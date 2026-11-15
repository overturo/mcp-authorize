// Integration against @modelcontextprotocol/server 2.4.0 with the official
// client: the modern era over createMcpHandler + a fetch-backed Streamable HTTP
// transport, the legacy era over a linked in-memory pair; clients with and
// without URL-mode elicitation. Overturo is the scripted stub fed by the
// recorded corpus.
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { createMcpHandler, createRequestStateCodec, type McpHttpHandler, type McpServer } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { MemoryStore, type DecisionEvent } from "../src/index.js"
import { selectDelivery, supportsUrlMode, gateTools, gateTool, type GateOptions } from "../src/server.js"
import { buildServer } from "../examples/server.js"
import { createAgentClient, createOverturoStub, DECISION_ID, DECISION_URL, type OverturoStub } from "./support/overturo_stub.js"
import { createMinter, ISSUER, type Minter } from "./support/receipts.js"

const KEY = "0123456789abcdef0123456789abcdef-request-state-key"
const args = (amount: string) => ({ amount, currency: "USD", payee: "acct_test" })

type Result = { isError?: boolean; structuredContent?: Record<string, unknown>; _meta?: Record<string, unknown>; [k: string]: unknown }

let minter: Minter
let stub: OverturoStub
let store: MemoryStore
let events: DecisionEvent[]
let agent: Awaited<ReturnType<typeof createAgentClient>>
const cleanups: Array<() => Promise<unknown>> = []

beforeEach(async () => {
  minter = await createMinter()
  stub = createOverturoStub(minter)
  agent = await createAgentClient(stub)
  store = new MemoryStore({ sweepIntervalSeconds: 0 })
  events = []
})

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => undefined)
})

function build(extra: { pendingVariant?: boolean; requestStateBind?: GateOptions["requestStateBind"] } = {}): McpServer {
  return buildServer({
    client: agent,
    store,
    requestStateKey: KEY,
    holdSeconds: 1,
    verifier: { acceptedIssuers: [ISSUER], jwks: minter.jwks, fetch: null },
    onDecision: (e) => events.push(e),
    pendingVariant: true,
    ...extra,
  })
}

async function modernClient(opts: { url?: boolean; autoFulfill?: boolean; onElicit?: (url: string) => void } = {}) {
  const handler: McpHttpHandler = createMcpHandler(() => build())
  const client = new Client(
    { name: "test-modern", version: "0" },
    {
      capabilities: opts.url === false ? {} : { elicitation: { url: {} } },
      versionNegotiation: { mode: { pin: "2026-07-28" } },
      inputRequired: { autoFulfill: opts.autoFulfill ?? false, maxRounds: 20 },
    }
  )
  if (opts.url !== false) {
    client.setRequestHandler("elicitation/create", async (req) => {
      opts.onElicit?.((req.params as { url?: string }).url ?? "")
      return { action: "accept" }
    })
  }
  const transport = new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  })
  await client.connect(transport)
  cleanups.push(() => client.close(), () => handler.close())
  return client
}

async function legacyClient(opts: { url?: boolean } = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = build()
  await server.connect(serverTransport)
  const client = new Client(
    { name: "test-legacy", version: "0" },
    { capabilities: opts.url === false ? {} : { elicitation: { url: {} } }, versionNegotiation: { mode: "legacy" } }
  )
  await client.connect(clientTransport)
  cleanups.push(() => client.close(), () => server.close())
  return client
}

const call = (client: Client, name: string, amount: string, extra: Record<string, unknown> = {}, options?: { allowInputRequired?: boolean }) =>
  client.callTool({ name, arguments: args(amount), ...extra } as never, options as never) as Promise<Result>

describe("modern era (2026-07-28), URL mode declared", () => {
  it("allow runs the handler with the receipt; the downstream verifier accepts it once", async () => {
    const client = await modernClient()
    stub.authorize.push({ kind: "allow", jti: "jti_allow" })
    const result = await call(client, "transfer", "10.00")
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ authorized: true, receipt_id: "jti_allow", record_id: "rec_us_allow01" })
    expect(result._meta?.decision).toEqual({ record_id: "rec_us_allow01", receipt_id: "jti_allow" })
    const receipt = result.structuredContent?.receipt as string

    const posted = await call(client, "ledger_post", "10.00", { _meta: { oap_receipt: receipt } })
    expect(posted.structuredContent).toMatchObject({ posted: true, entry: { receipt_id: "jti_allow", amount: "10.00" } })
    const replay = await call(client, "ledger_post", "10.00", { _meta: { oap_receipt: receipt } })
    expect(replay.isError).toBe(true)
    expect(replay.structuredContent).toEqual({ posted: false, reason_code: "receipt_replayed" })
    const bare = await call(client, "ledger_post", "10.00")
    expect(bare.structuredContent).toEqual({ posted: false, reason_code: "auth_missing" })
    expect(events).toEqual([{ tool: "transfer", outcome: "allow" }])
  })

  it("deny is an error result with the public reason", async () => {
    const client = await modernClient()
    stub.authorize.push({ kind: "error", status: 403, reason_code: "value_exceeds_tx_max", denial_category: "intent_denied", failed_bound: "value_bounds.per_tx_max" })
    const result = await call(client, "transfer", "500.00")
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ authorized: false, reason_code: "value_exceeds_tx_max", failed_bound: "value_bounds.per_tx_max" })
    expect(JSON.stringify(result.content)).not.toContain("500.00")
  })

  it("unavailable fails closed as an error result", async () => {
    const client = await modernClient()
    stub.authorize.push({ kind: "transport" })
    const result = await call(client, "transfer", "10.00")
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ outcome: "unavailable", reason_code: "transport" })
  })

  it("escalate is the input-required result; the retry with the request state resumes once", async () => {
    const client = await modernClient()
    stub.authorize.push({ kind: "escalate" })
    const held = await call(client, "transfer", "75.00", {}, { allowInputRequired: true })
    expect(held.resultType).toBe("input_required")
    expect(held.inputRequests).toEqual({
      decision: { method: "elicitation/create", params: { mode: "url", url: DECISION_URL, message: "Approval needed — open Overturo to decide" } },
    })
    expect(typeof held.requestState).toBe("string")
    expect(events.at(-1)).toEqual({ tool: "transfer", outcome: "held", delivery: "input_required", decisionId: DECISION_ID })

    stub.wait.push({ kind: "approved", jti: "jti_resumed" })
    const resumed = await call(client, "transfer", "75.00", { requestState: held.requestState, inputResponses: { decision: { action: "accept" } } })
    expect(resumed.isError).toBeFalsy()
    expect(resumed.structuredContent).toMatchObject({ authorized: true, receipt_id: "jti_resumed" })
    expect(resumed._meta?.decision).toEqual({ decision_id: DECISION_ID, record_id: "rec_us_decision01", receipt_id: "jti_resumed" })
    expect(stub.authorizeCalls()).toHaveLength(1)
    expect(stub.waitCalls()).toHaveLength(1)

    // a second identical call is a new authorization, not a replay
    stub.authorize.push({ kind: "escalate", decisionId: "esc_us_second" })
    const again = await call(client, "transfer", "75.00", {}, { allowInputRequired: true })
    expect(again.resultType).toBe("input_required")
    expect(stub.authorizeCalls()).toHaveLength(2)
  })

  it("the client's own driver fulfils the URL elicitation and retries with the state", async () => {
    const seen: string[] = []
    const client = await modernClient({ autoFulfill: true, onElicit: (u) => seen.push(u) })
    stub.authorize.push({ kind: "escalate" })
    stub.wait.push({ kind: "pending", retry_after: 1 }, { kind: "approved", jti: "jti_auto" })
    const result = await call(client, "transfer", "75.00")
    expect(result.structuredContent).toMatchObject({ authorized: true, receipt_id: "jti_auto" })
    expect(seen).toEqual([DECISION_URL, DECISION_URL])
    expect(events.map((e) => e.outcome)).toEqual(["held", "pending", "held", "approved"])
  })

  it("the same delivery is answered again while the decision is still pending", async () => {
    const client = await modernClient()
    stub.authorize.push({ kind: "escalate" })
    const held = await call(client, "transfer", "75.00", {}, { allowInputRequired: true })
    stub.wait.push({ kind: "pending", retry_after: 1 })
    const still = await call(client, "transfer", "75.00", { requestState: held.requestState, inputResponses: { decision: { action: "accept" } } }, { allowInputRequired: true })
    expect(still.resultType).toBe("input_required")
    expect(stub.authorizeCalls()).toHaveLength(1)
  })

  it("refused, lapsed and countered decisions are error results and the next call authorizes anew", async () => {
    const client = await modernClient()
    for (const [wait, outcome] of [
      [{ kind: "denied", decidedBy: "Ada" }, "denied"],
      [{ kind: "receipt_expired" }, "receipt_expired"],
      [{ kind: "countered", negotiationId: "neg_1" }, "countered"],
      [{ kind: "expired" }, "expired"],
      [{ kind: "cancelled" }, "cancelled"],
    ] as const) {
      stub.authorize.push({ kind: "escalate" })
      const held = await call(client, "transfer", "75.00", {}, { allowInputRequired: true })
      stub.wait.push(wait as never)
      const result = await call(client, "transfer", "75.00", { requestState: held.requestState, inputResponses: { decision: { action: "accept" } } })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ authorized: false, outcome })
    }
    expect(stub.authorizeCalls()).toHaveLength(5)
  })

  it("a request state is bound to the principal that minted it when requestStateBind is set", async () => {
    const principalOf = (ctx: { mcpReq: { _meta?: Record<string, unknown> } }) => String(ctx.mcpReq._meta?.principal ?? "")
    const handler: McpHttpHandler = createMcpHandler(() => build({ requestStateBind: principalOf as never } as never))
    const client = new Client(
      { name: "test-bound", version: "0" },
      { capabilities: { elicitation: { url: {} } }, versionNegotiation: { mode: { pin: "2026-07-28" } }, inputRequired: { autoFulfill: false, maxRounds: 20 } }
    )
    client.setRequestHandler("elicitation/create", async () => ({ action: "accept" }))
    const transport = new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), { fetch: (url, init) => handler.fetch(new Request(url, init)) })
    await client.connect(transport)
    cleanups.push(() => client.close(), () => handler.close())

    stub.authorize.push({ kind: "escalate" })
    const held = await call(client, "transfer", "75.00", { _meta: { principal: "alice" } }, { allowInputRequired: true })
    expect(held.resultType).toBe("input_required")
    const state = held.requestState as string
    await expect(call(client, "transfer", "75.00", { _meta: { principal: "bob" }, requestState: state, inputResponses: { decision: { action: "accept" } } })).rejects.toMatchObject({ code: -32602 })
    stub.wait.push({ kind: "approved", jti: "jti_alice" })
    const resumed = await call(client, "transfer", "75.00", { _meta: { principal: "alice" }, requestState: state, inputResponses: { decision: { action: "accept" } } })
    expect(resumed.structuredContent).toMatchObject({ authorized: true, receipt_id: "jti_alice" })
  })

  it("a request state delivers the decision page again where the store never saw the hold", async () => {
    const client = await modernClient()
    stub.authorize.push({ kind: "escalate" })
    const held = await call(client, "transfer", "75.00", {}, { allowInputRequired: true })
    await store.delete(`resume:transfer:${(await import("../src/core/canonical.js")).argumentsDigest(args("75.00"))}`)
    stub.wait.push({ kind: "pending", retry_after: 1 })
    const again = await call(client, "transfer", "75.00", { requestState: held.requestState, inputResponses: { decision: { action: "accept" } } }, { allowInputRequired: true })
    expect(again.resultType).toBe("input_required")
    expect(again.inputRequests).toMatchObject({ decision: { params: { url: DECISION_URL } } })
  })

  it("a tampered, foreign-key or expired request state is refused at the seam with invalid params (-32602)", async () => {
    const client = await modernClient()
    stub.authorize.push({ kind: "escalate" })
    const held = await call(client, "transfer", "75.00", {}, { allowInputRequired: true })
    const state = held.requestState as string

    await expect(call(client, "transfer", "75.00", { requestState: `${state}x` })).rejects.toMatchObject({ code: -32602 })
    const other = createRequestStateCodec({ key: "another-key-another-key-another-key-00" })
    const foreign = await other.mint({ decision_id: DECISION_ID, tool: "transfer", digest: "x" })
    await expect(call(client, "transfer", "75.00", { requestState: foreign })).rejects.toMatchObject({ code: -32602 })
    const expired = createRequestStateCodec({ key: KEY, ttlSeconds: 1 })
    const stale = await expired.mint({ decision_id: DECISION_ID, tool: "transfer", digest: "x" })
    await new Promise((r) => setTimeout(r, 2_100))
    await expect(call(client, "transfer", "75.00", { requestState: stale })).rejects.toMatchObject({ code: -32602 })
    expect(stub.waitCalls()).toHaveLength(0)
  })

  it("a valid state echoed for another tool, other arguments or another decision resumes nothing", async () => {
    const client = await modernClient()
    stub.authorize.push({ kind: "escalate" })
    const held = await call(client, "transfer", "75.00", {}, { allowInputRequired: true })
    const state = held.requestState as string
    const refused = (r: Result) => {
      expect(r.isError).toBe(true)
      expect(r.structuredContent).toMatchObject({ outcome: "invalid_request_state" })
    }
    // other arguments name another digest
    refused(await call(client, "transfer", "76.00", { requestState: state }))
    // an honest state for another tool
    const own = createRequestStateCodec({ key: KEY })
    refused(await call(client, "transfer", "75.00", { requestState: await own.mint({ decision_id: DECISION_ID, tool: "transfer_pending", digest: "x" }) }))
    // another decision than the open one
    const { argumentsDigest } = await import("../src/core/canonical.js")
    const other = await own.mint({ decision_id: "esc_us_other", tool: "transfer", digest: argumentsDigest(args("75.00")) })
    refused(await call(client, "transfer", "75.00", { requestState: other }))
    expect(stub.waitCalls()).toHaveLength(0)
    expect(stub.authorizeCalls()).toHaveLength(1)
  })

  it("verifies the raw wire state itself when the server was built without the verifier option", async () => {
    const { McpServer } = await import("@modelcontextprotocol/server")
    const server = new McpServer({ name: "bare", version: "0" })
    const opts: GateOptions = { server, client: agent, store, requestStateKey: KEY, holdSeconds: 1, onDecision: (e) => events.push(e) }
    server.registerTool("transfer", { inputSchema: (await import("zod")).z.object({ amount: z.string(), currency: z.string(), payee: z.string() }) }, gateTool("transfer", { action: "write", scope: "s", value: (a: { amount: string }) => a.amount, currency: () => "USD" }, async () => ({ content: [], structuredContent: { ran: true } }), opts))
    const handler = createMcpHandler(() => server)
    const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: { url: {} } }, versionNegotiation: { mode: { pin: "2026-07-28" } }, inputRequired: { autoFulfill: false } })
    await client.connect(new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), { fetch: (u, i) => handler.fetch(new Request(u, i)) }))
    cleanups.push(() => client.close(), () => handler.close())
    stub.authorize.push({ kind: "escalate" })
    const held = await call(client, "transfer", "75.00", {}, { allowInputRequired: true })
    const bad = await call(client, "transfer", "75.00", { requestState: `${held.requestState}x` })
    expect(bad.structuredContent).toMatchObject({ outcome: "invalid_request_state" })
    stub.wait.push({ kind: "approved" })
    const ok = await call(client, "transfer", "75.00", { requestState: held.requestState, inputResponses: { decision: { action: "accept" } } })
    expect(ok.structuredContent).toEqual({ ran: true })
  })
})

describe("modern era without URL mode, and delivery: pending", () => {
  it("answers the pending result when the client declared no URL mode", async () => {
    const client = await modernClient({ url: false })
    stub.authorize.push({ kind: "escalate" })
    const result = await call(client, "transfer", "75.00")
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toMatchObject({ held: true, decision_id: DECISION_ID, decision_url: DECISION_URL, trigger: "approval" })
    expect(result._meta).toMatchObject({ held: true, decision_id: DECISION_ID })
    expect(events.at(-1)).toEqual({ tool: "transfer", outcome: "held", delivery: "pending", decisionId: DECISION_ID })

    stub.wait.push({ kind: "approved", jti: "jti_pending_resume" })
    const resumed = await call(client, "transfer", "75.00")
    expect(resumed.structuredContent).toMatchObject({ authorized: true, receipt_id: "jti_pending_resume" })
  })

  it("answers pending for a delivery: pending tool even with URL mode declared", async () => {
    const client = await modernClient()
    stub.authorize.push({ kind: "escalate" })
    const result = await call(client, "transfer_pending", "75.00")
    expect(result.structuredContent).toMatchObject({ held: true, decision_url: DECISION_URL })
    expect(events.at(-1)).toMatchObject({ outcome: "held", delivery: "pending" })
  })
})

describe("legacy era (2025-11-25) on the v2 server", () => {
  it("URL mode declared: the -32042 error with one URL-mode elicitation; the retry resumes from the store", async () => {
    const client = await legacyClient()
    stub.authorize.push({ kind: "escalate" })
    let caught: { code?: number; elicitations?: unknown } | undefined
    try {
      await call(client, "transfer", "75.00")
    } catch (e) {
      caught = e as never
    }
    expect(caught?.code).toBe(-32042)
    expect(caught?.elicitations).toEqual([{ mode: "url", elicitationId: DECISION_ID, url: DECISION_URL, message: "Approval needed — open Overturo to decide" }])
    expect(events.at(-1)).toEqual({ tool: "transfer", outcome: "held", delivery: "url_error", decisionId: DECISION_ID })

    stub.wait.push({ kind: "approved", jti: "jti_legacy" })
    const resumed = await call(client, "transfer", "75.00")
    expect(resumed.structuredContent).toMatchObject({ authorized: true, receipt_id: "jti_legacy" })
    expect(resumed._meta?.decision).toMatchObject({ decision_id: DECISION_ID })
  })

  it("no URL mode: the pending result", async () => {
    const client = await legacyClient({ url: false })
    stub.authorize.push({ kind: "escalate" })
    const result = await call(client, "transfer", "75.00")
    expect(result.structuredContent).toMatchObject({ held: true, decision_id: DECISION_ID })
  })

  it("allow and deny behave as on the modern era", async () => {
    const client = await legacyClient()
    stub.authorize.push({ kind: "allow", jti: "jti_legacy_allow" })
    expect((await call(client, "transfer", "10.00")).structuredContent).toMatchObject({ authorized: true })
    stub.authorize.push({ kind: "error", status: 403, reason_code: "action_not_allowed", denial_category: "intent_denied" })
    const denied = await call(client, "transfer", "10.00")
    expect(denied.isError).toBe(true)
    expect(denied.structuredContent).toMatchObject({ reason_code: "action_not_allowed" })
  })
})

describe("gateTools and option validation", () => {
  it("wraps declared tools and leaves the rest untouched", () => {
    const server = build()
    const opts: GateOptions = { server, client: agent, requestStateKey: KEY }
    const plain = async () => ({ content: [] })
    const wrapped = gateTools({ transfer: { decl: { action: "write", scope: "s" }, handler: plain }, ping: { handler: plain } }, opts)
    expect(wrapped.ping).toBe(plain)
    expect(wrapped.transfer).not.toBe(plain)
    expect(typeof wrapped.transfer).toBe("function")
  })

  it("refuses a missing server, key or client, and a bad declaration", () => {
    const server = build()
    expect(() => gateTool("t", { action: "a", scope: "s" }, async () => ({ content: [] }), { server: undefined as never, client: agent, requestStateKey: KEY })).toThrow(/server/)
    expect(() => gateTool("t", { action: "a", scope: "s" }, async () => ({ content: [] }), { server, client: agent, requestStateKey: "" })).toThrow(/requestStateKey/)
    expect(() => gateTool("t", { action: "a", scope: "s" }, async () => ({ content: [] }), { server, client: undefined as never, requestStateKey: KEY })).toThrow(/client/)
    expect(() => gateTool("t", { action: "a", scope: "s", value: () => "1" }, async () => ({ content: [] }), { server, client: agent, requestStateKey: KEY })).toThrow(/currency/)
  })

  it("selects the delivery from the declaration and the capabilities", () => {
    expect(supportsUrlMode(undefined)).toBe(false)
    expect(supportsUrlMode({ elicitation: {} })).toBe(false)
    expect(supportsUrlMode({ elicitation: { url: {} } })).toBe(true)
    const server = build()
    const ctx = { mcpReq: { _meta: {}, envelope: {} } } as never
    expect(selectDelivery(server, ctx, { action: "a", scope: "s", delivery: "pending" })).toBe("pending")
    expect(selectDelivery(server, ctx, { action: "a", scope: "s" })).toBe("pending")
  })
})
