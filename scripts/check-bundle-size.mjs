#!/usr/bin/env node
/**
 * Fail if @devorash/browser dist exceeds the unpacked size budget.
 * rrweb and recording deps make this package larger than siblings.
 */
import { readdirSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const sdksRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const distDir = join(sdksRoot, "browser/dist")

/** Unpacked dist budget for the browser SDK (bytes). Adjust if recording deps change. */
const MAX_JS_DIST_BYTES = 2 * 1024 * 1024

function dirSize(dir) {
	let total = 0
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) {
			total += dirSize(path)
		} else {
			total += statSync(path).size
		}
	}
	return total
}

let size
try {
	size = dirSize(distDir)
} catch {
	console.error("check-bundle-size: run `bun run build:sdks` first (missing browser/dist)")
	process.exit(1)
}

const mb = (size / (1024 * 1024)).toFixed(2)
const maxMb = (MAX_JS_DIST_BYTES / (1024 * 1024)).toFixed(2)

if (size > MAX_JS_DIST_BYTES) {
	console.error(
		`check-bundle-size: @devorash/browser dist is ${mb} MB (limit ${maxMb} MB). ` +
			"If the increase is intentional, raise MAX_JS_DIST_BYTES in check-bundle-size.mjs."
	)
	process.exit(1)
}

console.log(`check-bundle-size: @devorash/browser dist ${mb} MB (limit ${maxMb} MB) — OK`)
