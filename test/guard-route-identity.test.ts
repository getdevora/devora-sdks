/**
 * Adversarial guard regressions on real framework routing.
 *
 * Every case asserts whether the application handler actually ran, not only
 * the status code: a guard that answers 403 after the handler already executed
 * (or a router that dispatches somewhere the guard never judged) must fail.
 */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { createRequire } from "node:module"
import net from "node:net"
import { fileURLToPath } from "node:url"
import { Hono } from "hono"
import { createImpersonationGuard } from "../node/src/index"
import { createImpersonationGuard as fastifyGuard } from "../fastify/src/index"
import { createImpersonationGuard as honoGuard } from "../hono/src/index"
import { createDevoraMiddleware } from "../nextjs/src/index"

const require = createRequire(import.meta.url)
const load = (name: string, from: string) =>
	require(require.resolve(name, { paths: [fileURLToPath(new URL(from, import.meta.url))] }))
const express = load("express", "../express/")
const fastify = load("fastify", "../fastify/")

const BRIDGE = "/api/devora/browser-session"

const POLICY = {
	blockedEndpoints: [
		{ method: "*", pattern: "/api/*/delete" },
		{ method: "*", pattern: "/api/admin/**" },
		{ method: "GET", pattern: "/api/export" },
		{ method: "DELETE", pattern: "/api/items/*" },
	],
	safeReadEndpoints: [
		{ method: "POST", pattern: "/api/search" },
		{ method: "POST", pattern: "/alias" },
	],
}

const sdk = {
	getSessionStatus: async () => ({ valid: true }),
	getScopeConfig: async () => POLICY,
} as any

function context(scope: "read" | "write", overrides: Record<string, unknown> = {}) {
	return {
		isImpersonation: true,
		actor: { id: "agent" },
		subject: { id: "customer" },
		sessionId: "sess_guard",
		scope,
		authMethod: "devora_impersonation",
		authorizationSource: "standard",
		recordingAllowed: false,
		expiresAt: Date.now() + 60_000,
		...overrides,
	}
}

/** Mutable per-test context so one server serves every case. */
let currentContext: unknown = null
const getImpersonationContext = () => currentContext as any

const unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => unhandled.push(reason)
beforeAll(() => process.on("unhandledRejection", onUnhandled))
afterAll(() => {
	process.off("unhandledRejection", onUnhandled)
	expect(unhandled).toEqual([])
})

type Counters = Record<string, number>

interface Case {
	name: string
	scope: "read" | "write"
	method: string
	target: string
	headers?: Record<string, string>
	reached: boolean
}

const CASES: Case[] = [
	// Baselines: the policy works on plain paths.
	{
		name: "allowlisted read-scope write",
		scope: "read",
		method: "POST",
		target: "/api/search",
		reached: true,
	},
	{
		name: "read-scope write",
		scope: "read",
		method: "POST",
		target: "/api/items/1",
		reached: false,
	},
	{
		name: "write-scope write",
		scope: "write",
		method: "POST",
		target: "/api/items/1",
		reached: true,
	},
	{
		name: "denied path",
		scope: "write",
		method: "POST",
		target: "/api/users/delete",
		reached: false,
	},
	// N1: an encoded ? or # must not end the judged path early.
	{
		name: "encoded ? in deny path",
		scope: "write",
		method: "POST",
		target: "/api/users%3F/delete",
		reached: false,
	},
	{
		name: "encoded # in deny path",
		scope: "write",
		method: "POST",
		target: "/api/users%23/delete",
		reached: false,
	},
	{
		name: "encoded ? after allowlisted path",
		scope: "read",
		method: "POST",
		target: "/api/search%3F/delete",
		reached: false,
	},
	// N2: frameworks run GET handlers for HEAD.
	{ name: "GET deny rule", scope: "write", method: "GET", target: "/api/export", reached: false },
	{
		name: "HEAD on GET deny rule",
		scope: "write",
		method: "HEAD",
		target: "/api/export",
		reached: false,
	},
	// R4-07: method-override headers are judged too.
	{
		name: "override to denied method",
		scope: "write",
		method: "POST",
		target: "/api/items/1",
		headers: { "x-http-method-override": "DELETE" },
		reached: false,
	},
	{
		name: "override on allowlisted read-scope write",
		scope: "read",
		method: "POST",
		target: "/api/search",
		headers: { "x-http-method-override": "DELETE" },
		reached: false,
	},
	// R4-06: the bridge exemption is opt-in (these servers do not configure it).
	{
		name: "unconfigured bridge path",
		scope: "read",
		method: "POST",
		target: BRIDGE,
		reached: false,
	},
]

function expectCase(item: Case, reachedBefore: number, reachedAfter: number, status: number) {
	const label = `${item.name}: ${item.method} ${item.target} (${item.scope})`
	expect({ label, reached: reachedAfter > reachedBefore }).toEqual({ label, reached: item.reached })
	if (!item.reached) expect({ label, status }).not.toEqual({ label, status: 200 })
}

async function rawRequest(port: number, requestLine: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, "127.0.0.1", () =>
			socket.write(
				`${requestLine}\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
			)
		)
		let data = ""
		socket.on("data", (chunk) => (data += chunk))
		socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0)))
		socket.on("error", reject)
	})
}

function registerExpressRoutes(app: any, counters: Counters) {
	const hit = (name: string) => (_req: any, res: any) => {
		counters[name] = (counters[name] ?? 0) + 1
		res.json({ reached: name })
	}
	app.post("/", hit("root"))
	app.post("/api/search", hit("search"))
	app.post("/api/:name/delete", hit("delete"))
	app.all("/api/admin/*rest", hit("admin"))
	app.get("/api/export", hit("export"))
	app.post("/api/items/:id", hit("items"))
	app.delete("/api/items/:id", hit("items"))
	app.post(BRIDGE, hit("bridge"))
}

async function listen(app: any): Promise<{ port: number; close: () => Promise<void> }> {
	const server = app.listen(0, "127.0.0.1")
	await new Promise<void>((resolve) => server.once("listening", resolve))
	return {
		port: server.address().port,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	}
}

const total = (counters: Counters) => Object.values(counters).reduce((sum, value) => sum + value, 0)

test("Express: the corpus never reaches a prohibited handler", async () => {
	const counters: Counters = {}
	const app = express()
	app.use(createImpersonationGuard({ sdk, getImpersonationContext, showWarnings: false }))
	registerExpressRoutes(app, counters)
	const server = await listen(app)
	try {
		for (const item of CASES) {
			currentContext = context(item.scope)
			const before = total(counters)
			const response = await fetch(`http://127.0.0.1:${server.port}${item.target}`, {
				method: item.method,
				headers: item.headers,
			})
			expectCase(item, before, total(counters), response.status)
		}
	} finally {
		await server.close()
	}
})

test("Express and Fastify: absolute-form targets cannot move the routed path (R4-01)", async () => {
	const counters: Counters = {}
	const app = express()
	app.use(
		createImpersonationGuard({
			sdk,
			getImpersonationContext,
			showWarnings: false,
			bridgePath: BRIDGE,
		})
	)
	registerExpressRoutes(app, counters)
	const expressServer = await listen(app)

	const fastifyCounters: Counters = {}
	const fastifyApp = fastify()
	fastifyApp.addHook(
		"preHandler",
		fastifyGuard({ sdk, getImpersonationContext, showWarnings: false, bridgePath: BRIDGE })
	)
	fastifyApp.post("/", async () => {
		fastifyCounters.root = (fastifyCounters.root ?? 0) + 1
		return { reached: "root" }
	})
	await fastifyApp.listen({ port: 0, host: "127.0.0.1" })
	const fastifyPort = (fastifyApp.server.address() as net.AddressInfo).port
	try {
		for (const [port, counterSet] of [
			[expressServer.port, counters],
			[fastifyPort, fastifyCounters],
		] as const) {
			for (const target of [
				"http://h?/api/search", // allowlisted POST judged, root handler routed
				`http://h?${BRIDGE}`, // bridge exemption judged, root handler routed
				"http://h/api/search",
			]) {
				currentContext = context("read")
				await rawRequest(port, `POST ${target} HTTP/1.1`)
				expect({ target, reached: counterSet.root ?? 0 }).toEqual({ target, reached: 0 })
			}
		}
	} finally {
		await expressServer.close()
		await fastifyApp.close()
	}
})

test("Express: rewrites and mounted routers are judged on the effective route (R3-01)", async () => {
	const counters: Counters = {}
	const app = express()
	// A rewrite that runs before the guard, as documented.
	app.use((req: any, _res: any, next: any) => {
		if (req.url === "/alias") req.url = "/api/admin/purge"
		if (req.url === "/alias-items") req.url = "/api/items/9"
		next()
	})
	app.use(createImpersonationGuard({ sdk, getImpersonationContext, showWarnings: false }))
	registerExpressRoutes(app, counters)
	// A router mounted under a prefix with its own guard: full-path policy applies.
	const mounted = express.Router()
	mounted.use(createImpersonationGuard({ sdk, getImpersonationContext, showWarnings: false }))
	mounted.post("/purge", (_req: any, res: any) => {
		counters.mounted = (counters.mounted ?? 0) + 1
		res.json({})
	})
	app.use("/api/admin", mounted)
	const server = await listen(app)
	try {
		for (const [scope, target] of [
			["write", "/alias"], // alias rewritten onto a denied route
			["read", "/alias"], // allowlisted alias rewritten onto a denied route
			["read", "/alias-items"], // non-allowlisted rewrite target in read scope
		] as const) {
			currentContext = context(scope)
			const before = total(counters)
			const response = await fetch(`http://127.0.0.1:${server.port}${target}`, { method: "POST" })
			expect({ scope, target, status: response.status, reached: total(counters) > before }).toEqual(
				{
					scope,
					target,
					status: 403,
					reached: false,
				}
			)
		}
		expect(counters.mounted ?? 0).toBe(0)
	} finally {
		await server.close()
	}
})

test("Fastify: the corpus, HEAD aliases and rewriteUrl never reach a prohibited handler", async () => {
	const counters: Counters = {}
	const app = fastify({
		rewriteUrl: (req: any) => (req.url === "/alias" ? "/api/admin/purge" : req.url),
	})
	app.addHook("preHandler", fastifyGuard({ sdk, getImpersonationContext, showWarnings: false }))
	const hit = (name: string) => async () => {
		counters[name] = (counters[name] ?? 0) + 1
		return { reached: name }
	}
	app.post("/", hit("root"))
	app.post("/api/search", hit("search"))
	app.post("/api/:name/delete", hit("delete"))
	app.all("/api/admin/*", hit("admin"))
	app.get("/api/export", hit("export")) // exposeHeadRoutes runs this for HEAD
	app.post("/api/items/:id", hit("items"))
	app.delete("/api/items/:id", hit("items"))
	app.post(BRIDGE, hit("bridge"))
	try {
		for (const item of [
			...CASES,
			{
				name: "rewriteUrl alias (write)",
				scope: "write",
				method: "POST",
				target: "/alias",
				reached: false,
			},
			{
				name: "rewriteUrl alias (read)",
				scope: "read",
				method: "POST",
				target: "/alias",
				reached: false,
			},
		] as Case[]) {
			currentContext = context(item.scope)
			const before = total(counters)
			const response = await app.inject({
				method: item.method,
				url: item.target,
				headers: item.headers,
			})
			expectCase(item, before, total(counters), response.statusCode)
		}
	} finally {
		await app.close()
	}
})

test("Hono: the corpus never reaches a prohibited handler, including under basePath", async () => {
	const counters: Counters = {}
	const hit = (name: string) => (c: any) => {
		counters[name] = (counters[name] ?? 0) + 1
		return c.json({ reached: name })
	}
	const app = new Hono()
	app.use("*", honoGuard({ sdk, getImpersonationContext, showWarnings: false }))
	app.post("/", hit("root"))
	app.post("/api/search", hit("search"))
	app.post("/api/:name/delete", hit("delete"))
	app.all("/api/admin/*", hit("admin"))
	app.get("/api/export", hit("export"))
	app.post("/api/items/:id", hit("items"))
	app.delete("/api/items/:id", hit("items"))
	app.post(BRIDGE, hit("bridge"))
	for (const item of CASES) {
		currentContext = context(item.scope)
		const before = total(counters)
		const response = await app.request(`http://h${item.target}`, {
			method: item.method,
			headers: item.headers,
		})
		expectCase(item, before, total(counters), response.status)
	}

	// Policy patterns match the full client-visible path, including basePath.
	const mounted = new Hono().basePath("/v1")
	mounted.use("*", honoGuard({ sdk, getImpersonationContext, showWarnings: false }))
	mounted.post("/api/admin/purge", hit("mounted"))
	currentContext = context("write")
	await mounted.request("http://h/v1/api/admin/purge", { method: "POST" })
	expect(counters.mounted ?? 0).toBe(1) // "/v1/api/admin/purge" is not "/api/admin/**"
})

test("Next.js middleware guard covers Server Actions, pages and base-path aliases (R4-05)", async () => {
	const judge = createDevoraMiddleware({ sdk, getImpersonationContext, showWarnings: false })
	const request = (
		method: string,
		url: string,
		headers: Record<string, string> = {},
		nextPath?: string
	) =>
		Object.assign(
			new Request(url, { method, headers }),
			nextPath ? { nextUrl: { pathname: nextPath } } : {}
		)

	currentContext = context("read")
	// A Server Action is a POST to a page URL: a write unless allowlisted.
	expect(
		(await judge(request("POST", "http://h/dashboard", { "next-action": "abc123" })))?.status
	).toBe(403)
	expect(await judge(request("GET", "http://h/dashboard"))).toBeNull()
	expect(await judge(request("POST", "http://h/api/search"))).toBeNull()

	currentContext = context("write")
	// basePath/locale-stripped nextUrl is a deny-only alias.
	expect(
		(await judge(request("POST", "http://h/app/api/admin/purge", {}, "/api/admin/purge")))?.status
	).toBe(403)
	expect(await judge(request("POST", "http://h/app/api/items/1", {}, "/api/items/1"))).toBeNull()

	currentContext = null
	expect(await judge(request("POST", "http://h/api/admin/purge"))).toBeNull()
})

test("context extraction: async contexts are enforced, malformed ones fail closed (R3-02, R3-05)", async () => {
	const counters: Counters = {}
	const app = express()
	let extractor: () => unknown = () => null
	app.use(
		createImpersonationGuard({
			sdk,
			getImpersonationContext: (() => extractor()) as any,
			showWarnings: false,
		})
	)
	registerExpressRoutes(app, counters)
	const server = await listen(app)
	const post = async (target: string) => {
		const before = total(counters)
		const response = await fetch(`http://127.0.0.1:${server.port}${target}`, { method: "POST" })
		return { status: response.status, reached: total(counters) > before }
	}
	try {
		extractor = async () => context("read")
		expect(await post("/api/items/1")).toEqual({ status: 403, reached: false })
		expect(await post("/api/search")).toEqual({ status: 200, reached: true })

		for (const malformed of ["yes", 1, {}, { isImpersonation: "true" }, Promise.resolve("yes")]) {
			extractor = () => malformed
			expect(await post("/api/search")).toEqual({ status: 500, reached: false })
		}
		for (const expiresAt of [Infinity, "9999999999999", Number.NaN, 1.5e12 + 0.5]) {
			extractor = () => context("write", { expiresAt })
			expect(await post("/api/items/1")).toEqual({ status: 401, reached: false })
		}
		for (const overrides of [{ scope: "admin" }, { sessionId: 7 }, { actor: { id: 1 } }]) {
			extractor = () => context("write", overrides)
			expect(await post("/api/items/1")).toEqual({ status: 401, reached: false })
		}

		// Ordinary traffic is untouched, including explicit non-impersonation.
		extractor = () => null
		expect(await post("/api/admin/purge")).toEqual({ status: 200, reached: true })
		extractor = () => ({ isImpersonation: false })
		expect(await post("/api/admin/purge")).toEqual({ status: 200, reached: true })

		// Extractor, policy and hook failures fail closed without unhandled rejections.
		extractor = () => {
			throw new Error("extractor failed")
		}
		expect(await post("/api/search")).toEqual({ status: 500, reached: false })
		extractor = async () => {
			throw new Error("async extractor failed")
		}
		expect(await post("/api/search")).toEqual({ status: 500, reached: false })
	} finally {
		await server.close()
	}
})

test("guard failures after context extraction fail closed", async () => {
	const failingPolicy = createImpersonationGuard({
		sdk: { ...sdk, getScopeConfig: async () => Promise.reject(new Error("policy down")) },
		getImpersonationContext: () => context("write") as any,
		showWarnings: false,
	})
	const failingHook = createImpersonationGuard({
		sdk,
		getImpersonationContext: () => context("write") as any,
		showWarnings: false,
		isImpersonationAllowed: () => {
			throw new Error("hook failed")
		},
		onBlocked: () => {
			throw new Error("audit failed")
		},
	})
	for (const guard of [failingPolicy, failingHook]) {
		let status = 0
		let nextCalled = false
		const res: any = {
			status(code: number) {
				status = code
				return res
			},
			json() {},
		}
		await guard({ method: "POST", path: "/api/items/1", url: "/api/items/1" }, res, () => {
			nextCalled = true
		})
		expect({ status, nextCalled }).toEqual({ status: 500, nextCalled: false })
	}
})

test("configured bridge path is exact: method, path and every routed target", async () => {
	const guard = createImpersonationGuard({
		sdk,
		getImpersonationContext: () => context("read") as any,
		showWarnings: false,
		bridgePath: BRIDGE,
	})
	const run = async (method: string, url: string, extra: Record<string, unknown> = {}) => {
		let nextCalled = false
		const res: any = { status: () => res, json() {} }
		await guard({ method, path: url, url, ...extra } as any, res, () => {
			nextCalled = true
		})
		return nextCalled
	}
	expect(await run("POST", BRIDGE)).toBe(true)
	for (const url of [
		`${BRIDGE}/`,
		BRIDGE.toUpperCase(),
		BRIDGE.replace("browser", "%62rowser"),
		`/x${BRIDGE}`,
	])
		expect({ url, allowed: await run("POST", url) }).toEqual({ url, allowed: false })
	expect(await run("PUT", BRIDGE)).toBe(false)
	expect(await run("POST", BRIDGE, { headers: { "x-http-method-override": "DELETE" } })).toBe(false)
	// Rewritten away from the bridge: the effective route is judged.
	expect(await run("POST", "/api/items/1", { originalUrl: BRIDGE })).toBe(false)
	expect(() =>
		createImpersonationGuard({ sdk, getImpersonationContext, bridgePath: "/a/../b" } as any)
	).toThrow()
})
