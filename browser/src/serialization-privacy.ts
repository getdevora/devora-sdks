import { CSS_KEYWORDS, CSS_PROPERTIES } from "./css-privacy-grammar.js"
import type { SerializationSanitizer } from "./masking.js"
import type * as css from "css-tree"
import parse from "css-tree/parser"
import generate from "css-tree/generator"
import walk from "css-tree/walker"
import { ident } from "css-tree/utils"

/**
 * Internal signal that a parsing or identifier budget was hit. Never escapes
 * this module: every public method degrades to an opaque, structure-free
 * result and records the reason in `degraded` instead of throwing, so a
 * budget breach cannot end a recording.
 */
export class PrivacyBudgetError extends Error {}
const MAX_CSS_LENGTH = 1_000_000
const MAX_CSS_CACHE_CHARS = 2_000_000
const MAX_IDENTIFIERS = 20_000
const MAX_IDENTIFIER_CHARS = 1_000_000
const MAX_IDENTIFIER_LENGTH = 1024
const MAX_CSS_TOKENS = 250_000
const MAX_CSS_NESTING = 64
const EMPTY_RULE = ":not(*){}"
const HTML_TAGS = new Set(
	"html head body title style link meta base div span p a button input select option optgroup textarea label form fieldset legend output datalist progress meter main header footer nav aside section article h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table thead tbody tfoot tr td th caption col colgroup details summary dialog address blockquote pre code kbd samp var strong em b i u s small sub sup mark time abbr cite q ruby rt rp br hr wbr figure figcaption picture img video audio source track canvas iframe object embed template slot noscript script svg path circle rect line polyline polygon ellipse g defs use symbol text tspan clipPath mask linearGradient radialGradient stop foreignObject menu search del ins hgroup bdi bdo data map area center nobr math filter pattern image textPath marker view desc metadata switch animate animateTransform feGaussianBlur feOffset feBlend feColorMatrix feFlood feComposite feMerge feMergeNode feDropShadow feMorphology feTurbulence feDisplacementMap".split(
		" "
	)
)
const PSEUDOS = new Set(
	"not is where has nth-child nth-of-type nth-last-child nth-last-of-type first-child last-child only-child first-of-type last-of-type only-of-type empty root scope hover active focus focus-visible focus-within disabled enabled checked indeterminate required optional valid invalid placeholder-shown read-only read-write link visited any-link target defined fullscreen before after selection marker first-line first-letter placeholder backdrop file-selector-button host host-context slotted part -webkit-scrollbar -webkit-scrollbar-thumb -webkit-scrollbar-track -webkit-scrollbar-button -webkit-scrollbar-corner -webkit-input-placeholder -moz-placeholder -ms-input-placeholder -webkit-search-cancel-button -webkit-search-decoration -webkit-autofill -moz-focus-inner -moz-selection -webkit-details-marker autofill popover-open modal open closed".split(
		" "
	)
)
const FUNCTIONS = new Set(
	"var calc min max clamp round mod rem abs sign pow sqrt hypot log exp sin cos tan asin acos atan atan2 rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix light-dark linear-gradient radial-gradient conic-gradient repeating-linear-gradient repeating-radial-gradient repeating-conic-gradient translate translateX translateY translateZ translate3d scale scaleX scaleY scaleZ scale3d rotate rotateX rotateY rotateZ rotate3d skew skewX skewY matrix matrix3d perspective cubic-bezier steps repeat minmax fit-content blur brightness contrast grayscale hue-rotate invert opacity saturate sepia drop-shadow"
		.toLowerCase()
		.split(" ")
)
const UNITS = new Set(
	"px em rem ex ch cap ic lh rlh vw vh vi vb vmin vmax svw svh svi svb svmin svmax lvw lvh lvi lvb lvmin lvmax dvw dvh dvi dvb dvmin dvmax cqw cqh cqi cqb cqmin cqmax cm mm q in pt pc fr deg grad rad turn s ms hz khz dpi dpcm dppx x".split(
		" "
	)
)
const VALUE_NODES = new Set(
	"Value Identifier Number Percentage Dimension Hash Function Operator Parentheses Brackets String Ratio UnicodeRange".split(
		" "
	)
)
const CSS_WIDE = new Set(["inherit", "initial", "unset", "revert", "revert-layer", "none", "auto"])
/** Properties whose values name other properties (`transition: opacity 150ms`). */
const PROPERTY_LIST_PROPERTIES = new Set(["transition", "transition-property", "will-change"])
const MEDIA_FEATURES =
	/^(?:prefers-color-scheme|prefers-reduced-motion|prefers-reduced-transparency|prefers-reduced-data|prefers-contrast|forced-colors|inverted-colors|hover|any-hover|pointer|any-pointer|orientation|resolution|aspect-ratio|display-mode|scripting|update|color-gamut|dynamic-range|width|height|device-width|device-height|color|monochrome|grid)$/
const MEDIA_FEATURE_VALUES = new Set(
	"hover none coarse fine reduce no-preference landscape portrait dark light standalone fullscreen browser minimal-ui more less custom active high low srgb p3 rec2020 slow fast enabled initial-only".split(
		" "
	)
)
/** `@property` syntax descriptors are a closed component grammar, never free text. */
// `@property` syntax descriptors: only the spec's `<type>` components with
// their multipliers, `*`, and `|` separators. Bare author custom-idents
// (`<length> | acme-internal-name`) would otherwise pass verbatim.
const PROPERTY_SYNTAX_COMPONENT =
	/^<(?:length|number|percentage|length-percentage|color|image|url|integer|angle|time|resolution|transform-function|transform-list|custom-ident|string)>[+#]?$/
function propertySyntaxAllowed(syntax: string): boolean {
	if (syntax.length > 200) return false
	const trimmed = syntax.trim()
	if (trimmed === "*") return true
	return trimmed.split("|").every((part) => PROPERTY_SYNTAX_COMPONENT.test(part.trim()))
}
const decode = (value: string) => ident.decode(value)

/** One instance per recording; original identifiers never leave this local map. */
export class SerializationPrivacy implements SerializationSanitizer {
	private identifiers = new Map<string, string>()
	private identifierChars = 0
	private cssCache = new Map<string, string>()
	private cssCacheChars = 0
	private degradedReasons: string[] = []

	/** Reasons a budget forced a lossy (but still opaque) result; empty when lossless. */
	get degraded(): readonly string[] {
		return this.degradedReasons
	}
	degrade(reason: string): void {
		if (!this.degradedReasons.includes(reason)) this.degradedReasons.push(reason)
	}

	identifier(kind: "class" | "id" | "symbol" | "variable" | "tag", value: string): string {
		const key = `${kind}:${value}`
		const known = this.identifiers.get(key)
		if (known) return known
		if (
			value.length > MAX_IDENTIFIER_LENGTH ||
			this.identifiers.size >= MAX_IDENTIFIERS ||
			this.identifierChars + key.length > MAX_IDENTIFIER_CHARS
		) {
			// Past the budget every new identifier of a kind collapses onto one
			// shared token: still opaque, but no longer distinguishable in replay.
			this.degrade("identifier_budget")
			return `dv-${kind}-x`
		}
		const replacement = `dv-${kind}-${this.identifiers.size + 1}`
		this.identifiers.set(key, replacement)
		this.identifierChars += key.length
		return replacement
	}
	tag(value: string): string {
		return HTML_TAGS.has(value.toLowerCase())
			? value.toLowerCase()
			: HTML_TAGS.has(value)
				? value
				: this.identifier("tag", value.toLowerCase())
	}
	property(value: string): string | null {
		const name = decode(value)
		if (name.startsWith("--")) return `--${this.identifier("variable", name)}`
		return CSS_PROPERTIES.has(name.toLowerCase()) ? name.toLowerCase() : null
	}
	private parse(source: string, context: css.ParseOptions["context"]): css.CssNode {
		if (source.length > MAX_CSS_LENGTH) throw new PrivacyBudgetError("css_length")
		let depth = 0
		// Conservative preflight also bounds parser recursion before an AST exists.
		for (const char of source) {
			if (char === "(" || char === "{" || char === "[") {
				if (++depth > MAX_CSS_NESTING) throw new PrivacyBudgetError("css_nesting")
			} else if (char === ")" || char === "}" || char === "]") depth = Math.max(0, depth - 1)
		}
		let tokens = 0
		return parse(source, {
			context,
			parseCustomProperty: true,
			onToken() {
				if (++tokens > MAX_CSS_TOKENS) throw new PrivacyBudgetError("css_tokens")
			},
		})
	}
	private value(ast: css.CssNode, property = ""): boolean {
		let safe = true
		walk(ast, (node) => {
			if (!VALUE_NODES.has(node.type)) {
				safe = false
				return
			}
			if (node.type === "Identifier") {
				const name = decode(node.name)
				const lower = name.toLowerCase()
				node.name = name.startsWith("--")
					? `--${this.identifier("variable", name)}`
					: (CSS_KEYWORDS.has(lower) && !(property === "animation-name" && !CSS_WIDE.has(lower))) ||
						  (PROPERTY_LIST_PROPERTIES.has(property) && CSS_PROPERTIES.has(lower))
						? lower
						: this.identifier("symbol", name)
			} else if (node.type === "Function") {
				const name = decode(node.name).toLowerCase()
				if (!FUNCTIONS.has(name)) safe = false
				node.name = name
			} else if (node.type === "Dimension") {
				node.unit = decode(node.unit).toLowerCase()
				if (!UNITS.has(node.unit) || !Number.isFinite(Number(node.value))) safe = false
			} else if (node.type === "Hash") {
				if (!/^(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(node.value)) safe = false
			} else if (node.type === "String") {
				node.value =
					property === "grid-template-areas"
						? node.value
								.split(/\s+/)
								.map((name) => (/^\.+$/.test(name) ? "." : this.identifier("symbol", name)))
								.join(" ")
						: "***"
			} else if (node.type === "UnicodeRange") safe = false
		})
		return safe
	}
	private declaration(node: css.Declaration): string | null {
		const property = this.property(node.property)
		if (!property) return null
		if (property === "content" || property === "quotes")
			return `${property}:"***"${node.important ? "!important" : ""}`
		if (property === "font-family")
			return `font-family:system-ui,sans-serif${node.important ? "!important" : ""}`
		if (!this.value(node.value, property)) return null
		return `${property}:${generate(node.value)}${node.important ? "!important" : ""}`
	}
	declarationValue(
		property: string,
		value: string
	): { property: string; value: string; priority: string } | null {
		try {
			const ast = this.parse(`${property}:${value}`, "declaration")
			if (ast.type !== "Declaration") return null
			const safe = this.declaration(ast)
			if (!safe) return null
			const colon = safe.indexOf(":")
			return {
				property: safe.slice(0, colon),
				value: safe.slice(colon + 1).replace(/!important$/, ""),
				priority: ast.important ? "important" : "",
			}
		} catch (error) {
			if (error instanceof PrivacyBudgetError) this.degrade(error.message)
			return null
		}
	}
	private selector(ast: css.CssNode, keyframes = false): string {
		let safe = true
		const trustedRaw = new Set<css.CssNode>()
		walk(ast, (node) => {
			switch (node.type) {
				case "Selector":
				case "SelectorList":
				case "Nth":
				case "AnPlusB":
				case "Combinator":
				case "NestingSelector":
				case "Percentage":
					break
				case "Identifier":
					if (!["odd", "even"].includes(node.name)) safe = false
					break
				case "ClassSelector":
					node.name = this.identifier("class", decode(node.name))
					break
				case "IdSelector":
					node.name = this.identifier("id", decode(node.name))
					break
				case "TypeSelector": {
					const name = decode(node.name)
					if (name.includes("|")) safe = false
					else
						node.name =
							name === "*" || (keyframes && (name === "from" || name === "to"))
								? name
								: this.tag(name)
					break
				}
				case "PseudoClassSelector":
				case "PseudoElementSelector":
					node.name = decode(node.name).toLowerCase()
					if (!PSEUDOS.has(node.name)) safe = false
					// css-tree keeps unknown pseudo arguments raw; `::part(name)` is an
					// author identifier and maps like every other one. Nested selectors
					// (`:host(.x)`, `::slotted(span)`) are walked as ordinary children.
					if (node.children) {
						for (const child of node.children.toArray()) {
							if (child.type !== "Raw") continue
							const raw = child.value.trim()
							if (node.name === "part" && /^[\w-]+$/.test(raw)) {
								child.value = this.identifier("symbol", raw)
								trustedRaw.add(child)
							} else safe = false
						}
					}
					break
				case "Raw":
					if (!trustedRaw.has(node)) safe = false
					break
				case "AttributeSelector": {
					const name = decode(node.name.name).toLowerCase()
					if (node.flags !== null) {
						node.flags = decode(node.flags).toLowerCase()
						if (node.flags !== "i" && node.flags !== "s") safe = false
					}
					if (name !== "class" && name !== "id") {
						safe = false
						break
					}
					if (
						node.matcher &&
						node.matcher !== "=" &&
						!(name === "class" && node.matcher === "~=")
					) {
						safe = false
						break
					}
					if (node.value) {
						const raw = node.value.type === "String" ? node.value.value : decode(node.value.name)
						const mapped =
							name === "class"
								? raw
										.split(/\s+/)
										.filter(Boolean)
										.map((value) => this.identifier("class", value))
										.join(" ")
								: this.identifier("id", raw)
						node.value = { type: "String", value: mapped }
					}
					node.name.name = name
					// The nested String/Identifier nodes below are trusted replacements.
					return walk.skip
				}
				default:
					safe = false
			}
		})
		return safe ? generate(ast) : ":not(*)"
	}
	private prelude(ast: css.CssNode, kind: string): string | null {
		let safe = true
		walk(ast, (node) => {
			if (node.type === "Declaration") {
				const value = this.declaration(node)
				if (!value) safe = false
				else Object.assign(node, this.parse(value, "declaration"))
				return walk.skip
			}
			if (node.type === "Layer")
				node.name = node.name
					.split(".")
					.map((name) => this.identifier("symbol", decode(name)))
					.join(".")
			else if (node.type === "Identifier") {
				const name = decode(node.name)
				node.name =
					kind === "keyframes" || kind === "-webkit-keyframes"
						? this.identifier("symbol", name)
						: CSS_KEYWORDS.has(name.toLowerCase()) || CSS_PROPERTIES.has(name.toLowerCase())
							? name.toLowerCase()
							: this.identifier("symbol", name)
			} else if (node.type === "Feature") {
				const name = decode(node.name).toLowerCase()
				if (!CSS_PROPERTIES.has(name.replace(/^(min|max)-/, "")) && !MEDIA_FEATURES.test(name))
					safe = false
				node.name = name
				// Feature keywords (`hover`, `dark`, `standalone`) are a closed set, not
				// author identifiers; anything else is unsafe rather than mapped.
				if (node.value?.type === "Identifier") {
					const value = decode(node.value.name).toLowerCase()
					if (MEDIA_FEATURE_VALUES.has(value)) node.value.name = value
					else safe = false
					return walk.skip
				}
			} else if (node.type === "MediaQuery") {
				if (node.mediaType && !["screen", "print", "all"].includes(node.mediaType)) safe = false
			} else if (node.type === "Dimension") {
				if (!UNITS.has(decode(node.unit).toLowerCase())) safe = false
			} else if (
				![
					"AtrulePrelude",
					"MediaQueryList",
					"Condition",
					"FeatureRange",
					"SupportsDeclaration",
					"LayerList",
					"Number",
					"Percentage",
					"Ratio",
					"Operator",
					"Parentheses",
				].includes(node.type)
			)
				safe = false
		})
		return safe ? generate(ast) : null
	}
	/** `@property --name { syntax; inherits; initial-value }` registers Tailwind v4 defaults. */
	private propertyRule(node: css.Atrule): string {
		const prelude = node.prelude?.type === "AtrulePrelude" ? node.prelude.children.toArray() : []
		const name =
			prelude.length === 1 && prelude[0]?.type === "Identifier" ? decode(prelude[0].name) : ""
		if (!name.startsWith("--") || !node.block) return EMPTY_RULE
		const descriptors: string[] = []
		for (const child of node.block.children.toArray()) {
			if (child.type !== "Declaration") continue
			const descriptor = decode(child.property).toLowerCase()
			const parts = child.value.type === "Value" ? child.value.children.toArray() : []
			if (descriptor === "syntax") {
				const syntax = parts.length === 1 && parts[0]?.type === "String" ? parts[0].value : ""
				descriptors.push(`syntax:"${propertySyntaxAllowed(syntax) ? syntax : "*"}"`)
			} else if (descriptor === "inherits") {
				const flag = parts.length === 1 && parts[0]?.type === "Identifier" ? parts[0].name : ""
				if (flag === "true" || flag === "false") descriptors.push(`inherits:${flag}`)
			} else if (descriptor === "initial-value") {
				if (this.value(child.value, descriptor))
					descriptors.push(`initial-value:${generate(child.value)}`)
			}
		}
		return `@property --${this.identifier("variable", name)}{${descriptors.join(";")}}`
	}
	private block(node: css.CssNode, keyframes = false): string {
		if (!("children" in node) || !node.children) return ""
		return node.children
			.toArray()
			.map((child) => {
				if (child.type === "Declaration") {
					const value = this.declaration(child)
					return value ? value + ";" : ""
				}
				if (child.type === "Rule") {
					const selector =
						child.prelude.type === "SelectorList"
							? child.prelude.children
									.toArray()
									.map((part) => this.selector(part, keyframes))
									.join(",")
							: ":not(*)"
					return `${selector}{${this.block(child.block)}}`
				}
				if (child.type === "Atrule") {
					const name = decode(child.name).toLowerCase()
					if (name === "property") return this.propertyRule(child)
					if (
						![
							"media",
							"supports",
							"container",
							"layer",
							"keyframes",
							"-webkit-keyframes",
							"starting-style",
						].includes(name)
					)
						return EMPTY_RULE
					const prelude = child.prelude ? this.prelude(child.prelude, name) : ""
					if (prelude === null)
						return child.block ? `@media not all{${this.block(child.block)}}` : EMPTY_RULE
					return `@${name}${prelude ? " " + prelude : ""}${child.block ? `{${this.block(child.block, name.endsWith("keyframes"))}}` : ";"}`
				}
				// Comments and unparsed syntax never enter the wire representation.
				return child.type === "Comment" ? "" : EMPTY_RULE
			})
			.filter(Boolean)
			.join("")
	}
	css(source: string, inline = false): string {
		const empty = inline ? "" : EMPTY_RULE
		if (source.length > MAX_CSS_LENGTH) {
			this.degrade("css_length")
			return empty
		}
		const key = `${inline ? "inline:" : "sheet:"}${source}`
		const known = this.cssCache.get(key)
		if (known !== undefined) return known
		let safe: string
		try {
			safe = this.block(this.parse(source, inline ? "declarationList" : "stylesheet"))
		} catch (error) {
			// Over-budget or unparseable input degrades to an empty, structure-free
			// rule; the original text never reaches the wire either way.
			if (error instanceof PrivacyBudgetError) this.degrade(error.message)
			safe = empty
		}
		const cost = key.length + safe.length
		// Repeated inline styles/checkouts avoid re-parsing. Cache eviction never
		// evicts identifier mappings, which must remain stable throughout replay.
		if (cost <= MAX_CSS_CACHE_CHARS) {
			while (
				this.cssCache.size &&
				(this.cssCacheChars + cost > MAX_CSS_CACHE_CHARS || this.cssCache.size >= 512)
			) {
				const oldest = this.cssCache.entries().next().value!
				this.cssCache.delete(oldest[0])
				this.cssCacheChars -= oldest[0].length + oldest[1].length
			}
			this.cssCache.set(key, safe)
			this.cssCacheChars += cost
		}
		return safe
	}
}
