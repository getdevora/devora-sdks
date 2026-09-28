# @devorash/node

Recording, masking and activity preferences are configured in Devora Settings.
SDK initialization overrides are ignored. New sessions retain the server's policy
snapshot across exchange and resume. Developer privacy labels take effect only
when selected in Settings; sensitive-field protection remains mandatory.
See [migration details](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Devora Backend SDK for Node.js applications. Enables secure impersonation by providing endpoints that the Devora platform can communicate with.

## Installation

```bash
npm install @devorash/node
# or
bun add @devorash/node
```

## Quick Start

```typescript
import { devoraSDK, DEVORA_ENDPOINTS } from "@devorash/node"

// Initialize SDK with your server key ID and secret key
const sdk = devoraSDK({
	apiKey: process.env.DEVORA_API_KEY!,
	secretKey: process.env.DEVORA_SECRET_KEY!,
	orgId: "your-org-id",
	debug: process.env.NODE_ENV === "development",
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
	const { targetUser } = req.devoraContext!

	// Generate a short-lived app token for the target user.
	const token = await generateAuthToken(targetUser.id)

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

	// Optional
	debug: false, // Enable debug logging
	timestampTolerance: 300, // Max clock drift in seconds (default: 5 min)
	collectStats: false, // Collect request statistics
	logRequests: false, // Log all requests
	logger: customLogger, // Custom logger implementation
})
```

## Built-in Endpoints

The SDK automatically provides two built-in endpoints:

### `/test` - Connection Test

Used by the Devora platform to verify your integration is working.

```
GET /devora/test
```

### `/health` - Health Check

Returns SDK health information and registered endpoints.

```
GET /devora/health
```

## Security

Every request from Devora is signed with HMAC-SHA256 (request signing v3). The
signature covers the exact path, query and body bytes, the request's direction,
a timestamp and a single-use request id. The adapters verify it before any route
lookup and reject unsigned, altered, stale or replayed requests. See
[SIGNING.md](../SIGNING.md) for the protocol and the replay-store contract.

Production deployments need a shared, atomic `replayStore`: every instance
must see every request id, and the insert must be atomic. The in-memory store
is for `environment: "development"` or `"test"` only; any other environment
refuses to start without a `replayStore`.

```typescript
import { createClient } from "redis"
import { devoraSDK, type ReplayStore } from "@devorash/node"

const redis = await createClient({ url: process.env.REDIS_URL }).connect()

const replayStore: ReplayStore = {
	async consume(namespace, requestId, expiresAt) {
		// Atomic insert-if-absent that lives until expiresAt (Unix ms).
		// Errors propagate: the SDK then fails closed with a 503.
		const result = await redis.set(`devora:replay:${namespace}:${requestId}`, "1", {
			NX: true,
			PXAT: expiresAt,
		})
		return result === "OK"
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

Create a new SDK instance.

### `sdk.register(path, handler, options?)`

Register an endpoint handler.

### `sdk.getRoutes()`

Get all registered routes.

### `sdk.getStats()`

Get request statistics (if `collectStats: true`).

### `sdk.verifyRequest({ method, path, query, body, headers }, options?)`

Verify a signed request from Devora over its exact wire bytes: `path` is
relative to the SDK mount and still percent-encoded, `query` is everything
after the first `?`, and `body` is a `Uint8Array`. The adapters call this for
you; use it only for a custom framework integration.

## License

MIT

## Request body limits

Mount Express SDK routes before application-wide body parsers. The router and
middleware include a bounded JSON parser (1 MiB by default, configurable through
`maxBodySize`); compressed request bodies are rejected. The browser-session
handler uses a 4 KiB limit. A parser placed earlier can already have allocated the
entire body, so its own limit must be at least as strict for these routes.

For direct `processRequest`/`createGenericHandler` integrations, apply the same
byte limit in the host's raw-body reader before parsing or constructing
`AdapterRequest`. The generic handler's check on an already-parsed object cannot
bound earlier allocations. Configure request-size and read-timeout limits at the
HTTP server/reverse proxy as well; middleware cannot undo upstream buffering.

The impersonation guard retains at most 1,000 liveness verdicts and 64 distinct
in-flight lookups per guard. Lookup waits end after five seconds. An unresponsive
custom transport keeps its slot until it settles, preventing unlimited
background requests; saturation follows the unavailable policy (deny by default).
TTL hits never extend a verdict, and invalid unavailable-policy values are
configuration errors.
