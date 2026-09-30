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
- In production, a replay store shared by every worker (the example below uses
  Redis 6.2 or newer, for `SET ... PXAT`)

## Install

```bash
pip install devora-python devora-fastapi redis
```

## Quick Start

```python
import os

import redis
from fastapi import FastAPI
from devora_sdk import DEVORA_ENDPOINTS, devora_sdk
from devora_sdk_fastapi import fastapi_router

# Replay protection shared by every worker and instance (required in production).
redis_client = redis.Redis.from_url(os.environ["REDIS_URL"])


class RedisReplayStore:
    def consume(self, namespace: str, request_id: str, expires_at: int) -> bool:
        # Atomic insert-if-absent kept until expires_at; an exception makes the SDK fail closed (503).
        key = f"devora:replay:{namespace}:{request_id}"
        return bool(redis_client.set(key, b"1", nx=True, pxat=expires_at))


sdk = devora_sdk(
    api_key=os.environ["DEVORA_API_KEY"],  # pk_server_live_...
    secret_key=os.environ["DEVORA_SECRET_KEY"],  # sk_server_live_...
    org_id=os.environ["DEVORA_ORG_ID"],
    replay_store=RedisReplayStore(),
)


@sdk.register(DEVORA_ENDPOINTS.USER_SEARCH)
async def search_users(req):
    return {"users": await search_customer_users(req.query.get("term", ""))}


app = FastAPI()
app.include_router(fastapi_router(sdk), prefix="/devora")
```

Register every handler before calling `fastapi_router(sdk)`; routes registered
later are not mounted. Handlers may be sync or async; sync handlers run in a
worker thread.

The environment comes from `environment=`, else `DEVORA_ENV`, else `NODE_ENV`.
Anything other than `development` or `test` (including unset) is production,
and production refuses to start without a `replay_store`. Any store whose
`consume` is an atomic insert-if-absent shared by every worker works; see the
[replay-store contract](https://github.com/getdevora/devora-sdks/blob/main/SIGNING.md#replay-store).
`consume` must be a regular method: the SDK calls it from a worker thread, so
use the synchronous `redis.Redis` client even in an async app. An
`async def consume` fails closed with a 503.

**Local development only:** to run without Redis, omit `replay_store` and set
`DEVORA_ENV=development` (or pass `environment="development"`). The SDK then
keeps request ids in memory, which protects a single process only. Never use
this in production.

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
