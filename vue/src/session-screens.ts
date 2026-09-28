/**
 * Default full-screen and dialog components for the impersonation lifecycle:
 * preparing, a blocked write, and session ended (expired / ended elsewhere /
 * exchange link invalid). Unlike @devorash/react and @devorash/solid, Vue has
 * no provider component to render these automatically — place whichever ones
 * you want anywhere in your own template (typically once near your app
 * root) and they show or hide themselves based on the SDK's state. Each is a
 * fixed, full-viewport overlay so it reads correctly no matter what else is
 * in your template at the time.
 *
 * @module @devorash/vue
 */

import { defineComponent, h, type PropType, type CSSProperties } from "vue"
import { SDK_END_REASON } from "@devorash/core"
import type { PayloadError, ScopeViolation } from "@devorash/browser"
import { useDevoraBridge, useDevoraImpersonation, useDevoraSessionState } from "./index.js"

const overlayStyle: CSSProperties = {
	position: "fixed",
	inset: "0",
	background: "#ffffff",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	padding: "16px",
	zIndex: "9998",
	fontFamily: "system-ui, sans-serif",
}

const cardStyle: CSSProperties = {
	maxWidth: "420px",
	width: "100%",
	textAlign: "center",
	color: "#0f172a",
}

const cardTitleStyle: CSSProperties = {
	margin: "16px 0 8px",
	fontSize: "16px",
	fontWeight: "700",
}

const cardBodyStyle: CSSProperties = {
	margin: "0",
	fontSize: "14px",
	lineHeight: "1.5",
	color: "#475569",
}

const linkStyle: CSSProperties = {
	color: "#315ce7",
	textDecoration: "none",
	fontWeight: "600",
}

const devoraAppUrlProp = { type: String as PropType<string>, default: undefined }

function isSafeHttpUrl(url: string): boolean {
	try {
		const protocol = new URL(url).protocol
		return protocol === "http:" || protocol === "https:"
	} catch {
		return false
	}
}

function backToDevoraLink(devoraAppUrl: string | undefined) {
	if (!devoraAppUrl || !isSafeHttpUrl(devoraAppUrl)) return null
	return h(
		"p",
		{ style: { ...cardBodyStyle, marginTop: "12px" } },
		h("a", { href: devoraAppUrl, style: linkStyle }, "Back to Devora")
	)
}

function spinner() {
	return h(
		"svg",
		{
			width: "18",
			height: "18",
			viewBox: "0 0 24 24",
			fill: "none",
			style: { animation: "devora-spin 0.8s linear infinite" },
		},
		[
			h("style", "@keyframes devora-spin { to { transform: rotate(360deg) } }"),
			h("path", {
				d: "M12 3a9 9 0 1 0 9 9",
				stroke: "#64748b",
				"stroke-width": "2",
				"stroke-linecap": "round",
				fill: "none",
			}),
		]
	)
}

/**
 * Shown while the SDK is exchanging the one-time link with Devora, or while
 * a configured `sessionBridge` hasn't resolved yet. The target user isn't
 * known at this point — the payload only resolves once the exchange
 * completes — so this deliberately doesn't name them.
 */
export const SessionPreparingScreen = defineComponent({
	name: "SessionPreparingScreen",
	setup() {
		const { isPending } = useDevoraBridge()
		return () => {
			if (!isPending.value) return null
			return h("div", { style: overlayStyle }, [
				h("div", { role: "status", "aria-live": "polite", style: cardStyle }, [
					h(
						"div",
						{
							"aria-hidden": "true",
							style: {
								width: "40px",
								height: "40px",
								margin: "0 auto",
								borderRadius: "8px",
								background: "#f1f5f9",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
							},
						},
						[spinner()]
					),
					h("h2", { style: cardTitleStyle }, "Preparing your session"),
					h(
						"p",
						{ style: cardBodyStyle },
						"Devora is verifying your one-time link. This only takes a moment."
					),
				]),
			])
		}
	},
})

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

export const SessionEndedScreen = defineComponent({
	name: "SessionEndedScreen",
	props: { devoraAppUrl: devoraAppUrlProp },
	setup(props) {
		const { lastEndReason } = useDevoraSessionState()
		const { isImpersonating } = useDevoraImpersonation()
		return () => {
			const reason = lastEndReason.value
			if (isImpersonating.value || !reason || !isExplainableEndReason(reason)) return null
			const copy = REASON_COPY[reason] ?? {
				title: "Session ended",
				description: "You've been signed out of this impersonation session.",
			}
			return h("div", { style: overlayStyle }, [
				h("div", { role: "alert", style: cardStyle }, [
					h("h2", { style: cardTitleStyle }, copy.title),
					h("p", { style: cardBodyStyle }, copy.description),
					backToDevoraLink(props.devoraAppUrl),
				]),
			])
		}
	},
})

/**
 * Shown when the one-time exchange link failed. The backend can't
 * distinguish "already used" from "expired" from "malformed" — it returns
 * one generic outcome for all three — so this deliberately doesn't invent a
 * specific cause.
 */
export const LinkInvalidScreen = defineComponent({
	name: "LinkInvalidScreen",
	props: { devoraAppUrl: devoraAppUrlProp },
	setup(props) {
		const { payloadError } = useDevoraSessionState()
		return () => {
			const error = payloadError.value as PayloadError | null
			if (!error) return null
			return h("div", { style: overlayStyle }, [
				h("div", { role: "alert", style: cardStyle }, [
					h("h2", { style: cardTitleStyle }, "This link isn't valid"),
					h("p", { style: cardBodyStyle }, [
						error.code === "expired"
							? "This link has expired. Devora links are single-use and short-lived."
							: "This link may have expired or already been used — Devora links work once.",
						" Ask for a new one to continue.",
					]),
					backToDevoraLink(props.devoraAppUrl),
				]),
			])
		}
	},
})

const dialogOverlayStyle: CSSProperties = {
	position: "fixed",
	inset: "0",
	background: "rgba(15, 23, 42, 0.4)",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	padding: "16px",
	zIndex: "10000",
	fontFamily: "system-ui, sans-serif",
}

const dialogStyle: CSSProperties = {
	background: "#ffffff",
	color: "#0f172a",
	borderRadius: "12px",
	padding: "20px",
	maxWidth: "440px",
	width: "100%",
	boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)",
}

const outlineButtonStyle: CSSProperties = {
	padding: "8px 14px",
	borderRadius: "6px",
	border: "1px solid #cbd5e1",
	background: "#ffffff",
	color: "#0f172a",
	fontSize: "13px",
	fontWeight: "600",
	cursor: "pointer",
}

const primaryButtonStyle: CSSProperties = {
	...outlineButtonStyle,
	border: "1px solid #315ce7",
	background: "#315ce7",
	color: "#ffffff",
}

function safePath(url: string): string {
	try {
		return new URL(url, "http://placeholder.local").pathname
	} catch {
		return url
	}
}

function banIcon() {
	return h(
		"svg",
		{
			width: "20",
			height: "20",
			viewBox: "0 0 24 24",
			fill: "none",
			style: { flexShrink: "0", marginTop: "2px" },
		},
		[
			h("circle", { cx: "12", cy: "12", r: "9", stroke: "#dc2626", "stroke-width": "2" }),
			h("line", {
				x1: "6.5",
				y1: "17.5",
				x2: "17.5",
				y2: "6.5",
				stroke: "#dc2626",
				"stroke-width": "2",
			}),
		]
	)
}

/**
 * Shown when session permissions or workspace endpoint rules block a request. Reports
 * the real method + URL from the violation the SDK's fetch/XHR patch
 * observed — this explains a block the *backend* enforces; the SDK only
 * surfaces it (frontend enforcement is advisory, matching the guard docs).
 */
export const BlockedActionDialog = defineComponent({
	name: "BlockedActionDialog",
	setup() {
		const { activeViolation, dismissViolation } = useDevoraSessionState()
		const { isImpersonating } = useDevoraImpersonation()
		return () => {
			const violation = activeViolation.value as ScopeViolation | null
			if (!isImpersonating.value || !violation) return null
			const details = `${violation.method} ${safePath(violation.url)}`
			return h(
				"div",
				{ style: dialogOverlayStyle, role: "presentation", onClick: dismissViolation },
				h(
					"div",
					{
						style: dialogStyle,
						role: "alertdialog",
						"aria-modal": "true",
						"aria-labelledby": "devora-blocked-title",
						onClick: (e: Event) => e.stopPropagation(),
					},
					[
						h("div", { style: { display: "flex", gap: "12px" } }, [
							banIcon(),
							h("div", { style: { minWidth: "0", flex: "1" } }, [
								h(
									"h2",
									{
										id: "devora-blocked-title",
										style: { margin: "2px 0 8px", fontSize: "15px", fontWeight: "700" },
									},
									"This action is not allowed in this session"
								),
								h(
									"p",
									{ style: { margin: "0", fontSize: "13px", lineHeight: "1.5", color: "#475569" } },
									[
										h("code", { style: { fontFamily: "ui-monospace, monospace" } }, details),
										" is blocked by your session permissions or workspace endpoint rules. Ask an administrator to review the required access and endpoint policy.",
									]
								),
							]),
						]),
						h(
							"div",
							{
								style: {
									display: "flex",
									justifyContent: "flex-end",
									gap: "8px",
									marginTop: "16px",
								},
							},
							[
								h(
									"button",
									{
										type: "button",
										style: outlineButtonStyle,
										onClick: () => {
											navigator.clipboard?.writeText(details).catch(() => {})
										},
									},
									"Copy details"
								),
								h(
									"button",
									{
										type: "button",
										style: primaryButtonStyle,
										onClick: dismissViolation,
										autofocus: true,
									},
									"OK"
								),
							]
						),
					]
				)
			)
		}
	},
})
