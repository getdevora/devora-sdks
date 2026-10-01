# devora-python

Recording, masking and capture policy are configured in the Devora dashboard and
authorized server-side for each session. This backend SDK takes no capture
settings, and `devora_sdk()` ignores keyword arguments it does not recognize,
so check option names carefully. See
[capture settings](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Python backend core SDK for Devora customer integrations.

## Requirements

- Python `>=3.10,<4.0`
- Outbound HTTPS access from your backend to the Devora API

## Install

```bash
pip install devora-python
```

## Quick Start

```python
import os
from dataclasses import asdict

from devora_sdk import DEVORA_ENDPOINTS, devora_sdk

sdk = devora_sdk(
    api_key=os.environ["DEVORA_API_KEY"],  # pk_server_live_...
    secret_key=os.environ["DEVORA_SECRET_KEY"],  # sk_server_live_...
    org_id=os.environ["DEVORA_ORG_ID"],
)


@sdk.register(DEVORA_ENDPOINTS.USER_SEARCH)
def search_users(req):
    # Match name, email and the exact user ID with a parameterised query.
    term = req.query.get("term", "")
    limit = int(req.query.get("limit", 10))
    users = search_customer_users(term, limit)
    return {
        "users": [
            {
                "id": u.id,
                "name": u.name,
                "email": u.email,
                "attributes": {"company": u.company, "role": u.role, "plan": u.plan},
            }
            for u in users
        ]
    }


@sdk.register(DEVORA_ENDPOINTS.IMPERSONATE)
def impersonate(req):
    ctx = req.devora_context
    if not ctx:
        raise ValueError("Missing impersonation context")
    # Store the whole verified context in the token: the scope guard reads every
    # field of it back. Expire the token no later than ctx.expires_at.
    devora = {**asdict(ctx), "is_impersonation": True}
    token = create_customer_token(ctx.target_user["id"], devora)
    return {"token": token}


@sdk.register(DEVORA_ENDPOINTS.TERMINATE)
def terminate(req):
    session_id = req.params["id"]
    reason = (req.body or {}).get("reason")
    # YOU IMPLEMENT: mark this Devora session revoked so every credential issued for it
    # is rejected, including one issued after this call. Must be idempotent: Devora
    # retries with a new request id (up to 5 attempts over 6 hours).
    auth.revoke_impersonation_session(session_id=session_id, reason=reason)
    return {"success": True}
```

User search should match name, email and the exact user ID. `attributes` are optional display fields such as company, role or plan: up to 12 per user, lowercase keys like `last_login`, and string, number, boolean or `null` values. Devora drops invalid entries silently; see [Search results and templates](https://docs.devora.sh/guide/search-results) for the limits and how your team lays out results.

Each verified request is claimed once from Devora before your handler runs, so
replay protection needs no storage on your side; your backend only needs
outbound HTTPS access to the Devora API. See [Replay protection](#replay-protection).

Register every handler, then mount the SDK with the
[Django](https://pypi.org/project/devora-django/) or
[FastAPI](https://pypi.org/project/devora-fastapi/) adapter. For any other
framework, pass the request exactly as received to `process_request` (sync) or
`await async_process_request` (async):

```python
from devora_sdk import AdapterRequest, process_request
from devora_sdk.utils import get_error_status_code


def handle_devora(method: str, path: str, query: str, body: bytes, headers) -> tuple[int, dict]:
    # path: still percent-encoded and relative to your Devora mount, e.g. "/user/search"
    # query: the raw query string without "?"; body: the raw bytes (cap the read yourself)
    # headers: a mapping, or (name, value) pairs so duplicate headers stay visible
    result = process_request(sdk, sdk.get_routes(), AdapterRequest(method, path, query, body, headers))
    status = 200 if result["success"] else get_error_status_code(result.get("errorCode"))
    return status, result  # send as JSON with Cache-Control: private, no-store
```

`async_process_request` runs signature verification, the request claim and
synchronous handlers in a worker thread, so it never blocks the event loop.
`process_request` cannot run `async def` handlers.

### Replay protection

Every signed request carries a single-use id. After the signature verifies, the
SDK claims that id from Devora with one signed call
(`POST /api/sdk/request-claim`, `REQUEST_CLAIM_TIMEOUT_SECONDS = 3.0`); the
handler runs only after a successful claim. Only requests whose signature
verified are ever claimed, so unauthenticated traffic cannot use up request
ids. The claim can fail with:

| Status | `errorCode`                 | Cause                                                                    |
| ------ | --------------------------- | ------------------------------------------------------------------------ |
| 401    | `REPLAYED_REQUEST`          | Devora already claimed this request id (the request was already processed) |
| 409    | `SESSION_NOT_STARTABLE`     | Start request for a session Devora is no longer starting                 |
| 401    | `TIMESTAMP_EXPIRED`         | Devora says the request is too old to claim                              |
| 503    | `REQUEST_CLAIM_UNAVAILABLE` | Devora could not be reached or gave no clear answer (fails closed)       |

Devora's **Test connection** check is claimed too, so it also proves your
backend can reach the Devora API. See
[SIGNING.md](https://github.com/getdevora/devora-sdks/blob/main/SIGNING.md#request-claims).

### Session termination

Devora calls `DELETE /impersonate/:id/terminate` when a session ends. The
session id is `req.params["id"]` (also `req.session_id`), and the body is
`{"reason": ..., "terminatedBy": ...}`. `terminatedBy` is the external user id
of the person who ended the session and is absent for automatic ends. `reason`
is one of `user_ended`, `time_limit`, `admin_terminated`, `superseded`,
`request_revoked`, `membership_revoked`, `role_downgraded`,
`workos_session_revoked`, `principal_erased`, `organization_erased`,
`start_failed` (Devora sent the start request, and your handler may have issued
a token, but the session never started) or `not_started` (your handler issued a
token but the impersonation link was never opened).

Devora retries a failed terminate call (up to 5 attempts over 6 hours, with
backoff), each as a new signed request with a new request id, so the handler
must be idempotent; any 2xx counts as delivered. A 4xx other than 408, 425 or 429 is
not retried; when overloaded, answer 429 or 503 with `Retry-After`. Store the
Devora session id with the credential you mint and revoke by session, so a
credential minted by a slow start handler after the terminate is still rejected. See
[Session lifecycle & cleanup](https://docs.devora.sh/guide/session-lifecycle).

The guard's session-liveness checker caches at most 1,024 results and permits at
most 64 distinct concurrent lookups per checker. Requests for the same session
share a lookup. Live/ended results use the configured TTL (five seconds by
default); unavailable results use at most one second. Cache hits never extend a
verdict's lifetime. Capacity exhaustion follows the configured unavailable
policy, which denies access by default.

### Cold-start latency

The impersonation guard's scope policy is fetched lazily on first use, so the
first request handled by a freshly started worker process pays for that fetch
synchronously (and any request racing it gets a `503
IMPERSONATION_POLICY_UNAVAILABLE` rather than waiting). If your deployment
runs multiple worker processes (gunicorn, uWSGI, etc.), pass
`prefetch_scope_config=True` to start that fetch in a background thread as soon
as `devora_sdk(...)` is constructed, so the cache is usually warm by the first
request:

```python
sdk = devora_sdk(
    api_key=os.environ["DEVORA_API_KEY"],
    secret_key=os.environ["DEVORA_SECRET_KEY"],
    org_id=os.environ["DEVORA_ORG_ID"],
    prefetch_scope_config=True,
)
```

Options, error codes and the guard are documented in the
[Python reference](https://docs.devora.sh/reference/python).
