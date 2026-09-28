/**
 * A minimal browser window for exchange tests: the one-time code sits in the
 * URL fragment and, unless disabled, a fake Devora dashboard is the opener and
 * answers the SDK's ready message with the verifier.
 */
import { SDK_DEFAULTS } from "../../core/src/constants/index"

export const EXCHANGE_CODE = "x".repeat(48)
export const EXCHANGE_VERIFIER = "v".repeat(43)

export function createExchangeWindow(
	options: { url?: string; withOpener?: boolean; verifier?: string; openerOrigin?: string } = {}
) {
	const location = new URL(
		options.url ?? `https://customer.example/#devora_exchange=${EXCHANGE_CODE}`
	)
	const events = new EventTarget()
	const openerMessages: unknown[] = []
	const win: Record<string, unknown> = {
		location,
		history: {
			state: null,
			replaceState(_data: unknown, _unused: string, url: string) {
				location.href = new URL(url, location).href
			},
		},
		addEventListener: events.addEventListener.bind(events),
		removeEventListener: events.removeEventListener.bind(events),
		dispatchEvent: events.dispatchEvent.bind(events),
		get fetch() {
			return globalThis.fetch
		},
		set fetch(value) {
			globalThis.fetch = value
		},
	}
	if (options.withOpener !== false) {
		const opener = {
			postMessage(data: { type?: string }) {
				openerMessages.push(data)
				if (data?.type !== "devora:exchange-ready") return
				queueMicrotask(() => {
					const event = new MessageEvent("message", {
						origin: options.openerOrigin ?? SDK_DEFAULTS.DASHBOARD_ORIGIN,
						data: {
							type: "devora:exchange-verifier",
							verifier: options.verifier ?? EXCHANGE_VERIFIER,
						},
					})
					Object.defineProperty(event, "source", { value: opener })
					events.dispatchEvent(event)
				})
			},
		}
		win.opener = opener
	}
	return { win, location, openerMessages }
}
