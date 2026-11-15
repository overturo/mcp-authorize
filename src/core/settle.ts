import { OapError, type OverturoAuthorize, type OapReasonCode } from "@overturo/sdk"
import { decisionFromAllow } from "./authorize.js"
import type { SettlementOutcome } from "./outcomes.js"

/** What the settlement wait answers — the SDK's own return type. */
export type EscalationSettlement = Awaited<ReturnType<OverturoAuthorize["waitForEscalation"]>>

export const DEFAULT_HOLD_SECONDS = 20
/** The platform's own ceiling on one settlement hold. */
export const MAX_HOLD_SECONDS = 20

export interface WaitForSettlementOptions {
  /** Total time this call may spend waiting (default 20 s; each platform round is capped at 20 s). */
  holdSeconds?: number
  /** Clock override for tests (milliseconds). */
  now?: () => number
  /** Sleep override for tests. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Waits on a decision this grant opened, for a bounded hold. The platform's
 * `retry_after` is honoured between rounds; when the hold runs out the
 * outcome is `pending` and the same delivery is answered again.
 */
export async function waitForSettlement(
  client: OverturoAuthorize,
  decisionId: string,
  opts: WaitForSettlementOptions = {}
): Promise<SettlementOutcome> {
  const hold = Math.max(0, opts.holdSeconds ?? DEFAULT_HOLD_SECONDS)
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  const deadline = now() + hold * 1000

  for (;;) {
    const remaining = Math.ceil((deadline - now()) / 1000)
    if (remaining <= 0) return { kind: "pending" }
    let settlement: EscalationSettlement
    try {
      settlement = await client.waitForEscalation(decisionId, { holdSeconds: Math.min(remaining, MAX_HOLD_SECONDS) })
    } catch (error) {
      return mapError(error)
    }
    const outcome = mapSettlement(settlement)
    if (outcome.kind !== "pending") return outcome
    const retryAfterMs = Math.max(0, Number((settlement as { retry_after?: number }).retry_after ?? 1)) * 1000
    const left = deadline - now()
    if (left <= 0) return outcome
    await sleep(Math.min(Math.max(retryAfterMs, 250), left))
  }
}

export function mapSettlement(s: EscalationSettlement): SettlementOutcome {
  const raw = s as unknown as Record<string, unknown>
  switch (s.status) {
    case "pending":
      return { kind: "pending" }
    case "approved":
      if (typeof raw.receipt === "string") return { kind: "approved", decision: decisionFromAllow(raw) }
      return { kind: "receipt_expired", decisionId: s.escalation_id }
    case "denied":
    case "expired":
    case "cancelled":
      return { kind: s.status, decisionId: s.escalation_id, decidedBy: s.decided_by }
    case "countered":
      return { kind: "countered", decisionId: s.escalation_id, negotiationId: s.negotiation_id }
    default:
      return { kind: "unavailable", reasonCode: "malformed", message: "The decision answer could not be read." }
  }
}

function mapError(error: unknown): SettlementOutcome {
  if (error instanceof OapError) {
    const code = error.reason_code as OapReasonCode
    // The decision is no longer there to wait on: treat it as lapsed so the next call starts afresh.
    if (code === "not_found") return { kind: "expired", decisionId: "" }
    return { kind: "unavailable", reasonCode: code, message: error.message }
  }
  return { kind: "unavailable", reasonCode: "transport", message: error instanceof Error ? error.message : String(error) }
}
