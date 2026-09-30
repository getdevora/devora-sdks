# devora-django

Recording, masking and capture policy are configured in the Devora dashboard and
authorized server-side for each session. This backend SDK takes no capture
settings, and `devora_sdk()` ignores keyword arguments it does not recognize,
so check option names carefully. See
[capture settings](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Django adapter for the Devora Python backend SDK.

## Requirements

- Python `>=3.10,<4.0`
- Django `>=5.2.17,<7.0`, excluding `6.0.0` through `6.0.7` (on Django 6.0, use `6.0.8` or newer)
- In production, a replay store shared by every worker (the example below uses
  Redis 6.2 or newer, for `SET ... PXAT`)

## Install

```bash
pip install devora-python devora-django redis
```

## Quick Start

```python
# devora_integration.py
import os

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
```

```python
# urls.py
from django.urls import include, path
from devora_sdk_django import django_urlpatterns
from .devora_integration import sdk

urlpatterns = [
    path("devora/", include(django_urlpatterns(sdk))),
]
```

Register every handler before building the URL patterns; routes registered
later are not mounted. If any handler is an `async def` function, use
`async_django_urlpatterns(sdk)` instead (it runs sync handlers in a worker
thread too); `django_urlpatterns` answers an async handler with
`400 HANDLER_ERROR`.

The environment comes from `environment=`, else `DEVORA_ENV`, else `NODE_ENV`.
Anything other than `development` or `test` (including unset) is production,
and production refuses to start without a `replay_store`. Any store whose
`consume` is an atomic insert-if-absent shared by every worker works; see the
[replay-store contract](https://github.com/getdevora/devora-sdks/blob/main/SIGNING.md#replay-store).
`consume` must be a regular (not `async def`) method.

**Local development only:** to run without Redis, omit `replay_store` and set
`DEVORA_ENV=development` (or pass `environment="development"`). The SDK then
keeps request ids in memory, which protects a single process only. Never use
this in production.

For protected application routes, install the guard middleware and return the
context dict your `IMPERSONATE` handler stored, read back from your
authenticated request state.

```python
# devora_guard.py
from devora_sdk_django import create_impersonation_guard
from .devora_integration import sdk


def get_impersonation_context(request):
    # YOU IMPLEMENT: return the dict your IMPERSONATE handler stored, read from
    # your verified session (never from headers or JSON the browser can set), or None.
    return getattr(request.user, "devora", None)


DevoraGuardMiddleware = create_impersonation_guard(
    sdk=sdk,
    get_impersonation_context=get_impersonation_context,
)
```

Add `"yourapp.devora_guard.DevoraGuardMiddleware"` to `settings.MIDDLEWARE`,
after your own authentication middleware, so `request.user` is set when the
guard runs.

`expires_at` must be a Unix timestamp in milliseconds. If your JWT stores Unix
seconds, multiply by `1000` when building the impersonation context. `actor`,
`subject`, `auth_method`, `authorization_source`, and `recording_allowed` are
all required — the guard rejects the context as invalid without them, even
though the dataclass marks them optional for construction convenience.

## Cross-Origin-Opener-Policy

Django's `SecurityMiddleware` sends `Cross-Origin-Opener-Policy: same-origin`
by default. That cuts the page opened by a Devora impersonation link off from
the dashboard tab that opened it, so the link cannot be redeemed. Set
`SECURE_CROSS_ORIGIN_OPENER_POLICY = None`, or send `unsafe-none` on the
route your Devora links land on.

## Request body limits

SDK views read at most `max_body_size + 1` bytes before parsing (1 MiB by default)
and reject oversized declared lengths without reading. The browser-session view
uses a 4 KiB limit. Async SDK views perform this bounded read off the event loop.
Set `DATA_UPLOAD_MAX_MEMORY_SIZE = 1024 * 1024` and keep earlier middleware from
buffering larger SDK bodies. WSGI/ASGI servers and reverse proxies also need
request-size and read-timeout limits: Django's ASGI handler can spool a request
before a view runs, and the SDK cannot bound that prior allocation.

Options, error codes and the browser-session bridge are documented in the
[Python reference](https://docs.devora.sh/reference/python).
