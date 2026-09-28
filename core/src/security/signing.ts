/**
 * Devora request signing, version 3.
 *
 * The signature covers the exact bytes on the wire: raw path, raw query and a
 * SHA-256 of the raw body, plus the direction the request travels in. Every
 * header has one accepted spelling. The canonical string joins fields with
 * `\n`; each field's grammar excludes `\n`, so the encoding is injective.
 *
 * This module is pure (no hashing): runtimes supply SHA-256 and HMAC.
 * Conformance vectors: packages/sdks/test/signing-v3-vectors.json.
 *
 * @module @devorash/core/security/signing
 */

import { SECURITY_HEADERS } from "../constants/index.js"

export const SIGNING = {
	VERSION: "3",
	ALGORITHM: "DEVORA-HMAC-SHA256",
	/** Devora backend -> customer backend (the SDK verifies). */
	DEVORA_TO_CUSTOMER: "devora-to-customer",
	/** Customer backend SDK -> Devora backend (Devora verifies). */
	CUSTOMER_TO_DEVORA: "customer-to-devora",
	/** SHA-256 of an empty body. */
	EMPTY_BODY_SHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
} as const

export type SigningDirection = typeof SIGNING.DEVORA_TO_CUSTOMER | typeof SIGNING.CUSTOMER_TO_DEVORA

/** Exact header grammars. (?![\s\S]) requires the actual end of input;
 * JavaScript's $ also accepts a position before a final newline. */
export const SIGNED_HEADER_PATTERNS = {
	signatureVersion: /^3(?![\s\S])/,
	keyId: /^pk_server_live_[A-Za-z0-9_-]{32}(?![\s\S])/,
	orgId: /^[A-Za-z0-9_-]{1,128}(?![\s\S])/,
	sentAt: /^[1-9][0-9]{9}(?![\s\S])/,
	requestId: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/,
	signature: /^[0-9a-f]{64}(?![\s\S])/,
	method: /^[A-Z]{3,7}(?![\s\S])/,
	bodySha256: /^[0-9a-f]{64}(?![\s\S])/,
	/** The full secret string; its ASCII bytes are the HMAC key. */
	secretKey: /^sk_server_live_[A-Za-z0-9_-]{64}(?![\s\S])/,
} as const

export type SignatureErrorCode =
	| "INVALID_SIGNATURE_HEADERS"
	| "UNSUPPORTED_SIGNATURE_VERSION"
	| "ORG_MISMATCH"
	| "TIMESTAMP_EXPIRED"
	| "INVALID_REQUEST_TARGET"
	| "UNSUPPORTED_CONTENT_ENCODING"
	| "INVALID_SIGNATURE"
	| "REPLAYED_REQUEST"
	| "REPLAY_STORE_UNAVAILABLE"

/** Header values as frameworks expose them. */
export type HeaderMap = Record<string, string | string[] | undefined>

export interface SignatureHeaders {
	keyId: string
	orgId: string
	sentAt: string
	requestId: string
	signature: string
}

export type SignatureHeaderResult =
	| { valid: true; headers: SignatureHeaders }
	| { valid: false; errorCode: SignatureErrorCode; error: string }

export interface CanonicalFields {
	direction: SigningDirection
	keyId: string
	orgId: string
	sentAt: string
	requestId: string
	method: string
	/** Raw, percent-encoded path (mount-relative for devora-to-customer). */
	path: string
	/** Raw query after the first `?`, exactly as sent; "" when absent. */
	query: string
	/** Lowercase hex SHA-256 of the exact body bytes. */
	bodySha256: string
}

const UNRESERVED = /[A-Za-z0-9\-_.~]/
const encoder = new TextEncoder()

/** UTF-8 percent-encode every byte outside `A-Z a-z 0-9 - _ . ~`, with uppercase hex. */
export function strictEncode(value: string): string {
	// TextEncoder silently replaces lone surrogates; Python rejects them. Never
	// sign a different identifier from the string the caller supplied.
	encodeURIComponent(value)
	let out = ""
	for (const byte of encoder.encode(value)) {
		const char = String.fromCharCode(byte)
		out += UNRESERVED.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
	}
	return out
}

/**
 * Encode one path parameter. `""`, `.` and `..` are refused: URL parsers
 * remove dot segments (even `%2E%2E`), so they cannot be sent as signed.
 */
export function encodePathParam(value: string): string {
	if (value === "" || value === "." || value === "..")
		throw new Error("Devora signing: unroutable path parameter")
	return strictEncode(value)
}

/** Strict-encoded `key=value` pairs, in the given order (the order is signed). */
export function buildStrictQuery(pairs: ReadonlyArray<readonly [string, string]>): string {
	return pairs.map(([key, value]) => `${strictEncode(key)}=${strictEncode(value)}`).join("&")
}

/** Printable ASCII where every `%` starts an uppercase two-digit escape. */
function isStrictAscii(value: string): boolean {
	return !/[^\x21-\x7E]/.test(value) && !/%(?![0-9A-F]{2})/.test(value)
}

/**
 * A raw request path as signed: absolute, printable ASCII, uppercase escapes,
 * and no empty or dot segments.
 */
export function isValidSignedPath(path: string): boolean {
	if (!path.startsWith("/") || !isStrictAscii(path) || path.length > 8192 || /[?#\\]/.test(path))
		return false
	try {
		decodeURIComponent(path)
	} catch {
		return false
	}
	if (path === "/") return true
	return path
		.slice(1)
		.split("/")
		.every((segment) => {
			const dots = segment.replace(/%2E/g, ".")
			return dots !== "" && dots !== "." && dots !== ".."
		})
}

/** A raw query as signed: printable ASCII, no fragment, uppercase escapes. */
export function isValidSignedQuery(query: string): boolean {
	if (query.includes("#") || !isStrictAscii(query) || query.length > 8192) return false
	try {
		decodeURIComponent(query)
		return true
	} catch {
		return false
	}
}

/** Build the canonical string. Throws if any field is outside its grammar. */
export function buildCanonicalString(fields: CanonicalFields): string {
	const checks: Array<[boolean, string]> = [
		[
			fields.direction === SIGNING.DEVORA_TO_CUSTOMER ||
				fields.direction === SIGNING.CUSTOMER_TO_DEVORA,
			"direction",
		],
		[SIGNED_HEADER_PATTERNS.keyId.test(fields.keyId), "key id"],
		[SIGNED_HEADER_PATTERNS.orgId.test(fields.orgId), "org id"],
		[SIGNED_HEADER_PATTERNS.sentAt.test(fields.sentAt), "sent-at"],
		[SIGNED_HEADER_PATTERNS.requestId.test(fields.requestId), "request id"],
		[SIGNED_HEADER_PATTERNS.method.test(fields.method), "method"],
		[isValidSignedPath(fields.path), "path"],
		[isValidSignedQuery(fields.query), "query"],
		[SIGNED_HEADER_PATTERNS.bodySha256.test(fields.bodySha256), "body digest"],
	]
	const invalid = checks.find(([ok]) => !ok)
	if (invalid) throw new Error(`Devora signing: invalid ${invalid[1]}`)
	return [
		SIGNING.ALGORITHM,
		SIGNING.VERSION,
		fields.direction,
		fields.keyId,
		fields.orgId,
		fields.sentAt,
		fields.requestId,
		fields.method,
		fields.path,
		fields.query,
		fields.bodySha256,
	].join("\n")
}

/**
 * The single value of a header, or `null` when it is present more than once
 * (an array, or a comma-joined value that the grammar then rejects).
 */
export function getSingleHeader(headers: HeaderMap, name: string): string | undefined | null {
	const values: string[] = []
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== name || value === undefined) continue
		values.push(...(Array.isArray(value) ? value : [value]))
	}
	if (values.length > 1) return null
	return values[0]
}

/** Parse and validate the signature headers. Never first-wins, never trims. */
export function parseSignatureHeaders(headers: HeaderMap): SignatureHeaderResult {
	const read = (name: string) => getSingleHeader(headers, name)
	const version = read(SECURITY_HEADERS.SIGNATURE_VERSION)
	const values = {
		keyId: read(SECURITY_HEADERS.KEY_ID),
		orgId: read(SECURITY_HEADERS.ORG_ID),
		sentAt: read(SECURITY_HEADERS.SENT_AT),
		requestId: read(SECURITY_HEADERS.REQUEST_ID),
		signature: read(SECURITY_HEADERS.SIGNATURE),
	}
	if (typeof version === "string" && version !== SIGNING.VERSION && /^\d+(?![\s\S])/.test(version))
		return {
			valid: false,
			errorCode: "UNSUPPORTED_SIGNATURE_VERSION",
			error: "Unsupported signature version",
		}
	const ok =
		typeof version === "string" &&
		SIGNED_HEADER_PATTERNS.signatureVersion.test(version) &&
		(Object.keys(values) as Array<keyof typeof values>).every((key) => {
			const value = values[key]
			return typeof value === "string" && SIGNED_HEADER_PATTERNS[key].test(value)
		})
	if (!ok)
		return {
			valid: false,
			errorCode: "INVALID_SIGNATURE_HEADERS",
			error: "Missing, duplicate or malformed signature headers",
		}
	return { valid: true, headers: values as SignatureHeaders }
}

/** Accept only an absent or `identity` Content-Encoding (the body digest is over wire bytes). */
export function hasIdentityContentEncoding(headers: HeaderMap): boolean {
	const value = getSingleHeader(headers, "content-encoding")
	return value === undefined || value === "identity"
}

/** Replay-store namespace: version, direction and key. */
export function replayNamespace(direction: SigningDirection, keyId: string): string {
	return `v${SIGNING.VERSION}:${direction}:${keyId}`
}

/**
 * Nonce lifetime covering the whole acceptance window: the floor second of the
 * timestamp check plus one second of clock jitter.
 */
export function replayExpiresAtMs(
	sentAt: number,
	nowSeconds: number,
	toleranceSeconds: number
): number {
	return (Math.max(nowSeconds, sentAt) + toleranceSeconds + 2) * 1000
}

/**
 * Parse a verified raw query into a null-prototype map. Repeated keys become
 * arrays in wire order; `__proto__` and `constructor` are ordinary keys.
 */
export function parseVerifiedQuery(query: string): Record<string, string | string[]> {
	const result: Record<string, string | string[]> = Object.create(null)
	for (const [key, value] of new URLSearchParams(query)) {
		const existing = result[key]
		if (existing === undefined) result[key] = value
		else if (Array.isArray(existing)) existing.push(value)
		else result[key] = [existing, value]
	}
	return result
}

export type VerifiedBodyResult = { ok: true; value: unknown } | { ok: false; error: string }

/**
 * Decode a verified body: empty means `undefined`; otherwise it must be JSON
 * (declared `application/json`) and strictly valid UTF-8.
 */
export function parseVerifiedJsonBody(
	bytes: Uint8Array,
	contentType: string | undefined | null
): VerifiedBodyResult {
	if (bytes.byteLength === 0) return { ok: true, value: undefined }
	if (!contentType || !/^application\/json(\s*;.*)?(?![\s\S])/i.test(contentType.trim()))
		return { ok: false, error: "Signed request bodies must be application/json" }
	try {
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
		const value: unknown = JSON.parse(text, (_key, item: unknown) => {
			if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Non-finite number")
			if (item !== null && typeof item === "object" && !Array.isArray(item))
				Object.setPrototypeOf(item, null)
			return item
		})
		if (hasDuplicateJsonKeys(text)) return { ok: false, error: "Duplicate JSON key" }
		return { ok: true, value }
	} catch {
		return { ok: false, error: "Invalid JSON body" }
	}
}

/** Scan valid JSON, comparing decoded keys separately in each object. */
function hasDuplicateJsonKeys(text: string): boolean {
	const stack: Array<Set<string> | null> = []
	let expectKey = false
	for (let index = 0; index < text.length; index++) {
		const char = text[index]
		if (char === "{") {
			stack.push(new Set())
			expectKey = true
		} else if (char === "[") {
			stack.push(null)
			expectKey = false
		} else if (char === "}" || char === "]") {
			stack.pop()
			expectKey = false
		} else if (char === ",") expectKey = stack[stack.length - 1] != null
		else if (char === ":") expectKey = false
		else if (char === '"') {
			let end = index + 1
			while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1
			if (expectKey) {
				const keys = stack[stack.length - 1]!
				const key = JSON.parse(text.slice(index, end + 1)) as string
				if (keys.has(key)) return true
				keys.add(key)
				expectKey = false
			}
			index = end
		}
	}
	return false
}

/**
 * Last `count` segments of a raw path, i.e. the path relative to a mount whose
 * route template has `count` segments. `null` when the path is shorter.
 */
export function routeRelativePath(rawPath: string, routeTemplate: string): string | null {
	const count = routeTemplate.split("/").filter(Boolean).length
	if (count === 0) return "/"
	const segments = rawPath.split("/")
	// segments[0] is "" for an absolute path; the tail must be `count` segments.
	if (segments.length - 1 < count) return null
	return `/${segments.slice(segments.length - count).join("/")}`
}
