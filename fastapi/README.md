# devora-fastapi

Recording, masking and activity preferences are configured in Devora Settings.
SDK initialization overrides are ignored. New sessions retain the server's policy
snapshot across exchange and resume. Developer privacy labels take effect only
when selected in Settings; sensitive-field protection remains mandatory.
See [migration details](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

FastAPI adapter for the Devora Python backend SDK.

## Requirements

- Python `>=3.10,<4.0`
- FastAPI `>=0.100.0,<1.0.0`

## Install

```bash
pip install devora-python devora-fastapi
```

## Quick Start

```python
from fastapi import FastAPI
from devora_sdk import DEVORA_ENDPOINTS, devora_sdk
from devora_sdk_fastapi import fastapi_router

sdk = devora_sdk(
    api_key="pk_server_live_...",
    secret_key="sk_server_live_...",
    org_id="org_...",
)


@sdk.register(DEVORA_ENDPOINTS.USER_SEARCH)
async def search_users(req):
    return {"users": await search_customer_users(req.query.get("term", ""))}


app = FastAPI()
app.include_router(fastapi_router(sdk), prefix="/devora")
```

For protected application routes, install the guard middleware and extract a
trusted impersonation context from authenticated request state.

```python
from devora_sdk import ImpersonationContext
from devora_sdk_fastapi import DevoraImpersonationGuardMiddleware


def get_impersonation_context(request) -> ImpersonationContext | None:
    devora = getattr(request.state, "devora", None)
    if not devora:
        return None
    return ImpersonationContext(
        is_impersonation=devora["isImpersonation"],
        scope=devora["scope"],
        session_id=devora["sessionId"],
        expires_at=devora["expiresAt"],
        actor=devora["actor"],
        subject=devora["subject"],
        auth_method=devora["authMethod"],
        authorization_source=devora["authorizationSource"],
        recording_allowed=devora["recordingAllowed"],
        impersonator=devora.get("impersonator"),
    )


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
