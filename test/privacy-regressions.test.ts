import { expect, test } from "bun:test"
import {
	buildRrwebPrivacyOptions,
	resolveMasking,
	describeElement,
	isInputMasked,
	isSensitiveInput,
	isTextMasked,
	isUnmasked,
} from "../browser/src/masking.ts"
import { sanitizeRrwebEvent } from "../browser/src/session-recorder.ts"
import { SerializationPrivacy } from "../browser/src/serialization-privacy.ts"

test("prototype-named DOM attributes are dropped without ending capture", () => {
	const options = buildRrwebPrivacyOptions(resolveMasking(undefined), new SerializationPrivacy())
	const attributes = JSON.parse(
		'{"constructor":"private","__proto__":"private","toString":"private","width":"20"}'
	)
	const safe = options.sanitizeAttributes!(attributes, element())
	expect(safe).toEqual({ width: "20" })
})

test("uncertain composed ancestry never removes masks or grants an unmask", () => {
	const rules = resolveMasking({
		recordingMaskingProfile: "minimal",
		recordingMaskSelectors: [".private"],
		recordingUnmaskSelectors: [".public"],
	} as any)
	const cycle = {
		tagName: "SPAN",
		closest: () => null,
		getRootNode: (): unknown => ({ host: cycle }),
	} as unknown as Element
	const inaccessible = {
		tagName: "SPAN",
		closest: () => null,
		getRootNode: () => {
			throw new Error("inaccessible ancestor")
		},
	} as unknown as Element
	for (const candidate of [cycle, inaccessible]) {
		expect(isTextMasked(candidate, rules)).toBe(true)
		expect(isUnmasked(candidate, rules)).toBe(false)
	}
})

function element(attributes: Record<string, string> = {}, matches = false): HTMLElement {
	return {
		nodeType: 1,
		tagName: "INPUT",
		id: attributes.id ?? "",
		getAttribute: (name: string) => attributes[name] ?? null,
		closest: () => (matches ? {} : null),
	} as unknown as HTMLElement
}

test("sensitive autocomplete tokens override every masking profile and revealed region", () => {
	for (const profile of ["full", "partial", "minimal"] as const) {
		const options = buildRrwebPrivacyOptions(
			resolveMasking({ recordingMaskingProfile: profile } as any),
			new SerializationPrivacy()
		)
		for (const autocomplete of [
			"billing cc-number",
			"section-checkout shipping cc-csc",
			"section-login one-time-code",
			" BILLING\tCC-NUMBER ",
		]) {
			expect(options.maskInputFn("PRIVATE_VALUE", element({ autocomplete }))).toBe("***")
		}
	}
})

test("full snapshots and incremental attributes exclude free-form data, links and masked labels", () => {
	const attributes = {
		href: "/reset?token=PRIVATE_LINK",
		"aria-label": "PRIVATE_LABEL",
		title: "PRIVATE_TITLE",
		"data-email": "PRIVATE_EMAIL",
		value: "PRIVATE_INPUT",
		class: "rounded button",
		width: "20",
	}
	const options = buildRrwebPrivacyOptions(resolveMasking(undefined), new SerializationPrivacy())
	const node = { type: 2, id: 2, tagName: "input", attributes, childNodes: [] }
	const snapshot = {
		type: 2,
		timestamp: Date.now(),
		data: { node: { type: 0, id: 1, childNodes: [node] } },
	}
	const mutation = {
		type: 3,
		timestamp: Date.now(),
		data: {
			source: 0,
			adds: [{ parentId: 1, nextId: null, node }],
			removes: [],
			texts: [],
			attributes: [{ id: 2, attributes }],
		},
	}
	for (const event of [snapshot, mutation]) {
		const safe = sanitizeRrwebEvent(event as any, options, () => element())
		expect(JSON.stringify(safe)).not.toContain("PRIVATE_")
		expect(JSON.stringify(event)).toContain("PRIVATE_") // mirror data was not mutated
		expect(JSON.stringify(safe)).toContain('"width":"20"')
	}
	expect(options.sanitizeTitle?.("PRIVATE_PAGE_TITLE")).toBe("***")
})

test("click labels never aggregate protected descendants or raw IDs", () => {
	const parent = {
		tagName: "BUTTON",
		id: "private-customer-id",
		innerText: "Open PRIVATE_CHILD",
		closest: () => parent,
		querySelector: () => ({}),
		getAttribute: () => null,
	} as unknown as Element
	const target = {
		tagName: "SPAN",
		closest: (selector: string) => (selector.includes("button,") ? parent : {}),
		getAttribute: () => null,
	} as unknown as Element
	const result = describeElement(
		target,
		resolveMasking({ recordingMaskingProfile: "partial" } as any)
	)
	expect(result.elementText).toBeUndefined()
	expect(result.description).toBe("Clicked button")
	expect(JSON.stringify(result)).not.toContain("PRIVATE_CHILD")
	expect(JSON.stringify(result)).not.toContain("private-customer-id")
})

test("full capture maps private URLs consistently across replay, activity and custom-event paths", async () => {
	const { ActivityLogger } = await import("../browser/src/activity-logger")
	const rules = resolveMasking(undefined)
	const options = buildRrwebPrivacyOptions(rules, new SerializationPrivacy())
	const input = "https://PRIVATE_TENANT.example/reset/PRIVATE_PATH?token=PRIVATE_QUERY#PRIVATE_HASH"
	const safe = sanitizeRrwebEvent(
		{ type: 4, timestamp: 1, data: { href: input, width: 1, height: 1 } } as any,
		options
	) as any
	expect(safe.data.href).toBe("https://recording.invalid/page-1")
	expect(options.sanitizeUrl!(input)).toBe(safe.data.href)
	expect(options.sanitizeUrl!(input.replace("PRIVATE_QUERY", "OTHER_QUERY"))).toBe(safe.data.href)
	expect(options.sanitizeUrl!(input.replace("PRIVATE_PATH", "SECOND_PATH"))).toBe(
		"https://recording.invalid/page-2"
	)
	const logger: any = new ActivityLogger({
		apiUrl: "https://example.invalid",
		apiKey: "test",
		sessionId: "test",
		devoraSessionToken: "test",
		masking: rules,
		captureErrors: false,
		captureCustomEvents: true,
	})
	logger.running = true
	logger.recordPageView(input)
	// logAction normalizes once; activity and recording receive the same form.
	const { normalizeCustomAction } = await import("../browser/src/capture-privacy")
	const normalized = normalizeCustomAction(
		{ type: "custom", action: "safe action", path: input },
		rules
	)
	expect(normalized.path).toBe(safe.data.href)
	logger.logCustomAction(normalized)
	expect(logger.queue).toHaveLength(2)
	for (const event of logger.queue) expect(event.context.url).toBe(safe.data.href)
	expect(JSON.stringify(logger.queue)).not.toContain("PRIVATE_")
	// A new session's mapping does not inherit an earlier customer's page references.
	const next = buildRrwebPrivacyOptions(resolveMasking(undefined), new SerializationPrivacy())
	expect(next.sanitizeUrl!(input.replace("PRIVATE_PATH", "SECOND_PATH"))).toBe(
		"https://recording.invalid/page-1"
	)
})

test("URL privacy has a fixed memory budget and rejects unsafe schemes and oversized paths", () => {
	const options = buildRrwebPrivacyOptions(resolveMasking(undefined), new SerializationPrivacy())
	for (let i = 0; i < 256; i++)
		expect(options.sanitizeUrl!(`https://customer.example/private/${i}`)).toBe(
			`https://recording.invalid/page-${i + 1}`
		)
	for (const url of [
		"https://customer.example/PRIVATE_OVERFLOW",
		"javascript:PRIVATE_SCRIPT",
		"data:text/plain,PRIVATE_DATA",
		"https://customer.example/" + "x".repeat(3000),
	]) {
		expect(options.sanitizeUrl!(url)).toBe("https://recording.invalid/page-redacted")
	}
	expect(options.sanitizeUrl!("https://customer.example/private/0")).toBe(
		"https://recording.invalid/page-1"
	)
})

// ---------------------------------------------------------------------------
// Real-shaped DOM fakes. The `fakeElement` helpers above answer `closest()`
// with a truthy stub for any selector, which cannot exercise descendant or
// ancestor checks; these build a tree and evaluate the selector forms the
// masking engine actually uses (tags, `.class`, `#id`, `[attr]`, `[attr="v"]`,
// comma lists).
// ---------------------------------------------------------------------------

interface FakeNode {
	nodeType: number
	tagName?: string
	attrs: Record<string, string>
	children: FakeNode[]
	parent: FakeNode | null
	text?: string
	id: string
	getAttribute(name: string): string | null
	matches(selector: string): boolean
	closest(selector: string): FakeNode | null
	querySelector(selector: string): FakeNode | null
	readonly innerText: string
	readonly parentElement: FakeNode | null
}

function matchesSimple(node: FakeNode, simple: string): boolean {
	if (node.nodeType !== 1) return false
	let rest = simple.trim()
	const tag = rest.match(/^[a-zA-Z][\w-]*/)?.[0]
	if (tag) {
		if (node.tagName?.toLowerCase() !== tag.toLowerCase()) return false
		rest = rest.slice(tag.length)
	}
	if (rest.startsWith("*")) rest = rest.slice(1)
	for (const part of rest.match(/\.[\w-]+|#[\w-]+|\[[^\]]+\]/g) ?? []) {
		if (part.startsWith(".")) {
			if (!(node.attrs.class ?? "").split(/\s+/).includes(part.slice(1))) return false
		} else if (part.startsWith("#")) {
			if (node.attrs.id !== part.slice(1)) return false
		} else {
			const m = part.match(/^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/)
			if (!m) return false
			const value = node.attrs[m[1]!]
			if (value === undefined) return false
			const expected = m[2] ?? m[3] ?? m[4]
			if (expected !== undefined && value !== expected) return false
		}
	}
	return true
}

function nodeMatches(node: FakeNode, selector: string): boolean {
	return selector
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.some((simple) => matchesSimple(node, simple))
}

function el(
	tagName: string,
	attrs: Record<string, string> = {},
	children: Array<FakeNode | string> = []
): FakeNode {
	const node: FakeNode = {
		nodeType: 1,
		tagName: tagName.toUpperCase(),
		attrs,
		children: [],
		parent: null,
		get id() {
			return attrs.id ?? ""
		},
		getAttribute: (name) => attrs[name] ?? null,
		matches: (selector) => nodeMatches(node, selector),
		closest(selector) {
			let current: FakeNode | null = node
			while (current) {
				if (nodeMatches(current, selector)) return current
				current = current.parent
			}
			return null
		},
		querySelector(selector) {
			const stack = [...node.children]
			while (stack.length) {
				const next = stack.shift()!
				if (nodeMatches(next, selector)) return next
				stack.push(...next.children)
			}
			return null
		},
		get innerText() {
			const collect = (n: FakeNode): string =>
				n.nodeType === 3 ? (n.text ?? "") : n.children.map(collect).join("")
			return collect(node)
		},
		get parentElement() {
			return node.parent
		},
	}
	for (const child of children) {
		const childNode: FakeNode =
			typeof child === "string"
				? ({ nodeType: 3, text: child, attrs: {}, children: [], parent: node } as FakeNode)
				: child
		childNode.parent = node
		node.children.push(childNode)
	}
	return node
}

const partialRules = () => resolveMasking({ recordingMaskingProfile: "partial" } as any)

test("click labels never include text from a masked descendant, even when the click lands on the ancestor", () => {
	const button = el("button", { id: "save" }, [
		"Save for ",
		el("span", { class: "devora-mask" }, ["PRIVATE_CHILD"]),
	])
	const described = describeElement(button as unknown as Element, partialRules())
	expect(described.elementText).toBeUndefined()
	expect(JSON.stringify(described)).not.toContain("PRIVATE_CHILD")
	// A click on the masked span itself promotes to the button and stays masked.
	const child = button.children[1]!
	expect(describeElement(child as unknown as Element, partialRules()).elementText).toBeUndefined()
})

test("an icon inside a button does not suppress its visible label, wherever the click lands", () => {
	const icon = el("svg", { viewBox: "0 0 24 24" }, [el("path", { d: "M1 1" })])
	const button = el("button", {}, [icon, " Save changes"])
	for (const target of [button, icon, icon.children[0]!]) {
		const described = describeElement(target as unknown as Element, partialRules())
		expect(described.elementText).toBe("Save changes")
		expect(described.description).toBe('Clicked "Save changes"')
	}
	// Blocked media is still blocked in the replay; only the label logic changed.
	expect(partialRules().blockSelector).toContain("svg")
	expect(partialRules().textBlockSelector).not.toContain("svg")
})

test("a blocked image's alt/title inside a control is never used as the label", () => {
	const button = el("button", {}, [el("img", { alt: "PRIVATE_ALT", title: "PRIVATE_TITLE" })])
	const described = describeElement(button as unknown as Element, partialRules())
	expect(JSON.stringify(described)).not.toContain("PRIVATE")
})

test("clicks inside a developer-blocked region carry no text", () => {
	const region = el("div", { "data-devora-block": "" }, [el("button", {}, ["PRIVATE_ACTION"])])
	const button = region.children[0]!
	const described = describeElement(button as unknown as Element, partialRules())
	expect(described.elementText).toBeUndefined()
	expect(JSON.stringify(described)).not.toContain("PRIVATE_ACTION")
})

test("select elements share the sensitive-input floor", () => {
	const select = el("select", { autocomplete: "billing cc-exp-month" })
	expect(isSensitiveInput(select as unknown as Element)).toBe(true)
	const named = el("select", { name: "card_type" })
	expect(isSensitiveInput(named as unknown as Element)).toBe(true)
	const plain = el("select", { name: "country" })
	expect(isSensitiveInput(plain as unknown as Element)).toBe(false)
	const minimal = buildRrwebPrivacyOptions(
		resolveMasking({ recordingMaskingProfile: "minimal" } as any),
		new SerializationPrivacy()
	)
	expect(minimal.maskInputFn("07", select as unknown as HTMLElement)).toBe("***")
})

test("registered custom properties and modern media features survive sanitation", () => {
	const p = new SerializationPrivacy()
	const css = p.css(
		`@property --tw-border-style { syntax: "*"; inherits: false; initial-value: solid; }
		@property --tw-x { syntax: "<length>"; inherits: true; initial-value: 0px; }
		@media (hover:hover) and (prefers-color-scheme:dark) { a { color: red } }
		@media (display-mode:standalone) { a { top: 0 } }
		a { transition: opacity 150ms ease, transform 200ms; will-change: transform; }
		:host(.dark) ::slotted(p) { color: red }
		x-card::part(label) { color: red }`
	)
	expect(css).toContain('@property --dv-variable-1{syntax:"*";inherits:false;initial-value:solid}')
	expect(css).toContain(
		'@property --dv-variable-2{syntax:"<length>";inherits:true;initial-value:0px}'
	)
	expect(css).toContain("(hover:hover)")
	expect(css).toContain("(prefers-color-scheme:dark)")
	expect(css).toContain("(display-mode:standalone)")
	expect(css).toContain("transition:opacity 150ms ease,transform 200ms")
	expect(css).toContain("will-change:transform")
	expect(css).toMatch(/:host\(\.dv-class-\d+\) ::slotted\(p\)/)
	expect(css).toMatch(/dv-tag-\d+::part\(dv-symbol-\d+\)/)
	expect(css).not.toContain("label")
	expect(css).not.toContain("@media not all")
	expect(css).not.toContain("x-card")
})

test("a rejected @property syntax string degrades to the universal syntax rather than passing text", () => {
	const p = new SerializationPrivacy()
	const css = p.css(`@property --a { syntax: "PRIVATE_TEXT with spaces?"; inherits: false; }`)
	expect(css).toBe('@property --dv-variable-1{syntax:"*";inherits:false}')
})

test("svg presentation attributes pass only as numbers, transforms and closed keywords", () => {
	const options = buildRrwebPrivacyOptions(partialRules(), new SerializationPrivacy())
	const safe = options.sanitizeAttributes!(
		{
			cx: "12",
			"stroke-width": "1.5px",
			transform: "translate(10, 20) rotate(45)",
			"stroke-linecap": "round",
			preserveAspectRatio: "xMidYMid meet",
			in: "SourceGraphic",
			result: "PRIVATE_RESULT",
			type: "PRIVATE_TYPE",
			mode: "PRIVATE_MODE",
			points: "0,0 10,10 url(#PRIVATE)",
			transform2: "PRIVATE",
		},
		null
	)
	expect(safe).toEqual({
		cx: "12",
		"stroke-width": "1.5px",
		transform: "translate(10, 20) rotate(45)",
		"stroke-linecap": "round",
		preserveAspectRatio: "xMidYMid meet",
		in: "SourceGraphic",
	})
})

test("free-form capture channels are redacted, bounded and masked under full (SDK-01, SDK-03)", async () => {
	const { normalizeCustomAction, describeCapturedError, sanitizeConsoleArguments, redactFreeText } =
		await import("../browser/src/capture-privacy")
	const full = resolveMasking(undefined)
	const partial = resolveMasking({ recordingMaskingProfile: "partial" } as any)
	const event = {
		type: "checkout",
		action: "paid with card 4242 4242 4242 4242",
		path: "https://PRIVATE_TENANT.example/pay?token=PRIVATE_QUERY",
		metadata: {
			password: "PRIVATE_PASSWORD",
			nested: { authorization: "Bearer PRIVATE_BEARER", note: "email PRIVATE@example.com" },
			count: 3,
			deep: { a: { b: { c: { d: { e: "too deep" } } } } },
		},
	}
	for (const rules of [full, partial]) {
		const normalized = normalizeCustomAction(event, rules)
		const text = JSON.stringify(normalized)
		for (const secret of [
			"PRIVATE_PASSWORD",
			"PRIVATE_BEARER",
			"PRIVATE@example.com",
			"PRIVATE_QUERY",
			"4242 4242",
		])
			expect(text).not.toContain(secret)
		if (rules.profile === "full") expect(normalized.metadata).toEqual({ redacted: true })
		else expect(normalized.metadata?.count).toBe(3)
		expect(text).not.toContain("too deep")
	}
	expect(JSON.stringify(normalizeCustomAction(event, full).metadata)).not.toContain("email")
	expect(describeCapturedError("TypeError", "cannot read PRIVATE_FIELD", full)).toBe("TypeError")
	expect(describeCapturedError("TypeError", "token=PRIVATE_TOKEN failed", partial)).not.toContain(
		"PRIVATE_TOKEN"
	)
	expect(sanitizeConsoleArguments(["user PRIVATE@example.com"], "full")).toEqual([
		"[console output masked]",
	])
	expect(sanitizeConsoleArguments(["Bearer abcdefghijkl"], "partial")[0]).not.toContain(
		"abcdefghijkl"
	)
	expect(redactFreeText("x".repeat(1000)).length).toBeLessThanOrEqual(300)
	// rrweb stringifies elements to outerHTML, errors to their stack and objects
	// to JSON; none of those may bypass masking or the key rules.
	const [element, error, json] = sanitizeConsoleArguments(
		[
			'<input type="hidden" name="csrf" value="PRIVATE_CSRF">',
			"TypeError: failed\n    at submit (https://app.example/main.js:10:5)\nsubmit@https://app.example/main.js:10:5",
			'{"password":"PRIVATE_PW","otp":"123456","step":"login"}',
		],
		"partial"
	)
	expect(element).toBe("[element]")
	expect(error).toBe("TypeError: failed")
	expect(json).not.toContain("PRIVATE_PW")
	expect(json).not.toContain("123456")
	expect(json).toContain("login")
	expect(redactFreeText('{"session_id": "PRIVATE_SID"}')).not.toContain("PRIVATE_SID")

	// Console plugin events: arguments masked, stack traces dropped, other plugins dropped.
	const options = buildRrwebPrivacyOptions(full, new SerializationPrivacy())
	const consoleEvent = sanitizeRrwebEvent(
		{
			type: 6,
			timestamp: 1,
			data: {
				plugin: "rrweb/console@1",
				payload: { level: "error", payload: ["PRIVATE_CONSOLE"], trace: ["at PRIVATE_STACK"] },
			},
		} as any,
		options
	) as any
	expect(JSON.stringify(consoleEvent)).not.toContain("PRIVATE_")
	expect(consoleEvent.data.payload.trace).toEqual([])
	expect(
		sanitizeRrwebEvent(
			{ type: 6, timestamp: 1, data: { plugin: "other", payload: {} } } as any,
			options
		)
	).toBeNull()
})

function fakeElement(options: {
	tag?: string
	matches?: (selector: string) => boolean
	host?: any
	attrs?: Record<string, string>
}): any {
	return {
		tagName: (options.tag ?? "span").toUpperCase(),
		closest: (selector: string) => (options.matches?.(selector) ? {} : null),
		getRootNode: () => (options.host ? { host: options.host } : {}),
		getAttribute: (name: string) => options.attrs?.[name] ?? null,
		querySelector: () => null,
		innerText: "Visible label",
	}
}

test("masking crosses shadow roots, treats editors as inputs and hides hidden inputs (N8, SDK-02)", () => {
	const partial = resolveMasking({
		recordingMaskingProfile: "partial",
		recordingMaskSelectors: [".private-host"],
		settingsOnly: true,
	} as any)
	const minimal = resolveMasking({ recordingMaskingProfile: "minimal", settingsOnly: true } as any)
	// A mask selector on a shadow host applies to text inside its shadow root.
	const host = fakeElement({ matches: (selector) => selector.includes(".private-host") })
	const insideShadow = fakeElement({ host })
	expect(isTextMasked(insideShadow, partial)).toBe(true)
	expect(isTextMasked(fakeElement({}), partial)).toBe(false)
	// Rich-text editor content follows the input rule.
	const editor = fakeElement({ matches: (selector) => selector.includes("contenteditable") })
	expect(isTextMasked(editor, partial)).toBe(true)
	expect(isTextMasked(editor, minimal)).toBe(false)
	// Hidden inputs are sensitive in every profile.
	const hidden = fakeElement({ tag: "input", attrs: { type: "hidden", name: "state" } })
	expect(isSensitiveInput(hidden)).toBe(true)
	expect(isInputMasked(hidden, minimal)).toBe(true)
	// Custom element names never reach activity descriptors.
	const custom = describeElement(fakeElement({ tag: "customer-private-account-123" }), minimal)
	expect(JSON.stringify(custom)).not.toContain("customer-private")
	expect(custom.elementType).toBe("element")
	expect(describeElement(fakeElement({ tag: "button" }), minimal).elementType).toBe("button")
})
