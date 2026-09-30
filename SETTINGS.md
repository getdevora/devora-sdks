# Capture settings

Recording, masking, activity and media preferences are configured by an organization administrator in the Devora dashboard under **Settings → Recording** and **Settings → Masking**. SDK options and the customer backend's `recordingAllowed` response field do not override the session capture policy. Each session retains its server-owned settings snapshot until it ends.

Use the normal SDK or framework provider API. Add mask, block and reveal selectors in **Settings → Masking**; `data-devora-*` markers alone do not reveal or capture content. Backend authorization and replay protection are independent of browser telemetry, which is not tamper-proof.

Endpoint rules live under **Developer → Endpoint rules**, and allowed browser origins for client keys under **Developer → Integration**. Never put a server key ID or secret in frontend code: create client and server keys separately under **Developer → API keys**. Backend integrations must validate signed requests and enforce session scope.
