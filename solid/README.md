# @devorash/solid

Solid provider, primitives and components for Devora impersonation. Wraps
[`@devorash/browser`](https://www.npmjs.com/package/@devorash/browser).

Supports Solid 1.7 and later. The SDK initializes in `onMount`, so it never runs during server
rendering.

## Installation

```bash
npm install @devorash/solid
```

Use a client key (`pk_client_live_…`) and list your app's origin under **Developer →
Integration → Allowed origins (client keys)** in the Devora dashboard.

## Quick start

Mount `DevoraProvider` once, at the root, above your router and auth guards:

```tsx
import { DevoraProvider, ImpersonationBanner } from "@devorash/solid"

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
as a prop, read once when the provider mounts, plus:

| Prop                   | Description                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `loadingFallback`      | Replaces the "Preparing your session" screen (a `JSX.Element`).                              |
| `blockedFallback`      | Rendered instead of your app when the tab is bridge-blocked (a `JSX.Element`; default: nothing). |
| `sessionEndedFallback` | Replaces the "Session ended" screen. `JSX.Element` or `({ reason }) => JSX.Element`.         |
| `devoraAppUrl`         | Your Devora dashboard URL, shown as a "Back to Devora" link on the ended and invalid-link screens. |

## New tabs and reloads

Pass `sessionBridge` so a reload or new tab restores the session through your backend instead
of running as an untracked login
([Session restore](https://www.npmjs.com/package/@devorash/browser#session-restore)). While it
resolves the provider renders `loadingFallback`; if Devora cannot restore the tab it renders
`blockedFallback`, which you should provide:

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
	blockedFallback={<p>This impersonated session cannot continue in this tab.</p>}
	onImpersonate={async ({ token }) => signInWithDevoraToken(token)}
	onSessionEnd={async () => signOutImpersonationSession()}
>
	<YourApp />
</DevoraProvider>
```

## Primitives

Use them inside `DevoraProvider`. Values are accessors: call them (`scope()`) inside JSX or
effects so Solid tracks updates.

| Primitive                  | Returns                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `useDevoraImpersonation()` | Accessors `isImpersonating`, `scope`, `sessionId`, `expiresAt`, `targetUser`, `impersonator`, `remainingMs`, `userId` (deprecated); `endSession()` |
| `useDevoraAuth()`          | Accessors `isReady` (false while an impersonation link is being redeemed), `isInitialized`, `isImpersonating`, `scope`; `hadPayloadOnLoad`; `endSession()` |
| `useDevoraScope()`         | Accessors `scope`, `canWrite`, `isReadOnly`                                                           |
| `useDevoraSession()`       | Accessors `session`, `isInitialized`                                                                  |
| `useDevoraReady()`         | Accessor: whether the SDK finished initializing                                                       |
| `useDevoraError()`         | Accessor: the error `init()` failed with, or `null`                                                   |
| `useDevoraLogger()`        | `logAction`, `logClick`, `logNavigation` (record only when the project enables custom events)         |

```tsx
function SessionInfo() {
	const { isImpersonating, targetUser, remainingMs, endSession } = useDevoraImpersonation()
	const { canWrite } = useDevoraScope()
	return (
		<Show when={isImpersonating()}>
			<p>
				Viewing {targetUser()?.email}, {Math.ceil((remainingMs() ?? 0) / 60_000)} min left
				<button onClick={() => void endSession()}>End session</button>
			</p>
			<button disabled={!canWrite()}>Edit</button>
		</Show>
	)
}
```

## Components

```tsx
// Default banner; props: class, showEndButton, endButtonText, message
<ImpersonationBanner />

// Custom render: values are plain, except remainingMs, which is an accessor
<ImpersonationBanner>
	{({ scope, targetUser, remainingMs, endSession }) => (
		<div class="banner">
			Viewing {targetUser?.name} ({scope}), {Math.ceil((remainingMs() ?? 0) / 60_000)} min left
			<button onClick={() => void endSession()}>End</button>
		</div>
	)}
</ImpersonationBanner>

// Disabled while read-only; `hide` renders nothing, `fallback` renders alternative content
<ReadOnlyGuard fallback={<p>Unavailable in read-only mode</p>}>
	<button>Delete account</button>
</ReadOnlyGuard>

// Intercepts clicks while read-only and calls onBlocked with the message
<WriteProtected blockedMessage="Cannot edit in view-only mode" onBlocked={(message) => showToast(message)}>
	<button>Save changes</button>
</WriteProtected>
```

UI guards improve UX only. Your backend impersonation guard is the enforcement boundary.

`DevoraMask`, `DevoraBlock` and `<DevoraRegion name="…">` add `data-devora-*` labels around
their children. They change nothing on their own: recording and masking are configured by a
Devora administrator in the dashboard, and a label takes effect only once an administrator
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

```tsx
<DevoraProvider apiKey={import.meta.env.VITE_DEVORA_API_KEY} devoraAppUrl="https://app.devora.sh">
	<YourApp />
</DevoraProvider>
```

## License

MIT
