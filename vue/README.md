# @devorash/vue

Vue 3 composables and components for Devora impersonation. Wraps
[`@devorash/browser`](https://www.npmjs.com/package/@devorash/browser).

Supports Vue 3.3 and later. State is app-global and browser-only: initialize it on the client
only (for Nuxt, from a client-only component or plugin), never during server rendering.

## Installation

```bash
npm install @devorash/vue
```

Use a client key (`pk_client_live_…`) and list your app's origin under **Developer →
Integration → Allowed origins (client keys)** in the Devora dashboard.

## Quick start

Call `useDevora()` once, in the `<script setup>` of your root component:

```vue
<!-- App.vue -->
<script setup lang="ts">
import { useDevora, ImpersonationBanner } from "@devorash/vue"

useDevora({
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
</script>

<template>
	<ImpersonationBanner />
	<RouterView />
</template>
```

`useDevora(config)` accepts every
[`@devorash/browser` option](https://www.npmjs.com/package/@devorash/browser#configuration)
and initializes the SDK when the calling component mounts. It must run inside a component's
`setup()`. If it is called again elsewhere, the first caller's configuration is kept. It returns
`{ sdk, isInitialized, isImpersonating, bridgeState, session, initError }`.

## New tabs and reloads

Pass `sessionBridge` so a reload or new tab restores the session through your backend instead
of running as an untracked login
([Session restore](https://www.npmjs.com/package/@devorash/browser#session-restore)). Vue has
no provider that gates your app, so wrap protected content in `BridgeGuard`: it renders its
`#pending` slot until the bridge resolves, its `#fallback` slot if the tab is blocked, and your
content otherwise (both slots default to nothing).

```vue
<script setup lang="ts">
import { useDevora, BridgeGuard } from "@devorash/vue"

useDevora({
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
</script>

<template>
	<BridgeGuard>
		<RouterView />
		<template #pending><p>Loading…</p></template>
		<template #fallback><p>This impersonated session cannot continue in this tab.</p></template>
	</BridgeGuard>
</template>
```

## Composables

| Composable                 | Returns                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `useDevoraImpersonation()` | Refs `isImpersonating`, `scope`, `sessionId`, `expiresAt`, `targetUser`, `impersonator`, `remainingMs` (ticks every second), `userId` (deprecated); `endSession()`, `getRemainingMs()` |
| `useDevoraAuth()`          | `isReady` (false while an impersonation link is being redeemed), `isInitialized`, `isImpersonating`, `initError`, `scope`, `hadPayloadOnLoad`, `endSession()` |
| `useDevoraScope()`         | Refs `scope`, `canWrite`, `isReadOnly`                                                                    |
| `useDevoraSession()`       | Refs for each `SessionState` field plus `isInitialized`                                                   |
| `useDevoraReady()`         | Ref: whether the SDK finished initializing                                                                |
| `useDevoraBridge()`        | Refs `bridgeState`, `isBlocked`, `isPending`                                                              |
| `useDevoraSessionState()`  | Refs `payloadError`, `lastEndReason`, `activeViolation`; `dismissViolation()`                             |
| `useDevoraLogger()`        | `logAction`, `logClick`, `logNavigation` (record only when the project enables custom events)             |

```vue
<script setup lang="ts">
import { useDevoraImpersonation, useDevoraScope } from "@devorash/vue"

const { isImpersonating, targetUser, remainingMs, endSession } = useDevoraImpersonation()
const { canWrite, isReadOnly } = useDevoraScope()
</script>

<template>
	<p v-if="isImpersonating">
		Viewing {{ targetUser?.email }}, {{ Math.ceil((remainingMs ?? 0) / 60_000) }} min left
		<button @click="endSession">End session</button>
	</p>
	<button :disabled="!canWrite">{{ isReadOnly ? "Read only" : "Edit" }}</button>
</template>
```

## Components

```vue
<!-- Default banner; props: class, showEndButton, endButtonText, message -->
<ImpersonationBanner />

<!-- Custom banner through the default slot -->
<ImpersonationBanner v-slot="{ scope, targetUser, remainingMs, endSession }">
	<div class="banner">
		<span>Viewing {{ targetUser?.name }} ({{ scope }})</span>
		<button @click="endSession">End</button>
	</div>
</ImpersonationBanner>

<!-- Disabled while read-only; `hide` renders nothing, #fallback renders alternative content -->
<ReadOnlyGuard>
	<button>Delete account</button>
	<template #fallback><p>Unavailable in read-only mode</p></template>
</ReadOnlyGuard>

<!-- Intercepts clicks while read-only and emits `blocked` with the message -->
<WriteProtected blocked-message="Cannot edit in view-only mode" @blocked="showToast">
	<button>Save changes</button>
</WriteProtected>
```

UI guards improve UX only. Your backend impersonation guard is the enforcement boundary.

`v-devora-mask`, `v-devora-block` and `v-devora-region="'name'"` (directives `vDevoraMask`,
`vDevoraBlock`, `vDevoraRegion`) and the `DevoraMask`, `DevoraBlock` and `DevoraRegion`
components add `data-devora-*` labels. They change nothing on their own: recording and masking
are configured by a Devora administrator in the dashboard, and a label takes effect only once an
administrator selects it in Settings. Sensitive fields are always masked.

## Default screens

Vue has no provider that wraps your app, so `@devorash/vue` exports the default screens as
components. Place the ones you want once near your app root; each is a fixed full-viewport
overlay that shows and hides itself:

```vue
<!-- App.vue -->
<script setup lang="ts">
import {
	useDevora,
	ImpersonationBanner,
	SessionPreparingScreen,
	SessionEndedScreen,
	LinkInvalidScreen,
	BlockedActionDialog,
} from "@devorash/vue"

useDevora({ apiKey: import.meta.env.VITE_DEVORA_API_KEY /* , onImpersonate, onSessionEnd */ })
</script>

<template>
	<SessionPreparingScreen />
	<SessionEndedScreen devora-app-url="https://app.devora.sh" />
	<LinkInvalidScreen devora-app-url="https://app.devora.sh" />
	<BlockedActionDialog />
	<ImpersonationBanner />
	<RouterView />
</template>
```

- **`SessionPreparingScreen`** — while the SDK redeems a one-time link, or while a configured
  `sessionBridge` resolves.
- **`SessionEndedScreen`** — after the time limit is reached or access is ended from Devora;
  not after your own `endSession()` call.
- **`LinkInvalidScreen`** — the link was forwarded, already used, expired or malformed.
- **`BlockedActionDialog`** — a request was blocked in a read-only session; names the method
  and path.

`devora-app-url` adds a "Back to Devora" link. Unlike the React and Solid providers, these
components show even if you pass your own `onError` handlers; leave out the ones you replace.

## License

MIT
