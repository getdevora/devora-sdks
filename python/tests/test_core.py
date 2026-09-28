from __future__ import annotations

import asyncio
import sys
import time
import unittest
import warnings
import uuid
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

import os

# The SDK fails closed (production) unless the runtime declares itself; tests are development.
os.environ.setdefault("DEVORA_ENV", "development")

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python" / "src"))
sys.path.insert(0, str(ROOT / "django" / "src"))
sys.path.insert(0, str(ROOT / "fastapi" / "src"))

from devora_sdk import (  # noqa: E402
	AdapterRequest,
	DEVORA_ENDPOINTS,
	ImpersonationContext,
	SessionLivenessChecker,
	async_process_request,
	devora_sdk,
	evaluate_impersonation_guard,
	process_request,
)
from devora_sdk.policy import ScopeConfig, ScopeConfigFetcher  # noqa: E402
from devora_sdk import route_relative_path  # noqa: E402
from signing_support import API_KEY, ORG_ID, SECRET_KEY, sign as sign_v3  # noqa: E402
from devora_sdk_django import django_route_pattern  # noqa: E402
from devora_sdk_fastapi import fastapi_route_path  # noqa: E402




def _context(**overrides):
	values = {
		"is_impersonation": True,
		"scope": "read",
		"session_id": "session_123",
		"expires_at": int(time.time() * 1000) + 60_000,
		"actor": {"id": "agent_1"},
		"subject": {"id": "user_1"},
		"auth_method": "devora_impersonation",
		"authorization_source": "standard",
		"recording_allowed": False,
	}
	values.update(overrides)
	return ImpersonationContext(**values)


class PythonSDKCoreTests(unittest.TestCase):
	def test_local_capture_preferences_are_ignored(self) -> None:
		from devora_sdk.sdk import DevoraBackendSDK
		for factory in (devora_sdk, DevoraBackendSDK):
			sdk = factory(API_KEY, SECRET_KEY, ORG_ID,
				recordingAllowed=False, recording_enabled=True,
				masking={"profile": "minimal"}, capture={"activityEnabled": True})
			for key in ("recordingAllowed", "recording_enabled", "masking", "capture"):
				self.assertNotIn(key, sdk.config)
				self.assertFalse(hasattr(sdk, key))

	def test_signed_request_success_and_replay_rejection(self) -> None:
		sdk = devora_sdk(API_KEY, SECRET_KEY, ORG_ID, collect_stats=True)

		def search(req):
			return {"term": req.query.get("term"), "path": req.path}

		sdk.register(DEVORA_ENDPOINTS.USER_SEARCH, search)
		request = self._signed_request(
			sdk,
			method="GET",
			path=DEVORA_ENDPOINTS.USER_SEARCH,
			query_string="term=ada&tag=b&tag=a",
			body=None,
		)

		response = process_request(sdk, sdk.get_routes(), request)
		self.assertTrue(response["success"])
		self.assertEqual(response["data"], {"term": "ada", "path": DEVORA_ENDPOINTS.USER_SEARCH})

		replayed = process_request(sdk, sdk.get_routes(), request)
		self.assertFalse(replayed["success"])
		self.assertEqual(replayed["errorCode"], "REPLAYED_REQUEST")
		self.assertEqual(sdk.get_stats()["securityErrors"], 1)

	def test_impersonation_context_is_built_after_hmac_validation(self) -> None:
		sdk = devora_sdk(API_KEY, SECRET_KEY, ORG_ID)

		def impersonate(req):
			return {
				"sessionId": req.devora_context.session_id,
				"scope": req.devora_context.scope,
				"targetUserId": req.devora_context.target_user["id"],
				"impersonatorId": req.devora_context.impersonator["id"],
			}

		sdk.register(DEVORA_ENDPOINTS.IMPERSONATE, impersonate)
		body = {
			"sessionId": "session_123",
			"scope": "read",
			"expiresAt": int(time.time() * 1000) + 60_000,
			"impersonator": {"id": "agent_1", "email": "agent@example.com"},
			"authMethod": "devora_impersonation",
			"authorizationSource": "standard",
			"recordingAllowed": False,
		}
		request = self._signed_request(
			sdk,
			method="POST",
			path="/impersonate/user_123",
			query_string="",
			query={},
			body=body,
		)

		response = process_request(sdk, sdk.get_routes(), request)
		self.assertTrue(response["success"])
		self.assertEqual(
			response["data"],
			{
				"sessionId": "session_123",
				"scope": "read",
				"targetUserId": "user_123",
				"impersonatorId": "agent_1",
			},
		)

	def test_async_handlers_are_supported_by_async_processor(self) -> None:
		sdk = devora_sdk(API_KEY, SECRET_KEY, ORG_ID)

		async def search(req):
			await asyncio.sleep(0)
			return {"term": req.query.get("term")}

		sdk.register(DEVORA_ENDPOINTS.USER_SEARCH, search)
		request = self._signed_request(
			sdk,
			method="GET",
			path=DEVORA_ENDPOINTS.USER_SEARCH,
			query_string="term=grace",
			query={"term": "grace"},
			body=None,
		)

		response = asyncio.run(async_process_request(sdk, sdk.get_routes(), request))
		self.assertTrue(response["success"])
		self.assertEqual(response["data"], {"term": "grace"})

	def test_sync_handler_does_not_block_the_event_loop(self) -> None:
		# A plain (non-async) customer handler may itself do blocking I/O (a DB
		# call, etc). async_process_request must run it off the event loop, or
		# concurrent requests would be serialized behind whichever one happens
		# to be handled first.
		sdk = devora_sdk(API_KEY, SECRET_KEY, ORG_ID)

		def search(req):
			time.sleep(0.2)
			return {"term": req.query.get("term")}

		sdk.register(DEVORA_ENDPOINTS.USER_SEARCH, search)

		async def run_two_concurrently():
			requests = [
				self._signed_request(
					sdk,
					method="GET",
					path=DEVORA_ENDPOINTS.USER_SEARCH,
					query_string=f"term=user{i}",
					query={"term": f"user{i}"},
					body=None,
				)
				for i in range(2)
			]
			start = time.monotonic()
			responses = await asyncio.gather(
				*(async_process_request(sdk, sdk.get_routes(), request) for request in requests)
			)
			elapsed = time.monotonic() - start
			return responses, elapsed

		responses, elapsed = asyncio.run(run_two_concurrently())
		for response in responses:
			self.assertTrue(response["success"])
		# If the handler ran on the event loop, two 0.2s sleeps would serialize
		# to ~0.4s; running them off-loop keeps the wall-clock time near 0.2s.
		self.assertLess(elapsed, 0.35)

	def test_guard_policy_order_and_fail_closed(self) -> None:
		context = _context()
		policy = ScopeConfig(
			safe_read_endpoints=[{"method": "POST", "pattern": "/safe"}],
			blocked_endpoints=[{"method": "*", "pattern": "/admin/**"}],
			version=1,
			cached_until=int(time.time() * 1000) + 60_000,
		)

		self.assertTrue(evaluate_impersonation_guard("GET", "/projects", context, policy).allowed)
		self.assertTrue(evaluate_impersonation_guard("POST", "/safe", context, policy).allowed)
		self.assertEqual(
			evaluate_impersonation_guard("POST", "/projects", context, policy).body["errorCode"],
			"IMPERSONATION_SCOPE_VIOLATION",
		)
		self.assertEqual(
			evaluate_impersonation_guard("GET", "/admin/users", context, policy).body["errorCode"],
			"IMPERSONATION_ENDPOINT_BLOCKED",
		)
		self.assertEqual(
			evaluate_impersonation_guard("GET", "/projects", context, None).body["errorCode"],
			"IMPERSONATION_POLICY_UNAVAILABLE",
		)

	def test_adapter_route_helpers_match_core_contract(self) -> None:
		self.assertEqual(route_relative_path("/devora/impersonate/user_1", "/impersonate/:id"), "/impersonate/user_1")
		self.assertIsNone(route_relative_path("/test", "/impersonate/:id"))
		self.assertEqual(django_route_pattern("/impersonate/:id"), "^impersonate/(?P<id>[^/]+)$")
		self.assertEqual(fastapi_route_path("/impersonate/:id/terminate"), "/impersonate/{id}/terminate")

	def test_scope_config_304_extends_cached_policy(self) -> None:
		fetcher = ScopeConfigFetcher(API_KEY, cache_ttl_ms=60_000, sign_request=lambda: {})
		fetcher.cached_config = ScopeConfig(
			safe_read_endpoints=[],
			blocked_endpoints=[],
			version=7,
			cached_until=0,
		)
		with patch(
			"devora_sdk.transport._OPENER.open",
			side_effect=HTTPError("https://devora.test", 304, "Not Modified", hdrs={}, fp=None),
		):
			result = fetcher.refresh()
		self.assertIsNotNone(result)
		self.assertEqual(result.version, 7)
		self.assertGreater(result.cached_until, int(time.time() * 1000))
		fetcher.stop()

	def test_fastapi_router_smoke_when_available(self) -> None:
		FastAPI, TestClient = self._fastapi_test_tools()

		from devora_sdk_fastapi import fastapi_router

		sdk = devora_sdk(API_KEY, SECRET_KEY, ORG_ID)
		sdk.register(DEVORA_ENDPOINTS.USER_SEARCH, lambda req: {"term": req.query.get("term")})
		app = FastAPI()
		app.include_router(fastapi_router(sdk), prefix="/devora")
		client = TestClient(app)
		response = client.get(
			"/devora/user/search?term=ada",
			headers=self._signed_headers(sdk, "GET", DEVORA_ENDPOINTS.USER_SEARCH, "term=ada", None),
		)
		self.assertEqual(response.status_code, 200)
		self.assertEqual(response.json()["data"], {"term": "ada"})

	def test_fastapi_router_verifies_encoded_path_param_when_available(self) -> None:
		# Devora signs path params with encodeURIComponent (e.g. "/user/a%40b.com"
		# for id "a@b.com"), but Starlette's request.url.path is percent-decoded.
		# Signing against the decoded path would never match what Devora sent.
		FastAPI, TestClient = self._fastapi_test_tools()

		from devora_sdk_fastapi import fastapi_router

		sdk = devora_sdk(API_KEY, SECRET_KEY, ORG_ID)
		sdk.register(DEVORA_ENDPOINTS.USER_BY_ID, lambda req: {"id": req.params.get("id")})
		app = FastAPI()
		app.include_router(fastapi_router(sdk), prefix="/devora")
		client = TestClient(app)
		signed_path = DEVORA_ENDPOINTS.USER_BY_ID.replace(":id", "a%40b.com")  # strict-encoded "a@b.com"
		response = client.get(
			"/devora/user/a%40b.com",
			headers=self._signed_headers(sdk, "GET", signed_path, "", None),
		)
		self.assertEqual(response.status_code, 200)
		self.assertEqual(response.json()["data"], {"id": "a@b.com"})

	def test_fastapi_guard_middleware_smoke_when_available(self) -> None:
		FastAPI, TestClient = self._fastapi_test_tools()

		from devora_sdk_fastapi import DevoraImpersonationGuardMiddleware

		sdk = devora_sdk(API_KEY, SECRET_KEY, ORG_ID)
		sdk.get_scope_config = lambda: ScopeConfig(
			safe_read_endpoints=[],
			blocked_endpoints=[],
			version=1,
			cached_until=int(time.time() * 1000) + 60_000,
		)
		context = _context()
		app = FastAPI()
		app.add_middleware(
			DevoraImpersonationGuardMiddleware,
			sdk=sdk,
			get_impersonation_context=lambda request: context,
			enforce_liveness=False,
		)

		@app.get("/projects")
		def list_projects():
			return {"ok": True}

		@app.post("/projects")
		def create_project():
			return {"ok": True}

		client = TestClient(app)
		self.assertEqual(client.get("/projects").status_code, 200)
		blocked = client.post("/projects")
		self.assertEqual(blocked.status_code, 403)
		self.assertEqual(blocked.json()["errorCode"], "IMPERSONATION_SCOPE_VIOLATION")

	def test_guard_blocks_when_liveness_reports_session_ended(self) -> None:
		context = _context(scope="write")
		policy = ScopeConfig(
			safe_read_endpoints=[],
			blocked_endpoints=[],
			version=1,
			cached_until=int(time.time() * 1000) + 60_000,
		)
		ended = evaluate_impersonation_guard("GET", "/projects", context, policy, session_live=False)
		self.assertFalse(ended.allowed)
		self.assertEqual(ended.status_code, 401)
		self.assertEqual(ended.body["errorCode"], "IMPERSONATION_SESSION_ENDED")
		self.assertTrue(
			evaluate_impersonation_guard("GET", "/projects", context, policy, session_live=True).allowed
		)

	def test_session_liveness_checker_caches_and_honors_fail_mode(self) -> None:
		class FakeSDK:
			def __init__(self, status):
				self.status = status
				self.calls = 0

			def get_session_status(self, session_id):
				self.calls += 1
				return self.status

		live_sdk = FakeSDK({"valid": True})
		checker = SessionLivenessChecker(live_sdk, cache_ttl_ms=60_000)
		self.assertTrue(checker.is_live("s1"))
		self.assertTrue(checker.is_live("s1"))
		self.assertEqual(live_sdk.calls, 1)  # second call served from cache

		self.assertIs(SessionLivenessChecker(FakeSDK({"valid": False})).is_live("s2"), False)
		self.assertIsNone(SessionLivenessChecker(FakeSDK(None), on_unavailable="allow").is_live("s3"))
		self.assertIs(SessionLivenessChecker(FakeSDK(None), on_unavailable="deny").is_live("s4"), False)

	def test_fastapi_guard_liveness_blocks_ended_session_when_available(self) -> None:
		FastAPI, TestClient = self._fastapi_test_tools()

		from devora_sdk_fastapi import DevoraImpersonationGuardMiddleware

		sdk = devora_sdk(API_KEY, SECRET_KEY, ORG_ID)
		sdk.get_scope_config = lambda: ScopeConfig(
			safe_read_endpoints=[],
			blocked_endpoints=[],
			version=1,
			cached_until=int(time.time() * 1000) + 60_000,
		)
		sdk.get_session_status = lambda session_id: {"valid": False, "status": "terminated"}
		context = _context(scope="write")
		app = FastAPI()
		app.add_middleware(
			DevoraImpersonationGuardMiddleware,
			sdk=sdk,
			get_impersonation_context=lambda request: context,
			enforce_liveness=True,
		)

		@app.get("/projects")
		def list_projects():
			return {"ok": True}

		client = TestClient(app)
		blocked = client.get("/projects")
		self.assertEqual(blocked.status_code, 401)
		self.assertEqual(blocked.json()["errorCode"], "IMPERSONATION_SESSION_ENDED")

	def _signed_request(
		self,
		sdk,
		method: str,
		path: str,
		query_string: str,
		body: object,
		**_ignored: object,
	) -> AdapterRequest:
		headers, raw = sign_v3(method, path, query_string, body)
		return AdapterRequest(method=method, path=path, query=query_string, body=raw, headers=headers)

	def _signed_headers(self, sdk, method: str, path: str, query_string: str, body: object) -> dict[str, str]:
		return sign_v3(method, path, query_string, body)[0]

	def _fastapi_test_tools(self):
		with warnings.catch_warnings():
			warnings.simplefilter("ignore", PendingDeprecationWarning)
			try:
				from fastapi import FastAPI
				from fastapi.testclient import TestClient
			except Exception as exc:
				self.skipTest(f"FastAPI unavailable: {exc}")
		return FastAPI, TestClient

	def test_security_validation_returns_granular_error_codes(self) -> None:
		sdk = devora_sdk(api_key=API_KEY, secret_key=SECRET_KEY, org_id=ORG_ID)
		try:
			missing = sdk.verify_request("GET", "/test", "", b"", {})
			self.assertFalse(missing.valid)
			self.assertEqual(missing.error_code, "INVALID_SIGNATURE_HEADERS")

			other_key = "pk_server_live_" + "B" * 32
			headers, _ = sign_v3("GET", "/test", key_id=other_key)
			mismatch = sdk.verify_request("GET", "/test", "", b"", headers)
			self.assertEqual(mismatch.error_code, "ORG_MISMATCH")

			stale_headers, _ = sign_v3("GET", "/test", sent_at=str(int(time.time()) - 900))
			stale = sdk.verify_request("GET", "/test", "", b"", stale_headers)
			self.assertEqual(stale.error_code, "TIMESTAMP_EXPIRED")

			# Per-call tolerance override accepts the same stale timestamp.
			widened = sdk.verify_request("GET", "/test", "", b"", stale_headers, timestamp_tolerance=1200)
			self.assertTrue(widened.valid)
		finally:
			sdk.destroy()

	def test_guard_bodies_include_error_code_alias(self) -> None:
		context = _context(session_id="sess_1")
		policy = ScopeConfig(
			safe_read_endpoints=[], blocked_endpoints=[], version=1, cached_until=0
		)
		decision = evaluate_impersonation_guard("POST", "/api/update", context, policy)
		self.assertFalse(decision.allowed)
		assert decision.body is not None
		self.assertEqual(decision.body["errorCode"], "IMPERSONATION_SCOPE_VIOLATION")
		self.assertNotIn("code", decision.body)

	def test_api_url_override_is_validated(self) -> None:
		with self.assertRaises(ValueError):
			devora_sdk(api_key=API_KEY, secret_key=SECRET_KEY, org_id=ORG_ID, api_url="http://example.com")
		with self.assertRaises(ValueError):
			devora_sdk(
				api_key=API_KEY, secret_key=SECRET_KEY, org_id=ORG_ID, api_url="https://example.com/path"
			)
		sdk = devora_sdk(
			api_key=API_KEY, secret_key=SECRET_KEY, org_id=ORG_ID, api_url="https://devora.example.com"
		)
		try:
			self.assertEqual(sdk.api_url, "https://devora.example.com")
			self.assertEqual(sdk.config["secret_key"], "[REDACTED]")
			self.assertEqual(sdk._scope_config.api_url, "https://devora.example.com")
		finally:
			sdk.destroy()

	def test_api_url_localhost_http_is_allowed(self) -> None:
		sdk = devora_sdk(
			api_key=API_KEY, secret_key=SECRET_KEY, org_id=ORG_ID, api_url="http://localhost:3210"
		)
		try:
			self.assertEqual(sdk.api_url, "http://localhost:3210")
		finally:
			sdk.destroy()


if __name__ == "__main__":
	unittest.main()


class ParityHardeningTests(unittest.TestCase):
	def test_production_requires_replay_store(self):
		from devora_sdk import InMemoryReplayStore

		with self.assertRaises(ValueError):
			devora_sdk(API_KEY, SECRET_KEY, ORG_ID, environment="production")
		devora_sdk(API_KEY, SECRET_KEY, ORG_ID, environment="production", replay_store=InMemoryReplayStore())
		devora_sdk(API_KEY, SECRET_KEY, ORG_ID, environment="development")

	def test_stale_policy_is_bounded_to_five_minutes(self):
		from devora_sdk.policy import STALE_GRACE_MS

		fetcher = ScopeConfigFetcher(api_key=API_KEY, api_url="http://example.com", sign_request=lambda: {})
		now = int(time.time() * 1000)
		fetcher.cached_config = ScopeConfig([], [], 1, now - 1)
		fetcher.stale_until = fetcher.cached_config.cached_until + STALE_GRACE_MS
		self.assertEqual(STALE_GRACE_MS, 5 * 60 * 1000)
		with patch("devora_sdk.transport._OPENER.open", side_effect=OSError("down")):
			self.assertIsNotNone(fetcher.refresh())
		fetcher.stale_until = now - 1
		with patch("devora_sdk.transport._OPENER.open", side_effect=OSError("down")):
			self.assertIsNone(fetcher.refresh())

	def test_refresh_never_blocks_a_second_caller_on_the_network(self):
		import threading

		fetcher = ScopeConfigFetcher(api_key=API_KEY, api_url="http://example.com", sign_request=lambda: {})
		fetcher.cached_config = ScopeConfig([], [], 1, int(time.time() * 1000) + 60_000)
		fetcher.stale_until = fetcher.cached_config.cached_until
		started = threading.Event()
		release = threading.Event()

		def slow_urlopen(*_args, **_kwargs):
			started.set()
			release.wait(timeout=5)
			raise OSError("down")

		with patch("devora_sdk.transport._OPENER.open", side_effect=slow_urlopen):
			worker = threading.Thread(target=fetcher.refresh)
			worker.start()
			started.wait(timeout=2)
			began = time.time()
			# Must return the cached policy immediately instead of queueing behind the lock.
			self.assertIsNotNone(fetcher.refresh())
			self.assertLess(time.time() - began, 1.0)
			release.set()
			worker.join(timeout=5)

	def test_path_normalisation_closes_blocklist_bypasses(self):
		policy = ScopeConfig([], [{"method": "POST", "pattern": "/admin/users"}], 1, int(time.time() * 1000) + 60_000)
		for path in ["/Admin/users", "/admin/%75sers", "/api/../admin/users", "/admin/users/", "//admin//users"]:
			decision = evaluate_impersonation_guard("POST", path, _context(scope="write"), policy)
			self.assertFalse(decision.allowed, path)
			self.assertEqual(decision.body["errorCode"], "IMPERSONATION_ENDPOINT_BLOCKED", path)

	def test_unverifiable_liveness_is_distinct_from_ended(self):
		policy = ScopeConfig([], [], 1, int(time.time() * 1000) + 60_000)
		decision = evaluate_impersonation_guard(
			"GET", "/api/items", _context(scope="write"), policy, liveness_unavailable=True
		)
		self.assertEqual(decision.status_code, 503)
		self.assertEqual(decision.body["errorCode"], "IMPERSONATION_LIVENESS_UNAVAILABLE")

		class Unreachable:
			calls = 0

			def get_session_status(self, _session_id):
				Unreachable.calls += 1
				return None

		checker = SessionLivenessChecker(Unreachable())
		self.assertEqual(checker.check("sess_1"), (None, True))
		self.assertEqual(checker.check("sess_1"), (None, True))
		# The unavailable verdict is cached briefly: one lookup, not one per request.
		self.assertEqual(Unreachable.calls, 1)
		self.assertIs(checker.is_live("sess_1"), False)

	def test_fastapi_semantic_hook_is_not_called_for_invalid_context(self):
		from fastapi import FastAPI
		from fastapi.testclient import TestClient
		from devora_sdk_fastapi import DevoraImpersonationGuardMiddleware

		sdk = devora_sdk(API_KEY, SECRET_KEY, ORG_ID)
		calls = []

		def hook(_request, _context):
			calls.append(1)
			return True

		app = FastAPI()

		@app.get("/api/items")
		def items():
			return {"ok": True}

		app.add_middleware(
			DevoraImpersonationGuardMiddleware,
			sdk=sdk,
			get_impersonation_context=lambda _request: _context(scope="write", expires_at=1),
			enforce_liveness=False,
			is_impersonation_allowed=hook,
		)
		with patch.object(sdk, "get_scope_config", return_value=ScopeConfig([], [], 1, 0)):
			response = TestClient(app).get("/api/items")
		self.assertEqual(response.status_code, 401)
		self.assertEqual(calls, [])


class BrowserSessionBridgeTests(unittest.TestCase):
	def test_create_browser_resume_code_signs_customer_to_devora_v3(self):
		from devora_sdk.constants import BROWSER_RESUME_CODE_ENDPOINT, SECURITY_HEADERS

		sdk = devora_sdk(API_KEY, SECRET_KEY, ORG_ID, api_url="http://localhost:9999")
		captured = {}

		class FakeResponse:
			status = 200
			headers = {}

			def __enter__(self):
				return self

			def __exit__(self, *_args):
				return False

			def __init__(self):
				self._body = b'{"success":true,"data":{"code":"' + b"c" * 43 + b'","expiresAt":1}}'

			def read(self, size=-1):
				chunk, self._body = self._body[:size], self._body[size:]
				return chunk

		def fake_open(req, timeout=5):
			captured["headers"] = {k.lower(): v for k, v in req.header_items()}
			captured["body"] = req.data
			captured["url"] = req.full_url
			return FakeResponse()

		with patch("devora_sdk.transport._OPENER.open", side_effect=fake_open):
			result = sdk.create_browser_resume_code("sess_1", "devora_tab_1", "http://localhost:5001")
		self.assertEqual(result["code"], "c" * 43)
		self.assertTrue(captured["url"].endswith(BROWSER_RESUME_CODE_ENDPOINT))
		headers = captured["headers"]
		expected, _ = sign_v3(
			"POST",
			BROWSER_RESUME_CODE_ENDPOINT,
			body=captured["body"],
			direction="customer-to-devora",
			sent_at=headers[SECURITY_HEADERS.SENT_AT],
			request_id=headers[SECURITY_HEADERS.REQUEST_ID],
		)
		self.assertEqual(headers[SECURITY_HEADERS.SIGNATURE], expected["x-devora-signature"])
		self.assertEqual(headers[SECURITY_HEADERS.SIGNATURE_VERSION], "3")
		self.assertNotIn("x-devora-key", headers)

	def test_resolve_browser_session_states(self):
		from devora_sdk import resolve_browser_session

		class Sdk:
			calls = 0

			def create_browser_resume_code(self, *_args):
				Sdk.calls += 1
				return None

		sdk = Sdk()
		self.assertEqual(
			resolve_browser_session(sdk, None, "devora_tab_1", "http://localhost:5001"),
			(200, {"status": "none"}),
		)
		self.assertEqual(Sdk.calls, 0)
		self.assertEqual(
			resolve_browser_session(sdk, _context(), "x", "http://localhost:5001")[0], 400
		)
		self.assertEqual(
			resolve_browser_session(
				sdk, _context(), "devora_tab_1", "https://evil.example", ["http://localhost:5001"]
			)[0],
			403,
		)
		self.assertEqual(
			resolve_browser_session(
				sdk, _context(), "devora_tab_1", "http://localhost:5001", ["http://localhost:5001"]
			),
			(200, {"status": "blocked", "reason": "control_plane_unavailable"}),
		)

	def test_bridge_path_is_allowed_for_read_sessions(self):
		from devora_sdk import BROWSER_SESSION_BRIDGE_PATH

		policy = ScopeConfig([], [], 1, int(time.time() * 1000) + 60_000)
		# Off by default: an unmounted bridge path is an ordinary read-scope write.
		self.assertFalse(
			evaluate_impersonation_guard("POST", BROWSER_SESSION_BRIDGE_PATH, _context(scope="read"), policy).allowed
		)
		self.assertTrue(
			evaluate_impersonation_guard(
				"POST", BROWSER_SESSION_BRIDGE_PATH, _context(scope="read"), policy,
				bridge_path=BROWSER_SESSION_BRIDGE_PATH,
			).allowed
		)
		self.assertFalse(
			evaluate_impersonation_guard(
				"POST", "/api/devora/other", _context(scope="read"), policy,
				bridge_path=BROWSER_SESSION_BRIDGE_PATH,
			).allowed
		)
