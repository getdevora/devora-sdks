/**
 * Request signing v3 primitives for Node.js (node:crypto).
 * @module @devorash/node
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from "crypto"
import {
	SECURITY_HEADERS,
	SIGNING,
	SIGNED_HEADER_PATTERNS,
	buildCanonicalString,
	type SigningDirection,
} from "@devorash/core"

/** Lowercase hex SHA-256 of exact bytes. */
export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex")
}

/** Lowercase hex HMAC-SHA256 of a canonical string, keyed by the secret's ASCII bytes. */
export function hmacHex(secretKey: string, canonical: string): string {
	return createHmac("sha256", Buffer.from(secretKey, "ascii"))
		.update(Buffer.from(canonical, "ascii"))
		.digest("hex")
}

/**
 * Constant-time comparison of a provided signature with the expected one.
 * The provided value must be exactly 64 lowercase hex characters; it is never
 * decoded leniently.
 */
export function signatureMatches(secretKey: string, canonical: string, provided: string): boolean {
	if (!SIGNED_HEADER_PATTERNS.signature.test(provided)) return false
	return timingSafeEqual(
		Buffer.from(hmacHex(secretKey, canonical), "hex"),
		Buffer.from(provided, "hex")
	)
}

/** Headers for an outgoing signed request. */
export function signRequest(input: {
	secretKey: string
	direction: SigningDirection
	keyId: string
	orgId: string
	method: string
	path: string
	query?: string
	body?: Uint8Array
}): Record<string, string> {
	const body = input.body ?? new Uint8Array()
	const sentAt = String(Math.floor(Date.now() / 1000))
	const requestId = randomUUID()
	const canonical = buildCanonicalString({
		direction: input.direction,
		keyId: input.keyId,
		orgId: input.orgId,
		sentAt,
		requestId,
		method: input.method,
		path: input.path,
		query: input.query ?? "",
		bodySha256: sha256Hex(body),
	})
	return {
		[SECURITY_HEADERS.SIGNATURE_VERSION]: SIGNING.VERSION,
		[SECURITY_HEADERS.KEY_ID]: input.keyId,
		[SECURITY_HEADERS.ORG_ID]: input.orgId,
		[SECURITY_HEADERS.SENT_AT]: sentAt,
		[SECURITY_HEADERS.REQUEST_ID]: requestId,
		[SECURITY_HEADERS.SIGNATURE]: hmacHex(input.secretKey, canonical),
		...(body.byteLength > 0 ? { "Content-Type": "application/json" } : {}),
	}
}
