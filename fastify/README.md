# @devorash/fastify

Recording, masking, capture and scope policy are configured in the Devora
dashboard and authorized server-side for each session. The backend SDK accepts
no settings for them.
See [SETTINGS.md](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Fastify adapter for Devora Backend SDK. Supports Fastify 4 and 5 on Node.js 20
or later.

## Installation

```bash
npm install @devorash/node @devorash/fastify fastify
# TypeScript projects also need the Node.js type package:
npm install -D @types/node
```

## Usage

```typescript
import Fastify from "fastify"
import { devoraSDK, DEVORA_ENDPOINTS, type ImpersonationTerminateRequest } from "@devorash/node"
import { fastifyAdapter } from "@devorash/fastify"

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

// Create Fastify server
const server = Fastify({ logger: true, requestTimeout: 15_000 })

// Register Devora plugin
server.register(fastifyAdapter(sdk), { prefix: "/devora" })

// Start server
server.listen({ port: 3000 })
```

User search should match name, email and the exact user ID. `attributes` are optional display fields such as company, role or plan: up to 12 per user, lowercase keys like `last_login`, and string, number, boolean or `null` values. Devora drops invalid entries silently; see [Search results and templates](https://docs.devora.sh/guide/search-results) for the limits and how your team lays out results.

Each verified request is claimed once from Devora before your handler runs, so
replay protection needs no storage on your side. Your backend must be able to
make outbound HTTPS requests to the Devora API. See
[SIGNING.md](https://github.com/getdevora/devora-sdks/blob/main/SIGNING.md#request-claims).

## API Reference

### `fastifyAdapter(sdk, options?)`

A Fastify plugin with all Devora SDK routes; register it with a `prefix` equal
to your Devora mount path. Options: `maxBodySize` (bytes, default 1 MiB) and
`timestampTolerance` (seconds, default: the SDK's).

### `createImpersonationGuard(options)`

A native `preHandler` hook for scope enforcement. Hooks added on the root
instance also run for the Devora plugin's routes, so keep your authentication
hook and the guard inside the plugin that holds your application routes:

```typescript
import { createImpersonationGuard } from "@devorash/fastify"

await server.register(
	async (api) => {
		api.addHook("preHandler", authenticateRequest)
		api.addHook(
			"preHandler",
			createImpersonationGuard({
				sdk,
				getImpersonationContext: (request) => request.auth?.devora ?? null,
			})
		)
		// ...your application routes
	},
	{ prefix: "/api" }
)
```

### `createBrowserSessionHandler(options)`

Handler for the browser-session bridge route (`sdk`, `getImpersonationContext`,
`allowedOrigins`); register it behind your authentication hook. See the
[`@devorash/node` reference](https://docs.devora.sh/reference/node#browser-session-bridge).

## Request body limits

The plugin applies `maxBodySize` (1 MiB by default) to Fastify's native route
`bodyLimit`, preserving a stricter application limit, and reads bodies with its
own raw-body parser inside its encapsulated scope; your application's content-type
parsers are unaffected. When registering `createBrowserSessionHandler`, set
`bodyLimit: 4096` on its route. Keep request-size and read-timeout limits at the
reverse proxy too; upstream buffering occurs before the plugin runs.

## License

MIT
