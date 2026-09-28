/**
 * Independent signing-v3 implementation for tests, written from the spec
 * (SIGNING_V3_PROPOSAL.md section 5) with node:crypto only. Verifiers are
 * tested against this, never against the SDK's own signer.
 */
import { createHash, createHmac, randomUUID } from "node:crypto"
import vectors from "../signing-v3-vectors.json"

export const TEST_KEYS = {
	apiKey: vectors.constants.keyId,
	secretKey: vectors.constants.secret,
	orgId: vectors.constants.orgId,
} as const

const encoder = new TextEncoder()

export function strictEncode(value: string): string {
	let out = ""
	for (const byte of encoder.encode(value)) {
		const char = String.fromCharCode(byte)
		out += /[A-Za-z0-9\-_.~]/.test(char)
			? char
			: `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
	}
	return out
}

export interface TestSignInput {
	method: string
	/** Signed path, already strict-encoded (mount-relative for devora-to-customer). */
	path: string
	query?: string
	/** A string is sent as UTF-8; an object is JSON-encoded; bytes are sent as-is. */
	body?: string | Uint8Array | Record<string, unknown> | unknown[]
	direction?: "devora-to-customer" | "customer-to-devora"
	keyId?: string
	orgId?: string
	secret?: string
	sentAt?: string
	requestId?: string
}

export function bodyBytes(body: TestSignInput["body"]): Uint8Array {
	if (body === undefined) return new Uint8Array()
	if (body instanceof Uint8Array) return body
	return encoder.encode(typeof body === "string" ? body : JSON.stringify(body))
}

/** Sign a request; returns the exact headers and body bytes to send. */
export function signTestRequest(input: TestSignInput): {
	headers: Record<string, string>
	body: Uint8Array
	canonical: string
} {
	const body = bodyBytes(input.body)
	const keyId = input.keyId ?? TEST_KEYS.apiKey
	const orgId = input.orgId ?? TEST_KEYS.orgId
	const sentAt = input.sentAt ?? String(Math.floor(Date.now() / 1000))
	const requestId = input.requestId ?? randomUUID()
	const canonical = [
		"DEVORA-HMAC-SHA256",
		"3",
		input.direction ?? "devora-to-customer",
		keyId,
		orgId,
		sentAt,
		requestId,
		input.method,
		input.path,
		input.query ?? "",
		createHash("sha256").update(body).digest("hex"),
	].join("\n")
	const signature = createHmac("sha256", Buffer.from(input.secret ?? TEST_KEYS.secretKey, "ascii"))
		.update(Buffer.from(canonical, "ascii"))
		.digest("hex")
	return {
		canonical,
		body,
		headers: {
			"x-devora-signature-version": "3",
			"x-devora-key-id": keyId,
			"x-devora-org-id": orgId,
			"x-devora-sent-at": sentAt,
			"x-devora-request-id": requestId,
			"x-devora-signature": signature,
			...(body.byteLength > 0 ? { "content-type": "application/json" } : {}),
		},
	}
}

/** An AdapterRequest (processRequest input) signed for devora-to-customer. */
export function signedAdapterRequest(input: TestSignInput) {
	const signed = signTestRequest(input)
	return {
		method: input.method,
		path: input.path,
		query: input.query ?? "",
		body: signed.body,
		headers: signed.headers as Record<string, string | string[] | undefined>,
	}
}

export { vectors }
