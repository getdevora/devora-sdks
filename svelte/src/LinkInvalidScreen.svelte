<script lang="ts">
	import { devoraSessionState } from "../dist/index.js"
	import {
		overlayStyle,
		cardStyle,
		cardTitleStyle,
		cardBodyStyle,
		linkStyle,
		isSafeHttpUrl,
	} from "../dist/session-screens.js"

	/** Shown as a "Back to Devora" link. Omit it and the link doesn't show. */
	export let devoraAppUrl: string | undefined = undefined

	$: error = $devoraSessionState.payloadError
	$: safeDevoraAppUrl = devoraAppUrl && isSafeHttpUrl(devoraAppUrl) ? devoraAppUrl : undefined
</script>

{#if error}
	<div style={overlayStyle}>
		<div role="alert" style={cardStyle}>
			<h2 style={cardTitleStyle}>This link isn't valid</h2>
			<p style={cardBodyStyle}>
				{error.code === "expired"
					? "This link has expired. Devora links are single-use and short-lived."
					: "This link may have expired or already been used — Devora links work once."}
				Ask for a new one to continue.
			</p>
			{#if safeDevoraAppUrl}
				<p style="{cardBodyStyle}margin-top:12px;">
					<a href={safeDevoraAppUrl} style={linkStyle}>Back to Devora</a>
				</p>
			{/if}
		</div>
	</div>
{/if}
