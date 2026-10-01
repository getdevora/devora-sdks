/**
 * Constants for Devora SDKs
 * @module @devorash/core/constants
 */

// ============================================================================
// API Endpoints
// ============================================================================

/**
 * Predefined endpoint constants for Devora SDK integration.
 * Using these constants ensures:
 * - Typo prevention (/impersonation vs /impersonate)
 * - Automatic HTTP method detection
 * - IDE autocomplete and documentation
 * - Consistency across all customer integrations
 */
export const DEVORA_ENDPOINTS = {
	/**
	 * User search endpoint - allows Devora to search customer's users
	 * @method GET
	 * @path /user/search
	 * @query term - Search term (name, email, or user ID)
	 */
	USER_SEARCH: "/user/search",

	/**
	 * Impersonation start endpoint - generates auth token for session
	 * @method POST
	 * @path /impersonate/:id
	 * @params id - Target user ID to impersonate
	 */
	IMPERSONATE: "/impersonate/:id",

	/**
	 * Session termination endpoint - revokes impersonation session
	 * @method DELETE
	 * @path /impersonate/:id/terminate
	 * @params id - Session ID to terminate
	 */
	TERMINATE: "/impersonate/:id/terminate",

	/**
	 * Connection test endpoint - validates SDK setup (built-in)
	 * @method GET
	 * @path /test
	 * @internal This endpoint is automatically provided by the SDK
	 */
	TEST: "/test",

	/**
	 * Health check endpoint - SDK health and metrics (built-in)
	 * @method GET
	 * @path /health
	 * @internal This endpoint is automatically provided by the SDK
	 */
	HEALTH: "/health",
} as const

/** Type for endpoint keys */
export type DevoraEndpointKey = keyof typeof DEVORA_ENDPOINTS

/** Type for endpoint values */
export type DevoraEndpointPath = (typeof DEVORA_ENDPOINTS)[keyof typeof DEVORA_ENDPOINTS]

/**
 * HTTP methods for each endpoint (auto-detected when using constants)
 */
export const ENDPOINT_METHODS: Record<DevoraEndpointPath, "GET" | "POST" | "DELETE"> = {
	[DEVORA_ENDPOINTS.USER_SEARCH]: "GET",
	[DEVORA_ENDPOINTS.IMPERSONATE]: "POST",
	[DEVORA_ENDPOINTS.TERMINATE]: "DELETE",
	[DEVORA_ENDPOINTS.TEST]: "GET",
	[DEVORA_ENDPOINTS.HEALTH]: "GET",
}

/**
 * Built-in endpoints that cannot be overridden
 */
export const PROTECTED_ENDPOINTS: readonly DevoraEndpointPath[] = [
	DEVORA_ENDPOINTS.TEST,
	DEVORA_ENDPOINTS.HEALTH,
]

// ============================================================================
// Security Headers
// ============================================================================

/**
 * HTTP headers used for HMAC authentication
 */
export const SECURITY_HEADERS = {
	/** HMAC-SHA256 signature (hex encoded) */
	SIGNATURE: "x-devora-signature",
	/** Unix timestamp in seconds when request was sent */
	SENT_AT: "x-devora-sent-at",
	/** API Key ID (public identifier) */
	KEY_ID: "x-devora-key-id",
	/** Organization ID */
	ORG_ID: "x-devora-org-id",
	/** Unique request identifier used for replay prevention */
	REQUEST_ID: "x-devora-request-id",
	/** Signature payload version */
	SIGNATURE_VERSION: "x-devora-signature-version",
	/** Session ID (for impersonation requests) */
	SESSION_ID: "x-devora-session-id",
} as const

/**
 * Frontend SDK headers
 */
export const FRONTEND_HEADERS = {
	/** Client API Key */
	API_KEY: "x-devora-key",
	/** Session ID */
	SESSION: "x-devora-session",
	/** Short-lived impersonation-session bearer token (never the customer auth token). */
	SESSION_TOKEN: "x-devora-session-token",
} as const

// ============================================================================
// URL Parameters
// ============================================================================

/**
 * URL parameters used for impersonation payload passing
 */
/**
 * Browser-session bridge: the customer route the browser SDK calls to restore
 * an impersonation session in a new tab. Always allowed by the scope guards
 * because it only mints a Devora resume code for an already-authenticated
 * customer session.
 */
export const BROWSER_SESSION_BRIDGE = {
	/** Default customer route path. */
	PATH: "/api/devora/browser-session",
	/** Devora endpoint the customer backend calls with a signed server request. */
	RESUME_CODE_ENDPOINT: "/api/sdk/browser-resume-code",
	/** Devora endpoint the browser calls to redeem the code for its own capability. */
	RESUME_ENDPOINT: "/api/sdk/browser-resume",
	/** Non-secret per-tab identifier shape (also stored in sessionStorage). */
	TAB_REF_PATTERN: /^[A-Za-z0-9_-]{4,96}$/,
} as const

/**
 * Single use of signed Devora → customer requests. After verifying a request's
 * signature the backend SDK claims its request id from Devora, which records it;
 * the handler runs only for the first claim. Customers need no storage of their own.
 */
export const REQUEST_CLAIM = {
	/** Devora endpoint the backend SDK calls with a signed server request. */
	ENDPOINT: "/api/sdk/request-claim",
	/** Total deadline for a claim, leaving room for the handler within Devora's own deadline. */
	TIMEOUT_MS: 3_000,
} as const

export const URL_PARAMS = {
	/** One-time code exchanged for the encrypted impersonation payload */
	EXCHANGE_CODE: "devora_exchange",
} as const

// ============================================================================
// Default Configuration
// ============================================================================

import { DEVORA_API_ORIGIN, DEVORA_DASHBOARD_ORIGIN } from "./api-url.gen.js"

/**
 * Default SDK configuration values
 */
export const SDK_DEFAULTS = {
	/** Devora API origin baked into the SDK package at build time. */
	API_URL: DEVORA_API_ORIGIN,
	/**
	 * The Devora dashboard origin, baked in at build time. Only a tab at this
	 * origin (or, for a customer app on loopback, a loopback dashboard) may hand
	 * an exchange verifier to the browser SDK.
	 */
	DASHBOARD_ORIGIN: DEVORA_DASHBOARD_ORIGIN,
	/** Timestamp tolerance in seconds (5 minutes) */
	TIMESTAMP_TOLERANCE: 300,
	/** Log batch size before flush */
	LOG_BATCH_SIZE: 10,
	/** Log flush interval in milliseconds (5 seconds) */
	LOG_FLUSH_INTERVAL: 5000,
	/** Maximum log queue size */
	MAX_LOG_QUEUE_SIZE: 100,
} as const

// ============================================================================
// SDK Metadata
// ============================================================================

/**
 * SDK package names
 */
export const SDK_PACKAGES = {
	CORE: "@devorash/core",
	NODE: "@devorash/node",
	BROWSER: "@devorash/browser",
	EXPRESS: "@devorash/express",
	HONO: "@devorash/hono",
	FASTIFY: "@devorash/fastify",
	REACT: "@devorash/react",
	VUE: "@devorash/vue",
	SVELTE: "@devorash/svelte",
	SOLID: "@devorash/solid",
	NEXT: "@devorash/nextjs",
} as const

/**
 * Current SDK version (synced across all packages)
 */
export const SDK_VERSION = "0.1.2"

// ============================================================================
// Error Codes
// ============================================================================

/**
 * SDK error codes
 */
export const ERROR_CODES = {
	// Security errors (1xx)
	MISSING_HEADERS: "DEVORA_101",
	INVALID_TIMESTAMP: "DEVORA_102",
	TIMESTAMP_EXPIRED: "DEVORA_103",
	INVALID_SIGNATURE: "DEVORA_104",
	ORG_MISMATCH: "DEVORA_105",
	KEY_NOT_FOUND: "DEVORA_106",
	KEY_REVOKED: "DEVORA_107",
	MISSING_SIGNATURE: "DEVORA_108",

	// Validation errors (2xx)
	INVALID_CONFIG: "DEVORA_201",
	MISSING_ENDPOINT: "DEVORA_202",
	INVALID_HANDLER: "DEVORA_203",
	DUPLICATE_ENDPOINT: "DEVORA_204",
	BODY_TOO_LARGE: "DEVORA_205",
	INVALID_API_KEY: "DEVORA_206",
	INVALID_ORG_ID: "DEVORA_207",

	// Runtime errors (3xx)
	HANDLER_ERROR: "DEVORA_301",
	NETWORK_ERROR: "DEVORA_302",
	SESSION_EXPIRED: "DEVORA_303",
	TOKEN_CONSUMED: "DEVORA_304",

	// Scope errors (4xx)
	SCOPE_VIOLATION: "DEVORA_401",
	WRITE_BLOCKED: "DEVORA_402",

	// Rate limiting errors (5xx)
	RATE_LIMITED: "DEVORA_501",
	TOO_MANY_REQUESTS: "DEVORA_502",
} as const

export type DevoraErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

// ============================================================================
// HTTP Methods
// ============================================================================

/**
 * HTTP methods considered as write operations (blocked in read-only mode)
 */
export const WRITE_METHODS = ["POST", "PUT", "DELETE", "PATCH"] as const

/**
 * HTTP methods considered as read operations (allowed in read-only mode)
 */
export const READ_METHODS = ["GET", "HEAD", "OPTIONS"] as const

export type WriteMethod = (typeof WRITE_METHODS)[number]
export type ReadMethod = (typeof READ_METHODS)[number]

// ============================================================================
// Session Lifecycle
// ============================================================================

export * from "./sessionLifecycle.js"
