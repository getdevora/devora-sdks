import { afterEach, expect, spyOn, test } from "bun:test"
import { get } from "svelte/store"
import { createRenderer, nextTick, watch } from "../vue/node_modules/vue"
import {
	initDevora,
	destroyDevora,
	devoraStore,
	getDevoraSDK,
	endDevoraSession,
} from "../svelte/src/index"
import { useDevora, useDevoraBridge } from "../vue/src/index"

const config = {
	apiKey: "pk_client_live_wrapper_regression",
	apiUrl: "https://devora.example",
	autoDetect: false,
	showWarnings: false,
}
function deferred<T = void>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((r) => {
		resolve = r
	})
	return { promise, resolve }
}
const blockedBridge = {
	restore: async () => ({ status: "blocked" as const, reason: "session_invalid" as const }),
}
const unmounts: (() => void)[] = []
afterEach(async () => {
	for (const unmount of unmounts.splice(0)) unmount()
	await destroyDevora()
})

test("Svelte retired initialization and delayed destruction cannot overwrite the replacement", async () => {
	const entered = deferred()
	const bridge = deferred<{ status: "none" }>()
	const oldInit = initDevora({
		...config,
		sessionBridge: {
			restore: () => {
				entered.resolve()
				return bridge.promise
			},
		},
	})
	await entered.promise
	const old = getDevoraSDK()!
	const destroy = old.destroy.bind(old)
	const flushed = deferred()
	const spy = spyOn(old, "destroy").mockImplementation(async () => {
		await destroy()
		await flushed.promise
	})
	try {
		const oldDestroy = destroyDevora()
		const current = await initDevora({ ...config, sessionBridge: blockedBridge })
		const before = get(devoraStore)
		expect(before.bridgeState.status).toBe("blocked")
		expect(before.isInitialized).toBe(true)
		bridge.resolve({ status: "none" })
		flushed.resolve()
		await Promise.all([oldInit, oldDestroy])
		expect(getDevoraSDK()).toBe(current)
		expect(get(devoraStore)).toEqual(before)
	} finally {
		bridge.resolve({ status: "none" })
		flushed.resolve()
		spy.mockRestore()
	}
})

test("Svelte older end completion cannot publish its session after reinitialization", async () => {
	const old = await initDevora(config)
	const finish = deferred()
	const ending = spyOn(old, "end").mockImplementation(() => finish.promise)
	const session = spyOn(old, "getSession").mockReturnValue({
		...old.getSession(),
		sessionId: "retired-session",
	})
	try {
		const oldEnd = endDevoraSession()
		await initDevora({ ...config, sessionBridge: blockedBridge })
		const before = get(devoraStore)
		finish.resolve()
		await oldEnd
		expect(get(devoraStore)).toEqual(before)
	} finally {
		finish.resolve()
		ending.mockRestore()
		session.mockRestore()
	}
})

// Vue's real lifecycle and reactivity, with a minimal host renderer. The SDK's
// own bridge and generation cancellation run unchanged; no mocked Vue hooks.
const renderer = createRenderer<Record<string, unknown>, Record<string, unknown>>({
	patchProp() {},
	insert() {},
	remove() {},
	createElement: () => ({}),
	createText: () => ({}),
	createComment: () => ({}),
	setText() {},
	setElementText() {},
	parentNode: () => null,
	nextSibling: () => null,
})
function mount(configOverride = {}) {
	let view!: ReturnType<typeof useDevora>
	let pendingDuringSetup = false
	const app = renderer.createApp({
		setup() {
			view = useDevora({ ...config, ...configOverride })
			pendingDuringSetup = useDevoraBridge().isPending.value
			return () => null
		},
	})
	app.mount({})
	let mounted = true
	const unmount = () => {
		if (mounted) {
			mounted = false
			app.unmount()
		}
	}
	unmounts.push(unmount)
	return { view, unmount, pendingDuringSetup }
}
async function ready(view: ReturnType<typeof useDevora>) {
	if (view.isInitialized.value) return
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			stop()
			reject(new Error("Wrapper did not initialize"))
		}, 2000)
		const stop = watch(view.isInitialized, (value) => {
			if (value) {
				clearTimeout(timeout)
				stop()
				resolve()
			}
		})
	})
}
async function settled() {
	for (let i = 0; i < 10; i++) await nextTick()
}

test("Vue unmount during initialization preserves the next app's blocked bridge state", async () => {
	const entered = deferred()
	const bridge = deferred<{ status: "none" }>()
	const old = mount({
		sessionBridge: {
			restore: () => {
				entered.resolve()
				return bridge.promise
			},
		},
	})
	await entered.promise
	old.unmount()
	expect(old.view.session.sessionId).toBeNull()
	expect(useDevoraBridge().bridgeState.value.status).toBe("idle")
	const current = mount({ sessionBridge: blockedBridge })
	await ready(current.view)
	expect(current.view.isInitialized.value).toBe(true)
	expect(current.view.bridgeState.value.status).toBe("blocked")
	bridge.resolve({ status: "none" })
	await settled()
	expect(current.view.isInitialized.value).toBe(true)
	expect(current.view.bridgeState.value.status).toBe("blocked")
})

test("Vue shared mounts initialize once and retain the instance until the last unmount", async () => {
	let restores = 0
	const bridge = {
		restore: async () => {
			restores++
			return { status: "none" as const }
		},
	}
	const first = mount({ sessionBridge: bridge })
	expect(first.pendingDuringSetup).toBe(true)
	const second = mount()
	await ready(second.view)
	expect(first.view.sdk).toBe(second.view.sdk)
	expect(restores).toBe(1)
	first.unmount()
	expect(second.view.isInitialized.value).toBe(true)
	second.unmount()
	expect(second.view.isInitialized.value).toBe(false)
	expect(useDevoraBridge().bridgeState.value.status).toBe("idle")
})
