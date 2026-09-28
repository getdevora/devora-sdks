"""Post-implementation regression cases. No app servers or network requests."""
import pytest

from devora_sdk.signing import parse_verified_json_body, is_valid_signed_path, is_valid_signed_query
from devora_sdk.guard import (
    ImpersonationContext, InvalidImpersonationContext,
    coerce_impersonation_context, evaluate_impersonation_guard,
)


@pytest.mark.parametrize("body", [
    b'{"scope":"read","scope":"write"}', b'{"x":{"a":1,"\\u0061":2}}',
    b'[{"a":1,"a":2}]', b'{"x":1e999}', b'{"x":NaN}', b'{"x":Infinity}', b'\xef\xbb\xbf{}',
])
def test_signed_body_rejects_ambiguous_or_non_finite_json(body):
    assert parse_verified_json_body(body, "application/json")[0] is False


def test_signed_body_accepts_distinct_objects_and_prototype_named_data():
    ok, value = parse_verified_json_body(b'{"a":[{"x":1},{"x":2}],"__proto__":{"admin":true}}', "application/json")
    assert ok and value["a"] == [{"x": 1}, {"x": 2}]
    assert value["__proto__"] == {"admin": True}


@pytest.mark.parametrize("path", ["/x\n", "/x?y", "/x#y", "/x\\y", "/x/%2E", "/x/.%2E", "/x/%2E%2E"])
def test_signed_path_rejects_reinterpreted_forms(path):
    assert not is_valid_signed_path(path)


@pytest.mark.parametrize("query", ["q=%FF", "q=%ED%A0%80", "q=ok\n"])
def test_signed_query_rejects_invalid_utf8(query):
    assert not is_valid_signed_query(query)


@pytest.mark.parametrize("flag", [0, 1, "", "false", None])
def test_dataclass_context_cannot_bypass_boolean_validation(flag):
    context = ImpersonationContext(is_impersonation=flag, scope="write")
    with pytest.raises(InvalidImpersonationContext):
        coerce_impersonation_context(context)
    decision = evaluate_impersonation_guard("DELETE", "/admin/delete", context, None)
    assert not decision.allowed and decision.status_code == 500


def test_explicit_non_impersonation_still_passes():
    context = ImpersonationContext(is_impersonation=False, scope="")
    assert coerce_impersonation_context(context) is context
    assert evaluate_impersonation_guard("GET", "/", context, None).allowed


def test_control_plane_deadline_is_total_even_when_the_connection_stalls(monkeypatch):
	# urllib's timeout is per socket operation and does not cover DNS: a stall
	# there must still end at the caller's total deadline.
	import threading
	import time as _time
	from devora_sdk import transport

	release = threading.Event()

	class StalledOpener:
		def open(self, req, timeout=None):
			release.wait(5)
			raise OSError("stalled")

	monkeypatch.setattr(transport, "_OPENER", StalledOpener())
	started = _time.monotonic()
	with pytest.raises(transport.ControlPlaneError, match="deadline"):
		transport.control_plane_request("https://devora.invalid/x", "GET", {}, timeout=0.2)
	assert _time.monotonic() - started < 1.0
	release.set()


def test_control_plane_stalls_never_grow_threads_without_bound(monkeypatch):
	import threading
	from devora_sdk import transport

	release = threading.Event()

	class StalledOpener:
		def open(self, req, timeout=None):
			release.wait(5)
			raise OSError("stalled")

	monkeypatch.setattr(transport, "_OPENER", StalledOpener())
	pool = transport._Pool()
	monkeypatch.setattr(transport, "_POOL", pool)
	try:
		for _ in range(40):
			with pytest.raises(transport.ControlPlaneError, match="deadline"):
				transport.control_plane_request("https://devora.invalid/x", "GET", {}, timeout=0.01)
		assert len(pool.executor._threads) <= transport._WORKERS
	finally:
		release.set()


def test_method_override_query_parameter_is_judged():
	from devora_sdk.guard import policy_methods

	assert policy_methods("POST", {}, "_method=DELETE") == ["POST", "DELETE"]
	assert set(policy_methods("POST", {"X-HTTP-Method-Override": "PATCH"}, "a=1&_method=put")) == {"POST", "PATCH", "PUT"}
	assert policy_methods("POST", {}, "method=DELETE") == ["POST"]


@pytest.mark.parametrize("verdict", [False, "false", 1, {}, [], None, True])
def test_semantic_authorization_requires_explicit_boolean_true(verdict):
    import time
    from devora_sdk.policy import ScopeConfig

    context = ImpersonationContext(
        is_impersonation=True, scope="write", session_id="s",
        expires_at=int(time.time() * 1000) + 60_000,
        actor={"id": "agent"}, subject={"id": "customer"},
        auth_method="devora_impersonation", authorization_source="standard", recording_allowed=False,
    )
    decision = evaluate_impersonation_guard(
        "DELETE", "/account", context, ScopeConfig([], [], 1, 0),
        is_impersonation_allowed=lambda _: verdict,
    )
    assert decision.allowed is (verdict is True)


def test_sync_guard_does_not_treat_async_denial_as_authorization():
    import time
    from devora_sdk.policy import ScopeConfig

    async def deny(_):
        return False

    context = ImpersonationContext(
        is_impersonation=True, scope="write", session_id="s",
        expires_at=int(time.time() * 1000) + 60_000,
        actor={"id": "agent"}, subject={"id": "customer"},
        auth_method="devora_impersonation", authorization_source="standard", recording_allowed=False,
    )
    decision = evaluate_impersonation_guard(
        "DELETE", "/account", context, ScopeConfig([], [], 1, 0), is_impersonation_allowed=deny,
    )
    assert not decision.allowed and decision.status_code == 403


@pytest.mark.parametrize("verdict", ["false", 1, {}, [], None])
def test_replay_store_cannot_authorize_with_truthy_nonboolean_result(verdict):
    from devora_sdk import devora_sdk
    from signing_support import API_KEY, ORG_ID, SECRET_KEY, sign

    class InvalidStore:
        def consume(self, *_):
            return verdict

    sdk = devora_sdk(API_KEY, SECRET_KEY, ORG_ID, replay_store=InvalidStore(), prefetch_scope_config=False)
    try:
        headers, _ = sign("GET", "/test")
        result = sdk.verify_request("GET", "/test", "", b"", headers)
        assert not result.valid and result.error_code == "REPLAY_STORE_UNAVAILABLE"
    finally:
        sdk.destroy()


def test_async_replay_store_is_rejected_instead_of_trusting_coroutine():
    from devora_sdk import devora_sdk
    from signing_support import API_KEY, ORG_ID, SECRET_KEY, sign

    class AsyncStore:
        async def consume(self, *_):
            return False

    sdk = devora_sdk(API_KEY, SECRET_KEY, ORG_ID, replay_store=AsyncStore(), prefetch_scope_config=False)
    try:
        headers, _ = sign("GET", "/test")
        result = sdk.verify_request("GET", "/test", "", b"", headers)
        assert not result.valid and result.error_code == "REPLAY_STORE_UNAVAILABLE"
    finally:
        sdk.destroy()


def test_scope_policy_requires_explicit_complete_bounded_fields():
    from devora_sdk.policy import _read_policy

    valid = {"version": 0, "safeReadEndpoints": [], "blockedEndpoints": [], "cachedUntil": 120_000}
    invalid = [[], {}, *[{k: v for k, v in valid.items() if k != field} for field in valid]]
    invalid += [
        {**valid, "version": -1}, {**valid, "version": 2**53}, {**valid, "version": True},
        {**valid, "cachedUntil": 0}, {**valid, "cachedUntil": "123"},
        {**valid, "blockedEndpoints": None},
        {**valid, "blockedEndpoints": [{"method": "GET\n", "pattern": "/export"}]},
    ]
    for data in invalid:
        assert _read_policy(data, 60_000) is None, data
    assert _read_policy(valid, 60_000).version == 0
    # JSON 1.0 parses as a float in Python but a safe integer in JavaScript.
    assert _read_policy({**valid, "version": 1.0}, 60_000).version == 1


def test_repeated_method_override_headers_are_all_judged():
	# Starlette keeps duplicate headers; a middleware reading the first value must
	# not see a method the guard never judged.
	from starlette.datastructures import Headers
	from devora_sdk.guard import policy_methods

	headers = Headers(raw=[
		(b"x-http-method-override", b"DELETE"),
		(b"x-http-method-override", b"POST"),
	])
	assert set(policy_methods("POST", headers)) == {"POST", "DELETE"}
	raw_pairs = [(b"X-HTTP-Method-Override", b"PUT"), (b"x-http-method-override", b"PATCH")]
	assert set(policy_methods("POST", raw_pairs)) == {"POST", "PUT", "PATCH"}
	assert policy_methods("POST", {"X-Method-Override": ["DELETE", "PATCH, PUT"]}) == [
		"POST", "DELETE", "PATCH", "PUT",
	]
