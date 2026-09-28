/**
 * Devora Next.js adapter (App Router — server).
 *
 * Mount the Devora endpoints in a catch-all App Router route and run them on the
 * Node.js runtime (Devora verifies requests with HMAC, which needs `node:crypto`):
 *
 * @example
 * ```ts
 * // app/api/devora/[...devora]/route.ts
 * import { devora } from "@/lib/devora";
 * import { createDevoraRouteHandlers } from "@devorash/nextjs";
 *
 * export const runtime = "nodejs";
 * export const { GET, POST, PUT, PATCH, DELETE } = createDevoraRouteHandlers(devora);
 * ```
 *
 * The client provider/hooks/components live in `@devorash/nextjs/client`.
 *
 * @packageDocumentation
 * @module @devorash/nextjs
 */

import {
	assertTimestampTolerance,
	getErrorStatusCode,
	readBoundedBody,
	readBoundedBytes,
	routeRelativePath,
	BodyReadError,
} from "@devorash/core"
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
 * Shape of the second argument Next.js passes to an App Router Route Handler.
 * `params` is a promise to match Next.js 15's generated route-type validation; the runtime
 * `await` also accepts the plain object Next 14 passes.
 */
interface RouteHandlerContext {
	params: Promise<Record<string, string | string[]>>
}

type NextRouteHandler = (request: Request, context: RouteHandlerContext) => Promise<Response>

export interface DevoraRouteHandlerOptions {
	/** Override timestamp tolerance (in seconds). */
	timestampTolerance?: number
	/** Maximum allowed body size in bytes (default: 1MB). */
	maxBodySize?: number
	/**
	 * Mount prefix to strip from the request pathname (e.g. "/api/devora"), used only
	 * when the route is NOT a catch-all. Leave unset for the recommended `[...devora]`
	 * setup, where the Devora path is read from the route params.
	 */
	basePath?: string
}

const INTERNAL_ERROR_RESPONSE = {
	success: false,
	error: "An unexpected error occurred",
	errorCode: "INTERNAL_ERROR",
} as const

const PRIVATE_RESPONSE_HEADERS = { "Cache-Control": "private, no-store" } as const

/**
 * Create Next.js App Router route handlers for the Devora SDK endpoints.
 *
 * Returns method handlers to re-export from a catch-all `route.ts`. Today Devora's
 * built-in endpoints use `GET`, `POST`, and `DELETE`; `PUT` and `PATCH` are exposed
 * as the same signed handler so Next.js does not reject future Devora endpoints
 * before the SDK can validate and answer.
 */
export function createDevoraRouteHandlers(
	sdk: DevoraBackendSDK,
	options?: DevoraRouteHandlerOptions
): {
	GET: NextRouteHandler
	POST: NextRouteHandler
	PUT: NextRouteHandler
	PATCH: NextRouteHandler
	DELETE: NextRouteHandler
} {
	assertTimestampTolerance(options?.timestampTolerance)
	const routes = sdk.getRoutes()

	const handle: NextRouteHandler = async (request, context) => {
		try {
			const url = new URL(request.url)
			const body = await readBoundedBytes(request, options?.maxBodySize ?? DEFAULT_MAX_BODY_SIZE)

			const adapterRequest: AdapterRequest = {
				method: request.method,
				path: await resolveDevoraPath(url, context, options?.basePath),
				query: url.search.slice(1),
				body,
				headers: Object.fromEntries(request.headers),
			}

			const response = await processRequest(sdk, routes, adapterRequest, {
				timestampTolerance: options?.timestampTolerance,
				maxBodySize: options?.maxBodySize,
			})
			const status = response.success ? 200 : getErrorStatusCode(response.errorCode)
			return Response.json(response, { status, headers: PRIVATE_RESPONSE_HEADERS })
		} catch (error) {
			if (error instanceof BodyReadError)
				return Response.json(
					{ success: false, error: error.message, errorCode: error.code },
					{ status: error.status, headers: PRIVATE_RESPONSE_HEADERS }
				)
			return Response.json(INTERNAL_ERROR_RESPONSE, {
				status: 500,
				headers: PRIVATE_RESPONSE_HEADERS,
			})
		}
	}

	return { GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle }
}

export interface NextImpersonationGuardOptions {
	/** Initialized Devora SDK used to load the centrally managed policy. */
	sdk: DevoraBackendSDK
	/** Extract trusted impersonation context from the authenticated request (may be async; null for ordinary traffic). */
	getImpersonationContext: (request: Request) => ImpersonationContextResult
	/** Optional audit callback for blocked requests. */
	onBlocked?: (request: Request, context: ImpersonationContext) => void
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
		request: Request,
		context: ImpersonationContext
	) => boolean | Promise<boolean>
}

interface NextGuardRequest extends MiddlewareRequest {
	request: Request
}

/**
 * Build the framework-agnostic guard and a function that judges one request,
 * returning the blocked Response or `null` when the request may proceed.
 */
function createRequestJudge(
	options: NextImpersonationGuardOptions
): (request: Request) => Promise<Response | null> {
	const guard = createNodeImpersonationGuard<NextGuardRequest>({
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

	return async (request) => {
		let statusCode = 403
		let responseBody: unknown
		let allowed = false
		const res: MiddlewareResponse = {
			status(code) {
				statusCode = code
				return res
			},
			json(body) {
				responseBody = body
			},
		}

		// request.url carries the full client-visible path (basePath and locale
		// included). NextRequest also exposes nextUrl with those removed; judge it
		// as a deny-only alias so rules written either way can block.
		const url = new URL(request.url)
		const target = `${url.pathname}${url.search}`
		const nextUrl = (request as Request & { nextUrl?: { pathname?: unknown } }).nextUrl
		const aliasUrls =
			typeof nextUrl?.pathname === "string" && nextUrl.pathname !== url.pathname
				? [nextUrl.pathname]
				: []
		await guard(
			{
				method: request.method,
				path: url.pathname,
				url: target,
				originalUrl: target,
				routedUrls: [target],
				aliasUrls,
				headers: Object.fromEntries(request.headers),
				request,
			},
			res,
			async () => {
				allowed = true
			}
		)
		return allowed ? null : Response.json(responseBody, { status: statusCode })
	}
}

/**
 * Wrap a Next.js App Router route handler with Devora scope enforcement.
 *
 * Blocks write or blacklisted requests in read-only sessions, and terminated or
 * unverifiable sessions (liveness is enforced by default), before your handler runs.
 * This protects only the wrapped route handler. Use {@link createDevoraMiddleware}
 * in `middleware.ts` to also cover Server Actions, pages and Pages Router API routes.
 *
 * @example
 * ```ts
 * export const POST = withDevoraGuard(handler, {
 *   sdk: devora,
 *   getImpersonationContext: (request) => readDevoraContext(request),
 * });
 * ```
 */
export function withDevoraGuard<TContext = unknown>(
	handler: (request: Request, context: TContext) => Response | Promise<Response>,
	options: NextImpersonationGuardOptions
): (request: Request, context: TContext) => Promise<Response> {
	const judge = createRequestJudge(options)
	return async (request, context) => (await judge(request)) ?? handler(request, context)
}

/**
 * Devora scope enforcement for Next.js `middleware.ts`.
 *
 * Middleware runs before every matched request, so this also covers Server
 * Actions (a `POST` to a page URL with a `Next-Action` header, which read scope
 * treats as a write unless allowlisted), page requests and Pages Router API
 * routes, none of which {@link withDevoraGuard} can wrap. The SDK verifies
 * requests with `node:crypto`, so the middleware must use the Node.js runtime.
 *
 * Next.js applies `next.config` rewrites after middleware. If a rewrite maps an
 * alias onto a protected route, block the alias too (or also wrap the
 * destination route handler with {@link withDevoraGuard}).
 *
 * @example
 * ```ts
 * // middleware.ts
 * import { createDevoraMiddleware } from "@devorash/nextjs"
 *
 * const devoraGuard = createDevoraMiddleware({ sdk: devora, getImpersonationContext })
 *
 * export async function middleware(request: NextRequest) {
 *   return (await devoraGuard(request)) ?? NextResponse.next()
 * }
 * export const config = { runtime: "nodejs", matcher: ["/((?!_next/static|_next/image).*)"] }
 * ```
 *
 * @returns A function resolving to the blocked `Response`, or `null` to continue.
 */
export function createDevoraMiddleware(
	options: NextImpersonationGuardOptions
): (request: Request) => Promise<Response | null> {
	return createRequestJudge(options)
}

async function resolveDevoraPath(
	url: URL,
	context: RouteHandlerContext | undefined,
	basePath: string | undefined
): Promise<string> {
	// Preferred: reconstruct the Devora path from the catch-all route params (name-agnostic).
	const params = context?.params ? await context.params : undefined
	if (params) {
		const segments = Object.values(params).find((value): value is string[] => Array.isArray(value))
		if (segments && segments.length > 0) {
			// Next.js decodes catch-all segments, but Devora signs the still-encoded
			// wire path: take the same number of raw segments from url.pathname.
			// Empty segments are kept so the signature check rejects them.
			return routeRelativePath(url.pathname, "/x".repeat(segments.length)) ?? url.pathname
		}
	}

	// Fallback: strip an explicit mount prefix from the pathname.
	if (basePath && url.pathname.startsWith(basePath)) {
		const stripped = url.pathname.slice(basePath.length)
		return stripped.startsWith("/") ? stripped : `/${stripped}`
	}
	return url.pathname
}

// Re-export from the node SDK for convenience: @devorash/nextjs is the only
// package a Next.js app needs to install.
export {
	devoraSDK,
	DEVORA_ENDPOINTS,
	SDK_VERSION,
	validateImpersonationContext,
} from "@devorash/node"
export type {
	DevoraBackendSDK,
	ImpersonationContext,
	ImpersonationContextResult,
	SessionStatusResult,
} from "@devorash/node"

// ============================================================================
// Browser-session bridge
// ============================================================================

import { resolveBrowserSession } from "@devorash/node"

export interface NextBrowserSessionOptions {
	sdk: DevoraBackendSDK
	/** Reads the trusted context from the signed cookie/session of this request (may be async). */
	getImpersonationContext: (request: Request) => ImpersonationContextResult
	allowedOrigins?: string[]
}

/** App Router `POST` handler for `app/api/devora/browser-session/route.ts`. */
export function createBrowserSessionRouteHandler(
	options: NextBrowserSessionOptions
): (request: Request) => Promise<Response> {
	return async (request: Request) => {
		let body: { tabRef?: unknown }
		try {
			body = JSON.parse(await readBoundedBody(request, 4_096))
		} catch (error) {
			return Response.json(
				{
					success: false,
					error: error instanceof BodyReadError ? error.message : "Invalid JSON body",
				},
				{ status: error instanceof BodyReadError ? error.status : 400 }
			)
		}
		if (!body || typeof body !== "object")
			return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
		const result = await resolveBrowserSession(options.sdk, {
			context: await options.getImpersonationContext(request),
			tabRef: body.tabRef,
			origin: request.headers.get("origin"),
			allowedOrigins: options.allowedOrigins,
		})
		return Response.json(result.body, {
			status: result.status,
			headers: { "Cache-Control": "private, no-store" },
		})
	}
}
