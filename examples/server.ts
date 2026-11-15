/**
 * The example server: one process, both roles.
 *
 *   - `transfer`      — agent role. Gated: Overturo decides before the handler runs.
 *                       The handler hands the receipt back so the caller can forward it downstream.
 *   - `ledger_post`   — counterparty role. Verifies the receipt a caller carries in `_meta.oap_receipt`
 *                       (signature, issuer, audience, binding, replay) before posting the entry.
 *   - `transfer_pending` (opt-in) — the same declaration with `delivery: "pending"`, for a tool
 *                       whose caller is never one of the decision's signers.
 *
 * The integration tests and the live walk both drive it.
 */
import { McpServer, type ServerContext } from "@modelcontextprotocol/server"
import { z } from "zod"
import {
  KeySetSource,
  MemoryStore,
  verifyReceipt,
  type JwksKey,
  type OnDecision,
  type OverturoAuthorize,
  type Store,
  type ToolAuthorization,
} from "@overturo/mcp-authorize"
import { gateTool, requestStateVerifier, type GateOptions } from "@overturo/mcp-authorize/server"

export const DEFAULT_ACTION = "write"
export const DEFAULT_SCOPE = "payments:transfer"
export const LEDGER_IDENTIFIER = "did:web:ledger.example.com"

export interface LedgerVerifierOptions {
  /** Issuers whose receipts the ledger accepts (the regional apexes). */
  acceptedIssuers: string[]
  /** The ledger's own identifier — the receipt's `aud`. */
  ownIdentifier?: string
  /** A shared key-set source; built from `jwks` and the issuers otherwise. */
  keys?: KeySetSource
  /** Static keys for air-gapped runs and tests. */
  jwks?: JwksKey[]
  /** Replay store (shares the resumption store by default). */
  replay?: Store
  fetch?: typeof fetch | null
  skewSeconds?: number
}

export interface ExampleServerOptions {
  /** The grant's agent credential (`new OverturoAuthorize({...})` from @overturo/sdk). */
  client: OverturoAuthorize
  /** HMAC key for the 2026-07-28 request state (≥ 32 bytes). */
  requestStateKey: Uint8Array | string
  /** Binds the request state to the calling principal (see GateOptions.requestStateBind). */
  requestStateBind?: GateOptions["requestStateBind"]
  /** Shared resumption (and replay) store; in-memory by default. */
  store?: Store
  holdSeconds?: number
  onDecision?: OnDecision
  /** Action token the grant covers (default "write"). */
  action?: string
  /** Scope token the grant covers (default "payments:transfer"). */
  scope?: string
  /** Counterparty the receipt is issued for (default the ledger's identifier). */
  counterparty?: string
  verifier: LedgerVerifierOptions
  /** Also register `transfer_pending`, the `delivery: "pending"` variant. */
  pendingVariant?: boolean
  /** Clock overrides for tests. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface TransferArgs extends Record<string, unknown> {
  amount: string
  currency: string
  payee: string
  memo?: string
}

const transferSchema = z.object({
  amount: z.string().describe("Decimal amount as a string, e.g. \"47.50\""),
  currency: z.string().describe("ISO 4217 or stablecoin code"),
  payee: z.string().describe("Who receives the transfer"),
  memo: z.string().optional(),
})

const ledgerPostSchema = z.object({
  amount: z.string(),
  currency: z.string(),
  payee: z.string(),
})

export interface LedgerEntry {
  id: string
  amount: string
  currency: string
  payee: string
  receipt_id: string
  grant_id: string
}

/** The downstream service: it honours a transfer only against a receipt it verified itself. */
export function createLedger(opts: LedgerVerifierOptions & { action: string; scope: string; replay: Store }) {
  const entries: LedgerEntry[] = []
  const keys =
    opts.keys ?? new KeySetSource({ issuers: opts.acceptedIssuers, jwks: opts.jwks, fetch: opts.fetch })
  const audience = opts.ownIdentifier ?? LEDGER_IDENTIFIER
  return {
    entries,
    async post(input: { amount: string; currency: string; payee: string; receipt: string | null }) {
      if (!input.receipt) return { ok: false as const, reason_code: "auth_missing" as const }
      const outcome = await verifyReceipt(input.receipt, {
        audience,
        acceptedIssuers: opts.acceptedIssuers,
        keys,
        replay: opts.replay,
        skewSeconds: opts.skewSeconds,
        bind: { action: opts.action, scope: opts.scope, value: input.amount, currency: input.currency },
      })
      if (outcome.ok !== true) {
        return { ok: false as const, reason_code: outcome.ok === false ? outcome.reasonCode : ("auth_missing" as const) }
      }
      const entry: LedgerEntry = {
        id: `led_${entries.length + 1}`,
        amount: input.amount,
        currency: input.currency,
        payee: input.payee,
        receipt_id: outcome.claims.jti,
        grant_id: outcome.claims.grant_id,
      }
      entries.push(entry)
      return { ok: true as const, entry }
    },
  }
}

/** Builds the example server. Call it once per server instance (a modern-era factory calls it per request). */
export function buildServer(opts: ExampleServerOptions): McpServer {
  const action = opts.action ?? DEFAULT_ACTION
  const scope = opts.scope ?? DEFAULT_SCOPE
  const counterparty = opts.counterparty ?? opts.verifier.ownIdentifier ?? LEDGER_IDENTIFIER
  const store = opts.store ?? new MemoryStore()
  const ledger = createLedger({ ...opts.verifier, action, scope, replay: opts.verifier.replay ?? store })

  const gate: GateOptions = {
    server: undefined as unknown as McpServer,
    client: opts.client,
    store,
    requestStateKey: opts.requestStateKey,
    requestStateBind: opts.requestStateBind,
    holdSeconds: opts.holdSeconds,
    onDecision: opts.onDecision,
    now: opts.now,
    sleep: opts.sleep,
  }
  const server = new McpServer(
    { name: "overturo-mcp-authorize-example", version: "2.0.0" },
    { requestState: { verify: requestStateVerifier(gate) } }
  )
  gate.server = server

  const declaration: ToolAuthorization<TransferArgs> = {
    action,
    scope,
    value: (a) => a.amount,
    currency: (a) => a.currency,
    counterparty: () => counterparty,
    context: (a) => ({ payee: a.payee, ...(a.memo ? { memo: a.memo } : {}) }),
  }

  const transferHandler = async (args: TransferArgs, _ctx: ServerContext, decision: { receipt: string; receiptId: string; recordId: string }) => ({
    content: [{ type: "text" as const, text: `Transfer of ${args.amount} ${args.currency} to ${args.payee} is authorized.` }],
    structuredContent: {
      authorized: true,
      receipt: decision.receipt,
      receipt_id: decision.receiptId,
      record_id: decision.recordId,
      next: "Hand the receipt to ledger_post in _meta.oap_receipt.",
    },
  })

  server.registerTool(
    "transfer",
    { description: "Move money. Authorized by Overturo before it runs.", inputSchema: transferSchema },
    gateTool<TransferArgs>("transfer", declaration, transferHandler, gate)
  )

  if (opts.pendingVariant) {
    server.registerTool(
      "transfer_pending",
      { description: "Move money; a held decision is always answered as pending.", inputSchema: transferSchema },
      gateTool<TransferArgs>("transfer_pending", { ...declaration, delivery: "pending" }, transferHandler, gate)
    )
  }

  server.registerTool(
    "ledger_post",
    { description: "Post a transfer to the ledger. Carries the receipt in _meta.oap_receipt.", inputSchema: ledgerPostSchema },
    async (args, ctx) => {
      const meta = (ctx.mcpReq._meta ?? {}) as Record<string, unknown>
      const receipt = typeof meta.oap_receipt === "string" ? meta.oap_receipt : null
      const posted = await ledger.post({ ...args, receipt })
      if (!posted.ok) {
        return {
          content: [{ type: "text" as const, text: `The Receipt was not accepted (${posted.reason_code}); nothing was posted.` }],
          structuredContent: { posted: false, reason_code: posted.reason_code },
          isError: true,
        }
      }
      return {
        content: [{ type: "text" as const, text: `Posted ${posted.entry.amount} ${posted.entry.currency} to ${posted.entry.payee}.` }],
        structuredContent: { posted: true, entry: posted.entry },
      }
    }
  )

  return server
}
