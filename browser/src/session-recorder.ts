/**
 * Session recording using rrweb for impersonation sessions
 *
 * Features:
 * - Multi-tab support (each tab has its own track)
 * - Pause/resume events for visibility changes
 * - Navigation tracking
 * - Privacy controls (masking, blocking)
 *
 * @module @devorash/browser
 */

import { sanitizeConsoleArguments, type NormalizedCustomAction } from "./capture-privacy.js"
import type { eventWithTime } from "rrweb"
import { getRecordConsolePlugin } from "@rrweb/rrweb-plugin-console-record"
import { strToU8 } from "fflate"
import {
	compressRecordingEvents,
	compressRecordingEventsSync,
	recordingEventBytes,
	recordingEventsBytes,
	recordingPrefixLength,
	RecordingEncodingLimitError,
	MAX_RECORDING_QUEUE_BYTES,
	MAX_SYNC_RECORDING_BYTES,
	MAX_UNCOMPRESSED_CHUNK_BYTES,
	type CompressedEvents,
} from "./recording-encoding.js"
import { tryKeepaliveFetch, availableKeepaliveBytes } from "./keepalive.js"
import { withDeadline } from "./deadline.js"
import { FRONTEND_HEADERS, createLogger, type Logger } from "@devorash/core"
import {
	buildRrwebPrivacyOptions,
	requireSerializer,
	resolveMasking,
	type RrwebPrivacyOptions,
} from "./masking.js"

// ============================================
// Lazy rrweb loading
// ============================================

// rrweb (DOM snapshot + mutation observer) is the largest dependency of this
// package, and most end users of a customer's app are never impersonated or
// recorded. Loading it only when a recording actually starts keeps it out of
// the bundle every other visitor pays for. Memoized so repeated start/stop
// cycles on one page (or multiple recorder instances) share a single fetch.
type RrwebModule = typeof import("rrweb")
let rrwebModulePromise: Promise<RrwebModule> | null = null

function loadRrweb(): Promise<RrwebModule> {
	rrwebModulePromise ??= import("rrweb")
	return rrwebModulePromise
}

// The CSS/identifier sanitizer pulls in a CSS parser; it is only needed once a
// recording actually starts, so it shares rrweb's lazy-loading treatment.
type SerializationModule = typeof import("./serialization-privacy.js")
let serializationModulePromise: Promise<SerializationModule> | null = null

function loadSerialization(): Promise<SerializationModule> {
	serializationModulePromise ??= import("./serialization-privacy.js")
	return serializationModulePromise
}

// ============================================
// Constants
// ============================================

// At most one rrweb recording may run per page (shared global DOM mirror).
let activeRrwebStop: (() => void) | null = null

// Reused by SessionRecorder.acquire() so one tab maps to one recording track.
let activeRecorder: SessionRecorder | null = null

const TAB_ID_KEY = "__devora_recording_tab_id_v1"
// When sessionStorage is unavailable or write fails, keep one tab id for this runtime
// so we don't mint a new id on every getOrCreateTabId() call within the same page.
let tabIdRuntimeFallback: string | null = null
const PAUSE_DEBOUNCE_MS = 1000 // Ignore pauses shorter than 1s
const INITIAL_FLUSH_DELAY_MS = 2000 // Delay before first flush (ensures meaningful initial data)

// Adaptive chunking: flush before a chunk's *uncompressed* JSON grows large.
// The final gate is compressed size (see MAX_COMPRESSED_CHUNK_BYTES).
const DEFAULT_MAX_CHUNK_BYTES = 600_000

// fetch() keepalive requests are capped at ~64 KB total body in major browsers.
const MAX_KEEPALIVE_BODY_BYTES = 60_000

// Fail-closed safety valve. If uploads keep failing, we keep the contiguous,
// already-buffered prefix and stop buffering *new* events rather than dropping
// older structural events (which would corrupt replay). The backend then sees a
// gap-free prefix with a full snapshot and marks the track accordingly.
const MAX_PENDING_EVENTS = 50_000

// Custom rrweb event tags
const DEVORA_EVENTS = {
	TRACK_STARTED: "devora_track_started",
	TRACK_ENDED: "devora_track_ended",
	PAUSE: "devora_pause",
	RESUME: "devora_resume",
	NAVIGATION: "devora_navigation",
	PAGE_RELOAD: "devora_page_reload",
	CUSTOM_ACTION: "devora_custom_action",
} as const

// ============================================
// Types
// ============================================

/**
 * Session recorder configuration
 */
export interface SessionRecorderConfig {
	/** SDK service origin */
	apiUrl: string
	/** Devora API key */
	apiKey: string
	/** Session ID for the impersonation session */
	sessionId: string
	/** Devora control-plane bearer token for this exact session. */
	devoraSessionToken: string
	/** Batch size before auto-flush (default: 50 events) */
	batchSize?: number
	/** Max uncompressed bytes buffered before auto-flush (default: 800000) */
	maxChunkBytes?: number
	/** Flush interval in ms (default: 10000) */
	flushInterval?: number
	/** Enable debug logging */
	debug?: boolean
	/**
	 * Capture console.error/warn calls in the rrweb replay stream. Arguments
	 * are captured as passed — this does NOT redact tokens, PII, or other
	 * sensitive data your own code might log — so only enable it if you trust
	 * what your app logs to console.error/warn. Disabled by default.
	 */
	captureConsoleErrors?: boolean
	/** Dashboard flag: embed `logAction` custom events in the replay stream. */
	captureCustomEvents?: boolean
	/**
	 * Resolved rrweb privacy options (from the masking engine).
	 * Defaults to the "full" preset: all text masked, all inputs masked, media blocked.
	 */
	privacy?: RrwebPrivacyOptions
	/** Error callback */
	onError?: (error: Error) => void
	/**
	 * Called once when the server permanently refuses further uploads for this
	 * session (revoked capability, capture not permitted). The recorder stops;
	 * the impersonation session itself continues.
	 */
	onCaptureIncomplete?: (reason: string) => void
	/**
	 * A privacy budget (oversized stylesheet, identifier volume) forced a lossy
	 * but still opaque capture. Recording continues; the replay may look plainer.
	 */
	onPrivacyDegraded?: (reasons: readonly string[]) => void
	/** Pause callback (when recording pauses due to visibility/focus) */
	onPause?: (reason: "tab_hidden" | "browser_unfocused") => void
	/** Resume callback (when recording resumes) */
	onResume?: (pauseDurationMs: number) => void
}

type PauseReason = "tab_hidden" | "browser_unfocused"

/**
 * The server refused the upload for a reason a retry cannot fix: the tab's
 * capability was revoked or capture is not permitted for the session.
 */
export class RecordingDeniedError extends Error {
	readonly status: number
	constructor(status: number, detail: string) {
		super(`Recording upload refused (${status}): ${detail}`)
		this.name = "RecordingDeniedError"
		this.status = status
	}
}

const PERMANENT_UPLOAD_STATUSES = new Set([401, 403, 409])

function createRuntimeId(prefix = "id"): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return `devora_${prefix}_${crypto.randomUUID()}`
	}
	return `devora_${prefix}_${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/**
 * A chunk whose index has already been allocated. The index is assigned exactly
 * once, at formation time, and travels with the events so a retry resends the
 * SAME content under the SAME index. This is what keeps the chunk stream strictly
 * ordered across the async `flush()` and the unload-time `flushSync()` paths —
 * two competing index allocators previously let them collide, which reorders the
 * merged stream and produces "Node with id X not found" on replay.
 */
interface FormedChunk {
	events: eventWithTime[]
	chunkIndex: number
	startOffset: number
	endOffset: number
	isFinal: boolean
	/** Set when the fitting pass already compressed these exact events, so
	 * upload can reuse the bytes instead of gzipping the same data twice. */
	precomputed?: CompressedEvents
	bufferedBytes?: number
}

interface DevoraCustomEventPayload {
	timestamp: number
	url?: string
	title?: string
	reason?: PauseReason
	pauseDuration?: number
	fromUrl?: string
	toUrl?: string
	endReason?: string
	type?: string
	action?: string
	path?: string
	metadata?: Record<string, unknown>
}

/**
 * Encode bytes to base64 without blowing the call stack on large payloads.
 * `String.fromCharCode(...bytes)` spreads every byte as an argument, which throws
 * "Maximum call stack size exceeded" for big chunks, so we walk it in slices.
 */
function bytesToBase64(bytes: Uint8Array): string {
	let binary = ""
	const sliceSize = 0x8000
	for (let i = 0; i < bytes.length; i += sliceSize) {
		const slice = bytes.subarray(i, i + sliceSize)
		binary += String.fromCharCode.apply(null, slice as unknown as number[])
	}
	return btoa(binary)
}

/** Sanitize copies, never rrweb's mirror-owned nodes or mutation structures. */
export function sanitizeRrwebEvent(
	event: eventWithTime,
	privacy: RrwebPrivacyOptions = buildRrwebPrivacyOptions(resolveMasking(undefined)),
	getNode: (id: number) => Node | null = () => null
): eventWithTime | null {
	const serialization = requireSerializer(privacy)
	const sanitize =
		privacy.sanitizeAttributes ??
		buildRrwebPrivacyOptions(resolveMasking(undefined), serialization).sanitizeAttributes!
	const elementFor = (id: number): Element | null => {
		const node = getNode(id)
		return node?.nodeType === 1 ? (node as Element) : null
	}
	const isStyleElement = (element: Element | null | undefined): boolean =>
		element?.tagName?.toLowerCase() === "style"
	// rrweb 2.x no longer flags style text with `isStyle`, so the parent decides:
	// the serialized parent while recursing a snapshot, or the live parent in the
	// mirror for a text node appended to an existing <style> (CSS-in-JS, HMR,
	// runtime theming). Either way the text goes through the CSS sanitizer and
	// never through the text mask, which would otherwise pass it raw in the
	// partial/minimal profiles and destroy it in the full profile.
	const copyNode = (node: any, parentTagName?: string): any => {
		const copy = { ...node }
		if (typeof node.tagName === "string") copy.tagName = serialization.tag(node.tagName)
		if (node.type === 1) {
			copy.name = "html"
			copy.publicId = ""
			copy.systemId = ""
		}
		if (node.type === 4 || node.type === 5) copy.textContent = ""
		if (node.type === 3) {
			const liveParent = getNode(node.id)?.parentElement ?? null
			const styleText =
				node.isStyle === true ||
				parentTagName?.toLowerCase() === "style" ||
				isStyleElement(liveParent)
			copy.textContent = styleText
				? serialization.css(node.textContent ?? "")
				: privacy.maskTextFn(node.textContent, liveParent)
		}
		if (node.attributes) copy.attributes = sanitize(node.attributes, elementFor(node.id))
		if (node.childNodes)
			copy.childNodes = node.childNodes.map((child: any) =>
				copyNode(child, typeof node.tagName === "string" ? node.tagName : undefined)
			)
		return copy
	}
	const candidate = event as any
	if (event.type === 7) return null // External asset payloads can bypass DOM/style sanitization.
	if (event.type === 2)
		return {
			...event,
			data: { ...candidate.data, node: copyNode(candidate.data.node) },
		} as eventWithTime
	if (event.type === 3 && candidate.data?.source === 0) {
		return {
			...event,
			data: {
				...candidate.data,
				texts: candidate.data.texts?.map((text: any) => {
					const parent = getNode(text.id)?.parentElement
					return {
						...text,
						value: isStyleElement(parent)
							? serialization.css(text.value ?? "")
							: privacy.maskTextFn(text.value ?? "", parent ?? null),
					}
				}),
				adds: candidate.data.adds?.map((add: any) => ({
					...add,
					node: copyNode(
						add.node,
						typeof add.parentId === "number" ? elementFor(add.parentId)?.tagName : undefined
					),
				})),
				attributes: candidate.data.attributes?.map((mutation: any) => ({
					...mutation,
					attributes: sanitize(mutation.attributes, elementFor(mutation.id)),
				})),
			},
		} as eventWithTime
	}
	if (event.type === 3) {
		const data = candidate.data
		// Font binaries/resource names and custom-element constructor source are
		// executable/resource surfaces; replay uses system fonts and inert tags.
		if (data.source === 9 || data.source === 10 || data.source === 16) return null
		if (data.source === 5) {
			const element = elementFor(data.id)
			return {
				...event,
				data: {
					...data,
					text: element ? privacy.maskInputFn(data.text, element as HTMLElement) : "***",
				},
			} as eventWithTime
		}
		const rules = (adds: any[]) =>
			adds.map((add) => ({ ...add, rule: serialization.css(add.rule) }))
		if (data.source === 8)
			return {
				...event,
				data: {
					...data,
					...(data.adds ? { adds: rules(data.adds) } : {}),
					...(data.replace !== undefined ? { replace: serialization.css(data.replace) } : {}),
					...(data.replaceSync !== undefined
						? { replaceSync: serialization.css(data.replaceSync) }
						: {}),
				},
			} as eventWithTime
		if (data.source === 15)
			return {
				...event,
				data: {
					...data,
					styles: data.styles?.map((style: any) => ({ ...style, rules: rules(style.rules) })),
				},
			} as eventWithTime
		if (data.source === 13) {
			const { set, remove, ...rest } = data
			const mapped = serialization.property(set?.property ?? remove?.property ?? "")
			if (!mapped) return null
			const parsed = set && serialization.declarationValue(set.property, set.value ?? "")
			return {
				...event,
				data: {
					...rest,
					...(parsed
						? {
								set: {
									...parsed,
									priority: set.priority === "important" ? "important" : parsed.priority,
								},
							}
						: { remove: { property: mapped } }),
				},
			} as eventWithTime
		}
	}

	// Plugin events: only the console plugin is used; its arguments are free
	// text, so they are masked (full) or redacted, and stack traces dropped.
	if (event.type === 6) {
		if (candidate.data?.plugin !== "rrweb/console@1") return null
		const payload = candidate.data.payload ?? {}
		return {
			...event,
			data: {
				...candidate.data,
				payload: {
					level: payload.level === "error" ? "error" : "warn",
					payload: sanitizeConsoleArguments(payload.payload, privacy.profile ?? "full"),
					trace: [],
				},
			},
		} as eventWithTime
	}

	if (event.type === 4 && candidate.data?.href)
		return {
			...event,
			data: {
				...candidate.data,
				href: (privacy.sanitizeUrl ?? (() => "https://recording.invalid/page-redacted"))(
					candidate.data.href
				),
			},
		} as eventWithTime
	return event
}

// ============================================
// Tab ID Management
// ============================================

/** Persist the logical tab id so a refresh reuses the same recording track. */
function persistTabId(tabId: string): void {
	try {
		if (typeof sessionStorage === "undefined") {
			tabIdRuntimeFallback = tabId
			return
		}
		sessionStorage.setItem(TAB_ID_KEY, tabId)
		tabIdRuntimeFallback = null
	} catch {
		tabIdRuntimeFallback = tabId
	}
}

/**
 * Get or create a unique tab ID.
 * The stable tab ID is stored in sessionStorage. Every page load also sends a
 * separate pageInstanceId so rrweb node-id spaces stay isolated per runtime.
 */
function getOrCreateTabId(): string {
	// sessionStorage can throw in sandboxed iframes; use a stable per-runtime fallback.
	try {
		if (typeof window === "undefined" || typeof sessionStorage === "undefined") {
			return (tabIdRuntimeFallback ??= createRuntimeId("ssr_tab"))
		}

		const tabId =
			sessionStorage.getItem(TAB_ID_KEY) ?? tabIdRuntimeFallback ?? createRuntimeId("tab")
		persistTabId(tabId)
		return tabId
	} catch {
		// Storage unavailable: fall back to a per-runtime id. Recording still works;
		// cross-reload tab continuity is simply not possible without storage.
		return (tabIdRuntimeFallback ??= createRuntimeId("tab"))
	}
}

/**
 * The logical tab id used by the recorder for this tab.
 * Shared with the activity logger so timeline rows can sync to recording tracks.
 */
export function getRecorderTabId(): string {
	return getOrCreateTabId()
}

/**
 * Adopt the tab reference claimed by the SDK's tab coordinator (which detects
 * cloned sessionStorage and regenerates on collision) so recording tracks and
 * activity rows use the same, collision-free identity.
 */
export function setRecorderTabId(tabId: string): void {
	persistTabId(tabId)
}

// ============================================
// Session Recorder Class
// ============================================

/**
 * Session recorder class using rrweb with multi-tab support.
 * Records DOM mutations and user interactions during impersonation.
 */
export class SessionRecorder {
	private config: Required<
		Pick<
			SessionRecorderConfig,
			| "apiUrl"
			| "apiKey"
			| "sessionId"
			| "batchSize"
			| "maxChunkBytes"
			| "flushInterval"
			| "privacy"
		>
	> &
		SessionRecorderConfig
	private events: eventWithTime[] = []
	private pendingBytes = 0
	private uploadingChunk: FormedChunk | null = null
	private stopFn: (() => void) | null = null
	private flushTimer: ReturnType<typeof setInterval> | null = null
	private initialFlushTimer: ReturnType<typeof setTimeout> | null = null
	private isRunning = false
	private isFlushing = false
	private keepaliveUpload: Promise<void> | null = null
	private unloadIncompleteReported = false
	private activeFlush: Promise<void> | null = null
	private hasPageExited = false
	// Flush as soon as the first rrweb FullSnapshot (type 2) is buffered, so the
	// large initial snapshot is uploaded via the normal unlimited POST during the
	// session instead of being stranded in the unload-time keepalive path (which is
	// capped at ~60KB and would otherwise drop an oversized snapshot). One-shot:
	// later snapshots (rrweb checkouts) must not retrigger this.
	private firstSnapshotFlushed = false
	private chunkIndex = 0
	// Once tripped, we stop buffering NEW events to preserve the valid prefix
	// instead of dropping older structural events. Never reset within a track.
	private integrityCompromised = false
	// A chunk whose upload failed, held WITH its already-allocated index so a
	// retry resends identical content under the identical index. Never merged
	// back into `events` (that reuses the index for different content) and never
	// re-indexed (that reorders the stream). At most one is outstanding because
	// `flush()` is serialized by `isFlushing` and retries this before forming a
	// new chunk.
	private failedChunk: FormedChunk | null = null
	// Set once the server permanently refuses uploads; nothing is sent afterwards.
	private uploadDenied = false
	private recordingStartTime: number | null = null
	private logger: Logger
	// Set once the dynamically-imported rrweb module resolves; addCustomEvent
	// calls must go through this exact reference (a static property of the
	// loaded `record` function), not a module-level import.
	private recordFn: RrwebModule["record"] | null = null
	// Number of privacy degradations already reported, so each new reason is
	// surfaced exactly once instead of on every subsequent event.
	private reportedDegradations = 0

	// Tab management
	private tabId: string
	private pageInstanceId: string
	private currentUrl: string
	private currentTitle: string

	// Pause tracking
	private isPaused = false
	private pausedAt: number | null = null
	private pauseReason: PauseReason | null = null

	// Event listeners (for cleanup)
	private boundHandleVisibilityChange: () => void
	private boundHandleBlur: () => void
	private boundHandleFocus: () => void
	private boundHandlePageHide: (event: PageTransitionEvent) => void
	private boundHandlePopState: () => void

	// Navigation tracking (for cleanup)
	private originalPushState: typeof history.pushState | null = null
	private originalReplaceState: typeof history.replaceState | null = null
	// The wrapper functions we installed, so restore can check we're still the
	// current patcher before overwriting history.pushState/replaceState — the
	// activity logger may have patched on top of us since (or self-stopped and
	// restored on top of us), and blindly overwriting would either discard its
	// wrapper outright or leave it pointing at an original we've already nulled.
	private patchedPushState: typeof history.pushState | null = null
	private patchedReplaceState: typeof history.replaceState | null = null

	constructor(config: SessionRecorderConfig) {
		this.config = {
			batchSize: 50,
			maxChunkBytes: DEFAULT_MAX_CHUNK_BYTES,
			flushInterval: 10000, // 10 seconds
			...config,
			privacy: config.privacy ?? buildRrwebPrivacyOptions(resolveMasking(undefined)),
		}
		this.logger = createLogger("Devora Recorder", config.debug)

		// Initialize tab management — one pageInstanceId per recorder instance (page load).
		this.tabId = getOrCreateTabId()
		this.pageInstanceId = createRuntimeId("page")
		this.currentUrl = typeof window !== "undefined" ? this.safeUrl(window.location.href) : ""
		this.currentTitle = this.safeTitle()

		// Bind event handlers
		this.boundHandleVisibilityChange = this.handleVisibilityChange.bind(this)
		this.boundHandleBlur = this.handleBlur.bind(this)
		this.boundHandleFocus = this.handleFocus.bind(this)
		this.boundHandlePageHide = this.handlePageHide.bind(this)
		this.boundHandlePopState = this.handlePopState.bind(this)
	}

	private safeUrl(value: string): string {
		return this.config.privacy?.sanitizeUrl?.(value) ?? "https://recording.invalid/page-redacted"
	}

	private safeTitle(): string {
		return (this.config.privacy?.sanitizeTitle ?? (() => "***"))(
			typeof document === "undefined" ? "" : document.title
		)
	}

	/**
	 * Return the live recorder for this session if one exists, otherwise create one.
	 * Idempotent across SDK init/restore paths (one track per tab).
	 */
	static acquire(config: SessionRecorderConfig): SessionRecorder {
		if (activeRecorder) {
			if (activeRecorder.isRunning && activeRecorder.config.sessionId === config.sessionId) {
				return activeRecorder
			}
			// A recorder for a *different* (or finished) session is lingering — tear
			// it down before replacing it. A different session has its own tabId+
			// sessionId track, so this cannot collide with the new recording.
			void activeRecorder.stop()
			activeRecorder = null
		}
		activeRecorder = new SessionRecorder(config)
		return activeRecorder
	}

	/**
	 * Start recording the session. Synchronous state registration happens
	 * immediately (so `isRunning`/`acquire()` are correct right away); the
	 * rrweb module itself loads lazily in `startRrweb()`.
	 */
	start(): void {
		if (this.isRunning) {
			this.logger.warn("Recording already started")
			return
		}

		if (typeof window === "undefined") {
			this.logger.warn("Cannot start recording: not in browser environment")
			return
		}

		this.isRunning = true
		// Register as the page's single live recorder (acquire() relies on this).
		// oxlint-disable-next-line typescript/no-this-alias -- module-level singleton registration
		activeRecorder = this
		this.hasPageExited = false
		this.recordingStartTime = Date.now()
		this.chunkIndex = 0
		this.pendingBytes = 0
		this.integrityCompromised = false
		this.failedChunk = null
		this.uploadDenied = false
		this.firstSnapshotFlushed = false

		void this.startRrweb()
	}

	/**
	 * Loads rrweb (deferred so end users who are never recorded don't pay for
	 * it) and starts the actual recording. `start()` may have been superseded
	 * by a `stop()` — or a newer `start()` on a different instance — while the
	 * module was loading, so this re-checks ownership before touching rrweb.
	 */
	private async startRrweb(): Promise<void> {
		let rrweb: RrwebModule
		try {
			const [rrwebModule, serialization] = await Promise.all([loadRrweb(), loadSerialization()])
			rrweb = rrwebModule
			// One sanitizer per recorder: its identifier map must stay stable for the
			// whole track so replay selectors keep resolving across checkouts.
			this.config.privacy.serialization ??= new serialization.SerializationPrivacy()
		} catch (error) {
			this.logger.error("Failed to load recording modules:", error)
			this.isRunning = false
			if (activeRecorder === this) activeRecorder = null
			this.config.onError?.(error as Error)
			return
		}

		if (!this.isRunning || activeRecorder !== this) return
		this.recordFn = rrweb.record

		try {
			this.logger.log("Starting rrweb recording...")

			// Stop any orphaned rrweb instance before starting a new recording.
			if (activeRrwebStop) {
				this.logger.warn("Another rrweb recording was still live; stopping it first")
				try {
					activeRrwebStop()
				} catch {
					// ignore – best-effort teardown of an orphan
				}
				activeRrwebStop = null
			}

			// Start rrweb recording with privacy controls
			const recordResult = this.recordFn({
				emit: (event: eventWithTime) => {
					// Fail-closed: if uploads are persistently failing and the buffer is
					// saturated, stop buffering NEW events so the already-captured,
					// contiguous prefix (with its full snapshot) stays intact and uploadable.
					if (this.integrityCompromised) return

					let sanitized: eventWithTime | null
					try {
						sanitized = sanitizeRrwebEvent(event, this.config.privacy, (id) =>
							rrweb.record.mirror.getNode(id)
						)
					} catch {
						// Budgets degrade inside the sanitizer; anything that still throws is
						// a bug. Never fall back to the unsanitized event: preserve the safe
						// prefix and report incomplete capture.
						this.maybeTripIntegrityGuard(true)
						return
					}
					this.reportPrivacyDegradations()
					if (!sanitized || !this.enqueueRecordingEvent(sanitized)) return
					this.logger.log(`Event captured (total: ${this.events.length})`, {
						type: event.type,
					})

					// Upload the initial FullSnapshot (type 2) immediately via the normal
					// (unlimited) POST path. The snapshot is the largest single event; if it
					// only ever left on unload it could exceed the ~60KB keepalive cap and be
					// dropped, leaving a snapshot-less, unplayable segment. One-shot: rrweb
					// checkouts emit later snapshots that must not retrigger this.
					if (event.type === 2 && !this.firstSnapshotFlushed) {
						this.firstSnapshotFlushed = true
						if (this.initialFlushTimer) {
							clearTimeout(this.initialFlushTimer)
							this.initialFlushTimer = null
						}
						this.logger.log("First FullSnapshot captured, flushing immediately")
						void this.flush()
						return
					}

					// Auto-flush on event count OR accumulated byte budget, whichever
					// comes first, so a single large mutation can't create an oversized chunk.
					if (
						this.events.length >= this.config.batchSize ||
						this.pendingBytes >= this.config.maxChunkBytes
					) {
						this.logger.log("Flush threshold reached, triggering flush...", {
							eventCount: this.events.length,
							pendingBytes: this.pendingBytes,
						})
						void this.flush()
					}
				},

				// Privacy: resolved masking rules (defaults to the "full" preset —
				// all text masked, all inputs masked, media blocked). Password inputs
				// are masked in every preset.
				...(this.config.privacy ?? buildRrwebPrivacyOptions(resolveMasking(undefined))),

				// Warnings and errors only. sanitizeRrwebEvent masks the arguments
				// (full) or redacts them, replaces elements with a placeholder and
				// drops stack traces; captureConsoleErrors still defaults off.
				// stringifyOptions bounds how much of each argument gets captured.
				plugins: this.config.captureConsoleErrors
					? [
							getRecordConsolePlugin({
								level: ["error", "warn"],
								lengthThreshold: 1000,
								stringifyOptions: {
									stringLengthLimit: 1000,
									numOfKeysLimit: 20,
									depthOfLimit: 4,
								},
							}),
						]
					: [],

				// Sample mouse movement to reduce data size
				sampling: {
					mousemove: true,
					mouseInteraction: true,
					scroll: 150,
					input: "last",
				},
				checkoutEveryNth: 200,
				checkoutEveryNms: 60_000,

				// Collect fonts for accurate replay
				collectFonts: false,
				inlineStylesheet: true,
			})

			this.stopFn = recordResult ?? null

			if (!this.stopFn) {
				this.logger.warn("rrweb record() returned null/undefined - recording may not work")
			} else {
				activeRrwebStop = this.stopFn
				this.logger.log("rrweb recording initialized successfully")
			}

			// Inject track started event
			this.injectCustomEvent(DEVORA_EVENTS.TRACK_STARTED, {
				timestamp: Date.now(),
				url: this.currentUrl,
				title: this.currentTitle,
			})

			// Set up visibility and focus tracking
			this.setupEventListeners()

			// Set up navigation tracking
			this.setupNavigationTracking()

			// Initial flush after short delay
			// This ensures the track is created early with meaningful initial data,
			// but doesn't fire immediately which could miss the first full snapshot.
			// Industry best practice: PostHog, FullStory, Sentry all use delayed initial flush.
			this.initialFlushTimer = setTimeout(() => {
				this.initialFlushTimer = null
				void this.flush()
			}, INITIAL_FLUSH_DELAY_MS)

			// Set up periodic flush timer
			this.flushTimer = setInterval(() => {
				void this.flush()
			}, this.config.flushInterval)

			this.logger.log("Session recording started", {
				sessionId: this.config.sessionId,
				tabId: this.tabId,
				pageInstanceId: this.pageInstanceId,
				url: this.currentUrl,
			})
		} catch (error) {
			this.logger.error("Failed to start recording:", error)
			this.isRunning = false
			this.config.onError?.(error as Error)
		}
	}

	/**
	 * Stop recording and perform final flush
	 */
	async stop(endReason: string = "user_closed"): Promise<void> {
		if (!this.isRunning) {
			return
		}

		this.isRunning = false
		// Deregister as the page's live recorder so a later session creates a fresh one.
		if (activeRecorder === this) {
			activeRecorder = null
		}

		// Inject track ended event
		this.injectCustomEvent(DEVORA_EVENTS.TRACK_ENDED, {
			timestamp: Date.now(),
			endReason,
		})

		// Clean up event listeners
		this.removeEventListeners()

		// Restore navigation methods (cleanup monkey-patches)
		this.restoreNavigationMethods()

		// Clear timers
		if (this.initialFlushTimer) {
			clearTimeout(this.initialFlushTimer)
			this.initialFlushTimer = null
		}
		if (this.flushTimer) {
			clearInterval(this.flushTimer)
			this.flushTimer = null
		}

		// Stop rrweb recording
		if (this.stopFn) {
			if (activeRrwebStop === this.stopFn) {
				activeRrwebStop = null
			}
			this.stopFn()
			this.stopFn = null
		}

		// Final flush with isFinal flag
		await this.flush(true)

		this.logger.log("Session recording stopped", {
			sessionId: this.config.sessionId,
			tabId: this.tabId,
			pageInstanceId: this.pageInstanceId,
			chunks: this.chunkIndex,
		})
	}

	/**
	 * Check if currently recording
	 */
	isRecording(): boolean {
		return this.isRunning
	}

	/**
	 * Check if currently paused
	 */
	isCurrentlyPaused(): boolean {
		return this.isPaused
	}

	/**
	 * Get current event count
	 */
	getEventCount(): number {
		return this.events.length
	}

	/**
	 * Get the tab ID for this recorder
	 */
	getTabId(): string {
		return this.tabId
	}

	/**
	 * Get the page-load/runtime ID for this recorder.
	 */
	getPageInstanceId(): string {
		return this.pageInstanceId
	}

	/**
	 * Add a bounded custom action to the recording stream.
	 */
	recordCustomAction(event: NormalizedCustomAction): void {
		if (!this.config.captureCustomEvents) return
		// Already normalized by the SDK (sanitized path and metadata, bounded
		// strings), identically to the activity timeline.
		this.injectCustomEvent(DEVORA_EVENTS.CUSTOM_ACTION, {
			timestamp: Date.now(),
			type: event.type,
			action: event.action,
			path: event.path,
			metadata: event.metadata,
		})
	}

	// ============================================
	// Event Listeners
	// ============================================

	private setupEventListeners(): void {
		if (typeof document !== "undefined") {
			document.addEventListener("visibilitychange", this.boundHandleVisibilityChange)
		}
		if (typeof window !== "undefined") {
			window.addEventListener("blur", this.boundHandleBlur)
			window.addEventListener("focus", this.boundHandleFocus)
			window.addEventListener("pagehide", this.boundHandlePageHide)
			window.addEventListener("popstate", this.boundHandlePopState)
		}
	}

	private removeEventListeners(): void {
		if (typeof document !== "undefined") {
			document.removeEventListener("visibilitychange", this.boundHandleVisibilityChange)
		}
		if (typeof window !== "undefined") {
			window.removeEventListener("blur", this.boundHandleBlur)
			window.removeEventListener("focus", this.boundHandleFocus)
			window.removeEventListener("pagehide", this.boundHandlePageHide)
			window.removeEventListener("popstate", this.boundHandlePopState)
		}
	}

	private handleVisibilityChange(): void {
		if (document.visibilityState === "hidden") {
			this.onPause("tab_hidden")
		} else {
			// Re-persist tab id when the tab becomes visible again (covers storage
			// write failures on an earlier page load in this browsing context).
			persistTabId(this.tabId)
			this.onResume()
		}
	}

	private handleBlur(): void {
		// Delay to check if document still has focus
		// (prevents false positives from clicking in DevTools)
		setTimeout(() => {
			if (!document.hasFocus() && document.visibilityState === "visible") {
				this.onPause("browser_unfocused")
			}
		}, 100)
	}

	private handleFocus(): void {
		if (document.hasFocus()) {
			this.onResume()
		}
	}

	private handlePageHide(event: PageTransitionEvent): void {
		if (event.persisted) {
			this.flushSync(false)
			return
		}
		this.handlePageExit()
	}

	private handlePageExit(): void {
		if (this.hasPageExited) return
		this.hasPageExited = true

		if (this.initialFlushTimer) {
			clearTimeout(this.initialFlushTimer)
			this.initialFlushTimer = null
		}
		if (this.flushTimer) {
			clearInterval(this.flushTimer)
			this.flushTimer = null
		}

		if (this.isRunning && this.stopFn) {
			try {
				// Mark the page boundary only. A page unload (reload/close/navigate) ends
				// this SEGMENT, not the logical tab TRACK — the tab may load another page
				// under the same tabId. TRACK_ENDED is reserved for explicit stop() /
				// session end so the track lifecycle isn't prematurely closed here.
				this.injectCustomEvent(DEVORA_EVENTS.PAGE_RELOAD, {
					timestamp: Date.now(),
					url: this.currentUrl,
				})
			} catch {
				this.logger.warn("Failed to inject page exit event, flushing existing events only")
			}

			if (activeRrwebStop === this.stopFn) {
				activeRrwebStop = null
			}
			try {
				this.stopFn()
			} catch {
				// Best-effort shutdown while the browser is unloading.
			}
			this.stopFn = null
		}

		this.isRunning = false
		if (activeRecorder === this) {
			activeRecorder = null
		}

		this.flushSync(true)
	}

	private handlePopState(): void {
		const nextUrl = this.safeUrl(window.location.href)
		this.onNavigation(this.currentUrl, nextUrl)
		this.currentUrl = nextUrl
	}

	// ============================================
	// Pause/Resume Handling
	// ============================================

	private onPause(reason: PauseReason): void {
		if (this.isPaused) return // Already paused

		this.isPaused = true
		this.pausedAt = Date.now()
		this.pauseReason = reason

		// Inject pause event into rrweb stream
		this.injectCustomEvent(DEVORA_EVENTS.PAUSE, {
			timestamp: Date.now(),
			reason,
		})

		// IMPORTANT: Flush events when tab becomes hidden (industry best practice)
		// This ensures data is saved before user potentially leaves or closes the tab.
		// Used by PostHog, FullStory, Sentry, LogRocket, and other major players.
		// We fire-and-forget (void) to avoid blocking the main thread.
		// NOTE: The chunk upload will include isPaused=true, so the backend will
		// update the track status automatically. We don't need a separate pause notification.
		if (reason === "tab_hidden") {
			// Cancel initial flush timer if it hasn't fired yet - we'll flush now instead
			if (this.initialFlushTimer) {
				clearTimeout(this.initialFlushTimer)
				this.initialFlushTimer = null
			}
			// Non-blocking flush - don't await, let it run in background
			// The flush() method has internal guards against concurrent flushes
			void this.flush()
		}

		this.logger.log("Recording paused", { reason })
		this.config.onPause?.(reason)
	}

	private onResume(): void {
		if (!this.isPaused || !this.pausedAt) return // Not paused

		const pauseDuration = Date.now() - this.pausedAt

		// Debounce: ignore very brief pauses
		if (pauseDuration < PAUSE_DEBOUNCE_MS) {
			this.isPaused = false
			this.pausedAt = null
			this.pauseReason = null
			return
		}

		// Inject resume event into rrweb stream
		this.injectCustomEvent(DEVORA_EVENTS.RESUME, {
			timestamp: Date.now(),
			pauseDuration,
			reason: this.pauseReason ?? undefined,
		})

		this.logger.log("Recording resumed", {
			pauseDuration: `${Math.round(pauseDuration / 1000)}s`,
			reason: this.pauseReason,
		})
		this.config.onResume?.(pauseDuration)

		this.isPaused = false
		this.pausedAt = null
		this.pauseReason = null

		// NOTE: The next chunk upload will include isPaused=false, so the backend will
		// update the track status automatically. We don't need a separate resume notification.
	}

	// ============================================
	// Navigation Tracking
	// ============================================

	/**
	 * Set up navigation tracking by monkey-patching history methods.
	 * Stores original methods for later restoration.
	 * Safe to call multiple times - only patches once.
	 */
	private setupNavigationTracking(): void {
		if (typeof window === "undefined") return

		// Only patch if not already patched
		if (this.originalPushState !== null || this.originalReplaceState !== null) {
			return // Already patched
		}

		const push = history.pushState.bind(history)
		const replace = history.replaceState.bind(history)
		this.originalPushState = push
		this.originalReplaceState = replace
		const navigate = () => {
			const nextUrl = this.safeUrl(window.location.href)
			this.onNavigation(this.currentUrl, nextUrl)
			this.currentUrl = nextUrl
		}
		const wrappedPush: History["pushState"] = (...args) => {
			push(...args)
			if (this.isRunning && this.patchedPushState === wrappedPush) navigate()
		}
		const wrappedReplace: History["replaceState"] = (...args) => {
			replace(...args)
			if (this.isRunning && this.patchedReplaceState === wrappedReplace) navigate()
		}
		this.patchedPushState = history.pushState = wrappedPush
		this.patchedReplaceState = history.replaceState = wrappedReplace
	}

	/**
	 * Restore original history methods.
	 * Cleans up monkey-patches applied by setupNavigationTracking. Only touches
	 * history.pushState/replaceState if it's still exactly our own wrapper —
	 * if something else (e.g. the activity logger) patched on top of us since,
	 * restoring would either discard that wrapper or hand it a now-null
	 * original to call, so we leave it alone and let that patcher's own
	 * restore run instead.
	 */
	private restoreNavigationMethods(): void {
		if (typeof window === "undefined") return

		if (this.originalPushState !== null) {
			if (history.pushState === this.patchedPushState) {
				history.pushState = this.originalPushState
			}
			this.originalPushState = null
			this.patchedPushState = null
		}

		if (this.originalReplaceState !== null) {
			if (history.replaceState === this.patchedReplaceState) {
				history.replaceState = this.originalReplaceState
			}
			this.originalReplaceState = null
			this.patchedReplaceState = null
		}
	}

	private onNavigation(fromUrl: string, toUrl: string): void {
		if (fromUrl === toUrl) return

		this.injectCustomEvent(DEVORA_EVENTS.NAVIGATION, {
			timestamp: Date.now(),
			fromUrl,
			toUrl,
		})

		this.currentTitle = this.safeTitle()
		this.logger.log("Navigation", { from: fromUrl, to: toUrl })

		// Upload buffered events via normal fetch before the page may unload.
		void this.flush()
	}

	// ============================================
	// Custom Event Injection
	// ============================================

	private injectCustomEvent(tag: string, payload: DevoraCustomEventPayload): void {
		// Guard: skip if not running (except for TRACK_ENDED which is called during stop())
		if (!this.isRunning && tag !== DEVORA_EVENTS.TRACK_ENDED) return

		// Additional guard: skip if rrweb has been stopped (stopFn is null) or
		// hasn't finished loading yet (recordFn is null). Handles race
		// conditions during shutdown and during the brief window where rrweb
		// is still being fetched.
		if (!this.stopFn && tag !== DEVORA_EVENTS.TRACK_ENDED) return
		if (!this.recordFn) return

		// rrweb addCustomEvent adds to the event stream
		// Wrap in try-catch as rrweb throws if recording has been stopped
		// This is a safety net - the guards above should prevent most cases
		try {
			this.recordFn.addCustomEvent(tag, payload)
		} catch (error) {
			// rrweb throws "please add custom event after start recording" if stopped
			// This is expected during shutdown or race conditions
			// Only log for non-shutdown cases (unexpected errors)
			if (tag !== DEVORA_EVENTS.TRACK_ENDED && tag !== DEVORA_EVENTS.PAGE_RELOAD) {
				this.logger.warn(`Failed to inject event ${tag}:`, error)
			}
		}
	}

	// ============================================
	// Flushing
	// ============================================

	/** Bound newly captured bytes together with the one failed/in-flight chunk. */
	private enqueueRecordingEvent(event: eventWithTime): boolean {
		if (this.integrityCompromised) return false
		try {
			const bytes = recordingEventBytes(event)
			const held = this.uploadingChunk ?? this.failedChunk
			const heldBytes = held ? (held.bufferedBytes ??= recordingEventsBytes(held.events)) : 0
			if (
				bytes + 2 > MAX_UNCOMPRESSED_CHUNK_BYTES ||
				this.pendingBytes + heldBytes + bytes + 2 > MAX_RECORDING_QUEUE_BYTES ||
				this.events.length + (held?.events.length ?? 0) >= MAX_PENDING_EVENTS
			) {
				this.maybeTripIntegrityGuard(true)
				return false
			}
			this.events.push(event)
			this.pendingBytes += bytes
			return true
		} catch {
			this.maybeTripIntegrityGuard(true)
			return false
		}
	}

	private chunkOffsets(events: eventWithTime[]): {
		startOffset: number
		endOffset: number
	} {
		const firstEvent = events[0]
		const lastEvent = events[events.length - 1]
		const startOffset = firstEvent?.timestamp
			? firstEvent.timestamp - (this.recordingStartTime ?? firstEvent.timestamp)
			: 0
		const endOffset = lastEvent?.timestamp
			? lastEvent.timestamp - (this.recordingStartTime ?? lastEvent.timestamp)
			: startOffset
		return { startOffset, endOffset }
	}

	/**
	 * Take a prefix of buffered events that fits upload limits. The index is
	 * allocated here (at formation), never at upload time.
	 */
	private formChunk(isFinal: boolean, keepaliveSafe = false): FormedChunk | null {
		if (this.events.length === 0) {
			if (!isFinal) return null
			return {
				events: [],
				chunkIndex: this.chunkIndex++,
				startOffset: 0,
				endOffset: 0,
				isFinal: true,
			}
		}

		let fit: eventWithTime[]
		let remainder: eventWithTime[]
		let precomputed: CompressedEvents | undefined
		if (keepaliveSafe) {
			;({ fit, remainder } = this.splitEventsToFitKeepalive(this.events, isFinal))
			if (fit.length > 0) precomputed = compressRecordingEventsSync(fit)
		} else {
			const count = recordingPrefixLength(this.events)
			fit = this.events.slice(0, count)
			remainder = this.events.slice(count)
		}

		if (fit.length === 0) return null

		this.events = remainder
		this.pendingBytes = Math.max(0, this.pendingBytes - (recordingEventsBytes(fit) - 2))

		const { startOffset, endOffset } = this.chunkOffsets(fit)
		return {
			events: fit,
			chunkIndex: this.chunkIndex++,
			startOffset,
			endOffset,
			isFinal: isFinal && remainder.length === 0,
			precomputed,
		}
	}

	/** Largest prefix whose keepalive POST body stays under the browser cap. */
	private splitEventsToFitKeepalive(
		events: eventWithTime[],
		isFinal: boolean
	): { fit: eventWithTime[]; remainder: eventWithTime[] } {
		if (events.length === 0) return { fit: [], remainder: [] }

		const chunkIndex = this.chunkIndex
		let lo = 1
		// Bound unload-time compression work before probing any candidates.
		let candidateCount = 0
		let candidateBytes = 2
		for (const event of events) {
			const bytes = recordingEventBytes(event)
			if (candidateBytes + bytes > MAX_SYNC_RECORDING_BYTES) break
			candidateBytes += bytes
			candidateCount++
		}
		let hi = candidateCount
		let best = 0

		while (lo <= hi) {
			const mid = Math.floor((lo + hi) / 2)
			const candidate = events.slice(0, mid)
			const bodySize = this.estimateKeepaliveBodySize(
				candidate,
				chunkIndex,
				isFinal && mid === events.length
			)
			if (bodySize <= Math.min(MAX_KEEPALIVE_BODY_BYTES, availableKeepaliveBytes("recording"))) {
				best = mid
				lo = mid + 1
			} else {
				hi = mid - 1
			}
		}

		if (best === 0) {
			return { fit: [], remainder: events }
		}
		return { fit: events.slice(0, best), remainder: events.slice(best) }
	}

	private estimateKeepaliveBodySize(
		events: eventWithTime[],
		chunkIndex: number,
		isFinal: boolean
	): number {
		return strToU8(JSON.stringify(this.buildChunkPayload(events, chunkIndex, 0, 0, isFinal)))
			.byteLength
	}

	private buildChunkPayload(
		events: eventWithTime[],
		chunkIndex: number,
		startOffset: number,
		endOffset: number,
		isFinal: boolean,
		precomputed?: CompressedEvents
	): Record<string, unknown> {
		return {
			tabId: this.tabId,
			pageInstanceId: this.pageInstanceId,
			tabUrl: this.currentUrl,
			tabTitle: this.currentTitle,
			userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
			...this.buildCompressedChunk(events, precomputed),
			chunkIndex,
			startOffset,
			endOffset,
			isFinal,
			isPaused: this.isPaused,
		}
	}

	/** Preserve the captured prefix and retire rrweb once the capture budget is exhausted. */
	/** Surface each new privacy degradation once; capture itself continues. */
	private reportPrivacyDegradations(): void {
		const reasons = this.config.privacy.serialization?.degraded ?? []
		if (reasons.length <= this.reportedDegradations) return
		const fresh = reasons.slice(this.reportedDegradations)
		this.reportedDegradations = reasons.length
		this.logger.warn("Recording privacy budget reached; capture continues with reduced fidelity", {
			reasons: fresh,
		})
		try {
			this.config.onPrivacyDegraded?.(fresh)
		} catch {
			/* Observers cannot affect capture. */
		}
	}

	private maybeTripIntegrityGuard(force = false): void {
		if (
			!this.integrityCompromised &&
			(force ||
				this.events.length >= MAX_PENDING_EVENTS ||
				this.pendingBytes >= MAX_RECORDING_QUEUE_BYTES)
		) {
			this.integrityCompromised = true
			const reason = force ? "recording_budget_exceeded" : "integrity_guard_tripped"
			this.logger.warn(
				"Recording limit reached; preserving the captured prefix and stopping capture"
			)
			try {
				this.config.onError?.(new RecordingEncodingLimitError())
				this.config.onCaptureIncomplete?.(reason)
			} catch {
				/* Observers cannot prevent recorder cleanup or reporting. */
			}
			this.reportCaptureIncomplete(reason)
			// The initial snapshot can exhaust the budget before rrweb returns its
			// stop handle. Retire it immediately after that synchronous startup.
			queueMicrotask(() => {
				void this.stop("error").catch((error) =>
					this.logger.warn("Recording cleanup failed", error)
				)
			})
		}
	}

	/**
	 * Best-effort, fire-and-forget report to the backend that capture stopped
	 * early for this tab while the session is still live. Never throws: a
	 * failure here must not affect the recorder's own control flow, which has
	 * already stopped (or is stopping) regardless of whether this call lands.
	 */
	private reportCaptureIncomplete(
		reasonCode:
			| "capability_revoked"
			| "recording_not_permitted"
			| "integrity_guard_tripped"
			| "unload_delivery_uncertain"
			| "recording_budget_exceeded"
	): void {
		const offsetMs = Date.now() - (this.recordingStartTime ?? Date.now())
		try {
			const url = `${this.config.apiUrl}/api/sdk/recording/incomplete`
			const init = {
				method: "POST",
				redirect: "error" as const,
				headers: {
					"Content-Type": "application/json",
					[FRONTEND_HEADERS.API_KEY]: this.config.apiKey,
					[FRONTEND_HEADERS.SESSION]: this.config.sessionId,
					[FRONTEND_HEADERS.SESSION_TOKEN]: this.config.devoraSessionToken,
				},
				body: JSON.stringify({
					tabId: this.tabId,
					tabUrl: this.currentUrl.slice(0, 2048),
					pageInstanceId: this.pageInstanceId,
					reasonCode,
					offsetMs,
				}),
				signal: AbortSignal.timeout(10_000),
			}
			const pending =
				reasonCode === "unload_delivery_uncertain"
					? tryKeepaliveFetch(url, init, "notice")
					: fetch(url, init)
			if (!pending) {
				this.logger.warn("Incomplete capture notice could not be queued")
				return
			}
			void pending.then(
				(response) => {
					if (!response.ok)
						this.logger.warn("Incomplete capture notice was refused", { status: response.status })
				},
				(error) => this.logger.warn("Failed to report incomplete capture (best effort):", error)
			)
		} catch (error) {
			this.logger.warn("Failed to report incomplete capture (best effort):", error)
		}
	}

	private async uploadFormedChunk(chunk: FormedChunk): Promise<void> {
		this.uploadingChunk = chunk
		try {
			chunk.precomputed ??= await compressRecordingEvents(chunk.events)
			await this.sendChunk(
				chunk.events,
				chunk.isFinal,
				chunk.chunkIndex,
				chunk.startOffset,
				chunk.endOffset,
				chunk.precomputed
			)
		} finally {
			if (this.uploadingChunk === chunk) this.uploadingChunk = null
		}
	}

	private async retryFailedChunk(): Promise<boolean> {
		if (this.keepaliveUpload) await this.keepaliveUpload
		if (!this.failedChunk) return true

		const fc = this.failedChunk
		try {
			await this.uploadFormedChunk(fc)
			this.failedChunk = null
			return true
		} catch (error) {
			if (error instanceof RecordingDeniedError) {
				this.abortAfterDenial(error)
				return false
			}
			this.logger.error("Failed to re-upload chunk:", error)
			this.config.onError?.(error as Error)
			this.maybeTripIntegrityGuard()
			return false
		}
	}

	/**
	 * A permanent refusal ends capture for this tab without ending the session.
	 * Buffered events are discarded (they can never be uploaded), listeners and
	 * rrweb are torn down, and the host is told once so it can surface the gap.
	 */
	private abortAfterDenial(error: RecordingDeniedError): void {
		if (this.uploadDenied) return
		this.uploadDenied = true
		this.failedChunk = null
		this.events = []
		this.pendingBytes = 0
		this.logger.warn("Recording stopped: the server refused further uploads", {
			status: error.status,
			sessionId: this.config.sessionId,
			tabId: this.tabId,
		})
		if (this.isRunning) {
			this.isRunning = false
			if (activeRecorder === this) activeRecorder = null
			this.removeEventListeners()
			this.restoreNavigationMethods()
			if (this.initialFlushTimer) {
				clearTimeout(this.initialFlushTimer)
				this.initialFlushTimer = null
			}
			if (this.flushTimer) {
				clearInterval(this.flushTimer)
				this.flushTimer = null
			}
			if (this.stopFn) {
				if (activeRrwebStop === this.stopFn) activeRrwebStop = null
				this.stopFn()
				this.stopFn = null
			}
		}
		const reasonCode = error.status === 409 ? "recording_not_permitted" : "capability_revoked"
		this.config.onError?.(error)
		this.config.onCaptureIncomplete?.(reasonCode)
		this.reportCaptureIncomplete(reasonCode)
	}

	private async performFlush(isFinal: boolean): Promise<void> {
		if (this.uploadDenied) return
		this.logger.log("flush() called", {
			isFinal,
			eventCount: this.events.length,
		})

		while (true) {
			if (!(await this.retryFailedChunk())) return

			const chunk = this.formChunk(isFinal)
			if (!chunk) break

			try {
				await this.uploadFormedChunk(chunk)
				this.logger.log("Chunk uploaded", {
					chunkIndex: chunk.chunkIndex,
					eventCount: chunk.events.length,
					isFinal: chunk.isFinal,
				})
			} catch (error) {
				if (error instanceof RecordingDeniedError) {
					this.abortAfterDenial(error)
					return
				}
				this.logger.error("Failed to upload chunk:", error)
				this.config.onError?.(error as Error)
				if (error instanceof RecordingEncodingLimitError) {
					this.uploadDenied = true
					this.events = []
					this.pendingBytes = 0
					this.maybeTripIntegrityGuard(true)
				} else {
					this.failedChunk = chunk
					this.maybeTripIntegrityGuard()
				}
				return
			}

			if (chunk.isFinal) break
			if (!isFinal && this.events.length === 0) break
		}
	}

	private async flush(isFinal = false): Promise<void> {
		if (this.activeFlush) {
			if (!isFinal) {
				this.logger.log("Flush skipped - already flushing")
				return
			}

			this.logger.log("Final flush waiting for active flush")
			await this.activeFlush
			return this.flush(true)
		}

		this.isFlushing = true
		const flushPromise = this.performFlush(isFinal)
		this.activeFlush = flushPromise
		try {
			await flushPromise
		} finally {
			this.isFlushing = false
			if (this.activeFlush === flushPromise) {
				this.activeFlush = null
			}
		}
	}

	/**
	 * Synchronous flush for page unload (`pagehide`). Uses fetch keepalive with
	 * size-safe chunks so the final buffer still uploads as the browser tears down.
	 */
	private flushSync(isFinal = false): void {
		if (this.uploadDenied) return
		// An earlier chunk must be acknowledged before a final index can claim
		// completeness. Never race the ordinary upload or another keepalive.
		if (this.isFlushing || this.keepaliveUpload) {
			if (isFinal) this.markUnloadIncomplete()
			return
		}
		const chunk = this.failedChunk ?? this.formChunk(isFinal, true)
		if (!chunk) {
			if (isFinal && this.events.length > 0) this.markUnloadIncomplete()
			return
		}
		// Retain the exact bytes/index until a successful response, including when
		// the browser refuses the request or the shared budget has no room.
		this.failedChunk = chunk
		const queued = this.postChunkKeepalive(chunk)
		if (isFinal && (!queued || this.events.length > 0 || !chunk.isFinal))
			this.markUnloadIncomplete()
	}

	private markUnloadIncomplete(): void {
		if (this.unloadIncompleteReported) return
		this.unloadIncompleteReported = true
		this.logger.warn("Recording delivery could not be confirmed before the page unloaded")
		try {
			this.config.onCaptureIncomplete?.("unload_delivery_uncertain")
		} catch {
			/* An observer must not prevent the notice from being attempted. */
		}
		this.reportCaptureIncomplete("unload_delivery_uncertain")
	}

	/** Queue one upload within the shared budget; true does not mean delivered. */
	private postChunkKeepalive(chunk: FormedChunk): boolean {
		if (!chunk.precomputed && recordingEventsBytes(chunk.events) > MAX_SYNC_RECORDING_BYTES)
			return false
		if (
			chunk.precomputed &&
			chunk.precomputed.compressed.byteLength > (availableKeepaliveBytes("recording") * 3) / 4
		)
			return false
		const payload = JSON.stringify(
			this.buildChunkPayload(
				chunk.events,
				chunk.chunkIndex,
				chunk.startOffset,
				chunk.endOffset,
				chunk.isFinal,
				chunk.precomputed
			)
		)
		if (strToU8(payload).byteLength > MAX_KEEPALIVE_BODY_BYTES) return false
		const controller = new AbortController()
		const pending = tryKeepaliveFetch(
			`${this.config.apiUrl}/api/sdk/recording/chunk`,
			{
				method: "POST",
				redirect: "error" as const,
				headers: {
					"Content-Type": "application/json",
					[FRONTEND_HEADERS.API_KEY]: this.config.apiKey,
					[FRONTEND_HEADERS.SESSION]: this.config.sessionId,
					[FRONTEND_HEADERS.SESSION_TOKEN]: this.config.devoraSessionToken,
				},
				body: payload,
				signal: controller.signal,
			},
			"recording"
		)
		if (!pending) return false
		const upload = withDeadline(
			() => pending,
			10_000,
			() => controller.abort()
		)
			.then((response) => {
				if (!response.ok) throw new Error(`Recording upload refused: ${response.status}`)
				if (this.failedChunk === chunk) this.failedChunk = null
			})
			.catch((error) => {
				this.logger.warn("Keepalive recording upload was not acknowledged", error)
				this.markUnloadIncomplete()
			})
			.finally(() => {
				if (this.keepaliveUpload === upload) this.keepaliveUpload = null
			})
		this.keepaliveUpload = upload
		return true
	}

	/**
	 * Gzip-compress an event batch for upload via the Devora recording API.
	 * Reuses `precomputed` (from the fitting pass that already compressed
	 * these exact events to check chunk-size limits) instead of gzipping the
	 * same data twice.
	 */
	private buildCompressedChunk(
		events: eventWithTime[],
		precomputed?: CompressedEvents
	): {
		encoding: "gzip"
		payloadKind: "storage"
		eventsBase64: string
		eventCount: number
		compressedSizeBytes: number
		uncompressedSizeBytes: number
	} {
		const { uncompressed, compressed } = precomputed ?? compressRecordingEventsSync(events)
		return {
			encoding: "gzip",
			payloadKind: "storage",
			eventsBase64: bytesToBase64(compressed),
			eventCount: events.length,
			compressedSizeBytes: compressed.byteLength,
			uncompressedSizeBytes: uncompressed.byteLength,
		}
	}

	private async sendChunk(
		events: eventWithTime[],
		isFinal: boolean,
		chunkIndex: number,
		startOffset = 0,
		endOffset = 0,
		precomputed?: CompressedEvents
	): Promise<void> {
		const url = `${this.config.apiUrl}/api/sdk/recording/chunk`
		const body = this.buildChunkPayload(
			events,
			chunkIndex,
			startOffset,
			endOffset,
			isFinal,
			precomputed
		)

		this.logger.log("sendChunk() - sending to backend", {
			url,
			sessionId: this.config.sessionId,
			tabId: this.tabId,
			pageInstanceId: this.pageInstanceId,
			eventCount: events.length,
			chunkIndex,
			compressedSizeBytes: (body as { compressedSizeBytes?: number }).compressedSizeBytes,
			isFinal,
		})

		try {
			const init = {
				method: "POST",
				redirect: "error" as const,
				headers: {
					"Content-Type": "application/json",
					[FRONTEND_HEADERS.API_KEY]: this.config.apiKey,
					[FRONTEND_HEADERS.SESSION]: this.config.sessionId,
					[FRONTEND_HEADERS.SESSION_TOKEN]: this.config.devoraSessionToken,
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(10000),
			}
			// A bounded final upload should survive a host logout/navigation. Share
			// the unload budget so telemetry cannot crowd out session revocation.
			// Oversized tails use ordinary fetch and retain truthful partial status
			// if navigation or the already-revoked capability prevents delivery.
			const pending = isFinal ? tryKeepaliveFetch(url, init, "recording") : null
			const response = await (pending ?? fetch(url, init))

			if (!response.ok) {
				const text = await response.text()
				this.logger.error("sendChunk() - upload failed", {
					status: response.status,
					response: text,
				})
				if (PERMANENT_UPLOAD_STATUSES.has(response.status))
					throw new RecordingDeniedError(response.status, text.slice(0, 200))
				throw new Error(`Failed to upload recording chunk: ${response.status} - ${text}`)
			}

			const result = await response.json()
			this.logger.log("sendChunk() - upload successful", result)
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			this.logger.error("sendChunk() - upload error", {
				error: errorMessage,
				chunkIndex,
				isFinal,
			})
			throw error
		}
	}
}
