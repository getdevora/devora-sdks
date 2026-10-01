from __future__ import annotations

import inspect
import json
import re
import warnings
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional

from asgiref.sync import iscoroutinefunction, markcoroutinefunction
from devora_sdk import (
	AdapterRequest,
	ImpersonationContext,
	InvalidImpersonationContext,
	route_relative_path,
	strict_encode,
	ProcessRequestOptions,
	SessionLivenessChecker,
	async_process_request,
	coerce_impersonation_context,
	evaluate_impersonation_guard,
	policy_methods,
	process_request,
	validate_timestamp_tolerance,
)
from devora_sdk.models import SDKRoute
from devora_sdk.utils import create_error_response, get_error_status_code


def _private_json_response(*args: Any, **kwargs: Any) -> Any:
	from django.http import JsonResponse

	response = JsonResponse(*args, **kwargs)
	# These routes authenticate with custom headers, so caches cannot infer that
	# customer search/detail responses require authorization.
	response["Cache-Control"] = "private, no-store"
	return response


@dataclass(frozen=True)
class DjangoAdapterOptions:
	timestamp_tolerance: Optional[int] = None
	max_body_size: Optional[int] = None
	trailing_slash: bool = False

	def __post_init__(self) -> None:
		validate_timestamp_tolerance(self.timestamp_tolerance)


@dataclass(frozen=True)
class DjangoImpersonationGuardOptions:
	sdk: Any
	get_impersonation_context: Callable[[Any], Any]
	on_blocked: Optional[Callable[[Any, ImpersonationContext], None]] = None
	blocked_response: Mapping[str, Any] = field(default_factory=dict)
	show_warnings: bool = False
	enforce_liveness: bool = True
	liveness_cache_ttl_ms: int = 5_000
	on_liveness_unavailable: str = "deny"
	is_impersonation_allowed: Optional[Callable[[Any, ImpersonationContext], bool]] = None
	bridge_path: Optional[str] = None
	render_blocked: Optional[Callable[[Any, int, Mapping[str, Any]], Any]] = None


def _wants_html(request: Any) -> bool:
	"""A browser page load or form post, as opposed to a fetch/XHR/API call."""
	headers = request.headers
	if headers.get("X-Requested-With") == "XMLHttpRequest":
		return False
	if "application/json" in (headers.get("Content-Type") or ""):
		return False
	accept = headers.get("Accept") or ""
	return "text/html" in accept and "application/json" not in accept


def _blocked_html_response(request: Any, status_code: int, body: Mapping[str, Any]) -> Any:
	"""Default page for a blocked page load or form post: plain, escaped, never cached."""
	from django.http import HttpResponse
	from django.utils.html import escape

	message = escape(str(body.get("error") or "This action is not allowed during impersonation"))
	html = (
		'<!doctype html><html lang="en"><head><meta charset="utf-8">'
		'<meta name="viewport" content="width=device-width, initial-scale=1">'
		"<title>Action not allowed</title></head>"
		'<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">'
		"<h1 style=\"font-size:1.25rem\">This action is not allowed in this session</h1>"
		f"<p>{message}.</p>"
		'<p><a href="javascript:history.back()">Go back</a></p>'
		"</body></html>"
	)
	response = HttpResponse(html, status=status_code, content_type="text/html; charset=utf-8")
	response["Cache-Control"] = "private, no-store"
	return response


def django_urlpatterns(sdk: Any, options: Optional[DjangoAdapterOptions] = None) -> list[Any]:
	from django.urls import re_path

	adapter_options = options or DjangoAdapterOptions()
	routes = sdk.get_routes()
	patterns: list[Any] = []

	for route in routes:
		view = django_view(sdk, routes, route, adapter_options)
		patterns.append(
			re_path(
				django_route_pattern(route.path, trailing_slash=adapter_options.trailing_slash),
				view,
				name=_route_name(route),
			)
		)

	return patterns


def django_adapter(sdk: Any, options: Optional[DjangoAdapterOptions] = None) -> list[Any]:
	return django_urlpatterns(sdk, options)


def async_django_urlpatterns(sdk: Any, options: Optional[DjangoAdapterOptions] = None) -> list[Any]:
	from django.urls import re_path

	adapter_options = options or DjangoAdapterOptions()
	routes = sdk.get_routes()
	patterns: list[Any] = []

	for route in routes:
		view = async_django_view(sdk, routes, route, adapter_options)
		patterns.append(
			re_path(
				django_route_pattern(route.path, trailing_slash=adapter_options.trailing_slash),
				view,
				name=_route_name(route),
			)
		)

	return patterns


def django_view(
	sdk: Any,
	routes: list[SDKRoute],
	route: SDKRoute,
	options: DjangoAdapterOptions,
) -> Callable[[Any], Any]:
	from django.views.decorators.csrf import csrf_exempt

	body_limit = _body_limit(options)

	@csrf_exempt
	def view(request: Any, *args: Any, **kwargs: Any) -> Any:
		try:
			path = route_relative_path(_wire_path(request), route.path)
			if path is None:
				return _private_json_response(create_error_response("Not found", "NOT_FOUND"), status=404)
			adapter_request = AdapterRequest(
				method=request.method,
				path=path,
				query=request.META.get("QUERY_STRING", ""),
				body=_raw_body(request, body_limit),
				headers=_headers_from_request(request),
			)
			response = process_request(
				sdk,
				routes,
				adapter_request,
				ProcessRequestOptions(
					timestamp_tolerance=options.timestamp_tolerance,
					max_body_size=options.max_body_size
					if options.max_body_size is not None
					else ProcessRequestOptions.max_body_size,
				),
			)
			status_code = 200 if response.get("success") else get_error_status_code(response.get("errorCode"))
			return _private_json_response(response, status=status_code)
		except _BodyReadError as error:
			return _private_json_response({"success": False, "errorCode": error.code, "error": str(error)}, status=error.status)
		except Exception:
			return _private_json_response(
				{
					"success": False,
					"errorCode": "INTERNAL_ERROR",
					"error": "An unexpected error occurred",
				},
				status=500,
			)

	return view


def async_django_view(
	sdk: Any,
	routes: list[SDKRoute],
	route: SDKRoute,
	options: DjangoAdapterOptions,
) -> Callable[[Any], Any]:
	from asgiref.sync import sync_to_async
	from django.views.decorators.csrf import csrf_exempt

	body_limit = _body_limit(options)

	@csrf_exempt
	async def view(request: Any, *args: Any, **kwargs: Any) -> Any:
		try:
			path = route_relative_path(_wire_path(request), route.path)
			if path is None:
				return _private_json_response(create_error_response("Not found", "NOT_FOUND"), status=404)
			adapter_request = AdapterRequest(
				method=request.method,
				path=path,
				query=request.META.get("QUERY_STRING", ""),
				body=await sync_to_async(_raw_body, thread_sensitive=True)(request, body_limit),
				headers=_headers_from_request(request),
			)
			response = await async_process_request(
				sdk,
				routes,
				adapter_request,
				ProcessRequestOptions(
					timestamp_tolerance=options.timestamp_tolerance,
					max_body_size=options.max_body_size
					if options.max_body_size is not None
					else ProcessRequestOptions.max_body_size,
				),
			)
			status_code = 200 if response.get("success") else get_error_status_code(response.get("errorCode"))
			return _private_json_response(response, status=status_code)
		except _BodyReadError as error:
			return _private_json_response({"success": False, "errorCode": error.code, "error": str(error)}, status=error.status)
		except Exception:
			return _private_json_response(
				{
					"success": False,
					"errorCode": "INTERNAL_ERROR",
					"error": "An unexpected error occurred",
				},
				status=500,
			)

	return view


def django_route_pattern(path: str, trailing_slash: bool = False) -> str:
	parts = [part for part in path.split("/") if part]
	regex_parts: list[str] = []
	for part in parts:
		if part.startswith(":"):
			name = part[1:]
			if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name):
				raise ValueError(f"Invalid route parameter name: {name}")
			regex_parts.append(f"(?P<{name}>[^/]+)")
		else:
			regex_parts.append(re.escape(part))
	suffix = "/?$" if trailing_slash else "$"
	return "^" + "/".join(regex_parts) + suffix


def create_impersonation_guard(
	sdk: Any,
	get_impersonation_context: Callable[[Any], Any],
	on_blocked: Optional[Callable[[Any, ImpersonationContext], None]] = None,
	blocked_response: Optional[Mapping[str, Any]] = None,
	show_warnings: bool = False,
	enforce_liveness: bool = True,
	liveness_cache_ttl_ms: int = 5_000,
	on_liveness_unavailable: str = "deny",
	is_impersonation_allowed: Optional[Callable[[Any, ImpersonationContext], bool]] = None,
	bridge_path: Optional[str] = None,
	render_blocked: Optional[Callable[[Any, int, Mapping[str, Any]], Any]] = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
	"""Django middleware factory (also usable as a view decorator).

	Works in sync and async stacks. ``get_impersonation_context`` returns ``None``
	for ordinary traffic, or a dict / ``ImpersonationContext``; in an async stack
	it may be ``async``. Any other value fails closed with a 500.

	Policy patterns match the full client-visible path (``request.path``,
	including ``SCRIPT_NAME``). Deny rules also match ``path_info`` and the path
	with an ``i18n_patterns`` language prefix removed. ``bridge_path`` enables the
	read-scope allowance for a mounted browser-session bridge (off by default).

	Blocked API calls (fetch/XHR, JSON) get a JSON error. Blocked page loads and
	form posts get a small HTML page instead, or whatever
	``render_blocked(request, status_code, body)`` returns, so a server-rendered
	app can show its own template.
	"""
	options = DjangoImpersonationGuardOptions(
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
		render_blocked=render_blocked,
	)
	liveness = (
		SessionLivenessChecker(sdk, liveness_cache_ttl_ms, on_liveness_unavailable)
		if enforce_liveness
		else None
	)

	def decide(request: Any, raw_context: Any) -> Optional[Any]:
		"""Return a blocking JsonResponse, or None to continue."""

		try:
			context = coerce_impersonation_context(raw_context)
		except InvalidImpersonationContext:
			return _private_json_response(
				{
					"success": False,
					"error": "Invalid impersonation context",
					"errorCode": "INVALID_IMPERSONATION_CONTEXT",
				},
				status=500,
			)
		# Non-impersonation traffic passes through without policy or liveness lookups.
		if not context or not context.is_impersonation:
			return None
		session_live = None
		liveness_unavailable = False
		if liveness and isinstance(context.session_id, str) and context.session_id:
			session_live, liveness_unavailable = liveness.check(context.session_id)
		path, aliases = _guard_paths(request)
		decision = evaluate_impersonation_guard(
			request.method,
			path,
			context,
			options.sdk.get_scope_config(),
			session_live=session_live,
			liveness_unavailable=liveness_unavailable,
			is_impersonation_allowed=(
				(lambda value: options.is_impersonation_allowed(request, value))
				if options.is_impersonation_allowed
				else None
			),
			bridge_path=options.bridge_path,
			raw_path=_raw_request_path(request),
			alias_paths=aliases,
			methods=policy_methods(request.method, request.headers, request.META.get("QUERY_STRING", "")),
		)
		if decision.allowed:
			return None

		# Notify only for actual blocks (scope/endpoint/liveness), not for
		# temporary policy unavailability (503) — matching the Node guard.
		notify_blocked = decision.status_code == 403 or (decision.body or {}).get(
			"errorCode"
		) == "IMPERSONATION_SESSION_ENDED"
		if options.on_blocked and notify_blocked:
			try:
				options.on_blocked(request, context)
			except Exception:
				pass  # Audit callbacks cannot change the decision.
		if options.show_warnings:
			warnings.warn(
				f"[Devora] Blocked {request.method} {path} (session: {context.session_id})",
				RuntimeWarning,
				stacklevel=2,
			)

		status_code, body = _guard_response(decision.status_code, decision.body, options.blocked_response)
		if _wants_html(request):
			render = options.render_blocked or _blocked_html_response
			return render(request, status_code, body)
		return _private_json_response(body, status=status_code)

	def guard_failed() -> Any:

		return _private_json_response(
			{"success": False, "error": "Impersonation guard failed", "errorCode": "INTERNAL_ERROR"},
			status=500,
		)

	def middleware(get_response: Callable[..., Any]) -> Callable[..., Any]:
		if iscoroutinefunction(get_response):

			async def async_wrapped(request: Any, *args: Any, **kwargs: Any) -> Any:
				from asgiref.sync import sync_to_async

				try:
					raw_context = options.get_impersonation_context(request)
					if inspect.isawaitable(raw_context):
						raw_context = await raw_context
					blocked = await sync_to_async(decide, thread_sensitive=False)(request, raw_context)
				except Exception:
					return guard_failed()
				return blocked if blocked is not None else await get_response(request, *args, **kwargs)

			markcoroutinefunction(async_wrapped)
			return async_wrapped

		def wrapped(request: Any, *args: Any, **kwargs: Any) -> Any:
			try:
				blocked = decide(request, options.get_impersonation_context(request))
			except Exception:
				return guard_failed()
			return blocked if blocked is not None else get_response(request, *args, **kwargs)

		return wrapped

	middleware.sync_capable = True  # type: ignore[attr-defined]
	middleware.async_capable = True  # type: ignore[attr-defined]
	return middleware


def _guard_paths(request: Any) -> tuple[str, list[str]]:
	"""The full client-visible path, plus deny-only views of the same request."""
	path = request.path or request.path_info or "/"
	aliases: list[str] = []
	path_info = request.path_info or "/"
	if path_info != path:
		aliases.append(path_info)
	stripped = _strip_language_prefix(path_info)
	if stripped is not None:
		aliases.append(stripped)
		script_name = path[: len(path) - len(path_info)] if path.endswith(path_info) else ""
		if script_name:
			aliases.append(script_name + stripped)
	return path, aliases


def _strip_language_prefix(path_info: str) -> Optional[str]:
	"""``path_info`` without an ``i18n_patterns`` language prefix, when it has one."""
	try:
		from django.conf import settings
		from django.utils.translation import get_language_from_path

		if not getattr(settings, "USE_I18N", False) or not get_language_from_path(path_info):
			return None
	except Exception:
		return None
	# get_language_from_path only matches a supported language as the first segment.
	rest = path_info.split("/", 2)
	return "/" + (rest[2] if len(rest) > 2 else "")


def _route_name(route: SDKRoute) -> str:
	name = route.path.strip("/").replace("/", "_").replace(":", "")
	return f"devora_{route.method.lower()}_{name or 'root'}"


def _raw_request_path(request: Any) -> Optional[str]:
	"""The still-percent-encoded path, from the ASGI scope or a server-specific
	WSGI environ key.

	Devora signs path params with ``encodeURIComponent``; Django's decoded
	``request.path``/``path_info`` can no longer match that signature for values
	containing reserved characters (``@``, ``+``, space, ...).
	"""
	scope = getattr(request, "scope", None)
	if isinstance(scope, Mapping):
		raw = scope.get("raw_path")
		if isinstance(raw, (bytes, bytearray)):
			try:
				return bytes(raw).decode("ascii")
			except UnicodeDecodeError:
				return bytes(raw).decode("latin-1")
	environ = getattr(request, "environ", None)
	if isinstance(environ, Mapping):
		raw_uri = environ.get("RAW_URI") or environ.get("REQUEST_URI")
		if raw_uri:
			return raw_uri.split("?", 1)[0]
	return None


def _wire_path(request: Any) -> str:
	"""The request path as sent, still percent-encoded.

	ASGI ``raw_path`` or WSGI ``RAW_URI``/``REQUEST_URI`` when the server provides
	them. Otherwise (for example ``manage.py runserver``) the decoded
	``PATH_INFO`` bytes are strict re-encoded, which reproduces exactly what
	Devora's strict signer sent and fails closed for anything else.
	"""
	raw = _raw_request_path(request)
	if raw is not None:
		return raw
	# request.path is Django's own consistently decoded full path, whatever the
	# server's PATH_INFO encoding quirks.
	return "/".join(strict_encode(part) if part else "" for part in (request.path or "/").split("/"))


def _headers_from_request(request: Any) -> Any:
	# ASGI retains duplicate fields. Django's normalized header map may have
	# joined or discarded them, so feed the original pairs to the verifier.
	scope = getattr(request, "scope", None)
	if isinstance(scope, dict) and "headers" in scope:
		return list(scope["headers"])
	return {key.lower(): value for key, value in request.headers.items()}


class _BodyReadError(ValueError):
	def __init__(self, message: str, status: int = 413) -> None:
		super().__init__(message)
		self.status = status
		self.code = "BODY_TOO_LARGE" if status == 413 else "INVALID_BODY"


def _body_limit(options: DjangoAdapterOptions) -> int:
	limit = options.max_body_size if options.max_body_size is not None else ProcessRequestOptions.max_body_size
	if not isinstance(limit, int) or isinstance(limit, bool) or limit <= 0:
		raise ValueError("Invalid body size limit")
	return limit


def _raw_body(request: Any, max_bytes: int = ProcessRequestOptions.max_body_size) -> bytes:
	"""The exact request body bytes, bounded before allocation."""
	declared = request.META.get("CONTENT_LENGTH", "")
	if declared:
		if not str(declared).isascii() or not str(declared).isdigit():
			raise _BodyReadError("Invalid Content-Length", 400)
		if int(declared) > max_bytes:
			raise _BodyReadError("Request body too large")
	# HttpRequest.read() bounds SDK allocation without eagerly filling .body.
	# ASGI servers and any earlier middleware still need their own ingress cap.
	if callable(getattr(request, "read", None)):
		raw = bytearray()
		while len(raw) <= max_bytes:
			part = request.read(min(65536, max_bytes + 1 - len(raw)))
			if not part:
				break
			raw.extend(part)
			if len(raw) > max_bytes:
				raise _BodyReadError("Request body too large")
		return bytes(raw)
	raw = request.body
	if len(raw) > max_bytes:
		raise _BodyReadError("Request body too large")
	return bytes(raw)


def _body_from_request(request: Any, max_bytes: int) -> Any:
	"""Parsed JSON body for the (unsigned) browser-session bridge."""
	raw = _raw_body(request, max_bytes)
	if not raw:
		return None
	return json.loads(raw.decode("utf-8"))


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


def browser_session_view(
	sdk: Any,
	get_impersonation_context: Callable[[Any], Any],
	allowed_origins: Optional[list[str]] = None,
) -> Callable[[Any], Any]:
	"""Django view for ``POST /api/devora/browser-session`` (wrap with your auth decorator)."""
	from devora_sdk import resolve_browser_session
	from django.views.decorators.csrf import csrf_exempt

	# Exempt from Django's CSRF token check (the browser SDK cannot send one):
	# the bridge authorizes by the session cookie AND an Origin that must be in
	# ``allowed_origins``; a missing or foreign Origin never gets a resume code.
	@csrf_exempt
	def view(request: Any) -> Any:

		if request.method != "POST":
			return _private_json_response({"error": "Method not allowed"}, status=405)
		try:
			body = _body_from_request(request, 4096)
		except _BodyReadError as error:
			return _private_json_response({"success": False, "errorCode": error.code, "error": str(error)}, status=error.status)
		except Exception:
			body = {}
		try:
			context = coerce_impersonation_context(get_impersonation_context(request))
		except InvalidImpersonationContext:
			return _private_json_response(
				{"status": "blocked", "reason": "session_invalid"}, status=500
			)
		status, payload = resolve_browser_session(
			sdk,
			context,
			body.get("tabRef") if isinstance(body, dict) else None,
			request.headers.get("Origin"),
			allowed_origins,
		)
		response = _private_json_response(payload, status=status)
		response["Cache-Control"] = "private, no-store"
		return response

	return view
