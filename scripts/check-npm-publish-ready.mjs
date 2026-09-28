#!/usr/bin/env node
/**
 * Pre-flight checks before npm publish.
 * Supports GitHub Actions trusted publishing and local npm login/token fallback.
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sdkPackageDirs, sdksRoot } from "./prepare-publish-artifacts.mjs"

function run(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" })
	return {
		ok: result.status === 0,
		stdout: result.stdout.trim(),
		stderr: result.stderr.trim(),
	}
}

function npmView(name, version) {
	const result = run("npm", ["view", `${name}@${version}`, "version"])
	return result.ok ? result.stdout : null
}

function npmWhoami() {
	const result = run("npm", ["whoami"])
	return result.ok ? result.stdout : null
}

function manifestFor(dir) {
	const filePath = join(sdksRoot, dir, "package.json")
	return JSON.parse(readFileSync(filePath, "utf8"))
}

const packageManifests = sdkPackageDirs.map(manifestFor)
const versions = new Set(packageManifests.map((manifest) => manifest.version))
const hasToken = Boolean(process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN)
const whoami = npmWhoami()
const hasTrustedPublishingEnv =
	process.env.GITHUB_ACTIONS === "true" &&
	Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) &&
	Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL)

console.log("=== Devora SDK publish pre-flight ===\n")

if (versions.size !== 1) {
	console.log(`✗ SDK package versions are not lockstep: ${[...versions].join(", ")}`)
	process.exit(1)
}

const version = [...versions][0]
console.log(`✓ SDK packages are lockstep at ${version}`)

// The unprivileged CI build job has no registry credentials by design; the
// publish job authenticates with OIDC.
if (process.argv.includes("--skip-auth")) {
	console.log("- Publish authentication not checked (--skip-auth)")
} else if (hasTrustedPublishingEnv) {
	console.log("✓ GitHub Actions OIDC environment is available for npm trusted publishing")
} else if (hasToken) {
	console.log("✓ npm token is set for local/token publishing")
} else if (whoami) {
	console.log(`✓ npm login active (${whoami})`)
} else {
	console.log("✗ No publish authentication detected")
	console.log("  → CI: configure npm trusted publishing for this workflow/environment")
	console.log("  → Local: run npm login or set NPM_TOKEN/NODE_AUTH_TOKEN")
	process.exit(1)
}

let versionAlreadyPublished = false
for (const manifest of packageManifests) {
	const published = npmView(manifest.name, manifest.version)
	if (published) {
		versionAlreadyPublished = true
		console.log(`✗ ${manifest.name}@${manifest.version} is already published`)
	} else {
		console.log(`✓ ${manifest.name}@${manifest.version} is not published yet`)
	}
}

if (versionAlreadyPublished) {
	console.log("\nRun bun run changeset && bun run version:sdks before publishing.")
	process.exit(1)
}

console.log("\nNext gate:")
console.log("  DEVORA_SDK_API_ORIGIN=<origin> bun run test:sdks")
console.log("  DEVORA_SDK_API_ORIGIN=<origin> bun run verify:sdks-publish")
console.log("  bun run publish:sdks")
