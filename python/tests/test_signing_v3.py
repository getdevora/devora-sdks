"""Request signing v3 conformance (Python). Mirrors packages/sdks/test/signing-v3.test.ts;
the vectors are shared with the Node SDK and the Devora backend."""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import pytest

for package in ("python", "django", "fastapi"):
	sys.path.insert(0, str(Path(__file__).resolve().parents[2] / package / "src"))

from django.conf import settings

if not settings.configured:
	settings.configure(DEFAULT_CHARSET="utf-8", SECRET_KEY="synthetic-test-key")

from devora_sdk import AdapterRequest, devora_sdk, process_request
from devora_sdk.hmac import signature_matches
from devora_sdk.signing import build_canonical_string, encode_path_param, parse_signature_headers, strict_encode
from signing_support import API_KEY, ORG_ID, SECRET_KEY, VECTORS, sign
from signing_support import strict_encode as ref_encode

VECTOR_TOLERANCE = 100_000_000
C = VECTORS["constants"]


def _sdk():
	return devora_sdk(API_KEY, SECRET_KEY, ORG_ID, environment="development", prefetch_scope_config=False)


def _vector(vector_id):
	return next(v for v in VECTORS["positive"] if v["id"] == vector_id)


def _headers(vector):
	headers = {
		"x-devora-signature-version": "3",
		"x-devora-key-id": C["keyId"],
		"x-devora-org-id": C["orgId"],
		"x-devora-sent-at": C["sentAt"],
		"x-devora-request-id": C["requestId"],
		"x-devora-signature": vector["signature"],
	}
	if vector["bodyHex"]:
		headers["content-type"] = "application/json"
	return headers


def _verify(vector, *, path=None, query=None, body=None, headers=None, tolerance=VECTOR_TOLERANCE):
	sdk = _sdk()
	try:
		return sdk.verify_request(
			vector["method"],
			vector["path"] if path is None else path,
			vector["query"] if query is None else query,
			bytes.fromhex(vector["bodyHex"]) if body is None else body,
			_headers(vector) if headers is None else headers,
			timestamp_tolerance=tolerance,
		)
	finally:
		sdk.destroy()


def test_canonical_builder_and_encoder_reproduce_shared_vectors():
	for v in VECTORS["positive"]:
		assert build_canonical_string(
			direction=v["direction"], key_id=C["keyId"], org_id=C["orgId"], sent_at=C["sentAt"],
			request_id=C["requestId"], method=v["method"], path=v["path"], query=v["query"], body_sha256=v["bodySha256"],
		) == v["canonical"]
		assert signature_matches(C["secret"], v["canonical"], v["signature"])
	for case in VECTORS["encoder"]:
		assert strict_encode(case["input"]) == case["encoded"] == ref_encode(case["input"])
	for segment in VECTORS["refusedSegments"]:
		with pytest.raises(ValueError):
			encode_path_param(segment)


@pytest.mark.parametrize("vector", VECTORS["positive"], ids=[v["id"] for v in VECTORS["positive"]])
def test_sdk_verifier_accepts_only_devora_to_customer_vectors(vector):
	result = _verify(vector)
	assert result.valid is (vector["direction"] == "devora-to-customer"), result.error_code
	if not result.valid:
		assert result.error_code == "INVALID_SIGNATURE"


def _bad_header_cases():
	good = _headers(_vector("V01"))
	signature = good["x-devora-signature"]
	transforms = {"UPPER": signature.upper(), "APPEND_zz": signature + "zz", "APPEND_0": signature + "0", "TRUNCATE_1": signature[:-1], "": ""}
	for name, values in VECTORS["badHeaders"].items():
		for value in values:
			yield {**good, name: transforms[value] if name == "x-devora-signature" else value}
	yield {**good, "x-devora-signature": [signature, signature]}
	yield {**good, "x-devora-signature": f"{signature}, {signature}"}
	yield [*good.items(), ("X-Devora-Signature", signature)]


@pytest.mark.parametrize("headers", list(_bad_header_cases()))
def test_malformed_duplicated_or_lenient_headers_are_rejected(headers):
	parsed, _, _ = parse_signature_headers(headers)
	assert parsed is None
	assert not _verify(_vector("V01"), headers=headers).valid


def test_non_ascii_signature_never_raises():
	assert signature_matches(C["secret"], _vector("V01")["canonical"], "é" * 64) is False
	assert signature_matches(C["secret"], _vector("V01")["canonical"], None) is False


def test_wire_bytes_are_authenticated_exactly():
	assert _verify(_vector("V02a"), query="a=2&a=1").error_code == "INVALID_SIGNATURE"
	assert _verify(_vector("V08"), query="term=a").error_code == "INVALID_SIGNATURE"
	assert _verify(_vector("V09"), path=_vector("V09")["path"].lower()).error_code == "INVALID_REQUEST_TARGET"
	assert _verify(_vector("V01"), query="term=alice#frag").error_code == "INVALID_REQUEST_TARGET"
	for path in ("/user//search", "/user/./search", "/user/%2e%2e/search", "user/search"):
		assert _verify(_vector("V01"), path=path).error_code == "INVALID_REQUEST_TARGET"
	bodies = [_vector(i) for i in ("V04a", "V04b", "V04c", "V04d")]
	for signed in bodies:
		for sent in bodies:
			result = _verify(signed, body=bytes.fromhex(sent["bodyHex"]))
			assert result.valid is (signed is sent)
	gzip_headers = {**_headers(_vector("V04b")), "content-encoding": "gzip"}
	assert _verify(_vector("V04b"), headers=gzip_headers).error_code == "UNSUPPORTED_CONTENT_ENCODING"
	# Wire order wins, so non-BMP keys and exponent spellings verify identically to Node.
	assert _verify(_vector("V12")).valid
	assert _verify(_vector("V06a")).valid and _verify(_vector("V06b")).valid


def test_replay_timestamp_edges_and_zero_tolerance():
	sdk = _sdk()
	try:
		headers, _ = sign("GET", "/test")
		assert sdk.verify_request("GET", "/test", "", b"", headers).valid
		assert sdk.verify_request("GET", "/test", "", b"", headers).error_code == "REPLAYED_REQUEST"
		now = int(time.time())
		assert sdk.verify_request("GET", "/test", "", b"", sign("GET", "/test", sent_at=str(now - 290))[0]).valid
		assert sdk.verify_request("GET", "/test", "", b"", sign("GET", "/test", sent_at=str(now - 310))[0]).error_code == "TIMESTAMP_EXPIRED"
		stale = sign("GET", "/test", sent_at=str(now - 2))[0]
		assert sdk.verify_request("GET", "/test", "", b"", stale, timestamp_tolerance=0).error_code == "TIMESTAMP_EXPIRED"
	finally:
		sdk.destroy()


def test_replay_store_failure_fails_closed():
	class Down:
		def consume(self, *_args):
			raise OSError("store down")

	sdk = devora_sdk(API_KEY, SECRET_KEY, ORG_ID, replay_store=Down(), prefetch_scope_config=False)
	try:
		headers, _ = sign("GET", "/test")
		assert sdk.verify_request("GET", "/test", "", b"", headers).error_code == "REPLAY_STORE_UNAVAILABLE"
	finally:
		sdk.destroy()


def test_process_request_parses_only_verified_bytes():
	sdk = _sdk()
	received = {}
	sdk.register("/echo/:id", lambda req: received.update(query=req.query, body=req.body, params=req.params) or {"ok": True}, method="POST")
	try:
		path = "/echo/" + strict_encode("a/b c@é")
		query = "a=2&a=1&__proto__=x"
		headers, raw = sign("POST", path, query, '{"n":1e-7}')
		response = process_request(sdk, sdk.get_routes(), AdapterRequest("POST", path, query, raw, headers))
		assert response["success"], response
		assert received == {"query": {"a": ["2", "1"], "__proto__": "x"}, "body": {"n": 1e-7}, "params": {"id": "a/b c@é"}}
		invalid = bytes.fromhex(_vector("V17")["bodyHex"])
		headers, raw = sign("POST", "/echo/x", body=invalid)
		assert process_request(sdk, sdk.get_routes(), AdapterRequest("POST", "/echo/x", "", raw, headers))["errorCode"] == "INVALID_BODY"
		headers, _ = sign("GET", "/test")
		assert process_request(sdk, sdk.get_routes(), AdapterRequest("GET", "/test", "", b"{}", headers))["errorCode"] == "INVALID_BODY"
	finally:
		sdk.destroy()


def _echo_sdk(seen):
	sdk = _sdk()

	def echo(req):
		seen.append({"id": req.params["id"], "a": req.query.get("a"), "term": req.query.get("term"), "body": req.body})
		return {"ok": True}

	sdk.register("/echo/:id", echo, method="POST")
	return sdk


def _exercise(send, mount, seen, param="a/b c@é"):
	path = "/echo/" + strict_encode(param)
	query = "a=2&a=1&term=it%27s"
	headers, raw = sign("POST", path, query, {"hello": "wörld"})
	status, body = send(f"{mount}{path}?{query}", headers, raw)
	assert status == 200, body
	assert seen.pop() == {"id": param, "a": ["2", "1"], "term": "it's", "body": {"hello": "wörld"}}
	assert send(f"{mount}{path}?{query}", headers, raw)[1]["errorCode"] == "REPLAYED_REQUEST"
	headers, raw = sign("POST", path, query, {"hello": "wörld"})
	assert send(f"{mount}{path}?a=1&a=2&term=it%27s", headers, raw)[1]["errorCode"] == "INVALID_SIGNATURE"
	assert seen == []


def test_fastapi_adapter_verifies_wire_bytes_and_sees_duplicate_headers():
	from fastapi import FastAPI
	from fastapi.testclient import TestClient
	from devora_sdk_fastapi import fastapi_router

	seen = []
	sdk = _echo_sdk(seen)
	app = FastAPI()
	app.include_router(fastapi_router(sdk), prefix="/devora")
	client = TestClient(app)
	try:
		def send(target, headers, raw):
			response = client.post(target, headers=headers, content=raw)
			assert response.headers["Cache-Control"] == "private, no-store"
			return response.status_code, response.json()

		# Starlette routes on the decoded path, so an id containing "/" can never
		# reach a FastAPI route; every other character round-trips.
		_exercise(send, "/devora", seen, param="b c@é+ü'")
		headers, raw = sign("POST", "/echo/x", body={})
		duplicate = [*headers.items(), ("x-devora-signature", headers["x-devora-signature"])]
		response = client.post("/devora/echo/x", headers=duplicate, content=raw)
		assert response.json()["errorCode"] == "INVALID_SIGNATURE_HEADERS"
	finally:
		sdk.destroy()


@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize("raw_uri", [True, False])
def test_django_adapter_verifies_wire_bytes(asynchronous, raw_uri):
	from django.test import RequestFactory
	from devora_sdk_django.adapter import DjangoAdapterOptions, async_django_view, django_view

	seen = []
	sdk = _echo_sdk(seen)
	route = next(r for r in sdk.get_routes() if r.path == "/echo/:id")
	view = (async_django_view if asynchronous else django_view)(sdk, sdk.get_routes(), route, DjangoAdapterOptions())
	try:
		def send(target, headers, raw):
			path, _, query = target.partition("?")
			# RAW_URI is what gunicorn passes; without it (runserver) the adapter
			# strict re-encodes PATH_INFO, which matches what Devora signed.
			extra = {"RAW_URI": target} if raw_uri else {}
			request = RequestFactory().generic("POST", path, data=raw, content_type=headers.get("content-type", ""), headers=headers, QUERY_STRING=query, **extra)
			response = asyncio.run(view(request)) if asynchronous else view(request)
			assert response["Cache-Control"] == "private, no-store"
			return response.status_code, json.loads(response.content)

		if raw_uri:
			_exercise(send, "/devora", seen)
		else:
			# A "/" inside a parameter cannot be recovered from a decoded PATH_INFO;
			# such requests fail closed. Ordinary parameters verify.
			path = "/echo/" + strict_encode("b c@é")
			headers, raw = sign("POST", path, "a=1", {"x": 1})
			assert send(f"/devora{path}?a=1", headers, raw)[0] == 200
			headers, raw = sign("POST", "/echo/" + strict_encode("a/b"), "", {"x": 1})
			assert send("/devora/echo/" + strict_encode("a/b"), headers, raw)[0] != 200
	finally:
		sdk.destroy()
