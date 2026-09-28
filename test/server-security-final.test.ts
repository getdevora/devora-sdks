/** Local final-pass regressions. Uses in-process fixtures, never a listening server. */
import { afterEach, expect, test } from "bun:test"
import { cleanImpersonationParams } from "../core/src/utils/index"
import { createImpersonationGuard } from "../node/src/middleware"
import { devoraSDK } from "../node/src/sdk"
import { createScopeConfigFetcher } from "../node/src/scope-config"
import { createDevoraRouteHandlers } from "../nextjs/src/index"
import { TEST_KEYS, signedAdapterRequest } from "./support/signing"

const realFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = realFetch
})

test("semantic authorization accepts only a boolean true", async () => {
	for (const verdict of [false, "false", 1, {}, [], null, undefined, true]) {
		let effects = 0
		const guard = createImpersonationGuard({
			sdk: { getScopeConfig: async () => ({ blockedEndpoints: [], safeReadEndpoints: [] }) } as any,
			enforceLiveness: false,
			showWarnings: false,
			getImpersonationContext: () => ({
				isImpersonation: true,
				scope: "write",
				sessionId: "session",
				expiresAt: Date.now() + 60_000,
				actor: { id: "agent" },
				subject: { id: "user" },
				authMethod: "devora_impersonation",
				authorizationSource: "standard",
				recordingAllowed: false,
			}),
			isImpersonationAllowed: (async () => verdict) as any,
		})
		const response = {
			status() {
				return response
			},
			json() {},
		}
		await guard({ method: "DELETE", path: "/account" }, response, () => {
			effects++
		})
		expect(effects).toBe(verdict === true ? 1 : 0)
	}
})

test("a replay store cannot authorize with a truthy nonboolean result", async () => {
	globalThis.fetch = (async () =>
		Response.json({
			success: true,
			data: {
				version: 1,
				safeReadEndpoints: [],
				blockedEndpoints: [],
				cachedUntil: Date.now() + 60_000,
			},
		})) as typeof fetch
	for (const verdict of ["false", 1, {}, [], null, undefined]) {
		const sdk = devoraSDK({ ...TEST_KEYS, replayStore: { consume: (async () => verdict) as any } })
		try {
			const result = await sdk.verifyRequest(signedAdapterRequest({ method: "GET", path: "/test" }))
			expect(result.valid).toBe(false)
			expect(result.errorCode).toBe("REPLAY_STORE_UNAVAILABLE")
		} finally {
			sdk.destroy()
		}
	}
})

test("public URL cleanup removes all copies of exchange codes", () => {
	for (const url of [
		"https://customer.example/#devora_exchange=a&devora_exchange=b&view=1",
		"/#/home?devora_exchange=a&devora_exchange=b&view=1",
		"/home?devora_exchange=a&devora_exchange=b#devora_exchange=c&devora_exchange=d",
	])
		expect(cleanImpersonationParams(url)).not.toContain("devora_exchange")
	expect(cleanImpersonationParams("/#/home?devora_exchange=a&devora_exchange=b&view=1")).toBe(
		"/#/home?view=1"
	)
})

test("signed Next GET responses are private and cannot be cached", async () => {
	const sdk = {
		getRoutes: () => [
			{ path: "/test", method: "GET", handler: () => ({ email: "private@example.test" }) },
		],
		verifyRequest: async () => ({ valid: true, keyId: "key", orgId: "org" }),
	} as any
	const handler = createDevoraRouteHandlers(sdk)
	const response = await handler.GET(new Request("https://customer.example/devora/test"), {
		params: Promise.resolve({ devora: ["test"] }),
	})
	expect(response.status).toBe(200)
	expect(response.headers.get("Cache-Control")).toBe("private, no-store")
})

test("malformed scope policies cannot be mistaken for an empty allow-all policy", async () => {
	const valid = {
		version: 0,
		safeReadEndpoints: [],
		blockedEndpoints: [],
		cachedUntil: Date.now() + 60_000,
	}
	const missing = Object.keys(valid).map((field) => {
		const partial = { ...valid } as Record<string, unknown>
		delete partial[field]
		return partial
	})
	for (const data of [
		[],
		{},
		...missing,
		{ ...valid, version: -1 },
		{ ...valid, version: Number.MAX_SAFE_INTEGER + 1 },
		{ ...valid, cachedUntil: 0 },
		{ ...valid, cachedUntil: "123" },
		{ ...valid, blockedEndpoints: null },
		{ ...valid, blockedEndpoints: [{ method: "GET\n", pattern: "/export" }] },
	]) {
		globalThis.fetch = (async () => Response.json({ success: true, data })) as typeof fetch
		const policy = createScopeConfigFetcher({ apiKey: TEST_KEYS.apiKey, signRequest: () => ({}) })
		try {
			expect(await policy.getConfig()).toBeNull()
		} finally {
			policy.stop()
		}
	}
	globalThis.fetch = (async () => Response.json({ success: true, data: valid })) as typeof fetch
	const policy = createScopeConfigFetcher({ apiKey: TEST_KEYS.apiKey, signRequest: () => ({}) })
	try {
		expect((await policy.getConfig())?.version).toBe(0)
	} finally {
		policy.stop()
	}
})
