import type { DashboardFinding } from '../../design-system/sync/scripts/dashboard-types.ts';
import { StatusBadge, policyVerdictBadge } from './StatusBadge.tsx';

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function FindingDrawer({
  finding,
  onClose,
  onRunAgent,
  isRunning,
}: {
  finding: DashboardFinding;
  onClose: () => void;
  onRunAgent: (reconciliationId: string) => void;
  isRunning: boolean;
}) {
  return (
    <div className="ds-dash-drawer-backdrop" onClick={onClose}>
      <aside className="ds-dash-drawer" onClick={(e) => e.stopPropagation()} aria-label="Finding detail">
        <div className="ds-dash-drawer__header">
          <div>
            <div className="ds-dash-drawer__eyebrow">{finding.entityType}</div>
            <h2 className="ds-dash-drawer__title">{finding.entityId}</h2>
          </div>
          <button className="ds-dash-drawer__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <section className="ds-dash-drawer__section">
          <h3>Identity</h3>
          <dl className="ds-dash-kv">
            <dt>Entity</dt>
            <dd>{finding.entityId}</dd>
            <dt>Entity type</dt>
            <dd>{finding.entityType}</dd>
            <dt>Field</dt>
            <dd>{finding.field}</dd>
            <dt>Registry ID</dt>
            <dd>{finding.registryId ?? '—'}</dd>
          </dl>
        </section>

        <section className="ds-dash-drawer__section">
          <h3>Reconciliation evidence</h3>
          <div className="ds-dash-evidence">
            <div className="ds-dash-evidence__row">
              <span className="ds-dash-evidence__label">Figma</span>
              <span className="ds-dash-evidence__value">
                {finding.figma ? (
                  <>
                    <code>{formatValue(finding.figma.baseline)}</code> → <code>{formatValue(finding.figma.current)}</code>
                  </>
                ) : (
                  '—'
                )}
              </span>
            </div>
            <div className="ds-dash-evidence__row">
              <span className="ds-dash-evidence__label">Code</span>
              <span className="ds-dash-evidence__value">
                {finding.code ? (
                  <>
                    <code>{formatValue(finding.code.baseline)}</code> → <code>{formatValue(finding.code.current)}</code>
                  </>
                ) : (
                  '—'
                )}
              </span>
            </div>
          </div>
          <p className="ds-dash-status-line">
            Reconciliation status: <code>{finding.status}</code>
          </p>
          <p className="ds-dash-detail-text">{finding.detail}</p>
        </section>

        <section className="ds-dash-drawer__section">
          <h3>Policy</h3>
          <StatusBadge {...policyVerdictBadge(finding.policyVerdict)} />
          <p className="ds-dash-detail-text">{finding.policyReason}</p>
          {finding.requiredEvidence.length > 0 && (
            <details className="ds-dash-evidence-toggle">
              <summary>Evidence ({finding.requiredEvidence.length})</summary>
              <ul>
                {finding.requiredEvidence.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </details>
          )}
          {finding.hasPriorFailedAttempt && (
            <p className="ds-dash-warning-line">A previous automatic attempt at this finding already failed — automatic retry is refused.</p>
          )}
        </section>

        {finding.editTarget && (
          <section className="ds-dash-drawer__section">
            <h3>Target</h3>
            <div className="ds-dash-target">
              <code>{finding.editTarget.filePath}</code>
              <code>{finding.editTarget.declarationIdentifier}</code>
              <code>{finding.editTarget.currentValue}</code>
            </div>
          </section>
        )}

        {finding.affectedComponents.length > 0 && (
          <section className="ds-dash-drawer__section">
            <h3>Affected components</h3>
            <p className="ds-dash-detail-text">{finding.affectedComponents.join(', ')}</p>
          </section>
        )}

        <div className="ds-dash-drawer__footer">
          {finding.policyVerdict === 'SAFE' ? (
            <button className="ds-dash-button ds-dash-button--primary" disabled={isRunning || finding.hasPriorFailedAttempt} onClick={() => onRunAgent(finding.reconciliationId)}>
              {isRunning ? 'Running agent…' : 'Run agent'}
            </button>
          ) : (
            <p className="ds-dash-detail-text">
              {finding.policyVerdict === 'REVIEW' || finding.policyVerdict === 'BLOCKED'
                ? 'This finding requires human review — the agent will not act on it automatically.'
                : 'No action available for this finding.'}
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}
