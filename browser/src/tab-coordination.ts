/**
 * Same-origin tab coordination for the browser SDK.
 *
 * Two channels, both carrying only non-secret coordination messages:
 * - `devora:tabs` — tab-reference claims, so a cloned browsing context (Chrome
 *   "Duplicate", `_blank` without `noopener`) that inherited another tab's
 *   sessionStorage gets a fresh reference instead of sharing a recording track.
 * - `devora:session:<id>` — lifecycle notices (ended, expired, revoked,
 *   replaced, policy changed) so sibling tabs react immediately instead of on
 *   the next validation poll. Backend validation remains authoritative.
 *
 * Capability tokens and customer identity never travel on either channel.
 */

const TAB_ID_KEY = "__devora_recording_tab_id_v1"
const TABS_CHANNEL = "devora:tabs"
const CLAIM_WAIT_MS = 120

export type SessionNotice =
	| { type: "ended"; reason: string }
	| { type: "expired" }
	| { type: "revoked" }
	| { type: "replaced" }
	| { type: "policy_changed" }

type TabsMessage =
	| { type: "claim"; tabRef: string; instanceId: string }
	| { type: "claimed"; tabRef: string; instanceId: string }

function createRuntimeId(prefix: string): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return `devora_${prefix}_${crypto.randomUUID()}`
	}
	return `devora_${prefix}_${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function readStoredTabRef(): string | null {
	try {
		if (typeof sessionStorage === "undefined") return null
		const value = sessionStorage.getItem(TAB_ID_KEY)
		return value && /^[A-Za-z0-9_-]{4,96}$/.test(value) ? value : null
	} catch {
		return null
	}
}

function writeStoredTabRef(tabRef: string): void {
	try {
		if (typeof sessionStorage !== "undefined") sessionStorage.setItem(TAB_ID_KEY, tabRef)
	} catch {
		// Storage unavailable: the reference lives for this runtime only.
	}
}

function hasBroadcastChannel(): boolean {
	return typeof BroadcastChannel !== "undefined"
}

export class TabCoordinator {
	private readonly instanceId = createRuntimeId("instance")
	private tabRef: string
	private tabsChannel: BroadcastChannel | null = null
	private sessionChannel: BroadcastChannel | null = null
	private sessionListeners = new Set<(notice: SessionNotice) => void>()
	/**
	 * Only an instance that completed its own claim defends the reference.
	 * Frameworks (React StrictMode, hot reload) construct SDK instances that are
	 * discarded without ever initialising; if those answered claims, a reload
	 * that reads the stored reference would wrongly regenerate it and split one
	 * browser tab into several recording tracks.
	 */
	private claimed = false
	private generation = 0
	private claimTask: Promise<string> | null = null

	constructor(options: { initialTabRef?: string } = {}) {
		this.tabRef = options.initialTabRef ?? readStoredTabRef() ?? createRuntimeId("tab")
	}

	/** Lazily open the claims channel; an unused instance opens nothing. */
	private tabs(): BroadcastChannel | null {
		if (this.tabsChannel || !hasBroadcastChannel()) return this.tabsChannel
		this.tabsChannel = new BroadcastChannel(TABS_CHANNEL)
		this.tabsChannel.onmessage = (event: MessageEvent<TabsMessage>) => {
			const message = event.data
			if (!message || typeof message !== "object") return
			if (
				this.claimed &&
				message.type === "claim" &&
				message.tabRef === this.tabRef &&
				message.instanceId !== this.instanceId
			) {
				// Another live context claims our reference: tell it to regenerate.
				this.tabsChannel?.postMessage({
					type: "claimed",
					tabRef: this.tabRef,
					instanceId: this.instanceId,
				} satisfies TabsMessage)
			}
		}
		return this.tabsChannel
	}

	/** The (possibly regenerated) tab reference for this browsing context. */
	getTabRef(): string {
		return this.tabRef
	}

	/**
	 * Announce this tab's reference and regenerate it when a live sibling
	 * already owns it. Resolves with the final reference.
	 */
	async claimTabRef(): Promise<string> {
		if (this.claimed) return this.tabRef
		if (this.claimTask) return this.claimTask
		const task = this.claim(this.generation)
		this.claimTask = task
		try {
			return await task
		} finally {
			if (this.claimTask === task) this.claimTask = null
		}
	}

	private async claim(generation: number): Promise<string> {
		writeStoredTabRef(this.tabRef)
		const channel = this.tabs()
		if (!channel) {
			this.claimed = true
			return this.tabRef
		}
		for (let attempt = 0; attempt < 3; attempt++) {
			const collided = await new Promise<boolean>((resolve) => {
				const candidate = this.tabRef
				const handler = (event: MessageEvent<TabsMessage>) => {
					const message = event.data
					if (
						message?.type === "claimed" &&
						message.tabRef === candidate &&
						message.instanceId !== this.instanceId
					)
						finish(true)
				}
				const finish = (value: boolean) => {
					channel.removeEventListener("message", handler)
					clearTimeout(timer)
					resolve(value)
				}
				channel.addEventListener("message", handler)
				const timer = setTimeout(() => finish(false), CLAIM_WAIT_MS)
				channel.postMessage({
					type: "claim",
					tabRef: candidate,
					instanceId: this.instanceId,
				} satisfies TabsMessage)
			})
			if (generation !== this.generation) return this.tabRef
			if (!collided) break
			this.tabRef = createRuntimeId("tab")
			writeStoredTabRef(this.tabRef)
		}
		this.claimed = true
		return this.tabRef
	}

	/** Join the lifecycle channel for a session. */
	joinSession(sessionId: string): void {
		this.leaveSession()
		if (!hasBroadcastChannel()) return
		this.sessionChannel = new BroadcastChannel(`devora:session:${sessionId}`)
		this.sessionChannel.onmessage = (event: MessageEvent<SessionNotice>) => {
			const notice = event.data
			if (!notice || typeof notice !== "object" || typeof notice.type !== "string") return
			for (const listener of this.sessionListeners) listener(notice)
		}
	}

	onSessionNotice(listener: (notice: SessionNotice) => void): () => void {
		this.sessionListeners.add(listener)
		return () => this.sessionListeners.delete(listener)
	}

	/** Tell sibling tabs about a lifecycle change. Never includes secrets. */
	broadcast(notice: SessionNotice): void {
		try {
			this.sessionChannel?.postMessage(notice)
		} catch {
			// Channel closed or unavailable.
		}
	}

	leaveSession(): void {
		this.sessionChannel?.close()
		this.sessionChannel = null
	}

	destroy(): void {
		this.generation++
		this.claimTask = null
		this.leaveSession()
		this.tabsChannel?.close()
		this.tabsChannel = null
		this.claimed = false
		this.sessionListeners.clear()
	}
}
