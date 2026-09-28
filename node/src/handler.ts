/**
 * Generic request handler for all framework adapters
 * @module @devorash/node
 */

import {
	DEVORA_ENDPOINTS,
	matchPath,
	createSuccessResponse,
	createErrorResponse,
	getSingleHeader,
	parseVerifiedJsonBody,
	parseVerifiedQuery,
	type DevoraRequest,
	type DevoraResponse,
	type DevoraImpersonationContext,
	type ImpersonationScope,
	type ImpersonationUserInfo,
} from "@devorash/core"

import type { DevoraBackendSDK, SDKRoute } from "./types.js"

/**
 * A request exactly as received, for signature verification. Nothing here may
 * be re-serialized: the signature covers these bytes.
 */
export interface AdapterRequest {
	method: string
	/** Path relative to the SDK mount, still percent-encoded exactly as received. */
	path: string
	/** Raw query after the first `?`, exactly as received ("" when absent). */
	query: string
	/** Exact request body bytes ("" body = empty array). */
	body: Uint8Array
	headers: Record<string, string | string[] | undefined>
}

/**
 * Options for processRequest
 */
export interface ProcessRequestOptions {
	/** Override timestamp tolerance (defaults to SDK config) */
	timestampTolerance?: number
	/** Maximum allowed body size in bytes (default: 1MB) */
	maxBodySize?: number
}

/**
 * Default maximum body size (1MB)
 * Framework/ingress parsers must apply this limit before buffering the body.
 */
export const DEFAULT_MAX_BODY_SIZE = 1024 * 1024 // 1MB

/**
 * Process an incoming request through the SDK.
 *
 * The signature is verified before any route lookup, so unauthenticated
 * callers learn nothing about registered routes. Only verified bytes are
 * parsed, with one parser for every framework.
 */
export async function processRequest(
	sdk: DevoraBackendSDK,
	routes: SDKRoute[],
	request: AdapterRequest,
	options: ProcessRequestOptions = {}
): Promise<DevoraResponse> {
	const { method, path, query, body, headers } = request
	// path is attacker-controlled and unbounded before a route has matched; every
	// caller here that hasn't matched a route omits the second argument.
	const record = (outcome: "success" | "failure" | "security_error", endpoint = "UNMATCHED") => {
		sdk._recordRequest?.(endpoint, outcome)
	}

	const maxBodySize = options.maxBodySize ?? DEFAULT_MAX_BODY_SIZE
	if (!(body instanceof Uint8Array)) {
		record("failure")
		return createErrorResponse("Adapter must supply the raw request body bytes", "INVALID_BODY")
	}
	if (body.byteLength > maxBodySize) {
		record("failure")
		return createErrorResponse("Request body too large", "BODY_TOO_LARGE")
	}
	if ((method === "GET" || method === "HEAD") && body.byteLength > 0) {
		record("failure")
		return createErrorResponse("GET and HEAD requests must not have a body", "INVALID_BODY")
	}

	// Signature v3: headers, key/org, timestamp, target grammar, body digest,
	// direction and single-use request id, over the exact wire bytes.
	const verification = await sdk.verifyRequest(
		{ method, path, query, body, headers },
		{ timestampTolerance: options.timestampTolerance }
	)
	if (!verification.valid) {
		record("security_error")
		return createErrorResponse(
			verification.error ?? "Security validation failed",
			verification.errorCode ?? "INVALID_SIGNATURE"
		)
	}

	const route = findMatchingRoute(routes, method, path)
	if (!route) {
		record("failure")
		return createErrorResponse("No handler found for this request", "NOT_FOUND")
	}
	const { params } = matchPath(route.path, path)

	const parsedBody = parseVerifiedJsonBody(body, getSingleHeader(headers, "content-type"))
	if (!parsedBody.ok) {
		record("failure", route.path)
		return createErrorResponse(parsedBody.error, "INVALID_BODY")
	}
	const parsedQuery = parseVerifiedQuery(query)

	const devoraContextResult = buildDevoraContext(route, path, parsedBody.value, params)
	if (!devoraContextResult.valid) {
		record("security_error", route.path)
		return createErrorResponse(
			devoraContextResult.error ?? "Invalid impersonation context",
			"INVALID_IMPERSONATION_CONTEXT"
		)
	}

	// Devora never sends SECURITY_HEADERS.SESSION_ID and it isn't part of the signed
	// payload, so trusting it here would let an unsigned header pick the session id.
	const requestSessionId =
		devoraContextResult.context?.sessionId ?? getSessionIdFromRoute(route, params, parsedBody.value)

	// Build Devora request object
	const devoraRequest: DevoraRequest = {
		method,
		path,
		params,
		query: parsedQuery,
		body: parsedBody.value,
		headers,
		orgId: verification.orgId ?? "",
		keyId: verification.keyId ?? "",
		sessionId: requestSessionId,
		devoraContext: devoraContextResult.context,
	}

	// Execute handler
	try {
		const result = await route.handler(devoraRequest)
		record("success", route.path)
		return createSuccessResponse(result)
	} catch (error) {
		if (sdk.config.debug) console.error("[Devora] Customer handler failed", error)
		record("failure", route.path)
		return createErrorResponse("Customer handler failed", "HANDLER_ERROR")
	}
}

/**
 * Find a matching route for the given method and path
 */
function findMatchingRoute(routes: SDKRoute[], method: string, path: string): SDKRoute | undefined {
	for (const route of routes) {
		if (route.method !== method.toUpperCase()) {
			continue
		}

		const { match } = matchPath(route.path, path)
		if (match) {
			return route
		}
	}

	return undefined
}

/**
 * Strip a literal mount prefix (e.g. "/devora" or "/api/devora") from a raw
 * request path. Used by middleware-style adapters where the framework does not
 * strip the mount point. Devora signs the path relative to the mount.
 */
export function stripMountPath(path: string, mountPath: string): string {
	const normalizedMount = `/${mountPath}`.replace(/\/+/g, "/").replace(/\/$/, "")
	if (!normalizedMount || normalizedMount === "/") return path
	if (path === normalizedMount) return "/"
	if (path.startsWith(`${normalizedMount}/`)) return path.slice(normalizedMount.length)
	return path
}

function buildDevoraContext(
	route: SDKRoute,
	path: string,
	body: unknown,
	params: Record<string, string>
): { valid: true; context?: DevoraImpersonationContext } | { valid: false; error: string } {
	if (route.path !== DEVORA_ENDPOINTS.IMPERSONATE) {
		return { valid: true }
	}

	const bodyObject = asRecord(body)
	if (!bodyObject) {
		return { valid: false, error: "Impersonation request body must be an object" }
	}

	const sessionId = readString(bodyObject.sessionId)
	if (!sessionId || sessionId.length > 128) {
		return { valid: false, error: "Impersonation request is missing a valid session ID" }
	}

	const scope = bodyObject.scope
	if (scope !== "read" && scope !== "write") {
		return { valid: false, error: "Impersonation request is missing a valid scope" }
	}

	const expiresAt = readFiniteNumber(bodyObject.expiresAt)
	if (!expiresAt || expiresAt <= Date.now()) {
		return { valid: false, error: "Impersonation request is expired or missing expiration" }
	}

	let targetUser = readUserInfo(bodyObject.targetUser, params.id)
	if (!targetUser) {
		const matchedParams = matchPath(route.path, path).params
		targetUser = readUserInfo(bodyObject.targetUser, matchedParams.id)
		if (!targetUser) {
			return { valid: false, error: "Impersonation request is missing target user context" }
		}
	}

	const impersonator = readUserInfo(bodyObject.impersonator)
	if (!impersonator) {
		return { valid: false, error: "Impersonation request is missing impersonator context" }
	}
	if (bodyObject.authMethod !== "devora_impersonation") {
		return { valid: false, error: "Impersonation request has an invalid authentication method" }
	}
	if (
		bodyObject.authorizationSource !== "standard" &&
		bodyObject.authorizationSource !== "self_approved" &&
		bodyObject.authorizationSource !== "self_approved_read" &&
		bodyObject.authorizationSource !== "break_glass"
	) {
		return { valid: false, error: "Impersonation request is missing authorization context" }
	}
	if (typeof bodyObject.recordingAllowed !== "boolean") {
		return { valid: false, error: "Impersonation request is missing recording authorization" }
	}

	return {
		valid: true,
		context: {
			isImpersonation: true,
			sessionId,
			scope: scope as ImpersonationScope,
			expiresAt,
			impersonator,
			targetUser,
			actor: { id: impersonator.id },
			subject: { id: targetUser.id },
			authMethod: "devora_impersonation",
			authorizationSource: bodyObject.authorizationSource,
			recordingAllowed: bodyObject.recordingAllowed,
		},
	}
}

function getSessionIdFromRoute(
	route: SDKRoute,
	params: Record<string, string>,
	body: unknown
): string | undefined {
	if (route.path === DEVORA_ENDPOINTS.TERMINATE && params.id) {
		return params.id
	}
	const bodyObject = asRecord(body)
	return readString(bodyObject?.sessionId)
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null
	return value as Record<string, unknown>
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined
}

function readFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value)
		if (Number.isFinite(parsed)) return parsed
	}
	return undefined
}

function readUserInfo(value: unknown, fallbackId?: string): ImpersonationUserInfo | null {
	const source = asRecord(value)
	const id = readString(source?.id) ?? fallbackId
	if (!id) return null
	return {
		id,
		email: readString(source?.email),
		name: readString(source?.name),
	}
}

/**
 * Create a generic handler function for framework adapters
 */
export function createGenericHandler(
	sdk: DevoraBackendSDK,
	routes: SDKRoute[],
	options?: ProcessRequestOptions
) {
	return async (request: AdapterRequest): Promise<DevoraResponse> => {
		return processRequest(sdk, routes, request, options)
	}
}
