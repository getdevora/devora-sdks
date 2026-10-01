from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

for package in ("python", "django"):
	sys.path.insert(0, str(Path(__file__).resolve().parents[2] / package / "src"))

from django.conf import settings
from django.test import RequestFactory
from devora_sdk import devora_sdk
from devora_sdk.models import SDKRoute
from devora_sdk_django.adapter import (
	DjangoAdapterOptions, django_view, async_django_view, browser_session_view,
)

if not settings.configured:
	settings.configure(DEFAULT_CHARSET="utf-8", SECRET_KEY="synthetic-test-key")


@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize("declared", [False, True])
def test_django_limits_raw_bytes_before_json_parsing(asynchronous, declared):
	request = RequestFactory().post("/devora/echo", data=" " * 4096 + "{}", content_type="application/json")
	if not declared:
		request.META["CONTENT_LENGTH"] = ""
	read = request.read
	sizes = []
	def bounded_read(size):
		sizes.append(size)
		return read(size)
	request.read = bounded_read
	route = SDKRoute(path="/echo", method="POST", handler=lambda _: pytest.fail("must reject before handler"))
	view = (async_django_view if asynchronous else django_view)(object(), [route], route, DjangoAdapterOptions(max_body_size=1024))
	response = asyncio.run(view(request)) if asynchronous else view(request)
	assert response.status_code == 413
	assert json.loads(response.content)["errorCode"] == "BODY_TOO_LARGE"
	assert sizes == ([] if declared else [1025])
	assert not hasattr(request, "_body")  # No eager HttpRequest.body allocation.


def test_django_browser_bridge_has_a_small_independent_body_budget():
	request = RequestFactory().post("/api/devora/browser-session", data=" " * 4097 + "{}", content_type="application/json")
	view = browser_session_view(object(), lambda _: pytest.fail("oversize must not reach the bridge"))
	assert view(request).status_code == 413
	assert not hasattr(request, "_body")


@pytest.mark.parametrize("asynchronous", [False, True])
def test_django_bounded_reads_preserve_signed_json_requests(asynchronous):
	from signing_support import API_KEY, ORG_ID, SECRET_KEY, sign

	sdk = devora_sdk(API_KEY, SECRET_KEY, ORG_ID, prefetch_scope_config=False)
	try:
		route = sdk.register("/echo", lambda request: {"received": request.body}, method="POST")
		body = {"value": "é😀"}
		headers, raw = sign("POST", "/echo", body=body)
		# RAW_URI is what WSGI servers such as gunicorn pass through unchanged.
		request = RequestFactory().post("/devora/echo", data=raw, content_type="application/json", headers=headers, RAW_URI="/devora/echo")
		view = (async_django_view if asynchronous else django_view)(sdk, sdk.get_routes(), route, DjangoAdapterOptions(max_body_size=1024))
		response = asyncio.run(view(request)) if asynchronous else view(request)
		assert response.status_code == 200, response.content
		assert json.loads(response.content)["data"]["received"] == body
	finally:
		sdk.destroy()


def test_browser_session_bridge_is_exempt_from_django_csrf_tokens():
	# Django enables CsrfViewMiddleware by default and the browser SDK cannot
	# send a CSRF token; the bridge authorizes by cookie + allowed Origin.
	view = browser_session_view(object(), lambda request: None, allowed_origins=["https://app.example"])
	assert getattr(view, "csrf_exempt", False) is True
