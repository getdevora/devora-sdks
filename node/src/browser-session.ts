/**
 * Browser-session bridge (server side).
 *
 * A browser tab that inherits the customer's own authentication (cookie or
 * stored token) but not Devora's per-tab capability asks the customer backend
 * to restore it. The backend, having authenticated the request through its
 * normal middleware, resolves the impersonation context and — only when the
 * customer session is impersonated — asks Devora for a one-time resume code.
 * Ordinary customer traffic never contacts Devora here.
 */
import { BROWSER_SESSION_BRIDGE, type SessionBridgeResult } from "@devorash/core"
import type { DevoraBackendSDK } from "./types.js"
import { validateImpersonationContext, type ImpersonationContext } from "./middleware.js"

export interface ResolveBrowserSessionInput {
	/** Trusted impersonation context for the authenticated customer session, or null. */
	context: ImpersonationContext | null | undefined
	/** Non-secret tab reference supplied by the browser SDK. */
	tabRef: unknown
	/** Exact browser origin of the request (from the Origin header). */
	origin: string | null | undefined
	/**
	 * Origins allowed to use the bridge. A request that carries an Origin header is
	 * rejected unless this is set and includes it — there is no usable default origin
	 * to compare against in a backend SDK, so an unconfigured allowlist fails closed.
	 */
	allowedOrigins?: string[]
}

/** Framework-agnostic bridge decision. Adapters wrap this in a route. */
export async function resolveBrowserSession(
	sdk: DevoraBackendSDK,
	input: ResolveBrowserSessionInput
): Promise<{ status: number; body: SessionBridgeResult | { error: string } }> {
	if (
		typeof input.tabRef !== "string" ||
		!BROWSER_SESSION_BRIDGE.TAB_REF_PATTERN.test(input.tabRef)
	)
		return { status: 400, body: { error: "Invalid tab reference" } }
	const context = input.context
	if (context === null || context === undefined || context.isImpersonation === false)
		return { status: 200, body: { status: "none" } }
	// Origin only matters once we're about to mint a resume code for a real
	// impersonation session; ordinary traffic through this bridge is unaffected.
	// An Origin header must be listed in allowedOrigins (unconfigured fails
	// closed). Devora binds every resume code to the origin that will redeem it,
	// so a request without an Origin header cannot use one and gets none.
	if (input.origin && (!input.allowedOrigins || !input.allowedOrigins.includes(input.origin)))
		return { status: 403, body: { error: "Invalid request origin" } }
	// The same strict validation as the guard: malformed or expired contexts
	// never mint a resume code.
	if (!input.origin || !validateImpersonationContext(context).valid)
		return { status: 200, body: { status: "blocked", reason: "session_invalid" } }
	const result = await sdk.createBrowserResumeCode({
		sessionId: context.sessionId!,
		tabRef: input.tabRef,
		origin: input.origin,
	})
	if (result === null)
		return { status: 200, body: { status: "blocked", reason: "control_plane_unavailable" } }
	if ("error" in result)
		return { status: 200, body: { status: "blocked", reason: "session_invalid" } }
	return { status: 200, body: { status: "resume", code: result.code } }
}

/** Response headers every bridge route must send. */
export const BROWSER_SESSION_RESPONSE_HEADERS = {
	"Cache-Control": "private, no-store",
	"Content-Type": "application/json",
} as const
