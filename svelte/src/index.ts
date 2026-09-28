/**
 * Devora Svelte SDK
 *
 * Svelte stores for enabling impersonation in your Svelte app.
 *
 * @example
 * ```svelte
 * <script>
 * import { initDevora, devoraStore, devoraImpersonation } from "@devorash/svelte";
 *
 * // Initialize in app root
 * initDevora({
 *   apiKey: "pk_client_live_xxx",
 *   onImpersonate: async ({ token }) => {
 *     await signInWithDevoraToken(token);
 *   },
 * });
 *
 * // Use stores
 * $: isImpersonating = $devoraStore.isImpersonating;
 * $: scope = $devoraImpersonation.scope;
 * </script>
 * ```
 *
 * @packageDocumentation
 * @module @devorash/svelte
 */

import { writable, derived, type Readable, type Writable } from "svelte/store"
import {
	createDevoraSDK,
	hasExchangeParameterInURL,
	type DevoraFrontendSDK,
	type SessionState,
	type JSFrontendSDKConfig,
	type BridgeState,
	type PayloadError,
	type ScopeViolation,
} from "@devorash/browser"
import type { ImpersonatePayload, ImpersonationScope, LogEvent } from "@devorash/core"

// Global SDK instance
let globalSDK: DevoraFrontendSDK | null = null

/**
 * Check if there's a Devora payload in the URL.
 */
export function hasDevoraPayload(): boolean {
	return hasExchangeParameterInURL()
}

const INITIAL_PAYLOAD_DETECTED = typeof window !== "undefined" && hasDevoraPayload()

/**
 * Store state type
 */
export interface DevoraStoreState {
	isInitialized: boolean
	isImpersonating: boolean
	/** Outcome of this tab's restoration attempt; "blocked" means protected content must not render. */
	bridgeState: BridgeState
	/** Whether `initDevora()` was called with a `sessionBridge` configured. */
	hasSessionBridge: boolean
	initError: Error | null
	/** Set when the one-time exchange link fails; drives `LinkInvalidScreen.svelte`. */
	payloadError: PayloadError | null
	/** Reason from the most recent `onSessionEnd`; drives `SessionEndedScreen.svelte`. */
	lastEndReason: string | null
	/** Most recent blocked write; drives `BlockedActionDialog.svelte`. */
	activeViolation: ScopeViolation | null
	session: SessionState
}

const initialStoreState: DevoraStoreState = {
	isInitialized: false,
	isImpersonating: false,
	bridgeState: { status: "idle" },
	hasSessionBridge: false,
	initError: null,
	payloadError: null,
	lastEndReason: null,
	activeViolation: null,
	session: {
		isActive: false,
		sessionId: null,
		scope: null,
		expiresAt: null,
		userId: null,
		targetUser: null,
		impersonator: null,
	},
}

/**
 * Main Devora store
 */
export const devoraStore: Writable<DevoraStoreState> = writable({ ...initialStoreState })

/**
 * Countdown timer store: ticks every second while impersonating. The
 * display shows seconds (MM:SS), so it updates every second regardless of
 * how much time is left — a slower interval for long sessions previously
 * made the clock look frozen for minutes at a time.
 */
const remainingMsStore: Writable<number | null> = writable(null)
let timerCleanup: (() => void) | null = null

// Start the timer when the store gains an impersonating subscriber
function startRemainingTimer() {
	const updateRemaining = () => {
		let currentExpiresAt: string | null = null
		const unsubscribe = devoraStore.subscribe(($store) => {
			currentExpiresAt = $store.session.expiresAt
		})
		unsubscribe()

		remainingMsStore.set(
			currentExpiresAt ? Math.max(0, new Date(currentExpiresAt).getTime() - Date.now()) : null
		)
	}

	updateRemaining()
	const intervalId = setInterval(updateRemaining, 1_000)

	return () => clearInterval(intervalId)
}

// Subscribe to devoraStore to start/stop timer when session changes
devoraStore.subscribe(($store) => {
	// Clean up existing timer
	if (timerCleanup) {
		timerCleanup()
		timerCleanup = null
	}

	// Start timer if impersonating
	if ($store.isImpersonating && $store.session.expiresAt) {
		timerCleanup = startRemainingTimer()
	} else {
		remainingMsStore.set(null)
	}
})

/**
 * Derived store for impersonation state with enriched user info
 */
export const devoraImpersonation: Readable<{
	isImpersonating: boolean
	scope: ImpersonationScope | null
	userId: string | null
	sessionId: string | null
	expiresAt: string | null
	targetUser: { id: string; email?: string; name?: string } | null
	impersonator: { id: string; email?: string; name?: string } | null
	remainingMs: number | null
}> = derived([devoraStore, remainingMsStore], ([$store, $remainingMs]) => {
	return {
		isImpersonating: $store.isImpersonating,
		scope: $store.session.scope,
		userId: $store.session.userId,
		sessionId: $store.session.sessionId,
		expiresAt: $store.session.expiresAt,
		targetUser: $store.session.targetUser,
		impersonator: $store.session.impersonator,
		remainingMs: $remainingMs,
	}
})

/**
 * Derived store for scope state
 */
export const devoraScope: Readable<{
	scope: ImpersonationScope | null
	canWrite: boolean
	isReadOnly: boolean
}> = derived(devoraStore, ($store) => ({
	scope: $store.session.scope,
	canWrite: $store.session.scope === "write" || !$store.isImpersonating,
	isReadOnly: $store.isImpersonating && $store.session.scope === "read",
}))

/**
 * Derived store for bridge-restoration state: whether this tab is blocked (an
 * impersonated customer session Devora could not safely restore) or still
 * pending (a configured `sessionBridge` hasn't resolved yet). Protected
 * content must not render in either case — see `BridgeGuard.svelte` for a
 * ready-made wrapper, since Svelte has no provider component that gates
 * automatically.
 */
export const devoraBridge: Readable<{
	bridgeState: BridgeState
	isBlocked: boolean
	/**
	 * True while the SDK is exchanging a one-time link, or while a
	 * configured `sessionBridge` hasn't resolved. False on a plain page
	 * load with neither — most pages don't need this window explained.
	 */
	isPending: boolean
}> = derived(devoraStore, ($store) => ({
	bridgeState: $store.bridgeState,
	isBlocked: $store.bridgeState.status === "blocked",
	isPending: ($store.hasSessionBridge || INITIAL_PAYLOAD_DETECTED) && !$store.isInitialized,
}))

/**
 * Derived store for the reactive state driving the default
 * session-lifecycle components (`SessionEndedScreen.svelte`,
 * `LinkInvalidScreen.svelte`, `BlockedActionDialog.svelte`). Exposed
 * directly too, for a custom UI built on the same state.
 */
export const devoraSessionState: Readable<{
	payloadError: PayloadError | null
	lastEndReason: string | null
	activeViolation: ScopeViolation | null
}> = derived(devoraStore, ($store) => ({
	payloadError: $store.payloadError,
	lastEndReason: $store.lastEndReason,
	activeViolation: $store.activeViolation,
}))

/**
 * Dismiss the currently displayed blocked-write dialog, if any.
 */
export function dismissViolation(): void {
	devoraStore.update((state) => ({ ...state, activeViolation: null }))
}

/**
 * Derived store for SDK ready/auth gate state.
 */
export const devoraAuth: Readable<{
	isReady: boolean
	isInitialized: boolean
	isImpersonating: boolean
	hadPayloadOnLoad: boolean
	scope: ImpersonationScope | null
	initError: Error | null
}> = derived(devoraStore, ($store) => ({
	isReady: INITIAL_PAYLOAD_DETECTED ? $store.isInitialized : true,
	isInitialized: $store.isInitialized,
	isImpersonating: $store.isImpersonating,
	hadPayloadOnLoad: INITIAL_PAYLOAD_DETECTED,
	scope: $store.session.scope,
	initError: $store.initError,
}))

/**
 * Devora config for Svelte
 */
export interface DevoraSvelteConfig extends Omit<
	JSFrontendSDKConfig,
	"onImpersonate" | "onSessionEnd"
> {
	onImpersonate?: (payload: ImpersonatePayload) => void | Promise<void>
	onSessionEnd?: (reason: string) => void | Promise<void>
}

/**
 * Initialize Devora SDK
 *
 * Note: If called multiple times, the previous SDK instance will be destroyed
 * and a new one will be created. To avoid resource leaks, call destroyDevora()
 * explicitly before reinitializing if needed.
 */
export async function initDevora(config: DevoraSvelteConfig): Promise<DevoraFrontendSDK> {
	// Claim ownership before asynchronous cleanup. Older init/end/destroy calls
	// may still finish, but can no longer publish into this instance's store.
	const previous = globalSDK
	const sdk = createDevoraSDK()
	globalSDK = sdk
	const ownsStore = () => globalSDK === sdk
	devoraStore.set({ ...initialStoreState, hasSessionBridge: !!config.sessionBridge })

	try {
		if (previous) await previous.destroy()
		if (!ownsStore()) return sdk
		devoraStore.update((state) => ({ ...state, initError: null }))
		await sdk.init({
			...config,
			onError: {
				...config.onError,
				payloadError: (error) => {
					if (!ownsStore()) return
					devoraStore.update((state) => ({ ...state, payloadError: error }))
					config.onError?.payloadError?.(error)
				},
			},
			onImpersonate: async (payload) => {
				if (!ownsStore()) return
				devoraStore.update((state) => ({
					...state,
					isImpersonating: true,
					session: sdk.getSession(),
				}))
				if (config.onImpersonate) {
					await config.onImpersonate(payload)
				}
			},
			onSessionEnd: async (reason) => {
				if (!ownsStore()) return
				devoraStore.update((state) => ({
					...state,
					isImpersonating: false,
					session: sdk.getSession(),
					lastEndReason: reason,
					activeViolation: null,
				}))
				if (config.onSessionEnd) {
					await config.onSessionEnd(reason)
				}
			},
		})
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error))
		if (ownsStore()) devoraStore.update((state) => ({ ...state, initError: err }))
		throw err
	}

	if (!ownsStore()) return sdk
	devoraStore.update((state) => ({
		...state,
		isInitialized: true,
		isImpersonating: sdk.isImpersonating(),
		bridgeState: sdk.getBridgeState(),
		initError: null,
		session: sdk.getSession(),
	}))
	sdk.on("session_blocked", () => {
		if (!ownsStore()) return
		devoraStore.update((state) => ({ ...state, bridgeState: sdk.getBridgeState() }))
	})
	sdk.on("scope_violation", (event: { data?: unknown }) => {
		if (!ownsStore()) return
		devoraStore.update((state) => ({ ...state, activeViolation: event.data as ScopeViolation }))
	})

	return sdk
}

/**
 * End the current impersonation session
 */
export async function endDevoraSession(): Promise<void> {
	const sdk = globalSDK
	if (sdk) {
		await sdk.end()
		if (globalSDK !== sdk) return
		devoraStore.update((state) => ({
			...state,
			isImpersonating: false,
			session: sdk.getSession(),
		}))
	}
}

/**
 * Log an action
 */
export function logDevoraAction(event: Omit<LogEvent, "sessionId" | "timestamp">): void {
	if (globalSDK) {
		globalSDK.logAction(event)
	}
}

/**
 * Log a click event
 */
export function logDevoraClick(elementId: string, metadata?: Record<string, unknown>): void {
	logDevoraAction({
		type: "click",
		action: "click",
		metadata: { elementId, ...metadata },
	})
}

/**
 * Log a navigation event
 */
export function logDevoraNavigation(path: string, metadata?: Record<string, unknown>): void {
	logDevoraAction({
		type: "navigation",
		path,
		metadata,
	})
}

/**
 * Get the SDK instance
 */
export function getDevoraSDK(): DevoraFrontendSDK | null {
	return globalSDK
}

/**
 * Destroy the SDK
 *
 * NOTE: This is now async. If you need to ensure recording data is flushed,
 * await the destroy call before navigation/unmounting.
 *
 * Example usage:
 * ```svelte
 * <script>
 *   import { onDestroy } from 'svelte';
 *   import { destroyDevora } from '@devorash/svelte';
 *
 *   // Fire-and-forget (small risk of data loss during fast unmount)
 *   onDestroy(() => void destroyDevora());
 *
 *   // Guaranteed flush (blocks UI slightly but ensures data saved)
 *   onDestroy(async () => await destroyDevora());
 * </script>
 * ```
 */
export async function destroyDevora(): Promise<void> {
	const sdk = globalSDK
	globalSDK = null
	devoraStore.set({ ...initialStoreState })
	if (sdk) await sdk.destroy()
}

// Re-export types
export type {
	ImpersonatePayload,
	ImpersonationScope,
	ImpersonationUserInfo,
	SessionState,
	ScopeViolation,
	PayloadError,
	ErrorHandlers,
	JSFrontendSDKConfig,
	DevoraMaskingProfile,
	DevoraCaptureSnapshot,
	SessionBridge,
	BridgeState,
	BridgeBlockedReason,
} from "@devorash/browser"

export { devoraMask, devoraRegion, devoraBlock } from "./privacy.js"
export { isExplainableEndReason } from "./session-screens.js"
