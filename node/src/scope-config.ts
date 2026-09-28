/**
 * Scope configuration fetching and caching for backend SDK
 *
 * Fetches centrally managed whitelist and blacklist configuration from the Devora platform
 * and caches it with automatic refresh.
 *
 * @module @devorash/node
 */

import { SDK_DEFAULTS, createLogger, type Logger } from "@devorash/core"
import { controlPlaneFetch, readBoundedJsonObject } from "./transport.js"

/** Largest accepted policy: entries per list, and the longest pattern. */
const MAX_POLICY_ENTRIES = 1000
const MAX_PATTERN_LENGTH = 500
/** A server-sent cache horizon is never trusted beyond this. */
const MAX_POLICY_TTL_MS = 60 * 60 * 1000

function readEndpoints(value: unknown): ScopeEndpoint[] | null {
	if (!Array.isArray(value) || value.length > MAX_POLICY_ENTRIES) return null
	const endpoints: ScopeEndpoint[] = []
	for (const entry of value) {
		const method = (entry as { method?: unknown } | null)?.method
		const pattern = (entry as { pattern?: unknown } | null)?.pattern
		if (
			typeof method !== "string" ||
			!/^(\*|[A-Z]{3,7})(?![\s\S])/.test(method) ||
			typeof pattern !== "string" ||
			!pattern ||
			pattern.length > MAX_PATTERN_LENGTH
		)
			return null
		endpoints.push({ method, pattern })
	}
	return endpoints
}

/** Validate a policy response; `null` when any part is malformed (fail closed). */
function readPolicy(data: unknown, now: number): ScopeConfig | null {
	if (!data || typeof data !== "object" || Array.isArray(data)) return null
	const source = data as Record<string, unknown>
	const safeReadEndpoints = readEndpoints(source.safeReadEndpoints)
	const blockedEndpoints = readEndpoints(source.blockedEndpoints)
	const version = source.version
	const requested = source.cachedUntil
	// Missing policy fields must not become an empty deny list. The server
	// always sends all four fields, including an explicit version zero.
	if (
		!safeReadEndpoints ||
		!blockedEndpoints ||
		typeof version !== "number" ||
		!Number.isSafeInteger(version) ||
		version < 0 ||
		typeof requested !== "number" ||
		!Number.isSafeInteger(requested) ||
		requested <= 0
	)
		return null
	return {
		safeReadEndpoints,
		blockedEndpoints,
		version: version as number,
		cachedUntil: Math.min(Math.max(requested, now), now + MAX_POLICY_TTL_MS),
	}
}

/**
 * Scope endpoint configuration
 */
export interface ScopeEndpoint {
	method: string
	pattern: string
}

/**
 * Scope configuration
 */
export interface ScopeConfig {
	/** Whitelist: Safe endpoints allowed in read-only mode */
	safeReadEndpoints: ScopeEndpoint[]
	/** Blacklist: Endpoints blocked during ANY impersonation */
	blockedEndpoints: ScopeEndpoint[]
	/** Configuration version */
	version: number
	/** When the cache expires (Unix ms) */
	cachedUntil: number
}

/**
 * Scope config fetcher options
 */
export interface ScopeConfigFetcherOptions {
	/** Public server API key identifier */
	apiKey: string
	/**
	 * Returns fresh signature headers for `GET /api/sdk/scope-config` (request
	 * signing v3, customer-to-devora). The policy is not public; `devoraSDK`
	 * supplies this from its server secret.
	 */
	signRequest: () => Record<string, string>
	/** Devora API origin (default: the origin baked into the SDK at build time) */
	apiUrl?: string
	/** Enable debug logging */
	debug?: boolean
	/**
	 * Cache TTL in milliseconds applied when a 304 revalidates an existing
	 * policy (default: 5 minutes, matching the server). A cached policy is served
	 * for at most `STALE_GRACE_MS` past its window when Devora is unreachable.
	 */
	cacheTtlMs?: number
}

/** How long a cached policy may be served past its window during an outage. */
export const STALE_GRACE_MS = 5 * 60 * 1000
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000

/**
 * Create a scope config fetcher
 *
 * Handles fetching scope configuration from Devora API with caching
 * and automatic background refresh.
 */
export function createScopeConfigFetcher(options: ScopeConfigFetcherOptions): {
	getConfig: () => Promise<ScopeConfig | null>
	getCachedConfig: () => ScopeConfig | null
	refresh: () => Promise<ScopeConfig | null>
	stop: () => void
} {
	const {
		signRequest,
		apiUrl = SDK_DEFAULTS.API_URL,
		debug = false,
		cacheTtlMs = DEFAULT_CACHE_TTL_MS,
	} = options
	if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs <= 0 || cacheTtlMs > MAX_POLICY_TTL_MS)
		throw new Error("Devora SDK: cacheTtlMs must be an integer between 1 and 3600000")

	const logger: Logger = createLogger("Devora ScopeConfig", debug)

	let cachedConfig: ScopeConfig | null = null
	let refreshTimer: ReturnType<typeof setTimeout> | null = null
	let pendingFetch: Promise<ScopeConfig | null> | null = null
	let etag: string | null = null
	let staleUntil = 0

	/**
	 * Fetch scope config from Devora API
	 */
	async function fetchConfig(): Promise<ScopeConfig | null> {
		if (pendingFetch) return pendingFetch
		pendingFetch = (async () => {
			try {
				const response = await controlPlaneFetch(`${apiUrl}/api/sdk/scope-config`, {
					method: "GET",
					headers: {
						...signRequest(),
						...(etag ? { "If-None-Match": etag } : {}),
					},
				})
				if (response.status === 304 && cachedConfig) {
					// A 304 re-validates the whole server window. Using a shorter TTL
					// here would multiply request volume against the per-key rate limit.
					const cachedUntil = Date.now() + cacheTtlMs
					cachedConfig = { ...cachedConfig, cachedUntil }
					staleUntil = cachedUntil + STALE_GRACE_MS
					return cachedConfig
				}

				if (!response.ok) {
					logger.warn("Failed to fetch scope config:", response.status)
					return cachedConfig && Date.now() < staleUntil ? cachedConfig : null
				}

				const result = await readBoundedJsonObject(response)
				const config = result.success === true ? readPolicy(result.data, Date.now()) : null
				if (!config) {
					logger.warn("Invalid scope config response")
					return cachedConfig && Date.now() < staleUntil ? cachedConfig : null
				}

				const previousVersion = cachedConfig?.version
				etag = response.headers.get("etag")
				cachedConfig = config
				staleUntil = config.cachedUntil + STALE_GRACE_MS
				if (previousVersion === undefined || config.version !== previousVersion) {
					logger.log("Scope config updated", {
						version: config.version,
						whitelist: config.safeReadEndpoints.length,
						blacklist: config.blockedEndpoints.length,
					})
				}

				return cachedConfig
			} catch (e) {
				logger.warn("Error fetching scope config:", e)
				return cachedConfig && Date.now() < staleUntil ? cachedConfig : null
			} finally {
				pendingFetch = null
			}
		})()
		return pendingFetch
	}

	/**
	 * Schedule background refresh
	 */
	function scheduleRefresh(): void {
		if (refreshTimer) {
			clearTimeout(refreshTimer)
		}

		// Refresh 30s before expiry. The floor must stay below the window or the
		// timer can never keep the cache warm and requests pay a synchronous fetch.
		const refreshIn = cachedConfig?.cachedUntil
			? Math.max(cachedConfig.cachedUntil - Date.now() - 30_000, Math.min(cacheTtlMs / 2, 60_000))
			: cacheTtlMs

		refreshTimer = setTimeout(async () => {
			await fetchConfig()
			scheduleRefresh()
		}, refreshIn)
		// Don't let the background refresh loop keep a process (script, test, serverless
		// invocation) alive on its own.
		refreshTimer.unref?.()
	}

	/**
	 * Get config (fetch if not cached or expired)
	 */
	async function getConfig(): Promise<ScopeConfig | null> {
		// Return cached if still valid
		if (cachedConfig && Date.now() < cachedConfig.cachedUntil) {
			return cachedConfig
		}

		// Fetch fresh config
		const config = await fetchConfig()

		// Schedule background refresh
		if (config && !refreshTimer) {
			scheduleRefresh()
		}

		return config
	}

	/**
	 * Get cached config without fetching
	 */
	function getCachedConfig(): ScopeConfig | null {
		return cachedConfig
	}

	/**
	 * Force refresh config
	 */
	async function refresh(): Promise<ScopeConfig | null> {
		return fetchConfig()
	}

	/**
	 * Stop background refresh
	 */
	function stop(): void {
		if (refreshTimer) {
			clearTimeout(refreshTimer)
			refreshTimer = null
		}
	}

	return {
		getConfig,
		getCachedConfig,
		refresh,
		stop,
	}
}
