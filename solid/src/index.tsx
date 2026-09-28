/**
 * Devora Solid.js SDK
 *
 * Solid.js primitives for enabling impersonation in your Solid app.
 *
 * @example
 * ```tsx
 * import { DevoraProvider, useDevoraImpersonation } from "@devorash/solid";
 *
 * function App() {
 *   return (
 *     <DevoraProvider
 *       apiKey="pk_client_live_xxx"
 *       onImpersonate={async ({ token }) => {
 *         await signInWithDevoraToken(token);
 *       }}
 *     >
 *       <YourApp />
 *     </DevoraProvider>
 *   );
 * }
 * ```
 *
 * @packageDocumentation
 * @module @devorash/solid
 */

import {
	createContext,
	useContext,
	createSignal,
	createMemo,
	createEffect,
	onMount,
	onCleanup,
	splitProps,
	Show,
	type ParentComponent,
	type Accessor,
	type JSX,
} from "solid-js"
import {
	createDevoraSDK,
	hasExchangeParameterInURL,
	type DevoraFrontendSDK,
	type SessionState,
	type JSFrontendSDKConfig,
	type BridgeState,
	type ScopeViolation,
	type PayloadError,
} from "@devorash/browser"
import type { ImpersonatePayload, LogEvent } from "@devorash/core"
import {
	SessionPreparingScreen,
	SessionEndedScreen,
	LinkInvalidScreen,
	BlockedActionDialog,
	isExplainableEndReason,
} from "./session-screens.js"

/**
 * Devora context type
 */
interface DevoraContextValue {
	sdk: () => DevoraFrontendSDK | null
	isInitialized: Accessor<boolean>
	isImpersonating: Accessor<boolean>
	/** Outcome of this tab's restoration attempt; "blocked" means protected content must not render. */
	bridgeState: Accessor<BridgeState>
	/** True when this tab is a blocked impersonated session. */
	isBlocked: Accessor<boolean>
	/** True while a configured `sessionBridge` has not yet resolved. */
	isPending: Accessor<boolean>
	session: Accessor<SessionState>
	remainingMs: Accessor<number | null>
	initError: Accessor<Error | null>
	hadPayloadOnLoad: boolean
	endSession: () => Promise<void>
	logAction: (event: Omit<LogEvent, "sessionId" | "timestamp">) => void
}

/**
 * Devora context
 */
const DevoraContext = createContext<DevoraContextValue>()

/**
 * Check if there's a Devora payload in the URL.
 */
export function hasDevoraPayload(): boolean {
	return hasExchangeParameterInURL()
}

const INITIAL_PAYLOAD_DETECTED = typeof window !== "undefined" && hasDevoraPayload()

/**
 * Props for DevoraProvider
 */
export interface DevoraProviderProps extends Omit<
	JSFrontendSDKConfig,
	"onImpersonate" | "onSessionEnd"
> {
	onImpersonate?: (payload: ImpersonatePayload) => void | Promise<void>
	onSessionEnd?: (reason: string) => void | Promise<void>
	/**
	 * Rendered instead of children while this tab is blocked (an impersonated
	 * customer session that Devora could not safely restore). Defaults to
	 * rendering nothing.
	 */
	blockedFallback?: JSX.Element
	/**
	 * Rendered instead of children while the SDK is exchanging the one-time
	 * link, or while a configured `sessionBridge` has not yet resolved.
	 * Defaults to a "Preparing your session" screen.
	 */
	loadingFallback?: JSX.Element
	/**
	 * Rendered instead of children right after a session ends for a reason
	 * worth explaining (the time limit was reached, or access was ended from
	 * Devora) — not shown for a deliberate `endSession()` call. Defaults to a
	 * plain "Session ended" screen.
	 */
	sessionEndedFallback?: JSX.Element | ((state: { reason: string }) => JSX.Element)
	/**
	 * The Devora dashboard's own URL, shown as a "Back to Devora" link on the
	 * session-ended and invalid-link screens. Omit it and those screens simply
	 * don't show the link — the SDK has no way to know your dashboard's URL on
	 * its own.
	 */
	devoraAppUrl?: string
}

/**
 * Devora Provider component
 */
export const DevoraProvider: ParentComponent<DevoraProviderProps> = (props) => {
	const [local, sdkConfig] = splitProps(props, [
		"onImpersonate",
		"onSessionEnd",
		"children",
		"blockedFallback",
		"loadingFallback",
		"sessionEndedFallback",
		"devoraAppUrl",
	])
	const [sdk, setSDK] = createSignal<DevoraFrontendSDK | null>(null)
	const [isInitialized, setIsInitialized] = createSignal(false)
	const [isImpersonating, setIsImpersonating] = createSignal(false)
	const [bridgeState, setBridgeState] = createSignal<BridgeState>({ status: "idle" })
	const [initError, setInitError] = createSignal<Error | null>(null)
	const [session, setSession] = createSignal<SessionState>({
		isActive: false,
		sessionId: null,
		scope: null,
		expiresAt: null,
		userId: null,
		targetUser: null,
		impersonator: null,
	})
	const [remainingMs, setRemainingMs] = createSignal<number | null>(null)
	const [payloadError, setPayloadError] = createSignal<PayloadError | null>(null)
	const [lastEndReason, setLastEndReason] = createSignal<string | null>(null)
	const [activeViolation, setActiveViolation] = createSignal<ScopeViolation | null>(null)

	// Countdown timer: ticks every second while impersonating. The display
	// shows seconds (MM:SS), so it updates every second regardless of how
	// much time is left — a slower interval for long sessions previously
	// made the clock look frozen for minutes at a time.
	let intervalId: ReturnType<typeof setInterval> | undefined

	createEffect(() => {
		const currentSession = session()
		const impersonating = isImpersonating()

		if (intervalId) {
			clearInterval(intervalId)
			intervalId = undefined
		}

		if (!impersonating || !currentSession.expiresAt) {
			setRemainingMs(null)
			return
		}

		const expiresAtMs = new Date(currentSession.expiresAt).getTime()
		const updateRemaining = () => {
			setRemainingMs(Math.max(0, expiresAtMs - Date.now()))
		}

		updateRemaining()
		intervalId = setInterval(updateRemaining, 1_000)
	})

	// Cleanup timer on unmount
	onCleanup(() => {
		if (intervalId) {
			clearInterval(intervalId)
		}
	})

	onMount(async () => {
		try {
			const sdkInstance = createDevoraSDK()
			setSDK(sdkInstance)

			const { onImpersonate, onSessionEnd } = local

			await sdkInstance.init({
				...sdkConfig,
				onError: {
					...sdkConfig.onError,
					payloadError: (error) => {
						setPayloadError(error)
						sdkConfig.onError?.payloadError?.(error)
					},
				},
				onImpersonate: async (payload) => {
					setIsImpersonating(true)
					setSession(sdkInstance.getSession())
					if (onImpersonate) {
						await onImpersonate(payload)
					}
				},
				onSessionEnd: async (reason) => {
					setIsImpersonating(false)
					setSession(sdkInstance.getSession())
					setLastEndReason(reason)
					setActiveViolation(null)
					if (onSessionEnd) {
						await onSessionEnd(reason)
					}
				},
			})

			setIsInitialized(true)
			setIsImpersonating(sdkInstance.isImpersonating())
			setBridgeState(sdkInstance.getBridgeState())
			sdkInstance.on("session_blocked", () => setBridgeState(sdkInstance.getBridgeState()))
			sdkInstance.on("scope_violation", (event: { data?: unknown }) => {
				// The customer already handles violations themselves (e.g. their own
				// toast) — don't also pop our dialog on top of that.
				if (sdkConfig.onError?.scopeViolation) return
				setActiveViolation(event.data as ScopeViolation)
			})
			setSession(sdkInstance.getSession())
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error))
			setInitError(err)
			if (props.debug) {
				console.error("[Devora] Initialization failed:", error)
			}
		}
	})

	onCleanup(() => {
		const sdkInstance = sdk()
		if (sdkInstance) {
			// NOTE: destroy() is now async but Solid cleanup functions must be sync
			// Fire-and-forget to ensure recording data is flushed in background
			// See sdk.destroy() JSDoc for migration notes and data loss prevention
			void sdkInstance.destroy()
		}
	})

	const endSession = async () => {
		const sdkInstance = sdk()
		if (sdkInstance) {
			await sdkInstance.end()
			setIsImpersonating(false)
			setSession(sdkInstance.getSession())
		}
	}

	const logAction = (event: Omit<LogEvent, "sessionId" | "timestamp">) => {
		const sdkInstance = sdk()
		if (sdkInstance) {
			sdkInstance.logAction(event)
		}
	}

	const isBlocked = createMemo(() => bridgeState().status === "blocked")
	const isPending = createMemo(
		() => (!!sdkConfig.sessionBridge || INITIAL_PAYLOAD_DETECTED) && !isInitialized()
	)
	const value: DevoraContextValue = {
		sdk,
		isInitialized,
		isImpersonating,
		bridgeState,
		isBlocked,
		isPending,
		session,
		remainingMs,
		initError,
		hadPayloadOnLoad: INITIAL_PAYLOAD_DETECTED,
		endSession,
		logAction,
	}

	const customerHandlesPayloadErrors = () => !!sdkConfig.onError?.payloadError

	// Each state is a nested <Show>, not a createMemo returning different JSX
	// (including raw `local.children`): `props.children` must be read either
	// directly in JSX or via <Show>'s own internal handling of it to
	// participate correctly in Solid's owner/context graph. Reading it from a
	// plain function — e.g. as one of a memo's return values — detaches it
	// from that graph, so `useContext(DevoraContext)` fails for anything
	// inside `children` that depends on it (silently, unless `debug` is on).
	const linkInvalidFallback = () => {
		const error = payloadError()
		return error ? <LinkInvalidScreen error={error} devoraAppUrl={local.devoraAppUrl} /> : null
	}

	const sessionEndedFallbackContent = () => {
		const endReason = lastEndReason()
		if (!endReason) return null
		return typeof local.sessionEndedFallback === "function"
			? local.sessionEndedFallback({ reason: endReason })
			: (local.sessionEndedFallback ?? (
					<SessionEndedScreen reason={endReason} devoraAppUrl={local.devoraAppUrl} />
				))
	}

	return (
		<DevoraContext.Provider value={value}>
			<Show
				when={!isBlocked() && !isPending()}
				fallback={
					isBlocked()
						? (local.blockedFallback ?? null)
						: (local.loadingFallback ?? <SessionPreparingScreen />)
				}
			>
				<Show
					when={!payloadError() || customerHandlesPayloadErrors()}
					fallback={linkInvalidFallback()}
				>
					<Show
						when={
							isImpersonating() ||
							!lastEndReason() ||
							!isExplainableEndReason(lastEndReason() as string)
						}
						fallback={sessionEndedFallbackContent()}
					>
						{local.children}
					</Show>
				</Show>
			</Show>
			<Show when={isImpersonating() && activeViolation()}>
				{(violation) => (
					<BlockedActionDialog violation={violation()} onDismiss={() => setActiveViolation(null)} />
				)}
			</Show>
		</DevoraContext.Provider>
	)
}

/**
 * Hook to access Devora context
 */
function useDevoraContext(): DevoraContextValue {
	const context = useContext(DevoraContext)
	if (!context) {
		throw new Error("useDevoraContext must be used within a DevoraProvider")
	}
	return context
}

/**
 * Hook to get impersonation state with enriched user info
 */
export function useDevoraImpersonation() {
	const context = useDevoraContext()

	return {
		isImpersonating: context.isImpersonating,
		scope: createMemo(() => context.session().scope),
		userId: createMemo(() => context.session().userId),
		sessionId: createMemo(() => context.session().sessionId),
		expiresAt: createMemo(() => context.session().expiresAt),
		targetUser: createMemo(() => context.session().targetUser),
		impersonator: createMemo(() => context.session().impersonator),
		/** Remaining time in milliseconds (from smart timer) */
		remainingMs: context.remainingMs,
		endSession: context.endSession,
	}
}

/**
 * Hook to check if SDK is ready
 */
export function useDevoraReady(): Accessor<boolean> {
	const context = useDevoraContext()
	return context.isInitialized
}

/**
 * Hook that combines SDK ready state with payload detection.
 */
export function useDevoraAuth() {
	const context = useDevoraContext()
	const isReady = createMemo(() => (context.hadPayloadOnLoad ? context.isInitialized() : true))

	return {
		isReady,
		isInitialized: context.isInitialized,
		isImpersonating: context.isImpersonating,
		hadPayloadOnLoad: context.hadPayloadOnLoad,
		scope: createMemo(() => context.session().scope),
		endSession: context.endSession,
	}
}

/**
 * Hook to get scope information
 */
export function useDevoraScope() {
	const context = useDevoraContext()

	return {
		scope: createMemo(() => context.session().scope),
		canWrite: createMemo(() => context.session().scope === "write" || !context.isImpersonating()),
		isReadOnly: createMemo(() => context.isImpersonating() && context.session().scope === "read"),
	}
}

/**
 * Hook to get logger functions
 */
export function useDevoraLogger() {
	const context = useDevoraContext()

	return {
		logAction: context.logAction,
		logClick: (elementId: string, metadata?: Record<string, unknown>) => {
			context.logAction({
				type: "click",
				action: "click",
				metadata: { elementId, ...metadata },
			})
		},
		logNavigation: (path: string, metadata?: Record<string, unknown>) => {
			context.logAction({
				type: "navigation",
				path,
				metadata,
			})
		},
	}
}

/**
 * Hook to get full session state
 */
export function useDevoraSession() {
	const context = useDevoraContext()

	return {
		isInitialized: context.isInitialized,
		session: context.session,
	}
}

/**
 * Hook to get initialization error (if any)
 */
export function useDevoraError(): Accessor<Error | null> {
	const context = useDevoraContext()
	return context.initError
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

export { ImpersonationBanner } from "./ImpersonationBanner.js"
export type { ImpersonationBannerProps } from "./ImpersonationBanner.js"
export { ReadOnlyGuard, WriteProtected } from "./guards.js"
export type { ReadOnlyGuardProps, WriteProtectedProps } from "./guards.js"
export { DevoraMask, DevoraRegion, DevoraBlock } from "./privacy.js"
