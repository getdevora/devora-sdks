/** Regenerate when upgrading css-tree; do not derive privacy keywords from page CSS. */
import { createRequire } from "node:module"
import { writeFileSync } from "node:fs"
const require = createRequire(new URL("../browser/package.json", import.meta.url))
const css = require("css-tree")
const grammar = css.lexer.dump(true)
const keywords = new Set(["inherit", "initial", "unset", "revert", "revert-layer", "none", "auto"])
for (const syntax of [...Object.values(grammar.properties), ...Object.values(grammar.types)]) {
	if (syntax && typeof syntax === "object")
		css.definitionSyntax.walk(syntax, (node) => {
			if (node.type === "Keyword" && /^[a-z-][a-z\d-]*$/i.test(node.name))
				keywords.add(node.name.toLowerCase())
		})
}
const emit = (name, values) =>
	`export const ${name} = new Set(${JSON.stringify([...values].sort().join(" "))}.split(" "))\n`
writeFileSync(
	new URL("../browser/src/css-privacy-grammar.ts", import.meta.url),
	`// Generated from css-tree ${require("css-tree/package.json").version}; regenerate with node packages/sdks/scripts/generate-css-privacy-grammar.mjs.\n` +
		emit("CSS_KEYWORDS", keywords) +
		emit("CSS_PROPERTIES", Object.keys(grammar.properties))
)
