/**
 * Recording privacy masking engine.
 *
 * Resolves the dashboard-owned capture snapshot delivered with a session into
 * rrweb record options, and provides privacy-aware element descriptors for the
 * activity logger so replay masking and log text can never disagree.
 *
 * New sessions use only the administrator snapshot. Developer markers are
 * inert labels unless selected in Settings. Pre-migration sessions preserve
 * their original marker semantics until they end.
 *
 * Precedence, strongest first:
 *   1. sensitive inputs (password, one-time code, card, SSN-like): always masked
 *   2. developer `devora-mask` / `devora-block` markers and administrator
 *      mask / block selectors
 *   3. administrator unmask regions and selectors
 *   4. the masking profile (`full`, `partial`, `minimal`)
 *
 * Implemented on upstream rrweb primitives: `maskTextSelector` selects which
 * text is masked, and `maskTextFn(text, element)` / `maskInputFn(text, element)`
 * make the final per-element decision (which is how unmask works without a fork).
 *
 * @module @devorash/browser
 */

import {
	DEVORA_PRIVACY_MARKERS,
	type DevoraCaptureSnapshot,
	type DevoraMaskingProfile,
} from "@devorash/core"

const M = DEVORA_PRIVACY_MARKERS

/**
 * Capture-time CSS/identifier sanitizer. Implemented by
 * `./serialization-privacy.js`, which the recorder loads lazily together with
 * rrweb — this module must not import it, or the CSS parser lands in the
 * eager bundle every visitor downloads whether or not they are ever recorded.
 */
export interface SerializationSanitizer {
	identifier(kind: "class" | "id" | "symbol" | "variable" | "tag", value: string): string
	tag(value: string): string
	property(value: string): string | null
	declarationValue(
		property: string,
		value: string
	): { property: string; value: string; priority: string } | null
	css(source: string, inline?: boolean): string
	/** Budget degradations so far; the recorder reports them without stopping capture. */
	readonly degraded: readonly string[]
	degrade(reason: string): void
}

/** Developer markers that always mask, in every profile. */
const HARDEN_MASK_SELECTORS = [`.${M.MASK_CLASS}`, `[${M.MASK_ATTR}]`]
/** Developer markers that always block, in every profile. */
const HARDEN_BLOCK_SELECTORS = [`.${M.BLOCK_CLASS}`, `[${M.BLOCK_ATTR}]`]

/** Media elements blocked by `recordingBlockMedia`. */
const MEDIA_SELECTORS = ["img", "svg", "video", "audio", "object", "picture", "embed"]

/** Region names are opaque tokens; anything else is ignored rather than interpolated. */
const REGION_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

/**
 * Input `autocomplete` values that always count as sensitive.
 * https://developer.mozilla.org/docs/Web/HTML/Attributes/autocomplete
 */
const SENSITIVE_AUTOCOMPLETE = new Set([
	"current-password",
	"new-password",
	"one-time-code",
	"cc-number",
	"cc-csc",
	"cc-exp",
	"cc-exp-month",
	"cc-exp-year",
	"cc-name",
	"cc-given-name",
	"cc-additional-name",
	"cc-family-name",
	"cc-type",
])

/** name/id/aria-label/placeholder heuristics for sensitive fields. */
const SENSITIVE_NAME_PATTERN =
	/passw|passcode|card|cvv|cvc|csc|ssn|social.?security|secret|token|iban|routing|account.?number|otp|one.?time|verification.?code|\bpin\b/i

/** Input types that are sensitive on their own. */
// Hidden inputs carry CSRF tokens, SAML responses and OAuth state: never recorded.
const SENSITIVE_INPUT_TYPES = new Set(["password", "tel", "email", "hidden"])

/** Rich-text editors: text typed here is treated like input values. */
const EDITABLE_SELECTOR = '[contenteditable]:not([contenteditable="false"])'

/** Standard HTML element names; anything else is described generically. */
const STANDARD_TAGS = new Set(
	"a abbr address area article aside audio b bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr html i iframe img input ins kbd label legend li main map mark menu meter nav object ol optgroup option output p picture pre progress q rp rt ruby s samp search section select slot small source span strong sub summary sup svg table tbody td template textarea tfoot th thead time tr track u ul var video wbr path g circle rect line polyline polygon use".split(
		" "
	)
)

/** Resolved masking rules consumed by the recorder and the activity logger. */
export interface ResolvedMasking {
	settingsOnly?: boolean
	profile: DevoraMaskingProfile
	/** Policy version the rules came from (0 when no snapshot was delivered). */
	policyVersion: number
	/** Combined selector list for explicitly masked elements (developer markers + administrator list). */
	maskSelector: string
	/** Combined selector list for administrator-revealed elements; empty when nothing is revealed. */
	unmaskSelector: string
	/** Combined selector for blocked elements. */
	blockSelector: string | undefined
	/**
	 * Block selectors that can carry text (developer markers + administrator
	 * list) without the media tags: an icon inside a button is blocked from the
	 * replay but does not make the button's own label sensitive.
	 */
	textBlockSelector: string | undefined
	blockAllMedia: boolean
	/** Administrator selectors the browser could not parse; dropped, never applied loosely. */
	dropped: string[]
}

/** Subset of rrweb record options controlled by the masking engine. */
export interface RrwebPrivacyOptions {
	maskTextClass: string | RegExp
	maskTextSelector: string | undefined
	maskTextFn: (text: string, element: HTMLElement | null) => string
	maskAllInputs: boolean
	maskInputFn: (text: string, element: HTMLElement) => string
	blockClass: string | RegExp
	blockSelector: string | undefined
	ignoreClass: string
	ignoreSelector: string
	slimDOMOptions?: "all"
	/** Sanitize serialized attributes, including incremental rrweb mutations. */
	sanitizeAttributes?: (
		attributes: Record<string, unknown>,
		element: Element | null
	) => Record<string, unknown>
	sanitizeTitle?: (title: string) => string
	sanitizeUrl?: (url: string) => string
	/** The resolved masking profile, for free-form channels such as console output. */
	profile?: ResolvedMasking["profile"]
	/** Attached by the recorder once the lazily loaded sanitizer module is ready. */
	serialization?: SerializationSanitizer
}

const pageReferences = new WeakMap<ResolvedMasking, Map<string, string>>()

/** Full capture uses bounded, per-session page references: route parameters,
 * tenant hostnames and credentials are not safe merely because queries were removed.
 * The same rules object is shared by recording and activity, preserving correlation. */
export function sanitizeCaptureUrl(value: string, rules: ResolvedMasking): string {
	const fallback = "https://recording.invalid/page-redacted"
	if (value.length > 2048) return fallback
	try {
		const base = typeof location === "undefined" ? "https://recording.invalid" : location.href
		const url = new URL(value, base)
		if (url.protocol !== "http:" && url.protocol !== "https:") return fallback
		const key = `${url.origin}${url.pathname}`
		if (rules.profile !== "full") return key
		let pages = pageReferences.get(rules)
		if (!pages) {
			pages = new Map()
			pageReferences.set(rules, pages)
		}
		const known = pages.get(key)
		if (known) return known
		if (pages.size >= 256) return fallback
		const ref = `https://recording.invalid/page-${pages.size + 1}`
		pages.set(key, ref)
		return ref
	} catch {
		return fallback
	}
}

function maskText(text: string): string {
	// Preserve whitespace so layout/word shape survives; mask every other char.
	return text.replace(/\S/g, "*")
}

function joinSelectors(selectors: string[]): string {
	return selectors.filter((s) => typeof s === "string" && s.trim().length > 0).join(", ")
}

/**
 * Keep only selectors the browser can parse. Outside a document (SSR, tests)
 * the list is accepted as-is; the server already applied structural checks.
 */
function parseableSelectors(selectors: readonly string[] | undefined): {
	valid: string[]
	dropped: string[]
} {
	const valid: string[] = []
	const dropped: string[] = []
	for (const raw of selectors ?? []) {
		const selector = typeof raw === "string" ? raw.trim() : ""
		if (!selector) continue
		if (typeof document === "undefined" || typeof document.querySelector !== "function") {
			valid.push(selector)
			continue
		}
		try {
			document.querySelector(selector)
			valid.push(selector)
		} catch {
			dropped.push(selector)
		}
	}
	return { valid, dropped }
}

/** Resolve the session's capture snapshot into concrete rules. */
export function resolveMasking(capture: DevoraCaptureSnapshot | undefined): ResolvedMasking {
	const profile: DevoraMaskingProfile = capture?.recordingMaskingProfile ?? "full"
	// The full profile always blocks media; without a snapshot everything is strict.
	const blockAllMedia = profile === "full" ? true : capture?.recordingBlockMedia !== false

	const mask = parseableSelectors(capture?.recordingMaskSelectors)
	const block = parseableSelectors(capture?.recordingBlockSelectors)
	const unmask = parseableSelectors(capture?.recordingUnmaskSelectors)
	const regions = (capture?.recordingUnmaskRegions ?? [])
		.filter((name) => typeof name === "string" && REGION_NAME_PATTERN.test(name))
		.map((name) => `[${M.REGION_ATTR}="${name}"]`)

	const hardenMask = capture?.settingsOnly === true ? [] : HARDEN_MASK_SELECTORS
	const hardenBlock = capture?.settingsOnly === true ? [] : HARDEN_BLOCK_SELECTORS
	const textBlockSelector = joinSelectors([...hardenBlock, ...block.valid]) || undefined
	return {
		profile,
		settingsOnly: capture?.settingsOnly === true,
		policyVersion: capture?.policyVersion ?? 0,
		maskSelector: joinSelectors([...hardenMask, ...mask.valid]),
		unmaskSelector: joinSelectors([...regions, ...unmask.valid]),
		blockSelector:
			joinSelectors([...hardenBlock, ...block.valid, ...(blockAllMedia ? MEDIA_SELECTORS : [])]) ||
			undefined,
		textBlockSelector,
		blockAllMedia,
		dropped: [...mask.dropped, ...block.dropped, ...unmask.dropped],
	}
}

/**
 * `closest()` across the composed tree: a selector on a shadow host or on an
 * iframe element also applies inside its shadow root or same-origin document,
 * where plain `closest()` stops.
 */
function safeCloses(
	element: Element | null | undefined,
	selector: string,
	onUncertain = true
): boolean {
	if (!selector) return false
	let current: Element | null | undefined = element
	for (let hops = 0; current && hops < 32; hops++) {
		if (typeof current.closest !== "function") return onUncertain
		try {
			if (current.closest(selector) !== null) return true
		} catch {
			return onUncertain
		}
		let next: Element | null = null
		try {
			const root = current.getRootNode?.() as (Node & { host?: Element }) | undefined
			if (root && root.host) next = root.host
			else next = (current.ownerDocument?.defaultView?.frameElement as Element | null) ?? null
		} catch {
			// An inaccessible ancestor cannot prove that a mask is absent or
			// that an unmask rule applies.
			return onUncertain
		}
		current = next
	}
	// A still-live ancestor means the traversal budget was exhausted. Masks
	// fail closed; unmask rules must actually match before revealing content.
	return current ? onUncertain : false
}

/** Whether the element sits inside a rich-text editor. */
function isEditable(element: Element | null | undefined): boolean {
	return safeCloses(element, EDITABLE_SELECTOR)
}

/** Whether an element (or an ancestor) is revealed by an administrator unmask rule. */
export function isUnmasked(element: Element | null | undefined, rules: ResolvedMasking): boolean {
	return safeCloses(element, rules.unmaskSelector, false)
}

/** Whether an element (or an ancestor) matches a developer marker or administrator mask selector. */
export function isExplicitlyMasked(
	element: Element | null | undefined,
	rules: ResolvedMasking
): boolean {
	return safeCloses(element, rules.maskSelector)
}

/** SSR-safe field reads that work on real DOM elements and duck-typed fakes. */
function elementTag(element: Element | null | undefined): string {
	return element?.tagName?.toLowerCase() ?? ""
}

function elementAttr(element: Element | null | undefined, name: string): string {
	try {
		return element?.getAttribute?.(name) ?? ""
	} catch {
		return ""
	}
}

/**
 * Sensitive-field detection: the floor that no profile, region or selector can
 * lower. Passwords, one-time codes, payment cards and SSN-like fields.
 */
export function isSensitiveInput(element: Element | null | undefined): boolean {
	const tag = elementTag(element)
	// rrweb routes <select> values through maskInputFn too, so the same floor
	// (`autocomplete="cc-exp-month"`, card-like names) must apply to it.
	if (tag !== "input" && tag !== "textarea" && tag !== "select") return false
	if (tag === "input") {
		const type = elementAttr(element, "type").toLowerCase()
		if (SENSITIVE_INPUT_TYPES.has(type)) return true

		if (
			elementAttr(element, "inputmode").toLowerCase() === "numeric" &&
			/otp|code/i.test(elementAttr(element, "name"))
		)
			return true
	}
	if (
		elementAttr(element, "autocomplete")
			.toLowerCase()
			.split(/\s+/)
			.some((token) => SENSITIVE_AUTOCOMPLETE.has(token))
	)
		return true
	const descriptor = [
		elementAttr(element, "name"),
		element?.id ?? "",
		elementAttr(element, "aria-label"),
		elementAttr(element, "placeholder"),
		elementAttr(element, "data-devora-field"),
	].join(" ")
	return SENSITIVE_NAME_PATTERN.test(descriptor)
}

/**
 * Whether text content of an element is masked under the resolved rules.
 * Mirrors the decision the recorder makes, for use by the activity logger.
 */
export function isTextMasked(element: Element | null | undefined, rules: ResolvedMasking): boolean {
	if (isExplicitlyMasked(element, rules)) return true
	if (isUnmasked(element, rules)) return false
	// Editor content is typed input, so it follows the input rule.
	if (isEditable(element)) return rules.profile !== "minimal"
	return rules.profile === "full"
}

/** Whether an input value is masked under the resolved rules. */
export function isInputMasked(
	element: Element | null | undefined,
	rules: ResolvedMasking
): boolean {
	if (isSensitiveInput(element)) return true
	if (isExplicitlyMasked(element, rules)) return true
	if (isUnmasked(element, rules)) return false
	return rules.profile !== "minimal"
}

/**
 * Build the rrweb record options implementing the resolved rules.
 *
 * `serialization` is normally attached later by the recorder (see
 * `SessionRecorder.startRrweb`), so this stays synchronous and free of the
 * CSS parser; the attribute hook reads it at call time and fails closed if it
 * is still missing.
 */
export function buildRrwebPrivacyOptions(
	rules: ResolvedMasking,
	serialization?: SerializationSanitizer
): RrwebPrivacyOptions {
	const options: RrwebPrivacyOptions = {
		serialization,
		maskTextClass: rules.settingsOnly ? /(?!)/ : M.MASK_CLASS,
		// rrweb's selector prefilter does not cross shadow/iframe boundaries.
		// Always invoke our composed-tree predicate, including partial/minimal
		// profiles, so an explicit mask on a host cannot be bypassed inside it.
		maskTextSelector: "*",
		maskTextFn: (text, element) => (isTextMasked(element, rules) ? maskText(text) : text),
		// All inputs run through maskInputFn so the sensitive floor and unmask
		// decisions are central.
		maskAllInputs: true,
		maskInputFn: (text, element) => (isInputMasked(element, rules) ? "***" : text),
		blockClass: rules.settingsOnly ? /(?!)/ : M.BLOCK_CLASS,
		blockSelector: rules.blockSelector,
		ignoreClass: rules.settingsOnly ? "" : M.IGNORE_CLASS,
		ignoreSelector: rules.settingsOnly ? ":not(*)" : `[${M.IGNORE_ATTR}]`,
		slimDOMOptions: "all",
		sanitizeAttributes: (attributes, element) =>
			sanitizeAttributes(attributes, element, rules, requireSerializer(options)),
		sanitizeTitle: (title) => (rules.profile === "full" ? "***" : title.slice(0, 500)),
		sanitizeUrl: (url) => sanitizeCaptureUrl(url, rules),
		profile: rules.profile,
	}
	return options
}

/** The recorder never records before the sanitizer is attached; anything else is a bug and fails closed. */
export function requireSerializer(options: RrwebPrivacyOptions): SerializationSanitizer {
	if (!options.serialization) throw new Error("Recording privacy sanitizer is not loaded")
	return options.serialization
}

// ============================================================================
// Privacy-aware element descriptors (shared with the activity logger)
// ============================================================================

export interface ElementDescriptor {
	/** Human-readable description, e.g. `Clicked "Submit order"` or `Clicked button#save`. */
	description: string
	/** Element tag (plus id when present), e.g. `button#save`. */
	elementType: string
	/** Visible text or accessible name — only present when the element is unmasked. */
	elementText?: string
	/** ARIA role when present. */
	elementRole?: string
}

const ACTIONABLE_SELECTOR =
	"button, a, [role='button'], [role='link'], [role='menuitem'], input, select, textarea, summary, label"

/**
 * Describe a clicked element without leaking masked content.
 * Text/accessible names are only included when the element is unmasked under
 * the same rules the recorder applies.
 */
export function describeElement(target: Element, rules: ResolvedMasking): ElementDescriptor {
	const element = (target.closest?.(ACTIONABLE_SELECTOR) ?? target) as Element
	const tag = element.tagName?.toLowerCase() ?? "element"
	// IDs and free-form roles are identifiers, not safe labels: they often
	// contain customer data even when visible text is masked. Custom element
	// names are identifiers too (the recorder maps them to opaque names).
	const elementType = STANDARD_TAGS.has(tag) ? tag : "element"
	const role = element.getAttribute?.("role") ?? ""
	const elementRole = /^(button|link|menuitem|checkbox|radio|switch|tab|option)$/.test(role)
		? role
		: undefined
	// Media inside the control is blocked from the replay but carries no text, so
	// an icon must not turn "Save changes" into an unlabeled click. Text-bearing
	// block markers (developer/administrator) still suppress the label.
	const selector = joinSelectors([rules.maskSelector, rules.textBlockSelector ?? ""])
	let protectedDescendant = false
	try {
		protectedDescendant = !!element.querySelector?.(selector)
	} catch {
		protectedDescendant = true
	}
	const blocked = rules.textBlockSelector
		? safeCloses(target, rules.textBlockSelector) || safeCloses(element, rules.textBlockSelector)
		: false
	const masked =
		blocked ||
		protectedDescendant ||
		isSensitiveInput(element) ||
		isTextMasked(target, rules) ||
		isTextMasked(element, rules)

	if (!masked) {
		const innerText = (element as HTMLElement).innerText
		// Only the control's own accessible attributes count; `alt`/`title` of a
		// blocked image inside it are never read.
		const label =
			elementAttr(element, "aria-label").trim() ||
			(typeof innerText === "string" ? innerText.trim() : "") ||
			elementAttr(element, "alt").trim() ||
			elementAttr(element, "title").trim() ||
			""
		const text = label.replace(/\s+/g, " ").slice(0, 50)
		if (text) {
			return {
				description: `Clicked "${text}"`,
				elementType,
				elementText: text,
				elementRole,
			}
		}
	}

	return { description: `Clicked ${elementType}`, elementType, elementRole }
}

const BOOLEAN_ATTRIBUTES = new Set(
	"disabled readonly checked selected multiple open hidden".split(" ")
)
const NUMBER_ATTRIBUTES = new Set(
	"width height colspan rowspan rr_width rr_height rr_scrollLeft rr_scrollTop rr_mediaCurrentTime".split(
		" "
	)
)
const INPUT_TYPES = new Set(
	"button checkbox color date datetime-local email file hidden image month number password radio range reset search submit tel text time url week".split(
		" "
	)
)
const ROLES = new Set(
	"button link menuitem checkbox radio switch tab option dialog navigation main banner complementary contentinfo list listitem table row cell columnheader rowheader grid gridcell presentation none status alert progressbar textbox combobox searchbox slider spinbutton separator tree treeitem tablist tabpanel menu menubar img heading group region tooltip".split(
		" "
	)
)

/**
 * SVG geometry/presentation attributes: numbers and lengths, transform lists,
 * and closed keyword sets only — never author identifiers, `url(#…)` references
 * or quoted text. Filter-chain names (`in`, `result`) are limited to the
 * standard inputs, so a custom chain degrades rather than leaking a name.
 */
const SVG_NUMERIC_ATTRIBUTES = new Set(
	"cx cy r rx ry x y x1 y1 x2 y2 dx dy points stroke-width stroke-dasharray stroke-dashoffset opacity fill-opacity stroke-opacity pathLength markerWidth markerHeight refX refY offset stdDeviation k1 k2 k3 k4 values tabindex".split(
		" "
	)
)
const SVG_NUMERIC_VALUE = /^[-+.,\s\d%eE]{0,2000}(?:px|em)?$/
const SVG_TRANSFORM_ATTRIBUTES = new Set(["transform", "gradientTransform", "patternTransform"])
// Length-capped before the regex runs, and whitespace is only ever consumed
// on one side of a function so no two optional groups compete for the same
// run of spaces: `transform` is reachable from user-generated inline SVG and
// an ambiguous pattern backtracks super-linearly.
const SVG_TRANSFORM_MAX_LENGTH = 2000
const SVG_TRANSFORM_VALUE =
	/^\s*(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([-+.,\s\deE]{0,200}\)[\s,]*){0,20}$/
const SVG_KEYWORD_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
	"stroke-linecap": new Set(["butt", "round", "square"]),
	"stroke-linejoin": new Set(["miter", "round", "bevel", "arcs", "miter-clip"]),
	"fill-rule": new Set(["nonzero", "evenodd"]),
	"clip-rule": new Set(["nonzero", "evenodd"]),
	patternUnits: new Set(["userSpaceOnUse", "objectBoundingBox"]),
	gradientUnits: new Set(["userSpaceOnUse", "objectBoundingBox"]),
	clipPathUnits: new Set(["userSpaceOnUse", "objectBoundingBox"]),
	maskUnits: new Set(["userSpaceOnUse", "objectBoundingBox"]),
	mode: new Set(
		"normal multiply screen darken lighten overlay color-dodge color-burn hard-light soft-light difference exclusion hue saturation color luminosity".split(
			" "
		)
	),
	operator: new Set("over in out atop xor lighter arithmetic erode dilate".split(" ")),
	in: new Set(
		"SourceGraphic SourceAlpha BackgroundImage BackgroundAlpha FillPaint StrokePaint".split(" ")
	),
	in2: new Set(
		"SourceGraphic SourceAlpha BackgroundImage BackgroundAlpha FillPaint StrokePaint".split(" ")
	),
}
const SVG_PRESERVE_ASPECT_RATIO =
	/^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?:\s+(?:meet|slice))?$/
/** `type` on SVG filter/animation primitives; input types are handled separately. */
const SVG_TYPE_VALUES = new Set(
	"matrix saturate hueRotate luminanceToAlpha translate scale rotate skewX skewY fractalNoise turbulence".split(
		" "
	)
)
/** SVG paint attributes are colors and go through the CSS value sanitizer. */
const SVG_PAINT_ATTRIBUTES = new Set([
	"fill",
	"stroke",
	"stop-color",
	"flood-color",
	"lighting-color",
])

function structuralAttribute(name: string, value: unknown): string | undefined {
	const text = String(value)
	if (BOOLEAN_ATTRIBUTES.has(name)) return ""
	if (NUMBER_ATTRIBUTES.has(name) && /^-?\d{1,7}(?:\.\d{1,5})?(?:px|%)?$/.test(text)) return text
	if (name === "type") {
		if (INPUT_TYPES.has(text.toLowerCase())) return text.toLowerCase()
		return SVG_TYPE_VALUES.has(text) ? text : undefined
	}
	if (SVG_NUMERIC_ATTRIBUTES.has(name) && SVG_NUMERIC_VALUE.test(text)) return text
	if (
		SVG_TRANSFORM_ATTRIBUTES.has(name) &&
		text.length <= SVG_TRANSFORM_MAX_LENGTH &&
		SVG_TRANSFORM_VALUE.test(text)
	)
		return text
	// DOM attribute names are attacker-controlled; never resolve inherited
	// object members such as constructor/__proto__ as attribute allowlists.
	if (Object.hasOwn(SVG_KEYWORD_ATTRIBUTES, name) && SVG_KEYWORD_ATTRIBUTES[name]?.has(text))
		return text
	if (name === "preserveAspectRatio" && SVG_PRESERVE_ASPECT_RATIO.test(text)) return text
	if (name === "role" && ROLES.has(text.toLowerCase())) return text.toLowerCase()
	if (name === "dir" && /^(ltr|rtl|auto)$/.test(text)) return text
	if (name === "rr_mediaState" && /^(played|paused)$/.test(text)) return text
	if (name === "viewBox" && /^[-.\d,\s]{1,100}$/.test(text)) return text
	if (name === "d" && /^[MmZzLlHhVvCcSsQqTtAaEe\d.,+\s-]{1,100000}$/.test(text)) return text
	if (
		name === "xmlns" &&
		["http://www.w3.org/2000/svg", "http://www.w3.org/1999/xhtml"].includes(text)
	)
		return text
	return undefined
}

function sanitizeAttributes(
	attributes: Record<string, unknown>,
	element: Element | null,
	rules: ResolvedMasking,
	serialization: SerializationSanitizer
): Record<string, unknown> {
	const result: Record<string, unknown> = {}
	const hardMasked =
		isExplicitlyMasked(element, rules) ||
		(rules.blockSelector ? safeCloses(element, rules.blockSelector) : false)
	for (const [name, value] of Object.entries(attributes)) {
		// Never replay navigation, embedded documents, event handlers or custom
		// data. These fields can hold bearer secrets independently of visible text.
		if (
			/^(on|data-)/i.test(name) ||
			/^(href|action|formaction|srcdoc|nonce|integrity|name|for)$/i.test(name)
		)
			continue
		if (value === null) {
			if (
				[
					"class",
					"id",
					"style",
					"_cssText",
					"value",
					"title",
					"alt",
					"placeholder",
					"aria-label",
					"aria-description",
					"src",
					"poster",
				].includes(name) ||
				BOOLEAN_ATTRIBUTES.has(name) ||
				NUMBER_ATTRIBUTES.has(name)
			)
				result[name] = null
			continue
		}
		if (name === "value") {
			result[name] = !element || isInputMasked(element, rules) ? "***" : value
		} else if (/^(title|alt|placeholder|aria-label|aria-description)$/i.test(name)) {
			result[name] =
				!element || isTextMasked(element, rules) || isSensitiveInput(element) ? "***" : value
		} else if (name === "src" || name === "poster") {
			if (!element || hardMasked || rules.blockAllMedia || isTextMasked(element, rules)) continue
			try {
				const url = new URL(
					String(value),
					typeof location === "undefined" ? "https://recording.invalid" : location.href
				)
				if (url.protocol !== "https:" && url.protocol !== "http:") continue
				url.username = ""
				url.password = ""
				url.search = ""
				url.hash = ""
				result[name] = url.href
			} catch {
				/* Malformed resource references are omitted. */
			}
		} else if (name === "class" || name === "id") {
			result[name] =
				name === "class"
					? String(value)
							.split(/\s+/)
							.filter(Boolean)
							.map((token) => serialization.identifier("class", token))
							.join(" ")
					: serialization.identifier("id", String(value))
		} else if (name === "_cssText") {
			result[name] = serialization.css(String(value))
		} else if (name === "style") {
			if (typeof value === "string") result[name] = serialization.css(value, true)
			else if (value && typeof value === "object" && !Array.isArray(value)) {
				let entries = Object.entries(value)
				if (entries.length > 1000) {
					// Keep the first thousand declarations rather than ending the recording.
					serialization.degrade("style_budget")
					entries = entries.slice(0, 1000)
				}
				const style: Record<string, unknown> = {}
				for (const [property, raw] of entries) {
					const mapped = serialization.property(property)
					if (!mapped) continue
					if (raw === false) {
						style[mapped] = false
						continue
					}
					const parsed = serialization.declarationValue(
						property,
						String(Array.isArray(raw) ? raw[0] : raw)
					)
					style[mapped] = parsed
						? [
								parsed.value,
								Array.isArray(raw) && raw[1] === "important" ? "important" : parsed.priority,
							]
						: false
				}
				result[name] = style
			}
		} else if (SVG_PAINT_ATTRIBUTES.has(name)) {
			const parsed = serialization.declarationValue(name, String(value))
			if (parsed) result[name] = parsed.value
		} else {
			const safe = structuralAttribute(name, value)
			if (safe !== undefined) result[name] = safe
		}
	}
	return result
}
