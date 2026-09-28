from __future__ import annotations

import math
import time
from threading import Lock
from typing import Protocol


class ReplayStore(Protocol):
	"""Atomic replay protection shared by every application instance.

	``consume`` must be an atomic insert-if-absent (for example Redis
	``SET key 1 NX PXAT expires_at``, or a unique-key database insert) and must
	never evict an entry before ``expires_at``. A store that cannot guarantee
	this must raise; the SDK then fails closed with a 503.
	"""

	def consume(self, namespace: str, request_id: str, expires_at: int) -> bool:
		"""Return True only for the first consumption of ``request_id`` within
		``namespace`` before ``expires_at`` (Unix milliseconds)."""
		...


class InMemoryReplayStore:
	"""Development-only replay store. Production must use persistent storage."""

	def __init__(self) -> None:
		self._entries: dict[str, int] = {}
		self._lock = Lock()

	def consume(self, namespace: str, request_id: str, expires_at: int) -> bool:
		if isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)) or not math.isfinite(expires_at):
			raise ValueError("Invalid replay expiry")
		now = int(time.time() * 1000)
		key = f"{namespace}\n{request_id}"
		with self._lock:
			self._entries = {entry: expiry for entry, expiry in self._entries.items() if expiry > now}
			if key in self._entries:
				return False
			self._entries[key] = int(expires_at)
			return True
