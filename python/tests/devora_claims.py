"""A fake Devora for backend SDK tests. ``POST /api/sdk/request-claim`` behaves
like the real endpoint: the claim call must be signed customer-to-devora with
the test key, and the first claim of a request id wins. Every other Devora URL
goes to the real transport. Mirrors packages/sdks/test/support/devora-claims.ts."""
from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any, Callable, Mapping, Optional

from signing_support import API_KEY, ORG_ID, SECRET_KEY

CLAIM_PATH = "/api/sdk/request-claim"


class FakeDevora:
	def __init__(self) -> None:
		self.reset()

	def reset(self) -> None:
		self.claimed: set[str] = set()
		# Every well-signed claim received, in order.
		self.calls: list[dict[str, Any]] = []
		# Force the reply to the next claims; None restores first-claim-wins.
		self.reply: Optional[str] = None
		# Session ids Devora no longer starts.
		self.not_startable: set[str] = set()

	def handle(
		self,
		original: Callable[..., Any],
		url: str,
		method: str,
		headers: Mapping[str, str],
		body: Optional[bytes] = None,
		*args: Any,
		**kwargs: Any,
	) -> tuple[int, Optional[dict[str, Any]], Mapping[str, str]]:
		if not url.endswith(CLAIM_PATH):
			return original(url, method, headers, body, *args, **kwargs)
		raw = body or b""
		if not _signature_valid(headers, raw):
			return 401, {"success": False, "code": "INVALID_SIGNATURE"}, {}
		call = json.loads(raw)
		self.calls.append(call)

		def reject(code: str) -> tuple[int, dict[str, Any], Mapping[str, str]]:
			return 409, {"success": False, "error": "Request cannot be claimed", "errorCode": code}, {}

		forced = {
			"replayed": lambda: reject("REPLAYED_REQUEST"),
			"not-startable": lambda: reject("SESSION_NOT_STARTABLE"),
			"timestamp-expired": lambda: reject("TIMESTAMP_EXPIRED"),
			"unavailable": lambda: (503, {"success": False, "error": "Claim unavailable"}, {}),
			"malformed": lambda: (200, {"success": True, "data": {"claimed": "yes"}}, {}),
			"claimed": lambda: (200, {"success": True, "data": {"claimed": True}}, {}),
		}
		if self.reply == "network-error":
			from devora_sdk.transport import ControlPlaneError

			raise ControlPlaneError("Devora is unreachable")
		if self.reply is not None:
			return forced[self.reply]()
		if call.get("sessionId") in self.not_startable:
			return reject("SESSION_NOT_STARTABLE")
		if call["requestId"] in self.claimed:
			return reject("REPLAYED_REQUEST")
		self.claimed.add(call["requestId"])
		return 200, {"success": True, "data": {"claimed": True}}, {}


def _signature_valid(headers: Mapping[str, str], body: bytes) -> bool:
	canonical = "\n".join(
		[
			"DEVORA-HMAC-SHA256",
			"3",
			"customer-to-devora",
			headers.get("x-devora-key-id", ""),
			headers.get("x-devora-org-id", ""),
			headers.get("x-devora-sent-at", ""),
			headers.get("x-devora-request-id", ""),
			"POST",
			CLAIM_PATH,
			"",
			hashlib.sha256(body).hexdigest(),
		]
	)
	expected = hmac.new(SECRET_KEY.encode("ascii"), canonical.encode("ascii"), hashlib.sha256).hexdigest()
	return (
		headers.get("x-devora-key-id") == API_KEY
		and headers.get("x-devora-org-id") == ORG_ID
		and hmac.compare_digest(headers.get("x-devora-signature", ""), expected)
	)


DEVORA = FakeDevora()
