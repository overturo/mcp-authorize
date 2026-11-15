import { canonicalize } from "@overturo/sdk"
import { describe, expect, it } from "vitest"
import { argumentsDigest, contextHash, sha256Hex } from "../../src/core/canonical.js"
import { elicitationFixture } from "../support/corpus.js"

interface Case {
  context: Record<string, unknown>
  canonical: string
  sha256: string
}

const cases = elicitationFixture<Case[]>("context_hash_cases")
const hasFalse = (v: unknown): boolean =>
  v === false || (!!v && typeof v === "object" && Object.values(v as Record<string, unknown>).some(hasFalse))

describe("argumentsDigest", () => {
  it("ignores an undefined an in-process caller left behind, and keeps the digest of the JSON the client sent", () => {
    expect(argumentsDigest({ a: 1, b: undefined })).toBe(argumentsDigest({ a: 1 }))
    expect(argumentsDigest(undefined)).toBe(argumentsDigest({}))
  })
})

describe("context hash parity with the shared fixtures", () => {
  for (const c of cases.filter((c) => !hasFalse(c.context))) {
    it(`hashes ${c.canonical.slice(0, 40)}… as the platform does`, () => {
      expect(canonicalize(c.context)).toBe(c.canonical)
      expect(contextHash(c.context)).toBe(c.sha256)
    })
  }

  // The platform's canonicaliser reads a hash value as `hash[k] || hash[k.to_sym]`,
  // which turns a `false` value into `null` before it is serialised; the fixture
  // records that. The SDK keeps `false`, so this case diverges until the platform
  // is corrected — this test turns red the day the fixture is regenerated from a
  // fixed canonicaliser, which is the signal to drop the `.fails`.
  for (const c of cases.filter((c) => hasFalse(c.context))) {
    it(`a context with a false value matches the platform`, () => {
      expect(contextHash(c.context)).toBe(c.sha256)
    })
  }

  it("covers the fixture set", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5)
  })
})

describe("digests", () => {
  it("contextHash of nothing is the hash of {}", () => {
    expect(contextHash(undefined)).toBe(sha256Hex("{}"))
    expect(contextHash(null)).toBe(contextHash({}))
  })

  it("argumentsDigest is order-insensitive and distinguishes values", () => {
    expect(argumentsDigest({ a: 1, b: "x" })).toBe(argumentsDigest({ b: "x", a: 1 }))
    expect(argumentsDigest({ a: 1 })).not.toBe(argumentsDigest({ a: 2 }))
    expect(argumentsDigest(undefined)).toBe(argumentsDigest({}))
  })
})
