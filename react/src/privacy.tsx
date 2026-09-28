/**
 * Dashboard-selectable privacy labels. These helpers emit data-devora-* markup.
 * For new sessions the labels have no capture effect unless an administrator
 * selects them in Devora Settings. Sensitive fields remain automatically masked.
 * Pre-migration sessions retain their original marker behavior until they end.
 */

import type { CSSProperties, ReactNode } from "react"

const CONTENTS_STYLE: CSSProperties = { display: "contents" }

export interface PrivacyWrapperProps {
	children: ReactNode
}

export interface PrivacyRegionProps extends PrivacyWrapperProps {
	/** Region name an administrator can choose to reveal (lowercase letters, digits, "-" or "_"). */
	name: string
}

/**
 * Label a subtree for a Settings mask selector: [data-devora-mask].
 *
 * @example
 * ```tsx
 * <DevoraMask>
 *   <AccountBalance />
 * </DevoraMask>
 * ```
 */
export function DevoraMask({ children }: PrivacyWrapperProps) {
	return (
		<span style={CONTENTS_STYLE} data-devora-mask="">
			{children}
		</span>
	)
}

/**
 * Name a region of the page. Nothing changes until a Devora administrator adds
 * the region to the project's unmask list; then its text and non-sensitive
 * inputs are revealed in recordings. Sensitive fields and administrator-masked content stay masked.
 *
 * @example
 * ```tsx
 * <DevoraRegion name="order-summary">
 *   <OrderSummary />
 * </DevoraRegion>
 * ```
 */
export function DevoraRegion({ name, children }: PrivacyRegionProps) {
	return (
		<span style={CONTENTS_STYLE} data-devora-region={name}>
			{children}
		</span>
	)
}

/**
 * Label a subtree for a Settings block selector: [data-devora-block].
 *
 * @example
 * ```tsx
 * <DevoraBlock>
 *   <DocumentViewer />
 * </DevoraBlock>
 * ```
 */
export function DevoraBlock({ children }: PrivacyWrapperProps) {
	return (
		<span style={CONTENTS_STYLE} data-devora-block="">
			{children}
		</span>
	)
}
