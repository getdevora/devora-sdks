/**
 * Outbound calls to the Devora API: no redirects (signed headers and bodies
 * must never be forwarded to another origin), a total deadline, and a bounded
 * JSON response.
 * @module @devorash/node
 */

/** Largest control-plane response the SDK will buffer. */
export const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024

export class ControlPlaneResponseError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ControlPlaneResponseError"
	}
}

/** `fetch` that refuses redirects and aborts after `timeoutMs` in total. */
export function controlPlaneFetch(
	url: string,
	init: RequestInit,
	timeoutMs = 5_000
): Promise<Response> {
	return fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) })
}

/**
 * Read a JSON object response of at most `maxBytes`. Non-object JSON, invalid
 * UTF-8 and oversized bodies throw {@link ControlPlaneResponseError}.
 */
export async function readBoundedJsonObject(
	response: Response,
	maxBytes = MAX_CONTROL_RESPONSE_BYTES
): Promise<Record<string, unknown>> {
	const declared = response.headers.get("content-length")
	if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
		void response.body?.cancel().catch(() => {})
		throw new ControlPlaneResponseError("Response too large")
	}
	const chunks: Uint8Array[] = []
	let total = 0
	if (response.body) {
		const reader = response.body.getReader()
		try {
			for (;;) {
				const { value, done } = await reader.read()
				if (done) break
				total += value.byteLength
				if (total > maxBytes) throw new ControlPlaneResponseError("Response too large")
				chunks.push(value)
			}
		} finally {
			void reader.cancel().catch(() => {})
		}
	}
	const bytes = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
	} catch {
		throw new ControlPlaneResponseError("Invalid JSON response")
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new ControlPlaneResponseError("Unexpected response shape")
	return parsed as Record<string, unknown>
}
