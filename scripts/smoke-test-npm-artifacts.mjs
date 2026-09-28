#!/usr/bin/env node
/**
 * Consumer smoke test for the packed @devorash/* artifacts: install the
 * tarballs (not the workspace) into a fresh npm project with each framework
 * peer, then import every declared entry the way a customer would.
 *
 *   node packages/sdks/scripts/smoke-test-npm-artifacts.mjs [--artifacts <dir>]
 *
 * With --artifacts, tests already-packed tarballs (the publish job's inputs)
 * instead of building and packing again.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { prepareSdkPublishArtifacts } from "./prepare-publish-artifacts.mjs"

const PEERS = [
	"react@19",
	"react-dom@19",
	"vue@3",
	"svelte@5",
	"solid-js@1",
	"next@16",
	"express@5",
	"hono@4",
	"fastify@5",
	// DOM for the browser-condition checks
	"@happy-dom/global-registrator@20",
]

function run(command, args, cwd, extra = {}) {
	const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env, ...extra })
	if (result.error) throw result.error
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`)
}

/** ESM checks, run inside the consumer project (so resolution is the package's own). */
const NODE_CHECKS = `
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const names = JSON.parse(readFileSync("./names.json", "utf8"))
for (const name of names) {
	const manifest = JSON.parse(readFileSync(\`./node_modules/\${name}/package.json\`, "utf8"))
	for (const subpath of Object.keys(manifest.exports ?? { ".": null })) {
		const specifier = subpath === "." ? name : \`\${name}/\${subpath.slice(2)}\`
		// Svelte components are compiled by the consumer's bundler; resolve only.
		if (subpath.endsWith(".svelte")) {
			import.meta.resolve(specifier)
			continue
		}
		// Solid's DOM build is exercised under the browser condition below.
		if (name === "@devorash/solid") continue
		const module = await import(specifier)
		assert.ok(Object.keys(module).length > 0, \`\${specifier} has no exports\`)
	}
}

const core = await import("@devorash/core/constants")
assert.match(String(core.SDK_VERSION), /^\\d+\\.\\d+\\.\\d+/)

// React: server rendering must not touch browser globals.
const { createElement } = await import("react")
const { renderToString } = await import("react-dom/server")
const react = await import("@devorash/react")
const html = renderToString(
	createElement(react.DevoraProvider, { apiKey: "pk_smoke" }, createElement("main", null, "ok"))
)
assert.ok(typeof html === "string")

// Vue: server rendering a component tree with the SDK's banner and guard.
const { createSSRApp, h } = await import("vue")
const { renderToString: renderVue } = await import("vue/server-renderer")
const vue = await import("@devorash/vue")
const vueHtml = await renderVue(
	createSSRApp({ render: () => h("main", [h(vue.ImpersonationBanner), h(vue.ReadOnlyGuard, null, () => "ok")]) })
)
assert.ok(vueHtml.includes("<main"))

// Next.js server entry loads without the client bundle.
await import("@devorash/nextjs")

// The Node entry's signing helpers are usable from the published build.
const node = await import("@devorash/node")
assert.equal(typeof node.devoraSDK, "function")
assert.match(node.sha256Hex(new Uint8Array()), /^e3b0c442/)
console.log("[smoke] node entries ok")
`

const BROWSER_CHECKS = `
import assert from "node:assert/strict"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
GlobalRegistrator.register({ url: "https://customer.example/" })
for (const name of ["@devorash/solid", "@devorash/browser", "@devorash/vue", "@devorash/nextjs/client"]) {
	const module = await import(name)
	assert.ok(Object.keys(module).length > 0, \`\${name} has no exports\`)
}
console.log("[smoke] browser-condition entries ok")
`

const argIndex = process.argv.indexOf("--artifacts")
const givenDir = argIndex === -1 ? null : resolve(process.argv[argIndex + 1])
let artifactDir = givenDir
const consumer = mkdtempSync(join(tmpdir(), "devora-npm-consumer-"))

try {
	let tarballs
	if (givenDir) {
		tarballs = readdirSync(givenDir)
			.filter((file) => file.endsWith(".tgz"))
			.map((file) => join(givenDir, file))
	} else {
		const prepared = prepareSdkPublishArtifacts()
		artifactDir = prepared.artifactDir
		tarballs = prepared.artifacts.map((artifact) => artifact.tarball)
	}
	if (tarballs.length === 0) throw new Error("no tarballs to test")

	writeFileSync(
		join(consumer, "package.json"),
		`${JSON.stringify({ name: "devora-sdk-consumer", private: true, type: "module" }, null, 2)}\n`
	)
	run(
		"npm",
		[
			"install",
			"--no-audit",
			"--no-fund",
			"--ignore-scripts",
			"--loglevel=error",
			...PEERS,
			...tarballs,
		],
		consumer
	)

	const names = readdirSync(join(consumer, "node_modules/@devorash")).map(
		(dir) => `@devorash/${dir}`
	)
	writeFileSync(join(consumer, "names.json"), JSON.stringify(names))
	writeFileSync(join(consumer, "node-checks.mjs"), NODE_CHECKS)
	writeFileSync(join(consumer, "browser-checks.mjs"), BROWSER_CHECKS)

	run("node", ["node-checks.mjs"], consumer)
	run("node", ["--conditions=browser", "browser-checks.mjs"], consumer)
	console.log(`\nAll ${names.length} SDK packages install and import from their tarballs.`)
} catch (error) {
	console.error(error instanceof Error ? error.message : error)
	process.exitCode = 1
} finally {
	rmSync(consumer, { recursive: true, force: true })
	if (artifactDir && !givenDir) rmSync(artifactDir, { recursive: true, force: true })
}
