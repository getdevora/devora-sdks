import { afterEach, expect, test } from "bun:test"
import { tryKeepaliveFetch, availableKeepaliveBytes } from "../browser/src/keepalive"
import { RecordingDeniedError, SessionRecorder } from "../browser/src/session-recorder"
import { ActivityLogger } from "../browser/src/activity-logger"
import { resolveMasking } from "../browser/src/masking"
import { compressRecordingEvents } from "../browser/src/recording-encoding"

const nativeFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = nativeFetch
})
const config = {
	apiKey: "pk_client_live_test",
	apiUrl: "https://devora.invalid",
	sessionId: "session",
	devoraSessionToken: "capability",
}
const event = (i: number) => ({
	type: 3,
	timestamp: 100 + i,
	data: { source: 0, text: "x".repeat(8000) },
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test("recording and activity reserve a shared UTF-8 budget with space for a notice", async () => {
	const releases: Array<(response: Response) => void> = []
	const sizes: number[] = []
	globalThis.fetch = (async (_url, init) => {
		sizes.push(new TextEncoder().encode(String(init?.body)).byteLength)
		return new Promise<Response>((resolve) => releases.push(resolve))
	}) as typeof fetch
	const recording = tryKeepaliveFetch(
		"https://devora.invalid/chunk",
		{ body: "é".repeat(24_000) },
		"recording"
	)!
	expect(availableKeepaliveBytes("recording")).toBe(0)
	expect(tryKeepaliveFetch("https://devora.invalid/chunk", { body: "x" }, "recording")).toBeNull()
	const activity = tryKeepaliveFetch(
		"https://devora.invalid/logs",
		{ body: "x".repeat(4_000) },
		"activity"
	)!
	const notice = tryKeepaliveFetch(
		"https://devora.invalid/incomplete",
		{ body: "x".repeat(4_000) },
		"notice"
	)!
	expect(sizes.reduce((a, b) => a + b, 0)).toBe(56_000)
	const revocation = tryKeepaliveFetch(
		"https://devora.invalid/end-session",
		{ body: "x".repeat(4_000) },
		"revocation"
	)!
	expect(sizes.reduce((a, b) => a + b, 0)).toBe(60_000)
	expect(
		tryKeepaliveFetch("https://devora.invalid/end-session", { body: "x" }, "revocation")
	).toBeNull()
	expect(tryKeepaliveFetch("https://devora.invalid/logs", { body: "x" }, "activity")).toBeNull()
	for (const release of releases) release(Response.json({ success: true }))
	await Promise.all([recording, activity, notice, revocation])
	expect(availableKeepaliveBytes("recording")).toBe(48_000)
})

test("a rejected keepalive releases its reservation", async () => {
	globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch
	const pending = tryKeepaliveFetch(
		"https://devora.invalid/chunk",
		{ body: "x".repeat(48_000) },
		"recording"
	)!
	await expect(pending).rejects.toThrow("Failed to fetch")
	expect(availableKeepaliveBytes("recording")).toBe(48_000)
})

test("bounded final capture uses keepalive without changing ordinary uploads", async () => {
	const keepalive: Array<boolean | undefined> = []
	globalThis.fetch = (async (_url, init) => {
		keepalive.push(init?.keepalive)
		return Response.json({ success: true })
	}) as typeof fetch
	const recorder = new SessionRecorder(config) as any
	await recorder.sendChunk([event(0)], false, 0)
	await recorder.sendChunk([event(1)], true, 1)
	expect(keepalive).toEqual([undefined, true])
	expect(availableKeepaliveBytes("revocation")).toBe(60_000)
})

test("oversized final capture does not exceed the keepalive budget", async () => {
	let keepalive: boolean | undefined
	let size = 0
	globalThis.fetch = (async (_url, init) => {
		keepalive = init?.keepalive
		size = new TextEncoder().encode(String(init?.body)).byteLength
		return Response.json({ success: true })
	}) as typeof fetch
	const recorder = new SessionRecorder(config) as any
	const largeEvent = event(0)
	largeEvent.data.text = Buffer.from(crypto.getRandomValues(new Uint8Array(50_000))).toString(
		"base64"
	)
	await recorder.sendChunk(
		[largeEvent],
		true,
		0,
		0,
		0,
		await compressRecordingEvents([largeEvent] as any)
	)
	expect(size).toBeGreaterThan(48_000)
	expect(keepalive).toBeUndefined()
	expect(availableKeepaliveBytes("revocation")).toBe(60_000)
})

test("final keepalive still fails closed when recording authorization is revoked", async () => {
	globalThis.fetch = (async () =>
		Response.json({ error: "revoked" }, { status: 401 })) as typeof fetch
	const recorder = new SessionRecorder(config) as any
	await expect(recorder.sendChunk([event(0)], true, 0)).rejects.toBeInstanceOf(RecordingDeniedError)
	expect(availableKeepaliveBytes("revocation")).toBe(60_000)
})

test("unload sends one bounded prefix, retains unsent events, and reports a gap", async () => {
	let release!: (response: Response) => void
	const calls: Array<{ url: string; body: any; bytes: number }> = []
	const gaps: string[] = []
	globalThis.fetch = (async (url, init) => {
		calls.push({
			url: String(url),
			body: JSON.parse(String(init?.body)),
			bytes: new TextEncoder().encode(String(init?.body)).byteLength,
		})
		if (String(url).endsWith("/chunk"))
			return new Promise<Response>((resolve) => {
				release = resolve
			})
		return Response.json({ success: true })
	}) as typeof fetch
	const recorder = new SessionRecorder({
		...config,
		onCaptureIncomplete: (reason) => gaps.push(reason),
	}) as any
	recorder.events = Array.from({ length: 1000 }, (_, i) => event(i))
	recorder.flushSync(true)
	expect(calls.filter((c) => c.url.endsWith("/chunk"))).toHaveLength(1)
	expect(calls.reduce((n, c) => n + c.bytes, 0)).toBeLessThanOrEqual(56_000)
	expect(recorder.events.length + recorder.failedChunk.events.length).toBe(1000)
	expect(recorder.failedChunk.isFinal).toBe(false)
	expect(gaps).toEqual(["unload_delivery_uncertain"])
	expect(
		calls.some(
			(c) => c.url.endsWith("/incomplete") && c.body.reasonCode === "unload_delivery_uncertain"
		)
	).toBe(true)
	const pending = recorder.keepaliveUpload
	release(Response.json({ success: true }))
	await pending
	expect(recorder.failedChunk).toBeNull()
	expect(recorder.events.length).toBeGreaterThan(0)
	await tick()
})

test("an asynchronous refusal retains the same chunk index for a normal retry", async () => {
	const indices: number[] = []
	let denied = true
	const gaps: string[] = []
	globalThis.fetch = (async (url, init) => {
		if (String(url).endsWith("/chunk")) {
			indices.push(JSON.parse(String(init?.body)).chunkIndex)
			if (denied) {
				denied = false
				throw new TypeError("keepalive refused")
			}
		}
		return Response.json({ success: true })
	}) as typeof fetch
	const recorder = new SessionRecorder({
		...config,
		onCaptureIncomplete: (reason) => gaps.push(reason),
	}) as any
	recorder.events = [event(0)]
	recorder.flushSync(true)
	await recorder.keepaliveUpload
	expect(recorder.failedChunk.chunkIndex).toBe(0)
	expect(gaps).toEqual(["unload_delivery_uncertain"])
	await recorder.flush()
	expect(indices).toEqual([0, 0])
	expect(recorder.failedChunk).toBeNull()
	await tick()
})

test("activity leaves queued events intact when the shared budget is exhausted", async () => {
	let release!: (response: Response) => void
	globalThis.fetch = (async () =>
		new Promise<Response>((resolve) => {
			release = resolve
		})) as typeof fetch
	const held = tryKeepaliveFetch(
		"https://devora.invalid/notice",
		{ body: "x".repeat(56_000) },
		"notice"
	)!
	const logger = new ActivityLogger({
		...config,
		masking: resolveMasking(undefined),
		captureErrors: false,
		captureCustomEvents: false,
	}) as any
	logger.queue = [{ type: "page_view", description: "page", timestamp: 100 }]
	await logger.flush(true)
	expect(logger.queue).toHaveLength(1)
	release(Response.json({ success: true }))
	await held
})
