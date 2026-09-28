from __future__ import annotations

import json
import re
from typing import Any, Mapping, Optional, Union
from urllib.parse import quote, unquote


def create_success_response(data: Any) -> dict[str, Any]:
	return {"success": True, "data": data, "timestamp": now_ms()}


def create_error_response(error: str, error_code: Optional[str] = None) -> dict[str, Any]:
	response: dict[str, Any] = {"success": False, "error": error, "timestamp": now_ms()}
	if error_code:
		response["errorCode"] = error_code
	return response


def now_ms() -> int:
	import time

	return int(time.time() * 1000)


def match_path(pattern: str, path: str) -> tuple[bool, dict[str, str]]:
	pattern_parts = [part for part in pattern.split("/") if part]
	path_parts = [part for part in path.split("/") if part]
	if len(pattern_parts) != len(path_parts):
		return False, {}

	params: dict[str, str] = {}
	for pattern_part, path_part in zip(pattern_parts, path_parts):
		if pattern_part.startswith(":"):
			params[pattern_part[1:]] = safe_decode_path_part(path_part)
		elif pattern_part != path_part:
			return False, {}
	return True, params


def get_header(headers: Mapping[str, Any], key: str) -> Optional[str]:
	value = headers.get(key)
	if value is None:
		value = headers.get(key.lower())
	if value is None:
		value = headers.get(key.upper())
	if value is None:
		lower_key = key.lower()
		for header_key, header_value in headers.items():
			if str(header_key).lower() == lower_key:
				value = header_value
				break
	if isinstance(value, (list, tuple)):
		value = value[0] if value else None
	return str(value) if value is not None else None


def get_error_status_code(error_code: Optional[str]) -> int:
	if not error_code:
		return 400
	if error_code in (
		"INVALID_IMPERSONATION_CONTEXT",
		"IMPERSONATION_EXPIRED",
		"IMPERSONATION_SESSION_ENDED",
	):
		return 401
	if error_code in ("IMPERSONATION_POLICY_UNAVAILABLE", "REPLAY_STORE_UNAVAILABLE"):
		return 503
	if error_code == "REPLAYED_REQUEST":
		return 401
	if error_code == "UNSUPPORTED_CONTENT_ENCODING":
		return 415
	if error_code in ("IMPERSONATION_ENDPOINT_BLOCKED", "IMPERSONATION_SCOPE_VIOLATION"):
		return 403
	if any(
		token in error_code
		for token in ("SECURITY", "SIGNATURE", "TIMESTAMP", "MISSING_HEADERS", "ORG_MISMATCH")
	):
		return 401
	if error_code == "NOT_FOUND":
		return 404
	if "SCOPE" in error_code or "WRITE_BLOCKED" in error_code:
		return 403
	if "BODY_TOO_LARGE" in error_code or "PAYLOAD_TOO_LARGE" in error_code:
		return 413
	if "RATE_LIMITED" in error_code or "TOO_MANY_REQUESTS" in error_code:
		return 429
	if error_code == "INTERNAL_ERROR":
		return 500
	return 400


def safe_decode_path_part(value: str) -> str:
	try:
		return unquote(value)
	except Exception:
		return value


def encode_uri_component(value: str) -> str:
	return quote(value, safe="-_.!~*'()")


def normalize_request_path(raw_target: str) -> str:
	"""Path of a raw origin-form target (``/path?query``), percent-decoded once."""
	path = (raw_target or "/").split("?", 1)[0].split("#", 1)[0]
	return unquote(path, errors="strict")


def is_ambiguous_request_path(path: str) -> bool:
	"""Reject paths whose segment boundaries could differ between routers.

	``path`` is a path only, never a target with a query: either the raw
	percent-encoded path or the decoded path the framework routes on. A decoded
	path is never split at ``?`` or ``#``; those are ordinary characters there
	(``%3F`` in the wire path), and cutting at them would judge a different path
	from the one the router dispatches.
	"""
	path = path or "/"
	# Adapters hand over already-decoded paths, so a space or a bare "%" is
	# ordinary parameter content; control characters and backslashes are not.
	if len(path) > 8192 or not path.startswith("/") or re.search(r"[\\\x00-\x1f\x7f]", path):
		return True
	try:
		decoded = unquote(path, errors="strict")
	except (ValueError, UnicodeError):
		return True
	# A still-encoded sequence after one decode means double encoding.
	return bool(
		re.search(r"[\\;\x00-\x1f\x7f]|%[0-9a-fA-F]{2}", decoded)
		or re.search(r"%(2f|5c)", path, re.I)
		or "//" in decoded
		or any(part in (".", "..") for part in decoded.split("/"))
	)


def match_endpoint_pattern(pattern: str, path: str, *, case_sensitive: bool = True, ignore_trailing_slash: bool = False) -> bool:
	"""Same bounded segment glob as JS core; no regex backtracking or recursion."""
	if len(pattern) > 500 or len(path) > 8192:
		return False
	pattern = pattern if pattern.startswith("/") else "/" + pattern
	path = path if path.startswith("/") else "/" + path
	if not case_sensitive:
		pattern, path = pattern.lower(), path.lower()
	if ignore_trailing_slash:
		pattern, path = pattern.rstrip("/") or "/", path.rstrip("/") or "/"

	def segment_matches(token: str, value: str) -> bool:
		previous = [True] + [False] * len(value)
		for char in token:
			current = [previous[0] if char == "*" else False] + [False] * len(value)
			for j in range(1, len(value) + 1):
				current[j] = (previous[j] or current[j - 1]) if char == "*" else (previous[j - 1] and char == value[j - 1])
			previous = current
		return previous[-1]

	parts = path[1:].split("/")
	previous = [True] + [False] * len(parts)
	for token in pattern[1:].split("/"):
		current = [previous[0] if token == "**" else False] + [False] * len(parts)
		for j in range(1, len(parts) + 1):
			current[j] = (previous[j] or current[j - 1]) if token == "**" else (previous[j - 1] and segment_matches(token, parts[j - 1]))
		previous = current
	return previous[-1]
