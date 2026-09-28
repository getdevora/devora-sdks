/**
 * Default full-screen and dialog states for the impersonation lifecycle:
 * preparing, a blocked write, and session ended (expired / ended elsewhere /
 * exchange link invalid). Deliberately plain and dependency-free, matching
 * the existing `ImpersonationBlockedScreen` in context.tsx — these render
 * inside an arbitrary host app, which has no knowledge of Devora's own
 * design tokens, so styling is inline and self-contained.
 *
 * @module @devorash/react
 */

import type { CSSProperties } from "react"
import { SDK_END_REASON } from "@devorash/core"
import type { PayloadError, ScopeViolation } from "@devorash/core"

const cardStyle: CSSProperties = {
	fontFamily: "system-ui, sans-serif",
	maxWidth: 420,
	margin: "12vh auto",
	padding: "28px 24px",
	textAlign: "center",
	color: "#0f172a",
}

const cardTitleStyle: CSSProperties = {
	margin: "16px 0 8px",
	fontSize: 16,
	fontWeight: 700,
}

const cardBodyStyle: CSSProperties = {
	margin: 0,
	fontSize: 14,
	lineHeight: 1.5,
	color: "#475569",
}

const linkStyle: CSSProperties = {
	color: "#315ce7",
	textDecoration: "none",
	fontWeight: 600,
}

function isSafeHttpUrl(url: string): boolean {
	try {
		const protocol = new URL(url).protocol
		return protocol === "http:" || protocol === "https:"
	} catch {
		return false
	}
}

function BackToDevoraLink({ devoraAppUrl }: { devoraAppUrl?: string }) {
	if (!devoraAppUrl || !isSafeHttpUrl(devoraAppUrl)) return null
	return (
		<p style={{ ...cardBodyStyle, marginTop: 12 }}>
			<a href={devoraAppUrl} style={linkStyle}>
				Back to Devora
			</a>
		</p>
	)
}

/**
 * Shown while the SDK is exchanging the one-time link with Devora. The
 * target user isn't known yet at this point — the payload only resolves
 * once the exchange completes — so this deliberately doesn't name them.
 */
export function SessionPreparingScreen() {
	return (
		<div role="status" aria-live="polite" style={cardStyle}>
			<div
				aria-hidden
				style={{
					width: 40,
					height: 40,
					margin: "0 auto",
					borderRadius: 8,
					background: "#f1f5f9",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
				}}
			>
				<Spinner />
			</div>
			<h2 style={cardTitleStyle}>Preparing your session</h2>
			<p style={cardBodyStyle}>Devora is verifying your one-time link. This only takes a moment.</p>
		</div>
	)
}

function Spinner() {
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
				strokeWidth="2"
				strokeLinecap="round"
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

export function SessionEndedScreen({
	reason,
	devoraAppUrl,
}: {
	reason: string
	devoraAppUrl?: string
}) {
	const copy = REASON_COPY[reason] ?? {
		title: "Session ended",
		description: "You've been signed out of this impersonation session.",
	}
	return (
		<div role="alert" style={cardStyle}>
			<h2 style={cardTitleStyle}>{copy.title}</h2>
			<p style={cardBodyStyle}>{copy.description}</p>
			<BackToDevoraLink devoraAppUrl={devoraAppUrl} />
		</div>
	)
}

/**
 * Shown when the one-time exchange link failed. The backend can't
 * distinguish "already used" from "expired" from "malformed" — it returns
 * one generic outcome for all three — so this deliberately doesn't invent a
 * specific cause.
 */
export function LinkInvalidScreen({
	error,
	devoraAppUrl,
}: {
	error: PayloadError
	devoraAppUrl?: string
}) {
	return (
		<div role="alert" style={cardStyle}>
			<h2 style={cardTitleStyle}>This link isn't valid</h2>
			<p style={cardBodyStyle}>
				{error.code === "expired"
					? "This link has expired. Devora links are single-use and short-lived."
					: "This link may have expired or already been used — Devora links work once."}{" "}
				Ask for a new one to continue.
			</p>
			<BackToDevoraLink devoraAppUrl={devoraAppUrl} />
		</div>
	)
}

const overlayStyle: CSSProperties = {
	position: "fixed",
	inset: 0,
	background: "rgba(15, 23, 42, 0.4)",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	padding: 16,
	zIndex: 10000,
	fontFamily: "system-ui, sans-serif",
}

const dialogStyle: CSSProperties = {
	background: "#ffffff",
	color: "#0f172a",
	borderRadius: 12,
	padding: 20,
	maxWidth: 440,
	width: "100%",
	boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)",
}

const outlineButtonStyle: CSSProperties = {
	padding: "8px 14px",
	borderRadius: 6,
	border: "1px solid #cbd5e1",
	background: "#ffffff",
	color: "#0f172a",
	fontSize: 13,
	fontWeight: 600,
	cursor: "pointer",
}

const primaryButtonStyle: CSSProperties = {
	...outlineButtonStyle,
	border: "1px solid #315ce7",
	background: "#315ce7",
	color: "#ffffff",
}

/**
 * Shown when session permissions or workspace endpoint rules block a request. Reports
 * the real method + URL from the violation the SDK's fetch/XHR patch
 * observed — this explains a block the *backend* enforces; the SDK only
 * surfaces it (frontend enforcement is advisory, matching the guard docs).
 */
export function BlockedActionDialog({
	violation,
	onDismiss,
}: {
	violation: ScopeViolation
	onDismiss: () => void
}) {
	const path = safePath(violation.url)
	const details = `${violation.method} ${path}`
	return (
		<div style={overlayStyle} role="presentation" onClick={onDismiss}>
			<div
				style={dialogStyle}
				role="alertdialog"
				aria-modal="true"
				aria-labelledby="devora-blocked-title"
				onClick={(e) => e.stopPropagation()}
			>
				<div style={{ display: "flex", gap: 12 }}>
					<BanIcon />
					<div style={{ minWidth: 0, flex: 1 }}>
						<h2
							id="devora-blocked-title"
							style={{ margin: "2px 0 8px", fontSize: 15, fontWeight: 700 }}
						>
							This action is not allowed in this session
						</h2>
						<p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "#475569" }}>
							<code style={{ fontFamily: "ui-monospace, monospace" }}>{details}</code> is blocked by
							your session permissions or workspace endpoint rules. Ask an administrator to review
							the required access and endpoint policy.
						</p>
					</div>
				</div>
				<div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
					<button
						type="button"
						style={outlineButtonStyle}
						onClick={() => {
							navigator.clipboard?.writeText(details).catch(() => {})
						}}
					>
						Copy details
					</button>
					<button type="button" style={primaryButtonStyle} onClick={onDismiss} autoFocus>
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

function BanIcon() {
	return (
		<svg
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			style={{ flexShrink: 0, marginTop: 2 }}
		>
			<circle cx="12" cy="12" r="9" stroke="#dc2626" strokeWidth="2" />
			<line x1="6.5" y1="17.5" x2="17.5" y2="6.5" stroke="#dc2626" strokeWidth="2" />
		</svg>
	)
}
