import { peekReceipt, verifyReceiptOffline, type JwksKey, type OapReasonCode, type ReceiptClaims } from "@overturo/sdk"
import { contextHash } from "./canonical.js"
import { KeySetSource } from "./keys.js"
import type { VerifyOutcome } from "./outcomes.js"
import { claimReceipt, replayTtlSeconds, type Store } from "./stores.js"

/** What the receipt must be bound to before the counterparty honours it. */
export interface ReceiptBinding {
  action?: string
  scope?: string
  value?: string
  currency?: string
  /** The context the server expects; its canonical hash must equal the receipt's `context_hash`. */
  context?: Record<string, unknown>
}

export interface VerifyReceiptOptions {
  /** Must equal the receipt's `aud`: the server's own identifier. */
  audience: string
  acceptedIssuers: string[]
  /** Published-key source; built from the static sets when omitted. */
  keys?: KeySetSource
  /** Static keys (shared) — a fallback, or the only source when nothing is fetched. */
  jwks?: JwksKey[]
  /** Static per-issuer keys. */
  issuerJwks?: Record<string, JwksKey[]>
  /** Replay store; a seen `jti` is `receipt_replayed`. Replay is not checked without one. */
  replay?: Store
  bind?: ReceiptBinding
  skewSeconds?: number
  /** Clock override for tests. */
  at?: Date
  /** Fetch override, used when `keys` is built here; `null` never fetches. */
  fetch?: typeof fetch | null
}

/**
 * Counterparty-role verification: the offline checks, then the binding, then
 * replay. Never throws on a receipt-shape failure — it answers an outcome
 * with a reason code.
 */
export async function verifyReceipt(receipt: string, opts: VerifyReceiptOptions): Promise<VerifyOutcome> {
  const peeked = peekReceipt(receipt)
  if (!peeked) return { ok: false, reasonCode: "malformed" }
  const iss = typeof peeked.claims?.iss === "string" ? peeked.claims.iss : ""
  const kid = typeof peeked.header?.kid === "string" ? peeked.header.kid : ""
  // Issuers are compared without a trailing slash, as the key source names them.
  const acceptedIssuers = opts.acceptedIssuers.map(normalizeIssuer)
  const accepted = acceptedIssuers.includes(normalizeIssuer(iss))

  const keys =
    opts.keys ??
    new KeySetSource({ issuers: acceptedIssuers, jwks: opts.jwks, issuerJwks: opts.issuerJwks, fetch: opts.fetch })

  let keySet = accepted ? await keys.keysFor(iss) : keys.staticFor(iss)
  if (kid && accepted && !keySet.some((k) => k.kid === kid)) {
    keySet = await keys.refresh(iss)
  }

  const result = await verifyReceiptOffline(receipt, {
    audience: opts.audience,
    acceptedIssuers,
    jwks: keySet,
    skewSeconds: opts.skewSeconds,
    at: opts.at,
  })
  if (!result.valid || !result.claims) return { ok: false, reasonCode: result.reason_code ?? "auth_invalid" }
  const claims = result.claims
  // A receipt is single-use by its `jti`; one without a usable `jti` is not a
  // receipt this verifier can hold to that (every later one would read as a replay).
  if (typeof claims.jti !== "string" || claims.jti.length === 0) return { ok: false, reasonCode: "malformed" }

  const mismatch = bindingMismatch(claims, opts.bind)
  if (mismatch) return { ok: false, reasonCode: mismatch }

  if (opts.replay) {
    const nowSeconds = Math.floor((opts.at ?? new Date()).getTime() / 1000)
    const ttl = replayTtlSeconds(claims.exp, opts.skewSeconds ?? 30, nowSeconds)
    const fresh = await claimReceipt(opts.replay, claims.jti, ttl)
    if (!fresh) return { ok: false, reasonCode: "receipt_replayed" }
  }

  return { ok: true, claims, receipt }
}

function normalizeIssuer(iss: string): string {
  return iss.replace(/\/+$/, "")
}

export function bindingMismatch(claims: ReceiptClaims, bind: ReceiptBinding | undefined): OapReasonCode | null {
  if (!bind) return null
  if (bind.action !== undefined && claims.action !== bind.action) return "action_mismatch"
  if (bind.scope !== undefined && claims.scope !== bind.scope) return "scope_mismatch"
  if (bind.value !== undefined && !sameAmount(claims.value, bind.value)) return "value_mismatch"
  if (bind.currency !== undefined && String(claims.currency ?? "").toUpperCase() !== bind.currency.toUpperCase()) return "currency_mismatch"
  if (bind.context !== undefined && claims.context_hash !== contextHash(bind.context)) return "context_mismatch"
  return null
}

/**
 * The receipt carries the value as the agent sent it; the counterparty binds
 * the value as its own arguments spell it. Two spellings of one decimal
 * amount ("10", "10.0", "010.00") are the same value; anything that is not a
 * plain decimal must match byte for byte.
 */
export function sameAmount(claimed: unknown, bound: string): boolean {
  if (typeof claimed !== "string") return false
  if (claimed === bound) return true
  const a = normalizeDecimal(claimed)
  const b = normalizeDecimal(bound)
  return a !== null && a === b
}

function normalizeDecimal(text: string): string | null {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text.trim())
  if (!match) return null
  const integer = match[2].replace(/^0+(?=\d)/, "")
  const fraction = (match[3] ?? "").replace(/0+$/, "")
  const zero = integer === "0" && fraction === ""
  const sign = match[1] === "-" && !zero ? "-" : ""
  return `${sign}${integer}${fraction ? `.${fraction}` : ""}`
}

export interface ConsumeReceiptOptions {
  /** The issuer to consume at (the receipt's `iss`); must be one the server accepts. */
  issuer: string
  acceptedIssuers: string[]
  /** Counterparty token for the issuer's online verification. */
  counterpartyToken: string
  /** Set by the author once the action was honoured. */
  actionCompleted: boolean
  fetch?: typeof fetch
}

/**
 * Online consumption — a separate, explicit call the adapter never makes on
 * the author's behalf. Returns the issuer's answer as given.
 */
export async function consumeReceiptOnline(receipt: string, opts: ConsumeReceiptOptions): Promise<unknown> {
  const issuer = opts.issuer.replace(/\/+$/, "")
  if (!opts.acceptedIssuers.map((i) => i.replace(/\/+$/, "")).includes(issuer)) {
    throw new Error("consumeReceiptOnline: issuer is not accepted")
  }
  const fetchFn = opts.fetch ?? globalThis.fetch
  const res = await fetchFn(`${issuer}/.well-known/overturo-verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${opts.counterpartyToken}`,
    },
    body: JSON.stringify({ receipt, action_completed: opts.actionCompleted }),
  })
  const text = await res.text()
  let body: unknown = undefined
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  if (!res.ok) throw new Error(`consumeReceiptOnline: HTTP ${res.status}`)
  return body
}
