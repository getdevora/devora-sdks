/**
 * Devora Express.js Adapter
 *
 * @example
 * ```typescript
 * import express from "express";
 * import { devoraSDK, DEVORA_ENDPOINTS } from "@devorash/node";
 * import { expressAdapter } from "@devorash/express";
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
 * const app = express();
 * // Mount Devora BEFORE any application-wide body parser: signatures cover the
 * // exact body bytes, and a body another parser consumed is rejected.
 * app.use("/devora", expressAdapter(sdk));
 * app.use(express.json());
 * ```
 *
 * @packageDocumentation
 * @module @devorash/express
 */

import type { Router, Request, Response } from "express"
import { createRequire } from "node:module"
import { assertTimestampTolerance, getErrorStatusCode, routeRelativePath } from "@devorash/core"
import {
	processRequest,
	DEFAULT_MAX_BODY_SIZE,
	stripMountPath,
	type DevoraBackendSDK,
	type AdapterRequest,
} from "@devorash/node"

// Create require for ESM compatibility
const require = createRequire(import.meta.url)

/**
 * Express adapter options
 */
export interface ExpressAdapterOptions {
	/** Override timestamp tolerance (in seconds) */
	timestampTolerance?: number
	/** Maximum allowed body size in bytes (default: 1MB) */
	maxBodySize?: number
	/**
	 * Mount path prefix when using expressMiddleware (e.g. "/devora").
	 * Required for correct HMAC path verification when middleware is not mounted at SDK root paths.
	 */
	mountPath?: string
}

const INTERNAL_ERROR_RESPONSE = {
	success: false,
	error: "An unexpected error occurred",
	errorCode: "INTERNAL_ERROR",
} as const

/**
 * Read the exact request body bytes with a size bound. Signatures cover these
 * bytes, so the adapter must see the unparsed stream: mount Devora before any
 * application-wide body parser. A body that another parser already consumed
 * fails closed with a configuration error instead of being trusted.
 */
function rawBodyReader(maxBodySize = DEFAULT_MAX_BODY_SIZE) {
	if (!Number.isSafeInteger(maxBodySize) || maxBodySize <= 0)
		throw new Error("Invalid body size limit")
	const parse = require("express").raw({ type: () => true, limit: maxBodySize, inflate: false })
	return (request: Request, response: Response): Promise<Uint8Array | null> =>
		new Promise((resolve) => {
			if (request.body !== undefined || (request as Request & { _body?: boolean })._body) {
				response.status(500).json({
					success: false,
					errorCode: "DEVORA_BODY_ALREADY_PARSED",
					error: "Mount the Devora adapter before application-wide body parsers",
				})
				resolve(null)
				return
			}
			const declared = request.headers["content-length"]
			if (
				declared !== undefined &&
				(!/^\d+$/.test(String(declared)) || Number(declared) > maxBodySize)
			) {
				response
					.status(413)
					.json({ success: false, errorCode: "BODY_TOO_LARGE", error: "Request body too large" })
				resolve(null)
				return
			}
			parse(request, response, (error?: { status?: number }) => {
				if (error) {
					const status = error.status === 413 ? 413 : error.status === 415 ? 415 : 400
					response.status(status).json({
						success: false,
						errorCode: status === 413 ? "BODY_TOO_LARGE" : "INVALID_BODY",
						error: status === 413 ? "Request body too large" : "Invalid request body",
					})
					resolve(null)
				} else {
					resolve(Buffer.isBuffer(request.body) ? new Uint8Array(request.body) : new Uint8Array())
				}
			})
		})
}

/** Small JSON reader for the browser-session bridge (not a signed route). */
function bridgeBodyParser(maxBodySize: number) {
	const parse = require("express").json({ limit: maxBodySize, inflate: false, strict: false })
	return (request: Request, response: Response): Promise<boolean> =>
		new Promise((resolve) => {
			parse(request, response, (error?: { status?: number }) => {
				if (error) {
					const status = error.status === 413 ? 413 : 400
					response.status(status).json({
						success: false,
						errorCode: status === 413 ? "BODY_TOO_LARGE" : "INVALID_BODY",
						error: status === 413 ? "Request body too large" : "Invalid request body",
					})
					resolve(false)
				} else resolve(true)
			})
		})
}

/** The raw target Devora sent: path (still encoded) and everything after the first `?`. */
function splitTarget(target: string): { path: string; query: string } {
	const queryStart = target.indexOf("?")
	return queryStart === -1
		? { path: target, query: "" }
		: { path: target.slice(0, queryStart), query: target.slice(queryStart + 1) }
}

/**
 * Create an Express Router for Devora SDK routes
 *
 * Note: The SDK instance already contains the secret key, so you don't need
 * to pass it again. The adapter uses sdk.verifySignature() internally.
 */
export function expressAdapter(sdk: DevoraBackendSDK, options?: ExpressAdapterOptions): Router {
	assertTimestampTolerance(options?.timestampTolerance)
	// Dynamic import to support both CommonJS and ESM
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const express = require("express")
	const router: Router = express.Router()
	const readBody = rawBodyReader(options?.maxBodySize)

	// Get all routes from SDK (includes built-in + custom)
	const allRoutes = sdk.getRoutes()

	// Register routes
	for (const route of allRoutes) {
		const method = route.method.toLowerCase() as "get" | "post" | "put" | "delete" | "patch"

		router[method](route.path, async (req: Request, res: Response) => {
			// Custom signature headers do not trigger HTTP Authorization cache rules.
			res.setHeader("Cache-Control", "private, no-store")
			try {
				const body = await readBody(req, res)
				if (!body) return
				// Inside the mounted router req.url is mount-relative and still encoded.
				const path = routeRelativePath(splitTarget(req.url).path, route.path)
				if (path === null) {
					res.status(404).json({ success: false, errorCode: "NOT_FOUND" })
					return
				}
				const adapterRequest: AdapterRequest = {
					method: req.method,
					path,
					query: splitTarget(req.originalUrl).query,
					body,
					headers: req.headers as Record<string, string | string[] | undefined>,
				}

				// Process request (uses SDK's verifySignature internally)
				const response = await processRequest(sdk, allRoutes, adapterRequest, {
					timestampTolerance: options?.timestampTolerance,
					maxBodySize: options?.maxBodySize,
				})

				// Send response
				const statusCode = response.success ? 200 : getErrorStatusCode(response.errorCode)
				res.status(statusCode).json(response)
			} catch {
				res.status(500).json(INTERNAL_ERROR_RESPONSE)
			}
		})
	}

	return router
}

/**
 * Create Express middleware for Devora SDK
 */
export function expressMiddleware(sdk: DevoraBackendSDK, options?: ExpressAdapterOptions) {
	assertTimestampTolerance(options?.timestampTolerance)
	const allRoutes = sdk.getRoutes()
	const readBody = rawBodyReader(options?.maxBodySize)

	return async (req: Request, res: Response) => {
		res.setHeader("Cache-Control", "private, no-store")
		try {
			const body = await readBody(req, res)
			if (!body) return
			const rawPath = splitTarget(req.url).path
			const adapterRequest: AdapterRequest = {
				method: req.method,
				path: options?.mountPath ? stripMountPath(rawPath, options.mountPath) : rawPath,
				query: splitTarget(req.originalUrl).query,
				body,
				headers: req.headers as Record<string, string | string[] | undefined>,
			}

			// Process request (uses SDK's verifySignature internally)
			const response = await processRequest(sdk, allRoutes, adapterRequest, {
				timestampTolerance: options?.timestampTolerance,
				maxBodySize: options?.maxBodySize,
			})

			// Send response
			const statusCode = response.success ? 200 : getErrorStatusCode(response.errorCode)
			res.status(statusCode).json(response)
		} catch {
			res.status(500).json(INTERNAL_ERROR_RESPONSE)
		}
	}
}

// Re-export from node SDK for convenience
export { DEVORA_ENDPOINTS, SDK_VERSION } from "@devorash/node"
export type { DevoraBackendSDK } from "@devorash/node"

// Re-export impersonation middleware for convenience
export { createImpersonationGuard, validateImpersonationContext } from "@devorash/node"
export type {
	ImpersonationContext,
	ImpersonationContextResult,
	ImpersonationGuardOptions,
} from "@devorash/node"

// ============================================================================
// Browser-session bridge
// ============================================================================

import { resolveBrowserSession } from "@devorash/node"
import type { ImpersonationContextResult } from "@devorash/node"

export interface ExpressBrowserSessionOptions<TRequest extends Request = Request> {
	sdk: DevoraBackendSDK
	/** Same trusted extractor the scope guard uses (may be async). */
	getImpersonationContext: (request: TRequest) => ImpersonationContextResult
	/**
	 * Exact browser origins allowed to call the bridge. Required for resume
	 * codes: a request whose Origin is not listed is rejected with 403.
	 */
	allowedOrigins?: string[]
}

/**
 * Express handler for `POST /api/devora/browser-session`. Mount it behind your
 * normal authentication middleware; the SDK's browser side calls it on every
 * page load to restore an impersonation session in a new tab.
 */
export function createBrowserSessionHandler<TRequest extends Request = Request>(
	options: ExpressBrowserSessionOptions<TRequest>
) {
	const parse = bridgeBodyParser(4096)
	return async (request: TRequest, response: Response): Promise<void> => {
		try {
			if (request.body === undefined && !(await parse(request, response))) return
			const tabRef = (request.body as { tabRef?: unknown } | undefined)?.tabRef
			const origin = request.headers.origin ?? null
			const result = await resolveBrowserSession(options.sdk, {
				context: await options.getImpersonationContext(request),
				tabRef,
				origin,
				allowedOrigins: options.allowedOrigins,
			})
			response.setHeader("Cache-Control", "private, no-store")
			response.status(result.status).json(result.body)
		} catch {
			// Express 4 does not forward rejected async handlers automatically.
			response.setHeader("Cache-Control", "private, no-store")
			response.status(500).json(INTERNAL_ERROR_RESPONSE)
		}
	}
}
