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
  /**
   * Non-null when policyVerdict is SAFE, OR when this is a token-level
   * `both-changed-conflict` finding (Part 18 — the only status eligible
   * for human-directed resolution), AND agent-targeting.ts's own
   * (stricter) resolveEditTarget() independently agrees — see
   * dashboard-loader.ts. Never constructed by the dashboard itself; this
   * is the SAME shape check the "Resolve" UI action gates on client-side
   * AND the same one runAgentForFinding re-derives server-side.
   */
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
  /** Whether this run was an explicit human re-authorization of a finding loop prevention had refused — see agent-run.ts's RunAgentForFindingOptions. */
  humanReauthorized: boolean;
  /** Whether this run was an explicit human-directed resolution of a both-changed-conflict finding (Part 18) — see agent-run.ts's RunAgentForFindingOptions.humanDirectedSourceOfTruth. */
  humanDirected: boolean;
  /** The human's chosen direction for a humanDirected run — null otherwise. */
  sourceOfTruth: 'figma' | 'code' | null;
  /** The full underlying record — the timeline view (Part 7) reads directly from this rather than a second copy of the same facts. */
  record: AgentAuditRecord;
}

export type SystemStatusTone = 'healthy' | 'warning' | 'critical' | 'unknown';

export interface DashboardSystemStatus {
  tone: SystemStatusTone;
  label: string;
}

export interface DashboardMetrics {
  /** SAFE + REVIEW + BLOCKED + UNMAPPED — deliberately excludes NOT_APPLICABLE verdicts (out-of-scope-entity, intentional-documented-deviation, already-converged both-changed-compatible), per agent-policy.ts's own classification — never a hand-picked status list in the dashboard. */
  findings: number;
  safe: number;
  review: number;
  /**
   * Display-layer split of policyVerdict === 'BLOCKED' — never a
   * re-derived verdict, purely a count bucketed by the finding's
   * EXISTING `status` field (see dashboard-loader.ts's computeMetrics):
   * genuinely ambiguous findings only (`both-changed-conflict`,
   * `registry-expectation-mismatch`). `unmapped-figma-entity` findings
   * (a coverage gap, not a safety block) are counted in `unmapped`
   * instead — see that field.
   */
  blocked: number;
  /** BLOCKED-verdict findings whose status is `unmapped-figma-entity` — a registry coverage gap, not an ambiguous/unsafe finding. Split out of `blocked` for display only; policyVerdict itself is untouched. */
  unmapped: number;
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
  /** The registry's own absolute path (registry.json), for the "Add to registry"/"Fix mapping" UI actions on an unmapped-figma-entity finding — never read or written by the dashboard itself, purely a display convenience so a human can open it in their editor. */
  registryPath: string;
}

export function summarizeValidation(validation: ValidationStepResult[]): string {
  if (validation.length === 0) return 'No validation ran';
  const passed = validation.filter((v) => v.passed).length;
  return `${passed}/${validation.length} passed`;
}
