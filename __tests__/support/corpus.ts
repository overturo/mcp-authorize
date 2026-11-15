// Shared conformance fixtures: read from the shared corpus when this package sits
// next to it, from the vendored copy under __tests__/fixtures otherwise (the
// published package carries only the vendored copy).
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const SHARED = join(__dirname, "..", "..", "..", "shared", "conformance")
const VENDORED = join(__dirname, "..", "fixtures")

export function fixtureDir(kind: "api_responses" | "elicitation"): string {
  const override = process.env.OVERTURO_CONFORMANCE_DIR
  if (override) return join(override, kind)
  const shared = join(SHARED, kind)
  return existsSync(shared) ? shared : join(VENDORED, kind)
}

export interface CorpusExchange {
  operationId: string
  request: { method: string; path: string; query?: Record<string, string>; headers: Record<string, string>; body?: unknown }
  response: { status: number; headers: Record<string, string>; body: unknown }
}

export function corpusExchange(operationId: string, step?: string): CorpusExchange {
  const file = join(fixtureDir("api_responses"), `${operationId}${step ? `.${step}` : ""}.json`)
  return JSON.parse(readFileSync(file, "utf8")) as CorpusExchange
}

export function corpusBody<T = Record<string, unknown>>(operationId: string, step?: string): T {
  return corpusExchange(operationId, step).response.body as T
}

export function elicitationFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(fixtureDir("elicitation"), `${name}.json`), "utf8")) as T
}

/** Deep key-sorted copy, so two JSON shapes compare regardless of key order. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])])
    )
  }
  return value
}
