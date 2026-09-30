# @devorash/express

Recording, masking, capture and scope policy are configured in the Devora
dashboard and authorized server-side for each session. The backend SDK accepts
no settings for them.
See [SETTINGS.md](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Express.js adapter for Devora Backend SDK. Supports Express 4.18+ and 5 on
Node.js 20 or later.

## Installation

```bash
npm install @devorash/node @devorash/express express redis
# TypeScript projects also need the type packages:
npm install -D @types/express @types/node
```

## Usage

```typescript
import express from "express"
import { createClient } from "redis"
import { devoraSDK, DEVORA_ENDPOINTS } from "@devorash/node"
import { expressAdapter } from "@devorash/express"

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

// Create Express app
const app = express()
// Mount Devora routes before application-wide parsers and outside end-user auth.
app.use("/devora", expressAdapter(sdk))
app.use(express.json())

app.listen(3000)
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

### `expressAdapter(sdk, options?)`

Creates an Express Router with all Devora SDK routes. Mount it at your Devora
mount path with `app.use`. Options: `maxBodySize` (bytes, default 1 MiB) and
`timestampTolerance` (seconds, default: the SDK's).

### `expressMiddleware(sdk, options?)`

A single catch-all handler for every SDK route; it answers signed requests for
unknown paths with `404 NOT_FOUND`. With `app.use("/devora", ...)` Express
strips the prefix; on a route that keeps it, pass `mountPath`:

```typescript
app.all("/devora/*rest", expressMiddleware(sdk, { mountPath: "/devora" }))
```

### `createImpersonationGuard(options)`

Scope enforcement for your application routes. Mount it after your
authentication middleware; pass Express's `Request` type so the extractor can
read your auth state:

```typescript
import express, { type Request } from "express"
import { createImpersonationGuard } from "@devorash/express"

app.use(
	"/api",
	authenticateRequest,
	createImpersonationGuard<Request>({
		sdk,
		getImpersonationContext: (req) => req.auth?.devora ?? null,
	})
)
```

### `createBrowserSessionHandler(options)`

Handler for the browser-session bridge route (`sdk`, `getImpersonationContext`,
`allowedOrigins`). Mount it behind your authentication middleware. See the
[`@devorash/node` reference](https://docs.devora.sh/reference/node#browser-session-bridge).

## Request body limits

Mount Express SDK routes before application-wide body parsers. Devora signs
the exact body bytes, so the router and middleware read the raw body themselves
(1 MiB by default, configurable through `maxBodySize`); compressed request
bodies are rejected. If another parser consumed the body first, the request is
rejected with `500 DEVORA_BODY_ALREADY_PARSED`. The browser-session handler uses
a 4 KiB limit.

For direct `processRequest`/`createGenericHandler` integrations, pass the exact
body bytes, the raw mount-relative path and the raw query (see
[SIGNING.md](https://github.com/getdevora/devora-sdks/blob/main/SIGNING.md)), and bound the body in the host's raw-body reader. Configure request-size and read-timeout limits at the
HTTP server/reverse proxy as well; middleware cannot undo upstream buffering.

## License

MIT
