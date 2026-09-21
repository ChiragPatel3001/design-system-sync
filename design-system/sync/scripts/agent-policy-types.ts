/**
 * Types for the deterministic policy layer (Stage 6B). This layer answers
 * exactly one question per reconciliation finding: "what is Claude allowed
 * to do about this?" — never "is this actually safe" in some deeper sense
 * (that's still bounded further by agent-targeting.ts, the last and
 * strictest gate before any file is touched).
 *
 * This is a small, additive module sitting entirely ABOVE Stage 5 — it
 * imports Stage 5's own `ReconciliationStatus` rather than duplicating the
 * union (see agent-policy.ts), and nothing here changes what any
 * `ReconciliationRecord` means.
 */
import type { ReconciliationStatus } from './reconcile-types.ts';

export type PolicyVerdict = 'SAFE' | 'REVIEW' | 'BLOCKED' | 'NOT_APPLICABLE';

export interface PolicyDecision {
  /** Ties this decision back to the exact ReconciliationRecord it was computed from. */
  reconciliationId: string;
  status: ReconciliationStatus;
  verdict: PolicyVerdict;
  /** Deterministic, templated — restates which condition(s) produced this verdict, never a vague message. */
  reason: string;
  /** The specific facts that were checked (and, for SAFE, all passed) to reach this verdict — not a confidence score, see module header. */
  requiredEvidence: string[];
  /** Which validation levels (1-6, see agent-run.ts) an edit against this finding would require. Empty unless verdict is SAFE. */
  requiredValidationLevels: number[];
  requiresHumanApproval: boolean;
}
