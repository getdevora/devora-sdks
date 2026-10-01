# @devorash/hono

Recording, masking, capture and scope policy are configured in the Devora
dashboard and authorized server-side for each session. The backend SDK accepts
no settings for them.
See [SETTINGS.md](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Hono adapter for Devora Backend SDK. Supports Hono 4.

## Installation

```bash
npm install @devorash/node @devorash/hono hono
# TypeScript projects on Node.js also need the Node.js type package:
npm install -D @types/node
```

## Usage

```typescript
import { Hono } from "hono"
import { devoraSDK, DEVORA_ENDPOINTS, type ImpersonationTerminateRequest } from "@devorash/node"
import { honoAdapter } from "@devorash/hono"

// Initialize SDK
const sdk = devoraSDK({
	apiKey: process.env.DEVORA_API_KEY!, // pk_server_live_...
	secretKey: process.env.DEVORA_SECRET_KEY!, // sk_server_live_...
	orgId: process.env.DEVORA_ORG_ID!,
})

// Register every handler before creating the adapter.
sdk.register(DEVORA_ENDPOINTS.USER_SEARCH, async (req) => {
	const { term, limit } = req.query
	// Match name, email and the exact user ID with a parameterised query.
	const users = await searchUsers(String(term ?? ""), Number(limit ?? 10))
	return {
		users: users.map((u) => ({
			id: u.id,
			name: u.name,
			email: u.email,
			attributes: { company: u.company, role: u.role, plan: u.plan },
		})),
	}
})

sdk.register(DEVORA_ENDPOINTS.IMPERSONATE, async (req) => {
	// Set only after the signature is verified: trust it, not raw params.
	const ctx = req.devoraContext
	if (!ctx) throw new Error("Missing verified Devora context")
	// Store ctx (including ctx.sessionId) in the token and expire it by ctx.expiresAt,
	// so TERMINATE can revoke it and createImpersonationGuard can read it back.
	return { token: await generateToken(ctx.targetUser.id, ctx) }
})

sdk.register(DEVORA_ENDPOINTS.TERMINATE, async (req) => {
	const sessionId = req.params.id
	const { reason } = req.body as ImpersonationTerminateRequest
	// Revoke every credential issued for this Devora session, including one issued
	// after this call. Must be idempotent: Devora retries (up to 5 attempts over 6 hours).
	await auth.revokeImpersonationSession({ sessionId, reason })
	return { success: true }
})

// Create Hono app
const app = new Hono()

// Mount Devora routes
app.route("/devora", honoAdapter(sdk))

export default app
```

User search should match name, email and the exact user ID. `attributes` are optional display fields such as company, role or plan: up to 12 per user, lowercase keys like `last_login`, and string, number, boolean or `null` values. Devora drops invalid entries silently; see [Search results and templates](https://docs.devora.sh/guide/search-results) for the limits and how your team lays out results.

On Node.js, serve the app with `@hono/node-server`; Bun and Deno serve the
default export directly.

Each verified request is claimed once from Devora before your handler runs, so
replay protection needs no storage on your side. Your backend must be able to
make outbound HTTPS requests to the Devora API. See
[SIGNING.md](https://github.com/getdevora/devora-sdks/blob/main/SIGNING.md#request-claims).

## Runtimes

The adapter reads requests through Web Platform APIs, but `@devorash/node`
signs and verifies with `node:crypto` and `Buffer` and reads `process.env`.
Use Node.js 20 or later, Bun, Deno, or an edge runtime with Node.js
compatibility (for example Cloudflare Workers with the `nodejs_compat` flag).
Runtimes without these APIs, such as Vercel's Edge runtime, are not supported.

The SDK makes outbound HTTPS requests to the Devora API (request claims, the
endpoint policy and session liveness), so the runtime must allow `fetch` to it.

## API Reference

### `honoAdapter(sdk, options?)`

A Hono sub-app with all Devora SDK routes; mount it with `app.route` at your
Devora mount path. Options: `maxBodySize` (bytes, default 1 MiB) and
`timestampTolerance` (seconds, default: the SDK's).

### `honoMiddleware(sdk, options?)`

A single catch-all handler for every SDK route. The request path is not
stripped, so pass `mountPath`:

```typescript
app.all("/devora/*", honoMiddleware(sdk, { mountPath: "/devora" }))
```

### `createImpersonationGuard(options)`

Native middleware for scope enforcement on your application routes. Register
it after your authentication middleware:

```typescript
import { createImpersonationGuard } from "@devorash/hono"

app.use("/api/*", authenticateRequest)
app.use(
	"/api/*",
	createImpersonationGuard({
		sdk,
		getImpersonationContext: (c) => c.get("auth")?.devora ?? null,
	})
)
```

### `createBrowserSessionHandler(options)`

Handler for the browser-session bridge route (`sdk`, `getImpersonationContext`,
`allowedOrigins`); it reads at most 4 KiB. Mount it behind your authentication
middleware. See the
[`@devorash/node` reference](https://docs.devora.sh/reference/node#browser-session-bridge).

## License

MIT
