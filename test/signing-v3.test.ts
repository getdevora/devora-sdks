/**
 * Request signing v3 conformance (Node). Vectors are shared with the Python
 * SDK and the Devora backend; see signing-v3-vectors.json.
 */
import { afterEach, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { Hono } from "hono"
import {
	buildCanonicalString,
	encodePathParam,
	parseSignatureHeaders,
	strictEncode,
} from "../core/dist/index.js"
import { devoraSDK, processRequest, type DevoraBackendSDK } from "../node/dist/index.js"
import { expressAdapter } from "../express/dist/index.js"
import { fastifyAdapter } from "../fastify/dist/index.js"
import { honoAdapter } from "../hono/dist/index.js"
import { createDevoraRouteHandlers } from "../nextjs/dist/index.js"
import {
	TEST_KEYS,
	signTestRequest,
	signedAdapterRequest,
	strictEncode as refEncode,
	vectors,
} from "./support/signing"

const require = createRequire(import.meta.url)
const load = (name: string, from: string) =>
	require(require.resolve(name, { paths: [fileURLToPath(new URL(from, import.meta.url))] }))
const express = load("express", "../express/")
const fastify = load("fastify", "../fastify/")

const realFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = realFetch
})
/** Vectors carry a fixed sent-at; accept it for vector checks only. */
const VECTOR_TOLERANCE = 100_000_000

function freshSdk(): DevoraBackendSDK {
	globalThis.fetch = async () =>
		Response.json({
			success: true,
			data: {
				version: 1,
				safeReadEndpoints: [],
				blockedEndpoints: [],
				cachedUntil: Date.now() + 60_000,
			},
		})
	return devoraSDK({ ...TEST_KEYS, environment: "test" })
}

type Vector = (typeof vectors.positive)[number]
const hexBytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"))
function vectorHeaders(vector: Vector): Record<string, string> {
	const c = vectors.constants
	return {
		"x-devora-signature-version": "3",
		"x-devora-key-id": c.keyId,
		"x-devora-org-id": c.orgId,
		"x-devora-sent-at": c.sentAt,
		"x-devora-request-id": c.requestId,
		"x-devora-signature": vector.signature,
		...(vector.bodyHex ? { "content-type": "application/json" } : {}),
	}
}
function vectorRequest(
	vector: Vector,
	overrides: Partial<{
		headers: Record<string, string | string[]>
		path: string
		query: string
		body: Uint8Array
		method: string
	}> = {}
) {
	return {
		method: overrides.method ?? vector.method,
		path: overrides.path ?? vector.path,
		query: overrides.query ?? vector.query,
		body: overrides.body ?? hexBytes(vector.bodyHex),
		headers: overrides.headers ?? vectorHeaders(vector),
	}
}
const vector = (id: string) => vectors.positive.find((v) => v.id === id)!

test("the canonical builder and encoder reproduce every shared vector", () => {
	const c = vectors.constants
	for (const v of vectors.positive)
		expect(
			buildCanonicalString({
				direction: v.direction as "devora-to-customer",
				keyId: c.keyId,
				orgId: c.orgId,
				sentAt: c.sentAt,
				requestId: c.requestId,
				method: v.method,
				path: v.path,
				query: v.query,
				bodySha256: v.bodySha256,
			})
		).toBe(v.canonical)
	for (const { input, encoded } of vectors.encoder) {
		expect(strictEncode(input)).toBe(encoded)
		expect(refEncode(input)).toBe(encoded)
		// Strict output survives WHATWG URL serialization untouched.
		expect(new URL(`https://h/x/${encoded}?q=${encoded}`).href).toBe(
			`https://h/x/${encoded}?q=${encoded}`
		)
	}
	for (const segment of vectors.refusedSegments) expect(() => encodePathParam(segment)).toThrow()
})

test("the SDK verifier accepts devora-to-customer vectors and rejects the other direction", async () => {
	for (const v of vectors.positive) {
		const sdk = freshSdk()
		const result = await sdk.verifyRequest(vectorRequest(v), {
			timestampTolerance: VECTOR_TOLERANCE,
		})
		expect({ id: v.id, valid: result.valid }).toEqual({
			id: v.id,
			valid: v.direction === "devora-to-customer",
		})
		if (v.direction !== "devora-to-customer") expect(result.errorCode).toBe("INVALID_SIGNATURE")
		sdk.destroy()
	}
})

test("every malformed, duplicated or lenient header is rejected (N01-N05)", async () => {
	const v = vector("V01")
	const good = vectorHeaders(v)
	const cases: Array<Record<string, string | string[]>> = []
	for (const [name, values] of Object.entries(vectors.badHeaders))
		for (const value of values) {
			const signature = good["x-devora-signature"]!
			const mutated =
				name === "x-devora-signature"
					? {
							UPPER: signature.toUpperCase(),
							APPEND_zz: `${signature}zz`,
							APPEND_0: `${signature}0`,
							TRUNCATE_1: signature.slice(0, -1),
							"": "",
						}[value]!
					: value
			cases.push({ ...good, [name]: mutated })
		}
	cases.push({
		...good,
		"x-devora-signature": [good["x-devora-signature"]!, good["x-devora-signature"]!],
	})
	cases.push({
		...good,
		"x-devora-signature": `${good["x-devora-signature"]}, ${good["x-devora-signature"]}`,
	})
	cases.push({ ...good, "X-Devora-Signature": good["x-devora-signature"]! })
	for (const headers of cases) {
		expect(parseSignatureHeaders(headers).valid).toBe(false)
		const sdk = freshSdk()
		expect(
			(
				await sdk.verifyRequest(vectorRequest(v, { headers }), {
					timestampTolerance: VECTOR_TOLERANCE,
				})
			).valid
		).toBe(false)
		sdk.destroy()
	}
})

test("path, query and body bytes are authenticated exactly (N06-N08, N11, N15, N18)", async () => {
	const check = async (
		v: Vector,
		overrides: Parameters<typeof vectorRequest>[1],
		expected: string | true
	) => {
		const sdk = freshSdk()
		const result = await sdk.verifyRequest(vectorRequest(v, overrides), {
			timestampTolerance: VECTOR_TOLERANCE,
		})
		expect(result.valid ? true : result.errorCode).toBe(expected)
		sdk.destroy()
	}
	await check(vector("V02a"), { query: "a=2&a=1" }, "INVALID_SIGNATURE")
	await check(vector("V08"), { query: "term=a" }, "INVALID_SIGNATURE")
	await check(vector("V09"), { path: vector("V09").path.toLowerCase() }, "INVALID_REQUEST_TARGET")
	await check(vector("V01"), { query: "term=alice#frag" }, "INVALID_REQUEST_TARGET")
	for (const path of ["/user//search", "/user/./search", "/user/%2e%2e/search", "user/search"])
		await check(vector("V01"), { path }, "INVALID_REQUEST_TARGET")
	const bodies = ["V04a", "V04b", "V04c", "V04d"].map((id) => vector(id))
	for (const signed of bodies)
		for (const sent of bodies)
			await check(
				signed,
				{ body: hexBytes(sent.bodyHex) },
				signed === sent ? true : "INVALID_SIGNATURE"
			)
	await check(
		vector("V04b"),
		{ headers: { ...vectorHeaders(vector("V04b")), "content-encoding": "gzip" } },
		"UNSUPPORTED_CONTENT_ENCODING"
	)
	await check(vector("V12"), {}, true)
	await check(vector("V06a"), {}, true)
})

test("replays, timestamp edges and zero tolerance (N13, N14, N19)", async () => {
	const sdk = freshSdk()
	const request = signedAdapterRequest({ method: "GET", path: "/test" })
	expect((await sdk.verifyRequest(request)).valid).toBe(true)
	expect((await sdk.verifyRequest(request)).errorCode).toBe("REPLAYED_REQUEST")
	const now = Math.floor(Date.now() / 1000)
	expect(
		(
			await sdk.verifyRequest(
				signedAdapterRequest({ method: "GET", path: "/test", sentAt: String(now - 290) })
			)
		).valid
	).toBe(true)
	expect(
		(
			await sdk.verifyRequest(
				signedAdapterRequest({ method: "GET", path: "/test", sentAt: String(now - 310) })
			)
		).errorCode
	).toBe("TIMESTAMP_EXPIRED")
	expect(
		(
			await sdk.verifyRequest(
				signedAdapterRequest({ method: "GET", path: "/test", sentAt: String(now - 2) }),
				{ timestampTolerance: 0 }
			)
		).errorCode
	).toBe("TIMESTAMP_EXPIRED")
	sdk.destroy()
})

test("replay store failures fail closed", async () => {
	globalThis.fetch = async () =>
		Response.json({
			success: true,
			data: {
				version: 1,
				safeReadEndpoints: [],
				blockedEndpoints: [],
				cachedUntil: Date.now() + 60_000,
			},
		})
	const sdk = devoraSDK({
		...TEST_KEYS,
		replayStore: {
			consume: async () => {
				throw new Error("store down")
			},
		},
	})
	const result = await sdk.verifyRequest(signedAdapterRequest({ method: "GET", path: "/test" }))
	expect(result.errorCode).toBe("REPLAY_STORE_UNAVAILABLE")
	sdk.destroy()
})

test("processRequest parses only verified bytes, with one parser (N17, V17)", async () => {
	const sdk = freshSdk()
	let received: { query: unknown; body: unknown; params: unknown } | undefined
	sdk.register(
		"/echo/:id",
		(req) => {
			received = { query: req.query, body: req.body, params: req.params }
			return { ok: true }
		},
		{ method: "POST" }
	)
	const ok = await processRequest(
		sdk,
		sdk.getRoutes(),
		signedAdapterRequest({
			method: "POST",
			path: `/echo/${strictEncode("a/b c@é")}`,
			query: "a=2&a=1&__proto__=x&constructor=y",
			body: '{"__proto__":{"isAdmin":true},"n":1e-7}',
		})
	)
	expect(ok.success).toBe(true)
	expect(received!.params).toEqual({ id: "a/b c@é" })
	const query = received!.query as Record<string, unknown>
	expect(Object.getPrototypeOf(query)).toBeNull()
	expect(query.a).toEqual(["2", "1"])
	expect(query.__proto__).toBe("x")
	expect(query.constructor).toBe("y")
	expect(({} as Record<string, unknown>).isAdmin).toBeUndefined()
	expect((received!.body as { n: number }).n).toBe(1e-7)

	const invalidUtf8 = await processRequest(
		sdk,
		sdk.getRoutes(),
		signedAdapterRequest({ method: "POST", path: "/echo/x", body: hexBytes(vector("V17").bodyHex) })
	)
	expect(invalidUtf8.errorCode).toBe("INVALID_BODY")
	const getWithBody = await processRequest(sdk, sdk.getRoutes(), {
		...signedAdapterRequest({ method: "GET", path: "/test" }),
		body: new TextEncoder().encode("{}"),
	})
	expect(getWithBody.errorCode).toBe("INVALID_BODY")
	sdk.destroy()
})

/** One signed request through each real adapter: order, encoding, replay and tamper. */
async function exerciseAdapter(
	send: (
		target: string,
		init: { method: string; headers: Record<string, string>; body?: Uint8Array }
	) => Promise<{ status: number; json: any }>,
	mount: string,
	sdk: DevoraBackendSDK,
	seen: unknown[]
) {
	const path = `/echo/${strictEncode("a/b c@é")}`
	const query = "a=2&a=1&term=it%27s"
	const signed = signTestRequest({ method: "POST", path, query, body: { hello: "wörld" } })
	const init = { method: "POST", headers: signed.headers, body: signed.body }
	const first = await send(`${mount}${path}?${query}`, init)
	expect(first.status).toBe(200)
	expect(seen.pop()).toEqual({
		id: "a/b c@é",
		a: ["2", "1"],
		term: "it's",
		body: { hello: "wörld" },
	})
	expect((await send(`${mount}${path}?${query}`, init)).json.errorCode).toBe("REPLAYED_REQUEST")
	const again = signTestRequest({ method: "POST", path, query, body: { hello: "wörld" } })
	const tampered = await send(`${mount}${path}?a=1&a=2&term=it%27s`, {
		method: "POST",
		headers: again.headers,
		body: again.body,
	})
	expect(tampered.json.errorCode).toBe("INVALID_SIGNATURE")
	expect(seen).toEqual([])
}

function echoSdk(seen: unknown[]) {
	const sdk = freshSdk()
	sdk.register(
		"/echo/:id",
		(req) => {
			const query = req.query as Record<string, unknown>
			seen.push({ id: req.params.id, a: query.a, term: query.term, body: req.body })
			return { ok: true }
		},
		{ method: "POST" }
	)
	return sdk
}

test("Express adapter verifies wire bytes and refuses pre-parsed bodies (N16)", async () => {
	const seen: unknown[] = []
	const sdk = echoSdk(seen)
	const app = express()
	app.use("/devora", expressAdapter(sdk))
	const parsedFirst = express()
	parsedFirst.use(express.json())
	parsedFirst.use("/devora", expressAdapter(sdk))
	const servers = [app.listen(0, "127.0.0.1"), parsedFirst.listen(0, "127.0.0.1")]
	await Promise.all(
		servers.map((server) => new Promise<void>((resolve) => server.once("listening", resolve)))
	)
	const origin = (i: number) => `http://127.0.0.1:${servers[i]!.address().port}`
	try {
		await exerciseAdapter(
			async (target, init) => {
				const response = await realFetch(origin(0) + target, init)
				expect(response.headers.get("Cache-Control")).toBe("private, no-store")
				return { status: response.status, json: await response.json() }
			},
			"/devora",
			sdk,
			seen
		)
		const signed = signTestRequest({ method: "POST", path: "/echo/x", body: {} })
		const rejected = await realFetch(origin(1) + "/devora/echo/x", {
			method: "POST",
			headers: signed.headers,
			body: signed.body,
		})
		expect(rejected.status).toBe(500)
		expect(((await rejected.json()) as { errorCode: string }).errorCode).toBe(
			"DEVORA_BODY_ALREADY_PARSED"
		)
	} finally {
		await Promise.all(
			servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
		)
		sdk.destroy()
	}
})

test("Fastify adapter verifies wire bytes inside its encapsulated parser", async () => {
	const seen: unknown[] = []
	const sdk = echoSdk(seen)
	const app = fastify()
	app.register(fastifyAdapter(sdk), { prefix: "/devora" })
	app.post("/app-json", async (request: any) => request.body) // application parsers still work
	try {
		await exerciseAdapter(
			async (target, init) => {
				const response = await app.inject({
					method: init.method,
					url: target,
					headers: init.headers,
					payload: init.body ? Buffer.from(init.body) : undefined,
				})
				expect(response.headers["cache-control"]).toBe("private, no-store")
				return { status: response.statusCode, json: response.json() }
			},
			"/devora",
			sdk,
			seen
		)
		const appJson = await app.inject({ method: "POST", url: "/app-json", payload: { ok: 1 } })
		expect(appJson.json()).toEqual({ ok: 1 })
	} finally {
		await app.close()
		sdk.destroy()
	}
})

test("Hono and Next.js adapters verify wire bytes", async () => {
	const seen: unknown[] = []
	const sdk = echoSdk(seen)
	const app = new Hono()
	app.route("/devora", honoAdapter(sdk))
	await exerciseAdapter(
		async (target, init) => {
			const response = await app.request(`http://h${target}`, init)
			expect(response.headers.get("Cache-Control")).toBe("private, no-store")
			return { status: response.status, json: await response.json() }
		},
		"/devora",
		sdk,
		seen
	)

	const handlers = createDevoraRouteHandlers(sdk)
	await exerciseAdapter(
		async (target, init) => {
			const url = new URL(`https://app.example.com${target}`)
			const segments = url.pathname.split("/").filter(Boolean).slice(2).map(decodeURIComponent)
			const response = await handlers.POST(new Request(url, init), {
				params: Promise.resolve({ devora: segments }),
			} as any)
			expect(response.headers.get("Cache-Control")).toBe("private, no-store")
			return { status: response.status, json: await response.json() }
		},
		"/api/devora",
		sdk,
		seen
	)
	sdk.destroy()
})
