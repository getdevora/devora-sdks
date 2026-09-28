import type { BrowserResumeCode } from "@devorash/core"
/**
 * Node.js Backend SDK specific types
 * @module @devorash/node
 */

import type { BackendSDKConfig, DevoraRequest, RouteHandler, SDKInfo } from "@devorash/core"
import type { ScopeConfig } from "./scope-config.js"
import type { ReplayStore } from "./replay-store.js"

/**
 * Extended backend SDK configuration for Node.js
 */
export interface NodeBackendSDKConfig extends BackendSDKConfig {
	/**
	 * Devora API origin override (advanced; e.g. self-hosted deployments).
	 * Must be an https origin (http is allowed for localhost only).
	 * @default the origin baked into the SDK at build time
	 */
	apiUrl?: string
	/** Enable request logging */
	logRequests?: boolean
	/** Custom logger implementation */
	logger?: Logger
	/** Statistics collection */
	collectStats?: boolean
	/** Required in production so replay rejection works across processes/instances. */
	replayStore?: ReplayStore
	/**
	 * Runtime environment. Anything other than "development" or "test" is treated
	 * as production, which requires `replayStore`. Falls back to `DEVORA_ENV`,
	 * then `NODE_ENV`, then "production" (fail closed).
	 */
	environment?: DevoraEnvironment
}

export type DevoraEnvironment = "development" | "test" | "production"

/**
 * Logger interface for custom logging
 */
export interface Logger {
	debug: (message: string, meta?: Record<string, unknown>) => void
	info: (message: string, meta?: Record<string, unknown>) => void
	warn: (message: string, meta?: Record<string, unknown>) => void
	error: (message: string, meta?: Record<string, unknown>) => void
}

/**
 * Route definition with method and handler
 */
export interface SDKRoute<TRequest = DevoraRequest, TResponse = unknown> {
	/** Endpoint path */
	path: string
	/** HTTP method */
	method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH"
	/** Route handler */
	handler: RouteHandler<TRequest, TResponse>
	/** Whether this is a built-in route */
	isBuiltIn?: boolean
}

/**
 * Result of a server-side session liveness check.
 */
export interface SessionStatusResult {
	/** True only when the session is active and not past its hard expiry. */
	valid: boolean
	/** Machine-readable reason when not valid (e.g. SESSION_TERMINATED, SESSION_EXPIRED). */
	error?: string
	/** Raw session status (active, terminated, completed, expired, ...). */
	status?: string
	/** Session scope. */
	scope?: "read" | "write"
	/** Session hard expiry as a Unix timestamp in milliseconds. */
	expiresAt?: number
	/** Remaining time in milliseconds. */
	remainingMs?: number
}

/**
 * SDK instance returned by devoraSDK()
 */
export interface DevoraBackendSDK {
	/** SDK configuration (read-only) */
	readonly config: NodeBackendSDKConfig
	/** SDK info */
	readonly info: SDKInfo
	/** Resolves after the initial scope policy fetch attempt completes. Use getScopeConfig() or isPolicyLoaded() to check whether policy is available. */
	readonly ready: Promise<void>
	/** Register a new endpoint handler */
	register: <TRequest extends DevoraRequest, TResponse>(
		path: string,
		handler: RouteHandler<TRequest, TResponse>,
		options?: RegisterOptions
	) => SDKRoute<TRequest, TResponse>
	/** Get all registered routes */
	getRoutes: () => SDKRoute[]
	/** Get statistics */
	getStats: () => SDKStats
	/** Fetch the latest centrally managed scope policy, using the cache when valid. */
	getScopeConfig: () => Promise<ScopeConfig | null>
	/** Whether a scope policy is currently cached in memory. */
	isPolicyLoaded: () => boolean
	/** Return the currently cached scope policy without network I/O. */
	getCachedScopeConfig: () => ScopeConfig | null
	/** Force a scope policy refresh. */
	refreshScopeConfig: () => Promise<ScopeConfig | null>
	/**
	 * Check whether a Devora session is still live (not terminated, revoked, or expired).
	 * Used by the optional `enforceLiveness` guard. Returns null when Devora is unreachable.
	 */
	getSessionStatus: (sessionId: string) => Promise<SessionStatusResult | null>
	/**
	 * Ask Devora for a one-time browser resume code for an active session. The
	 * request is signed with the server secret and consumed once. Returns null
	 * when Devora is unreachable; throws never.
	 */
	createBrowserResumeCode: (input: {
		sessionId: string
		tabRef: string
		origin: string
	}) => Promise<BrowserResumeCode | { error: string; status?: number } | null>
	/** Stop background refresh timers. */
	destroy: () => void
	/** @internal Record a processed request for SDK statistics. */
	_recordRequest?: (endpoint: string, outcome: "success" | "failure" | "security_error") => void
	/**
	 * Verify a signed request from Devora over its exact wire bytes (signature
	 * v3): headers, key and org, timestamp, raw path and query, body digest,
	 * direction, then single-use request id. Nothing is re-serialized.
	 * Optional tolerance (seconds) overrides the SDK config for this call.
	 */
	verifyRequest: (
		request: SignedRequestInput,
		options?: { timestampTolerance?: number }
	) => Promise<ValidationResult>
}

/**
 * Options for register()
 */
export interface RegisterOptions {
	/** HTTP method (auto-detected if using DEVORA_ENDPOINTS) */
	method?: "GET" | "POST" | "DELETE" | "PUT" | "PATCH"
	/** Custom description for debug output */
	description?: string
}

/**
 * SDK statistics
 */
export interface SDKStats {
	/** Total requests received */
	totalRequests: number
	/** Successful requests */
	successfulRequests: number
	/** Failed requests */
	failedRequests: number
	/** Security validation errors */
	securityErrors: number
	/** Requests by endpoint */
	requestsByEndpoint: Record<string, number>
}

/**
 * A signed request exactly as received. `path` is relative to the SDK mount
 * and still percent-encoded; `query` is everything after the first `?`.
 */
export interface SignedRequestInput {
	method: string
	path: string
	query: string
	body: Uint8Array
	headers: Record<string, string | string[] | undefined>
}

/**
 * Validation result for incoming requests
 */
export interface ValidationResult {
	/** Whether validation passed */
	valid: boolean
	/** Error message if validation failed */
	error?: string
	/** Machine-readable error code when validation failed */
	errorCode?: string
	/** Extracted organization ID */
	orgId?: string
	/** Extracted key ID */
	keyId?: string
	/** Request timestamp */
	timestamp?: number
	/** Unique request ID */
	requestId?: string
}

/**
 * Adapter interface for framework integrations
 */
export interface FrameworkAdapter<THandler = unknown> {
	/** Adapter name */
	name: string
	/** Create framework-specific handler */
	createHandler: (sdk: DevoraBackendSDK, routes: SDKRoute[]) => THandler
}
