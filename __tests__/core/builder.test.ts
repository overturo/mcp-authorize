import { describe, expect, it } from "vitest"
import { inputRequiredResult, iso8601Seconds, pendingResult, urlElicitation, urlErrorData } from "../../src/core/builder.js"
import { elicitationFixture, sortKeys } from "../support/corpus.js"

const URL_ = "https://overturo.com/decisions/tok_fixture"
const ID = "esc_us_fixture0001"
const MESSAGE = "Approval needed — open Overturo to decide"

describe("builder parity with the shared conformance fixtures", () => {
  it("url_error_data matches field for field", () => {
    const ours = urlErrorData({ elicitationId: ID, url: URL_, message: MESSAGE })
    expect(sortKeys(JSON.parse(JSON.stringify(ours)))).toEqual(sortKeys(elicitationFixture("url_error_data")))
  })

  it("input_required matches field for field", () => {
    const ours = inputRequiredResult({ url: URL_, message: MESSAGE, requestState: "opaque-state-fixture" })
    expect(sortKeys(JSON.parse(JSON.stringify(ours)))).toEqual(sortKeys(elicitationFixture("input_required")))
  })

  it("pending matches field for field, including the second-precision expiry", () => {
    const ours = pendingResult({
      decisionId: ID,
      decisionUrl: URL_,
      expiresAt: new Date("2026-10-26T12:00:00.000Z"),
      trigger: "approval",
      next: "Open the link, decide, then ask again.",
      text: `Approval needed: ${URL_}`,
      meta: { escalation_id: ID },
    })
    expect(sortKeys(JSON.parse(JSON.stringify(ours)))).toEqual(sortKeys(elicitationFixture("pending")))
  })
})

describe("builder pieces", () => {
  it("urlElicitation is the one URL-mode shape", () => {
    expect(urlElicitation({ elicitationId: "a", url: "u", message: "m" })).toEqual({
      mode: "url",
      elicitationId: "a",
      url: "u",
      message: "m",
    })
  })

  it("pending carries a null expiry when none is known", () => {
    const r = pendingResult({ decisionId: "a", decisionUrl: "u", expiresAt: null, trigger: "approval", next: "n", text: "t" })
    expect(r.structuredContent.expires_at).toBeNull()
    expect(r._meta).toEqual({ held: true })
    expect(r.isError).toBe(false)
  })

  it("iso8601Seconds drops milliseconds and keeps Z", () => {
    expect(iso8601Seconds(new Date("2026-10-26T12:00:00.123Z"))).toBe("2026-10-26T12:00:00Z")
  })
})
