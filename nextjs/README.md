# @devorash/nextjs

Recording, masking and activity preferences are configured in Devora Settings.
SDK initialization overrides are ignored. New sessions retain the server's policy
snapshot across exchange and resume. Developer privacy labels take effect only
when selected in Settings; sensitive-field protection remains mandatory.
See [migration details](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Devora adapter for **Next.js (App Router)**. Ships the backend Route Handler adapter, backend SDK constructor, scope guard, and a client entry that re-exports the React provider from [`@devorash/react`](https://www.npmjs.com/package/@devorash/react).

```bash
npm install @devorash/nextjs
```

> **Runtime:** the Devora route handlers verify requests with HMAC (`node:crypto`), so they must run on the **Node.js runtime** — add `export const runtime = "nodejs"` to the route file. Edge runtime is not supported.

## Backend — mount the Devora endpoints

Create your SDK instance once and register your handlers:

```ts
// lib/devora.ts
import { devoraSDK, DEVORA_ENDPOINTS } from "@devorash/nextjs"

export const devora = devoraSDK({
	apiKey: process.env.DEVORA_API_KEY!,
	secretKey: process.env.DEVORA_SECRET_KEY!,
	orgId: process.env.DEVORA_ORG_ID!,
})

devora.register(DEVORA_ENDPOINTS.USER_SEARCH, async (req) => ({
	users: await searchUsers(req.query.term),
}))
devora.register(DEVORA_ENDPOINTS.IMPERSONATE, async (req) => {
	const ctx = req.devoraContext // verified only after HMAC passes
	if (!ctx) throw new Error("Missing verified Devora context")
	return { token: await mintToken(ctx.targetUser.id) }
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

```ts
// middleware.ts
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
import { DevoraProvider, ImpersonationBanner } from "@devorash/nextjs/client"

export function DevoraClientProvider({ children }: { children: React.ReactNode }) {
	return (
		<DevoraProvider
			apiKey={process.env.NEXT_PUBLIC_DEVORA_API_KEY!}
			onImpersonate={async ({ token }) => {
				// Hand the token to your auth layer (prefer an HTTP-only cookie set by a route handler).
				await fetch("/api/devora/session", { method: "POST", body: JSON.stringify({ token }) })
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

`@devorash/nextjs/client` re-exports everything from `@devorash/react` (`DevoraProvider`, `useDevoraImpersonation`, `useDevoraScope`, `ImpersonationBanner`, `ReadOnlyGuard`, `WriteProtected`, …) and carries the `"use client"` boundary for you.

## License

MIT
