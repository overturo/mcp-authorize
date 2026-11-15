/**
 * The pluggable store behind resumption (open decisions) and replay (seen
 * receipts). Five operations; a multi-process server plugs a shared backend
 * and both uses ride it.
 */
export interface Store {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
  /** Atomic transition: write `value` only when the current value equals `expected` (`undefined` = absent). */
  compareAndSet(key: string, expected: string | undefined, value: string, ttlSeconds: number): Promise<boolean>
  delete(key: string): Promise<void>
  /** Optional: drop expired entries. The memory store sweeps on a timer. */
  sweep?(): Promise<void>
}

interface MemoryEntry {
  value: string
  expiresAt: number
}

export interface MemoryStoreOptions {
  /** Sweep interval in seconds (default 60; `0` disables the timer). */
  sweepIntervalSeconds?: number
  /** Clock override for tests (milliseconds). */
  now?: () => number
}

/** In-memory default: expiry on read plus a periodic sweep on an unref'd timer. */
export class MemoryStore implements Store {
  private readonly entries = new Map<string, MemoryEntry>()
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(opts: MemoryStoreOptions = {}) {
    this.now = opts.now ?? Date.now
    const interval = opts.sweepIntervalSeconds ?? 60
    if (interval > 0) {
      this.timer = setInterval(() => void this.sweep(), interval * 1000)
      this.timer.unref?.()
    }
  }

  async get(key: string): Promise<string | undefined> {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 })
  }

  // No await between the read and the write: the whole transition is one
  // turn of the event loop, so concurrent callers cannot all see the same
  // "expected" and all succeed (the single-use guarantees rest on this).
  async compareAndSet(key: string, expected: string | undefined, value: string, ttlSeconds: number): Promise<boolean> {
    const entry = this.entries.get(key)
    const live = entry !== undefined && entry.expiresAt > this.now()
    if (entry && !live) this.entries.delete(key)
    const current = live ? entry.value : undefined
    if (current !== expected) return false
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 })
    return true
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key)
  }

  async sweep(): Promise<void> {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key)
    }
  }

  /** Number of live entries (diagnostics). */
  get size(): number {
    return this.entries.size
  }

  /** Stops the sweep timer. */
  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}

// ── resumption entries ────────────────────────────────────────────────────

export type ResumptionState = "pending" | "resumed" | "refused" | "expired"

export interface ResumptionEntry {
  decision_id: string
  decision_url: string
  wait_url: string
  /** ISO 8601; the decision's expiry. */
  expires_at: string
  record_id: string
  state: ResumptionState
}

/** Grace after the decision's expiry during which a retry still finds the entry. */
export const RESUMPTION_GRACE_SECONDS = 60

export function resumptionKey(tool: string, digest: string): string {
  return `resume:${tool}:${digest}`
}

/** Reads an entry; an expired one (decision expiry plus grace) is removed and reported absent. */
export async function readResumption(
  store: Store,
  key: string,
  now: () => number = Date.now
): Promise<ResumptionEntry | undefined> {
  const raw = await store.get(key)
  if (!raw) return undefined
  let entry: ResumptionEntry
  try {
    entry = JSON.parse(raw) as ResumptionEntry
  } catch {
    await store.delete(key)
    return undefined
  }
  const expiresAt = Date.parse(entry.expires_at)
  if (!Number.isFinite(expiresAt) || expiresAt + RESUMPTION_GRACE_SECONDS * 1000 <= now()) {
    await store.delete(key)
    return undefined
  }
  return entry
}

export function resumptionTtlSeconds(expiresAt: Date, now: () => number = Date.now): number {
  return Math.max(1, Math.ceil((expiresAt.getTime() - now()) / 1000) + RESUMPTION_GRACE_SECONDS)
}

export async function writeResumption(
  store: Store,
  key: string,
  entry: ResumptionEntry,
  now: () => number = Date.now
): Promise<void> {
  await store.set(key, JSON.stringify(entry), resumptionTtlSeconds(new Date(entry.expires_at), now))
}

/** Writes an entry only when none is there. `false` when one already was. */
export async function writeResumptionIfAbsent(
  store: Store,
  key: string,
  entry: ResumptionEntry,
  now: () => number = Date.now
): Promise<boolean> {
  return store.compareAndSet(key, undefined, JSON.stringify(entry), resumptionTtlSeconds(new Date(entry.expires_at), now))
}

/**
 * Single use: the one caller whose transition from `pending` to `resumed`
 * lands runs the handler; everyone else sees the entry already moved.
 */
export async function claimResumption(
  store: Store,
  key: string,
  entry: ResumptionEntry,
  now: () => number = Date.now
): Promise<boolean> {
  const resumed: ResumptionEntry = { ...entry, state: "resumed" }
  return store.compareAndSet(
    key,
    JSON.stringify(entry),
    JSON.stringify(resumed),
    resumptionTtlSeconds(new Date(entry.expires_at), now)
  )
}

// ── replay entries ────────────────────────────────────────────────────────

export const REPLAY_MIN_TTL_SECONDS = 300

export function replayKey(jti: string): string {
  return `jti:${jti}`
}

/** Replay TTL: at least five minutes, and at least until the receipt's `exp` plus skew. */
export function replayTtlSeconds(exp: number, skewSeconds: number, nowSeconds: number): number {
  return Math.max(REPLAY_MIN_TTL_SECONDS, exp + skewSeconds - nowSeconds)
}

/** Records a receipt as seen. `false` when it was already seen. */
export async function claimReceipt(store: Store, jti: string, ttlSeconds: number): Promise<boolean> {
  return store.compareAndSet(replayKey(jti), undefined, "1", ttlSeconds)
}
