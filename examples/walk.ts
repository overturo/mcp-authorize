/**
 * The live-leg driver. Two subcommands:
 *
 *   walk.ts keygen --out <file>
 *     Generates the DPoP key pair (EdDSA), writes
 *     {"dpop": {"privateJwk": {...}, "publicJwk": {...}}} to <file> (0600) and
 *     prints the RFC 7638 thumbprint (jkt) as the last stdout line. The runner
 *     then adds grant_id, agent_token and iss to the same file.
 *
 *   walk.ts run --apex <url> --credential <file>
 *     Boots the example server in-process against the apex with that credential
 *     and drives it with the official v2 client in both eras. One JSON object per
 *     stdout line:
 *       {"leg": "<name>", "ok": true|false, ...}      per assertion
 *       {"leg": "<name>", "skipped": "<why>"}          a leg it cannot run
 *       {"await": "<decision id>", "decision_url": "...", "outcome": "approve"|"deny"}
 *                                                      right before a settlement wait
 *       {"error": "..."}                               on an exception
 *     Exit status is non-zero when any leg failed. The agent token is never logged.
 */
import { generateKeyPairSync, webcrypto } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { Client, StreamableHTTPClientTransport, InMemoryTransport } from "@modelcontextprotocol/client"
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server"
import { OverturoAuthorize, jwkThumbprint, type DpopKeyPair } from "@overturo/sdk"
import { MemoryStore, type Store } from "@overturo/mcp-authorize"
import { buildServer, DEFAULT_ACTION, DEFAULT_SCOPE } from "./server.js"

type Json = Record<string, unknown>

function emit(line: Json): void {
  process.stdout.write(`${JSON.stringify(line)}\n`)
}

// ── keygen ────────────────────────────────────────────────────────────────

async function keygen(out: string | undefined): Promise<void> {
  if (!out) throw new Error("keygen: --out <file> is required")
  const { privateKey } = generateKeyPairSync("ed25519")
  const privateJwk = privateKey.export({ format: "jwk" }) as JsonWebKey
  const publicJwk = { kty: "OKP" as const, crv: privateJwk.crv as DpopCurve, x: privateJwk.x as string }
  writeFileSync(out, JSON.stringify({ dpop: { privateJwk, publicJwk } }, null, 2), { mode: 0o600 })
  const jkt = await jwkThumbprint(publicJwk)
  process.stdout.write(`${jkt}\n`)
}

// ── run ───────────────────────────────────────────────────────────────────

type DpopCurve = Extract<DpopKeyPair["publicJwk"], { kty: "OKP" }>["crv"]

interface Credential {
  grant_id: string
  agent_token: string
  iss: string
  action?: string
  scope?: string
  dpop: { privateJwk: JsonWebKey; publicJwk: { kty: "OKP"; crv: DpopCurve; x: string } }
}

async function loadCredential(file: string): Promise<{ client: OverturoAuthorize; action: string; scope: string; iss: string }> {
  const cred = JSON.parse(readFileSync(file, "utf8")) as Credential
  for (const k of ["grant_id", "agent_token", "iss", "dpop"] as const) {
    if (!cred[k]) throw new Error(`credential file: ${k} is missing`)
  }
  // The WebCrypto algorithm is the key's own curve (an OKP JWK names it in `crv`).
  const privateKey = await webcrypto.subtle.importKey("jwk", cred.dpop.privateJwk, { name: String(cred.dpop.privateJwk.crv) }, false, ["sign"])
  const dpopKey: DpopKeyPair = { privateKey, publicJwk: cred.dpop.publicJwk }
  const client = new OverturoAuthorize({ grantId: cred.grant_id, agentToken: cred.agent_token, dpopKey, iss: cred.iss })
  return { client, action: cred.action ?? DEFAULT_ACTION, scope: cred.scope ?? DEFAULT_SCOPE, iss: cred.iss }
}

interface Harness {
  modernUrl: (opts?: { elicitation?: boolean }) => Promise<Client>
  legacy: (opts: { elicitation: boolean }) => Promise<Client>
  awaited: Map<string, string>
  close: () => Promise<void>
}

async function harness(client: OverturoAuthorize, apex: string, action: string, scope: string): Promise<Harness> {
  const store: Store = new MemoryStore()
  const requestStateKey = webcrypto.getRandomValues(new Uint8Array(32))
  const awaited = new Map<string, string>()
  const build = (pendingVariant: boolean): McpServer =>
    buildServer({
      client,
      store,
      requestStateKey,
      action,
      scope,
      pendingVariant,
      verifier: { acceptedIssuers: [apex] },
      onDecision: (e) => {
        if (e.outcome === "held" && e.decisionId && !awaited.has(e.decisionId)) awaited.set(e.decisionId, "")
      },
    })
  const handler = createMcpHandler(() => build(true))
  const legacyServers: McpServer[] = []
  const clients: Client[] = []

  const elicitationHandler = (c: Client) =>
    c.setRequestHandler("elicitation/create", async (req) => {
      const params = req.params as { url?: string }
      if (params.url) noteDecisionUrl(awaited, params.url)
      return { action: "accept" as const }
    })

  return {
    awaited,
    async modernUrl(opts = {}) {
      const elicitation = opts.elicitation !== false
      const c = new Client(
        { name: "walk-modern", version: "2.0.0" },
        {
          capabilities: elicitation ? { elicitation: { url: {} } } : {},
          versionNegotiation: { mode: { pin: "2026-07-28" } },
          inputRequired: { autoFulfill: true, maxRounds: 10_000 },
        }
      )
      if (elicitation) elicitationHandler(c)
      const transport = new StreamableHTTPClientTransport(new URL("http://walk.local/mcp"), {
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      })
      await c.connect(transport)
      clients.push(c)
      return c
    },
    async legacy({ elicitation }) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      const server = build(true)
      await server.connect(serverTransport)
      legacyServers.push(server)
      const c = new Client(
        { name: "walk-legacy", version: "2.0.0" },
        { capabilities: elicitation ? { elicitation: { url: {} } } : {}, versionNegotiation: { mode: "legacy" } }
      )
      await c.connect(clientTransport)
      clients.push(c)
      return c
    },
    async close() {
      for (const c of clients) await c.close().catch(() => undefined)
      for (const s of legacyServers) await s.close().catch(() => undefined)
      await handler.close().catch(() => undefined)
    },
  }
}

function noteDecisionUrl(awaited: Map<string, string>, url: string): void {
  for (const [id, known] of awaited) if (!known) awaited.set(id, url)
}

interface Leg {
  name: string
  ok: boolean
  [k: string]: unknown
}

class Walk {
  failed = 0
  constructor(
    private readonly h: Harness,
    private readonly currency: string
  ) {}

  leg(name: string, ok: boolean, detail: Json = {}): void {
    if (!ok) this.failed++
    emit({ leg: name, ok, ...detail })
  }

  skipped(name: string, why: string): void {
    emit({ leg: name, skipped: why })
  }

  args(amount: string, memo?: string) {
    return { amount, currency: this.currency, payee: "acct_walk_payee", ...(memo ? { memo } : {}) }
  }

  /** Announces a held decision once, naming the outcome the runner should produce. */
  announce(outcome: "approve" | "deny"): void {
    for (const [id, url] of this.h.awaited) {
      if (this.announced.has(id)) continue
      this.announced.add(id)
      emit({ await: id, decision_url: url, outcome })
    }
  }
  private announced = new Set<string>()

  structured(result: unknown): Json {
    return ((result as { structuredContent?: Json }).structuredContent ?? {}) as Json
  }
}

async function run(apex: string | undefined, credential: string | undefined): Promise<number> {
  if (!apex) throw new Error("run: --apex <url> is required")
  if (!credential) throw new Error("run: --credential <file> is required")
  const { client, action, scope } = await loadCredential(credential)
  const apexUrl = apex.replace(/\/+$/, "")
  const h = await harness(client, apexUrl, action, scope)
  const w = new Walk(h, "USD")
  const modern = await h.modernUrl()

  try {
    // 1. Under the bound: allowed, and the downstream verifier accepts the receipt.
    const allow = await modern.callTool({ name: "transfer", arguments: w.args("10.00", "walk allow") })
    const allowed = w.structured(allow)
    w.leg("allow_modern", allowed.authorized === true && typeof allowed.receipt === "string", {
      receipt_id: allowed.receipt_id,
      record_id: allowed.record_id,
    })
    if (typeof allowed.receipt === "string") {
      const posted = await modern.callTool({
        name: "ledger_post",
        arguments: { amount: "10.00", currency: "USD", payee: "acct_walk_payee" },
        _meta: { oap_receipt: allowed.receipt },
      })
      const p = w.structured(posted)
      w.leg("ledger_post_verifies", p.posted === true, { reason_code: p.reason_code })
      const replay = await modern.callTool({
        name: "ledger_post",
        arguments: { amount: "10.00", currency: "USD", payee: "acct_walk_payee" },
        _meta: { oap_receipt: allowed.receipt },
      })
      w.leg("ledger_post_refuses_replay", w.structured(replay).reason_code === "receipt_replayed")
    } else {
      w.skipped("ledger_post_verifies", "no receipt from the allow leg")
    }

    // 2. Over the bound: denied as an error result in the public vocabulary.
    const deny = await modern.callTool({ name: "transfer", arguments: w.args("500.00", "walk deny") })
    const denied = w.structured(deny)
    w.leg("deny_value_exceeds_tx_max", (deny as { isError?: boolean }).isError === true && denied.reason_code === "value_exceeds_tx_max", {
      reason_code: denied.reason_code,
      failed_bound: denied.failed_bound,
    })

    // 3. Held on the modern era with URL mode: input_required → the person approves → the retry runs once.
    const heldArgs = w.args("75.00", "walk approve")
    const approvePromise = modern.callTool({ name: "transfer", arguments: heldArgs })
    await waitForAnnouncement(w, "approve")
    const resumed = await approvePromise
    const r = w.structured(resumed)
    const meta = ((resumed as { _meta?: Json })._meta ?? {}) as Json
    w.leg("held_modern_input_required_resumes_once", r.authorized === true && typeof meta.decision === "object", {
      decision: meta.decision,
    })

    // 4. A second identical call is a new authorization → held again → the person denies → refused result.
    const againPromise = modern.callTool({ name: "transfer", arguments: heldArgs })
    await waitForAnnouncement(w, "deny")
    const again = await againPromise
    const a = w.structured(again)
    w.leg("second_retry_is_new_authorization_denied", (again as { isError?: boolean }).isError === true && a.outcome === "denied", {
      outcome: a.outcome,
      decision_id: a.decision_id,
    })

    // 5. Legacy era, URL mode declared: the -32042 error.
    const legacyUrl = await h.legacy({ elicitation: true })
    try {
      await legacyUrl.callTool({ name: "transfer", arguments: w.args("75.00", "walk legacy url") })
      w.leg("legacy_url_mode_minus_32042", false, { detail: "no error was raised" })
    } catch (error) {
      const e = error as { code?: number; elicitations?: Array<{ elicitationId?: string; url?: string }> }
      w.leg("legacy_url_mode_minus_32042", e.code === -32042 && Array.isArray(e.elicitations), { code: e.code })
      const first = e.elicitations?.[0]
      if (first?.elicitationId && first.url) h.awaited.set(first.elicitationId, first.url)
    }
    w.announce("deny")

    // 6. Legacy era, no URL mode: the pending result.
    const legacyPlain = await h.legacy({ elicitation: false })
    const pending = await legacyPlain.callTool({ name: "transfer", arguments: w.args("75.00", "walk legacy pending") })
    const pd = w.structured(pending)
    w.leg("legacy_without_url_mode_pending", pd.held === true && typeof pd.decision_url === "string", { decision_id: pd.decision_id })
    if (typeof pd.decision_id === "string" && typeof pd.decision_url === "string") h.awaited.set(pd.decision_id, pd.decision_url)
    w.announce("deny")

    // 7. delivery: "pending" on the modern client with URL mode: pending regardless.
    const forced = await modern.callTool({ name: "transfer_pending", arguments: w.args("75.00", "walk forced pending") })
    const fd = w.structured(forced)
    w.leg("delivery_pending_on_modern", fd.held === true && typeof fd.decision_url === "string", { decision_id: fd.decision_id })
    if (typeof fd.decision_id === "string" && typeof fd.decision_url === "string") h.awaited.set(fd.decision_id, fd.decision_url)
    w.announce("deny")
  } finally {
    await h.close()
  }
  return w.failed === 0 ? 0 : 1
}

/** Waits until the adapter reports a held decision for the in-flight call, then announces it. */
async function waitForAnnouncement(w: Walk, outcome: "approve" | "deny"): Promise<void> {
  const h = (w as unknown as { h: Harness }).h
  const before = new Set(h.awaited.keys())
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 100))
    const fresh = [...h.awaited.entries()].filter(([id, url]) => !before.has(id) && url)
    if (fresh.length > 0) {
      w.announce(outcome)
      return
    }
  }
  w.leg(`await_${outcome}`, false, { detail: "no held decision was reported within 60 s" })
}

// ── CLI ───────────────────────────────────────────────────────────────────

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  if (cmd === "keygen") return keygen(flag("out"))
  if (cmd === "run") {
    const status = await run(flag("apex"), flag("credential"))
    process.exitCode = status
    return
  }
  throw new Error("usage: walk.ts keygen --out <file> | walk.ts run --apex <url> --credential <file>")
}

main().catch((error: unknown) => {
  emit({ error: error instanceof Error ? error.message : String(error) })
  process.exitCode = 2
})
