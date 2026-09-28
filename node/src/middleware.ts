/**
 * Impersonation scope enforcement middleware
 *
 * Provides defense-in-depth by validating impersonation scope on the backend,
 * blocking write operations in read-only mode even if the frontend SDK is bypassed.
 *
 * @module @devorash/node
 */

import {
	isWriteMethod,
	matchEndpointPattern,
	isAmbiguousRequestPath,
	getRawRequestPath,
	getPolicyMethods,
	getDenyMethods,
	joinMountedTarget,
	createErrorResponse,
	getErrorStatusCode,
	type ImpersonationScope,
} from "@devorash/core"
import type { DevoraBackendSDK } from "./types.js"

/**
 * Impersonation context extracted from JWT or request
 */
export interface ImpersonationContext {
	/** Whether this is an impersonation session */
	isImpersonation: boolean
	/**
	 * The Devora agent actually performing the action. Optional only because
	 * `impersonator` (the field name the SDK handler emits) is accepted as an
	 * equivalent source; one of the two must be present.
	 */
	actor?: { id: string }
	/**
	 * The authenticated customer user being represented. `targetUser` is
	 * accepted as an equivalent source.
	 */
	subject?: { id: string }
	/** Access scope: "read" or "write" */
	scope: ImpersonationScope
	/** Devora session ID */
	sessionId?: string
	/** This is always a distinct customer impersonation session, never customer MFA. */
	authMethod: "devora_impersonation"
	/** How the Devora request was authorized. */
	authorizationSource: "standard" | "self_approved" | "self_approved_read" | "break_glass"
	/** Whether the customer backend permitted recording for this exact session. */
	recordingAllowed: boolean
	/**
	 * When the session expires.
	 *
	 * IMPORTANT: This should be a Unix timestamp in MILLISECONDS (matching JavaScript's Date.now()).
	 * If your JWT uses seconds (standard Unix timestamp), multiply by 1000 when extracting.
	 *
	 * Example:
	 * ```typescript
	 * getImpersonationContext: (req) => ({
	 *   ...req.user.devora,
	 *   // Convert seconds to milliseconds if needed
	 *   expiresAt: req.user.devora.expiresAt * 1000,
	 * })
	 * ```
	 */
	expiresAt?: number
	/** Information about the impersonator (agent) */
	impersonator?: {
		id: string
		email?: string
		name?: string
	}
	/** Information about the impersonated customer user */
	targetUser?: {
		id: string
		email?: string
		name?: string
	}
}

/**
 * What a context extractor may return: the context, or `null`/`undefined` for
 * ordinary (non-impersonated) traffic. Async extractors are awaited.
 */
export type ImpersonationContextResult =
	| ImpersonationContext
	| null
	| undefined
	| Promise<ImpersonationContext | null | undefined>

const AUTHORIZATION_SOURCES = new Set([
	"standard",
	"self_approved",
	"self_approved_read",
	"break_glass",
])

/** Resolve the canonical actor/subject ids from either field-name convention. */
export function resolveImpersonationIdentities(
	context: Pick<ImpersonationContext, "actor" | "subject" | "impersonator" | "targetUser">
): { actorId?: string; subjectId?: string } {
	return {
		actorId: context.actor?.id ?? context.impersonator?.id,
		subjectId: context.subject?.id ?? context.targetUser?.id,
	}
}

/**
 * Generic request interface for middleware
 */
export interface MiddlewareRequest {
	method: string
	path: string
	url?: string
	originalUrl?: string
	/** Express: the mount path of the router running the guard. */
	baseUrl?: string
	/** Request headers (lower-case names); used to detect method-override headers. */
	headers?: Record<string, string | string[] | undefined>
	/**
	 * Origin-form targets (`/path?query`, full client-visible path) the framework
	 * dispatches on after any rewrites. Adapters set this; the default is
	 * `baseUrl + url`. Safe-read allow rules must match every routed target and
	 * the original target; deny rules match any of them.
	 */
	routedUrls?: string[]
	/**
	 * Additional deny-only views of the same request (for example a path with a
	 * framework base path or locale prefix removed). They can only block.
	 */
	aliasUrls?: string[]
}

/**
 * Generic response interface for middleware
 */
export interface MiddlewareResponse {
	status: (code: number) => MiddlewareResponse
	json: (body: unknown) => void
}

/**
 * Next function type for middleware
 */
export type MiddlewareNext = () => void | Promise<void>

// Re-export ScopeEndpoint from scope-config for convenience
export type { ScopeEndpoint } from "./scope-config.js"

// Import for internal use
import type { ScopeEndpoint } from "./scope-config.js"

/**
 * Options for the impersonation guard middleware
 */
export interface ImpersonationGuardOptions<TRequest = MiddlewareRequest> {
	/** Initialized Devora SDK used to load the centrally managed policy. */
	sdk: DevoraBackendSDK
	/**
	 * Function to extract impersonation context from the request, typically from
	 * the authenticated session or JWT claims. Return `null` for ordinary traffic.
	 * May be async. Any other non-context value fails closed with a 500.
	 */
	getImpersonationContext: (req: TRequest) => ImpersonationContextResult

	/**
	 * Callback when a request is blocked.
	 * Useful for logging or alerting. Errors it throws are ignored.
	 */
	onBlocked?: (req: TRequest, context: ImpersonationContext) => void

	/**
	 * Custom response when a request is blocked.
	 * Defaults to a standard 403 response.
	 */
	blockedResponse?: {
		status?: number
		message?: string
		errorCode?: string
	}

	/**
	 * Whether to show warnings in console when requests are blocked.
	 * Defaults to true in development.
	 */
	showWarnings?: boolean

	/**
	 * Enforce server-side session liveness in addition to scope and expiry. When true, the
	 * guard asks Devora whether the request's session is still live and blocks it if the
	 * session was terminated or revoked early (before its hard expiry). On by default.
	 *
	 * Requires `getImpersonationContext` to return a `sessionId`. Adds at most one cached
	 * lookup per session per `livenessCacheTtlMs`.
	 */
	enforceLiveness?: boolean

	/**
	 * How long, in milliseconds, to cache a liveness result per session. Lower values detect
	 * early termination faster at the cost of more lookups. Default 5000 (5 seconds).
	 */
	livenessCacheTtlMs?: number

	/**
	 * Behavior when Devora cannot be reached for a liveness check:
	 * - "allow": fall back to scope and expiry enforcement (local development only).
	 * - "deny" (default): fail closed — block impersonated requests until Devora is reachable.
	 */
	onLivenessUnavailable?: "allow" | "deny"

	/**
	 * Path where you mounted the browser-session bridge handler, for example
	 * `/api/devora/browser-session`. When set, a `POST` to exactly this path is
	 * allowed in read scope (it mints a resume code, it is not a customer write).
	 * The blocklist and `isImpersonationAllowed` still apply. Off by default:
	 * only set it when the bridge is actually mounted at that path.
	 */
	bridgePath?: string

	/**
	 * Semantic authorization hook for application-specific high-risk actions.
	 * It runs after the static blocklist and before scope allowlisting. Returning
	 * false blocks the impersonated request; normal customer traffic is untouched.
	 */
	isImpersonationAllowed?: (
		req: TRequest,
		context: ImpersonationContext
	) => boolean | Promise<boolean>
}

/**
 * Check if methods match (considering wildcard)
 */
function methodsMatch(patternMethod: string, requestMethod: string): boolean {
	if (patternMethod === "*") return true
	return patternMethod.toUpperCase() === requestMethod.toUpperCase()
}

/** Percent-encoded and decoded forms of one origin-form target. */
interface TargetForms {
	raw: string
	decoded: string
}

function targetForms(target: string): TargetForms {
	const raw = getRawRequestPath(target)
	let decoded = raw
	try {
		decoded = decodeURIComponent(raw)
	} catch {
		// Undecodable targets are rejected as ambiguous before any matching.
	}
	return { raw, decoded }
}

/** First deny rule matching any method against any form of any target. */
function findBlockedEndpoint(
	targets: TargetForms[],
	methods: string[],
	blockedEndpoints?: ScopeEndpoint[]
): ScopeEndpoint | null {
	if (!blockedEndpoints || blockedEndpoints.length === 0) return null
	const denyMethods = getDenyMethods(methods)
	for (const endpoint of blockedEndpoints) {
		if (!denyMethods.some((method) => methodsMatch(endpoint.method, method))) continue
		for (const target of targets)
			for (const candidate of [target.raw, target.decoded])
				if (
					matchEndpointPattern(endpoint.pattern, candidate, {
						caseSensitive: false,
						ignoreTrailingSlash: true,
					})
				)
					return endpoint
	}
	return null
}

/** A safe-read allow rule must match both forms of every routed target. */
function isAllowlisted(
	targets: TargetForms[],
	method: string,
	safeReadEndpoints?: ScopeEndpoint[]
): boolean {
	if (!safeReadEndpoints || safeReadEndpoints.length === 0) return false
	return safeReadEndpoints.some(
		(endpoint) =>
			endpoint.method !== "*" &&
			methodsMatch(endpoint.method, method) &&
			targets.every(
				(target) =>
					matchEndpointPattern(endpoint.pattern, target.raw) &&
					matchEndpointPattern(endpoint.pattern, target.decoded)
			)
	)
}

/** The targets a request is judged on. */
function requestTargets(req: MiddlewareRequest): { routed: string[]; aliases: string[] } {
	const original = req.originalUrl ?? req.url ?? req.path
	const effective = req.routedUrls ?? [joinMountedTarget(req.baseUrl, req.url ?? req.path)]
	return {
		routed: [...new Set([original, ...effective])],
		// Express strips the current router mount from req.url. Deny rules
		// must also see that view, just as Python's mount-relative aliases do.
		aliases: [...(req.aliasUrls ?? []), ...(req.baseUrl ? [req.url ?? req.path] : [])],
	}
}

type GuardVerdict =
	| { allowed: true }
	| {
			allowed: false
			status: number
			error: string
			errorCode: string
			/** Context to pass to onBlocked; absent for non-policy failures. */
			blockedContext?: ImpersonationContext
			warning?: string
	  }

/**
 * Create an impersonation guard middleware
 *
 * This middleware validates impersonation scope and blocks write operations
 * in read-only mode. It provides defense-in-depth protection on the backend.
 *
 * Every request target the framework may dispatch on is judged: the original
 * target, the effective target after rewrites/mounts, and any deny-only aliases.
 * Policy patterns match the full client-visible path, including mount prefixes.
 *
 * Enforcement Priority:
 * 1. Check blacklist first - if match, BLOCK (regardless of scope)
 * 2. Run the application's isImpersonationAllowed hook
 * 3. If scope is "write", ALLOW (blacklist already checked)
 * 4. If scope is "read" and write method, check whitelist
 * 5. If not in whitelist, BLOCK
 */
export function createImpersonationGuard<TRequest extends MiddlewareRequest = MiddlewareRequest>(
	options: ImpersonationGuardOptions<TRequest>
): (req: TRequest, res: MiddlewareResponse, next: MiddlewareNext) => Promise<void> {
	const {
		sdk,
		getImpersonationContext,
		onBlocked,
		blockedResponse = {},
		showWarnings = process.env.NODE_ENV !== "production",
		enforceLiveness = true,
		livenessCacheTtlMs = 5_000,
		onLivenessUnavailable = "deny",
		isImpersonationAllowed,
		bridgePath,
	} = options
	if (onLivenessUnavailable !== "allow" && onLivenessUnavailable !== "deny")
		throw new Error("Invalid liveness unavailable policy")
	if (!Number.isFinite(livenessCacheTtlMs) || livenessCacheTtlMs < 0)
		throw new Error("Invalid liveness cache TTL")
	if (
		bridgePath !== undefined &&
		(typeof bridgePath !== "string" ||
			isAmbiguousRequestPath(bridgePath) ||
			getRawRequestPath(bridgePath) !== bridgePath)
	)
		throw new Error("Invalid bridge path")

	const responseMessage = blockedResponse.message ?? "This action is blocked during impersonation"
	const responseErrorCode = blockedResponse.errorCode ?? "IMPERSONATION_SCOPE_VIOLATION"

	// Per-guard cache of recent liveness results. `live: null` records an
	// "unavailable" verdict for a short window so an outage costs one lookup per
	// session per second instead of one blocked 5-second fetch per request.
	const livenessCache = new Map<string, { live: boolean | null; checkedAt: number }>()
	const livenessInFlight = new Map<string, Promise<boolean | null>>()
	const unavailableCacheMs = Math.min(1_000, livenessCacheTtlMs)
	const maxCachedSessions = 1000

	function remember(sessionId: string, live: boolean | null): void {
		livenessCache.delete(sessionId)
		livenessCache.set(sessionId, { live, checkedAt: performance.now() })
		if (livenessCache.size > maxCachedSessions)
			livenessCache.delete(livenessCache.keys().next().value!)
	}

	/** Bounded single-flight lookups, including custom transports that stall. */
	async function isSessionLive(sessionId: string): Promise<boolean | null> {
		const now = performance.now()
		const cached = livenessCache.get(sessionId)
		if (cached) {
			const ttl = cached.live === null ? unavailableCacheMs : livenessCacheTtlMs
			if (now - cached.checkedAt < ttl) {
				livenessCache.delete(sessionId)
				livenessCache.set(sessionId, cached)
				return cached.live
			}
			livenessCache.delete(sessionId)
		}
		const pending = livenessInFlight.get(sessionId)
		if (pending) return pending
		if (livenessInFlight.size >= 64) return null
		const actual = Promise.resolve()
			.then(() => sdk.getSessionStatus(sessionId))
			.then((status) => (status == null ? null : status.valid === true))
			.catch(() => null)
		const lookup = new Promise<boolean | null>((resolve) => {
			let finished = false
			const timer = setTimeout(() => {
				finished = true
				remember(sessionId, null)
				resolve(null)
			}, 5_000)
			void actual.then((live) => {
				clearTimeout(timer)
				livenessInFlight.delete(sessionId)
				if (!finished) {
					finished = true
					remember(sessionId, live)
					resolve(live)
				}
			})
		})
		// A timed-out transport retains its slot until it actually settles. That
		// prevents repeated requests from creating unbounded background work.
		livenessInFlight.set(sessionId, lookup)
		return lookup
	}

	async function decide(req: TRequest): Promise<GuardVerdict> {
		const context = await getImpersonationContext(req)

		// Only an explicit absence of impersonation passes through unchecked. A
		// value of any other shape is an integration error and fails closed.
		if (context === null || context === undefined) return { allowed: true }
		if (typeof context !== "object" || typeof context.isImpersonation !== "boolean")
			return {
				allowed: false,
				status: 500,
				error: "Invalid impersonation context",
				errorCode: "INVALID_IMPERSONATION_CONTEXT",
			}
		if (!context.isImpersonation) return { allowed: true }

		const contextValidation = validateImpersonationContext(context)
		if (!contextValidation.valid) {
			const errorCode = contextValidation.expired
				? "IMPERSONATION_EXPIRED"
				: "INVALID_IMPERSONATION_CONTEXT"
			return {
				allowed: false,
				status: getErrorStatusCode(errorCode),
				error: contextValidation.expired
					? "Impersonation session expired"
					: "Invalid impersonation context",
				errorCode,
			}
		}

		const { routed, aliases } = requestTargets(req)
		if ([...routed, ...aliases].some((target) => isAmbiguousRequestPath(target)))
			return {
				allowed: false,
				status: getErrorStatusCode("IMPERSONATION_ENDPOINT_BLOCKED"),
				error: "Ambiguous request path",
				errorCode: "IMPERSONATION_ENDPOINT_BLOCKED",
				blockedContext: context,
			}
		const routedForms = routed.map(targetForms)
		const allForms = [...routedForms, ...aliases.map(targetForms)]
		const displayPath = routedForms[routedForms.length - 1]!.decoded
		const methods = getPolicyMethods(req.method, req.headers, req.originalUrl ?? req.url)

		// Optional server-side liveness: block sessions terminated/revoked before their expiry.
		if (enforceLiveness && context.sessionId) {
			const live = await isSessionLive(context.sessionId)
			if (live === null && onLivenessUnavailable === "deny") {
				// Distinct from "ended": the session may well be live, but it cannot
				// be verified. Fail closed for impersonated traffic only.
				return {
					allowed: false,
					status: 503,
					error: "Impersonation session liveness could not be verified",
					errorCode: "IMPERSONATION_LIVENESS_UNAVAILABLE",
				}
			}
			if (live === false)
				return {
					allowed: false,
					status: getErrorStatusCode("IMPERSONATION_SESSION_ENDED"),
					error: "Impersonation session is no longer active",
					errorCode: "IMPERSONATION_SESSION_ENDED",
					blockedContext: context,
					warning: `${req.method} ${displayPath} - session no longer live`,
				}
		}

		const policy = await sdk.getScopeConfig()
		if (!policy)
			return {
				allowed: false,
				status: getErrorStatusCode("IMPERSONATION_POLICY_UNAVAILABLE"),
				error: "Impersonation policy is temporarily unavailable",
				errorCode: "IMPERSONATION_POLICY_UNAVAILABLE",
			}

		// 1. Deny rules FIRST - blocked regardless of scope, on any target/alias.
		const blockedBy = findBlockedEndpoint(allForms, methods, policy.blockedEndpoints)
		if (blockedBy)
			return {
				allowed: false,
				status: blockedResponse.status ?? getErrorStatusCode("IMPERSONATION_ENDPOINT_BLOCKED"),
				error: "This endpoint is blocked during impersonation",
				errorCode: "IMPERSONATION_ENDPOINT_BLOCKED",
				blockedContext: context,
				warning: `${methods.join("/")} ${displayPath} - blacklisted (${blockedBy.method} ${blockedBy.pattern})`,
			}

		// 2. Application-specific semantic authorization.
		if (isImpersonationAllowed && (await isImpersonationAllowed(req, context)) !== true)
			return {
				allowed: false,
				status: blockedResponse.status ?? getErrorStatusCode("IMPERSONATION_ENDPOINT_BLOCKED"),
				error: "This action is not permitted during impersonation",
				errorCode: "IMPERSONATION_ENDPOINT_BLOCKED",
				blockedContext: context,
			}

		// 3. Write scope allows everything that is not denied.
		if (context.scope === "write") return { allowed: true }

		const writeMethods = methods.filter((method) => isWriteMethod(method))
		if (writeMethods.length === 0) return { allowed: true }

		// 4. The browser-session bridge mints a Devora resume code for this
		// already-authenticated, live session. It is not a customer write.
		if (
			bridgePath &&
			methods.length === 1 &&
			methods[0] === "POST" &&
			routedForms.every((target) => target.raw === bridgePath && target.decoded === bridgePath)
		)
			return { allowed: true }

		// 5. Read scope: every write method must be allowlisted on every routed target.
		if (
			writeMethods.every((method) => isAllowlisted(routedForms, method, policy.safeReadEndpoints))
		)
			return { allowed: true }

		return {
			allowed: false,
			status: blockedResponse.status ?? getErrorStatusCode(responseErrorCode),
			error: responseMessage,
			errorCode: responseErrorCode,
			blockedContext: context,
			warning: `${methods.join("/")} ${displayPath} - read-only impersonation`,
		}
	}

	return async (req: TRequest, res: MiddlewareResponse, next: MiddlewareNext): Promise<void> => {
		let verdict: GuardVerdict
		try {
			verdict = await decide(req)
		} catch {
			// Extractor, policy and hook failures must never hang the request or
			// surface as an unhandled rejection (Express 4); they fail closed.
			verdict = {
				allowed: false,
				status: 500,
				error: "Impersonation guard failed",
				errorCode: "INTERNAL_ERROR",
			}
		}

		if (verdict.allowed) {
			await next()
			return
		}

		if (verdict.blockedContext) {
			if (showWarnings && verdict.warning)
				console.warn(
					`[Devora] Blocked ${verdict.warning} (session: ${verdict.blockedContext.sessionId})`
				)
			try {
				onBlocked?.(req, verdict.blockedContext)
			} catch {
				// Audit callbacks cannot change the decision.
			}
		}
		res.status(verdict.status).json(createErrorResponse(verdict.error, verdict.errorCode))
	}
}

/**
 * Validate impersonation context
 *
 * Utility function to check if impersonation context is valid and not expired.
 * Types are checked strictly; nothing is coerced.
 */
export function validateImpersonationContext(context: ImpersonationContext | undefined | null): {
	valid: boolean
	expired?: boolean
	error?: string
} {
	if (!context || typeof context !== "object") {
		return { valid: false, error: "No impersonation context" }
	}

	if (context.isImpersonation !== true) {
		return { valid: false, error: "Not an impersonation session" }
	}

	if (context.scope !== "read" && context.scope !== "write") {
		return { valid: false, error: "Invalid scope" }
	}
	const identities = resolveImpersonationIdentities(context)
	if (
		typeof identities.actorId !== "string" ||
		!identities.actorId ||
		typeof identities.subjectId !== "string" ||
		!identities.subjectId
	) {
		return { valid: false, error: "Missing impersonation actor or subject" }
	}
	if (context.authMethod !== "devora_impersonation") {
		return { valid: false, error: "Invalid impersonation authentication method" }
	}
	if (!AUTHORIZATION_SOURCES.has(context.authorizationSource as string)) {
		return { valid: false, error: "Invalid authorization source" }
	}
	if (typeof context.recordingAllowed !== "boolean") {
		return { valid: false, error: "Missing recording authorization" }
	}
	if (typeof context.sessionId !== "string" || !context.sessionId) {
		return { valid: false, error: "Missing session ID" }
	}

	// expiresAt must be an integer Unix timestamp in milliseconds (Date.now()).
	// If your JWT uses seconds, convert it when extracting the context.
	if (typeof context.expiresAt !== "number" || !Number.isSafeInteger(context.expiresAt)) {
		return { valid: false, error: "Missing expiration" }
	}
	const YEAR_2000_MS = 946684800000
	if (context.expiresAt < YEAR_2000_MS) {
		return { valid: false, error: "Expiration must be a Unix timestamp in milliseconds" }
	}
	if (Date.now() > context.expiresAt) {
		return { valid: false, expired: true, error: "Impersonation session expired" }
	}

	return { valid: true }
}

/**
 * Check if a request method is a write operation
 *
 * @deprecated Use isWriteMethod from @devorash/core instead
 */
export function isWriteOperation(method: string): boolean {
	return isWriteMethod(method.toUpperCase())
}
