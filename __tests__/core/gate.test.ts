import { beforeEach, describe, expect, it } from "vitest"
import { argumentsDigest } from "../../src/core/canonical.js"
import type { ToolAuthorization } from "../../src/core/declaration.js"
import { createGateCore, gateCall, remainingSeconds, type GateCore } from "../../src/core/gate.js"
import type { DecisionEvent } from "../../src/core/hooks.js"
import { MemoryStore, readResumption, resumptionKey } from "../../src/core/stores.js"
import { createAgentClient, createOverturoStub, DECISION_ID, DECISION_URL, type OverturoStub } from "../support/overturo_stub.js"
import { createMinter } from "../support/receipts.js"

type Args = { amount: string; currency: string }
const decl: ToolAuthorization<Args> = { action: "write", scope: "payments:transfer", value: (a) => a.amount, currency: (a) => a.currency }
const args: Args = { amount: "75.00", currency: "USD" }
const key = () => resumptionKey("transfer", argumentsDigest(args))

let stub: OverturoStub
let core: GateCore
let store: MemoryStore
let events: DecisionEvent[]
let clock: { t: number }

beforeEach(async () => {
  stub = createOverturoStub(await createMinter())
  store = new MemoryStore({ sweepIntervalSeconds: 0 })
  events = []
  clock = { t: Date.now() }
  core = createGateCore({
    client: await createAgentClient(stub),
    store,
    holdSeconds: 1,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms
    },
    onDecision: (e) => events.push(e),
  })
})

describe("gateCall: authorize now", () => {
  it("runs on allow and reports the outcome", async () => {
    stub.authorize.push({ kind: "allow", jti: "j" })
    const step = await gateCall(core, "transfer", decl, args)
    expect(step.kind).toBe("run")
    expect(events).toEqual([{ tool: "transfer", outcome: "allow" }])
  })

  it("answers deny and unavailable as results", async () => {
    stub.authorize.push({ kind: "error", status: 403, reason_code: "value_exceeds_tx_max", denial_category: "intent_denied" })
    const deny = await gateCall(core, "transfer", decl, args)
    expect(deny.kind).toBe("result")
    if (deny.kind === "result") expect(deny.result.structuredContent?.reason_code).toBe("value_exceeds_tx_max")
    stub.authorize.push({ kind: "transport" })
    const unavailable = await gateCall(core, "transfer", decl, args)
    if (unavailable.kind === "result") expect(unavailable.result.structuredContent?.outcome).toBe("unavailable")
    expect(events.map((e) => e.outcome)).toEqual(["deny", "unavailable"])
  })

  it("stores a held decision keyed by tool and digest", async () => {
    stub.authorize.push({ kind: "escalate" })
    const step = await gateCall(core, "transfer", decl, args)
    expect(step.kind).toBe("held")
    if (step.kind !== "held") return
    expect(step.repeated).toBe(false)
    expect(step.digest).toBe(argumentsDigest(args))
    const entry = await readResumption(store, key())
    expect(entry).toMatchObject({ decision_id: DECISION_ID, state: "pending", record_id: "rec_us_held01" })
    expect(events).toEqual([])
  })

  it("two identical first calls in flight at once share one hold: the second delivers the first's decision instead of overwriting it", async () => {
    stub.authorize.push({ kind: "escalate" }, { kind: "escalate", decisionId: "esc_us_orphan" })
    const steps = await Promise.all([gateCall(core, "transfer", decl, args), gateCall(core, "transfer", decl, args)])
    const held = steps.filter((s): s is Extract<typeof s, { kind: "held" }> => s.kind === "held")
    expect(held).toHaveLength(2)
    expect(held.map((s) => s.repeated).sort()).toEqual([false, true])
    const owner = (await readResumption(store, key()))?.decision_id
    expect(held.map((s) => s.held.decisionId)).toEqual([owner, owner])
    expect(stub.authorizeCalls()).toHaveLength(2)
  })

  it("gives an unreadable expiry a ten-minute life", async () => {
    stub.authorize.push({ kind: "escalate", ttl: "not a date" })
    const step = await gateCall(core, "transfer", decl, args)
    if (step.kind !== "held") throw new Error("expected held")
    expect(step.held.expiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60 * 1000)
  })
})

describe("gateCall: resumption", () => {
  beforeEach(async () => {
    stub.authorize.push({ kind: "escalate" })
    await gateCall(core, "transfer", decl, args)
  })

  it("waits on a pending decision and repeats the delivery when it stays pending", async () => {
    stub.wait.push({ kind: "pending", retry_after: 1 })
    const step = await gateCall(core, "transfer", decl, args)
    expect(step).toMatchObject({ kind: "held", repeated: true })
    expect(stub.authorizeCalls()).toHaveLength(1)
    expect(stub.waitCalls()).toHaveLength(1)
    expect(events).toEqual([{ tool: "transfer", outcome: "pending", decisionId: DECISION_ID }])
  })

  it("runs once on approval with the settlement's receipt, then a second identical call is a new authorization", async () => {
    stub.wait.push({ kind: "approved", jti: "jti_approved" })
    const step = await gateCall(core, "transfer", decl, args)
    expect(step.kind).toBe("run")
    if (step.kind !== "run") return
    expect(step.decision.receiptId).toBe("jti_approved")
    expect(step.decision.decisionId).toBe(DECISION_ID)
    expect((await readResumption(store, key()))?.state).toBe("resumed")
    expect(events.at(-1)).toEqual({ tool: "transfer", outcome: "approved", decisionId: DECISION_ID })

    stub.authorize.push({ kind: "escalate", decisionId: "esc_us_second" })
    const next = await gateCall(core, "transfer", decl, args)
    expect(next).toMatchObject({ kind: "held", repeated: false })
    expect(stub.authorizeCalls()).toHaveLength(2)
    expect(stub.waitCalls()).toHaveLength(1)
  })

  it("answers receipt_expired, removes the entry, and the next call authorizes anew", async () => {
    stub.wait.push({ kind: "receipt_expired" })
    const step = await gateCall(core, "transfer", decl, args)
    expect(step.kind).toBe("result")
    if (step.kind === "result") expect(step.result.structuredContent?.outcome).toBe("receipt_expired")
    expect(await store.get(key())).toBeUndefined()
    stub.authorize.push({ kind: "escalate" })
    expect((await gateCall(core, "transfer", decl, args)).kind).toBe("held")
    expect(stub.authorizeCalls()).toHaveLength(2)
  })

  it.each(["denied", "expired", "cancelled"] as const)("answers %s as a refused result and removes the entry", async (kind) => {
    stub.wait.push({ kind, decidedBy: "Ada" })
    const step = await gateCall(core, "transfer", decl, args)
    expect(step.kind).toBe("result")
    if (step.kind === "result") {
      expect(step.result.isError).toBe(true)
      expect(step.result.structuredContent).toMatchObject({ outcome: kind, decision_id: DECISION_ID })
    }
    expect(await store.get(key())).toBeUndefined()
    expect(events.at(-1)).toEqual({ tool: "transfer", outcome: kind, decisionId: DECISION_ID })
  })

  it("answers countered with the negotiation reference and removes the entry", async () => {
    stub.wait.push({ kind: "countered", negotiationId: "neg_7" })
    const step = await gateCall(core, "transfer", decl, args)
    if (step.kind !== "result") throw new Error("expected result")
    expect(step.result.structuredContent).toMatchObject({ outcome: "countered", negotiation_id: "neg_7" })
    expect(await store.get(key())).toBeUndefined()
  })

  it("keeps the entry when the settlement wait is unavailable", async () => {
    stub.wait.push({ kind: "transport" })
    const step = await gateCall(core, "transfer", decl, args)
    if (step.kind !== "result") throw new Error("expected result")
    expect(step.result.structuredContent?.outcome).toBe("unavailable")
    expect(await readResumption(store, key())).toBeDefined()
  })

  it("leaves the open decision alone for different arguments", async () => {
    stub.authorize.push({ kind: "allow" })
    const step = await gateCall(core, "transfer", decl, { amount: "10.00", currency: "USD" })
    expect(step.kind).toBe("run")
    expect(await readResumption(store, key())).toMatchObject({ decision_id: DECISION_ID })
    expect(stub.waitCalls()).toHaveLength(0)
  })

  it("refuses a pointer that names another decision", async () => {
    const step = await gateCall(core, "transfer", decl, args, { decisionId: "esc_us_other" })
    expect(step).toEqual({ kind: "invalid_state" })
  })

  it("follows the pointer when the store has lost the entry, and runs it once: the same state echoed again is a new authorization", async () => {
    await store.delete(key())
    stub.wait.push({ kind: "approved", jti: "jti_from_pointer" })
    const step = await gateCall(core, "transfer", decl, args, { decisionId: DECISION_ID })
    expect(step.kind).toBe("run")
    if (step.kind === "run") expect(step.decision.receiptId).toBe("jti_from_pointer")
    expect(stub.waitCalls()[0].path).toContain(DECISION_ID)

    stub.wait.push({ kind: "approved", jti: "jti_replayed_state" })
    stub.authorize.push({ kind: "allow", jti: "jti_fresh" })
    const again = await gateCall(core, "transfer", decl, args, { decisionId: DECISION_ID })
    expect(again.kind).toBe("run")
    if (again.kind === "run") expect(again.decision.receiptId).toBe("jti_fresh")
    expect(stub.waitCalls()).toHaveLength(1)
    expect(stub.authorizeCalls()).toHaveLength(2)
  })

  it("materialises a pointer's page and expiry, so a pending decision is delivered with its link where the store never saw the hold", async () => {
    await store.delete(key())
    stub.wait.push({ kind: "pending", retry_after: 1 })
    const expires = new Date(Date.now() + 120_000).toISOString()
    const step = await gateCall(core, "transfer", decl, args, { decisionId: DECISION_ID, decisionUrl: DECISION_URL, expiresAt: expires })
    expect(step).toMatchObject({ kind: "held", repeated: true })
    if (step.kind === "held") {
      expect(step.held.decisionUrl).toBe(DECISION_URL)
      expect(step.held.expiresAt.toISOString()).toBe(expires)
    }
  })

  it("refuses a pointer whose decision is not the one another process materialised for these arguments", async () => {
    await store.delete(key())
    await store.set(key(), JSON.stringify({ decision_id: "esc_us_other", decision_url: "", wait_url: "", expires_at: new Date(Date.now() + 60_000).toISOString(), record_id: "", state: "pending" }), 120)
    const step = await gateCall(core, "transfer", decl, args, { decisionId: DECISION_ID })
    expect(step.kind).toBe("invalid_state")
  })

  it("answers the loser of a resume race with unavailable", async () => {
    stub.wait.push({ kind: "approved" })
    const entry = await readResumption(store, key())
    // another process resumed first
    await store.set(key(), JSON.stringify({ ...entry, state: "resumed" }), 60)
    const step = await gateCall(core, "transfer", decl, args)
    // a resumed entry is not pending: this call authorizes anew
    expect(stub.authorizeCalls()).toHaveLength(2)
    expect(step.kind).toBe("result")
  })

  it("answers the loser of a concurrent claim with unavailable", async () => {
    stub.wait.push({ kind: "approved" })
    const racing = new MemoryStore({ sweepIntervalSeconds: 0 })
    const entry = await readResumption(store, key())
    await racing.set(key(), JSON.stringify(entry), 600)
    const original = racing.compareAndSet.bind(racing)
    racing.compareAndSet = async () => false
    const raced = createGateCore({ client: core.client, store: racing, holdSeconds: 1, onDecision: (e) => events.push(e) })
    const step = await gateCall(raced, "transfer", decl, args)
    racing.compareAndSet = original
    expect(step.kind).toBe("result")
    if (step.kind === "result") expect(step.result.structuredContent?.outcome).toBe("unavailable")
    expect(events.at(-1)).toEqual({ tool: "transfer", outcome: "unavailable" })
  })
})

describe("createGateCore and remainingSeconds", () => {
  it("requires a client and defaults the hold and the store", () => {
    expect(() => createGateCore({ client: undefined as never })).toThrow(/client/)
    const c = createGateCore({ client: core.client })
    expect(c.holdSeconds).toBe(20)
    expect(c.store).toBeInstanceOf(MemoryStore)
    ;(c.store as MemoryStore).close()
  })

  it("remainingSeconds floors at one and defaults an unreadable expiry", () => {
    const held = { decisionId: "d", decisionUrl: "u", waitUrl: "w", recordId: "r" }
    expect(remainingSeconds({ ...held, expiresAt: new Date(Date.now() + 30_500) })).toBeGreaterThanOrEqual(30)
    expect(remainingSeconds({ ...held, expiresAt: new Date(Date.now() - 30_000) })).toBe(1)
    expect(remainingSeconds({ ...held, expiresAt: new Date("x") })).toBe(600)
  })

  it("a throwing hook never breaks the call", async () => {
    const loud = createGateCore({
      client: core.client,
      store,
      onDecision: () => {
        throw new Error("boom")
      },
    })
    stub.authorize.push({ kind: "allow" })
    expect((await gateCall(loud, "other", decl, args)).kind).toBe("run")
  })
})
