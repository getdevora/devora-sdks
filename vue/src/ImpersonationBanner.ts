import { defineComponent, h, ref, type PropType, type CSSProperties, type VNodeChild } from "vue"
import { createLogger } from "@devorash/core"
import { useDevoraImpersonation } from "./index.js"

const logger = createLogger("Devora Vue")

export interface ImpersonationBannerSlotProps {
	isImpersonating: boolean
	scope: "read" | "write" | null
	userId: string | null
	targetUser: { id: string; email?: string; name?: string } | null
	impersonator: { id: string; email?: string; name?: string } | null
	remainingMs: number | null
	endSession: () => Promise<void>
}

const BRAND_BLUE = "#315ce7"

const defaultBannerStyle: CSSProperties = {
	position: "fixed",
	top: "0",
	left: "0",
	right: "0",
	padding: "10px 16px",
	backgroundColor: BRAND_BLUE,
	color: "#ffffff",
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: "12px",
	fontSize: "14px",
	fontFamily: "system-ui, sans-serif",
	zIndex: "9999",
}

const outlineButtonStyle: CSSProperties = {
	padding: "5px 12px",
	backgroundColor: "transparent",
	color: "#ffffff",
	border: "1px solid rgba(255,255,255,0.6)",
	borderRadius: "6px",
	cursor: "pointer",
	fontSize: "13px",
	fontWeight: "600",
}

const solidButtonStyle: CSSProperties = {
	padding: "5px 12px",
	backgroundColor: "#ffffff",
	color: BRAND_BLUE,
	border: "1px solid #ffffff",
	borderRadius: "6px",
	cursor: "pointer",
	fontSize: "13px",
	fontWeight: "600",
}

const pillStyle: CSSProperties = {
	position: "fixed",
	top: "10px",
	right: "10px",
	zIndex: "9999",
	display: "flex",
	alignItems: "center",
	gap: "6px",
	padding: "6px 10px",
	borderRadius: "999px",
	backgroundColor: BRAND_BLUE,
	color: "#ffffff",
	fontFamily: "system-ui, sans-serif",
	fontSize: "12px",
	fontWeight: "600",
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

function detailRow(label: string, value: string | undefined | null): VNodeChild {
	if (!value) return null
	return h(
		"div",
		{ style: { display: "flex", justifyContent: "space-between", gap: "16px", padding: "4px 0" } },
		[
			h("span", { style: { opacity: "0.7" } }, label),
			h("span", { style: { fontWeight: "600" } }, value),
		]
	)
}

export const ImpersonationBanner = defineComponent({
	name: "ImpersonationBanner",
	props: {
		class: { type: String, default: undefined },
		showEndButton: { type: Boolean, default: true },
		endButtonText: { type: String, default: "End session" },
		message: {
			type: [String, Function] as PropType<string | ((scope: "read" | "write" | null) => string)>,
			default: undefined,
		},
	},
	setup(props, { slots }) {
		const impersonation = useDevoraImpersonation()
		const isMinimized = ref(false)
		const showDetails = ref(false)

		const handleEnd = () =>
			impersonation.endSession().catch((err) => {
				logger.error("Failed to end session:", err)
			})

		return () => {
			if (!impersonation.isImpersonating.value) return null

			const scope = impersonation.scope.value
			const slotProps: ImpersonationBannerSlotProps = {
				isImpersonating: impersonation.isImpersonating.value,
				scope,
				userId: impersonation.userId.value,
				targetUser: impersonation.targetUser.value,
				impersonator: impersonation.impersonator.value,
				remainingMs: impersonation.remainingMs.value,
				endSession: impersonation.endSession,
			}

			if (slots.default) {
				return slots.default(slotProps)
			}

			const userDisplay =
				slotProps.targetUser?.name ||
				slotProps.targetUser?.email ||
				slotProps.targetUser?.id ||
				slotProps.userId

			if (isMinimized.value) {
				return h(
					"button",
					{
						type: "button",
						style: pillStyle,
						onClick: () => (isMinimized.value = false),
						"aria-label": `Impersonating ${userDisplay ?? "customer"} — expand`,
					},
					[
						h("span", {
							"aria-hidden": "true",
							style: { width: "6px", height: "6px", borderRadius: "50%", background: "#fff" },
						}),
						formatCountdownClock(slotProps.remainingMs),
					]
				)
			}

			const bannerMessage =
				typeof props.message === "function"
					? props.message(scope)
					: (props.message ?? (userDisplay ? `Viewing as ${userDisplay}` : "Impersonation active"))
			const scopeLabel = scope === "write" ? "Read & write" : "Read-only"
			const remainingMs = slotProps.remainingMs

			return h(
				"div",
				{
					class: props.class,
					role: "alert",
					"aria-live": "polite",
					style: defaultBannerStyle,
				},
				[
					h(
						"span",
						{
							style: {
								minWidth: "0",
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
							},
						},
						[
							h("strong", bannerMessage),
							scope !== null
								? h("span", { style: { marginLeft: "10px", opacity: "0.85", fontWeight: "400" } }, [
										scopeLabel,
										remainingMs !== null && remainingMs > 0
											? ` · ${formatCountdownClock(remainingMs)} left`
											: null,
									])
								: null,
						]
					),
					h("span", { style: { display: "flex", gap: "8px", flexShrink: "0" } }, [
						h(
							"button",
							{
								type: "button",
								style: outlineButtonStyle,
								onClick: () => (showDetails.value = !showDetails.value),
							},
							"Details"
						),
						props.showEndButton
							? h(
									"button",
									{ type: "button", style: solidButtonStyle, onClick: handleEnd },
									props.endButtonText
								)
							: null,
						h(
							"button",
							{
								type: "button",
								style: {
									...outlineButtonStyle,
									border: "1px solid transparent",
									padding: "5px 8px",
								},
								onClick: () => (isMinimized.value = true),
								"aria-label": "Minimize",
								title: "Minimize",
							},
							"⌄"
						),
					]),
					showDetails.value
						? h(
								"div",
								{
									style: {
										position: "absolute",
										top: "100%",
										right: "16px",
										marginTop: "4px",
										background: "#ffffff",
										color: "#0f172a",
										borderRadius: "8px",
										padding: "10px 14px",
										minWidth: "220px",
										fontSize: "13px",
										boxShadow: "0 10px 15px -3px rgba(0,0,0,0.1)",
									},
								},
								[
									detailRow(
										"Viewing",
										slotProps.targetUser?.name ?? slotProps.targetUser?.email ?? userDisplay
									),
									detailRow("Access", scopeLabel),
									detailRow(
										"Agent",
										slotProps.impersonator?.name ?? slotProps.impersonator?.email ?? null
									),
								]
							)
						: null,
				]
			)
		}
	},
})
