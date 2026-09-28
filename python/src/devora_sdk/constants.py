from __future__ import annotations

from .api_url_gen import DEVORA_API_ORIGIN


class DEVORA_ENDPOINTS:
	USER_SEARCH = "/user/search"
	USER_BY_ID = "/user/:id"
	IMPERSONATE = "/impersonate/:id"
	TERMINATE = "/impersonate/:id/terminate"
	TEST = "/test"
	HEALTH = "/health"


ENDPOINT_METHODS = {
	DEVORA_ENDPOINTS.USER_SEARCH: "GET",
	DEVORA_ENDPOINTS.USER_BY_ID: "GET",
	DEVORA_ENDPOINTS.IMPERSONATE: "POST",
	DEVORA_ENDPOINTS.TERMINATE: "DELETE",
	DEVORA_ENDPOINTS.TEST: "GET",
	DEVORA_ENDPOINTS.HEALTH: "GET",
}

PROTECTED_ENDPOINTS = (DEVORA_ENDPOINTS.TEST, DEVORA_ENDPOINTS.HEALTH)


class SECURITY_HEADERS:
	SIGNATURE = "x-devora-signature"
	SENT_AT = "x-devora-sent-at"
	KEY_ID = "x-devora-key-id"
	ORG_ID = "x-devora-org-id"
	REQUEST_ID = "x-devora-request-id"
	SIGNATURE_VERSION = "x-devora-signature-version"
	SESSION_ID = "x-devora-session-id"


SDK_VERSION = "0.1.0"
DEFAULT_API_URL = DEVORA_API_ORIGIN
DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 300
DEFAULT_MAX_BODY_SIZE_BYTES = 1024 * 1024
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


# Browser-session bridge (see @devorash/core BROWSER_SESSION_BRIDGE).
BROWSER_SESSION_BRIDGE_PATH = "/api/devora/browser-session"
BROWSER_RESUME_CODE_ENDPOINT = "/api/sdk/browser-resume-code"
BROWSER_RESUME_ENDPOINT = "/api/sdk/browser-resume"
# \Z, not $: $ also matches before a trailing newline.
TAB_REF_PATTERN = r"^[A-Za-z0-9_-]{4,96}\Z"
