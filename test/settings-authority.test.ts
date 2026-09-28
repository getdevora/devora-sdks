import { afterEach, expect, test, spyOn } from "bun:test"
import { createExchangeWindow } from "./support/exchange-window"
import { createDevoraSDK } from "../browser/src/sdk.ts"
import { SessionRecorder } from "../browser/src/session-recorder.ts"
import { restoreNetworkLayer } from "../browser/src/scope-enforcer.ts"

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
		if (String(input).endsWith("/browser-resume") || String(input).endsWith("/exchange"))
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

import { ActivityLogger } from "../browser/src/activity-logger.ts"
import { resolveMasking, buildRrwebPrivacyOptions } from "../browser/src/masking.ts"
const policy = {
	settingsOnly: true,
	policyVersion: 42,
	recordingPolicy: "all_sessions",
	activityPolicy: "all_sessions",
	recordingMaskingProfile: "full",
	recordingBlockMedia: true,
	recordingMaskSelectors: [],
	recordingBlockSelectors: [],
	recordingUnmaskRegions: [],
	recordingUnmaskSelectors: [],
	consoleErrorCaptureEnabled: false,
	activityCustomEventsEnabled: false,
} as const

function installExchangeWindow() {
	replaceGlobal("window", createExchangeWindow().win)
	replaceGlobal(
		"XMLHttpRequest",
		class extends EventTarget {
			open() {}
			send() {}
		}
	)
}

test("exchange and resume ignore injected capture settings both enabling and disabling", async () => {
	for (const flow of ["exchange", "resume"]) {
		for (const serverEnabled of [true, false]) {
			if (flow === "exchange") installExchangeWindow()
			else replaceGlobal("window", undefined)
			const configs: any[] = []
			const activity: any[] = []
			const acquire = spyOn(SessionRecorder, "acquire").mockImplementation((cfg) => {
				configs.push(cfg)
				return { start() {}, stop: async () => {} } as unknown as SessionRecorder
			})
			const activityStart = spyOn(ActivityLogger.prototype, "start").mockImplementation(
				function (this: any) {
					activity.push(this.options)
				}
			)
			try {
				transport(async () => Response.json({ success: true }))
				const ordinary = globalThis.fetch
				globalThis.fetch = (async (input, init) =>
					String(input).endsWith("/browser-resume") || String(input).endsWith("/exchange")
						? Response.json({
								success: true,
								data: {
									...snapshot,
									token: "synthetic_customer_token",
									capture: policy,
									recordingEnabled: serverEnabled,
									activityEnabled: serverEnabled,
									recordingAllowed: true,
								},
							})
						: ordinary(input, init)) as typeof fetch
				const sdk = sdkInstance()
				await start(sdk, {
					autoDetect: flow === "exchange",
					recordingEnabled: !serverEnabled,
					activityEnabled: !serverEnabled,
					recordingAllowed: !serverEnabled,
					recording: { enabled: !serverEnabled },
					activity: { enabled: !serverEnabled },
					masking: { profile: "minimal" },
					recordingMaskingProfile: "minimal",
					recordingBlockMedia: false,
					captureConsoleErrors: true,
					captureCustomEvents: true,
					consoleErrorCaptureEnabled: true,
					activityCustomEventsEnabled: true,
					privacy: buildRrwebPrivacyOptions(
						resolveMasking({ ...policy, recordingMaskingProfile: "minimal" })
					),
					capture: {
						...policy,
						recordingMaskingProfile: "minimal",
						consoleErrorCaptureEnabled: true,
						activityCustomEventsEnabled: true,
					},
				})
				expect(configs.length).toBe(serverEnabled ? 1 : 0)
				expect(activity.length).toBe(serverEnabled ? 1 : 0)
				if (serverEnabled) {
					expect(configs[0].captureConsoleErrors).toBe(false)
					expect(configs[0].captureCustomEvents).toBe(false)
					expect(configs[0].privacy.maskTextFn("SYNTHETIC_PRIVATE_TEXT", null)).not.toContain(
						"SYNTHETIC_PRIVATE_TEXT"
					)
					expect(activity[0].masking.profile).toBe("full")
					expect(activity[0].captureErrors).toBe(false)
					expect(activity[0].captureCustomEvents).toBe(false)
				}
				await sdk.destroy()
			} finally {
				acquire.mockRestore()
				activityStart.mockRestore()
			}
		}
	}
})

test("capture constructors and local privacy builders are absent from the public SDK", async () => {
	const sdk = await import("../browser/src/index.ts")
	for (const name of [
		"SessionRecorder",
		"ActivityLogger",
		"resolveMasking",
		"buildRrwebPrivacyOptions",
	]) {
		expect(name in sdk).toBe(false)
	}
})
test("new sessions ignore page markers unless the administrator selects them", () => {
	const element = {
		tagName: "DIV",
		closest: (selector: string) => (selector.includes("devora-mask") ? {} : null),
		getAttribute: () => null,
	} as any
	const snapshot = {
		...policy,
		recordingMaskingProfile: "minimal",
		recordingBlockMedia: false,
	} as const
	const rules = resolveMasking(snapshot)
	const privacy = buildRrwebPrivacyOptions(rules)
	expect(privacy.maskTextFn("VISIBLE", element)).toBe("VISIBLE")
	expect(rules.blockSelector).toBeUndefined()
	expect(privacy.ignoreClass).toBe("")
	expect(privacy.ignoreSelector).toBe(":not(*)")
	expect((privacy.maskTextClass as RegExp).test("devora-mask")).toBe(false)
	expect((privacy.blockClass as RegExp).test("devora-block")).toBe(false)
	const selected = buildRrwebPrivacyOptions(
		resolveMasking({ ...snapshot, recordingMaskSelectors: ["[data-devora-mask]"] })
	)
	expect(selected.maskTextFn("VISIBLE", element)).toBe("*******")
	const password = {
		tagName: "INPUT",
		getAttribute: (name: string) => (name === "type" ? "password" : null),
	} as any
	expect(privacy.maskInputFn("SECRET", password)).toBe("***")
	const legacy = buildRrwebPrivacyOptions(resolveMasking({ ...snapshot, settingsOnly: undefined }))
	expect(legacy.maskTextFn("VISIBLE", element)).toBe("*******")
})

test("Node initialization discards caller capture preferences", async () => {
	const { devoraSDK } = await import("../node/src/sdk.ts")
	transport(async () => Response.json({ success: true }))
	const sdk = devoraSDK({
		apiKey: "pk_server_live_" + "A".repeat(32),
		secretKey: "sk_server_live_" + "a".repeat(64),
		orgId: "org_test",
		environment: "test",
		apiUrl: "https://devora.example",
		recordingAllowed: false,
		recordingEnabled: true,
		masking: { profile: "minimal" },
		capture: { activityEnabled: true },
	} as any)
	await sdk.ready
	for (const key of ["recordingAllowed", "recordingEnabled", "masking", "capture"])
		expect(key in sdk.config).toBe(false)
})
