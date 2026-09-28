#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { scanForSecrets } from "./prepare-publish-artifacts.mjs"
import { spawnSync } from "node:child_process"

/*
 * Modes:
 *   (no flags)                 build to a temp dir, then run every check.
 *   --out-dir <dir> --build-only
 *                              build into <dir> and run only the static checks
 *                              (LICENSE, no tests, secret scan, baked origin).
 *                              Nothing third-party is installed or imported, so
 *                              the release job can checksum and upload the
 *                              artifacts before any floating dependency runs.
 *   --artifacts <dir>          verify already-built artifacts: static checks,
 *                              pinned twine check, isolated wheel/sdist imports.
 */
const sdksRoot = resolve(import.meta.dirname, "..")
const repositoryRoot = existsSync(join(sdksRoot, "package.json"))
	? sdksRoot
	: resolve(sdksRoot, "../..")
const argument = (name) => {
	const index = process.argv.indexOf(name)
	return index === -1 ? null : resolve(process.argv[index + 1])
}
const buildOnly = process.argv.includes("--build-only")
const givenArtifacts = argument("--artifacts")
const keepDirectory = argument("--out-dir")
if (buildOnly && givenArtifacts) throw new Error("--build-only and --artifacts are exclusive")
const outputDirectory =
	givenArtifacts ?? keepDirectory ?? mkdtempSync(join(tmpdir(), "devora-python-artifacts-"))
if (keepDirectory && !givenArtifacts) {
	rmSync(keepDirectory, { recursive: true, force: true })
	mkdirSync(keepDirectory, { recursive: true })
}
const expectedOrigin = process.env.DEVORA_SDK_EXPECTED_ORIGIN
const packages = ["python", "django", "fastapi"]

function run(command, args, capture = false) {
	const result = spawnSync(command, args, {
		cwd: repositoryRoot,
		stdio: capture ? "pipe" : "inherit",
		encoding: "utf8",
		env: process.env,
	})
	if (result.error) throw result.error
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`)
	return result.stdout ?? ""
}

/** Archive member names (wheel = zip, sdist = tar.gz). */
function members(artifact) {
	return (
		artifact.endsWith(".whl")
			? run("unzip", ["-Z1", artifact], true)
			: run("tar", ["-tzf", artifact], true)
	)
		.split("\n")
		.filter(Boolean)
}

try {
	if (!givenArtifacts)
		for (const packageName of packages)
			run("uv", ["build", join(sdksRoot, packageName), "--out-dir", outputDirectory])
	const artifacts = readdirSync(outputDirectory)
		.filter((name) => name.endsWith(".whl") || name.endsWith(".tar.gz"))
		.map((name) => join(outputDirectory, name))
	if (artifacts.length !== packages.length * 2)
		throw new Error(`Expected ${packages.length * 2} Python artifacts, found ${artifacts.length}`)
	for (const artifact of artifacts) {
		const names = members(artifact)
		if (!names.some((name) => /(^|\/)LICENSE$/.test(name)))
			throw new Error(`${artifact} does not include LICENSE`)
		if (names.some((name) => /\/tests?\//.test(name)))
			throw new Error(`${artifact} includes tests; the sdist must carry the package only`)
		scanForSecrets(artifact, names, (name) =>
			artifact.endsWith(".whl")
				? run("unzip", ["-p", artifact, name], true)
				: run("tar", ["-xOzf", artifact, name], true)
		)
	}
	const coreWheel = artifacts.find(
		(name) => name.includes("/devora_python-") && name.endsWith(".whl")
	)
	const origin = coreWheel ? run("unzip", ["-p", coreWheel, "devora_sdk/api_url_gen.py"], true) : ""
	if (!origin.includes("DEVORA_API_ORIGIN"))
		throw new Error("devora-python wheel is missing the generated API origin")
	if (expectedOrigin && !origin.includes(JSON.stringify(expectedOrigin)))
		throw new Error(`devora-python is not built for ${expectedOrigin}`)
	if (buildOnly) {
		console.log("Python SDK artifacts built and statically verified (imports run separately).")
	} else {
		run("uvx", ["twine@7.0.0", "check", ...artifacts])
		// twine validates metadata only. Install each wheel into an isolated
		// environment and import it, so a missing module (for example the generated
		// api_url_gen.py) cannot ship silently.
		const wheels = artifacts.filter((name) => name.endsWith(".whl"))
		const wheelFor = (prefix) => wheels.find((name) => name.includes(`/${prefix}-`))
		const core = wheelFor("devora_python")
		if (!core) throw new Error("devora-python wheel not found")
		for (const [prefix, moduleName] of [
			["devora_python", "devora_sdk"],
			["devora_django", "devora_sdk_django"],
			["devora_fastapi", "devora_sdk_fastapi"],
		]) {
			const wheel = wheelFor(prefix)
			if (!wheel) throw new Error(`${prefix} wheel not found`)
			const withs = wheel === core ? ["--with", core] : ["--with", core, "--with", wheel]
			run("uv", [
				"run",
				"--no-project",
				"--isolated",
				...withs,
				"python",
				"-c",
				`import ${moduleName}; print("${moduleName} imports")`,
			])
		}
		// The source distributions must build and import on their own too.
		const sdists = artifacts.filter((name) => name.endsWith(".tar.gz"))
		const coreSdist = sdists.find((name) => name.includes("/devora_python-"))
		for (const [prefix, moduleName] of [
			["devora_django", "devora_sdk_django"],
			["devora_fastapi", "devora_sdk_fastapi"],
		]) {
			const sdist = sdists.find((name) => name.includes(`/${prefix}-`))
			run("uv", [
				"run",
				"--no-project",
				"--isolated",
				"--with",
				coreSdist,
				"--with",
				sdist,
				"python",
				"-c",
				`import devora_sdk, ${moduleName}`,
			])
		}
		console.log("All Python SDK wheels and source distributions are ready for publish.")
	}
} finally {
	if (!keepDirectory && !givenArtifacts) rmSync(outputDirectory, { recursive: true, force: true })
}
