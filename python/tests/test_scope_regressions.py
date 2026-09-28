import json
import time
from pathlib import Path

from devora_sdk.guard import ImpersonationContext, evaluate_impersonation_guard
from devora_sdk.policy import ScopeConfig
from devora_sdk.utils import match_endpoint_pattern


def test_shared_scope_corpus():
    cases = json.loads((Path(__file__).resolve().parents[2] / "test/scope-policy-cases.json").read_text())
    for item in cases:
        options = item.get("options", {})
        assert match_endpoint_pattern(item["pattern"], item["path"], case_sensitive=options.get("caseSensitive", True), ignore_trailing_slash=options.get("ignoreTrailingSlash", False)) == item["matches"], item
    start = time.monotonic()
    assert not match_endpoint_pattern("/**/**/**/**/**/never", "/" + "/".join(["x"] * 150))
    assert time.monotonic() - start < 0.25


def test_guard_denies_zero_depth_wildcard_case_alias_and_unknown_verbs():
    context = ImpersonationContext(is_impersonation=True, scope="read", session_id="test", expires_at=int(time.time() * 1000) + 60000, actor={"id": "a"}, subject={"id": "b"}, auth_method="devora_impersonation", authorization_source="standard", recording_allowed=False)
    policy = ScopeConfig(safe_read_endpoints=[{"method": "POST", "pattern": "/api/reports"}], blocked_endpoints=[{"method": "*", "pattern": "/api/**/secrets"}], version=1, cached_until=int(time.time() * 1000) + 60000)
    # Adapters pass the server-decoded path, so a malformed "%zz" is literal
    # content the router also sees verbatim; only boundary-changing forms are denied.
    for method, path in [("GET", "/api/secrets"), ("GET", "/API/team/secrets"), ("POST", "/api/REPORTS"), ("POST", "/api/%72eports"), ("POST", "/api/reports/"), ("COPY", "/public"), ("GET", "/api/a%2fb"), ("GET", "/api/a%2520b")]:
        assert not evaluate_impersonation_guard(method, path, context, policy, session_live=True).allowed, (method, path)
    assert evaluate_impersonation_guard("POST", "/api/reports", context, policy, session_live=True).allowed


def test_python_liveness_request_is_signed_customer_to_devora_v3():
    from unittest.mock import patch
    from devora_sdk import devora_sdk
    from signing_support import API_KEY, ORG_ID, SECRET_KEY, sign
    sdk = devora_sdk(API_KEY, SECRET_KEY, ORG_ID, environment="development", prefetch_scope_config=False)
    captured = []
    class Response:
        status = 200
        headers = {}
        body = b'{"success":true,"data":{"valid":true}}'
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, size=-1):
            chunk, Response.body = Response.body[:size], Response.body[size:]
            return chunk
    def open_request(req, timeout):
        captured.append(req)
        return Response()
    with patch("devora_sdk.transport._OPENER.open", open_request):
        assert sdk.get_session_status("test_session") == {"valid": True}
    req = captured[0]
    headers = {k.lower(): v for k, v in req.header_items()}
    assert headers["x-devora-signature-version"] == "3"
    expected, _ = sign("POST", "/api/sdk/session-status", body=req.data, direction="customer-to-devora", sent_at=headers["x-devora-sent-at"], request_id=headers["x-devora-request-id"])
    assert headers["x-devora-signature"] == expected["x-devora-signature"]

def test_encoded_spaces_and_percent_are_ordinary_parameters():
    from devora_sdk.utils import is_ambiguous_request_path as path_has_dot_segment

    # Adapters may pass encoded or already-decoded paths; neither form of an
    # ordinary space or percent sign may be treated as ambiguous.
    for path in ["/files/my%20doc", "/files/my doc", "/files/100%25", "/files/100%", "/search/a%2Bb"]:
        assert not path_has_dot_segment(path), path
    for path in ["/a%2520b", "/a%2fb", "/a%5cb", "/a\tb", "/a%09b", "/a/../b", "/a;b"]:
        assert path_has_dot_segment(path), path


def test_semicolon_aliases_are_rejected_for_write_impersonation():
    context = ImpersonationContext(is_impersonation=True, scope="write", session_id="test", expires_at=int(time.time() * 1000) + 60000, actor={"id": "a"}, subject={"id": "b"}, auth_method="devora_impersonation", authorization_source="standard", recording_allowed=False)
    policy = ScopeConfig(safe_read_endpoints=[], blocked_endpoints=[{"method": "*", "pattern": "/api/admin"}], version=1, cached_until=int(time.time() * 1000) + 60000)
    for path in ["/api/admin", "/api/admin;ignored", "/api/admin%3Bignored", "/api/admin%253bignored"]:
        assert not evaluate_impersonation_guard("GET", path, context, policy, session_live=True).allowed
