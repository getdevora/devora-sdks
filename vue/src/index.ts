/**
 * Devora Vue SDK
 *
 * Vue composables for enabling impersonation in your Vue app.
 *
 * @example
 * ```vue
 * <script setup>
 * import { useDevora, useDevoraImpersonation } from "@devorash/vue";
 *
 * // Initialize in app root
 * const devora = useDevora({
 *   apiKey: "pk_client_live_xxx",
 *   onImpersonate: async ({ token }) => {
 *     await signInWithDevoraToken(token);
 *   },
 * });
 *
 * // In any component
 * const { isImpersonating, scope, endSession } = useDevoraImpersonation();
 * </script>
 * ```
 *
 * @packageDocumentation
 * @module @devorash/vue
 */

import {
	reactive,
	readonly,
	computed,
	ref,
	onMounted,
	onUnmounted,
	onScopeDispose,
	getCurrentInstance,
	watchEffect,
} from "vue"
import {
	createDevoraSDK,
	hasExchangeParameterInURL,
	type DevoraFrontendSDK,
	type JSFrontendSDKConfig,
	type BridgeState,
	type PayloadError,
	type ScopeViolation,
} from "@devorash/browser"
import {
	createLogger,
	type ImpersonatePayload,
	type ImpersonationScope,
	type LogEvent,
} from "@devorash/core"

// Create a logger instance for the Vue SDK
const logger = createLogger("Devora Vue")

/**
 * Check if there's a Devora payload in the URL.
 */
export function hasDevoraPayload(): boolean {
	return hasExchangeParameterInURL()
}

const INITIAL_PAYLOAD_DETECTED = typeof window !== "undefined" && hasDevoraPayload()

/**
 * Global SDK instance (shared across composables)
 *
 * WARNING: This global state pattern is NOT SSR-safe. In SSR environments (Nuxt, etc.),
 * state would be shared across requests causing data leakage between users.
 * For SSR apps, use Vue's provide/inject pattern with app-level isolation instead.
 */
let globalSDK: DevoraFrontendSDK | null = null
let globalConfig: DevoraVueConfig | null = null
let refCount = 0
/**
 * Components whose setup() adopted the shared SDK but have not mounted yet.
 * A route swap runs the outgoing page's onUnmounted after the incoming page's
 * setup() in the same flush; without this reservation the outgoing page would
 * see refCount reach zero and destroy the instance the incoming page holds.
 */
let pendingSetups = 0
let warnedSecondaryConfig = false
/**
 * In-flight (or successfully completed) `sdk.init()` call shared across every
 * `useDevora()` caller. Without this, two components mounting close together
 * both see `isInitialized() === false` and both call `sdk.init()`; the
 * browser SDK's own generation counter aborts whichever call started first,
 * silently dropping that caller's `onImpersonate`/`onSessionEnd` handlers
 * while both callers still proceed as if their own init had succeeded. Reset
 * to null on a failed attempt (so a later mount can retry) and on full
 * teardown.
 */
let initPromise: Promise<void> | null = null
const globalState = reactive({
	isInitialized: false,
	isImpersonating: false,
	/** Outcome of this tab's restoration attempt; "blocked" means protected content must not render. */
	bridgeState: { status: "idle" } as BridgeState,
	/** Whether the app root's `useDevora()` call configured a `sessionBridge`. */
	hasSessionBridge: false,
	initError: null as Error | null,
	/** Set when the one-time exchange link fails; drives `LinkInvalidScreen`. */
	payloadError: null as PayloadError | null,
	/** Reason from the most recent `onSessionEnd`; drives `SessionEndedScreen`. */
	lastEndReason: null as string | null,
	/** Most recent blocked write; drives `BlockedActionDialog`. */
	activeViolation: null as ScopeViolation | null,
	session: {
		isActive: false,
		sessionId: null as string | null,
		scope: null as ImpersonationScope | null,
		expiresAt: null as string | null,
		userId: null as string | null,
		targetUser: null as { id: string; email?: string; name?: string } | null,
		impersonator: null as { id: string; email?: string; name?: string } | null,
	},
})

/**
 * Devora config for Vue
 */
export interface DevoraVueConfig extends Omit<
	JSFrontendSDKConfig,
	"onImpersonate" | "onSessionEnd"
> {
	onImpersonate?: (payload: ImpersonatePayload) => void | Promise<void>
	onSessionEnd?: (reason: string) => void | Promise<void>
}

/**
 * Initialize Devora SDK (call once in app root)
 *
 * This function is designed to be called once per application instance.
 * If called multiple times, it returns the existing SDK instance.
 */
export function useDevora(config: DevoraVueConfig) {
	const firstCaller = globalSDK === null
	const sdk = globalSDK ?? createDevoraSDK()
	globalSDK = sdk
	// Keep the first caller's configuration across shared mounts. Establish
	// the bridge gate during setup, before any protected children can render.
	const callerConfig = config
	config = globalConfig ?? (globalConfig = config)
	if (!firstCaller && callerConfig !== config && !warnedSecondaryConfig) {
		warnedSecondaryConfig = true
		logger.warn(
			"useDevora() was called again while the SDK is already configured; the first caller's config (including onImpersonate/onSessionEnd/sessionBridge) is kept and this one is ignored"
		)
	}
	if (firstCaller) globalState.hasSessionBridge = !!config.sessionBridge
	const ownsState = () => globalSDK === sdk
	let mounted = false
	let reserved = true
	pendingSetups++
	const releaseReservation = () => {
		if (!reserved) return
		reserved = false
		pendingSetups--
	}
	// Covers a component whose setup() ran but which is discarded before mount.
	onScopeDispose(releaseReservation)

	onMounted(async () => {
		releaseReservation()
		if (!ownsState()) return
		mounted = true
		refCount++

		// Don't reinitialize if already done
		if (sdk.isInitialized()) {
			globalState.isInitialized = true
			globalState.isImpersonating = sdk.isImpersonating()
			Object.assign(globalState.session, sdk.getSession())
			return
		}

		// Another useDevora() caller already started (or already ran) init —
		// await that same attempt instead of racing a second sdk.init() call.
		if (initPromise) {
			await initPromise
			return
		}

		globalState.hasSessionBridge = !!config.sessionBridge
		globalState.initError = null
		initPromise = (async () => {
			try {
				await sdk.init({
					...config,
					onError: {
						...config.onError,
						payloadError: (error) => {
							if (!ownsState()) return
							globalState.payloadError = error
							config.onError?.payloadError?.(error)
						},
					},
					onImpersonate: async (payload) => {
						if (!ownsState()) return
						globalState.isImpersonating = true
						Object.assign(globalState.session, sdk.getSession())
						if (config.onImpersonate) {
							await config.onImpersonate(payload)
						}
					},
					onSessionEnd: async (reason) => {
						if (!ownsState()) return
						globalState.isImpersonating = false
						Object.assign(globalState.session, sdk.getSession())
						globalState.lastEndReason = reason
						globalState.activeViolation = null
						if (config.onSessionEnd) {
							await config.onSessionEnd(reason)
						}
					},
				})

				if (!ownsState()) return
				globalState.isInitialized = true
				globalState.isImpersonating = sdk.isImpersonating()
				globalState.bridgeState = sdk.getBridgeState()
				sdk.on("session_blocked", () => {
					if (!ownsState()) return
					globalState.bridgeState = sdk.getBridgeState()
				})
				sdk.on("scope_violation", (event: { data?: unknown }) => {
					if (!ownsState()) return
					globalState.activeViolation = event.data as ScopeViolation
				})
				Object.assign(globalState.session, sdk.getSession())
			} catch (error) {
				if (!ownsState()) return
				const err = error instanceof Error ? error : new Error(String(error))
				globalState.initError = err
				logger.error("Failed to initialize Devora SDK:", err)
				// Let a later useDevora() mount retry instead of staying stuck on
				// this failure for the rest of the page's lifetime.
				initPromise = null
			}
		})()

		await initPromise
	})

	onUnmounted(() => {
		if (!mounted || !ownsState()) return
		mounted = false
		refCount--
		// Only destroy when the last component using the SDK unmounts
		// NOTE: destroy() is now async but Vue cleanup functions must be sync
		// Fire-and-forget to ensure recording data is flushed in background
		// See sdk.destroy() JSDoc for migration notes and data loss prevention
		if (refCount === 0 && pendingSetups === 0 && globalSDK) {
			globalSDK = null
			globalConfig = null
			initPromise = null
			warnedSecondaryConfig = false
			globalState.isInitialized = false
			globalState.isImpersonating = false
			globalState.initError = null
			globalState.payloadError = null
			globalState.lastEndReason = null
			globalState.activeViolation = null
			globalState.bridgeState = { status: "idle" }
			globalState.hasSessionBridge = false
			Object.assign(globalState.session, {
				isActive: false,
				sessionId: null,
				scope: null,
				expiresAt: null,
				userId: null,
				targetUser: null,
				impersonator: null,
			})
			void sdk.destroy().catch((error) => logger.error("Failed to destroy Devora SDK:", error))
		}
	})

	return {
		sdk,
		isInitialized: computed(() => globalState.isInitialized),
		isImpersonating: computed(() => globalState.isImpersonating),
		bridgeState: computed(() => globalState.bridgeState),
		session: readonly(globalState.session),
		initError: computed(() => globalState.initError),
	}
}

/**
 * Bridge-restoration state: whether this tab is blocked (an impersonated
 * customer session Devora could not safely restore) or still pending (a
 * configured `sessionBridge` hasn't resolved yet). Protected content must not
 * render in either case — see `BridgeGuard` in `./guards.js` for a ready-made
 * wrapper, since Vue has no provider component that gates automatically.
 */
export function useDevoraBridge() {
	return {
		bridgeState: computed(() => globalState.bridgeState),
		isBlocked: computed(() => globalState.bridgeState.status === "blocked"),
		/**
		 * True while the SDK is exchanging a one-time link, or while a
		 * configured `sessionBridge` hasn't resolved. False on a plain page
		 * load with neither — most pages don't need this window explained.
		 */
		isPending: computed(
			() => (globalState.hasSessionBridge || INITIAL_PAYLOAD_DETECTED) && !globalState.isInitialized
		),
	}
}

/**
 * Reactive state driving the default session-lifecycle screens in
 * `./session-screens.js` (`SessionEndedScreen`, `LinkInvalidScreen`,
 * `BlockedActionDialog`). Exposed directly too, for a custom UI built on the
 * same state.
 */
export function useDevoraSessionState() {
	return {
		payloadError: computed(() => globalState.payloadError),
		lastEndReason: computed(() => globalState.lastEndReason),
		activeViolation: computed(() => globalState.activeViolation),
		dismissViolation: () => {
			globalState.activeViolation = null
		},
	}
}

/**
 * Check if SDK is initialized.
 */
export function useDevoraReady() {
	return computed(() => globalState.isInitialized)
}

/**
 * Combine SDK ready state with initial payload detection.
 */
export function useDevoraAuth() {
	const isReady = computed(() => (INITIAL_PAYLOAD_DETECTED ? globalState.isInitialized : true))

	return {
		isReady,
		isInitialized: computed(() => globalState.isInitialized),
		isImpersonating: computed(() => globalState.isImpersonating),
		initError: computed(() => globalState.initError),
		hadPayloadOnLoad: INITIAL_PAYLOAD_DETECTED,
		scope: computed(() => globalState.session.scope),
		endSession: async () => {
			const sdk = globalSDK
			if (!sdk) return
			await sdk.end()
			if (globalSDK !== sdk) return
			globalState.isImpersonating = false
			Object.assign(globalState.session, sdk.getSession())
		},
	}
}

/**
 * Shared countdown state backing `useDevoraImpersonation().remainingMs`. A
 * single interval feeds every subscriber instead of each component running
 * its own — `ImpersonationBanner`, `SessionEndedScreen`, and
 * `BlockedActionDialog` can all be mounted at once, and each calls this
 * composable. Ticks every second while impersonating: the display shows
 * seconds (MM:SS), so a slower interval for long sessions previously made
 * the clock look frozen for minutes at a time.
 */
const remainingMsState = ref<number | null>(null)
let remainingMsSubscriberCount = 0
let remainingMsWatchStop: (() => void) | null = null
let remainingMsIntervalId: ReturnType<typeof setInterval> | undefined

function stopRemainingMsInterval() {
	if (remainingMsIntervalId !== undefined) {
		clearInterval(remainingMsIntervalId)
		remainingMsIntervalId = undefined
	}
}

function subscribeRemainingMs() {
	remainingMsSubscriberCount++
	if (remainingMsSubscriberCount > 1) return

	// Reactive (watchEffect), not a one-shot check: this component can mount
	// (and subscribe) before the app root's `useDevora()` has even called
	// `sdk.init()` — Vue mounts children before their parent, and
	// `useDevora()` lives in the root — so `expiresAt` is reliably still null
	// at subscribe time. A one-shot check would set no timer and never get
	// another chance to.
	remainingMsWatchStop = watchEffect(() => {
		stopRemainingMsInterval()
		const exp = globalState.isImpersonating ? globalState.session.expiresAt : null
		if (!exp) {
			remainingMsState.value = null
			return
		}
		const expiresAtMs = new Date(exp).getTime()
		const updateRemaining = () => {
			remainingMsState.value = Math.max(0, expiresAtMs - Date.now())
		}

		updateRemaining()
		remainingMsIntervalId = setInterval(updateRemaining, 1_000)
	})
}

function unsubscribeRemainingMs() {
	remainingMsSubscriberCount--
	if (remainingMsSubscriberCount > 0) return

	remainingMsWatchStop?.()
	remainingMsWatchStop = null
	stopRemainingMsInterval()
}

/**
 * Get impersonation state with enriched user info (use in any component)
 *
 * Note: For reactive `remainingMs` updates, this composable must be called
 * within a component's setup function. If called outside, `remainingMs` will
 * only update when you call `getRemainingMs()`.
 */
export function useDevoraImpersonation() {
	const isImpersonating = computed(() => globalState.isImpersonating)
	const scope = computed(() => globalState.session.scope)
	const userId = computed(() => globalState.session.userId)
	const sessionId = computed(() => globalState.session.sessionId)
	const expiresAt = computed(() => globalState.session.expiresAt)
	const targetUser = computed(() => globalState.session.targetUser)
	const impersonator = computed(() => globalState.session.impersonator)

	// Check if we're in a component setup context before using lifecycle hooks
	// This prevents errors when the composable is called outside of setup()
	const instance = getCurrentInstance()
	if (instance) {
		onMounted(subscribeRemainingMs)
		onUnmounted(unsubscribeRemainingMs)
	} else {
		// No onMounted/onUnmounted outside a component, so no subscription to
		// the shared timer — give an accurate one-off snapshot instead.
		// Consumer should call getRemainingMs() for subsequent reads.
		const exp = globalState.isImpersonating ? globalState.session.expiresAt : null
		remainingMsState.value = exp ? Math.max(0, new Date(exp).getTime() - Date.now()) : null
	}

	const endSession = async () => {
		const sdk = globalSDK
		if (!sdk) return
		try {
			await sdk.end()
		} finally {
			if (globalSDK === sdk) {
				globalState.isImpersonating = false
				Object.assign(globalState.session, sdk.getSession())
			}
		}
	}

	/**
	 * Get the current remaining time in milliseconds.
	 * Use this if you need the current value without reactivity,
	 * or if the composable is called outside of a component setup.
	 */
	const getRemainingMs = (): number | null => {
		const exp = globalState.session.expiresAt
		return exp ? Math.max(0, new Date(exp).getTime() - Date.now()) : null
	}

	return {
		isImpersonating,
		scope,
		userId,
		sessionId,
		expiresAt,
		targetUser,
		impersonator,
		/** Reactive remaining time (updates every second when in component context) */
		remainingMs: remainingMsState,
		/** Get current remaining time (non-reactive, for one-time reads) */
		getRemainingMs,
		endSession,
	}
}

/**
 * Get scope information
 */
export function useDevoraScope() {
	const scope = computed(() => globalState.session.scope)
	const canWrite = computed(
		() => globalState.session.scope === "write" || !globalState.isImpersonating
	)
	const isReadOnly = computed(
		() => globalState.isImpersonating && globalState.session.scope === "read"
	)

	return {
		scope,
		canWrite,
		isReadOnly,
	}
}

/**
 * Get session state with enriched user info
 */
export function useDevoraSession() {
	return {
		isInitialized: computed(() => globalState.isInitialized),
		isActive: computed(() => globalState.session.isActive),
		sessionId: computed(() => globalState.session.sessionId),
		scope: computed(() => globalState.session.scope),
		userId: computed(() => globalState.session.userId),
		expiresAt: computed(() => globalState.session.expiresAt),
		targetUser: computed(() => globalState.session.targetUser),
		impersonator: computed(() => globalState.session.impersonator),
	}
}

/**
 * Get logger functions
 */
export function useDevoraLogger() {
	const logAction = (event: Omit<LogEvent, "sessionId" | "timestamp">) => {
		if (!globalState.isInitialized) {
			logger.warn("Cannot log action: SDK not initialized")
			return
		}
		if (globalSDK) {
			globalSDK.logAction(event)
		}
	}

	const logClick = (elementId: string, metadata?: Record<string, unknown>) => {
		logAction({
			type: "click",
			action: "click",
			metadata: { elementId, ...metadata },
		})
	}

	const logNavigation = (path: string, metadata?: Record<string, unknown>) => {
		logAction({
			type: "navigation",
			path,
			metadata,
		})
	}

	return {
		logAction,
		logClick,
		logNavigation,
	}
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

export {
	vDevoraMask,
	vDevoraRegion,
	vDevoraBlock,
	DevoraMask,
	DevoraRegion,
	DevoraBlock,
} from "./privacy.js"
export { ImpersonationBanner } from "./ImpersonationBanner.js"
export type { ImpersonationBannerSlotProps } from "./ImpersonationBanner.js"
export { ReadOnlyGuard, WriteProtected, BridgeGuard } from "./guards.js"
export {
	SessionPreparingScreen,
	SessionEndedScreen,
	LinkInvalidScreen,
	BlockedActionDialog,
	isExplainableEndReason,
} from "./session-screens.js"
