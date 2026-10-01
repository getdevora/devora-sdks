# Devora SDKs

This repository contains the Devora SDKs for enabling secure impersonation in customer applications.

## Package Structure

```
devora-sdks/
├── core/           # @devorash/core - Shared types, constants, and utilities
├── node/           # @devorash/node - Node.js backend SDK
├── browser/        # @devorash/browser - Core frontend JavaScript SDK
│
├── # Backend Framework Adapters
├── express/        # @devorash/express - Express.js adapter
├── hono/           # @devorash/hono - Hono adapter
├── fastify/        # @devorash/fastify - Fastify adapter
│
├── # Frontend Framework Wrappers
├── react/          # @devorash/react - React hooks and components
├── vue/            # @devorash/vue - Vue composables
├── svelte/         # @devorash/svelte - Svelte stores
├── solid/          # @devorash/solid - Solid.js primitives
│
├── # Full-stack
├── nextjs/         # @devorash/nextjs - Next.js App Router (route handlers + /client)
│
├── # Python backend SDK (published to PyPI)
├── python/         # devora-python - Python backend SDK
├── django/         # devora-django - Django adapter
└── fastapi/        # devora-fastapi - FastAPI adapter
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        @devorash/core                         │
│  (Types, Constants, Utilities, HMAC, Validation, Shared Logic)  │
└─────────────────────────────────────────────────────────────────┘
                    ▲                           ▲
                    │                           │
        ┌───────────┴───────────┐   ┌───────────┴───────────┐
        │   @devorash/node    │   │   @devorash/browser      │
        │   (Backend Core SDK)  │   │   (Frontend Core SDK) │
        └───────────┬───────────┘   └───────────┬───────────┘
                    │                           │
        ┌───────────┴───────────┐   ┌───────────┴───────────┐
        │  Framework Adapters   │   │  Framework Wrappers   │
        ├───────────────────────┤   ├───────────────────────┤
        │  @devorash/express  │   │  @devorash/react    │
        │  @devorash/hono     │   │  @devorash/vue      │
        │  @devorash/fastify  │   │  @devorash/svelte   │
        └───────────────────────┘   │  @devorash/solid    │
                                    └───────────────────────┘
```

## Installation

Full guides: [docs.devora.sh](https://docs.devora.sh). Recording, masking, capture and endpoint policy are configured in the Devora dashboard and delivered per session; SDK options cannot enable or override them (see [SETTINGS.md](./SETTINGS.md)).

### Backend SDK (Node.js + Express example)

```bash
npm install @devorash/node @devorash/express
```

```typescript
import { devoraSDK, DEVORA_ENDPOINTS, type ImpersonationTerminateRequest } from "@devorash/node"
import { expressAdapter } from "@devorash/express"

const sdk = devoraSDK({
	apiKey: process.env.DEVORA_API_KEY!, // pk_server_live_…
	secretKey: process.env.DEVORA_SECRET_KEY!, // sk_server_live_…
	orgId: process.env.DEVORA_ORG_ID!,
})

await sdk.ready

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
	const ctx = req.devoraContext
	if (!ctx) throw new Error("Missing verified Devora context")

	// Store ctx unchanged in the credential: the backend guard reads it back.
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

// Mount before any application-wide body parser.
app.use("/devora", expressAdapter(sdk))
```

User search should match name, email and the exact user ID. `attributes` are optional display fields such as company, role or plan: up to 12 per user, lowercase keys like `last_login`, and string, number, boolean or `null` values. Devora drops invalid entries silently; see [Search results and templates](https://docs.devora.sh/guide/search-results) for the limits and how your team lays out results.

Each verified request is claimed once from Devora before your handler runs, so
you need no storage for replay protection, but your backend must be able to make
outbound HTTPS requests to the Devora API.

### Frontend SDK (React example)

```bash
npm install @devorash/browser @devorash/react
```

```tsx
import { DevoraProvider, ImpersonationBanner } from "@devorash/react"

function App() {
	return (
		<DevoraProvider
			apiKey="pk_client_live_xxx"
			onImpersonate={async ({ token }) => {
				// Turn the credential your backend returned into your app's session.
				await acceptImpersonationCredential(token)
				window.location.replace("/dashboard")
			}}
			onSessionEnd={async () => {
				// Clear the impersonated session and return to a safe route.
				await signOut()
				window.location.replace("/login")
			}}
		>
			<ImpersonationBanner />
			<YourApp />
		</DevoraProvider>
	)
}
```

The browser origin must be listed under **Developer → Integration → Allowed origins (client keys)** in the Devora dashboard; an empty list denies every client key.

### Backend Scope Enforcement (Defense-in-Depth)

The frontend SDK blocks write operations in read-only mode, but users can bypass this via DevTools. For true security, add the backend middleware:

```typescript
import { createImpersonationGuard } from "@devorash/express"

// Add after your auth middleware
app.use(
	createImpersonationGuard({
		sdk,
		// The Devora context stored in your verified JWT or server-side session
		getImpersonationContext: (req) => req.user?.devora ?? null,
	})
)
```

Endpoint rules are managed only in the Devora dashboard (**Developer → Endpoint rules**). The
backend SDK fetches the versioned policy at initialization and the browser SDK during a session;
both cache it for five minutes and retain a bounded stale copy for temporary Devora outages. The
backend guard fails closed if no policy is available.

For this to work, embed the verified impersonation context in your JWT or session during token generation:

```typescript
sdk.register(DEVORA_ENDPOINTS.IMPERSONATE, async (req) => {
	// SECURITY: Use req.devoraContext (set only after the signed request is verified)
	// instead of raw req.body, so clients cannot forge impersonation context.
	const ctx = req.devoraContext
	if (!ctx) throw new Error("Missing verified Devora context")

	// Look up the target user from YOUR database (don't trust client-provided user data)
	const user = await db.users.findById(ctx.targetUser.id)
	if (!user) {
		throw new Error("User not found")
	}

	const token = generateJWT({
		sub: user.id,
		// Keep every field: the guard requires scope, sessionId, expiresAt (ms),
		// actor/subject, authMethod, authorizationSource and recordingAllowed.
		devora: ctx,
		exp: Math.floor(ctx.expiresAt / 1000),
	})

	return { token }
})
```

**Important Security Notes:**

- Never trust `req.body` for impersonation fields (`sessionId`, `scope`, `expiresAt`, `impersonator`)
- The `req.devoraContext` is populated by the SDK after verifying the HMAC signature
- Never let the customer credential outlive `ctx.expiresAt`
- Never put a server key ID or secret in frontend code

## Development

### Building SDKs

```bash
# From repository root
bun run build:sdks

# Build a single package
bunx turbo build --filter=@devorash/core
bunx turbo build --filter=@devorash/node
```

All packages ship **unminified ESM** + TypeScript types. Customers' bundlers minify for production — do not publish minified npm tarballs.

### Running Tests

```bash
bun run test:sdks
bun run test:python-sdks
bun run verify:sdks-publish   # dry-run pack; ensures no workspace:* in tarballs
```

### Releases

JavaScript packages are published under the `@devorash` npm scope and Python packages with the `devora-` prefix on PyPI, at the same version. Releases are coordinated across both registries and require verification and explicit approval. See [CHANGELOG.md](./CHANGELOG.md).

See [contribution and release guidance](https://github.com/getdevora/devora-sdks/blob/main/CONTRIBUTING.md). Run `bun run test:sdks` and `bun run verify:sdks-publish` to verify source and package artifacts without publishing.
