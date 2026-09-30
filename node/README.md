# @devorash/node

Recording, masking, capture and scope policy are configured in the Devora
dashboard and authorized server-side for each session. The backend SDK accepts
no settings for them: `devoraSDK` ignores any option not listed under
[Configuration](#configuration).
See [SETTINGS.md](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Devora Backend SDK for Node.js applications. Enables secure impersonation by providing endpoints that the Devora platform can communicate with.

Requires Node.js 20 or later. Use it through a framework adapter:
[`@devorash/express`](https://www.npmjs.com/package/@devorash/express),
[`@devorash/fastify`](https://www.npmjs.com/package/@devorash/fastify) or
[`@devorash/hono`](https://www.npmjs.com/package/@devorash/hono).

## Installation

```bash
npm install @devorash/node redis
# or
bun add @devorash/node redis
```

## Quick Start

```typescript
import { createClient } from "redis"
import { devoraSDK, DEVORA_ENDPOINTS } from "@devorash/node"

// Replay protection shared by every instance of your backend (required in production).
const redis = createClient({ url: process.env.REDIS_URL }).on("error", (err) => console.error("Redis error", err))
let redisReady: Promise<unknown> | undefined // one connection, shared by concurrent first requests

// Initialize SDK with your server key ID and secret key
const sdk = devoraSDK({
	apiKey: process.env.DEVORA_API_KEY!, // pk_server_live_...
	secretKey: process.env.DEVORA_SECRET_KEY!, // sk_server_live_...
	orgId: process.env.DEVORA_ORG_ID!,
	debug: process.env.NODE_ENV === "development",
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

// User search endpoint
sdk.register(DEVORA_ENDPOINTS.USER_SEARCH, async (req) => {
	const { term } = req.query
	const users = await searchYourUsers(term)
	return {
		users: users.map((u) => ({
			id: u.id,
			email: u.email,
			name: u.name,
		})),
	}
})

// Impersonation start endpoint
sdk.register(DEVORA_ENDPOINTS.IMPERSONATE, async (req) => {
	const { id } = req.params
	const ctx = req.devoraContext
	if (!ctx) throw new Error("Missing verified Devora context")

	// Generate a short-lived app token for the target user. Store ctx unchanged in
	// it: createImpersonationGuard reads every field back. Expire it by ctx.expiresAt.
	const token = await generateAuthToken(ctx.targetUser.id, ctx)

	// Optionally include user settings for frontend initialization.
	const userSettings = await getUserSettings(id)

	return {
		token,
		data: {
			theme: userSettings.theme,
			timezone: userSettings.timezone,
		},
	}
})

// Session termination endpoint
sdk.register(DEVORA_ENDPOINTS.TERMINATE, async (req) => {
	const { id } = req.params
	const sessionId = req.sessionId ?? id

	await invalidateUserSession(id, sessionId)

	return { success: true }
})

export { sdk }
```

The environment comes from the `environment` option, else `DEVORA_ENV`, else
`NODE_ENV`. Anything other than `development` or `test` (including unset) is
production, and production refuses to start without a `replayStore`; see
[Security](#security).

**Local development only:** to run without Redis, omit `replayStore` and start
the process with `DEVORA_ENV=development` (or pass `environment: "development"`).
The SDK then keeps request ids in memory, which protects a single process only.
Never use this in production.

Register every handler before creating an adapter: adapters read the route list
once, when they are created.

## Framework Integration

Use the SDK with your preferred web framework:

### Express

```bash
npm install @devorash/express
```

```typescript
import express from "express"
import { expressAdapter } from "@devorash/express"
import { sdk } from "./devora"

const app = express()
app.use("/devora", expressAdapter(sdk))
app.use(express.json()) // Parsers for other routes come afterwards.
```

### Hono

```bash
npm install @devorash/hono
```

```typescript
import { Hono } from "hono"
import { honoAdapter } from "@devorash/hono"
import { sdk } from "./devora"

const app = new Hono()
app.route("/devora", honoAdapter(sdk))
```

### Fastify

```bash
npm install @devorash/fastify
```

```typescript
import Fastify from "fastify"
import { fastifyAdapter } from "@devorash/fastify"
import { sdk } from "./devora"

const server = Fastify()
server.register(fastifyAdapter(sdk), { prefix: "/devora" })
```

## Configuration

```typescript
const sdk = devoraSDK({
	// Required
	apiKey: "pk_server_live_xxx", // Your public server key ID
	secretKey: "sk_server_live_xxx", // Your server secret key
	orgId: "org_xxx", // Your organization ID
	replayStore, // Required in production (see Security)

	// Optional
	environment: "production", // "development" | "test" | "production"; defaults from DEVORA_ENV, then NODE_ENV, else production
	debug: false, // SDK debug logging (default: on when NODE_ENV=development)
	timestampTolerance: 300, // Max clock drift in seconds, a non-negative integer (default: 300)
	collectStats: false, // Per-endpoint counts in getStats() and counters in the /health response
})
```

`apiKey` must be `pk_server_live_` followed by 32 characters and `secretKey`
`sk_server_live_` followed by 64; `devoraSDK` throws on anything else. `apiUrl`
(an https origin) overrides the Devora API origin for self-hosted deployments.

## Built-in Endpoints

The SDK automatically provides two signed endpoints. Like every SDK route, they
answer unsigned requests with `401`.

### `/health` - Health Check

Returns SDK health information and the registered endpoints. Devora's **Test
connection** check calls it.

```
GET /devora/health
```

### `/test` - Connection Test

Returns the verified organization and key ID, for your own signed checks.

```
GET /devora/test
```

## Responses and errors

A handler's return value is sent as `{ success: true, data, timestamp }` with
status 200. Failures are `{ success: false, error, errorCode, timestamp }`:

| Status | `errorCode`                                                                                          | Cause                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 401    | `INVALID_SIGNATURE_HEADERS`, `UNSUPPORTED_SIGNATURE_VERSION`, `ORG_MISMATCH`, `TIMESTAMP_EXPIRED`, `INVALID_SIGNATURE`, `REPLAYED_REQUEST` | Unsigned, altered, stale or replayed request, or a different key or org |
| 401    | `INVALID_IMPERSONATION_CONTEXT`                                                                      | Incomplete or expired impersonation-start body                          |
| 400    | `INVALID_REQUEST_TARGET`, `INVALID_BODY`                                                             | Malformed path or query; body that is not strict JSON                   |
| 400    | `HANDLER_ERROR`                                                                                      | Your handler threw (its message is not sent)                            |
| 413    | `BODY_TOO_LARGE`                                                                                     | Body larger than `maxBodySize`                                          |
| 415    | `UNSUPPORTED_CONTENT_ENCODING`                                                                       | `Content-Encoding` other than `identity`                                |
| 503    | `REPLAY_STORE_UNAVAILABLE`                                                                           | `replayStore.consume` threw or did not return a boolean                 |

## Security

Every request from Devora is signed with HMAC-SHA256 (request signing v3). The
signature covers the exact path, query and body bytes, the request's direction,
a timestamp and a single-use request id. The adapters verify it before any
handler runs and reject unsigned, altered, stale or replayed requests. See
[SIGNING.md](https://github.com/getdevora/devora-sdks/blob/main/SIGNING.md) for the protocol and the replay-store contract.

Production deployments need a shared, atomic `replayStore`: every instance
must see every request id, and the insert must be atomic. The in-memory store
is for `environment: "development"` or `"test"` only; any other environment
refuses to start without a `replayStore`.

```typescript
import { createClient } from "redis"
import { devoraSDK, type ReplayStore } from "@devorash/node"

const redis = createClient({ url: process.env.REDIS_URL }).on("error", (err) => console.error("Redis error", err))
let redisReady: Promise<unknown> | undefined // one connection, shared by concurrent first requests

const replayStore: ReplayStore = {
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
}

const sdk = devoraSDK({
	apiKey: process.env.DEVORA_API_KEY!,
	secretKey: process.env.DEVORA_SECRET_KEY!,
	orgId: process.env.DEVORA_ORG_ID!,
	replayStore,
})
```

Do not run the store with an eviction policy that can drop keys before they
expire (`maxmemory-policy` must not evict these keys). A unique-key database
insert with an expiry column works too.

## Types

```typescript
import type {
	DevoraRequest,
	DevoraResponse,
	DevoraUser,
	ImpersonationStartRequest,
	ImpersonationStartResponse,
} from "@devorash/node"

// Request handler with types
sdk.register<
	DevoraRequest<{ id: string }, {}, ImpersonationStartRequest>,
	ImpersonationStartResponse
>(DEVORA_ENDPOINTS.IMPERSONATE, async (req) => {
	const { id } = req.params
	const { scope, expiresAt, sessionId } = req.devoraContext!
	return { token: "...", data: {} }
})
```

## API Reference

### `devoraSDK(config)`

Create a new SDK instance. It starts loading the dashboard-managed scope policy
in the background (`sdk.ready` resolves when that first attempt finishes).

### `sdk.register(path, handler, options?)`

Register an endpoint handler. The method is detected for `DEVORA_ENDPOINTS`
paths; `/test` and `/health` cannot be overridden.

### `sdk.getRoutes()`

Get all registered routes.

### `sdk.getStats()`

Get request statistics. Totals are always counted; `requestsByEndpoint` is
filled only with `collectStats: true`.

### `sdk.verifyRequest({ method, path, query, body, headers }, options?)`

Verify a signed request from Devora over its exact wire bytes: `path` is
relative to the SDK mount and still percent-encoded, `query` is everything
after the first `?`, and `body` is a `Uint8Array`. The adapters call this for
you; use it only for a custom framework integration.

### `createImpersonationGuard(options)`

Backend scope enforcement for your application routes, using the policy managed
in the dashboard. See the
[`@devorash/node` reference](https://docs.devora.sh/reference/node#scope-guard).

## Request body limits

The Express router and middleware read the raw body themselves (1 MiB by
default, configurable through `maxBodySize`); compressed request bodies are
rejected. Mount them before application-wide body parsers: a body another
parser already consumed is rejected with `DEVORA_BODY_ALREADY_PARSED`. The
Express browser-session handler uses a 4 KiB limit.

For direct `processRequest`/`createGenericHandler` integrations, pass the exact
body bytes as a `Uint8Array` and apply the byte limit in the host's raw-body
reader: the handler's own `maxBodySize` check runs only after the body is
buffered. Configure request-size and read-timeout limits at the HTTP
server/reverse proxy as well; middleware cannot undo upstream buffering.

The impersonation guard retains at most 1,000 liveness verdicts and 64 distinct
in-flight lookups per guard. Lookup waits end after five seconds. An unresponsive
custom transport keeps its slot until it settles, preventing unlimited
background requests; saturation follows the unavailable policy (deny by default).
TTL hits never extend a verdict, and invalid unavailable-policy values are
configuration errors.

## License

MIT
