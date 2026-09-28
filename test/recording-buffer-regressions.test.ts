import { afterEach, expect, test } from "bun:test"
import { gunzipSync, strFromU8 } from "fflate"
import type { eventWithTime } from "rrweb"
import { SessionRecorder } from "../browser/src/session-recorder"
import {
	compressRecordingEvents,
	compressRecordingEventsSync,
	recordingEventBytes,
	recordingEventsBytes,
	recordingPrefixLength,
	MAX_RECORDING_QUEUE_BYTES,
	NORMAL_CHUNK_BYTES,
	RecordingEncodingLimitError,
} from "../browser/src/recording-encoding"

const nativeFetch = globalThis.fetch
const compressionDescriptor = Object.getOwnPropertyDescriptor(globalThis, "CompressionStream")
afterEach(() => {
	globalThis.fetch = nativeFetch
	if (compressionDescriptor)
		Object.defineProperty(globalThis, "CompressionStream", compressionDescriptor)
	else Reflect.deleteProperty(globalThis, "CompressionStream")
})
const config = {
	apiKey: "pk_client_live_test",
	apiUrl: "https://devora.invalid",
	sessionId: "session",
	devoraSessionToken: "capability",
}
const event = (i: number, text = "é".repeat(4096)) =>
	({
		type: 3,
		timestamp: 100 + i,
		data: { source: 0, texts: [{ id: i, value: text }], removes: [], adds: [], attributes: [] },
	}) as eventWithTime

test("chunk formation selects a byte-bounded prefix without compressing the whole queue", () => {
	const recorder = new SessionRecorder(config) as any
	const events = Array.from({ length: 1000 }, (_, i) => event(i))
	// Synthetic backlog bypasses the enqueue guard to isolate chunk formation.
	for (const e of events) recordingEventBytes(e)
	recorder.events = events
	recorder.pendingBytes = recordingEventsBytes(events) - 2
	const chunk = recorder.formChunk(false)
	expect(recordingEventsBytes(chunk.events)).toBeLessThanOrEqual(NORMAL_CHUNK_BYTES)
	expect(chunk.precomputed).toBeUndefined()
	expect(chunk.events.length + recorder.events.length).toBe(1000)
	expect(recorder.events[0].timestamp).toBe(chunk.events.at(-1).timestamp + 1)
	expect(recorder.pendingBytes).toBe(recordingEventsBytes(recorder.events) - 2)
})

test("queue limits include in-flight bytes and preserve a contiguous prefix", async () => {
	const reasons: string[] = []
	globalThis.fetch = (async () => Response.json({ success: true })) as typeof fetch
	const recorder = new SessionRecorder({
		...config,
		onCaptureIncomplete: (r) => reasons.push(r),
	}) as any
	for (let i = 0; i < 70; i++) expect(recorder.enqueueRecordingEvent(event(i))).toBe(true)
	const held = recorder.formChunk(false)
	recorder.uploadingChunk = held
	let i = 70
	while (recorder.enqueueRecordingEvent(event(i))) i++
	expect(i).toBeLessThan(1000)
	expect(recorder.pendingBytes + recordingEventsBytes(held.events)).toBeLessThanOrEqual(
		MAX_RECORDING_QUEUE_BYTES
	)
	expect(recorder.pendingBytes + recordingEventsBytes(held.events)).toBeGreaterThan(
		MAX_RECORDING_QUEUE_BYTES - 9000
	)
	expect([...held.events, ...recorder.events].map((e) => e.timestamp)).toEqual(
		Array.from({ length: i }, (_, n) => 100 + n)
	)
	expect(reasons).toEqual(["recording_budget_exceeded"])
	expect(recorder.enqueueRecordingEvent(event(i + 1))).toBe(false)
	await Promise.resolve()
})

test("an oversized snapshot is rejected before entering the queue", async () => {
	const reasons: string[] = []
	globalThis.fetch = (async () => Response.json({ success: true })) as typeof fetch
	const recorder = new SessionRecorder({
		...config,
		onCaptureIncomplete: (r) => reasons.push(r),
	}) as any
	expect(recorder.enqueueRecordingEvent(event(0, "é".repeat(800_000)))).toBe(false)
	expect(recorder.events).toHaveLength(0)
	expect(recorder.pendingBytes).toBe(0)
	expect(reasons).toEqual(["recording_budget_exceeded"])
	await Promise.resolve()
})

test("async compression preserves captured bytes despite a later source-object mutation", async () => {
	const captured: any = event(0, "original")
	recordingEventBytes(captured)
	captured.data.texts[0].value = "changed afterward"
	const encoded = await compressRecordingEvents([captured])
	expect(JSON.parse(strFromU8(gunzipSync(encoded.compressed)))[0].data.texts[0].value).toBe(
		"original"
	)
	expect(encoded.compressed[3]).toBe(0)
	// Devora's ingest accepts exactly one gzip member with no optional header
	// fields: FLG is 0 (asserted above) and the trailer's ISIZE is the full length.
	const view = new DataView(encoded.compressed.buffer, encoded.compressed.byteOffset)
	expect(view.getUint32(encoded.compressed.byteLength - 4, true)).toBe(
		encoded.uncompressed.byteLength
	)
	expect(strFromU8(gunzipSync(encoded.compressed))).toBe(strFromU8(encoded.uncompressed))
})

test("retries reuse exactly the same compressed bytes and chunk index", async () => {
	const uploads: any[] = []
	globalThis.fetch = (async (url, init) => {
		if (String(url).endsWith("/chunk")) {
			uploads.push(JSON.parse(String(init?.body)))
			return uploads.length === 1
				? new Response(null, { status: 500 })
				: Response.json({ success: true })
		}
		return Response.json({ success: true })
	}) as typeof fetch
	const recorder = new SessionRecorder(config) as any
	recorder.enqueueRecordingEvent(event(0))
	await recorder.flush()
	expect(recorder.failedChunk).not.toBeNull()
	await recorder.flush()
	expect(uploads).toHaveLength(2)
	expect(uploads[1].eventsBase64).toBe(uploads[0].eventsBase64)
	expect(uploads[1].chunkIndex).toBe(uploads[0].chunkIndex)
	expect(recorder.failedChunk).toBeNull()
})

test("recording encoding works without a native compressor", async () => {
	Object.defineProperty(globalThis, "CompressionStream", {
		configurable: true,
		value: class {
			constructor() {
				throw new Error("Unavailable")
			}
		},
	})
	const input = Array.from({ length: 50 }, (_, i) => event(i))
	const encoded = await compressRecordingEvents(input)
	// An earlier worker failure can select the stored-block fallback, which is
	// valid gzip but slightly larger than the input.
	expect(encoded.compressed.byteLength).toBeLessThanOrEqual(700_000)
	expect(strFromU8(gunzipSync(encoded.compressed))).toBe(strFromU8(encoded.uncompressed))
})

test("synchronous compression refuses a normal upload-sized batch", () => {
	expect(() => compressRecordingEventsSync(Array.from({ length: 10 }, (_, i) => event(i)))).toThrow(
		RecordingEncodingLimitError
	)
	expect(recordingPrefixLength([event(0, "x".repeat(800_000)), event(1)])).toBe(1)
})

test("an incompressible oversized single event fails before an upload can be formed", async () => {
	const bytes = new Uint8Array(800_000)
	for (let offset = 0; offset < bytes.length; offset += 65_536)
		crypto.getRandomValues(bytes.subarray(offset, offset + 65_536))
	await expect(
		compressRecordingEvents([event(0, Buffer.from(bytes).toString("base64"))])
	).rejects.toBeInstanceOf(RecordingEncodingLimitError)
})
