import { readBoundedBody, readBoundedBytes, routeRelativePath, BodyReadError } from "@devorash/core"
/**
 * Devora Hono Adapter
 *
 * @example
 * ```typescript
 * import { Hono } from "hono";
 * import { devoraSDK, DEVORA_ENDPOINTS } from "@devorash/node";
 * import { honoAdapter } from "@devorash/hono";
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
 * const app = new Hono();
 * app.route("/devora", honoAdapter(sdk));
 * ```
 *
 * @packageDocumentation
 * @module @devorash/hono
 */

import { Hono } from "hono"
import type { Context, MiddlewareHandler } from "hono"
import { assertTimestampTolerance, getErrorStatusCode } from "@devorash/core"
import {
	createImpersonationGuard as createNodeImpersonationGuard,
	processRequest,
	stripMountPath,
	DEFAULT_MAX_BODY_SIZE,
	type AdapterRequest,
	type DevoraBackendSDK,
	type ImpersonationContext,
	type ImpersonationContextResult,
	type MiddlewareRequest,
	type MiddlewareResponse,
} from "@devorash/node"

/**
 * Hono adapter options
 */
export interface HonoAdapterOptions {
	/** Override timestamp tolerance (in seconds) */
	timestampTolerance?: number
	/** Maximum allowed body size in bytes (default: 1MB) */
	maxBodySize?: number
	/**
	 * Mount path prefix when using honoMiddleware (e.g. "/devora").
	 * Required for correct HMAC path verification when middleware is not mounted at SDK root paths.
	 */
	mountPath?: string
}

const INTERNAL_ERROR_RESPONSE = {
	success: false,
	error: "An unexpected error occurred",
	errorCode: "INTERNAL_ERROR",
} as const

export interface HonoImpersonationGuardOptions<TContext extends Context = Context> {
	/** Initialized Devora SDK used to load the centrally managed policy. */
	sdk: DevoraBackendSDK
	/** Extract trusted impersonation context from the authenticated request (may be async; null for ordinary traffic). */
	getImpersonationContext: (context: TContext) => ImpersonationContextResult
	/** Optional audit callback for blocked requests. */
	onBlocked?: (context: TContext, impersonation: ImpersonationContext) => void
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
		context: TContext,
		impersonation: ImpersonationContext
	) => boolean | Promise<boolean>
}

interface HonoGuardRequest<TContext extends Context> extends MiddlewareRequest {
	context: TContext
}

/** Create native Hono middleware for Devora scope enforcement. */
export function createImpersonationGuard<TContext extends Context = Context>(
	options: HonoImpersonationGuardOptions<TContext>
): MiddlewareHandler {
	const guard = createNodeImpersonationGuard<HonoGuardRequest<TContext>>({
		sdk: options.sdk,
		getImpersonationContext: ({ context }) => options.getImpersonationContext(context),
		onBlocked: options.onBlocked
			? ({ context }, impersonation) => options.onBlocked?.(context, impersonation)
			: undefined,
		blockedResponse: options.blockedResponse,
		showWarnings: options.showWarnings,
		enforceLiveness: options.enforceLiveness,
		livenessCacheTtlMs: options.livenessCacheTtlMs,
		onLivenessUnavailable: options.onLivenessUnavailable,
		bridgePath: options.bridgePath,
		isImpersonationAllowed: options.isImpersonationAllowed
			? ({ context }, impersonation) => options.isImpersonationAllowed!(context, impersonation)
			: undefined,
	})

	return async (context, next) => {
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

		// `context.req.url` is the ABSOLUTE URL in Hono (unlike Express/Fastify,
		// where `req.url`/`request.url` are already path-relative). Its full,
		// still-encoded pathname is what Hono routes on, including any basePath.
		const requestUrl = new URL(context.req.url)
		const target = `${requestUrl.pathname}${requestUrl.search}`
		await guard(
			{
				method: context.req.method,
				path: requestUrl.pathname,
				url: target,
				originalUrl: target,
				routedUrls: [target],
				headers: Object.fromEntries(context.req.raw.headers),
				context: context as TContext,
			},
			response,
			async () => {
				allowed = true
				await next()
			}
		)

		if (!allowed) return context.json(responseBody, statusCode as 401 | 403 | 503)
	}
}

/**
 * Create a Hono app for Devora SDK routes
 *
 * Note: The SDK instance already contains the secret key, so you don't need
 * to pass it again. The adapter uses sdk.verifySignature() internally.
 *
 * The adapter is designed to be mounted at a specific path prefix:
 * ```typescript
 * app.route("/devora", honoAdapter(sdk));
 * ```
 *
 * Routes are relative to the mount point, so `/test` becomes `/devora/test`.
 */
export function honoAdapter(sdk: DevoraBackendSDK, options?: HonoAdapterOptions): Hono {
	assertTimestampTolerance(options?.timestampTolerance)
	const app = new Hono()
	app.use("*", async (context, next) => {
		context.header("Cache-Control", "private, no-store")
		await next()
	})

	// Get all routes from SDK (includes built-in + custom)
	const allRoutes = sdk.getRoutes()

	// Register routes
	for (const route of allRoutes) {
		app.on(route.method, route.path, async (c: Context) => {
			try {
				// The exact body bytes; c.req.raw is read directly because Hono's body
				// cache may re-stringify JSON parsed by earlier middleware.
				const body = await readBoundedBytes(
					c.req.raw,
					options?.maxBodySize ?? DEFAULT_MAX_BODY_SIZE
				)

				// Signed path: the last segments matching this route, still encoded.
				// url.pathname (unlike c.req.path) never decodes dynamic segments.
				const url = new URL(c.req.url)
				const path = routeRelativePath(url.pathname, route.path)
				if (path === null) return c.json({ success: false, errorCode: "NOT_FOUND" }, 404)

				const adapterRequest: AdapterRequest = {
					method: c.req.method,
					path,
					query: url.search.slice(1),
					body,
					headers: Object.fromEntries(c.req.raw.headers),
				}

				// Process request (uses SDK's verifySignature internally)
				const response = await processRequest(sdk, allRoutes, adapterRequest, {
					timestampTolerance: options?.timestampTolerance,
					maxBodySize: options?.maxBodySize,
				})

				// Send response with proper status code
				const statusCode = response.success ? 200 : getErrorStatusCode(response.errorCode)
				return c.json(response, statusCode as 200 | 400 | 401 | 403 | 404 | 413 | 415 | 500 | 503)
			} catch (error) {
				if (error instanceof BodyReadError)
					return c.json(
						{ success: false, error: error.message, errorCode: error.code },
						error.status
					)
				return c.json(INTERNAL_ERROR_RESPONSE, 500)
			}
		})
	}

	return app
}

/**
 * Create Hono middleware for Devora SDK
 */
export function honoMiddleware(sdk: DevoraBackendSDK, options?: HonoAdapterOptions) {
	assertTimestampTolerance(options?.timestampTolerance)
	const allRoutes = sdk.getRoutes()

	return async (c: Context) => {
		c.header("Cache-Control", "private, no-store")
		try {
			const body = await readBoundedBytes(c.req.raw, options?.maxBodySize ?? DEFAULT_MAX_BODY_SIZE)

			// url.pathname (unlike c.req.path) never decodes dynamic segments,
			// matching what Devora signed.
			const url = new URL(c.req.url)
			const path = options?.mountPath
				? stripMountPath(url.pathname, options.mountPath)
				: url.pathname
			const adapterRequest: AdapterRequest = {
				method: c.req.method,
				path,
				query: url.search.slice(1),
				body,
				headers: Object.fromEntries(c.req.raw.headers),
			}

			// Process request (uses SDK's verifySignature internally)
			const response = await processRequest(sdk, allRoutes, adapterRequest, {
				timestampTolerance: options?.timestampTolerance,
				maxBodySize: options?.maxBodySize,
			})

			// Send response with proper status code
			const statusCode = response.success ? 200 : getErrorStatusCode(response.errorCode)
			return c.json(response, statusCode as 200 | 400 | 401 | 403 | 404 | 413 | 415 | 500 | 503)
		} catch (error) {
			if (error instanceof BodyReadError)
				return c.json({ success: false, error: error.message, errorCode: error.code }, error.status)
			return c.json(INTERNAL_ERROR_RESPONSE, 500)
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

export interface HonoBrowserSessionOptions<TContext extends Context = Context> {
	sdk: DevoraBackendSDK
	getImpersonationContext: (context: TContext) => ImpersonationContextResult
	allowedOrigins?: string[]
}

/** Hono handler for `POST /api/devora/browser-session` (mount behind your auth gate). */
export function createBrowserSessionHandler<TContext extends Context = Context>(
	options: HonoBrowserSessionOptions<TContext>
) {
	return async (context: TContext) => {
		let body: { tabRef?: unknown }
		try {
			body = JSON.parse(await readBoundedBody(context.req.raw, 4_096))
		} catch (error) {
			return context.json(
				{
					success: false,
					error: error instanceof BodyReadError ? error.message : "Invalid JSON body",
				},
				error instanceof BodyReadError ? error.status : 400
			)
		}
		if (!body || typeof body !== "object")
			return context.json({ success: false, error: "Invalid JSON body" }, 400)
		const result = await resolveBrowserSession(options.sdk, {
			context: await options.getImpersonationContext(context),
			tabRef: body.tabRef,
			origin: context.req.header("origin") ?? null,
			allowedOrigins: options.allowedOrigins,
		})
		context.header("Cache-Control", "private, no-store")
		return context.json(result.body, result.status as 200)
	}
}
