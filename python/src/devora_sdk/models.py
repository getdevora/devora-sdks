from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, MutableMapping, Optional


@dataclass(frozen=True)
class DevoraImpersonationContext:
	session_id: str
	scope: str
	expires_at: int
	impersonator: dict[str, Any]
	target_user: dict[str, Any]
	auth_method: str
	authorization_source: str
	recording_allowed: bool

	@property
	def actor(self) -> dict[str, Any]:
		return self.impersonator

	@property
	def subject(self) -> dict[str, Any]:
		return self.target_user


@dataclass(frozen=True)
class DevoraRequest:
	method: str
	path: str
	params: Mapping[str, str]
	query: Mapping[str, Any]
	body: Any
	headers: Mapping[str, Any]
	org_id: str
	key_id: str
	session_id: Optional[str] = None
	devora_context: Optional[DevoraImpersonationContext] = None


DevoraResponse = dict[str, Any]
RouteHandler = Callable[[DevoraRequest], Any]


@dataclass(frozen=True)
class SDKRoute:
	path: str
	method: str
	handler: RouteHandler
	is_built_in: bool = False


@dataclass
class SDKStats:
	total_requests: int = 0
	successful_requests: int = 0
	failed_requests: int = 0
	security_errors: int = 0
	requests_by_endpoint: MutableMapping[str, int] = field(default_factory=dict)

	def to_dict(self) -> dict[str, Any]:
		return {
			"totalRequests": self.total_requests,
			"successfulRequests": self.successful_requests,
			"failedRequests": self.failed_requests,
			"securityErrors": self.security_errors,
			"requestsByEndpoint": dict(self.requests_by_endpoint),
		}


@dataclass(frozen=True)
class ValidationResult:
	valid: bool
	error: Optional[str] = None
	error_code: Optional[str] = None
	org_id: Optional[str] = None
	key_id: Optional[str] = None
	timestamp: Optional[int] = None
	request_id: Optional[str] = None
