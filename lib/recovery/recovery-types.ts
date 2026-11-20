/**
 * Shared type helpers for `lib/recovery`. Type-only module: it has no runtime
 * exports, so importers must use `import type`.
 */

/** Row / payload whose shape is validated at runtime, not by the compiler. */
export type LooseRecord = Record<string, any>;

/** An `Error` carrying a stable machine code (`err.code`). */
export type CodedError = Error & { code?: string };

/** What a `catch (err)` block may read from a thrown value. */
export type ThrownLike = { code?: unknown; message?: unknown } | null | undefined;
