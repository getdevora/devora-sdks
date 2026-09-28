import { afterEach, expect, spyOn, test } from "bun:test"
import { ActivityLogger } from "../browser/src/activity-logger"
import { resolveMasking } from "../browser/src/masking"

const nativeFetch = globalThis.fetch
const dateNow = Date.now
afterEach(() => {
	globalThis.fetch = nativeFetch
	Date.now = dateNow
})
function logger(reasons: string[] = []) {
	const logger = new ActivityLogger({
		apiUrl: "https://devora.invalid",
		apiKey: "pk_client_test",
		sessionId: "session",
		devoraSessionToken: "synthetic-capability",
		tabId: "tab",
		masking: resolveMasking(undefined),
		captureErrors: false,
		captureCustomEvents: true,
		onIncomplete: (reason) => reasons.push(reason),
	})
	// Exercise production batching without installing unrelated DOM listeners.
	;(logger as any).running = true
	return logger
}

test("a 2000-event burst has one upload, retains its failed prefix and reports overflow on recovery", async () => {
	let now = dateNow()
	const clock = spyOn(Date, "now").mockImplementation(() => now)
	const reasons: string[] = []
	const activity = logger(reasons) as any
	const bodies: string[] = []
	let release!: (response: Response) => void
	globalThis.fetch = (_input, init) => {
		bodies.push(String(init!.body))
		if (bodies.length === 1)
			return new Promise((resolve) => {
				release = resolve
			})
		return Promise.resolve(Response.json({ success: true }))
	}
	try {
		for (let i = 0; i < 2000; i++)
			activity.logCustomAction({ type: "custom", action: `event_${i}` })
		await Promise.resolve()
		expect(bodies).toHaveLength(1)
		expect(activity.queue).toHaveLength(100)
		expect(reasons).toEqual(["activity_budget_exceeded"])
		const pending = activity.flush()
		release(Response.json({ success: false }, { status: 503 }))
		await pending
		expect(activity.queue).toHaveLength(100)
		await activity.flush() // Backoff blocks enqueue-triggered retry storms.
		expect(bodies).toHaveLength(1)
		now += 1001
		await activity.flush()
		expect(bodies[1]).toBe(bodies[0])
		const delivered = bodies.slice(1).map((body) => JSON.parse(body))
		expect(
			delivered.flatMap((batch) => batch.events.map((event: any) => event.context.action))
		).toEqual(Array.from({ length: 100 }, (_, i) => `event_${i}`))
		expect(delivered.reduce((sum, batch) => sum + batch.droppedEvents, 0)).toBe(1900)
		expect(activity.queue).toHaveLength(0)
		expect(activity.dropped).toBe(0)
		await activity.stop()
	} finally {
		clock.mockRestore()
	}
})

test("failed acknowledgments preserve the batch and stop capture after a bounded retry budget", async () => {
	let now = dateNow()
	const clock = spyOn(Date, "now").mockImplementation(() => now)
	const reasons: string[] = []
	const activity = logger(reasons) as any
	const bodies: string[] = []
	globalThis.fetch = async (_input, init) => {
		bodies.push(String(init!.body))
		return Response.json({ success: false }) // HTTP 200 alone is not an acknowledgment.
	}
	try {
		activity.logCustomAction({ type: "custom", action: "retained" })
		for (let attempt = 0; attempt < 3; attempt++) {
			await activity.flush()
			now += 30_000
		}
		expect(new Set(bodies).size).toBe(1)
		expect(bodies).toHaveLength(3)
		expect(activity.queue).toHaveLength(1)
		expect(activity.isRunning()).toBe(false)
		expect(reasons).toEqual(["activity_delivery_failed"])
		activity.logCustomAction({ type: "custom", action: "after_retirement" })
		await activity.flush()
		expect(bodies).toHaveLength(3)
		expect(activity.queue).toHaveLength(1)
	} finally {
		clock.mockRestore()
	}
})

test("pagehide cannot overlap an active upload or change a failed batch to fit its byte allowance", async () => {
	const reasons: string[] = []
	const activity = logger(reasons) as any
	let requests = 0
	let release!: (response: Response) => void
	globalThis.fetch = () => {
		requests++
		return new Promise((resolve) => {
			release = resolve
		})
	}
	for (let i = 0; i < 20; i++)
		activity.logCustomAction({
			type: "custom",
			action: `event_${i}`,
			metadata: { text: "x".repeat(1500) },
		})
	await Promise.resolve()
	const hiding = activity.flush(true)
	expect(requests).toBe(1)
	release(Response.json({ success: false }, { status: 503 }))
	await hiding
	await activity.flush(true)
	expect(requests).toBe(1)
	expect(activity.queue).toHaveLength(20)
	expect(reasons).toContain("activity_delivery_uncertain")
})
