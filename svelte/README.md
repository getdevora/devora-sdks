# @devorash/svelte

Svelte stores and components for Devora impersonation. Wraps
[`@devorash/browser`](https://www.npmjs.com/package/@devorash/browser).

Supports Svelte 4 and 5 (the components use slot syntax, so use them from components that are
not in runes mode). State is app-global and browser-only: call `initDevora()` from `onMount`,
never during server rendering.

## Installation

```bash
npm install @devorash/svelte
```

Use a client key (`pk_client_live_…`) and list your app's origin under **Developer →
Integration → Allowed origins (client keys)** in the Devora dashboard.

## Quick start

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
	import { onMount, onDestroy } from "svelte"
	import { initDevora, destroyDevora } from "@devorash/svelte"
	import ImpersonationBanner from "@devorash/svelte/ImpersonationBanner.svelte"

	onMount(() => {
		void initDevora({
			apiKey: import.meta.env.VITE_DEVORA_API_KEY,
			onImpersonate: async ({ token }) => {
				// YOU IMPLEMENT: turn `token` into your app's logged-in session.
				await signInWithDevoraToken(token)
				window.location.replace("/dashboard")
			},
			onSessionEnd: async () => {
				// YOU IMPLEMENT: clear the impersonated session.
				await signOutImpersonationSession()
				window.location.replace("/login")
			},
		})
	})

	onDestroy(() => void destroyDevora())
</script>

<ImpersonationBanner />
<slot />
```

`initDevora(config)` accepts every
[`@devorash/browser` option](https://www.npmjs.com/package/@devorash/browser#configuration) and
resolves with the SDK instance. Call it once; calling it again destroys the previous instance
and starts a new one.

## New tabs and reloads

Pass `sessionBridge` so a reload or new tab restores the session through your backend instead
of running as an untracked login
([Session restore](https://www.npmjs.com/package/@devorash/browser#session-restore)). Svelte has
no provider that gates your app, so wrap protected content in `BridgeGuard`: it renders the
`pending` slot until the bridge resolves, the `fallback` slot if the tab is blocked, and your
content otherwise (both slots default to nothing).

```svelte
<script lang="ts">
	import { onMount } from "svelte"
	import { initDevora } from "@devorash/svelte"
	import BridgeGuard from "@devorash/svelte/BridgeGuard.svelte"

	onMount(() => {
		void initDevora({
			apiKey: import.meta.env.VITE_DEVORA_API_KEY,
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
	})
</script>

<BridgeGuard>
	<slot />
	<p slot="pending">Loading…</p>
	<p slot="fallback">This impersonated session cannot continue in this tab.</p>
</BridgeGuard>
```

## Stores

| Store                 | Value                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `devoraImpersonation` | `isImpersonating`, `scope`, `sessionId`, `expiresAt`, `targetUser`, `impersonator`, `remainingMs` (ticks every second), `userId` (deprecated) |
| `devoraAuth`          | `isReady` (false while an impersonation link is being redeemed), `isInitialized`, `isImpersonating`, `hadPayloadOnLoad`, `scope`, `initError` |
| `devoraScope`         | `scope`, `canWrite`, `isReadOnly`                                                                       |
| `devoraBridge`        | `bridgeState`, `isBlocked`, `isPending`                                                                 |
| `devoraSessionState`  | `payloadError`, `lastEndReason`, `activeViolation`                                                      |
| `devoraStore`         | Everything above in one writable store (`isInitialized`, `isImpersonating`, `session`, …)               |

```svelte
<script lang="ts">
	import { devoraImpersonation, devoraScope, endDevoraSession } from "@devorash/svelte"
</script>

{#if $devoraImpersonation.isImpersonating}
	<p>
		Viewing {$devoraImpersonation.targetUser?.email} ({$devoraImpersonation.scope})
		<button on:click={endDevoraSession}>End session</button>
	</p>
{/if}
<button disabled={!$devoraScope.canWrite}>Edit</button>
```

## Functions

| Function                                    | Description                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| `initDevora(config)`                        | Initialize the SDK; resolves with the instance.                          |
| `endDevoraSession()`                        | End the current session.                                                 |
| `logDevoraAction(event)`                    | Add a custom event (recorded only when the project enables custom events). |
| `logDevoraClick(elementId, metadata?)`      | Log a click.                                                             |
| `logDevoraNavigation(path, metadata?)`      | Log a navigation.                                                        |
| `dismissViolation()`                        | Clear the current blocked-request dialog.                                |
| `getDevoraSDK()`                            | The SDK instance, or `null`.                                             |
| `destroyDevora()`                           | Destroy the SDK (async; await it to flush capture).                      |

## Components

Each component is published at its own path, `@devorash/svelte/<Name>.svelte`:

```svelte
<script lang="ts">
	import ImpersonationBanner from "@devorash/svelte/ImpersonationBanner.svelte"
	import ReadOnlyGuard from "@devorash/svelte/ReadOnlyGuard.svelte"
	import WriteProtected from "@devorash/svelte/WriteProtected.svelte"

	const showToast = (message: string) => console.log(message)
</script>

<!-- Default banner; props: className, showEndButton, endButtonText, message -->
<ImpersonationBanner />

<!-- Custom banner through the default slot -->
<ImpersonationBanner let:scope let:targetUser let:endSession>
	<div class="banner">
		Viewing {targetUser?.name} ({scope})
		<button on:click={endSession}>End</button>
	</div>
</ImpersonationBanner>

<!-- Disabled while read-only; `hide` renders nothing, the fallback slot renders alternative content -->
<ReadOnlyGuard>
	<button>Delete account</button>
	<p slot="fallback">Unavailable in read-only mode</p>
</ReadOnlyGuard>

<!-- Intercepts clicks while read-only and dispatches `blocked` with the message -->
<WriteProtected blockedMessage="Cannot edit in view-only mode" on:blocked={(event) => showToast(event.detail)}>
	<button>Save changes</button>
</WriteProtected>
```

UI guards improve UX only. Your backend impersonation guard is the enforcement boundary.

The `use:devoraMask`, `use:devoraBlock` and `use:devoraRegion={"name"}` actions add
`data-devora-*` labels. They change nothing on their own: recording and masking are configured
by a Devora administrator in the dashboard, and a label takes effect only once an administrator
selects it in Settings. Sensitive fields are always masked.

## Default screens

Svelte has no provider that wraps your app, so `@devorash/svelte` ships the default screens as
components. Place the ones you want once near your app root; each is a fixed full-viewport
overlay that shows and hides itself:

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
	import SessionPreparingScreen from "@devorash/svelte/SessionPreparingScreen.svelte"
	import SessionEndedScreen from "@devorash/svelte/SessionEndedScreen.svelte"
	import LinkInvalidScreen from "@devorash/svelte/LinkInvalidScreen.svelte"
	import BlockedActionDialog from "@devorash/svelte/BlockedActionDialog.svelte"
</script>

<SessionPreparingScreen />
<SessionEndedScreen devoraAppUrl="https://app.devora.sh" />
<LinkInvalidScreen devoraAppUrl="https://app.devora.sh" />
<BlockedActionDialog />
<slot />
```

- **`SessionPreparingScreen`** — while the SDK redeems a one-time link, or while a configured
  `sessionBridge` resolves.
- **`SessionEndedScreen`** — after the time limit is reached or access is ended from Devora;
  not after your own `endDevoraSession()` call.
- **`LinkInvalidScreen`** — the link was forwarded, already used, expired or malformed.
- **`BlockedActionDialog`** — a request was blocked in a read-only session; names the method
  and path.

`devoraAppUrl` adds a "Back to Devora" link. These components show even if you pass your own
`onError` handlers; leave out the ones you replace.

## License

MIT
