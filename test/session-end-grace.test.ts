// Devora keeps data a tab recorded before a session ended for 60 s
// (its late-data grace window). The SDK must learn of the end
// quickly and deliver its final capture inside that window.
import { afterEach, expect, spyOn, test } from "bun:test"
import { ActivityLogger } from "../browser/src/activity-logger"
import { resolveMasking } from "../browser/src/masking"
import { PresenceHeartbeat } from "../browser/src/presence-heartbeat"
import { SessionRecorder } from "../browser/src/session-recorder"
import { createDevoraSDK } from "../browser/src/sdk"
import { restoreNetworkLayer } from "../browser/src/scope-enforcer"

const nativeFetch = globalThis.fetch
const sdks: ReturnType<typeof createDevoraSDK>[] = []
afterEach(async () => {
	for (const sdk of sdks.splice(0)) await sdk.destroy()
	restoreNetworkLayer()
	globalThis.fetch = nativeFetch
})

test("an activity upload stored after the end tells the tab to end locally", async () => {
	let ended = 0
	const logger = new ActivityLogger({
		apiUrl: "https://devora.invalid",
		apiKey: "pk_client_test",
		sessionId: "session",
		devoraSessionToken: "synthetic-capability",
		tabId: "tab",
		masking: resolveMasking(undefined),
		captureErrors: false,
		captureCustomEvents: true,
		onSessionEnded: () => ended++,
	}) as any
	logger.running = true
	globalThis.fetch = async () => Response.json({ success: true, stored: 1, sessionEnded: true })
	logger.logCustomAction({ type: "custom", action: "save" })
	await logger.flush()
	expect(ended).toBe(1)
	globalThis.fetch = async () => Response.json({ success: true, stored: 1 })
	logger.logCustomAction({ type: "custom", action: "save" })
	await logger.flush()
	expect(ended).toBe(1)
})

test("a recording upload stored after the end tells the tab to end locally", async () => {
	let ended = 0
	const recorder = new SessionRecorder({
		apiUrl: "https://devora.invalid",
		apiKey: "pk_client_test",
		sessionId: "session",
		devoraSessionToken: "capability",
		onSessionEnded: () => ended++,
	}) as any
	globalThis.fetch = async () => Response.json({ success: true, sessionEnded: true })
	recorder.enqueueRecordingEvent({
		type: 4,
		timestamp: 100,
		data: { href: "/", width: 1, height: 1 },
	})
	await recorder.flush()
	expect(ended).toBe(1)
})

test("a refused heartbeat asks for a session check; other failures do not", async () => {
	for (const [status, expected] of [
		[401, [401]],
		[409, [409]],
		[500, []],
	] as const) {
		const rejected: number[] = []
		const beat = new PresenceHeartbeat({
			apiUrl: "https://devora.invalid",
			apiKey: "pk_client_test",
			sessionId: "session",
			devoraSessionToken: "synthetic-capability",
			onRejected: (code) => rejected.push(code),
		}) as any
		globalThis.fetch = async () => Response.json({ success: false }, { status })
		await beat.send()
		expect(rejected).toEqual([...expected])
	}
})

test("an end from elsewhere holds host logout for the final capture, at most one second", async () => {
	let onSessionEnded: (() => void) | undefined
	let finish!: () => void
	const acquire = spyOn(SessionRecorder, "acquire").mockImplementation(((config: any) => {
		onSessionEnded = config.onSessionEnded
		return {
			start() {},
			stop() {
				return new Promise<void>((resolve) => {
					finish = resolve
				})
			},
		}
	}) as never)
	try {
		let revoked = false
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input)
			if (url.endsWith("/end-session")) revoked = true
			if (url.endsWith("/browser-resume"))
				return Response.json({
					success: true,
					data: {
						scopePolicy: {
							version: 1,
							safeReadEndpoints: [],
							blockedEndpoints: [],
							cachedUntil: Date.now() + 60_000,
						},
						sessionId: "grace_session",
						devoraSessionToken: "synthetic_capability",
						scope: "read",
						expiresAt: Date.now() + 600_000,
						recordingEnabled: true,
					},
				})
			return Response.json({ success: true })
		}) as typeof fetch
		const sdk = createDevoraSDK()
		sdks.push(sdk)
		let loggedOut = 0
		await sdk.init({
			apiKey: "pk_client_live_grace_regression",
			apiUrl: "https://devora.example",
			autoDetect: false,
			showWarnings: false,
			onSessionEnd: () => {
				loggedOut++
			},
			sessionBridge: { restore: async () => ({ status: "resume", code: "r".repeat(43) }) },
		} as never)
		expect(sdk.isImpersonating()).toBe(true)
		expect(onSessionEnded).toBeDefined()
		onSessionEnded!()
		expect(sdk.isImpersonating()).toBe(false)
		await new Promise((resolve) => setTimeout(resolve, 20))
		// Devora already knows; the tab sends no second revocation, and waits for capture.
		expect(revoked).toBe(false)
		expect(loggedOut).toBe(0)
		finish()
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(loggedOut).toBe(1)
	} finally {
		acquire.mockRestore()
	}
})
