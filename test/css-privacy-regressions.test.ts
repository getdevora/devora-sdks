import { expect, test } from "bun:test"
import { SerializationPrivacy } from "../browser/src/serialization-privacy"
import { buildRrwebPrivacyOptions, resolveMasking } from "../browser/src/masking"
import { sanitizeRrwebEvent } from "../browser/src/session-recorder"

const source = `/*! PRIVATE_COMMENT */
@import url("https://PRIVATE_RESOURCE.example/PRIVATE_TOKEN");
@font-face{font-family:PRIVATE_FONT;src:url("https://PRIVATE_FONT_RESOURCE")}
@layer PRIVATE_LAYER {
 .PRIVATE_CLASS#PRIVATE_ID { --PRIVATE_VARIABLE:20px; display:grid; grid-template-columns:1fr 2fr; gap:var(--PRIVATE_VARIABLE); padding:12px; background:linear-gradient(red,blue); font-family:"PRIVATE_FONT"; color:#abc; }
 .PRIVATE_CLASS::after { content:"PRIVATE_CONTENT"; background-image:u\\72l(https://PRIVATE_CSS_URL) }
 @media (min-width:600px) { .PRIVATE_CLASS { margin:10px } }
}
@keyframes PRIVATE_ANIMATION { from{opacity:0}to{opacity:1} }
.PRIVATE_CLASS{animation-name:PRIVATE_ANIMATION; grid-template-areas:"PRIVATE_AREA PRIVATE_AREA"; grid-area:PRIVATE_AREA;}
`

test("CSS and DOM identifiers share opaque references without losing structural declarations", () => {
	const options = buildRrwebPrivacyOptions(resolveMasking(undefined), new SerializationPrivacy())
	const attrs = options.sanitizeAttributes!(
		{
			class: "PRIVATE_CLASS",
			id: "PRIVATE_ID",
			style: "--PRIVATE_VARIABLE:20px;gap:var(--PRIVATE_VARIABLE);width:120px",
			_cssText: source,
		},
		null
	)
	const wire = JSON.stringify(attrs)
	expect(wire).not.toContain("PRIVATE")
	const sheet = String(attrs._cssText)
	expect(sheet).toContain(`.${attrs.class}#${attrs.id}`)
	expect(sheet).toContain("display:grid;")
	expect(sheet).toContain("grid-template-columns:1fr 2fr;")
	expect(sheet).toContain("background:linear-gradient(red,blue);")
	expect(sheet).toContain("@media (min-width:600px)")
	expect(sheet).toContain("font-family:system-ui,sans-serif")
	expect(sheet).not.toContain("url(")
	expect(sheet).not.toContain("@font-face")
	const variable = String(attrs.style).match(/(--dv-variable-\d+):20px/)![1]
	expect(sheet).toContain(`gap:var(${variable})`)
	const animation = sheet.match(/@keyframes (dv-symbol-\d+)/)![1]
	expect(sheet).toContain(`animation-name:${animation}`)
})

test("snapshot, CSSOM, adopted stylesheets, declarations and style text mutations share sanitation", () => {
	const options = buildRrwebPrivacyOptions(resolveMasking(undefined), new SerializationPrivacy())
	const styleText = { nodeType: 3, parentElement: { tagName: "STYLE" } } as unknown as Node
	const events = [
		{
			type: 2,
			data: {
				node: {
					type: 0,
					id: 1,
					childNodes: [
						{
							type: 2,
							id: 2,
							tagName: "style",
							attributes: {},
							childNodes: [{ type: 3, id: 3, isStyle: true, textContent: source }],
						},
					],
				},
			},
		},
		{ type: 3, data: { source: 0, adds: [], attributes: [], texts: [{ id: 3, value: source }] } },
		{
			type: 3,
			data: {
				source: 8,
				id: 2,
				adds: [{ index: 0, rule: source }],
				replace: source,
				replaceSync: source,
			},
		},
		{
			type: 3,
			data: {
				source: 15,
				id: 1,
				styleIds: [4],
				styles: [{ styleId: 4, rules: [{ index: 0, rule: source }] }],
			},
		},
		{
			type: 3,
			data: {
				source: 13,
				styleId: 4,
				index: [0],
				set: { property: "--PRIVATE_VARIABLE", value: '"PRIVATE_TEXT"', priority: "important" },
			},
		},
		{
			type: 3,
			data: { source: 13, id: 2, index: [0], remove: { property: "--PRIVATE_VARIABLE" } },
		},
		{
			type: 3,
			data: {
				source: 0,
				adds: [],
				texts: [],
				attributes: [
					{
						id: 4,
						attributes: {
							style: {
								"--PRIVATE_VARIABLE": ['"PRIVATE_TEXT"', "important"],
								"background-image": "url(https://PRIVATE_RESOURCE)",
							},
						},
					},
				],
			},
		},
	]
	for (const event of events) {
		const original = JSON.stringify(event)
		const safe = sanitizeRrwebEvent({ ...event, timestamp: 1 } as any, options, () => styleText)
		expect(safe).not.toBeNull()
		expect(JSON.stringify(safe)).not.toContain("PRIVATE")
		expect(JSON.stringify(safe)).not.toContain("https://PRIVATE")
		expect(JSON.stringify(event)).toBe(original)
	}
	for (const event of [
		{ type: 3, data: { source: 10, family: "PRIVATE_FONT", fontSource: "PRIVATE_RESOURCE" } },
		{ type: 3, data: { source: 16, define: { name: "PRIVATE_ELEMENT", ctor: "PRIVATE_CODE" } } },
		{ type: 7, data: { url: "https://PRIVATE_RESOURCE", payload: { cssText: source } } },
	])
		expect(sanitizeRrwebEvent({ ...event, timestamp: 1 } as any, options)).toBeNull()
})

test("escaped identifiers correlate and invalid CSS cannot use raw parser fallback", () => {
	const p = new SerializationPrivacy()
	const className = p.identifier("class", "user:PRIVATE")
	expect(p.css(".user\\:PRIVATE{color:red}")).toBe(`.${className}{color:red;}`)
	for (const raw of [
		".PRIVATE{color:}PRIVATE_RAW",
		'@PRIVATE "PRIVATE_TEXT";',
		'.x{background:image-set("https://PRIVATE_RESOURCE" 1x)}',
		".x{color:PRIVATE_COLOR;bogus:PRIVATE_PROP}",
		'[data-PRIVATE="PRIVATE_TEXT"]{color:red}',
		'[class="ordinary" PRIVATE_FLAG]{color:red}',
	]) {
		expect(p.css(raw)).not.toContain("PRIVATE")
	}
	expect(p.css(".x:nth-child(odd){display:flex}")).toContain(":nth-child(odd)")
})

test("private attribute names and values cannot bypass the layout allowlist", () => {
	const options = buildRrwebPrivacyOptions(resolveMasking(undefined), new SerializationPrivacy())
	const safe = options.sanitizeAttributes!(
		{
			PRIVATE_ATTRIBUTE: null,
			width: "PRIVATE_WIDTH",
			role: "PRIVATE_ROLE",
			lang: "PRIVATE_LANG",
			type: "PRIVATE_TYPE",
			disabled: "PRIVATE_FLAG",
			style: { PRIVATE_PROPERTY: "PRIVATE_VALUE" },
		},
		null
	)
	expect(JSON.stringify(safe)).not.toContain("PRIVATE")
	expect(safe.disabled).toBe("")
})

test("privacy budgets degrade to opaque output and are reported instead of ending capture", () => {
	const p = new SerializationPrivacy()
	// An oversized or over-nested sheet becomes the empty rule, never raw CSS.
	expect(p.css("a".repeat(1_000_001))).toBe(":not(*){}")
	expect(p.css("a{" + "(".repeat(65))).toBe(":not(*){}")
	expect(p.css("a".repeat(1_000_001), true)).toBe("")
	// Identifier overflow collapses onto one shared opaque token per kind; the
	// original tokens still never appear and earlier mappings stay stable.
	expect(p.identifier("id", "a".repeat(1025))).toBe("dv-id-x")
	for (let i = 0; i < 20_000; i++) p.identifier("class", String(i))
	expect(p.identifier("class", "overflow")).toBe("dv-class-x")
	expect(p.identifier("class", "PRIVATE_CLASS")).toBe("dv-class-x")
	expect(p.identifier("class", "0")).toBe("dv-class-1")
	expect([...p.degraded]).toEqual(["css_length", "css_nesting", "identifier_budget"])
	// Nothing above escaped as an exception, so a recorder driving these inputs keeps capturing.
	const options = buildRrwebPrivacyOptions(resolveMasking(undefined), p)
	const many: Record<string, string> = {}
	for (let i = 0; i < 25_000; i++) many["class"] = (many["class"] ?? "") + ` c${i}`
	expect(() =>
		sanitizeRrwebEvent(
			{
				type: 2,
				timestamp: 1,
				data: { node: { type: 2, id: 1, tagName: "div", attributes: many, childNodes: [] } },
			} as any,
			options
		)
	).not.toThrow()
})

test("style text is sanitized as CSS by its parent, not by rrweb's retired isStyle flag", () => {
	// rrweb 2.x never sets `isStyle`; in the partial/minimal profiles the text
	// mask passes unmasked text through, so raw CSS would otherwise reach the wire.
	const partial = resolveMasking({ recordingMaskingProfile: "partial" } as any)
	const options = buildRrwebPrivacyOptions(partial, new SerializationPrivacy())
	const css =
		'.ZZSENTINEL_CLASS{background:url(https://ZZSENTINEL_URL/x);content:"ZZSENTINEL_TEXT"} /* ZZSENTINEL_COMMENT */'
	const styleElement = { nodeType: 1, tagName: "STYLE", parentElement: null } as unknown as Element
	const styleText = { nodeType: 3, parentElement: styleElement } as unknown as Node
	const getNode = (id: number) => (id === 2 ? styleElement : id === 3 ? styleText : null)
	const snapshot = {
		type: 2,
		timestamp: 1,
		data: {
			node: {
				type: 0,
				id: 1,
				childNodes: [
					{
						type: 2,
						id: 2,
						tagName: "style",
						attributes: {},
						// No `isStyle`, no `_cssText`: the shape rrweb emits for a
						// comment-only / invalid sheet or a non-CSS `type`.
						childNodes: [{ type: 3, id: 3, textContent: css }],
					},
				],
			},
		},
	}
	// A text node appended to an existing <style> (CSS-in-JS, HMR, theming).
	const appended = {
		type: 3,
		timestamp: 2,
		data: {
			source: 0,
			texts: [],
			attributes: [],
			removes: [],
			adds: [{ parentId: 2, nextId: null, node: { type: 3, id: 3, textContent: css } }],
		},
	}
	for (const event of [snapshot, appended]) {
		const safe = JSON.stringify(sanitizeRrwebEvent(event as any, options, getNode))
		expect(safe).not.toContain("ZZSENTINEL")
		expect(safe).toContain("dv-class-")
	}
	// The same text under an ordinary element is still masked as text, not parsed as CSS.
	const paragraph = { nodeType: 1, tagName: "P", parentElement: null } as unknown as Element
	const plain = sanitizeRrwebEvent(
		{
			type: 3,
			timestamp: 3,
			data: {
				source: 0,
				texts: [],
				attributes: [],
				removes: [],
				adds: [{ parentId: 9, nextId: null, node: { type: 3, id: 10, textContent: "hello" } }],
			},
		} as any,
		options,
		(id) => (id === 9 ? paragraph : null)
	)
	expect(JSON.stringify(plain)).not.toContain("dv-class-")
})

test("@property syntax only passes spec type components; author idents degrade to *", () => {
	const p = new SerializationPrivacy()
	expect(p.css('@property --a { syntax: "<length> | ZZSENTINEL"; inherits: false; }')).toBe(
		'@property --dv-variable-1{syntax:"*";inherits:false}'
	)
	expect(
		p.css('@property --b { syntax: "<length-percentage>+ | <color>#"; inherits: true; }')
	).toBe('@property --dv-variable-2{syntax:"<length-percentage>+ | <color>#";inherits:true}')
})

test("svg transform values are length-capped and match in linear time", () => {
	const options = buildRrwebPrivacyOptions(
		resolveMasking({ recordingMaskingProfile: "partial" } as any),
		new SerializationPrivacy()
	)
	const hostile = ("translate(1)" + " ".repeat(50)).repeat(400) + "x"
	const started = performance.now()
	const safe = options.sanitizeAttributes!({ transform: hostile }, null)
	expect(performance.now() - started).toBeLessThan(50)
	expect(safe.transform).toBeUndefined()
	expect(
		options.sanitizeAttributes!({ transform: "  translate(10 20),rotate(45)  scale(1.5)" }, null)
			.transform
	).toBe("  translate(10 20),rotate(45)  scale(1.5)")
})
