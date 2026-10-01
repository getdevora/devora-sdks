# Changelog

## 0.1.2

Breaking release for all fourteen packages. 0.1.0 and 0.1.1 are deprecated; use 0.1.2 or later.

- Request ids are now claimed from Devora. After a signed request verifies, the backend SDK makes one signed call to `POST /api/sdk/request-claim` and runs your handler only after a successful claim. You provide no storage for replay protection, but your backend must be able to make outbound HTTPS requests to the Devora API. New error codes: `SESSION_NOT_STARTABLE` (409, a start request for a session Devora is no longer starting) and `REQUEST_CLAIM_UNAVAILABLE` (503, Devora could not be reached; the SDK fails closed). `REPLAYED_REQUEST` (401) now means Devora already claimed the request id, and `TIMESTAMP_EXPIRED` (401) can also come from the claim when Devora finds the request too old. `@devorash/core` exports the claim endpoint and deadline as `REQUEST_CLAIM`.
- Removed the replay store and environment handling: the Node `replayStore` and `environment` options, `ReplayStore`, `InMemoryReplayStore`, `resolveEnvironment` and `DevoraEnvironment`; the Python `replay_store` and `environment` arguments, `ReplayStore`, `InMemoryReplayStore`, `resolve_environment` and the `devora_sdk.replay` module; the `DEVORA_ENV`/`NODE_ENV` production check; the `REPLAY_STORE_UNAVAILABLE` error code; and the helpers `replayNamespace` and `replayExpiresAtMs` (core) and `replay_namespace` and `replay_expires_at_ms` (Python).
- Removed `DEVORA_ENDPOINTS.USER_BY_ID` (`/user/:id`); Devora never called it.
- The terminate request body is typed as `ImpersonationTerminateRequest` (`{ reason, terminatedBy? }`) with the new exported `SessionTerminationReason` type, which adds the `start_failed` and `not_started` reasons. `@devorash/nextjs` re-exports both types.
- Terminate notices: Devora makes up to 5 attempts within 6 hours, each a new signed request with a new request id, so `TERMINATE` handlers must be idempotent. `408`, `425`, `429`, `5xx` and transport errors are retried after 8, 24, 72 and 216 minutes (±20%), and a `Retry-After` on `429` or `503` is honoured, but not past the 6-hour deadline; any other `4xx` is not retried. Return a `2xx`, or `429`/`503` with `Retry-After` when overloaded.
- User search results can carry `attributes`: extra display fields such as company, role or plan (up to 12 per user; keys match `^[a-z][a-z0-9_]{0,39}$`; values are strings up to 120 characters, numbers, booleans or `null`). Devora shows them through the search results template configured in the dashboard and drops invalid entries; see [Search results and templates](https://docs.devora.sh/guide/search-results). Handlers should match name, email and the exact user ID.
- `DevoraUser` is now `{ id, name?, email?, avatar?, attributes? }`: `avatarUrl` is renamed `avatar` and `metadata` is replaced by `attributes`, typed by the new `DevoraUserAttributeValue` (`string | number | boolean | null`). `UserSearchRequest` gains `limit?`. The undocumented `meta` field of a search result is no longer read. Python exports matching `DevoraUser` and `UserSearchResponse` `TypedDict`s and the `DevoraUserAttributeValue` alias from `devora_sdk`.
- Browser SDK: removed the never-called `onError.tokenValidationFailed` and `onError.networkError` handlers and the unused `SDK_END_REASON.PAGE_UNLOAD`.
- Browser SDK: `hasExchangeParameterInURL()` and the frameworks' `hasDevoraPayload()` now stay `true` until the SDK has finished starting, not only until it removes the one-time code from the URL, so an app can hold back its login redirect for the whole handoff. They return `false` again if the SDK is destroyed mid-redemption.
- Browser SDK: a page that navigates away right after the impersonation handoff (a server-rendered app that hands off, then navigates) no longer reports a recording gap: the upload in flight is sent again with `keepalive`.
- Browser SDK: after a session ends from Devora's side (dashboard end, revoke, time limit), the last seconds of recording and activity are no longer lost. Devora keeps data a tab recorded before the end for 60 seconds, and a tab now ends the session as soon as Devora reports the end (on an upload or a refused presence heartbeat) and holds host logout up to one second for its final capture, for every kind of end. Pages whose final upload still did not arrive show "Stopped at session end" in the replay instead of "Incomplete".
- Browser SDK: a server-rendered page whose ordinary recording upload is cancelled by navigation just before `pagehide` now resends it with the rest of the page, instead of reporting a recording gap on every navigation.
- Django: blocked page loads and form posts now get a small HTML page instead of JSON; API calls (fetch/XHR or JSON) still get JSON. Pass `render_blocked=callable(request, status_code, body)` to `create_impersonation_guard` to render your own template.

## 0.1.1

Documentation release for all fourteen packages; SDK behaviour is unchanged from 0.1.0.

- Every framework quick start now runs as copied: backend examples configure the production replay store, examples store the complete verified Devora context that the scope guard requires, the Next.js provider declares `"use client"`, and the Fastify example passes its server key ID.
- The READMEs describe the real options, error responses, supported framework versions, adapter mounting order and browser-session restore.
- Recording, masking, capture and scope policy are documented as configured in the Devora dashboard and authorized per session; the SDKs take no settings for them.

## 0.1.0

Initial public release of the JavaScript and Python SDKs with signed requests, replay protection, session lifecycle handling and framework adapters, published to npm and PyPI on 30 September 2026.
