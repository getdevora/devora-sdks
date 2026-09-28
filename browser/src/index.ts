/**
 * Devora Frontend JavaScript SDK
 *
 * Secure frontend SDK for enabling impersonation in your web application.
 *
 * @example
 * ```typescript
 * import Devora from "@devorash/browser";
 *
 * // Initialize the SDK
 * await Devora.init({
 *   apiKey: "pk_client_live_xxx",
 * });
 *
 * // Handle impersonation
 * Devora.onImpersonate(async ({ token, data, scope }) => {
 *   // Exchange the Devora token with your app's auth/session layer.
 *   // Prefer an HTTP-only cookie or provider-managed session over browser storage.
 *   await signInWithDevoraToken(token);
 *
 *   // Apply user preferences
 *   if (data?.theme) setTheme(data.theme);
 *
 *   // Show your own impersonation indicator (or use a framework wrapper banner)
 *   if (Devora.isImpersonating()) {
 *     document.body.classList.add("devora-impersonating");
 *   }
 *
 *   // Navigate to dashboard
 *   router.push("/dashboard");
 * });
 *
 * // Check impersonation status
 * if (Devora.isImpersonating()) {
 *   const { scope } = Devora.getSession();
 *   console.log(`Impersonating with ${scope} access`);
 * }
 * ```
 *
 * @packageDocumentation
 * @module @devorash/browser
 */

// Main SDK
export { default, Devora, createDevoraSDK } from "./sdk.js"

// Token detection and session management
export {
	getExchangeCodeFromURL,
	getExchangeVerifier,
	requestExchangeVerifier,
	hasExchangeParameterInURL,
	exchangePayload,
	resumeSession,
	validateStoredSession,
	cleanURL,
} from "./token-detector.js"

// Tab coordination (non-secret tab references and lifecycle notices)
export { TabCoordinator } from "./tab-coordination.js"
export type { SessionNotice } from "./tab-coordination.js"

// Capture implementation and privacy builders are internal. Public consumers
// configure capture only through Devora Settings, never a recorder constructor.

// Types
export type {
	JSFrontendSDKConfig,
	SessionState,
	SessionRevocationState,
	DecryptedPayload,
	ResumedSession,
	SessionBridge,
	BridgeState,
	BridgeBlockedReason,
	StoredSessionValidation,
	SDKEventType,
	SDKEvent,
	SDKEventListener,
	DevoraFrontendSDK,
} from "./types.js"

// Re-export commonly used items from core
export {
	// URL & Storage keys
	URL_PARAMS,
	BROWSER_SESSION_BRIDGE,
	// Defaults
	SDK_DEFAULTS,
	SDK_VERSION,
	// Session lifecycle
	SDK_END_REASON,
	// Utilities
	isWriteMethod,
	scopeAllowsWrite,
	getScopeDescription,
	cleanImpersonationParams,
	createLogEvent,
	// Logger service
	LogLevel,
	configureLogger,
	createLogger,
} from "@devorash/core"

// Re-export types from core
export type {
	FrontendSDKConfig,
	ImpersonatePayload,
	ImpersonateCallback,
	SessionEndCallback,
	ImpersonationScope,
	ImpersonationUserInfo,
	ErrorHandlers,
	PayloadError,
	ScopeViolation,
	LogEvent,
	LogEventType,
	SessionBridgeResult,
	SDKEndReason,
	// Recording privacy & activity log config
	DevoraMaskingProfile,
	DevoraCapturePolicy,
	DevoraCaptureSnapshot,
	// Logger types
	Logger,
	LoggerConfig,
} from "@devorash/core"
