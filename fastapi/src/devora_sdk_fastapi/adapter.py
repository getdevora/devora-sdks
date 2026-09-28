from __future__ import annotations

import inspect
import asyncio
import json
import re
import warnings
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Mapping, Optional, Union

from devora_sdk.guard import _validate_context
from devora_sdk import (
	AdapterRequest,
	ImpersonationContext,
	InvalidImpersonationContext,
	ProcessRequestOptions,
	route_relative_path,
	strict_encode,
	SessionLivenessChecker,
	async_process_request,
	coerce_impersonation_context,
	evaluate_impersonation_guard,
	policy_methods,
	validate_timestamp_tolerance,
)
from devora_sdk.models import SDKRoute
from devora_sdk.utils import create_error_response, get_error_status_code
from starlette.requests import Request as _StarletteRequest


def _private_json_response(*args: Any, **kwargs: Any) -> Any:
	from fastapi.responses import JSONResponse

	response = JSONResponse(*args, **kwargs)
	response.headers["Cache-Control"] = "private, no-store"
	return response


@dataclass(frozen=True)
class FastAPIAdapterOptions:
	timestamp_tolerance: Optional[int] = None
	max_body_size: Optional[int] = None

	def __post_init__(self) -> None:
		validate_timestamp_tolerance(self.timestamp_tolerance)


ContextGetter = Callable[[Any], Union[Optional[ImpersonationContext], Awaitable[Optional[ImpersonationContext]]]]
BlockedCallback = Callable[[Any, ImpersonationContext], Union[None, Awaitable[None]]]


def fastapi_router(sdk: Any, options: Optional[FastAPIAdapterOptions] = None) -> Any:
	from fastapi import APIRouter

	adapter_options = options or FastAPIAdapterOptions()
	routes = sdk.get_routes()
	router = APIRouter()

	for route in routes:
		router.add_api_route(
			fastapi_route_path(route.path),
			_endpoint_for_route(sdk, routes, route, adapter_options),
			methods=[route.method],
			include_in_schema=False,
			name=_route_name(route),
		)

	return router


def fastapi_adapter(sdk: Any, options: Optional[FastAPIAdapterOptions] = None) -> Any:
	return fastapi_router(sdk, options)


def fastapi_route_path(path: str) -> str:
	return re.sub(r":([A-Za-z_][A-Za-z0-9_]*)", r"{\1}", path)


def _endpoint_for_route(
	sdk: Any,
	routes: list[SDKRoute],
	route: SDKRoute,
	options: FastAPIAdapterOptions,
) -> Callable[[Any], Awaitable[Any]]:
	from fastapi import Request
	from fastapi.responses import JSONResponse

	async def endpoint(request: Any) -> Any:
		try:
			max_body_size = (
				options.max_body_size
				if options.max_body_size is not None
				else ProcessRequestOptions.max_body_size
			)
			content_length = request.headers.get("content-length")
			if content_length is not None:
				try:
					declared_size = int(content_length)
				except ValueError:
					declared_size = None
				if declared_size is not None and declared_size > max_body_size:
					return _private_json_response(
						create_error_response("Request body too large", "BODY_TOO_LARGE"),
						status_code=get_error_status_code("BODY_TOO_LARGE"),
					)
			path = route_relative_path(_wire_path(request), route.path)
			if path is None:
				return _private_json_response(create_error_response("Not found", "NOT_FOUND"), status_code=404)
			raw_query = request.scope.get("query_string", b"")
			adapter_request = AdapterRequest(
				method=request.method,
				path=path,
				query=bytes(raw_query).decode("latin-1"),
				body=await _read_bounded_body(request, max_body_size),
				# Raw pairs keep duplicate headers visible to the verifier.
				headers=list(request.headers.raw),
			)
			response = await async_process_request(
				sdk,
				routes,
				adapter_request,
				ProcessRequestOptions(
					timestamp_tolerance=options.timestamp_tolerance,
					max_body_size=max_body_size,
				),
			)
			status_code = 200 if response.get("success") else get_error_status_code(response.get("errorCode"))
			return _private_json_response(response, status_code=status_code)
		except _BodyReadError as error:
			return _private_json_response(create_error_response(str(error), error.code), status_code=error.status)
		except Exception:
			return _private_json_response(
				{
					"success": False,
					"errorCode": "INTERNAL_ERROR",
					"error": "An unexpected error occurred",
				},
				status_code=500,
			)

	endpoint.__annotations__ = {"request": Request, "return": JSONResponse}
	return endpoint


@dataclass(frozen=True)
class _GuardOptions:
	sdk: Any
	get_impersonation_context: ContextGetter
	on_blocked: Optional[BlockedCallback] = None
	blocked_response: Mapping[str, Any] = field(default_factory=dict)
	show_warnings: bool = False
	enforce_liveness: bool = True
	liveness_cache_ttl_ms: int = 5_000
	on_liveness_unavailable: str = "deny"
	is_impersonation_allowed: Optional[Callable[[Any, ImpersonationContext], Union[bool, Awaitable[bool]]]] = None
	bridge_path: Optional[str] = None


class DevoraImpersonationGuardMiddleware:
	"""Starlette/FastAPI middleware enforcing the Devora impersonation policy.

	``get_impersonation_context`` may be sync or async and returns ``None`` for
	ordinary traffic, or a dict / ``ImpersonationContext``. Any other value fails
	closed with a 500. Policy patterns match the full client-visible path
	(``scope["path"]``, including ``root_path``); deny rules also match the path
	relative to ``root_path``. ``bridge_path`` enables the read-scope allowance
	for a mounted browser-session bridge (off by default).
	"""

	def __init__(
		self,
		app: Any,
		sdk: Any,
		get_impersonation_context: ContextGetter,
		on_blocked: Optional[BlockedCallback] = None,
		blocked_response: Optional[Mapping[str, Any]] = None,
		show_warnings: bool = False,
		enforce_liveness: bool = True,
		liveness_cache_ttl_ms: int = 5_000,
		on_liveness_unavailable: str = "deny",
		is_impersonation_allowed: Optional[
			Callable[[Any, ImpersonationContext], Union[bool, Awaitable[bool]]]
		] = None,
		bridge_path: Optional[str] = None,
	) -> None:
		from starlette.middleware.base import BaseHTTPMiddleware

		self._middleware = BaseHTTPMiddleware(
			app,
			dispatch=self.dispatch,
		)
		self.options = _GuardOptions(
			sdk=sdk,
			get_impersonation_context=get_impersonation_context,
			on_blocked=on_blocked,
			blocked_response=blocked_response or {},
			show_warnings=show_warnings,
			enforce_liveness=enforce_liveness,
			liveness_cache_ttl_ms=liveness_cache_ttl_ms,
			on_liveness_unavailable=on_liveness_unavailable,
			is_impersonation_allowed=is_impersonation_allowed,
			bridge_path=bridge_path,
		)
		self._liveness = (
			SessionLivenessChecker(sdk, liveness_cache_ttl_ms, on_liveness_unavailable)
			if enforce_liveness
			else None
		)

	async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
		await self._middleware(scope, receive, send)

	async def dispatch(self, request: Any, call_next: Callable[[Any], Awaitable[Any]]) -> Any:
		from fastapi.responses import JSONResponse

		try:
			blocked = await self._decide(request)
		except Exception:
			# Extractor, policy and hook failures fail closed.
			blocked = _private_json_response(
				create_error_response("Impersonation guard failed", "INTERNAL_ERROR"), status_code=500
			)
		return blocked if blocked is not None else await call_next(request)

	async def _decide(self, request: Any) -> Optional[Any]:
		"""Return a blocking JSONResponse, or None to continue."""
		from fastapi.responses import JSONResponse
		from starlette.concurrency import run_in_threadpool

		try:
			context = coerce_impersonation_context(
				await _maybe_await(self.options.get_impersonation_context(request))
			)
		except InvalidImpersonationContext:
			return _private_json_response(
				create_error_response("Invalid impersonation context", "INVALID_IMPERSONATION_CONTEXT"),
				status_code=500,
			)
		# Non-impersonation traffic passes through without policy or liveness lookups.
		if not context or not context.is_impersonation:
			return None
		session_live: Optional[bool] = None
		liveness_unavailable = False
		if self._liveness and isinstance(context.session_id, str) and context.session_id:
			session_live, liveness_unavailable = await run_in_threadpool(
				self._liveness.check, context.session_id
			)
		policy = await run_in_threadpool(self.options.sdk.get_scope_config)
		# The customer hook is semantic authorization for otherwise-valid, live
		# sessions. Never invoke it for an invalid/expired context, an ended or
		# unverifiable session, or while policy is unavailable.
		semantic_allowed = True
		if (
			self.options.is_impersonation_allowed
			and _validate_context(context)[0]
			and session_live is not False
			and not liveness_unavailable
			and policy is not None
		):
			semantic_allowed = await _maybe_await(self.options.is_impersonation_allowed(request, context))
		path, aliases = _guard_paths(request)
		decision = evaluate_impersonation_guard(
			request.method,
			path,
			context,
			policy,
			session_live=session_live,
			liveness_unavailable=liveness_unavailable,
			is_impersonation_allowed=(lambda _context: semantic_allowed),
			bridge_path=self.options.bridge_path,
			raw_path=_raw_request_path(request),
			alias_paths=aliases,
			methods=policy_methods(request.method, request.headers, request.url.query),
		)
		if decision.allowed:
			return None

		# Notify only for actual blocks (scope/endpoint/liveness), not for
		# temporary policy unavailability (503) — matching the Node guard.
		notify_blocked = decision.status_code == 403 or (decision.body or {}).get(
			"errorCode"
		) == "IMPERSONATION_SESSION_ENDED"
		if self.options.on_blocked and notify_blocked:
			try:
				await _maybe_await(self.options.on_blocked(request, context))
			except Exception:
				pass  # Audit callbacks cannot change the decision.
		if self.options.show_warnings:
			warnings.warn(
				f"[Devora] Blocked {request.method} {path} (session: {context.session_id})",
				RuntimeWarning,
				stacklevel=2,
			)

		status_code, body = _guard_response(
			decision.status_code,
			decision.body,
			self.options.blocked_response,
		)
		return _private_json_response(body, status_code=status_code)


def _route_name(route: SDKRoute) -> str:
	name = route.path.strip("/").replace("/", "_").replace(":", "")
	return f"devora_{route.method.lower()}_{name or 'root'}"


def _raw_request_path(request: Any) -> Optional[str]:
	"""The still-percent-encoded path, straight from the ASGI scope.

	Devora signs path params with ``encodeURIComponent``; Starlette's decoded
	``request.url.path`` can no longer match that signature for values containing
	reserved characters (``@``, ``+``, space, ...).
	"""
	scope = getattr(request, "scope", None)
	if isinstance(scope, Mapping):
		raw = scope.get("raw_path")
		if isinstance(raw, (bytes, bytearray)):
			try:
				return bytes(raw).decode("ascii")
			except UnicodeDecodeError:
				return bytes(raw).decode("latin-1")
	return None


def _routed_request_path(request: Any) -> str:
	"""The decoded path Starlette's router actually dispatches on.

	``request.url.path`` is re-parsed as a WHATWG URL, which silently strips tab,
	line feed and carriage return; the router matches ``scope["path"]`` where
	those bytes survive. The guard must judge the path the router judges, or a
	``%09`` inside a whitelisted read path lets a write reach a parameterised
	handler.
	"""
	scope = getattr(request, "scope", None)
	if isinstance(scope, Mapping):
		path = scope.get("path")
		if isinstance(path, str):
			return path
	return str(request.url.path)


def _guard_paths(request: Any) -> tuple[str, list[str]]:
	"""The full client-visible routed path, plus the root_path-relative view."""
	path = _routed_request_path(request)
	aliases: list[str] = []
	scope = getattr(request, "scope", None)
	root_path = scope.get("root_path", "") if isinstance(scope, Mapping) else ""
	if isinstance(root_path, str) and root_path and path.startswith(root_path):
		aliases.append(path[len(root_path) :] or "/")
	return path, aliases


def _wire_path(request: Any) -> str:
	"""ASGI ``raw_path`` as sent; otherwise the strict re-encoded decoded path,
	which reproduces what Devora's strict signer sent and fails closed otherwise."""
	raw = _raw_request_path(request)
	if raw is not None:
		return raw
	return "/".join(strict_encode(part) if part else "" for part in _routed_request_path(request).split("/"))


class _BodyReadError(ValueError):
	def __init__(self, code: str, status: int, message: str):
		super().__init__(message)
		self.code = code
		self.status = status


async def _read_bounded_body(request: Any, max_bytes: int, timeout: float = 5.0) -> bytes:
	if not isinstance(max_bytes, int) or max_bytes < 0 or timeout <= 0:
		raise ValueError("Invalid body budget")
	declared = request.headers.get("content-length")
	if declared is not None:
		if not declared.isascii() or not declared.isdigit():
			raise _BodyReadError("INVALID_BODY", 400, "Invalid Content-Length")
		if int(declared) > max_bytes:
			raise _BodyReadError("BODY_TOO_LARGE", 413, "Request body too large")

	async def read() -> bytes:
		body = bytearray()
		async for chunk in request.stream():
			if len(body) + len(chunk) > max_bytes:
				raise _BodyReadError("BODY_TOO_LARGE", 413, "Request body too large")
			body.extend(chunk)
		return bytes(body)

	try:
		return await asyncio.wait_for(read(), timeout=timeout)
	except asyncio.TimeoutError as error:
		raise _BodyReadError("BODY_TIMEOUT", 408, "Request body timed out") from error


async def _maybe_await(value: Any) -> Any:
	if inspect.isawaitable(value):
		return await value
	return value


def _guard_response(
	status_code: int,
	body: Optional[dict[str, object]],
	blocked_response: Mapping[str, Any],
) -> tuple[int, dict[str, object]]:
	response_body = dict(body or {})
	if status_code == 403:
		status_code = int(blocked_response.get("status", status_code))
		if response_body.get("errorCode") == "IMPERSONATION_SCOPE_VIOLATION":
			response_body["error"] = blocked_response.get(
				"message", response_body.get("error", "This action is blocked during impersonation")
			)
			response_body["errorCode"] = blocked_response.get(
				"errorCode", response_body.get("errorCode", "IMPERSONATION_SCOPE_VIOLATION")
			)
	return status_code, response_body


def browser_session_router(
	sdk: Any,
	get_impersonation_context: Callable[[Any], Any],
	path: str = "/api/devora/browser-session",
	allowed_origins: Optional[list[str]] = None,
) -> Any:
	"""Router exposing ``POST <path>`` for the browser-session bridge.

	Include it on the app that already authenticates requests; the context
	callable is the same one given to the guard middleware.
	"""
	from fastapi import APIRouter
	from fastapi.responses import JSONResponse
	from starlette.concurrency import run_in_threadpool

	from devora_sdk import resolve_browser_session

	router = APIRouter()

	# NOTE: the parameter annotation must resolve from module globals because
	# this module uses `from __future__ import annotations`; a function-local
	# `Request` import would make FastAPI treat it as a query parameter.
	@router.post(path)
	async def browser_session(request: _StarletteRequest) -> JSONResponse:
		try:
			body = json.loads(await _read_bounded_body(request, 4096))
		except _BodyReadError as error:
			return _private_json_response(create_error_response(str(error), error.code), status_code=error.status)
		except (ValueError, UnicodeDecodeError):
			return _private_json_response({"success": False, "error": "Invalid JSON body"}, status_code=400)
		try:
			context = coerce_impersonation_context(await _maybe_await(get_impersonation_context(request)))
		except InvalidImpersonationContext:
			return _private_json_response({"status": "blocked", "reason": "session_invalid"}, status_code=500)
		status, payload = await run_in_threadpool(
			resolve_browser_session,
			sdk,
			context,
			(body or {}).get("tabRef") if isinstance(body, dict) else None,
			request.headers.get("origin"),
			allowed_origins,
		)
		return _private_json_response(payload, status_code=status, headers={"Cache-Control": "private, no-store"})

	return router
