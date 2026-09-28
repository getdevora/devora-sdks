/**
 * Devora React SDK
 *
 * React hooks and components for enabling impersonation in your React app.
 *
 * @example
 * ```tsx
 * import { DevoraProvider, useDevoraImpersonation, ImpersonationBanner } from "@devorash/react";
 *
 * function App() {
 *   return (
 *     <DevoraProvider
 *       apiKey="pk_client_live_xxx"
 *       onImpersonate={async ({ token }) => {
 *         await signInWithDevoraToken(token);
 *       }}
 *     >
 *       <ImpersonationBanner />
 *       <YourApp />
 *     </DevoraProvider>
 *   );
 * }
 *
 * function YourApp() {
 *   const { isImpersonating, scope } = useDevoraImpersonation();
 *
 *   return (
 *     <div>
 *       {isImpersonating && <p>Viewing as user (scope: {scope})</p>}
 *     </div>
 *   );
 * }
 * ```
 *
 * @packageDocumentation
 * @module @devorash/react
 */

// Context and Provider
export {
	DevoraProvider,
	useDevoraContext,
	useDevoraRemainingMs,
	hasDevoraPayload,
} from "./context.js"
export type { DevoraContextValue, DevoraProviderProps } from "./context.js"

// Hooks
export {
	useDevoraImpersonation,
	useDevoraReady,
	useDevoraAuth,
	useDevoraScope,
	useDevoraLogger,
	useDevoraSession,
	useDevoraError,
} from "./hooks.js"

// Components
export { ImpersonationBanner, ReadOnlyGuard, WriteProtected } from "./components.js"
export type {
	ImpersonationBannerProps,
	ReadOnlyGuardProps,
	WriteProtectedProps,
} from "./components.js"

// Recording privacy components
export { DevoraMask, DevoraRegion, DevoraBlock } from "./privacy.js"
export type { PrivacyWrapperProps, PrivacyRegionProps } from "./privacy.js"

// Re-export types from core
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
