#!/usr/bin/env node
/**
 * Sync every SDK version from packages/sdks/core/package.json: SDK_VERSION in
 * @devorash/core, and the three Python packages (pyproject versions, the
 * devora-python pins, SDK_VERSION in devora_sdk). npm prereleases map to
 * PEP 440 (1.2.0-beta.1 -> 1.2.0b1). Run after `changeset version` via
 * `bun run version:sdks`.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const sdksRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const corePackagePath = join(sdksRoot, "core/package.json")

const { version } = JSON.parse(readFileSync(corePackagePath, "utf8"))
if (!version) {
	console.error("sync-sdk-version: missing version in core/package.json")
	process.exit(1)
}

function toPep440(npmVersion) {
	const match = /^(\d+\.\d+\.\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(npmVersion)
	if (!match) throw new Error(`sync-sdk-version: cannot map ${npmVersion} to PEP 440`)
	const [, release, stage, number] = match
	if (!stage) return release
	return `${release}${{ alpha: "a", beta: "b", rc: "rc" }[stage]}${number}`
}

function rewrite(relativePath, replacements) {
	const path = join(sdksRoot, relativePath)
	let text = readFileSync(path, "utf8")
	for (const [pattern, replacement] of replacements) {
		if (!pattern.test(text)) {
			console.error(`sync-sdk-version: ${relativePath} has no match for ${pattern}`)
			process.exit(1)
		}
		text = text.replace(pattern, replacement)
	}
	writeFileSync(path, text)
}

const pythonVersion = toPep440(version)
const [major, minor] = version.split(".").map(Number)
// 0.x minors may break; 1.x+ majors may break.
const upperBound = major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`

rewrite("core/src/constants/index.ts", [
	[/export const SDK_VERSION = "[^"]+"/, `export const SDK_VERSION = "${version}"`],
])
rewrite("python/src/devora_sdk/constants.py", [
	[/^SDK_VERSION = "[^"]+"/m, `SDK_VERSION = "${pythonVersion}"`],
])
rewrite("python/pyproject.toml", [[/^version = "[^"]+"/m, `version = "${pythonVersion}"`]])
for (const pkg of ["django", "fastapi"]) {
	rewrite(`${pkg}/pyproject.toml`, [
		[/^version = "[^"]+"/m, `version = "${pythonVersion}"`],
		[/"devora-python>=[^"]+"/, `"devora-python>=${pythonVersion},<${upperBound}"`],
	])
}
console.log(`sync-sdk-version: npm ${version}, PyPI ${pythonVersion}`)
