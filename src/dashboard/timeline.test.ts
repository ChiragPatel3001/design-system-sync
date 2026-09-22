import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { deriveTimeline } from './timeline.ts';
import type { AgentAuditRecord } from '../../design-system/sync/scripts/agent-run.ts';
import type { ReconciliationRecord } from '../../design-system/sync/scripts/reconcile-types.ts';
import type { PolicyDecision } from '../../design-system/sync/scripts/agent-policy-types.ts';

const baseRecord: ReconciliationRecord = {
  reconciliationId: 'f1',
  entityType: 'token',
  entityId: 'widget-length',
  registryId: 'widget-length',
  field: 'value',
  status: 'figma-only-change',
  figma: { current: '24', baseline: '20', changed: true },
  code: { current: '20px', baseline: '20px', changed: false },
  registryExpected: null,
  affectedComponents: [],
  sources: { figmaBaselineId: 'a', figmaCurrentId: 'b', codeBaselineId: 'c', codeCurrentId: 'd' },
  detail: 'fixture',
};

function makeAudit(overrides: Partial<AgentAuditRecord> & { policyDecision: PolicyDecision }): AgentAuditRecord {
  return {
    auditId: 'audit1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    reconciliationRunId: 'run1',
    reconciliationId: 'f1',
    findingBefore: baseRecord,
    editTarget: null,
    filesInspected: [],
    filesModified: [],
    change: null,
    validation: [],
    reconciliationAfterRunId: null,
    findingAfter: 'unresolved',
    outcome: 'no-safe-action',
    stopReason: 'fixture',
    humanReauthorized: false,
    codeBaselinePromoted: false,
    figmaBaselinePromoted: false,
    humanDirected: false,
    sourceOfTruth: null,
    ...overrides,
  };
}

const editTarget = { filePath: 'src/tokens/typography.css', kind: 'css-custom-property-value' as const, declarationIdentifier: '--widget-length', currentValue: '20px' };

describe('deriveTimeline', () => {
  test('a full success shows every step as done', () => {
    const record = makeAudit({
      policyDecision: { reconciliationId: 'f1', status: 'figma-only-change', verdict: 'SAFE', reason: 'safe', requiredEvidence: [], requiredValidationLevels: [1, 2, 3, 4, 5, 6], requiresHumanApproval: false },
      editTarget,
      outcome: 'applied',
      findingAfter: 'resolved',
      change: { before: '20px', after: '24px' },
      filesModified: ['src/tokens/typography.css'],
      validation: [1, 2, 3, 4, 5, 6].map((level) => ({ level, command: `l${level}`, passed: true })),
      stopReason: 'Completed successfully: the targeted finding resolved, no new findings, no unrelated mutations.',
    });
    const timeline = deriveTimeline(record);
    assert.equal(timeline[timeline.length - 1].label, 'Audit recorded');
    assert.ok(timeline.every((s) => s.state === 'done'));
    assert.equal(timeline.length, 10);
  });

  test('a REVIEW/BLOCKED policy verdict stops immediately after "Policy classified" — target/reasoner steps are skipped, not faked', () => {
    const record = makeAudit({
      policyDecision: { reconciliationId: 'f1', status: 'code-only-change', verdict: 'REVIEW', reason: 'Code changed without a corresponding Figma change; intent cannot be inferred. No automatic edit.', requiredEvidence: [], requiredValidationLevels: [], requiresHumanApproval: true },
      outcome: 'no-safe-action',
      stopReason: 'Code changed without a corresponding Figma change; intent cannot be inferred. No automatic edit.',
    });
    const timeline = deriveTimeline(record);
    assert.deepEqual(
      timeline.map((s) => s.label),
      ['Finding detected', 'Policy classified REVIEW', 'Target resolved'],
    );
    assert.equal(timeline[timeline.length - 1].state, 'skipped');
  });

  test('a prior-failed-attempt refusal stops at the very first policy step', () => {
    const record = makeAudit({
      policyDecision: { reconciliationId: 'f1', status: 'figma-only-change', verdict: 'BLOCKED', reason: 'refused: a previous attempt at this exact finding already failed', requiredEvidence: [], requiredValidationLevels: [], requiresHumanApproval: true },
      outcome: 'no-safe-action',
      stopReason: 'A previous automatic attempt at this exact finding already failed. Automatic re-execution is refused; a human must re-authorize it explicitly (no override mechanism exists yet).',
    });
    const timeline = deriveTimeline(record);
    assert.equal(timeline.length, 2);
    assert.equal(timeline[1].state, 'failed');
  });

  test('a reasoner refusal stops at "Claude proposed edit" with target already resolved', () => {
    const record = makeAudit({
      policyDecision: { reconciliationId: 'f1', status: 'figma-only-change', verdict: 'SAFE', reason: 'safe', requiredEvidence: [], requiredValidationLevels: [1, 2, 3, 4, 5, 6], requiresHumanApproval: false },
      editTarget,
      outcome: 'no-safe-action',
      stopReason: 'Reasoner did not produce a proposal: Claude refused to propose an edit: not confident.',
    });
    const timeline = deriveTimeline(record);
    assert.deepEqual(
      timeline.map((s) => s.label),
      ['Finding detected', 'Policy classified SAFE', 'Target resolved', 'Claude proposed edit'],
    );
    assert.equal(timeline[timeline.length - 1].state, 'failed');
  });

  test('a validation failure shows the revert step, never a fabricated "verified"/"audit recorded" step', () => {
    const record = makeAudit({
      policyDecision: { reconciliationId: 'f1', status: 'figma-only-change', verdict: 'SAFE', reason: 'safe', requiredEvidence: [], requiredValidationLevels: [1, 2, 3, 4, 5, 6], requiresHumanApproval: false },
      editTarget,
      outcome: 'failed-validation',
      validation: [
        { level: 1, command: 'tsc', passed: true },
        { level: 2, command: 'test', passed: false },
      ],
      stopReason: 'Validation level 2 failed (npm run sync:code-test). The edit was reverted.',
    });
    const timeline = deriveTimeline(record);
    assert.deepEqual(
      timeline.map((s) => s.label),
      ['Finding detected', 'Policy classified SAFE', 'Target resolved', 'Claude proposed edit', 'Edit applied', 'Validation passed', 'Edit reverted'],
    );
    assert.equal(timeline.find((s) => s.label === 'Validation passed')!.state, 'failed');
    assert.equal(timeline[timeline.length - 1].label, 'Edit reverted');
  });

  test('a failed-verification run shows the revert step after reconciliation completed', () => {
    const record = makeAudit({
      policyDecision: { reconciliationId: 'f1', status: 'figma-only-change', verdict: 'SAFE', reason: 'safe', requiredEvidence: [], requiredValidationLevels: [1, 2, 3, 4, 5, 6], requiresHumanApproval: false },
      editTarget,
      outcome: 'failed-verification',
      validation: [1, 2, 3, 4, 5, 6].map((level) => ({ level, command: `l${level}`, passed: true })),
      stopReason: 'Re-reconciliation did not confirm a clean resolution (resolved=false, newFindings=0, unrelatedMutations=0). The edit was reverted.',
    });
    const timeline = deriveTimeline(record);
    assert.equal(timeline.find((s) => s.label === 'Finding verified')!.state, 'failed');
    assert.equal(timeline[timeline.length - 1].label, 'Edit reverted');
  });

  test('applied-verification-incomplete (Level 6 failure): "Edit applied" and "Validation passed" are genuinely done, "Code snapshot refreshed" is done, "Reconciliation completed" is failed — never a fabricated "Finding verified"/"Edit reverted" step', () => {
    const record = makeAudit({
      policyDecision: { reconciliationId: 'f1', status: 'figma-only-change', verdict: 'SAFE', reason: 'safe', requiredEvidence: [], requiredValidationLevels: [1, 2, 3, 4, 5, 6], requiresHumanApproval: false },
      editTarget,
      outcome: 'applied-verification-incomplete',
      change: { before: '20px', after: '24px' },
      filesModified: ['src/tokens/typography.css'],
      codeBaselinePromoted: false,
      figmaBaselinePromoted: false,
      validation: [
        { level: 1, command: 'tsc', passed: true },
        { level: 2, command: 'test', passed: true },
        { level: 3, command: 'build', passed: true },
        { level: 4, command: 'storybook', passed: true },
        { level: 5, command: 'sync:code-check (refresh current CodeSnapshot)', passed: true },
        { level: 6, command: 'sync:reconcile', passed: false, output: 'rate limit exceeded' },
      ],
      stopReason:
        'The edit was applied and passed all pre-apply validation (levels 1-4), but post-apply verification (sync:reconcile) failed before it could confirm resolution or promote any baseline: rate limit exceeded. The edit was NOT reverted — it was already independently validated. Once the underlying issue is resolved, run reconciliation and re-invoke the agent on this finding to complete verification and baseline promotion.',
    });
    const timeline = deriveTimeline(record);
    assert.deepEqual(
      timeline.map((s) => s.label),
      ['Finding detected', 'Policy classified SAFE', 'Target resolved', 'Claude proposed edit', 'Edit applied', 'Validation passed', 'Code snapshot refreshed', 'Reconciliation completed'],
    );
    assert.equal(timeline.find((s) => s.label === 'Edit applied')!.state, 'done');
    assert.equal(timeline.find((s) => s.label === 'Validation passed')!.state, 'done');
    assert.equal(timeline.find((s) => s.label === 'Code snapshot refreshed')!.state, 'done');
    assert.equal(timeline[timeline.length - 1].label, 'Reconciliation completed');
    assert.equal(timeline[timeline.length - 1].state, 'failed');
    assert.ok(!timeline.some((s) => s.label === 'Finding verified' || s.label === 'Edit reverted'));
  });

  test('applied-verification-incomplete (Level 5 failure): "Code snapshot refreshed" itself is the failed step, "Reconciliation completed" never appears at all', () => {
    const record = makeAudit({
      policyDecision: { reconciliationId: 'f1', status: 'figma-only-change', verdict: 'SAFE', reason: 'safe', requiredEvidence: [], requiredValidationLevels: [1, 2, 3, 4, 5, 6], requiresHumanApproval: false },
      editTarget,
      outcome: 'applied-verification-incomplete',
      change: { before: '20px', after: '24px' },
      filesModified: ['src/tokens/typography.css'],
      validation: [
        { level: 1, command: 'tsc', passed: true },
        { level: 2, command: 'test', passed: true },
        { level: 3, command: 'build', passed: true },
        { level: 4, command: 'storybook', passed: true },
        { level: 5, command: 'sync:code-check (refresh current CodeSnapshot)', passed: false, output: 'disk full' },
      ],
      stopReason:
        'The edit was applied and passed all pre-apply validation (levels 1-4), but post-apply verification (sync:code-check (refresh current CodeSnapshot)) failed before it could confirm resolution or promote any baseline: disk full. The edit was NOT reverted — it was already independently validated. Once the underlying issue is resolved, run reconciliation and re-invoke the agent on this finding to complete verification and baseline promotion.',
    });
    const timeline = deriveTimeline(record);
    assert.deepEqual(
      timeline.map((s) => s.label),
      ['Finding detected', 'Policy classified SAFE', 'Target resolved', 'Claude proposed edit', 'Edit applied', 'Validation passed', 'Code snapshot refreshed'],
    );
    assert.equal(timeline[timeline.length - 1].state, 'failed');
  });
});
