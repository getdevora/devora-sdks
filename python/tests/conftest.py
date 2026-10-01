"""Every test talks to a fake Devora for request claims (see devora_claims.py)."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
for package in ("python", "django", "fastapi"):
	sys.path.insert(0, str(Path(__file__).resolve().parents[2] / package / "src"))

from devora_claims import DEVORA  # noqa: E402


@pytest.fixture(autouse=True)
def fake_devora():
	import devora_sdk.sdk as sdk_module

	original = sdk_module.control_plane_request
	DEVORA.reset()
	with patch.object(
		sdk_module,
		"control_plane_request",
		side_effect=lambda *args, **kwargs: DEVORA.handle(original, *args, **kwargs),
	):
		yield DEVORA
