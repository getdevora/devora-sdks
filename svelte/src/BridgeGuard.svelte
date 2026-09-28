<script lang="ts">
	import { devoraBridge } from "../dist/index.js"

	$: isBlocked = $devoraBridge.isBlocked
	$: isPending = $devoraBridge.isPending
</script>

{#if isPending}
	<slot name="pending" />
{:else if isBlocked}
	<slot name="fallback" />
{:else}
	<slot />
{/if}
