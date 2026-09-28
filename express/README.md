# @devorash/express

Recording, masking and activity preferences are configured in Devora Settings.
SDK initialization overrides are ignored. New sessions retain the server's policy
snapshot across exchange and resume. Developer privacy labels take effect only
when selected in Settings; sensitive-field protection remains mandatory.
See [migration details](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Express.js adapter for Devora Backend SDK.

## Installation

```bash
npm install @devorash/node @devorash/express
```

## Usage

```typescript
import express from "express"
import { devoraSDK, DEVORA_ENDPOINTS } from "@devorash/node"
import { expressAdapter } from "@devorash/express"

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

// Create Express app
const app = express()
// Mount Devora routes before application-wide parsers.
app.use("/devora", expressAdapter(sdk))
app.use(express.json())

app.listen(3000)
```

## API Reference

### `expressAdapter(sdk, options?)`

Creates an Express Router with all Devora SDK routes.

### `expressMiddleware(sdk, options?)`

Creates Express middleware for a single route handler.

## License

MIT

## Request body limits

Mount Express SDK routes before application-wide body parsers. Devora signs
the exact body bytes, so the router and middleware read the raw body themselves
(1 MiB by default, configurable through `maxBodySize`); compressed request
bodies are rejected. If another parser consumed the body first, the request is
rejected with `DEVORA_BODY_ALREADY_PARSED`. The browser-session handler uses a
4 KiB limit.

For direct `processRequest`/`createGenericHandler` integrations, pass the exact
body bytes, the raw mount-relative path and the raw query (see
[SIGNING.md](../SIGNING.md)), and bound the body in the host's raw-body reader. Configure request-size and read-timeout limits at the
HTTP server/reverse proxy as well; middleware cannot undo upstream buffering.
