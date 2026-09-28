/**
 * Scope and bridge guard components for Vue (parity with @devorash/react).
 * @module @devorash/vue
 */
import { defineComponent, h } from "vue"
import { useDevoraScope, useDevoraBridge } from "./index.js"

/**
 * Hides or disables its default slot while the session is read-only.
 * Provide a `#fallback` slot to render alternative content instead.
 */
export const ReadOnlyGuard = defineComponent({
	name: "ReadOnlyGuard",
	props: {
		/** Render nothing instead of a disabled wrapper while read-only. */
		hide: { type: Boolean, default: false },
	},
	setup(props, { slots }) {
		const { isReadOnly } = useDevoraScope()
		return () => {
			if (!isReadOnly.value) return slots.default ? slots.default() : null
			if (props.hide) return null
			if (slots.fallback) return slots.fallback()
			return h(
				"div",
				{
					"aria-disabled": "true",
					style: { opacity: "0.5", pointerEvents: "none", cursor: "not-allowed" },
				},
				slots.default?.()
			)
		}
	},
})

/**
 * Intercepts interaction with its default slot while the session is read-only and
 * emits a `blocked` event with the message instead of letting the action through.
 */
export const WriteProtected = defineComponent({
	name: "WriteProtected",
	props: {
		blockedMessage: {
			type: String,
			default: "This action is not available in read-only mode",
		},
	},
	emits: ["blocked"],
	setup(props, { slots, emit }) {
		const { isReadOnly } = useDevoraScope()
		return () => {
			if (!isReadOnly.value) return slots.default ? slots.default() : null
			return h(
				"div",
				{
					style: { position: "relative" },
					role: "button",
					tabindex: 0,
					onClickCapture: (event: Event) => {
						event.preventDefault()
						event.stopPropagation()
						emit("blocked", props.blockedMessage)
					},
				},
				h("div", { style: { opacity: "0.5", pointerEvents: "none" } }, slots.default?.())
			)
		}
	},
})

/**
 * Vue has no children-wrapping provider, so bridge-restoration gating (unlike
 * React/Solid) is opt-in: wrap the parts of your app that must never render
 * before Devora knows whether this tab is safe.
 *
 * Renders the default slot only once a configured `sessionBridge` has
 * resolved and this tab is not blocked. Provide a `#fallback` slot to render
 * something specific while blocked; a `#pending` slot for the (usually very
 * brief) window before restoration resolves. Both default to rendering
 * nothing rather than a flash of protected content.
 */
export const BridgeGuard = defineComponent({
	name: "BridgeGuard",
	setup(_, { slots }) {
		const { isBlocked, isPending } = useDevoraBridge()
		return () => {
			if (isPending.value) return slots.pending ? slots.pending() : null
			if (isBlocked.value) return slots.fallback ? slots.fallback() : null
			return slots.default ? slots.default() : null
		}
	},
})
