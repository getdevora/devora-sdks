/**
 * Dashboard-selectable privacy labels. These helpers emit data-devora-* markup.
 * For new sessions the labels have no capture effect unless an administrator
 * selects them in Devora Settings. Sensitive fields remain automatically masked.
 * Pre-migration sessions retain their original marker behavior until they end.
 */

function attributeAction(attribute: string) {
	return (node: HTMLElement) => {
		node.setAttribute(attribute, "")
		return {
			destroy() {
				node.removeAttribute(attribute)
			},
		}
	}
}

/** `use:devoraMask` — label the element for [data-devora-mask] in Settings. */
export const devoraMask = attributeAction("data-devora-mask")

/** `use:devoraBlock` — label the element for [data-devora-block] in Settings. */
export const devoraBlock = attributeAction("data-devora-block")

/**
 * `use:devoraRegion={"name"}` — name a region an administrator can choose to
 * reveal from the dashboard. Sensitive fields and masked content stay masked.
 */
export function devoraRegion(node: HTMLElement, name: string) {
	node.setAttribute("data-devora-region", name)
	return {
		update(next: string) {
			node.setAttribute("data-devora-region", next)
		},
		destroy() {
			node.removeAttribute("data-devora-region")
		},
	}
}
