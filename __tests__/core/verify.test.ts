import { beforeAll, describe, expect, it } from "vitest"
import { KeySetSource, MIN_FETCH_INTERVAL_SECONDS } from "../../src/core/keys.js"
import { MemoryStore } from "../../src/core/stores.js"
import { bindingMismatch, sameAmount, consumeReceiptOnline, verifyReceipt } from "../../src/core/verify.js"
import { createOverturoStub } from "../support/overturo_stub.js"
import { AUDIENCE, createMinter, ISSUER, type Minter } from "../support/receipts.js"

let minter: Minter

beforeAll(async () => {
  minter = await createMinter()
})

const base = () => ({ audience: AUDIENCE, acceptedIssuers: [ISSUER], jwks: minter.jwks, fetch: null })

describe("verifyReceipt", () => {
  it("accepts a valid receipt against static keys", async () => {
    const receipt = await minter.sign(minter.claims())
    const outcome = await verifyReceipt(receipt, base())
    expect(outcome.ok).toBe(true)
    if (outcome.ok !== true) return
    expect(outcome.claims.action).toBe("write")
    expect(outcome.receipt).toBe(receipt)
  })

  it("answers malformed, never throws", async () => {
    expect(await verifyReceipt("nope", base())).toEqual({ ok: false, reasonCode: "malformed" })
    expect(await verifyReceipt("a.b.c", base())).toEqual({ ok: false, reasonCode: "malformed" })
  })

  it("propagates the offline failure codes", async () => {
    const wrongAud = await minter.sign(minter.claims({ aud: "did:web:other" }))
    expect(await verifyReceipt(wrongAud, base())).toEqual({ ok: false, reasonCode: "invalid_aud" })
    const foreign = await minter.sign(minter.claims({ iss: "https://overturo.eu" }))
    expect(await verifyReceipt(foreign, base())).toEqual({ ok: false, reasonCode: "invalid_iss" })
    const expired = await minter.sign(minter.claims({ exp: Math.floor(Date.now() / 1000) - 120 }))
    expect(await verifyReceipt(expired, base())).toEqual({ ok: false, reasonCode: "expired" })
  })

  it("binds action, scope, value, currency and context, each with its own code", async () => {
    const receipt = await minter.sign(minter.claims({ context_hash: "3e32320a3bbfa89cc4d6aa54f373278e9aa32362056de65ef0da0d571d23e5c0" }))
    const bind = { action: "write", scope: "payments:transfer", value: "10.00", currency: "USD", context: { invoice_id: "inv_123", memo: "May 2026 hosting" } }
    expect((await verifyReceipt(receipt, { ...base(), bind })).ok).toBe(true)
    expect(await verifyReceipt(receipt, { ...base(), bind: { ...bind, action: "delete" } })).toEqual({ ok: false, reasonCode: "action_mismatch" })
    expect(await verifyReceipt(receipt, { ...base(), bind: { ...bind, scope: "x" } })).toEqual({ ok: false, reasonCode: "scope_mismatch" })
    expect(await verifyReceipt(receipt, { ...base(), bind: { ...bind, value: "11.00" } })).toEqual({ ok: false, reasonCode: "value_mismatch" })
    expect(await verifyReceipt(receipt, { ...base(), bind: { ...bind, currency: "EUR" } })).toEqual({ ok: false, reasonCode: "currency_mismatch" })
    expect(await verifyReceipt(receipt, { ...base(), bind: { ...bind, context: { invoice_id: "other" } } })).toEqual({ ok: false, reasonCode: "context_mismatch" })
    expect(bindingMismatch(minter.claims() as never, undefined)).toBeNull()
  })

  it("binds the currency without regard to case, as the platform records it upper case", async () => {
    const receipt = await minter.sign(minter.claims())
    expect((await verifyReceipt(receipt, { ...base(), bind: { currency: "usd" } })).ok).toBe(true)
    expect(await verifyReceipt(receipt, { ...base(), bind: { currency: "eur" } })).toEqual({ ok: false, reasonCode: "currency_mismatch" })
  })

  it("answers malformed for a receipt without a usable jti (it could never be single-use)", async () => {
    const receipt = await minter.sign(minter.claims({ jti: undefined as unknown as string }))
    const replay = new MemoryStore({ sweepIntervalSeconds: 0 })
    expect(await verifyReceipt(receipt, { ...base(), replay })).toEqual({ ok: false, reasonCode: "malformed" })
    expect(replay.size).toBe(0)
  })

  it("accepts an issuer written with a trailing slash", async () => {
    const receipt = await minter.sign(minter.claims())
    expect((await verifyReceipt(receipt, { ...base(), acceptedIssuers: [`${ISSUER}/`] })).ok).toBe(true)
  })

  it("binds the value as a decimal amount, not a spelling", async () => {
    const receipt = await minter.sign(minter.claims())
    for (const value of ["10", "10.0", "010.00", " 10.00 "]) {
      expect((await verifyReceipt(receipt, { ...base(), bind: { value } })).ok).toBe(true)
    }
    for (const value of ["10.01", "1e1", "10,00", "-10.00", ""]) {
      expect(await verifyReceipt(receipt, { ...base(), bind: { value } })).toEqual({ ok: false, reasonCode: "value_mismatch" })
    }
    expect(sameAmount("-0.00", "0")).toBe(true)
    expect(sameAmount("-1", "1")).toBe(false)
    expect(sameAmount(undefined, "1")).toBe(false)
    expect(sameAmount("abc", "abc")).toBe(true)
  })

  it("refuses a replayed receipt within the hold and accepts it only once", async () => {
    const replay = new MemoryStore({ sweepIntervalSeconds: 0 })
    const receipt = await minter.sign(minter.claims({ jti: "jti_once" }))
    expect((await verifyReceipt(receipt, { ...base(), replay })).ok).toBe(true)
    expect(await verifyReceipt(receipt, { ...base(), replay })).toEqual({ ok: false, reasonCode: "receipt_replayed" })
    expect(await replay.get("jti:jti_once")).toBe("1")
  })

  it("holds the replay entry at least five minutes, and until exp plus skew beyond that", async () => {
    let t = Date.now()
    const replay = new MemoryStore({ sweepIntervalSeconds: 0, now: () => t })
    const short = await minter.sign(minter.claims({ jti: "jti_short", exp: Math.floor(t / 1000) + 10 }))
    await verifyReceipt(short, { ...base(), replay, at: new Date(t) })
    t += 299_000
    expect(await replay.get("jti:jti_short")).toBe("1")
    t += 2_000
    expect(await replay.get("jti:jti_short")).toBeUndefined()
  })

  it("fetches the issuer's published keys, caches them, and re-fetches once on an unknown key", async () => {
    const stub = createOverturoStub(minter)
    let t = Date.now()
    const keys = new KeySetSource({ issuers: [ISSUER], fetch: stub.fetch, now: () => t })
    const receipt = await minter.sign(minter.claims())
    expect((await verifyReceipt(receipt, { audience: AUDIENCE, acceptedIssuers: [ISSUER], keys })).ok).toBe(true)
    expect((await verifyReceipt(await minter.sign(minter.claims()), { audience: AUDIENCE, acceptedIssuers: [ISSUER], keys })).ok).toBe(true)
    expect(stub.jwksCalls()).toHaveLength(1)

    const rotated = await createMinter("oap-rotated-v2")
    const fresh = await rotated.sign(rotated.claims())
    // first attempt: unknown kid → one refetch (still the old set) → unknown_kid
    expect(await verifyReceipt(fresh, { audience: AUDIENCE, acceptedIssuers: [ISSUER], keys })).toEqual({ ok: false, reasonCode: "unknown_kid" })
    expect(stub.jwksCalls()).toHaveLength(2)
    // the issuer publishes the new key: within the refresh interval nothing is fetched again …
    stub.jwks = [...minter.jwks, ...rotated.jwks]
    expect(await verifyReceipt(fresh, { audience: AUDIENCE, acceptedIssuers: [ISSUER], keys })).toEqual({ ok: false, reasonCode: "unknown_kid" })
    expect(stub.jwksCalls()).toHaveLength(2)
    // … and the next unknown-kid refetch after it finds the key
    t += MIN_FETCH_INTERVAL_SECONDS * 1000 + 1
    expect((await verifyReceipt(fresh, { audience: AUDIENCE, acceptedIssuers: [ISSUER], keys })).ok).toBe(true)
    expect(stub.jwksCalls()).toHaveLength(3)
  })

  it("verifies with the cached set when the refetch fails, and with the static set when nothing was fetched", async () => {
    const stub = createOverturoStub(minter)
    const keys = new KeySetSource({ issuers: [ISSUER], fetch: stub.fetch })
    await keys.keysFor(ISSUER)
    stub.jwksStatus = 500
    expect((await verifyReceipt(await minter.sign(minter.claims()), { audience: AUDIENCE, acceptedIssuers: [ISSUER], keys })).ok).toBe(true)

    const offline = createOverturoStub(minter)
    offline.jwksStatus = 500
    expect((await verifyReceipt(await minter.sign(minter.claims()), { ...base(), fetch: offline.fetch })).ok).toBe(true)
    expect(offline.jwksCalls().length).toBeGreaterThanOrEqual(1)
  })

  it("uses only static keys for an issuer it does not accept (and then refuses the issuer)", async () => {
    const stub = createOverturoStub(minter)
    const receipt = await minter.sign(minter.claims({ iss: "https://overturo.eu" }))
    expect(await verifyReceipt(receipt, { ...base(), fetch: stub.fetch })).toEqual({ ok: false, reasonCode: "invalid_iss" })
    expect(stub.jwksCalls()).toHaveLength(0)
  })

  it("answers unknown_kid after one refetch when nobody has the key", async () => {
    const stub = createOverturoStub(minter)
    const unknown = await (await createMinter("oap-unknown")).sign(minter.claims())
    expect(await verifyReceipt(unknown, { ...base(), fetch: stub.fetch })).toEqual({ ok: false, reasonCode: "unknown_kid" })
    expect(stub.jwksCalls()).toHaveLength(2)
  })
})

describe("consumeReceiptOnline", () => {
  it("posts the receipt with the counterparty token to the issuer's verify endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ valid: true, consumed: true }), { status: 200 })
    }) as typeof fetch
    const answer = await consumeReceiptOnline("r.e.c", { issuer: `${ISSUER}/`, acceptedIssuers: [ISSUER], counterpartyToken: "cpt", actionCompleted: true, fetch: fetchFn })
    expect(answer).toEqual({ valid: true, consumed: true })
    expect(calls[0].url).toBe(`${ISSUER}/.well-known/overturo-verify`)
    expect(calls[0].init?.headers).toMatchObject({ Authorization: "Bearer cpt" })
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ receipt: "r.e.c", action_completed: true })
  })

  it("refuses an issuer that is not accepted and surfaces an HTTP failure", async () => {
    await expect(consumeReceiptOnline("r", { issuer: "https://evil.example", acceptedIssuers: [ISSUER], counterpartyToken: "t", actionCompleted: false })).rejects.toThrow(/not accepted/)
    const failing = (async () => new Response("<html>", { status: 500 })) as typeof fetch
    await expect(consumeReceiptOnline("r", { issuer: ISSUER, acceptedIssuers: [ISSUER], counterpartyToken: "t", actionCompleted: false, fetch: failing })).rejects.toThrow(/HTTP 500/)
    const empty = (async () => new Response("", { status: 200 })) as typeof fetch
    expect(await consumeReceiptOnline("r", { issuer: ISSUER, acceptedIssuers: [ISSUER], counterpartyToken: "t", actionCompleted: false, fetch: empty })).toBeUndefined()
  })
})
