from __future__ import annotations

import re
import math
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

from .constants import DEFAULT_API_URL
from .transport import ControlPlaneError, control_plane_request

# How long a cached policy may be served past its window during an outage.
STALE_GRACE_MS = 5 * 60 * 1000
# Largest accepted policy, and the longest server-sent cache horizon trusted.
MAX_POLICY_ENTRIES = 1000
MAX_PATTERN_LENGTH = 500
MAX_POLICY_TTL_MS = 60 * 60 * 1000
_METHOD = re.compile(r"\*|[A-Z]{3,7}")


def _read_endpoints(value: Any) -> Optional[list[dict[str, str]]]:
	if not isinstance(value, list) or len(value) > MAX_POLICY_ENTRIES:
		return None
	endpoints = []
	for entry in value:
		method = entry.get("method") if isinstance(entry, dict) else None
		pattern = entry.get("pattern") if isinstance(entry, dict) else None
		if (
			not isinstance(method, str)
			or not _METHOD.fullmatch(method)
			or not isinstance(pattern, str)
			or not pattern
			or len(pattern) > MAX_PATTERN_LENGTH
		):
			return None
		endpoints.append({"method": method, "pattern": pattern})
	return endpoints


def _read_policy(data: Any, now: int) -> Optional["ScopeConfig"]:
	"""Validate a policy response; ``None`` when any part is malformed (fail closed)."""
	if not isinstance(data, dict):
		return None
	safe = _read_endpoints(data.get("safeReadEndpoints"))
	blocked = _read_endpoints(data.get("blockedEndpoints"))
	version = _safe_integer(data.get("version"), 0)
	requested = _safe_integer(data.get("cachedUntil"), 1)
	# Mirror JavaScript safe integers, including rejection of booleans. A
	# missing deny list/version/cache horizon cannot mean an empty valid policy.
	if safe is None or blocked is None or version is None or requested is None:
		return None
	return ScopeConfig(
		safe_read_endpoints=safe,
		blocked_endpoints=blocked,
		version=version,
		cached_until=int(min(max(requested, now), now + MAX_POLICY_TTL_MS)),
	)


def _safe_integer(value: Any, minimum: int) -> Optional[int]:
	if isinstance(value, bool):
		return None
	if isinstance(value, float):
		if not math.isfinite(value) or not value.is_integer():
			return None
		value = int(value)
	return value if isinstance(value, int) and minimum <= value <= 2**53 - 1 else None


@dataclass(frozen=True)
class ScopeConfig:
	safe_read_endpoints: list[dict[str, str]]
	blocked_endpoints: list[dict[str, str]]
	version: int
	cached_until: int

	def to_dict(self) -> dict[str, Any]:
		return {
			"safeReadEndpoints": self.safe_read_endpoints,
			"blockedEndpoints": self.blocked_endpoints,
			"version": self.version,
			"cachedUntil": self.cached_until,
		}


class ScopeConfigFetcher:
	def __init__(
		self,
		api_key: str,
		cache_ttl_ms: int = 5 * 60 * 1000,
		api_url: Optional[str] = None,
		prefetch: bool = False,
		sign_request: Optional[Callable[[], dict[str, str]]] = None,
	) -> None:
		"""``sign_request`` returns fresh v3 signature headers for
		``GET /api/sdk/scope-config`` (the policy is not public);
		``DevoraBackendSDK`` supplies it from the server secret."""
		if isinstance(cache_ttl_ms, bool) or not isinstance(cache_ttl_ms, int) or not 0 < cache_ttl_ms <= MAX_POLICY_TTL_MS:
			raise ValueError("cache_ttl_ms must be an integer between 1 and 3600000")
		self.api_key = api_key
		self._sign_request = sign_request
		self.api_url = api_url or DEFAULT_API_URL
		self.cache_ttl_ms = cache_ttl_ms
		self.cached_config: Optional[ScopeConfig] = None
		self.etag: Optional[str] = None
		self.stale_until = 0
		self._timer: Optional[threading.Timer] = None
		self._lock = threading.Lock()
		if prefetch:
			# Warm the cache in the background at construction time instead of
			# leaving the first request(s) to pay for it. Without this, every
			# worker process that just started serves its first request (and any
			# request racing it) a synchronous fetch or a 503
			# IMPERSONATION_POLICY_UNAVAILABLE, since get_config() only fetches
			# lazily and a concurrent caller during that first fetch gets None
			# rather than waiting (see refresh()'s single-flight comment).
			# Fire-and-forget: refresh() already handles its own errors.
			threading.Thread(target=self.refresh, daemon=True).start()

	def get_config(self) -> Optional[ScopeConfig]:
		if self.cached_config and _now_ms() < self.cached_config.cached_until:
			return self.cached_config
		config = self.refresh()
		if config and not self._timer:
			self._schedule_refresh()
		return config

	def get_cached_config(self) -> Optional[ScopeConfig]:
		return self.cached_config

	def refresh(self) -> Optional[ScopeConfig]:
		# Single-flight without blocking: a second caller during an in-progress
		# refresh gets the cached/stale policy immediately instead of queueing a
		# worker thread behind a 5-second network call.
		if not self._lock.acquire(blocking=False):
			return self._stale_or_none()
		try:
			return self._refresh_locked()
		finally:
			self._lock.release()

	def _refresh_locked(self) -> Optional[ScopeConfig]:
		if self._sign_request is None:
			return self._stale_or_none()
		headers = dict(self._sign_request())
		if self.etag:
			headers["If-None-Match"] = self.etag
		try:
			status, payload, response_headers = control_plane_request(
				f"{self.api_url}/api/sdk/scope-config", "GET", headers
			)
		except ControlPlaneError:
			return self._stale_or_none()
		if status == 304 and self.cached_config:
			return self._extend_cached_config()
		config = (
			_read_policy(payload.get("data"), _now_ms())
			if 200 <= status < 300 and payload and payload.get("success") is True
			else None
		)
		if config is None:
			return self._stale_or_none()
		self.etag = response_headers.get("etag")
		self.cached_config = config
		self.stale_until = config.cached_until + STALE_GRACE_MS
		self._schedule_refresh()
		return config

	def stop(self) -> None:
		if self._timer:
			self._timer.cancel()
			self._timer = None

	def _stale_or_none(self) -> Optional[ScopeConfig]:
		if self.cached_config and _now_ms() < self.stale_until:
			return self.cached_config
		return None

	def _extend_cached_config(self) -> ScopeConfig:
		self.cached_config = ScopeConfig(
			safe_read_endpoints=self.cached_config.safe_read_endpoints,
			blocked_endpoints=self.cached_config.blocked_endpoints,
			version=self.cached_config.version,
			cached_until=_now_ms() + self.cache_ttl_ms,
		)
		self.stale_until = self.cached_config.cached_until + STALE_GRACE_MS
		self._schedule_refresh()
		return self.cached_config

	def _schedule_refresh(self) -> None:
		self.stop()
		refresh_in_ms = self.cache_ttl_ms
		if self.cached_config:
			refresh_in_ms = max(
				self.cached_config.cached_until - _now_ms() - 30_000,
				min(self.cache_ttl_ms // 2, 60_000),
			)
		self._timer = threading.Timer(refresh_in_ms / 1000, self._refresh_from_timer)
		self._timer.daemon = True
		self._timer.start()

	def _refresh_from_timer(self) -> None:
		self.refresh()


def _now_ms() -> int:
	return int(time.time() * 1000)
