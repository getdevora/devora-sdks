/**
 * Scope enforcement - blocks write operations in read-only mode
 * @module @devorash/browser
 *
 * Enforcement Priority:
 * 1. Check blacklist first - if match, BLOCK (regardless of method/scope)
 * 2. If scope is "write", ALLOW (blacklist already checked)
 * 3. If scope is "read" and write method, check whitelist (safeReadEndpoints)
 * 4. If not in whitelist, BLOCK
 */

import {
	isWriteMethod,
	matchEndpointPattern,
	isAmbiguousRequestPath,
	normalizeRequestPath,
	createBlockedResponse,
	type ScopeViolation,
} from "@devorash/core"
import type { ScopeEnforcerConfig } from "./types.js"

// Store original functions
let originalFetch: typeof fetch | null = null
let originalXHROpen: typeof XMLHttpRequest.prototype.open | null = null
let originalXHRSend: typeof XMLHttpRequest.prototype.send | null = null

// The wrapper functions we installed, so restore can check we're still the
// current patcher before overwriting window.fetch / XHR.prototype.open|send —
// another library (Sentry, analytics, etc.) may have patched on top of us
// since, and blindly overwriting would discard its wrapper and silently
// break it instead of leaving it layered over our (now-restored) original.
let patchedFetch: typeof fetch | null = null
let patchedXHROpen: typeof XMLHttpRequest.prototype.open | null = null
let patchedXHRSend: typeof XMLHttpRequest.prototype.send | null = null

// Track patching state
let isPatched = false
let patchEpoch = 0

// Store current config for dynamic updates
let currentConfig: ScopeEnforcerConfig | null = null

/**
 * Default URL patterns that indicate write operations even if using GET
 * (e.g., some legacy APIs use GET for mutations)
 *
 * SECURITY NOTE: These patterns are checked AFTER the allowlist, so SDK
 * endpoints are not affected by these patterns.
 */
const DEFAULT_WRITE_PATTERNS: RegExp[] = [
	/\/api\/.*\/(create|update|delete|remove)/i,
	/\/graphql.*mutation/i,
	/\/(save|submit|upload|import|export)/i,
]

/**
 * Check if a URL path matches a glob pattern
 * Supports * as wildcard (e.g., /api/filters/*)
 */
/**
 * Check if methods match (considering wildcard)
 */
function methodsMatch(patternMethod: string, requestMethod: string): boolean {
	if (patternMethod === "*") return true
	const pattern = patternMethod.toUpperCase()
	const method = requestMethod.toUpperCase()
	// Common routers dispatch HEAD to the GET handler. Match the server
	// guard's deny semantics rather than allowing a browser-only loophole.
	return pattern === method || (method === "HEAD" && pattern === "GET")
}

/**
 * Check if URL is in the blacklist (blocked endpoints)
 * Returns the matching pattern if blocked, null otherwise
 */
function isInBlacklist(
	url: string,
	method: string,
	blockedEndpoints?: Array<{ method: string; pattern: string }>
): { method: string; pattern: string } | null {
	let parsedUrl: URL
	try {
		parsedUrl = new URL(url, window.location.href)
	} catch {
		return null
	}

	if (isAmbiguousRequestPath(parsedUrl.pathname)) return { method: "*", pattern: "ambiguous path" }
	for (const endpoint of blockedEndpoints ?? []) {
		if (
			methodsMatch(endpoint.method, method) &&
			[parsedUrl.pathname, normalizeRequestPath(parsedUrl.pathname)].some((path) =>
				matchEndpointPattern(endpoint.pattern, path, {
					caseSensitive: false,
					ignoreTrailingSlash: true,
				})
			)
		) {
			return endpoint
		}
	}

	return null
}

/**
 * Check if URL is in the whitelist (safe read endpoints)
 * Only applies to write methods in read-only mode
 */
function isInWhitelist(
	url: string,
	method: string,
	safeReadEndpoints?: Array<{ method: string; pattern: string }>
): boolean {
	if (!safeReadEndpoints || safeReadEndpoints.length === 0) return false

	let parsedUrl: URL
	try {
		parsedUrl = new URL(url, window.location.href)
	} catch {
		return false
	}

	for (const endpoint of safeReadEndpoints) {
		if (
			endpoint.method.toUpperCase() === method.toUpperCase() &&
			[parsedUrl.pathname, normalizeRequestPath(parsedUrl.pathname)].every((path) =>
				matchEndpointPattern(endpoint.pattern, path)
			)
		) {
			return true
		}
	}

	return false
}

/**
 * Check if a URL should be allowed through (bypasses scope enforcement)
 * - SDK's own API calls to the Devora service origin
 *
 * SECURITY: Uses proper URL parsing to prevent bypass attacks like:
 * - https://evil.com/api/sdk/malicious (would bypass simple includes check)
 * - https://attacker.com/steal?redirect=/sdk/logs (would bypass simple includes check)
 */
function isAllowedURL(url: string, config: ScopeEnforcerConfig): boolean {
	let parsedUrl: URL
	try {
		// Parse URL relative to current origin for relative URLs
		parsedUrl = new URL(url, window.location.href)
	} catch {
		// If URL parsing fails, don't allow (fail secure)
		return false
	}

	let isDevoraApi = false
	try {
		isDevoraApi = parsedUrl.origin === new URL(config.apiUrl).origin
	} catch {
		return false
	}

	// Devora SDK API paths on the configured origin.
	const sdkPathPrefix = "/api/sdk/"

	if (isDevoraApi && parsedUrl.pathname.startsWith(sdkPathPrefix)) {
		return true
	}

	return false
}

/**
 * Check if URL matches write operation patterns
 */
function matchesWritePattern(url: string): boolean {
	return DEFAULT_WRITE_PATTERNS.some((pattern) => pattern.test(url))
}

/**
 * Extract method from fetch input
 * Handles both string URLs (with init) and Request objects
 */
function extractFetchMethod(input: RequestInfo | URL, init?: RequestInit): string {
	// If init has a method, use it (overrides Request method)
	if (init?.method) {
		return init.method.toUpperCase()
	}

	// If input is a Request object, get its method
	if (input instanceof Request) {
		return input.method.toUpperCase()
	}

	// Default to GET
	return "GET"
}

/**
 * Patch network layer to block write operations
 */
export function patchNetworkLayer(config: ScopeEnforcerConfig): void {
	if (!config.enabled || isPatched) return
	if (typeof window === "undefined") return

	isPatched = true
	patchEpoch++

	// Patch fetch
	patchFetch(config)

	// Patch XMLHttpRequest
	patchXHR(config)
}

/**
 * Restore original network functions
 */
export function restoreNetworkLayer(): void {
	if (!isPatched) return
	if (typeof window === "undefined") return

	patchEpoch++
	currentConfig = null

	// Restore fetch — only if it's still exactly our own wrapper.
	if (originalFetch) {
		if (window.fetch === patchedFetch) {
			window.fetch = originalFetch
		}
		originalFetch = null
		patchedFetch = null
	}

	// Restore XMLHttpRequest — same ownership check.
	if (originalXHROpen) {
		if (XMLHttpRequest.prototype.open === patchedXHROpen) {
			XMLHttpRequest.prototype.open = originalXHROpen
		}
		originalXHROpen = null
		patchedXHROpen = null
	}
	if (originalXHRSend) {
		if (XMLHttpRequest.prototype.send === patchedXHRSend) {
			XMLHttpRequest.prototype.send = originalXHRSend
		}
		originalXHRSend = null
		patchedXHRSend = null
	}

	isPatched = false
}

/**
 * Get the unpatched fetch function for internal SDK use.
 * This allows the SDK to make API calls even when scope enforcement is active.
 */
export function getUnpatchedFetch(): typeof fetch {
	return originalFetch ?? fetch
}

/**
 * Patch fetch API
 *
 * Enforcement Priority:
 * 1. Check if URL is SDK internal (always allow)
 * 2. Check blacklist - if match, BLOCK
 * 3. Check if write method
 * 4. If write method, check whitelist - if match, ALLOW
 * 5. If write method and not in whitelist, BLOCK
 * 6. Allow non-write methods
 */
function patchFetch(config: ScopeEnforcerConfig): void {
	const delegate = window.fetch
	const epoch = patchEpoch
	originalFetch = delegate
	currentConfig = config

	const wrappedFetch = async function (
		input: RequestInfo | URL,
		init?: RequestInit
	): Promise<Response> {
		if (epoch !== patchEpoch) return delegate.call(window, input, init)
		// Properly detect method from either init or Request object
		const method = extractFetchMethod(input, init)
		const url = input instanceof Request ? input.url : input.toString()

		// Use current config (may have been updated with dynamic scope config)
		const activeConfig = currentConfig ?? config

		// 1. Check if URL is SDK internal (always allow)
		if (isAllowedURL(url, activeConfig)) {
			return delegate.call(window, input, init)
		}

		// 2. Check blacklist FIRST - blocked regardless of scope/method
		const blockedBy = isInBlacklist(url, method, activeConfig.blockedEndpoints)
		if (blockedBy) {
			const violation: ScopeViolation = {
				type: "write_attempt",
				method,
				url,
				timestamp: Date.now(),
			}

			if (activeConfig.showWarnings) {
				console.warn(
					`[Devora] Blocked ${method} request by blacklist (${blockedBy.method} ${blockedBy.pattern}):`,
					warningPath(url)
				)
			}

			if (activeConfig.onViolation) {
				activeConfig.onViolation(violation)
			}

			return createBlockedResponse(method, url)
		}

		// 3. Check if this is a write operation (by method or URL pattern)
		const isWriteOperation =
			activeConfig.scope === "read" && (isWriteMethod(method) || matchesWritePattern(url))

		if (isWriteOperation) {
			// 4. Check whitelist (safeReadEndpoints) for write methods
			if (isInWhitelist(url, method, activeConfig.safeReadEndpoints)) {
				// Whitelisted - allow through
				return delegate.call(window, input, init)
			}

			// 5. Not whitelisted - block write operation
			const violation: ScopeViolation = {
				type: "write_attempt",
				method,
				url,
				timestamp: Date.now(),
			}

			if (activeConfig.showWarnings) {
				console.warn(`[Devora] Blocked ${method} request in read-only mode:`, warningPath(url))
			}

			if (activeConfig.onViolation) {
				activeConfig.onViolation(violation)
			}

			return createBlockedResponse(method, url)
		}

		// 6. Allow read operations
		return delegate.call(window, input, init)
	}

	patchedFetch = wrappedFetch
	window.fetch = wrappedFetch
}

/**
 * Patch XMLHttpRequest
 *
 * Uses same enforcement priority as fetch:
 * 1. Check if URL is SDK internal (always allow)
 * 2. Check blacklist - if match, BLOCK
 * 3. Check if write method
 * 4. If write method, check whitelist - if match, ALLOW
 * 5. If write method and not in whitelist, BLOCK
 */
function patchXHR(config: ScopeEnforcerConfig): void {
	const delegateOpen = XMLHttpRequest.prototype.open
	const delegateSend = XMLHttpRequest.prototype.send
	const epoch = patchEpoch
	originalXHROpen = delegateOpen
	originalXHRSend = delegateSend

	// Track request info per XHR instance
	const requestInfo = new WeakMap<
		XMLHttpRequest,
		{ method: string; url: string; blocked: boolean; blockedReason?: string }
	>()

	// Patch open to track method and URL
	const wrappedOpen = function (
		this: XMLHttpRequest,
		method: string,
		url: string | URL,
		async: boolean = true,
		username?: string | null,
		password?: string | null
	): void {
		if (epoch !== patchEpoch) return delegateOpen.call(this, method, url, async, username, password)
		const urlString = url.toString()
		const methodUpper = method.toUpperCase()

		// Use current config (may have been updated)
		const activeConfig = currentConfig ?? config

		// 1. Check if SDK internal URL
		if (isAllowedURL(urlString, activeConfig)) {
			requestInfo.set(this, {
				method: methodUpper,
				url: urlString,
				blocked: false,
			})
			return delegateOpen.call(this, method, url, async, username, password)
		}

		// 2. Check blacklist FIRST
		const blockedBy = isInBlacklist(urlString, methodUpper, activeConfig.blockedEndpoints)
		if (blockedBy) {
			requestInfo.set(this, {
				method: methodUpper,
				url: urlString,
				blocked: true,
				blockedReason: `blacklist: ${blockedBy.method} ${blockedBy.pattern}`,
			})
			return delegateOpen.call(this, method, url, async, username, password)
		}

		// 3. Check if write operation
		const isWriteOperation =
			activeConfig.scope === "read" &&
			(isWriteMethod(methodUpper) || matchesWritePattern(urlString))

		if (isWriteOperation) {
			// 4. Check whitelist
			if (isInWhitelist(urlString, methodUpper, activeConfig.safeReadEndpoints)) {
				requestInfo.set(this, {
					method: methodUpper,
					url: urlString,
					blocked: false,
				})
				return delegateOpen.call(this, method, url, async, username, password)
			}

			// 5. Not whitelisted - block
			requestInfo.set(this, {
				method: methodUpper,
				url: urlString,
				blocked: true,
				blockedReason: "write method not in whitelist",
			})
		} else {
			// Allow non-write operations
			requestInfo.set(this, {
				method: methodUpper,
				url: urlString,
				blocked: false,
			})
		}

		return delegateOpen.call(this, method, url, async, username, password)
	}

	// Patch send to block write requests
	const wrappedSend = function (
		this: XMLHttpRequest,
		body?: Document | XMLHttpRequestBodyInit | null
	): void {
		if (epoch !== patchEpoch) return delegateSend.call(this, body)
		const info = requestInfo.get(this)

		if (info?.blocked) {
			const violation: ScopeViolation = {
				type: "write_attempt",
				method: info.method,
				url: info.url,
				timestamp: Date.now(),
			}

			// Use current config for warnings/callbacks
			const activeConfig = currentConfig ?? config

			if (activeConfig.showWarnings) {
				const reason = info.blockedReason ?? "read-only mode"
				console.warn(
					`[Devora] Blocked ${info.method} XHR request (${reason}):`,
					warningPath(info.url)
				)
			}

			if (activeConfig.onViolation) {
				activeConfig.onViolation(violation)
			}

			// Trigger error event
			setTimeout(() => {
				const errorEvent = new ProgressEvent("error")
				this.dispatchEvent(errorEvent)
			}, 0)

			return
		}

		return delegateSend.call(this, body)
	}

	patchedXHROpen = wrappedOpen
	patchedXHRSend = wrappedSend
	XMLHttpRequest.prototype.open = wrappedOpen
	XMLHttpRequest.prototype.send = wrappedSend
}

/**
 * Check if network layer is patched
 */
export function isNetworkPatched(): boolean {
	return isPatched
}

/**
 * Update scope config dynamically.
 * Called when fresh config is fetched from Devora API.
 */
export function updateScopeConfig(
	safeReadEndpoints?: Array<{ method: string; pattern: string }>,
	blockedEndpoints?: Array<{ method: string; pattern: string }>
): void {
	if (currentConfig) {
		currentConfig = {
			...currentConfig,
			safeReadEndpoints,
			blockedEndpoints,
		}
	}
}

/**
 * Get current scope config (for debugging)
 */
export function getCurrentScopeConfig(): ScopeEnforcerConfig | null {
	return currentConfig
}

/**
 * The path of a blocked request for console warnings: no origin, query or
 * fragment (they can hold tokens), since console output may be recorded.
 */
function warningPath(url: string): string {
	try {
		return new URL(url, typeof location === "undefined" ? "https://app.invalid" : location.href)
			.pathname
	} catch {
		return "[unparseable URL]"
	}
}
