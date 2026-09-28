# @devorash/solid

Recording, masking and activity preferences are configured in Devora Settings.
SDK initialization overrides are ignored. New sessions retain the server's policy
snapshot across exchange and resume. Developer privacy labels take effect only
when selected in Settings; sensitive-field protection remains mandatory.
See [migration details](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Solid.js SDK for Devora - primitives for impersonation.

## Installation

```bash
npm install @devorash/solid
```

## Quick Start

```tsx
import { DevoraProvider, ImpersonationBanner } from "@devorash/solid"

function App() {
	return (
		<DevoraProvider
			apiKey="pk_client_live_xxx"
			onImpersonate={async ({ token, data }) => {
				await signInWithDevoraToken(token)
			}}
			onSessionEnd={async () => {
				await signOutImpersonationSession()
				navigate("/login")
			}}
		>
			<ImpersonationBanner />
			<YourApp />
		</DevoraProvider>
	)
}
```

Custom banner via children render prop:

```tsx
<ImpersonationBanner>
	{({ scope, targetUser, endSession }) => (
		<div class="banner">
			Viewing {targetUser?.name} ({scope})<button onClick={endSession}>End</button>
		</div>
	)}
</ImpersonationBanner>
```

## Primitives

### `DevoraProvider`

Wrap your app with the provider:

```tsx
<DevoraProvider
	apiKey="pk_client_live_xxx"
	onImpersonate={({ token }) => {}}
	onSessionEnd={() => {}}
>
	<App />
</DevoraProvider>
```

### `useDevoraImpersonation`

Get impersonation state:

```tsx
const { isImpersonating, scope, userId, endSession } = useDevoraImpersonation()

// All values are accessors (reactive signals)
console.log(isImpersonating()) // boolean
console.log(scope()) // "read" | "write" | null
```

### `useDevoraScope`

Check write permissions:

```tsx
const { canWrite, isReadOnly } = useDevoraScope()

return <button disabled={!canWrite()}>Edit</button>
```

### `useDevoraLogger`

Log actions:

```tsx
const { logClick, logNavigation } = useDevoraLogger()

return <button onClick={() => logClick("submit-btn")}>Submit</button>
```

### `useDevoraReady`

Check if SDK is initialized:

```tsx
const isReady = useDevoraReady()

return (
	<Show when={isReady()} fallback={<Loading />}>
		<App />
	</Show>
)
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

## License

MIT
