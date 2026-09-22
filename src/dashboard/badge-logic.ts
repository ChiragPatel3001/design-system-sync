/**
 * Pure badge-classification logic, split out of StatusBadge.tsx (which
 * has JSX and therefore can't be imported by a plain `node --test` run —
 * see StatusBadge.test.ts) — mirrors this directory's existing split
 * between pure `.ts` logic (format.ts, timeline.ts) and `.tsx` components.
 * StatusBadge.tsx re-exports everything here so every existing import
 * site is unaffected.
 */
import type { PolicyVerdict } from '../../design-system/sync/scripts/agent-policy-types.ts';
import type { AgentOutcome } from '../../design-system/sync/scripts/agent-run.ts';
import type { ReconciliationStatus } from '../../design-system/sync/scripts/reconcile-types.ts';

export type BadgeTone = 'safe' | 'warning' | 'critical' | 'neutral';

export interface BadgeSpec {
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

/**
 * Display-layer split of the BLOCKED verdict into two honest categories —
 * this NEVER changes `status` or `policyVerdict` themselves (both stay
 * exactly what agent-policy.ts/reconcile-compare.ts computed), it only
 * picks a different badge for one already-BLOCKED status:
 *
 *  - `unmapped-figma-entity` is a registry COVERAGE GAP (either Figma has
 *    a real entity the registry never mapped, or the registry expects a
 *    Figma name that's absent from the current capture) — not a genuinely
 *    ambiguous/unsafe finding, so it gets a neutral "UNMAPPED" badge
 *    instead of the red BLOCKED/✕ one.
 *  - Every other BLOCKED status (`both-changed-conflict`,
 *    `registry-expectation-mismatch` — the only two others agent-policy.ts
 *    ever assigns BLOCKED to) keeps the existing red BLOCKED/✕ badge via
 *    policyVerdictBadge, unchanged.
 */
export function findingBadge(finding: { policyVerdict: PolicyVerdict; status: ReconciliationStatus }): BadgeSpec {
  if (finding.policyVerdict === 'BLOCKED' && finding.status === 'unmapped-figma-entity') {
    return { tone: 'neutral', symbol: '?', label: 'UNMAPPED' };
  }
  return policyVerdictBadge(finding.policyVerdict);
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
    case 'applied-verification-incomplete':
      // Deliberately distinct from both 'Applied' (safe/green — would
      // overclaim verification that never completed) and a failed
      // outcome (critical/red — would wrongly suggest the edit was
      // rejected or reverted, which it wasn't). Warning tone signals "a
      // human should look at this and manually confirm/re-run Reconcile
      // once the underlying issue clears" — see agent-run.ts's own
      // comment on this outcome.
      return { tone: 'warning', symbol: '!', label: 'Applied — needs verification' };
  }
}
