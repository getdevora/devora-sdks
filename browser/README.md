# @devorash/browser

Devora browser SDK. It redeems Devora's one-time impersonation link, hands your app the
credential your backend minted, tracks the session, enforces read-only scope on `fetch` and
`XMLHttpRequest`, and runs whatever capture the Devora dashboard enabled for the session.

Use a framework wrapper when one fits: [`@devorash/react`](https://www.npmjs.com/package/@devorash/react),
[`@devorash/vue`](https://www.npmjs.com/package/@devorash/vue),
[`@devorash/svelte`](https://www.npmjs.com/package/@devorash/svelte),
[`@devorash/solid`](https://www.npmjs.com/package/@devorash/solid) or
[`@devorash/nextjs`](https://www.npmjs.com/package/@devorash/nextjs).

## Installation

```bash
npm install @devorash/browser
```

`@devorash/browser` ships as ES modules for a bundler (Vite, webpack, esbuild, Rollup,
Next.js, …). There is no CDN or script-tag build. It runs in the browser only; initialize it
from client code, never during server rendering.

## Before you start

- Create a **client key** (`pk_client_live_…`) in the Devora dashboard. It is public and safe to
  ship in frontend code. Never put a server key or secret in the browser.
- Add every origin that loads the SDK under **Developer → Integration → Allowed origins
  (client keys)**, including scheme and port (for example `http://localhost:5173`). An empty
  list denies all browser SDK requests.
- Your backend's impersonate handler returns the `token` that `onImpersonate` receives; its
  `redirectUrl` must be a page of this app that initializes the SDK.

## Quick start

```typescript
import Devora from "@devorash/browser"

await Devora.init({
	apiKey: "pk_client_live_xxx",
	// Register callbacks in init() (or call Devora.onImpersonate() before init()):
	// a new session starts while init() runs.
	onImpersonate: async ({ token }) => {
		// YOU IMPLEMENT: turn `token` into your app's logged-in session.
		// Prefer an HTTP-only cookie set by your backend over browser storage.
		await signInWithDevoraToken(token)
		window.location.replace("/dashboard")
	},
	onSessionEnd: async (reason) => {
		// YOU IMPLEMENT: clear the impersonated session.
		await signOutImpersonationSession()
		window.location.replace("/login")
	},
})
```

Call `init()` once at startup, before your router decides whether the visitor is signed in.
`Devora` is a ready-made instance; `createDevoraSDK()` creates an independent one.

### Impersonation links and `Cross-Origin-Opener-Policy`

A Devora link carries its one-time code in the URL fragment. The SDK removes it from the URL
as soon as the module loads and redeems it only together with a verifier that the Devora
dashboard tab sends to the tab it opened, over `window.opener`. A forwarded or copied link
cannot be redeemed.

The page the link lands on must therefore not send a `Cross-Origin-Opener-Policy` header
other than `unsafe-none`. Django's `SecurityMiddleware` (`SECURE_CROSS_ORIGIN_OPENER_POLICY`)
and `helmet()` (`crossOriginOpenerPolicy`) both send `same-origin` by default; relax it for
that route. The SDK clears the public `window.opener` when its handshake starts and keeps the
reference privately until it finishes; this does not sandbox scripts that run before the SDK
loads. The verifier is accepted only from the Devora dashboard origin built into the package
(and from a loopback dashboard when your app itself runs on `localhost`, `127.0.0.1` or `[::1]`).

## Configuration

| Option                 | Required | Default | Description                                                                                  |
| ---------------------- | -------- | ------- | -------------------------------------------------------------------------------------------- |
| `apiKey`               | Yes      |         | Client key (`pk_client_live_…`). Any other format throws.                                   |
| `onImpersonate`        | No       |         | `(payload) => void \| Promise<void>`: establish your app's session from `payload.token`.    |
| `onSessionEnd`         | No       |         | `(reason) => void \| Promise<void>`: clear the impersonated session. Runs for every end.     |
| `onSessionExpired`     | No       |         | `() => void \| Promise<void>`: runs when the time limit is reached (in addition to `onSessionEnd`). |
| `onError`              | No       |         | Error callbacks; see [Error handling](#error-handling).                                      |
| `sessionBridge`        | No       |         | Restores the session in new tabs and reloads; see [Session restore](#session-restore).      |
| `autoDetect`           | No       | `true`  | Redeem an impersonation link found in the URL during `init()`.                              |
| `showWarnings`         | No       | `true`  | Log a console warning when a request is blocked.                                            |
| `validationIntervalMs` | No       | `60000` | How often the SDK checks with Devora that the session is still live; clamped to 15 s–5 min. |
| `debug`                | No       | `false` | Verbose SDK logging.                                                                        |
| `apiUrl`               | No       |         | Devora API origin override (self-hosted). `https` only (`http` for localhost), no path.     |

`onSessionEnd` and `onSessionExpired` callbacks get about two seconds each before the SDK
stops waiting for them.

### Recording, masking and scope policy are not SDK options

Recording, masking, the activity timeline, console/error capture and the read-only allow and
block lists are configured by a Devora administrator in the dashboard (**Settings → Recording
/ Masking**, and the scope policy) and authorized by Devora for each session. They arrive with
the session; the SDK accepts no option that changes them, and unknown init options are dropped.

What you can do in your markup is label elements so an administrator can target them:
`data-devora-mask`, `data-devora-block` and `data-devora-region="name"` (region names:
lowercase letters, digits, `-`, `_`). A label changes nothing on its own; it takes effect only
when an administrator adds its selector or region name in Settings. Sensitive fields
(passwords, one-time codes, payment cards, SSN-like fields, hidden, email and phone inputs)
are always masked. See [Capture settings](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

## Session state

```typescript
if (Devora.isImpersonating()) {
	const session = Devora.getSession()
	console.log(session.targetUser?.name ?? session.targetUser?.id)
	console.log(session.impersonator?.email)
	console.log(session.scope) // "read" | "write"
	console.log(session.expiresAt) // ISO timestamp
}
```

`getSession()` returns `SessionState`: `isActive`, `sessionId`, `scope`, `expiresAt` (ISO
string), `userId` (deprecated, use `targetUser.id`), `targetUser` and `impersonator` (each
`{ id, email?, name? }`). There is no countdown helper; compute
`new Date(session.expiresAt).getTime() - Date.now()` on your own interval (the framework
wrappers do this for you).

| Method                                     | Description                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `init(config)`                             | Initialize. A second call is ignored until `destroy()`.                              |
| `isInitialized()`                          | Whether `init()` finished.                                                            |
| `isImpersonating()`                        | Whether a session is active in this tab.                                              |
| `getSession()`                             | Current `SessionState`.                                                               |
| `getBridgeState()`                         | This tab's restore outcome: `idle`, `none`, `restored` or `blocked` (with `reason`).  |
| `getRevocationState()`                     | Whether Devora confirmed the last `end()`: `none`, `pending`, `confirmed`, `failed`.  |
| `getTabRef()`                              | Non-secret reference for this tab (used by the session bridge).                       |
| `onImpersonate(cb)` / `onSessionEnd(cb)` / `onSessionExpired(cb)` | Register a callback (in addition to the `init()` options). Register before `init()`. |
| `end(reason?)`                             | End the session. `reason` is passed to your callbacks; Devora records it as `user_ended`. |
| `logAction(event)`                         | Add a custom event; see [Custom events](#custom-events).                             |
| `on(event, listener)` / `off(event, listener)` | Subscribe to [events](#events).                                                   |
| `destroy()`                                | Stop the session locally, flush capture and release resources. Async: await it.      |

### Session end reasons

`onSessionEnd(reason)` receives a value from `SDK_END_REASON` (or the string you passed to
`end()`):

| Reason                    | When                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `"user_ended"`            | `end()` was called (the default reason).                                                  |
| `"expired"`               | The session's time limit was reached.                                                     |
| `"terminated_externally"` | Devora reports the session ended (an administrator ended it, or it ended in another tab). |

```typescript
import { SDK_END_REASON } from "@devorash/browser"

Devora.onSessionEnd((reason) => {
	if (reason === SDK_END_REASON.TERMINATED_EXTERNALLY) {
		showNotice("This session was ended from Devora.")
	}
})
```

## Session restore

A session starts in the tab that opened the Devora link. Your own login (cookie or token) is
shared with other tabs, but Devora's per-tab capability is not, and nothing is kept in browser
storage. Without a `sessionBridge`, a reload or a new tab runs as your ordinary login with no
banner, scope enforcement or capture, and `onImpersonate` does not run again.

Provide `sessionBridge` so every tab restores through your backend:

```typescript
await Devora.init({
	apiKey: "pk_client_live_xxx",
	sessionBridge: {
		restore: async ({ tabRef, signal }) => {
			const response = await fetch("/api/devora/browser-session", {
				method: "POST",
				credentials: "same-origin",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ tabRef }),
				signal,
			})
			if (!response.ok) throw new Error(`Session bridge failed: ${response.status}`)
			return response.json()
		},
	},
	onImpersonate: async ({ token }) => signInWithDevoraToken(token),
	onSessionEnd: async () => signOutImpersonationSession(),
})
```

Mount that route with your backend SDK's browser-session helper (`createBrowserSessionHandler`
for Express, Fastify and Hono, `createBrowserSessionRouteHandler` for Next.js,
`browser_session_router` for FastAPI, `browser_session_view` for Django). It answers
`{ status: "none" }` for ordinary users without contacting Devora, a one-time resume code for
an impersonated session, or `{ status: "blocked", reason }`.

With a bridge configured, `init()` calls it on every page load without a link (it waits up to
10 seconds). `getBridgeState()` then reports `none`, `restored`, or
`{ status: "blocked", reason }` where `reason` is `control_plane_unavailable`,
`session_invalid`, `bridge_unavailable` (your `restore` threw or timed out) or `resume_failed`.
While `init()` is pending, and whenever the state is `blocked`, do not render protected content:
the customer session is impersonated but Devora could not put this tab under its controls.
Restored tabs do not call `onImpersonate`; read `getSession()` after `init()` resolves.

Tabs of the same session notify each other over `BroadcastChannel` when it ends; Devora's
validation check remains authoritative.

## Scope enforcement

During a read-only (`scope: "read"`) session the SDK blocks, on `fetch` and `XMLHttpRequest`:

- `POST`, `PUT`, `PATCH` and `DELETE` requests, unless the dashboard's allowlist permits them;
- URLs that look like writes even with `GET` (`/api/…/create|update|delete|remove`,
  `/graphql…mutation`, `/save`, `/submit`, `/upload`, `/import`, `/export`).

Endpoints on the dashboard's blocklist are blocked in every scope. A blocked `fetch` resolves
to a synthetic `403` JSON response (`code: "SCOPE_VIOLATION"`); a blocked XHR fires its
`error` event. Requests to Devora itself are never blocked. Native form submissions,
`navigator.sendBeacon` and WebSockets are not intercepted, so this is a UX layer: your backend
impersonation guard is the enforcement boundary.

```typescript
import { scopeAllowsWrite } from "@devorash/browser"

const { scope } = Devora.getSession()
if (Devora.isImpersonating() && scope && !scopeAllowsWrite(scope)) {
	document.querySelector<HTMLButtonElement>(".edit-btn")!.disabled = true
}
```

## Error handling

```typescript
await Devora.init({
	apiKey: "pk_client_live_xxx",
	onError: {
		// A link that was forwarded, already used, expired or malformed.
		payloadError: (error) => showNotification(error.message),
		// A request blocked by scope enforcement.
		scopeViolation: (violation) => showToast(`Blocked ${violation.method} ${violation.url}`),
		// The session reached its time limit.
		sessionExpired: () => showNotification("Your session expired"),
	},
})
```

`ErrorHandlers` also declares `tokenValidationFailed` and `networkError`; the SDK does not call
them. `init()` itself rejects when `apiKey` or `apiUrl` is invalid.

## Events

`Devora.on(event, listener)` / `Devora.off(event, listener)`. Each listener receives
`{ type, timestamp, data? }`:

| Event                 | `data`                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `init`                | none                                                                                            |
| `impersonation_start` | the `ImpersonatePayload`                                                                        |
| `impersonation_end`   | `{ reason, sessionId }`                                                                         |
| `session_restored`    | the `SessionState` restored through the session bridge                                          |
| `session_blocked`     | the `BridgeState` (`{ status: "blocked", reason }`)                                             |
| `session_expired`     | none                                                                                            |
| `session_revocation`  | the `SessionRevocationState` after `end()`                                                      |
| `session_error`       | `{ error: "POLICY_UNAVAILABLE" }`: the session could not start without a scope policy          |
| `scope_violation`     | the `ScopeViolation` (`{ type: "write_attempt", method, url, timestamp }`)                     |
| `error`               | `{ type, … }`, e.g. `payload_error`, `recording_error`, `recording_incomplete`, `activity_incomplete`, `session_revocation_failed`, `session_logout_failed` |

```typescript
import type { SDKEvent } from "@devorash/browser"

const onStart = (event: SDKEvent) => console.log("Impersonation started", event.data)
Devora.on("impersonation_start", onStart)
Devora.off("impersonation_start", onStart)
```

`init` fires while `init()` runs, so register listeners before calling it.

## Custom events

```typescript
Devora.logAction({
	type: "click",
	action: "viewed_order",
	path: "/orders/123",
	metadata: { orderId: "123" },
})
```

`logAction` records only during an active session and only when the dashboard enables custom
events; otherwise it is a no-op. Events are sanitized before upload: credential-like metadata
keys (`password`, `token`, `authorization`, `cookie`, `session`, …) are dropped, text is
redacted and bounded, and under the `full` masking profile the label is generic and metadata is
replaced by `{ redacted: true }`. Redaction is a backstop: do not pass secrets to `logAction`.

## What capture does in the browser

When the dashboard enables recording or activity for a session:

- Under the `full` profile, captured URLs become session-local references such as
  `https://recording.invalid/page-1` (query strings and fragments are always dropped).
- Console and error capture keeps only error categories under `full`; otherwise text is
  redacted for tokens, emails and card-like numbers. Stack traces are never recorded.
- Recording replaces DOM/CSS identifiers with opaque names and removes stylesheet resource
  URLs and embedded fonts. Very large stylesheets or DOMs can exceed the recorder's limits;
  recording then stops and the SDK emits an `error` event (`recording_incomplete`). The session
  itself continues.
- Activity uploads retry with backoff and stop after three consecutive failures, emitting
  `activity_incomplete`.

## TypeScript

```typescript
import type {
	JSFrontendSDKConfig,
	ImpersonatePayload,
	SessionState,
	SessionBridge,
	SessionBridgeResult,
	BridgeState,
	BridgeBlockedReason,
	ImpersonationScope,
	ImpersonationUserInfo,
	ScopeViolation,
	PayloadError,
	ErrorHandlers,
	SDKEventType,
	SDKEvent,
	SDKEndReason,
	DevoraFrontendSDK,
} from "@devorash/browser"
```

## License

MIT
