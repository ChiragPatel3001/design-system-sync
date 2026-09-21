/**
 * Stage 6F — the dashboard's read-model types. Type-only (plus one tiny
 * pure helper with zero I/O): safe to import from BOTH the server-side
 * loader (dashboard-loader.ts, Node `fs`) and the browser-side UI
 * (src/dashboard/**), since `import type` and a pure function are erased/
 * tree-shaken from the browser bundle — no `node:fs` ever reaches the
 * client.
 *
 * These types describe a NORMALIZED VIEW of data the existing engines
 * already produce (reconcile-compare.ts's ReconciliationRecord,
 * agent-policy.ts's PolicyDecision, agent-targeting.ts's EditTarget,
 * agent-run.ts's AgentAuditRecord) — nothing here invents a new status,
 * verdict, or outcome. See dashboard-loader.ts for how each field is
 * populated; it must always be a direct pass-through or a pure
 * reshaping, never a re-derived classification.
 */
import type { ReconciliationEntityType, ReconciliationStatus } from './reconcile-types.ts';
import type { PolicyVerdict } from './agent-policy-types.ts';
import type { EditTarget } from './agent-targeting-types.ts';
import type { AgentOutcome, AgentAuditRecord, ValidationStepResult } from './agent-run.ts';

/** A ReconciliationRecord + the PolicyDecision agent-policy.ts already computed for it — never a frontend-side re-derivation of SAFE/REVIEW/BLOCKED. */
export interface DashboardFinding {
  reconciliationId: string;
  entityType: ReconciliationEntityType;
  entityId: string;
  registryId: string | null;
  field: string;
  status: ReconciliationStatus;
  detail: string;
  figma: { current: unknown; baseline: unknown } | null;
  code: { current: unknown; baseline: unknown } | null;
  affectedComponents: string[];
  policyVerdict: PolicyVerdict;
  policyReason: string;
  requiredEvidence: string[];
  requiresHumanApproval: boolean;
  /** Only ever non-null when policyVerdict is SAFE AND agent-targeting.ts's own (stricter) resolveEditTarget() independently agrees — see dashboard-loader.ts. Never constructed by the dashboard itself. */
  editTarget: EditTarget | null;
  /** Whether a PRIOR agent run already failed against this exact reconciliationId (agent-run.ts's own loop-prevention signal, surfaced read-only — see hasPriorFailedAttempt). */
  hasPriorFailedAttempt: boolean;
}

/** A thin, mostly pass-through projection of AgentAuditRecord — adds only display-friendly derived strings, never a new outcome. */
export interface DashboardAgentRun {
  auditId: string;
  generatedAt: string;
  reconciliationId: string;
  reconciliationRunId: string;
  entityId: string;
  entityType: ReconciliationEntityType;
  field: string;
  outcome: AgentOutcome;
  policyVerdict: PolicyVerdict;
  filesModified: string[];
  change: { before: string; after: string } | null;
  validation: ValidationStepResult[];
  validationSummary: string; // e.g. "6/6 passed" or "1/6 passed"
  findingAfter: AgentAuditRecord['findingAfter'];
  stopReason: string;
  /** The full underlying record — the timeline view (Part 7) reads directly from this rather than a second copy of the same facts. */
  record: AgentAuditRecord;
}

export type SystemStatusTone = 'healthy' | 'warning' | 'critical' | 'unknown';

export interface DashboardSystemStatus {
  tone: SystemStatusTone;
  label: string;
}

export interface DashboardMetrics {
  /** SAFE + REVIEW + BLOCKED — deliberately excludes NOT_APPLICABLE verdicts (out-of-scope-entity, intentional-documented-deviation, already-converged both-changed-compatible), per agent-policy.ts's own classification — never a hand-picked status list in the dashboard. */
  findings: number;
  safe: number;
  review: number;
  blocked: number;
}

export interface DashboardViewModel {
  generatedAt: string;
  reconciliation: {
    available: boolean;
    runId: string | null;
    generatedAt: string | null;
    warnings: { code: string; message: string }[];
  };
  systemStatus: DashboardSystemStatus;
  metrics: DashboardMetrics;
  /** Actionable findings only (policyVerdict !== 'NOT_APPLICABLE'), sorted SAFE, then REVIEW, then BLOCKED, then by entityId. */
  findings: DashboardFinding[];
  /** Most recent first, capped (see dashboard-loader.ts). */
  agentRuns: DashboardAgentRun[];
}

export function summarizeValidation(validation: ValidationStepResult[]): string {
  if (validation.length === 0) return 'No validation ran';
  const passed = validation.filter((v) => v.passed).length;
  return `${passed}/${validation.length} passed`;
}
