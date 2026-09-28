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
import {
	validateTimestamp,
	extractSecurityHeaders,
	timingSafeEqual,
	isWriteMethod,
} from "@devorash/core"

// Validate request timestamp
const { valid, error } = validateTimestamp(requestTimestamp)

// Check if HTTP method is a write operation (blocked in read-only mode)
if (isWriteMethod("POST")) {
	console.log("This is a write operation")
}
```

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

// Validate API key format
const validation = validateApiKeyFormat("pk_server_live_abc123")
console.log(validation) // { valid: true, type: "server", environment: "live" }
```

## Exports

### Subpath Exports

This package supports subpath exports for tree-shaking:

```typescript
// Import only types
import type { DevoraRequest } from "@devorash/core/types"

// Import only constants
import { DEVORA_ENDPOINTS } from "@devorash/core/constants"

// Import only security utilities
import { validateTimestamp } from "@devorash/core/security"

// Import only utility functions
import { matchPath } from "@devorash/core/utils"
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

| Function                    | Description                           |
| --------------------------- | ------------------------------------- |
| `validateTimestamp()`       | Validate request timestamp            |
| `extractSecurityHeaders()`  | Extract security headers from request |
| `validateSecurityHeaders()` | Full security validation              |
| `timingSafeEqual()`         | Timing-safe string comparison         |
| `isWriteMethod()`           | Check if method is a write operation  |

### Utility Functions

| Function                  | Description                        |
| ------------------------- | ---------------------------------- |
| `matchPath()`             | Match path pattern with parameters |
| `createSuccessResponse()` | Create success response            |
| `createErrorResponse()`   | Create error response              |
| `validateApiKeyFormat()`  | Validate API key format            |

### Logger Service

The SDK includes a configurable logger service that automatically adjusts based on environment.

```typescript
import { configureLogger, LogLevel, createLogger } from "@devorash/core"

// Configure globally at app initialization (optional)
configureLogger({
	level: LogLevel.DEBUG, // DEBUG, INFO, WARN, ERROR, SILENT
	enabled: true, // Override auto-detection
	includeTimestamp: true, // Add timestamps to log messages
})

// Create a logger instance
const logger = createLogger("MyComponent")

logger.debug("Verbose debugging info") // Only in development
logger.info("General information") // Only if level <= INFO
logger.warn("Warning message") // Only if level <= WARN
logger.error("Error message") // Always logged (unless disabled)
```

**Environment Auto-Detection:**

- Development: `NODE_ENV=development` or running on `localhost`
- Production: All other cases (logging disabled by default)

**Log Levels:**
| Level | Value | Description |
|-------|-------|-------------|
| `DEBUG` | 0 | Verbose debugging (dev only) |
| `INFO` | 1 | General information |
| `WARN` | 2 | Warnings (default in dev) |
| `ERROR` | 3 | Errors only (default in prod) |
| `SILENT` | 4 | No logging |

## License

MIT
