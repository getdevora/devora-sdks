/**
 * Dashboard-selectable privacy labels. These helpers emit data-devora-* markup.
 * For new sessions the labels have no capture effect unless an administrator
 * selects them in Devora Settings. Sensitive fields remain automatically masked.
 * Pre-migration sessions retain their original marker behavior until they end.
 */

import { defineComponent, h, type Directive } from "vue"

function attributeDirective(attribute: string): Directive<HTMLElement> {
	return {
		mounted(el) {
			el.setAttribute(attribute, "")
		},
		updated(el) {
			el.setAttribute(attribute, "")
		},
	}
}

/** `v-devora-mask` — label the element for [data-devora-mask] in Settings. */
export const vDevoraMask: Directive<HTMLElement> = attributeDirective("data-devora-mask")

/** `v-devora-block` — label the element for [data-devora-block] in Settings. */
export const vDevoraBlock: Directive<HTMLElement> = attributeDirective("data-devora-block")

/**
 * `v-devora-region="'name'"` — name a region an administrator can choose to
 * reveal from the dashboard. Sensitive fields and masked content stay masked.
 */
export const vDevoraRegion: Directive<HTMLElement, string> = {
	mounted(el, binding) {
		el.setAttribute("data-devora-region", String(binding.value ?? ""))
	},
	updated(el, binding) {
		el.setAttribute("data-devora-region", String(binding.value ?? ""))
	},
}

function privacyWrapper(name: string, attribute: string) {
	return defineComponent({
		name,
		setup(_, { slots }) {
			return () => h("span", { style: { display: "contents" }, [attribute]: "" }, slots.default?.())
		},
	})
}

/** Component form of `v-devora-mask` for wrapping slots. */
export const DevoraMask = privacyWrapper("DevoraMask", "data-devora-mask")

/** Component form of `v-devora-block` for wrapping slots. */
export const DevoraBlock = privacyWrapper("DevoraBlock", "data-devora-block")

/** Component form of `v-devora-region` for wrapping slots. */
export const DevoraRegion = defineComponent({
	name: "DevoraRegion",
	props: { name: { type: String, required: true } },
	setup(props, { slots }) {
		return () =>
			h(
				"span",
				{ style: { display: "contents" }, "data-devora-region": props.name },
				slots.default?.()
			)
	},
})
