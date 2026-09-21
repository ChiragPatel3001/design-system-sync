import { useCallback, useEffect, useState } from 'react';
import type { DashboardFinding, DashboardAgentRun, DashboardViewModel, SystemStatusTone } from '../../design-system/sync/scripts/dashboard-types.ts';
import { fetchDashboard, runAgent, DashboardApiError } from './api.ts';
import { StatusBadge, policyVerdictBadge, outcomeBadge } from './StatusBadge.tsx';
import { FindingDrawer } from './FindingDrawer.tsx';
import { AgentRunDrawer } from './AgentRunDrawer.tsx';
import { formatRelativeTime } from './format.ts';

function statusDotClass(tone: SystemStatusTone): string {
  return `ds-dash-status-dot ds-dash-status-dot--${tone}`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function Dashboard() {
  const [viewModel, setViewModel] = useState<DashboardViewModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedFinding, setSelectedFinding] = useState<DashboardFinding | null>(null);
  const [selectedRun, setSelectedRun] = useState<DashboardAgentRun | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<DashboardViewModel | null> => {
    try {
      const vm = await fetchDashboard();
      setViewModel(vm);
      setLoadError(null);
      return vm;
    } catch (err) {
      setLoadError(err instanceof DashboardApiError ? err.message : `Failed to load dashboard data: ${err}`);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRunAgent = useCallback(
    async (reconciliationId: string) => {
      setRunningId(reconciliationId);
      setRunError(null);
      try {
        const audit = await runAgent(reconciliationId);
        setSelectedFinding(null);
        const freshViewModel = await load();
        // Stage 6H: surface the just-completed run's outcome immediately —
        // without this, a successful (or failed) run left the drawer
        // closed with no visible confirmation beyond the Agent Activity
        // list, which a user could easily miss. The audit record itself
        // (not a fabricated summary) drives what's shown.
        const justCompletedRun = freshViewModel?.agentRuns.find((r) => r.auditId === audit.auditId) ?? null;
        setSelectedRun(justCompletedRun);
      } catch (err) {
        setRunError(err instanceof DashboardApiError ? err.message : `Agent run failed: ${err}`);
      } finally {
        setRunningId(null);
      }
    },
    [load],
  );

  if (loading) {
    return (
      <div className="ds-dash-page ds-dash-page--center">
        <p className="ds-dash-loading">Loading dashboard…</p>
      </div>
    );
  }

  if (loadError || !viewModel) {
    return (
      <div className="ds-dash-page ds-dash-page--center">
        <div className="ds-dash-empty-state">
          <h2>Could not load dashboard data</h2>
          <p>{loadError}</p>
        </div>
      </div>
    );
  }

  const { systemStatus, metrics, findings, agentRuns, reconciliation } = viewModel;
  const attentionFindings = findings.filter((f) => f.policyVerdict === 'REVIEW' || f.policyVerdict === 'BLOCKED');

  return (
    <div className="ds-dash-page">
      <header className="ds-dash-header">
        <div>
          <h1 className="ds-dash-title">Sync Agent</h1>
          <p className="ds-dash-subtitle">Design system synchronization and agent activity</p>
        </div>
        <div className="ds-dash-header__right">
          <div className="ds-dash-system-status">
            <span className={statusDotClass(systemStatus.tone)} aria-hidden="true" />
            {systemStatus.label}
          </div>
          {reconciliation.available ? (
            <p className="ds-dash-header__meta">
              Latest reconciliation: <code>{reconciliation.runId}</code> · {reconciliation.generatedAt ? formatRelativeTime(reconciliation.generatedAt) : '—'}
            </p>
          ) : (
            <p className="ds-dash-header__meta">No reconciliation run found — run `npm run sync:reconcile`.</p>
          )}
        </div>
      </header>

      {runError && (
        <div className="ds-dash-banner ds-dash-banner--critical" role="alert">
          {runError}
        </div>
      )}

      <section className="ds-dash-metrics" aria-label="Overview metrics">
        <div className="ds-dash-metric-card">
          <span className="ds-dash-metric-card__value">{metrics.findings}</span>
          <span className="ds-dash-metric-card__label">Reconciliation Findings</span>
        </div>
        <div className="ds-dash-metric-card">
          <span className="ds-dash-metric-card__value ds-dash-metric-card__value--safe">{metrics.safe}</span>
          <span className="ds-dash-metric-card__label">Safe to Apply</span>
        </div>
        <div className="ds-dash-metric-card">
          <span className="ds-dash-metric-card__value ds-dash-metric-card__value--warning">{metrics.review}</span>
          <span className="ds-dash-metric-card__label">Needs Review</span>
        </div>
        <div className="ds-dash-metric-card">
          <span className="ds-dash-metric-card__value ds-dash-metric-card__value--critical">{metrics.blocked}</span>
          <span className="ds-dash-metric-card__label">Blocked</span>
        </div>
      </section>

      <section className="ds-dash-section" aria-label="Current findings">
        <h2 className="ds-dash-section__title">Current findings</h2>
        {findings.length === 0 ? (
          <div className="ds-dash-empty-state">
            <h3>Everything is synchronized</h3>
            <p>No SAFE actions are currently available.</p>
            <p>Your design system is currently awaiting either new changes or human review.</p>
          </div>
        ) : (
          <table className="ds-dash-table">
            <thead>
              <tr>
                <th>Token / Component</th>
                <th>Entity</th>
                <th>Field</th>
                <th>Status</th>
                <th>Figma</th>
                <th>Code</th>
                <th>Verdict</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {findings.map((finding) => (
                <tr key={finding.reconciliationId} className="ds-dash-table__row" onClick={() => setSelectedFinding(finding)}>
                  <td>{finding.entityId}</td>
                  <td>{finding.entityType}</td>
                  <td>{finding.field}</td>
                  <td>
                    <code>{finding.status}</code>
                  </td>
                  <td>{finding.figma ? formatValue(finding.figma.current) : '—'}</td>
                  <td>{finding.code ? formatValue(finding.code.current) : '—'}</td>
                  <td>
                    <StatusBadge {...policyVerdictBadge(finding.policyVerdict)} />
                  </td>
                  <td>
                    <button
                      className="ds-dash-link-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedFinding(finding);
                      }}
                    >
                      Review →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="ds-dash-columns">
        <section className="ds-dash-section" aria-label="Agent activity">
          <h2 className="ds-dash-section__title">Agent activity</h2>
          {agentRuns.length === 0 ? (
            <div className="ds-dash-empty-state ds-dash-empty-state--compact">
              <p>No agent runs yet</p>
            </div>
          ) : (
            <ul className="ds-dash-activity-list">
              {agentRuns.map((run) => (
                <li key={run.auditId} className="ds-dash-activity-item" onClick={() => setSelectedRun(run)}>
                  <StatusBadge {...outcomeBadge(run.outcome)} />
                  <div className="ds-dash-activity-item__body">
                    <span className="ds-dash-activity-item__title">{run.entityId}</span>
                    {run.change && (
                      <span className="ds-dash-activity-item__change">
                        <code>{run.change.before}</code> → <code>{run.change.after}</code>
                      </span>
                    )}
                    <span className="ds-dash-activity-item__meta">
                      {run.validationSummary} · {formatRelativeTime(run.generatedAt)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="ds-dash-section" aria-label="Requires attention">
          <h2 className="ds-dash-section__title">Requires attention</h2>
          {attentionFindings.length === 0 ? (
            <div className="ds-dash-empty-state ds-dash-empty-state--compact">
              <p>Nothing needs human review right now.</p>
            </div>
          ) : (
            <ul className="ds-dash-attention-list">
              {attentionFindings.map((finding) => (
                <li key={finding.reconciliationId} className="ds-dash-attention-item" onClick={() => setSelectedFinding(finding)}>
                  <StatusBadge {...policyVerdictBadge(finding.policyVerdict)} />
                  <div className="ds-dash-attention-item__body">
                    <span className="ds-dash-attention-item__title">{finding.entityId}</span>
                    <span className="ds-dash-attention-item__reason">{finding.policyReason}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {selectedFinding && (
        <FindingDrawer finding={selectedFinding} onClose={() => setSelectedFinding(null)} onRunAgent={handleRunAgent} isRunning={runningId === selectedFinding.reconciliationId} />
      )}
      {selectedRun && <AgentRunDrawer run={selectedRun} onClose={() => setSelectedRun(null)} />}
    </div>
  );
}
