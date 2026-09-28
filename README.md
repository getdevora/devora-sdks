# Devora SDKs

This directory contains all the Devora SDKs for enabling secure impersonation in customer applications.

## Package Structure

```
sdks/
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

### Backend SDK (Node.js + Express example)

```bash
npm install @devorash/node @devorash/express
```

```typescript
import { devoraSDK, DEVORA_ENDPOINTS } from "@devorash/node"
import { expressAdapter } from "@devorash/express"

const sdk = devoraSDK({
	apiKey: process.env.DEVORA_API_KEY!,
	secretKey: process.env.DEVORA_SECRET_KEY!,
	orgId: "your-org-id",
})

await sdk.ready

sdk.register(DEVORA_ENDPOINTS.USER_SEARCH, async (req) => {
	const { term } = req.query
	return { users: await searchUsers(term) }
})

sdk.register(DEVORA_ENDPOINTS.IMPERSONATE, async (req) => {
	const ctx = req.devoraContext
	if (!ctx) throw new Error("Missing verified Devora context")

	return {
		token: await generateToken(ctx.targetUser.id, {
			sessionId: ctx.sessionId,
			scope: ctx.scope,
			expiresAt: ctx.expiresAt,
		}),
		data: {},
	}
})

sdk.register(DEVORA_ENDPOINTS.TERMINATE, async (req) => {
	const sessionId = req.sessionId ?? req.params.id
	await invalidateSession(sessionId)
	return { success: true }
})

app.use("/devora", expressAdapter(sdk))
```

### Frontend SDK (React example)

```bash
npm install @devorash/browser @devorash/react
```

```tsx
import { DevoraProvider, useDevoraImpersonation } from "@devorash/react"

function App() {
	return (
		<DevoraProvider apiKey="pk_client_live_xxx">
			<YourApp />
		</DevoraProvider>
	)
}

function YourApp() {
	const { isImpersonating, scope, endSession } = useDevoraImpersonation()

	return (
		<>
			{isImpersonating && (
				<Banner>
					Impersonation Mode ({scope})<button onClick={endSession}>End</button>
				</Banner>
			)}
			{/* Your app content */}
		</>
	)
}
```

### Backend Scope Enforcement (Defense-in-Depth)

The frontend SDK blocks write operations in read-only mode, but users can bypass this via DevTools. For true security, add the backend middleware:

```typescript
import { createImpersonationGuard } from "@devorash/express"

// Add after your auth middleware
app.use(
	createImpersonationGuard({
		sdk,
		// Extract impersonation context from JWT claims
		getImpersonationContext: (req) => req.user?.devora,
	})
)
```

Whitelist and blocklist rules are managed only in Devora Settings. Both frontend and backend
SDKs fetch the same versioned policy at initialization, cache it for five minutes, and retain a
bounded stale copy for temporary Devora outages. The backend guard fails closed if no policy is
available.

For this to work, embed impersonation context in your JWT during token generation:

```typescript
sdk.register(DEVORA_ENDPOINTS.IMPERSONATE, async (req) => {
	// SECURITY: Use req.devoraContext (validated via HMAC) instead of raw req.body
	// This prevents clients from forging impersonation context
	const { sessionId, scope, expiresAt, impersonator, targetUser } = req.devoraContext

	// Look up the target user from YOUR database (don't trust client-provided user data)
	const user = await db.users.findById(targetUser.id)
	if (!user) {
		throw new Error("User not found")
	}

	// Validate the requestor is authorized to impersonate (your business logic)
	// e.g., check if impersonator has admin role, same organization, etc.

	const token = generateJWT({
		sub: user.id,
		email: user.email,
		devora: {
			isImpersonation: true,
			scope: scope, // Use validated scope from devoraContext
			sessionId: sessionId, // Use validated sessionId from devoraContext
			expiresAt: expiresAt, // Use validated expiresAt from devoraContext
			impersonator: {
				id: impersonator.id,
				email: impersonator.email,
			},
		},
	})

	return { token }
})
```

**Important Security Notes:**

- Never trust `req.body` for impersonation fields (`sessionId`, `scope`, `expiresAt`, `agent`)
- The `req.devoraContext` is populated by the SDK after verifying the HMAC signature
- Always validate that the requestor is authorized to impersonate the target user
- Generate `sessionId` and `expiresAt` server-side if not using Devora's values
- Configure exact browser origins on every client key; an empty origin list disables the key

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
bun run verify:sdks-publish   # dry-run pack; ensures no workspace:* in tarballs
```

### Publishing

SDKs are published to **public npm** under the `@devorash` scope. See [RELEASE.md](./RELEASE.md) for:

- Creating the `@devorash` npm organization
- Semver and Changesets workflow
- CI trusted publishing and `publish:sdks` commands

Quick reference:

```bash
bun run changeset          # after SDK changes
bun run version:sdks       # bump versions + CHANGELOG
bun run test:sdks          # build, test, bundle size
bun run publish:sdks       # publish all packages (CI uses npm trusted publishing)
```

## Future Packages (Planned)

### Backend SDKs (Other Languages)

- `@devorash/java` - Java backend SDK
- `@devorash/rust` - Rust backend SDK
- `@devorash/go` - Go backend SDK

### Backend Framework Adapters

- `@devorash/nestjs` - NestJS adapter
- `@devorash/koa` - Koa adapter
- `@devorash/flask` - Flask adapter (Python)
- `@devorash/actix` - Actix adapter (Rust)
- `@devorash/axum` - Axum adapter (Rust)

### Frontend Framework Wrappers

- `@devorash/nuxt` - Nuxt module
- `@devorash/angular` - Angular module
- `@devorash/qwik` - Qwik integration
