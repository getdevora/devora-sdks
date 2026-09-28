<script lang="ts">
	import { devoraBridge } from "../dist/index.js"
	import { overlayStyle, cardStyle, cardTitleStyle, cardBodyStyle } from "../dist/session-screens.js"

	$: isPending = $devoraBridge.isPending
</script>

{#if isPending}
	<div style={overlayStyle}>
		<div role="status" aria-live="polite" style={cardStyle}>
			<div
				aria-hidden="true"
				style="width:40px;height:40px;margin:0 auto;border-radius:8px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;"
			>
				<svg class="devora-spinner" width="18" height="18" viewBox="0 0 24 24" fill="none">
					<path
						d="M12 3a9 9 0 1 0 9 9"
						stroke="#64748b"
						stroke-width="2"
						stroke-linecap="round"
						fill="none"
					/>
				</svg>
			</div>
			<h2 style={cardTitleStyle}>Preparing your session</h2>
			<p style={cardBodyStyle}>Devora is verifying your one-time link. This only takes a moment.</p>
		</div>
	</div>
{/if}

<style>
	.devora-spinner {
		animation: devora-spin 0.8s linear infinite;
	}
	@keyframes devora-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
