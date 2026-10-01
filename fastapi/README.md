# devora-fastapi

Recording, masking and capture policy are configured in the Devora dashboard and
authorized server-side for each session. This backend SDK takes no capture
settings, and `devora_sdk()` ignores keyword arguments it does not recognize,
so check option names carefully. See
[capture settings](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

FastAPI adapter for the Devora Python backend SDK.

## Requirements

- Python `>=3.10,<4.0`
- FastAPI `>=0.133.0,<1.0.0`
- Outbound HTTPS access from your backend to the Devora API

## Install

```bash
pip install devora-python devora-fastapi
```

## Quick Start

```python
import os

from fastapi import FastAPI
from devora_sdk import DEVORA_ENDPOINTS, devora_sdk
from devora_sdk_fastapi import fastapi_router


sdk = devora_sdk(
    api_key=os.environ["DEVORA_API_KEY"],  # pk_server_live_...
    secret_key=os.environ["DEVORA_SECRET_KEY"],  # sk_server_live_...
    org_id=os.environ["DEVORA_ORG_ID"],
)


@sdk.register(DEVORA_ENDPOINTS.USER_SEARCH)
async def search_users(req):
    # Match name, email and the exact user ID with a parameterised query.
    term = req.query.get("term", "")
    limit = int(req.query.get("limit", 10))
    users = await search_customer_users(term, limit)
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


@sdk.register(DEVORA_ENDPOINTS.TERMINATE)
async def terminate(req):
    session_id = req.params["id"]
    reason = (req.body or {}).get("reason")
    # YOU IMPLEMENT: mark this Devora session revoked so every credential issued for it
    # is rejected, including one issued after this call. Must be idempotent: Devora
    # retries with a new request id (up to 5 attempts over 6 hours).
    await auth.revoke_impersonation_session(session_id=session_id, reason=reason)
    return {"success": True}


app = FastAPI()
app.include_router(fastapi_router(sdk), prefix="/devora")
```

User search should match name, email and the exact user ID. `attributes` are optional display fields such as company, role or plan: up to 12 per user, lowercase keys like `last_login`, and string, number, boolean or `null` values. Devora drops invalid entries silently; see [Search results and templates](https://docs.devora.sh/guide/search-results) for the limits and how your team lays out results.

Register every handler before calling `fastapi_router(sdk)`; routes registered
later are not mounted. Handlers may be sync or async; sync handlers run in a
worker thread.

Each verified request is claimed once from Devora before your handler runs, so
replay protection needs no storage on your side; your backend only needs
outbound HTTPS access to the Devora API. See
[SIGNING.md](https://github.com/getdevora/devora-sdks/blob/main/SIGNING.md#request-claims).

The terminate body is `{"reason": ..., "terminatedBy": ...}`; Devora retries a
failed call (up to 5 attempts over 6 hours) with a new request id, so keep the
handler idempotent. Return a 2xx, or 429/503 with `Retry-After` when overloaded; any
other 4xx stops the retries. See
[Session lifecycle & cleanup](https://docs.devora.sh/guide/session-lifecycle).

For protected application routes, install the guard middleware and return the
context dict your `IMPERSONATE` handler stored, read back from your
authenticated request state.

```python
from devora_sdk_fastapi import DevoraImpersonationGuardMiddleware


def get_impersonation_context(request) -> dict | None:
    # YOU IMPLEMENT: return the dict your IMPERSONATE handler stored, read from
    # your auth middleware (never from headers or JSON the browser can set), or None.
    return getattr(request.state, "devora", None)


app.add_middleware(
    DevoraImpersonationGuardMiddleware,
    sdk=sdk,
    get_impersonation_context=get_impersonation_context,
)
```

Register your own authentication middleware **after** this call — Starlette
runs middleware in the reverse of its registration order, so it must be the
outer layer that runs first for `request.state` to carry verified claims by
the time the guard reads them.

Resolve method overrides and route rewrites **before** the guard as well
(register that middleware after this call too, so it runs first). The guard
also judges every `X-HTTP-Method-Override`, `X-HTTP-Method` and
`X-Method-Override` value and any `_method` query parameter, but it cannot see a
`_method` field inside a request body, and it judges the path it receives.

`expires_at` must be a Unix timestamp in milliseconds. If your JWT stores Unix
seconds, multiply by `1000` when building the impersonation context. `actor`,
`subject`, `auth_method`, `authorization_source`, and `recording_allowed` are
all required — the guard rejects the context as invalid without them, even
though the dataclass marks them optional for construction convenience.

Options, error codes and the browser-session bridge are documented in the
[Python reference](https://docs.devora.sh/reference/python).
