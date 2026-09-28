/**
 * Frontend SDK specific types
 * @module @devorash/browser
 */

import type {
	DevoraCaptureSnapshot,
	FrontendSDKConfig,
	ImpersonatePayload,
	ImpersonationScope,
	ImpersonationUserInfo,
	LogEvent,
	ScopeViolation,
	SessionBridgeResult,
} from "@devorash/core"

/**
 * Customer-provided restore hook. The SDK calls it on every page load without
 * an exchange code, passing this tab's non-secret reference. The customer
 * route answers from its own authenticated session (see the backend SDK's
 * browser-session helpers) without contacting Devora for ordinary users.
 */
export interface SessionBridge {
	restore: (input: { tabRef: string; signal: AbortSignal }) => Promise<SessionBridgeResult>
}

export type BridgeBlockedReason =
	| "control_plane_unavailable"
	| "session_invalid"
	| "bridge_unavailable"
	| "resume_failed"

/** Restoration outcome for this tab. */
export type BridgeState =
	| { status: "idle" }
	| { status: "restored" }
	| { status: "none" }
	| { status: "blocked"; reason: BridgeBlockedReason }

/**
 * Extended frontend SDK configuration
 */
export interface JSFrontendSDKConfig extends FrontendSDKConfig {
	/** Automatically detect impersonation tokens on init */
	autoDetect?: boolean
	/** Show console warnings for scope violations */
	showWarnings?: boolean
	/**
	 * Devora API origin override (advanced; e.g. self-hosted deployments).
	 * Must be an https origin (http is allowed for localhost only).
	 * @default the origin baked into the SDK at build time
	 */
	apiUrl?: string

	/** Callback when session expires */
	onSessionExpired?: () => void | Promise<void>
	/**
	 * Interval in milliseconds for periodic session validation with Devora backend.
	 * This allows detecting externally terminated sessions (e.g., ended by an admin on the Devora platform).
	 * @default 60000 (60 seconds)
	 */
	validationIntervalMs?: number
	/**
	 * Restores an impersonation session in a tab that has the customer's own
	 * authentication but no Devora capability (new tab, reload, cold start).
	 * Without it, only the tab that consumed the exchange link is tracked.
	 */
	sessionBridge?: SessionBridge
}

/**
 * Session state
 */
export interface SessionState {
	/** Whether an impersonation session is active */
	isActive: boolean
	/** Current session ID */
	sessionId: string | null
	/** Access scope */
	scope: ImpersonationScope | null
	/** Session expiration time (ISO timestamp) */
	expiresAt: string | null
	/** User being impersonated (deprecated, use targetUser.id) */
	userId: string | null
	/** Target user being impersonated */
	targetUser: ImpersonationUserInfo | null
	/** Agent performing the impersonation */
	impersonator: ImpersonationUserInfo | null
}

/**
 * Decrypted payload from Devora backend
 *
 * This contains all the information needed to start an impersonation session.
 * The payload is encrypted in the URL and decrypted via the Devora backend.
 */
export interface DecryptedPayload {
	/**
	 * The organization's scope policy, delivered with the capability. Refreshes
	 * later require that capability; the policy is never cached in storage.
	 */
	scopePolicy?: {
		version: number
		safeReadEndpoints: Array<{ method: string; pattern: string }>
		blockedEndpoints: Array<{ method: string; pattern: string }>
		cachedUntil: number
	}
	/** Authentication token from customer backend */
	token: string
	/** Devora session ID */
	sessionId: string
	/** Access scope (read/write) */
	scope: ImpersonationScope
	/** Session expiration timestamp (Unix ms) */
	expiresAt: number
	/** Optional additional data from customer backend */
	data?: Record<string, unknown>
	/** Target user being impersonated */
	targetUser?: ImpersonationUserInfo
	/** Agent performing the impersonation */
	impersonator?: ImpersonationUserInfo
	/** Customer backend decision for capture of this exact impersonation session. */
	recordingAllowed?: boolean
	/** Server-authorized recording policy for this session. */
	recordingEnabled?: boolean
	/** Server-authorized activity policy for this session. */
	activityEnabled?: boolean
	/** Server-authorized console/error capture. */
	consoleErrorCaptureEnabled?: boolean
	/** Dashboard-owned masking profile, selector lists and capture flags for this session. */
	capture?: DevoraCaptureSnapshot
	/** Echo of the tab reference the capability was minted for. */
	tabRef?: string
	/** Devora control-plane token, distinct from the customer authentication token. */
	devoraSessionToken: string
}

/**
 * Session validation response from Devora API
 *
 * Used when validating a stored session on page refresh to ensure
 * it hasn't been terminated by an admin while the user was away.
 */
export interface StoredSessionValidation {
	/** Whether the session is valid */
	valid: boolean
	/** Access scope */
	scope: ImpersonationScope
	/** Session expiration time (Unix timestamp in ms) - only present if valid */
	expiresAt?: number
	/** User being impersonated - only present if valid */
	userId?: string
	/** Remaining time in ms until expiration - only present if valid */
	remainingMs?: number
	/** Error code when session is invalid (e.g., SESSION_TERMINATED, SESSION_EXPIRED) */
	error?: string
}

/**
 * SDK event types
 */
/** Remote revocation is distinct from local logout; no credentials are exposed. */
export interface SessionRevocationState {
	status: "none" | "pending" | "confirmed" | "failed"
	sessionId?: string
	httpStatus?: number
}

export type SDKEventType =
	| "init"
	| "impersonation_start"
	| "impersonation_end"
	| "session_revocation"
	| "session_restored"
	| "session_blocked"
	| "session_expired"
	| "session_error"
	| "scope_violation"
	| "error"

/**
 * SDK event payload
 */
export interface SDKEvent {
	type: SDKEventType
	timestamp: number
	data?: unknown
}

/**
 * Event listener type
 */
export type SDKEventListener = (event: SDKEvent) => void

/**
 * Frontend SDK instance
 */
export interface DevoraFrontendSDK {
	/** Initialize the SDK */
	init: (config: JSFrontendSDKConfig) => Promise<void>
	/** Check if SDK is initialized */
	isInitialized: () => boolean
	/** Check if impersonation session is active */
	isImpersonating: () => boolean
	/** Get current session state */
	getSession: () => SessionState
	/** Latest remote end request; failed means the server may still consider that session active. */
	getRevocationState: () => SessionRevocationState
	/** Outcome of this tab's restoration attempt. */
	getBridgeState: () => BridgeState
	/** Non-secret reference identifying this browser tab. */
	getTabRef: () => string
	/** Register impersonation callback */
	onImpersonate: (callback: (payload: ImpersonatePayload) => void | Promise<void>) => void
	/** Register session end callback */
	onSessionEnd: (callback: (reason: string) => void | Promise<void>) => void
	/** Register session expired callback */
	onSessionExpired: (callback: () => void | Promise<void>) => void
	/** End the current session. Optional reason is reported to Devora (default "user_ended"). */
	end: (reason?: string) => Promise<void>
	/** Log a custom action */
	logAction: (event: Omit<LogEvent, "sessionId" | "timestamp">) => void
	/** Add event listener */
	on: (event: SDKEventType, listener: SDKEventListener) => void
	/** Remove event listener */
	off: (event: SDKEventType, listener: SDKEventListener) => void
	/** Destroy SDK instance */
	destroy: () => Promise<void>
}

/**
 * Scope enforcer configuration
 */
export interface ScopeEnforcerConfig {
	/** Whether to block requests */
	enabled: boolean
	/** Active impersonation scope */
	scope: ImpersonationScope
	/** SDK service origin allowed to bypass customer request enforcement */
	apiUrl: string
	/** Show console warnings */
	showWarnings: boolean
	/** Callback for violations */
	onViolation?: (violation: ScopeViolation) => void
	/**
	 * Dynamic whitelist from centrally managed Devora policy.
	 * POST/PUT/PATCH/DELETE endpoints allowed in read-only mode.
	 */
	safeReadEndpoints?: Array<{ method: string; pattern: string }>
	/**
	 * Dynamic blacklist from centrally managed Devora policy.
	 * Endpoints blocked during ANY impersonation (even in write mode).
	 * Blacklist is checked FIRST and takes priority.
	 */
	blockedEndpoints?: Array<{ method: string; pattern: string }>
}

/** Authoritative snapshot returned when a tab redeems a resume code. */
export interface ResumedSession {
	/**
	 * The organization's scope policy, delivered with the capability. Refreshes
	 * later require that capability; the policy is never cached in storage.
	 */
	scopePolicy?: {
		version: number
		safeReadEndpoints: Array<{ method: string; pattern: string }>
		blockedEndpoints: Array<{ method: string; pattern: string }>
		cachedUntil: number
	}
	sessionId: string
	scope: ImpersonationScope
	expiresAt: number
	targetUser?: ImpersonationUserInfo
	impersonator?: ImpersonationUserInfo
	recordingAllowed?: boolean
	recordingEnabled?: boolean
	activityEnabled?: boolean
	consoleErrorCaptureEnabled?: boolean
	capture?: DevoraCaptureSnapshot
	devoraSessionToken: string
	tabRef?: string
}
