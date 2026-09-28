# @devorash/browser

Devora Frontend JavaScript SDK for enabling secure impersonation in your web application.

## Installation

```bash
npm install @devorash/browser
# or
bun add @devorash/browser
```

## Quick Start

```typescript
import Devora from "@devorash/browser"

// Initialize the SDK
await Devora.init({
	apiKey: "pk_client_live_xxx",
})

// Handle impersonation
Devora.onImpersonate(async ({ token, data, scope }) => {
	// Exchange the Devora token with your app's auth/session layer.
	// Prefer an HTTP-only cookie or provider-managed session over browser storage.
	await signInWithDevoraToken(token)

	// Apply user preferences
	if (data?.theme) setTheme(data.theme)

	// Show your own impersonation indicator (or use a framework wrapper banner)
	if (Devora.isImpersonating()) {
		document.body.classList.add("devora-impersonating")
	}

	// Navigate to dashboard
	router.push("/dashboard")
})
```

### Impersonation links and `Cross-Origin-Opener-Policy`

A Devora link carries its one-time code in the URL fragment and only redeems
together with a verifier that the Devora dashboard tab sends to the tab it
opened, over `window.opener`. The page the link lands on must therefore not
send a `Cross-Origin-Opener-Policy` header other than `unsafe-none`: Django's
`SecurityMiddleware` (`SECURE_CROSS_ORIGIN_OPENER_POLICY`) and `helmet()`
(`crossOriginOpenerPolicy`) both send `same-origin` by default. Relax it for
that route only. The SDK clears the public `window.opener` when its handshake
starts and keeps the reference privately until it finishes. This does not
sandbox scripts that execute before the SDK loads; launch only trusted customer
origins while the isolated launch design is pending browser verification.

Verifier messages must come from the single dashboard origin embedded at build
time (`DEVORA_SDK_DASHBOARD_ORIGIN`, production by default) and from the window
that opened the tab. Non-production builds must explicitly configure their own dashboard origin.
Loopback dashboard origins are accepted only when the customer page itself
runs on `localhost`, `127.0.0.1`, or `[::1]`. URL parameters and referrers never
extend that trust. Custom dashboard domains need a reviewed SDK update.

## Framework Wrappers

For framework-specific integrations, use the corresponding wrapper package:

- **React**: `@devorash/react`
- **Vue**: `@devorash/vue`
- **Svelte**: `@devorash/svelte`
- **Solid**: `@devorash/solid`

## API Reference

### Initialization

```typescript
await Devora.init({
	apiKey: "pk_client_live_xxx", // Required: Your public client key
	debug: false, // Optional: Enable debug logging
	autoDetect: true, // Optional: Auto-detect tokens in URL
	showWarnings: true, // Optional: Show console warnings for violations
})
```

Scope enforcement is always enabled during impersonation. Whitelist and blocklist rules come
from Devora Settings and are cached automatically; they cannot be overridden in SDK options.

Session recording, masking and the activity timeline are likewise decided in the Devora
dashboard (Settings → Recording / Masking) and delivered with each session.
Frontend/backend initialization preferences and customer response capture flags
are ignored. New sessions treat `data-devora-mask`, `data-devora-block` and
`data-devora-ignore` as inert labels unless an administrator selects them in
Settings. Named regions are revealed only through the administrator's list.
Sensitive fields remain automatically masked. Existing sessions keep their
original capture semantics until they end.

`SessionRecorder`, `ActivityLogger` and privacy builders are internal and are no
longer exported by `@devorash/browser`. Use the main SDK or framework provider.
See [Settings-only capture migration](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

With the `full` masking profile, automatically captured URLs use session-local
page references such as `https://recording.invalid/page-1`. Recording and activity
share those references, so navigation remains correlated without sending tenant
hostnames or private route parameters. Query strings and fragments are omitted.
After 256 distinct pages, new paths use `page-redacted`; known references remain
stable. Partial/minimal profiles retain origin and pathname.

Custom events, errors and console output are sanitized before upload, identically
for activity and recording. Custom-event paths use the same page references;
metadata keys that look like credentials (`password`, `token`, `authorization`,
`cookie`, `session`, …) are dropped at any depth and nesting, size and length are
bounded. Under the `full` profile, custom actions use a generic label and arbitrary
metadata is replaced by `{ redacted: true }`, including its keys and numeric values.
Error messages and console arguments are masked; only known error categories
(`TypeError`) are kept. Otherwise
text is redacted for tokens, emails and card-like numbers. Stack traces are never
recorded. Redaction is a backstop: do not pass secrets to `logAction`.

Recording also replaces DOM/CSS identifiers with consistent opaque names, masks
generated text, and removes stylesheet resource URLs and embedded font payloads.
Layout declarations remain available, but system font fallback and masked text
can change intrinsic sizing. Unsupported CSS becomes inert. Parsing is limited
to one million characters, 250,000 tokens and 64 nesting levels per stylesheet;
identifier retention is limited to 20,000 entries and one million characters per
recording. Exceeding a limit stops recording and reports incomplete capture.
The stylesheet cache retains at most two million characters across 512 entries.

Activity uploads use one active request, retain at most 100 unacknowledged events,
and reuse batch identities when retrying. Backend deduplication must be deployed
before these SDKs. Queue overflow preserves the pending events and reports the
dropped count in the next acknowledged batch's activity timeline. A permanent
refusal or three consecutive failures stops activity capture and emits an SDK
`error` event with `type: "activity_incomplete"`. Unload delivery is best effort;
an unconfirmed request is never treated as an acknowledgment.

### Checking Status

```typescript
// Check if SDK is initialized
if (Devora.isInitialized()) {
	console.log("SDK ready")
}

// Check if impersonation is active
if (Devora.isImpersonating()) {
	const session = Devora.getSession()
	console.log(`Impersonating user ${session.targetUser?.id} (${session.targetUser?.name})`)
	console.log(`Agent: ${session.impersonator?.name ?? session.impersonator?.email}`)
	console.log(`Scope: ${session.scope}`) // "read" | "write"
	console.log(`Expires: ${session.expiresAt}`) // ISO timestamp — use to build your own countdown
}

// Outcome of this tab's bridge-restoration attempt (see "Session restore" below)
const bridge = Devora.getBridgeState()
if (bridge.status === "blocked") {
	console.log(`Restoration blocked: ${bridge.reason}`)
}

// A non-secret id for this browser tab, useful for correlating bridge restores
const tabRef = Devora.getTabRef()
```

`getSession()` returns the full `SessionState`: `isActive`, `sessionId`, `scope`, `expiresAt` (ISO string), `userId` (deprecated, use `targetUser.id`), `targetUser` and `impersonator` (each `{ id, email?, name? }`). There's no built-in countdown helper — compute remaining time yourself with `new Date(session.expiresAt).getTime() - Date.now()` and re-render on your own interval (this is exactly what the framework wrapper packages do).

### Handling Impersonation

```typescript
// Register callback for impersonation start
Devora.onImpersonate(async ({ token, data, scope, sessionId, targetUser, expiresAt }) => {
	// Authenticate with your app.
	// Keep provider tickets and long-lived credentials out of browser storage.
	await signInWithDevoraToken(token)

	// Apply user settings from data
	if (data) {
		applyUserSettings(data)
	}

	// Navigate to the app
	window.location.href = "/dashboard"
})

// Register callback for session end
Devora.onSessionEnd(async (reason) => {
	console.log(`Session ended: ${reason}`)
	await signOutImpersonationSession()
	window.location.href = "/login"
})

// Register callback for session expiry specifically (also covered by
// onSessionEnd, and by the config-level onError.sessionExpired handler)
Devora.onSessionExpired(() => {
	console.log("Session expired")
})
```

`reason` is one of `SDK_END_REASON`'s values — `"user_ended"`, `"expired"`, or `"terminated_externally"` (a `"page_unload"` value also exists but is never actually sent by the SDK today):

```typescript
import { SDK_END_REASON } from "@devorash/browser"

Devora.onSessionEnd((reason) => {
	if (reason === SDK_END_REASON.TERMINATED_EXTERNALLY) {
		showNotice("Your session was ended by an administrator.")
	}
})
```

### Manual Session Control

```typescript
// End the session manually
await Devora.end()

// Destroy the SDK instance. This is async — always await it, or recording
// data from the very end of the session can be lost.
await Devora.destroy()
```

### Custom Activity Logging

Custom events reach the activity timeline only when the project policy accepts them;
otherwise `logAction` is a no-op (a debug warning is logged).

```typescript
// Log custom actions during impersonation
Devora.logAction({
	type: "click",
	action: "viewed_order",
	path: "/orders/123",
	metadata: {
		orderId: "123",
		orderTotal: 99.99,
	},
})
```

### Event Listeners

`Devora.on(event, listener)` / `Devora.off(event, listener)` support 9 event types, each firing with `{ type, timestamp, data? }`:

| Event                 | `data`                                                                     |
| --------------------- | -------------------------------------------------------------------------- |
| `init`                | none                                                                       |
| `impersonation_start` | the `ImpersonatePayload`                                                   |
| `impersonation_end`   | `{ reason, sessionId }`                                                    |
| `session_restored`    | the full `SessionState`                                                    |
| `session_blocked`     | the `BridgeState` (`{ status: "blocked", reason }`)                        |
| `session_expired`     | none                                                                       |
| `session_error`       | `{ error: "POLICY_UNAVAILABLE" }`                                          |
| `scope_violation`     | the `ScopeViolation` (`{ type: "write_attempt", method, url, timestamp }`) |
| `error`               | varies by source (recording, exchange)                                     |

```typescript
Devora.on("impersonation_start", (event) => {
	console.log("Impersonation started:", event.data)
})

Devora.on("impersonation_end", (event) => {
	console.log("Impersonation ended:", event.data)
})

Devora.on("scope_violation", (event) => {
	const violation = event.data // { type: "write_attempt", method, url, timestamp }
	console.log(`Blocked ${violation.method} ${violation.url}`)
})

// Remove listener
Devora.off("impersonation_start", myListener)
```

## Scope Enforcement

In read-only mode, the SDK automatically blocks write operations:

- **Blocked**: `POST`, `PUT`, `DELETE`, `PATCH` requests
- **Allowed**: `GET`, `HEAD`, `OPTIONS` requests

```typescript
// During read-only impersonation:
fetch("/api/users", { method: "POST" }) // Blocked!
// Console: [Devora] Blocked POST request in read-only mode

fetch("/api/users") // Allowed (GET by default)
```

### Detecting Read-Only Mode

```typescript
import { scopeAllowsWrite } from "@devorash/browser"

const session = Devora.getSession()

if (!scopeAllowsWrite(session.scope)) {
	// Disable edit buttons, hide forms, etc.
	document.querySelector(".edit-btn").disabled = true
}
```

## Error Handling

```typescript
await Devora.init({
	apiKey: "pk_client_live_xxx",
	onError: {
		tokenValidationFailed: (error) => {
			console.error("Token validation failed:", error)
			showNotification("Unable to start impersonation")
		},
		scopeViolation: (violation) => {
			showToast(`Action blocked: ${violation.method} ${violation.url}`)
		},
		sessionExpired: () => {
			window.location.href = "/login?expired=true"
		},
		networkError: (error) => {
			console.error("Network error:", error)
		},
	},
})
```

### Session restore

`onImpersonate` runs only when a new impersonation session starts from a
one-time exchange link. It is **not** replayed when a session is restored from
browser storage after a page refresh — your app should already have persisted the
customer auth token from the initial `onImpersonate` call. After `init()`
resolves, use `Devora.getSession()` to read the restored session state.

## CDN Usage

For non-bundled applications:

```html
<script src="https://cdn.devora.sh/sdk/v1/devora.js"></script>
<script>
	Devora.init({ apiKey: "pk_client_live_xxx" })

	Devora.onImpersonate(async function (payload) {
		await signInWithDevoraToken(payload.token)
		window.location.href = "/dashboard"
	})
</script>
```

## TypeScript Support

Full TypeScript support with exported types:

```typescript
import type {
	ImpersonatePayload,
	SessionState,
	ImpersonationScope,
	ImpersonationUserInfo,
	ScopeViolation,
	PayloadError,
	ErrorHandlers,
	BridgeState,
	BridgeBlockedReason,
	SessionBridge,
	SessionBridgeResult,
	DecryptedPayload,
	ResumedSession,
	StoredSessionValidation,
	SDKEventType,
	SDKEvent,
	SDKEndReason,
	DevoraFrontendSDK,
	DevoraMaskingProfile,
	DevoraCapturePolicy,
	DevoraCaptureSnapshot,
} from "@devorash/browser"
import { SDK_END_REASON } from "@devorash/browser"
```

## License

MIT
