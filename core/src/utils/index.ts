/**
 * Utility functions for Devora SDKs
 * @module @devorash/core/utils
 */

import type { DevoraResponse, ImpersonationScope, LogEvent, SDKInfo } from "../types/index.js"
import { SDK_VERSION } from "../constants/index.js"

// ============================================================================
// Response Helpers
// ============================================================================

/**
 * Create a successful SDK response
 */
export function createSuccessResponse<T>(data: T): DevoraResponse<T> {
	return {
		success: true,
		data,
		timestamp: Date.now(),
	}
}

/**
 * Create an error SDK response
 */
export function createErrorResponse(error: string, errorCode?: string): DevoraResponse<never> {
	return {
		success: false,
		error,
		errorCode,
		timestamp: Date.now(),
	}
}

// ============================================================================
// URL Helpers
// ============================================================================

/**
 * Extract URL parameters.
 */
export function extractUrlParams(url: string): Record<string, string | undefined> {
	try {
		const urlObj = new URL(url, "http://placeholder")
		const params: Record<string, string | undefined> = {}

		for (const [key, value] of urlObj.searchParams.entries()) {
			params[key] = value
		}

		return params
	} catch {
		return {}
	}
}

/**
 * Clean impersonation parameters from URL
 * Handles both absolute and relative URLs
 */
export function cleanImpersonationParams(url: string): string {
	const PLACEHOLDER_BASE = "http://placeholder.local"
	// The code travels in the fragment; drop it there too, keeping router state.
	const stripFragment = (hash: string) => {
		let previous: string
		do {
			previous = hash
			hash = hash
				.replace(/([?&])devora_exchange=[^&]*&?/, (_m, sep: string) => sep)
				.replace(/^#devora_exchange=[^&]*&?/, "#")
		} while (hash !== previous)
		return hash.replace(/[?&]$/, "").replace(/^#$/, "")
	}

	try {
		// First try parsing as absolute URL
		const urlObj = new URL(url)
		urlObj.searchParams.delete("devora_exchange")
		urlObj.hash = stripFragment(urlObj.hash)
		return urlObj.toString()
	} catch {
		// Handle relative URLs by parsing with placeholder base
		try {
			const urlObj = new URL(url, PLACEHOLDER_BASE)
			urlObj.searchParams.delete("devora_exchange")
			urlObj.hash = stripFragment(urlObj.hash)

			// Return relative form: pathname + search + hash
			const search = urlObj.search
			const hash = urlObj.hash
			return `${urlObj.pathname}${search}${hash}`
		} catch {
			// If all parsing fails, return original (shouldn't happen with valid relative URLs)
			return url
		}
	}
}

// ============================================================================
// Path Matching
// ============================================================================

/**
 * Match a path pattern against an actual path
 * Supports :param patterns (e.g., /impersonate/:id)
 */
export function matchPath(
	pattern: string,
	path: string
): { match: boolean; params: Record<string, string> } {
	const patternParts = pattern.split("/").filter(Boolean)
	const pathParts = path.split("/").filter(Boolean)

	if (patternParts.length !== pathParts.length) {
		return { match: false, params: {} }
	}

	const params: Record<string, string> = {}

	for (let i = 0; i < patternParts.length; i++) {
		const patternPart = patternParts[i]!
		const pathPart = pathParts[i]!

		if (patternPart.startsWith(":")) {
			// This is a parameter
			const paramName = patternPart.slice(1)
			params[paramName] = safeDecodePathPart(pathPart)
		} else if (patternPart !== pathPart) {
			// Static part doesn't match
			return { match: false, params: {} }
		}
	}

	return { match: true, params }
}

function safeDecodePathPart(value: string): string {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

/**
 * Extract path parameters from a matched route
 */
export function extractPathParams(pattern: string, path: string): Record<string, string> {
	const result = matchPath(pattern, path)
	return result.params
}

// ============================================================================
// Scope Helpers
// ============================================================================

/**
 * Check if a scope allows write operations
 */
export function scopeAllowsWrite(scope: ImpersonationScope): boolean {
	return scope === "write"
}

/**
 * Get human-readable scope description
 */
export function getScopeDescription(scope: ImpersonationScope): string {
	switch (scope) {
		case "read":
			return "Read-only access (view only, no changes allowed)"
		case "write":
			return "Full access (can view and modify)"
		default:
			return "Unknown scope"
	}
}

// ============================================================================
// Logging Helpers
// ============================================================================

/**
 * Create a log event
 */
export function createLogEvent(
	type: LogEvent["type"],
	sessionId: string,
	options: Partial<Omit<LogEvent, "type" | "sessionId" | "timestamp">> = {}
): LogEvent {
	return {
		type,
		sessionId,
		timestamp: Date.now(),
		...options,
	}
}

// ============================================================================
// SDK Info Helpers
// ============================================================================

/**
 * Create SDK info object
 */
export function createSDKInfo(
	name: string,
	type: SDKInfo["type"],
	runtime?: SDKInfo["runtime"]
): SDKInfo {
	return {
		name,
		version: SDK_VERSION,
		type,
		runtime,
	}
}

// ============================================================================
// Logger Service
// ============================================================================

/**
 * Log levels in order of severity (lower = more verbose)
 */
export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
	SILENT = 4,
}

/**
 * Logger configuration options
 */
export interface LoggerConfig {
	/** Minimum log level to output (default: WARN in production, DEBUG in development) */
	level?: LogLevel
	/** Custom prefix for log messages (default: "Devora") */
	prefix?: string
	/** Enable/disable logging entirely (overrides level) */
	enabled?: boolean
	/** Include timestamp in log messages */
	includeTimestamp?: boolean
	/** Custom log handler (for testing or custom logging backends) */
	handler?: LogHandler
}

/**
 * Custom log handler interface
 */
export interface LogHandler {
	debug: (...args: unknown[]) => void
	info: (...args: unknown[]) => void
	warn: (...args: unknown[]) => void
	error: (...args: unknown[]) => void
}

/**
 * Logger instance interface
 */
export interface Logger {
	debug: (...args: unknown[]) => void
	log: (...args: unknown[]) => void // Alias for info
	info: (...args: unknown[]) => void
	warn: (...args: unknown[]) => void
	error: (...args: unknown[]) => void
	setLevel: (level: LogLevel) => void
	setEnabled: (enabled: boolean) => void
	isEnabled: () => boolean
	getLevel: () => LogLevel
}

/**
 * Global logger configuration (can be set at app initialization)
 */
let globalLoggerConfig: LoggerConfig = {
	level: undefined, // Will be auto-detected
	enabled: undefined, // Will be auto-detected
	prefix: "Devora",
	includeTimestamp: false,
}

/**
 * Detect if we're in development mode
 */
function isDevEnvironment(): boolean {
	// Check common environment variables
	if (typeof process !== "undefined") {
		const nodeEnv = process.env?.NODE_ENV
		if (nodeEnv === "development" || nodeEnv === "dev") return true
		if (nodeEnv === "production" || nodeEnv === "prod") return false
	}

	// Browser: check for localhost
	// Use globalThis for cross-platform compatibility (browser and Node.js)
	const globalWindow =
		typeof globalThis !== "undefined"
			? (globalThis as { window?: { location?: { hostname?: string } } }).window
			: undefined
	if (globalWindow?.location?.hostname) {
		const hostname = globalWindow.location.hostname
		if (hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".local")) {
			return true
		}
	}

	// Default to production (safer)
	return false
}

/**
 * Get default log level based on environment
 */
function getDefaultLogLevel(): LogLevel {
	return isDevEnvironment() ? LogLevel.DEBUG : LogLevel.WARN
}

/**
 * Get default enabled state based on environment
 */
function getDefaultEnabled(): boolean {
	return isDevEnvironment()
}

/**
 * Configure the global logger settings.
 * Call this once at your application's entry point.
 *
 * @example
 * ```typescript
 * import { configureLogger, LogLevel } from "@devorash/core"
 *
 * // Enable verbose logging in development
 * configureLogger({
 *   level: LogLevel.DEBUG,
 *   enabled: true,
 *   includeTimestamp: true,
 * })
 *
 * // Disable all logging in production
 * configureLogger({
 *   enabled: false,
 * })
 * ```
 */
export function configureLogger(config: Partial<LoggerConfig>): void {
	globalLoggerConfig = {
		...globalLoggerConfig,
		...config,
	}
}

/**
 * Get the current global logger configuration
 */
export function getLoggerConfig(): LoggerConfig {
	return { ...globalLoggerConfig }
}

/**
 * Reset logger configuration to defaults
 */
export function resetLoggerConfig(): void {
	globalLoggerConfig = {
		level: undefined,
		enabled: undefined,
		prefix: "Devora",
		includeTimestamp: false,
	}
}

/**
 * Format a log message with prefix and optional timestamp
 */
function formatLogPrefix(prefix: string, includeTimestamp: boolean): string {
	if (includeTimestamp) {
		const now = new Date()
		const time = now.toISOString().slice(11, 23) // HH:MM:SS.mmm
		return `[${time}] [${prefix}]`
	}
	return `[${prefix}]`
}

/**
 * Create a logger instance with the given options.
 *
 * @param prefix - Prefix for log messages (e.g., "Devora SDK", "Devora React")
 * @param enabled - Override to enable/disable this specific logger
 * @returns Logger instance
 *
 * @example
 * ```typescript
 * const logger = createLogger("MyComponent")
 * logger.debug("Initializing...")
 * logger.info("Ready")
 * logger.warn("Something unexpected happened")
 * logger.error("Failed!", error)
 * ```
 */
export function createLogger(prefix?: string, enabled?: boolean): Logger {
	let instanceEnabled = enabled
	let instanceLevel: LogLevel | undefined

	const getEffectiveEnabled = (): boolean => {
		if (instanceEnabled !== undefined) return instanceEnabled
		if (globalLoggerConfig.enabled !== undefined) return globalLoggerConfig.enabled
		return getDefaultEnabled()
	}

	const getEffectiveLevel = (): LogLevel => {
		if (instanceLevel !== undefined) return instanceLevel
		if (globalLoggerConfig.level !== undefined) return globalLoggerConfig.level
		return getDefaultLogLevel()
	}

	const getPrefix = (): string => {
		return prefix ?? globalLoggerConfig.prefix ?? "Devora"
	}

	const shouldLog = (level: LogLevel): boolean => {
		if (!getEffectiveEnabled()) return false
		return level >= getEffectiveLevel()
	}

	const getHandler = (): LogHandler => {
		return (
			globalLoggerConfig.handler ?? {
				debug: console.debug ?? console.log,
				info: console.info ?? console.log,
				warn: console.warn ?? console.log,
				error: console.error ?? console.log,
			}
		)
	}

	const formatPrefix = (): string => {
		return formatLogPrefix(getPrefix(), globalLoggerConfig.includeTimestamp ?? false)
	}

	return {
		debug: (...args: unknown[]) => {
			if (shouldLog(LogLevel.DEBUG)) {
				getHandler().debug(formatPrefix(), ...args)
			}
		},
		log: (...args: unknown[]) => {
			// Alias for info
			if (shouldLog(LogLevel.INFO)) {
				getHandler().info(formatPrefix(), ...args)
			}
		},
		info: (...args: unknown[]) => {
			if (shouldLog(LogLevel.INFO)) {
				getHandler().info(formatPrefix(), ...args)
			}
		},
		warn: (...args: unknown[]) => {
			if (shouldLog(LogLevel.WARN)) {
				getHandler().warn(formatPrefix(), ...args)
			}
		},
		error: (...args: unknown[]) => {
			// Errors are always logged unless explicitly disabled
			if (getEffectiveEnabled() || globalLoggerConfig.enabled === undefined) {
				getHandler().error(formatPrefix(), ...args)
			}
		},
		setLevel: (level: LogLevel) => {
			instanceLevel = level
		},
		setEnabled: (enabled: boolean) => {
			instanceEnabled = enabled
		},
		isEnabled: () => getEffectiveEnabled(),
		getLevel: () => getEffectiveLevel(),
	}
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate API key format
 */
export function validateApiKeyFormat(apiKey: string): {
	valid: boolean
	type?: "server" | "client"
} {
	// Expected formats:
	// Server ID: pk_server_live_xxx
	// Client ID: pk_client_live_xxx

	if (/^pk_server_live_[a-zA-Z0-9_-]+$/.test(apiKey)) {
		return { valid: true, type: "server" }
	}

	if (/^pk_client_live_[a-zA-Z0-9_-]+$/.test(apiKey)) {
		return { valid: true, type: "client" }
	}

	return { valid: false }
}

/**
 * Validate organization ID format
 */
export function validateOrgIdFormat(orgId: string): boolean {
	// Expected format: org_xxx
	return /^org_[a-zA-Z0-9]+$/.test(orgId)
}

// ============================================================================
// Header Utilities
// ============================================================================

/**
 * Get header value from headers object (handles array values and case-insensitive lookup)
 */
export function getHeaderValue(
	headers: Record<string, string | string[] | undefined>,
	key: string
): string | undefined {
	const value = headers[key] ?? headers[key.toLowerCase()]
	if (Array.isArray(value)) {
		return value[0]
	}
	return value
}

/**
 * Get HTTP status code from Devora error code
 */
export function getErrorStatusCode(errorCode?: string): number {
	if (!errorCode) return 400

	// Impersonation context errors -> 401 Unauthorized
	if (
		errorCode === "INVALID_IMPERSONATION_CONTEXT" ||
		errorCode === "IMPERSONATION_EXPIRED" ||
		errorCode === "IMPERSONATION_SESSION_ENDED"
	) {
		return 401
	}

	// Impersonation policy or the Devora request claim unavailable -> 503 (fail closed)
	if (
		errorCode === "IMPERSONATION_POLICY_UNAVAILABLE" ||
		errorCode === "REQUEST_CLAIM_UNAVAILABLE"
	) {
		return 503
	}

	// A signed request id Devora has already seen claimed -> 401
	if (errorCode === "REPLAYED_REQUEST") return 401

	// A start request for a session Devora is no longer starting -> 409
	if (errorCode === "SESSION_NOT_STARTABLE") return 409

	// The body digest is over wire bytes; encoded bodies are refused -> 415
	if (errorCode === "UNSUPPORTED_CONTENT_ENCODING") return 415

	// Impersonation scope/endpoint blocks -> 403 Forbidden
	if (
		errorCode === "IMPERSONATION_ENDPOINT_BLOCKED" ||
		errorCode === "IMPERSONATION_SCOPE_VIOLATION"
	) {
		return 403
	}

	// Security errors -> 401 Unauthorized
	if (
		errorCode.includes("SECURITY") ||
		errorCode.includes("SIGNATURE") ||
		errorCode.includes("TIMESTAMP") ||
		errorCode.includes("MISSING_HEADERS") ||
		errorCode.includes("ORG_MISMATCH")
	) {
		return 401
	}

	// Not found -> 404
	if (errorCode === "NOT_FOUND") {
		return 404
	}

	// Scope violations -> 403 Forbidden
	if (errorCode.includes("SCOPE") || errorCode.includes("WRITE_BLOCKED")) {
		return 403
	}

	// Payload too large -> 413
	if (errorCode.includes("BODY_TOO_LARGE") || errorCode.includes("PAYLOAD_TOO_LARGE")) {
		return 413
	}

	// Rate limited -> 429
	if (errorCode.includes("RATE_LIMITED") || errorCode.includes("TOO_MANY_REQUESTS")) {
		return 429
	}

	// Internal server errors -> 500
	if (errorCode === "INTERNAL_ERROR") {
		return 500
	}

	// Default -> 400 Bad Request
	return 400
}

// ============================================================================
// Rate Limiting
// ============================================================================

/**
 * Simple rate limiter for SDK API calls
 */
export class RateLimiter {
	private maxRequests: number
	private windowMs: number
	private requests: number[] = []

	constructor(maxRequests: number = 10, windowMs: number = 1000) {
		this.maxRequests = maxRequests
		this.windowMs = windowMs
	}

	/**
	 * Check if a request is allowed
	 */
	isAllowed(): boolean {
		const now = Date.now()
		// Remove old requests outside the window
		this.requests = this.requests.filter((t) => now - t < this.windowMs)

		if (this.requests.length >= this.maxRequests) {
			return false
		}

		this.requests.push(now)
		return true
	}

	/**
	 * Get remaining requests in current window
	 */
	getRemaining(): number {
		const now = Date.now()
		this.requests = this.requests.filter((t) => now - t < this.windowMs)
		return Math.max(0, this.maxRequests - this.requests.length)
	}

	/**
	 * Reset the rate limiter
	 */
	reset(): void {
		this.requests = []
	}

	/**
	 * Wait until a request is allowed
	 * Uses iterative approach to avoid stack overflow under sustained load
	 */
	async waitForSlot(): Promise<void> {
		while (true) {
			const now = Date.now()
			// Filter stale requests outside the window
			this.requests = this.requests.filter((t) => now - t < this.windowMs)

			if (this.requests.length < this.maxRequests) {
				this.requests.push(now)
				return
			}

			// Calculate wait time based on oldest request
			const oldestRequest = this.requests[0]
			if (oldestRequest) {
				const waitTime = this.windowMs - (now - oldestRequest) + 10
				await new Promise((resolve) => setTimeout(resolve, Math.max(waitTime, 10)))
			}
		}
	}
}

// ============================================================================
// Miscellaneous
// ============================================================================

/**
 * Safely parse JSON
 */
export function safeJsonParse<T>(json: string, fallback: T): T {
	try {
		return JSON.parse(json) as T
	} catch {
		return fallback
	}
}

/**
 * Safely stringify JSON
 */
export function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value)
	} catch {
		return "{}"
	}
}

/**
 * Deep freeze an object (make immutable)
 */
export function deepFreeze<T extends object>(obj: T): Readonly<T> {
	Object.freeze(obj)

	for (const key of Object.keys(obj)) {
		const value = (obj as Record<string, unknown>)[key]
		if (value && typeof value === "object" && !Object.isFrozen(value)) {
			deepFreeze(value as object)
		}
	}

	return obj as Readonly<T>
}

/**
 * Create a deferred promise
 */
export function createDeferred<T>(): {
	promise: Promise<T>
	resolve: (value: T) => void
	reject: (reason?: unknown) => void
} {
	let resolve!: (value: T) => void
	let reject!: (reason?: unknown) => void

	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})

	return { promise, resolve, reject }
}
