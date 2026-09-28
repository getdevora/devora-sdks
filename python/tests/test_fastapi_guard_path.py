"""The FastAPI guard must judge the path Starlette's router dispatches on.

Starlette re-parses ``request.url.path`` as a WHATWG URL, which silently drops
tab, line feed and carriage return; the router matches ``scope["path"]`` where
those bytes survive. A guard reading the stripped path would whitelist
``POST /api/rep\\torts`` as the safe read ``/api/reports`` while the router
sends it to a parameterised write handler.
"""

import sys
import time
from pathlib import Path

for sdk_package in ("python", "fastapi"):
	sys.path.insert(0, str(Path(__file__).resolve().parents[2] / sdk_package / "src"))

import unittest

from devora_sdk.guard import ImpersonationContext
from devora_sdk.policy import ScopeConfig


def _context() -> ImpersonationContext:
	return ImpersonationContext(
		is_impersonation=True,
		scope="read",
		session_id="test",
		expires_at=int(time.time() * 1000) + 60000,
		actor={"id": "a"},
		subject={"id": "b"},
		auth_method="devora_impersonation",
		authorization_source="standard",
		recording_allowed=False,
	)


class _FakeSDK:
	def get_scope_config(self):
		return ScopeConfig(
			safe_read_endpoints=[{"method": "POST", "pattern": "/api/reports"}],
			blocked_endpoints=[],
			version=1,
			cached_until=int(time.time() * 1000) + 60000,
		)


class FastAPIGuardPathTests(unittest.TestCase):
	def _client(self):
		from starlette.applications import Starlette
		from starlette.responses import JSONResponse
		from starlette.routing import Route
		from starlette.testclient import TestClient
		from devora_sdk_fastapi.adapter import DevoraImpersonationGuardMiddleware

		async def reports(request):
			return JSONResponse({"handler": "reports"})

		async def catch_all(request):
			return JSONResponse({"handler": "write", "slug": request.path_params["slug"]})

		app = Starlette(
			routes=[
				Route("/api/reports", reports, methods=["POST"]),
				Route("/api/{slug}", catch_all, methods=["POST"]),
			]
		)
		guarded = DevoraImpersonationGuardMiddleware(
			app,
			sdk=_FakeSDK(),
			get_impersonation_context=lambda request: _context(),
			enforce_liveness=False,
		)
		return TestClient(guarded)

	def test_whitelisted_read_is_allowed(self):
		response = self._client().post("/api/reports")
		self.assertEqual(response.status_code, 200)
		self.assertEqual(response.json()["handler"], "reports")

	def test_control_characters_cannot_smuggle_a_write_past_the_read_whitelist(self):
		client = self._client()
		for path in ("/api/rep%09orts", "/api/reports%09", "/api/rep%0aorts", "/api/reports%0d"):
			response = client.post(path)
			self.assertEqual(response.status_code, 403, path)
			self.assertEqual(response.json().get("errorCode"), "IMPERSONATION_ENDPOINT_BLOCKED", path)

	def test_unlisted_write_is_blocked(self):
		response = self._client().post("/api/other")
		self.assertEqual(response.status_code, 403)


if __name__ == "__main__":
	unittest.main()
