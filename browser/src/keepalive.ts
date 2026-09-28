/** Shared across SDK instances and duplicate bundles in the same document. */
const BUDGET_KEY = Symbol.for("devora.keepalive.bytes.v1")
type BudgetHost = typeof globalThis & { [BUDGET_KEY]?: { pending: number } }
const host = globalThis as BudgetHost
const budget = (host[BUDGET_KEY] ??= { pending: 0 })

// Stay below the browser's 64 KiB aggregate limit. Leave room for host traffic,
// and reserve part of our own allowance for an incomplete-capture notice.
const LIMITS = { recording: 48_000, activity: 52_000, notice: 56_000, revocation: 60_000 } as const
export type KeepaliveKind = keyof typeof LIMITS

export function availableKeepaliveBytes(kind: KeepaliveKind): number {
	return Math.max(0, LIMITS[kind] - budget.pending)
}

/** Null means no request was sent. A returned promise still requires acknowledgement. */
export function tryKeepaliveFetch(
	url: string,
	init: Omit<RequestInit, "body" | "keepalive"> & { body: string },
	kind: KeepaliveKind
): Promise<Response> | null {
	const bytes = new TextEncoder().encode(init.body).byteLength
	if (bytes > availableKeepaliveBytes(kind)) return null
	budget.pending += bytes
	try {
		return fetch(url, { ...init, keepalive: true, redirect: "error" }).finally(() => {
			budget.pending -= bytes
		})
	} catch (error) {
		budget.pending -= bytes
		return Promise.reject(error)
	}
}
