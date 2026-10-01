/** Local regression cases from the post-implementation security review.
 * No sockets or application services; run after rebuilding SDK artifacts. */
import { afterEach, expect, test } from "bun:test"
import {
	parseVerifiedJsonBody,
	isValidSignedPath,
	isValidSignedQuery,
	SIGNED_HEADER_PATTERNS,
	strictEncode,
} from "../core/src/security/signing"
import { createImpersonationGuard } from "../node/src/middleware"
import { normalizeCustomAction, describeCapturedError } from "../browser/src/capture-privacy"
import { resolveMasking } from "../browser/src/masking"
import {
	requestExchangeVerifier,
	getExchangeCodeFromURL,
	getExchangeVerifier,
	cleanURL,
	hasExchangeParameterInURL,
	hasUntakenExchangeInURL,
	settleExchange,
} from "../browser/src/token-detector"
import { createExchangeWindow } from "./support/exchange-window"
import { SDK_DEFAULTS } from "../core/src/constants/index"

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
afterEach(() => {
	if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
	else Reflect.deleteProperty(globalThis, "window")
})

test("signed JSON rejects ambiguous objects and non-finite numbers", () => {
	for (const text of [
		'{"scope":"read","scope":"write"}',
		'{"x":{"a":1,"\\u0061":2}}',
		'[{"a":1,"a":2}]',
		'{"x":1e999}',
		'{"x":NaN}',
		"\uFEFF{}",
	])
		expect(parseVerifiedJsonBody(new TextEncoder().encode(text), "application/json").ok).toBe(false)
	const result = parseVerifiedJsonBody(
		new TextEncoder().encode('{"__proto__":{"admin":true},"a":[{"b":1}]}'),
		"application/json"
	)
	expect(result.ok).toBe(true)
	if (!result.ok) return
	const value = result.value as any
	expect(Object.getPrototypeOf(value)).toBeNull()
	expect(Object.getPrototypeOf(value.__proto__)).toBeNull()
	expect(Object.getPrototypeOf(value.a[0])).toBeNull()
	expect(({} as any).admin).toBeUndefined()
})

test("signing rejects hidden newlines, URL delimiters, encoded dot segments and invalid UTF-8", () => {
	for (const path of ["/x\n", "/x?y", "/x#y", "/x\\y", "/x/%2E", "/x/.%2E", "/x/%2E%2E"])
		expect(isValidSignedPath(path)).toBe(false)
	for (const query of ["q=%FF", "q=%ED%A0%80", "q=ok\n"])
		expect(isValidSignedQuery(query)).toBe(false)
	expect(isValidSignedPath("/user/a%2Fb")).toBe(true)
	expect(isValidSignedQuery("a=2&a=1&term=a?b")).toBe(true)
	expect(SIGNED_HEADER_PATTERNS.signature.test("a".repeat(64) + "\n")).toBe(false)
	expect(SIGNED_HEADER_PATTERNS.orgId.test("org\n")).toBe(false)
	expect(() => strictEncode("\uD800")).toThrow()
})

test("full capture does not leak arbitrary action labels, numeric metadata or error names", () => {
	const rules = resolveMasking(undefined)
	const normalized = normalizeCustomAction(
		{
			type: "AliceSmith",
			action: "Patient has a medical condition",
			metadata: { AliceSmith: 123456789, age: 39 },
		},
		rules
	)
	expect(normalized.type).toBe("custom")
	expect(normalized.action).toBe("Custom action")
	expect(normalized.metadata).toEqual({ redacted: true })
	expect(describeCapturedError("AliceSmith", "private", rules)).toBe("Error")
	expect(describeCapturedError("TypeError", "private", rules)).toBe("TypeError")
})

test("an attacker opener cannot supply a valid-looking exchange verifier", async () => {
	// Only the dashboard this build targets is trusted: a production build
	// never accepts a different dashboard, and the reverse.
	const other =
		SDK_DEFAULTS.DASHBOARD_ORIGIN === "https://app.devora.sh"
			? "https://dashboard.example"
			: "https://app.devora.sh"
	for (const origin of [
		"https://attacker.example",
		`${SDK_DEFAULTS.DASHBOARD_ORIGIN}.attacker.example`,
		"null",
		"http://localhost:3001",
		other,
	]) {
		const { win } = createExchangeWindow({ openerOrigin: origin })
		Object.defineProperty(globalThis, "window", { configurable: true, value: win })
		expect(await requestExchangeVerifier(10)).toBeNull()
		expect(win.opener).toBeNull()
	}
	for (const origin of [SDK_DEFAULTS.DASHBOARD_ORIGIN]) {
		const { win } = createExchangeWindow({ openerOrigin: origin })
		Object.defineProperty(globalThis, "window", { configurable: true, value: win })
		const handshake = requestExchangeVerifier(100)
		// Clearing the global reference does not break the private handshake.
		expect(win.opener).toBeNull()
		expect(await handshake).toBe("v".repeat(43))
		expect(win.opener).toBeNull()
	}
})

test("every exchange parameter is scrubbed while hash router state is preserved", async () => {
	cleanURL()
	const code = "x".repeat(48)
	const { win, location } = createExchangeWindow({
		url: `https://customer.example/#/home?devora_exchange=${code}&devora_exchange=${"y".repeat(48)}&view=1`,
	})
	Object.defineProperty(globalThis, "window", { configurable: true, value: win })
	expect(getExchangeCodeFromURL()).toBe(code)
	expect(location.hash).toBe("#/home?view=1")
	await getExchangeVerifier()
	cleanURL()
})

test("apps see a pending exchange until the SDK settles it, but init takes it only once", async () => {
	cleanURL()
	settleExchange()
	const { win } = createExchangeWindow()
	Object.defineProperty(globalThis, "window", { configurable: true, value: win })
	expect(hasExchangeParameterInURL()).toBe(true)
	expect(hasUntakenExchangeInURL()).toBe(true)
	await getExchangeVerifier()
	// init takes the exchange: a second init (e.g. StrictMode) must not take it again...
	cleanURL()
	expect(hasUntakenExchangeInURL()).toBe(false)
	// ...but the app must still hold back its login redirect while it is redeemed.
	expect(hasExchangeParameterInURL()).toBe(true)
	settleExchange()
	expect(hasExchangeParameterInURL()).toBe(false)
})

test("Express mount-relative deny rules block both scopes before handler side effects", async () => {
	for (const scope of ["read", "write"] as const) {
		let effects = 0
		let status = 0
		const guard = createImpersonationGuard({
			sdk: {
				getScopeConfig: async () => ({
					blockedEndpoints: [{ method: "POST", pattern: "/admin/**" }],
					safeReadEndpoints: [],
				}),
			} as any,
			enforceLiveness: false,
			showWarnings: false,
			getImpersonationContext: () => ({
				isImpersonation: true,
				scope,
				sessionId: "s",
				expiresAt: Date.now() + 60_000,
				actor: { id: "agent" },
				subject: { id: "user" },
				authMethod: "devora_impersonation",
				authorizationSource: "standard",
				recordingAllowed: true,
			}),
		})
		const response = {
			status(code: number) {
				status = code
				return response
			},
			json() {},
		}
		await guard(
			{
				method: "POST",
				path: "/admin/delete",
				url: "/admin/delete",
				baseUrl: "/v1",
				originalUrl: "/v1/admin/delete",
			},
			response,
			() => {
				effects++
			}
		)
		expect(status).toBe(403)
		expect(effects).toBe(0)
	}
})

test("a _method query override is judged, so method-override middleware after the guard cannot upgrade a POST", async () => {
	const { getPolicyMethods } = await import("../core/src/security/index")
	expect(getPolicyMethods("POST", {}, "/api/items/7?_method=DELETE")).toEqual(["POST", "DELETE"])
	expect(getPolicyMethods("POST", {}, "/api/items/7?x=1#_method=DELETE")).toEqual(["POST"])
	expect(getPolicyMethods("POST", { "x-http-method-override": "PATCH" }, "/a?_method=put")).toEqual(
		["POST", "PATCH", "PUT"]
	)
})
