#!/usr/bin/env node
/**
 * Publish all @devorash/* packages to npm in dependency order.
 *
 * CI should use npm trusted publishing with GitHub Actions OIDC. Local fallback:
 * run `npm login` or set NPM_TOKEN/NODE_AUTH_TOKEN, and set
 * SDK_PUBLISH_PROVENANCE=0 if provenance is unavailable locally.
 */
import { spawnSync } from "node:child_process"
import { rmSync } from "node:fs"
import { prepareSdkPublishArtifacts } from "./prepare-publish-artifacts.mjs"

const dryRun = process.argv.includes("--dry-run") || process.env.SDK_PUBLISH_DRY_RUN === "1"
const distTag = process.env.NPM_DIST_TAG || "latest"
const useProvenance = process.env.SDK_PUBLISH_PROVENANCE !== "0"

function publishArtifact(artifact) {
	const args = ["publish", artifact.tarball, "--access", "public", "--tag", distTag]
	if (useProvenance) {
		args.push("--provenance")
	}

	console.log(`\nPublishing ${artifact.name}@${artifact.version} (${distTag})...`)
	const result = spawnSync("npm", args, {
		stdio: "inherit",
		env: process.env,
	})
	if (result.status !== 0) {
		process.exit(result.status ?? 1)
	}
}

let artifactDir

try {
	const result = prepareSdkPublishArtifacts()
	artifactDir = result.artifactDir

	if (dryRun) {
		for (const artifact of result.artifacts) {
			console.log(`[dry-run] ${artifact.name}@${artifact.version} - ${artifact.tarball}`)
		}
		console.log("\nDry run complete. No packages were published.")
		process.exit(0)
	}

	for (const artifact of result.artifacts) {
		publishArtifact(artifact)
	}

	console.log("\nAll SDK packages published.")
} catch (error) {
	console.error(error instanceof Error ? error.message : error)
	process.exitCode = 1
} finally {
	if (artifactDir) {
		rmSync(artifactDir, { recursive: true, force: true })
	}
}
