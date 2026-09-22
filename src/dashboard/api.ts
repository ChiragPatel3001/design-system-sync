/**
 * The dashboard frontend's ONLY connection to the real repository data —
 * `fetch` calls against the local dev-server API
 * (design-system/sync/scripts/dashboard-server-plugin.ts). No reconciliation,
 * policy, or targeting logic lives here or anywhere else in `src/dashboard/`;
 * this file only shapes HTTP I/O.
 */
import type { DashboardViewModel } from '../../design-system/sync/scripts/dashboard-types.ts';
import type { AgentAuditRecord } from '../../design-system/sync/scripts/agent-run.ts';
import type { ReconcileRunSummary } from '../../design-system/sync/scripts/dashboard-reconcile-handler.ts';

export class DashboardApiError extends Error {}

export async function fetchDashboard(): Promise<DashboardViewModel> {
  const response = await fetch('/api/dashboard');
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new DashboardApiError(body.error ?? `Failed to load dashboard data (${response.status}).`);
  }
  return (await response.json()) as DashboardViewModel;
}

/**
 * Runs the real agent pipeline for exactly one finding. The dashboard
 * never sends anything beyond `reconciliationId`, `reauthorize`, and
 * `sourceOfTruth` — see dashboard-agent-handler.ts, which would ignore
 * extra fields anyway.
 *
 * `reauthorize` must only ever be set from an explicit "Re-authorize &
 * Run" click (see FindingDrawer.tsx) — it carries no weight on its own;
 * the server independently re-derives the real policy verdict regardless
 * of what this flag says (see dashboard-agent-handler.ts).
 *
 * `sourceOfTruth` must only ever be set from an explicit "Resolve toward
 * Figma"/"Resolve toward Code" click on a both-changed-conflict finding
 * (Part 18) — same discipline: the server independently, structurally
 * re-validates that the target is actually eligible (token-level
 * both-changed-conflict) before acting on it.
 */
export async function runAgent(reconciliationId: string, options: { reauthorize?: boolean; sourceOfTruth?: 'figma' | 'code' } = {}): Promise<AgentAuditRecord> {
  const response = await fetch('/api/agent/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reconciliationId, reauthorize: options.reauthorize ?? false, ...(options.sourceOfTruth ? { sourceOfTruth: options.sourceOfTruth } : {}) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new DashboardApiError(body.error ?? `Agent run failed (${response.status}).`);
  }
  return body as AgentAuditRecord;
}

/**
 * Runs the real code-refresh + Figma-refresh + reconciliation pipeline
 * (the dashboard equivalent of `npm run sync:code-check && npm run
 * sync:reconcile`). Takes no parameters — there is nothing for the
 * browser to control here (see dashboard-reconcile-handler.ts).
 */
export async function runReconcile(): Promise<ReconcileRunSummary> {
  const response = await fetch('/api/reconcile', { method: 'POST' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new DashboardApiError(body.error ?? `Reconciliation failed (${response.status}).`);
  }
  return body as ReconcileRunSummary;
}
