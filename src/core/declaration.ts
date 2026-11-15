/**
 * The authorization declaration of a gated tool (agent role).
 *
 * The author names the action and scope tokens the grant covers and says how
 * to derive the monetary value, the currency, the counterparty and the
 * free-form context from the call's arguments. Nothing here is persisted by
 * Overturo: the context is hashed into the receipt's `context_hash`, the rest
 * rides the authorize request.
 */
export interface ToolAuthorization<Args = Record<string, unknown>> {
  /** Action token from the grant's allowed actions (for example `pay`, `send`). */
  action: string
  /** Scope token the grant covers (for example `payments:transfer`). */
  scope: string
  /** Decimal-as-string value when the action is monetary. Requires `currency`. */
  value?: (args: Args) => string
  /** ISO 4217 or stablecoin code. Requires `value`. */
  currency?: (args: Args) => string
  /** Counterparty identifier (DID / HTTPS URL / URN); becomes the receipt's `aud`. */
  counterparty?: (args: Args) => string | undefined
  /** Free-form context, hashed into the receipt's `context_hash`; never stored by Overturo. */
  context?: (args: Args) => Record<string, unknown> | undefined
  /**
   * How a held decision is delivered to the client. `auto` (the default)
   * follows what the client declared; `pending` always answers the pending
   * result — for a tool whose caller is never one of the decision's signers.
   */
  delivery?: "auto" | "pending"
}

/** The authorize request derived from one call's arguments. */
export interface DerivedAuthorization {
  action: string
  scope: string
  value?: string
  currency?: string
  counterparty?: string
  context?: Record<string, unknown>
}

/** Throws at wrap time when the declaration cannot produce a valid request. */
export function validateDeclaration(tool: string, decl: ToolAuthorization<never>): void {
  if (!decl || typeof decl !== "object") throw new Error(`gateTool(${tool}): a declaration is required`)
  if (!decl.action) throw new Error(`gateTool(${tool}): declaration.action is required`)
  if (!decl.scope) throw new Error(`gateTool(${tool}): declaration.scope is required`)
  if ((decl.value === undefined) !== (decl.currency === undefined)) {
    throw new Error(`gateTool(${tool}): declare both value and currency, or neither`)
  }
  if (decl.delivery !== undefined && decl.delivery !== "auto" && decl.delivery !== "pending") {
    throw new Error(`gateTool(${tool}): delivery must be "auto" or "pending"`)
  }
}

/** Applies the declaration to one call's arguments. Derivation errors propagate to the caller. */
export function deriveAuthorization<Args>(decl: ToolAuthorization<Args>, args: Args): DerivedAuthorization {
  const out: DerivedAuthorization = { action: decl.action, scope: decl.scope }
  if (decl.value) out.value = decl.value(args)
  // The platform upcases the currency it records; derive the wire form here so
  // the receipt's claim equals what a counterparty binds.
  if (decl.currency) out.currency = String(decl.currency(args)).toUpperCase()
  const counterparty = decl.counterparty?.(args)
  if (counterparty !== undefined) out.counterparty = counterparty
  const context = decl.context?.(args)
  if (context !== undefined) out.context = context
  return out
}
