import { describe, expect, it } from "vitest"

import {
  OapError,
  OapAuthorizationDenied,
  OapIntentDenied,
  OapTrajectoryDenied,
  OapSequenceDenied,
  isOapError,
} from "../src/index.js"

// overturo-mcp-authorize re-exports the entire OAP
// denial subclass hierarchy from @overturo/authorize. This smoke
// test confirms the names are reachable from the MCP SDK surface,
// catching accidental drops during refactors.
describe("@overturo/mcp-authorize re-exports", () => {
  it("re-exports the four OAP denial classes", () => {
    expect(OapError).toBeDefined()
    expect(OapAuthorizationDenied).toBeDefined()
    expect(OapIntentDenied).toBeDefined()
    expect(OapTrajectoryDenied).toBeDefined()
    expect(OapSequenceDenied).toBeDefined()
  })

  it("re-exports the isOapError type guard", () => {
    const err = new OapError({ reason_code: "validation_failed", message: "x" })
    expect(isOapError(err)).toBe(true)
    expect(isOapError("not an error")).toBe(false)
  })

  it("OapSequenceDenied is a subclass of OapTrajectoryDenied", () => {
    expect(OapSequenceDenied.prototype).toBeInstanceOf(OapTrajectoryDenied)
  })
})
