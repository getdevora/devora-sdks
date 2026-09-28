# @devorash/hono

Recording, masking and activity preferences are configured in Devora Settings.
SDK initialization overrides are ignored. New sessions retain the server's policy
snapshot across exchange and resume. Developer privacy labels take effect only
when selected in Settings; sensitive-field protection remains mandatory.
See [migration details](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Hono adapter for Devora Backend SDK. Works with Node.js, Bun, Deno, and edge runtimes.

## Installation

```bash
npm install @devorash/node @devorash/hono hono
```

## Usage

```typescript
import { Hono } from "hono"
import { devoraSDK, DEVORA_ENDPOINTS } from "@devorash/node"
import { honoAdapter } from "@devorash/hono"

// Initialize SDK
const sdk = devoraSDK({
	apiKey: process.env.DEVORA_API_KEY!,
	secretKey: process.env.DEVORA_SECRET_KEY!,
	orgId: "your-org-id",
})

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

## Edge Runtime Support

Works with Cloudflare Workers, Vercel Edge, and other edge runtimes:

```typescript
// wrangler.toml or similar config
export default {
	fetch: app.fetch,
}
```

## License

MIT
