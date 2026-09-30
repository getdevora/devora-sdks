# @devorash/nextjs

Devora adapter for **Next.js (App Router)**. Ships the backend Route Handler adapter, backend SDK constructor, scope guard, browser-session bridge, and a client entry that re-exports the React provider from [`@devorash/react`](https://www.npmjs.com/package/@devorash/react).

Supports Next.js 14, 15 and 16 with React 18 or 19. Import server APIs from `@devorash/nextjs` only in server code, and client APIs from `@devorash/nextjs/client`.

Recording, masking, capture and scope policy are configured by a Devora administrator in the dashboard and authorized by Devora for each session; they are not SDK options. See [Capture settings](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

```bash
npm install @devorash/nextjs redis
```

> **Runtime:** the Devora route handlers verify requests with HMAC (`node:crypto`), so they must run on the **Node.js runtime** — add `export const runtime = "nodejs"` to the route file. Edge runtime is not supported.

## Backend — mount the Devora endpoints

Create your SDK instance once and register your handlers:

```ts
// lib/devora.ts
import { createClient } from "redis"
import { devoraSDK, DEVORA_ENDPOINTS } from "@devorash/nextjs"

// Replay protection shared by every instance of your app (required in production).
const redis = createClient({ url: process.env.REDIS_URL }).on("error", (err) => console.error("Redis error", err))
let redisReady: Promise<unknown> | undefined // one connection, shared by concurrent first requests

export const devora = devoraSDK({
	apiKey: process.env.DEVORA_API_KEY!, // pk_server_live_...
	secretKey: process.env.DEVORA_SECRET_KEY!, // sk_server_live_...
	orgId: process.env.DEVORA_ORG_ID!,
	replayStore: {
		async consume(namespace, requestId, expiresAt) {
			await (redisReady ??= redis.connect().catch((err) => {
				redisReady = undefined // retry on the next request
				throw err
			}))
			const key = `devora:replay:${namespace}:${requestId}`
			// Atomic insert-if-absent kept until expiresAt; an error makes the SDK fail closed (503).
			const reply = await redis.sendCommand<string | null>(["SET", key, "1", "NX", "PXAT", String(expiresAt)])
			return reply === "OK"
		},
	},
})

devora.register(DEVORA_ENDPOINTS.USER_SEARCH, async (req) => ({
	users: await searchUsers(req.query.term),
}))
devora.register(DEVORA_ENDPOINTS.IMPERSONATE, async (req) => {
	const ctx = req.devoraContext // verified only after HMAC passes
	if (!ctx) throw new Error("Missing verified Devora context")
	// Store ctx unchanged in the token or session: readDevoraContext returns it to the guard.
	return { token: await mintToken(ctx.targetUser.id, ctx) }
})
devora.register(DEVORA_ENDPOINTS.TERMINATE, async (req) => {
	await invalidateSession(req.sessionId)
	return { success: true }
})
```

Mount them in a single catch-all route:

```ts
// app/api/devora/[...devora]/route.ts
import { devora } from "@/lib/devora"
import { createDevoraRouteHandlers } from "@devorash/nextjs"

export const runtime = "nodejs"
export const { GET, POST, PUT, PATCH, DELETE } = createDevoraRouteHandlers(devora)
```

Set your app's public URL + mount path (`/api/devora`) in the Devora dashboard.

The SDK takes its environment from the `environment` option, then `DEVORA_ENV`, then
`NODE_ENV`, and defaults to production; in production it refuses to start without a
`replayStore`. `next build` and `next start` set `NODE_ENV=production`. Any store whose
`consume` is an atomic insert-if-absent shared by every instance works; see the
[replay-store contract](https://github.com/getdevora/devora-sdks/blob/main/SIGNING.md#replay-store).
`lib/devora.ts` is also evaluated while `next build` collects route data, so the
`DEVORA_*` variables must be set at build time too.

**Local development only:** `next dev` sets `NODE_ENV=development`, so unless the
`environment` option or `DEVORA_ENV` says otherwise (`DEVORA_ENV=production` wins over
`NODE_ENV`), you can omit `replayStore` there and the SDK keeps request ids in memory.
That protects a single process only; never deploy without a `replayStore`.

## Backend — guard your own API routes

Block writes in read-only sessions (and terminated sessions, with `enforceLiveness`) before a route handler runs:

```ts
// app/api/projects/route.ts
import { withDevoraGuard } from "@devorash/nextjs"
import { devora } from "@/lib/devora"

export const runtime = "nodejs"

async function handler(request: Request) {
	// ... your write logic
	return Response.json({ ok: true })
}

export const POST = withDevoraGuard(handler, {
	sdk: devora,
	// Read the verified impersonation context from your own session/JWT.
	getImpersonationContext: (request) => readDevoraContext(request),
	enforceLiveness: true,
})
```

`getImpersonationContext` must return data from a **verified** session/token, never from raw request headers or JSON supplied by the browser.

### Guard Server Actions, pages and Pages Router API routes

`withDevoraGuard` protects only the route handler it wraps. Server Actions (a `POST` to a page URL with a `Next-Action` header), page requests and Pages Router API routes need the middleware guard. In read scope a Server Action is a write unless you allowlist it.

The guard needs the Node.js runtime, which Next.js supports for middleware from 15.5. On Next.js 16, name the file `proxy.ts`, export the function as `proxy`, and leave `runtime` out of `config` (proxy always runs on Node.js; Next.js rejects the option there). On Next.js 14 and 15 before 15.5, wrap each route handler with `withDevoraGuard` instead.

```ts
// middleware.ts (Next.js 15.5+)
import { NextResponse, type NextRequest } from "next/server"
import { createDevoraMiddleware } from "@devorash/nextjs"
import { devora } from "@/lib/devora"

const devoraGuard = createDevoraMiddleware({
	sdk: devora,
	getImpersonationContext: (request) => readDevoraContext(request),
})

export async function middleware(request: NextRequest) {
	return (await devoraGuard(request)) ?? NextResponse.next()
}

// The SDK verifies requests with node:crypto, so middleware runs on the Node.js runtime.
export const config = {
	runtime: "nodejs",
	matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
```

Patterns match the full client-visible path, including `basePath` and locale prefixes. Next.js applies `next.config` rewrites after middleware, so if a rewrite maps an alias onto a protected route, block the alias as well or also wrap the destination with `withDevoraGuard`.

## Frontend — client provider

```tsx
// app/devora-provider.tsx
"use client"

import { DevoraProvider, ImpersonationBanner } from "@devorash/nextjs/client"

export function DevoraClientProvider({ children }: { children: React.ReactNode }) {
	return (
		<DevoraProvider
			apiKey={process.env.NEXT_PUBLIC_DEVORA_API_KEY!}
			onImpersonate={async ({ token }) => {
				// YOU IMPLEMENT: a route handler that validates `token` and sets your session cookie.
				const response = await fetch("/api/devora/session", {
					method: "POST",
					credentials: "include",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ token }),
				})
				if (!response.ok) throw new Error("Could not start impersonation")
				window.location.replace("/dashboard")
			}}
			onSessionEnd={async () => {
				await fetch("/api/logout", { method: "POST" })
				window.location.replace("/login")
			}}
		>
			<ImpersonationBanner />
			{children}
		</DevoraProvider>
	)
}
```

Keep the `"use client"` directive: this file passes functions (`onImpersonate`, `onSessionEnd`) to `DevoraProvider`, and a Server Component such as `app/layout.tsx` cannot pass functions to a Client Component. Render `<DevoraClientProvider>` from your root layout.

`NEXT_PUBLIC_DEVORA_API_KEY` is your client key (`pk_client_live_…`); add your app's origin under **Developer → Integration → Allowed origins (client keys)** in the dashboard. Never give the server variables a `NEXT_PUBLIC_` prefix.

`@devorash/nextjs/client` re-exports everything from `@devorash/react` (`DevoraProvider`, `useDevoraImpersonation`, `useDevoraScope`, `ImpersonationBanner`, `ReadOnlyGuard`, `WriteProtected`, …). Its exports are already Client Components, but that does not make the file importing them one: any file that passes callbacks to them must start with `"use client"` itself.

## New tabs and reloads — session bridge

Devora's per-tab capability is never stored in the browser, so a reload or new tab needs your backend to vouch for it. Mount the bridge route (a static route takes precedence over the `[...devora]` catch-all):

```ts
// app/api/devora/browser-session/route.ts
import { createBrowserSessionRouteHandler } from "@devorash/nextjs"
import { devora } from "@/lib/devora"

export const runtime = "nodejs"
export const POST = createBrowserSessionRouteHandler({
	sdk: devora,
	// Read the impersonation context from your own verified session/JWT.
	getImpersonationContext: (request) => readDevoraContext(request),
	// Exact origins allowed to restore tabs; requests from other origins get 403.
	allowedOrigins: ["https://app.example.com"],
})
```

Then pass `sessionBridge` to `DevoraProvider`:

```tsx
sessionBridge={{
	restore: async ({ tabRef, signal }) => {
		const response = await fetch("/api/devora/browser-session", {
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tabRef }),
			signal,
		})
		if (!response.ok) throw new Error(`Session bridge failed: ${response.status}`)
		return response.json()
	},
}}
```

While the bridge resolves the provider renders `loadingFallback`; if Devora cannot restore the tab it renders `blockedFallback` (default: a safety screen). If your middleware or proxy guard runs in read scope, add `bridgePath: "/api/devora/browser-session"` to its options so the bridge `POST` is allowed.

## License

MIT
