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
npm install @devorash/node
# or
bun add @devorash/node
```

## Quick Start

```typescript
import { devoraSDK, DEVORA_ENDPOINTS, type ImpersonationTerminateRequest } from "@devorash/node"

// Initialize SDK with your server key ID and secret key
const sdk = devoraSDK({
	apiKey: process.env.DEVORA_API_KEY!, // pk_server_live_...
	secretKey: process.env.DEVORA_SECRET_KEY!, // sk_server_live_...
	orgId: process.env.DEVORA_ORG_ID!,
})

// User search endpoint: match name, email and the exact user ID with a
// parameterised query, and map each field explicitly.
sdk.register(DEVORA_ENDPOINTS.USER_SEARCH, async (req) => {
	const { term, limit } = req.query
	const users = await searchYourUsers(String(term ?? ""), Number(limit ?? 10))
	return {
		users: users.map((u) => ({
			id: u.id,
			email: u.email,
			name: u.name,
			attributes: { company: u.company, role: u.role, plan: u.plan },
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
	const sessionId = req.params.id
	const { reason } = req.body as ImpersonationTerminateRequest
	// YOU IMPLEMENT: mark this Devora session revoked so every credential issued for it
	// is rejected, including one issued after this call. Must be idempotent: Devora
	// retries with a new request id (up to 5 attempts over 6 hours).
	await auth.revokeImpersonationSession({ sessionId, reason })
	return { success: true }
})

export { sdk }
```

User search should match name, email and the exact user ID. `attributes` are optional display fields such as company, role or plan: up to 12 per user, lowercase keys like `last_login`, and string, number, boolean or `null` values. Devora drops invalid entries silently; see [Search results and templates](https://docs.devora.sh/guide/search-results) for the limits and how your team lays out results.

Each verified request is claimed once from Devora before your handler runs, so
replay protection needs no storage on your side. Your backend must be able to
make outbound HTTPS requests to the Devora API; see [Security](#security).

Register every handler before creating an adapter: adapters read the route list
once, when they are created.

### Session termination

Devora calls `DELETE /impersonate/:id/terminate` when a session ends. The
session id is the `:id` path parameter (`req.params.id`, also `req.sessionId`)
and the body is `{ reason, terminatedBy? }` (`ImpersonationTerminateRequest`).
`terminatedBy` is the external user id of the person who ended the session and
is absent for automatic ends. `reason` is a `SessionTerminationReason`:

| `reason`                 | When                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `user_ended`             | Ended from the customer-app banner, or by the agent from the Devora dashboard                                           |
| `time_limit`             | The approved time window was reached, or the session was idle too long                                                  |
| `admin_terminated`       | An admin force-ended it (also when the impersonated user's data is erased)                                              |
| `superseded`             | A newer session replaced it                                                                                             |
| `request_revoked`        | The approval (access request) was revoked                                                                               |
| `membership_revoked`     | The agent lost organization membership                                                                                  |
| `role_downgraded`        | The agent's role no longer allows it                                                                                    |
| `workos_session_revoked` | The agent's Devora sign-in was revoked                                                                                  |
| `principal_erased`       | The agent's account was erased                                                                                          |
| `organization_erased`    | The organization was erased                                                                                             |
| `start_failed`           | Devora sent the start request, and your handler may have issued a token, but the session never started                  |
| `not_started`            | Your handler issued a token but the impersonation link was never opened (sent a few minutes after the link expires)     |

Devora retries a failed terminate call (up to 5 attempts over 6 hours, with
backoff), each as a new signed request with a new request id, so the handler
must be idempotent; any 2xx counts as delivered. A 4xx other than 408, 425 or 429 is
not retried; when overloaded, answer 429 or 503 with `Retry-After`. Store the
Devora `sessionId` with the credential you mint and revoke by session, not by
token, so a credential minted by a slow start handler after the terminate is
still rejected. The
[impersonation guard](#createimpersonationguardoptions) also rejects credentials
for sessions Devora no longer reports as active. See
[Session lifecycle & cleanup](https://docs.devora.sh/guide/session-lifecycle).

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
| 401    | `INVALID_SIGNATURE_HEADERS`, `UNSUPPORTED_SIGNATURE_VERSION`, `ORG_MISMATCH`, `TIMESTAMP_EXPIRED`, `INVALID_SIGNATURE` | Unsigned, altered or stale request, or a different key or org           |
| 401    | `REPLAYED_REQUEST`                                                                                   | Devora already claimed this request id (the request was already processed) |
| 401    | `INVALID_IMPERSONATION_CONTEXT`                                                                      | Incomplete or expired impersonation-start body                          |
| 400    | `INVALID_REQUEST_TARGET`, `INVALID_BODY`                                                             | Malformed path or query; body that is not strict JSON                   |
| 400    | `HANDLER_ERROR`                                                                                      | Your handler threw (its message is not sent)                            |
| 413    | `BODY_TOO_LARGE`                                                                                     | Body larger than `maxBodySize`                                          |
| 415    | `UNSUPPORTED_CONTENT_ENCODING`                                                                       | `Content-Encoding` other than `identity`                                |
| 409    | `SESSION_NOT_STARTABLE`                                                                              | Start request for a session Devora is no longer starting                |
| 503    | `REQUEST_CLAIM_UNAVAILABLE`                                                                          | Devora could not be reached to claim the request id, or gave no clear answer |

## Security

Every request from Devora is signed with HMAC-SHA256 (request signing v3). The
signature covers the exact path, query and body bytes, the request's direction,
a timestamp and a single-use request id. The adapters verify it before any
handler runs and reject unsigned, altered or stale requests. See
[SIGNING.md](https://github.com/getdevora/devora-sdks/blob/main/SIGNING.md) for the protocol.

After a request verifies, the SDK claims its request id from Devora with one
signed call (`POST /api/sdk/request-claim`, 3-second timeout). The first claim
wins; a repeat gets `REPLAYED_REQUEST`, and the handler runs only after a
successful claim. Only requests whose signature verified are ever claimed, so
unauthenticated traffic cannot use up request ids. If Devora cannot be reached
the SDK fails closed with `REQUEST_CLAIM_UNAVAILABLE` (503).

You provide no storage for this, but your backend must be able to make outbound
HTTPS requests to the Devora API (it already does so for the endpoint policy and
session liveness). Devora's **Test connection** check is claimed too, so it also
proves that outbound connectivity.

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
