from __future__ import annotations

import time
from typing import Optional

from .constants import DEFAULT_TIMESTAMP_TOLERANCE_SECONDS


def is_valid_timestamp_tolerance(value: object) -> bool:
	"""A tolerance is a whole, non-negative number of seconds (0 = current second only)."""
	return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def validate_timestamp_tolerance(value: object, name: str = "timestamp_tolerance") -> None:
	"""Raise for configuration values that :func:`is_valid_timestamp_tolerance` rejects.

	``None`` means "use the default" and is accepted. NaN, infinities, negatives,
	floats and bools are rejected: they would make every drift comparison pass.
	"""
	if value is not None and not is_valid_timestamp_tolerance(value):
		raise ValueError(f"Devora SDK: {name} must be a non-negative integer number of seconds")


def validate_timestamp(
	request_timestamp: int, tolerance_seconds: int = DEFAULT_TIMESTAMP_TOLERANCE_SECONDS
) -> tuple[bool, Optional[str]]:
	if not is_valid_timestamp_tolerance(tolerance_seconds):
		return False, "Invalid timestamp tolerance"
	if not isinstance(request_timestamp, int) or request_timestamp <= 0:
		return False, "Invalid timestamp"
	drift = abs(int(time.time()) - request_timestamp)
	if drift > tolerance_seconds:
		return (
			False,
			f"Request timestamp outside tolerance window (drift: {drift}s, max: {tolerance_seconds}s)",
		)
	return True, None
