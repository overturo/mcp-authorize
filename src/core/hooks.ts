import type { DecisionOutcomeName } from "./outcomes.js"

export type DeliveryName = "input_required" | "url_error" | "pending"

/** One event per outcome of a gated call, for the author's own metrics. */
export interface DecisionEvent {
  tool: string
  outcome: DecisionOutcomeName
  delivery?: DeliveryName
  decisionId?: string
}

export type OnDecision = (event: DecisionEvent) => void

/** Fires the hook; a throwing hook never breaks the call. */
export function emitDecision(hook: OnDecision | undefined, event: DecisionEvent): void {
  if (!hook) return
  try {
    hook(event)
  } catch {
    // the author's hook, the author's problem
  }
}
