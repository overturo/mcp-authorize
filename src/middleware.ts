import { OapError, type JwksKey, type OapReasonCode, type ReceiptClaims } from "@overturo/sdk"
import { KeySetSource } from "./core/keys.js"
import type { Store } from "./core/stores.js"
import { verifyReceipt, type ReceiptBinding } from "./core/verify.js"

/**
 * Minimal shape of an MCP-style request. The counterparty-role verifier is
 * generic over the JSON-RPC envelope: anything with a tool invocation
 * carrying `_meta`-style out-of-band metadata.
 */
export interface McpRequest {
  method?: string
  params?: {
    _meta?: Record<string, unknown>
    [k: string]: unknown
  }
  [k: string]: unknown
}

/**
 * Strategy that extracts the receipt string from a request. The default reads
 * `params._meta.oap_receipt`, where the protocol carries the receipt.
 */
export type McpReceiptExtractor = (req: McpRequest) => string | null

/** Result of a successful verification — attached to the request context. */
export interface McpAuthorizeContext {
  claims: ReceiptClaims
  receipt: string
}

/**
 * Outcome shape returned from the verifier. Soft mode (`required: false`)
 * answers `no_receipt` for a call without a receipt — a third variant, with
 * no claim object at all.
 */
export type McpAuthorizeOutcome =
  | { ok: true; context: McpAuthorizeContext }
  | { ok: false; reason_code: OapReasonCode }
  | { ok: "no_receipt" }

export interface McpAuthorizeOptions {
  /** Issuer URLs the server accepts receipts from. */
  acceptedIssuers: string[]
  /** Counterparty identifier that MUST match the receipt's `aud` claim (the server's DID or HTTPS URL). */
  ownIdentifier: string
  /**
   * Static keys — a fallback for air-gapped servers and tests. The published
   * key set of each accepted issuer is fetched from `/.well-known/jwks.json`
   * and wins when it is available.
   */
  jwks?: JwksKey[]
  /** Static per-issuer keys, keyed by `iss`. */
  issuerJwks?: Record<string, JwksKey[]>
  /** A shared key-set source (one cache for several verifiers). */
  keys?: KeySetSource
  /** Replay store; a seen receipt is `receipt_replayed`. */
  replay?: Store
  /** What the receipt must be bound to (action, scope, value, currency, context). */
  bind?: ReceiptBinding
  /** When false, a call without a receipt yields `{ ok: "no_receipt" }` instead of `auth_missing`. */
  required?: boolean
  /** Override the default `params._meta.oap_receipt` extractor. */
  extractor?: McpReceiptExtractor
  /** Clock skew in seconds (default 30). */
  skewSeconds?: number
  /** Fetch override for the key-set source; `null` never fetches (static keys only). */
  fetch?: typeof fetch | null
}

const DEFAULT_EXTRACTOR: McpReceiptExtractor = (req) => {
  const meta = req.params?._meta
  if (!meta || typeof meta !== "object") return null
  const r = (meta as Record<string, unknown>).oap_receipt
  return typeof r === "string" ? r : null
}

/**
 * Factory that returns an async verifier for the counterparty role, for
 * runtimes without either official SDK:
 *
 *     const verify = mcpAuthorize({ acceptedIssuers, ownIdentifier })
 *     const outcome = await verify(req)
 *     if (outcome.ok === true) … outcome.context.claims …
 */
export function mcpAuthorize(opts: McpAuthorizeOptions): (req: McpRequest) => Promise<McpAuthorizeOutcome> {
  if (!opts.acceptedIssuers || opts.acceptedIssuers.length === 0) {
    throw new Error("mcpAuthorize: acceptedIssuers must be non-empty")
  }
  if (!opts.ownIdentifier) {
    throw new Error("mcpAuthorize: ownIdentifier is required")
  }

  const required = opts.required !== false
  const extract = opts.extractor ?? DEFAULT_EXTRACTOR
  const keys =
    opts.keys ??
    new KeySetSource({ issuers: opts.acceptedIssuers, jwks: opts.jwks, issuerJwks: opts.issuerJwks, fetch: opts.fetch })

  return async function verifyRequest(req: McpRequest): Promise<McpAuthorizeOutcome> {
    const receipt = extract(req)
    if (!receipt) {
      return required ? { ok: false, reason_code: "auth_missing" } : { ok: "no_receipt" }
    }
    const outcome = await verifyReceipt(receipt, {
      audience: opts.ownIdentifier,
      acceptedIssuers: opts.acceptedIssuers,
      keys,
      replay: opts.replay,
      bind: opts.bind,
      skewSeconds: opts.skewSeconds,
    })
    if (outcome.ok === true) return { ok: true, context: { claims: outcome.claims, receipt } }
    if (outcome.ok === false) return { ok: false, reason_code: outcome.reasonCode }
    return { ok: "no_receipt" }
  }
}

/**
 * Throwing variant: returns the context, `null` in soft mode when no receipt
 * was carried, and throws an `OapError` carrying the reason code otherwise.
 */
export async function assertReceipt(req: McpRequest, opts: McpAuthorizeOptions): Promise<McpAuthorizeContext | null> {
  const verify = mcpAuthorize(opts)
  const outcome = await verify(req)
  if (outcome.ok === true) return outcome.context
  if (outcome.ok === "no_receipt") return null
  throw new OapError({
    reason_code: outcome.reason_code,
    message: `Receipt rejected: ${outcome.reason_code}`,
  })
}
