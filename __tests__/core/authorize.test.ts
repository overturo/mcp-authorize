import { beforeEach, describe, expect, it } from "vitest"
import { authorizeToolCall, decisionFromAllow } from "../../src/core/authorize.js"
import type { ToolAuthorization } from "../../src/core/declaration.js"
import { createAgentClient, createOverturoStub, DECISION_ID, type OverturoStub } from "../support/overturo_stub.js"
import { createMinter } from "../support/receipts.js"

type Args = { amount: string; currency: string; payee: string }
const decl: ToolAuthorization<Args> = {
  action: "write",
  scope: "payments:transfer",
  value: (a) => a.amount,
  currency: (a) => a.currency,
  counterparty: (a) => a.payee,
  context: (a) => ({ payee: a.payee }),
}
const args: Args = { amount: "10.00", currency: "USD", payee: "did:web:ledger.example.com" }

let stub: OverturoStub
let client: Awaited<ReturnType<typeof createAgentClient>>

beforeEach(async () => {
  stub = createOverturoStub(await createMinter())
  client = await createAgentClient(stub)
})

describe("authorizeToolCall", () => {
  it("sends one request with the derived fields and a fresh nonce, and maps allow", async () => {
    stub.authorize.push({ kind: "allow", jti: "jti_1" })
    const outcome = await authorizeToolCall(client, decl, args, { nonce: "n-1" })
    expect(outcome.kind).toBe("allow")
    if (outcome.kind !== "allow") return
    expect(outcome.decision.receiptId).toBe("jti_1")
    expect(outcome.decision.recordId).toBe("rec_us_allow01")
    expect(outcome.decision.receipt.split(".")).toHaveLength(3)
    const [call] = stub.authorizeCalls()
    expect(stub.authorizeCalls()).toHaveLength(1)
    expect(call.body).toEqual({
      nonce: "n-1",
      action: "write",
      scope: "payments:transfer",
      value: "10.00",
      currency: "USD",
      counterparty: "did:web:ledger.example.com",
      context: { payee: "did:web:ledger.example.com" },
    })
    expect(call.headers.authorization).toMatch(/^DPoP /)
    expect(call.headers.dpop).toBeTruthy()
  })

  it("generates a UUID nonce when none is given", async () => {
    stub.authorize.push({ kind: "allow" })
    await authorizeToolCall(client, decl, args)
    expect((stub.authorizeCalls()[0].body as { nonce: string }).nonce).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("maps escalate to a held decision with the page, the wait and the expiry", async () => {
    const ttl = "2026-01-01T00:00:00Z"
    stub.authorize.push({ kind: "escalate", ttl })
    const outcome = await authorizeToolCall(client, decl, args)
    expect(outcome.kind).toBe("held")
    if (outcome.kind !== "held") return
    expect(outcome.held.decisionId).toBe(DECISION_ID)
    expect(outcome.held.decisionUrl).toBe("https://overturo.com/decisions/tok_fixture")
    expect(outcome.held.waitUrl).toContain(`/escalations/${DECISION_ID}/wait`)
    expect(outcome.held.expiresAt.toISOString()).toBe("2026-01-01T00:00:00.000Z")
    expect(outcome.held.recordId).toBe("rec_us_held01")
  })

  it("maps a bound refusal to deny with the reason, the bound, the record and the negotiation link", async () => {
    stub.authorize.push({
      kind: "error",
      status: 403,
      reason_code: "value_exceeds_tx_max",
      denial_category: "intent_denied",
      failed_bound: "value_bounds.per_tx_max",
      detail: { record_id: "rec_us_deny01" },
      negotiate_url: "https://overturo.com/negotiate/x",
    })
    const outcome = await authorizeToolCall(client, decl, args)
    expect(outcome).toMatchObject({
      kind: "deny",
      reasonCode: "value_exceeds_tx_max",
      failedBound: "value_bounds.per_tx_max",
      recordId: "rec_us_deny01",
      negotiateUrl: "https://overturo.com/negotiate/x",
    })
    expect(stub.authorizeCalls()).toHaveLength(1)
  })

  it("maps a refused grant (missing, revoked, scope or action not covered) to deny with its reason, never to unavailable", async () => {
    for (const reason_code of ["grant_revoked", "grant_expired", "scope_not_covered", "action_not_allowed"]) {
      stub.authorize.push({ kind: "error", status: 403, reason_code, denial_category: "authorization_denied" })
      const outcome = await authorizeToolCall(client, decl, args)
      expect(outcome).toMatchObject({ kind: "deny", reasonCode: reason_code })
    }
  })

  it("maps a refusal without a category by its reason code", async () => {
    stub.authorize.push({ kind: "error", status: 403, reason_code: "grant_revoked" })
    const outcome = await authorizeToolCall(client, decl, args)
    expect(outcome).toMatchObject({ kind: "deny", reasonCode: "grant_revoked", recordId: undefined })
  })

  it("maps a credential refusal to unavailable and never retries", async () => {
    stub.authorize.push({ kind: "error", status: 401, reason_code: "dpop_invalid", denial_category: "authorization_denied", request_id: "req_1" })
    const outcome = await authorizeToolCall(client, decl, args)
    expect(outcome).toMatchObject({ kind: "unavailable", reasonCode: "dpop_invalid", requestId: "req_1" })
    expect(stub.authorizeCalls()).toHaveLength(1)
    expect(stub.tokenRefreshes).toBe(0)
  })

  it("rotates the token once on an expired credential, then surfaces the refusal", async () => {
    stub.authorize.push({ kind: "error", status: 401, reason_code: "auth_invalid", denial_category: "authorization_denied" })
    const outcome = await authorizeToolCall(client, decl, args)
    expect(outcome).toMatchObject({ kind: "unavailable", reasonCode: "auth_invalid" })
    expect(stub.tokenRefreshes).toBe(1)
    expect(stub.authorizeCalls()).toHaveLength(1)
    expect(client.currentToken).toBe("ovt_rotated_1")
  })

  it("surfaces the refusal even when the rotation itself fails", async () => {
    stub.authorize.push({ kind: "error", status: 401, reason_code: "auth_invalid" })
    const failing = await createAgentClient({
      ...stub,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url.endsWith("/token")) throw new TypeError("fetch failed")
        return stub.fetch(input, init)
      }) as typeof fetch,
    })
    const outcome = await authorizeToolCall(failing, decl, args)
    expect(outcome).toMatchObject({ kind: "unavailable", reasonCode: "auth_invalid" })
  })

  it("maps a transport failure to unavailable (fail closed, no retry)", async () => {
    stub.authorize.push({ kind: "transport" })
    const outcome = await authorizeToolCall(client, decl, args)
    expect(outcome).toMatchObject({ kind: "unavailable", reasonCode: "transport" })
    expect(stub.authorizeCalls()).toHaveLength(1)
  })

  it("maps a malformed answer to unavailable", async () => {
    stub.authorize.push({ kind: "garbage" })
    const outcome = await authorizeToolCall(client, decl, args)
    expect(outcome).toMatchObject({ kind: "unavailable", reasonCode: "malformed" })
  })

  it("maps a non-envelope HTTP failure to unavailable", async () => {
    const broken = await createAgentClient({
      ...stub,
      fetch: (async () => new Response("<html>502</html>", { status: 502 })) as typeof fetch,
    })
    const outcome = await authorizeToolCall(broken, decl, args)
    expect(outcome).toMatchObject({ kind: "unavailable", reasonCode: "internal_error" })
  })
})

describe("decisionFromAllow", () => {
  it("reads jti or receipt_jti and the decision pointers when present", () => {
    expect(decisionFromAllow({ receipt: "r", jti: "a", exp: 1, record_id: "rec" })).toEqual({
      receipt: "r",
      receiptId: "a",
      expiresAt: 1,
      recordId: "rec",
    })
    expect(
      decisionFromAllow({ receipt: "r", receipt_jti: "b", exp: 2, record_id: "rec", escalation_id: "esc", decision_record_id: null })
    ).toEqual({ receipt: "r", receiptId: "b", expiresAt: 2, recordId: "rec", decisionId: "esc", decisionRecordId: null })
  })
})
