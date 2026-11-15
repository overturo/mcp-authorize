import type { JwksKey } from "@overturo/sdk"

export const MAX_KEY_CACHE_SECONDS = 86_400
export const DEFAULT_KEY_CACHE_SECONDS = 300
/**
 * The least time between two refreshes of one issuer's set on an unknown key,
 * and the back-off after a failed fetch: a flood of receipts carrying unknown
 * keys, or an issuer that is down, cannot turn the verifier into a fetch loop.
 * The one refresh a rotation needs is never refused — only the ones after it.
 */
export const MIN_FETCH_INTERVAL_SECONDS = 30

export interface KeySetSourceOptions {
  /** The issuers whose published key sets may be fetched. Nothing else is ever fetched. */
  issuers: string[]
  /** Fetch override (tests, proxies); `null` never fetches (air-gapped: static keys only). */
  fetch?: typeof fetch | null
  /** Static fallback for air-gapped servers and tests. */
  jwks?: JwksKey[]
  /** Static per-issuer fallback, keyed by `iss`. */
  issuerJwks?: Record<string, JwksKey[]>
  /** Clock override for tests (milliseconds). */
  now?: () => number
}

interface CachedSet {
  keys: JwksKey[]
  expiresAt: number
}

/**
 * Each accepted issuer's published key set, fetched from
 * `<iss>/.well-known/jwks.json`, cached per `Cache-Control` (capped at a day)
 * and re-fetched once when a key is unknown. A fetched set wins; the static
 * sets are the fallback, and a static key the fetched set does not list is
 * still served (an author's pinned key is a trust anchor, not a cache). A
 * fetch failure never fails a verification the cached or static keys can
 * answer: the last set fetched is kept past its lifetime and served until a
 * fetch succeeds again. An unknown key refreshes one issuer at most once
 * every `MIN_FETCH_INTERVAL_SECONDS`, and a failed fetch is not retried
 * before then, so unknown keys on the wire cannot drive a fetch per receipt.
 * Only issuers in `issuers` are fetched — never a URL found in a receipt.
 */
export class KeySetSource {
  private readonly issuers: Set<string>
  private readonly fetchFn: typeof fetch | undefined
  private readonly staticJwks: JwksKey[]
  private readonly staticIssuerJwks: Record<string, JwksKey[]>
  private readonly now: () => number
  private readonly cache = new Map<string, CachedSet>()
  private readonly inflight = new Map<string, Promise<JwksKey[] | undefined>>()
  private readonly nextRefreshAt = new Map<string, number>()
  private readonly retryAt = new Map<string, number>()

  constructor(opts: KeySetSourceOptions) {
    for (const issuer of opts.issuers) assertFetchableIssuer(issuer)
    this.issuers = new Set(opts.issuers.map(normalize))
    this.fetchFn = opts.fetch === null ? undefined : (opts.fetch ?? globalThis.fetch)
    this.staticJwks = opts.jwks ?? []
    this.staticIssuerJwks = opts.issuerJwks ?? {}
    this.now = opts.now ?? Date.now
  }

  /** The keys to verify a receipt from `iss` with: cached, else fetched, else static. */
  async keysFor(iss: string): Promise<JwksKey[]> {
    const issuer = normalize(iss)
    const fresh = this.cached(issuer, { stale: false })
    if (fresh) return this.merged(fresh, issuer)
    const fetched = await this.fetchOnce(issuer, { refresh: false })
    return this.merged(fetched ?? this.cached(issuer, { stale: true }), issuer)
  }

  /** Re-fetches once (an unknown key may be a fresh rotation); throttled after that one, and the last set stands in when the fetch is refused or fails. */
  async refresh(iss: string): Promise<JwksKey[]> {
    const issuer = normalize(iss)
    const fetched = await this.fetchOnce(issuer, { refresh: true })
    return this.merged(fetched ?? this.cached(issuer, { stale: true }), issuer)
  }

  /** Fetched keys plus the pinned ones; on one `kid` in both, the pinned key wins — it is the author's trust anchor, never overridden by what an endpoint serves. */
  private merged(fetched: JwksKey[] | undefined, issuer: string): JwksKey[] {
    const statics = this.staticFor(issuer)
    if (!fetched) return statics
    const pinned = new Set(statics.map((k) => k.kid))
    return [...fetched.filter((k) => !pinned.has(k.kid)), ...statics]
  }

  /** Static keys for an issuer: its own entry, else the shared set. */
  staticFor(iss: string): JwksKey[] {
    return this.staticIssuerJwks[normalize(iss)] ?? this.staticIssuerJwks[iss] ?? this.staticJwks
  }

  /** The cached set: a live one, or — with `stale` — the last one fetched, whatever its age. */
  private cached(issuer: string, opts: { stale: boolean }): JwksKey[] | undefined {
    const entry = this.cache.get(issuer)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now() && !opts.stale) return undefined
    return entry.keys
  }

  private fetchOnce(issuer: string, opts: { refresh: boolean }): Promise<JwksKey[] | undefined> {
    if (!this.issuers.has(issuer) || !this.fetchFn) return Promise.resolve(undefined)
    const running = this.inflight.get(issuer)
    if (running) return running
    const now = this.now()
    if (opts.refresh && (this.nextRefreshAt.get(issuer) ?? 0) > now) return Promise.resolve(undefined)
    if ((this.retryAt.get(issuer) ?? 0) > now) return Promise.resolve(undefined)
    const p = this.doFetch(issuer)
      .then((keys) => {
        if (keys === undefined) this.retryAt.set(issuer, this.now() + MIN_FETCH_INTERVAL_SECONDS * 1000)
        return keys
      })
      .finally(() => {
        this.inflight.delete(issuer)
        if (opts.refresh) this.nextRefreshAt.set(issuer, this.now() + MIN_FETCH_INTERVAL_SECONDS * 1000)
      })
    this.inflight.set(issuer, p)
    return p
  }

  private async doFetch(issuer: string): Promise<JwksKey[] | undefined> {
    try {
      const res = await this.fetchFn!(`${issuer}/.well-known/jwks.json`, { headers: { Accept: "application/json" } })
      if (!res.ok) return undefined
      const body = (await res.json()) as { keys?: unknown }
      if (!body || !Array.isArray(body.keys)) return undefined
      const keys = body.keys.filter(isJwksKey)
      // A set with no usable key is an outage, not a rotation: keep the last set.
      if (keys.length === 0) return undefined
      const ttl = cacheSeconds(res.headers.get("cache-control"))
      this.cache.set(issuer, { keys, expiresAt: this.now() + ttl * 1000 })
      return keys
    } catch {
      return undefined
    }
  }
}

function isJwksKey(k: unknown): k is JwksKey {
  if (!k || typeof k !== "object") return false
  const key = k as Record<string, unknown>
  return typeof key.kid === "string" && key.kty === "OKP" && typeof key.crv === "string" && typeof key.x === "string"
}

/** `Cache-Control: max-age` honoured up to a day; a missing or unparseable header caches briefly. */
export function cacheSeconds(header: string | null): number {
  if (!header) return DEFAULT_KEY_CACHE_SECONDS
  if (/no-store|no-cache/i.test(header)) return 1
  const match = /max-age=(\d+)/i.exec(header)
  if (!match) return DEFAULT_KEY_CACHE_SECONDS
  return Math.max(1, Math.min(MAX_KEY_CACHE_SECONDS, Number(match[1])))
}

function normalize(iss: string): string {
  return iss.replace(/\/+$/, "")
}

/** Keys are fetched over TLS only; a loopback issuer is allowed for tests and local walks. */
function assertFetchableIssuer(issuer: string): void {
  let url: URL
  try {
    url = new URL(issuer)
  } catch {
    throw new Error(`KeySetSource: issuer is not a URL: ${issuer}`)
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname.endsWith(".localhost")
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`KeySetSource: issuer must be https (or http on loopback): ${issuer}`)
  }
}
