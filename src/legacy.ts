/**
 * @overturo/mcp-authorize/legacy — the compatibility adapter for
 * @modelcontextprotocol/sdk (v1). The input-required result does not exist on
 * this line: a held decision is the `-32042` error when the client declared
 * URL mode on `initialize`, else the pending result. The store is the only
 * pointer between rounds.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  UrlElicitationRequiredError,
  type CallToolResult,
  type ClientCapabilities,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js"
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js"
import type { OverturoAuthorize } from "@overturo/sdk"
import { validateDeclaration, type ToolAuthorization } from "./core/declaration.js"
import { createGateCore, gateCall, type GateCore } from "./core/gate.js"
import { emitDecision, type DeliveryName, type OnDecision } from "./core/hooks.js"
import type { Decision, HeldDecision } from "./core/outcomes.js"
import { DEFAULT_MESSAGE, heldPendingResult, invalidRequestStateResult, withDecisionMeta } from "./core/results.js"
import type { Store } from "./core/stores.js"

export type { ToolAuthorization } from "./core/declaration.js"
export type { Decision, HeldDecision } from "./core/outcomes.js"
export type { Store } from "./core/stores.js"
export type { DecisionEvent, OnDecision, DeliveryName } from "./core/hooks.js"
export { MemoryStore } from "./core/stores.js"

export type LegacyExtra = RequestHandlerExtra<ServerRequest, ServerNotification>

export interface LegacyGateOptions {
  /** The server the gated tools are registered on (its negotiated client capabilities select the delivery). */
  server: McpServer
  client: OverturoAuthorize
  store?: Store
  holdSeconds?: number
  message?: string
  onDecision?: OnDecision
  /** Clock overrides for tests. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type LegacyGatedToolHandler<Args> = (
  args: Args,
  extra: LegacyExtra,
  decision: Decision
) => CallToolResult | Promise<CallToolResult>

export type LegacyGatedToolCallback<Args> = (args: Args, extra: LegacyExtra) => Promise<CallToolResult>

interface Prepared {
  core: GateCore
  message: string
  server: McpServer
}

const prepared = new WeakMap<LegacyGateOptions, Prepared>()

function prepare(opts: LegacyGateOptions): Prepared {
  const found = prepared.get(opts)
  if (found) return found
  if (!opts.server) throw new Error("gateTool: server is required (the McpServer the tools are registered on)")
  const p: Prepared = { core: createGateCore(opts), message: opts.message ?? DEFAULT_MESSAGE, server: opts.server }
  prepared.set(opts, p)
  return p
}

/** Wrap one handler. `server.registerTool(name, config, gateTool(name, decl, handler, opts))`. */
export function gateTool<Args extends Record<string, unknown> = Record<string, unknown>>(
  tool: string,
  decl: ToolAuthorization<Args>,
  handler: LegacyGatedToolHandler<Args>,
  opts: LegacyGateOptions
): LegacyGatedToolCallback<Args> {
  validateDeclaration(tool, decl as ToolAuthorization<never>)
  const p = prepare(opts)

  return async (args, extra) => {
    const step = await gateCall(p.core, tool, decl, args)
    switch (step.kind) {
      case "run": {
        const result = await handler(args, extra, step.decision)
        return withDecisionMeta(result, step.decision)
      }
      case "result":
        return step.result as CallToolResult
      case "invalid_state":
        // Unreachable on this line (no request state exists); kept for the exhaustive switch.
        return invalidRequestStateResult() as CallToolResult
      case "held":
        return deliver(p, tool, decl, step.held)
    }
  }
}

/** Wrap several. Tools without a declaration are returned untouched and never gated. */
export function gateTools<T extends Record<string, { decl?: ToolAuthorization<never>; handler: (...a: never[]) => unknown }>>(
  tools: T,
  opts: LegacyGateOptions
): { [K in keyof T]: T[K]["decl"] extends ToolAuthorization<never> ? LegacyGatedToolCallback<Record<string, unknown>> : T[K]["handler"] } {
  const out: Record<string, unknown> = {}
  for (const [name, entry] of Object.entries(tools)) {
    out[name] = entry.decl
      ? gateTool(
          name,
          entry.decl as ToolAuthorization<Record<string, unknown>>,
          entry.handler as LegacyGatedToolHandler<Record<string, unknown>>,
          opts
        )
      : entry.handler
  }
  return out as never
}

/** Delivery selection on v1: the capabilities negotiated on `initialize`; a server that exposes none selects pending. */
export function selectDelivery(server: McpServer, decl: ToolAuthorization<never>): DeliveryName {
  if (decl.delivery === "pending") return "pending"
  let caps: ClientCapabilities | undefined
  try {
    caps = server.server.getClientCapabilities()
  } catch {
    caps = undefined
  }
  return supportsUrlMode(caps) ? "url_error" : "pending"
}

export function supportsUrlMode(caps: ClientCapabilities | undefined): boolean {
  const elicitation = (caps as { elicitation?: { url?: unknown } } | undefined)?.elicitation
  return !!elicitation && typeof elicitation === "object" && elicitation.url !== undefined
}

function deliver(p: Prepared, tool: string, decl: ToolAuthorization<never>, held: HeldDecision): CallToolResult {
  const delivery = selectDelivery(p.server, decl)
  emitDecision(p.core.onDecision, { tool, outcome: "held", delivery, decisionId: held.decisionId })
  if (delivery === "url_error") {
    throw new UrlElicitationRequiredError(
      [{ mode: "url", elicitationId: held.decisionId, url: held.decisionUrl, message: p.message }],
      p.message
    )
  }
  return heldPendingResult(held, p.message) as unknown as CallToolResult
}
