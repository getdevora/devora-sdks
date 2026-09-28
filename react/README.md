# @devorash/react

Recording, masking and activity preferences are configured in Devora Settings.
SDK initialization overrides are ignored. New sessions retain the server's policy
snapshot across exchange and resume. Developer privacy labels take effect only
when selected in Settings; sensitive-field protection remains mandatory.
See [migration details](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

React SDK for Devora - hooks and components for impersonation.

## Installation

```bash
npm install @devorash/react
```

## Quick Start

```tsx
import { DevoraProvider, useDevoraImpersonation, ImpersonationBanner } from "@devorash/react"

function App() {
	return (
		<DevoraProvider
			apiKey="pk_client_live_xxx"
			onImpersonate={async ({ token, data }) => {
				// Exchange with your app's auth/session layer.
				await signInWithDevoraToken(token)
				// Apply user settings
				if (data?.theme) setTheme(data.theme)
			}}
			onSessionEnd={async () => {
				await signOutImpersonationSession()
				window.location.href = "/login"
			}}
		>
			<ImpersonationBanner />
			<YourApp />
		</DevoraProvider>
	)
}
```

## Hooks

### `useDevoraImpersonation`

```tsx
function MyComponent() {
	const { isImpersonating, scope, userId, sessionId, endSession } = useDevoraImpersonation()

	if (isImpersonating) {
		return (
			<div>
				<p>Viewing as user {userId}</p>
				<p>Access: {scope}</p>
				<button onClick={endSession}>End Session</button>
			</div>
		)
	}

	return <div>Normal view</div>
}
```

### `useDevoraScope`

```tsx
function EditButton() {
	const { canWrite, isReadOnly } = useDevoraScope()

	return <button disabled={!canWrite}>{isReadOnly ? "Read Only" : "Edit"}</button>
}
```

### `useDevoraLogger`

```tsx
function ActionButton() {
	const { logClick } = useDevoraLogger()

	return <button onClick={() => logClick("submit-order", { orderId: "123" })}>Submit Order</button>
}
```

## Components

### `ImpersonationBanner`

```tsx
// Default banner
<ImpersonationBanner />

// Custom styling
<ImpersonationBanner
  className="my-banner"
  style={{ backgroundColor: "#f00" }}
  endButtonText="Exit"
  message="Support Mode Active"
/>

// Custom render
<ImpersonationBanner>
  {({ scope, endSession }) => (
    <div className="custom-banner">
      <span>Support Mode ({scope})</span>
      <button onClick={endSession}>Exit</button>
    </div>
  )}
</ImpersonationBanner>
```

### `ReadOnlyGuard`

```tsx
// Disables content in read-only mode
<ReadOnlyGuard>
  <button>Delete Account</button>
</ReadOnlyGuard>

// Hide completely in read-only mode
<ReadOnlyGuard hide>
  <DangerousAction />
</ReadOnlyGuard>

// Custom fallback
<ReadOnlyGuard fallback={<p>This action is disabled</p>}>
  <EditForm />
</ReadOnlyGuard>
```

### `WriteProtected`

```tsx
// Shows alert when clicked in read-only mode
<WriteProtected blockedMessage="Cannot edit in view-only mode">
	<button>Save Changes</button>
</WriteProtected>
```

## Default screens

`DevoraProvider` renders a plain, dependency-free screen by default for states your app would otherwise have no UI for — each backs off if you already handle it yourself:

- **Preparing** — while the SDK is exchanging the one-time link. Override with `loadingFallback`.
- **A blocked write** — a dialog naming the specific method + path that was blocked (from the SDK's own scope-violation event), with Copy details / OK. Suppressed if you pass `onError={{ scopeViolation: ... }}`.
- **Session ended** — shown for a reason worth explaining (the time limit was reached, or access was ended from Devora); not shown for a deliberate `endSession()` call. Override with `sessionEndedFallback`.
- **Link invalid** — the exchange failed (expired, already used, or malformed). Suppressed if you pass `onError={{ payloadError: ... }}`.

The session-ended and link-invalid screens show a "Back to Devora" link when you set `devoraAppUrl` on `DevoraProvider`:

```tsx
<DevoraProvider apiKey="pk_client_live_xxx" devoraAppUrl="https://app.your-devora-dashboard.example">
```

## TypeScript

Full TypeScript support included:

```tsx
import type { ImpersonatePayload, SessionState, ImpersonationScope } from "@devorash/react"
```

## License

MIT
