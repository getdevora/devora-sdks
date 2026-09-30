# @devorash/react

React provider, hooks and components for Devora impersonation. Wraps
[`@devorash/browser`](https://www.npmjs.com/package/@devorash/browser).

Supports React 18 and 19. The provider runs in the browser; for Next.js use
[`@devorash/nextjs`](https://www.npmjs.com/package/@devorash/nextjs), whose `/client` entry
re-exports this package behind a `"use client"` boundary.

## Installation

```bash
npm install @devorash/react
```

Use a client key (`pk_client_live_…`) and list your app's origin under **Developer →
Integration → Allowed origins (client keys)** in the Devora dashboard.

## Quick start

Mount `DevoraProvider` once, at the root, above your router and auth guards:

```tsx
import { DevoraProvider, ImpersonationBanner } from "@devorash/react"

export function App() {
	return (
		<DevoraProvider
			apiKey={import.meta.env.VITE_DEVORA_API_KEY}
			onImpersonate={async ({ token }) => {
				// YOU IMPLEMENT: turn `token` into your app's logged-in session.
				await signInWithDevoraToken(token)
				window.location.replace("/dashboard")
			}}
			onSessionEnd={async () => {
				// YOU IMPLEMENT: clear the impersonated session.
				await signOutImpersonationSession()
				window.location.replace("/login")
			}}
		>
			<ImpersonationBanner />
			<YourApp />
		</DevoraProvider>
	)
}
```

## `DevoraProvider` props

Accepts every [`@devorash/browser` option](https://www.npmjs.com/package/@devorash/browser#configuration)
as a prop (`apiKey`, `onImpersonate`, `onSessionEnd`, `onSessionExpired`, `onError`,
`sessionBridge`, `autoDetect`, `showWarnings`, `validationIntervalMs`, `debug`, `apiUrl`),
plus:

| Prop                   | Description                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `children`             | Your app.                                                                                         |
| `loadingFallback`      | Replaces the "Preparing your session" screen. Element or `() => element`.                        |
| `blockedFallback`      | Replaces the default safety screen for a bridge-blocked tab. Element or `({ reason, retry }) => element`. |
| `sessionEndedFallback` | Replaces the "Session ended" screen. Element or `({ reason }) => element`.                       |
| `devoraAppUrl`         | Your Devora dashboard URL, shown as a "Back to Devora" link on the ended and invalid-link screens. |

The SDK initializes once on mount; later changes to config props (other than the callbacks)
are not applied. With an empty `apiKey` the provider renders your app without initializing
the SDK.

## New tabs and reloads

Pass `sessionBridge` so a reload or new tab restores the session through your backend instead
of running as an untracked login. See
[Session restore](https://www.npmjs.com/package/@devorash/browser#session-restore).

```tsx
<DevoraProvider
	apiKey={import.meta.env.VITE_DEVORA_API_KEY}
	sessionBridge={{
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
	}}
	onImpersonate={async ({ token }) => signInWithDevoraToken(token)}
	onSessionEnd={async () => signOutImpersonationSession()}
>
	<YourApp />
</DevoraProvider>
```

While the bridge is resolving, the provider renders `loadingFallback` instead of your app.
If the tab is blocked it renders `blockedFallback` (default: a safety screen with Retry and End
impersonation; End calls your `onSessionEnd("blocked")`).

## Hooks

| Hook                       | Returns                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `useDevoraImpersonation()` | `isImpersonating`, `scope`, `sessionId`, `expiresAt`, `targetUser`, `impersonator`, `remainingMs`, `endSession`, `userId` (deprecated) |
| `useDevoraAuth()`          | `isReady` (false while an impersonation link is being redeemed), `isInitialized`, `isImpersonating`, `hadPayloadOnLoad`, `scope`, `endSession` |
| `useDevoraScope()`         | `scope`, `canWrite`, `isReadOnly`                                                                         |
| `useDevoraSession()`       | The `SessionState` plus `isInitialized`                                                                   |
| `useDevoraReady()`         | Whether the SDK finished initializing                                                                     |
| `useDevoraError()`         | The error `init()` rejected with, or `null`                                                               |
| `useDevoraRemainingMs()`   | Milliseconds until expiry (ticks every second), or `null`                                                 |
| `useDevoraLogger()`        | `logAction`, `logClick`, `logNavigation`, `logFormSubmit`                                                 |
| `useDevoraContext()`       | The full context, including `sdk`, `isBlocked`, `isPending` and `bridgeState`                             |

All hooks must be used inside `DevoraProvider`.

```tsx
function ProtectedRoute({ children }: { children: React.ReactNode }) {
	const { isReady } = useDevoraAuth()
	const auth = useApplicationAuth()

	// Wait for Devora before redirecting an apparently signed-out visitor.
	if (!isReady || auth.isLoading) return <LoadingScreen />
	if (!auth.user) return <Navigate to="/login" replace />
	return children
}

function EditButton() {
	const { canWrite, isReadOnly } = useDevoraScope()
	return <button disabled={!canWrite}>{isReadOnly ? "Read only" : "Edit"}</button>
}

function OrderButton() {
	const { logClick } = useDevoraLogger()
	return <button onClick={() => logClick("submit-order", { orderId: "123" })}>Submit order</button>
}
```

`logAction` and the `log*` helpers record only when the Devora project enables custom events.

## Components

### `ImpersonationBanner`

Renders only while impersonating. The default banner shows who is being viewed, the scope, a
live countdown, a Details panel, a minimize control and an End session button.

```tsx
// Default banner
<ImpersonationBanner />

// Options
<ImpersonationBanner
	className="my-banner"
	style={{ backgroundColor: "#b91c1c" }}
	endButtonText="Exit"
	showEndButton
	message={(scope) => (scope === "write" ? "Support mode (read & write)" : "Support mode")}
/>

// Custom render
<ImpersonationBanner>
	{({ scope, targetUser, remainingMs, endSession }) => (
		<div className="custom-banner">
			<span>
				Viewing {targetUser?.email} ({scope}), {Math.ceil((remainingMs ?? 0) / 60_000)} min left
			</span>
			<button onClick={() => void endSession()}>Exit</button>
		</div>
	)}
</ImpersonationBanner>
```

### `ReadOnlyGuard` and `WriteProtected`

```tsx
// Dims and disables its children in a read-only session
<ReadOnlyGuard>
	<button>Delete account</button>
</ReadOnlyGuard>

// Renders nothing in a read-only session
<ReadOnlyGuard hide>
	<DangerousAction />
</ReadOnlyGuard>

// Renders the fallback in a read-only session
<ReadOnlyGuard fallback={<p>This action is disabled</p>}>
	<EditForm />
</ReadOnlyGuard>

// Intercepts clicks in a read-only session; calls onBlocked (default: alert())
<WriteProtected blockedMessage="Cannot edit in view-only mode" onBlocked={(message) => toast(message)}>
	<button>Save changes</button>
</WriteProtected>
```

UI guards improve UX only. Your backend impersonation guard is the enforcement boundary.

### Privacy labels

`DevoraMask`, `DevoraBlock` and `<DevoraRegion name="…">` wrap children in a
`display: contents` element carrying `data-devora-mask`, `data-devora-block` or
`data-devora-region`. They change nothing on their own: recording and masking are configured
by a Devora administrator in the dashboard, and a label takes effect only once an administrator
selects it in Settings. Sensitive fields are always masked.

## Default screens

`DevoraProvider` renders a plain, dependency-free screen for states your app would otherwise
have no UI for:

- **Preparing** — while the SDK redeems a one-time link, or while a configured
  `sessionBridge` resolves. Override with `loadingFallback`.
- **Blocked write** — a dialog naming the blocked method and path. Not shown if you pass
  `onError={{ scopeViolation }}`.
- **Session ended** — after the time limit is reached or access is ended from Devora; not after
  your own `endSession()` call. Override with `sessionEndedFallback`.
- **Link invalid** — the link was forwarded, already used, expired or malformed. Not shown if
  you pass `onError={{ payloadError }}`.
- **Blocked tab** — see [New tabs and reloads](#new-tabs-and-reloads). Override with
  `blockedFallback`.

```tsx
<DevoraProvider apiKey={import.meta.env.VITE_DEVORA_API_KEY} devoraAppUrl="https://app.devora.sh">
	<YourApp />
</DevoraProvider>
```

## TypeScript

```tsx
import type {
	DevoraProviderProps,
	DevoraContextValue,
	ImpersonatePayload,
	SessionState,
	ImpersonationScope,
	SessionBridge,
	BridgeState,
} from "@devorash/react"
```

## License

MIT
