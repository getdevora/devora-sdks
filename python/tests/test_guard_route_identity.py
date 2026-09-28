"""Adversarial guard regressions on real framework routing.

Every case asserts whether the application handler actually ran, not only the
status code. Mirrors packages/sdks/test/guard-route-identity.test.ts.
"""
from __future__ import annotations

import asyncio
import math
import sys
import time
import types
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest

for package in ("python", "django", "fastapi"):
	sys.path.insert(0, str(Path(__file__).resolve().parents[2] / package / "src"))

import django
from django.conf import settings

if not settings.configured:
	settings.configure(DEFAULT_CHARSET="utf-8", SECRET_KEY="synthetic-test-key")
django.setup()

from django.http import HttpResponse
from django.test import RequestFactory, override_settings
from django.urls import path as django_path, re_path, resolve
from django.conf.urls.i18n import i18n_patterns
from django.utils import translation
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from devora_sdk import (
	BROWSER_SESSION_BRIDGE_PATH as BRIDGE,
	ProcessRequestOptions,
	devora_sdk,
	evaluate_impersonation_guard,
)
from devora_sdk.guard import ImpersonationContext
from devora_sdk.policy import ScopeConfig
from devora_sdk_django import create_impersonation_guard
from devora_sdk_django.adapter import DjangoAdapterOptions
from devora_sdk_fastapi import DevoraImpersonationGuardMiddleware
from devora_sdk_fastapi.adapter import FastAPIAdapterOptions


def _policy(extra_blocked=(), extra_safe=()):
	return ScopeConfig(
		safe_read_endpoints=[
			{"method": "POST", "pattern": "/api/search"},
			*extra_safe,
		],
		blocked_endpoints=[
			{"method": "*", "pattern": "/api/*/delete"},
			{"method": "*", "pattern": "/api/admin/**"},
			{"method": "GET", "pattern": "/api/export"},
			{"method": "DELETE", "pattern": "/api/items/*"},
			*extra_blocked,
		],
		version=1,
		cached_until=int(time.time() * 1000) + 60_000,
	)


class _SDK:
	def __init__(self, policy=None):
		self.policy = policy or _policy()

	def get_scope_config(self):
		return self.policy

	def get_session_status(self, _session_id):
		return {"valid": True}


def _context(scope="read", **overrides):
	value = {
		"isImpersonation": True,
		"actor": {"id": "agent"},
		"subject": {"id": "customer"},
		"sessionId": "sess_guard",
		"scope": scope,
		"authMethod": "devora_impersonation",
		"authorizationSource": "standard",
		"recordingAllowed": False,
		"expiresAt": int(time.time() * 1000) + 60_000,
	}
	value.update(overrides)
	return value


@pytest.mark.parametrize("asynchronous", [False, True])
def test_django_view_guard_preserves_url_captures(asynchronous):
	seen = []
	def view(request, item_id, *, category):
		seen.append((item_id, category))
		return HttpResponse("ok")
	async def async_view(request, item_id, *, category):
		return view(request, item_id, category=category)
	guard = create_impersonation_guard(_SDK(), lambda _: _context("write"), enforce_liveness=False)
	wrapped = guard(async_view if asynchronous else view)
	request = RequestFactory().get("/items/7")
	response = asyncio.run(wrapped(request, 7, category="paid")) if asynchronous else wrapped(request, 7, category="paid")
	assert response.status_code == 200
	assert seen == [(7, "paid")]


# (name, scope, method, path, headers, reached)
CASES = [
	("allowlisted read-scope write", "read", "POST", "/api/search", {}, True),
	("read-scope write", "read", "POST", "/api/items/1", {}, False),
	("write-scope write", "write", "POST", "/api/items/1", {}, True),
	("denied path", "write", "POST", "/api/users/delete", {}, False),
	# N1: a decoded ? or # is path content, never the end of the judged path.
	("encoded ? in deny path", "write", "POST", "/api/users%3F/delete", {}, False),
	("encoded # in deny path", "write", "POST", "/api/users%23/delete", {}, False),
	("encoded ? after allowlisted path", "read", "POST", "/api/search%3F/delete", {}, False),
	# N2: GET deny rules cover HEAD.
	("GET deny rule", "write", "GET", "/api/export", {}, False),
	("HEAD on GET deny rule", "write", "HEAD", "/api/export", {}, False),
	# Method-override headers are judged too.
	("override to denied method", "write", "POST", "/api/items/1", {"X-HTTP-Method-Override": "DELETE"}, False),
	("override on allowlisted write", "read", "POST", "/api/search", {"X-HTTP-Method-Override": "DELETE"}, False),
	# The bridge exemption is opt-in.
	("unconfigured bridge path", "read", "POST", BRIDGE, {}, False),
]


# --------------------------------------------------------------------------- FastAPI


def _fastapi_app(get_context, sdk=None, **guard_options):
	app = FastAPI()
	hits: dict[str, int] = {}

	def hit(name):
		hits[name] = hits.get(name, 0) + 1
		return {"reached": name}

	@app.post("/")
	def root():
		return hit("root")

	@app.post("/api/search")
	def search():
		return hit("search")

	@app.post("/api/{name}/delete")
	def delete(name: str):
		return hit("delete")

	@app.api_route("/api/admin/{rest:path}", methods=["GET", "POST", "DELETE"])
	def admin(rest: str):
		return hit("admin")

	@app.api_route("/api/export", methods=["GET", "HEAD"])
	def export():
		return hit("export")

	@app.api_route("/api/items/{item}", methods=["POST", "DELETE"])
	def items(item: str):
		return hit("items")

	@app.post(BRIDGE)
	def bridge():
		return hit("bridge")

	app.add_middleware(
		DevoraImpersonationGuardMiddleware,
		sdk=sdk or _SDK(),
		get_impersonation_context=get_context,
		**guard_options,
	)
	return app, hits


@pytest.mark.parametrize("name,scope,method,path,headers,reached", CASES, ids=[c[0] for c in CASES])
def test_fastapi_corpus_never_reaches_prohibited_handlers(name, scope, method, path, headers, reached):
	app, hits = _fastapi_app(lambda _request: _context(scope))
	response = TestClient(app).request(method, path, headers=headers)
	assert (sum(hits.values()) > 0) is reached, (name, response.status_code)
	if not reached:
		assert response.status_code != 200


def test_fastapi_root_path_full_and_relative_deny_rules_both_block():
	for pattern in ("/api/admin/**", "/app/api/admin/**"):
		policy = _policy()
		policy.blocked_endpoints[:] = [{"method": "*", "pattern": pattern}]
		app, hits = _fastapi_app(lambda _request: _context("write"), sdk=_SDK(policy))
		response = TestClient(app, root_path="/app").post("/app/api/admin/purge")
		assert (response.status_code, hits) == (403, {}), pattern


class _Namespaced:
	def __init__(self):
		self.__dict__.update(
			is_impersonation=True, scope="write", session_id="s", expires_at=int(time.time() * 1000) + 60_000
		)


@dataclass
class _DataclassContext:
	isImpersonation: bool = True
	scope: str = "write"


@pytest.mark.parametrize(
	"getter",
	[
		lambda _r: SimpleNamespace(**_context("write")),
		lambda _r: _Namespaced(),
		lambda _r: _DataclassContext(),
		lambda _r: "yes",
		lambda _r: {},
		lambda _r: {**_context("write"), "isImpersonation": "true"},
	],
)
def test_fastapi_unrecognised_contexts_fail_closed(getter):
	app, hits = _fastapi_app(getter)
	response = TestClient(app).post("/api/admin/purge")
	assert (response.status_code, hits) == (500, {})


def test_fastapi_async_contexts_are_enforced():
	async def getter(_request):
		return _context("read")

	app, hits = _fastapi_app(getter)
	client = TestClient(app)
	assert client.post("/api/items/1").status_code == 403
	assert client.post("/api/search").status_code == 200
	assert hits == {"search": 1}


@pytest.mark.parametrize("expires_at", [math.inf, -math.inf, math.nan, "inf", "9999999999999", True, 1.5e12 + 0.5])
def test_fastapi_malformed_expiry_is_rejected_without_crashing(expires_at):
	app, hits = _fastapi_app(lambda _request: _context("write", expiresAt=expires_at))
	response = TestClient(app).post("/api/items/1")
	assert (response.status_code, hits) == (401, {})


def test_fastapi_guard_failures_fail_closed():
	class Down(_SDK):
		def get_scope_config(self):
			raise RuntimeError("policy down")

	def boom(_request):
		raise RuntimeError("extractor failed")

	for app, hits in (
		_fastapi_app(lambda _request: _context("write"), sdk=Down()),
		_fastapi_app(boom),
		_fastapi_app(
			lambda _request: _context("write"),
			is_impersonation_allowed=lambda _request, _context: 1 / 0,
		),
	):
		assert (TestClient(app).post("/api/items/1").status_code, hits) == (500, {})


def test_fastapi_configured_bridge_is_exact():
	app, hits = _fastapi_app(lambda _request: _context("read"), bridge_path=BRIDGE)
	client = TestClient(app)
	assert client.post(BRIDGE).status_code == 200
	assert client.post(BRIDGE, headers={"X-HTTP-Method-Override": "DELETE"}).status_code == 403
	assert hits == {"bridge": 1}


def test_ordinary_traffic_is_untouched():
	for getter in (lambda _request: None, lambda _request: {"isImpersonation": False}):
		app, hits = _fastapi_app(getter)
		assert TestClient(app).post("/api/admin/purge").status_code == 200
		assert hits == {"admin": 1}


# --------------------------------------------------------------------------- Django


_DJANGO_HITS: dict[str, int] = {}


def _view(name):
	def view(_request, **_kwargs):
		_DJANGO_HITS[name] = _DJANGO_HITS.get(name, 0) + 1
		return HttpResponse(name)

	return view


_URLS = types.ModuleType("devora_guard_test_urls")
_URLS.urlpatterns = [
	django_path("", _view("root")),
	django_path("api/search", _view("search")),
	django_path("api/<str:name>/delete", _view("delete")),
	re_path(r"^api/admin/(?P<rest>.*)$", _view("admin")),
	django_path("api/export", _view("export")),
	django_path("api/items/<str:item>", _view("items")),
	django_path(BRIDGE.lstrip("/"), _view("bridge")),
	*i18n_patterns(re_path(r"^api/admin/(?P<rest>.*)$", _view("i18n-admin")), prefix_default_language=False),
]


def _dispatch(request):
	"""Stand-in for Django's handler: LocaleMiddleware activation, then URL resolution."""
	language = translation.get_language_from_path(request.path_info) or "en"
	with translation.override(language):
		match = resolve(request.path_info, urlconf=_URLS)
	return match.func(request, **match.kwargs)


async def _async_dispatch(request):
	return _dispatch(request)


def _django_request(method, path, headers=None, **extra):
	factory = RequestFactory()
	return factory.generic(method, path, headers=headers or {}, **extra)


def _django_run(getter, method, path, headers=None, sdk=None, asynchronous=False, **extra):
	_DJANGO_HITS.clear()
	middleware = create_impersonation_guard(sdk or _SDK(), getter)
	request = _django_request(method, path, headers, **extra)
	if asynchronous:
		response = asyncio.run(middleware(_async_dispatch)(request))
	else:
		response = middleware(_dispatch)(request)
	return response.status_code, dict(_DJANGO_HITS)


@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize("name,scope,method,path,headers,reached", CASES, ids=[c[0] for c in CASES])
def test_django_corpus_never_reaches_prohibited_handlers(asynchronous, name, scope, method, path, headers, reached):
	status, hits = _django_run(lambda _r: _context(scope), method, path, headers, asynchronous=asynchronous)
	assert bool(hits) is reached, (name, status)
	if not reached:
		assert status != 200


@override_settings(USE_I18N=True, LANGUAGE_CODE="en", LANGUAGES=[("en", "English"), ("fr", "French")])
def test_django_locale_prefix_cannot_dodge_deny_rules():
	# The resolver strips /fr/ before matching; the guard must judge that path too.
	assert _django_run(lambda _r: None, "POST", "/fr/api/admin/purge") == (200, {"i18n-admin": 1})
	assert _django_run(lambda _r: _context("write"), "POST", "/fr/api/admin/purge") == (403, {})


def test_django_script_name_full_and_relative_deny_rules_both_block():
	for pattern in ("/api/admin/**", "/app/api/admin/**"):
		policy = _policy()
		policy.blocked_endpoints[:] = [{"method": "*", "pattern": pattern}]
		result = _django_run(
			lambda _r: _context("write"), "POST", "/api/admin/purge", sdk=_SDK(policy), SCRIPT_NAME="/app"
		)
		assert result == (403, {}), pattern
	# Allow rules use the full client-visible path.
	allow = _policy(extra_safe=[{"method": "POST", "pattern": "/app/api/items/1"}])
	assert _django_run(
		lambda _r: _context("read"), "POST", "/api/items/1", sdk=_SDK(allow), SCRIPT_NAME="/app"
	) == (200, {"items": 1})
	assert _django_run(lambda _r: _context("read"), "POST", "/api/search", SCRIPT_NAME="/app")[1] == {}


@pytest.mark.parametrize(
	"getter",
	[
		lambda _r: SimpleNamespace(**_context("write")),
		lambda _r: _DataclassContext(),
		lambda _r: {},
		lambda _r: {**_context("write"), "isImpersonation": 1},
	],
)
@pytest.mark.parametrize("asynchronous", [False, True])
def test_django_unrecognised_contexts_fail_closed(getter, asynchronous):
	assert _django_run(getter, "POST", "/api/admin/purge", asynchronous=asynchronous) == (500, {})


def test_django_async_getter_is_enforced_in_async_stacks_and_fails_closed_in_sync_stacks():
	async def getter(_request):
		return _context("read")

	assert _django_run(getter, "POST", "/api/items/1", asynchronous=True) == (403, {})
	assert _django_run(getter, "POST", "/api/search", asynchronous=True) == (200, {"search": 1})
	assert _django_run(getter, "POST", "/api/search") == (500, {})


@pytest.mark.parametrize("expires_at", [math.inf, math.nan, "inf", "9999999999999", True])
def test_django_malformed_expiry_is_rejected_without_crashing(expires_at):
	assert _django_run(lambda _r: _context("write", expiresAt=expires_at), "POST", "/api/items/1") == (401, {})


# --------------------------------------------------------------------------- SDK-04 tolerances


@pytest.mark.parametrize("tolerance", [math.nan, math.inf, -math.inf, -1, 1.5, True, "300"])
def test_invalid_timestamp_tolerances_are_rejected_everywhere(tolerance):
	with pytest.raises(ValueError):
		devora_sdk("pk_server_live_" + "A" * 32, "sk_server_live_" + "a" * 64, "org", environment="development", timestamp_tolerance=tolerance, prefetch_scope_config=False)
	with pytest.raises(ValueError):
		ProcessRequestOptions(timestamp_tolerance=tolerance)
	with pytest.raises(ValueError):
		DjangoAdapterOptions(timestamp_tolerance=tolerance)
	with pytest.raises(ValueError):
		FastAPIAdapterOptions(timestamp_tolerance=tolerance)


def test_invalid_per_call_tolerances_fail_closed():
	from signing_support import API_KEY, ORG_ID, SECRET_KEY, sign

	sdk = devora_sdk(API_KEY, SECRET_KEY, ORG_ID, environment="development", prefetch_scope_config=False)
	try:
		headers, _ = sign("GET", "/x", sent_at=str(int(time.time()) - 3600))
		for tolerance in (math.nan, math.inf, -1):
			# NaN previously accepted this hour-old request, and replayed it.
			for _ in range(2):
				assert not sdk.verify_request("GET", "/x", "", b"", headers, timestamp_tolerance=tolerance).valid
	finally:
		sdk.destroy()


def test_zero_tolerance_means_current_second_only():
	from devora_sdk.security import validate_timestamp

	assert validate_timestamp(int(time.time()), 0)[0]
	assert not validate_timestamp(int(time.time()) - 5, 0)[0]
