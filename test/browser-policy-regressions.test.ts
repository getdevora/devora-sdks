/** No network or services: check the browser guard before its fetch delegate. */
import { afterEach, expect, test } from "bun:test"
import { patchNetworkLayer, restoreNetworkLayer } from "../browser/src/scope-enforcer"
import { createDevoraSDK } from "../browser/src/sdk"

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
const originalXHR = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest")
const originalFetch = globalThis.fetch
afterEach(() => {
	restoreNetworkLayer()
	globalThis.fetch = originalFetch
	for (const [name, descriptor] of [
		["window", originalWindow],
		["XMLHttpRequest", originalXHR],
	] as const) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor)
		else Reflect.deleteProperty(globalThis, name)
	}
})

test("an incomplete control-plane policy cannot restore a write-scope browser session", async () => {
	const valid = {
		version: 1,
		safeReadEndpoints: [],
		blockedEndpoints: [],
		cachedUntil: Date.now() + 60_000,
	}
	for (const scopePolicy of [
		{},
		[],
		{ ...valid, blockedEndpoints: undefined },
		{ ...valid, version: undefined },
		{ ...valid, cachedUntil: undefined },
		{ ...valid, blockedEndpoints: [{ method: "GET\n", pattern: "/admin/**" }] },
	]) {
		globalThis.fetch = async () =>
			Response.json({
				success: true,
				data: {
					sessionId: "session",
					scope: "write",
					expiresAt: Date.now() + 60_000,
					devoraSessionToken: "synthetic",
					recordingEnabled: false,
					activityEnabled: false,
					scopePolicy,
				},
			})
		const sdk = createDevoraSDK()
		try {
			await sdk.init({
				apiKey: `pk_client_live_${"a".repeat(32)}`,
				autoDetect: false,
				sessionBridge: { restore: async () => ({ status: "resume", code: "r".repeat(43) }) },
			})
			expect(sdk.isImpersonating()).toBe(false)
		} finally {
			await sdk.destroy()
		}
	}
})

test("browser deny rules cover HEAD and safe-read exceptions require decoded path agreement", async () => {
	let effects = 0
	const win = {
		location: new URL("https://customer.example/"),
		fetch: async () => {
			effects++
			return Response.json({ success: true })
		},
	}
	Object.defineProperty(globalThis, "window", { configurable: true, value: win })
	Object.defineProperty(globalThis, "XMLHttpRequest", {
		configurable: true,
		value: class {
			open() {}
			send() {}
		},
	})
	patchNetworkLayer({
		enabled: true,
		apiUrl: "https://api.example/",
		scope: "read",
		showWarnings: false,
		blockedEndpoints: [{ method: "GET", pattern: "/admin/**" }],
		safeReadEndpoints: [{ method: "POST", pattern: "/api/%72eports" }],
	})
	const guarded = win.fetch as typeof fetch
	expect((await guarded("/admin/users", { method: "HEAD" })).status).toBe(403)
	expect((await guarded("/api/%72eports", { method: "POST" })).status).toBe(403)
	expect(effects).toBe(0)
	expect((await guarded("/api/reports", { method: "GET" })).status).toBe(200)
	expect(effects).toBe(1)
})

test("policy caches written by pre-0.1.0 SDKs are removed on init", async () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
	const store = new Map<string, string>([
		["devora_scope_config:https://api.example:pk_client_live_old", '{"blockedEndpoints":[]}'],
		["devora_scope_config:https://api.example:pk_client_live_older", "{}"],
		["access_token", "customer-app-value"],
	])
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			get length() {
				return store.size
			},
			key: (index: number) => [...store.keys()][index] ?? null,
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
			removeItem: (key: string) => void store.delete(key),
		},
	})
	const sdk = createDevoraSDK()
	try {
		await sdk.init({ apiKey: `pk_client_live_${"a".repeat(32)}`, autoDetect: false })
		// Only the SDK's own legacy entries go; the host app's storage is untouched.
		expect([...store.keys()]).toEqual(["access_token"])
	} finally {
		await sdk.destroy()
		if (original) Object.defineProperty(globalThis, "localStorage", original)
		else Reflect.deleteProperty(globalThis, "localStorage")
	}
})
