# Devora request signing (version 3)

Devora and your backend authenticate requests to each other with HMAC-SHA256.
The signature covers the exact bytes on the wire (path, query and body) and
the direction the request travels in. The SDKs implement this for you; this
page is the protocol reference. Conformance vectors shared by every
implementation: [`test/signing-v3-vectors.json`](./test/signing-v3-vectors.json).

## Directions

| Direction            | Signed by              | Verified by                     | Used for                                                                |
| -------------------- | ---------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `devora-to-customer` | Devora                 | Your backend (the SDK adapters) | User search, impersonation start and terminate, test, health            |
| `customer-to-devora` | Your backend (the SDK) | Devora                          | Request claims, endpoint policy, session liveness, browser resume codes |

Each verifier accepts only its own direction, so a request can never be
replayed back at its sender.

## Key material

The HMAC key is the ASCII bytes of the full server secret
(`sk_server_live_` followed by 64 characters). The key id is
`pk_server_live_` followed by 32 characters. Your backend verifies only the
one key id it is configured with; Devora accepts any active server key of your
organization.

## Headers

Each header must appear exactly once and match its grammar in full. Nothing is
trimmed, lower-cased or reduced to a first value.

| Header                       | Grammar                                                       |
| ---------------------------- | ------------------------------------------------------------- |
| `x-devora-signature-version` | `3`                                                           |
| `x-devora-key-id`            | `^pk_server_live_[A-Za-z0-9_-]{32}$`                          |
| `x-devora-org-id`            | `^[A-Za-z0-9_-]{1,128}$`                                      |
| `x-devora-sent-at`           | `^[1-9][0-9]{9}$` (Unix seconds)                              |
| `x-devora-request-id`        | lowercase UUID v4                                             |
| `x-devora-signature`         | `^[0-9a-f]{64}$`                                              |
| `content-type`               | `application/json` when, and only when, the body is non-empty |

`Content-Encoding` must be absent or `identity`.

## Canonical string

The fields below are joined with a single `\n` (no trailing newline) and
encoded as ASCII:

```
DEVORA-HMAC-SHA256
3
<direction>
<key id>
<org id>
<sent-at>
<request id>
<METHOD>
<path>
<query>
<lowercase hex SHA-256 of the exact body bytes>
```

`signature = lowercase_hex(HMAC-SHA256(secret, canonical))`

- **Path**: the raw, percent-encoded path. For `devora-to-customer` it is
  relative to your SDK mount (the mount prefix is not signed, so proxies may
  rewrite it). Path parameters are encoded strictly: every byte outside
  `A-Z a-z 0-9 - _ . ~` becomes `%XX` with uppercase hex. `""`, `.` and `..`
  cannot be sent.
- **Query**: everything after the first `?`, byte for byte, in the order sent.
  Order is authenticated; repeated keys keep their order.
- **Body**: the SHA-256 of the exact bytes received, before any decoding.
  An empty body hashes to `e3b0c442…b855`. `{}`, `[]` and `null` are distinct.

## Verification order

1. Parse the headers (any missing, repeated or malformed header is rejected).
2. Key id and org id must equal your configuration.
3. `|now - sent-at|` must be within the tolerance (default 300 s; an integer;
   `0` means the current second only).
4. The path and query must be printable ASCII with uppercase escapes, no
   empty or dot segments, and no fragment.
5. Hash the body bytes, build the canonical string with the verifier's own
   direction, and compare signatures in constant time.
6. Claim the request id from Devora (`POST /api/sdk/request-claim`, see
   [Request claims](#request-claims)). Only after a successful claim parse the
   query and the JSON body (strict UTF-8) and run your handler. Duplicate
   object keys, including escaped spellings of the same key, non-finite numbers
   and a UTF-8 BOM are rejected. JavaScript objects are recursively given null
   prototypes.

Encoded dot segments are rejected too. Query percent escapes must decode as
valid UTF-8; lone surrogates cannot be supplied to the signer. Header grammar
matches must consume the entire value, including any terminal newline.

Steps 1-5 never contact Devora, so unauthenticated traffic cannot use up
request ids. Unsigned or invalid requests are rejected before route lookup.

## Request claims

Each request id is single use, and Devora is the one place that records it: your
backend stores nothing. After step 5 the SDK sends one signed
`customer-to-devora` request, `POST /api/sdk/request-claim`, with the JSON body
`{ "requestId": "<request id>", "sentAt": "<sent-at>" }`. For the impersonation
start request (`POST /impersonate/:id`) the SDK reads `sessionId` from the
already verified body and adds it, so the start can be claimed only while
Devora is still starting that session. The first claim of a request id wins.
The claim has a 3-second deadline (`REQUEST_CLAIM.TIMEOUT_MS` in
`@devorash/core`, `REQUEST_CLAIM_TIMEOUT_SECONDS` in `devora-python`).

| Devora's answer                       | SDK result                                | Status |
| ------------------------------------- | ----------------------------------------- | ------ |
| Claimed                               | Run the handler                           | -      |
| Request id already claimed            | `REPLAYED_REQUEST`                        | 401    |
| Session no longer starting            | `SESSION_NOT_STARTABLE`                   | 409    |
| Request too old to claim              | `TIMESTAMP_EXPIRED`                       | 401    |
| Unreachable, timeout or anything else | `REQUEST_CLAIM_UNAVAILABLE` (fail closed) | 503    |

Your backend therefore needs outbound HTTPS access to the Devora API. Every
signed Devora request is claimed, including `/test` and `/health`, so Devora's
**Test connection** check also proves that access.

## Framework notes

- **Express**: mount the Devora adapter before any application-wide body
  parser. A body another parser already consumed is rejected with
  `DEVORA_BODY_ALREADY_PARSED`.
- **Fastify**: the plugin registers its own raw-body parser inside its
  encapsulated scope; your application's parsers are unaffected.
- **Django / FastAPI**: the adapters read the raw path from ASGI `raw_path` or
  WSGI `RAW_URI`/`REQUEST_URI`. Starlette and Django route on decoded paths, so
  a user id containing `/` cannot reach a route there.
