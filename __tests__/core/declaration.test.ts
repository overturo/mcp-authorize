import { describe, expect, it } from "vitest"
import { deriveAuthorization, validateDeclaration, type ToolAuthorization } from "../../src/core/declaration.js"

type Args = { amount: string; currency: string; payee?: string; memo?: string }

describe("validateDeclaration", () => {
  it("accepts a complete declaration", () => {
    expect(() => validateDeclaration("t", { action: "write", scope: "s" })).not.toThrow()
    expect(() =>
      validateDeclaration("t", { action: "write", scope: "s", value: () => "1", currency: () => "USD", delivery: "pending" })
    ).not.toThrow()
  })

  it("refuses value without currency and the reverse", () => {
    expect(() => validateDeclaration("t", { action: "a", scope: "s", value: () => "1" })).toThrow(/both value and currency/)
    expect(() => validateDeclaration("t", { action: "a", scope: "s", currency: () => "USD" })).toThrow(/both value and currency/)
  })

  it("refuses a missing action, scope, declaration or an unknown delivery", () => {
    expect(() => validateDeclaration("t", { action: "", scope: "s" })).toThrow(/action/)
    expect(() => validateDeclaration("t", { action: "a", scope: "" })).toThrow(/scope/)
    expect(() => validateDeclaration("t", undefined as never)).toThrow(/declaration/)
    expect(() => validateDeclaration("t", { action: "a", scope: "s", delivery: "later" as never })).toThrow(/delivery/)
  })
})

describe("deriveAuthorization", () => {
  const decl: ToolAuthorization<Args> = {
    action: "write",
    scope: "payments:transfer",
    value: (a) => a.amount,
    currency: (a) => a.currency,
    counterparty: (a) => a.payee,
    context: (a) => (a.memo ? { memo: a.memo } : undefined),
  }

  it("derives every field the declaration names", () => {
    expect(deriveAuthorization(decl, { amount: "10.00", currency: "USD", payee: "did:web:x", memo: "m" })).toEqual({
      action: "write",
      scope: "payments:transfer",
      value: "10.00",
      currency: "USD",
      counterparty: "did:web:x",
      context: { memo: "m" },
    })
  })

  it("derives the currency in its wire form, upper case", () => {
    const decl: ToolAuthorization<Args> = { action: "write", scope: "s", value: (a) => a.amount, currency: (a) => a.currency }
    expect(deriveAuthorization(decl, { amount: "1.00", currency: "usd" }).currency).toBe("USD")
  })

  it("omits what the derivations do not produce", () => {
    expect(deriveAuthorization(decl, { amount: "1", currency: "EUR" })).toEqual({
      action: "write",
      scope: "payments:transfer",
      value: "1",
      currency: "EUR",
    })
    expect(deriveAuthorization({ action: "read", scope: "s" }, {})).toEqual({ action: "read", scope: "s" })
  })
})
