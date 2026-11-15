import { describe, expect, it } from "vitest"
import {
  claimReceipt,
  claimResumption,
  MemoryStore,
  readResumption,
  replayKey,
  replayTtlSeconds,
  resumptionKey,
  resumptionTtlSeconds,
  writeResumption,
  writeResumptionIfAbsent,
  type ResumptionEntry,
} from "../../src/core/stores.js"

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

const entry = (expiresAt: Date, state: ResumptionEntry["state"] = "pending"): ResumptionEntry => ({
  decision_id: "esc_us_1",
  decision_url: "https://overturo.com/decisions/tok",
  wait_url: "https://overturo.com/api/v1/grants/g/escalations/esc_us_1/wait",
  expires_at: expiresAt.toISOString(),
  record_id: "rec_1",
  state,
})

describe("MemoryStore", () => {
  it("sets, gets, deletes and expires on read", async () => {
    const c = clock()
    const store = new MemoryStore({ now: c.now, sweepIntervalSeconds: 0 })
    await store.set("k", "v", 10)
    expect(await store.get("k")).toBe("v")
    c.advance(10_001)
    expect(await store.get("k")).toBeUndefined()
    await store.set("k", "v", 10)
    await store.delete("k")
    expect(await store.get("k")).toBeUndefined()
    store.close()
  })

  it("compareAndSet is one turn: concurrent claims of one receipt or one resumption yield exactly one winner", async () => {
    const store = new MemoryStore({ sweepIntervalSeconds: 0 })
    const receipts = await Promise.all([claimReceipt(store, "jti_race", 300), claimReceipt(store, "jti_race", 300), claimReceipt(store, "jti_race", 300)])
    expect(receipts.filter(Boolean)).toHaveLength(1)
    const entry: ResumptionEntry = { decision_id: "d", decision_url: "u", wait_url: "w", expires_at: new Date(Date.now() + 60_000).toISOString(), record_id: "r", state: "pending" }
    await writeResumption(store, "resume:t:x", entry)
    const claims = await Promise.all([claimResumption(store, "resume:t:x", entry), claimResumption(store, "resume:t:x", entry)])
    expect(claims.filter(Boolean)).toHaveLength(1)
    const writes = await Promise.all([writeResumptionIfAbsent(store, "resume:t:y", entry), writeResumptionIfAbsent(store, "resume:t:y", entry)])
    expect(writes.filter(Boolean)).toHaveLength(1)
  })

  it("compareAndSet is single use", async () => {
    const store = new MemoryStore({ sweepIntervalSeconds: 0 })
    expect(await store.compareAndSet("k", undefined, "1", 10)).toBe(true)
    expect(await store.compareAndSet("k", undefined, "1", 10)).toBe(false)
    expect(await store.compareAndSet("k", "1", "2", 10)).toBe(true)
    expect(await store.compareAndSet("k", "1", "3", 10)).toBe(false)
    expect(await store.get("k")).toBe("2")
  })

  it("sweeps expired entries on the timer", async () => {
    const c = clock()
    const store = new MemoryStore({ now: c.now, sweepIntervalSeconds: 1 })
    await store.set("a", "1", 1)
    await store.set("b", "1", 100)
    c.advance(2_000)
    await store.sweep()
    expect(store.size).toBe(1)
    store.close()
    store.close()
  })
})

describe("resumption entries", () => {
  it("round-trips, keyed by tool and digest", async () => {
    const c = clock()
    const store = new MemoryStore({ now: c.now, sweepIntervalSeconds: 0 })
    const key = resumptionKey("transfer", "abc")
    expect(key).toBe("resume:transfer:abc")
    const e = entry(new Date(c.now() + 60_000))
    await writeResumption(store, key, e, c.now)
    expect(await readResumption(store, key, c.now)).toEqual(e)
  })

  it("expires on read after the decision's expiry plus grace", async () => {
    const c = clock()
    const store = new MemoryStore({ now: c.now, sweepIntervalSeconds: 0 })
    const key = resumptionKey("transfer", "abc")
    await writeResumption(store, key, entry(new Date(c.now() + 1_000)), c.now)
    c.advance(1_000 + 60_000 + 1)
    expect(await readResumption(store, key, c.now)).toBeUndefined()
  })

  it("drops an unreadable entry", async () => {
    const store = new MemoryStore({ sweepIntervalSeconds: 0 })
    await store.set("resume:x:y", "{not json", 60)
    expect(await readResumption(store, "resume:x:y")).toBeUndefined()
    expect(await store.get("resume:x:y")).toBeUndefined()
    await store.set("resume:x:z", JSON.stringify({ expires_at: "never" }), 60)
    expect(await readResumption(store, "resume:x:z")).toBeUndefined()
  })

  it("claims a pending entry exactly once", async () => {
    const c = clock()
    const store = new MemoryStore({ now: c.now, sweepIntervalSeconds: 0 })
    const key = resumptionKey("transfer", "abc")
    const e = entry(new Date(c.now() + 60_000))
    await writeResumption(store, key, e, c.now)
    expect(await claimResumption(store, key, e, c.now)).toBe(true)
    expect(await claimResumption(store, key, e, c.now)).toBe(false)
    expect((await readResumption(store, key, c.now))?.state).toBe("resumed")
  })

  it("ttl covers the decision's life plus grace", () => {
    const c = clock()
    expect(resumptionTtlSeconds(new Date(c.now() + 30_000), c.now)).toBe(90)
    expect(resumptionTtlSeconds(new Date(c.now() - 30_000), c.now)).toBe(30)
  })
})

describe("replay entries", () => {
  it("holds a jti at least five minutes and until exp plus skew", () => {
    expect(replayTtlSeconds(1_000, 30, 900)).toBe(300)
    expect(replayTtlSeconds(2_000, 30, 900)).toBe(1_130)
    expect(replayKey("abc")).toBe("jti:abc")
  })

  it("claims a receipt once", async () => {
    const store = new MemoryStore({ sweepIntervalSeconds: 0 })
    expect(await claimReceipt(store, "j1", 300)).toBe(true)
    expect(await claimReceipt(store, "j1", 300)).toBe(false)
    expect(await claimReceipt(store, "j2", 300)).toBe(true)
  })
})
