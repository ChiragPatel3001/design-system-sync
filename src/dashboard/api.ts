/**
 * The dashboard frontend's ONLY connection to the real repository data —
 * two `fetch` calls against the local dev-server API
 * (design-system/sync/scripts/dashboard-server-plugin.ts). No reconciliation,
 * policy, or targeting logic lives here or anywhere else in `src/dashboard/`;
 * this file only shapes HTTP I/O.
 */
import type { DashboardViewModel } from '../../design-system/sync/scripts/dashboard-types.ts';
import type { AgentAuditRecord } from '../../design-system/sync/scripts/agent-run.ts';

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
 * never sends anything beyond `reconciliationId` — see
 * dashboard-agent-handler.ts, which would ignore extra fields anyway.
 */
export async function runAgent(reconciliationId: string): Promise<AgentAuditRecord> {
  const response = await fetch('/api/agent/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reconciliationId }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new DashboardApiError(body.error ?? `Agent run failed (${response.status}).`);
  }
  return body as AgentAuditRecord;
}
