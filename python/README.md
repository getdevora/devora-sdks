# devora-python

Recording, masking and activity preferences are configured in Devora Settings.
SDK initialization overrides are ignored. New sessions retain the server's policy
snapshot across exchange and resume. Developer privacy labels take effect only
when selected in Settings; sensitive-field protection remains mandatory.
See [migration details](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Python backend core SDK for Devora customer integrations.

## Requirements

- Python `>=3.10,<4.0`

## Install

```bash
pip install devora-python
```

## Quick Start

```python
from devora_sdk import DEVORA_ENDPOINTS, devora_sdk

sdk = devora_sdk(
    api_key="pk_server_live_...",
    secret_key="sk_server_live_...",
    org_id="org_...",
)

@sdk.register(DEVORA_ENDPOINTS.USER_SEARCH)
def search_users(req):
    return {"users": search_customer_users(req.query.get("term", ""))}

@sdk.register(DEVORA_ENDPOINTS.IMPERSONATE)
def impersonate(req):
    context = req.devora_context
    token = create_customer_token(context.target_user["id"], context)
    return {"token": token}
```

Use `process_request()` for sync frameworks, `async_process_request()` for
async frameworks, or use the Django and FastAPI adapter packages.

### Production replay store

Every signed request carries a single-use id. In production the SDK needs a
shared, atomic `replay_store` so a captured request cannot be replayed against
another worker or instance; the in-memory store is for
`environment="development"` or `"test"` only, and any other environment refuses
to start without one.

```python
import os

import redis
from devora_sdk import devora_sdk

client = redis.Redis.from_url(os.environ["REDIS_URL"])


class RedisReplayStore:
    def consume(self, namespace: str, request_id: str, expires_at: int) -> bool:
        # Atomic insert-if-absent that lives until expires_at (Unix ms).
        # Exceptions propagate: the SDK then fails closed with a 503.
        return bool(
            client.set(f"devora:replay:{namespace}:{request_id}", b"1", nx=True, pxat=expires_at)
        )


sdk = devora_sdk(
    api_key=os.environ["DEVORA_API_KEY"],
    secret_key=os.environ["DEVORA_SECRET_KEY"],
    org_id=os.environ["DEVORA_ORG_ID"],
    replay_store=RedisReplayStore(),
)
```

`consume` is called synchronously, including from `async_process_request`;
keep it a single short round trip. Do not let the store evict these keys
before they expire. A unique-key database insert with an expiry column works
too.

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
`prefetch_scope_config=True` to warm the cache in the background as soon as
`devora_sdk(...)` is constructed, before the process starts serving traffic:

```python
sdk = devora_sdk(
    api_key="pk_server_live_...",
    secret_key="sk_server_live_...",
    org_id="org_...",
    prefetch_scope_config=True,
)
```
