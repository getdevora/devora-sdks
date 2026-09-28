"use client"

/**
 * Devora Next.js client surface.
 *
 * Re-exports the React provider, hooks, and components from `@devorash/react`.
 * This module carries the `"use client"` boundary, so you can import it directly into
 * a Server Component tree:
 *
 * @example
 * ```tsx
 * import { DevoraProvider, ImpersonationBanner } from "@devorash/nextjs/client";
 * ```
 *
 * @packageDocumentation
 * @module @devorash/nextjs/client
 */

export * from "@devorash/react"
