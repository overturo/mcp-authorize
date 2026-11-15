/**
 * The framework-free decision router both adapters share: read the open
 * decision for this call (request state first, store second), wait on it or
 * authorize now, and hand the adapter one step to emit — run the handler,
 * return a result, or deliver a held decision.
 */
import type { OverturoAuthorize } from "@overturo/sdk"
import { authorizeToolCall } from "./authorize.js"
import { argumentsDigest } from "./canonical.js"
import type { ToolAuthorization } from "./declaration.js"
import { emitDecision, type OnDecision } from "./hooks.js"
import type { Decision, HeldDecision } from "./outcomes.js"
import {
  counteredResult,
  denyResult,
  receiptExpiredResult,
  refusedResult,
  unavailableResult,
  type ToolResultShape,
} from "./results.js"
import { DEFAULT_HOLD_SECONDS, waitForSettlement } from "./settle.js"
import {
  claimResumption,
  MemoryStore,
  readResumption,
  resumptionKey,
  writeResumption,
  writeResumptionIfAbsent,
  type ResumptionEntry,
  type Store,
} from "./stores.js"

/** Life of an entry materialised from a request state alone (the state's own TTL is the real bound). */
export const POINTER_ENTRY_SECONDS = 600

export interface GateCore {
  client: OverturoAuthorize
  store: Store
  holdSeconds: number
  onDecision?: OnDecision
  now: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface GateCoreOptions {
  client: OverturoAuthorize
  store?: Store
  holdSeconds?: number
  onDecision?: OnDecision
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export function createGateCore(opts: GateCoreOptions): GateCore {
  if (!opts.client) throw new Error("gateTool: client is required (an OverturoAuthorize from @overturo/sdk)")
  return {
    client: opts.client,
    store: opts.store ?? new MemoryStore(),
    holdSeconds: opts.holdSeconds ?? DEFAULT_HOLD_SECONDS,
    onDecision: opts.onDecision,
    now: opts.now ?? Date.now,
    sleep: opts.sleep,
  }
}

/** The pointer a verified request state carries (2026-07-28). */
export interface HeldPointer {
  decisionId: string
  /** The decision page, so a process whose store never saw the hold can still deliver it. */
  decisionUrl?: string
  /** ISO 8601 expiry of the decision, when the state carries it. */
  expiresAt?: string
}

export type GateStep =
  | { kind: "run"; decision: Decision }
  | { kind: "result"; result: ToolResultShape }
  | { kind: "held"; held: HeldDecision; digest: string; repeated: boolean }
  | { kind: "invalid_state" }

export async function gateCall<Args>(
  core: GateCore,
  tool: string,
  decl: ToolAuthorization<Args>,
  args: Args,
  pointer?: HeldPointer
): Promise<GateStep> {
  const digest = argumentsDigest(args)
  const key = resumptionKey(tool, digest)
  let entry = await readResumption(core.store, key, core.now)

  if (pointer) {
    if (entry && entry.state === "pending" && entry.decision_id !== pointer.decisionId) return { kind: "invalid_state" }
    if (!entry) {
      // The state is the only record of this hold (another process without a
      // shared store, or the entry lapsed). Materialise it before waiting, so
      // the resumption is claimed once here as well — a state echoed twice
      // within the receipt's life must not run the handler twice.
      const carried = pointer.expiresAt ? Date.parse(pointer.expiresAt) : Number.NaN
      const materialised: ResumptionEntry = {
        decision_id: pointer.decisionId,
        decision_url: pointer.decisionUrl ?? "",
        wait_url: "",
        expires_at: new Date(Number.isFinite(carried) ? carried : core.now() + POINTER_ENTRY_SECONDS * 1000).toISOString(),
        record_id: "",
        state: "pending",
      }
      await writeResumptionIfAbsent(core.store, key, materialised, core.now)
      entry = (await readResumption(core.store, key, core.now)) ?? materialised
      if (entry.state === "pending" && entry.decision_id !== pointer.decisionId) return { kind: "invalid_state" }
    }
  }

  // A pending entry is waited on. A resumed or refused one is history: the
  // retry after a resumed execution — with or without a stale request state —
  // is a new authorization, never a second run.
  if (entry && entry.state === "pending") return resume(core, tool, key, entry, digest)
  return authorizeNow(core, tool, decl, args, key, digest)
}

async function resume(
  core: GateCore,
  tool: string,
  key: string,
  entry: ResumptionEntry,
  digest: string
): Promise<GateStep> {
  const settled = await waitForSettlement(core.client, entry.decision_id, {
    holdSeconds: core.holdSeconds,
    now: core.now,
    sleep: core.sleep,
  })
  const decisionId = entry.decision_id
  switch (settled.kind) {
    case "pending":
      emitDecision(core.onDecision, { tool, outcome: "pending", decisionId })
      return { kind: "held", held: heldFromEntry(entry), digest, repeated: true }
    case "approved": {
      // The claim moves the entry to `resumed` and leaves it there until the
      // decision's expiry plus grace: a retry in that window finds history,
      // not a pending decision, and authorizes anew.
      const claimed = await claimResumption(core.store, key, entry, core.now)
      if (!claimed) {
        // Someone else resumed this decision first; this call is a new authorization.
        return authorizeAfterRace(core, tool, key, digest)
      }
      emitDecision(core.onDecision, { tool, outcome: "approved", decisionId })
      return { kind: "run", decision: { ...settled.decision, decisionId: settled.decision.decisionId ?? decisionId } }
    }
    case "receipt_expired":
      await core.store.delete(key)
      emitDecision(core.onDecision, { tool, outcome: "receipt_expired", decisionId })
      return { kind: "result", result: receiptExpiredResult({ decisionId }) }
    case "denied":
    case "expired":
    case "cancelled":
      await core.store.delete(key)
      emitDecision(core.onDecision, { tool, outcome: settled.kind, decisionId })
      return { kind: "result", result: refusedResult({ ...settled, decisionId: settled.decisionId || decisionId }) }
    case "countered":
      await core.store.delete(key)
      emitDecision(core.onDecision, { tool, outcome: "countered", decisionId })
      return { kind: "result", result: counteredResult({ decisionId, negotiationId: settled.negotiationId }) }
    case "unavailable":
      emitDecision(core.onDecision, { tool, outcome: "unavailable", decisionId })
      return { kind: "result", result: unavailableResult({ reasonCode: settled.reasonCode }) }
  }
}

async function authorizeAfterRace(core: GateCore, tool: string, key: string, digest: string): Promise<GateStep> {
  // The race loser has no declaration in hand here; answer unavailable so the
  // model asks again — the next call is a clean new authorization.
  void key
  void digest
  emitDecision(core.onDecision, { tool, outcome: "unavailable" })
  return { kind: "result", result: unavailableResult({ reasonCode: "nonce_replay" }) }
}

async function authorizeNow<Args>(
  core: GateCore,
  tool: string,
  decl: ToolAuthorization<Args>,
  args: Args,
  key: string,
  digest: string
): Promise<GateStep> {
  const outcome = await authorizeToolCall(core.client, decl, args)
  switch (outcome.kind) {
    case "allow":
      emitDecision(core.onDecision, { tool, outcome: "allow" })
      return { kind: "run", decision: outcome.decision }
    case "deny":
      emitDecision(core.onDecision, { tool, outcome: "deny" })
      return { kind: "result", result: denyResult(outcome) }
    case "unavailable":
      emitDecision(core.onDecision, { tool, outcome: "unavailable" })
      return { kind: "result", result: unavailableResult(outcome) }
    case "held": {
      const held = outcome.held
      const expiresAt = Number.isNaN(held.expiresAt.getTime())
        ? new Date(core.now() + 10 * 60 * 1000)
        : held.expiresAt
      const entry: ResumptionEntry = {
        decision_id: held.decisionId,
        decision_url: held.decisionUrl,
        wait_url: held.waitUrl,
        expires_at: expiresAt.toISOString(),
        record_id: held.recordId,
        state: "pending",
      }
      // Two identical first calls in flight at once both reach the platform;
      // the first to write owns the hold, the other delivers the same decision
      // rather than overwriting it (its own escalation lapses unanswered).
      if (!(await writeResumptionIfAbsent(core.store, key, entry, core.now))) {
        const winner = await readResumption(core.store, key, core.now)
        if (winner && winner.state === "pending") return { kind: "held", held: heldFromEntry(winner), digest, repeated: true }
        await writeResumption(core.store, key, entry, core.now)
      }
      return { kind: "held", held: { ...held, expiresAt }, digest, repeated: false }
    }
  }
}

function heldFromEntry(entry: ResumptionEntry): HeldDecision {
  return {
    decisionId: entry.decision_id,
    decisionUrl: entry.decision_url,
    waitUrl: entry.wait_url,
    expiresAt: new Date(entry.expires_at),
    recordId: entry.record_id,
  }
}

/** Seconds the decision has left (floored at one), for the request state's TTL. */
export function remainingSeconds(held: HeldDecision, now: () => number = Date.now): number {
  const left = Math.ceil((held.expiresAt.getTime() - now()) / 1000)
  return Number.isFinite(left) ? Math.max(1, left) : 600
}
