import { createHash } from "node:crypto"
import { canonicalize } from "@overturo/sdk"

/** Hex SHA-256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex")
}

/**
 * The receipt's `context_hash`: SHA-256 over the canonical JSON of the context
 * (sorted keys, no insignificant whitespace), the way the platform computes it.
 * An absent context hashes as `{}`.
 */
export function contextHash(context?: Record<string, unknown> | null): string {
  return sha256Hex(canonicalize(context ?? {}))
}

/** The canonical digest of a tool call's arguments — the resumption key's second half. */
export function argumentsDigest(args: unknown): string {
  // Arguments arrive as JSON; an `undefined` an in-process caller left behind
  // is not part of the call and must not throw inside the gate.
  return sha256Hex(canonicalize(JSON.parse(JSON.stringify(args ?? {}))))
}
