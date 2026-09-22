import type { BadgeSpec } from './badge-logic.ts';

export type { BadgeTone, BadgeSpec } from './badge-logic.ts';
export { policyVerdictBadge, findingBadge, outcomeBadge } from './badge-logic.ts';

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
