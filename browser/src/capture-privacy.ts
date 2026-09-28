/**
 * Sanitizers for the free-form capture channels: custom actions, their
 * metadata, uncaught errors and console arguments. DOM masking does not reach
 * these, so each is normalized here, once, before activity or recording sees it.
 *
 * Regex redaction is a backstop, not a guarantee: under the `full` profile
 * free text is not recorded at all, only structure and categories.
 */
import { sanitizeCaptureUrl, type ResolvedMasking } from "./masking.js"

/** Keys whose values are never recorded, at any depth. */
const SENSITIVE_KEY =
	/pass(word|wd|phrase)?|secret|token|cookie|authori[sz]ation|session|api[-_]?key|bearer|credential|private|ssn|social|card|cvv|cvc|iban|otp|pin$/i

const SECRET_PATTERNS: RegExp[] = [
	// JWTs and bearer tokens
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
	/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
	// key=value secrets in URLs, headers and messages, including JSON's quoted keys
	/\b([A-Za-z_-]*(?:token|secret|password|passwd|api[-_]?key|session|auth|otp|cvv|cvc|ssn)[A-Za-z_-]*)["']?\s*[=:]\s*("[^"]*"|'[^']*'|[^\s&,;}\]]+)/gi,
	// email addresses
	/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
	// card-like digit runs and long opaque identifiers
	/\b(?:\d[ -]?){12,19}\b/g,
	/\b[A-Za-z0-9_-]{32,}\b/g,
]

/** Redact secret-shaped substrings and bound the length. */
export function redactFreeText(value: string, max = 300): string {
	let text = value.length > max * 4 ? value.slice(0, max * 4) : value
	for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[redacted]")
	return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const MAX_METADATA_JSON = 2048

function sanitizeValue(value: unknown, masking: ResolvedMasking, depth: number): unknown {
	if (value === null || typeof value === "boolean") return value
	if (typeof value === "number") return Number.isFinite(value) ? value : null
	if (typeof value === "string")
		return masking.profile === "full"
			? value.replace(/\S/g, "*").slice(0, 200)
			: redactFreeText(value, 200)
	if (depth >= 4 || typeof value !== "object") return undefined
	if (Array.isArray(value))
		return value
			.slice(0, 20)
			.map((item) => sanitizeValue(item, masking, depth + 1))
			.filter((item) => item !== undefined)
	const result: Record<string, unknown> = Object.create(null)
	for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
		const safeKey = redactFreeText(key, 64)
		if (SENSITIVE_KEY.test(key)) {
			result[safeKey] = "[redacted]"
			continue
		}
		const sanitized = sanitizeValue(item, masking, depth + 1)
		if (sanitized !== undefined) result[safeKey] = sanitized
	}
	return result
}

/**
 * Custom metadata: sensitive keys removed at any depth, strings redacted (and
 * masked entirely under `full`), bounded in depth, breadth and size.
 */
export function sanitizeCustomMetadata(
	metadata: Record<string, unknown> | undefined,
	masking: ResolvedMasking
): Record<string, unknown> | undefined {
	if (!metadata || typeof metadata !== "object") return undefined
	// Keys and numbers can themselves contain customer data. Regexes and
	// masking only string values cannot make arbitrary metadata safe in full.
	if (masking.profile === "full") return { redacted: true }
	try {
		const sanitized = sanitizeValue(metadata, masking, 0) as Record<string, unknown>
		return JSON.stringify(sanitized).length > MAX_METADATA_JSON ? { truncated: true } : sanitized
	} catch {
		return { unserializable: true }
	}
}

export interface NormalizedCustomAction {
	type: string
	action: string
	/** Sanitized with the session's page references; undefined when not given. */
	path?: string
	metadata?: Record<string, unknown>
}

/** One normalized form of a `logAction` event, shared by activity and recording. */
export function normalizeCustomAction(
	event: { type?: string; action?: string; path?: string; metadata?: Record<string, unknown> },
	masking: ResolvedMasking
): NormalizedCustomAction {
	return {
		type:
			masking.profile === "full" ? "custom" : redactFreeText(String(event.type ?? "custom"), 64),
		action:
			masking.profile === "full"
				? "Custom action"
				: redactFreeText(String(event.action ?? event.type ?? ""), 200),
		path: typeof event.path === "string" ? sanitizeCaptureUrl(event.path, masking) : undefined,
		metadata: sanitizeCustomMetadata(event.metadata, masking),
	}
}

/**
 * An uncaught error as recorded: only its category under `full`, otherwise the
 * redacted, bounded message.
 */
export function describeCapturedError(
	name: string | undefined,
	message: string | undefined,
	masking: ResolvedMasking
): string {
	const category = [
		"Error",
		"TypeError",
		"RangeError",
		"ReferenceError",
		"SyntaxError",
		"URIError",
		"EvalError",
		"AggregateError",
	].includes(name ?? "")
		? name!
		: "Error"
	if (masking.profile === "full") return category
	return redactFreeText(message || category, 300)
}

/**
 * Console arguments as recorded: masked under `full`, otherwise redacted and
 * bounded. Stack traces are never recorded.
 */
export function sanitizeConsoleArguments(
	args: unknown,
	profile: ResolvedMasking["profile"]
): string[] {
	if (profile === "full") return ["[console output masked]"]
	if (!Array.isArray(args)) return []
	return args
		.slice(0, 10)
		.map((arg) => sanitizeConsoleArgument(typeof arg === "string" ? arg : String(arg), profile))
}

/** A stack frame line: V8 `    at fn (url:1:2)`, Firefox/Safari `fn@url:1:2`. */
const STACK_FRAME = /^\s*at\s|@\S*:\d+:\d+\)?\s*$/

/**
 * One console argument as rrweb stringified it. Elements and events arrive as
 * their outerHTML (input values, tokens and masked text included), errors as
 * their stack, objects as JSON: none of that may bypass DOM masking or the
 * metadata rules.
 */
function sanitizeConsoleArgument(text: string, profile: ResolvedMasking["profile"]): string {
	const trimmed = text.trim()
	if (/^<[A-Za-z!/]/.test(trimmed) && trimmed.includes(">")) return "[element]"
	if (/^[{[]/.test(trimmed)) {
		try {
			const parsed: unknown = JSON.parse(trimmed)
			const sanitized = sanitizeValue(parsed, { profile } as ResolvedMasking, 0)
			const json = JSON.stringify(sanitized ?? null)
			return json.length > 300 ? "[object]" : json
		} catch {
			// Truncated or not JSON: treated as text below.
		}
	}
	const lines = trimmed.split("\n").filter((line) => !STACK_FRAME.test(line))
	return redactFreeText(lines.join("\n"), 300)
}
