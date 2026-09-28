import { afterEach, expect, test, spyOn } from "bun:test"
import { createDevoraSDK } from "../browser/src/sdk.ts"
import { SessionRecorder } from "../browser/src/session-recorder.ts"
import { patchNetworkLayer, restoreNetworkLayer } from "../browser/src/scope-enforcer.ts"
import { EXCHANGE_CODE, EXCHANGE_VERIFIER, createExchangeWindow } from "./support/exchange-window"

const nativeFetch = globalThis.fetch
const descriptors = new Map<string, PropertyDescriptor | undefined>()
const sdkInstances: ReturnType<typeof createDevoraSDK>[] = []
function replaceGlobal(name: string, value: unknown) {
	if (!descriptors.has(name))
		descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
	Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}
afterEach(async () => {
	for (const sdk of sdkInstances.splice(0)) await sdk.destroy()
	restoreNetworkLayer()
	globalThis.fetch = nativeFetch
	for (const [name, descriptor] of descriptors) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor)
		else Reflect.deleteProperty(globalThis, name)
	}
	descriptors.clear()
})
const config = {
	apiKey: "pk_client_live_lifecycle_regression",
	apiUrl: "https://devora.example",
	autoDetect: false,
	showWarnings: false,
}
const snapshot = {
	scopePolicy: {
		version: 1,
		safeReadEndpoints: [],
		blockedEndpoints: [],
		cachedUntil: Date.now() + 60_000,
	},
	sessionId: "lifecycle_session",
	devoraSessionToken: "synthetic_capability",
	scope: "read",
	expiresAt: Date.now() + 600_000,
}
function sdkInstance() {
	const sdk = createDevoraSDK()
	sdkInstances.push(sdk)
	return sdk
}
function transport(end: () => Promise<Response>, recordingEnabled = false) {
	globalThis.fetch = async (input) => {
		if (String(input).endsWith("/end-session")) return await end()
		if (String(input).endsWith("/browser-resume"))
			return Response.json({ success: true, data: { ...snapshot, recordingEnabled } })
		if (String(input).endsWith("/exchange"))
			return Response.json({
				success: true,
				data: { ...snapshot, token: "synthetic_customer_token" },
			})
		return Response.json({
			success: true,
			data: {
				safeReadEndpoints: [],
				blockedEndpoints: [],
				version: 1,
				cachedUntil: Date.now() + 60_000,
			},
		})
	}
}
async function start(sdk: ReturnType<typeof sdkInstance>, extra = {}) {
	await sdk.init({
		...config,
		sessionBridge: { restore: async () => ({ status: "resume", code: "r".repeat(43) }) },
		...extra,
	})
	expect(sdk.isImpersonating()).toBe(true)
}

test("ordinary visits neither fetch policy nor wait on a dead policy endpoint", async () => {
	let calls = 0
	globalThis.fetch = () => {
		calls++
		return new Promise(() => {})
	}
	for (const sessionBridge of [undefined, { restore: async () => ({ status: "none" as const }) }]) {
		const sdk = sdkInstance()
		await sdk.init({ ...config, sessionBridge })
		expect(sdk.getBridgeState()).toEqual({ status: "none" })
	}
	expect(calls).toBe(0)
})

test("a transport ignoring abort cannot hold local logout or end() indefinitely", async () => {
	const releases: Array<(response: Response) => void> = []
	transport(() => new Promise<Response>((resolve) => releases.push(resolve)))
	const sdk = sdkInstance()
	let loggedOut = false
	await start(sdk, {
		onSessionEnd: () => {
			loggedOut = true
		},
	})
	const ending = sdk.end()
	expect(sdk.isImpersonating()).toBe(false)
	await Promise.resolve()
	expect(loggedOut).toBe(true)
	await ending
	expect(sdk.getRevocationState()).toMatchObject({
		status: "failed",
		sessionId: snapshot.sessionId,
	})
	// Simulate the abandoned transports eventually settling, so their shared
	// keepalive reservations cannot contaminate subsequent test documents.
	for (const release of releases) release(Response.json({ success: true }))
	await new Promise((resolve) => setTimeout(resolve, 0))
}, 10_000)

test("host navigation cannot defer revocation behind an unfinished capture flush", async () => {
	let finish!: () => void
	const acquire = spyOn(SessionRecorder, "acquire").mockReturnValue({
		start() {},
		stop() {
			return new Promise<void>((resolve) => {
				finish = resolve
			})
		},
	} as unknown as SessionRecorder)
	try {
		transport(async () => Response.json({ success: true }), true)
		const base = globalThis.fetch
		let sent = false
		globalThis.fetch = (async (url, init) => {
			if (String(url).endsWith("/end-session")) {
				expect(init?.keepalive).toBe(true)
				sent = true
			}
			return base(url, init)
		}) as typeof fetch
		const sdk = sdkInstance()
		await start(sdk, {
			onSessionEnd: () => {
				expect(sent).toBe(true)
			},
		})
		const ending = sdk.end()
		expect(sdk.isImpersonating()).toBe(false)
		await Promise.resolve()
		expect(sent).toBe(true)
		finish()
		await ending
		expect(sdk.getRevocationState().status).toBe("confirmed")
	} finally {
		acquire.mockRestore()
	}
})

test("revocation failures are truthful and retryable responses retry once", async () => {
	for (const status of [400, 401, 429, 500]) {
		let calls = 0
		transport(async () => {
			calls++
			return Response.json({ success: false }, { status })
		})
		const sdk = sdkInstance()
		await start(sdk)
		await sdk.end()
		expect(sdk.isImpersonating()).toBe(false)
		expect(sdk.getRevocationState()).toMatchObject({ status: "failed", httpStatus: status })
		expect(calls).toBe(status === 429 || status >= 500 ? 2 : 1)
	}
	let calls = 0
	transport(async () => {
		calls++
		return Response.json({ success: calls > 1 }, { status: calls > 1 ? 200 : 503 })
	})
	const sdk = sdkInstance()
	await start(sdk)
	await sdk.end()
	expect(sdk.getRevocationState().status).toBe("confirmed")
})

test("destroy retires capture synchronously and its pending flush cannot clear a newer init", async () => {
	let recording = false
	let finish!: () => void
	const acquire = spyOn(SessionRecorder, "acquire").mockReturnValue({
		start() {
			recording = true
		},
		stop() {
			recording = false
			return new Promise<void>((resolve) => {
				finish = resolve
			})
		},
	} as unknown as SessionRecorder)
	try {
		transport(async () => Response.json({ success: true }), true)
		const sdk = sdkInstance()
		await start(sdk)
		expect(recording).toBe(true)
		const cleanup = sdk.destroy()
		expect(recording).toBe(false)
		expect(sdk.isImpersonating()).toBe(false)
		await sdk.init(config)
		finish()
		await cleanup
		expect(sdk.isInitialized()).toBe(true)
	} finally {
		acquire.mockRestore()
	}
})

function installWindow(options: Parameters<typeof createExchangeWindow>[0] = {}) {
	const { win, location, openerMessages } = createExchangeWindow(options)
	class XHR extends EventTarget {
		opened = false
		sent = false
		open() {
			this.opened = true
		}
		send() {
			this.sent = true
		}
	}
	replaceGlobal("window", win)
	replaceGlobal("XMLHttpRequest", XHR)
	return { location, XHR, win, openerMessages }
}
test("init/destroy/init preserves a scrubbed link and redeems it only once", async () => {
	const { location } = installWindow()
	let exchanges = 0,
		handoffs = 0
	const bodies: Array<Record<string, unknown>> = []
	transport(async () => Response.json({ success: true }))
	const fetch = globalThis.fetch
	globalThis.fetch = async (input, init) => {
		if (String(input).endsWith("/exchange")) {
			exchanges++
			bodies.push(JSON.parse(String(init?.body)))
		}
		return fetch(input, init)
	}
	const sdk = sdkInstance()
	const cfg = {
		...config,
		autoDetect: true,
		onImpersonate: () => {
			handoffs++
		},
	}
	const first = sdk.init(cfg)
	const cleanup = sdk.destroy()
	const second = sdk.init(cfg)
	await Promise.all([first, cleanup, second])
	expect(location.href).not.toContain("devora_exchange")
	expect(exchanges).toBe(1)
	expect(bodies[0]).toMatchObject({ code: EXCHANGE_CODE, verifier: EXCHANGE_VERIFIER })
	expect(handoffs).toBe(1)
	expect(sdk.isImpersonating()).toBe(true)
})

test("a forwarded exchange link (no dashboard opener) is never redeemed", async () => {
	const { location } = installWindow({ withOpener: false })
	let exchanges = 0
	const errors: unknown[] = []
	transport(async () => Response.json({ success: true }))
	const fetch = globalThis.fetch
	globalThis.fetch = async (input, init) => {
		if (String(input).endsWith("/exchange")) exchanges++
		return fetch(input, init)
	}
	const sdk = sdkInstance()
	await sdk.init({
		...config,
		autoDetect: true,
		onError: { payloadError: (error: unknown) => errors.push(error) },
	})
	expect(location.href).not.toContain("devora_exchange")
	expect(exchanges).toBe(0)
	expect(errors).toHaveLength(1)
	expect(sdk.isImpersonating()).toBe(false)
})

test("the exchange code is scrubbed from the fragment keeping hash-router state; query codes are never redeemed", async () => {
	for (const [url, expected] of [
		[
			`https://customer.example/app#/orders?tab=2&devora_exchange=${EXCHANGE_CODE}`,
			"https://customer.example/app#/orders?tab=2",
		],
		[
			`https://customer.example/app#devora_exchange=${EXCHANGE_CODE}&k=v`,
			"https://customer.example/app#k=v",
		],
		[
			`https://customer.example/app?devora_exchange=${EXCHANGE_CODE}&q=1`,
			"https://customer.example/app?q=1",
		],
	] as const) {
		const { location } = installWindow({ url })
		let exchanges = 0
		transport(async () => Response.json({ success: true }))
		const fetch = globalThis.fetch
		globalThis.fetch = async (input, init) => {
			if (String(input).endsWith("/exchange")) exchanges++
			return fetch(input, init)
		}
		const sdk = sdkInstance()
		await sdk.init({ ...config, autoDetect: true })
		expect(location.href).toBe(expected)
		expect(exchanges).toBe(url.includes("?devora_exchange") ? 0 : 1)
		await sdk.destroy()
	}
})

test("retained network wrappers pass through after retirement and never reactivate", async () => {
	const { XHR } = installWindow()
	let nativeCalls = 0
	globalThis.fetch = async () => {
		nativeCalls++
		return Response.json({ ok: true })
	}
	const cfg = { ...config, enabled: true, scope: "read" as const, apiUrl: config.apiUrl }
	patchNetworkLayer(cfg)
	const retainedFetch = globalThis.fetch
	const retainedOpen = XHR.prototype.open
	const retainedSend = XHR.prototype.send
	globalThis.fetch = (...args) => retainedFetch(...args)
	XHR.prototype.open = function (...args) {
		return retainedOpen.apply(this, args)
	}
	XHR.prototype.send = function (...args) {
		return retainedSend.apply(this, args)
	}
	restoreNetworkLayer()
	await globalThis.fetch("https://customer.example/write", { method: "POST" })
	const xhr = new XHR()
	xhr.open()
	xhr.send()
	expect(xhr.sent).toBe(true)
	patchNetworkLayer(cfg)
	expect(
		(await globalThis.fetch("https://customer.example/write", { method: "POST" })).status
	).toBe(403)
	await retainedFetch("https://customer.example/write", { method: "POST" })
	expect(nativeCalls).toBe(2)
	restoreNetworkLayer()
})
