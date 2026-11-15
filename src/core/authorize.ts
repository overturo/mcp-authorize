import { randomUUID } from "node:crypto"
import { OapError, OapWrongRegion, type OverturoAuthorize, type OapReasonCode } from "@overturo/sdk"
import { deriveAuthorization, type ToolAuthorization } from "./declaration.js"
import type { AuthorizeOutcome, Decision } from "./outcomes.js"

/**
 * Reason codes that mean the credential itself was refused — the handler does
 * not run and the tool answers "unavailable". A credential refusal is never a
 * decision about the action.
 */
const CREDENTIAL_REFUSALS: ReadonlySet<string> = new Set([
  "auth_missing",
  "auth_invalid",
  "dpop_invalid",
  "dpop_replay",
  "nonce_replay",
  "rate_limited",
  "rate_limited_global",
  "internal_error",
  "feature_disabled",
  "validation_failed",
  "not_found",
  "malformed",
])

/** Credential expired or rejected: rotate the token once so the next call carries a fresh one. */
const ROTATE_ON: ReadonlySet<string> = new Set(["auth_invalid"])

export interface AuthorizeToolCallOptions {
  /** Nonce override for tests; a fresh UUID otherwise. */
  nonce?: string
}

/**
 * One authorize request for one tool call. Sent exactly once: the endpoint
 * takes no idempotency key and a retried nonce would be refused as a replay,
 * so a failed request is `unavailable` and the next tool call is a new nonce.
 */
export async function authorizeToolCall<Args>(
  client: OverturoAuthorize,
  decl: ToolAuthorization<Args>,
  args: Args,
  opts: AuthorizeToolCallOptions = {}
): Promise<AuthorizeOutcome> {
  const derived = deriveAuthorization(decl, args)
  let body: unknown
  try {
    body = await client.authorize({ nonce: opts.nonce ?? randomUUID(), ...derived })
  } catch (error) {
    return await mapError(client, error)
  }
  return mapResponse(body)
}

function mapResponse(body: unknown): AuthorizeOutcome {
  const res = (body ?? {}) as Record<string, unknown>
  if (res.decision === "allow" && typeof res.receipt === "string") {
    return { kind: "allow", decision: decisionFromAllow(res) }
  }
  if (res.decision === "escalate" && typeof res.escalation_id === "string") {
    return {
      kind: "held",
      held: {
        decisionId: res.escalation_id,
        decisionUrl: String(res.decision_url ?? ""),
        waitUrl: String(res.wait_url ?? ""),
        expiresAt: new Date(String(res.approval_ttl_at ?? "")),
        recordId: String(res.record_id ?? ""),
      },
    }
  }
  return { kind: "unavailable", reasonCode: "malformed", message: "The authorization answer could not be read." }
}

/** The allow body (and the approved settlement body, which embeds it) as a {@link Decision}. */
export function decisionFromAllow(res: Record<string, unknown>): Decision {
  const decision: Decision = {
    receipt: String(res.receipt),
    receiptId: String(res.jti ?? res.receipt_jti ?? ""),
    expiresAt: Number(res.exp ?? 0),
    recordId: String(res.record_id ?? ""),
  }
  if (typeof res.escalation_id === "string") decision.decisionId = res.escalation_id
  if ("decision_record_id" in res) decision.decisionRecordId = (res.decision_record_id as string | null) ?? null
  return decision
}

async function mapError(client: OverturoAuthorize, error: unknown): Promise<AuthorizeOutcome> {
  if (!(error instanceof OapError)) {
    return { kind: "unavailable", reasonCode: "transport", message: describe(error) }
  }
  const code = error.reason_code as OapReasonCode
  if (ROTATE_ON.has(code)) {
    try {
      await client.refreshToken()
    } catch {
      // the refusal is surfaced either way; the rotation was best effort
    }
  }
  // A grant that is missing, expired, revoked, or does not cover the scope or
  // action is a decision about the action (`denial_category` "authorization"):
  // the model is told the reason. Only the credential and transport refusals
  // above are "unavailable".
  if (CREDENTIAL_REFUSALS.has(code) || error instanceof OapWrongRegion) {
    return { kind: "unavailable", reasonCode: code, requestId: error.request_id, message: error.message }
  }
  return {
    kind: "deny",
    reasonCode: code,
    failedBound: error.failed_bound,
    recordId: recordIdOf(error.detail),
    negotiateUrl: error.negotiate_url,
    message: error.message,
  }
}

function recordIdOf(detail: unknown): string | undefined {
  if (detail && typeof detail === "object" && typeof (detail as Record<string, unknown>).record_id === "string") {
    return (detail as Record<string, string>).record_id
  }
  return undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
