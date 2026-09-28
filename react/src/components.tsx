/**
 * React components for Devora SDK
 * @module @devorash/react
 */

import { useState, type ReactNode, type CSSProperties } from "react"
import { createLogger } from "@devorash/core"
import { useDevoraRemainingMs } from "./context.js"
import { useDevoraImpersonation, useDevoraScope } from "./hooks.js"

// Create a logger instance for the React components
const logger = createLogger("Devora React")

/**
 * Props for ImpersonationBanner
 */
export interface ImpersonationBannerProps {
	/** Custom styles */
	style?: CSSProperties
	/** Custom class name */
	className?: string
	/** Show end session button */
	showEndButton?: boolean
	/** Custom end button text */
	endButtonText?: string
	/** Custom banner message */
	message?: string | ((scope: "read" | "write" | null) => string)
	/** Custom render function with enriched impersonation info */
	children?: (props: {
		isImpersonating: boolean
		scope: "read" | "write" | null
		userId: string | null
		targetUser: { id: string; email?: string; name?: string } | null
		impersonator: { id: string; email?: string; name?: string } | null
		remainingMs: number | null
		endSession: () => Promise<void>
	}) => ReactNode
}

const BRAND_BLUE = "#315ce7"

const defaultBannerStyle: CSSProperties = {
	position: "fixed",
	top: 0,
	left: 0,
	right: 0,
	padding: "10px 16px",
	backgroundColor: BRAND_BLUE,
	color: "#ffffff",
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: 12,
	fontSize: "14px",
	fontFamily: "system-ui, sans-serif",
	zIndex: 9999,
}

const outlineButtonStyle: CSSProperties = {
	padding: "5px 12px",
	backgroundColor: "transparent",
	color: "#ffffff",
	border: "1px solid rgba(255,255,255,0.6)",
	borderRadius: "6px",
	cursor: "pointer",
	fontSize: "13px",
	fontWeight: 600,
}

const solidButtonStyle: CSSProperties = {
	padding: "5px 12px",
	backgroundColor: "#ffffff",
	color: BRAND_BLUE,
	border: "1px solid #ffffff",
	borderRadius: "6px",
	cursor: "pointer",
	fontSize: "13px",
	fontWeight: 600,
}

const pillStyle: CSSProperties = {
	position: "fixed",
	top: 10,
	right: 10,
	zIndex: 9999,
	display: "flex",
	alignItems: "center",
	gap: 6,
	padding: "6px 10px",
	borderRadius: 999,
	backgroundColor: BRAND_BLUE,
	color: "#ffffff",
	fontFamily: "system-ui, sans-serif",
	fontSize: "12px",
	fontWeight: 600,
	border: "none",
	cursor: "pointer",
}

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

function detailRow(label: string, value: string | undefined | null): ReactNode {
	if (!value) return null
	return (
		<div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "4px 0" }}>
			<span style={{ opacity: 0.7 }}>{label}</span>
			<span style={{ fontWeight: 600 }}>{value}</span>
		</div>
	)
}

/**
 * Impersonation banner component. Shows when an impersonation session is
 * active — full bar by default, collapsing to a small pill when the agent
 * minimizes it (it never fully hides while impersonating, so the person
 * whose account is being viewed can't lose track that it's happening).
 */
export function ImpersonationBanner({
	style,
	className,
	showEndButton = true,
	endButtonText = "End session",
	message,
	children,
}: ImpersonationBannerProps) {
	const { isImpersonating, scope, userId, targetUser, impersonator, endSession } =
		useDevoraImpersonation()
	const remainingMs = useDevoraRemainingMs()
	const [isMinimized, setIsMinimized] = useState(false)
	const [showDetails, setShowDetails] = useState(false)

	// Don't render if not impersonating
	if (!isImpersonating) {
		return null
	}

	// Custom render with enriched info
	if (children) {
		return (
			<>
				{children({
					isImpersonating,
					scope,
					userId,
					targetUser,
					impersonator,
					remainingMs,
					endSession,
				})}
			</>
		)
	}

	const handleEnd = () =>
		endSession().catch((err) => {
			logger.error("Failed to end session:", err)
		})

	const userDisplay = targetUser?.name || targetUser?.email || targetUser?.id || userId

	if (isMinimized) {
		return (
			<button
				type="button"
				style={pillStyle}
				onClick={() => setIsMinimized(false)}
				aria-label={`Impersonating ${userDisplay ?? "customer"} — expand`}
			>
				<span
					aria-hidden
					style={{ width: 6, height: 6, borderRadius: "50%", background: "#fff" }}
				/>
				{formatCountdownClock(remainingMs)}
			</button>
		)
	}

	const bannerMessage =
		typeof message === "function"
			? message(scope)
			: (message ?? (userDisplay ? `Viewing as ${userDisplay}` : "Impersonation active"))
	const scopeLabel = scope === "write" ? "Read & write" : "Read-only"

	return (
		<div
			style={{ ...defaultBannerStyle, ...style }}
			className={className}
			role="alert"
			aria-live="polite"
		>
			<span
				style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
			>
				<strong>{bannerMessage}</strong>
				{scope !== null && (
					<span style={{ marginLeft: 10, opacity: 0.85, fontWeight: 400 }}>
						{scopeLabel}
						{remainingMs !== null &&
							remainingMs > 0 &&
							` · ${formatCountdownClock(remainingMs)} left`}
					</span>
				)}
			</span>
			<span style={{ display: "flex", gap: 8, flexShrink: 0 }}>
				<button type="button" style={outlineButtonStyle} onClick={() => setShowDetails((v) => !v)}>
					Details
				</button>
				{showEndButton && (
					<button type="button" style={solidButtonStyle} onClick={handleEnd}>
						{endButtonText}
					</button>
				)}
				<button
					type="button"
					style={{ ...outlineButtonStyle, border: "1px solid transparent", padding: "5px 8px" }}
					onClick={() => setIsMinimized(true)}
					aria-label="Minimize"
					title="Minimize"
				>
					⌄
				</button>
			</span>
			{showDetails && (
				<div
					style={{
						position: "absolute",
						top: "100%",
						right: 16,
						marginTop: 4,
						background: "#ffffff",
						color: "#0f172a",
						borderRadius: 8,
						padding: "10px 14px",
						minWidth: 220,
						fontSize: 13,
						boxShadow: "0 10px 15px -3px rgba(0,0,0,0.1)",
					}}
				>
					{detailRow("Viewing", targetUser?.name ?? targetUser?.email ?? userDisplay)}
					{detailRow("Access", scopeLabel)}
					{detailRow("Agent", impersonator?.name ?? impersonator?.email ?? null)}
				</div>
			)}
		</div>
	)
}

/**
 * Props for ReadOnlyGuard
 */
export interface ReadOnlyGuardProps {
	/** Content to render when write is allowed */
	children: ReactNode
	/** Content to render when read-only (optional) */
	fallback?: ReactNode
	/** Whether to hide completely in read-only mode */
	hide?: boolean
}

/**
 * Guard component that hides/disables content in read-only mode
 */
export function ReadOnlyGuard({ children, fallback, hide = false }: ReadOnlyGuardProps) {
	const { isReadOnly } = useDevoraScope()

	if (isReadOnly) {
		if (hide) {
			return null
		}
		if (fallback) {
			return <>{fallback}</>
		}
		// Wrap in disabled container
		return (
			<div
				style={{
					opacity: 0.5,
					pointerEvents: "none",
					cursor: "not-allowed",
				}}
				aria-disabled="true"
			>
				{children}
			</div>
		)
	}

	return <>{children}</>
}

/**
 * Props for WriteProtected
 */
export interface WriteProtectedProps {
	/** Content to render */
	children: ReactNode
	/** Message to show when action is blocked */
	blockedMessage?: string
	/** Custom callback when write action is blocked (overrides default alert) */
	onBlocked?: (message: string) => void
}

/**
 * Component that shows a message when trying to write in read-only mode
 */
export function WriteProtected({
	children,
	blockedMessage = "This action is not available in read-only mode",
	onBlocked,
}: WriteProtectedProps) {
	const { isReadOnly } = useDevoraScope()

	const handleBlocked = () => {
		if (onBlocked) {
			onBlocked(blockedMessage)
		} else {
			// Default behavior - can be replaced by providing onBlocked prop
			alert(blockedMessage)
		}
	}

	if (isReadOnly) {
		return (
			<div
				style={{
					position: "relative",
				}}
				onClick={(e) => {
					e.preventDefault()
					e.stopPropagation()
					handleBlocked()
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault()
						handleBlocked()
					}
				}}
				role="button"
				tabIndex={0}
			>
				<div
					style={{
						opacity: 0.5,
						pointerEvents: "none",
					}}
				>
					{children}
				</div>
			</div>
		)
	}

	return <>{children}</>
}
