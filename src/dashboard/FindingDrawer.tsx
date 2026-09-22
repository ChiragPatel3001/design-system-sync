import type { DashboardFinding } from '../../design-system/sync/scripts/dashboard-types.ts';
import { StatusBadge, findingBadge } from './StatusBadge.tsx';

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** unmapped-figma-entity is the only BLOCKED status this drawer treats differently — see StatusBadge.tsx's findingBadge for the same split. */
function isUnmappedFigmaFinding(finding: DashboardFinding): boolean {
  return finding.policyVerdict === 'BLOCKED' && finding.status === 'unmapped-figma-entity';
}

/**
 * Distinguishes the two unmapped-figma-entity cases by inspecting the
 * finding's EXISTING figma observation — no new status code, purely a
 * branch on already-present data (mirrors the '—' formatValue() already
 * shows for a null/undefined current value elsewhere in this drawer):
 *  - figma.current present -> Figma has a real entity; the registry has
 *    no mapping for it yet ("Add to registry").
 *  - figma.current null/absent -> the registry expects a Figma name that
 *    wasn't found in the current capture ("Fix mapping").
 */
function figmaDataPresent(finding: DashboardFinding): boolean {
  return finding.figma !== null && finding.figma.current !== null && finding.figma.current !== undefined;
}

/** vscode://file/ opens the given absolute path directly in VS Code (when its URI handler is registered) — a display convenience only, never a write/mutation. */
function vscodeFileLink(absolutePath: string): string {
  return `vscode://file/${encodeURI(absolutePath.split('\\').join('/'))}`;
}

/**
 * Part 18 — the ONLY findings eligible for human-directed resolution:
 * `editTarget` is non-null ONLY for a SAFE finding or a token-level
 * both-changed-conflict (see dashboard-loader.ts's loadFindings), so
 * checking `status` here is enough to exclude SAFE — this can never be
 * true for a registry-expectation-mismatch or a component-level finding
 * like "button" (they carry no editTarget at all).
 */
function isHumanDirectableConflict(finding: DashboardFinding): boolean {
  return finding.status === 'both-changed-conflict' && finding.editTarget !== null;
}

export function FindingDrawer({
  finding,
  registryPath,
  onClose,
  onRunAgent,
  isRunning,
}: {
  finding: DashboardFinding;
  registryPath: string;
  onClose: () => void;
  onRunAgent: (reconciliationId: string, options?: { reauthorize?: boolean; sourceOfTruth?: 'figma' | 'code' }) => void;
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
          <StatusBadge {...findingBadge(finding)} />
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
            <p className="ds-dash-warning-line">
              A previous automatic attempt at this finding already failed — automatic retry is refused.
              {(finding.policyVerdict === 'SAFE' || isHumanDirectableConflict(finding)) && ' A human can explicitly re-authorize one new attempt below.'}
            </p>
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
          {finding.policyVerdict === 'SAFE' && !finding.hasPriorFailedAttempt && (
            <button className="ds-dash-button ds-dash-button--primary" disabled={isRunning} onClick={() => onRunAgent(finding.reconciliationId)}>
              {isRunning ? 'Running agent…' : 'Run agent'}
            </button>
          )}
          {finding.policyVerdict === 'SAFE' && finding.hasPriorFailedAttempt && (
            <button
              className="ds-dash-button ds-dash-button--primary"
              disabled={isRunning}
              onClick={() => onRunAgent(finding.reconciliationId, { reauthorize: true })}
            >
              {isRunning ? 'Re-authorizing…' : 'Re-authorize & Run'}
            </button>
          )}
          {isUnmappedFigmaFinding(finding) && (
            <div className="ds-dash-unmapped-action">
              <p className="ds-dash-detail-text">
                {figmaDataPresent(finding)
                  ? 'Figma has this token/variable; it has no registry mapping yet.'
                  : "Registry expects this Figma variable; it wasn't found in the current capture — it may have been renamed or removed."}
              </p>
              <a className="ds-dash-button ds-dash-button--secondary" href={vscodeFileLink(registryPath)}>
                {figmaDataPresent(finding) ? 'Add to registry' : 'Fix mapping'}
              </a>
            </div>
          )}
          {isHumanDirectableConflict(finding) && (
            <div className="ds-dash-resolve-action">
              <p className="ds-dash-detail-text">
                Figma and code both changed and disagree. Pick which side is correct — the other will be treated as the mistake to fix.
              </p>
              <div className="ds-dash-resolve-action__buttons">
                <button
                  className="ds-dash-button ds-dash-button--primary"
                  disabled={isRunning}
                  onClick={() => onRunAgent(finding.reconciliationId, { sourceOfTruth: 'figma', reauthorize: finding.hasPriorFailedAttempt })}
                >
                  {isRunning ? 'Resolving…' : 'Resolve toward Figma'}
                </button>
                <button
                  className="ds-dash-button ds-dash-button--secondary"
                  disabled={isRunning}
                  onClick={() => onRunAgent(finding.reconciliationId, { sourceOfTruth: 'code', reauthorize: finding.hasPriorFailedAttempt })}
                >
                  {isRunning ? 'Resolving…' : 'Resolve toward Code'}
                </button>
              </div>
            </div>
          )}
          {finding.policyVerdict !== 'SAFE' && !isUnmappedFigmaFinding(finding) && !isHumanDirectableConflict(finding) && (
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
