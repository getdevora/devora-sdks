from __future__ import annotations

import sys
import threading
import pytest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from devora_sdk.guard import SessionLivenessChecker


def test_fresh_cache_has_a_hard_lru_bound_without_extending_verdict_ttl():
	class SDK:
		calls = 0
		def get_session_status(self, _):
			self.calls += 1
			return {"valid": True}

	sdk = SDK()
	checker = SessionLivenessChecker(sdk)
	with patch("devora_sdk.guard.time.monotonic", return_value=100) as clock:
		for i in range(1024):
			assert checker.check(str(i)) == (True, False)
		assert checker.check("0") == (True, False)  # Retain the hot entry.
		checker.check("1024")
		assert "0" in checker._cache and "1" not in checker._cache
		for i in range(1025, 5000):
			checker.check(str(i))
		assert len(checker._cache) == 1024
		assert sdk.calls == 5000
		clock.return_value = 104.9
		assert checker.check("4999") == (True, False)
		assert sdk.calls == 5000
		clock.return_value = 105
		assert checker.check("4999") == (True, False)
		assert sdk.calls == 5001  # Access did not extend the original TTL.


def test_distinct_pending_lookups_are_bounded_and_same_session_still_coalesces():
	release = threading.Event()
	all_started = threading.Event()
	lock = threading.Lock()
	calls = 0

	class SDK:
		def get_session_status(self, _):
			nonlocal calls
			with lock:
				calls += 1
				if calls == 64:
					all_started.set()
			assert release.wait(5)
			return {"valid": True}

	checker = SessionLivenessChecker(SDK())
	with ThreadPoolExecutor(max_workers=65) as pool:
		owners = [pool.submit(checker.check, str(i)) for i in range(64)]
		try:
			assert all_started.wait(5)
			assert checker.check("excess") == (None, True)
			assert calls == 64 and len(checker._pending) == 64
			waiter = pool.submit(checker.check, "0")
		finally:
			release.set()
		assert all(f.result(timeout=5) == (True, False) for f in owners)
		assert waiter.result(timeout=5) == (True, False)
	assert calls == 64 and len(checker._pending) == 0


def test_transport_failure_is_cached_briefly_and_invalid_ids_allocate_nothing():
	class SDK:
		calls = 0
		def get_session_status(self, _):
			self.calls += 1
			raise OSError("unavailable")

	sdk = SDK()
	checker = SessionLivenessChecker(sdk)
	with patch("devora_sdk.guard.time.monotonic", return_value=100) as clock:
		for sid in ("", "x" * 129):
			assert checker.check(sid) == (None, True)
		assert len(checker._cache) == len(checker._pending) == sdk.calls == 0
		assert checker.check("s") == (None, True)
		assert checker.check("s") == (None, True)
		assert sdk.calls == 1 and len(checker._pending) == 0
		clock.return_value = 101
		assert checker.check("s") == (None, True)
		assert sdk.calls == 2
	assert SessionLivenessChecker(sdk, on_unavailable="allow").check("s") == (None, False)


def test_invalid_fail_open_policy_and_cache_ttl_are_configuration_errors():
	for options in ({"on_unavailable": "denny"}, {"cache_ttl_ms": float("nan")}, {"cache_ttl_ms": -1}):
		with pytest.raises(ValueError, match="Invalid liveness"):
			SessionLivenessChecker(object(), **options)
