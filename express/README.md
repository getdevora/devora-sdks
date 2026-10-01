# @devorash/express

Recording, masking, capture and scope policy are configured in the Devora
dashboard and authorized server-side for each session. The backend SDK accepts
no settings for them.
See [SETTINGS.md](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Express.js adapter for Devora Backend SDK. Supports Express 4.18+ and 5 on
Node.js 20 or later.

## Installation

```bash
npm install @devorash/node @devorash/express express
# TypeScript projects also need the type packages:
npm install -D @types/express @types/node
```

## Usage

```typescript
import express from "express"
import { devoraSDK, DEVORA_ENDPOINTS, type ImpersonationTerminateRequest } from "@devorash/node"
import { expressAdapter } from "@devorash/express"

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

// Create Express app
const app = express()
// Mount Devora routes before application-wide parsers and outside end-user auth.
app.use("/devora", expressAdapter(sdk))
app.use(express.json())

app.listen(3000)
```

User search should match name, email and the exact user ID. `attributes` are optional display fields such as company, role or plan: up to 12 per user, lowercase keys like `last_login`, and string, number, boolean or `null` values. Devora drops invalid entries silently; see [Search results and templates](https://docs.devora.sh/guide/search-results) for the limits and how your team lays out results.

Each verified request is claimed once from Devora before your handler runs, so
replay protection needs no storage on your side. Your backend must be able to
make outbound HTTPS requests to the Devora API. See
[SIGNING.md](https://github.com/getdevora/devora-sdks/blob/main/SIGNING.md#request-claims).

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
