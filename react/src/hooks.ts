/**
 * React hooks for Devora SDK
 * @module @devorash/react
 */

import { useDevoraContext, useDevoraRemainingMs } from "./context.js"
import type { ImpersonationScope } from "@devorash/core"

/**
 * Hook to get initialization error (if any)
 */
export function useDevoraError(): Error | null {
	const context = useDevoraContext()
	return context.initError
}

/**
 * Hook to get impersonation state with enriched user info
 */
export function useDevoraImpersonation() {
	const context = useDevoraContext()
	const remainingMs = useDevoraRemainingMs()

	return {
		/** Whether an impersonation session is active */
		isImpersonating: context.isImpersonating,
		/** Current access scope */
		scope: context.scope,
		/** Session ID */
		sessionId: context.session?.sessionId ?? null,
		/** User being impersonated (deprecated, use targetUser.id) */
		userId: context.session?.userId ?? null,
		/** Session expiration time (ISO timestamp) */
		expiresAt: context.session?.expiresAt ?? null,
		/** Target user being impersonated */
		targetUser: context.session?.targetUser ?? null,
		/** Agent performing the impersonation */
		impersonator: context.session?.impersonator ?? null,
		/** Remaining time in milliseconds (from smart timer) */
		remainingMs,
		/** End the current session */
		endSession: context.endSession,
	}
}

/**
 * Hook to check if SDK is initialized
 */
export function useDevoraReady(): boolean {
	const context = useDevoraContext()
	return context.isInitialized
}

/**
 * Hook that combines SDK ready state with payload detection.
 *
 * Use this hook in protected routes to properly handle impersonation:
 * - If a payload was detected on load, wait for SDK to initialize
 * - Returns isReady: true when it's safe to check authentication
 *
 * @example
 * ```tsx
 * function ProtectedRoute({ children }) {
 *   const { isReady, isImpersonating } = useDevoraAuth();
 *   const { isAuthenticated, isLoading } = useAuth();
 *
 *   // Wait for Devora SDK if payload was detected
 *   if (!isReady) {
 *     return <LoadingSpinner />;
 *   }
 *
 *   // Normal auth check
 *   if (isLoading) return <LoadingSpinner />;
 *   if (!isAuthenticated) return <Navigate to="/login" />;
 *
 *   return children;
 * }
 * ```
 */
export function useDevoraAuth() {
	const context = useDevoraContext()

	// If a payload was detected on load, we need to wait for SDK to initialize
	// before checking authentication (to avoid redirect to login)
	const isReady = context.hadPayloadOnLoad ? context.isInitialized : true

	return {
		/** Whether it's safe to proceed with auth checks */
		isReady,
		/** Whether SDK is initialized */
		isInitialized: context.isInitialized,
		/** Whether an impersonation session is active */
		isImpersonating: context.isImpersonating,
		/** Whether a payload was detected on initial page load */
		hadPayloadOnLoad: context.hadPayloadOnLoad,
		/** Current access scope */
		scope: context.scope,
		/** End the current session */
		endSession: context.endSession,
	}
}

/**
 * Hook to check if action is allowed based on scope
 */
export function useDevoraScope(): {
	scope: ImpersonationScope | null
	canWrite: boolean
	isReadOnly: boolean
} {
	const context = useDevoraContext()

	return {
		scope: context.scope,
		canWrite: context.scope === "write" || !context.isImpersonating,
		isReadOnly: context.isImpersonating && context.scope === "read",
	}
}

/**
 * Hook to log actions
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
		logFormSubmit: (formId: string, metadata?: Record<string, unknown>) => {
			context.logAction({
				type: "form_submit",
				action: "submit",
				metadata: { formId, ...metadata },
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
		...context.session,
		isInitialized: context.isInitialized,
	}
}
