<script lang="ts">
	import { devoraScope } from "../dist/index.js"

	/** Render nothing instead of a disabled wrapper while read-only. */
	export let hide = false

	$: isReadOnly = $devoraScope.isReadOnly
</script>

{#if !isReadOnly}
	<slot />
{:else if hide}
	<!-- hidden while read-only -->
{:else if $$slots.fallback}
	<slot name="fallback" />
{:else}
	<div aria-disabled="true" style="opacity:0.5;pointer-events:none;cursor:not-allowed;">
		<slot />
	</div>
{/if}
