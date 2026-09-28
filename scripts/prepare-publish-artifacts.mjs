#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const sdksRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
// Standalone exports have their workspace root beside the packages.
export const repoRoot = existsSync(join(sdksRoot, "package.json"))
	? sdksRoot
	: resolve(sdksRoot, "../..")

/** The public repository every published manifest must point at. */
export const PUBLIC_REPOSITORY = "git+https://github.com/getdevora/devora-sdks.git"
export const PUBLIC_ISSUES = "https://github.com/getdevora/devora-sdks/issues"

export const sdkPackageDirs = [
	"core",
	"node",
	"browser",
	"express",
	"hono",
	"fastify",
	"react",
	"vue",
	"svelte",
	"solid",
	"nextjs",
]

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? repoRoot,
		encoding: "utf8",
		stdio: options.stdio ?? "pipe",
		env: process.env,
	})
	if (result.status !== 0) {
		if (result.stdout) process.stdout.write(result.stdout)
		if (result.stderr) process.stderr.write(result.stderr)
		throw new Error(`${command} ${args.join(" ")} failed`)
	}
	return result
}

function readJson(filePath) {
	return JSON.parse(readFileSync(filePath, "utf8"))
}

function loadPackages() {
	const packages = sdkPackageDirs.map((dir) => {
		const packageDir = join(sdksRoot, dir)
		const manifest = readJson(join(packageDir, "package.json"))
		return { dir, packageDir, manifest }
	})
	const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]))
	return { packages, byName }
}

function validateLockstepVersion(packages) {
	const versions = new Set(packages.map((pkg) => pkg.manifest.version))
	if (versions.size !== 1) {
		throw new Error(`SDK packages must use one lockstep version: ${[...versions].join(", ")}`)
	}

	const version = packages[0].manifest.version
	const constants = readFileSync(join(sdksRoot, "core/src/constants/index.ts"), "utf8")
	if (!constants.includes(`SDK_VERSION = "${version}"`)) {
		throw new Error(`SDK_VERSION must match package version ${version}`)
	}

	return version
}

function rewriteDependencySection(section, packagesByName) {
	if (!section) return section
	const rewritten = { ...section }
	for (const [name, specifier] of Object.entries(rewritten)) {
		if (packagesByName.has(name) && String(specifier).startsWith("workspace:")) {
			rewritten[name] = packagesByName.get(name).manifest.version
		}
	}
	return rewritten
}

function createPublishManifest(manifest, packagesByName) {
	const publishManifest = {
		...manifest,
		dependencies: rewriteDependencySection(manifest.dependencies, packagesByName),
		peerDependencies: rewriteDependencySection(manifest.peerDependencies, packagesByName),
		optionalDependencies: rewriteDependencySection(manifest.optionalDependencies, packagesByName),
	}

	delete publishManifest.devDependencies
	delete publishManifest.scripts

	for (const key of ["dependencies", "peerDependencies", "optionalDependencies"]) {
		if (publishManifest[key] && Object.keys(publishManifest[key]).length === 0) {
			delete publishManifest[key]
		}
	}

	return publishManifest
}

function copyPackageFiles(pkg, stageDir) {
	const files = pkg.manifest.files ?? ["dist", "README.md", "LICENSE"]
	for (const entry of files) {
		const src = join(pkg.packageDir, entry)
		const dest = join(stageDir, entry)
		if (!existsSync(src)) {
			throw new Error(`${pkg.manifest.name} package file is missing: ${entry}`)
		}
		mkdirSync(dirname(dest), { recursive: true })
		cpSync(src, dest, { recursive: true })
	}
}

function parseNpmPackJson(stdout) {
	const start = stdout.indexOf("[")
	const end = stdout.lastIndexOf("]")
	if (start === -1 || end === -1) {
		throw new Error(`Could not parse npm pack output:\n${stdout}`)
	}
	const parsed = JSON.parse(stdout.slice(start, end + 1))
	if (!Array.isArray(parsed) || !parsed[0]?.filename) {
		throw new Error(`Unexpected npm pack output:\n${stdout}`)
	}
	return parsed[0]
}

function tarRead(tarball, entry) {
	const result = run("tar", ["-xOf", tarball, entry])
	return result.stdout
}

function tarList(tarball) {
	const result = run("tar", ["-tzf", tarball])
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
}

/** Files that must never be published, whatever `files` says. */
const FORBIDDEN_ENTRY =
	/(^|\/)(\.env(\..*)?|\.npmrc|\.pypirc|id_[rd]sa[^/]*|[^/]+\.(pem|key|p12|pfx))$/i
/** Secret-shaped content: private keys, cloud and registry tokens, Devora secret keys. */
const SECRET_CONTENT = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
	/\bnpm_[A-Za-z0-9]{36}\b/,
	/\bpypi-[A-Za-z0-9_-]{50,}/,
	/\bsk_(live|test)_[A-Za-z0-9]{16,}/,
	/\bsk_[a-z]+_live_[A-Za-z0-9_-]{32,}/,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}/,
]

/** Throws when an artifact carries a secret-looking file or string. */
export function scanForSecrets(label, entries, readEntry) {
	for (const entry of entries) {
		if (FORBIDDEN_ENTRY.test(entry))
			throw new Error(`${label} would publish a secret-like file: ${entry}`)
		if (entry.endsWith("/")) continue
		const text = readEntry(entry)
		for (const pattern of SECRET_CONTENT)
			if (pattern.test(text))
				throw new Error(`${label} contains a secret-like value in ${entry} (${pattern})`)
	}
}

/** Every file path a manifest declares as an entry point (main/module/types/exports/svelte). */
function declaredEntries(manifest) {
	const targets = new Set()
	for (const key of ["main", "module", "types", "svelte"])
		if (typeof manifest[key] === "string") targets.add(manifest[key])
	const walk = (value) => {
		if (typeof value === "string") targets.add(value)
		else if (value && typeof value === "object") for (const item of Object.values(value)) walk(item)
	}
	walk(manifest.exports)
	return [...targets].map((target) => `package/${target.replace(/^\.\//, "")}`)
}

function verifyTarball(tarball, options = {}) {
	const manifest = JSON.parse(tarRead(tarball, "package/package.json"))
	const manifestText = JSON.stringify(manifest)
	if (manifestText.includes("workspace:")) {
		throw new Error(`${manifest.name} still contains workspace:* in package.json`)
	}
	if (manifest.devDependencies) {
		throw new Error(`${manifest.name} package.json should not publish devDependencies`)
	}

	if (manifest.repository?.url !== PUBLIC_REPOSITORY || manifest.bugs?.url !== PUBLIC_ISSUES) {
		// npm provenance fails when repository.url is not the publishing repository.
		throw new Error(`${manifest.name} repository/bugs must point at ${PUBLIC_REPOSITORY}`)
	}

	const entries = tarList(tarball)
	const entrySet = new Set(entries)
	for (const target of declaredEntries(manifest)) {
		if (!entrySet.has(target))
			throw new Error(`${manifest.name} declares a missing entry: ${target}`)
	}
	scanForSecrets(manifest.name, entries, (entry) => tarRead(tarball, entry))
	for (const entry of entries.filter((name) => name.endsWith(".map"))) {
		if (JSON.parse(tarRead(tarball, entry)).sourcesContent)
			throw new Error(`${manifest.name} ships embedded sources in ${entry}`)
	}
	for (const entry of entries) {
		if (!entry.startsWith("package/")) {
			throw new Error(`${manifest.name} tarball contains unexpected entry: ${entry}`)
		}
		if (entry.includes("node_modules/")) {
			throw new Error(`${manifest.name} tarball contains node_modules`)
		}
	}

	if (manifest.name === "@devorash/core") {
		const generated = tarRead(tarball, "package/dist/constants/api-url.gen.js")
		if (!generated.includes("DEVORA_API_ORIGIN")) {
			throw new Error("@devorash/core tarball is missing generated API origin")
		}
		if (options.expectedOrigin && !generated.includes(JSON.stringify(options.expectedOrigin))) {
			throw new Error(`@devorash/core is not built for ${options.expectedOrigin}`)
		}
		const dashboard = /DEVORA_DASHBOARD_ORIGIN = "([^"]+)"/.exec(generated)?.[1]
		if (!dashboard) throw new Error("@devorash/core tarball is missing the dashboard origin")
		if (options.expectedDashboardOrigin && dashboard !== options.expectedDashboardOrigin) {
			throw new Error(
				`@devorash/core trusts dashboard ${dashboard}, expected ${options.expectedDashboardOrigin}`
			)
		}
	}

	return manifest
}

function packStagedPackage(stageDir, artifactDir) {
	const pack = run("npm", ["pack", "--json", "--pack-destination", artifactDir], {
		cwd: stageDir,
	})
	const packed = parseNpmPackJson(pack.stdout)
	return join(artifactDir, packed.filename)
}

export function prepareSdkPublishArtifacts(options = {}) {
	const artifactDir = resolve(
		options.artifactDir ?? mkdtempSync(join(tmpdir(), "devora-npm-artifacts-"))
	)
	const stageRoot = mkdtempSync(join(tmpdir(), "devora-python-stage-"))
	const { packages, byName } = loadPackages()
	const version = validateLockstepVersion(packages)

	const buildStartedAt = Date.now()
	if (!options.skipBuild) {
		// --force: a turbo cache hit would replay old outputs instead of a clean build.
		run("bun", ["run", "build:sdks", "--", "--force"], { stdio: "inherit" })
		for (const pkg of packages) assertFreshDist(pkg, buildStartedAt)
	}

	mkdirSync(artifactDir, { recursive: true })

	const artifacts = []
	try {
		for (const pkg of packages) {
			const stageDir = join(stageRoot, pkg.dir)
			mkdirSync(stageDir, { recursive: true })
			const publishManifest = createPublishManifest(pkg.manifest, byName)
			writeFileSync(join(stageDir, "package.json"), `${JSON.stringify(publishManifest, null, 2)}\n`)
			copyPackageFiles(pkg, stageDir)

			const tarball = packStagedPackage(stageDir, artifactDir)
			const packedManifest = verifyTarball(tarball, {
				expectedOrigin: options.expectedOrigin ?? process.env.DEVORA_SDK_EXPECTED_ORIGIN,
				expectedDashboardOrigin:
					options.expectedDashboardOrigin ?? process.env.DEVORA_SDK_EXPECTED_DASHBOARD_ORIGIN,
			})
			artifacts.push({ dir: pkg.dir, name: packedManifest.name, version, tarball })
		}
	} finally {
		rmSync(stageRoot, { recursive: true, force: true })
	}

	return { artifactDir, artifacts, version }
}

/** Every dist file must come from this build: stale outputs never ship. */
function assertFreshDist(pkg, buildStartedAt) {
	const dist = join(pkg.packageDir, "dist")
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name)
			const stat = statSync(path)
			if (stat.isDirectory()) walk(path)
			else if (stat.mtimeMs < buildStartedAt - 1000)
				throw new Error(`${pkg.manifest.name} has a stale build output: ${path}`)
		}
	}
	if (existsSync(dist)) walk(dist)
}
