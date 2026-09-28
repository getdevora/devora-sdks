# @devorash/svelte

Recording, masking and activity preferences are configured in Devora Settings.
SDK initialization overrides are ignored. New sessions retain the server's policy
snapshot across exchange and resume. Developer privacy labels take effect only
when selected in Settings; sensitive-field protection remains mandatory.
See [migration details](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Svelte SDK for Devora - stores for impersonation.

## Installation

```bash
npm install @devorash/svelte
```

## Quick Start

```svelte
<!-- +layout.svelte -->
<script>
import { onMount, onDestroy } from "svelte";
import { initDevora, destroyDevora } from "@devorash/svelte";
import ImpersonationBanner from "@devorash/svelte/ImpersonationBanner.svelte";

onMount(async () => {
  await initDevora({
    apiKey: "pk_client_live_xxx",
    onImpersonate: async ({ token, data }) => {
      await signInWithDevoraToken(token);
    },
    onSessionEnd: async () => {
      await signOutImpersonationSession();
      goto("/login");
    },
  });
});

onDestroy(() => {
  destroyDevora();
});
</script>

<ImpersonationBanner />
<slot />
```

Custom banner via slot:

```svelte
<ImpersonationBanner let:scope let:targetUser let:endSession>
  <div class="banner">Viewing {targetUser?.name} ({scope})</div>
</ImpersonationBanner>
```

## Stores

### `devoraStore`

Main store with all SDK state:

```svelte
<script>
import { devoraStore } from "@devorash/svelte";

$: ({ isInitialized, isImpersonating, session } = $devoraStore);
</script>
```

### `devoraImpersonation`

Derived store for impersonation state:

```svelte
<script>
import { devoraImpersonation } from "@devorash/svelte";

$: ({ isImpersonating, scope, userId } = $devoraImpersonation);
</script>
```

### `devoraScope`

Derived store for scope/permissions:

```svelte
<script>
import { devoraScope } from "@devorash/svelte";

$: ({ canWrite, isReadOnly } = $devoraScope);
</script>

<button disabled={!$devoraScope.canWrite}>Edit</button>
```

## Functions

### `initDevora(config)`

Initialize the SDK.

### `endDevoraSession()`

End current session.

### `logDevoraAction(event)`

Log custom action.

### `logDevoraClick(elementId, metadata?)`

Log click event.

### `destroyDevora()`

Destroy SDK instance.

## Default screens

Svelte has no provider component to render these automatically — `initDevora()` is a plain function, not something that wraps and replaces your app's children. Instead, `@devorash/svelte` ships plain, dependency-free components for the same states; place whichever ones you want once near your app root and they show or hide themselves reactively:

```svelte
<!-- +layout.svelte -->
<script>
import { initDevora, destroyDevora } from "@devorash/svelte";
import ImpersonationBanner from "@devorash/svelte/ImpersonationBanner.svelte";
import SessionPreparingScreen from "@devorash/svelte/SessionPreparingScreen.svelte";
import SessionEndedScreen from "@devorash/svelte/SessionEndedScreen.svelte";
import LinkInvalidScreen from "@devorash/svelte/LinkInvalidScreen.svelte";
import BlockedActionDialog from "@devorash/svelte/BlockedActionDialog.svelte";
</script>

<SessionPreparingScreen />
<SessionEndedScreen devoraAppUrl="https://app.your-devora-dashboard.example" />
<LinkInvalidScreen devoraAppUrl="https://app.your-devora-dashboard.example" />
<BlockedActionDialog />
<ImpersonationBanner />
<slot />
```

- **`SessionPreparingScreen`** — visible while the SDK is exchanging the one-time link, or while a configured `sessionBridge` hasn't resolved.
- **`SessionEndedScreen`** — visible right after a session ends for a reason worth explaining (the time limit was reached, or access was ended from Devora); not shown for a deliberate `endDevoraSession()` call.
- **`LinkInvalidScreen`** — visible when the exchange link failed (expired, already used, or malformed).
- **`BlockedActionDialog`** — visible when a write was blocked in a read-only session; names the real blocked method + path, from the SDK's own scope-violation event.

`SessionEndedScreen` and `LinkInvalidScreen` accept an optional `devoraAppUrl` prop, shown as a "Back to Devora" link. Each component is a fixed, full-viewport overlay, so it displays correctly no matter where in your markup you place it.

For a custom UI built on the same state, `devoraSessionState` exposes the raw reactive values (`payloadError`, `lastEndReason`, `activeViolation`), `dismissViolation()` clears the current violation, and `devoraBridge.isPending` reports the preparing window directly.

## License

MIT
