/**
 * Atomic replay protection shared by every application instance.
 *
 * `consume` must be an atomic insert-if-absent (for example Redis
 * `SET key 1 NX PXAT expiresAt`, or a unique-key database insert) and must
 * never evict an entry before `expiresAt`. A store that cannot guarantee this
 * must throw; the SDK then fails closed with a 503.
 */
export interface ReplayStore {
	/**
	 * Return true only for the first consumption of `requestId` within
	 * `namespace` before `expiresAt` (Unix milliseconds).
	 */
	consume(namespace: string, requestId: string, expiresAt: number): Promise<boolean>
}

/** Development-only implementation; production must supply a persistent store. */
export class InMemoryReplayStore implements ReplayStore {
	private readonly entries = new Map<string, number>()

	async consume(namespace: string, requestId: string, expiresAt: number): Promise<boolean> {
		if (!Number.isFinite(expiresAt)) throw new Error("Invalid replay expiry")
		const now = Date.now()
		for (const [id, expiry] of this.entries) if (expiry <= now) this.entries.delete(id)
		const key = `${namespace}\n${requestId}`
		if (this.entries.has(key)) return false
		this.entries.set(key, expiresAt)
		return true
	}
}
