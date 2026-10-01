/**
 * Minimal presence signal for idle-timeout enforcement.
 *
 * Separate from the activity timeline (ActivityLogger): it carries no page
 * content or event detail -- just "input happened just now" -- so it is not
 * gated by the project's activity-capture policy, unlike the timeline.
 *
 * It only fires in response to genuine input events (mousemove, keydown,
 * scroll, click, touchstart), heavily debounced, and never on a timer. A
 * blind timer would keep an abandoned tab "active" forever and defeat idle
 * timeout entirely -- that is exactly the trap this module avoids.
 *
 * @module @devorash/browser
 */

import { FRONTEND_HEADERS, createLogger, type Logger } from "@devorash/core"

export interface PresenceHeartbeatOptions {
	apiUrl: string
	apiKey: string
	sessionId: string
	devoraSessionToken: string
	debug?: boolean
	/** The server refused the heartbeat (401/409): the session may have ended. */
	onRejected?: (status: number) => void
}

const INTERACTION_EVENTS = ["mousemove", "keydown", "scroll", "click", "touchstart"] as const

// Well under any realistic idle timeout (server minimum is 60s) so a session
// stays alive through genuine, sparse interaction without hammering the API.
const HEARTBEAT_MIN_INTERVAL_MS = 20_000

export class PresenceHeartbeat {
	private readonly options: PresenceHeartbeatOptions
	private readonly logger: Logger
	private running = false
	private lastSentAt = 0
	private inFlight: Promise<void> | null = null
	private listener: (() => void) | null = null

	constructor(options: PresenceHeartbeatOptions) {
		this.options = options
		this.logger = createLogger("Devora Presence", options.debug)
	}

	start(): void {
		if (
			this.running ||
			typeof window === "undefined" ||
			typeof window.addEventListener !== "function"
		)
			return
		this.running = true
		this.listener = () => this.onInteraction()
		for (const type of INTERACTION_EVENTS)
			window.addEventListener(type, this.listener, { capture: true, passive: true })
	}

	stop(): void {
		this.running = false
		if (this.listener) {
			if (typeof window !== "undefined" && typeof window.removeEventListener === "function")
				for (const type of INTERACTION_EVENTS)
					window.removeEventListener(type, this.listener, { capture: true })
			this.listener = null
		}
	}

	isRunning(): boolean {
		return this.running
	}

	private onInteraction(): void {
		if (!this.running || this.inFlight) return
		const now = Date.now()
		if (now - this.lastSentAt < HEARTBEAT_MIN_INTERVAL_MS) return
		// Set before the request resolves: throttling must hold regardless of
		// network latency, or a burst of events during a slow request would
		// queue up a burst of sends the moment it finishes.
		this.lastSentAt = now
		this.inFlight = this.send().finally(() => {
			this.inFlight = null
		})
	}

	private async send(): Promise<void> {
		try {
			const response = await fetch(`${this.options.apiUrl}/api/sdk/session-presence`, {
				method: "POST",
				redirect: "error" as const,
				headers: {
					"Content-Type": "application/json",
					[FRONTEND_HEADERS.API_KEY]: this.options.apiKey,
					[FRONTEND_HEADERS.SESSION_TOKEN]: this.options.devoraSessionToken,
				},
				body: JSON.stringify({ sessionId: this.options.sessionId }),
				signal: AbortSignal.timeout(5_000),
			})
			if (!response.ok) {
				this.logger.warn("Presence heartbeat rejected", { status: response.status })
				if (response.status === 401 || response.status === 409)
					this.options.onRejected?.(response.status)
			}
		} catch (error) {
			// Best effort: a lost heartbeat is not fatal, the next interaction retries.
			this.logger.warn("Presence heartbeat failed (network):", error)
		}
	}
}
