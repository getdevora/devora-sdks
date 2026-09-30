# @devorash/core

Core utilities, types, and constants shared across all Devora SDKs.

## Installation

```bash
npm install @devorash/core
# or
bun add @devorash/core
```

## Usage

This package is primarily used as a dependency by other Devora SDK packages. You typically won't need to install it directly unless you're building custom integrations.

### Types

```typescript
import type {
	DevoraRequest,
	DevoraResponse,
	ImpersonationScope,
	BackendSDKConfig,
	FrontendSDKConfig,
} from "@devorash/core"
```

### Constants

```typescript
import { DEVORA_ENDPOINTS, SECURITY_HEADERS, SDK_DEFAULTS, SDK_VERSION } from "@devorash/core"

// Use predefined endpoints for type safety
console.log(DEVORA_ENDPOINTS.USER_SEARCH) // "/user/search"
console.log(DEVORA_ENDPOINTS.USER_BY_ID) // "/user/:id"
console.log(DEVORA_ENDPOINTS.IMPERSONATE) // "/impersonate/:id"
console.log(DEVORA_ENDPOINTS.TERMINATE) // "/impersonate/:id/terminate"
```

### Security Utilities

```typescript
import { validateTimestamp, isWriteMethod } from "@devorash/core"

// Validate a request timestamp (Unix seconds) against a tolerance (default 300 s)
const { valid, error } = validateTimestamp(requestTimestamp)

// Check if HTTP method is a write operation (blocked in read-only mode)
if (isWriteMethod("POST")) {
	console.log("This is a write operation")
}
```

Request signing (v3) helpers such as `buildCanonicalString`,
`parseSignatureHeaders` and `SIGNED_HEADER_PATTERNS` are exported too; see
[SIGNING.md](https://github.com/getdevora/devora-sdks/blob/main/SIGNING.md).
`@devorash/node` builds on them to sign and verify requests.

### Utility Functions

```typescript
import {
	matchPath,
	createSuccessResponse,
	createErrorResponse,
	validateApiKeyFormat,
} from "@devorash/core"

// Match path patterns
const { match, params } = matchPath("/impersonate/:id", "/impersonate/user123")
console.log(match) // true
console.log(params) // { id: "user123" }

// Create SDK responses
const success = createSuccessResponse({ users: [] })
const error = createErrorResponse("Not found", "NOT_FOUND")

// Check the shape of a public key ID
const validation = validateApiKeyFormat("pk_server_live_abc123")
console.log(validation) // { valid: true, type: "server" }
```

## Exports

### Subpath Exports

Besides the root export, types and constants have their own entry points:

```typescript
// Import only types
import type { DevoraRequest } from "@devorash/core/types"

// Import only constants
import { DEVORA_ENDPOINTS } from "@devorash/core/constants"
```

## API Reference

### Types

| Type                 | Description                                  |
| -------------------- | -------------------------------------------- |
| `DevoraRequest`      | Normalized request object passed to handlers |
| `DevoraResponse`     | Standard response format                     |
| `DevoraUser`         | User object for search results               |
| `ImpersonationScope` | "read" or "write" scope                      |
| `BackendSDKConfig`   | Backend SDK configuration                    |
| `FrontendSDKConfig`  | Frontend SDK configuration                   |
| `RouteDefinition`    | Route handler definition                     |
| `LogEvent`           | Activity log event                           |

### Constants

| Constant           | Description                     |
| ------------------ | ------------------------------- |
| `DEVORA_ENDPOINTS` | Predefined endpoint paths       |
| `SECURITY_HEADERS` | HTTP header names for HMAC auth |
| `SDK_DEFAULTS`     | Default configuration values    |
| `ERROR_CODES`      | SDK error codes                 |
| `WRITE_METHODS`    | HTTP methods considered writes  |

### Security Functions

| Function                   | Description                                        |
| -------------------------- | -------------------------------------------------- |
| `validateTimestamp()`      | Validate a request timestamp against a tolerance   |
| `parseSignatureHeaders()`  | Parse and validate the v3 signature headers        |
| `buildCanonicalString()`   | Build the v3 canonical string that is signed       |
| `isWriteMethod()`          | Check if method is a write operation               |

### Utility Functions

| Function                  | Description                        |
| ------------------------- | ---------------------------------- |
| `matchPath()`             | Match path pattern with parameters |
| `createSuccessResponse()` | Create success response            |
| `createErrorResponse()`   | Create error response              |
| `validateApiKeyFormat()`  | Check the shape of a public key ID |

### Logger Service

The SDK includes a configurable logger service that automatically adjusts based on environment.

```typescript
import { configureLogger, LogLevel, createLogger } from "@devorash/core"

// Configure globally at app initialization (optional)
configureLogger({
	level: LogLevel.DEBUG, // DEBUG, INFO, WARN, ERROR, SILENT
	enabled: true, // Override auto-detection
	includeTimestamp: true, // Add timestamps to log messages
	// handler: { debug, info, warn, error } routes output to your own logger
})

// Create a logger instance
const logger = createLogger("MyComponent")

logger.debug("Verbose debugging info") // Only if level <= DEBUG
logger.info("General information") // Only if level <= INFO
logger.warn("Warning message") // Only if level <= WARN
logger.error("Error message") // Logged at every level unless enabled: false
```

**Environment Auto-Detection:**

- Development: `NODE_ENV=development` (or `dev`), or a browser page on `localhost`, `127.0.0.1` or `*.local`
- Production: All other cases (logging disabled by default, except errors)

**Log Levels:**
| Level | Value | Description |
|-------|-------|-------------|
| `DEBUG` | 0 | Verbose debugging (default in dev) |
| `INFO` | 1 | General information |
| `WARN` | 2 | Warnings (default level in prod) |
| `ERROR` | 3 | Errors only |
| `SILENT` | 4 | Nothing except `error()`; `enabled: false` silences errors too |

## License

MIT
