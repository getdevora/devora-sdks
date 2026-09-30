# @devorash/hono

Recording, masking, capture and scope policy are configured in the Devora
dashboard and authorized server-side for each session. The backend SDK accepts
no settings for them.
See [SETTINGS.md](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Hono adapter for Devora Backend SDK. Supports Hono 4.

## Installation

```bash
npm install @devorash/node @devorash/hono hono redis
# TypeScript projects on Node.js also need the Node.js type package:
npm install -D @types/node
```

## Usage

```typescript
import { Hono } from "hono"
import { createClient } from "redis"
import { devoraSDK, DEVORA_ENDPOINTS } from "@devorash/node"
import { honoAdapter } from "@devorash/hono"

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

// Create Hono app
const app = new Hono()

// Mount Devora routes
app.route("/devora", honoAdapter(sdk))

export default app
```

On Node.js, serve the app with `@hono/node-server`; Bun and Deno serve the
default export directly.

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

## Runtimes

The adapter reads requests through Web Platform APIs, but `@devorash/node`
signs and verifies with `node:crypto` and `Buffer` and reads `process.env`.
Use Node.js 20 or later, Bun, Deno, or an edge runtime with Node.js
compatibility (for example Cloudflare Workers with the `nodejs_compat` flag).
Runtimes without these APIs, such as Vercel's Edge runtime, are not supported.

The `redis` client in the usage example needs TCP sockets. Where those are not
available, implement `replayStore` with an atomic insert-if-absent store that
the runtime can reach.

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
