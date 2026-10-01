import { afterEach, expect, test } from "bun:test"
import type { eventWithTime } from "rrweb"
import { SessionRecorder } from "../browser/src/session-recorder"
import { availableKeepaliveBytes } from "../browser/src/keepalive"

// A server-rendered app's handoff: onImpersonate POSTs the token for a cookie,
// then `window.location.href = "/"`. The exchange page unloads while its first
// FullSnapshot is still uploading over an ordinary fetch.

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
const meta = { type: 4, timestamp: 100, data: { href: "/", width: 1, height: 1 } }
const snapshot = (text = "landing page ".repeat(200)) => ({
	type: 2,
	timestamp: 101,
	data: { node: { type: 0, id: 1, childNodes: [{ type: 3, id: 2, textContent: text }] } },
	initialOffset: { top: 0, left: 0 },
})

type Call = { url: string; keepalive?: boolean; body: any }

function harness(options: { holdOrdinary: boolean }) {
	const calls: Call[] = []
	const held: Array<(response: Response) => void> = []
	let holding = false
	globalThis.fetch = (async (url, init) => {
		const call = {
			url: String(url),
			keepalive: init?.keepalive,
			body: JSON.parse(String(init?.body)),
		}
		calls.push(call)
		// Hold only the first ordinary upload: the one the navigation interrupts.
		if (call.url.endsWith("/chunk") && !call.keepalive && options.holdOrdinary && !holding) {
			holding = true
			return new Promise<Response>((resolve) => held.push(resolve))
		}
		return Response.json({ success: true })
	}) as typeof fetch
	const gaps: string[] = []
	const recorder = new SessionRecorder({
		...config,
		onCaptureIncomplete: (reason) => gaps.push(reason),
	}) as any
	// A started recorder: rrweb's custom events land in the same queue.
	recorder.isRunning = true
	recorder.stopFn = () => {}
	recorder.recordFn = {
		addCustomEvent: (tag: string, payload: unknown) =>
			recorder.enqueueRecordingEvent({
				type: 5,
				timestamp: 102,
				data: { tag, payload },
			} as eventWithTime),
	}
	const chunks = () => calls.filter((c) => c.url.endsWith("/chunk"))
	const notices = () => calls.filter((c) => c.url.endsWith("/incomplete"))
	const release = () => {
		for (const resolve of held.splice(0)) resolve(Response.json({ success: true }))
	}
	return { recorder, calls, gaps, chunks, notices, release }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test("navigating away while the first snapshot uploads requeues it and the tail, without a gap", async () => {
	const h = harness({ holdOrdinary: true })
	h.recorder.enqueueRecordingEvent(meta)
	h.recorder.enqueueRecordingEvent(snapshot())
	const firstFlush = h.recorder.flush()
	// Let compression finish so the ordinary POST is on the wire.
	while (h.chunks().length === 0) await tick()
	expect(h.recorder.isFlushing).toBe(true)
	h.recorder.enqueueRecordingEvent({ ...meta, type: 3, timestamp: 103, data: { source: 1 } })

	h.recorder.handlePageHide({ persisted: false })

	const [ordinary, resent, tail] = h.chunks()
	expect(ordinary.keepalive).toBeUndefined()
	expect(resent.keepalive).toBe(true)
	expect(resent.body.chunkIndex).toBe(0)
	expect(resent.body.isFinal).toBe(false)
	// The server accepts a duplicate index only when the bytes are identical.
	expect(resent.body.eventsBase64).toBe(ordinary.body.eventsBase64)
	expect(resent.body.pageInstanceId).toBe(ordinary.body.pageInstanceId)
	expect(tail.keepalive).toBe(true)
	expect(tail.body.chunkIndex).toBe(1)
	expect(tail.body.isFinal).toBe(true)
	expect(h.chunks()).toHaveLength(3)
	expect(h.notices()).toHaveLength(0)
	expect(h.gaps).toEqual([])

	await h.recorder.keepaliveUpload
	h.release()
	await firstFlush
	await tick()
	expect(h.chunks()).toHaveLength(3)
	expect(h.notices()).toHaveLength(0)
	expect(h.gaps).toEqual([])
	expect(h.recorder.failedChunk).toBeNull()
	expect(h.recorder.keepaliveUpload).toBeNull()
	expect(availableKeepaliveBytes("recording")).toBe(48_000)
})

test("an upload the navigation cancelled before pagehide is requeued with the tail, without a gap", async () => {
	const h = harness({ holdOrdinary: false })
	const fetchOk = globalThis.fetch
	let cancel = true
	globalThis.fetch = (async (url, init) => {
		const response = await fetchOk(url, init)
		// Chrome rejects the page's ordinary fetches as navigation begins, before pagehide.
		if (String(url).endsWith("/chunk") && !init?.keepalive && cancel) {
			cancel = false
			throw new TypeError("Failed to fetch")
		}
		return response
	}) as typeof fetch
	h.recorder.enqueueRecordingEvent(meta)
	h.recorder.enqueueRecordingEvent(snapshot())
	await h.recorder.flush()
	expect(h.recorder.failedChunk?.chunkIndex).toBe(0)
	h.recorder.enqueueRecordingEvent({ ...meta, type: 3, timestamp: 103, data: { source: 1 } })

	h.recorder.handlePageHide({ persisted: false })

	const [ordinary, resent, tail] = h.chunks()
	expect(resent.keepalive).toBe(true)
	expect(resent.body.chunkIndex).toBe(0)
	expect(resent.body.eventsBase64).toBe(ordinary.body.eventsBase64)
	expect(tail.keepalive).toBe(true)
	expect(tail.body.chunkIndex).toBe(1)
	expect(tail.body.isFinal).toBe(true)
	expect(h.chunks()).toHaveLength(3)
	await h.recorder.keepaliveUpload
	await tick()
	expect(h.notices()).toHaveLength(0)
	expect(h.gaps).toEqual([])
	expect(h.recorder.failedChunk).toBeNull()
	expect(availableKeepaliveBytes("recording")).toBe(48_000)
})

test("an unload during compression pins the bytes the later ordinary upload reuses", async () => {
	const h = harness({ holdOrdinary: true })
	h.recorder.enqueueRecordingEvent(meta)
	h.recorder.enqueueRecordingEvent(snapshot())
	const firstFlush = h.recorder.flush()
	// Synchronously after flush(): the chunk is formed but still compressing.
	expect(h.recorder.uploadingChunk.precomputed).toBeUndefined()

	h.recorder.handlePageHide({ persisted: false })

	const [resent, tail] = h.chunks()
	expect(resent.keepalive).toBe(true)
	expect(resent.body.chunkIndex).toBe(0)
	expect(tail.body.chunkIndex).toBe(1)
	expect(tail.body.isFinal).toBe(true)
	expect(h.gaps).toEqual([])

	while (h.chunks().length < 3) await tick()
	const ordinary = h.chunks()[2]!
	expect(ordinary.keepalive).toBeUndefined()
	expect(ordinary.body.chunkIndex).toBe(0)
	expect(ordinary.body.eventsBase64).toBe(resent.body.eventsBase64)
	h.release()
	await firstFlush
	await tick()
	expect(h.notices()).toHaveLength(0)
	expect(h.gaps).toEqual([])
})

test("a persisted pagehide leaves the ordinary upload to finish", async () => {
	const h = harness({ holdOrdinary: true })
	h.recorder.enqueueRecordingEvent(meta)
	h.recorder.enqueueRecordingEvent(snapshot())
	const firstFlush = h.recorder.flush()
	while (h.chunks().length === 0) await tick()
	h.recorder.handlePageHide({ persisted: true })
	expect(h.chunks()).toHaveLength(1)
	expect(h.gaps).toEqual([])
	h.release()
	await firstFlush
	await tick()
	expect(h.gaps).toEqual([])
})

test("an in-flight upload that cannot be requeued still reports the gap", async () => {
	const h = harness({ holdOrdinary: true })
	h.recorder.enqueueRecordingEvent(meta)
	// Incompressible: exceeds the keepalive allowance once compressed.
	const noise = Buffer.from(crypto.getRandomValues(new Uint8Array(60_000))).toString("base64")
	h.recorder.enqueueRecordingEvent(snapshot(noise))
	const firstFlush = h.recorder.flush()
	while (h.chunks().length === 0) await tick()

	h.recorder.handlePageHide({ persisted: false })

	expect(h.chunks()).toHaveLength(1)
	expect(h.gaps).toEqual(["unload_delivery_uncertain"])
	expect(h.notices().map((c) => c.body.reasonCode)).toEqual(["unload_delivery_uncertain"])
	expect(h.notices()[0]!.keepalive).toBe(true)
	h.release()
	await firstFlush
	await tick()
})

test("a refused requeue after unload still reports the gap", async () => {
	const h = harness({ holdOrdinary: true })
	const fetchHeld = globalThis.fetch
	globalThis.fetch = (async (url, init) => {
		if (String(url).endsWith("/chunk") && init?.keepalive) {
			await fetchHeld(url, init)
			return Response.json({ error: "revoked" }, { status: 401 })
		}
		return fetchHeld(url, init)
	}) as typeof fetch
	h.recorder.enqueueRecordingEvent(meta)
	h.recorder.enqueueRecordingEvent(snapshot())
	const firstFlush = h.recorder.flush()
	while (h.chunks().length === 0) await tick()

	h.recorder.handlePageHide({ persisted: false })
	expect(h.gaps).toEqual([])
	await h.recorder.keepaliveUpload
	expect(h.gaps).toEqual(["unload_delivery_uncertain"])
	expect(h.notices().map((c) => c.body.reasonCode)).toEqual(["unload_delivery_uncertain"])
	h.release()
	await firstFlush
	await tick()
})
