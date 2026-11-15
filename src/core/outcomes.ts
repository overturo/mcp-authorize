import type { OapReasonCode, ReceiptClaims } from "@overturo/sdk"

/** What a gated handler receives alongside the arguments when the action is authorized. */
export interface Decision {
  /** Compact receipt (`oap+jwt`); hand it downstream so the counterparty can verify it. */
  receipt: string
  /** The receipt's `jti`. */
  receiptId: string
  /** Unix seconds; receipts are short-lived. */
  expiresAt: number
  /** Pointer into the audit trail for the authorize call. */
  recordId: string
  /** The decision reference when the action was approved by a person. */
  decisionId?: string
  /** Pointer into the audit trail for the person's decision, when there was one. */
  decisionRecordId?: string | null
}

/** A decision a person must make before the action runs. */
export interface HeldDecision {
  decisionId: string
  decisionUrl: string
  waitUrl: string
  expiresAt: Date
  recordId: string
}

export type AuthorizeOutcome =
  | { kind: "allow"; decision: Decision }
  | {
      kind: "deny"
      reasonCode: OapReasonCode
      failedBound?: string
      recordId?: string
      negotiateUrl?: string
      message: string
    }
  | { kind: "held"; held: HeldDecision }
  | { kind: "unavailable"; reasonCode: OapReasonCode | "transport"; requestId?: string; message: string }

export type SettlementOutcome =
  | { kind: "pending" }
  | { kind: "approved"; decision: Decision }
  | { kind: "receipt_expired"; decisionId: string }
  | { kind: "denied" | "expired" | "cancelled"; decisionId: string; decidedBy?: string | null }
  | { kind: "countered"; decisionId: string; negotiationId?: string }
  | { kind: "unavailable"; reasonCode: OapReasonCode | "transport"; message: string }

/** What the counterparty-role verifier answers. */
export type VerifyOutcome =
  | { ok: true; claims: ReceiptClaims; receipt: string }
  | { ok: false; reasonCode: OapReasonCode }
  | { ok: "no_receipt" }

/** Every outcome name the `onDecision` hook can report. */
export type DecisionOutcomeName =
  | "allow"
  | "deny"
  | "held"
  | "unavailable"
  | "pending"
  | "approved"
  | "receipt_expired"
  | "denied"
  | "expired"
  | "cancelled"
  | "countered"
