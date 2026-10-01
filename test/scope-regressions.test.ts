import { afterEach, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { isAmbiguousRequestPath, isWriteMethod, matchEndpointPattern } from "../core/dist/index.js"
import { createImpersonationGuard, devoraSDK } from "../node/dist/index.js"
import cases from "./scope-policy-cases.json"
import { TEST_KEYS, signTestRequest, signedAdapterRequest } from "./support/signing"
import { fakeDevora } from "./support/devora-claims"

const require = createRequire(import.meta.url)
const express = require(
	require.resolve("express", { paths: [fileURLToPath(new URL("../express/", import.meta.url))] })
)
const realFetch = globalThis.fetch
const context = {
	isImpersonation: true,
	actor: { id: "a" },
	subject: { id: "b" },
	sessionId: "audit",
	scope: "read",
	authMethod: "devora_impersonation",
	authorizationSource: "standard",
	recordingAllowed: false,
	expiresAt: Date.now() + 60000,
}
afterEach(() => {
	globalThis.fetch = realFetch
})

test("scope matching agrees with the cross-language corpus", () => {
	for (const item of cases)
		expect(matchEndpointPattern(item.pattern, item.path, item.options)).toBe(item.matches)
	expect(matchEndpointPattern("/**/**/**/**/**/never", "/" + Array(150).fill("x").join("/"))).toBe(
		false
	)
})

test("ambiguous paths and non-safe methods cannot silently broaden read scope", () => {
	for (const path of [
		"/a%2fb",
		"/a%5cb",
		"/a/../b",
		"/a/%2e%2e/b",
		"/a//b",
		"/a%252fb",
		"/a%zz",
		"/a\\b",
		// Double-encoded space and raw control characters still move boundaries.
		"/a%2520b",
		"/a%09b",
		"/a%0ab",
	])
		expect(isAmbiguousRequestPath(path)).toBe(true)
	// Ordinary route-parameter content must not be blocked under impersonation.
	for (const path of [
		"/api/reports",
		"/api/caf%C3%A9",
		"/api/file-one",
		"/files/my%20doc",
		"/files/100%25",
		"/search/a%2Bb",
	])
		expect(isAmbiguousRequestPath(path)).toBe(false)
	for (const method of ["COPY", "MOVE", "MKCOL", "PROPPATCH", "CUSTOM", "TRACE", "POST"])
		expect(isWriteMethod(method)).toBe(true)
	for (const method of ["GET", "HEAD", "OPTIONS"]) expect(isWriteMethod(method)).toBe(false)
})

test("real Express routes cannot bypass policy using encoded separators, case or unknown verbs", async () => {
	const app = express()
	app.set("case sensitive routing", true)
	app.set("strict routing", true)
	const guard = createImpersonationGuard({
		sdk: {
			getSessionStatus: async () => ({ valid: true }),
			getScopeConfig: async () => ({
				blockedEndpoints: [{ method: "*", pattern: "/api/files/*" }],
				safeReadEndpoints: [{ method: "POST", pattern: "/api/reports" }],
			}),
		} as any,
		getImpersonationContext: () => context as any,
		showWarnings: false,
	})
	app.use(guard)
	app.all(
		[
			"/api/files/:id",
			"/api/reports",
			"/api/REPORTS",
			"/api/reports/",
			"/api/%72eports",
			"/public",
		],
		(_req: any, res: any) => res.json({ reached: true })
	)
	const server = app.listen(0, "127.0.0.1")
	await new Promise<void>((resolve) => server.once("listening", resolve))
	try {
		const base = `http://127.0.0.1:${server.address().port}`
		for (const [method, path, status] of [
			["GET", "/api/files/abc", 403],
			["GET", "/api/files/a%2Fb", 403],
			["POST", "/api/reports", 200],
			["POST", "/api/REPORTS", 403],
			["POST", "/api/reports/", 403],
			["POST", "/api/%72eports", 403],
			["COPY", "/public", 403],
			["GET", "/public", 200],
		] as const)
			expect((await realFetch(base + path, { method })).status).toBe(status)
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((err: Error | undefined) => (err ? reject(err) : resolve()))
		)
	}
})

const policyResponse = () =>
	Response.json({
		success: true,
		data: {
			version: 1,
			safeReadEndpoints: [],
			blockedEndpoints: [],
			cachedUntil: Date.now() + 60000,
		},
	})

test("the exported Node verifier rejects stale and future MACs before claiming the request", async () => {
	globalThis.fetch = fakeDevora(async () => policyResponse()).fetch
	const sdk = devoraSDK({ ...TEST_KEYS })
	try {
		await sdk.ready
		for (const delta of [-3600, 3600]) {
			const requestId = crypto.randomUUID()
			const stale = signedAdapterRequest({
				method: "GET",
				path: "/test",
				sentAt: String(Math.floor(Date.now() / 1000) + delta),
				requestId,
			})
			expect((await sdk.verifyRequest(stale)).errorCode).toBe("TIMESTAMP_EXPIRED")
			// The id was not claimed: the same id still verifies once when fresh.
			const fresh = signedAdapterRequest({ method: "GET", path: "/test", requestId })
			expect((await sdk.verifyRequest(fresh)).valid).toBe(true)
		}
	} finally {
		sdk.destroy()
	}
})

test("Node liveness requests carry a valid customer-to-devora v3 signature", async () => {
	let checked = false
	globalThis.fetch = async (url, init) => {
		if (String(url).endsWith("/session-status")) {
			const headers = new Headers(init?.headers)
			const body = init?.body as Uint8Array
			// Independently re-sign the exact wire bytes and compare.
			const expected = signTestRequest({
				direction: "customer-to-devora",
				method: "POST",
				path: "/api/sdk/session-status",
				body,
				sentAt: headers.get("x-devora-sent-at")!,
				requestId: headers.get("x-devora-request-id")!,
			})
			expect(headers.get("x-devora-signature")).toBe(expected.headers["x-devora-signature"])
			expect(headers.get("x-devora-signature-version")).toBe("3")
			expect((init as RequestInit).redirect).toBe("manual")
			checked = true
			return Response.json({ success: true, data: { valid: true } })
		}
		return policyResponse()
	}
	const sdk = devoraSDK({ ...TEST_KEYS })
	try {
		await sdk.ready
		expect(await sdk.getSessionStatus("test_session")).toMatchObject({ valid: true })
		expect(checked).toBe(true)
	} finally {
		sdk.destroy()
	}
})

test("native Fastify delimiter aliases cannot bypass a blocked endpoint", async () => {
	const fastify = require(
		require.resolve("fastify", {
			paths: [fileURLToPath(new URL("../fastify/", import.meta.url))],
		})
	)
	const { createImpersonationGuard: fastifyGuard } = await import("../fastify/src/index")
	for (const useSemicolonDelimiter of [false, true]) {
		const app = fastify({ routerOptions: { useSemicolonDelimiter } })
		let reached = 0
		app.addHook(
			"preHandler",
			fastifyGuard({
				sdk: {
					getSessionStatus: async () => ({ valid: true }),
					getScopeConfig: async () => ({
						blockedEndpoints: [{ method: "*", pattern: "/api/admin" }],
						safeReadEndpoints: [],
					}),
				} as any,
				getImpersonationContext: () => ({ ...context, scope: "write" }) as any,
				showWarnings: false,
			})
		)
		app.get("/api/admin", async () => {
			reached++
			return { allowed: true }
		})
		try {
			for (const url of [
				"/api/admin",
				"/api/admin;ignored",
				"/api/admin%3bignored",
				"/api/admin%253bignored",
			]) {
				const response = await app.inject({ method: "GET", url })
				expect([403, 404]).toContain(response.statusCode)
			}
			expect(reached).toBe(0)
		} finally {
			await app.close()
		}
	}
	for (const path of ["/api/admin;ignored", "/api/admin%3Bignored"])
		expect(isAmbiguousRequestPath(path)).toBe(true)
})
