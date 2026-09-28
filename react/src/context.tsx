/**
 * React Context for Devora SDK
 * @module @devorash/react
 *
 * Provides seamless integration with React applications.
 * The SDK now uses synchronous payload detection - no async waiting required.
 */

import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useState,
	useCallback,
	useRef,
	type ReactNode,
} from "react"
import {
	createDevoraSDK,
	hasExchangeParameterInURL,
	type DevoraFrontendSDK,
	type SessionState,
	type JSFrontendSDKConfig,
	type BridgeState,
} from "@devorash/browser"
import {
	createLogger,
	type ImpersonatePayload,
	type ImpersonationScope,
	type LogEventType,
	type PayloadError,
	type ScopeViolation,
} from "@devorash/core"
import {
	SessionPreparingScreen,
	SessionEndedScreen,
	LinkInvalidScreen,
	BlockedActionDialog,
	isExplainableEndReason,
} from "./session-screens.js"

// Create a logger instance for the React SDK
const logger = createLogger("Devora React")

/**
 * Check if there's a Devora payload in the URL.
 * This is a SYNCHRONOUS check that can be called before React renders.
 *
 * @returns true if a Devora one-time exchange parameter is present in the URL
 */
export function hasDevoraPayload(): boolean {
	return hasExchangeParameterInURL()
}

// Capture payload presence ONCE at module load (before React renders)
// This ensures we detect the payload before any URL cleaning happens
const INITIAL_PAYLOAD_DETECTED = typeof window !== "undefined" && hasDevoraPayload()

/**
 * Devora context value
 */
export interface DevoraContextValue {
	/** SDK instance */
	sdk: DevoraFrontendSDK | null
	/** Whether SDK is initialized */
	isInitialized: boolean
	/** Initialization error, if init() rejected */
	initError: Error | null
	/** Whether an impersonation session is active */
	isImpersonating: boolean
	/**
	 * True when the customer backend confirmed an impersonated session but this
	 * tab could not be safely restored. Protected content must not render.
	 */
	isBlocked: boolean
	/**
	 * True while a configured `sessionBridge` has not yet resolved whether this
	 * tab is safe. Protected content must not render — a tab that turns out to
	 * be blocked has not been distinguished from a safe one yet.
	 */
	isPending: boolean
	/** Outcome of this tab's restoration attempt. */
	bridgeState: BridgeState
	/** Current session state */
	session: SessionState
	/** Access scope of current session */
	scope: ImpersonationScope | null
	/** Whether a payload was detected on initial page load (before SDK init) */
	hadPayloadOnLoad: boolean
	/** End the current session */
	endSession: () => Promise<void>
	/** Log a custom action */
	logAction: (event: {
		type: LogEventType
		action?: string
		path?: string
		metadata?: Record<string, unknown>
	}) => void
}

/**
 * Devora context
 */
const DevoraContext = createContext<DevoraContextValue | null>(null)

/**
 * Countdown context, separate from `DevoraContext`: it updates every second
 * while impersonating, so keeping it out of the main context value means
 * that tick only re-renders components that actually read it (via
 * `useDevoraRemainingMs()` / `useDevoraImpersonation()`), not every
 * `useDevoraContext()` consumer in the app.
 */
const DevoraRemainingMsContext = createContext<number | null>(null)

/**
 * Props for DevoraProvider
 */
export interface DevoraProviderProps extends Omit<
	JSFrontendSDKConfig,
	"onImpersonate" | "onSessionEnd"
> {
	/** Child components */
	children: ReactNode
	/** Callback when impersonation starts */
	onImpersonate?: (payload: ImpersonatePayload) => void | Promise<void>
	/** Callback when session ends */
	onSessionEnd?: (reason: string) => void | Promise<void>
	/**
	 * Rendered instead of `children` while this tab is blocked (an impersonated
	 * customer session that Devora could not safely restore). Defaults to a
	 * minimal safety screen with retry and end-impersonation actions.
	 */
	blockedFallback?: ReactNode | ((state: { reason: string; retry: () => void }) => ReactNode)
	/**
	 * Rendered instead of `children` while the SDK is exchanging the one-time
	 * link, or while a configured `sessionBridge` has not yet resolved whether
	 * this tab is safe. Defaults to a "Preparing your session" screen. Has no
	 * effect when neither condition applies (e.g. a normal page load with no
	 * impersonation link and no bridge configured).
	 */
	loadingFallback?: ReactNode | (() => ReactNode)
	/**
	 * Rendered instead of `children` right after a session ends for a reason
	 * worth explaining (the time limit was reached, or access was ended from
	 * Devora) — not shown for a deliberate `endSession()` call, since the agent
	 * who just clicked "End session" doesn't need it explained back to them.
	 * Defaults to a plain "Session ended" screen.
	 */
	sessionEndedFallback?: ReactNode | ((state: { reason: string }) => ReactNode)
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
 *
 * Automatically detects and processes impersonation payloads.
 * The SDK uses synchronous payload parsing - no async API calls for token detection.
 */
export function DevoraProvider({
	children,
	onImpersonate,
	onSessionEnd,
	blockedFallback,
	loadingFallback,
	sessionEndedFallback,
	devoraAppUrl,
	...config
}: DevoraProviderProps) {
	const [sdk] = useState(() => createDevoraSDK())
	const [isInitialized, setIsInitialized] = useState(false)
	const [bridgeState, setBridgeState] = useState<BridgeState>({ status: "idle" })
	const [initError, setInitError] = useState<Error | null>(null)
	const [isImpersonating, setIsImpersonating] = useState(false)
	const [session, setSession] = useState<SessionState>({
		isActive: false,
		sessionId: null,
		scope: null,
		expiresAt: null,
		userId: null,
		targetUser: null,
		impersonator: null,
	})
	const [remainingMs, setRemainingMs] = useState<number | null>(null)
	const [payloadError, setPayloadError] = useState<PayloadError | null>(null)
	const [lastEndReason, setLastEndReason] = useState<string | null>(null)
	const [activeViolation, setActiveViolation] = useState<ScopeViolation | null>(null)

	// Use refs to store callbacks to avoid dependency issues
	const onImpersonateRef = useRef(onImpersonate)
	const onSessionEndRef = useRef(onSessionEnd)
	const configRef = useRef(config)

	// Update refs when callbacks change
	useEffect(() => {
		onImpersonateRef.current = onImpersonate
		onSessionEndRef.current = onSessionEnd
		configRef.current = config
	})

	// Countdown timer: ticks every second while impersonating. The display
	// shows seconds (MM:SS), so it updates every second regardless of how
	// much time is left — a slower interval for long sessions previously
	// made the clock look frozen for minutes at a time.
	useEffect(() => {
		if (!isImpersonating || !session.expiresAt) {
			setRemainingMs(null)
			return
		}

		const expiresAtMs = new Date(session.expiresAt).getTime()
		const updateRemaining = () => {
			setRemainingMs(Math.max(0, expiresAtMs - Date.now()))
		}

		updateRemaining()
		const intervalId = setInterval(updateRemaining, 1_000)

		return () => clearInterval(intervalId)
	}, [isImpersonating, session.expiresAt])

	// Initialize SDK once on mount
	useEffect(() => {
		let mounted = true
		if (!configRef.current.apiKey?.trim()) {
			// Customer-app examples can run their own login flow before they are
			// connected to a Devora dashboard. Keep the provider context usable,
			// but do not initialize the SDK or hold the app behind a session bridge.
			setIsInitialized(true)
			return () => {
				mounted = false
			}
		}

		const onBlocked = () => {
			if (mounted) setBridgeState(sdk.getBridgeState())
		}
		sdk.on("session_blocked", onBlocked)

		const onViolation = (event: { data?: unknown }) => {
			if (!mounted) return
			// The customer already handles violations themselves (e.g. their own
			// toast) — don't also pop our dialog on top of that.
			if (configRef.current.onError?.scopeViolation) return
			setActiveViolation(event.data as ScopeViolation)
		}
		sdk.on("scope_violation", onViolation)

		sdk
			.init({
				...configRef.current,
				onError: {
					...configRef.current.onError,
					payloadError: (error) => {
						if (mounted) setPayloadError(error)
						configRef.current.onError?.payloadError?.(error)
					},
				},
				onImpersonate: async (payload) => {
					if (!mounted) return
					setIsImpersonating(true)
					setSession(sdk.getSession())
					if (onImpersonateRef.current) {
						await onImpersonateRef.current(payload)
					}
				},
				onSessionEnd: async (reason) => {
					if (!mounted) return
					setIsImpersonating(false)
					setSession(sdk.getSession())
					setLastEndReason(reason)
					setActiveViolation(null)
					if (onSessionEndRef.current) {
						await onSessionEndRef.current(reason)
					}
				},
			})
			.then(() => {
				if (!mounted) return
				setInitError(null)
				const impersonating = sdk.isImpersonating()
				const currentSession = sdk.getSession()
				logger.debug("SDK initialized, state:", {
					impersonating,
					sessionId: currentSession.sessionId,
				})
				setIsInitialized(true)
				// Get the latest state after init completes
				// (session may have been restored through the bridge)
				setIsImpersonating(impersonating)
				setSession(currentSession)
				setBridgeState(sdk.getBridgeState())
			})
			.catch((error) => {
				if (!mounted) return
				const err = error instanceof Error ? error : new Error(String(error))
				setInitError(err)
				logger.error("Failed to initialize Devora SDK:", err)
			})

		return () => {
			mounted = false

			// destroy() is async; fire-and-forget in cleanup. Await sdk.destroy() before navigation for a guaranteed flush.
			void sdk.destroy()
		}
	}, [sdk])

	// End session handler
	const endSession = useCallback(async () => {
		try {
			await sdk.end()
		} finally {
			// Update state even if end() fails
			setIsImpersonating(false)
			setSession(sdk.getSession())
		}
	}, [sdk])

	// Log action handler
	const logAction = useCallback(
		(event: {
			type: LogEventType
			action?: string
			path?: string
			metadata?: Record<string, unknown>
		}) => {
			if (!isInitialized) {
				return
			}
			if (!configRef.current.apiKey?.trim()) return
			sdk.logAction(event)
		},
		[sdk, isInitialized]
	)

	const isBlocked = bridgeState.status === "blocked"
	const isPending =
		((!!config.apiKey?.trim() && !!config.sessionBridge) || INITIAL_PAYLOAD_DETECTED) &&
		!isInitialized
	const value = useMemo<DevoraContextValue>(
		() => ({
			sdk,
			isInitialized,
			initError,
			isImpersonating,
			isBlocked,
			isPending,
			bridgeState,
			session,
			scope: session.scope,
			hadPayloadOnLoad: INITIAL_PAYLOAD_DETECTED,
			endSession,
			logAction,
		}),
		[
			sdk,
			isInitialized,
			initError,
			isImpersonating,
			isBlocked,
			isPending,
			bridgeState,
			session,
			endSession,
			logAction,
		]
	)

	const customerHandlesPayloadErrors = !!configRef.current.onError?.payloadError

	let content: ReactNode = children
	if (isBlocked) {
		const reason = bridgeState.status === "blocked" ? bridgeState.reason : "session_invalid"
		const retry = () => {
			if (typeof window !== "undefined") window.location.reload()
		}
		content =
			typeof blockedFallback === "function"
				? blockedFallback({ reason, retry })
				: (blockedFallback ?? (
						<ImpersonationBlockedScreen
							reason={reason}
							onRetry={retry}
							onEnd={async () => {
								// No Devora capability exists in this tab; let the host clear its
								// own authentication so this cannot continue as a bare login.
								await onSessionEndRef.current?.("blocked")
							}}
						/>
					))
	} else if (isPending) {
		content =
			typeof loadingFallback === "function"
				? loadingFallback()
				: (loadingFallback ?? <SessionPreparingScreen />)
	} else if (payloadError && !customerHandlesPayloadErrors) {
		content = <LinkInvalidScreen error={payloadError} devoraAppUrl={devoraAppUrl} />
	} else if (!isImpersonating && lastEndReason && isExplainableEndReason(lastEndReason)) {
		content =
			typeof sessionEndedFallback === "function"
				? sessionEndedFallback({ reason: lastEndReason })
				: (sessionEndedFallback ?? (
						<SessionEndedScreen reason={lastEndReason} devoraAppUrl={devoraAppUrl} />
					))
	}

	return (
		<DevoraRemainingMsContext.Provider value={remainingMs}>
			<DevoraContext.Provider value={value}>
				{content}
				{isImpersonating && activeViolation && (
					<BlockedActionDialog
						violation={activeViolation}
						onDismiss={() => setActiveViolation(null)}
					/>
				)}
			</DevoraContext.Provider>
		</DevoraRemainingMsContext.Provider>
	)
}

/**
 * Default safety screen for a tab whose impersonated customer session could not
 * be restored under Devora's controls. Deliberately plain and dependency-free.
 */
function ImpersonationBlockedScreen({
	reason,
	onRetry,
	onEnd,
}: {
	reason: string
	onRetry: () => void
	onEnd: () => void | Promise<void>
}) {
	const message =
		reason === "control_plane_unavailable" || reason === "bridge_unavailable"
			? "Devora is temporarily unreachable, so this impersonated session cannot continue in this tab."
			: "This impersonated session could not be restored in this tab."
	return (
		<div
			role="alert"
			style={{
				fontFamily: "system-ui, sans-serif",
				maxWidth: 480,
				margin: "10vh auto",
				padding: 24,
				border: "1px solid #e5b400",
				borderRadius: 8,
				background: "#fffbea",
				color: "#1f1f1f",
			}}
		>
			<h2 style={{ margin: "0 0 8px", fontSize: 18 }}>Impersonation paused</h2>
			<p style={{ margin: "0 0 16px", fontSize: 14 }}>{message}</p>
			<div style={{ display: "flex", gap: 8 }}>
				<button type="button" onClick={onRetry} style={{ padding: "8px 12px" }}>
					Retry
				</button>
				<button type="button" onClick={() => void onEnd()} style={{ padding: "8px 12px" }}>
					End impersonation
				</button>
			</div>
		</div>
	)
}

/**
 * Hook to access Devora context
 */
export function useDevoraContext(): DevoraContextValue {
	const context = useContext(DevoraContext)
	if (!context) {
		throw new Error("useDevoraContext must be used within a DevoraProvider")
	}
	return context
}

/**
 * Hook to access the live countdown on its own. Reading it here (instead of
 * from `useDevoraContext()`) means the once-a-second update only re-renders
 * whatever calls this hook, not every consumer of the main context.
 */
export function useDevoraRemainingMs(): number | null {
	return useContext(DevoraRemainingMsContext)
}
