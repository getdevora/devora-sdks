#!/usr/bin/env node
// This runs only in an unprivileged verification job. Publisher jobs use the
// resulting checksum file and never execute source from the candidate tree.
import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const packageNames = [
	"core",
	"node",
	"browser",
	"express",
	"fastify",
	"hono",
	"react",
	"vue",
	"svelte",
	"solid",
	"nextjs",
]
const pythonNames = ["devora_python", "devora_fastapi", "devora_django"]
const mode = process.argv[2]
const root = resolve(process.argv[3] ?? "release")
const sha = process.env.GITHUB_SHA
if (!["create", "verify"].includes(mode) || !/^[a-f0-9]{40}$/.test(sha ?? ""))
	throw new Error(
		"Usage: GITHUB_SHA=<public commit SHA> release-candidate.mjs create|verify <artifact directory>"
	)

const version = JSON.parse(readFileSync("core/package.json", "utf8")).version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Release version must be stable semver")
for (const [index, name] of packageNames.entries()) {
	const manifest = JSON.parse(readFileSync(`${name}/package.json`, "utf8"))
	if (manifest.name !== `@devorash/${name}` || manifest.version !== version)
		throw new Error(`Unexpected npm package name or version: ${name}`)
	for (const dependency of Object.keys({
		...manifest.dependencies,
		...manifest.peerDependencies,
	})) {
		if (!dependency.startsWith("@devorash/")) continue
		const dependencyIndex = packageNames.indexOf(dependency.slice("@devorash/".length))
		if (dependencyIndex < 0 || dependencyIndex >= index)
			throw new Error(`npm publication order would publish ${name} before ${dependency}`)
	}
}
const exportMetadata = JSON.parse(readFileSync(".sdk-export.json", "utf8"))
if (exportMetadata.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(exportMetadata.fingerprint ?? ""))
	throw new Error("Missing verified public export fingerprint")

const expected = []
for (const name of packageNames) expected.push(`npm/devorash-${name}-${version}.tgz`)
for (const name of pythonNames) {
	expected.push(`python/${name}-${version}-py3-none-any.whl`)
	expected.push(`python/${name}-${version}.tar.gz`)
}
expected.sort()

function actualFiles() {
	const files = []
	for (const directory of ["npm", "python"]) {
		for (const name of readdirSync(join(root, directory))) {
			const path = `${directory}/${name}`
			if (!lstatSync(join(root, path)).isFile())
				throw new Error(`Unexpected artifact type: ${path}`)
			files.push(path)
		}
	}
	return files.sort()
}

function digest(path) {
	return createHash("sha256")
		.update(readFileSync(join(root, path)))
		.digest("hex")
}

function assertFiles() {
	if (JSON.stringify(actualFiles()) !== JSON.stringify(expected))
		throw new Error("Expected exactly eleven npm tarballs and six Python distributions")
}

assertFiles()
const metadataPath = join(root, "candidate.json")
const checksumsPath = join(root, "SHA256SUMS")
if (mode === "create") {
	if (existsSync(metadataPath) || existsSync(checksumsPath))
		throw new Error("Candidate metadata already exists")
	const files = expected.map((path) => ({ path, sha256: digest(path) }))
	const metadata = {
		schemaVersion: 1,
		repository: "getdevora/devora-sdks",
		commit: sha,
		version,
		fingerprint: exportMetadata.fingerprint,
		files,
	}
	writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + "\n")
	writeFileSync(
		checksumsPath,
		files.map(({ path, sha256 }) => `${sha256}  ${path}`).join("\n") + "\n"
	)
} else {
	const metadata = JSON.parse(readFileSync(metadataPath, "utf8"))
	if (
		metadata.schemaVersion !== 1 ||
		metadata.repository !== "getdevora/devora-sdks" ||
		metadata.commit !== sha ||
		metadata.version !== version ||
		metadata.fingerprint !== exportMetadata.fingerprint ||
		JSON.stringify(metadata.files?.map((file) => file.path)) !== JSON.stringify(expected)
	)
		throw new Error("Candidate metadata does not match this public commit")
	for (const file of metadata.files)
		if (file.sha256 !== digest(file.path))
			throw new Error(`Candidate checksum mismatch: ${file.path}`)
	const checksums = metadata.files.map(({ path, sha256 }) => `${sha256}  ${path}`).join("\n") + "\n"
	if (readFileSync(checksumsPath, "utf8") !== checksums)
		throw new Error("Candidate checksum manifest mismatch")
}
console.log(
	`Release candidate ${mode} PASS: ${version}, ${expected.length} artifacts, ${exportMetadata.fingerprint}`
)
