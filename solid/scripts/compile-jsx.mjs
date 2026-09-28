#!/usr/bin/env node
/**
 * tsc emits types and preserved JSX (`dist/*.jsx`); compile that JSX with
 * Solid's compiler into the `dist/*.js` files package.json points at. Bundlers
 * with the `solid` export condition use `src/` directly instead.
 */
import { transformAsync } from "@babel/core"
import { readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist")
const files = (await readdir(dist)).filter((name) => name.endsWith(".jsx"))
if (files.length === 0) throw new Error("No JSX output found; run tsc first")
for (const name of files) {
	const source = join(dist, name)
	const target = source.replace(/\.jsx$/, ".js")
	const result = await transformAsync(await readFile(source, "utf8"), {
		filename: source,
		babelrc: false,
		configFile: false,
		presets: [["babel-preset-solid", { generate: "dom" }]],
		sourceMaps: true,
	})
	if (!result?.code) throw new Error(`Solid compilation produced no output for ${name}`)
	const mapName = `${name.replace(/\.jsx$/, ".js")}.map`
	await writeFile(target, `${result.code}\n//# sourceMappingURL=${mapName}\n`)
	await writeFile(join(dist, mapName), JSON.stringify({ ...result.map, sourcesContent: undefined }))
	await rm(source)
	await rm(`${source}.map`, { force: true })
}
console.log(`Compiled ${files.length} Solid modules`)
