# @devorash/fastify

Recording, masking and activity preferences are configured in Devora Settings.
SDK initialization overrides are ignored. New sessions retain the server's policy
snapshot across exchange and resume. Developer privacy labels take effect only
when selected in Settings; sensitive-field protection remains mandatory.
See [migration details](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Fastify adapter for Devora Backend SDK.

## Installation

```bash
npm install @devorash/node @devorash/fastify fastify
```

## Usage

```typescript
import Fastify from "fastify"
import { devoraSDK, DEVORA_ENDPOINTS } from "@devorash/node"
import { fastifyAdapter } from "@devorash/fastify"

// Initialize SDK
const sdk = devoraSDK({
	secretKey: process.env.DEVORA_SECRET_KEY!,
	orgId: "your-org-id",
})

// Define routes
const routes = [
	sdk.register(DEVORA_ENDPOINTS.USER_SEARCH, async (req) => {
		const { term } = req.query
		return { users: await searchUsers(term) }
	}),
	sdk.register(DEVORA_ENDPOINTS.IMPERSONATE, async (req) => {
		const { id } = req.params
		return { token: await generateToken(id), data: {} }
	}),
	sdk.register(DEVORA_ENDPOINTS.TERMINATE, async (req) => {
		const { id } = req.params
		await invalidateSession(id)
		return { success: true }
	}),
]

// Create Fastify server
const server = Fastify({ logger: true, requestTimeout: 15_000 })

// Register Devora plugin
server.register(fastifyAdapter(sdk), { prefix: "/devora" })

// Start server
server.listen({ port: 3000 })
```

## License

MIT

## Request body limits

The plugin applies `maxBodySize` (1 MiB by default) to Fastify's native route
`bodyLimit`, preserving a stricter application limit. Oversized JSON is rejected
before parsing. Custom content-type parsers must enforce equivalent byte limits.
When registering `createBrowserSessionHandler` manually, set `bodyLimit: 4096`
on its route. Keep request-size and read-timeout limits at the reverse proxy too;
upstream buffering occurs before the plugin runs.
