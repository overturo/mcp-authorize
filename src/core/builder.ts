/**
 * The three shapes a held decision takes on the MCP wire. A field-for-field
 * mirror of the platform's builder; the shared conformance fixtures under
 * `conformance/elicitation/` pin both sides.
 *
 *   - `urlErrorData`      — the `-32042` "URL elicitation required" data (2025-11-25)
 *   - `inputRequiredResult` — the multi round-trip input-required result (2026-07-28)
 *   - `pendingResult`     — the structured pending result for a client that declared no URL mode
 */

export const INPUT_KEY = "decision"

export interface UrlElicitationParams {
  elicitationId: string
  url: string
  message: string
}

export interface UrlElicitation {
  mode: "url"
  elicitationId: string
  url: string
  message: string
}

export function urlElicitation(p: UrlElicitationParams): UrlElicitation {
  return { mode: "url", elicitationId: p.elicitationId, url: p.url, message: p.message }
}

export function urlErrorData(p: UrlElicitationParams): { elicitations: UrlElicitation[] } {
  return { elicitations: [urlElicitation(p)] }
}

export interface InputRequiredShape {
  resultType: "input_required"
  inputRequests: Record<string, { method: "elicitation/create"; params: { mode: "url"; message: string; url: string } }>
  requestState: string
}

export function inputRequiredResult(p: { url: string; message: string; requestState: string }): InputRequiredShape {
  return {
    resultType: "input_required",
    inputRequests: {
      [INPUT_KEY]: { method: "elicitation/create", params: { mode: "url", message: p.message, url: p.url } },
    },
    requestState: p.requestState,
  }
}

export interface PendingShape {
  content: Array<{ type: "text"; text: string }>
  structuredContent: {
    held: true
    decision_id: string
    decision_url: string
    expires_at: string | null
    trigger: string
    next: string
  }
  isError: false
  _meta: Record<string, unknown>
}

export function pendingResult(p: {
  decisionId: string
  decisionUrl: string
  expiresAt: Date | null
  trigger: string
  next: string
  text: string
  meta?: Record<string, unknown>
}): PendingShape {
  return {
    content: [{ type: "text", text: p.text }],
    structuredContent: {
      held: true,
      decision_id: p.decisionId,
      decision_url: p.decisionUrl,
      expires_at: p.expiresAt ? iso8601Seconds(p.expiresAt) : null,
      trigger: p.trigger,
      next: p.next,
    },
    isError: false,
    _meta: { held: true, ...(p.meta ?? {}) },
  }
}

/** Second precision with a `Z` suffix — the platform's `iso8601`. */
export function iso8601Seconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z")
}
