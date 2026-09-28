# Capture settings

Recording, masking, activity and media preferences are configured in the Devora dashboard. SDK options do not override the session capture policy. Each session retains its server-owned settings snapshot until it ends.

Use the normal SDK or framework provider API. Configure mask and block selectors in Settings; HTML markers alone do not reveal or capture content. Backend authorization and replay protection are independent of browser telemetry, which is not tamper-proof.

Never put a server secret in frontend code. Generate client and server keys separately in the integration setup. Backend integrations must validate signed requests and enforce session scope.
