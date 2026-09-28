<script lang="ts">
	import { devoraSessionState, devoraImpersonation, isExplainableEndReason } from "../dist/index.js"
	import {
		getSessionEndedCopy,
		overlayStyle,
		cardStyle,
		cardTitleStyle,
		cardBodyStyle,
		linkStyle,
		isSafeHttpUrl,
	} from "../dist/session-screens.js"

	/** Shown as a "Back to Devora" link. Omit it and the link doesn't show. */
	export let devoraAppUrl: string | undefined = undefined

	$: isImpersonating = $devoraImpersonation.isImpersonating
	$: lastEndReason = $devoraSessionState.lastEndReason
	$: shouldShow = !isImpersonating && !!lastEndReason && isExplainableEndReason(lastEndReason)
	$: copy = lastEndReason ? getSessionEndedCopy(lastEndReason) : null
	$: safeDevoraAppUrl = devoraAppUrl && isSafeHttpUrl(devoraAppUrl) ? devoraAppUrl : undefined
</script>

{#if shouldShow && copy}
	<div style={overlayStyle}>
		<div role="alert" style={cardStyle}>
			<h2 style={cardTitleStyle}>{copy.title}</h2>
			<p style={cardBodyStyle}>{copy.description}</p>
			{#if safeDevoraAppUrl}
				<p style="{cardBodyStyle}margin-top:12px;">
					<a href={safeDevoraAppUrl} style={linkStyle}>Back to Devora</a>
				</p>
			{/if}
		</div>
	</div>
{/if}
