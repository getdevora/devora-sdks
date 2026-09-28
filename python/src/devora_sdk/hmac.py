"""Request signing v3 primitives (hashlib/hmac)."""
from __future__ import annotations

import hashlib
import hmac as _hmac
import time
import uuid
from typing import Optional

from .constants import SECURITY_HEADERS
from .signing import VERSION, build_canonical_string, matches


def sha256_hex(body: bytes) -> str:
	return hashlib.sha256(body).hexdigest()


def hmac_hex(secret_key: str, canonical: str) -> str:
	"""Lowercase hex HMAC-SHA256 keyed by the secret's ASCII bytes."""
	return _hmac.new(secret_key.encode("ascii"), canonical.encode("ascii"), hashlib.sha256).hexdigest()


def signature_matches(secret_key: str, canonical: str, provided: object) -> bool:
	"""Constant-time byte comparison. Never raises; lenient hex is rejected."""
	if not matches("signature", provided):
		return False
	return _hmac.compare_digest(bytes.fromhex(hmac_hex(secret_key, canonical)), bytes.fromhex(provided))  # type: ignore[arg-type]


def sign_request(
	*,
	secret_key: str,
	direction: str,
	key_id: str,
	org_id: str,
	method: str,
	path: str,
	query: str = "",
	body: bytes = b"",
	sent_at: Optional[int] = None,
	request_id: Optional[str] = None,
) -> dict[str, str]:
	"""Headers for an outgoing signed request (the body is sent as given)."""
	sent = str(int(time.time()) if sent_at is None else sent_at)
	rid = request_id or str(uuid.uuid4())
	canonical = build_canonical_string(
		direction=direction,
		key_id=key_id,
		org_id=org_id,
		sent_at=sent,
		request_id=rid,
		method=method,
		path=path,
		query=query,
		body_sha256=sha256_hex(body),
	)
	headers = {
		SECURITY_HEADERS.SIGNATURE_VERSION: VERSION,
		SECURITY_HEADERS.KEY_ID: key_id,
		SECURITY_HEADERS.ORG_ID: org_id,
		SECURITY_HEADERS.SENT_AT: sent,
		SECURITY_HEADERS.REQUEST_ID: rid,
		SECURITY_HEADERS.SIGNATURE: hmac_hex(secret_key, canonical),
	}
	if body:
		headers["Content-Type"] = "application/json"
	return headers
