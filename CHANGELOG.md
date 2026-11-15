# Changelog

## [2.0.0] - 2026-10-26

### Added — the agent role

- **`@overturo/mcp-authorize/server`** — the adapter for `@modelcontextprotocol/server` (v2): `gateTool`, `gateTools`, `requestStateVerifier`. Wrap a tool's handler with its authorization declaration (action, scope, how to derive value, currency, counterparty and context from the arguments); registration, schemas and transport are unchanged. On every call the adapter sends one authorize request under the grant's agent credential (`OverturoAuthorize` from `@overturo/sdk`) and runs the handler only on allow.
- **`@overturo/mcp-authorize/legacy`** — the compatibility adapter for `@modelcontextprotocol/sdk` (v1), same declaration and handler shape.
- **Three deliveries for a held decision**, mirrored from the platform's builder and pinned by the shared conformance fixtures: the input-required result with a signed request state (2026-07-28, URL mode declared), the `-32042` URL-elicitation-required error (legacy era, URL mode declared), the pending result (everything else, and every tool with `delivery: "pending"`).
- **Resumption** through a pluggable store keyed by tool and canonical argument digest: a pending decision is waited on for a bounded hold (`holdSeconds`, 20 s default, `retry_after` honoured); approval runs the handler once with the receipt and `_meta.decision` (the claim is single-use per store, also for a request state that arrives where the store never saw the hold); a lapsed receipt, a denial, expiry, cancellation or a counter-proposal answer an error result and the next call authorizes anew. `MemoryStore` is the default; a `Store` is five operations.
- **`onDecision`** hook with the tool, the outcome, the delivery and the decision reference.
- **`requestStateBind`** on `GateOptions`: the 2026-07-28 request state is bound to the principal of the call that minted it (the SDK codec's `bind`); the state carries the decision page and expiry, so a process whose store never saw the hold still delivers and bounds it. Two identical first calls in flight at once share one hold. The in-memory store's `compareAndSet` is one turn of the event loop, so its single-use guarantees hold under concurrency.
- A refused grant (missing, expired, revoked, scope or action not covered) is a **deny** with its reason; only credential and transport refusals are "unavailable".
- **Online consumption** as an explicit call (`consumeReceiptOnline`); never performed by the adapter.
- `examples/`: the two-role example server, the live-walk driver, a file-backed store.

### Changed — the counterparty role, tightened

- `verifyReceipt` adds **binding** after the signature (`action_mismatch`, `scope_mismatch`, `value_mismatch`, `currency_mismatch`, `context_mismatch` — the context hash is recomputed over the canonical form) and **replay** through the shared store (`receipt_replayed`; entries held at least five minutes and until expiry plus skew).
- **`KeySetSource`** fetches each accepted issuer's published key set, honours `Cache-Control` up to a day, re-fetches once on an unknown key (then at most once every thirty seconds, and a failed fetch is not retried before then), keeps the last set fetched past its lifetime until a fetch succeeds again, and falls back to the static `jwks` / `issuerJwks`; it never fetches a URL found in a receipt. `jwks` is no longer required on `mcpAuthorize`.
- The value binding compares decimal amounts, not spellings (`10` and `10.00` are one value); the currency is derived and bound upper case, as the platform records it. A receipt without a usable `jti` is `malformed`. Accepted issuers may be written with a trailing slash. Issuers are fetched over `https` only (loopback excepted); a pinned key wins over a published key with the same `kid`; a published set with no usable key counts as an outage.
- **Soft mode says what it saw.** With `required: false`, a call without a receipt yields `{ ok: "no_receipt" }` — no claim object. The 1.1.0 `ok: true` with empty-string claims is removed. `assertReceipt` returns `null` for it.
- The receipt claims type names the audit-record pointer `record_id`.
- The package ships three entry points (`.`, `./server`, `./legacy`), ESM and CommonJS, with `@modelcontextprotocol/server` and `@modelcontextprotocol/sdk` as optional peer dependencies.

### Breaking

- Soft mode's outcome variant (above). Handlers that checked `context.receipt === ""` branch on `outcome.ok === "no_receipt"` instead.
- Every tool-result and option name uses the public vocabulary; the audit-record pointer claim is `record_id`.

## [1.1.0] - 2026-06-26

### Added — multi-issuer handling

- **`issuerJwks`** — an optional `mcpAuthorize` option mapping each issuer
  (`iss`) to its own published keys. Lets the middleware accept receipts from
  several issuers, each verified against that issuer's own published key with no
  callback. Passed through to `@overturo/sdk`'s offline verifier; falls back to
  `jwks` when the issuer isn't in the map.

### Compatibility

- Additive, no break. Servers with a single issuer can ignore `issuerJwks`.
  First changelog. Minor bump (1.0.0 → 1.1.0).
