// A scripted Overturo: a `fetch` that answers the authorize, token, settlement
// and key-set endpoints from the recorded corpus, with queues the test fills
// per scenario. Every request is recorded so a test can assert "sent once".
import { generateKeyPairSync, webcrypto } from "node:crypto"
import { OverturoAuthorize, type DpopKeyPair, type JwksKey } from "@overturo/sdk"
import { corpusBody } from "./corpus.js"
import type { Minter } from "./receipts.js"

export const GRANT_ID = "ath_us_grant01"
export const DECISION_ID = "esc_us_decision01"
export const DECISION_URL = "https://overturo.com/decisions/tok_fixture"

export type AuthorizeScript =
  | { kind: "allow"; receipt?: string; jti?: string }
  | { kind: "escalate"; decisionId?: string; ttl?: string }
  | { kind: "error"; status: number; reason_code: string; denial_category?: string; failed_bound?: string; detail?: unknown; negotiate_url?: string; request_id?: string }
  | { kind: "transport" }
  | { kind: "garbage" }

export type WaitScript =
  | { kind: "pending"; retry_after?: number }
  | { kind: "approved"; receipt?: string; jti?: string; decidedBy?: string }
  | { kind: "receipt_expired" }
  | { kind: "denied" | "expired" | "cancelled"; decidedBy?: string }
  | { kind: "countered"; negotiationId?: string }
  | { kind: "error"; status: number; reason_code: string }
  | { kind: "transport" }
  | { kind: "garbage" }

export interface RecordedCall {
  method: string
  path: string
  headers: Record<string, string>
  body?: unknown
}

export interface OverturoStub {
  fetch: typeof fetch
  authorize: AuthorizeScript[]
  wait: WaitScript[]
  calls: RecordedCall[]
  jwks: JwksKey[]
  jwksCacheControl: string | null
  jwksStatus: number
  tokenRefreshes: number
  /** A receipt minted for the next allow/approved answer when the script does not carry one. */
  receiptFor(jti: string, overrides?: Record<string, unknown>): Promise<string>
  authorizeCalls(): RecordedCall[]
  waitCalls(): RecordedCall[]
  jwksCalls(): RecordedCall[]
}

export function createOverturoStub(minter: Minter): OverturoStub {
  const stub: OverturoStub = {
    authorize: [],
    wait: [],
    calls: [],
    jwks: minter.jwks,
    jwksCacheControl: "max-age=600",
    jwksStatus: 200,
    tokenRefreshes: 0,
    fetch: undefined as unknown as typeof fetch,
    receiptFor: (jti, overrides = {}) => minter.sign(minter.claims({ jti, ...overrides })),
    authorizeCalls: () => stub.calls.filter((c) => c.path.endsWith("/authorize")),
    waitCalls: () => stub.calls.filter((c) => c.path.endsWith("/wait")),
    jwksCalls: () => stub.calls.filter((c) => c.path.endsWith("/jwks.json")),
  }

  stub.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? "GET").toUpperCase()
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    stub.calls.push({ method, path: url.pathname, headers, body })

    if (url.pathname === "/.well-known/jwks.json") {
      if (stub.jwksStatus !== 200) return new Response("nope", { status: stub.jwksStatus })
      const h: Record<string, string> = { "Content-Type": "application/json" }
      if (stub.jwksCacheControl) h["Cache-Control"] = stub.jwksCacheControl
      return new Response(JSON.stringify({ keys: stub.jwks }), { status: 200, headers: h })
    }
    if (url.pathname.endsWith("/token") && method === "POST") {
      stub.tokenRefreshes++
      return json(200, { agent_token: `ovt_rotated_${stub.tokenRefreshes}`, agent_token_expires_at: "2030-01-01T00:00:00Z", iss: "https://overturo.com", oap_ver: "1.0" })
    }
    if (url.pathname.endsWith("/authorize") && method === "POST") {
      const script = stub.authorize.shift()
      if (!script) throw new Error("overturo stub: no authorize answer scripted")
      return authorizeResponse(stub, script)
    }
    if (url.pathname.endsWith("/wait") && method === "GET") {
      const script = stub.wait.shift()
      if (!script) throw new Error("overturo stub: no settlement answer scripted")
      return waitResponse(stub, script)
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  return stub
}

async function authorizeResponse(stub: OverturoStub, script: AuthorizeScript): Promise<Response> {
  switch (script.kind) {
    case "allow": {
      const body: Record<string, unknown> = { ...corpusBody("Oap_Authorize_create") }
      const jti = script.jti ?? `jti_${stub.calls.length}`
      body.receipt = script.receipt ?? (await stub.receiptFor(jti))
      body.receipt_jti = jti
      body.record_id = "rec_us_allow01"
      const now = Math.floor(Date.now() / 1000)
      body.iat = now
      body.exp = now + 60
      return json(201, body)
    }
    case "escalate": {
      const body: Record<string, unknown> = { ...corpusBody("Oap_Authorize_create", "escalate") }
      body.escalation_id = script.decisionId ?? DECISION_ID
      body.decision_url = DECISION_URL
      body.wait_url = `https://overturo.com/api/v1/grants/${GRANT_ID}/escalations/${body.escalation_id}/wait`
      body.approval_ttl_at = script.ttl ?? new Date(Date.now() + 10 * 60 * 1000).toISOString()
      body.record_id = "rec_us_held01"
      return json(202, body)
    }
    case "error":
      return json(script.status, {
        error: {
          reason_code: script.reason_code,
          message: `refused: ${script.reason_code}`,
          denial_category: script.denial_category,
          failed_bound: script.failed_bound,
          detail: script.detail,
          negotiate_url: script.negotiate_url,
          request_id: script.request_id,
          oap_ver: "1.0",
        },
      })
    case "transport":
      throw new TypeError("fetch failed")
    case "garbage":
      return json(200, { hello: "world" })
  }
}

async function waitResponse(stub: OverturoStub, script: WaitScript): Promise<Response> {
  const base = { escalation_id: DECISION_ID, oap_ver: "1.0", decision_record_id: "rec_us_decision01" }
  switch (script.kind) {
    case "pending": {
      const body: Record<string, unknown> = { ...corpusBody("Oap_EscalationSettlements_show"), escalation_id: DECISION_ID }
      if (script.retry_after !== undefined) body.retry_after = script.retry_after
      return json(200, body)
    }
    case "approved": {
      const body: Record<string, unknown> = { ...corpusBody("Oap_EscalationSettlements_show", "approved"), ...base }
      const jti = script.jti ?? `jti_approved_${stub.calls.length}`
      body.receipt = script.receipt ?? (await stub.receiptFor(jti))
      body.receipt_jti = jti
      body.record_id = "rec_us_allow02"
      body.decided_by = script.decidedBy ?? "principal"
      const now = Math.floor(Date.now() / 1000)
      body.iat = now
      body.exp = now + 60
      return json(200, body)
    }
    case "receipt_expired":
      return json(200, { ...base, status: "approved", wait_again: false, decided_by: "principal", reason_code: "receipt_expired" })
    case "denied":
    case "expired":
    case "cancelled":
      return json(200, { ...base, status: script.kind, wait_again: false, decided_by: script.decidedBy ?? null, reason_code: `escalation_${script.kind}` })
    case "countered":
      return json(200, { ...base, status: "countered", wait_again: false, decided_by: "principal", reason_code: "escalation_countered", negotiation_id: script.negotiationId })
    case "error":
      return json(script.status, { error: { reason_code: script.reason_code, message: `refused: ${script.reason_code}`, oap_ver: "1.0" } })
    case "transport":
      throw new TypeError("fetch failed")
    case "garbage":
      return json(200, { status: "weird" })
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

/** An agent credential bound to the stub. */
export async function createAgentClient(stub: OverturoStub, opts: { timeoutMs?: number } = {}): Promise<OverturoAuthorize> {
  const { privateKey } = generateKeyPairSync("ed25519")
  const jwk = privateKey.export({ format: "jwk" }) as JsonWebKey
  const cryptoKey = await webcrypto.subtle.importKey("jwk", jwk, { name: String(jwk.crv) }, false, ["sign"])
  const dpopKey: DpopKeyPair = { privateKey: cryptoKey, publicJwk: { kty: "OKP", crv: jwk.crv as never, x: jwk.x as string } }
  return new OverturoAuthorize({
    grantId: GRANT_ID,
    agentToken: "ovt_test_token",
    dpopKey,
    iss: "https://overturo.com",
    fetch: stub.fetch,
    timeoutMs: opts.timeoutMs,
  })
}
