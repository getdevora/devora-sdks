/**
 * Scope guard components for Solid (parity with @devorash/react).
 * @module @devorash/solid
 */
import { Show, type JSX } from "solid-js"
import { useDevoraScope } from "./index.js"

export interface ReadOnlyGuardProps {
	/** Content rendered when write is allowed. */
	children: JSX.Element
	/** Content rendered instead while read-only. */
	fallback?: JSX.Element
	/** Render nothing instead of a disabled wrapper while read-only. */
	hide?: boolean
}

/**
 * Hides or disables its children while the session is read-only.
 */
export function ReadOnlyGuard(props: ReadOnlyGuardProps): JSX.Element {
	const { isReadOnly } = useDevoraScope()
	return (
		<Show when={isReadOnly()} fallback={<>{props.children}</>}>
			<Show when={!props.hide}>
				<Show
					when={props.fallback !== undefined}
					fallback={
						<div
							aria-disabled="true"
							style={{ opacity: "0.5", "pointer-events": "none", cursor: "not-allowed" }}
						>
							{props.children}
						</div>
					}
				>
					{props.fallback}
				</Show>
			</Show>
		</Show>
	)
}

export interface WriteProtectedProps {
	/** Content rendered (interactive when write is allowed). */
	children: JSX.Element
	/** Message passed to `onBlocked` when interaction is blocked. */
	blockedMessage?: string
	/** Called when a blocked interaction is attempted while read-only. */
	onBlocked?: (message: string) => void
}

/**
 * Intercepts interaction with its children while the session is read-only.
 */
export function WriteProtected(props: WriteProtectedProps): JSX.Element {
	const { isReadOnly } = useDevoraScope()
	const message = () => props.blockedMessage ?? "This action is not available in read-only mode"
	const handleBlocked = (event: Event) => {
		event.preventDefault()
		event.stopPropagation()
		props.onBlocked?.(message())
	}
	return (
		<Show when={isReadOnly()} fallback={<>{props.children}</>}>
			<div
				style={{ position: "relative" }}
				role="button"
				tabindex={0}
				onClick={handleBlocked}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") handleBlocked(event)
				}}
			>
				<div style={{ opacity: "0.5", "pointer-events": "none" }}>{props.children}</div>
			</div>
		</Show>
	)
}
