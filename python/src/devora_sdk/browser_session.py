"""Browser-session bridge (server side). See @devorash/node browser-session.ts."""
from __future__ import annotations

import re
from typing import Any, Optional

from .constants import TAB_REF_PATTERN
from .guard import validate_impersonation_context


def resolve_browser_session(
	sdk: Any,
	context: Any,
	tab_ref: Any,
	origin: Optional[str],
	allowed_origins: Optional[list[str]] = None,
) -> tuple[int, dict[str, Any]]:
	"""Return ``(status_code, body)`` for the bridge route.

	Ordinary customer sessions return ``{"status": "none"}`` without contacting
	Devora. Impersonated sessions receive a one-time resume code, or ``blocked``
	when Devora cannot safely restore them.
	"""
	if not isinstance(tab_ref, str) or not re.fullmatch(TAB_REF_PATTERN, tab_ref):
		return 400, {"error": "Invalid tab reference"}
	if context is None or getattr(context, "is_impersonation", None) is False:
		return 200, {"status": "none"}
	# Origin only matters once we're about to mint a resume code for a real
	# impersonation session; ordinary traffic through this bridge is unaffected.
	# An Origin header must be listed in allowed_origins (unconfigured fails
	# closed). Devora binds every resume code to the origin that will redeem it,
	# so a request without an Origin header cannot use one and gets none.
	if origin and (allowed_origins is None or origin not in allowed_origins):
		return 403, {"error": "Invalid request origin"}
	# The same strict validation as the guard: malformed or expired contexts
	# never mint a resume code.
	if not origin or not validate_impersonation_context(context)["valid"]:
		return 200, {"status": "blocked", "reason": "session_invalid"}
	session_id = context.session_id
	result = sdk.create_browser_resume_code(session_id, tab_ref, origin)
	if result is None:
		return 200, {"status": "blocked", "reason": "control_plane_unavailable"}
	if "error" in result:
		return 200, {"status": "blocked", "reason": "session_invalid"}
	return 200, {"status": "resume", "code": result["code"]}
