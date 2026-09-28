/**
 * Dashboard-selectable privacy labels. These helpers emit data-devora-* markup.
 * For new sessions the labels have no capture effect unless an administrator
 * selects them in Devora Settings. Sensitive fields remain automatically masked.
 * Pre-migration sessions retain their original marker behavior until they end.
 */

import type { ParentComponent } from "solid-js"

/** Label a subtree for a Settings mask selector: [data-devora-mask]. */
export const DevoraMask: ParentComponent = (props) => (
	<span style={{ display: "contents" }} data-devora-mask="">
		{props.children}
	</span>
)

/**
 * Name a region an administrator can choose to reveal from the dashboard.
 * Sensitive fields and administrator-masked content stay masked.
 */
export const DevoraRegion: ParentComponent<{ name: string }> = (props) => (
	<span style={{ display: "contents" }} data-devora-region={props.name}>
		{props.children}
	</span>
)

/**
 * Label a subtree for a Settings block selector: [data-devora-block].
 */
export const DevoraBlock: ParentComponent = (props) => (
	<span style={{ display: "contents" }} data-devora-block="">
		{props.children}
	</span>
)
