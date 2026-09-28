from __future__ import annotations

import inspect
import logging
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional, Union

from .constants import DEFAULT_MAX_BODY_SIZE_BYTES, DEVORA_ENDPOINTS
from .models import DevoraImpersonationContext, DevoraRequest, SDKRoute
from .security import validate_timestamp_tolerance
from .signing import get_single_header, parse_verified_json_body, parse_verified_query
from .utils import (
	create_error_response,
	create_success_response,
	match_path,
)

logger = logging.getLogger("devora_sdk")


@dataclass(frozen=True)
class AdapterRequest:
	"""A request exactly as received. The signature covers these bytes.

	``path`` is relative to the SDK mount and still percent-encoded; ``query`` is
	everything after the first ``?``; ``body`` is the raw bytes; ``headers`` is a
	mapping or a list of ``(name, value)`` pairs (so duplicates are visible).
	"""

	method: str
	path: str
	query: str
	body: bytes
	headers: Any


@dataclass(frozen=True)
class ProcessRequestOptions:
	timestamp_tolerance: Optional[int] = None
	max_body_size: int = DEFAULT_MAX_BODY_SIZE_BYTES

	def __post_init__(self) -> None:
		validate_timestamp_tolerance(self.timestamp_tolerance)


@dataclass(frozen=True)
class _PreparedRequest:
	route: SDKRoute
	devora_request: DevoraRequest
	record: Callable[[str, Optional[str]], None]


def process_request(
	sdk: Any,
	routes: list[SDKRoute],
	request: AdapterRequest,
	options: Optional[ProcessRequestOptions] = None,
) -> dict[str, Any]:
	prepared = _prepare_request(sdk, routes, request, options)
	if isinstance(prepared, dict):
		return prepared

	try:
		result = prepared.route.handler(prepared.devora_request)
		if inspect.isawaitable(result):
			close = getattr(result, "close", None)
			if callable(close):
				close()
			raise TypeError("Async Devora handlers require async_process_request")
		prepared.record("success", prepared.route.path)
		return create_success_response(result)
	except Exception:
		logger.exception("Devora SDK: customer handler raised")
		prepared.record("failure", prepared.route.path)
		return create_error_response("Customer handler failed", "HANDLER_ERROR")


async def async_process_request(
	sdk: Any,
	routes: list[SDKRoute],
	request: AdapterRequest,
	options: Optional[ProcessRequestOptions] = None,
) -> dict[str, Any]:
	import asyncio

	loop = asyncio.get_running_loop()
	# _prepare_request verifies the HMAC signature and consumes the replay
	# nonce; in production the replay store is disk- or network-backed, so
	# this can block. Run it off the event loop rather than stalling every
	# other request this async server is handling. Using the stdlib executor
	# (rather than anyio/Starlette's threadpool) keeps this module usable from
	# any asyncio-based framework, not just FastAPI.
	prepared = await loop.run_in_executor(None, _prepare_request, sdk, routes, request, options)
	if isinstance(prepared, dict):
		return prepared

	try:
		if inspect.iscoroutinefunction(prepared.route.handler):
			result = await prepared.route.handler(prepared.devora_request)
		else:
			# A synchronous customer handler may itself block (a DB call, an
			# HTTP request, ...) — never call it directly on the event loop.
			# This also lets a sync Django ORM call run safely from Django's
			# async view path, which otherwise raises SynchronousOnlyOperation.
			result = await loop.run_in_executor(None, prepared.route.handler, prepared.devora_request)
			if inspect.isawaitable(result):
				result = await result
		prepared.record("success", prepared.route.path)
		return create_success_response(result)
	except Exception:
		logger.exception("Devora SDK: customer handler raised")
		prepared.record("failure", prepared.route.path)
		return create_error_response("Customer handler failed", "HANDLER_ERROR")


def create_generic_handler(
	sdk: Any,
	routes: list[SDKRoute],
	options: Optional[ProcessRequestOptions] = None,
) -> Callable[[AdapterRequest], dict[str, Any]]:
	def handler(request: AdapterRequest) -> dict[str, Any]:
		return process_request(sdk, routes, request, options)

	return handler


def _prepare_request(
	sdk: Any,
	routes: list[SDKRoute],
	request: AdapterRequest,
	options: Optional[ProcessRequestOptions] = None,
) -> Union[dict[str, Any], _PreparedRequest]:
	options = options or ProcessRequestOptions()
	method = request.method
	path = request.path

	def record(outcome: str, endpoint: Optional[str] = None) -> None:
		if hasattr(sdk, "record_request"):
			sdk.record_request(endpoint or "UNMATCHED", outcome)

	if not isinstance(request.body, (bytes, bytearray)):
		record("failure")
		return create_error_response("Adapter must supply the raw request body bytes", "INVALID_BODY")
	body = bytes(request.body)
	if len(body) > options.max_body_size:
		record("failure")
		return create_error_response("Request body too large", "BODY_TOO_LARGE")
	if method in ("GET", "HEAD") and body:
		record("failure")
		return create_error_response("GET and HEAD requests must not have a body", "INVALID_BODY")

	# Signature v3 over the exact wire bytes, before any route lookup, so
	# unauthenticated callers learn nothing about registered routes.
	validation = sdk.verify_request(method, path, request.query, body, request.headers, options.timestamp_tolerance)
	if not validation.valid:
		record("security_error")
		return create_error_response(
			validation.error or "Security validation failed",
			validation.error_code or "INVALID_SIGNATURE",
		)

	route = _find_matching_route(routes, method, path)
	if not route:
		record("failure")
		return create_error_response("No handler found for this request", "NOT_FOUND")
	_, params = match_path(route.path, path)

	body_ok, parsed_body = parse_verified_json_body(body, get_single_header(request.headers, "content-type") or None)
	if not body_ok:
		record("failure", route.path)
		return create_error_response(parsed_body, "INVALID_BODY")
	try:
		parsed_query = parse_verified_query(request.query)
	except (UnicodeDecodeError, ValueError):
		record("failure", route.path)
		return create_error_response("Invalid query string", "INVALID_REQUEST_TARGET")

	context_result = _build_devora_context(route, path, parsed_body, params)
	if context_result.get("error"):
		record("security_error", route.path)
		return create_error_response(context_result["error"], "INVALID_IMPERSONATION_CONTEXT")

	context = context_result.get("context")
	session_id = context.session_id if context else _session_id_from_route(route, params, parsed_body)

	devora_request = DevoraRequest(
		method=method,
		path=path,
		params=params,
		query=parsed_query,
		body=parsed_body,
		headers=request.headers,
		org_id=validation.org_id or "",
		key_id=validation.key_id or "",
		session_id=session_id,
		devora_context=context,
	)

	return _PreparedRequest(route=route, devora_request=devora_request, record=record)


def _find_matching_route(routes: list[SDKRoute], method: str, path: str) -> Optional[SDKRoute]:
	for route in routes:
		matched, _ = match_path(route.path, path)
		if route.method.upper() == method and matched:
			return route
	return None


def _build_devora_context(
	route: SDKRoute, path: str, body: Any, params: Mapping[str, str]
) -> dict[str, Any]:
	if route.path != DEVORA_ENDPOINTS.IMPERSONATE:
		return {}
	if not isinstance(body, dict):
		return {"error": "Impersonation request body must be an object"}
	session_id = _read_string(body.get("sessionId"))
	scope = body.get("scope")
	expires_at = _read_number(body.get("expiresAt"))
	if not session_id or len(session_id) > 128:
		return {"error": "Impersonation request is missing a valid session ID"}
	if scope not in ("read", "write"):
		return {"error": "Impersonation request is missing a valid scope"}
	from .utils import now_ms

	if not expires_at or expires_at <= now_ms():
		return {"error": "Impersonation request is expired or missing expiration"}
	target_user = _read_user(body.get("targetUser"), params.get("id"))
	if not target_user:
		_, matched_params = match_path(route.path, path)
		target_user = _read_user(body.get("targetUser"), matched_params.get("id"))
	if not target_user:
		return {"error": "Impersonation request is missing target user context"}
	impersonator = _read_user(body.get("impersonator"))
	if not impersonator:
		return {"error": "Impersonation request is missing impersonator context"}
	auth_method = body.get("authMethod")
	if auth_method != "devora_impersonation":
		return {"error": "Impersonation request has an invalid authentication method"}
	authorization_source = body.get("authorizationSource")
	if authorization_source not in (
		"standard",
		"self_approved",
		"self_approved_read",
		"break_glass",
	):
		return {"error": "Impersonation request has an invalid authorization source"}
	recording_allowed = body.get("recordingAllowed")
	if not isinstance(recording_allowed, bool):
		return {"error": "Impersonation request is missing recording authorization"}
	return {
		"context": DevoraImpersonationContext(
			session_id=session_id,
			scope=str(scope),
			expires_at=int(expires_at),
			impersonator=impersonator,
			target_user=target_user,
			auth_method=auth_method,
			authorization_source=authorization_source,
			recording_allowed=recording_allowed,
		)
	}


def _session_id_from_route(route: SDKRoute, params: Mapping[str, str], body: Any) -> Optional[str]:
	if route.path == DEVORA_ENDPOINTS.TERMINATE and params.get("id"):
		return params["id"]
	if isinstance(body, dict):
		return _read_string(body.get("sessionId"))
	return None


def _read_string(value: Any) -> Optional[str]:
	return value if isinstance(value, str) and value.strip() else None


def _read_number(value: Any) -> Optional[int]:
	if isinstance(value, (int, float)):
		return int(value)
	if isinstance(value, str) and value.strip():
		try:
			return int(float(value))
		except ValueError:
			return None
	return None


def _read_user(value: Any, fallback_id: Optional[str] = None) -> Optional[dict[str, Any]]:
	source = value if isinstance(value, dict) else {}
	user_id = _read_string(source.get("id")) or fallback_id
	if not user_id:
		return None
	result = {"id": user_id}
	if _read_string(source.get("email")):
		result["email"] = source["email"]
	if _read_string(source.get("name")):
		result["name"] = source["name"]
	return result
