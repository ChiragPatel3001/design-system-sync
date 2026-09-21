/**
 * Stage 6F — the dashboard's server-side read-model loader.
 *
 *   Existing JSON + existing deterministic engines
 *         |
 *   dashboard-loader.ts (this file)     <- THIS is the only new logic
 *         |
 *   DashboardViewModel (dashboard-types.ts)
 *         |
 *   UI (src/dashboard/**)
 *
 * This module does not reconcile, classify, or target anything itself —
 * every fact in the returned DashboardViewModel is either read verbatim
 * from an already-persisted JSON file, or computed by calling the
 * existing, unmodified engines (`classifyRecord` from agent-policy.ts,
 * `resolveEditTarget` from agent-targeting.ts, `hasPriorFailedAttempt`
 * from agent-run.ts). It never duplicates `if (status === ...)` policy
 * logic, never writes anything, and never imports/executes Stage 5's
 * comparison logic itself — only its already-persisted OUTPUT
 * (reconciliation/latest.json) plus the same input-loading helper
 * (`loadReconciliationInputs`) agent-run.ts itself already depends on.
 *
 * Runs in Node only (uses `node:fs`) — imported by the Vite dev-server
 * plugin (dashboard-server-plugin.ts) and by this file's own tests.
 * Never imported from `src/` (the browser bundle root).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { loadReconciliationInputs, type ReconcileInputPaths, type ReconciliationOutputPaths } from './reconcile.ts';
import type { ReconciliationRun } from './reconcile-types.ts';
import { classifyRecord } from './agent-policy.ts';
import { resolveEditTarget } from './agent-targeting.ts';
import { hasPriorFailedAttempt, type AgentAuditRecord } from './agent-run.ts';
import type { DashboardFinding, DashboardAgentRun, DashboardViewModel, DashboardMetrics, DashboardSystemStatus } from './dashboard-types.ts';
import { summarizeValidation } from './dashboard-types.ts';

/** How many most-recent agent runs the dashboard surfaces — a display cap, not a data limit (every run remains on disk regardless). */
const MAX_AGENT_RUNS = 25;

export interface DashboardLoaderPaths {
  reconciliationInputPaths: ReconcileInputPaths;
  reconciliationOutputPaths: ReconciliationOutputPaths;
  agentHistoryPaths: { recordsDir: string; latestPath: string };
}

function readReconciliationRunSafe(latestPath: string): ReconciliationRun | null {
  if (!existsSync(latestPath)) return null;
  try {
    return JSON.parse(readFileSync(latestPath, 'utf8')) as ReconciliationRun;
  } catch {
    return null; // malformed latest.json is treated the same as "unavailable" — never crash the dashboard on bad data
  }
}

function loadFindings(paths: DashboardLoaderPaths, run: ReconciliationRun): DashboardFinding[] {
  const input = loadReconciliationInputs(paths.reconciliationInputPaths);

  const findings: DashboardFinding[] = [];
  for (const record of run.records) {
    const policy = classifyRecord({ record, crosswalk: input.crosswalk, codeCurrent: input.codeCurrent });
    if (policy.verdict === 'NOT_APPLICABLE') continue; // out-of-scope-entity / intentional-documented-deviation / already-converged — not a "finding" a human or the agent needs to act on

    const editTarget = policy.verdict === 'SAFE' ? resolveEditTarget({ record, crosswalk: input.crosswalk, codeCurrent: input.codeCurrent }) : null;

    findings.push({
      reconciliationId: record.reconciliationId,
      entityType: record.entityType,
      entityId: record.entityId,
      registryId: record.registryId,
      field: record.field,
      status: record.status,
      detail: record.detail,
      figma: record.figma ? { current: record.figma.current, baseline: record.figma.baseline } : null,
      code: record.code ? { current: record.code.current, baseline: record.code.baseline } : null,
      affectedComponents: record.affectedComponents,
      policyVerdict: policy.verdict,
      policyReason: policy.reason,
      requiredEvidence: policy.requiredEvidence,
      requiresHumanApproval: policy.requiresHumanApproval,
      editTarget,
      hasPriorFailedAttempt: hasPriorFailedAttempt(paths.agentHistoryPaths.recordsDir, record.reconciliationId),
    });
  }

  const verdictOrder: Record<string, number> = { SAFE: 0, REVIEW: 1, BLOCKED: 2 };
  return findings.sort((a, b) => (verdictOrder[a.policyVerdict] ?? 3) - (verdictOrder[b.policyVerdict] ?? 3) || a.entityId.localeCompare(b.entityId));
}

function computeMetrics(findings: DashboardFinding[]): DashboardMetrics {
  const safe = findings.filter((f) => f.policyVerdict === 'SAFE').length;
  const review = findings.filter((f) => f.policyVerdict === 'REVIEW').length;
  const blocked = findings.filter((f) => f.policyVerdict === 'BLOCKED').length;
  return { findings: findings.length, safe, review, blocked };
}

function computeSystemStatus(reconciliationAvailable: boolean, metrics: DashboardMetrics): DashboardSystemStatus {
  if (!reconciliationAvailable) return { tone: 'unknown', label: 'No reconciliation data' };
  if (metrics.blocked > 0) return { tone: 'critical', label: `${metrics.blocked} blocked finding${metrics.blocked === 1 ? '' : 's'}` };
  if (metrics.review > 0) return { tone: 'warning', label: `${metrics.review} finding${metrics.review === 1 ? '' : 's'} need review` };
  return { tone: 'healthy', label: 'System healthy' };
}

function loadAgentRuns(recordsDir: string): DashboardAgentRun[] {
  if (!existsSync(recordsDir)) return [];

  const records: AgentAuditRecord[] = [];
  for (const fileName of readdirSync(recordsDir)) {
    if (!fileName.endsWith('.json')) continue;
    try {
      records.push(JSON.parse(readFileSync(path.join(recordsDir, fileName), 'utf8')) as AgentAuditRecord);
    } catch {
      continue; // a malformed/partial record is skipped, never crashes the dashboard
    }
  }

  records.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));

  return records.slice(0, MAX_AGENT_RUNS).map((record) => ({
    auditId: record.auditId,
    generatedAt: record.generatedAt,
    reconciliationId: record.reconciliationId,
    reconciliationRunId: record.reconciliationRunId,
    entityId: record.findingBefore.entityId,
    entityType: record.findingBefore.entityType,
    field: record.findingBefore.field,
    outcome: record.outcome,
    policyVerdict: record.policyDecision.verdict,
    filesModified: record.filesModified,
    change: record.change,
    validation: record.validation,
    validationSummary: summarizeValidation(record.validation),
    findingAfter: record.findingAfter,
    stopReason: record.stopReason,
    record,
  }));
}

/**
 * The single entry point the dashboard server (and its tests) call.
 * Never throws for "expected empty" states (no reconciliation run yet, no
 * agent history yet) — those become explicit, honest empty states in the
 * returned view model (Part 10's requirement), not a crash or a fabricated
 * finding.
 */
export function loadDashboardViewModel(paths: DashboardLoaderPaths): DashboardViewModel {
  const run = readReconciliationRunSafe(paths.reconciliationOutputPaths.latestPath);
  const findings = run ? loadFindings(paths, run) : [];
  const metrics = computeMetrics(findings);
  const systemStatus = computeSystemStatus(run !== null, metrics);
  const agentRuns = loadAgentRuns(paths.agentHistoryPaths.recordsDir);

  return {
    generatedAt: new Date().toISOString(),
    reconciliation: {
      available: run !== null,
      runId: run?.runId ?? null,
      generatedAt: run?.generatedAt ?? null,
      warnings: run?.warnings ?? [],
    },
    systemStatus,
    metrics,
    findings,
    agentRuns,
  };
}
