from __future__ import annotations

import inspect
import math
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional, Sequence
from urllib.parse import unquote

from .policy import ScopeConfig
from .utils import is_ambiguous_request_path, match_endpoint_pattern


@dataclass(frozen=True)
class ScopeEndpoint:
	method: str
	pattern: str


@dataclass(frozen=True)
class ImpersonationContext:
	is_impersonation: bool
	scope: str
	session_id: Optional[str] = None
	expires_at: Optional[int] = None
	impersonator: Optional[dict[str, str]] = None
	actor: Optional[dict[str, str]] = None
	subject: Optional[dict[str, str]] = None
	auth_method: Optional[str] = None
	authorization_source: Optional[str] = None
	recording_allowed: Optional[bool] = None


@dataclass(frozen=True)
class GuardDecision:
	allowed: bool
	status_code: int = 200
	body: Optional[dict[str, object]] = None


@dataclass
class _LivenessLookup:
	event: threading.Event = field(default_factory=threading.Event)
	live: Optional[bool] = None
	checked_at_ms: float = 0


class SessionLivenessChecker:
	"""Caches server-side session liveness results for the impersonation guard.

	``is_live`` returns True (live), False (ended), or None (could not determine — Devora
	unreachable). When unreachable, behavior follows ``on_unavailable``: "allow" (fail open,
	returns None) or "deny" (fail closed, returns False).
	"""

	def __init__(self, sdk: Any, cache_ttl_ms: int = 5_000, on_unavailable: str = "deny") -> None:
		if on_unavailable not in ("allow", "deny"):
			raise ValueError("Invalid liveness unavailable policy")
		if not isinstance(cache_ttl_ms, (int, float)) or not math.isfinite(cache_ttl_ms) or cache_ttl_ms < 0:
			raise ValueError("Invalid liveness cache TTL")
		self._sdk = sdk
		self._cache_ttl_ms = cache_ttl_ms
		self._unavailable_ttl_ms = min(1_000, cache_ttl_ms)
		self._on_unavailable = on_unavailable
		# value: (live | None for "unavailable", checked_at_ms)
		self._cache: OrderedDict[str, tuple[Optional[bool], float]] = OrderedDict()
		self._pending: dict[str, _LivenessLookup] = {}
		self._lock = threading.Lock()

	@property
	def fails_closed(self) -> bool:
		return self._on_unavailable == "deny"

	def check(self, session_id: str) -> tuple[Optional[bool], bool]:
		"""Return ``(live, unavailable)``.

		``live`` is True/False when Devora answered and None when it could not be
		reached; ``unavailable`` is True only when the verdict is unknown *and* the
		checker is configured to fail closed. Concurrent requests for one session
		share a single lookup, and an unavailable verdict is cached for one second
		so an outage costs one lookup per session per second, not per request.
		"""
		if not session_id or len(session_id) > 128:
			return None, self.fails_closed
		now = time.monotonic() * 1000
		with self._lock:
			cached = self._cache.get(session_id)
			if cached:
				ttl = self._unavailable_ttl_ms if cached[0] is None else self._cache_ttl_ms
				if now - cached[1] < ttl:
					self._cache.move_to_end(session_id)
					return cached[0], cached[0] is None and self.fails_closed
				del self._cache[session_id]
			pending = self._pending.get(session_id)
			if pending is None:
				# Reject excess distinct lookups without allocating another pending
				# key or starting network I/O. Same-session callers still coalesce.
				if len(self._pending) >= 64:
					return None, self.fails_closed
				pending = _LivenessLookup()
				self._pending[session_id] = pending
				owner = True
			else:
				owner = False
		if not owner:
			if not pending.event.wait(timeout=6):
				return None, self.fails_closed
			# Read this lookup's result, not a potentially evicted/replaced cache
			# entry. A delayed waiter must not resurrect an expired live verdict.
			live = pending.live
			ttl = self._unavailable_ttl_ms if live is None else self._cache_ttl_ms
			if time.monotonic() * 1000 - pending.checked_at_ms >= ttl:
				live = None
			return live, live is None and self.fails_closed
		live: Optional[bool] = None
		try:
			status = self._sdk.get_session_status(session_id)
			live = None if status is None else status.get("valid") is True
		except Exception:
			# A custom transport may raise instead of returning unavailable.
			live = None
		finally:
			with self._lock:
				pending.live = live
				pending.checked_at_ms = time.monotonic() * 1000
				self._cache[session_id] = (live, pending.checked_at_ms)
				self._cache.move_to_end(session_id)
				# Hard LRU bound even when every entry is fresh. No dictionary
				# copying or full-cache scans while holding the shared lock.
				if len(self._cache) > 1024:
					self._cache.popitem(last=False)
				self._pending.pop(session_id, None)
				pending.event.set()
		return live, live is None and self.fails_closed

	def is_live(self, session_id: str) -> Optional[bool]:
		"""Backwards-compatible verdict: False when unavailable and failing closed."""
		live, unavailable = self.check(session_id)
		if unavailable:
			return False
		return live


READ_METHODS = ("GET", "HEAD", "OPTIONS")

#: Headers through which common middleware lets a client change the effective method.
METHOD_OVERRIDE_HEADERS = ("x-http-method-override", "x-http-method", "x-method-override")

_AUTHORIZATION_SOURCES = ("standard", "self_approved", "self_approved_read", "break_glass")


class InvalidImpersonationContext(TypeError):
	"""The context extractor returned something that is not a recognised context."""


METHOD_OVERRIDE_QUERY_PARAM = "_method"


def policy_methods(
	method: str, headers: Optional[Mapping[str, Any]] = None, query: Optional[str] = None
) -> list[str]:
	"""Every method a request might execute as, including method-override headers
	and ``_method`` query parameters (``query`` is the raw query string).

	The guard judges all of them, so override middleware ordered after the guard
	cannot turn an allowed POST into a blocked DELETE. A ``_method`` form field
	in the body is not visible here; resolve it before the guard.
	"""
	methods = [method.upper()]
	if query:
		from urllib.parse import parse_qsl

		for key, value in parse_qsl(query, keep_blank_values=False, errors="replace"):
			value = value.strip().upper()
			if key == METHOD_OVERRIDE_QUERY_PARAM and value and value not in methods:
				methods.append(value)
	if headers:
		# Every value of every override header counts. Starlette's Headers.items()
		# yields each raw pair, and a repeated header must not be collapsed to one
		# value: an override middleware may read the first while a dict keeps the
		# last. Raw ASGI pairs (bytes) are accepted too.
		pairs = headers.items() if hasattr(headers, "items") else headers
		for key, value in pairs:
			name = key.decode("latin-1") if isinstance(key, (bytes, bytearray)) else str(key)
			if name.lower() not in METHOD_OVERRIDE_HEADERS or value is None:
				continue
			for item in value if isinstance(value, (list, tuple)) else [value]:
				text = item.decode("latin-1") if isinstance(item, (bytes, bytearray)) else str(item)
				for part in text.split(","):
					part = part.strip().upper()
					if part and part not in methods:
						methods.append(part)
	return methods


def evaluate_impersonation_guard(
	method: str,
	path: str,
	context: Optional[ImpersonationContext],
	policy: Optional[ScopeConfig],
	on_blocked: Optional[Callable[[ImpersonationContext], None]] = None,
	session_live: Optional[bool] = None,
	is_impersonation_allowed: Optional[Callable[[ImpersonationContext], bool]] = None,
	liveness_unavailable: bool = False,
	bridge_path: Optional[str] = None,
	*,
	raw_path: Optional[str] = None,
	alias_paths: Sequence[str] = (),
	methods: Optional[Sequence[str]] = None,
) -> GuardDecision:
	"""Decide whether an impersonated request may reach its handler.

	``path`` is the decoded, full client-visible path the framework dispatches on
	(mount prefix included, no query). It is never re-parsed as a URL. Policy
	patterns match this convention.

	``raw_path`` is the percent-encoded wire path when the adapter has it.
	``alias_paths`` are further decoded views of the same request (mount-relative,
	locale prefix removed); they can only cause a block. ``methods`` defaults to
	``[method]``; adapters pass :func:`policy_methods` to include overrides.

	``bridge_path``, when set, allows a read-scope ``POST`` to exactly that path
	(the browser-session bridge). It is off by default.
	"""
	if context is None:
		return GuardDecision(allowed=True)
	if not isinstance(context, ImpersonationContext) or not isinstance(context.is_impersonation, bool):
		return GuardDecision(allowed=False, status_code=500, body=_guard_error_body(
			"Invalid impersonation context", "INVALID_IMPERSONATION_CONTEXT"
		))
	if context.is_impersonation is False:
		return GuardDecision(allowed=True)

	judged = [path, *alias_paths]
	if any(is_ambiguous_request_path(candidate) for candidate in judged) or (
		raw_path is not None and is_ambiguous_request_path(raw_path)
	):
		if on_blocked:
			on_blocked(context)
		return GuardDecision(
			allowed=False,
			status_code=403,
			body=_guard_error_body(
				"This endpoint is blocked during impersonation", "IMPERSONATION_ENDPOINT_BLOCKED"
			),
		)
	# Deny rules also see one further decoding of every view (a literal "%75" in a
	# decoded path must not dodge "/users"), and the encoded wire form.
	judged += [unquote(candidate) for candidate in judged]
	if raw_path is not None:
		judged += [raw_path, unquote(raw_path)]
	judged = list(dict.fromkeys(judged))

	valid, expired = _validate_context(context)
	if not valid:
		return GuardDecision(
			allowed=False,
			status_code=401,
			body=_guard_error_body(
				"Impersonation session expired" if expired else "Invalid impersonation context",
				"IMPERSONATION_EXPIRED" if expired else "INVALID_IMPERSONATION_CONTEXT",
			),
		)

	# Liveness could not be verified and the guard fails closed: this is a
	# distinct, retryable condition, not a terminated session.
	if liveness_unavailable:
		return GuardDecision(
			allowed=False,
			status_code=503,
			body=_guard_error_body(
				"Impersonation session liveness could not be verified",
				"IMPERSONATION_LIVENESS_UNAVAILABLE",
			),
		)

	# Optional server-side liveness: block sessions terminated/revoked before their expiry.
	if session_live is False:
		if on_blocked:
			on_blocked(context)
		return GuardDecision(
			allowed=False,
			status_code=401,
			body=_guard_error_body(
				"Impersonation session is no longer active", "IMPERSONATION_SESSION_ENDED"
			),
		)

	if policy is None:
		return GuardDecision(
			allowed=False,
			status_code=503,
			body=_guard_error_body(
				"Impersonation policy is temporarily unavailable", "IMPERSONATION_POLICY_UNAVAILABLE"
			),
		)

	request_methods = [m.upper() for m in (methods or [method])]
	if method.upper() not in request_methods:
		request_methods.insert(0, method.upper())
	# Frameworks answer HEAD with the GET handler, so GET deny rules cover HEAD.
	deny_methods = request_methods + (["GET"] if "HEAD" in request_methods and "GET" not in request_methods else [])

	# 1. Deny rules FIRST - blocked regardless of scope, on any path view.
	if _find_endpoint(deny_methods, judged, policy.blocked_endpoints, deny=True):
		if on_blocked:
			on_blocked(context)
		return GuardDecision(
			allowed=False,
			status_code=403,
			body=_guard_error_body(
				"This endpoint is blocked during impersonation", "IMPERSONATION_ENDPOINT_BLOCKED"
			),
		)

	# 2. Application-specific semantic authorization.
	semantic_allowed = True
	if is_impersonation_allowed:
		semantic_allowed = is_impersonation_allowed(context)
		# A coroutine is truthy even when its eventual decision is False. Sync
		# guards must fail closed for async hooks; async adapters await first.
		if inspect.iscoroutine(semantic_allowed):
			semantic_allowed.close()
	if semantic_allowed is not True:
		if on_blocked:
			on_blocked(context)
		return GuardDecision(
			allowed=False,
			status_code=403,
			body=_guard_error_body(
				"This action is not permitted during impersonation", "IMPERSONATION_ENDPOINT_BLOCKED"
			),
		)

	# 3. Write scope allows everything that is not denied.
	if context.scope == "write":
		return GuardDecision(allowed=True)

	write_methods = [m for m in request_methods if m not in READ_METHODS]
	if not write_methods:
		return GuardDecision(allowed=True)

	# 4. The browser-session bridge mints a Devora resume code for this
	# already-authenticated, live session. It is not a customer write.
	if bridge_path and request_methods == ["POST"] and path == bridge_path and (
		raw_path is None or unquote(raw_path) in (path, *alias_paths)
	):
		return GuardDecision(allowed=True)

	# 5. Read scope: every write method must be allowlisted on the routed path.
	if all(_find_endpoint([m], [path], policy.safe_read_endpoints, deny=False) for m in write_methods):
		return GuardDecision(allowed=True)

	if on_blocked:
		on_blocked(context)
	return GuardDecision(
		allowed=False,
		status_code=403,
		body=_guard_error_body(
			"This action is blocked during impersonation", "IMPERSONATION_SCOPE_VIOLATION"
		),
	)


def _guard_error_body(error: str, error_code: str) -> dict[str, object]:
	"""Standard blocked response matching the Node guard shape."""
	return {
		"success": False,
		"error": error,
		"errorCode": error_code,
	}


def _strict_int(value: object) -> Optional[int]:
	"""An integer, or an integral finite float; never a bool, string, NaN or infinity."""
	if isinstance(value, bool):
		return None
	if isinstance(value, int):
		return value
	if isinstance(value, float) and math.isfinite(value) and value.is_integer():
		return int(value)
	return None


def coerce_impersonation_context(value: Any) -> Optional[ImpersonationContext]:
	"""Convert what a context extractor returned into an :class:`ImpersonationContext`.

	Accepts ``None`` (ordinary traffic), an ``ImpersonationContext`` or a mapping
	using either camelCase or snake_case keys. Anything else, including awaitables,
	dataclasses and other objects, raises :class:`InvalidImpersonationContext`
	so the guard fails closed instead of treating it as ordinary traffic.
	"""
	if value is None:
		return value
	if isinstance(value, ImpersonationContext):
		if not isinstance(value.is_impersonation, bool):
			raise InvalidImpersonationContext("is_impersonation must be a boolean")
		return value
	if inspect.isawaitable(value):
		if inspect.iscoroutine(value):
			value.close()
		raise InvalidImpersonationContext("Context extractor returned an awaitable in a sync guard")
	if not isinstance(value, Mapping):
		raise InvalidImpersonationContext(
			f"Context extractor returned {type(value).__name__}; return None, a dict or ImpersonationContext"
		)
	is_impersonation = value.get("isImpersonation", value.get("is_impersonation"))
	if not isinstance(is_impersonation, bool):
		raise InvalidImpersonationContext("isImpersonation must be a boolean")
	return ImpersonationContext(
		is_impersonation=is_impersonation,
		scope=value.get("scope", ""),
		session_id=value.get("sessionId", value.get("session_id")),
		expires_at=value.get("expiresAt", value.get("expires_at")),
		impersonator=value.get("impersonator"),
		actor=value.get("actor", value.get("impersonator")),
		subject=value.get("subject", value.get("targetUser", value.get("target_user"))),
		auth_method=value.get("authMethod", value.get("auth_method")),
		authorization_source=value.get("authorizationSource", value.get("authorization_source")),
		recording_allowed=value.get("recordingAllowed", value.get("recording_allowed")),
	)


def _identity(value: object) -> Optional[str]:
	if isinstance(value, Mapping):
		identifier = value.get("id")
		if isinstance(identifier, str) and identifier:
			return identifier
	return None


def validate_impersonation_context(
	context: Optional[ImpersonationContext],
) -> dict[str, Any]:
	"""Strictly validate a context: types are checked, nothing is coerced."""
	if not isinstance(context, ImpersonationContext):
		return {"valid": False, "error": "No impersonation context"}
	if context.is_impersonation is not True:
		return {"valid": False, "error": "Not an impersonation session"}
	if context.scope not in ("read", "write"):
		return {"valid": False, "error": "Invalid scope"}
	if not _identity(context.actor or context.impersonator) or not _identity(context.subject):
		return {"valid": False, "error": "Missing impersonation actor or subject"}
	if context.auth_method != "devora_impersonation":
		return {"valid": False, "error": "Invalid impersonation authentication method"}
	if context.authorization_source not in _AUTHORIZATION_SOURCES:
		return {"valid": False, "error": "Invalid authorization source"}
	if not isinstance(context.recording_allowed, bool):
		return {"valid": False, "error": "Missing recording authorization"}
	if not isinstance(context.session_id, str) or not context.session_id:
		return {"valid": False, "error": "Missing session ID"}
	expires_at = _strict_int(context.expires_at)
	if expires_at is None:
		return {"valid": False, "error": "Missing expiration"}
	if expires_at < 946684800000:
		return {"valid": False, "error": "Expiration must be a Unix timestamp in milliseconds"}
	if int(time.time() * 1000) > expires_at:
		return {"valid": False, "expired": True, "error": "Impersonation session expired"}
	return {"valid": True}


def _validate_context(context: ImpersonationContext) -> tuple[bool, bool]:
	result = validate_impersonation_context(context)
	return bool(result["valid"]), bool(result.get("expired"))


def _find_endpoint(
	methods: Sequence[str], paths: Sequence[str], endpoints: list[dict[str, str]], deny: bool
) -> Optional[dict[str, str]]:
	"""Deny rules: any method on any path, ignoring case and trailing slashes.
	Allow rules: the exact method on every path, strictly."""
	for endpoint in endpoints:
		endpoint_method = str(endpoint.get("method", "")).upper()
		pattern = endpoint.get("pattern", "")
		if not any((endpoint_method == "*" and deny) or endpoint_method == m for m in methods):
			continue
		matches = [
			match_endpoint_pattern(pattern, candidate, case_sensitive=not deny, ignore_trailing_slash=deny)
			for candidate in paths
		]
		if (any(matches) if deny else all(matches)):
			return endpoint
	return None
