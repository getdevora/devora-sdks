/**
 * Lightweight activity logger.
 *
 * Batches structured activity events (page views, clicks, errors, custom
 * actions) to Devora independently of session recording. These rows power the
 * session activity timeline in the Devora dashboard and work even when
 * recording is disabled. Click descriptions respect the active masking rules
 * so the timeline can never leak content the replay masks.
 *
 * @module @devorash/browser
 */

import { describeCapturedError, type NormalizedCustomAction } from "./capture-privacy.js"
import {
	FRONTEND_HEADERS,
	SDK_DEFAULTS,
	createLogger,
	readBoundedBody,
	type Logger,
} from "@devorash/core"
import { describeElement, sanitizeCaptureUrl, type ResolvedMasking } from "./masking.js"
import { withDeadline } from "./deadline.js"
import { tryKeepaliveFetch, availableKeepaliveBytes } from "./keepalive.js"

/** Wire shape for a single activity event. */
export interface ActivityEvent {
	type: "page_view" | "click" | "error" | "custom"
	description: string
	context?: {
		url?: string
		elementType?: string
		elementText?: string
		elementRole?: string
		errorMessage?: string
		action?: string
		metadata?: Record<string, unknown>
	}
	/** Client timestamp (Unix ms). */
	timestamp: number
}

export interface ActivityLoggerOptions {
	apiUrl: string
	apiKey: string
	sessionId: string
	devoraSessionToken: string
	/** Logical tab id shared with the session recorder for player sync. */
	tabId?: string
	masking: ResolvedMasking
	/** Dashboard flag: capture uncaught errors and unhandled rejections. */
	captureErrors: boolean
	/** Dashboard flag: accept `logAction` custom events. */
	captureCustomEvents: boolean
	debug?: boolean
	onIncomplete?: (reason: string) => void
	/** Devora stored a batch after the session ended: end the session locally now. */
	onSessionEnded?: () => void
}

const MAX_DESCRIPTION_LENGTH = 300
const MAX_EVENTS_PER_FLUSH = 20

export class ActivityLogger {
	private readonly options: ActivityLoggerOptions
	private readonly logger: Logger
	private queue: ActivityEvent[] = []
	private flushTimer: ReturnType<typeof setInterval> | null = null
	private running = false
	private lastPath: string | null = null
	private upload: Promise<void> | null = null
	private pendingBatch: { id: string; count: number; dropped: number; body: string } | null = null
	private dropped = 0
	private failureCount = 0
	private retryAt = 0
	private deliveryStopped = false
	private reported = new Set<string>()

	private clickListener: ((event: MouseEvent) => void) | null = null
	private errorListener: ((event: ErrorEvent) => void) | null = null
	private rejectionListener: ((event: PromiseRejectionEvent) => void) | null = null
	private popstateListener: (() => void) | null = null
	private pagehideListener: (() => void) | null = null
	private originalPushState: History["pushState"] | null = null
	private originalReplaceState: History["replaceState"] | null = null
	// The wrapper functions we installed, so restore can check we're still the
	// current patcher before overwriting history.pushState/replaceState — the
	// session recorder may have patched on top of us since (or self-stopped
	// and restored on top of us), and blindly overwriting would either discard
	// its wrapper outright or leave it pointing at an original already nulled.
	private patchedPushState: History["pushState"] | null = null
	private patchedReplaceState: History["replaceState"] | null = null

	constructor(options: ActivityLoggerOptions) {
		this.options = options
		this.logger = createLogger("Devora Activity", options.debug)
	}

	start(): void {
		if (this.running || typeof window === "undefined") return
		this.running = true

		// Navigation and clicks are always part of the activity timeline; only the
		// error and custom channels are switchable, and only from the dashboard.
		this.recordPageView(window.location.href)
		this.patchNavigation()
		this.clickListener = (event: MouseEvent) => this.handleClick(event)
		document.addEventListener("click", this.clickListener, { capture: true, passive: true })
		if (this.options.captureErrors) {
			// Error text often carries user data or tokens: under the full profile
			// only the error category is recorded, otherwise a redacted message.
			this.errorListener = (event: ErrorEvent) => {
				const error = event.error as { name?: string } | undefined
				const text = describeCapturedError(error?.name, event.message, this.options.masking)
				this.enqueue({
					type: "error",
					description: truncate(`Error: ${text}`),
					context: { errorMessage: truncate(text), url: this.currentPath() },
					timestamp: Date.now(),
				})
			}
			this.rejectionListener = (event: PromiseRejectionEvent) => {
				const reason = event.reason as { name?: string; message?: string } | undefined
				const text = describeCapturedError(
					reason instanceof Error ? reason.name : undefined,
					reason instanceof Error ? reason.message : String(event.reason ?? "unknown"),
					this.options.masking
				)
				this.enqueue({
					type: "error",
					description: truncate(`Unhandled rejection: ${text}`),
					context: { errorMessage: truncate(text), url: this.currentPath() },
					timestamp: Date.now(),
				})
			}
			window.addEventListener("error", this.errorListener)
			window.addEventListener("unhandledrejection", this.rejectionListener)
		}

		this.pagehideListener = () => this.flush(true)
		window.addEventListener("pagehide", this.pagehideListener)

		this.flushTimer = setInterval(() => {
			void this.flush()
		}, SDK_DEFAULTS.LOG_FLUSH_INTERVAL)

		this.logger.log("Activity logging started", { sessionId: this.options.sessionId })
	}

	/** Stop listeners and flush remaining events (best effort). */
	async stop(): Promise<void> {
		this.retireCapture()
		await this.flush()
		if (this.queue.length || this.dropped) this.incomplete("activity_delivery_uncertain")
	}

	private retireCapture(): void {
		this.running = false

		if (this.flushTimer) {
			clearInterval(this.flushTimer)
			this.flushTimer = null
		}
		if (this.clickListener) {
			document.removeEventListener("click", this.clickListener, { capture: true })
			this.clickListener = null
		}
		if (this.errorListener) window.removeEventListener("error", this.errorListener)
		if (this.rejectionListener)
			window.removeEventListener("unhandledrejection", this.rejectionListener)
		if (this.pagehideListener) window.removeEventListener("pagehide", this.pagehideListener)
		this.errorListener = null
		this.rejectionListener = null
		this.pagehideListener = null
		this.restoreNavigation()
	}

	/** Whether the dashboard policy accepts customer-defined actions. */
	acceptsCustomEvents(): boolean {
		return this.options.captureCustomEvents
	}

	/** Record a customer-defined action (from sdk.logAction). Dropped unless enabled by policy. */
	logCustomAction(event: NormalizedCustomAction): void {
		if (!this.options.captureCustomEvents) {
			this.logger.log("Custom event dropped: custom events are disabled by the project policy")
			return
		}
		// Normalized once by the SDK, identically for the recording.
		this.enqueue({
			type: "custom",
			description: truncate(event.action ? `Action: ${event.action}` : "Custom action"),
			context: {
				action: truncate(event.action),
				url: event.path ?? this.currentPath(),
				metadata: event.metadata,
			},
			timestamp: Date.now(),
		})
	}

	isRunning(): boolean {
		return this.running
	}

	private currentPath(): string {
		return typeof window !== "undefined"
			? sanitizeCaptureUrl(window.location.href, this.options.masking)
			: "/unknown"
	}

	private recordPageView(href: string): void {
		const path = sanitizeCaptureUrl(href, this.options.masking)
		if (path === this.lastPath) return
		this.lastPath = path
		this.enqueue({
			type: "page_view",
			description: truncate(`Navigated to ${path}`),
			context: { url: path },
			timestamp: Date.now(),
		})
	}

	private handleClick(event: MouseEvent): void {
		const target = event.target
		if (!(target instanceof Element)) return
		const descriptor = describeElement(target, this.options.masking)
		this.enqueue({
			type: "click",
			description: truncate(descriptor.description),
			context: {
				url: this.currentPath(),
				elementType: descriptor.elementType,
				elementText: descriptor.elementText,
				elementRole: descriptor.elementRole,
			},
			timestamp: Date.now(),
		})
	}

	private patchNavigation(): void {
		const push = history.pushState.bind(history)
		const replace = history.replaceState.bind(history)
		this.originalPushState = push
		this.originalReplaceState = replace
		const wrappedPush: History["pushState"] = (...args) => {
			push(...args)
			if (this.running && this.patchedPushState === wrappedPush)
				this.recordPageView(window.location.href)
		}
		const wrappedReplace: History["replaceState"] = (...args) => {
			replace(...args)
			if (this.running && this.patchedReplaceState === wrappedReplace)
				this.recordPageView(window.location.href)
		}
		this.patchedPushState = history.pushState = wrappedPush
		this.patchedReplaceState = history.replaceState = wrappedReplace
		this.popstateListener = () => this.recordPageView(window.location.href)
		window.addEventListener("popstate", this.popstateListener)
		window.addEventListener("hashchange", this.popstateListener)
	}

	/**
	 * Only touches history.pushState/replaceState if it's still exactly our
	 * own wrapper — if something else (e.g. the session recorder) patched on
	 * top of us since, restoring would either discard that wrapper or hand it
	 * a now-null original to call, so we leave it alone and let that
	 * patcher's own restore run instead.
	 */
	private restoreNavigation(): void {
		if (this.originalPushState) {
			if (history.pushState === this.patchedPushState) history.pushState = this.originalPushState
		}
		if (this.originalReplaceState) {
			if (history.replaceState === this.patchedReplaceState)
				history.replaceState = this.originalReplaceState
		}
		this.originalPushState = null
		this.originalReplaceState = null
		this.patchedPushState = null
		this.patchedReplaceState = null
		if (this.popstateListener) {
			window.removeEventListener("popstate", this.popstateListener)
			window.removeEventListener("hashchange", this.popstateListener)
			this.popstateListener = null
		}
	}

	private incomplete(reason: string): void {
		if (this.reported.has(reason)) return
		this.reported.add(reason)
		this.logger.warn("Activity delivery is incomplete", { reason })
		try {
			this.options.onIncomplete?.(reason)
		} catch {
			/* Reporting cannot break the host page. */
		}
	}

	private enqueue(event: ActivityEvent): void {
		if (!this.running || this.deliveryStopped) return
		// Keep the unacknowledged prefix unchanged, including its batch identity.
		if (this.queue.length >= SDK_DEFAULTS.MAX_LOG_QUEUE_SIZE) {
			this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + 1)
			this.incomplete("activity_budget_exceeded")
			return
		}
		this.queue.push(event)
		if (this.queue.length >= SDK_DEFAULTS.LOG_BATCH_SIZE) void this.flush()
	}

	/** Only acknowledged events leave the queue. Retries reuse the exact batch. */
	async flush(keepalive = false): Promise<void> {
		if (this.upload) {
			if (keepalive) this.incomplete("activity_delivery_uncertain")
			return this.upload
		}
		if (this.deliveryStopped || (!keepalive && Date.now() < this.retryAt)) return
		if (!this.queue.length && !this.dropped) return
		// Assign before the first batch starts so simultaneous enqueue/pagehide/
		// timer calls share one upload, including a synchronously rejecting fetch.
		this.upload = Promise.resolve()
			.then(async () => {
				for (let attempt = 0; attempt < (keepalive ? 1 : 5); attempt++) {
					if (!this.queue.length && !this.dropped) break
					if (!(await this.deliverBatch(keepalive))) break
				}
			})
			.finally(() => {
				this.upload = null
			})
		await this.upload
		if (keepalive && (this.queue.length || this.dropped))
			this.incomplete("activity_delivery_uncertain")
	}

	private async deliverBatch(keepalive: boolean): Promise<boolean> {
		const maxBytes = keepalive ? Math.min(8_000, availableKeepaliveBytes("activity")) : 100_000
		if (!this.pendingBatch) {
			const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
				byte.toString(16).padStart(2, "0")
			).join("")
			const dropped = Math.min(1_000_000, this.dropped)
			let count = Math.min(this.queue.length, MAX_EVENTS_PER_FLUSH)
			let body: string
			for (;;) {
				body = JSON.stringify({
					batchId: id,
					tabId: this.options.tabId,
					droppedEvents: dropped,
					events: this.queue.slice(0, count),
				})
				if (new TextEncoder().encode(body).byteLength <= maxBytes) break
				if (count === 0) return false
				count--
			}
			if (!count && !dropped) return false
			this.pendingBatch = { id, count, dropped, body }
		}
		const batch = this.pendingBatch
		// Never split or re-identify a previously attempted batch for unload:
		// the server may already have committed it while its response was lost.
		if (new TextEncoder().encode(batch.body).byteLength > maxBytes) return false
		const controller = new AbortController()
		try {
			const init = {
				method: "POST",
				redirect: "error" as const,
				headers: {
					"Content-Type": "application/json",
					[FRONTEND_HEADERS.API_KEY]: this.options.apiKey,
					[FRONTEND_HEADERS.SESSION]: this.options.sessionId,
					[FRONTEND_HEADERS.SESSION_TOKEN]: this.options.devoraSessionToken,
				},
				body: batch.body,
				signal: controller.signal,
			}
			const pending = keepalive
				? tryKeepaliveFetch(`${this.options.apiUrl}/api/sdk/logs`, init, "activity")
				: fetch(`${this.options.apiUrl}/api/sdk/logs`, init)
			if (!pending) return false
			await withDeadline(
				async () => {
					const response = await pending
					if (!response.ok) {
						void response.body?.cancel().catch(() => {})
						if ([400, 401, 403, 409, 413].includes(response.status)) this.deliveryStopped = true
						throw new Error(`Activity log upload failed: ${response.status}`)
					}
					const acknowledgment = JSON.parse(await readBoundedBody(response, 4096))
					if (acknowledgment?.success !== true)
						throw new Error("Activity upload was not acknowledged")
					if (acknowledgment.sessionEnded === true) {
						try {
							this.options.onSessionEnded?.()
						} catch {
							/* An observer cannot affect delivery. */
						}
					}
				},
				10_000,
				() => controller.abort()
			)
			this.queue.splice(0, batch.count)
			this.dropped -= batch.dropped
			this.pendingBatch = null
			this.failureCount = 0
			this.retryAt = 0
			return true
		} catch (error) {
			this.failureCount++
			this.retryAt = Date.now() + Math.min(30_000, 1000 * 2 ** (this.failureCount - 1))
			// Bound even transports that ignore abort: at most three unresolved
			// attempts can survive locally before capture is retired with a notice.
			if (this.deliveryStopped || this.failureCount >= 3) {
				this.deliveryStopped = true
				this.retireCapture()
				this.incomplete("activity_delivery_failed")
			}
			if (keepalive) this.incomplete("activity_delivery_uncertain")
			this.logger.warn("Activity log upload error", { error })
			return false
		}
	}
}

function truncate(value: string, max = MAX_DESCRIPTION_LENGTH): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
