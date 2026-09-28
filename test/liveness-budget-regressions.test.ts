import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import { createImpersonationGuard } from "../node/src/middleware"
import type { DevoraBackendSDK } from "../node/src/types"

beforeEach(() => jest.useFakeTimers())
afterEach(() => {
	jest.clearAllTimers()
	jest.useRealTimers()
})
const sdkWith = (getSessionStatus: (id: string) => Promise<any>) =>
	({ getSessionStatus }) as DevoraBackendSDK
function guardFor(sdk: DevoraBackendSDK) {
	return createImpersonationGuard({
		sdk,
		showWarnings: false,
		getImpersonationContext: (request) => ({
			isImpersonation: true,
			sessionId: request.id as string,
			scope: "read",
			expiresAt: Date.now() + 60_000,
			actor: { id: "actor" },
			subject: { id: "subject" },
			authMethod: "devora_impersonation",
			authorizationSource: "standard",
			recordingAllowed: false,
		}),
	})
}
async function check(guard: ReturnType<typeof guardFor>, id: string) {
	let status = 0
	const response = {
		status(value: number) {
			status = value
			return response
		},
		json() {},
	}
	await guard({ method: "GET", path: "/api/items", id } as any, response, () => {
		status = 200
	})
	return status
}

test("Node liveness coalesces requests and bounds actual work even when a transport outlives its deadline", async () => {
	const pending = new Map<string, (value: any) => void>()
	let calls = 0
	const guard = guardFor(
		sdkWith((id) => {
			calls++
			return new Promise((resolve) => pending.set(id, resolve))
		})
	)
	const owners = Array.from({ length: 64 }, (_, i) => check(guard, String(i)))
	const same = check(guard, "0")
	expect(await check(guard, "excess")).toBe(503)
	expect(calls).toBe(64)
	jest.advanceTimersByTime(5000)
	expect(await Promise.all(owners)).toEqual(Array(64).fill(503))
	expect(await same).toBe(503)
	expect(await check(guard, "still-full")).toBe(503)
	expect(calls).toBe(64)
	// Late transport completion frees capacity but does not cache its old live verdict.
	pending.get("0")!({ valid: true })
	for (let i = 0; i < 8; i++) await Promise.resolve()
	expect(await check(guard, "0")).toBe(503)
	const newlyAdmitted = check(guard, "new")
	for (let i = 0; i < 4; i++) await Promise.resolve()
	expect(calls).toBe(65)
	pending.get("new")!({ valid: false })
	expect(await newlyAdmitted).toBe(401)
	for (const resolve of pending.values()) resolve({ valid: false })
})

test("Node liveness catches synchronous transport failures and validates fail-open configuration", async () => {
	let calls = 0
	const sdk = sdkWith(() => {
		calls++
		throw new Error("unavailable")
	})
	const guard = guardFor(sdk)
	expect(await check(guard, "same")).toBe(503)
	expect(await check(guard, "same")).toBe(503)
	expect(calls).toBe(1)
	for (const extra of [
		{ onLivenessUnavailable: "denny" },
		{ livenessCacheTtlMs: NaN },
		{ livenessCacheTtlMs: -1 },
	])
		expect(() =>
			createImpersonationGuard({ sdk, getImpersonationContext: () => null, ...extra } as any)
		).toThrow("Invalid liveness")
})
