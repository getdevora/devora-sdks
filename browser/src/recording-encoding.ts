import type { eventWithTime } from "rrweb"
import { gzip, gzipSync, strToU8 } from "fflate"
import { withDeadline } from "./deadline.js"

export const MAX_COMPRESSED_CHUNK_BYTES = 700_000
export const MAX_UNCOMPRESSED_CHUNK_BYTES = 1_500_000
export const NORMAL_CHUNK_BYTES = 600_000
export const MAX_SYNC_RECORDING_BYTES = 24_000
export const MAX_RECORDING_QUEUE_BYTES = 6 * 1024 * 1024

export class RecordingEncodingLimitError extends Error {
	constructor() {
		super("Recording exceeds the chunk or buffer size limit")
	}
}

export interface CompressedEvents {
	uncompressed: Uint8Array
	compressed: Uint8Array
}

// Capture the wire representation once. Weak keys do not keep uploaded events
// alive, and later mutations of an rrweb-owned object cannot change retry bytes.
const serialized = new WeakMap<eventWithTime, { json: string; bytes: number }>()
function serialize(event: eventWithTime) {
	let value = serialized.get(event)
	if (!value) {
		const json = JSON.stringify(event)
		if (!json) throw new RecordingEncodingLimitError()
		value = { json, bytes: strToU8(json).byteLength }
		if (value.bytes + 3 > MAX_UNCOMPRESSED_CHUNK_BYTES) throw new RecordingEncodingLimitError()
		serialized.set(event, value)
	}
	return value
}

/** Includes a comma allowance so sums are conservative for JSON arrays. */
export function recordingEventBytes(event: eventWithTime): number {
	return serialize(event).bytes + 1
}

export function recordingEventsBytes(events: eventWithTime[]): number {
	return 2 + events.reduce((sum, event) => sum + recordingEventBytes(event), 0)
}

/** Select a bounded prefix before serialization/compression of the whole chunk. */
export function recordingPrefixLength(events: eventWithTime[]): number {
	let bytes = 2
	let count = 0
	for (const event of events) {
		const next = recordingEventBytes(event)
		if (next + 2 > MAX_UNCOMPRESSED_CHUNK_BYTES) throw new RecordingEncodingLimitError()
		// A single large DOM snapshot can use the full protocol allowance, but
		// subsequent small events never turn a normal chunk into a large batch.
		if (bytes + next > NORMAL_CHUNK_BYTES) return count || 1
		bytes += next
		if (++count === 5_000) break
	}
	return count
}

function encode(events: eventWithTime[]): Uint8Array {
	if (events.length > 5_000 || recordingEventsBytes(events) > MAX_UNCOMPRESSED_CHUNK_BYTES)
		throw new RecordingEncodingLimitError()
	return strToU8("[" + events.map((event) => serialize(event).json).join(",") + "]")
}

function checked(uncompressed: Uint8Array, compressed: Uint8Array): CompressedEvents {
	if (compressed.byteLength > MAX_COMPRESSED_CHUNK_BYTES) throw new RecordingEncodingLimitError()
	return { uncompressed, compressed }
}

/** Only the small unload prefix uses synchronous compression. */
export function compressRecordingEventsSync(events: eventWithTime[]): CompressedEvents {
	if (recordingEventsBytes(events) > MAX_SYNC_RECORDING_BYTES)
		throw new RecordingEncodingLimitError()
	const uncompressed = encode(events)
	return checked(uncompressed, gzipSync(uncompressed, { level: 1, mtime: 0 }))
}

/** Pace native compression between small writes when CSP prevents a worker. */
async function compressNatively(uncompressed: Uint8Array): Promise<Uint8Array> {
	const stream = new CompressionStream("gzip")
	const reader = stream.readable.getReader()
	const writer = stream.writable.getWriter()
	const channel = typeof MessageChannel === "undefined" ? null : new MessageChannel()
	let release: (() => void) | undefined
	let closed = false
	if (channel)
		channel.port1.onmessage = () => {
			release?.()
			release = undefined
		}
	const yieldTask = () =>
		new Promise<void>((resolve) => {
			if (channel) {
				release = resolve
				channel.port2.postMessage(null)
			} else setTimeout(resolve, 0)
		})
	const cancel = () => {
		closed = true
		void reader.cancel().catch(() => {})
		void writer.abort().catch(() => {})
		release?.()
	}
	try {
		return await withDeadline(
			async () => {
				const read = (async () => {
					const chunks: Uint8Array[] = []
					let size = 0
					while (!closed) {
						const { done, value } = await reader.read()
						if (done) break
						size += value.byteLength
						if (size > MAX_COMPRESSED_CHUNK_BYTES) throw new RecordingEncodingLimitError()
						chunks.push(value)
					}
					const result = new Uint8Array(size)
					let offset = 0
					for (const chunk of chunks) {
						result.set(chunk, offset)
						offset += chunk.byteLength
					}
					return result
				})()
				const write = (async () => {
					for (let offset = 0; offset < uncompressed.byteLength && !closed; offset += 32_768) {
						await writer.write(
							uncompressed.subarray(offset, offset + 32_768) as Uint8Array<ArrayBuffer>
						)
						await yieldTask()
					}
					if (!closed) await writer.close()
				})()
				const [result] = await Promise.all([read, write])
				return result
			},
			5_000,
			cancel
		)
	} finally {
		cancel()
		channel?.port1.close()
		channel?.port2.close()
		reader.releaseLock()
		writer.releaseLock()
	}
}

// A failed worker bootstrap (including CSP) must not delay every later chunk.
let workerUnavailable = false

/** Worker compression, then paced native compression, then fast stored blocks. */
export async function compressRecordingEvents(events: eventWithTime[]): Promise<CompressedEvents> {
	const uncompressed = encode(events)
	if (!workerUnavailable) {
		let terminate: (() => void) | undefined
		let rejectWorker: ((error: Error) => void) | undefined
		const denied = (event: SecurityPolicyViolationEvent) => {
			if (
				event.disposition === "enforce" &&
				["worker-src", "child-src", "script-src", "default-src"].includes(
					event.effectiveDirective
				) &&
				(event.blockedURI === "blob" || event.blockedURI.startsWith("blob:"))
			) {
				workerUnavailable = true
				terminate?.()
				rejectWorker?.(new Error("Page policy prevents compression workers"))
			}
		}
		if (typeof document !== "undefined")
			document.addEventListener("securitypolicyviolation", denied)
		try {
			const compressed = await withDeadline(
				() =>
					new Promise<Uint8Array>((resolve, reject) => {
						rejectWorker = reject
						terminate = gzip(uncompressed, { level: 1, mtime: 0 }, (error, result) => {
							if (error) reject(error)
							else resolve(result)
						})
					}),
				5_000,
				() => terminate?.()
			)
			return checked(uncompressed, compressed)
		} catch (error) {
			if (error instanceof RecordingEncodingLimitError) throw error
			workerUnavailable = true
		} finally {
			terminate?.()
			if (typeof document !== "undefined")
				document.removeEventListener("securitypolicyviolation", denied)
		}
	}
	if (typeof CompressionStream !== "undefined") {
		try {
			return checked(uncompressed, await compressNatively(uncompressed))
		} catch (error) {
			if (error instanceof RecordingEncodingLimitError) throw error
		}
	}
	// Stored blocks avoid CPU-heavy deflate on the UI thread. A snapshot too
	// large for this last fallback fails visibly instead of blocking or looping.
	return checked(uncompressed, gzipSync(uncompressed, { level: 0, mtime: 0 }))
}
