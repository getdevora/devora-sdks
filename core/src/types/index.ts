/**
 * Core types for Devora SDKs
 * @module @devorash/core/types
 */

// ============================================================================
// Request & Response Types
// ============================================================================

/**
 * Normalized request object passed to customer handlers
 */
export interface DevoraRequest<
	TParams extends Record<string, string> = Record<string, string>,
	TQuery extends Record<string, string | string[] | undefined> = Record<
		string,
		string | string[] | undefined
	>,
	TBody = unknown,
> {
	/** HTTP method (GET, POST, etc.) */
	method: string
	/** Request path */
	path: string
	/** URL parameters (e.g., :id in /impersonate/:id) */
	params: TParams
	/** Query string parameters */
	query: TQuery
	/** Request body (for POST, PUT, etc.) */
	body: TBody
	/** Request headers */
	headers: Record<string, string | string[] | undefined>
	/** Organization ID from Devora */
	orgId: string
	/** API Key ID from Devora */
	keyId: string
	/** Session ID for impersonation requests */
	sessionId?: string
	/**
	 * Trusted impersonation context derived only after Devora HMAC validation.
	 *
	 * Customer handlers should prefer this over raw body fields for impersonation
	 * metadata because the SDK only populates it after request authentication.
	 */
	devoraContext?: DevoraImpersonationContext
}

/**
 * Standard response format for SDK endpoints
 */
export interface DevoraResponse<T = unknown> {
	/** Whether the request was successful */
	success: boolean
	/** Response data (on success) */
	data?: T
	/** Error message (on failure) */
	error?: string
	/** Error code (on failure) */
	errorCode?: string
	/** Unix timestamp of the response */
	timestamp: number
}

// ============================================================================
// User Search Types
// ============================================================================

/**
 * User object returned from search
 */
export interface DevoraUser {
	/** Unique user identifier (required) */
	id: string
	/** User's email address (recommended for display) */
	email?: string
	/** User's display name (recommended for display) */
	name?: string
	/** Optional avatar URL */
	avatarUrl?: string
	/** Optional additional metadata */
	metadata?: Record<string, unknown>
}

/**
 * Request for user search endpoint
 */
export interface UserSearchRequest {
	term: string
}

/**
 * Response from user search endpoint
 */
export interface UserSearchResponse {
	users: DevoraUser[]
}

// ============================================================================
// Impersonation Types
// ============================================================================

/**
 * Impersonation scope levels
 */
export type ImpersonationScope = "read" | "write"

/**
 * Duration window for impersonation
 */
export interface ImpersonationDuration {
	/** Start time (ISO timestamp) */
	from: string
	/** End time (ISO timestamp) */
	to: string
}

/**
 * Request body for impersonation start
 */
export interface ImpersonationStartRequest {
	/** Unique session ID from Devora */
	sessionId: string
	/** Access scope (read-only or read-write) */
	scope: ImpersonationScope
	/** Session expiration timestamp (Unix milliseconds) */
	expiresAt?: number
	/** Time window for impersonation */
	duration?: ImpersonationDuration
	/**
	 * Email of the agent requesting impersonation.
	 *
	 * PRIVACY NOTE: This field contains PII (Personally Identifiable Information).
	 * Ensure this value is not logged in plain text in application logs to comply
	 * with privacy requirements. Consider masking or hashing when logging.
	 */
	requestedBy?: string
	/** Agent performing the impersonation */
	impersonator?: ImpersonationUserInfo
	/** Target user being impersonated */
	targetUser?: ImpersonationUserInfo
}

/**
 * Response from impersonation start endpoint
 */
export interface ImpersonationStartResponse {
	/** Authentication token for the target user */
	token: string
	/** Optional initialization data for the frontend */
	data?: Record<string, unknown>
}

/**
 * Request body for session termination
 */
export interface ImpersonationTerminateRequest {
	/** Session ID to terminate */
	sessionId: string
	/** Reason for termination */
	reason: "manual" | "expired" | "terminated"
}

/**
 * Response from termination endpoint
 */
export interface ImpersonationTerminateResponse {
	/** Whether termination was successful */
	success: boolean
	/** Optional message */
	message?: string
}

// ============================================================================
// Frontend SDK Types
// ============================================================================

/**
 * User info for impersonation (target or impersonator)
 */
export interface ImpersonationUserInfo {
	/** User ID */
	id: string
	/** User's email address */
	email?: string
	/** User's display name */
	name?: string
}

/**
 * Trusted impersonation context exposed to backend customer handlers.
 */
export interface DevoraImpersonationContext {
	/**
	 * Always true. Present so the object can be stored on the customer session
	 * and handed back to `createImpersonationGuard` unchanged.
	 */
	isImpersonation: true
	/** Devora session ID */
	sessionId: string
	/** Access scope */
	scope: ImpersonationScope
	/** Session expiration timestamp (Unix milliseconds) */
	expiresAt: number
	/** Agent performing the impersonation */
	impersonator: ImpersonationUserInfo
	/** Target user being impersonated */
	targetUser: ImpersonationUserInfo
	/** Same identity as `impersonator`, in the guard's canonical field name. */
	actor: { id: string }
	/** Same identity as `targetUser`, in the guard's canonical field name. */
	subject: { id: string }
	/** This context is a dedicated impersonation session, not customer MFA. */
	authMethod: "devora_impersonation"
	/** How Devora authorized the request. */
	authorizationSource: "standard" | "self_approved" | "self_approved_read" | "break_glass"
	/**
	 * In the impersonate request: whether Devora's project policy will record
	 * this session. In the customer's response and the stored customer session:
	 * the customer backend's own decision for this exact session.
	 */
	recordingAllowed: boolean
}

/**
 * Payload passed to onImpersonate callback
 */
export interface ImpersonatePayload {
	/** Authentication token from customer backend */
	token: string
	/** Optional initialization data */
	data?: Record<string, unknown>
	/** Access scope */
	scope: ImpersonationScope
	/** Session expiration time (ISO timestamp) */
	expiresAt: string
	/** Unique session ID */
	sessionId: string
	/** Target user being impersonated */
	targetUser?: ImpersonationUserInfo
	/** Agent performing the impersonation */
	impersonator?: ImpersonationUserInfo
}

/**
 * Callback type for impersonation events
 */
export type ImpersonateCallback = (payload: ImpersonatePayload) => void | Promise<void>

/**
 * Callback type for session end events
 */
export type SessionEndCallback = (reason: string) => void | Promise<void>

/**
 * Frontend SDK configuration
 */
export interface FrontendSDKConfig {
	/** Public client API key (pk_client_live_xxx) */
	apiKey: string
	/** Enable debug logging */
	debug?: boolean
	/** Callback for impersonation start */
	onImpersonate?: ImpersonateCallback
	/** Callback for session end */
	onSessionEnd?: SessionEndCallback
	/** Custom error handlers */
	onError?: ErrorHandlers
}

/**
 * Payload error information
 */
export interface PayloadError {
	/** Error code */
	code: "invalid_format" | "missing_fields" | "expired" | "unknown"
	/** Human-readable error message */
	message: string
}

/**
 * Error handler configuration
 */
export interface ErrorHandlers {
	tokenValidationFailed?: (error: Error) => void
	scopeViolation?: (violation: ScopeViolation) => void
	sessionExpired?: () => void
	networkError?: (error: Error) => void
	/** Called when the impersonation payload in the URL is invalid or expired */
	payloadError?: (error: PayloadError) => void
}

// ============================================================================
// Recording Privacy & Capture Policy Types
// ============================================================================

/**
 * Masking profile chosen by the Devora administrator for a project.
 *
 * - `full`: every text node and input value is masked and media is blocked.
 *   The replay stays structurally intact (layout, navigation, clicks) but no
 *   content is captured unless the administrator unmasks a region or selector.
 * - `partial`: input values are masked; page text and media are visible.
 * - `minimal`: only sensitive fields are masked (password, one-time code,
 *   payment card and SSN-like inputs detected from type, autocomplete and
 *   name/id/aria-label heuristics).
 *
 * Sensitive fields stay masked in every profile and cannot be unmasked. The
 * profile is never configured in the SDK; it arrives with the session.
 */
export type DevoraMaskingProfile = "full" | "partial" | "minimal"

/** Whether a capture channel is on for a session scope. */
export type DevoraCapturePolicy = "disabled" | "write_only" | "all_sessions"

/**
 * The capture policy a session was created under, decided in the Devora
 * dashboard and delivered to the browser SDK with the session. A later policy
 * change applies to new sessions only.
 */
export interface DevoraCaptureSnapshot {
	/** Server-owned migration marker. New sessions use Settings exclusively. */
	settingsOnly?: boolean
	policyVersion: number
	recordingPolicy: DevoraCapturePolicy
	activityPolicy: DevoraCapturePolicy
	recordingMaskingProfile: DevoraMaskingProfile
	/** Block media elements (img, svg, video, audio, object, picture, embed). Always true for `full`. */
	recordingBlockMedia: boolean
	/** Administrator selectors whose text and input values are masked in any profile. */
	recordingMaskSelectors: string[]
	/** Administrator selectors removed from the replay entirely. */
	recordingBlockSelectors: string[]
	/** `data-devora-region` names the administrator chose to reveal. */
	recordingUnmaskRegions: string[]
	/** Administrator selectors revealed despite the profile (never sensitive fields). */
	recordingUnmaskSelectors: string[]
	/**
	 * Capture console warnings/errors in the replay and uncaught errors in the
	 * activity timeline. Under the full profile only error categories are kept
	 * and console arguments are masked; otherwise text is redacted and bounded.
	 * Stack traces are never recorded.
	 */
	consoleErrorCaptureEnabled: boolean
	/** Accept `logAction` custom events in the activity timeline. */
	activityCustomEventsEnabled: boolean
}

/**
 * Labels developers may place in their UI for administrator selectors/regions.
 * New sessions apply them only when selected in Devora Settings; legacy sessions
 * preserve their original hardening behavior. Labels cannot reveal content alone.
 */
export const DEVORA_PRIVACY_MARKERS = {
	MASK_CLASS: "devora-mask",
	BLOCK_CLASS: "devora-block",
	IGNORE_CLASS: "devora-ignore",
	MASK_ATTR: "data-devora-mask",
	BLOCK_ATTR: "data-devora-block",
	IGNORE_ATTR: "data-devora-ignore",
	REGION_ATTR: "data-devora-region",
} as const

/**
 * Scope violation event
 */
export interface ScopeViolation {
	/** Type of violation */
	type: "write_attempt"
	/** HTTP method that was blocked */
	method: string
	/** URL that was blocked */
	url: string
	/** Timestamp of the violation */
	timestamp: number
}

// ============================================================================
// Backend SDK Types
// ============================================================================

/**
 * Backend SDK configuration
 */
export interface BackendSDKConfig {
	/** Public server API key identifier (pk_server_*) */
	apiKey: string
	/** Secret API key beginning with sk_server_ (backend only; keep out of source control) */
	secretKey: string
	/** Devora organization ID bound into every signed request */
	orgId: string
	/** Enable debug logging */
	debug?: boolean
	/** Timestamp tolerance in seconds (default: 300) */
	timestampTolerance?: number
}

/**
 * Route handler function type
 */
export type RouteHandler<TRequest = DevoraRequest, TResponse = unknown> = (
	request: TRequest
) => Promise<TResponse> | TResponse

/**
 * Route definition for SDK endpoints
 */
export interface RouteDefinition<TRequest = DevoraRequest, TResponse = unknown> {
	/** Endpoint path (e.g., /user/search) */
	path: string
	/** HTTP method */
	method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH"
	/** Route handler function */
	handler: RouteHandler<TRequest, TResponse>
}

// ============================================================================
// Security Types
// ============================================================================

// ============================================================================
// Scope Configuration Types
// ============================================================================

/**
 * HTTP methods for whitelist endpoints (write methods only)
 */
export type WhitelistMethod = "POST" | "PUT" | "PATCH" | "DELETE"

/**
 * HTTP methods for blacklist endpoints (all methods including wildcard)
 */
export type BlacklistMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "*"

/**
 * Whitelist entry - allows write methods in read-only mode
 * These POST/PUT/PATCH/DELETE endpoints are allowed during read-only impersonation
 */
export interface SafeReadEndpoint {
	/** HTTP method */
	method: WhitelistMethod
	/** URL pattern (supports glob wildcards like /api/filters/*) */
	pattern: string
	/** Optional description */
	description?: string
}

/**
 * Blacklist entry - blocks endpoints in ANY impersonation mode
 * These endpoints are ALWAYS blocked during impersonation (even in write mode)
 */
export interface BlockedEndpoint {
	/** HTTP method (* blocks all methods) */
	method: BlacklistMethod
	/** URL pattern (supports glob wildcards like /api/payments/*) */
	pattern: string
	/** Optional description */
	description?: string
}

/**
 * Response from /api/sdk/scope-config endpoint
 */
export interface ScopeConfigResponse {
	/** Configuration version (for cache invalidation) */
	version: number
	/** Whitelist: Safe endpoints allowed in read-only mode */
	safeReadEndpoints: SafeReadEndpoint[]
	/** Blacklist: Endpoints blocked during ANY impersonation */
	blockedEndpoints: BlockedEndpoint[]
	/** Cache expiration timestamp (Unix ms) */
	cachedUntil: number
}

/**
 * @internal Scope config cache entry used by SDK implementations.
 */
export interface ScopeConfigCache {
	/** Cached configuration */
	config: ScopeConfigResponse
	/** When the cache was last updated */
	fetchedAt: number
	/** Whether a background refresh is in progress */
	refreshing: boolean
}

// ============================================================================
// Activity Logging Types
// ============================================================================

/**
 * Log event types
 */
export type LogEventType =
	| "session_start"
	| "session_end"
	| "navigation"
	| "click"
	| "form_submit"
	| "api_call"
	| "error"
	| "scope_violation"

/**
 * Log event structure
 */
export interface LogEvent {
	/** Event type */
	type: LogEventType
	/** Unix timestamp in milliseconds */
	timestamp: number
	/** Session ID */
	sessionId: string
	/** Page/route path */
	path?: string
	/** Action description */
	action?: string
	/** Additional metadata */
	metadata?: Record<string, unknown>
}

// ============================================================================
// SDK Info Types
// ============================================================================

/**
 * SDK metadata
 */
export interface SDKInfo {
	/** SDK name */
	name: string
	/** SDK version */
	version: string
	/** SDK type */
	type: "backend" | "frontend" | "adapter"
	/** Runtime environment */
	runtime?: "node" | "browser" | "edge"
}

/**
 * Health check response
 */
export interface HealthCheckResponse {
	/** SDK status */
	status: "healthy" | "degraded" | "unhealthy"
	/** SDK info */
	sdk: SDKInfo
	/** Request statistics */
	stats?: {
		totalRequests: number
		successfulRequests: number
		failedRequests: number
		securityErrors: number
	}
	/** Registered endpoints */
	endpoints?: Record<string, string>
}

/**
 * Connection test response
 */
export interface ConnectionTestResponse {
	status: "success"
	message: string
	timestamp: number
	/** Organization ID from request headers (informational) */
	orgId: string
	keyId: string
	sdk: SDKInfo
	security: {
		hmacValidated: boolean
		timestampValid: boolean
	}
}

// ============================================================================
// Browser-session bridge
// ============================================================================

/** What the customer route returns to the browser SDK for a tab restore. */
export type SessionBridgeResult =
	| { status: "none" }
	| { status: "resume"; code: string }
	| { status: "blocked"; reason: "control_plane_unavailable" | "session_invalid" }

/** One-time resume code minted by Devora for a specific tab and origin. */
export interface BrowserResumeCode {
	code: string
	expiresAt: number
}
