import type { DashboardAgentRun } from '../../design-system/sync/scripts/dashboard-types.ts';
import { StatusBadge, outcomeBadge } from './StatusBadge.tsx';
import { deriveTimeline } from './timeline.ts';

export function AgentRunDrawer({ run, onClose }: { run: DashboardAgentRun; onClose: () => void }) {
  const timeline = deriveTimeline(run.record);

  return (
    <div className="ds-dash-drawer-backdrop" onClick={onClose}>
      <aside className="ds-dash-drawer" onClick={(e) => e.stopPropagation()} aria-label="Agent run detail">
        <div className="ds-dash-drawer__header">
          <div>
            <div className="ds-dash-drawer__eyebrow">{run.entityId}</div>
            <h2 className="ds-dash-drawer__title">Agent run {run.auditId.slice(0, 8)}</h2>
          </div>
          <button className="ds-dash-drawer__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <section className="ds-dash-drawer__section">
          <StatusBadge {...outcomeBadge(run.outcome)} />
          {run.humanReauthorized && <span className="ds-dash-reauthorized-badge">Human re-authorized</span>}
          {run.humanDirected && <span className="ds-dash-reauthorized-badge">Human-directed: {run.sourceOfTruth}</span>}
          <p className="ds-dash-detail-text">{run.stopReason}</p>
        </section>

        {run.change && (
          <section className="ds-dash-drawer__section">
            <h3>Change</h3>
            <div className="ds-dash-evidence__row">
              <code>{run.change.before}</code> → <code>{run.change.after}</code>
            </div>
            {run.filesModified.map((f) => (
              <p key={f} className="ds-dash-detail-text">
                <code>{f}</code>
              </p>
            ))}
          </section>
        )}

        <section className="ds-dash-drawer__section">
          <h3>Timeline</h3>
          <ol className="ds-dash-timeline">
            {timeline.map((step, i) => (
              <li key={i} className={`ds-dash-timeline__step ds-dash-timeline__step--${step.state}`}>
                <span className="ds-dash-timeline__marker" aria-hidden="true">
                  {step.state === 'done' ? '✓' : step.state === 'failed' ? '✕' : '·'}
                </span>
                <span className="ds-dash-timeline__label">{step.label}</span>
              </li>
            ))}
          </ol>
        </section>

        {run.validation.length > 0 && (
          <section className="ds-dash-drawer__section">
            <h3>Validation ({run.validationSummary})</h3>
            <ul className="ds-dash-validation-list">
              {run.validation.map((v) => (
                <li key={v.level} className={v.passed ? 'ds-dash-validation-list__item--pass' : 'ds-dash-validation-list__item--fail'}>
                  <span aria-hidden="true">{v.passed ? '✓' : '✕'}</span> Level {v.level}: {v.command}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="ds-dash-drawer__section">
          <h3>Identity</h3>
          <dl className="ds-dash-kv">
            <dt>Audit ID</dt>
            <dd>{run.auditId}</dd>
            <dt>Reconciliation run (before)</dt>
            <dd>{run.reconciliationRunId}</dd>
            <dt>Reconciliation run (after)</dt>
            <dd>{run.record.reconciliationAfterRunId ?? '—'}</dd>
            <dt>Finding after</dt>
            <dd>{run.findingAfter}</dd>
            <dt>When</dt>
            <dd>{new Date(run.generatedAt).toLocaleString()}</dd>
          </dl>
        </section>
      </aside>
    </div>
  );
}
