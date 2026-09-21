import type { PolicyVerdict } from '../../design-system/sync/scripts/agent-policy-types.ts';
import type { AgentOutcome } from '../../design-system/sync/scripts/agent-run.ts';

export type BadgeTone = 'safe' | 'warning' | 'critical' | 'neutral';

interface BadgeSpec {
  tone: BadgeTone;
  symbol: string;
  label: string;
}

/**
 * SAFE/REVIEW/BLOCKED/NOT_APPLICABLE come from agent-policy.ts unchanged
 * — this only maps each already-decided verdict to a tone/symbol/label
 * for display. It never decides a verdict.
 */
export function policyVerdictBadge(verdict: PolicyVerdict): BadgeSpec {
  switch (verdict) {
    case 'SAFE':
      return { tone: 'safe', symbol: '✓', label: 'SAFE' };
    case 'REVIEW':
      return { tone: 'warning', symbol: '!', label: 'REVIEW' };
    case 'BLOCKED':
      return { tone: 'critical', symbol: '✕', label: 'BLOCKED' };
    case 'NOT_APPLICABLE':
      return { tone: 'neutral', symbol: '–', label: 'N/A' };
  }
}

/** The actual AgentOutcome values from agent-run.ts — never an invented one. */
export function outcomeBadge(outcome: AgentOutcome): BadgeSpec {
  switch (outcome) {
    case 'applied':
      return { tone: 'safe', symbol: '✓', label: 'Applied' };
    case 'no-safe-action':
      return { tone: 'neutral', symbol: '–', label: 'No safe action' };
    case 'blocked':
      return { tone: 'critical', symbol: '✕', label: 'Blocked' };
    case 'failed-validation':
      return { tone: 'critical', symbol: '!', label: 'Failed validation' };
    case 'failed-verification':
      return { tone: 'critical', symbol: '!', label: 'Failed verification' };
  }
}

export function StatusBadge({ tone, symbol, label }: BadgeSpec) {
  return (
    <span className={`ds-dash-badge ds-dash-badge--${tone}`}>
      <span className="ds-dash-badge__symbol" aria-hidden="true">
        {symbol}
      </span>
      {label}
    </span>
  );
}
