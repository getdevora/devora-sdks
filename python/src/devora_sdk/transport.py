"""Outbound calls to the Devora API: no redirects (signed headers and bodies
must never be forwarded to another origin), a total deadline, and a bounded
JSON object response."""
from __future__ import annotations

import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from typing import Any, Mapping, Optional
from urllib import error, request

#: Largest control-plane response the SDK will buffer.
MAX_CONTROL_RESPONSE_BYTES = 64 * 1024
#: Worker threads performing control-plane I/O, and the most calls in flight
#: (running or queued) before new calls fail fast instead of piling up.
_WORKERS = 8
_MAX_IN_FLIGHT = 32


class ControlPlaneError(Exception):
	"""Transport failure, redirect, oversized or malformed response."""


class _NoRedirect(request.HTTPRedirectHandler):
	def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
		# Returning None makes urllib raise HTTPError for the 3xx instead of following it.
		return None


_OPENER = request.build_opener(_NoRedirect)


def _read_bounded(response: Any, max_bytes: int, deadline: float) -> bytes:
	declared = response.headers.get("content-length")
	if declared is not None and (not declared.isascii() or not declared.isdigit() or int(declared) > max_bytes):
		raise ControlPlaneError("Response too large")
	body = bytearray()
	while True:
		if time.monotonic() > deadline:
			raise ControlPlaneError("Response deadline exceeded")
		# read(n) can perform many socket reads before returning n bytes, so a
		# peer trickling data defeats the deadline between chunks. read1 makes
		# at most one underlying read and lets us check elapsed time again.
		read = getattr(response, "read1", response.read)
		chunk = read(min(8192, max_bytes + 1 - len(body)))
		if time.monotonic() > deadline:
			raise ControlPlaneError("Response deadline exceeded")
		if not chunk:
			return bytes(body)
		body.extend(chunk)
		if len(body) > max_bytes:
			raise ControlPlaneError("Response too large")


def _json_object(raw: bytes) -> dict[str, Any]:
	try:
		parsed = json.loads(raw.decode("utf-8"))
	except (UnicodeDecodeError, ValueError) as exc:
		raise ControlPlaneError("Invalid JSON response") from exc
	if not isinstance(parsed, dict):
		raise ControlPlaneError("Unexpected response shape")
	return parsed


class _Pool:
	"""Bounded I/O workers. urllib's timeout applies per socket operation and
	not at all to DNS resolution, so the caller's total deadline is enforced by
	waiting on the worker's future; a stalled worker is abandoned (it still ends
	at its own socket timeouts) and in-flight calls are capped."""

	def __init__(self) -> None:
		self.executor = ThreadPoolExecutor(max_workers=_WORKERS, thread_name_prefix="devora-control-plane")
		self.slots = threading.BoundedSemaphore(_MAX_IN_FLIGHT)


_POOL = _Pool()


def _reset_pool_after_fork() -> None:
	# A forked worker (gunicorn, uWSGI) inherits the parent's executor without
	# its threads; start a fresh one.
	global _POOL
	_POOL = _Pool()


if hasattr(os, "register_at_fork"):
	os.register_at_fork(after_in_child=_reset_pool_after_fork)


def control_plane_request(
	url: str,
	method: str,
	headers: Mapping[str, str],
	body: Optional[bytes] = None,
	timeout: float = 5.0,
	max_bytes: int = MAX_CONTROL_RESPONSE_BYTES,
) -> tuple[int, Optional[dict[str, Any]], Mapping[str, str]]:
	"""Return ``(status, json_object_or_None, headers)``.

	Redirects, network errors, oversized or slow responses raise
	:class:`ControlPlaneError`. A non-2xx response returns its status and, when
	it is a bounded JSON object, its body. ``timeout`` is a hard total deadline
	covering DNS, connect, headers and body.
	"""
	deadline = time.monotonic() + timeout
	pool = _POOL
	if not pool.slots.acquire(blocking=False):
		raise ControlPlaneError("Too many outstanding Devora requests")
	try:
		future = pool.executor.submit(_perform, url, method, headers, body, timeout, max_bytes, deadline)
	except RuntimeError as exc:
		pool.slots.release()
		raise ControlPlaneError("Devora is unreachable") from exc
	future.add_done_callback(lambda _: pool.slots.release())
	try:
		return future.result(timeout=max(0.0, deadline - time.monotonic()))
	except FutureTimeout as exc:
		future.cancel()
		raise ControlPlaneError("Devora request deadline exceeded") from exc


def _perform(
	url: str,
	method: str,
	headers: Mapping[str, str],
	body: Optional[bytes],
	timeout: float,
	max_bytes: int,
	deadline: float,
) -> tuple[int, Optional[dict[str, Any]], Mapping[str, str]]:
	req = request.Request(url, data=body, method=method)
	for name, value in headers.items():
		req.add_header(name, value)
	try:
		remaining = deadline - time.monotonic()
		if remaining <= 0:
			raise ControlPlaneError("Devora request deadline exceeded")
		with _OPENER.open(req, timeout=remaining) as response:
			raw = _read_bounded(response, max_bytes, deadline)
			return response.status, _json_object(raw), response.headers
	except error.HTTPError as exc:
		try:
			if 300 <= exc.code < 400 and exc.code != 304:
				raise ControlPlaneError("Redirects are not followed") from exc
			try:
				payload: Optional[dict[str, Any]] = _json_object(_read_bounded(exc, max_bytes, deadline))
			except ControlPlaneError:
				payload = None
			return exc.code, payload, exc.headers
		finally:
			exc.close()
	except ControlPlaneError:
		raise
	except Exception as exc:
		raise ControlPlaneError("Devora is unreachable") from exc
