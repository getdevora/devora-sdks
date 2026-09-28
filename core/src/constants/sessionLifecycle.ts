/**
 * Session Lifecycle Constants for SDK
 *
 * These constants are used by the frontend SDK when ending sessions.
 * They match the backend expectations.
 */

/**
 * Reasons the SDK can send when ending a session.
 * These are mapped by the backend to EndReason values.
 */
export const SDK_END_REASON = {
	/** User clicked the "End Session" button in the customer app */
	USER_ENDED: "user_ended",
	/** Frontend timer detected that the session has expired */
	EXPIRED: "expired",
	/** Session was terminated externally (detected via validation check) */
	TERMINATED_EXTERNALLY: "terminated_externally",
	/** Page is being unloaded (beforeunload event) */
	PAGE_UNLOAD: "page_unload",
} as const

export type SDKEndReason = (typeof SDK_END_REASON)[keyof typeof SDK_END_REASON]
