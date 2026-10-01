/**
 * Main Devora Frontend SDK implementation
 * @module @devorash/browser
 */

import { normalizeCustomAction } from "./capture-privacy.js"
import {
	SDK_DEFAULTS,
	createLogger,
	SDK_END_REASON,
	validateApiKeyFormat,
	type ImpersonatePayload,
	type ScopeViolation,
	type Logger,
	type DevoraCaptureSnapshot,
} from "@devorash/core"

import {
	cleanURL,
	exchangePayload,
	getExchangeCodeFromURL,
	getExchangeVerifier,
	hasUntakenExchangeInURL,
	settleExchange,
	resumeSession,
	validateStoredSession,
} from "./token-detector.js"
import { withDeadline } from "./deadline.js"
import { tryKeepaliveFetch } from "./keepalive.js"
import { TabCoordinator, type SessionNotice } from "./tab-coordination.js"
import { patchNetworkLayer, restoreNetworkLayer, updateScopeConfig } from "./scope-enforcer.js"
import { SessionRecorder, getRecorderTabId, setRecorderTabId } from "./session-recorder.js"
import { ActivityLogger } from "./activity-logger.js"
import { PresenceHeartbeat } from "./presence-heartbeat.js"
import { buildRrwebPrivacyOptions, resolveMasking, type ResolvedMasking } from "./masking.js"
import type {
	DevoraFrontendSDK,
	JSFrontendSDKConfig,
	SessionState,
	SDKEventType,
	SDKEventListener,
	SDKEvent,
	DecryptedPayload,
	BridgeState,
	ResumedSession,
	SessionRevocationState,
} from "./types.js"

/** Longest a session end holds host logout for the final capture flush. */
const FINAL_CAPTURE_LOGOUT_WAIT_MS = 1_000

/**
 * Resolve and validate the Devora API origin.
 * Only https origins are accepted (http for localhost/127.0.0.1 development).
 */
function resolveApiUrl(override: string | undefined): string {
	if (!override) return SDK_DEFAULTS.API_URL
	let parsed: URL
	try {
		parsed = new URL(override)
	} catch {
		throw new Error(`Devora SDK: apiUrl is not a valid URL: ${override}`)
	}
	const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) {
		throw new Error("Devora SDK: apiUrl must use https (http is allowed for localhost only)")
	}
	if (
		parsed.username ||
		parsed.password ||
		(parsed.pathname && parsed.pathname !== "/") ||
		parsed.search ||
		parsed.hash
	) {
		throw new Error("Devora SDK: apiUrl must be an origin without path, query, or credentials")
	}
	return parsed.origin
}

/**
 * Create Devora Frontend SDK
 */
export function createDevoraSDK(): DevoraFrontendSDK {
	// SDK state
	let initialized = false
	let config: JSFrontendSDKConfig | null = null
	let sessionState: SessionState = {
		isActive: false,
		sessionId: null,
		scope: null,
		expiresAt: null,
		userId: null,
		targetUser: null,
		impersonator: null,
	}
	let sessionRecorder: SessionRecorder | null = null
	let activityLogger: ActivityLogger | null = null
	let presenceHeartbeat: PresenceHeartbeat | null = null
	let devoraSessionToken: string | null = null
	// Resolved API origin (config override or the build-time default).
	let apiUrl: string = SDK_DEFAULTS.API_URL
	// Resolved privacy masking rules; shared by the recorder and the activity logger.
	let masking: ResolvedMasking = resolveMasking(undefined)
	// Bumped by destroy(); in-flight init() aborts when it observes a newer generation.
	// Makes React StrictMode double-mount (init → destroy → init) deterministic.
	let lifecycleGeneration = 0
	// Synchronous guard so concurrent terminators (expiry timer + validation poll + user end())
	// cannot double-run cleanup, double-fire onSessionEnd, or double-notify the backend.
	let endSessionTask: Promise<void> | null = null
	let revocationState: SessionRevocationState = { status: "none" }
	// Only this SDK instance may hand an unconsumed link to a replacement init.
	// The secret never returns to the URL or persistent storage.
	let pendingExchange: {
		code: string
		verifier: Promise<string | null>
		apiKey: string
		apiUrl: string
		expiresAt: number
		promise?: Promise<DecryptedPayload | null>
	} | null = null
	let exchangeExpiry: ReturnType<typeof setTimeout> | null = null
	function clearPendingExchange(): void {
		pendingExchange = null
		if (exchangeExpiry) clearTimeout(exchangeExpiry)
		exchangeExpiry = null
	}
	function expirePendingExchange(): void {
		clearPendingExchange()
		settleExchange()
	}
	let impersonateCallback: ((payload: ImpersonatePayload) => void | Promise<void>) | null = null
	let sessionEndCallback: ((reason: string) => void | Promise<void>) | null = null
	let sessionExpiredCallback: (() => void | Promise<void>) | null = null
	let expirationTimer: ReturnType<typeof setTimeout> | null = null
	let validationInterval: ReturnType<typeof setInterval> | null = null
	// Per-tab identity and cross-tab lifecycle coordination (non-secret only).
	const tabs = new TabCoordinator()
	let stopSessionNotices: (() => void) | null = null
	let bridgeState: BridgeState = { status: "idle" }
	const eventListeners: Map<SDKEventType, Set<SDKEventListener>> = new Map()

	// Logger - uses global config by default, can be overridden with debug option
	let logger: Logger = createLogger("Devora SDK")

	// Scope config cache
	type ScopeConfigCache = {
		safeReadEndpoints: Array<{ method: string; pattern: string }>
		blockedEndpoints: Array<{ method: string; pattern: string }>
		version: number
		cachedUntil: number
	}
	let scopeConfigCache: ScopeConfigCache | null = null
	let scopeConfigRefreshTimer: ReturnType<typeof setTimeout> | null = null
	let scopeConfigEtag: string | null = null
	let scopeConfigFetch: Promise<ScopeConfigCache | null> | null = null

	function validateConfig(sdkConfig: JSFrontendSDKConfig): void {
		if (!sdkConfig.apiKey?.trim()) {
			throw new Error("Devora SDK: apiKey is required")
		}
		const keyValidation = validateApiKeyFormat(sdkConfig.apiKey)
		if (!keyValidation.valid || keyValidation.type !== "client") {
			throw new Error("Devora SDK: apiKey must be a client key identifier (pk_client_*)")
		}
	}

	function invokeSessionExpiredHandlers(cfg: JSFrontendSDKConfig | null = config): void {
		if (cfg?.onError?.sessionExpired) {
			try {
				cfg.onError.sessionExpired()
			} catch (e) {
				logger.error("onError.sessionExpired callback error:", e)
			}
		}
	}

	/**
	 * Validate and adopt a scope policy delivered by Devora (with the exchange
	 * or resume response, or a capability-authenticated refresh). Malformed
	 * policies are refused, so enforcement fails closed; the cache horizon is
	 * clamped so a bad value can neither pin a policy nor spin the refresh timer.
	 */
	function adoptScopePolicy(policy: unknown): boolean {
		const parsed = parseScopePolicy(policy, Date.now())
		if (!parsed) return false
		scopeConfigCache = parsed
		updateScopeConfig(parsed.safeReadEndpoints, parsed.blockedEndpoints)
		return true
	}

	/**
	 * Fetch scope configuration from Devora API
	 * Returns the config or null if fetch fails
	 */
	async function fetchScopeConfig(): Promise<typeof scopeConfigCache> {
		// Policy refreshes are authenticated by this tab's session capability.
		const sessionId = sessionState.sessionId
		const capability = devoraSessionToken
		if (!config?.apiKey || !sessionId || !capability) return null
		if (scopeConfigFetch) return scopeConfigFetch
		const generation = lifecycleGeneration
		const key = config.apiKey
		const origin = apiUrl
		const controller = new AbortController()
		const request = (async () => {
			try {
				const { response, result } = await withDeadline(
					async () => {
						const response = await fetch(origin + "/api/sdk/scope-config", {
							method: "GET",
							redirect: "error" as const,
							headers: {
								"X-Devora-Key": key,
								"X-Devora-Session": sessionId,
								"X-Devora-Session-Token": capability,
								...(scopeConfigEtag ? { "If-None-Match": scopeConfigEtag } : {}),
							},
							signal: controller.signal,
						})
						return {
							response,
							result: response.ok && response.status !== 304 ? await response.json() : null,
						}
					},
					5_000,
					() => controller.abort()
				)
				if (generation !== lifecycleGeneration) return null
				if (response.status === 304 && scopeConfigCache) {
					scopeConfigCache.cachedUntil = Date.now() + 5 * 60 * 1000
					return scopeConfigCache
				}
				if (!response.ok || !result?.success) return null
				const nextConfig = parseScopePolicy(result.data, Date.now())
				if (!nextConfig) return null
				scopeConfigEtag = response.headers.get("etag")
				scopeConfigCache = nextConfig
				return nextConfig
			} catch (error) {
				if (generation === lifecycleGeneration) logger.warn("Scope config unavailable", error)
				return null
			}
		})()
		scopeConfigFetch = request
		try {
			return await request
		} finally {
			if (scopeConfigFetch === request) scopeConfigFetch = null
		}
	}

	function scheduleScopeConfigRefresh(): void {
		stopScopeConfigRefresh()
		if (!sessionState.isActive) return
		const generation = lifecycleGeneration
		const refreshIn = scopeConfigCache?.cachedUntil
			? Math.max(scopeConfigCache.cachedUntil - Date.now() - 30_000, 60_000)
			: 60_000
		scopeConfigRefreshTimer = setTimeout(async () => {
			const policy = await fetchScopeConfig()
			if (generation !== lifecycleGeneration || !sessionState.isActive) return
			if (policy) updateScopeConfig(policy.safeReadEndpoints, policy.blockedEndpoints)
			scheduleScopeConfigRefresh()
		}, refreshIn)
	}

	/**
	 * Stop scope config refresh
	 */
	function stopScopeConfigRefresh(): void {
		if (scopeConfigRefreshTimer) {
			clearTimeout(scopeConfigRefreshTimer)
			scopeConfigRefreshTimer = null
		}
	}

	/**
	 * Start session expiration monitoring
	 */
	function startExpirationMonitoring(): void {
		if (!sessionState.expiresAt) return

		// Clear any existing timer
		if (expirationTimer) {
			clearTimeout(expirationTimer)
			expirationTimer = null
		}

		const expiresAt = new Date(sessionState.expiresAt).getTime()
		const now = Date.now()
		const timeUntilExpiry = expiresAt - now

		if (timeUntilExpiry <= 0) {
			// Already expired
			handleSessionExpired()
			return
		}

		// Maximum safe timeout value (~24.8 days)
		const MAX_TIMEOUT = 2147483647

		// Set timer for expiration (handle overflow for long sessions)
		if (timeUntilExpiry > MAX_TIMEOUT) {
			// Schedule a re-check at MAX_TIMEOUT, which will re-schedule if needed
			expirationTimer = setTimeout(() => {
				startExpirationMonitoring()
			}, MAX_TIMEOUT)
		} else {
			expirationTimer = setTimeout(() => {
				handleSessionExpired()
			}, timeUntilExpiry)
		}

		logger.log("Session expiration monitoring started", {
			expiresAt: sessionState.expiresAt,
			inMs: timeUntilExpiry,
		})
	}

	/**
	 * Start periodic session validation with Devora backend.
	 * This detects externally terminated sessions (e.g., ended by an admin on the Devora platform).
	 *
	 */
	function startSessionValidation(): void {
		// Clear any existing interval
		if (validationInterval) {
			clearInterval(validationInterval)
			validationInterval = null
		}

		// Get validation interval from config (default: 60 seconds)
		const intervalMs = Math.min(Math.max(config?.validationIntervalMs ?? 60_000, 15_000), 300_000)

		validationInterval = setInterval(() => void checkSessionNow(), intervalMs)
		logger.log("Periodic session validation started", { intervalMs })
	}

	/**
	 * Ask Devora whether this session is still live and end it locally when not.
	 * Runs on the validation interval, and at once when a heartbeat is refused,
	 * so a tab ends (and sends its final capture inside Devora's late-data grace
	 * window) soon after a session ends elsewhere.
	 */
	let sessionCheck: Promise<void> | null = null
	function checkSessionNow(): Promise<void> {
		sessionCheck ??= runSessionCheck().finally(() => {
			sessionCheck = null
		})
		return sessionCheck
	}

	async function runSessionCheck(): Promise<void> {
		if (!sessionState.isActive || !config?.apiKey || !sessionState.sessionId) {
			return
		}

		const generation = lifecycleGeneration
		try {
			const result = await validateStoredSession(
				sessionState.sessionId,
				config.apiKey,
				devoraSessionToken ?? "",
				apiUrl
			)

			if (generation !== lifecycleGeneration || !sessionState.isActive) return
			if (result.outcome === "invalid") {
				// Session was terminated externally (admin, expiry, etc.)
				logger.log("Session terminated externally:", result.error)
				await endSession(SDK_END_REASON.TERMINATED_EXTERNALLY)
			} else if (result.outcome === "unknown") {
				// Rate limited, erroring, or an unrecognized response — not proof
				// the session ended. Leave the session running; the next interval
				// (or a network error's own retry-on-next-tick) will try again.
				logger.warn("Session validation inconclusive, will retry")
			}
		} catch (e) {
			// Network error - don't terminate, just log
			// User will be logged out on next successful validation or page refresh
			logger.warn("Session validation failed (network):", e)
		}
	}

	/**
	 * Stop periodic session validation.
	 */
	function stopSessionValidation(): void {
		if (validationInterval) {
			clearInterval(validationInterval)
			validationInterval = null
		}
	}

	/**
	 * Handle session expiration
	 */
	async function handleSessionExpired(): Promise<void> {
		const cfg = config
		const callback = sessionExpiredCallback
		const ending = endSession(SDK_END_REASON.EXPIRED)
		emit("session_expired")
		invokeSessionExpiredHandlers(cfg)
		await Promise.allSettled([
			ending,
			withDeadline(() => callback?.(), 2_000),
			withDeadline(() => cfg?.onSessionExpired?.(), 2_000),
		])
	}

	function resetLocalSession(): void {
		if (expirationTimer) clearTimeout(expirationTimer)
		expirationTimer = null
		stopSessionValidation()
		stopPresenceHeartbeat()
		stopScopeConfigRefresh()
		restoreNetworkLayer()
		stopSessionNotices?.()
		stopSessionNotices = null
		tabs.leaveSession()
		devoraSessionToken = null
		bridgeState = { status: "idle" }
		sessionState = {
			isActive: false,
			sessionId: null,
			scope: null,
			expiresAt: null,
			userId: null,
			targetUser: null,
			impersonator: null,
		}
	}

	/** Stop capture synchronously; only the bounded final delivery is asynchronous. */
	function stopCapture(): Promise<void> {
		const activity = activityLogger
		const recorder = sessionRecorder
		activityLogger = null
		sessionRecorder = null
		// stop() retires observers/hooks before its first await. Both must start now.
		const stops = [activity?.stop(), recorder?.stop()]
		return withDeadline(() => Promise.allSettled(stops), 2_000).then(
			() => undefined,
			() => {
				logger.warn("Final capture flush timed out")
			}
		)
	}

	async function notifySessionEnd(
		origin: string,
		apiKey: string,
		token: string,
		sessionId: string,
		reason: string
	): Promise<void> {
		const state: SessionRevocationState = { status: "pending", sessionId }
		revocationState = state
		emit("session_revocation", state)
		let status: number | undefined
		for (let attempt = 0; attempt < 2; attempt++) {
			const controller = new AbortController()
			try {
				const result = await withDeadline(
					async () => {
						const pending = tryKeepaliveFetch(
							origin + "/api/sdk/end-session",
							{
								method: "POST",
								redirect: "error" as const,
								headers: {
									"Content-Type": "application/json",
									"X-Devora-Key": apiKey,
									"X-Devora-Session-Token": token,
								},
								body: JSON.stringify({ sessionId, reason: reason.slice(0, 500) }),
								signal: controller.signal,
							},
							"revocation"
						)
						if (!pending) throw new Error("Revocation keepalive budget exhausted")
						const response = await pending
						status = response.status
						if (!response.ok) return false
						const body = await response.json()
						return body?.success === true
					},
					2_000,
					() => controller.abort()
				)
				if (result) {
					state.status = "confirmed"
					emit("session_revocation", { ...state })
					return
				}
				if (status && status < 500 && status !== 429) break
			} catch {
				/* Retry once, with the retired session's credential only. */
			}
		}
		state.status = "failed"
		state.httpStatus = status
		emit("session_revocation", { ...state })
		emit("error", { type: "session_revocation_failed", sessionId, httpStatus: status })
		logger.error("Local session ended, but server revocation could not be confirmed", {
			sessionId,
			httpStatus: status,
		})
	}

	/**
	 * Devora stored this tab's upload after the session had ended elsewhere
	 * (dashboard end, revoke, time limit). End locally now, so the final capture
	 * still arrives inside Devora's late-data grace window.
	 */
	function endedElsewhere(): void {
		if (sessionState.isActive) void endSession(SDK_END_REASON.TERMINATED_EXTERNALLY)
	}

	/** Local access closes before any telemetry, remote request or host callback is awaited. */
	function endSession(reason: string): Promise<void> {
		if (!sessionState.isActive) return endSessionTask ?? Promise.resolve()
		const cfg = config
		const origin = apiUrl
		const sessionId = sessionState.sessionId!
		const token = devoraSessionToken ?? ""
		const callback = sessionEndCallback
		lifecycleGeneration++
		clearPendingExchange()
		// The session is inactive before siblings hear about it: a synchronous
		// BroadcastChannel delivery (polyfills, test doubles) would otherwise
		// re-enter endSession from the sibling's notice while isActive is still
		// true. The channel itself stays open until resetLocalSession().
		sessionState = { ...sessionState, isActive: false }
		if (reason !== SDK_END_REASON.TERMINATED_EXTERNALLY) tabs.broadcast({ type: "ended", reason })
		resetLocalSession()
		// Read before stopCapture() retires capture.
		const capturing = sessionRecorder !== null || activityLogger !== null
		const capture = stopCapture()
		emit("impersonation_end", { reason, sessionId })
		// Queue revocation before host callbacks can navigate away. Capture flushes
		// must not delay security state changes; final telemetry may be refused.
		// The backend accepts only the protocol reasons; a host-supplied free-form
		// reason is still delivered to local callbacks but must not turn the
		// revocation request into a 400 that leaves the server session live.
		const wireReason = reason === SDK_END_REASON.EXPIRED ? reason : SDK_END_REASON.USER_ENDED
		const notify =
			reason !== SDK_END_REASON.TERMINATED_EXTERNALLY && cfg?.apiKey
				? notifySessionEnd(origin, cfg.apiKey, token, sessionId, wireReason)
				: Promise.resolve()
		// Devora still stores capture that reaches it shortly after any end (its
		// late-data grace window), but a host callback that navigates cancels an
		// ordinary upload. So let host logout wait briefly for the final flush on
		// every end. Revocation above is already queued and never waits.
		const beforeLogout = capturing
			? withDeadline(() => capture, FINAL_CAPTURE_LOGOUT_WAIT_MS).catch(() => undefined)
			: null
		// Start both host logout callbacks independently.
		const callbacks = [callback, cfg?.onSessionEnd].filter(
			(cb, index, all) => cb && all.indexOf(cb) === index
		)
		const logout = (cb: (reason: string) => void | Promise<void>) =>
			withDeadline(() => cb(reason), 2_000)
		const cleanup = callbacks.map((cb) =>
			(beforeLogout ? beforeLogout.then(() => logout(cb!)) : logout(cb!)).catch((error) => {
				logger.error("onSessionEnd callback failed", error)
				emit("error", { type: "session_logout_failed", sessionId })
			})
		)
		const task = Promise.allSettled([capture, notify, ...cleanup]).then(() => undefined)
		endSessionTask = task
		void task.then(() => {
			if (endSessionTask === task) endSessionTask = null
		})
		return task
	}

	/**
	 * Emit SDK event
	 */
	function emit(type: SDKEventType, data?: unknown): void {
		// Every init path (session started, link refused, bridge restore) ends here.
		if (type === "init") settleExchange()
		const event: SDKEvent = { type, timestamp: Date.now(), data }
		const listeners = eventListeners.get(type)
		if (listeners) {
			for (const listener of listeners) {
				try {
					listener(event)
				} catch (e) {
					logger.error("Event listener error:", e)
				}
			}
		}
	}

	/**
	 * Handle scope violation
	 */
	function handleScopeViolation(violation: ScopeViolation): void {
		emit("scope_violation", violation)

		if (config?.onError?.scopeViolation) {
			config.onError.scopeViolation(violation)
		}

		// Note: Scope violations are captured by rrweb console plugin if logged
		// The session recording will capture the UI state at time of violation
		logger.warn("Scope violation:", violation)
	}

	/**
	 * Apply the dashboard-owned capture policy delivered with the session. Masking
	 * is resolved here, never from SDK configuration, so the replay always matches
	 * what the administrator chose for this exact session.
	 */
	function applyCapturePolicy(capture: DevoraCaptureSnapshot | undefined): void {
		masking = resolveMasking(capture)
		if (masking.dropped.length > 0) {
			logger.warn("Ignoring administrator selectors the browser cannot parse", masking.dropped)
		}
	}

	/** Recording eligibility is the authoritative server verdict, never an SDK override. */
	function isRecordingEnabled(session: {
		recordingAllowed?: boolean
		recordingEnabled?: boolean
	}): boolean {
		return session.recordingEnabled === true
	}

	/**
	 * Start the lightweight activity logger for a session when the dashboard
	 * policy enables it. Independent of recording; powers the activity timeline.
	 */
	function startActivityLogger(
		sessionId: string,
		sessionToken: string,
		cfg: JSFrontendSDKConfig | null,
		serverEnabled: boolean,
		capture: DevoraCaptureSnapshot | undefined
	): void {
		if (!serverEnabled || !cfg?.apiKey) return
		if (activityLogger?.isRunning()) return
		activityLogger = new ActivityLogger({
			apiUrl,
			apiKey: cfg.apiKey,
			sessionId,
			devoraSessionToken: sessionToken,
			tabId: getRecorderTabId(),
			masking,
			captureErrors: capture?.consoleErrorCaptureEnabled === true,
			captureCustomEvents: capture?.activityCustomEventsEnabled === true,
			onIncomplete: (reason) => emit("error", { type: "activity_incomplete", reason }),
			onSessionEnded: endedElsewhere,
			debug: cfg.debug,
		})
		activityLogger.start()
	}

	/**
	 * Start the presence heartbeat for idle-timeout enforcement. Independent of
	 * the activity-capture policy: it carries no data, only a "someone is here"
	 * signal, so it always runs for the life of the session.
	 */
	function startPresenceHeartbeat(
		sessionId: string,
		sessionToken: string,
		cfg: JSFrontendSDKConfig | null
	): void {
		if (!cfg?.apiKey) return
		if (presenceHeartbeat?.isRunning()) return
		presenceHeartbeat = new PresenceHeartbeat({
			apiUrl,
			apiKey: cfg.apiKey,
			sessionId,
			devoraSessionToken: sessionToken,
			debug: cfg.debug,
			// A refused heartbeat may mean the session ended elsewhere: check now.
			onRejected: () => void checkSessionNow(),
		})
		presenceHeartbeat.start()
	}

	function stopPresenceHeartbeat(): void {
		presenceHeartbeat?.stop()
		presenceHeartbeat = null
	}

	function startSessionRecorder(
		sessionId: string,
		sessionToken: string,
		apiKey: string,
		debug: boolean | undefined,
		capture: DevoraCaptureSnapshot | undefined
	): void {
		sessionRecorder = SessionRecorder.acquire({
			apiUrl,
			apiKey,
			sessionId,
			devoraSessionToken: sessionToken,
			debug,
			captureConsoleErrors: capture?.consoleErrorCaptureEnabled === true,
			captureCustomEvents: capture?.activityCustomEventsEnabled === true,
			privacy: buildRrwebPrivacyOptions(masking),
			onError: (error) => {
				logger.error("Recording error:", error)
				emit("error", { type: "recording_error", error })
			},
			onCaptureIncomplete: (reason) => {
				// The session itself continues; only the replay stops here.
				logger.warn("Recording stopped early; the impersonation session continues", { reason })
				emit("error", { type: "recording_incomplete", reason })
			},
			onPrivacyDegraded: (reasons) => {
				// Non-fatal: the replay stays opaque but loses some fidelity.
				emit("error", { type: "recording_privacy_degraded", reasons })
			},
			onSessionEnded: endedElsewhere,
		})
		sessionRecorder.start()
	}

	/**
	 * Start impersonation session from decrypted payload
	 */
	async function startImpersonation(decrypted: DecryptedPayload): Promise<void> {
		const generation = lifecycleGeneration
		const cfg = config
		if (!adoptScopePolicy(decrypted.scopePolicy)) {
			logger.error("Cannot start impersonation without a verified scope policy")
			emit("session_error", { error: "POLICY_UNAVAILABLE" })
			return
		}

		// Convert expiresAt from number to ISO string
		const expiresAtStr = new Date(decrypted.expiresAt).toISOString()
		devoraSessionToken = decrypted.devoraSessionToken

		// Get target user ID (from enriched info or fallback to sessionId for backwards compat)
		const targetUserId = decrypted.targetUser?.id ?? decrypted.sessionId

		// Update session state with enriched user info
		sessionState = {
			isActive: true,
			sessionId: decrypted.sessionId,
			scope: decrypted.scope,
			expiresAt: expiresAtStr,
			userId: targetUserId, // Actual target user ID
			targetUser: decrypted.targetUser ?? null,
			impersonator: decrypted.impersonator ?? null,
		}

		// Nothing is persisted: a later tab or reload restores through the
		// customer backend bridge and receives its own capability.
		joinSessionChannel(decrypted.sessionId)

		// Start expiration monitoring
		startExpirationMonitoring()
		if (generation !== lifecycleGeneration || !sessionState.isActive) return

		// Start periodic session validation
		startSessionValidation()
		scheduleScopeConfigRefresh()

		// Capture follows the policy delivered with the session. acquire() reuses an
		// existing recorder for this session.
		applyCapturePolicy(decrypted.capture)
		if (isRecordingEnabled(decrypted)) {
			startSessionRecorder(
				decrypted.sessionId,
				decrypted.devoraSessionToken,
				config!.apiKey,
				config?.debug,
				decrypted.capture
			)
		}

		startActivityLogger(
			decrypted.sessionId,
			decrypted.devoraSessionToken,
			config,
			decrypted.activityEnabled === true,
			decrypted.capture
		)
		startPresenceHeartbeat(decrypted.sessionId, decrypted.devoraSessionToken, config)

		// Build payload for callback with enriched user info
		const payload: ImpersonatePayload = {
			token: decrypted.token,
			data: decrypted.data,
			scope: decrypted.scope,
			expiresAt: expiresAtStr,
			sessionId: decrypted.sessionId,
			targetUser: decrypted.targetUser,
			impersonator: decrypted.impersonator,
		}

		// Trigger callback
		if (impersonateCallback) {
			try {
				await impersonateCallback(payload)
			} catch (e) {
				logger.error("onImpersonate callback error:", e)
			}
		}

		if (generation !== lifecycleGeneration || !sessionState.isActive) return
		// Also trigger callback from config
		if (cfg?.onImpersonate) {
			try {
				await cfg.onImpersonate(payload)
			} catch (e) {
				logger.error("onImpersonate callback error:", e)
			}
		}

		if (generation !== lifecycleGeneration || !sessionState.isActive) return
		// Enforce scope on the app's network layer AFTER the onImpersonate handoff.
		// In full-stack (cookie/session) mode the handoff is itself a write — POSTing the
		// token to a server endpoint that sets the session cookie — so patching before the
		// callback would block that POST for read-only sessions. Subsequent app traffic is
		// still scope-enforced (and after a full-stack reload, enforcement is server-side).
		patchNetworkLayer({
			enabled: true,
			scope: decrypted.scope,
			apiUrl: apiUrl,
			showWarnings: config?.showWarnings ?? true,
			onViolation: handleScopeViolation,
			safeReadEndpoints: scopeConfigCache!.safeReadEndpoints,
			blockedEndpoints: scopeConfigCache!.blockedEndpoints,
		})

		emit("impersonation_start", payload)
		logger.log("Impersonation session started", {
			sessionId: decrypted.sessionId,
			scope: decrypted.scope,
		})
	}

	/** React to lifecycle notices from sibling tabs. Backend validation stays authoritative. */
	function joinSessionChannel(sessionId: string): void {
		stopSessionNotices?.()
		tabs.joinSession(sessionId)
		stopSessionNotices = tabs.onSessionNotice((notice: SessionNotice) => {
			if (!sessionState.isActive || sessionState.sessionId !== sessionId) return
			if (notice.type === "policy_changed") {
				void fetchScopeConfig()
				return
			}
			const reason =
				notice.type === "ended"
					? notice.reason
					: notice.type === "expired"
						? SDK_END_REASON.EXPIRED
						: SDK_END_REASON.TERMINATED_EXTERNALLY
			// The originating tab already told Devora; end locally without a second notify.
			void endSession(
				reason === SDK_END_REASON.EXPIRED ? reason : SDK_END_REASON.TERMINATED_EXTERNALLY
			)
		})
	}

	/**
	 * Start capture and enforcement for a session restored through the bridge.
	 * Unlike the exchange path, the customer app is already authenticated, so
	 * onImpersonate is not invoked and no customer token is involved.
	 */
	async function restoreResumedSession(
		resumed: ResumedSession,
		sdkConfig: JSFrontendSDKConfig
	): Promise<boolean> {
		if (!adoptScopePolicy(resumed.scopePolicy)) {
			logger.error("Cannot restore impersonation without a verified scope policy")
			emit("session_error", { error: "POLICY_UNAVAILABLE" })
			return false
		}
		const expiresAtStr = new Date(resumed.expiresAt).toISOString()
		devoraSessionToken = resumed.devoraSessionToken
		sessionState = {
			isActive: true,
			sessionId: resumed.sessionId,
			scope: resumed.scope,
			expiresAt: expiresAtStr,
			userId: resumed.targetUser?.id ?? resumed.sessionId,
			targetUser: resumed.targetUser ?? null,
			impersonator: resumed.impersonator ?? null,
		}
		joinSessionChannel(resumed.sessionId)
		startExpirationMonitoring()
		if (!sessionState.isActive) return false
		startSessionValidation()
		scheduleScopeConfigRefresh()

		patchNetworkLayer({
			enabled: true,
			scope: resumed.scope,
			apiUrl: apiUrl,
			showWarnings: sdkConfig.showWarnings ?? true,
			onViolation: handleScopeViolation,
			safeReadEndpoints: scopeConfigCache!.safeReadEndpoints,
			blockedEndpoints: scopeConfigCache!.blockedEndpoints,
		})

		applyCapturePolicy(resumed.capture)
		if (isRecordingEnabled(resumed)) {
			startSessionRecorder(
				resumed.sessionId,
				resumed.devoraSessionToken,
				sdkConfig.apiKey,
				sdkConfig.debug,
				resumed.capture
			)
		}

		startActivityLogger(
			resumed.sessionId,
			resumed.devoraSessionToken,
			sdkConfig,
			resumed.activityEnabled === true,
			resumed.capture
		)
		startPresenceHeartbeat(resumed.sessionId, resumed.devoraSessionToken, sdkConfig)

		logger.log("Session restored through the customer bridge", { sessionId: resumed.sessionId })
		emit("session_restored", sessionState)
		return true
	}

	/**
	 * Ask the customer backend whether this browser belongs to an impersonated
	 * session and, if so, redeem the returned resume code for this tab's own
	 * capability. A customer session that is impersonated but cannot be safely
	 * restored ends in the blocked state; the host must not render protected
	 * content in that state.
	 */
	async function restoreThroughBridge(sdkConfig: JSFrontendSDKConfig): Promise<void> {
		const generation = lifecycleGeneration
		const origin = apiUrl
		const bridge = sdkConfig.sessionBridge
		if (!bridge) {
			bridgeState = { status: "none" }
			return
		}
		const controller = new AbortController()
		let result
		try {
			result = await withDeadline(
				() => bridge.restore({ tabRef: tabs.getTabRef(), signal: controller.signal }),
				10_000,
				() => controller.abort()
			)
			if (generation !== lifecycleGeneration) return
		} catch (error) {
			if (generation !== lifecycleGeneration) return
			logger.warn("Session bridge failed", { error })
			bridgeState = { status: "blocked", reason: "bridge_unavailable" }
			emit("session_blocked", bridgeState)
			return
		}
		if (!result || result.status === "none") {
			bridgeState = { status: "none" }
			return
		}
		if (result.status === "blocked") {
			bridgeState = { status: "blocked", reason: result.reason }
			emit("session_blocked", bridgeState)
			return
		}
		// The policy arrives with the resume response, bound to its capability.
		const resumed = await resumeSession(result.code, tabs.getTabRef(), sdkConfig.apiKey, origin)
		if (generation !== lifecycleGeneration) return
		if (!resumed) {
			bridgeState = { status: "blocked", reason: "resume_failed" }
			emit("session_blocked", bridgeState)
			return
		}
		const restored = await restoreResumedSession(resumed, sdkConfig)
		bridgeState = restored ? { status: "restored" } : { status: "blocked", reason: "resume_failed" }
		if (!restored) emit("session_blocked", bridgeState)
	}

	// SDK API
	const sdk: DevoraFrontendSDK = {
		/** Initialize the SDK and preload the centrally managed policy. */
		async init(sdkConfig: JSFrontendSDKConfig): Promise<void> {
			if (initialized) {
				logger.warn("SDK already initialized")
				return
			}
			removeLegacyPolicyCache()

			// Pick supported runtime options; capture-shaped extras are never retained.
			sdkConfig = {
				apiKey: sdkConfig.apiKey,
				apiUrl: sdkConfig.apiUrl,
				debug: sdkConfig.debug,
				autoDetect: sdkConfig.autoDetect,
				showWarnings: sdkConfig.showWarnings,
				validationIntervalMs: sdkConfig.validationIntervalMs,
				sessionBridge: sdkConfig.sessionBridge,
				onImpersonate: sdkConfig.onImpersonate,
				onSessionEnd: sdkConfig.onSessionEnd,
				onSessionExpired: sdkConfig.onSessionExpired,
				onError: sdkConfig.onError,
			}
			validateConfig(sdkConfig)
			const generation = ++lifecycleGeneration
			config = sdkConfig
			apiUrl = resolveApiUrl(sdkConfig.apiUrl)
			bridgeState = { status: "idle" }
			// Update logger with user's debug preference
			logger = createLogger("Devora SDK", sdkConfig.debug)

			const autoDetect = sdkConfig.autoDetect !== false
			const urlHasExchange = autoDetect && hasUntakenExchangeInURL()
			const code = urlHasExchange ? getExchangeCodeFromURL() : null
			const verifier = urlHasExchange ? getExchangeVerifier() : null
			if (urlHasExchange) cleanURL()
			if (
				pendingExchange &&
				(pendingExchange.apiKey !== sdkConfig.apiKey ||
					pendingExchange.apiUrl !== apiUrl ||
					pendingExchange.expiresAt <= Date.now() ||
					!autoDetect)
			)
				clearPendingExchange()
			if (urlHasExchange) {
				clearPendingExchange()
				if (code) {
					pendingExchange = {
						code,
						verifier: verifier ?? Promise.resolve(null),
						apiKey: sdkConfig.apiKey,
						apiUrl,
						expiresAt: Date.now() + 30_000,
					}
					exchangeExpiry = setTimeout(expirePendingExchange, 30_000)
				}
			}
			const handoff = pendingExchange
			const hasExchange = urlHasExchange || !!handoff
			// An ordinary page has no policy fetch, polling, or tab-claim overhead.
			if (!hasExchange && !sdkConfig.sessionBridge) {
				await Promise.resolve()
				if (generation !== lifecycleGeneration) return
				bridgeState = { status: "none" }
				initialized = true
				emit("init")
				return
			}
			const tabRef = await tabs.claimTabRef()
			if (generation !== lifecycleGeneration) return
			setRecorderTabId(tabRef)
			// A newer init must not inherit an obsolete generation's policy promise.
			scopeConfigFetch = null

			if (hasExchange) {
				if (handoff && handoff.expiresAt > Date.now()) {
					// Cancellation never causes a second redemption of this one-time code.
					// The code only redeems with the verifier from the dashboard tab
					// that opened this one; a forwarded link never gets one.
					handoff.promise ??= handoff.verifier.then((verifier) =>
						verifier
							? exchangePayload(handoff.code, verifier, tabRef, handoff.apiKey, handoff.apiUrl)
							: null
					)
					const payload = await handoff.promise
					if (generation !== lifecycleGeneration) return
					if (pendingExchange === handoff) clearPendingExchange()
					if (
						!payload ||
						(payload.tabRef && payload.tabRef !== tabRef) ||
						payload.expiresAt <= Date.now()
					) {
						emit("error", {
							code: "invalid_exchange",
							type: "payload_error",
						})
						// Without a verifier the dashboard handshake never happened: the
						// link was forwarded, or this page's Cross-Origin-Opener-Policy
						// cut the tab off from the dashboard that opened it.
						const handshakeFailed = !(await handoff.verifier)
						if (generation !== lifecycleGeneration) return
						sdkConfig.onError?.payloadError?.({
							code: "invalid_format",
							message: handshakeFailed
								? "This impersonation link was not opened from the Devora dashboard in this browser. If it was, this page must not send a Cross-Origin-Opener-Policy header other than unsafe-none."
								: "This impersonation link is invalid, expired or already used.",
						})
						initialized = true
						emit("init")
						return
					}
					await startImpersonation(payload)
					if (generation !== lifecycleGeneration) {
						// The session ended during startup (typically the host calling
						// end() from onImpersonate). Unless destroy() ran, the SDK is
						// still configured and must report itself initialized so a
						// second init() is refused and wrappers settle.
						if (config === sdkConfig && !initialized) {
							initialized = true
							emit("init")
						}
						return
					}
					initialized = true
					emit("init")
					logger.log("Devora SDK initialized with impersonation session")
					return
				}
				if (pendingExchange === handoff) clearPendingExchange()
				emit("error", { code: "invalid_exchange", type: "payload_error" })
				sdkConfig.onError?.payloadError?.({
					code: "unknown",
					message: "This impersonation link is malformed or expired.",
				})
				initialized = true
				emit("init")
				return
			}

			// No exchange in the URL: ask the customer backend to restore this tab.
			await restoreThroughBridge(sdkConfig)
			if (generation !== lifecycleGeneration) return
			logger.log("Bridge restoration result:", bridgeState)

			initialized = true
			emit("init")
			logger.log("Devora SDK initialized")
		},

		/**
		 * Check if SDK is initialized
		 */
		isInitialized(): boolean {
			return initialized
		},

		/**
		 * Check if impersonation session is active
		 */
		isImpersonating(): boolean {
			return sessionState.isActive
		},

		/**
		 * Get current session state
		 */
		getRevocationState(): SessionRevocationState {
			return { ...revocationState }
		},

		getSession(): SessionState {
			return { ...sessionState }
		},

		/** Outcome of this tab's restoration attempt. */
		getBridgeState(): BridgeState {
			return bridgeState
		},

		/** Non-secret reference identifying this browser tab. */
		getTabRef(): string {
			return tabs.getTabRef()
		},

		/**
		 * Register impersonation callback
		 */
		onImpersonate(callback: (payload: ImpersonatePayload) => void | Promise<void>): void {
			impersonateCallback = callback
		},

		/**
		 * Register session end callback
		 */
		onSessionEnd(callback: (reason: string) => void | Promise<void>): void {
			sessionEndCallback = callback
		},

		/**
		 * End the current session.
		 * @param reason Optional reason reported to Devora (default "user_ended").
		 */
		async end(reason?: string): Promise<void> {
			await endSession(reason?.trim() || SDK_END_REASON.USER_ENDED)
		},

		/**
		 * Register session expired callback
		 */
		onSessionExpired(callback: () => void | Promise<void>): void {
			sessionExpiredCallback = callback
		},

		/**
		 * Log a custom action.
		 *
		 * Lands in the session activity timeline and, when recording is active, in the
		 * replay stream, but only when the project policy enables custom events. With
		 * custom events disabled this is a no-op (a debug warning is logged).
		 */
		logAction(event: Omit<import("@devorash/core").LogEvent, "sessionId" | "timestamp">): void {
			if (!activityLogger?.isRunning() && !sessionRecorder?.isRecording()) return
			const accepted = activityLogger?.acceptsCustomEvents() ?? false
			if (!accepted) {
				logger.warn("logAction ignored: custom events are disabled in the Devora project policy")
				return
			}
			// One normalized form for both outputs: the path is mapped to the
			// session's page reference and metadata/strings are redacted and bounded.
			const normalized = normalizeCustomAction(event, masking)
			activityLogger?.logCustomAction(normalized)
			if (sessionRecorder?.isRecording()) sessionRecorder.recordCustomAction(normalized)
		},

		/**
		 * Add event listener
		 */
		on(event: SDKEventType, listener: SDKEventListener): void {
			logger.log("Registering listener for event:", event)
			if (!eventListeners.has(event)) {
				eventListeners.set(event, new Set())
			}
			eventListeners.get(event)!.add(listener)
			logger.log(
				"Listener registered, total listeners for",
				event,
				":",
				eventListeners.get(event)!.size
			)
		},

		/**
		 * Remove event listener
		 */
		off(event: SDKEventType, listener: SDKEventListener): void {
			const listeners = eventListeners.get(event)
			if (listeners) {
				listeners.delete(listener)
			}
		},

		/**
		 * Destroy SDK instance
		 *
		 * IMPORTANT: This method is now async to ensure proper cleanup of recording data.
		 * Always await destroy() to prevent data loss during shutdown.
		 *
		 * Migration from v1.x:
		 * - Old: sdk.destroy() // sync, fire-and-forget
		 * - New: await sdk.destroy() // async, waits for recording flush
		 *
		 * Framework integration notes:
		 * - React: Use async effect cleanup or fire-and-forget with void
		 * - Vue/Solid/Svelte: Same - lifecycle hooks don't support async cleanup
		 * - Manual cleanup: Always await if you need to ensure data is saved
		 */
		async destroy(): Promise<void> {
			lifecycleGeneration++
			resetLocalSession()
			const capture = stopCapture()
			tabs.destroy()
			scopeConfigCache = null
			scopeConfigEtag = null
			scopeConfigFetch = null
			eventListeners.clear()
			impersonateCallback = null
			sessionEndCallback = null
			sessionExpiredCallback = null
			config = null
			initialized = false
			// A redemption this teardown interrupted will never emit "init": stop
			// reporting it as in flight. An exchange still waiting to be taken stays
			// in flight for the next init (React StrictMode remounts immediately).
			if (!pendingExchange) settleExchange()
			// An unconsumed exchange survives only its short, private handoff TTL.
			// No shared state may be changed after awaiting retired capture.
			await capture
		},
	}

	return sdk
}

// Create default SDK instance
const Devora = createDevoraSDK()

export default Devora
export { Devora }

/** Largest accepted policy and the longest trusted cache horizon. */
const MAX_POLICY_ENTRIES = 1000
const MAX_POLICY_TTL_MS = 60 * 60 * 1000

function parseScopeEndpoints(value: unknown): Array<{ method: string; pattern: string }> | null {
	if (!Array.isArray(value) || value.length > MAX_POLICY_ENTRIES) return null
	const endpoints: Array<{ method: string; pattern: string }> = []
	for (const entry of value) {
		const method = (entry as { method?: unknown } | null)?.method
		const pattern = (entry as { pattern?: unknown } | null)?.pattern
		if (
			typeof method !== "string" ||
			!/^(\*|[A-Z]{3,7})(?![\s\S])/.test(method) ||
			typeof pattern !== "string" ||
			!pattern ||
			pattern.length > 500
		)
			return null
		endpoints.push({ method, pattern })
	}
	return endpoints
}

/**
 * SDK versions before 0.1.0 cached the scope policy in localStorage under
 * `devora_scope_config:<api>:<key>`. The policy is never stored now; remove
 * leftovers so old policy data does not linger in customers' browsers.
 */
function removeLegacyPolicyCache(): void {
	try {
		if (typeof localStorage === "undefined") return
		for (let index = localStorage.length - 1; index >= 0; index--) {
			const key = localStorage.key(index)
			if (key?.startsWith("devora_scope_config:")) localStorage.removeItem(key)
		}
	} catch {
		// Storage can be unavailable (privacy modes); nothing to clean up.
	}
}

/** A validated scope policy, or null. The cache horizon is clamped to an hour. */
function parseScopePolicy(
	value: unknown,
	now: number
): {
	safeReadEndpoints: Array<{ method: string; pattern: string }>
	blockedEndpoints: Array<{ method: string; pattern: string }>
	version: number
	cachedUntil: number
} | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null
	const source = value as Record<string, unknown>
	const safeReadEndpoints = parseScopeEndpoints(source.safeReadEndpoints)
	const blockedEndpoints = parseScopeEndpoints(source.blockedEndpoints)
	const version = source.version
	const requested = source.cachedUntil
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
		version,
		cachedUntil: Math.min(Math.max(requested, now), now + MAX_POLICY_TTL_MS),
	}
}
