import { afterEach, expect, spyOn, test } from "bun:test"
import { PresenceHeartbeat } from "../browser/src/presence-heartbeat"

const nativeFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = nativeFetch
})

function heartbeat() {
	const beat = new PresenceHeartbeat({
		apiUrl: "https://devora.invalid",
		apiKey: "pk_client_test",
		sessionId: "session",
		devoraSessionToken: "synthetic-capability",
	})
	// Exercise the throttle/send logic directly, without installing the real
	// window listeners -- this test environment has no DOM, matching how the
	// activity logger's own regression tests avoid it too.
	;(beat as any).running = true
	return beat as any
}

test("interaction is heavily debounced: a burst sends once, a later interaction after the interval sends again", async () => {
	let calls = 0
	const bodies: string[] = []
	globalThis.fetch = (_input, init) => {
		calls++
		bodies.push(String(init!.body))
		return Promise.resolve(Response.json({ success: true }))
	}
	let now = Date.now()
	const clock = spyOn(Date, "now").mockImplementation(() => now)
	try {
		const beat = heartbeat()
		for (let i = 0; i < 50; i++) beat.onInteraction()
		await Promise.resolve()
		expect(calls).toBe(1)
		expect(JSON.parse(bodies[0]!)).toEqual({ sessionId: "session" })

		// Still inside the debounce window: no new send.
		now += 5_000
		beat.onInteraction()
		await Promise.resolve()
		expect(calls).toBe(1)

		// Past the debounce window: a fresh interaction sends again.
		now += 16_000
		beat.onInteraction()
		await Promise.resolve()
		expect(calls).toBe(2)
	} finally {
		clock.mockRestore()
	}
})

test("a heartbeat in flight blocks further sends until it settles, even across many interactions", async () => {
	let calls = 0
	let release!: (response: Response) => void
	globalThis.fetch = () => {
		calls++
		return new Promise((resolve) => {
			release = resolve
		})
	}
	const beat = heartbeat()
	beat.onInteraction()
	for (let i = 0; i < 20; i++) beat.onInteraction()
	await Promise.resolve()
	expect(calls).toBe(1)
	release(Response.json({ success: true }))
	await beat.inFlight
})

test("a failed or rejected send does not throw, and a later interaction retries", async () => {
	let calls = 0
	globalThis.fetch = () => {
		calls++
		if (calls === 1) return Promise.reject(new Error("network down"))
		return Promise.resolve(Response.json({ success: false }, { status: 500 }))
	}
	let now = Date.now()
	const clock = spyOn(Date, "now").mockImplementation(() => now)
	try {
		const beat = heartbeat()
		beat.onInteraction()
		await beat.inFlight
		expect(calls).toBe(1)

		now += 21_000
		beat.onInteraction()
		await beat.inFlight
		expect(calls).toBe(2)
	} finally {
		clock.mockRestore()
	}
})

test("a stopped heartbeat ignores interaction and start/stop are idempotent", async () => {
	let calls = 0
	globalThis.fetch = () => {
		calls++
		return Promise.resolve(Response.json({ success: true }))
	}
	const beat = heartbeat()
	beat.stop()
	expect(beat.isRunning()).toBe(false)
	beat.onInteraction()
	await Promise.resolve()
	expect(calls).toBe(0)
	beat.stop() // idempotent, no throw
	expect(beat.isRunning()).toBe(false)
})
