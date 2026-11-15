/**
 * @overturo/mcp-authorize/server — the adapter for @modelcontextprotocol/server (v2).
 *
 * Wrap a tool's handler; registration, schemas and transport are unchanged:
 *
 *     server.registerTool("transfer", { inputSchema }, gateTool("transfer", decl, handler, opts))
 *
 * A held decision is delivered the way the client declared it can take it:
 * the input-required result (2026-07-28, URL mode declared), the `-32042`
 * error (a legacy-era connection that declared URL mode), or the pending
 * result (everything else, and every tool with `delivery: "pending"`).
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  UrlElicitationRequiredError,
  createRequestStateCodec,
  inputRequired,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server"
import type { OverturoAuthorize } from "@overturo/sdk"
import { INPUT_KEY } from "./core/builder.js"
import { argumentsDigest } from "./core/canonical.js"
import { validateDeclaration, type ToolAuthorization } from "./core/declaration.js"
import { createGateCore, gateCall, remainingSeconds, type GateCore } from "./core/gate.js"
import { emitDecision, type DeliveryName, type OnDecision } from "./core/hooks.js"
import type { Decision, HeldDecision } from "./core/outcomes.js"
import { DEFAULT_MESSAGE, heldPendingResult, invalidRequestStateResult, withDecisionMeta } from "./core/results.js"
import type { Store } from "./core/stores.js"

export type { ToolAuthorization } from "./core/declaration.js"
export type { Decision, HeldDecision } from "./core/outcomes.js"
export type { Store } from "./core/stores.js"
export type { DecisionEvent, OnDecision, DeliveryName } from "./core/hooks.js"
export { MemoryStore } from "./core/stores.js"

export const MODERN_PROTOCOL_VERSION = "2026-07-28"

export interface GateOptions {
  /** The server instance the gated tools are registered on (its negotiated revision and client capabilities select the delivery). */
  server: McpServer
  /** The grant's agent credential, from @overturo/sdk. */
  client: OverturoAuthorize
  /** Resumption store (in-memory default; plug a shared one for a multi-process server). */
  store?: Store
  /** HMAC key for the 2026-07-28 request state, at least 32 bytes; the same on every process. */
  requestStateKey: Uint8Array | string
  /**
   * Binds the request state to the principal (and anything else) of the call
   * that minted it; a state echoed under another value is refused at the seam.
   * Read it from your own authentication (`ctx.http?.authInfo`, a session, …).
   * Without it, any client of this server that can reach the same tool with
   * the same arguments could echo another client's state.
   */
  requestStateBind?: (ctx: ServerContext) => string
  /** Bounded settlement wait per call (default 20 s). */
  holdSeconds?: number
  /** The one-line message on every delivery (default "Approval needed — open Overturo to decide"). */
  message?: string
  /** One event per outcome, for the author's own metrics. */
  onDecision?: OnDecision
  /** Clock overrides for tests. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** The verified payload the request state carries between rounds. */
export interface HeldState {
  decision_id: string
  tool: string
  digest: string
  /** The decision page and expiry, so a process whose store never saw the hold can still deliver and bound it. */
  decision_url?: string
  expires_at?: string
}

/** A gated handler: the arguments, the SDK context, and the decision the action runs under. */
export type GatedToolHandler<Args> = (
  args: Args,
  ctx: ServerContext,
  decision: Decision
) => CallToolResult | Promise<CallToolResult>

export type GatedToolCallback<Args> = (args: Args, ctx: ServerContext) => Promise<CallToolResult | InputRequiredResult>

interface Prepared {
  core: GateCore
  message: string
  codecFor: (ttlSeconds: number) => ReturnType<typeof createRequestStateCodec<HeldState>>
  verifyState: (state: string, ctx: ServerContext) => Promise<HeldState>
  server: McpServer
}

const prepared = new WeakMap<GateOptions, Prepared>()

function prepare(opts: GateOptions): Prepared {
  const found = prepared.get(opts)
  if (found) return found
  if (!opts.requestStateKey) throw new Error("gateTool: requestStateKey is required (at least 32 bytes)")
  const bind = opts.requestStateBind ? { bind: opts.requestStateBind } : {}
  const shared = createRequestStateCodec<HeldState>({ key: opts.requestStateKey, ...bind })
  const p: Prepared = {
    core: createGateCore(opts),
    message: opts.message ?? DEFAULT_MESSAGE,
    codecFor: (ttlSeconds) => createRequestStateCodec<HeldState>({ key: opts.requestStateKey, ttlSeconds, ...bind }),
    verifyState: (state, ctx) => shared.verify(state, ctx),
    // Read lazily: the verifier is built before the McpServer exists (it is one of its options).
    get server() {
      return opts.server
    },
  }
  prepared.set(opts, p)
  return p
}

/**
 * The server option that verifies our request state before any handler runs:
 *
 *     new McpServer(info, { requestState: { verify: requestStateVerifier(opts) } })
 *
 * A rejection answers the SDK's invalid-params error; nothing is resumed.
 */
export function requestStateVerifier(opts: GateOptions): (state: string, ctx: ServerContext) => Promise<unknown> {
  const p = prepare(opts)
  return (state, ctx) => p.verifyState(state, ctx)
}

/** Wrap one handler. `server.registerTool(name, config, gateTool(name, decl, handler, opts))`. */
export function gateTool<Args extends Record<string, unknown> = Record<string, unknown>>(
  tool: string,
  decl: ToolAuthorization<Args>,
  handler: GatedToolHandler<Args>,
  opts: GateOptions
): GatedToolCallback<Args> {
  validateDeclaration(tool, decl as ToolAuthorization<never>)
  if (!opts.server) throw new Error("gateTool: server is required (the McpServer the tools are registered on)")
  const p = prepare(opts)

  return async (args, ctx) => {
    const pointer = await readPointer(p, ctx, tool, argumentsDigest(args))
    if (pointer === "invalid") return invalidRequestStateResult() as CallToolResult
    const step = await gateCall(p.core, tool, decl, args, pointer)
    switch (step.kind) {
      case "run": {
        const result = await handler(args, ctx, step.decision)
        return withDecisionMeta(result, step.decision)
      }
      case "result":
        return step.result as CallToolResult
      case "invalid_state":
        return invalidRequestStateResult() as CallToolResult
      case "held":
        return deliver(p, tool, decl, ctx, step.held, step.digest)
    }
  }
}

/** Wrap several. Tools without a declaration are returned untouched and never gated. */
export function gateTools<T extends Record<string, { decl?: ToolAuthorization<never>; handler: (...a: never[]) => unknown }>>(
  tools: T,
  opts: GateOptions
): { [K in keyof T]: T[K]["decl"] extends ToolAuthorization<never> ? GatedToolCallback<Record<string, unknown>> : T[K]["handler"] } {
  const out: Record<string, unknown> = {}
  for (const [name, entry] of Object.entries(tools)) {
    out[name] = entry.decl
      ? gateTool(name, entry.decl as ToolAuthorization<Record<string, unknown>>, entry.handler as GatedToolHandler<Record<string, unknown>>, opts)
      : entry.handler
  }
  return out as never
}

/**
 * The echoed request state, already verified by the seam (`requestStateVerifier`)
 * — a tampered or expired one was answered with the protocol's invalid-params
 * error before this ran. When the seam was not configured the wire string
 * arrives raw and is verified here. A valid state must name this tool and these
 * arguments; otherwise nothing is resumed.
 */
async function readPointer(p: Prepared, ctx: ServerContext, tool: string, digest: string): Promise<HeldPointerOrInvalid> {
  const raw = ctx.mcpReq.requestState<HeldState | string>()
  if (raw === undefined) return undefined
  let state: HeldState
  if (typeof raw === "string") {
    try {
      state = await p.verifyState(raw, ctx)
    } catch {
      return "invalid"
    }
  } else {
    state = raw
  }
  if (!state || typeof state !== "object" || state.tool !== tool || state.digest !== digest || !state.decision_id) {
    return "invalid"
  }
  const pointer: HeldPointerOrInvalid = { decisionId: state.decision_id }
  if (typeof state.decision_url === "string" && state.decision_url) pointer.decisionUrl = state.decision_url
  if (typeof state.expires_at === "string" && state.expires_at) pointer.expiresAt = state.expires_at
  return pointer
}

type HeldPointerOrInvalid = { decisionId: string; decisionUrl?: string; expiresAt?: string } | "invalid" | undefined

/** Delivery selection: what the client declared on the revision in use, never who the client is. */
export function selectDelivery(server: McpServer, ctx: ServerContext, decl: ToolAuthorization<never>): DeliveryName {
  if (decl.delivery === "pending") return "pending"
  const modern = isModern(server)
  const caps = clientCapabilities(server, ctx, modern)
  if (!supportsUrlMode(caps)) return "pending"
  return modern ? "input_required" : "url_error"
}

function isModern(server: McpServer): boolean {
  return (server.server.getNegotiatedProtocolVersion() ?? "") >= MODERN_PROTOCOL_VERSION
}

function clientCapabilities(server: McpServer, ctx: ServerContext, modern: boolean): ClientCapabilities | undefined {
  if (modern) {
    const envelope = (ctx.mcpReq.envelope ?? {}) as Record<string, unknown>
    const meta = (ctx.mcpReq._meta ?? {}) as Record<string, unknown>
    const fromRequest = envelope[CLIENT_CAPABILITIES_META_KEY] ?? meta[CLIENT_CAPABILITIES_META_KEY]
    if (fromRequest && typeof fromRequest === "object") return fromRequest as ClientCapabilities
  }
  return server.server.getClientCapabilities()
}

/** URL mode is supported only when the client declared it explicitly. */
export function supportsUrlMode(caps: ClientCapabilities | undefined): boolean {
  const elicitation = (caps as { elicitation?: { url?: unknown } } | undefined)?.elicitation
  return !!elicitation && typeof elicitation === "object" && elicitation.url !== undefined
}

async function deliver(
  p: Prepared,
  tool: string,
  decl: ToolAuthorization<never>,
  ctx: ServerContext,
  held: HeldDecision,
  digest: string
): Promise<CallToolResult | InputRequiredResult> {
  const delivery = selectDelivery(p.server, ctx, decl)
  emitDecision(p.core.onDecision, { tool, outcome: "held", delivery, decisionId: held.decisionId })
  switch (delivery) {
    case "input_required": {
      const codec = p.codecFor(remainingSeconds(held, p.core.now))
      const requestState = await codec.mint(
        { decision_id: held.decisionId, tool, digest, decision_url: held.decisionUrl, expires_at: held.expiresAt.toISOString() },
        ctx
      )
      return inputRequired({
        inputRequests: { [INPUT_KEY]: inputRequired.elicitUrl({ url: held.decisionUrl, message: p.message }) },
        requestState,
      })
    }
    case "url_error":
      throw new UrlElicitationRequiredError(
        [{ mode: "url", elicitationId: held.decisionId, url: held.decisionUrl, message: p.message }],
        p.message
      )
    case "pending":
      return heldPendingResult(held, p.message) as unknown as CallToolResult
  }
}
