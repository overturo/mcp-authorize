// Integration against @modelcontextprotocol/sdk 1.32.2 (the v1 line) over a
// linked in-memory pair: the same scenarios minus the input-required result.
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MemoryStore, type DecisionEvent, type ToolAuthorization } from "../src/index.js"
import { gateTool, gateTools, selectDelivery, supportsUrlMode, type LegacyGateOptions } from "../src/legacy.js"
import { createAgentClient, createOverturoStub, DECISION_ID, DECISION_URL, type OverturoStub } from "./support/overturo_stub.js"
import { createMinter } from "./support/receipts.js"

type Result = { isError?: boolean; structuredContent?: Record<string, unknown>; _meta?: Record<string, unknown> }

let stub: OverturoStub
let store: MemoryStore
let events: DecisionEvent[]
let agent: Awaited<ReturnType<typeof createAgentClient>>
let handlerRuns: number
const cleanups: Array<() => Promise<unknown>> = []

beforeEach(async () => {
  stub = createOverturoStub(await createMinter())
  agent = await createAgentClient(stub)
  store = new MemoryStore({ sweepIntervalSeconds: 0 })
  events = []
  handlerRuns = 0
})

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => undefined)
})

function buildV1(): { server: McpServer; opts: LegacyGateOptions } {
  const server = new McpServer({ name: "v1-example", version: "0" })
  const opts: LegacyGateOptions = { server, client: agent, store, holdSeconds: 1, onDecision: (e) => events.push(e) }
  type Args = { amount: string; currency: string; payee: string }
  const decl: ToolAuthorization<Args> = { action: "write", scope: "payments:transfer", value: (a) => a.amount, currency: (a) => a.currency }
  const schema = z.object({ amount: z.string(), currency: z.string(), payee: z.string() })
  server.registerTool(
    "transfer",
    { description: "gated", inputSchema: schema },
    gateTool("transfer", decl, async (a, _extra, decision) => {
      handlerRuns++
      return { content: [{ type: "text", text: `ok ${a.amount}` }], structuredContent: { authorized: true, receipt_id: decision.receiptId } }
    }, opts)
  )
  server.registerTool(
    "transfer_pending",
    { description: "gated, pending", inputSchema: schema },
    gateTool("transfer_pending", { ...decl, delivery: "pending" }, async () => ({ content: [], structuredContent: { authorized: true } }), opts)
  )
  return { server, opts }
}

async function connect(opts: { url?: boolean } = {}) {
  const { server } = buildV1()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "v1-client", version: "0" }, { capabilities: opts.url === false ? {} : { elicitation: { url: {} } } })
  await client.connect(clientTransport)
  cleanups.push(() => client.close(), () => server.close())
  return client
}

const call = (client: Client, name: string, amount: string) =>
  client.callTool({ name, arguments: { amount, currency: "USD", payee: "acct_test" } }) as Promise<Result>

describe("v1 adapter", () => {
  it("allow runs the handler with the decision and adds _meta.decision", async () => {
    const client = await connect()
    stub.authorize.push({ kind: "allow", jti: "jti_v1" })
    const result = await call(client, "transfer", "10.00")
    expect(result.structuredContent).toEqual({ authorized: true, receipt_id: "jti_v1" })
    expect(result._meta?.decision).toEqual({ record_id: "rec_us_allow01", receipt_id: "jti_v1" })
    expect(handlerRuns).toBe(1)
  })

  it("deny and unavailable are error results", async () => {
    const client = await connect()
    stub.authorize.push({ kind: "error", status: 403, reason_code: "value_exceeds_tx_max", denial_category: "intent_denied" })
    const denied = await call(client, "transfer", "500.00")
    expect(denied.isError).toBe(true)
    expect(denied.structuredContent).toMatchObject({ reason_code: "value_exceeds_tx_max" })
    stub.authorize.push({ kind: "transport" })
    expect((await call(client, "transfer", "10.00")).structuredContent).toMatchObject({ outcome: "unavailable" })
    expect(handlerRuns).toBe(0)
  })

  it("URL mode declared: -32042 with one URL-mode elicitation; the retry resumes once from the store", async () => {
    const client = await connect()
    stub.authorize.push({ kind: "escalate" })
    let caught: { code?: number; data?: { elicitations?: unknown } } | undefined
    try {
      await call(client, "transfer", "75.00")
    } catch (e) {
      caught = e as never
    }
    expect(caught?.code).toBe(-32042)
    expect(caught?.data?.elicitations).toEqual([{ mode: "url", elicitationId: DECISION_ID, url: DECISION_URL, message: "Approval needed — open Overturo to decide" }])
    expect(events.at(-1)).toEqual({ tool: "transfer", outcome: "held", delivery: "url_error", decisionId: DECISION_ID })

    stub.wait.push({ kind: "pending", retry_after: 1 })
    await expect(call(client, "transfer", "75.00")).rejects.toMatchObject({ code: -32042 })

    stub.wait.push({ kind: "approved", jti: "jti_v1_resumed" })
    const resumed = await call(client, "transfer", "75.00")
    expect(resumed.structuredContent).toEqual({ authorized: true, receipt_id: "jti_v1_resumed" })
    expect(resumed._meta?.decision).toEqual({ decision_id: DECISION_ID, record_id: "rec_us_decision01", receipt_id: "jti_v1_resumed" })
    expect(handlerRuns).toBe(1)
    expect(stub.authorizeCalls()).toHaveLength(1)

    stub.authorize.push({ kind: "escalate", decisionId: "esc_us_next" })
    await expect(call(client, "transfer", "75.00")).rejects.toMatchObject({ code: -32042 })
    expect(stub.authorizeCalls()).toHaveLength(2)
  })

  it("no URL mode: the pending result, then the refused result after a denial", async () => {
    const client = await connect({ url: false })
    stub.authorize.push({ kind: "escalate" })
    const pending = await call(client, "transfer", "75.00")
    expect(pending.isError).toBe(false)
    expect(pending.structuredContent).toMatchObject({ held: true, decision_id: DECISION_ID, decision_url: DECISION_URL })
    stub.wait.push({ kind: "denied", decidedBy: "Ada" })
    const refused = await call(client, "transfer", "75.00")
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toMatchObject({ outcome: "denied", decided_by: "Ada" })
    expect(handlerRuns).toBe(0)
  })

  it("delivery: pending wins over a declared URL mode", async () => {
    const client = await connect()
    stub.authorize.push({ kind: "escalate" })
    const pending = await call(client, "transfer_pending", "75.00")
    expect(pending.structuredContent).toMatchObject({ held: true })
    expect(events.at(-1)).toMatchObject({ delivery: "pending" })
  })

  it("selects the delivery from the negotiated capabilities, pending when none are exposed", () => {
    const { server, opts } = buildV1()
    expect(selectDelivery(server, { action: "a", scope: "s" })).toBe("pending")
    expect(selectDelivery(server, { action: "a", scope: "s", delivery: "pending" })).toBe("pending")
    expect(supportsUrlMode({ elicitation: { url: {} } })).toBe(true)
    expect(supportsUrlMode({ elicitation: {} })).toBe(false)
    const broken = { server: { getClientCapabilities: () => { throw new Error("no session") } } } as never
    expect(selectDelivery(broken, { action: "a", scope: "s" })).toBe("pending")
    const plain = async () => ({ content: [] })
    const wrapped = gateTools({ gated: { decl: { action: "a", scope: "s" }, handler: plain }, open: { handler: plain } }, opts)
    expect(wrapped.open).toBe(plain)
    expect(wrapped.gated).not.toBe(plain)
    expect(() => gateTool("t", { action: "a", scope: "s" }, plain, { ...opts, server: undefined as never })).toThrow(/server/)
  })
})
