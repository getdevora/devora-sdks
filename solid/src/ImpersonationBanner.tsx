/**
 * Impersonation banner for Solid.js
 * @module @devorash/solid
 */

import { createSignal, Show, type Accessor, type JSX } from "solid-js"
import { createLogger } from "@devorash/core"
import { useDevoraImpersonation } from "./index.js"

const logger = createLogger("Devora Solid")

export interface ImpersonationBannerProps {
	class?: string
	className?: string
	showEndButton?: boolean
	endButtonText?: string
	message?: string | ((scope: "read" | "write" | null) => string)
	children?: (props: {
		isImpersonating: boolean
		scope: "read" | "write" | null
		userId: string | null
		targetUser: { id: string; email?: string; name?: string } | null
		impersonator: { id: string; email?: string; name?: string } | null
		remainingMs: Accessor<number | null>
		endSession: () => Promise<void>
	}) => JSX.Element
}

const BRAND_BLUE = "#315ce7"

const defaultBannerStyle = {
	position: "fixed",
	top: "0",
	left: "0",
	right: "0",
	padding: "10px 16px",
	"background-color": BRAND_BLUE,
	color: "#ffffff",
	display: "flex",
	"align-items": "center",
	"justify-content": "space-between",
	gap: "12px",
	"font-size": "14px",
	"font-family": "system-ui, sans-serif",
	"z-index": "9999",
} as const

const outlineButtonStyle = {
	padding: "5px 12px",
	"background-color": "transparent",
	color: "#ffffff",
	border: "1px solid rgba(255,255,255,0.6)",
	"border-radius": "6px",
	cursor: "pointer",
	"font-size": "13px",
	"font-weight": "600",
} as const

const solidButtonStyle = {
	padding: "5px 12px",
	"background-color": "#ffffff",
	color: BRAND_BLUE,
	border: "1px solid #ffffff",
	"border-radius": "6px",
	cursor: "pointer",
	"font-size": "13px",
	"font-weight": "600",
} as const

const pillStyle = {
	position: "fixed",
	top: "10px",
	right: "10px",
	"z-index": "9999",
	display: "flex",
	"align-items": "center",
	gap: "6px",
	padding: "6px 10px",
	"border-radius": "999px",
	"background-color": BRAND_BLUE,
	color: "#ffffff",
	"font-family": "system-ui, sans-serif",
	"font-size": "12px",
	"font-weight": "600",
	border: "none",
	cursor: "pointer",
} as const

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

function DetailRow(props: { label: string; value: string | undefined | null }): JSX.Element {
	return (
		<Show when={props.value}>
			<div
				style={{
					display: "flex",
					"justify-content": "space-between",
					gap: "16px",
					padding: "4px 0",
				}}
			>
				<span style={{ opacity: "0.7" }}>{props.label}</span>
				<span style={{ "font-weight": "600" }}>{props.value}</span>
			</div>
		</Show>
	)
}

/**
 * Impersonation banner component. Shows when an impersonation session is
 * active — full bar by default, collapsing to a small pill when the agent
 * minimizes it (it never fully hides while impersonating, so the person
 * whose account is being viewed can't lose track that it's happening).
 */
export function ImpersonationBanner(props: ImpersonationBannerProps): JSX.Element {
	const impersonation = useDevoraImpersonation()
	const [isMinimized, setIsMinimized] = createSignal(false)
	const [showDetails, setShowDetails] = createSignal(false)

	const userDisplay = () => {
		const targetUser = impersonation.targetUser()
		return targetUser?.name || targetUser?.email || targetUser?.id || impersonation.userId()
	}

	const scopeLabel = () => (impersonation.scope() === "write" ? "Read & write" : "Read-only")

	const bannerMessage = () =>
		typeof props.message === "function"
			? props.message(impersonation.scope())
			: (props.message ?? (userDisplay() ? `Viewing as ${userDisplay()}` : "Impersonation active"))

	// Read inside its own function, called fresh from a JSX expression below,
	// rather than hoisted into a variable inside the banner's IIFE: this value
	// ticks every second, and hoisting it into the enclosing <Show>'s tracked
	// scope would make that memo — and the whole subtree it returns — rebuild
	// every second instead of just this text.
	const remainingLabel = () => {
		const ms = impersonation.remainingMs()
		return ms !== null && ms > 0 ? ` · ${formatCountdownClock(ms)} left` : null
	}

	const handleEnd = () =>
		impersonation.endSession().catch((err) => {
			logger.error("Failed to end session:", err)
		})

	return (
		<Show when={impersonation.isImpersonating()}>
			<Show
				when={!props.children}
				fallback={props.children?.({
					isImpersonating: impersonation.isImpersonating(),
					scope: impersonation.scope(),
					userId: impersonation.userId(),
					targetUser: impersonation.targetUser(),
					impersonator: impersonation.impersonator(),
					remainingMs: impersonation.remainingMs,
					endSession: impersonation.endSession,
				})}
			>
				<Show
					when={!isMinimized()}
					fallback={
						<button
							type="button"
							style={pillStyle}
							onClick={() => setIsMinimized(false)}
							aria-label={`Impersonating ${userDisplay() ?? "customer"} — expand`}
						>
							<span
								aria-hidden="true"
								style={{ width: "6px", height: "6px", "border-radius": "50%", background: "#fff" }}
							/>
							{formatCountdownClock(impersonation.remainingMs())}
						</button>
					}
				>
					<div
						class={props.class ?? props.className}
						style={defaultBannerStyle}
						role="alert"
						aria-live="polite"
					>
						<span
							style={{
								"min-width": "0",
								overflow: "hidden",
								"text-overflow": "ellipsis",
								"white-space": "nowrap",
							}}
						>
							<strong>{bannerMessage()}</strong>
							<Show when={impersonation.scope() !== null}>
								<span style={{ "margin-left": "10px", opacity: "0.85", "font-weight": "400" }}>
									{scopeLabel()}
									{remainingLabel()}
								</span>
							</Show>
						</span>
						<span style={{ display: "flex", gap: "8px", "flex-shrink": "0" }}>
							<button
								type="button"
								style={outlineButtonStyle}
								onClick={() => setShowDetails((v) => !v)}
							>
								Details
							</button>
							<Show when={props.showEndButton ?? true}>
								<button type="button" style={solidButtonStyle} onClick={handleEnd}>
									{props.endButtonText ?? "End session"}
								</button>
							</Show>
							<button
								type="button"
								style={{
									...outlineButtonStyle,
									border: "1px solid transparent",
									padding: "5px 8px",
								}}
								onClick={() => setIsMinimized(true)}
								aria-label="Minimize"
								title="Minimize"
							>
								⌄
							</button>
						</span>
						<Show when={showDetails()}>
							<div
								style={{
									position: "absolute",
									top: "100%",
									right: "16px",
									"margin-top": "4px",
									background: "#ffffff",
									color: "#0f172a",
									"border-radius": "8px",
									padding: "10px 14px",
									"min-width": "220px",
									"font-size": "13px",
									"box-shadow": "0 10px 15px -3px rgba(0,0,0,0.1)",
								}}
							>
								<DetailRow
									label="Viewing"
									value={
										impersonation.targetUser()?.name ??
										impersonation.targetUser()?.email ??
										userDisplay()
									}
								/>
								<DetailRow label="Access" value={scopeLabel()} />
								<DetailRow
									label="Agent"
									value={
										impersonation.impersonator()?.name ??
										impersonation.impersonator()?.email ??
										null
									}
								/>
							</div>
						</Show>
					</div>
				</Show>
			</Show>
		</Show>
	)
}
