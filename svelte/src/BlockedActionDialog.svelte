<script lang="ts">
	import { devoraSessionState, devoraImpersonation, dismissViolation } from "../dist/index.js"
	import {
		dialogOverlayStyle,
		dialogStyle,
		outlineButtonStyle,
		primaryButtonStyle,
		safePath,
	} from "../dist/session-screens.js"

	$: isImpersonating = $devoraImpersonation.isImpersonating
	$: violation = $devoraSessionState.activeViolation
	$: details = violation ? `${violation.method} ${safePath(violation.url)}` : ""

	function copyDetails() {
		navigator.clipboard?.writeText(details).catch(() => {})
	}
</script>

{#if isImpersonating && violation}
	<div style={dialogOverlayStyle} role="presentation" on:click={dismissViolation}>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			style={dialogStyle}
			role="alertdialog"
			tabindex="-1"
			aria-modal="true"
			aria-labelledby="devora-blocked-title"
			on:click|stopPropagation
		>
			<div style="display:flex;gap:12px;">
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" style="flex-shrink:0;margin-top:2px;">
					<circle cx="12" cy="12" r="9" stroke="#dc2626" stroke-width="2" />
					<line x1="6.5" y1="17.5" x2="17.5" y2="6.5" stroke="#dc2626" stroke-width="2" />
				</svg>
				<div style="min-width:0;flex:1;">
					<h2 id="devora-blocked-title" style="margin:2px 0 8px;font-size:15px;font-weight:700;">
						This action is not allowed in this session
					</h2>
					<p style="margin:0;font-size:13px;line-height:1.5;color:#475569;">
						<code style="font-family:ui-monospace,monospace;">{details}</code> is blocked by your session permissions or workspace endpoint rules.
						Ask an administrator to review the required access and endpoint policy.
					</p>
				</div>
			</div>
			<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
				<button type="button" style={outlineButtonStyle} on:click={copyDetails}>Copy details</button>
				<!-- svelte-ignore a11y_autofocus -->
				<button type="button" style={primaryButtonStyle} on:click={dismissViolation} autofocus>OK</button>
			</div>
		</div>
	</div>
{/if}
