"""Devora request signing, version 3. Mirrors @devorash/core security/signing.ts.

The signature covers the exact bytes on the wire: raw path, raw query and a
SHA-256 of the raw body, plus the direction the request travels in. Every
header has one accepted spelling. Conformance vectors:
packages/sdks/test/signing-v3-vectors.json.
"""
from __future__ import annotations

import json
import math
import re
from typing import Any, Iterable, Mapping, Optional, Sequence, Union
from urllib.parse import parse_qsl, unquote

from .constants import SECURITY_HEADERS

VERSION = "3"
ALGORITHM = "DEVORA-HMAC-SHA256"
DEVORA_TO_CUSTOMER = "devora-to-customer"
CUSTOMER_TO_DEVORA = "customer-to-devora"
EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

#: Exact header grammars. A value must match in full; nothing is trimmed.
PATTERNS = {
	"signature_version": re.compile(r"3"),
	"key_id": re.compile(r"pk_server_live_[A-Za-z0-9_-]{32}"),
	"org_id": re.compile(r"[A-Za-z0-9_-]{1,128}"),
	"sent_at": re.compile(r"[1-9][0-9]{9}"),
	"request_id": re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"),
	"signature": re.compile(r"[0-9a-f]{64}"),
	"method": re.compile(r"[A-Z]{3,7}"),
	"body_sha256": re.compile(r"[0-9a-f]{64}"),
	"secret_key": re.compile(r"sk_server_live_[A-Za-z0-9_-]{64}"),
}

HeaderInput = Union[Mapping[str, Any], Sequence[tuple[Any, Any]]]

_UNRESERVED = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~")


def matches(name: str, value: Any) -> bool:
	"""Full-string ASCII match; ``str.isdigit``-style Unicode digits never pass."""
	return isinstance(value, str) and value.isascii() and PATTERNS[name].fullmatch(value) is not None


def strict_encode(value: str) -> str:
	"""UTF-8 percent-encode every byte outside ``A-Z a-z 0-9 - _ . ~`` (uppercase hex)."""
	return "".join(chr(byte) if byte in _UNRESERVED else f"%{byte:02X}" for byte in value.encode("utf-8"))


def encode_path_param(value: str) -> str:
	"""Encode one path parameter; ``""``, ``.`` and ``..`` cannot be sent as signed."""
	if value in ("", ".", ".."):
		raise ValueError("Devora signing: unroutable path parameter")
	return strict_encode(value)


def build_strict_query(pairs: Iterable[tuple[str, str]]) -> str:
	"""Strict-encoded ``key=value`` pairs in the given order (the order is signed)."""
	return "&".join(f"{strict_encode(key)}={strict_encode(value)}" for key, value in pairs)


_STRICT_ASCII = re.compile(r"[\x21-\x7E]*")
_BAD_ESCAPE = re.compile(r"%(?![0-9A-F]{2})")


def _is_strict_ascii(value: str) -> bool:
	return _STRICT_ASCII.fullmatch(value) is not None and not _BAD_ESCAPE.search(value)


def is_valid_signed_path(path: str) -> bool:
	"""Absolute, printable ASCII, uppercase escapes, no empty or dot segments."""
	if not isinstance(path, str) or not path.startswith("/") or len(path) > 8192 or not _is_strict_ascii(path) or any(char in path for char in "?#\\"):
		return False
	if path == "/":
		return True
	try:
		unquote(path, errors="strict")
	except UnicodeDecodeError:
		return False
	return all(segment.replace("%2E", ".") not in ("", ".", "..") for segment in path[1:].split("/"))


def is_valid_signed_query(query: str) -> bool:
	if not isinstance(query, str) or "#" in query or len(query) > 8192 or not _is_strict_ascii(query):
		return False
	try:
		unquote(query, errors="strict")
		return True
	except UnicodeDecodeError:
		return False


def build_canonical_string(
	*,
	direction: str,
	key_id: str,
	org_id: str,
	sent_at: str,
	request_id: str,
	method: str,
	path: str,
	query: str,
	body_sha256: str,
) -> str:
	"""Build the canonical string. Raises ValueError if any field is outside its grammar."""
	checks = [
		(direction in (DEVORA_TO_CUSTOMER, CUSTOMER_TO_DEVORA), "direction"),
		(matches("key_id", key_id), "key id"),
		(matches("org_id", org_id), "org id"),
		(matches("sent_at", sent_at), "sent-at"),
		(matches("request_id", request_id), "request id"),
		(matches("method", method), "method"),
		(is_valid_signed_path(path), "path"),
		(is_valid_signed_query(query), "query"),
		(matches("body_sha256", body_sha256), "body digest"),
	]
	for ok, name in checks:
		if not ok:
			raise ValueError(f"Devora signing: invalid {name}")
	return "\n".join(
		[ALGORITHM, VERSION, direction, key_id, org_id, sent_at, request_id, method, path, query, body_sha256]
	)


def _header_items(headers: HeaderInput) -> Iterable[tuple[str, Any]]:
	if isinstance(headers, Mapping):
		return headers.items()
	return headers


def get_single_header(headers: HeaderInput, name: str) -> Union[str, None, bool]:
	"""The single value of a header; ``None`` if absent, ``False`` if repeated.

	Accepts a mapping or a list of ``(name, value)`` pairs (so frameworks that
	keep duplicates can pass them). Byte values are decoded as latin-1.
	"""
	values: list[str] = []
	for key, value in _header_items(headers):
		key = key.decode("latin-1") if isinstance(key, (bytes, bytearray)) else str(key)
		if key.lower() != name or value is None:
			continue
		for item in value if isinstance(value, (list, tuple)) else [value]:
			values.append(item.decode("latin-1") if isinstance(item, (bytes, bytearray)) else str(item))
	if len(values) > 1:
		return False
	return values[0] if values else None


def parse_signature_headers(headers: HeaderInput) -> tuple[Optional[dict[str, str]], Optional[str], Optional[str]]:
	"""Return ``(headers, error_code, error)``. Never first-wins, never trims."""
	version = get_single_header(headers, SECURITY_HEADERS.SIGNATURE_VERSION)
	values = {
		"key_id": get_single_header(headers, SECURITY_HEADERS.KEY_ID),
		"org_id": get_single_header(headers, SECURITY_HEADERS.ORG_ID),
		"sent_at": get_single_header(headers, SECURITY_HEADERS.SENT_AT),
		"request_id": get_single_header(headers, SECURITY_HEADERS.REQUEST_ID),
		"signature": get_single_header(headers, SECURITY_HEADERS.SIGNATURE),
	}
	if isinstance(version, str) and version != VERSION and version.isascii() and version.isdigit():
		return None, "UNSUPPORTED_SIGNATURE_VERSION", "Unsupported signature version"
	if not matches("signature_version", version) or not all(matches(name, value) for name, value in values.items()):
		return None, "INVALID_SIGNATURE_HEADERS", "Missing, duplicate or malformed signature headers"
	return values, None, None  # type: ignore[return-value]


def has_identity_content_encoding(headers: HeaderInput) -> bool:
	value = get_single_header(headers, "content-encoding")
	return value is None or value == "identity"


def replay_namespace(direction: str, key_id: str) -> str:
	return f"v{VERSION}:{direction}:{key_id}"


def replay_expires_at_ms(sent_at: int, now_seconds: int, tolerance_seconds: int) -> int:
	"""Covers the floor second of the timestamp check plus one second of jitter."""
	return (max(now_seconds, sent_at) + tolerance_seconds + 2) * 1000


def parse_verified_query(query: str) -> dict[str, Union[str, list[str]]]:
	"""Parse a verified raw query. Repeated keys become lists in wire order."""
	result: dict[str, Union[str, list[str]]] = {}
	for key, value in parse_qsl(query, keep_blank_values=True, strict_parsing=False, errors="strict"):
		existing = result.get(key)
		if existing is None:
			result[key] = value
		elif isinstance(existing, list):
			existing.append(value)
		else:
			result[key] = [existing, value]
	return result


def parse_verified_json_body(body: bytes, content_type: Optional[str]) -> tuple[bool, Any]:
	"""``(True, value)`` or ``(False, error)``. Empty means ``None``; otherwise
	strict UTF-8 JSON declared as ``application/json``."""
	if not body:
		return True, None
	if not isinstance(content_type, str) or not re.fullmatch(r"application/json(\s*;.*)?", content_type.strip(), re.IGNORECASE):
		return False, "Signed request bodies must be application/json"
	try:
		return True, json.loads(
			body.decode("utf-8"), object_pairs_hook=_unique_object,
			parse_constant=_reject_constant, parse_float=_finite_float,
		)
	except (UnicodeDecodeError, ValueError, RecursionError):
		return False, "Invalid JSON body"


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
	result: dict[str, Any] = {}
	for key, value in pairs:
		if key in result:
			raise ValueError("Duplicate JSON key")
		result[key] = value
	return result


def _reject_constant(value: str) -> Any:
	raise ValueError("Non-finite JSON number")


def _finite_float(value: str) -> float:
	parsed = float(value)
	if not math.isfinite(parsed):
		raise ValueError("Non-finite JSON number")
	return parsed


def route_relative_path(raw_path: str, route_template: str) -> Optional[str]:
	"""Last N raw segments of ``raw_path`` (N = the template's segment count)."""
	count = len([part for part in route_template.split("/") if part])
	if count == 0:
		return "/"
	segments = raw_path.split("/")
	if len(segments) - 1 < count:
		return None
	return "/" + "/".join(segments[-count:])
