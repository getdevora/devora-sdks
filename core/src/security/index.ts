/**
 * Security utilities for Devora SDKs
 * @module @devorash/core/security
 */

import { SDK_DEFAULTS, READ_METHODS } from "../constants/index.js"
import type { SignatureErrorCode } from "./signing.js"

// ============================================================================
// Timestamps
// ============================================================================

/**
 * A timestamp tolerance is a whole, non-negative number of seconds. Zero means
 * only the current second is accepted; there is no "falsy means default".
 */
export function isValidTimestampTolerance(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/** Throws for configuration values that {@link isValidTimestampTolerance} rejects. */
export function assertTimestampTolerance(value: unknown, name = "timestampTolerance"): void {
	if (value !== undefined && !isValidTimestampTolerance(value))
		throw new Error(`Devora SDK: ${name} must be a non-negative integer number of seconds`)
}

/**
 * Validate timestamp is within acceptable window
 */
export function validateTimestamp(
	requestTimestamp: number,
	toleranceSeconds: number = SDK_DEFAULTS.TIMESTAMP_TOLERANCE
): { valid: boolean; error?: string } {
	// NaN/Infinity/negative tolerances would make every drift comparison pass.
	if (!isValidTimestampTolerance(toleranceSeconds)) {
		return { valid: false, error: "Invalid timestamp tolerance" }
	}
	if (!Number.isFinite(requestTimestamp) || requestTimestamp <= 0) {
		return {
			valid: false,
			error: "Invalid timestamp",
		}
	}

	const currentTime = Math.floor(Date.now() / 1000)
	const drift = Math.abs(currentTime - requestTimestamp)

	if (drift > toleranceSeconds) {
		return {
			valid: false,
			error: `Request timestamp outside tolerance window (drift: ${drift}s, max: ${toleranceSeconds}s)`,
		}
	}

	return { valid: true }
}

// ============================================================================
// Scope Enforcement Utilities
// ============================================================================

/**
 * Check if HTTP method is a write operation
 */
export function isWriteMethod(method: string): boolean {
	// Unknown verbs are not safe just because they are absent from our CRUD list.
	return !(READ_METHODS as readonly string[]).includes(method.toUpperCase())
}

/**
 * Path of an origin-form request target (`/path?query`), still percent-encoded.
 *
 * Absolute-form targets (`http://host/path`) are deliberately NOT unwrapped:
 * routers disagree with any regex about where such a host ends (a `?` inside
 * it moves the routed path to `/`), so the result does not start with `/` and
 * {@link isAmbiguousRequestPath} rejects it.
 */
export function getRawRequestPath(value: string): string {
	return (value ?? "").split(/[?#]/)[0] || "/"
}

/** Headers through which common middleware lets a client change the effective method. */
export const METHOD_OVERRIDE_HEADERS = [
	"x-http-method-override",
	"x-http-method",
	"x-method-override",
] as const

/** The query parameter method-override middleware reads (`?_method=DELETE`). */
export const METHOD_OVERRIDE_QUERY_PARAM = "_method"

/**
 * Every method a request might execute as. The guard judges all of them, so a
 * method-override middleware ordered after the guard cannot turn an allowed
 * POST into a blocked DELETE. `target` (the raw request target) adds any
 * `_method` query parameters. A `_method` field in a request body is invisible
 * to a guard that runs before body parsing; see the guard docs.
 */
export function getPolicyMethods(
	method: string,
	headers?: Record<string, string | string[] | undefined>,
	target?: string
): string[] {
	const methods = new Set([method.toUpperCase()])
	for (const name of METHOD_OVERRIDE_HEADERS) {
		const value = headers?.[name]
		for (const item of Array.isArray(value) ? value : value ? [value] : [])
			for (const part of item.split(",")) if (part.trim()) methods.add(part.trim().toUpperCase())
	}
	const queryStart = target?.indexOf("?") ?? -1
	if (target && queryStart !== -1) {
		const query = target.slice(queryStart + 1).split("#")[0]!
		try {
			for (const value of new URLSearchParams(query).getAll(METHOD_OVERRIDE_QUERY_PARAM))
				if (value.trim()) methods.add(value.trim().toUpperCase())
		} catch {
			// An unparseable query overrides nothing; the route guard judges it.
		}
	}
	return [...methods]
}

/**
 * Methods a deny rule must cover. Frameworks answer HEAD with the GET handler,
 * so a GET deny rule also denies HEAD.
 */
export function getDenyMethods(methods: string[]): string[] {
	return methods.includes("HEAD") && !methods.includes("GET") ? [...methods, "GET"] : methods
}

/** Join a router mount prefix and a mount-relative origin-form target. */
export function joinMountedTarget(mountPath: string | undefined, target: string): string {
	if (!mountPath || mountPath === "/") return target
	// A mounted router sees `/` for both `/mount` and `/mount/`; both dispatch
	// to the router's root handler, so report the mount path itself.
	if (target === "/" || target.startsWith("/?") || target.startsWith("/#"))
		return mountPath + target.slice(1)
	return mountPath + target
}

// A plain space (`%20` once decoded) is ordinary route-parameter content and
// does not move a segment boundary; control characters and backslashes do.
function hasPathControl(value: string): boolean {
	return Array.from(value).some(
		(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char.charCodeAt(0) === 92
	)
}

/** Reject paths whose segment boundaries differ between common routers. */
export function isAmbiguousRequestPath(value: string): boolean {
	const raw = getRawRequestPath(value)
	if (raw.length > 8192 || !raw.startsWith("/") || hasPathControl(raw)) return true
	try {
		const decoded = decodeURIComponent(raw)
		return (
			// A still-encoded sequence after one decode means double encoding; a
			// bare `%` (from a literal `%25`) is ordinary parameter content.
			/%[0-9a-f]{2}/i.test(decoded) ||
			// Routers may treat semicolons as query/matrix delimiters. A deny
			// rule must not compare a different path from the selected handler.
			decoded.includes(";") ||
			hasPathControl(decoded) ||
			/%(?:2f|5c)/i.test(raw) ||
			decoded.includes("//") ||
			decoded.split("/").some((part) => part === "." || part === "..")
		)
	} catch {
		return true
	}
}

/** Decode one segment at a time, preserving case and separators. */
export function normalizeRequestPath(value: string): string {
	const path = getRawRequestPath(value)
	try {
		return decodeURIComponent(path)
	} catch {
		return path
	}
}

/** Linear-space wildcard matching within one path segment. */
function segmentMatches(pattern: string, value: string): boolean {
	let previous = new Uint8Array(value.length + 1)
	previous[0] = 1
	for (const token of pattern) {
		const current = new Uint8Array(value.length + 1)
		if (token === "*") current[0] = previous[0]!
		for (let j = 1; j <= value.length; j++) {
			current[j] =
				token === "*"
					? previous[j] || current[j - 1]
						? 1
						: 0
					: previous[j - 1] && token === value[j - 1]
						? 1
						: 0
		}
		previous = current
	}
	return previous[value.length] === 1
}

/**
 * Bounded iterative glob matching: * stays within a segment; ** spans zero or
 * more whole segments. Allow rules preserve case/trailing slashes. Deny rules
 * opt into conservative case-insensitive matching for non-strict routers.
 */
export function matchEndpointPattern(
	pattern: string,
	path: string,
	options: { caseSensitive?: boolean; ignoreTrailingSlash?: boolean } = {}
): boolean {
	if (pattern.length > 500 || path.length > 8192) return false
	let patternPath = pattern.startsWith("/") ? pattern : `/${pattern}`
	let requestPath = path.startsWith("/") ? path : `/${path}`
	if (options.caseSensitive === false) {
		patternPath = patternPath.toLowerCase()
		requestPath = requestPath.toLowerCase()
	}
	if (options.ignoreTrailingSlash) {
		patternPath = patternPath.replace(/\/+$/, "") || "/"
		requestPath = requestPath.replace(/\/+$/, "") || "/"
	}
	const patterns = patternPath.slice(1).split("/")
	const parts = requestPath.slice(1).split("/")
	let previous = new Uint8Array(parts.length + 1)
	previous[0] = 1
	for (const token of patterns) {
		const current = new Uint8Array(parts.length + 1)
		if (token === "**") current[0] = previous[0]!
		for (let j = 1; j <= parts.length; j++) {
			current[j] =
				token === "**"
					? previous[j] || current[j - 1]
						? 1
						: 0
					: previous[j - 1] && segmentMatches(token, parts[j - 1]!)
						? 1
						: 0
		}
		previous = current
	}
	return previous[parts.length] === 1
}

/**
 * Create a blocked response for scope violations
 */
export function createBlockedResponse(method: string, url: string): Response {
	return new Response(
		JSON.stringify({
			error: "Write operations disabled in read-only mode",
			method,
			url,
			code: "SCOPE_VIOLATION",
		}),
		{
			status: 403,
			headers: { "Content-Type": "application/json" },
		}
	)
}

// ============================================================================
// Token Utilities
// ============================================================================

/**
 * Generate a cryptographically secure random string for tokens/IDs.
 *
 * @throws {Error} If no secure random source is available.
 *         This is intentional - we must never fall back to Math.random()
 *         for security-sensitive operations like token generation.
 */
export function generateRandomString(length: number = 32): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	let result = ""

	// Check for Web Crypto API (browser and modern Node.js)
	if (typeof crypto === "undefined" || !crypto.getRandomValues) {
		// NO FALLBACK - throw error instead of using insecure Math.random()
		throw new Error(
			"Devora SDK: Secure random number generator not available. " +
				"This environment does not support Web Crypto API. " +
				"For Node.js < 19, ensure you're using the crypto module."
		)
	}

	// Use rejection sampling to avoid modulo bias
	const maxValidValue = 256 - (256 % chars.length) // 248 for 62 chars
	for (let i = 0; i < length; i++) {
		let randomValue: number
		do {
			const randomBytes = new Uint8Array(1)
			crypto.getRandomValues(randomBytes)
			// Non-null assertion is safe: we just created a 1-byte array
			randomValue = randomBytes[0]!
		} while (randomValue >= maxValidValue)
		result += chars[randomValue % chars.length]
	}

	return result
}

/**
 * Convert ArrayBuffer to hex string
 */
export function arrayBufferToHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer)
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
}

/**
 * Convert hex string to ArrayBuffer
 */
export function hexToArrayBuffer(hex: string): ArrayBuffer {
	if (hex.length % 2 !== 0) {
		throw new Error(`Invalid hex string: length must be even (got ${hex.length})`)
	}
	const bytes = new Uint8Array(hex.length / 2)
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
	}
	return bytes.buffer
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Base error class for Devora SDK errors
 */
export class DevoraSDKError extends Error {
	readonly code: string
	readonly statusCode: number

	constructor(message: string, code: string, statusCode: number = 400) {
		super(message)
		this.name = "DevoraSDKError"
		this.code = code
		this.statusCode = statusCode
	}
}

/**
 * Security-related errors
 */
export class DevoraSecurityError extends DevoraSDKError {
	readonly securityCode: SignatureErrorCode

	constructor(message: string, securityCode: SignatureErrorCode, statusCode: number = 401) {
		super(message, `SECURITY_${securityCode}`, statusCode)
		this.name = "DevoraSecurityError"
		this.securityCode = securityCode
	}
}

/**
 * Validation errors
 */
export class DevoraValidationError extends DevoraSDKError {
	constructor(message: string, code: string = "VALIDATION_ERROR") {
		super(message, code, 400)
		this.name = "DevoraValidationError"
	}
}

/**
 * Configuration errors
 */
export class DevoraConfigError extends DevoraSDKError {
	constructor(message: string) {
		super(message, "CONFIG_ERROR", 500)
		this.name = "DevoraConfigError"
	}
}

/**
 * Network/connectivity errors
 */
export class DevoraNetworkError extends DevoraSDKError {
	constructor(message: string) {
		super(message, "NETWORK_ERROR", 503)
		this.name = "DevoraNetworkError"
	}
}
