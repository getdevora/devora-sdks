# @devorash/fastify

Recording, masking, capture and scope policy are configured in the Devora
dashboard and authorized server-side for each session. The backend SDK accepts
no settings for them.
See [SETTINGS.md](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Fastify adapter for Devora Backend SDK. Supports Fastify 4 and 5 on Node.js 20
or later.

## Installation

```bash
npm install @devorash/node @devorash/fastify fastify redis
# TypeScript projects also need the Node.js type package:
npm install -D @types/node
```

## Usage

```typescript
import Fastify from "fastify"
import { createClient } from "redis"
import { devoraSDK, DEVORA_ENDPOINTS } from "@devorash/node"
import { fastifyAdapter } from "@devorash/fastify"

// Replay protection shared by every instance of your backend (required in production).
const redis = createClient({ url: process.env.REDIS_URL }).on("error", (err) => console.error("Redis error", err))
let redisReady: Promise<unknown> | undefined // one connection, shared by concurrent first requests

// Initialize SDK
const sdk = devoraSDK({
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

// Register every handler before creating the adapter.
sdk.register(DEVORA_ENDPOINTS.USER_SEARCH, async (req) => {
	const { term } = req.query
	return { users: await searchUsers(term) }
})

sdk.register(DEVORA_ENDPOINTS.IMPERSONATE, async (req) => {
	const { id } = req.params
	return { token: await generateToken(id), data: {} }
})

sdk.register(DEVORA_ENDPOINTS.TERMINATE, async (req) => {
	const { id } = req.params
	await invalidateSession(id)
	return { success: true }
})

// Create Fastify server
const server = Fastify({ logger: true, requestTimeout: 15_000 })

// Register Devora plugin
server.register(fastifyAdapter(sdk), { prefix: "/devora" })

// Start server
server.listen({ port: 3000 })
```

The environment comes from the `environment` option, else `DEVORA_ENV`, else
`NODE_ENV`. Anything other than `development` or `test` (including unset) is
production, and production refuses to start without a `replayStore`. Any store
whose `consume` is an atomic insert-if-absent shared by every instance works;
see the
[replay-store contract](https://github.com/getdevora/devora-sdks/blob/main/SIGNING.md#replay-store).

**Local development only:** to run without Redis, omit `replayStore` and start
the process with `DEVORA_ENV=development` (or pass `environment: "development"`).
The SDK then keeps request ids in memory, which protects a single process only.
Never use this in production.

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
