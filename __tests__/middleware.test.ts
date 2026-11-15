import { beforeAll, describe, expect, it } from "vitest"
import { assertReceipt, KeySetSource, MemoryStore, mcpAuthorize, OapError } from "../src/index.js"
import { createOverturoStub } from "./support/overturo_stub.js"
import { AUDIENCE, createMinter, ISSUER, type Minter } from "./support/receipts.js"

let minter: Minter

beforeAll(async () => {
  minter = await createMinter()
})

const base = () => ({ acceptedIssuers: [ISSUER], ownIdentifier: AUDIENCE, jwks: minter.jwks, fetch: null })
const req = (receipt: string) => ({ method: "tools/call", params: { _meta: { oap_receipt: receipt }, name: "ping" } })

describe("mcpAuthorize (counterparty role, any runtime)", () => {
  it("rejects when acceptedIssuers or ownIdentifier are missing", () => {
    expect(() => mcpAuthorize({ ...base(), acceptedIssuers: [] })).toThrow(/acceptedIssuers/)
    expect(() => mcpAuthorize({ ...base(), ownIdentifier: "" })).toThrow(/ownIdentifier/)
  })

  it("verifies a receipt riding in params._meta.oap_receipt", async () => {
    const verify = mcpAuthorize(base())
    const receipt = await minter.sign(minter.claims())
    const outcome = await verify(req(receipt))
    expect(outcome.ok).toBe(true)
    if (outcome.ok !== true) return
    expect(outcome.context.claims.action).toBe("write")
    expect(outcome.context.receipt).toBe(receipt)
  })

  it("verifies a multi-issuer receipt via issuerJwks, not the fallback jwks", async () => {
    const eu = "https://overturo.eu"
    const decoy = [{ ...minter.jwks[0], kid: "decoy-kid" }]
    const verify = mcpAuthorize({ acceptedIssuers: [eu], ownIdentifier: AUDIENCE, jwks: decoy, issuerJwks: { [eu]: minter.jwks }, fetch: null })
    const outcome = await verify(req(await minter.sign(minter.claims({ iss: eu }))))
    expect(outcome.ok).toBe(true)
  })

  it("fetches the issuer's published keys through a shared KeySetSource", async () => {
    const stub = createOverturoStub(minter)
    const keys = new KeySetSource({ issuers: [ISSUER], fetch: stub.fetch })
    const verify = mcpAuthorize({ acceptedIssuers: [ISSUER], ownIdentifier: AUDIENCE, keys })
    expect((await verify(req(await minter.sign(minter.claims())))).ok).toBe(true)
    expect((await verify(req(await minter.sign(minter.claims())))).ok).toBe(true)
    expect(stub.jwksCalls()).toHaveLength(1)
  })

  it("returns auth_missing when required and no receipt is present", async () => {
    expect(await mcpAuthorize(base())({ method: "tools/call", params: {} })).toEqual({ ok: false, reason_code: "auth_missing" })
    expect(await mcpAuthorize(base())({ method: "tools/call", params: { _meta: { oap_receipt: 7 } } })).toEqual({ ok: false, reason_code: "auth_missing" })
    expect(await mcpAuthorize(base())({ method: "tools/call" })).toEqual({ ok: false, reason_code: "auth_missing" })
  })

  it("soft mode says what it saw: no_receipt, with no claim object at all", async () => {
    const verify = mcpAuthorize({ ...base(), required: false })
    const outcome = await verify({ method: "tools/call", params: {} })
    expect(outcome).toEqual({ ok: "no_receipt" })
    expect("context" in outcome).toBe(false)
  })

  it("propagates the verify failure reason_code and binds when asked", async () => {
    const receipt = await minter.sign(minter.claims())
    const wrong = mcpAuthorize({ ...base(), ownIdentifier: "did:web:other.example" })
    expect(await wrong(req(receipt))).toEqual({ ok: false, reason_code: "invalid_aud" })
    const bound = mcpAuthorize({ ...base(), bind: { action: "delete" } })
    expect(await bound(req(receipt))).toEqual({ ok: false, reason_code: "action_mismatch" })
    expect((await mcpAuthorize(base())(req(receipt))).ok).toBe(true)
  })

  it("refuses a replay through the shared store", async () => {
    const replay = new MemoryStore({ sweepIntervalSeconds: 0 })
    const verify = mcpAuthorize({ ...base(), replay })
    const receipt = await minter.sign(minter.claims())
    expect((await verify(req(receipt))).ok).toBe(true)
    expect(await verify(req(receipt))).toEqual({ ok: false, reason_code: "receipt_replayed" })
  })

  it("supports a custom extractor for non-default metadata layouts", async () => {
    const verify = mcpAuthorize({ ...base(), extractor: (r) => (r.params?.["oap-receipt"] as string | undefined) ?? null })
    const outcome = await verify({ method: "tools/call", params: { "oap-receipt": await minter.sign(minter.claims()) } })
    expect(outcome.ok).toBe(true)
  })

  it("returns malformed when the embedded receipt isn't a JWT", async () => {
    expect(await mcpAuthorize(base())(req("not-a-jwt"))).toEqual({ ok: false, reason_code: "malformed" })
  })
})

describe("assertReceipt", () => {
  it("returns the context on success and null in soft mode without a receipt", async () => {
    const receipt = await minter.sign(minter.claims())
    const ctx = await assertReceipt({ params: { _meta: { oap_receipt: receipt } } }, base())
    expect(ctx?.claims.action).toBe("write")
    expect(await assertReceipt({ params: {} }, { ...base(), required: false })).toBeNull()
  })

  it("throws OapError carrying the reason_code on failure", async () => {
    let caught: unknown
    try {
      await assertReceipt({ params: {} }, base())
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(OapError)
    expect((caught as OapError).reason_code).toBe("auth_missing")
    expect((caught as OapError).message).not.toMatch(/chronicle|touchpoint|accord|hydra/i)
  })
})
