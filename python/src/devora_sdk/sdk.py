from __future__ import annotations

import json
import inspect
import os
import re
import time
from typing import Any, Callable, Optional

from .constants import (
	DEFAULT_API_URL,
	DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
	DEVORA_ENDPOINTS,
	ENDPOINT_METHODS,
	PROTECTED_ENDPOINTS,
	SDK_VERSION,
	BROWSER_RESUME_CODE_ENDPOINT,
	TAB_REF_PATTERN,
)
from .hmac import sha256_hex, sign_request, signature_matches
from .models import DevoraRequest, SDKRoute, SDKStats, ValidationResult
from .policy import ScopeConfig, ScopeConfigFetcher
from .security import is_valid_timestamp_tolerance, validate_timestamp, validate_timestamp_tolerance
from .signing import (
	CUSTOMER_TO_DEVORA,
	DEVORA_TO_CUSTOMER,
	build_canonical_string,
	has_identity_content_encoding,
	is_valid_signed_path,
	is_valid_signed_query,
	matches,
	parse_signature_headers,
	replay_expires_at_ms,
	replay_namespace,
)
from .transport import ControlPlaneError, control_plane_request
from .replay import InMemoryReplayStore, ReplayStore


def resolve_environment(explicit: Optional[str] = None) -> str:
	"""Explicit option first, then DEVORA_ENV / NODE_ENV as hints, else production."""
	raw = (explicit or os.environ.get("DEVORA_ENV") or os.environ.get("NODE_ENV") or "production")
	raw = str(raw).strip().lower()
	return raw if raw in ("development", "test") else "production"


class DevoraBackendSDK:
	def __init__(
		self,
		api_key: str,
		secret_key: str,
		org_id: str,
		timestamp_tolerance: int = DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
		collect_stats: bool = False,
		debug: bool = False,
		api_url: Optional[str] = None,
		replay_store: Optional[ReplayStore] = None,
		environment: Optional[str] = None,
		prefetch_scope_config: bool = False,
		**_ignored_options: Any,
	) -> None:
		# Unknown preferences are intentionally discarded; capture is owned by Devora.
		if not matches("key_id", api_key):
			raise ValueError("Devora SDK: api_key must be a server key identifier (pk_server_live_*)")
		if not _valid_secret_key(secret_key):
			raise ValueError("Devora SDK: invalid server secret key")
		if not org_id.strip():
			raise ValueError("Devora SDK: org_id is required")
		validate_timestamp_tolerance(timestamp_tolerance)

		self.api_key = api_key
		self._secret_key = secret_key
		self.org_id = org_id
		self.api_url = _resolve_api_url(api_url)
		self.timestamp_tolerance = timestamp_tolerance
		self.collect_stats = collect_stats
		self.debug = debug
		self.stats = SDKStats()
		self._routes: list[SDKRoute] = []
		# Fail closed: anything that is not explicitly a development/test runtime
		# is production, and production must share replay protection across
		# processes. Explicit option first, then DEVORA_ENV / NODE_ENV as hints.
		self.environment = resolve_environment(environment)
		if self.environment == "production" and replay_store is None:
			raise ValueError(
				"Devora SDK: replay_store is required in production. Pass a persistent "
				"ReplayStore, or environment='development' (InMemoryReplayStore) for local "
				"development only."
			)
		self._replay_store = replay_store or InMemoryReplayStore()
		self._scope_config = ScopeConfigFetcher(
			api_key=api_key,
			api_url=self.api_url,
			prefetch=prefetch_scope_config,
			sign_request=lambda: sign_request(
				secret_key=self._secret_key,
				direction=CUSTOMER_TO_DEVORA,
				key_id=self.api_key,
				org_id=self.org_id,
				method="GET",
				path="/api/sdk/scope-config",
			),
		)
		self._register_built_ins()

	@property
	def config(self) -> dict[str, Any]:
		"""Redacted configuration view. The secret key is never exposed."""
		return {
			"api_key": self.api_key,
			"secret_key": "[REDACTED]",
			"org_id": self.org_id,
			"api_url": self.api_url,
			"timestamp_tolerance": self.timestamp_tolerance,
			"collect_stats": self.collect_stats,
			"debug": self.debug,
		}

	def register(
		self,
		path: str,
		handler: Optional[Callable[[DevoraRequest], Any]] = None,
		method: Optional[str] = None,
	) -> Any:
		def add_route(route_handler: Callable[[DevoraRequest], Any]) -> SDKRoute:
			if path in PROTECTED_ENDPOINTS:
				raise ValueError(f"Cannot override protected endpoint: {path}")
			if any(route.path == path for route in self._routes):
				raise ValueError(f"Endpoint already registered: {path}")
			route_method = (ENDPOINT_METHODS.get(path) or method or "GET").upper()
			route = SDKRoute(path=path, method=route_method, handler=route_handler, is_built_in=False)
			self._routes.append(route)
			return route

		if handler is None:
			return add_route
		return add_route(handler)

	def get_routes(self) -> list[SDKRoute]:
		return list(self._routes)

	def get_stats(self) -> dict[str, Any]:
		return self.stats.to_dict()

	def verify_request(
		self,
		method: str,
		path: str,
		query: str,
		body: bytes,
		headers: Any,
		timestamp_tolerance: Optional[int] = None,
	) -> ValidationResult:
		"""Verify a signed request from Devora (signature v3) over its exact bytes.

		``path`` is relative to the SDK mount and still percent-encoded; ``query``
		is everything after the first ``?``; ``body`` is the raw bytes; ``headers``
		is a mapping or a list of ``(name, value)`` pairs (duplicates are
		rejected). Steps before the replay store never touch it.
		"""
		tolerance = self.timestamp_tolerance if timestamp_tolerance is None else timestamp_tolerance
		if not is_valid_timestamp_tolerance(tolerance):
			return ValidationResult(valid=False, error="Invalid timestamp tolerance", error_code="TIMESTAMP_EXPIRED")

		parsed, error_code, error_message = parse_signature_headers(headers)
		if parsed is None:
			return ValidationResult(valid=False, error=error_message, error_code=error_code)
		if parsed["key_id"] != self.api_key or parsed["org_id"] != self.org_id:
			return ValidationResult(
				valid=False,
				error="Request key or organization does not match SDK configuration",
				error_code="ORG_MISMATCH",
			)
		sent_at = int(parsed["sent_at"])
		timestamp_ok, timestamp_error = validate_timestamp(sent_at, tolerance)
		if not timestamp_ok:
			return ValidationResult(valid=False, error=timestamp_error, error_code="TIMESTAMP_EXPIRED")
		if not matches("method", method) or not is_valid_signed_path(path) or not is_valid_signed_query(query):
			return ValidationResult(valid=False, error="Invalid request target", error_code="INVALID_REQUEST_TARGET")
		if not has_identity_content_encoding(headers):
			return ValidationResult(
				valid=False, error="Content-Encoding is not supported", error_code="UNSUPPORTED_CONTENT_ENCODING"
			)
		if not isinstance(body, (bytes, bytearray)):
			return ValidationResult(valid=False, error="Raw body bytes are required", error_code="INVALID_BODY")

		canonical = build_canonical_string(
			direction=DEVORA_TO_CUSTOMER,
			key_id=parsed["key_id"],
			org_id=parsed["org_id"],
			sent_at=parsed["sent_at"],
			request_id=parsed["request_id"],
			method=method,
			path=path,
			query=query,
			body_sha256=sha256_hex(bytes(body)),
		)
		if not signature_matches(self._secret_key, canonical, parsed["signature"]):
			return ValidationResult(valid=False, error="Invalid HMAC signature", error_code="INVALID_SIGNATURE")

		try:
			fresh = self._replay_store.consume(
				replay_namespace(DEVORA_TO_CUSTOMER, parsed["key_id"]),
				parsed["request_id"],
				replay_expires_at_ms(sent_at, int(time.time()), tolerance),
			)
		except Exception:
			return ValidationResult(
				valid=False, error="Replay protection is unavailable", error_code="REPLAY_STORE_UNAVAILABLE"
			)
		if not isinstance(fresh, bool):
			if inspect.iscoroutine(fresh):
				fresh.close()
			return ValidationResult(
				valid=False, error="Replay store must return a boolean decision", error_code="REPLAY_STORE_UNAVAILABLE"
			)
		if not fresh:
			return ValidationResult(valid=False, error="Request was already processed", error_code="REPLAYED_REQUEST")
		return ValidationResult(
			valid=True,
			org_id=parsed["org_id"],
			key_id=parsed["key_id"],
			timestamp=sent_at,
			request_id=parsed["request_id"],
		)

	def get_scope_config(self) -> Optional[ScopeConfig]:
		return self._scope_config.get_config()

	def get_cached_scope_config(self) -> Optional[ScopeConfig]:
		return self._scope_config.get_cached_config()

	def refresh_scope_config(self) -> Optional[ScopeConfig]:
		return self._scope_config.refresh()

	def _signed_devora_post(self, path: str, payload: dict[str, Any]) -> tuple[int, Optional[dict[str, Any]]]:
		"""POST a signed JSON body to a Devora SDK endpoint (customer-to-devora)."""
		body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
		headers = sign_request(
			secret_key=self._secret_key,
			direction=CUSTOMER_TO_DEVORA,
			key_id=self.api_key,
			org_id=self.org_id,
			method="POST",
			path=path,
			body=body,
		)
		status, json_body, _ = control_plane_request(f"{self.api_url}{path}", "POST", headers, body)
		return status, json_body

	def get_session_status(self, session_id: str) -> Optional[dict[str, Any]]:
		"""Check whether a Devora session is still live (server-side liveness check).

		Returns the status payload (including a ``valid`` flag), or ``None`` when Devora is
		unreachable so callers can choose fail-open or fail-closed behavior.
		"""
		if not isinstance(session_id, str) or not session_id or len(session_id) > 128:
			return None
		try:
			status, payload = self._signed_devora_post("/api/sdk/session-status", {"sessionId": session_id})
		except (ControlPlaneError, ValueError):
			return None
		if status == 404:
			return {"valid": False, "error": "SESSION_NOT_FOUND"}
		if not (200 <= status < 300) or not payload or payload.get("success") is not True:
			return None
		data = payload.get("data")
		if isinstance(data, dict) and isinstance(data.get("valid"), bool):
			return data
		return None

	def create_browser_resume_code(
		self, session_id: str, tab_ref: str, origin: str
	) -> Optional[dict[str, Any]]:
		"""Mint a one-time browser resume code for an active session.

		Signed customer-to-devora. Returns ``{"code", "expiresAt"}``; ``{"error": ...}``
		when Devora rejected the request; ``None`` when Devora is unreachable.
		"""
		if not isinstance(session_id, str) or not session_id or len(session_id) > 128:
			return {"error": "INVALID_SESSION"}
		if not isinstance(tab_ref, str) or not re.fullmatch(TAB_REF_PATTERN, tab_ref):
			return {"error": "INVALID_TAB_REF"}
		try:
			status, payload = self._signed_devora_post(
				BROWSER_RESUME_CODE_ENDPOINT, {"sessionId": session_id, "tabRef": tab_ref, "origin": origin}
			)
		except (ControlPlaneError, ValueError):
			return None
		data = payload.get("data") if payload else None
		if 200 <= status < 300 and payload and payload.get("success") is True and isinstance(data, dict) and isinstance(data.get("code"), str):
			return data
		if status >= 500 or status == 429:
			return None
		error_code = payload.get("error") if payload else None
		return {"error": error_code if isinstance(error_code, str) else "RESUME_REJECTED", "status": status}

	def destroy(self) -> None:
		self._scope_config.stop()

	def record_request(self, endpoint: str, outcome: str) -> None:
		self.stats.total_requests += 1
		if self.collect_stats:
			self.stats.requests_by_endpoint[endpoint] = self.stats.requests_by_endpoint.get(endpoint, 0) + 1
		if outcome == "success":
			self.stats.successful_requests += 1
		else:
			self.stats.failed_requests += 1
			if outcome == "security_error":
				self.stats.security_errors += 1

	def _register_built_ins(self) -> None:
		def test_handler(req: DevoraRequest) -> dict[str, Any]:
			return {
				"status": "success",
				"message": "Devora SDK connection test successful",
				"timestamp": _now_ms(),
				"orgId": req.org_id,
				"keyId": req.key_id,
				"sdk": {"name": "devora-python", "version": SDK_VERSION, "type": "backend", "runtime": "python"},
				"security": {"hmacValidated": True, "timestampValid": True},
			}

		def health_handler(_: DevoraRequest) -> dict[str, Any]:
			return {
				"status": "healthy",
				"sdk": {"name": "devora-python", "version": SDK_VERSION, "type": "backend", "runtime": "python"},
				"stats": self.get_stats() if self.collect_stats else None,
				"endpoints": {route.path: route.method for route in self._routes},
			}

		self._routes.append(SDKRoute(DEVORA_ENDPOINTS.TEST, "GET", test_handler, True))
		self._routes.append(SDKRoute(DEVORA_ENDPOINTS.HEALTH, "GET", health_handler, True))


def devora_sdk(
	api_key: str,
	secret_key: str,
	org_id: str,
	timestamp_tolerance: int = DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
	collect_stats: bool = False,
	debug: bool = False,
	api_url: Optional[str] = None,
	replay_store: Optional[ReplayStore] = None,
	environment: Optional[str] = None,
	prefetch_scope_config: bool = False,
	**_ignored_options: Any,
) -> DevoraBackendSDK:
	return DevoraBackendSDK(
		api_key=api_key,
		secret_key=secret_key,
		org_id=org_id,
		timestamp_tolerance=timestamp_tolerance,
		collect_stats=collect_stats,
		debug=debug,
		api_url=api_url,
		replay_store=replay_store,
		environment=environment,
		prefetch_scope_config=prefetch_scope_config,
	)


def _valid_secret_key(secret_key: str) -> bool:
	return matches("secret_key", secret_key)


def _resolve_api_url(override: Optional[str]) -> str:
	"""Validate an API origin override (advanced; e.g. self-hosted deployments).

	Only https origins are accepted (http for localhost/127.0.0.1 development).
	"""
	if not override:
		return DEFAULT_API_URL
	from urllib.parse import urlparse

	parsed = urlparse(override.strip())
	is_localhost = parsed.hostname in ("localhost", "127.0.0.1")
	if parsed.scheme != "https" and not (parsed.scheme == "http" and is_localhost):
		raise ValueError("Devora SDK: api_url must use https (http is allowed for localhost only)")
	if parsed.username or parsed.password or (parsed.path and parsed.path != "/") or parsed.query or parsed.fragment:
		raise ValueError("Devora SDK: api_url must be an origin without path, query, or credentials")
	if not parsed.netloc:
		raise ValueError(f"Devora SDK: api_url is not a valid URL: {override}")
	return f"{parsed.scheme}://{parsed.netloc}"


def _now_ms() -> int:
	import time

	return int(time.time() * 1000)
