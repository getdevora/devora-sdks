import type { BrowserResumeCode } from "@devorash/core"
/**
 * Main Devora Backend SDK implementation
 * @module @devorash/node
 */

import {
	DEVORA_ENDPOINTS,
	ENDPOINT_METHODS,
	PROTECTED_ENDPOINTS,
	SDK_DEFAULTS,
	SDK_PACKAGES,
	SDK_VERSION,
	validateTimestamp,
	SIGNING,
	SIGNED_HEADER_PATTERNS,
	buildCanonicalString,
	hasIdentityContentEncoding,
	isValidSignedPath,
	isValidSignedQuery,
	parseSignatureHeaders,
	parseVerifiedJsonBody,
	getSingleHeader,
	REQUEST_CLAIM,
	assertTimestampTolerance,
	isValidTimestampTolerance,
	createSDKInfo,
	createLogger,
	type DevoraEndpointPath,
	type DevoraRequest,
	type RouteHandler,
	type ConnectionTestResponse,
	type HealthCheckResponse,
	BROWSER_SESSION_BRIDGE,
} from "@devorash/core"

import { sha256Hex, signatureMatches, signRequest } from "./hmac.js"
import { controlPlaneFetch, readBoundedJsonObject } from "./transport.js"
import { createScopeConfigFetcher } from "./scope-config.js"
import type {
	DevoraBackendSDK,
	RegisterOptions,
	NodeBackendSDKConfig,
	SDKRoute,
	SDKStats,
	SessionStatusResult,
	SignedRequestInput,
	ValidationResult,
} from "./types.js"

/**
 * Validate secret key format
 * Expected format: sk_server_live_xxx
 */
function validateSecretKeyFormat(secretKey: string): { valid: boolean; error?: string } {
	return SIGNED_HEADER_PATTERNS.secretKey.test(secretKey)
		? { valid: true }
		: {
				valid: false,
				error: "Invalid secret key format. Expected sk_server_live_ followed by 64 characters",
			}
}

/**
 * Resolve and validate the Devora API origin.
 * Only https origins are accepted (http for localhost/127.0.0.1 development).
 */
function resolveApiUrl(override: string | undefined): string {
	if (!override) return SDK_DEFAULTS.API_URL
	let parsed: URL
	try {
		parsed = new URL(override)
	} catch {
		throw new Error(`Devora SDK: apiUrl is not a valid URL: ${override}`)
	}
	const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) {
		throw new Error("Devora SDK: apiUrl must use https (http is allowed for localhost only)")
	}
	if (
		parsed.username ||
		parsed.password ||
		(parsed.pathname && parsed.pathname !== "/") ||
		parsed.search ||
		parsed.hash
	) {
		throw new Error("Devora SDK: apiUrl must be an origin without path, query, or credentials")
	}
	return parsed.origin
}

/** A start request: `POST …/impersonate/:id` under any mount path. */
const START_REQUEST_PATH = /\/impersonate\/[^/]+$/

/**
 * Create a Devora Backend SDK instance
 *
 * Security: The SDK authenticates requests using HMAC-SHA256 signatures.
 * The secret key is unique per organization, so valid HMAC = authenticated request.
 * Each verified request is then claimed once from Devora, so it cannot be replayed.
 */
export function devoraSDK(config: NodeBackendSDKConfig): DevoraBackendSDK {
	// Runtime allowlist: unknown capture/preferences are ignored in JavaScript too.
	config = {
		apiKey: config.apiKey,
		secretKey: config.secretKey,
		orgId: config.orgId,
		apiUrl: config.apiUrl,
		debug: config.debug,
		timestampTolerance: config.timestampTolerance,
		logRequests: config.logRequests,
		logger: config.logger,
		collectStats: config.collectStats,
	}
	// Validate configuration
	if (!config.secretKey) {
		throw new Error("Devora SDK: secretKey is required")
	}
	if (!SIGNED_HEADER_PATTERNS.keyId.test(config.apiKey ?? "")) {
		throw new Error("Devora SDK: apiKey must be a server key identifier (pk_server_live_*)")
	}
	if (!config.orgId?.trim()) {
		throw new Error("Devora SDK: orgId is required")
	}
	assertTimestampTolerance(config.timestampTolerance)
	const apiUrl = resolveApiUrl(config.apiUrl)

	// Validate secret key format (security check)
	const secretKeyValidation = validateSecretKeyFormat(config.secretKey)
	if (!secretKeyValidation.valid) {
		throw new Error(`Devora SDK: ${secretKeyValidation.error}`)
	}

	// Initialize logger - uses global config by default, can be overridden with debug option
	const logger = createLogger("Devora SDK", config.debug)

	// SDK info
	const info = createSDKInfo(SDK_PACKAGES.NODE, "backend", "node")

	// Statistics
	const stats: SDKStats = {
		totalRequests: 0,
		successfulRequests: 0,
		failedRequests: 0,
		securityErrors: 0,
		requestsByEndpoint: {},
	}

	// Registered routes
	const routes: SDKRoute[] = []
	const scopeConfig = createScopeConfigFetcher({
		apiKey: config.apiKey,
		signRequest: () =>
			signRequest({
				secretKey: config.secretKey,
				direction: SIGNING.CUSTOMER_TO_DEVORA,
				keyId: config.apiKey,
				orgId: config.orgId,
				method: "GET",
				path: "/api/sdk/scope-config",
			}),
		apiUrl,
		debug: config.debug,
	})
	const ready = scopeConfig.getConfig().then((policy) => {
		if (!policy) {
			logger.warn(
				"Scope policy could not be loaded; getScopeConfig() may return null until refresh succeeds"
			)
		}
	})

	// Register built-in routes
	registerBuiltInRoutes()

	/**
	 * Register built-in /test and /health endpoints
	 */
	function registerBuiltInRoutes(): void {
		// Test endpoint
		routes.push({
			path: DEVORA_ENDPOINTS.TEST,
			method: "GET",
			isBuiltIn: true,
			handler: async (req: DevoraRequest): Promise<ConnectionTestResponse> => {
				logger.log("Test endpoint called", { orgId: req.orgId, keyId: req.keyId })
				return {
					status: "success",
					message: "Devora SDK connection test successful",
					timestamp: Date.now(),
					orgId: req.orgId,
					keyId: req.keyId,
					sdk: info,
					security: {
						hmacValidated: true,
						timestampValid: true,
					},
				}
			},
		})

		// Health endpoint
		routes.push({
			path: DEVORA_ENDPOINTS.HEALTH,
			method: "GET",
			isBuiltIn: true,
			handler: async (): Promise<HealthCheckResponse> => {
				const endpointMap: Record<string, string> = {}
				for (const route of routes) {
					endpointMap[route.path] = route.method
				}

				return {
					status: "healthy",
					sdk: info,
					stats: config.collectStats ? { ...stats } : undefined,
					endpoints: endpointMap,
				}
			},
		})
	}

	/**
	 * Register a new endpoint handler
	 */
	function register<TRequest extends DevoraRequest, TResponse>(
		path: string,
		handler: RouteHandler<TRequest, TResponse>,
		options?: RegisterOptions
	): SDKRoute<TRequest, TResponse> {
		// Check if path is a predefined endpoint
		const isPredefined = Object.values(DEVORA_ENDPOINTS).includes(path as DevoraEndpointPath)

		// Check if it's a protected endpoint
		if (PROTECTED_ENDPOINTS.includes(path as DevoraEndpointPath)) {
			throw new Error(
				`Cannot override protected endpoint: ${path}. This endpoint is built into the SDK.`
			)
		}

		// Auto-detect method if using predefined endpoints
		let method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH" = options?.method ?? "GET"
		if (isPredefined) {
			method = ENDPOINT_METHODS[path as DevoraEndpointPath] as typeof method
			logger.log(`Using predefined endpoint: ${path}`, { method })
		} else if (config.debug) {
			logger.warn(
				`Using custom endpoint path: ${path}. Consider using DEVORA_ENDPOINTS constants for consistency.`
			)
		}

		// Check for duplicates (including built-in routes not caught by PROTECTED_ENDPOINTS)
		const existingRoute = routes.find((r) => r.path === path)
		if (existingRoute) {
			const routeType = existingRoute.isBuiltIn ? "built-in" : "custom"
			throw new Error(`Endpoint already registered: ${path} (existing route is ${routeType})`)
		}

		const route: SDKRoute<TRequest, TResponse> = {
			path,
			method,
			handler,
			isBuiltIn: false,
		}

		routes.push(route as SDKRoute)

		logger.log(`Registered endpoint: ${method} ${path}`, {
			predefined: isPredefined,
		})

		return route
	}

	/**
	 * Get all registered routes
	 */
	function getRoutes(): SDKRoute[] {
		return [...routes]
	}

	/**
	 * Get statistics
	 */
	function getStats(): SDKStats {
		return {
			...stats,
			requestsByEndpoint: { ...stats.requestsByEndpoint },
		}
	}

	/**
	 * Record a processed request for statistics.
	 */
	function recordRequest(
		endpoint: string,
		outcome: "success" | "failure" | "security_error"
	): void {
		stats.totalRequests++
		if (config.collectStats) {
			stats.requestsByEndpoint[endpoint] = (stats.requestsByEndpoint[endpoint] ?? 0) + 1
		}
		if (outcome === "success") {
			stats.successfulRequests++
			return
		}
		stats.failedRequests++
		if (outcome === "security_error") {
			stats.securityErrors++
		}
	}

	/**
	 * Verify a signed request from Devora (signature v3) over its exact bytes,
	 * then claim its request id from Devora. Only a request whose signature
	 * verified is ever claimed, so unauthenticated traffic cannot burn request ids.
	 */
	async function verifyRequest(
		request: SignedRequestInput,
		options: { timestampTolerance?: number } = {}
	): Promise<ValidationResult> {
		const tolerance =
			options.timestampTolerance ?? config.timestampTolerance ?? SDK_DEFAULTS.TIMESTAMP_TOLERANCE
		if (!isValidTimestampTolerance(tolerance))
			return { valid: false, error: "Invalid timestamp tolerance", errorCode: "TIMESTAMP_EXPIRED" }

		const parsed = parseSignatureHeaders(request.headers)
		if (!parsed.valid) return { valid: false, error: parsed.error, errorCode: parsed.errorCode }
		const headers = parsed.headers
		if (headers.keyId !== config.apiKey || headers.orgId !== config.orgId)
			return {
				valid: false,
				error: "Request key or organization does not match SDK configuration",
				errorCode: "ORG_MISMATCH",
			}

		const sentAt = Number(headers.sentAt)
		const timestamp = validateTimestamp(sentAt, tolerance)
		if (!timestamp.valid)
			return { valid: false, error: timestamp.error, errorCode: "TIMESTAMP_EXPIRED" }

		if (
			!SIGNED_HEADER_PATTERNS.method.test(request.method) ||
			!isValidSignedPath(request.path) ||
			!isValidSignedQuery(request.query)
		)
			return { valid: false, error: "Invalid request target", errorCode: "INVALID_REQUEST_TARGET" }
		if (!hasIdentityContentEncoding(request.headers))
			return {
				valid: false,
				error: "Content-Encoding is not supported",
				errorCode: "UNSUPPORTED_CONTENT_ENCODING",
			}

		const canonical = buildCanonicalString({
			direction: SIGNING.DEVORA_TO_CUSTOMER,
			keyId: headers.keyId,
			orgId: headers.orgId,
			sentAt: headers.sentAt,
			requestId: headers.requestId,
			method: request.method,
			path: request.path,
			query: request.query,
			bodySha256: sha256Hex(request.body),
		})
		if (!signatureMatches(config.secretKey, canonical, headers.signature))
			return { valid: false, error: "Invalid HMAC signature", errorCode: "INVALID_SIGNATURE" }

		// A start request names the session it starts; Devora lets it be claimed
		// only while that session is still starting. (A start request without a
		// valid session ID is claimed plainly; the handler then refuses it.)
		let sessionId: string | undefined
		if (request.method === "POST" && START_REQUEST_PATH.test(request.path)) {
			const parsed = parseVerifiedJsonBody(
				request.body,
				getSingleHeader(request.headers, "content-type")
			)
			const value = parsed.ok ? (parsed.value as { sessionId?: unknown } | undefined) : undefined
			if (typeof value?.sessionId === "string" && value.sessionId && value.sessionId.length <= 128)
				sessionId = value.sessionId
		}
		const claim = await claimRequest(headers.requestId, headers.sentAt, sessionId)
		if (claim) return claim

		return {
			valid: true,
			orgId: headers.orgId,
			keyId: headers.keyId,
			timestamp: sentAt,
			requestId: headers.requestId,
		}
	}

	/**
	 * Claim a verified request id from Devora. Returns null when this is the
	 * first claim, otherwise the rejection. Anything but a clear answer fails
	 * closed: the handler never runs without a successful claim.
	 */
	async function claimRequest(
		requestId: string,
		sentAt: string,
		sessionId: string | undefined
	): Promise<ValidationResult | null> {
		let result: { status: number; ok: boolean; json: Record<string, unknown> | null }
		try {
			result = await signedDevoraPost(
				REQUEST_CLAIM.ENDPOINT,
				sessionId === undefined ? { requestId, sentAt } : { requestId, sentAt, sessionId },
				REQUEST_CLAIM.TIMEOUT_MS
			)
		} catch {
			result = { status: 0, ok: false, json: null }
		}
		const { status, ok, json } = result
		if (ok && json?.success === true) {
			const data = json.data as { claimed?: unknown } | undefined
			if (data?.claimed === true) return null
		}
		if (status === 409) {
			const code = json?.errorCode
			if (code === "REPLAYED_REQUEST")
				return {
					valid: false,
					error: "Request was already processed",
					errorCode: "REPLAYED_REQUEST",
				}
			if (code === "SESSION_NOT_STARTABLE")
				return {
					valid: false,
					error: "Devora is no longer starting this session",
					errorCode: "SESSION_NOT_STARTABLE",
				}
			if (code === "TIMESTAMP_EXPIRED")
				return { valid: false, error: "Request is too old", errorCode: "TIMESTAMP_EXPIRED" }
		}
		logger.warn("Devora request claim unavailable", { status })
		return {
			valid: false,
			error: "Devora could not confirm this request is new",
			errorCode: "REQUEST_CLAIM_UNAVAILABLE",
		}
	}

	/** POST a signed JSON body to a Devora SDK endpoint and read a bounded JSON object reply. */
	async function signedDevoraPost(
		path: string,
		payload: Record<string, unknown>,
		timeoutMs?: number
	): Promise<{ status: number; ok: boolean; json: Record<string, unknown> | null }> {
		const body = new TextEncoder().encode(JSON.stringify(payload))
		const response = await controlPlaneFetch(
			`${apiUrl}${path}`,
			{
				method: "POST",
				headers: signRequest({
					secretKey: config.secretKey,
					direction: SIGNING.CUSTOMER_TO_DEVORA,
					keyId: config.apiKey,
					orgId: config.orgId,
					method: "POST",
					path,
					body,
				}),
				body,
			},
			timeoutMs
		)
		const json = await readBoundedJsonObject(response).catch(() => null)
		return { status: response.status, ok: response.ok, json }
	}

	/**
	 * Check whether a Devora session is still live (server-side liveness check).
	 * Returns null if Devora is unreachable so callers can choose fail-open/closed.
	 */
	async function getSessionStatus(sessionId: string): Promise<SessionStatusResult | null> {
		if (!sessionId || sessionId.length > 128) return null
		try {
			const { status, ok, json } = await signedDevoraPost("/api/sdk/session-status", { sessionId })
			if (status === 404) return { valid: false, error: "SESSION_NOT_FOUND" } as SessionStatusResult
			// 429/5xx/other failures are "unavailable", never a liveness verdict.
			if (!ok || !json || json.success !== true) return null
			const data = json.data
			if (
				!data ||
				typeof data !== "object" ||
				typeof (data as { valid?: unknown }).valid !== "boolean"
			)
				return null
			return data as SessionStatusResult
		} catch {
			return null
		}
	}

	/**
	 * Server-to-server: mint a one-time browser resume code (signed, customer-to-devora).
	 */
	async function createBrowserResumeCode(input: {
		sessionId: string
		tabRef: string
		origin: string
	}): Promise<BrowserResumeCode | { error: string; status?: number } | null> {
		if (!input.sessionId || input.sessionId.length > 128) return { error: "INVALID_SESSION" }
		if (!BROWSER_SESSION_BRIDGE.TAB_REF_PATTERN.test(input.tabRef))
			return { error: "INVALID_TAB_REF" }
		try {
			const { status, ok, json } = await signedDevoraPost(
				BROWSER_SESSION_BRIDGE.RESUME_CODE_ENDPOINT,
				{
					sessionId: input.sessionId,
					tabRef: input.tabRef,
					origin: input.origin,
				}
			)
			const data = json?.data as Partial<BrowserResumeCode> | undefined
			if (ok && json?.success === true && typeof data?.code === "string")
				return data as BrowserResumeCode
			if (status >= 500 || status === 429) return null
			return {
				error: typeof json?.error === "string" ? json.error : "RESUME_REJECTED",
				status,
			}
		} catch {
			return null
		}
	}

	// Return SDK instance
	const sdk: DevoraBackendSDK = {
		config: Object.freeze({ ...config, secretKey: "[REDACTED]" }) as NodeBackendSDKConfig,
		info,
		ready,
		register,
		getRoutes,
		getStats,
		getScopeConfig: scopeConfig.getConfig,
		isPolicyLoaded: () => scopeConfig.getCachedConfig() !== null,
		getCachedScopeConfig: scopeConfig.getCachedConfig,
		refreshScopeConfig: scopeConfig.refresh,
		getSessionStatus,
		createBrowserResumeCode,
		destroy: scopeConfig.stop,
		_recordRequest: recordRequest,
		verifyRequest,
	}

	logger.log("Devora SDK initialized", {
		version: SDK_VERSION,
		debug: config.debug,
	})

	return sdk
}
