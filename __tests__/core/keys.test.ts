import { describe, expect, it } from "vitest"
import { cacheSeconds, KeySetSource, MIN_FETCH_INTERVAL_SECONDS } from "../../src/core/keys.js"
import { rawEd25519ToJwk, bytesToBase64url } from "@overturo/sdk"
import { createOverturoStub } from "../support/overturo_stub.js"
import { createMinter, ISSUER } from "../support/receipts.js"

const staticKey = (kid: string, fill = 0) => rawEd25519ToJwk(kid, bytesToBase64url(new Uint8Array(32).fill(fill)))

function clock() {
  let t = 1_000_000
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe("KeySetSource", () => {
  it("fetches an accepted issuer's published set once and serves from cache", async () => {
    const stub = createOverturoStub(await createMinter())
    const c = clock()
    const keys = new KeySetSource({ issuers: [ISSUER], fetch: stub.fetch, now: c.now })
    expect(await keys.keysFor(ISSUER)).toEqual(stub.jwks)
    expect(await keys.keysFor(`${ISSUER}/`)).toEqual(stub.jwks)
    expect(stub.jwksCalls()).toHaveLength(1)
    expect(stub.jwksCalls()[0].headers.accept).toBe("application/json")
  })

  it("honours Cache-Control max-age up to a day and refetches after it", async () => {
    const stub = createOverturoStub(await createMinter())
    const c = clock()
    stub.jwksCacheControl = "public, max-age=100"
    const keys = new KeySetSource({ issuers: [ISSUER], fetch: stub.fetch, now: c.now })
    await keys.keysFor(ISSUER)
    c.advance(99_000)
    await keys.keysFor(ISSUER)
    expect(stub.jwksCalls()).toHaveLength(1)
    c.advance(2_000)
    await keys.keysFor(ISSUER)
    expect(stub.jwksCalls()).toHaveLength(2)
  })

  it("never fetches an issuer that is not accepted, and never from a receipt's URL", async () => {
    const stub = createOverturoStub(await createMinter())
    const keys = new KeySetSource({ issuers: [ISSUER], fetch: stub.fetch, jwks: [staticKey("static")] })
    expect(await keys.keysFor("https://evil.example")).toEqual([staticKey("static")])
    expect(await keys.refresh("https://evil.example")).toHaveLength(1)
    expect(stub.jwksCalls()).toHaveLength(0)
  })

  it("re-fetches once on refresh and keeps the cached set when the refetch fails", async () => {
    const stub = createOverturoStub(await createMinter())
    const keys = new KeySetSource({ issuers: [ISSUER], fetch: stub.fetch })
    const first = await keys.keysFor(ISSUER)
    stub.jwksStatus = 500
    expect(await keys.refresh(ISSUER)).toEqual(first)
    expect(stub.jwksCalls()).toHaveLength(2)
  })

  it("falls back to the static set when the fetch fails, per issuer first", async () => {
    const stub = createOverturoStub(await createMinter())
    stub.jwksStatus = 503
    const shared = [staticKey("shared", 1)]
    const own = [staticKey("own", 2)]
    const keys = new KeySetSource({ issuers: [ISSUER, "https://overturo.eu"], fetch: stub.fetch, jwks: shared, issuerJwks: { [ISSUER]: own } })
    expect(await keys.keysFor(ISSUER)).toEqual(own)
    expect(await keys.keysFor("https://overturo.eu")).toEqual(shared)
  })

  it("ignores a malformed key set and non-key entries, and survives a throwing fetch", async () => {
    const bad = new KeySetSource({ issuers: [ISSUER], fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch })
    expect(await bad.keysFor(ISSUER)).toEqual([])
    const mixed = new KeySetSource({
      issuers: [ISSUER],
      fetch: (async () => new Response(JSON.stringify({ keys: [staticKey("k", 3), { kid: 1 }, null] }), { status: 200 })) as typeof fetch,
    })
    expect(await mixed.keysFor(ISSUER)).toEqual([staticKey("k", 3)])
    const throwing = new KeySetSource({ issuers: [ISSUER], fetch: (async () => { throw new TypeError("down") }) as typeof fetch })
    expect(await throwing.keysFor(ISSUER)).toEqual([])
  })

  it("never fetches with fetch: null (static keys only)", async () => {
    const keys = new KeySetSource({ issuers: [ISSUER], fetch: null, jwks: [] })
    expect(await keys.keysFor(ISSUER)).toEqual([])
    expect(await keys.refresh(ISSUER)).toEqual([])
  })

  it("serves fetched keys and pinned static keys; on one kid in both, the pinned key wins (a trust anchor, not a cache)", async () => {
    const stub = createOverturoStub(await createMinter())
    const pinned = staticKey("pinned", 4)
    const anchored = { ...stub.jwks[0], x: "anchored" }
    const keys = new KeySetSource({ issuers: [ISSUER], fetch: stub.fetch, jwks: [pinned, anchored] })
    expect(await keys.keysFor(ISSUER)).toEqual([pinned, anchored])
  })

  it("fetches over https only (loopback may be plain), and refuses anything else at construction", () => {
    expect(() => new KeySetSource({ issuers: ["https://overturo.com"] })).not.toThrow()
    expect(() => new KeySetSource({ issuers: ["http://localhost:3000", "http://127.0.0.1:3000", "http://api.localhost"] })).not.toThrow()
    expect(() => new KeySetSource({ issuers: ["http://overturo.com"] })).toThrow(/https/)
    expect(() => new KeySetSource({ issuers: ["not a url"] })).toThrow(/not a URL/)
  })

  it("treats a set with no usable key as an outage: the last set stands, and the fetch is retried after the interval", async () => {
    const stub = createOverturoStub(await createMinter())
    const c = clock()
    stub.jwksCacheControl = "max-age=10"
    const keys = new KeySetSource({ issuers: [ISSUER], fetch: stub.fetch, now: c.now })
    const first = await keys.keysFor(ISSUER)
    c.advance(11_000)
    stub.jwks = []
    expect(await keys.keysFor(ISSUER)).toEqual(first)
    expect(await keys.keysFor(ISSUER)).toEqual(first)
    expect(stub.jwksCalls()).toHaveLength(2)
  })

  it("serves the last set fetched when its lifetime is over and the refetch fails, until a fetch succeeds", async () => {
    const stub = createOverturoStub(await createMinter())
    const c = clock()
    stub.jwksCacheControl = "max-age=10"
    const keys = new KeySetSource({ issuers: [ISSUER], fetch: stub.fetch, now: c.now, jwks: [staticKey("pinned", 5)] })
    const first = await keys.keysFor(ISSUER)
    c.advance(11_000)
    stub.jwksStatus = 503
    c.advance(MIN_FETCH_INTERVAL_SECONDS * 1000)
    expect(await keys.keysFor(ISSUER)).toEqual(first)
    expect(stub.jwksCalls()).toHaveLength(2)
    stub.jwksStatus = 200
    stub.jwks = [staticKey("rotated", 6)]
    c.advance(MIN_FETCH_INTERVAL_SECONDS * 1000)
    expect(await keys.keysFor(ISSUER)).toEqual([staticKey("rotated", 6), staticKey("pinned", 5)])
  })

  it("refreshes one issuer at most once per interval after the one a rotation needs: unknown keys on the wire cannot drive a fetch per receipt", async () => {
    const stub = createOverturoStub(await createMinter())
    const c = clock()
    const keys = new KeySetSource({ issuers: [ISSUER], fetch: stub.fetch, now: c.now })
    const set = await keys.keysFor(ISSUER)
    for (let i = 0; i < 5; i++) expect(await keys.refresh(ISSUER)).toEqual(set)
    expect(stub.jwksCalls()).toHaveLength(2)
    c.advance(MIN_FETCH_INTERVAL_SECONDS * 1000 + 1)
    await keys.refresh(ISSUER)
    expect(stub.jwksCalls()).toHaveLength(3)
  })

  it("does not retry a failed fetch before the interval, and serves the static keys meanwhile", async () => {
    const stub = createOverturoStub(await createMinter())
    const c = clock()
    stub.jwksStatus = 503
    const keys = new KeySetSource({ issuers: [ISSUER], fetch: stub.fetch, now: c.now, jwks: [staticKey("pinned", 7)] })
    expect(await keys.keysFor(ISSUER)).toEqual([staticKey("pinned", 7)])
    expect(await keys.keysFor(ISSUER)).toEqual([staticKey("pinned", 7)])
    expect(stub.jwksCalls()).toHaveLength(1)
    stub.jwksStatus = 200
    c.advance(MIN_FETCH_INTERVAL_SECONDS * 1000 + 1)
    expect(await keys.keysFor(ISSUER)).toEqual([...stub.jwks, staticKey("pinned", 7)])
  })

  it("coalesces concurrent fetches of one issuer", async () => {
    const stub = createOverturoStub(await createMinter())
    const keys = new KeySetSource({ issuers: [ISSUER], fetch: stub.fetch })
    await Promise.all([keys.keysFor(ISSUER), keys.keysFor(ISSUER), keys.refresh(ISSUER)])
    expect(stub.jwksCalls()).toHaveLength(1)
  })
})

describe("cacheSeconds", () => {
  it("parses max-age, caps at a day, and defaults sensibly", () => {
    expect(cacheSeconds("max-age=60")).toBe(60)
    expect(cacheSeconds("public, max-age=999999")).toBe(86_400)
    expect(cacheSeconds("max-age=0")).toBe(1)
    expect(cacheSeconds("no-store")).toBe(1)
    expect(cacheSeconds("public")).toBe(300)
    expect(cacheSeconds(null)).toBe(300)
  })
})
