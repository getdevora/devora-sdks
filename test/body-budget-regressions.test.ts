import { expect, test } from "bun:test"
import { BodyReadError, readBoundedBody } from "../core/src/security/request-body.ts"
import { createDevoraRouteHandlers, createBrowserSessionRouteHandler } from "../nextjs/src/index.ts"
import { honoAdapter, createBrowserSessionHandler } from "../hono/src/index.ts"
import { Hono } from "hono"
import type { DevoraBackendSDK } from "../node/src/index.ts"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { request as httpRequest } from "node:http"
import {
	expressAdapter,
	expressMiddleware,
	createBrowserSessionHandler as expressBridge,
} from "../express/src/index"
import { fastifyAdapter } from "../fastify/src/index"

const require = createRequire(import.meta.url)
const express = require(
	require.resolve("express", { paths: [fileURLToPath(new URL("../express/", import.meta.url))] })
)
const Fastify = require(
	require.resolve("fastify", { paths: [fileURLToPath(new URL("../fastify/", import.meta.url))] })
)

function oversizedRequest(url: string, chunkBytes = 256) {
	let bytes = 0,
		cancelled = false
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				bytes += chunkBytes
				controller.enqueue(new Uint8Array(chunkBytes).fill(32))
			},
			cancel() {
				cancelled = true
			},
		},
		{ highWaterMark: 0 }
	)
	return {
		request: new Request(url, { method: "POST", body, duplex: "half" } as RequestInit),
		bytes: () => bytes,
		cancelled: () => cancelled,
	}
}
test("stream budget measures bytes before parsing and cancels at first overrun", async () => {
	const stream = oversizedRequest("https://test.invalid/")
	await expect(readBoundedBody(stream.request, 1024)).rejects.toMatchObject({
		status: 413,
		code: "BODY_TOO_LARGE",
	})
	expect(stream.bytes()).toBe(1280)
	expect(stream.cancelled()).toBe(true)
})
test("body deadline bounds even a stalled stream and declared overflows read nothing", async () => {
	let cancelled = false
	const stalled = new Request("https://test.invalid", {
		method: "POST",
		body: new ReadableStream({
			pull: () => new Promise(() => {}),
			cancel() {
				cancelled = true
			},
		}),
		duplex: "half",
	} as RequestInit)
	await expect(readBoundedBody(stalled, 100, 10)).rejects.toBeInstanceOf(BodyReadError)
	expect(cancelled).toBe(true)
	const request = oversizedRequest("https://test.invalid")
	request.request.headers.set("Content-Length", "4096")
	await expect(readBoundedBody(request.request, 1024)).rejects.toMatchObject({ status: 413 })
	expect(request.bytes()).toBe(0)
})
test("UTF-8 budget includes multibyte text and whitespace around JSON", async () => {
	const bytes = new TextEncoder().encode('  {"name":"é😀"}  ')
	const make = () => new Request("https://test.invalid", { method: "POST", body: bytes })
	expect(await readBoundedBody(make(), bytes.length)).toBe('  {"name":"é😀"}  ')
	await expect(readBoundedBody(make(), bytes.length - 1)).rejects.toMatchObject({ status: 413 })
})
test("Next.js and Hono signed and bridge routes bound missing-Content-Length bodies", async () => {
	const sdk = {
		getRoutes: () => [{ method: "POST", path: "/test" }],
	} as unknown as DevoraBackendSDK
	const next = createDevoraRouteHandlers(sdk, { maxBodySize: 1024 })
	const nextBridge = createBrowserSessionRouteHandler({ sdk, getImpersonationContext: () => null })
	const hono = honoAdapter(sdk, { maxBodySize: 1024 })
	const honoBridge = new Hono().post(
		"/bridge",
		createBrowserSessionHandler({ sdk, getImpersonationContext: () => null })
	)
	for (const [path, limit, handler] of [
		["/test", 1024, (r: Request) => next.POST(r, { params: Promise.resolve({}) })],
		["/bridge", 4096, nextBridge],
		["/test", 1024, (r: Request) => hono.fetch(r)],
		["/bridge", 4096, (r: Request) => honoBridge.fetch(r)],
	] as const) {
		const stream = oversizedRequest("https://test.invalid" + path)
		const response = await handler(stream.request)
		expect(response.status).toBe(413)
		expect(stream.bytes()).toBeLessThanOrEqual(limit + 256)
		expect(stream.cancelled()).toBe(true)
	}
})

test("native Express bounds raw chunked JSON before canonicalization for both mounting APIs and the bridge", async () => {
	let validations = 0
	const sdk = {
		getRoutes: () => [{ method: "POST", path: "/test" }],
		verifyRequest: async () => {
			validations++
			return { valid: false, errorCode: "SECURITY_ERROR" }
		},
	} as unknown as DevoraBackendSDK
	const app = express()
	app.use("/router", expressAdapter(sdk, { maxBodySize: 256 }))
	app.use("/middleware", expressMiddleware(sdk, { maxBodySize: 256 }))
	app.post("/bridge", expressBridge({ sdk, getImpersonationContext: () => null }))
	// A permissive application parser cannot enlarge the preceding SDK routes.
	app.use(express.json({ limit: "8mb" }))
	const server = app.listen(0, "127.0.0.1")
	await new Promise<void>((resolve) => server.once("listening", resolve))
	const origin = `http://127.0.0.1:${server.address().port}`
	try {
		for (const path of ["/router/test", "/middleware/test", "/bridge"]) {
			const status = await new Promise<number>((resolve, reject) => {
				const request = httpRequest(
					origin + path,
					{ method: "POST", headers: { "Content-Type": "application/json" } },
					(response) => {
						response.resume()
						resolve(response.statusCode!)
					}
				)
				request.on("error", reject)
				// Whitespace would disappear under the old post-parse size check.
				request.write(" ".repeat(8192))
				request.end("{}")
			})
			expect(status).toBe(413)
		}
		expect(validations).toBe(0)
		expect(
			(
				await fetch(origin + "/router/test", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "{}",
				})
			).status
		).toBe(401)
		expect(validations).toBe(1)
	} finally {
		server.closeAllConnections()
		await new Promise<void>((resolve) => server.close(resolve))
	}
})

test("native Fastify applies the SDK limit before parsing and retains a stricter application limit", async () => {
	for (const [applicationLimit, sdkLimit] of [
		[8 * 1024 * 1024, 256],
		[128, 1024],
	]) {
		let validations = 0
		const sdk = {
			getRoutes: () => [{ method: "POST", path: "/test" }],
			verifyRequest: async () => {
				validations++
				return { valid: false, errorCode: "SECURITY_ERROR" }
			},
		} as unknown as DevoraBackendSDK
		const server = Fastify({ bodyLimit: applicationLimit })
		server.register(fastifyAdapter(sdk, { maxBodySize: sdkLimit }), { prefix: "/devora" })
		try {
			const response = await server.inject({
				method: "POST",
				url: "/devora/test",
				headers: { "Content-Type": "application/json" },
				payload: " ".repeat(512) + "{}",
			})
			expect(response.statusCode).toBe(413)
			expect(validations).toBe(0)
		} finally {
			await server.close()
		}
	}
})
