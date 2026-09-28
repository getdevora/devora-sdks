/**
 * Devora SDK Core
 * Shared types, constants, and utilities for all Devora SDKs
 *
 * @packageDocumentation
 * @module @devorash/core
 */

// ============================================================================
// Types
// ============================================================================

export type {
	// Request & Response
	DevoraRequest,
	DevoraResponse,
	// User Search
	DevoraUser,
	UserSearchRequest,
	UserSearchResponse,
	// Impersonation
	ImpersonationScope,
	ImpersonationDuration,
	DevoraImpersonationContext,
	ImpersonationStartRequest,
	ImpersonationStartResponse,
	ImpersonationTerminateRequest,
	ImpersonationTerminateResponse,
	// Frontend SDK
	ImpersonationUserInfo,
	ImpersonatePayload,
	ImpersonateCallback,
	SessionEndCallback,
	FrontendSDKConfig,
	ErrorHandlers,
	PayloadError,
	ScopeViolation,
	// Recording privacy & capture policy
	DevoraMaskingProfile,
	DevoraCapturePolicy,
	DevoraCaptureSnapshot,
	// Backend SDK
	BackendSDKConfig,
	RouteHandler,
	RouteDefinition,
	// Logging
	LogEventType,
	LogEvent,
	// SDK Info
	SDKInfo,
	HealthCheckResponse,
	ConnectionTestResponse,
	SessionBridgeResult,
	BrowserResumeCode,
} from "./types/index.js"

export { DEVORA_PRIVACY_MARKERS } from "./types/index.js"

// ============================================================================
// Constants
// ============================================================================

export {
	// Endpoints
	DEVORA_ENDPOINTS,
	ENDPOINT_METHODS,
	PROTECTED_ENDPOINTS,
	type DevoraEndpointKey,
	type DevoraEndpointPath,
	// Headers
	SECURITY_HEADERS,
	FRONTEND_HEADERS,
	// URL & Storage
	URL_PARAMS,
	BROWSER_SESSION_BRIDGE,
	// Defaults
	SDK_DEFAULTS,
	// Metadata
	SDK_PACKAGES,
	SDK_VERSION,
	// Error codes
	ERROR_CODES,
	type DevoraErrorCode,
	// HTTP Methods
	WRITE_METHODS,
	READ_METHODS,
	type WriteMethod,
	type ReadMethod,
	// Session Lifecycle
	SDK_END_REASON,
	type SDKEndReason,
} from "./constants/index.js"

// ============================================================================
// Security
// ============================================================================

export {
	// Timestamps
	validateTimestamp,
	isValidTimestampTolerance,
	assertTimestampTolerance,
	// Scope
	isWriteMethod,
	matchEndpointPattern,
	normalizeRequestPath,
	isAmbiguousRequestPath,
	getRawRequestPath,
	METHOD_OVERRIDE_HEADERS,
	getPolicyMethods,
	getDenyMethods,
	joinMountedTarget,
	createBlockedResponse,
	// Tokens
	generateRandomString,
	arrayBufferToHex,
	hexToArrayBuffer,
	// Errors
	DevoraSDKError,
	DevoraSecurityError,
	DevoraValidationError,
	DevoraConfigError,
	DevoraNetworkError,
} from "./security/index.js"

// Request signing (v3)
export {
	SIGNING,
	SIGNED_HEADER_PATTERNS,
	strictEncode,
	encodePathParam,
	buildStrictQuery,
	isValidSignedPath,
	isValidSignedQuery,
	buildCanonicalString,
	getSingleHeader,
	parseSignatureHeaders,
	hasIdentityContentEncoding,
	replayNamespace,
	replayExpiresAtMs,
	parseVerifiedQuery,
	parseVerifiedJsonBody,
	routeRelativePath,
	type SigningDirection,
	type SignatureErrorCode,
	type HeaderMap,
	type SignatureHeaders,
	type SignatureHeaderResult,
	type CanonicalFields,
	type VerifiedBodyResult,
} from "./security/signing.js"

// ============================================================================
// Utilities
// ============================================================================

export {
	// Response helpers
	createSuccessResponse,
	createErrorResponse,
	// URL helpers
	extractUrlParams,
	cleanImpersonationParams,
	// Path matching
	matchPath,
	extractPathParams,
	// Query string
	// Header utilities
	getHeaderValue,
	getErrorStatusCode,
	// Request canonicalization (for HMAC)
	// Rate limiting
	RateLimiter,
	// Scope helpers
	scopeAllowsWrite,
	getScopeDescription,
	// Logging
	createLogEvent,
	// SDK info
	createSDKInfo,
	// Logger service
	LogLevel,
	configureLogger,
	getLoggerConfig,
	resetLoggerConfig,
	createLogger,
	type LoggerConfig,
	type LogHandler,
	type Logger,
	// Validation
	validateApiKeyFormat,
	validateOrgIdFormat,
	// Misc
	safeJsonParse,
	safeJsonStringify,
	deepFreeze,
	createDeferred,
} from "./utils/index.js"

export { readBoundedBody, readBoundedBytes, BodyReadError } from "./security/request-body.js"
