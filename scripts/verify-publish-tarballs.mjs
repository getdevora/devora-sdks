#!/usr/bin/env node
/**
 * Build, pack, and verify all @devorash/* npm artifacts.
 * Uses npm pack against temporary package directories so workspace:* specs are
 * rewritten before packaging.
 */
import { rmSync } from "node:fs"
import { resolve } from "node:path"
import { prepareSdkPublishArtifacts } from "./prepare-publish-artifacts.mjs"

let artifactDir
// `--out-dir <dir>` keeps the verified tarballs there (the publish job's inputs).
const outArgument = process.argv.indexOf("--out-dir")
const outDir = outArgument === -1 ? undefined : resolve(process.argv[outArgument + 1])
const keepArtifacts = process.env.SDK_KEEP_ARTIFACTS === "1" || Boolean(outDir)

try {
	if (outDir) rmSync(outDir, { recursive: true, force: true })
	const result = prepareSdkPublishArtifacts({ artifactDir: outDir })
	artifactDir = result.artifactDir

	for (const artifact of result.artifacts) {
		console.log(`[verify] ${artifact.name}@${artifact.version} - ${artifact.tarball}`)
	}

	console.log("\nAll SDK npm artifacts are ready for publish.")
} catch (error) {
	console.error(error instanceof Error ? error.message : error)
	process.exitCode = 1
} finally {
	if (artifactDir && !keepArtifacts) {
		rmSync(artifactDir, { recursive: true, force: true })
	} else if (artifactDir) {
		console.log(`\nKept artifacts in ${artifactDir}`)
	}
}
