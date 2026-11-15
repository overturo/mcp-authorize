import { beforeEach, describe, expect, it } from "vitest"
import { mapSettlement, waitForSettlement } from "../../src/core/settle.js"
import { createAgentClient, createOverturoStub, DECISION_ID, type OverturoStub } from "../support/overturo_stub.js"
import { createMinter } from "../support/receipts.js"

let stub: OverturoStub
let client: Awaited<ReturnType<typeof createAgentClient>>

function fakeClock() {
  let t = 1_000_000
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
    sleeps,
    advance: (ms: number) => (t += ms),
  }
}

beforeEach(async () => {
  stub = createOverturoStub(await createMinter())
  client = await createAgentClient(stub)
})

describe("waitForSettlement", () => {
  it("returns approved with the receipt from the settlement body", async () => {
    stub.wait.push({ kind: "approved", jti: "jti_ok", decidedBy: "principal" })
    const outcome = await waitForSettlement(client, DECISION_ID, { holdSeconds: 5 })
    expect(outcome.kind).toBe("approved")
    if (outcome.kind !== "approved") return
    expect(outcome.decision.receiptId).toBe("jti_ok")
    expect(outcome.decision.decisionId).toBe(DECISION_ID)
    expect(outcome.decision.decisionRecordId).toBe("rec_us_decision01")
    const [call] = stub.waitCalls()
    expect(call.path).toBe(`/api/v1/grants/ath_us_grant01/escalations/${DECISION_ID}/wait`)
    expect(call.headers.authorization).toMatch(/^DPoP /)
  })

  it("asks the platform to hold no longer than the ceiling, honours retry_after and stops at the deadline", async () => {
    const c = fakeClock()
    stub.wait.push({ kind: "pending", retry_after: 2 }, { kind: "pending", retry_after: 2 }, { kind: "pending", retry_after: 2 })
    const outcome = await waitForSettlement(client, DECISION_ID, { holdSeconds: 5, now: c.now, sleep: c.sleep })
    expect(outcome).toEqual({ kind: "pending" })
    expect(c.sleeps).toEqual([2_000, 2_000, 1_000])
    expect(stub.waitCalls().length).toBe(3)
    expect(stub.waitCalls().map((w) => w.path.length > 0)).toEqual([true, true, true])
  })

  it("sends a hold capped at twenty seconds", async () => {
    const c = fakeClock()
    stub.wait.push({ kind: "denied" })
    await waitForSettlement(client, DECISION_ID, { holdSeconds: 45, now: c.now, sleep: c.sleep })
    expect(stub.calls[0].path).toContain("/wait")
  })

  it("settles after a pending round within the hold", async () => {
    const c = fakeClock()
    stub.wait.push({ kind: "pending", retry_after: 0 }, { kind: "approved" })
    const outcome = await waitForSettlement(client, DECISION_ID, { holdSeconds: 5, now: c.now, sleep: c.sleep })
    expect(outcome.kind).toBe("approved")
    expect(c.sleeps).toEqual([250])
  })

  it("answers pending at once when the hold is zero", async () => {
    const outcome = await waitForSettlement(client, DECISION_ID, { holdSeconds: 0 })
    expect(outcome).toEqual({ kind: "pending" })
    expect(stub.waitCalls()).toHaveLength(0)
  })

  it("maps receipt_expired, denied, expired, cancelled and countered", async () => {
    stub.wait.push({ kind: "receipt_expired" })
    expect(await waitForSettlement(client, DECISION_ID)).toEqual({ kind: "receipt_expired", decisionId: DECISION_ID })
    stub.wait.push({ kind: "denied", decidedBy: "Ada" })
    expect(await waitForSettlement(client, DECISION_ID)).toEqual({ kind: "denied", decisionId: DECISION_ID, decidedBy: "Ada" })
    stub.wait.push({ kind: "expired" })
    expect(await waitForSettlement(client, DECISION_ID)).toMatchObject({ kind: "expired", decisionId: DECISION_ID })
    stub.wait.push({ kind: "cancelled" })
    expect(await waitForSettlement(client, DECISION_ID)).toMatchObject({ kind: "cancelled" })
    stub.wait.push({ kind: "countered", negotiationId: "neg_1" })
    expect(await waitForSettlement(client, DECISION_ID)).toEqual({ kind: "countered", decisionId: DECISION_ID, negotiationId: "neg_1" })
  })

  it("treats a decision the platform no longer finds as expired", async () => {
    stub.wait.push({ kind: "error", status: 404, reason_code: "not_found" })
    expect(await waitForSettlement(client, DECISION_ID)).toEqual({ kind: "expired", decisionId: "" })
  })

  it("maps other refusals, transport failures and unreadable answers to unavailable", async () => {
    stub.wait.push({ kind: "error", status: 429, reason_code: "rate_limited" })
    expect(await waitForSettlement(client, DECISION_ID)).toMatchObject({ kind: "unavailable", reasonCode: "rate_limited" })
    stub.wait.push({ kind: "transport" })
    expect(await waitForSettlement(client, DECISION_ID)).toMatchObject({ kind: "unavailable", reasonCode: "transport" })
    stub.wait.push({ kind: "garbage" })
    expect(await waitForSettlement(client, DECISION_ID)).toMatchObject({ kind: "unavailable", reasonCode: "malformed" })
  })

  it("maps a pending settlement with a missing retry_after", () => {
    expect(mapSettlement({ status: "pending", wait_again: true, retry_after: 0, escalation_id: "e", oap_ver: "1.0" })).toEqual({ kind: "pending" })
  })
})
