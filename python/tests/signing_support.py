"""Independent signing-v3 implementation for tests, written from the spec with
the standard library only. Verifiers are tested against this, never against
the SDK's own signer."""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from pathlib import Path
from typing import Any, Optional, Union

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "test" / "signing-v3-vectors.json").read_text())
API_KEY = VECTORS["constants"]["keyId"]
SECRET_KEY = VECTORS["constants"]["secret"]
ORG_ID = VECTORS["constants"]["orgId"]

_UNRESERVED = set(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~")


def strict_encode(value: str) -> str:
	return "".join(chr(b) if b in _UNRESERVED else f"%{b:02X}" for b in value.encode("utf-8"))


def body_bytes(body: Union[None, str, bytes, dict, list]) -> bytes:
	if body is None:
		return b""
	if isinstance(body, bytes):
		return body
	if isinstance(body, str):
		return body.encode("utf-8")
	return json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sign(
	method: str,
	path: str,
	query: str = "",
	body: Union[None, str, bytes, dict, list] = None,
	*,
	direction: str = "devora-to-customer",
	key_id: str = API_KEY,
	org_id: str = ORG_ID,
	secret: str = SECRET_KEY,
	sent_at: Optional[str] = None,
	request_id: Optional[str] = None,
) -> tuple[dict[str, str], bytes]:
	"""Return ``(headers, body_bytes)`` for a v3-signed request."""
	raw = body_bytes(body)
	sent = sent_at or str(int(time.time()))
	rid = request_id or str(uuid.uuid4())
	canonical = "\n".join(
		["DEVORA-HMAC-SHA256", "3", direction, key_id, org_id, sent, rid, method, path, query, hashlib.sha256(raw).hexdigest()]
	)
	signature = hmac.new(secret.encode("ascii"), canonical.encode("ascii"), hashlib.sha256).hexdigest()
	headers = {
		"x-devora-signature-version": "3",
		"x-devora-key-id": key_id,
		"x-devora-org-id": org_id,
		"x-devora-sent-at": sent,
		"x-devora-request-id": rid,
		"x-devora-signature": signature,
	}
	if raw:
		headers["content-type"] = "application/json"
	return headers, raw
