/**
 * Shared helpers and style strings for the default session-lifecycle
 * components (`SessionPreparingScreen.svelte`, `SessionEndedScreen.svelte`,
 * `LinkInvalidScreen.svelte`, `BlockedActionDialog.svelte`). Svelte
 * components must be `.svelte` files, so those are the public surface for
 * rendering — this plain module only backs them (and exports
 * `isExplainableEndReason` for a custom UI built on `devoraSessionState`).
 *
 * @module @devorash/svelte
 */

import { SDK_END_REASON } from "@devorash/core"

export const overlayStyle =
	"position:fixed;inset:0;background:#ffffff;display:flex;align-items:center;justify-content:center;padding:16px;z-index:9998;font-family:system-ui,sans-serif;"

export const cardStyle = "max-width:420px;width:100%;text-align:center;color:#0f172a;"

export const cardTitleStyle = "margin:16px 0 8px;font-size:16px;font-weight:700;"

export const cardBodyStyle = "margin:0;font-size:14px;line-height:1.5;color:#475569;"

export const linkStyle = "color:#315ce7;text-decoration:none;font-weight:600;"

export const dialogOverlayStyle =
	"position:fixed;inset:0;background:rgba(15,23,42,0.4);display:flex;align-items:center;justify-content:center;padding:16px;z-index:10000;font-family:system-ui,sans-serif;"

export const dialogStyle =
	"background:#ffffff;color:#0f172a;border-radius:12px;padding:20px;max-width:440px;width:100%;box-shadow:0 20px 25px -5px rgba(0,0,0,0.1),0 8px 10px -6px rgba(0,0,0,0.1);"

export const outlineButtonStyle =
	"padding:8px 14px;border-radius:6px;border:1px solid #cbd5e1;background:#ffffff;color:#0f172a;font-size:13px;font-weight:600;cursor:pointer;"

export const primaryButtonStyle =
	"padding:8px 14px;border-radius:6px;border:1px solid #315ce7;background:#315ce7;color:#ffffff;font-size:13px;font-weight:600;cursor:pointer;"

const REASON_COPY: Partial<Record<string, { title: string; description: string }>> = {
	[SDK_END_REASON.EXPIRED]: {
		title: "Session ended",
		description: "The time limit for this session was reached. You've been signed out.",
	},
	[SDK_END_REASON.TERMINATED_EXTERNALLY]: {
		title: "Session ended",
		description: "Access to this session was ended from Devora. You've been signed out.",
	},
}

/**
 * Whether `reason` warrants taking over the screen with an explanation.
 * `user_ended` is a deliberate action the agent just took — they don't need
 * it explained back to them — so this returns false for it (and for any
 * other reason this default doesn't have copy for).
 */
export function isExplainableEndReason(reason: string): boolean {
	return reason in REASON_COPY
}

export function getSessionEndedCopy(reason: string): { title: string; description: string } {
	return (
		REASON_COPY[reason] ?? {
			title: "Session ended",
			description: "You've been signed out of this impersonation session.",
		}
	)
}

export function isSafeHttpUrl(url: string): boolean {
	try {
		const protocol = new URL(url).protocol
		return protocol === "http:" || protocol === "https:"
	} catch {
		return false
	}
}

export function safePath(url: string): string {
	try {
		return new URL(url, "http://placeholder.local").pathname
	} catch {
		return url
	}
}
