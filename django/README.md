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
- Outbound HTTPS access from your backend to the Devora API

## Install

```bash
pip install devora-python devora-django
```

## Quick Start

```python
# devora_integration.py
import os

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

Blocked API calls get a JSON error. Blocked page loads and form posts (an
`Accept` header with `text/html` and without `application/json`, no JSON body,
not an XHR) get a small, uncached HTML page with the reason and a back link. To show your own template, pass `render_blocked`, a
synchronous function that receives the request, the status code and the error
body and returns a response:

```python
from django.shortcuts import render


def render_blocked(request, status_code, body):
    return render(request, "impersonation_blocked.html", {"error": body.get("error")}, status=status_code)


DevoraGuardMiddleware = create_impersonation_guard(
    sdk=sdk,
    get_impersonation_context=get_impersonation_context,
    render_blocked=render_blocked,
)
```

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
