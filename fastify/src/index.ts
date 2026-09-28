/**
 * Devora Fastify Adapter
 *
 * @example
 * ```typescript
 * import Fastify from "fastify";
 * import { devoraSDK, DEVORA_ENDPOINTS } from "@devorash/node";
 * import { fastifyAdapter } from "@devorash/fastify";
 *
 * const sdk = devoraSDK({
 *   apiKey: process.env.DEVORA_API_KEY!,
 *   secretKey: process.env.DEVORA_SECRET_KEY!,
 *   orgId: "your-org-id",
 * });
 *
 * // Register your handlers
 * sdk.register(DEVORA_ENDPOINTS.USER_SEARCH, async (req) => {
 *   return { users: await searchUsers(req.query.term) };
 * });
 *
 * const server = Fastify();
 * server.register(fastifyAdapter(sdk), { prefix: "/devora" });
 * ```
 *
 * @packageDocumentation
 * @module @devorash/fastify
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify"
import { assertTimestampTolerance, getErrorStatusCode, routeRelativePath } from "@devorash/core"
import {
	createImpersonationGuard as createNodeImpersonationGuard,
	processRequest,
	DEFAULT_MAX_BODY_SIZE,
	type AdapterRequest,
	type DevoraBackendSDK,
	type ImpersonationContext,
	type ImpersonationContextResult,
	type MiddlewareRequest,
	type MiddlewareResponse,
} from "@devorash/node"

/**
 * Fastify adapter options
 */
export interface FastifyAdapterOptions {
	/** Override timestamp tolerance (in seconds) */
	timestampTolerance?: number
	/** Maximum allowed body size in bytes (default: 1MB) */
	maxBodySize?: number
}

const INTERNAL_ERROR_RESPONSE = {
	success: false,
	error: "An unexpected error occurred",
	errorCode: "INTERNAL_ERROR",
} as const

export interface FastifyImpersonationGuardOptions<
	TRequest extends FastifyRequest = FastifyRequest,
> {
	/** Initialized Devora SDK used to load the centrally managed policy. */
	sdk: DevoraBackendSDK
	/** Extract trusted impersonation context from the authenticated request (may be async; null for ordinary traffic). */
	getImpersonationContext: (request: TRequest) => ImpersonationContextResult
	/** Optional audit callback for blocked requests. */
	onBlocked?: (request: TRequest, context: ImpersonationContext) => void
	/** Customize the blocked response. */
	blockedResponse?: { status?: number; message?: string; errorCode?: string }
	/** Emit development warnings for blocked requests. */
	showWarnings?: boolean
	/** Enforce server-side session liveness (rejects sessions terminated/revoked before expiry). */
	enforceLiveness?: boolean
	/** Cache window for liveness results in milliseconds (default 5000). */
	livenessCacheTtlMs?: number
	/** Behavior when Devora is unreachable for a liveness check: "deny" (default, fail closed) or "allow" (local development only). */
	onLivenessUnavailable?: "allow" | "deny"
	/** Path of your mounted browser-session bridge; POSTs to exactly this path are allowed in read scope. Off by default. */
	bridgePath?: string
	/** Semantic authorization hook for application-specific high-risk actions; false blocks the impersonated request. */
	isImpersonationAllowed?: (
		request: TRequest,
		context: ImpersonationContext
	) => boolean | Promise<boolean>
}

interface FastifyGuardRequest<TRequest extends FastifyRequest> extends MiddlewareRequest {
	request: TRequest
}

/**
 * Create a native Fastify preHandler for Devora scope enforcement.
 *
 * Register it as a `preHandler` hook so it runs after routing: it judges both
 * the original request target and the URL Fastify routed on (after
 * `rewriteUrl`), including any plugin prefix.
 */
export function createImpersonationGuard<TRequest extends FastifyRequest = FastifyRequest>(
	options: FastifyImpersonationGuardOptions<TRequest>
): (request: TRequest, reply: FastifyReply, done: (error?: Error) => void) => void {
	const guard = createNodeImpersonationGuard<FastifyGuardRequest<TRequest>>({
		sdk: options.sdk,
		getImpersonationContext: ({ request }) => options.getImpersonationContext(request),
		onBlocked: options.onBlocked
			? ({ request }, context) => options.onBlocked?.(request, context)
			: undefined,
		blockedResponse: options.blockedResponse,
		showWarnings: options.showWarnings,
		enforceLiveness: options.enforceLiveness,
		livenessCacheTtlMs: options.livenessCacheTtlMs,
		onLivenessUnavailable: options.onLivenessUnavailable,
		bridgePath: options.bridgePath,
		isImpersonationAllowed: options.isImpersonationAllowed
			? ({ request }, impersonation) => options.isImpersonationAllowed!(request, impersonation)
			: undefined,
	})

	return (request, reply, done) => {
		// The original wire target (before rewriteUrl or semicolon handling) and
		// the URL Fastify actually routed on are both judged.
		const originalUrl = request.originalUrl ?? request.raw.url ?? request.url
		let statusCode = 403
		let responseBody: unknown
		let allowed = false
		const response: MiddlewareResponse = {
			status(code) {
				statusCode = code
				return response
			},
			json(body) {
				responseBody = body
			},
		}

		void guard(
			{
				method: request.method,
				path: request.url,
				url: request.url,
				originalUrl,
				routedUrls: [request.url],
				headers: request.headers as Record<string, string | string[] | undefined>,
				request,
			},
			response,
			() => {
				allowed = true
			}
		).then(
			() => {
				if (allowed) done()
				else reply.status(statusCode).send(responseBody)
			},
			(error: unknown) => done(error instanceof Error ? error : new Error(String(error)))
		)
	}
}

/**
 * Create a Fastify plugin for Devora SDK routes
 *
 * Note: The SDK instance already contains the secret key, so you don't need
 * to pass it again. The adapter uses sdk.verifySignature() internally.
 */
export function fastifyAdapter(
	sdk: DevoraBackendSDK,
	options?: FastifyAdapterOptions
): FastifyPluginAsync {
	assertTimestampTolerance(options?.timestampTolerance)
	const maxBodySize = options?.maxBodySize ?? DEFAULT_MAX_BODY_SIZE
	if (!Number.isSafeInteger(maxBodySize) || maxBodySize <= 0)
		throw new Error("Invalid body size limit")
	return async (fastify: FastifyInstance) => {
		// Applies before native parsing too, including errors and signed GETs.
		fastify.addHook("onRequest", async (_request, reply) => {
			reply.header("Cache-Control", "private, no-store")
		})
		// Enforce at the native parser, before request.body is allocated. Preserve
		// a stricter application limit rather than relaxing it for SDK routes.
		const bodyLimit = Math.min(maxBodySize, fastify.initialConfig.bodyLimit ?? maxBodySize)
		// Signatures cover the exact body bytes. This plugin is encapsulated, so
		// replacing the parsers here does not affect the application's routes.
		fastify.removeAllContentTypeParsers()
		fastify.addContentTypeParser("*", { parseAs: "buffer", bodyLimit }, (_request, body, done) =>
			done(null, body)
		)
		// Get all routes from SDK (includes built-in + custom)
		const allRoutes = sdk.getRoutes()

		// Register routes
		for (const route of allRoutes) {
			fastify.route({
				method: route.method,
				url: route.path,
				bodyLimit,
				handler: async (request: FastifyRequest, reply: FastifyReply) => {
					try {
						// The wire target Devora signed: before rewriteUrl, still encoded.
						const target = request.originalUrl ?? request.raw.url ?? request.url
						const queryStart = target.indexOf("?")
						const rawPath = queryStart === -1 ? target : target.slice(0, queryStart)
						const path = routeRelativePath(rawPath, route.path)
						if (path === null)
							return reply.status(404).send({ success: false, errorCode: "NOT_FOUND" })

						const adapterRequest: AdapterRequest = {
							method: request.method,
							path,
							query: queryStart === -1 ? "" : target.slice(queryStart + 1),
							body: Buffer.isBuffer(request.body) ? new Uint8Array(request.body) : new Uint8Array(),
							headers: request.headers as Record<string, string | string[] | undefined>,
						}

						const response = await processRequest(sdk, allRoutes, adapterRequest, {
							timestampTolerance: options?.timestampTolerance,
							maxBodySize: options?.maxBodySize,
						})

						// Send response
						const statusCode = response.success ? 200 : getErrorStatusCode(response.errorCode)
						return reply.status(statusCode).send(response)
					} catch {
						return reply.status(500).send(INTERNAL_ERROR_RESPONSE)
					}
				},
			})
		}
	}
}

// Re-export from node SDK for convenience
export { DEVORA_ENDPOINTS, SDK_VERSION } from "@devorash/node"
export type { DevoraBackendSDK } from "@devorash/node"

// Re-export validation utility for convenience
export { validateImpersonationContext } from "@devorash/node"
export type { ImpersonationContext } from "@devorash/node"

// ============================================================================
// Browser-session bridge
// ============================================================================

import { resolveBrowserSession } from "@devorash/node"

export interface FastifyBrowserSessionOptions<TRequest extends FastifyRequest = FastifyRequest> {
	sdk: DevoraBackendSDK
	getImpersonationContext: (request: TRequest) => ImpersonationContextResult
	allowedOrigins?: string[]
}

/** Fastify handler for `POST /api/devora/browser-session` (register behind your auth preHandler). */
export function createBrowserSessionHandler<TRequest extends FastifyRequest = FastifyRequest>(
	options: FastifyBrowserSessionOptions<TRequest>
) {
	return async (request: TRequest, reply: FastifyReply) => {
		const tabRef = (request.body as { tabRef?: unknown } | undefined)?.tabRef
		const result = await resolveBrowserSession(options.sdk, {
			context: await options.getImpersonationContext(request),
			tabRef,
			origin: (request.headers.origin as string | undefined) ?? null,
			allowedOrigins: options.allowedOrigins,
		})
		reply.header("Cache-Control", "private, no-store")
		return reply.status(result.status).send(result.body)
	}
}
