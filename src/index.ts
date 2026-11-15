/**
 * @overturo/mcp-authorize — authorization for MCP servers in two roles.
 *
 * Agent role: wrap a tool's handler so Overturo decides before it runs
 * (`@overturo/mcp-authorize/server` for @modelcontextprotocol/server,
 * `@overturo/mcp-authorize/legacy` for @modelcontextprotocol/sdk).
 *
 * Counterparty role: verify a receipt a caller hands you before honouring the
 * action (`verifyReceipt`, `mcpAuthorize`, `assertReceipt` — this entry, for
 * any runtime).
 *
 * This entry is the framework-free core the adapters are thin over.
 */

export { mcpAuthorize, assertReceipt } from "./middleware.js"
export type {
  McpAuthorizeOptions,
  McpRequest,
  McpAuthorizeContext,
  McpAuthorizeOutcome,
  McpReceiptExtractor,
} from "./middleware.js"

export { verifyReceipt, consumeReceiptOnline, bindingMismatch } from "./core/verify.js"
export type { ReceiptBinding, VerifyReceiptOptions, ConsumeReceiptOptions } from "./core/verify.js"
export { KeySetSource, cacheSeconds } from "./core/keys.js"
export type { KeySetSourceOptions } from "./core/keys.js"

export { validateDeclaration, deriveAuthorization } from "./core/declaration.js"
export type { ToolAuthorization, DerivedAuthorization } from "./core/declaration.js"
export { contextHash, argumentsDigest, sha256Hex } from "./core/canonical.js"
export type {
  Decision,
  HeldDecision,
  AuthorizeOutcome,
  SettlementOutcome,
  VerifyOutcome,
  DecisionOutcomeName,
} from "./core/outcomes.js"
export { authorizeToolCall } from "./core/authorize.js"
export { waitForSettlement, DEFAULT_HOLD_SECONDS } from "./core/settle.js"
export type { WaitForSettlementOptions, EscalationSettlement } from "./core/settle.js"
export {
  INPUT_KEY,
  urlElicitation,
  urlErrorData,
  inputRequiredResult,
  pendingResult,
  iso8601Seconds,
} from "./core/builder.js"
export type { UrlElicitation, UrlElicitationParams, InputRequiredShape, PendingShape } from "./core/builder.js"
export { MemoryStore, resumptionKey, replayKey } from "./core/stores.js"
export type { Store, MemoryStoreOptions, ResumptionEntry, ResumptionState } from "./core/stores.js"
export {
  denyResult,
  unavailableResult,
  refusedResult,
  receiptExpiredResult,
  counteredResult,
  invalidRequestStateResult,
  heldPendingResult,
  decisionMeta,
  withDecisionMeta,
  DEFAULT_MESSAGE,
} from "./core/results.js"
export type { ToolResultShape } from "./core/results.js"
export { createGateCore, gateCall, remainingSeconds } from "./core/gate.js"
export type { GateCore, GateCoreOptions, GateStep, HeldPointer } from "./core/gate.js"
export type { DecisionEvent, OnDecision, DeliveryName } from "./core/hooks.js"

export {
  OverturoAuthorize,
  OapError,
  OapAuthorizationDenied,
  OapIntentDenied,
  OapTrajectoryDenied,
  OapSequenceDenied,
  isOapError,
} from "@overturo/sdk"
export type {
  JwksKey,
  OapDenialCategory,
  OapReasonCode,
  ReceiptClaims,
  OfflineVerifyResult,
} from "@overturo/sdk"
