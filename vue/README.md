# @devorash/vue

Recording, masking and activity preferences are configured in Devora Settings.
SDK initialization overrides are ignored. New sessions retain the server's policy
snapshot across exchange and resume. Developer privacy labels take effect only
when selected in Settings; sensitive-field protection remains mandatory.
See [migration details](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Vue SDK for Devora - composables for impersonation.

## Installation

```bash
npm install @devorash/vue
```

## Quick Start

```vue
<!-- App.vue -->
<script setup>
import { useDevora, ImpersonationBanner } from "@devorash/vue"

useDevora({
	apiKey: "pk_client_live_xxx",
	onImpersonate: async ({ token, data }) => {
		await signInWithDevoraToken(token)
		if (data?.theme) setTheme(data.theme)
	},
	onSessionEnd: async () => {
		await signOutImpersonationSession()
		router.push("/login")
	},
})
</script>

<template>
	<ImpersonationBanner />
	<RouterView />
</template>
```

Custom banner via the default slot:

```vue
<ImpersonationBanner v-slot="{ scope, targetUser, impersonator, remainingMs, endSession }">
  <div class="banner">
    <span>Viewing {{ targetUser?.name }} ({{ scope }})</span>
    <button @click="endSession">End</button>
  </div>
</ImpersonationBanner>
```

## Composables

### `useDevora`

Initialize SDK (call once in app root):

```vue
<script setup>
import { useDevora } from "@devorash/vue"

const { sdk, isInitialized, isImpersonating, session } = useDevora({
	apiKey: "pk_client_live_xxx",
	onImpersonate: ({ token }) => {
		// Handle login
	},
})
</script>
```

### `useDevoraImpersonation`

Get impersonation state:

```vue
<script setup>
import { useDevoraImpersonation } from "@devorash/vue"

const { isImpersonating, scope, userId, endSession } = useDevoraImpersonation()
</script>
```

### `useDevoraScope`

Check write permissions:

```vue
<script setup>
import { useDevoraScope } from "@devorash/vue"

const { canWrite, isReadOnly } = useDevoraScope()
</script>

<template>
	<button :disabled="!canWrite">Edit</button>
	<p v-if="isReadOnly">Read-only mode</p>
</template>
```

### `useDevoraLogger`

Log actions:

```vue
<script setup>
import { useDevoraLogger } from "@devorash/vue"

const { logClick, logNavigation } = useDevoraLogger()
</script>

<template>
	<button @click="logClick('submit-btn')">Submit</button>
</template>
```

## Default screens

Unlike `@devorash/react`/`@devorash/solid`, Vue has no provider component to render these automatically — Vue's `useDevora()` is a composable, not something that wraps and replaces your app's children. Instead, `@devorash/vue` exports plain, dependency-free components for the same states; place whichever ones you want once near your app root and they show or hide themselves reactively:

```vue
<!-- App.vue -->
<script setup>
import {
	useDevora,
	ImpersonationBanner,
	SessionPreparingScreen,
	SessionEndedScreen,
	LinkInvalidScreen,
	BlockedActionDialog,
} from "@devorash/vue"

useDevora({ apiKey: "pk_client_live_xxx" /* ... */ })
</script>

<template>
	<SessionPreparingScreen />
	<SessionEndedScreen devora-app-url="https://app.your-devora-dashboard.example" />
	<LinkInvalidScreen devora-app-url="https://app.your-devora-dashboard.example" />
	<BlockedActionDialog />
	<ImpersonationBanner />
	<RouterView />
</template>
```

- **`SessionPreparingScreen`** — visible while the SDK is exchanging the one-time link, or while a configured `sessionBridge` hasn't resolved.
- **`SessionEndedScreen`** — visible right after a session ends for a reason worth explaining (the time limit was reached, or access was ended from Devora); not shown for a deliberate `endSession()` call.
- **`LinkInvalidScreen`** — visible when the exchange link failed (expired, already used, or malformed).
- **`BlockedActionDialog`** — visible when a write was blocked in a read-only session; names the real blocked method + path, from the SDK's own scope-violation event.

`SessionEndedScreen` and `LinkInvalidScreen` accept an optional `devora-app-url` prop, shown as a "Back to Devora" link. Each component is a fixed, full-viewport overlay, so it displays correctly no matter where in your template you place it — you don't need to conditionally render them yourself.

For a custom UI built on the same state, `useDevoraSessionState()` exposes the raw reactive values (`payloadError`, `lastEndReason`, `activeViolation`, `dismissViolation()`) and `useDevoraBridge()` exposes `isPending`.

## License

MIT
