> **Release mirror.** This repository is a read-only snapshot of
> `@overturo/mcp-authorize` 2.0.1, published from Overturo's main
> development repository. Issues and pull requests are welcome here; accepted
> changes are ported upstream and appear in the next release snapshot.
> Security reports: see [SECURITY.md](./SECURITY.md).

# @overturo/mcp-authorize

**Documentation:** <https://overturo.com/developers/agent-authorization> · **API reference:** <https://overturo.com/developers/openapi>

Authorization for MCP (Model Context Protocol) servers, in two roles:

- **Agent role — `gateTool`.** Your server holds a grant's agent credential and asks Overturo before a wrapped tool runs. Allowed actions run with a receipt; refused actions answer a result the model can relay; an action a person must approve is held, and the client is pointed at the decision page in whichever way it declared it can take one.
- **Counterparty role — `verifyReceipt`.** Your server is handed a receipt by a caller and verifies it (signature, issuer, audience, binding, replay) before honouring the action.

One server may play both: it gates its own sensitive tool, and the downstream service it calls verifies the receipt that authorization produced. The example server does exactly that.

## Where the credential comes from

The agent credential is an **authorization grant's**: a principal creates a grant for "this server's agent" on the Delegate surface or through the grants API, you generate the DPoP key pair, and the grant creation returns the agent token. That is the same triple (`grantId`, `agentToken`, `dpopKey`) that [`@overturo/sdk`](https://github.com/overturo/sdk)'s `OverturoAuthorize` takes.

The agent tokens a launchpad issues to connect a model to Overturo's own MCP gateway are **not** this credential; they belong to the gateway, not to your server.

## Install

```sh
npm install @overturo/mcp-authorize @overturo/sdk
```

`@overturo/sdk` is the one runtime dependency and the only thing that speaks to Overturo. Install the MCP SDK line you use; both are optional peer dependencies:

| Entry point | For | Held decisions delivered as |
|---|---|---|
| `@overturo/mcp-authorize/server` | `@modelcontextprotocol/server` (v2, ^2.4.0) — **recommended** | input-required result (2026-07-28, URL mode declared) · `-32042` error (legacy era, URL mode declared) · pending result |
| `@overturo/mcp-authorize/legacy` | `@modelcontextprotocol/sdk` (v1, ^1.32.0) — compatibility | `-32042` error (URL mode declared) · pending result |
| `@overturo/mcp-authorize` | any runtime — the framework-free core and the counterparty verifier | — |

Node 20 or later.

## Agent role with `@modelcontextprotocol/server`

```ts
import { McpServer } from "@modelcontextprotocol/server"
import { OverturoAuthorize } from "@overturo/sdk"
import { gateTool, requestStateVerifier, type GateOptions } from "@overturo/mcp-authorize/server"
import { z } from "zod"

// 1. The grant's agent credential.
const client = new OverturoAuthorize({ grantId, agentToken, dpopKey, iss: "https://overturo.com" })

// 2. One options object per server instance. The request-state key signs the state the
//    client echoes between rounds on the 2026-07-28 revision; use the same key on every process.
const gate = {
  client,
  requestStateKey: process.env.REQUEST_STATE_KEY!,
  // the 2026-07-28 request state resumes only for the principal that minted it — read it from your own authentication
  requestStateBind: (ctx) => ctx.http?.authInfo?.clientId ?? "",
} as GateOptions
const server = new McpServer({ name: "ledger", version: "1.0.0" }, { requestState: { verify: requestStateVerifier(gate) } })
gate.server = server

// 3. Register the tool as you do today; pass the handler through gateTool with its declaration.
server.registerTool(
  "transfer",
  { inputSchema: z.object({ amount: z.string(), currency: z.string(), payee: z.string() }) },
  gateTool(
    "transfer",
    {
      action: "<action token the grant allows>",   // e.g. "write"
      scope: "<scope token the grant covers>",     // e.g. "payments:transfer"
      value: (a) => a.amount,                      // both or neither
      currency: (a) => a.currency,
      counterparty: () => "did:web:ledger.example.com",
      context: (a) => ({ payee: a.payee }),        // hashed into the receipt, never stored
    },
    async (args, ctx, decision) => {
      // Runs only when the action is authorized. `decision` carries the receipt, its id and
      // expiry, and the record pointer; hand the receipt downstream if a counterparty verifies it.
      await ledger.post({ ...args, receipt: decision.receipt })
      return { content: [{ type: "text", text: "Posted." }] }
    },
    gate
  )
)
```

Nothing about registration, schemas or transport changes. `gateTools({ name: { decl, handler }, … }, gate)` wraps several at once; a tool without a declaration is returned untouched and never gated.

### What a call does

On every call to a gated tool, before the handler, the adapter sends **one** authorize request under the grant — a fresh nonce, the declared action and scope, and the value, currency, counterparty and context derived from the arguments. The context is canonicalised the way the platform canonicalises it, so the receipt's `context_hash` is reproducible by you and by any downstream counterparty you hand the context to.

| Overturo says | The tool answers |
|---|---|
| **Allow** | The handler runs with the decision; the result's `_meta.decision` carries the record and receipt pointers. |
| **Deny** | An error result (`isError`): one sentence with the reason code, the failed bound and the record pointer, and the same fields in `structuredContent`. No argument value appears in the text. |
| **Approval needed** | A held decision — see the three deliveries below. |
| **Unreachable, credential refused, answer unreadable** | An error result saying authorization is unavailable and to try again. The adapter **fails closed**; there is no fail-open option. |

The request is sent exactly once: a failed request is `unavailable`, and the next tool call is a new nonce. When the platform says the agent token expired, the adapter rotates it through `@overturo/sdk` once, then surfaces the refusal.

### The three deliveries

A held decision is delivered the way the client declared it can take one — by what it declared on the revision in use, never by who it is:

1. **2026-07-28, URL-mode elicitation declared** → the input-required result with one URL elicitation under the key `decision` and a signed request state bound to the decision, the tool and the arguments' canonical digest. The client's own driver opens the page and retries with the state.
2. **Legacy era (2025-11-25), URL-mode elicitation declared** → the `-32042` URL-elicitation-required error with one URL-mode elicitation.
3. **Otherwise** → the pending result: a successful tool result the model can relay, with the decision link in one sentence (`structuredContent.held`, `decision_id`, `decision_url`, `expires_at`, `next`).

The URL is the decision page; it carries a session token only. Who may decide is the page's business: a signer signs in and decides, anyone else is refused. The adapter therefore elicits whenever the client declared it can; a tool whose caller is never a signer sets `delivery: "pending"` in its declaration and is always delivered as (3).

### Resumption

The adapter keeps open decisions in a store keyed by the tool name and the canonical digest of the arguments. When the same call comes back:

- **still pending** → it waits on the decision for a bounded hold (`holdSeconds`, 20 s by default) and, if nothing settles, answers the same delivery again;
- **approved** → the handler runs once, now, with the receipt the approval produced; `_meta.decision` names the decision, the record and the receipt. A second identical call afterwards — with or without the request state echoed again — is a **new authorization**, not a replay: the resumption is claimed once in the store, and a request state that reaches a process whose store never saw the hold is materialised there before the wait, so it too runs at most once per store;
- **approved but the receipt lapsed**, **denied**, **expired**, **cancelled**, **countered** → an error result naming the outcome; the next identical call starts afresh;
- **different arguments** → a different call; the open decision is left alone.

On 2026-07-28 the request state the client echoes is the primary pointer and the store is the fallback; a tampered or expired state is refused by the server before any handler runs (the protocol's invalid-params error), and a valid state echoed for another tool, other arguments or another decision resumes nothing. On the legacy era and on v1 the store is the only pointer.

### Stores and multi-process servers

The default store is in memory (expiry on read plus a periodic sweep). A server that runs on several processes plugs a shared one — the interface is five operations:

```ts
interface Store {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
  compareAndSet(key: string, expected: string | undefined, value: string, ttlSeconds: number): Promise<boolean>
  delete(key: string): Promise<void>
  sweep?(): Promise<void>
}
```

Resumption and the counterparty verifier's replay check share this interface, so one backend serves both. `examples/file-store.ts` is a file-backed store for several processes on one host; a fleet wants a real shared backend. The request-state key must also be the same on every process.

### Hooks

`onDecision` fires once per outcome with `{ tool, outcome, delivery?, decisionId? }` — `allow`, `deny`, `held`, `unavailable`, `pending`, `approved`, `receipt_expired`, `denied`, `expired`, `cancelled`, `countered` — for your own metrics. The package emits no telemetry of its own.

## Agent role with `@modelcontextprotocol/sdk` (v1)

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { gateTool } from "@overturo/mcp-authorize/legacy"

const server = new McpServer({ name: "ledger", version: "1.0.0" })
const gate = { server, client }
server.registerTool("transfer", { inputSchema }, gateTool("transfer", declaration, handler, gate))
```

Same declaration, same handler shape (`(args, extra, decision)`), same store. The adapter reads the capabilities the client declared on `initialize`: URL mode declared → the `-32042` error; otherwise, or when the server cannot expose them → the pending result. The input-required result does not exist on this line, and there is no request state.

## Counterparty role

```ts
import { verifyReceipt, KeySetSource, MemoryStore } from "@overturo/mcp-authorize"

const keys = new KeySetSource({ issuers: ["https://overturo.com", "https://overturo.eu"] })
const replay = new MemoryStore()

const outcome = await verifyReceipt(receipt, {
  audience: "did:web:ledger.example.com",            // must equal the receipt's aud
  acceptedIssuers: ["https://overturo.com", "https://overturo.eu"],
  keys,
  replay,
  bind: { action: "write", scope: "payments:transfer", value: amount, currency },
})
if (outcome.ok !== true) refuse(outcome)             // { ok: false, reasonCode }
honour(outcome.claims)
```

In order, after the signature: **binding** — the receipt's `action` and `scope` must equal the tool's declared ones, `value` (compared as a decimal amount: `10`, `10.0` and `10.00` are one value; anything that is not a plain decimal must match exactly) and `currency` when the declaration derives them, and a `context` you supply is recomputed into `context_hash` (`action_mismatch`, `scope_mismatch`, `value_mismatch`, `currency_mismatch`, `context_mismatch`); **replay** — a seen receipt is `receipt_replayed`, held for at least five minutes and until the receipt's expiry plus skew. The verifier never throws on a receipt-shape failure; it answers an outcome with a reason code.

**Keys.** `KeySetSource` fetches each accepted issuer's published key set from `/.well-known/jwks.json` — over `https` only (plain `http` on loopback, for tests) — honours `Cache-Control` up to a day, serves from cache, and re-fetches once on an unknown key before answering `unknown_kid`. It never fetches a URL found in a receipt and only fetches issuers you accept. `jwks` / `issuerJwks` are a static source for air-gapped servers and tests (`fetch: null` never fetches); fetched keys and pinned keys are both served, and on one `kid` in both the pinned key wins (it is your trust anchor, never overridden by what an endpoint serves). A set with no usable key is an outage, not a rotation. A fetch failure never fails a verification the cached or static keys can answer: the last set fetched is kept past its lifetime and served until a fetch succeeds again. One issuer is refreshed on an unknown key at most once every thirty seconds after the refresh a rotation needs, and a failed fetch is not retried before then — receipts carrying unknown keys cannot drive a fetch per receipt.

**Online consumption** is a separate, explicit call (`consumeReceiptOnline`) with your counterparty token and `actionCompleted` set by you; the adapter never makes it on your behalf.

### The framework-agnostic verifier

For a runtime without either SDK, `mcpAuthorize` and `assertReceipt` verify the receipt a request carries in `params._meta.oap_receipt` (or wherever your `extractor` says):

```ts
const verify = mcpAuthorize({ acceptedIssuers, ownIdentifier: "did:web:ledger.example.com", bind, replay })
const outcome = await verify(req)
if (outcome.ok === true) … outcome.context.claims …
```

### Soft mode

With `required: false`, a call that carries no receipt yields `{ ok: "no_receipt" }` — a third variant beside `ok: true` and the failure, with no claim object at all. A handler that serves unauthenticated callers branches on the variant; `assertReceipt` returns `null` for it.

## The example server

The examples need the dev dependencies (`zod` and an official MCP SDK) beside the package; they are reference code, not part of the library. `examples/server.ts` hands the receipt back to the caller in `structuredContent` so the walk can carry it to `ledger_post` — a receipt is a sixty-second bearer credential, so a real server passes it downstream itself rather than returning it to the model. `examples/server.ts` is one process in both roles: `transfer` is gated in the agent role and hands the receipt back; `ledger_post` verifies the receipt a caller carries in `_meta.oap_receipt` and posts the entry; `transfer_pending` (opt-in) is the same declaration with `delivery: "pending"`. The integration tests drive it with the official clients in both eras, and `examples/walk.ts` drives it against a live Overturo host: `keygen --out <file>` writes a DPoP key pair and prints its thumbprint, `run --apex <url> --credential <file>` walks allow, deny, every delivery, resumption and counterparty verification, printing one JSON line per leg. The agent token is never logged.

## Testing

`npm test` runs the core suite (decision handling, builder parity against the shared conformance fixtures, context-hash parity, delivery selection, request-state binding, stores, settlement outcomes, the verifier) and the integration suites against `@modelcontextprotocol/server` 2.4.0 and `@modelcontextprotocol/sdk` 1.32.2 with a scripted Overturo; no server is needed.

## License

Apache-2.0
