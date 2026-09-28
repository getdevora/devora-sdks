/**
 * Default full-screen and dialog states for the impersonation lifecycle:
 * preparing, a blocked write, and session ended (expired / ended elsewhere /
 * exchange link invalid). Deliberately plain and dependency-free — these
 * render inside an arbitrary host app, which has no knowledge of Devora's
 * own design tokens, so styling is inline and self-contained.
 *
 * @module @devorash/solid
 */

import { Show, type JSX } from "solid-js"
import { SDK_END_REASON } from "@devorash/core"
import type { PayloadError, ScopeViolation } from "@devorash/browser"

const cardStyle = {
	"font-family": "system-ui, sans-serif",
	"max-width": "420px",
	margin: "12vh auto",
	padding: "28px 24px",
	"text-align": "center",
	color: "#0f172a",
} as const

const cardTitleStyle = {
	margin: "16px 0 8px",
	"font-size": "16px",
	"font-weight": "700",
} as const

const cardBodyStyle = {
	margin: "0",
	"font-size": "14px",
	"line-height": "1.5",
	color: "#475569",
} as const

const linkStyle = {
	color: "#315ce7",
	"text-decoration": "none",
	"font-weight": "600",
} as const

function isSafeHttpUrl(url: string): boolean {
	try {
		const protocol = new URL(url).protocol
		return protocol === "http:" || protocol === "https:"
	} catch {
		return false
	}
}

function BackToDevoraLink(props: { devoraAppUrl?: string }): JSX.Element {
	return (
		<Show when={props.devoraAppUrl && isSafeHttpUrl(props.devoraAppUrl)}>
			<p style={{ ...cardBodyStyle, "margin-top": "12px" }}>
				<a href={props.devoraAppUrl} style={linkStyle}>
					Back to Devora
				</a>
			</p>
		</Show>
	)
}

/**
 * Shown while the SDK is exchanging the one-time link with Devora. The
 * target user isn't known yet at this point — the payload only resolves
 * once the exchange completes — so this deliberately doesn't name them.
 */
export function SessionPreparingScreen(): JSX.Element {
	return (
		<div role="status" aria-live="polite" style={cardStyle}>
			<div
				aria-hidden="true"
				style={{
					width: "40px",
					height: "40px",
					margin: "0 auto",
					"border-radius": "8px",
					background: "#f1f5f9",
					display: "flex",
					"align-items": "center",
					"justify-content": "center",
				}}
			>
				<Spinner />
			</div>
			<h2 style={cardTitleStyle}>Preparing your session</h2>
			<p style={cardBodyStyle}>Devora is verifying your one-time link. This only takes a moment.</p>
		</div>
	)
}

function Spinner(): JSX.Element {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			style={{ animation: "devora-spin 0.8s linear infinite" }}
		>
			<style>{"@keyframes devora-spin { to { transform: rotate(360deg) } }"}</style>
			<path
				d="M12 3a9 9 0 1 0 9 9"
				stroke="#64748b"
				stroke-width="2"
				stroke-linecap="round"
				fill="none"
			/>
		</svg>
	)
}

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

export function SessionEndedScreen(props: { reason: string; devoraAppUrl?: string }): JSX.Element {
	const copy = () =>
		REASON_COPY[props.reason] ?? {
			title: "Session ended",
			description: "You've been signed out of this impersonation session.",
		}
	return (
		<div role="alert" style={cardStyle}>
			<h2 style={cardTitleStyle}>{copy().title}</h2>
			<p style={cardBodyStyle}>{copy().description}</p>
			<BackToDevoraLink devoraAppUrl={props.devoraAppUrl} />
		</div>
	)
}

/**
 * Shown when the one-time exchange link failed. The backend can't
 * distinguish "already used" from "expired" from "malformed" — it returns
 * one generic outcome for all three — so this deliberately doesn't invent a
 * specific cause.
 */
export function LinkInvalidScreen(props: {
	error: PayloadError
	devoraAppUrl?: string
}): JSX.Element {
	return (
		<div role="alert" style={cardStyle}>
			<h2 style={cardTitleStyle}>This link isn't valid</h2>
			<p style={cardBodyStyle}>
				{props.error.code === "expired"
					? "This link has expired. Devora links are single-use and short-lived."
					: "This link may have expired or already been used — Devora links work once."}{" "}
				Ask for a new one to continue.
			</p>
			<BackToDevoraLink devoraAppUrl={props.devoraAppUrl} />
		</div>
	)
}

const overlayStyle = {
	position: "fixed",
	inset: "0",
	background: "rgba(15, 23, 42, 0.4)",
	display: "flex",
	"align-items": "center",
	"justify-content": "center",
	padding: "16px",
	"z-index": "10000",
	"font-family": "system-ui, sans-serif",
} as const

const dialogStyle = {
	background: "#ffffff",
	color: "#0f172a",
	"border-radius": "12px",
	padding: "20px",
	"max-width": "440px",
	width: "100%",
	"box-shadow": "0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)",
} as const

const outlineButtonStyle = {
	padding: "8px 14px",
	"border-radius": "6px",
	border: "1px solid #cbd5e1",
	background: "#ffffff",
	color: "#0f172a",
	"font-size": "13px",
	"font-weight": "600",
	cursor: "pointer",
} as const

const primaryButtonStyle = {
	...outlineButtonStyle,
	border: "1px solid #315ce7",
	background: "#315ce7",
	color: "#ffffff",
} as const

/**
 * Shown when session permissions or workspace endpoint rules block a request. Reports
 * the real method + URL from the violation the SDK's fetch/XHR patch
 * observed — this explains a block the *backend* enforces; the SDK only
 * surfaces it (frontend enforcement is advisory, matching the guard docs).
 */
export function BlockedActionDialog(props: {
	violation: ScopeViolation
	onDismiss: () => void
}): JSX.Element {
	const details = () => `${props.violation.method} ${safePath(props.violation.url)}`
	return (
		<div style={overlayStyle} role="presentation" onClick={props.onDismiss}>
			<div
				style={dialogStyle}
				role="alertdialog"
				aria-modal="true"
				aria-labelledby="devora-blocked-title"
				onClick={(e) => e.stopPropagation()}
			>
				<div style={{ display: "flex", gap: "12px" }}>
					<BanIcon />
					<div style={{ "min-width": "0", flex: "1" }}>
						<h2
							id="devora-blocked-title"
							style={{ margin: "2px 0 8px", "font-size": "15px", "font-weight": "700" }}
						>
							This action is not allowed in this session
						</h2>
						<p style={{ margin: "0", "font-size": "13px", "line-height": "1.5", color: "#475569" }}>
							<code style={{ "font-family": "ui-monospace, monospace" }}>{details()}</code> is
							blocked by your session permissions or workspace endpoint rules. Ask an administrator
							to review the required access and endpoint policy.
						</p>
					</div>
				</div>
				<div
					style={{
						display: "flex",
						"justify-content": "flex-end",
						gap: "8px",
						"margin-top": "16px",
					}}
				>
					<button
						type="button"
						style={outlineButtonStyle}
						onClick={() => {
							navigator.clipboard?.writeText(details()).catch(() => {})
						}}
					>
						Copy details
					</button>
					<button type="button" style={primaryButtonStyle} onClick={props.onDismiss} autofocus>
						OK
					</button>
				</div>
			</div>
		</div>
	)
}

function safePath(url: string): string {
	try {
		return new URL(url, "http://placeholder.local").pathname
	} catch {
		return url
	}
}

function BanIcon(): JSX.Element {
	return (
		<svg
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			style={{ "flex-shrink": "0", "margin-top": "2px" }}
		>
			<circle cx="12" cy="12" r="9" stroke="#dc2626" stroke-width="2" />
			<line x1="6.5" y1="17.5" x2="17.5" y2="6.5" stroke="#dc2626" stroke-width="2" />
		</svg>
	)
}
