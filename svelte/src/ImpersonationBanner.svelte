<script lang="ts">
	import { createLogger } from "@devorash/core"
	import { devoraImpersonation, endDevoraSession } from "../dist/index.js"

	const logger = createLogger("Devora Svelte")
	const BRAND_BLUE = "#315ce7"

	export let className: string | undefined = undefined
	export let showEndButton = true
	export let endButtonText = "End session"
	export let message: string | ((scope: "read" | "write" | null) => string) | undefined =
		undefined

	let isMinimized = false
	let showDetails = false

	/** "42:18" (or "1:02:03" past an hour) — a countdown clock, not a word duration. */
	function formatCountdownClock(ms: number | null): string {
		if (ms === null || ms <= 0) return "0:00"
		const totalSeconds = Math.round(ms / 1000)
		const hours = Math.floor(totalSeconds / 3600)
		const minutes = Math.floor((totalSeconds % 3600) / 60)
		const seconds = totalSeconds % 60
		const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes)
		const ss = String(seconds).padStart(2, "0")
		return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
	}

	$: isImpersonating = $devoraImpersonation.isImpersonating
	$: scope = $devoraImpersonation.scope
	$: targetUser = $devoraImpersonation.targetUser
	$: impersonator = $devoraImpersonation.impersonator
	$: userId = $devoraImpersonation.userId
	$: remainingMs = $devoraImpersonation.remainingMs

	$: userDisplay = targetUser?.name || targetUser?.email || targetUser?.id || userId
	$: bannerMessage =
		typeof message === "function"
			? message(scope)
			: (message ?? (userDisplay ? `Viewing as ${userDisplay}` : "Impersonation active"))
	$: scopeLabel = scope === "write" ? "Read & write" : "Read-only"

	async function handleEndSession() {
		try {
			await endDevoraSession()
		} catch (err) {
			logger.error("Failed to end session:", err)
		}
	}
</script>

{#if isImpersonating}
	{#if $$slots.default}
		<slot
			{isImpersonating}
			{scope}
			{userId}
			{targetUser}
			{impersonator}
			{remainingMs}
			endSession={endDevoraSession}
		/>
	{:else if isMinimized}
		<button
			type="button"
			on:click={() => (isMinimized = false)}
			aria-label={`Impersonating ${userDisplay ?? "customer"} — expand`}
			style="position:fixed;top:10px;right:10px;z-index:9999;display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;background-color:{BRAND_BLUE};color:#ffffff;font-family:system-ui,sans-serif;font-size:12px;font-weight:600;border:none;cursor:pointer;"
		>
			<span aria-hidden="true" style="width:6px;height:6px;border-radius:50%;background:#fff;"></span>
			{formatCountdownClock(remainingMs)}
		</button>
	{:else}
		<div
			class={className}
			role="alert"
			aria-live="polite"
			style="position:fixed;top:0;left:0;right:0;padding:10px 16px;background-color:{BRAND_BLUE};color:#ffffff;display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:14px;font-family:system-ui,sans-serif;z-index:9999;"
		>
			<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
				<strong>{bannerMessage}</strong>
				{#if scope !== null}
					<span style="margin-left:10px;opacity:0.85;font-weight:400;">
						{scopeLabel}
						{#if remainingMs !== null && remainingMs > 0}
							&nbsp;· {formatCountdownClock(remainingMs)} left
						{/if}
					</span>
				{/if}
			</span>
			<span style="display:flex;gap:8px;flex-shrink:0;">
				<button
					type="button"
					on:click={() => (showDetails = !showDetails)}
					style="padding:5px 12px;background-color:transparent;color:#ffffff;border:1px solid rgba(255,255,255,0.6);border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;"
				>
					Details
				</button>
				{#if showEndButton}
					<button
						type="button"
						on:click={handleEndSession}
						style="padding:5px 12px;background-color:#ffffff;color:{BRAND_BLUE};border:1px solid #ffffff;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;"
					>
						{endButtonText}
					</button>
				{/if}
				<button
					type="button"
					on:click={() => (isMinimized = true)}
					aria-label="Minimize"
					title="Minimize"
					style="padding:5px 8px;background-color:transparent;color:#ffffff;border:1px solid transparent;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;"
				>
					⌄
				</button>
			</span>
			{#if showDetails}
				<div
					style="position:absolute;top:100%;right:16px;margin-top:4px;background:#ffffff;color:#0f172a;border-radius:8px;padding:10px 14px;min-width:220px;font-size:13px;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1);"
				>
					{#if targetUser?.name ?? targetUser?.email ?? userDisplay}
						<div style="display:flex;justify-content:space-between;gap:16px;padding:4px 0;">
							<span style="opacity:0.7;">Viewing</span>
							<span style="font-weight:600;">{targetUser?.name ?? targetUser?.email ?? userDisplay}</span>
						</div>
					{/if}
					<div style="display:flex;justify-content:space-between;gap:16px;padding:4px 0;">
						<span style="opacity:0.7;">Access</span>
						<span style="font-weight:600;">{scopeLabel}</span>
					</div>
					{#if impersonator?.name ?? impersonator?.email}
						<div style="display:flex;justify-content:space-between;gap:16px;padding:4px 0;">
							<span style="opacity:0.7;">Agent</span>
							<span style="font-weight:600;">{impersonator?.name ?? impersonator?.email}</span>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
{/if}
