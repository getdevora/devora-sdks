"""Audit the third-party dependencies of the Python SDK packages.

Resolves the declared ranges at their newest and lowest versions (so a
vulnerable floor fails too), for Python 3.10 and 3.12. The latter also covers
Django 6, which cannot resolve on Python 3.10. Runs a pinned pip-audit on
each resolution. The SDK's own packages (devora-*) are excluded: they are
what is being released.

    uv run --no-project --python 3.12 packages/sdks/scripts/audit-python-deps.py
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ("python", "django", "fastapi")
PIP_AUDIT = "pip-audit==2.9.0"


def main() -> int:
	deps: set[str] = set()
	for package in PACKAGES:
		project = tomllib.loads((ROOT / package / "pyproject.toml").read_text())["project"]
		deps.update(dep for dep in project.get("dependencies", []) if not dep.startswith("devora-"))
	with tempfile.TemporaryDirectory() as work:
		requirements = Path(work) / "requirements.in"
		requirements.write_text("\n".join(sorted(deps)) + "\n")
		for python_version in ("3.10", "3.12"):
			for resolution in ("highest", "lowest-direct"):
				locked = Path(work) / f"requirements-{python_version}-{resolution}.txt"
				subprocess.run(
					["uv", "pip", "compile", "--quiet", "--python-version", python_version,
					 "--resolution", resolution, str(requirements), "-o", str(locked)],
					check=True,
				)
				print(f"Auditing Python {python_version} {resolution} resolution of: {', '.join(sorted(deps))}", flush=True)
				result = subprocess.run(
					["uvx", PIP_AUDIT, "--strict", "--disable-pip", "--no-deps", "-r", str(locked)]
				)
				if result.returncode != 0:
					return result.returncode
	return 0


if __name__ == "__main__":
	sys.exit(main())
