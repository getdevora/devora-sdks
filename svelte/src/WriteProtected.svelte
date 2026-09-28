<script lang="ts">
	import { createEventDispatcher } from "svelte"
	import { devoraScope } from "../dist/index.js"

	export let blockedMessage = "This action is not available in read-only mode"

	const dispatch = createEventDispatcher<{ blocked: string }>()

	$: isReadOnly = $devoraScope.isReadOnly

	function handleBlocked(event: Event) {
		event.preventDefault()
		event.stopPropagation()
		dispatch("blocked", blockedMessage)
	}
</script>

{#if !isReadOnly}
	<slot />
{:else}
	<div
		role="button"
		tabindex="0"
		style="position:relative;"
		on:click|capture={handleBlocked}
		on:keydown|capture={(event) =>
			(event.key === "Enter" || event.key === " ") && handleBlocked(event)}
	>
		<div style="opacity:0.5;pointer-events:none;">
			<slot />
		</div>
	</div>
{/if}
