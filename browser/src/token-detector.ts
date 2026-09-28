/**
 * One-time impersonation exchange, tab resume and session validation helpers.
 *
 * The per-tab capability token returned by these calls is held in memory by
 * the SDK only. Nothing capability-shaped is ever written to Web Storage,
 * cookies or the URL; a new tab restores through the customer backend bridge.
 */
import { BROWSER_SESSION_BRIDGE, FRONTEND_HEADERS, SDK_DEFAULTS, URL_PARAMS } from "@devorash/core"
import type { DecryptedPayload, ResumedSession } from "./types.js"

const EXCHANGE_CODE_PATTERN = /^[A-Za-z0-9_-]{40,128}$/
const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43,128}$/
const READY_MESSAGE = "devora:exchange-ready"
const VERIFIER_MESSAGE = "devora:exchange-verifier"

/** Only the Devora dashboard this SDK was built for (`DEVORA_SDK_DASHBOARD_ORIGIN`,
 * production by default). Never infer this trust from a URL parameter,
 * document.referrer, or the sender of the first message. Local dashboards are
 * accepted only by customer apps that are themselves running on loopback. */
function isTrustedDashboardOrigin(origin: string): boolean {
	if (origin === SDK_DEFAULTS.DASHBOARD_ORIGIN) return true
	const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"])
	if (!localHosts.has(window.location.hostname)) return false
	try {
		const url = new URL(origin)
		return (
			url.origin === origin &&
			localHosts.has(url.hostname) &&
			(url.protocol === "http:" || url.protocol === "https:")
		)
	} catch {
		return false
	}
}

/** Exchange state captured from the URL, then removed from it. */
let exchangeSeen = false
let capturedCode: string | null = null
let capturedVerifier: Promise<string | null> | null = null

/** Remove `devora_exchange=` from a fragment, keeping any hash-router state. */
function removeFromFragment(hash: string): { value: string | null; rest: string } {
	let first: string | null = null
	let rest = hash
	for (;;) {
		const removed = removeOneFromFragment(rest)
		if (removed.value === null) return { value: first, rest }
		if (first === null) first = removed.value
		rest = removed.rest
	}
}

function removeOneFromFragment(hash: string): { value: string | null; rest: string } {
	const match = new RegExp(`(^#|[?&])${URL_PARAMS.EXCHANGE_CODE}=([^&]*)`).exec(hash)
	if (!match) return { value: null, rest: hash }
	const before = hash.slice(0, match.index)
	const after = hash.slice(match.index + match[0].length).replace(/^&/, "")
	const rest =
		match[1] === "#"
			? after
				? `#${after}`
				: ""
			: match[1] === "?"
				? `${before}${after ? `?${after}` : ""}`
				: `${before}${after ? `&${after}` : ""}`
	return { value: match[2] ?? "", rest }
}

/**
 * Read the one-time exchange code from the URL fragment and scrub it at once.
 * Runs when this module loads, before a framework renders, so routers and
 * analytics never see the code. A legacy query-string code is scrubbed but
 * never redeemed: fragments are never sent to servers, query strings are.
 */
function captureExchangeFromURL(): void {
	if (typeof window === "undefined" || capturedCode) return
	try {
		const url = new URL(window.location.href)
		const fromFragment = removeFromFragment(url.hash)
		const inQuery = url.searchParams.has(URL_PARAMS.EXCHANGE_CODE)
		if (fromFragment.value === null && !inQuery) return
		exchangeSeen = true
		url.searchParams.delete(URL_PARAMS.EXCHANGE_CODE)
		url.hash = fromFragment.rest
		window.history.replaceState(window.history.state, "", url.toString())
		if (fromFragment.value && EXCHANGE_CODE_PATTERN.test(fromFragment.value)) {
			capturedCode = fromFragment.value
			capturedVerifier = requestExchangeVerifier()
		} else {
			// No redeemable code, so no handshake: never keep a live reference
			// to the dashboard tab that opened this one.
			severOpener()
		}
	} catch {
		// URL access is best effort; callers must never log the code.
	}
}
captureExchangeFromURL()

function severOpener(): void {
	try {
		window.opener = null
	} catch {
		// Some embedders make opener read-only; nothing else to do.
	}
}

/**
 * Ask the Devora dashboard tab that opened this one for the exchange verifier.
 * The dashboard answers only its own popup, at this page's origin. A link that
 * was copied, forwarded or opened any other way has no opener, so it resolves
 * to null and cannot be redeemed. Clear the public opener immediately; only
 * this closure keeps the reference for the origin-checked handshake. This
 * does not sandbox customer scripts that ran before the SDK loaded.
 */
export function requestExchangeVerifier(timeoutMs = 10_000): Promise<string | null> {
	if (typeof window === "undefined" || !window.opener) return Promise.resolve(null)
	const opener = window.opener as Window
	severOpener()
	return new Promise((resolve) => {
		const finish = (verifier: string | null) => {
			clearTimeout(timer)
			window.removeEventListener("message", onMessage)
			severOpener()
			resolve(verifier)
		}
		const onMessage = (event: MessageEvent) => {
			if (event.source !== opener || !isTrustedDashboardOrigin(event.origin)) return
			const data = event.data as { type?: unknown; verifier?: unknown } | null
			if (data?.type !== VERIFIER_MESSAGE) return
			finish(
				typeof data.verifier === "string" && VERIFIER_PATTERN.test(data.verifier)
					? data.verifier
					: null
			)
		}
		const timer = setTimeout(() => finish(null), timeoutMs)
		window.addEventListener("message", onMessage)
		try {
			// Carries no secret; the dashboard checks the source and origin.
			opener.postMessage({ type: READY_MESSAGE }, "*")
		} catch {
			finish(null)
		}
	})
}

/** The captured exchange code, if the page was opened with one. */
export function getExchangeCodeFromURL(): string | null {
	captureExchangeFromURL()
	return capturedCode
}

/** The verifier handshake started for the captured code. */
export function getExchangeVerifier(): Promise<string | null> {
	captureExchangeFromURL()
	return capturedVerifier ?? Promise.resolve(null)
}

/** Whether the page was opened with an exchange parameter (valid or not). */
export function hasExchangeParameterInURL(): boolean {
	captureExchangeFromURL()
	return exchangeSeen
}

const validScope = (value: unknown): value is "read" | "write" =>
	value === "read" || value === "write"

/** Redeem the one-time exchange code for the first tab's payload and capability. */
export async function exchangePayload(
	code: string,
	verifier: string,
	tabRef: string,
	apiKey: string,
	apiUrl: string = SDK_DEFAULTS.API_URL
): Promise<DecryptedPayload | null> {
	try {
		const response = await fetch(`${apiUrl}/api/sdk/exchange`, {
			method: "POST",
			redirect: "error" as const,
			headers: {
				"Content-Type": "application/json",
				[FRONTEND_HEADERS.API_KEY]: apiKey,
			},
			body: JSON.stringify({ code, verifier, tabRef }),
			signal: AbortSignal.timeout(5000),
		})
		if (!response.ok) return null
		const result = (await response.json()) as { success?: boolean; data?: DecryptedPayload }
		const payload = result.data
		if (
			!result.success ||
			!payload?.token ||
			!payload.sessionId ||
			!payload.devoraSessionToken ||
			!validScope(payload.scope) ||
			!Number.isFinite(payload.expiresAt) ||
			payload.expiresAt <= Date.now()
		) {
			return null
		}
		return payload
	} catch {
		return null
	}
}

/**
 * Redeem a resume code (obtained by the customer backend) for this tab's own
 * capability and the authoritative session snapshot. Never returns the
 * customer authentication token.
 */
export async function resumeSession(
	code: string,
	tabRef: string,
	apiKey: string,
	apiUrl: string = SDK_DEFAULTS.API_URL
): Promise<ResumedSession | null> {
	try {
		const response = await fetch(`${apiUrl}${BROWSER_SESSION_BRIDGE.RESUME_ENDPOINT}`, {
			method: "POST",
			redirect: "error" as const,
			headers: {
				"Content-Type": "application/json",
				[FRONTEND_HEADERS.API_KEY]: apiKey,
			},
			body: JSON.stringify({ code, tabRef }),
			signal: AbortSignal.timeout(5000),
		})
		if (!response.ok) return null
		const result = (await response.json()) as { success?: boolean; data?: ResumedSession }
		const snapshot = result.data
		if (
			!result.success ||
			!snapshot?.sessionId ||
			!snapshot.devoraSessionToken ||
			!validScope(snapshot.scope) ||
			!Number.isFinite(snapshot.expiresAt) ||
			snapshot.expiresAt <= Date.now()
		) {
			return null
		}
		return snapshot
	} catch {
		return null
	}
}

/**
 * A definitive verdict ("valid"/"invalid") means the backend looked up the
 * session and rendered a real answer. "unknown" means the backend could not
 * be asked authoritatively (rate limited, erroring, or an unrecognized
 * response shape) — callers must not treat "unknown" as proof the session
 * ended, since a 429 from an unrelated caller sharing the same public client
 * key would otherwise be able to end every open session for that customer.
 */
export type SessionValidationResult =
	| { outcome: "valid"; scope: "read" | "write"; expiresAt?: number; remainingMs?: number }
	| { outcome: "invalid"; error?: string }
	| { outcome: "unknown" }

export async function validateStoredSession(
	sessionId: string,
	apiKey: string,
	devoraSessionToken: string,
	apiUrl: string = SDK_DEFAULTS.API_URL
): Promise<SessionValidationResult> {
	try {
		const response = await fetch(`${apiUrl}/api/sdk/validate-session`, {
			method: "POST",
			redirect: "error" as const,
			headers: {
				"Content-Type": "application/json",
				[FRONTEND_HEADERS.API_KEY]: apiKey,
				[FRONTEND_HEADERS.SESSION_TOKEN]: devoraSessionToken,
			},
			body: JSON.stringify({ sessionId }),
			signal: AbortSignal.timeout(5000),
		})
		if (response.ok) {
			const json = (await response.json()) as {
				success?: boolean
				data?: {
					valid: boolean
					scope: "read" | "write"
					expiresAt?: number
					remainingMs?: number
					error?: string
				}
			}
			if (!json.success || !json.data) return { outcome: "unknown" }
			return json.data.valid
				? {
						outcome: "valid",
						scope: json.data.scope,
						expiresAt: json.data.expiresAt,
						remainingMs: json.data.remainingMs,
					}
				: { outcome: "invalid", error: json.data.error }
		}
		// 401/404 are the backend definitively rejecting this session/grant
		// combination (revoked grant, wrong tab, unknown session). Everything
		// else — most importantly 429 and 5xx — is inconclusive: it says
		// nothing about whether the session is actually still valid.
		if (response.status === 401 || response.status === 404) {
			return { outcome: "invalid" }
		}
		return { outcome: "unknown" }
	} catch (error) {
		throw error instanceof Error ? error : new Error(String(error))
	}
}

/**
 * Mark the captured exchange as taken. The URL itself was already scrubbed
 * when the code was captured.
 */
export function cleanURL(): void {
	exchangeSeen = false
	capturedCode = null
	capturedVerifier = null
}
