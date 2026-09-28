/** Failures raised before an oversized or stalled body is fully materialized. */
export class BodyReadError extends Error {
	constructor(
		public readonly code: "BODY_TOO_LARGE" | "BODY_TIMEOUT" | "INVALID_BODY",
		public readonly status: 400 | 408 | 413,
		message: string
	) {
		super(message)
		this.name = "BodyReadError"
	}
}

/**
 * Read the exact body bytes with a size bound and a total deadline, cancelling
 * on failure. A single transport chunk may exceed the limit; it is rejected
 * before being retained. Framework/ingress limits must also bound the
 * transport's own buffering.
 */
export async function readBoundedBytes(
	request: Pick<Request, "headers" | "body">,
	maxBytes: number,
	timeoutMs = 5_000
): Promise<Uint8Array> {
	if (
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 0 ||
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0
	)
		throw new Error("Invalid body budget")
	const declared = request.headers.get("content-length")
	const cancel = () => {
		void request.body?.cancel().catch(() => {})
	}
	if (declared !== null && !/^\d+$/.test(declared)) {
		cancel()
		throw new BodyReadError("INVALID_BODY", 400, "Invalid Content-Length")
	}
	if (declared !== null && Number(declared) > maxBytes) {
		cancel()
		throw new BodyReadError("BODY_TOO_LARGE", 413, "Request body too large")
	}
	if (!request.body) return new Uint8Array()
	const reader = request.body.getReader()
	let timer: ReturnType<typeof setTimeout> | undefined
	let finished = false
	try {
		return await Promise.race([
			(async () => {
				const chunks: Uint8Array[] = []
				let total = 0
				while (!finished) {
					const { value, done } = await reader.read()
					if (finished) break
					if (done) {
						const bytes = new Uint8Array(total)
						let offset = 0
						for (const chunk of chunks) {
							bytes.set(chunk, offset)
							offset += chunk.byteLength
						}
						return bytes
					}
					total += value.byteLength
					if (total > maxBytes)
						throw new BodyReadError("BODY_TOO_LARGE", 413, "Request body too large")
					chunks.push(value)
				}
				throw new BodyReadError("BODY_TIMEOUT", 408, "Request body timed out")
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new BodyReadError("BODY_TIMEOUT", 408, "Request body timed out")),
					timeoutMs
				)
			}),
		])
	} finally {
		finished = true
		if (timer !== undefined) clearTimeout(timer)
		// Do not wait for an uncooperative upstream cancellation.
		void reader.cancel().catch(() => {})
		reader.releaseLock()
	}
}

/** {@link readBoundedBytes}, decoded as UTF-8 (invalid sequences become U+FFFD). */
export async function readBoundedBody(
	request: Pick<Request, "headers" | "body">,
	maxBytes: number,
	timeoutMs = 5_000
): Promise<string> {
	return new TextDecoder().decode(await readBoundedBytes(request, maxBytes, timeoutMs))
}
