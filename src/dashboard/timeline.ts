/**
 * Stage 6F — derives the Agent Run Detail timeline (Part 7) from an
 * ACTUAL AgentAuditRecord. No step is invented: every step's state is
 * read off fields agent-run.ts's `runAgentForFinding` already sets
 * (`policyDecision.verdict`, `editTarget`, `outcome`, `stopReason`'s
 * literal, stable prefixes — these are fixed strings in agent-run.ts's
 * own source, not free text this file is guessing at). Pure, no I/O —
 * safe to import from the browser bundle and to unit-test directly.
 */
import type { AgentAuditRecord } from '../../design-system/sync/scripts/agent-run.ts';

export type TimelineStepState = 'done' | 'failed' | 'skipped';

export interface TimelineStep {
  label: string;
  state: TimelineStepState;
}

const PRIOR_FAILURE_PREFIX = 'A previous automatic attempt';
const REASONER_FAILED_PREFIX = 'Reasoner did not produce a proposal';
const PROPOSAL_REJECTED_PREFIX = 'Reasoner proposal rejected by the deterministic validator';
const APPLY_FAILED_PREFIX = 'Edit could not be safely applied';
const VALIDATION_FAILED_PREFIX = 'Validation level';
const VERIFICATION_FAILED_PREFIX = 'Re-reconciliation did not confirm';

export function deriveTimeline(record: AgentAuditRecord): TimelineStep[] {
  const step = (label: string, state: TimelineStepState): TimelineStep => ({ label, state });

  const steps: TimelineStep[] = [step('Finding detected', 'done')];

  if (record.stopReason.startsWith(PRIOR_FAILURE_PREFIX)) {
    steps.push(step('Policy classified — refused (prior failed attempt)', 'failed'));
    return steps;
  }

  steps.push(step(`Policy classified ${record.policyDecision.verdict}`, 'done'));

  if (record.policyDecision.verdict !== 'SAFE') {
    steps.push(step('Target resolved', 'skipped'));
    return steps;
  }

  if (!record.editTarget) {
    steps.push(step('Target resolved', 'failed'));
    return steps;
  }
  steps.push(step('Target resolved', 'done'));

  if (record.stopReason.startsWith(REASONER_FAILED_PREFIX)) {
    steps.push(step('Claude proposed edit', 'failed'));
    return steps;
  }
  steps.push(step('Claude proposed edit', 'done'));

  if (record.stopReason.startsWith(PROPOSAL_REJECTED_PREFIX) || record.stopReason.startsWith(APPLY_FAILED_PREFIX)) {
    steps.push(step('Edit applied', 'failed'));
    return steps;
  }
  steps.push(step('Edit applied', 'done'));

  if (record.stopReason.startsWith(VALIDATION_FAILED_PREFIX)) {
    steps.push(step('Validation passed', 'failed'));
    steps.push(step('Edit reverted', 'done'));
    return steps;
  }
  steps.push(step('Validation passed', 'done'));
  steps.push(step('Code snapshot refreshed', 'done'));
  steps.push(step('Reconciliation completed', 'done'));

  if (record.stopReason.startsWith(VERIFICATION_FAILED_PREFIX)) {
    steps.push(step('Finding verified', 'failed'));
    steps.push(step('Edit reverted', 'done'));
    return steps;
  }
  steps.push(step('Finding verified', 'done'));
  steps.push(step('Audit recorded', 'done'));
  return steps;
}
