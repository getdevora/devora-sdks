import { afterEach, beforeEach, expect, test } from "bun:test"
import {
	DEVORA_ENDPOINTS,
	SECURITY_HEADERS,
	createImpersonationGuard,
	createScopeConfigFetcher,
	validateImpersonationContext,
	resolveEnvironment,
	resolveBrowserSession,
	BROWSER_SESSION_BRIDGE,
	devoraSDK,
	processRequest,
	stripMountPath,
	type DevoraBackendSDK,
} from "../node/dist/index.js"
import { createDevoraSDK, TabCoordinator } from "../browser/dist/index.js"
// Internal privacy behavior is exercised separately from the supported public API.
import {
	resolveMasking,
	buildRrwebPrivacyOptions,
	describeElement,
} from "../browser/dist/masking.js"
import {
	getErrorStatusCode,
	validateApiKeyFormat,
	type DevoraImpersonationContext,
} from "../core/dist/index.js"
import {
	createDevoraRouteHandlers,
	devoraSDK as createNextBackendSDK,
	withDevoraGuard,
} from "../nextjs/dist/index.js"
import { createImpersonationGuard as createHonoImpersonationGuard } from "../hono/dist/index.js"
import { Hono } from "hono"
import { controlPlaneFetch } from "../node/dist/transport.js"
import { routeRelativePath } from "../core/dist/index.js"
import {
	TEST_KEYS,
	signTestRequest,
	signedAdapterRequest as signAdapterRequest,
} from "./support/signing"

const { apiKey, secretKey, orgId } = TEST_KEYS
const clientApiKey = "pk_client_live_abc123456789012345678"

let originalFetch: typeof fetch

function trustedContext(scope: "read" | "write", sessionId = "sess_123") {
	return {
		isImpersonation: true as const,
		actor: { id: "agent_1" },
		subject: { id: "user_1" },
		scope,
		sessionId,
		expiresAt: Date.now() + 60_000,
		authMethod: "devora_impersonation" as const,
		authorizationSource: "standard" as const,
		recordingAllowed: false,
	}
}

function scopeConfigResponse(blockedEndpoints: Array<{ method: string; pattern: string }> = []) {
	return new Response(
		JSON.stringify({
			success: true,
			data: {
				safeReadEndpoints: [],
				blockedEndpoints,
				version: 1,
				cachedUntil: Date.now() + 60_000,
			},
		}),
		{ status: 200, headers: { etag: "policy-v1" } }
	)
}

beforeEach(() => {
	originalFetch = globalThis.fetch
	globalThis.fetch = async () => scopeConfigResponse()
})

afterEach(() => {
	globalThis.fetch = originalFetch
})

test("backend core exposes trusted devoraContext only after HMAC verification", async () => {
	const sdk = createBackendSDK()
	let trustedContext: DevoraImpersonationContext | undefined

	sdk.register(DEVORA_ENDPOINTS.IMPERSONATE, (req) => {
		trustedContext = req.devoraContext
		return { token: "customer-jwt" }
	})
	await sdk.ready

	const body = {
		sessionId: "sess_123",
		scope: "read",
		expiresAt: Date.now() + 60_000,
		impersonator: { id: "agent_1", email: "agent@example.com" },
		authMethod: "devora_impersonation",
		authorizationSource: "self_approved",
		recordingAllowed: false,
	}
	const request = await signedAdapterRequest(sdk, "POST", "/impersonate/user_1", body)

	const response = await processRequest(sdk, sdk.getRoutes(), request)

	expect(response.success).toBe(true)
	expect(trustedContext).toMatchObject({
		sessionId: "sess_123",
		scope: "read",
		expiresAt: body.expiresAt,
		impersonator: { id: "agent_1", email: "agent@example.com", name: undefined },
		targetUser: { id: "user_1", email: undefined, name: undefined },
		authMethod: "devora_impersonation",
		authorizationSource: "self_approved",
		recordingAllowed: false,
	})
	// The handler's context is directly acceptable to the guard: canonical
	// actor/subject ids are populated from impersonator/targetUser.
	expect(trustedContext?.isImpersonation).toBe(true)
	expect(trustedContext?.actor).toEqual({ id: "agent_1" })
	expect(trustedContext?.subject).toEqual({ id: "user_1" })
	expect(validateImpersonationContext(trustedContext).valid).toBe(true)
	expect(sdk.getStats()).toMatchObject({
		totalRequests: 1,
		successfulRequests: 1,
		failedRequests: 0,
		securityErrors: 0,
	})
})

test("backend core rejects replayed request IDs and records security stats", async () => {
	const sdk = createBackendSDK()
	sdk.register(DEVORA_ENDPOINTS.IMPERSONATE, () => ({ token: "customer-jwt" }))
	await sdk.ready

	const body = {
		sessionId: "sess_123",
		scope: "write",
		expiresAt: Date.now() + 60_000,
		impersonator: { id: "agent_1" },
		authMethod: "devora_impersonation",
		authorizationSource: "standard",
		recordingAllowed: false,
	}
	const request = await signedAdapterRequest(sdk, "POST", "/impersonate/user_1", body)

	expect((await processRequest(sdk, sdk.getRoutes(), request)).success).toBe(true)
	const replay = await processRequest(sdk, sdk.getRoutes(), request)

	expect(replay.success).toBe(false)
	expect(replay.errorCode).toBe("REPLAYED_REQUEST")
	expect(sdk.getStats()).toMatchObject({
		totalRequests: 2,
		successfulRequests: 1,
		failedRequests: 1,
		securityErrors: 1,
	})
})

test("backend core rejects requests without signature headers", async () => {
	const sdk = createBackendSDK()
	await sdk.ready

	const response = await processRequest(sdk, sdk.getRoutes(), {
		method: "GET",
		path: DEVORA_ENDPOINTS.TEST,
		query: "",
		body: new Uint8Array(),
		headers: {},
	})

	expect(response.success).toBe(false)
	expect(response.errorCode).toBe("INVALID_SIGNATURE_HEADERS")
	expect(getErrorStatusCode(response.errorCode)).toBe(401)
})

test("backend core returns TIMESTAMP_EXPIRED for stale sent-at headers", async () => {
	const sdk = createBackendSDK()
	await sdk.ready

	const staleTimestamp = Math.floor(Date.now() / 1000) - 3600
	const response = await processRequest(
		sdk,
		sdk.getRoutes(),
		signAdapterRequest({
			method: "GET",
			path: DEVORA_ENDPOINTS.TEST,
			sentAt: String(staleTimestamp),
		})
	)

	expect(response.success).toBe(false)
	expect(response.errorCode).toBe("TIMESTAMP_EXPIRED")
	expect(getErrorStatusCode(response.errorCode)).toBe(401)
})

test("backend core rejects invalid impersonation context bodies", async () => {
	const sdk = createBackendSDK()
	sdk.register(DEVORA_ENDPOINTS.IMPERSONATE, () => ({ token: "customer-jwt" }))
	await sdk.ready

	const request = await signedAdapterRequest(sdk, "POST", "/impersonate/user_1", {
		sessionId: "sess_123",
		scope: "read",
	})

	const response = await processRequest(sdk, sdk.getRoutes(), request)

	expect(response.success).toBe(false)
	expect(response.errorCode).toBe("INVALID_IMPERSONATION_CONTEXT")
	expect(getErrorStatusCode(response.errorCode)).toBe(401)
})

test("impersonation guard blocks blacklisted endpoints with DevoraResponse shape", async () => {
	globalThis.fetch = async () => scopeConfigResponse([{ method: "POST", pattern: "/api/delete" }])

	const sdk = createBackendSDK()
	await sdk.ready

	const guard = createImpersonationGuard({
		sdk,
		getImpersonationContext: () => trustedContext("write"),
		enforceLiveness: false,
		showWarnings: false,
	})

	let statusCode = 0
	let body: Record<string, unknown> | undefined
	await guard(
		{ method: "POST", path: "/api/delete" },
		{
			status(code) {
				statusCode = code
				return this
			},
			json(payload) {
				body = payload as Record<string, unknown>
			},
		},
		async () => {}
	)

	expect(statusCode).toBe(403)
	expect(body).toMatchObject({
		success: false,
		errorCode: "IMPERSONATION_ENDPOINT_BLOCKED",
		error: "This endpoint is blocked during impersonation",
	})
})

test("impersonation guard blocks read-only write attempts with scope violation code", async () => {
	const sdk = createBackendSDK()
	await sdk.ready

	const guard = createImpersonationGuard({
		sdk,
		getImpersonationContext: () => trustedContext("read"),
		enforceLiveness: false,
		showWarnings: false,
	})

	let statusCode = 0
	let body: Record<string, unknown> | undefined
	await guard(
		{ method: "POST", path: "/api/items" },
		{
			status(code) {
				statusCode = code
				return this
			},
			json(payload) {
				body = payload as Record<string, unknown>
			},
		},
		async () => {}
	)

	expect(statusCode).toBe(403)
	expect(body?.errorCode).toBe("IMPERSONATION_SCOPE_VIOLATION")
})

test("liveness guard blocks a session Devora reports as ended", async () => {
	globalThis.fetch = async (input) => {
		const url = String(input)
		if (url.includes("scope-config")) return scopeConfigResponse()
		if (url.includes("session-status")) {
			return new Response(
				JSON.stringify({ success: true, data: { valid: false, status: "terminated" } }),
				{ status: 200 }
			)
		}
		return new Response("not found", { status: 404 })
	}

	const sdk = createBackendSDK()
	await sdk.ready

	const guard = createImpersonationGuard({
		sdk,
		enforceLiveness: true,
		getImpersonationContext: () => trustedContext("write", "sess_live_1"),
		showWarnings: false,
	})

	const { statusCode, body } = await runGuard(guard, { method: "GET", path: "/api/items" })
	expect(statusCode).toBe(401)
	expect(body?.errorCode).toBe("IMPERSONATION_SESSION_ENDED")
})

test("liveness guard allows a session Devora reports as live", async () => {
	globalThis.fetch = async (input) => {
		const url = String(input)
		if (url.includes("scope-config")) return scopeConfigResponse()
		if (url.includes("session-status")) {
			return new Response(
				JSON.stringify({ success: true, data: { valid: true, status: "active" } }),
				{ status: 200 }
			)
		}
		return new Response("not found", { status: 404 })
	}

	const sdk = createBackendSDK()
	await sdk.ready

	const guard = createImpersonationGuard({
		sdk,
		enforceLiveness: true,
		getImpersonationContext: () => trustedContext("write", "sess_live_2"),
		showWarnings: false,
	})

	const { nextCalled } = await runGuard(guard, { method: "GET", path: "/api/items" })
	expect(nextCalled).toBe(true)
})

test("liveness guard fails closed when Devora is unreachable by default", async () => {
	globalThis.fetch = async (input) => {
		const url = String(input)
		if (url.includes("scope-config")) return scopeConfigResponse()
		if (url.includes("session-status")) throw new Error("network down")
		return new Response("not found", { status: 404 })
	}

	const sdk = createBackendSDK()
	await sdk.ready

	const guard = createImpersonationGuard({
		sdk,
		enforceLiveness: true,
		getImpersonationContext: () => trustedContext("write", "sess_live_3"),
		showWarnings: false,
	})

	const { statusCode, body } = await runGuard(guard, { method: "GET", path: "/api/items" })
	expect(statusCode).toBe(503)
	expect(body?.errorCode).toBe("IMPERSONATION_LIVENESS_UNAVAILABLE")
})

test("liveness guard fails closed when configured and Devora is unreachable", async () => {
	globalThis.fetch = async (input) => {
		const url = String(input)
		if (url.includes("scope-config")) return scopeConfigResponse()
		if (url.includes("session-status")) throw new Error("network down")
		return new Response("not found", { status: 404 })
	}

	const sdk = createBackendSDK()
	await sdk.ready

	const guard = createImpersonationGuard({
		sdk,
		enforceLiveness: true,
		onLivenessUnavailable: "deny",
		getImpersonationContext: () => trustedContext("write", "sess_live_4"),
		showWarnings: false,
	})

	const { statusCode, body } = await runGuard(guard, { method: "GET", path: "/api/items" })
	expect(statusCode).toBe(503)
	expect(body?.errorCode).toBe("IMPERSONATION_LIVENESS_UNAVAILABLE")
})

test("next route handler verifies a signed request and rejects replays", async () => {
	const sdk = createBackendSDK()
	sdk.register(DEVORA_ENDPOINTS.IMPERSONATE, () => ({ token: "customer-jwt" }))
	await sdk.ready

	const handlers = createDevoraRouteHandlers(sdk)
	const body = {
		sessionId: "sess_123",
		scope: "read",
		expiresAt: Date.now() + 60_000,
		impersonator: { id: "agent_1" },
		authMethod: "devora_impersonation",
		authorizationSource: "standard",
		recordingAllowed: false,
	}
	const { make, context } = await signedWebRequest(sdk, "POST", "/impersonate/user_1", body)

	const ok = await handlers.POST(make(), context)
	expect(ok.status).toBe(200)
	expect(((await ok.json()) as { success: boolean }).success).toBe(true)

	const replay = await handlers.POST(make(), context)
	expect(replay.status).toBe(401)
	expect(((await replay.json()) as { errorCode: string }).errorCode).toBe("REPLAYED_REQUEST")
})

test("nextjs package is a single-package full-stack backend surface", async () => {
	const sdk = createNextBackendSDK({ apiKey, secretKey, orgId })
	await sdk.ready

	const handlers = createDevoraRouteHandlers(sdk)
	expect(typeof handlers.GET).toBe("function")
	expect(typeof handlers.POST).toBe("function")
	expect(typeof handlers.PUT).toBe("function")
	expect(typeof handlers.PATCH).toBe("function")
	expect(typeof handlers.DELETE).toBe("function")

	// Unsigned callers learn nothing about which routes exist.
	const unsigned = await handlers.PUT(
		new Request("https://app.example.com/api/devora/health", { method: "PUT" }),
		{ params: { devora: ["health"] } }
	)
	expect(unsigned.status).toBe(401)
	const signed = signTestRequest({ method: "PUT", path: "/health" })
	const unsupported = await handlers.PUT(
		new Request("https://app.example.com/api/devora/health", {
			method: "PUT",
			headers: signed.headers,
		}),
		{ params: { devora: ["health"] } }
	)
	expect(unsupported.status).toBe(404)
	expect(((await unsupported.json()) as { errorCode: string }).errorCode).toBe("NOT_FOUND")
})

test("next withDevoraGuard blocks read-only writes and allows reads", async () => {
	const sdk = createBackendSDK()
	await sdk.ready

	const guard = withDevoraGuard(async () => Response.json({ ok: true }), {
		sdk,
		getImpersonationContext: () => trustedContext("read"),
		enforceLiveness: false,
		showWarnings: false,
	})

	const blocked = await guard(
		new Request("https://app.example.com/api/items", { method: "POST" }),
		undefined
	)
	expect(blocked.status).toBe(403)
	expect(((await blocked.json()) as { errorCode: string }).errorCode).toBe(
		"IMPERSONATION_SCOPE_VIOLATION"
	)

	const allowed = await guard(
		new Request("https://app.example.com/api/items", { method: "GET" }),
		undefined
	)
	expect(allowed.status).toBe(200)
	expect(((await allowed.json()) as { ok: boolean }).ok).toBe(true)
})

test("adapters take the route-relative raw path without guessing across routes", () => {
	expect(routeRelativePath("/devora/impersonate/user_1", "/impersonate/:id")).toBe(
		"/impersonate/user_1"
	)
	expect(routeRelativePath("/impersonate/user_1", "/impersonate/:id")).toBe("/impersonate/user_1")
	expect(routeRelativePath("/devora/test", "/test")).toBe("/test")
	expect(routeRelativePath("/test", "/impersonate/:id")).toBeNull()
	// Empty segments are kept so the signature check rejects them.
	expect(routeRelativePath("/devora//a%2Fb", "/user/:id")).toBe("//a%2Fb")
})

test("getErrorStatusCode maps impersonation and internal error codes", () => {
	expect(getErrorStatusCode("INVALID_IMPERSONATION_CONTEXT")).toBe(401)
	expect(getErrorStatusCode("IMPERSONATION_EXPIRED")).toBe(401)
	expect(getErrorStatusCode("IMPERSONATION_SESSION_ENDED")).toBe(401)
	expect(getErrorStatusCode("IMPERSONATION_ENDPOINT_BLOCKED")).toBe(403)
	expect(getErrorStatusCode("IMPERSONATION_SCOPE_VIOLATION")).toBe(403)
	expect(getErrorStatusCode("IMPERSONATION_POLICY_UNAVAILABLE")).toBe(503)
	expect(getErrorStatusCode("INTERNAL_ERROR")).toBe(500)
})

test("frontend core rejects server keys during initialization", async () => {
	const sdk = createDevoraSDK()
	await expect(
		sdk.init({
			apiKey: "pk_server_live_12345678901234567890",
		})
	).rejects.toThrow("apiKey must be a client key")
})

test("frontend core rejects malformed client keys during initialization", async () => {
	const sdk = createDevoraSDK()
	await expect(
		sdk.init({
			apiKey: "not-a-valid-key",
		})
	).rejects.toThrow("apiKey must be a client key")
})

test("frontend without a bridge is idle in a fresh tab and keeps no session state", async () => {
	const sdk = createDevoraSDK()
	await sdk.init({ apiKey: clientApiKey, autoDetect: false })
	expect(sdk.isImpersonating()).toBe(false)
	expect(sdk.getBridgeState()).toEqual({ status: "none" })
	expect(sdk.getTabRef()).toMatch(/^devora_tab_/)
})

test("frontend restores through the customer bridge and keeps the capability in memory only", async () => {
	const seen: { resumeBody?: Record<string, unknown> } = {}
	globalThis.fetch = async (url, init) => {
		const urlStr = String(url)
		if (urlStr.includes("scope-config")) return scopeConfigResponse()
		if (urlStr.endsWith("/api/sdk/browser-resume")) {
			seen.resumeBody = JSON.parse(String(init?.body))
			return new Response(
				JSON.stringify({
					success: true,
					data: {
						sessionId: "sess_bridge",
						scope: "read",
						expiresAt: Date.now() + 60_000,
						targetUser: { id: "user_1" },
						impersonator: { id: "agent_1" },
						recordingEnabled: false,
						activityEnabled: false,
						devoraSessionToken: "tab_capability_token",
						tabRef: seen.resumeBody?.tabRef,
						scopePolicy: {
							version: 1,
							safeReadEndpoints: [],
							blockedEndpoints: [],
							cachedUntil: Date.now() + 60_000,
						},
					},
				}),
				{ status: 200 }
			)
		}
		return new Response("not found", { status: 404 })
	}
	const bridgeCalls: string[] = []
	const sdk = createDevoraSDK()
	let restoredEvent = false
	sdk.on("session_restored", () => {
		restoredEvent = true
	})
	await sdk.init({
		apiKey: clientApiKey,
		autoDetect: false,
		sessionBridge: {
			restore: async ({ tabRef }) => {
				bridgeCalls.push(tabRef)
				return { status: "resume", code: "r".repeat(43) }
			},
		},
	})
	expect(bridgeCalls).toEqual([sdk.getTabRef()])
	expect(seen.resumeBody).toEqual({ code: "r".repeat(43), tabRef: sdk.getTabRef() })
	expect(sdk.isImpersonating()).toBe(true)
	expect(sdk.getSession().scope).toBe("read")
	expect(sdk.getBridgeState()).toEqual({ status: "restored" })
	expect(restoredEvent).toBe(true)
	// Nothing capability-shaped is exposed through public state.
	expect(JSON.stringify(sdk.getSession())).not.toContain("tab_capability_token")
	await sdk.destroy()
})

test("frontend enters the blocked state when the bridge cannot restore an impersonated session", async () => {
	const sdk = createDevoraSDK()
	const events: unknown[] = []
	sdk.on("session_blocked", (event) => events.push(event))
	await sdk.init({
		apiKey: clientApiKey,
		autoDetect: false,
		sessionBridge: {
			restore: async () => ({ status: "blocked", reason: "control_plane_unavailable" }),
		},
	})
	expect(sdk.isImpersonating()).toBe(false)
	expect(sdk.getBridgeState()).toEqual({ status: "blocked", reason: "control_plane_unavailable" })
	expect(events).toHaveLength(1)

	const failing = createDevoraSDK()
	await failing.init({
		apiKey: clientApiKey,
		autoDetect: false,
		sessionBridge: {
			restore: async () => {
				throw new Error("bridge down")
			},
		},
	})
	expect(failing.getBridgeState()).toEqual({ status: "blocked", reason: "bridge_unavailable" })

	globalThis.fetch = async (url) => {
		const urlStr = String(url)
		if (urlStr.includes("scope-config")) return scopeConfigResponse()
		return new Response(JSON.stringify({ success: false }), { status: 400 })
	}
	const rejected = createDevoraSDK()
	await rejected.init({
		apiKey: clientApiKey,
		autoDetect: false,
		sessionBridge: { restore: async () => ({ status: "resume", code: "x".repeat(43) }) },
	})
	expect(rejected.getBridgeState()).toEqual({ status: "blocked", reason: "resume_failed" })
	expect(rejected.isImpersonating()).toBe(false)
})

test("shared API key validation recognizes current server and client key prefixes", () => {
	expect(validateApiKeyFormat("pk_server_live_abc123")).toEqual({
		valid: true,
		type: "server",
	})
	expect(validateApiKeyFormat("pk_client_live_abc123")).toEqual({
		valid: true,
		type: "client",
	})
	// There is no test-mode key prefix; only live keys are ever issued.
	expect(validateApiKeyFormat("pk_client_test_abc123")).toEqual({ valid: false })
	// Legacy pk_live_/pk_test_ prefixes are no longer supported.
	expect(validateApiKeyFormat("pk_live_legacy123")).toEqual({ valid: false })
})

function createBackendSDK(): DevoraBackendSDK {
	return devoraSDK({
		apiKey,
		secretKey,
		orgId,
		collectStats: true,
	})
}

async function signedWebRequest(
	_sdk: DevoraBackendSDK,
	method: string,
	path: string,
	body: unknown
): Promise<{ make: () => Request; context: { params: { devora: string[] } } }> {
	const signed = signTestRequest({
		method,
		path,
		body: body === undefined ? undefined : (body as Record<string, unknown>),
	})
	const make = () =>
		new Request(`https://app.example.com/api/devora${path}`, {
			method,
			headers: signed.headers,
			body: signed.body.byteLength > 0 ? signed.body : undefined,
		})
	return { make, context: { params: { devora: path.split("/").filter(Boolean) } } }
}

async function runGuard(
	guard: ReturnType<typeof createImpersonationGuard>,
	req: { method: string; path: string }
): Promise<{ statusCode: number; body?: Record<string, unknown>; nextCalled: boolean }> {
	let statusCode = 0
	let body: Record<string, unknown> | undefined
	let nextCalled = false
	await guard(
		req,
		{
			status(code) {
				statusCode = code
				return this
			},
			json(payload) {
				body = payload as Record<string, unknown>
			},
		},
		async () => {
			nextCalled = true
		}
	)
	return { statusCode, body, nextCalled }
}

async function signedAdapterRequest(
	_sdk: DevoraBackendSDK,
	method: string,
	path: string,
	body: unknown
) {
	return signAdapterRequest({
		method,
		path,
		body: body === undefined ? undefined : (body as Record<string, unknown>),
	})
}

// ============================================
// mountPath prefix stripping (middleware adapters)
// ============================================

test("stripMountPath strips a literal mount prefix for middleware adapters", () => {
	expect(stripMountPath("/devora/user/search", "/devora")).toBe("/user/search")
	expect(stripMountPath("/devora/impersonate/u1", "/devora")).toBe("/impersonate/u1")
	expect(stripMountPath("/api/devora/test", "/api/devora")).toBe("/test")
	expect(stripMountPath("/devora", "/devora")).toBe("/")
	// Paths outside the mount are untouched.
	expect(stripMountPath("/other/test", "/devora")).toBe("/other/test")
	// Prefix must match on a segment boundary.
	expect(stripMountPath("/devorax/test", "/devora")).toBe("/devorax/test")
})

// ============================================
// Adapter-level timestamp tolerance override
// ============================================

test("adapter timestampTolerance option overrides the SDK config", async () => {
	const sdk = createBackendSDK()
	await sdk.ready

	const staleTimestamp = Math.floor(Date.now() / 1000) - 600 // 10 minutes old
	const request = signAdapterRequest({
		method: "GET",
		path: DEVORA_ENDPOINTS.TEST,
		sentAt: String(staleTimestamp),
	})

	// Default tolerance (300s): stale request is rejected.
	const rejected = await processRequest(sdk, sdk.getRoutes(), request)
	expect(rejected.success).toBe(false)
	expect(rejected.errorCode).toBe("TIMESTAMP_EXPIRED")

	// Widened per-adapter tolerance: the same request verifies.
	const accepted = await processRequest(sdk, sdk.getRoutes(), request, {
		timestampTolerance: 1200,
	})
	expect(accepted.success).toBe(true)
})

// ============================================
// Recording privacy masking presets
// ============================================

type FakeElementOptions = {
	tag?: string
	id?: string
	attrs?: Record<string, string>
	/** Selectors (single, not comma lists) this element or an ancestor matches. */
	matches?: string[]
}

function fakeElement(options: FakeElementOptions = {}) {
	return {
		tagName: (options.tag ?? "div").toUpperCase(),
		id: options.id ?? "",
		getAttribute: (name: string) => options.attrs?.[name] ?? null,
		closest: (selector: string) => {
			const parts = selector.split(",").map((part) => part.trim())
			return parts.some((part) => options.matches?.includes(part)) ? {} : null
		},
	} as unknown as HTMLElement
}

function capture(overrides: Partial<import("../core/dist/index.js").DevoraCaptureSnapshot> = {}) {
	return {
		policyVersion: 1,
		recordingPolicy: "all_sessions" as const,
		activityPolicy: "all_sessions" as const,
		recordingMaskingProfile: "full" as const,
		recordingBlockMedia: true,
		recordingMaskSelectors: [],
		recordingBlockSelectors: [],
		recordingUnmaskRegions: [],
		recordingUnmaskSelectors: [],
		consoleErrorCaptureEnabled: false,
		activityCustomEventsEnabled: false,
		...overrides,
	}
}

const REGION = '[data-devora-region="order-summary"]'

test("without a snapshot the 'full' profile masks all text and inputs and blocks media", () => {
	const rules = resolveMasking(undefined)
	const options = buildRrwebPrivacyOptions(rules)

	expect(rules.profile).toBe("full")
	expect(rules.policyVersion).toBe(0)
	expect(options.maskTextSelector).toBe("*")
	expect(options.maskAllInputs).toBe(true)
	expect(options.blockSelector).toContain("img")
	expect(options.blockSelector).toContain("video")

	// Text masked by default, whitespace preserved.
	expect(options.maskTextFn("card 4242", fakeElement())).toBe("**** ****")
	// The removed developer unmask marker reveals nothing.
	const legacyUnmask = fakeElement({ matches: ["[data-devora-unmask]", ".devora-unmask"] })
	expect(options.maskTextFn("visible", legacyUnmask)).toBe("*******")
	expect(options.maskInputFn("secret", fakeElement({ tag: "input" }))).toBe("***")
	expect(
		options.maskInputFn("ok", fakeElement({ tag: "input", matches: ["[data-devora-unmask]"] }))
	).toBe("***")
})

test("a region is revealed only when the administrator listed it", () => {
	const unlisted = buildRrwebPrivacyOptions(resolveMasking(capture()))
	expect(unlisted.maskTextFn("Total 42", fakeElement({ matches: [REGION] }))).toBe("***** **")

	const listed = buildRrwebPrivacyOptions(
		resolveMasking(capture({ recordingUnmaskRegions: ["order-summary"] }))
	)
	expect(listed.maskTextFn("Total 42", fakeElement({ matches: [REGION] }))).toBe("Total 42")
	expect(listed.maskInputFn("note", fakeElement({ tag: "input", matches: [REGION] }))).toBe("note")
	// Outside the region the profile still applies.
	expect(listed.maskTextFn("Total 42", fakeElement())).toBe("***** **")
	// Region names that are not opaque tokens are ignored rather than interpolated.
	const hostile = resolveMasking(capture({ recordingUnmaskRegions: ['x"] , *'] }))
	expect(hostile.unmaskSelector).toBe("")
})

test("developer mask markers beat an administrator unmask region", () => {
	const options = buildRrwebPrivacyOptions(
		resolveMasking(capture({ recordingUnmaskRegions: ["order-summary"] }))
	)
	const maskedInsideRegion = fakeElement({ matches: [REGION, "[data-devora-mask]"] })
	expect(options.maskTextFn("secret", maskedInsideRegion)).toBe("******")
	expect(
		options.maskInputFn("secret", fakeElement({ tag: "input", matches: [REGION, ".devora-mask"] }))
	).toBe("***")
})

test("sensitive inputs stay masked in every profile, even inside a revealed region", () => {
	for (const profile of ["full", "partial", "minimal"] as const) {
		const options = buildRrwebPrivacyOptions(
			resolveMasking(
				capture({
					recordingMaskingProfile: profile,
					recordingUnmaskRegions: ["order-summary"],
					recordingUnmaskSelectors: ["#checkout"],
				})
			)
		)
		expect(
			options.maskInputFn(
				"hunter2",
				fakeElement({ tag: "input", attrs: { type: "password" }, matches: [REGION, "#checkout"] })
			)
		).toBe("***")
		expect(
			options.maskInputFn(
				"4242",
				fakeElement({ tag: "input", attrs: { autocomplete: "cc-number" }, matches: [REGION] })
			)
		).toBe("***")
		expect(
			options.maskInputFn(
				"123456",
				fakeElement({ tag: "input", attrs: { autocomplete: "one-time-code" } })
			)
		).toBe("***")
		expect(
			options.maskInputFn(
				"123-45-6789",
				fakeElement({ tag: "input", attrs: { name: "ssn_number" } })
			)
		).toBe("***")
	}
})

test("the 'partial' profile masks inputs but leaves text, and media follows the administrator flag", () => {
	const blocked = resolveMasking(
		capture({ recordingMaskingProfile: "partial", recordingBlockMedia: true })
	)
	const options = buildRrwebPrivacyOptions(blocked)
	// Every node reaches the composed-tree predicate, even in partial mode.
	expect(options.maskTextSelector).toBe("*")
	expect(blocked.blockAllMedia).toBe(true)
	expect(options.maskTextFn("visible", fakeElement())).toBe("visible")
	expect(options.maskInputFn("secret", fakeElement({ tag: "input" }))).toBe("***")

	const open = resolveMasking(
		capture({ recordingMaskingProfile: "partial", recordingBlockMedia: false })
	)
	expect(open.blockAllMedia).toBe(false)
	expect(open.blockSelector).not.toContain("img")
	// The full profile cannot have media unblocked.
	expect(resolveMasking(capture({ recordingBlockMedia: false })).blockAllMedia).toBe(true)
})

test("the 'minimal' profile masks only sensitive fields plus explicit mask rules", () => {
	const options = buildRrwebPrivacyOptions(
		resolveMasking(
			capture({ recordingMaskingProfile: "minimal", recordingMaskSelectors: [".price"] })
		)
	)
	expect(options.maskInputFn("john", fakeElement({ tag: "input", attrs: { type: "text" } }))).toBe(
		"john"
	)
	expect(
		options.maskInputFn("pw", fakeElement({ tag: "input", attrs: { type: "password" } }))
	).toBe("***")
	expect(
		options.maskInputFn("hide", fakeElement({ tag: "input", matches: ["[data-devora-mask]"] }))
	).toBe("***")
	expect(options.maskInputFn("hide", fakeElement({ tag: "input", matches: [".price"] }))).toBe(
		"***"
	)
	expect(options.maskTextFn("42.00", fakeElement({ matches: [".price"] }))).toBe("*****")
	expect(options.maskTextFn("Hello", fakeElement())).toBe("Hello")
})

test("administrator block selectors join the developer block markers", () => {
	const rules = resolveMasking(
		capture({
			recordingMaskingProfile: "partial",
			recordingBlockMedia: false,
			recordingBlockSelectors: [".pdf"],
		})
	)
	expect(rules.blockSelector).toContain(".devora-block")
	expect(rules.blockSelector).toContain("[data-devora-block]")
	expect(rules.blockSelector).toContain(".pdf")
})

test("describeElement withholds text for masked elements and reveals listed regions", () => {
	const fullRules = resolveMasking(capture())
	const masked = describeElement(
		fakeElement({ tag: "button", id: "save", attrs: { "aria-label": "Save order" } }),
		fullRules
	)
	expect(masked.description).toBe("Clicked button")
	expect(masked.elementText).toBeUndefined()

	const listed = resolveMasking(capture({ recordingUnmaskRegions: ["order-summary"] }))
	const revealed = describeElement(
		fakeElement({
			tag: "button",
			id: "save",
			attrs: { "aria-label": "Save order" },
			matches: [REGION],
		}),
		listed
	)
	expect(revealed.description).toBe('Clicked "Save order"')
	expect(revealed.elementText).toBe("Save order")
})

// ============================================
// Session restore prefers server-returned scope/expiry (A4)
// ============================================

test("frontend restore takes scope and expiry from the server snapshot only", async () => {
	const serverExpiresAt = Date.now() + 120_000
	globalThis.fetch = async (url) => {
		const urlStr = String(url)
		if (urlStr.includes("scope-config")) return scopeConfigResponse()
		if (urlStr.endsWith("/api/sdk/browser-resume")) {
			return new Response(
				JSON.stringify({
					success: true,
					data: {
						sessionId: "sess_snapshot",
						scope: "read",
						expiresAt: serverExpiresAt,
						devoraSessionToken: "tab_capability_token",
						scopePolicy: {
							version: 1,
							safeReadEndpoints: [],
							blockedEndpoints: [],
							cachedUntil: Date.now() + 60_000,
						},
					},
				}),
				{ status: 200 }
			)
		}
		return new Response("not found", { status: 404 })
	}

	const sdk = createDevoraSDK()
	await sdk.init({
		apiKey: clientApiKey,
		autoDetect: false,
		recording: { enabled: false },
		activityLog: { enabled: false },
		sessionBridge: { restore: async () => ({ status: "resume", code: "r".repeat(43) }) },
	})

	// There is no locally stored copy that could be tampered with; the SDK
	// carries exactly what Devora returned for this tab.
	expect(sdk.isImpersonating()).toBe(true)
	expect(sdk.getSession().scope).toBe("read")
	expect(sdk.getSession().expiresAt).toBe(new Date(serverExpiresAt).toISOString())
	await sdk.destroy()
})

// ============================================
// init/destroy generation guard (React StrictMode)
// ============================================

test("destroy during in-flight init aborts the stale init without consuming state", async () => {
	globalThis.fetch = async (url) => {
		const urlStr = String(url)
		if (urlStr.includes("scope-config")) {
			// Slow policy fetch so destroy() lands while init() is awaiting.
			await new Promise((resolve) => setTimeout(resolve, 30))
			return scopeConfigResponse()
		}
		return new Response("not found", { status: 404 })
	}

	const sdk = createDevoraSDK()
	const firstInit = sdk.init({
		apiKey: clientApiKey,
		autoDetect: false,
		recording: { enabled: false },
		activityLog: { enabled: false },
	})
	await sdk.destroy()
	await firstInit

	// The superseded init must not mark the SDK initialized.
	expect(sdk.isInitialized()).toBe(false)

	// A fresh init afterwards works normally.
	await sdk.init({
		apiKey: clientApiKey,
		autoDetect: false,
		recording: { enabled: false },
		activityLog: { enabled: false },
	})
	expect(sdk.isInitialized()).toBe(true)
	await sdk.destroy()
})

// ============================================
// apiUrl override validation (D2)
// ============================================

test("backend SDK rejects unsafe apiUrl overrides and accepts https origins", () => {
	expect(() => devoraSDK({ apiKey, secretKey, orgId, apiUrl: "http://example.com" })).toThrow(
		/https/
	)
	expect(() => devoraSDK({ apiKey, secretKey, orgId, apiUrl: "https://example.com/path" })).toThrow(
		/origin/
	)
	const sdk = devoraSDK({ apiKey, secretKey, orgId, apiUrl: "https://devora.example.com" })
	expect(sdk).toBeDefined()
	sdk.destroy()
	const localSdk = devoraSDK({ apiKey, secretKey, orgId, apiUrl: "http://localhost:3210" })
	expect(localSdk).toBeDefined()
	localSdk.destroy()
})

test("guard accepts impersonator/targetUser as actor/subject and rejects unknown authorization sources", () => {
	const base = trustedContext("read")
	const { actor, subject, ...legacyShape } = base
	expect(
		validateImpersonationContext({
			...legacyShape,
			impersonator: { id: actor.id },
			targetUser: { id: subject.id },
		}).valid
	).toBe(true)
	expect(validateImpersonationContext({ ...legacyShape }).valid).toBe(false)
	expect(
		validateImpersonationContext({
			...base,
			authorizationSource: "forged" as unknown as typeof base.authorizationSource,
		})
	).toMatchObject({ valid: false, error: "Invalid authorization source" })
	for (const missing of ["authMethod", "recordingAllowed", "sessionId", "expiresAt"] as const) {
		const { [missing]: _omitted, ...rest } = base
		expect(validateImpersonationContext(rest as typeof base).valid).toBe(false)
	}
})

test("blocklist matching sees the router-normalized path", async () => {
	globalThis.fetch = async () => scopeConfigResponse([{ method: "POST", pattern: "/admin/users" }])
	const sdk = createBackendSDK()
	await sdk.ready
	const guard = createImpersonationGuard({
		sdk,
		getImpersonationContext: () => trustedContext("write"),
		enforceLiveness: false,
		showWarnings: false,
	})
	for (const path of [
		"/Admin/users",
		"/admin/%75sers",
		"/api/../admin/users",
		"/admin/users/",
		"//admin//users",
		"/admin/users?x=1",
	]) {
		const { statusCode, body } = await runGuard(guard, { method: "POST", path })
		expect([path, statusCode]).toEqual([path, 403])
		expect(body?.errorCode).toBe("IMPERSONATION_ENDPOINT_BLOCKED")
	}
	const { nextCalled } = await runGuard(guard, { method: "POST", path: "/admin/users2" })
	expect(nextCalled).toBe(true)
})

test("Hono adapter guard enforces the blocklist against a real request (regression: c.req.url is absolute)", async () => {
	globalThis.fetch = async () => scopeConfigResponse([{ method: "POST", pattern: "/admin/users" }])
	const sdk = createBackendSDK()
	await sdk.ready
	const app = new Hono()
	app.use(
		"*",
		createHonoImpersonationGuard({
			sdk,
			getImpersonationContext: () => trustedContext("write"),
			enforceLiveness: false,
			showWarnings: false,
		})
	)
	app.post("/admin/users", (c) => c.json({ reachedHandler: true }))
	app.post("/admin/users2", (c) => c.json({ reachedHandler: true }))

	// Hono's `c.req.url` is the absolute URL; a naive pass-through of it into the
	// path-matching guard turns "/admin/users" into "/https:/.../admin/users",
	// which never matches the configured blocklist pattern.
	const blocked = await app.request("https://app.example.com/admin/users", { method: "POST" })
	expect(blocked.status).toBe(403)
	expect((await blocked.json()).errorCode).toBe("IMPERSONATION_ENDPOINT_BLOCKED")

	const allowed = await app.request("https://app.example.com/admin/users2", { method: "POST" })
	expect(allowed.status).toBe(200)
	expect(await allowed.json()).toEqual({ reachedHandler: true })
})

test("a 304 policy revalidation keeps the full server cache window", async () => {
	let calls = 0
	globalThis.fetch = async () => {
		calls++
		return calls === 1
			? scopeConfigResponse()
			: new Response(null, { status: 304, headers: { etag: "policy-v1" } })
	}
	const sdk = createBackendSDK()
	await sdk.ready
	await sdk.refreshScopeConfig()
	const cached = sdk.getCachedScopeConfig()
	expect(calls).toBe(2)
	expect(cached).not.toBeNull()
	// Default TTL is five minutes, not thirty seconds: the SDK must not poll the
	// rate-limited policy endpoint twice a minute per process.
	expect(cached!.cachedUntil - Date.now()).toBeGreaterThan(4 * 60 * 1000)
})

test("endpoint rule edits remain cached until the Node SDK refreshes policy", async () => {
	let serverVersion = 1
	let requests = 0
	globalThis.fetch = async () => {
		requests++
		return new Response(
			JSON.stringify({
				success: true,
				data: {
					version: serverVersion,
					safeReadEndpoints: [],
					blockedEndpoints:
						serverVersion === 1 ? [{ method: "*", pattern: "/api/customers/*" }] : [],
					cachedUntil: Date.now() + 5 * 60_000,
				},
			}),
			{ headers: { etag: `policy-v${serverVersion}` } }
		)
	}
	const fetcher = createScopeConfigFetcher({
		apiKey,
		signRequest: () => ({}),
		apiUrl: "https://devora.example",
	})
	try {
		expect((await fetcher.getConfig())?.blockedEndpoints).toHaveLength(1)
		serverVersion = 2
		// Changing the server policy does not push an invalidation into this process.
		expect((await fetcher.getConfig())?.blockedEndpoints).toHaveLength(1)
		expect(requests).toBe(1)
		expect((await fetcher.refresh())?.blockedEndpoints).toHaveLength(0)
		expect(requests).toBe(2)
	} finally {
		fetcher.stop()
	}
})

test("real HTTP policy revalidation accepts 304 on the deployed Bun runtime", async () => {
	globalThis.fetch = originalFetch
	let requests = 0
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			requests++
			return request.headers.get("if-none-match") === '"policy-v1"'
				? new Response(null, { status: 304 })
				: Response.json(
						{
							success: true,
							data: {
								version: 1,
								safeReadEndpoints: [],
								blockedEndpoints: [],
								cachedUntil: Date.now() + 300_000,
							},
						},
						{ headers: { etag: '"policy-v1"' } }
					)
		},
	})
	const sdk = devoraSDK({
		...TEST_KEYS,
		apiUrl: `http://127.0.0.1:${server.port}`,
		environment: "test",
	})
	try {
		await sdk.ready
		await sdk.refreshScopeConfig()
		await sdk.refreshScopeConfig()
		expect(requests).toBe(3)
		expect(sdk.getCachedScopeConfig()?.version).toBe(1)
		expect(sdk.getCachedScopeConfig()!.cachedUntil - Date.now()).toBeGreaterThan(240_000)
	} finally {
		sdk.destroy()
		await server.stop(true)
	}
})

test("real HTTP redirect responses never forward signed headers to a target", async () => {
	globalThis.fetch = originalFetch
	let targetRequests = 0
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url)
			if (url.pathname === "/target") {
				targetRequests++
				return Response.json({ success: true })
			}
			return new Response(null, {
				status: Number(url.pathname.slice(1)),
				headers: { location: new URL("/target", url).href },
			})
		},
	})
	try {
		for (const status of [300, 301, 302, 303, 305, 307, 308]) {
			await expect(
				controlPlaneFetch(`http://127.0.0.1:${server.port}/${status}`, {
					method: "POST",
					headers: { "X-Devora-Signature": "synthetic-only" },
					body: "synthetic-only",
				})
			).rejects.toThrow("Control-plane redirects are not allowed")
		}
		expect(targetRequests).toBe(0)
	} finally {
		await server.stop(true)
	}
})

test("concurrent requests during a liveness outage share one lookup and get a 503", async () => {
	let statusCalls = 0
	globalThis.fetch = async (input) => {
		const url = String(input)
		if (url.includes("scope-config")) return scopeConfigResponse()
		if (url.includes("session-status")) {
			statusCalls++
			await new Promise((resolve) => setTimeout(resolve, 20))
			return new Response("rate limited", { status: 429 })
		}
		return new Response("not found", { status: 404 })
	}
	const sdk = createBackendSDK()
	await sdk.ready
	const guard = createImpersonationGuard({
		sdk,
		getImpersonationContext: () => trustedContext("write", "sess_outage"),
		showWarnings: false,
	})
	const results = await Promise.all(
		Array.from({ length: 5 }, () => runGuard(guard, { method: "GET", path: "/api/items" }))
	)
	expect(statusCalls).toBe(1)
	for (const result of results) {
		expect(result.statusCode).toBe(503)
		expect(result.body?.errorCode).toBe("IMPERSONATION_LIVENESS_UNAVAILABLE")
	}
})

test("a 404 from session-status is a definitive not-live verdict", async () => {
	globalThis.fetch = async (input) => {
		const url = String(input)
		if (url.includes("scope-config")) return scopeConfigResponse()
		return new Response("not found", { status: 404 })
	}
	const sdk = createBackendSDK()
	await sdk.ready
	const guard = createImpersonationGuard({
		sdk,
		getImpersonationContext: () => trustedContext("write", "sess_missing"),
		showWarnings: false,
	})
	const { statusCode, body } = await runGuard(guard, { method: "GET", path: "/api/items" })
	expect(statusCode).toBe(401)
	expect(body?.errorCode).toBe("IMPERSONATION_SESSION_ENDED")
})

test("production requires a replayStore; development may omit it", () => {
	expect(resolveEnvironment("production")).toBe("production")
	expect(resolveEnvironment("development")).toBe("development")
	expect(() => devoraSDK({ apiKey, secretKey, orgId, environment: "production" })).toThrow(
		/replayStore is required in production/
	)
	expect(() => devoraSDK({ apiKey, secretKey, orgId, environment: "development" })).not.toThrow()
	let consumed = 0
	const sdk = devoraSDK({
		apiKey,
		secretKey,
		orgId,
		environment: "production",
		replayStore: {
			async consume() {
				consumed++
				return true
			},
		},
	})
	expect(sdk).toBeDefined()
	expect(consumed).toBe(0)
})

test("Next.js guard forwards isImpersonationAllowed", async () => {
	const sdk = createNextBackendSDK({ apiKey, secretKey, orgId })
	await sdk.ready
	const handler = withDevoraGuard(async () => new Response("ok"), {
		sdk,
		enforceLiveness: false,
		showWarnings: false,
		getImpersonationContext: () => trustedContext("write"),
		isImpersonationAllowed: (request) => !request.url.includes("/api/payouts"),
	})
	const blocked = await handler(
		new Request("https://app.example.com/api/payouts", { method: "POST" }),
		undefined
	)
	expect(blocked.status).toBe(403)
	const allowed = await handler(
		new Request("https://app.example.com/api/items", { method: "POST" }),
		undefined
	)
	expect(allowed.status).toBe(200)
})

test("createBrowserResumeCode signs the request with the server secret and consumes one request id", async () => {
	let captured: { url: string; headers: Record<string, string>; body: string } | null = null
	globalThis.fetch = async (input, init) => {
		const url = String(input)
		if (url.includes("scope-config")) return scopeConfigResponse()
		captured = {
			url,
			headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
			body:
				init?.body instanceof Uint8Array
					? new TextDecoder().decode(init.body)
					: String(init?.body ?? ""),
		}
		return new Response(
			JSON.stringify({
				success: true,
				data: { code: "c".repeat(43), expiresAt: Date.now() + 30_000 },
			}),
			{ status: 200 }
		)
	}
	const sdk = createBackendSDK()
	await sdk.ready
	const result = await sdk.createBrowserResumeCode({
		sessionId: "sess_1",
		tabRef: "devora_tab_1",
		origin: "http://localhost:5001",
	})
	expect(result && "code" in result ? result.code : null).toBe("c".repeat(43))
	expect(captured).not.toBeNull()
	const { headers, body, url } = captured!
	expect(url.endsWith(BROWSER_SESSION_BRIDGE.RESUME_CODE_ENDPOINT)).toBe(true)
	// Re-sign the exact bytes independently: customer-to-devora, v3.
	const expected = signTestRequest({
		direction: "customer-to-devora",
		method: "POST",
		path: BROWSER_SESSION_BRIDGE.RESUME_CODE_ENDPOINT,
		body,
		sentAt: headers[SECURITY_HEADERS.SENT_AT],
		requestId: headers[SECURITY_HEADERS.REQUEST_ID],
	})
	expect(headers[SECURITY_HEADERS.SIGNATURE]).toBe(expected.headers["x-devora-signature"])
	expect(headers[SECURITY_HEADERS.SIGNATURE_VERSION]).toBe("3")
	expect(headers["X-Devora-Key"]).toBeUndefined()
	expect(JSON.parse(body)).toEqual({
		sessionId: "sess_1",
		tabRef: "devora_tab_1",
		origin: "http://localhost:5001",
	})
})

test("resolveBrowserSession never contacts Devora for ordinary sessions and maps outcomes", async () => {
	let calls = 0
	globalThis.fetch = async (input) => {
		const url = String(input)
		if (url.includes("scope-config")) return scopeConfigResponse()
		calls++
		return new Response("down", { status: 503 })
	}
	const sdk = createBackendSDK()
	await sdk.ready
	const none = await resolveBrowserSession(sdk, {
		context: null,
		tabRef: "devora_tab_1",
		origin: "http://localhost:5001",
	})
	expect(none).toEqual({ status: 200, body: { status: "none" } })
	expect(calls).toBe(0)
	const badTab = await resolveBrowserSession(sdk, {
		context: trustedContext("read"),
		tabRef: "x",
		origin: "http://localhost:5001",
	})
	expect(badTab.status).toBe(400)
	const badOrigin = await resolveBrowserSession(sdk, {
		context: trustedContext("read"),
		tabRef: "devora_tab_1",
		origin: "https://evil.example",
		allowedOrigins: ["http://localhost:5001"],
	})
	expect(badOrigin.status).toBe(403)
	const outage = await resolveBrowserSession(sdk, {
		context: trustedContext("read"),
		tabRef: "devora_tab_1",
		origin: "http://localhost:5001",
		allowedOrigins: ["http://localhost:5001"],
	})
	expect(outage.body).toEqual({ status: "blocked", reason: "control_plane_unavailable" })
	expect(calls).toBe(1)
	const expired = await resolveBrowserSession(sdk, {
		context: { ...trustedContext("read"), expiresAt: Date.now() - 1 },
		tabRef: "devora_tab_1",
		origin: "http://localhost:5001",
		allowedOrigins: ["http://localhost:5001"],
	})
	expect(expired.body).toEqual({ status: "blocked", reason: "session_invalid" })
})

test("the browser-session bridge path is allowed for a read-only session only when configured", async () => {
	const sdk = createBackendSDK()
	await sdk.ready
	const unconfigured = createImpersonationGuard({
		sdk,
		getImpersonationContext: () => trustedContext("read"),
		enforceLiveness: false,
		showWarnings: false,
	})
	// Off by default: an unmounted bridge path is an ordinary read-scope write.
	expect(
		(await runGuard(unconfigured, { method: "POST", path: BROWSER_SESSION_BRIDGE.PATH })).statusCode
	).toBe(403)
	const guard = createImpersonationGuard({
		sdk,
		getImpersonationContext: () => trustedContext("read"),
		enforceLiveness: false,
		showWarnings: false,
		bridgePath: BROWSER_SESSION_BRIDGE.PATH,
	})
	const bridge = await runGuard(guard, { method: "POST", path: BROWSER_SESSION_BRIDGE.PATH })
	expect(bridge.nextCalled).toBe(true)
	const other = await runGuard(guard, { method: "POST", path: "/api/devora/other" })
	expect(other.statusCode).toBe(403)
})

test("a discarded SDK instance never forces a reloaded tab to regenerate its reference", async () => {
	// React StrictMode constructs and discards an extra SDK instance; it reads the
	// same stored reference but never initialises. It must not answer claims.
	const discarded = new TabCoordinator({ initialTabRef: "devora_tab_stored" })
	const live = new TabCoordinator({ initialTabRef: "devora_tab_stored" })
	expect(await live.claimTabRef()).toBe("devora_tab_stored")
	// A second context that really claimed the same reference does force a new one.
	const clone = new TabCoordinator({ initialTabRef: "devora_tab_stored" })
	const regenerated = await clone.claimTabRef()
	expect(regenerated).not.toBe("devora_tab_stored")
	expect(regenerated).toMatch(/^devora_tab_/)
	discarded.destroy()
	live.destroy()
	clone.destroy()
})
