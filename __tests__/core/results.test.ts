import { describe, expect, it } from "vitest"
import {
  counteredResult,
  decisionMeta,
  denyResult,
  heldPendingResult,
  receiptExpiredResult,
  refusedResult,
  unavailableResult,
  withDecisionMeta,
} from "../../src/core/results.js"

const INTERNAL = /chronicle|touchpoint|accord|escalation|hydra/i

const texts = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join(" ")

describe("tool results in the public vocabulary", () => {
  it("deny is an error result naming the reason, the record and a counter-proposal when offered", () => {
    const r = denyResult({
      kind: "deny",
      reasonCode: "value_exceeds_tx_max",
      failedBound: "value_bounds.per_tx_max",
      recordId: "rec_1",
      negotiateUrl: "https://overturo.com/n",
      message: "the value 500.00 is over the bound",
    })
    expect(r.isError).toBe(true)
    expect(texts(r)).toBe("This action is not authorized (value_exceeds_tx_max). Record rec_1. A counter-proposal is possible.")
    expect(texts(r)).not.toContain("500.00")
    expect(r.structuredContent).toEqual({
      authorized: false,
      outcome: "deny",
      reason_code: "value_exceeds_tx_max",
      failed_bound: "value_bounds.per_tx_max",
      record_id: "rec_1",
      negotiate_url: "https://overturo.com/n",
    })
  })

  it("deny without a record or a negotiation is one sentence", () => {
    const r = denyResult({ kind: "deny", reasonCode: "grant_paused", message: "" })
    expect(texts(r)).toBe("This action is not authorized (grant_paused).")
    expect(r.structuredContent).toEqual({ authorized: false, outcome: "deny", reason_code: "grant_paused" })
  })

  it("unavailable says to try again", () => {
    const r = unavailableResult({ reasonCode: "transport", requestId: "req_9" })
    expect(r.isError).toBe(true)
    expect(texts(r)).toBe("Authorization is unavailable right now; try again.")
    expect(r.structuredContent).toEqual({ authorized: false, outcome: "unavailable", reason_code: "transport", request_id: "req_9" })
  })

  it("refused names the outcome and who decided", () => {
    expect(texts(refusedResult({ kind: "denied", decisionId: "d", decidedBy: "Ada" }))).toBe("The Decision was denied by Ada; nothing was done.")
    expect(texts(refusedResult({ kind: "cancelled", decisionId: "d" }))).toBe("The Decision was cancelled; nothing was done.")
    const expired = refusedResult({ kind: "expired", decisionId: "d", decidedBy: null })
    expect(texts(expired)).toContain("expired")
    expect(expired.structuredContent).toEqual({ authorized: false, outcome: "expired", decision_id: "d" })
    expect(refusedResult({ kind: "denied", decisionId: "", decidedBy: "A" }).structuredContent).toEqual({
      authorized: false,
      outcome: "denied",
      decided_by: "A",
    })
  })

  it("receipt expired and countered are error results", () => {
    const r = receiptExpiredResult({ decisionId: "d" })
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toMatchObject({ outcome: "receipt_expired", decision_id: "d" })
    const c = counteredResult({ decisionId: "d", negotiationId: "neg_1" })
    expect(texts(c)).toBe("A counter-proposal was made (neg_1); nothing was done. The server may negotiate it.")
    expect(c.structuredContent).toMatchObject({ outcome: "countered", negotiation_id: "neg_1" })
    expect(texts(counteredResult({ decisionId: "d" }))).toBe("A counter-proposal was made; nothing was done. The server may negotiate it.")
  })

  it("the pending delivery is a success with the link in one sentence", () => {
    const held = {
      decisionId: "esc_1",
      decisionUrl: "https://overturo.com/decisions/tok",
      waitUrl: "w",
      expiresAt: new Date("2026-10-26T12:00:00Z"),
      recordId: "rec",
    }
    const r = heldPendingResult(held)
    expect(r.isError).toBe(false)
    expect(texts(r)).toBe("Approval needed — open Overturo to decide: https://overturo.com/decisions/tok")
    expect(r.structuredContent).toEqual({
      held: true,
      decision_id: "esc_1",
      decision_url: "https://overturo.com/decisions/tok",
      expires_at: "2026-10-26T12:00:00Z",
      trigger: "approval",
      next: "Open the link, decide, then ask again.",
    })
    expect(r._meta).toEqual({ held: true, decision_id: "esc_1" })
    expect(heldPendingResult({ ...held, expiresAt: new Date("nope") }, "Please decide").structuredContent.expires_at).toBeNull()
  })

  it("never says an internal name", () => {
    const all = [
      denyResult({ kind: "deny", reasonCode: "grant_paused", recordId: "rec_1", negotiateUrl: "u", message: "" }),
      unavailableResult({ reasonCode: "transport" }),
      refusedResult({ kind: "denied", decisionId: "d" }),
      receiptExpiredResult({ decisionId: "d" }),
      counteredResult({ decisionId: "d" }),
    ]
    for (const r of all) expect(texts(r)).not.toMatch(INTERNAL)
  })

  it("decision meta carries the decision, record and receipt pointers", () => {
    const decision = { receipt: "r", receiptId: "j", expiresAt: 1, recordId: "rec_a", decisionId: "esc", decisionRecordId: "rec_d" }
    expect(decisionMeta(decision)).toEqual({ decision_id: "esc", record_id: "rec_d", receipt_id: "j" })
    expect(decisionMeta({ receipt: "r", receiptId: "j", expiresAt: 1, recordId: "rec_a" })).toEqual({ record_id: "rec_a", receipt_id: "j" })
    const out = withDecisionMeta({ content: [], _meta: { keep: 1 } }, decision)
    expect(out._meta).toEqual({ keep: 1, decision: { decision_id: "esc", record_id: "rec_d", receipt_id: "j" } })
    expect(withDecisionMeta({ content: [] } as { content: never[]; _meta?: Record<string, unknown> }, decision)._meta?.decision).toBeDefined()
  })
})
