from __future__ import annotations

from .api_url_gen import DEVORA_API_ORIGIN


class DEVORA_ENDPOINTS:
	USER_SEARCH = "/user/search"
	IMPERSONATE = "/impersonate/:id"
	TERMINATE = "/impersonate/:id/terminate"
	TEST = "/test"
	HEALTH = "/health"


ENDPOINT_METHODS = {
	DEVORA_ENDPOINTS.USER_SEARCH: "GET",
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


SDK_VERSION = "0.1.2"
DEFAULT_API_URL = DEVORA_API_ORIGIN
DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 300
DEFAULT_MAX_BODY_SIZE_BYTES = 1024 * 1024
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


# Browser-session bridge (see @devorash/core BROWSER_SESSION_BRIDGE).
BROWSER_SESSION_BRIDGE_PATH = "/api/devora/browser-session"
BROWSER_RESUME_CODE_ENDPOINT = "/api/sdk/browser-resume-code"
BROWSER_RESUME_ENDPOINT = "/api/sdk/browser-resume"

# Single use of signed Devora -> customer requests (see @devorash/core REQUEST_CLAIM):
# after verifying a signature the SDK claims the request id from Devora, and the
# handler runs only for the first claim. Customers need no storage of their own.
REQUEST_CLAIM_ENDPOINT = "/api/sdk/request-claim"
# Total deadline in seconds, leaving room for the handler within Devora's own deadline.
REQUEST_CLAIM_TIMEOUT_SECONDS = 3.0
# \Z, not $: $ also matches before a trailing newline.
TAB_REF_PATTERN = r"^[A-Za-z0-9_-]{4,96}\Z"
