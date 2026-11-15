/**
 * Tool results in the public vocabulary. A deny, an unavailable
 * authorization, a refused or lapsed decision and a counter-proposal are all
 * valid tool calls with a refused action — results a model can relay, never
 * protocol errors. No argument value ever appears in the text.
 */
import { pendingResult, type PendingShape } from "./builder.js"
import type { AuthorizeOutcome, Decision, HeldDecision, SettlementOutcome } from "./outcomes.js"

export interface ToolResultShape {
  content: Array<{ type: "text"; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
  _meta?: Record<string, unknown>
  [k: string]: unknown
}

export const DEFAULT_MESSAGE = "Approval needed — open Overturo to decide"
export const PENDING_NEXT = "Open the link, decide, then ask again."

function errorResult(text: string, structured: Record<string, unknown>): ToolResultShape {
  return { content: [{ type: "text", text }], structuredContent: compact(structured), isError: true }
}

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))
}

export function denyResult(o: Extract<AuthorizeOutcome, { kind: "deny" }>): ToolResultShape {
  const record = o.recordId ? ` Record ${o.recordId}.` : ""
  const negotiate = o.negotiateUrl ? " A counter-proposal is possible." : ""
  return errorResult(`This action is not authorized (${o.reasonCode}).${record}${negotiate}`, {
    authorized: false,
    outcome: "deny",
    reason_code: o.reasonCode,
    failed_bound: o.failedBound,
    record_id: o.recordId,
    negotiate_url: o.negotiateUrl,
  })
}

export function unavailableResult(o: { reasonCode: string; requestId?: string }): ToolResultShape {
  return errorResult("Authorization is unavailable right now; try again.", {
    authorized: false,
    outcome: "unavailable",
    reason_code: o.reasonCode,
    request_id: o.requestId,
  })
}

export function refusedResult(o: Extract<SettlementOutcome, { kind: "denied" | "expired" | "cancelled" }>): ToolResultShape {
  const who = o.decidedBy ? ` by ${o.decidedBy}` : ""
  const text = {
    denied: `The Decision was denied${who}; nothing was done.`,
    expired: "The Decision expired before it was made; nothing was done. Ask again to start a new one.",
    cancelled: `The Decision was cancelled${who}; nothing was done.`,
  }[o.kind]
  return errorResult(text, {
    authorized: false,
    outcome: o.kind,
    decision_id: o.decisionId || undefined,
    decided_by: o.decidedBy ?? undefined,
  })
}

export function receiptExpiredResult(o: { decisionId: string }): ToolResultShape {
  return errorResult("The Approval stood but its Receipt lapsed before the action ran; ask again.", {
    authorized: false,
    outcome: "receipt_expired",
    reason_code: "receipt_expired",
    decision_id: o.decisionId,
  })
}

export function counteredResult(o: { decisionId: string; negotiationId?: string }): ToolResultShape {
  const ref = o.negotiationId ? ` (${o.negotiationId})` : ""
  return errorResult(`A counter-proposal was made${ref}; nothing was done. The server may negotiate it.`, {
    authorized: false,
    outcome: "countered",
    reason_code: "escalation_countered",
    decision_id: o.decisionId,
    negotiation_id: o.negotiationId,
  })
}

/**
 * A validly signed request state echoed for another tool, other arguments or
 * another decision. The seam has already answered a tampered or expired state
 * with the protocol's invalid-params error before the handler ran; a handler
 * cannot reach the wire with a protocol error on this line (the server maps
 * every throw but the URL-elicitation one into a tool error), so this is the
 * same refusal as a tool result. Nothing is resumed.
 */
export function invalidRequestStateResult(): ToolResultShape {
  return errorResult("Invalid or expired requestState; ask again to start a new authorization.", {
    authorized: false,
    outcome: "invalid_request_state",
    reason: "invalid_request_state",
  })
}

/** The pending delivery: a successful result the model can relay, with the decision link in one sentence. */
export function heldPendingResult(held: HeldDecision, message: string = DEFAULT_MESSAGE): PendingShape {
  return pendingResult({
    decisionId: held.decisionId,
    decisionUrl: held.decisionUrl,
    expiresAt: Number.isNaN(held.expiresAt.getTime()) ? null : held.expiresAt,
    trigger: "approval",
    next: PENDING_NEXT,
    text: `${message}: ${held.decisionUrl}`,
    meta: { decision_id: held.decisionId },
  })
}

/** The `_meta.decision` reference a handler's result carries. */
export function decisionMeta(decision: Decision): Record<string, unknown> {
  return compact({
    decision_id: decision.decisionId,
    record_id: decision.decisionRecordId ?? decision.recordId,
    receipt_id: decision.receiptId,
  })
}

/** Adds `_meta.decision` to a handler's result without touching anything else. */
export function withDecisionMeta<T extends { _meta?: Record<string, unknown>; [k: string]: unknown }>(result: T, decision: Decision): T {
  return { ...result, _meta: { ...(result._meta ?? {}), decision: decisionMeta(decision) } }
}
