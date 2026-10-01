/**
 * A fake Devora for backend SDK tests. `POST /api/sdk/request-claim` behaves
 * like the real endpoint: the claim call must be signed customer-to-devora
 * with the test key, and the first claim of a request id wins. Every other
 * URL goes to `fallback` (a scope-config reply by default).
 */
import { createHash, createHmac } from "node:crypto"
import { TEST_KEYS } from "./signing"

export const CLAIM_PATH = "/api/sdk/request-claim"

export interface ClaimCall {
	requestId: string
	sentAt: string
	sessionId?: string
}

export type ClaimReply =
	| "claimed"
	| "replayed"
	| "not-startable"
	| "timestamp-expired"
	| "unavailable"
	| "network-error"
	| "malformed"

export interface FakeDevora {
	fetch: typeof fetch
	/** Every well-signed claim received, in order. */
	calls: ClaimCall[]
	/** Force the reply to the next claims; `undefined` restores first-claim-wins. */
	reply: ClaimReply | undefined
	/** Session ids Devora no longer starts (their start claims get SESSION_NOT_STARTABLE). */
	notStartable: Set<string>
}

const scopeConfigReply = () =>
	Response.json({
		success: true,
		data: {
			version: 1,
			safeReadEndpoints: [],
			blockedEndpoints: [],
			cachedUntil: Date.now() + 60_000,
		},
	})

function signatureValid(headers: Headers, body: Uint8Array): boolean {
	const canonical = [
		"DEVORA-HMAC-SHA256",
		"3",
		"customer-to-devora",
		headers.get("x-devora-key-id"),
		headers.get("x-devora-org-id"),
		headers.get("x-devora-sent-at"),
		headers.get("x-devora-request-id"),
		"POST",
		CLAIM_PATH,
		"",
		createHash("sha256").update(body).digest("hex"),
	].join("\n")
	const expected = createHmac("sha256", Buffer.from(TEST_KEYS.secretKey, "ascii"))
		.update(Buffer.from(canonical, "ascii"))
		.digest("hex")
	return (
		headers.get("x-devora-key-id") === TEST_KEYS.apiKey &&
		headers.get("x-devora-org-id") === TEST_KEYS.orgId &&
		headers.get("x-devora-signature") === expected
	)
}

export function fakeDevora(fallback: typeof fetch = async () => scopeConfigReply()): FakeDevora {
	const claimed = new Set<string>()
	const fake: FakeDevora = {
		calls: [],
		reply: undefined,
		notStartable: new Set(),
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(
				typeof input === "string" ? input : input instanceof URL ? input : input.url
			)
			if (url.pathname !== CLAIM_PATH) return fallback(input, init)
			const body = new Uint8Array(await new Response(init?.body).arrayBuffer())
			if (!signatureValid(new Headers(init?.headers), body))
				return Response.json({ success: false, code: "INVALID_SIGNATURE" }, { status: 401 })
			const call = JSON.parse(new TextDecoder().decode(body)) as ClaimCall
			fake.calls.push(call)
			const reject = (errorCode: string) =>
				Response.json(
					{ success: false, error: "Request cannot be claimed", errorCode },
					{ status: 409 }
				)
			switch (fake.reply) {
				case "replayed":
					return reject("REPLAYED_REQUEST")
				case "not-startable":
					return reject("SESSION_NOT_STARTABLE")
				case "timestamp-expired":
					return reject("TIMESTAMP_EXPIRED")
				case "unavailable":
					return Response.json({ success: false, error: "Claim unavailable" }, { status: 503 })
				case "network-error":
					throw new TypeError("fetch failed")
				case "malformed":
					return Response.json({ success: true, data: { claimed: "yes" } })
				case "claimed":
					return Response.json({ success: true, data: { claimed: true } })
			}
			if (call.sessionId !== undefined && fake.notStartable.has(call.sessionId))
				return reject("SESSION_NOT_STARTABLE")
			if (claimed.has(call.requestId)) return reject("REPLAYED_REQUEST")
			claimed.add(call.requestId)
			return Response.json({ success: true, data: { claimed: true } })
		}) as typeof fetch,
	}
	return fake
}

/** Install a fake Devora as `globalThis.fetch`; restore the real fetch in `afterEach`. */
export function installFakeDevora(fallback?: typeof fetch): FakeDevora {
	const fake = fakeDevora(fallback)
	globalThis.fetch = fake.fetch
	return fake
}
