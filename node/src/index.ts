/**
 * Devora Node.js Backend SDK
 *
 * Secure backend SDK for enabling impersonation in your Node.js application.
 *
 * @example
 * ```typescript
 * import { createClient } from "redis"
 * import { devoraSDK, DEVORA_ENDPOINTS } from "@devorash/node"
 *
 * // Replay protection shared by every instance of your backend (required in production).
 * const redis = createClient({ url: process.env.REDIS_URL }).on("error", (err) => console.error("Redis error", err))
 * let redisReady: Promise<unknown> | undefined // one connection, shared by concurrent first requests
 *
 * const sdk = devoraSDK({
 *   apiKey: process.env.DEVORA_API_KEY!,
 *   secretKey: process.env.DEVORA_SECRET_KEY!,
 *   orgId: process.env.DEVORA_ORG_ID!,
 *   replayStore: {
 *     async consume(namespace, requestId, expiresAt) {
 *       await (redisReady ??= redis.connect().catch((err) => {
 *         redisReady = undefined // retry on the next request
 *         throw err
 *       }))
 *       const key = `devora:replay:${namespace}:${requestId}`
 *       // Atomic insert-if-absent kept until expiresAt; an error makes the SDK fail closed (503).
 *       const reply = await redis.sendCommand<string | null>(["SET", key, "1", "NX", "PXAT", String(expiresAt)])
 *       return reply === "OK"
 *     },
 *   },
 * })
 *
 * sdk.register(DEVORA_ENDPOINTS.USER_SEARCH, async (req) => ({
 *   users: await searchUsers(String(req.query.term ?? "")),
 * }))
 *
 * sdk.register(DEVORA_ENDPOINTS.IMPERSONATE, async (req) => {
 *   const ctx = req.devoraContext // set only after the signed request is verified
 *   if (!ctx) throw new Error("Missing verified Devora context")
 *   // Store ctx unchanged in the credential: createImpersonationGuard reads every
 *   // field of it back. Expire the credential no later than ctx.expiresAt.
 *   return { token: await generateToken(ctx.targetUser.id, ctx) }
 * })
 *
 * sdk.register(DEVORA_ENDPOINTS.TERMINATE, async (req) => {
 *   await invalidateSession(req.sessionId ?? req.params.id)
 *   return { success: true }
 * })
 * ```
 *
 * @packageDocumentation
 * @module @devorash/node
 */

// Main SDK
export { devoraSDK, resolveEnvironment } from "./sdk.js"

// HMAC utilities
export { sha256Hex, signRequest } from "./hmac.js"
export {
	controlPlaneFetch,
	readBoundedJsonObject,
	ControlPlaneResponseError,
	MAX_CONTROL_RESPONSE_BYTES,
} from "./transport.js"

// Request handler
export {
	processRequest,
	createGenericHandler,
	stripMountPath,
	DEFAULT_MAX_BODY_SIZE,
	type AdapterRequest,
} from "./handler.js"

// Impersonation middleware
export {
	createImpersonationGuard,
	validateImpersonationContext,
	resolveImpersonationIdentities,
	isWriteOperation,
} from "./middleware.js"
export type {
	ImpersonationContext,
	ImpersonationContextResult,
	ImpersonationGuardOptions,
	MiddlewareRequest,
	MiddlewareResponse,
	MiddlewareNext,
	ScopeEndpoint,
} from "./middleware.js"

// Scope configuration
export { createScopeConfigFetcher } from "./scope-config.js"
export type { ScopeConfig, ScopeConfigFetcherOptions } from "./scope-config.js"

// Persistent replay protection
export { InMemoryReplayStore } from "./replay-store.js"
export type { ReplayStore } from "./replay-store.js"

// Types
export type {
	NodeBackendSDKConfig,
	Logger,
	SDKRoute,
	DevoraBackendSDK,
	RegisterOptions,
	SDKStats,
	SessionStatusResult,
	ValidationResult,
	SignedRequestInput,
	FrameworkAdapter,
	DevoraEnvironment,
} from "./types.js"

// Re-export commonly used items from core
export {
	// Endpoints
	DEVORA_ENDPOINTS,
	ENDPOINT_METHODS,
	PROTECTED_ENDPOINTS,
	// Security headers
	SECURITY_HEADERS,
	// Defaults
	SDK_DEFAULTS,
	SDK_VERSION,
	// Error codes
	ERROR_CODES,
	// Errors
	DevoraSDKError,
	DevoraSecurityError,
	DevoraValidationError,
	DevoraConfigError,
	// Utilities
	matchPath,
	createSuccessResponse,
	createErrorResponse,
} from "@devorash/core"

// Re-export types from core
export type {
	DevoraRequest,
	DevoraResponse,
	DevoraUser,
	UserSearchRequest,
	UserSearchResponse,
	ImpersonationScope,
	ImpersonationDuration,
	DevoraImpersonationContext,
	ImpersonationStartRequest,
	ImpersonationStartResponse,
	ImpersonationTerminateRequest,
	ImpersonationTerminateResponse,
	RouteHandler,
	RouteDefinition,
	ConnectionTestResponse,
	HealthCheckResponse,
} from "@devorash/core"

// Browser-session bridge (server side)
export {
	resolveBrowserSession,
	BROWSER_SESSION_RESPONSE_HEADERS,
	type ResolveBrowserSessionInput,
} from "./browser-session.js"
export { BROWSER_SESSION_BRIDGE } from "@devorash/core"
export type { SessionBridgeResult, BrowserResumeCode } from "@devorash/core"
