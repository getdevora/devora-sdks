# devora-django

Recording, masking and activity preferences are configured in Devora Settings.
SDK initialization overrides are ignored. New sessions retain the server's policy
snapshot across exchange and resume. Developer privacy labels take effect only
when selected in Settings; sensitive-field protection remains mandatory.
See [migration details](https://github.com/getdevora/devora-sdks/blob/main/SETTINGS.md).

Django adapter for the Devora Python backend SDK.

## Requirements

- Python `>=3.10,<4.0`
- Django `>=5.2,<7.0`

## Install

```bash
pip install devora-python devora-django
```

## Quick Start

```python
# devora_integration.py
from devora_sdk import DEVORA_ENDPOINTS, devora_sdk

sdk = devora_sdk(
    api_key="pk_server_live_...",
    secret_key="sk_server_live_...",
    org_id="org_...",
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

Use `async_django_urlpatterns(sdk)` instead when your exposed handlers are
async functions.

For protected application routes, install the guard middleware and extract a
trusted impersonation context from your authenticated request state.

```python
from devora_sdk import ImpersonationContext
from devora_sdk_django import create_impersonation_guard
from .devora_integration import sdk


def get_impersonation_context(request):
    devora = getattr(request.user, "devora", None)
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


DevoraGuardMiddleware = create_impersonation_guard(
    sdk=sdk,
    get_impersonation_context=get_impersonation_context,
)
```

Add `"yourapp.devora_integration.DevoraGuardMiddleware"` to `settings.MIDDLEWARE`,
after your own authentication middleware.

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
