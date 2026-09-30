# devora-python

Recording, masking and capture policy are configured in the Devora dashboard and
authorized server-side for each session. This backend SDK takes no capture
settings, and `devora_sdk()` ignores keyword arguments it does not recognize,
so check option names carefully. See
[capture settings](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Python backend core SDK for Devora customer integrations.

## Requirements

- Python `>=3.10,<4.0`
- In production, a replay store shared by every worker (the example below uses
  Redis 6.2 or newer, for `SET ... PXAT`)

## Install

```bash
pip install devora-python redis
```

## Quick Start

```python
import os
from dataclasses import asdict

import redis
from devora_sdk import DEVORA_ENDPOINTS, devora_sdk

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
def search_users(req):
    return {"users": search_customer_users(req.query.get("term", ""))}


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
```

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

`async_process_request` runs signature verification, the replay store and
synchronous handlers in a worker thread, so it never blocks the event loop.
`process_request` cannot run `async def` handlers.

### Production replay store

Every signed request carries a single-use id. In production the SDK needs a
shared, atomic `replay_store` so a captured request cannot be replayed against
another worker or instance. The environment comes from `environment=`, else
`DEVORA_ENV`, else `NODE_ENV`. Anything other than `development` or `test`
(including unset) is production, and production refuses to start without a
`replay_store`. Any store whose `consume` is an atomic insert-if-absent works;
see the
[replay-store contract](https://github.com/getdevora/devora-sdks/blob/main/SIGNING.md#replay-store).

**Local development only:** to run without Redis, omit `replay_store` and set
`DEVORA_ENV=development` (or pass `environment="development"`). The SDK then
keeps request ids in memory, which protects a single process only. Never use
this in production.

`consume` must be a regular method returning `True` or `False`; the SDK calls
it synchronously, including from `async_process_request` (in a worker thread).
Use a synchronous client such as `redis.Redis`: an `async def consume` fails
closed with a 503. Keep it a single short round trip, and do not let the store
evict these keys before they expire. A unique-key database insert with an
expiry column works too.

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
    replay_store=RedisReplayStore(),
    prefetch_scope_config=True,
)
```

Options, error codes and the guard are documented in the
[Python reference](https://docs.devora.sh/reference/python).
