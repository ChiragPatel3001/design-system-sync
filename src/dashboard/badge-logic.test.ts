import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { policyVerdictBadge, findingBadge, outcomeBadge } from './badge-logic.ts';

// =======================================================================
// findingBadge — the display-layer split of the BLOCKED verdict into two
// honest categories. Never changes status or policyVerdict themselves
// (those are asserted unchanged in dashboard-loader.test.ts); this file
// only covers the badge/category mapping itself.
// =======================================================================

describe('policyVerdictBadge (unchanged baseline behavior)', () => {
  test('SAFE / REVIEW / BLOCKED / NOT_APPLICABLE map to their existing tone/symbol/label', () => {
    assert.deepEqual(policyVerdictBadge('SAFE'), { tone: 'safe', symbol: '✓', label: 'SAFE' });
    assert.deepEqual(policyVerdictBadge('REVIEW'), { tone: 'warning', symbol: '!', label: 'REVIEW' });
    assert.deepEqual(policyVerdictBadge('BLOCKED'), { tone: 'critical', symbol: '✕', label: 'BLOCKED' });
    assert.deepEqual(policyVerdictBadge('NOT_APPLICABLE'), { tone: 'neutral', symbol: '–', label: 'N/A' });
  });
});

describe('findingBadge', () => {
  test('SAFE and REVIEW pass through to policyVerdictBadge unchanged, regardless of status', () => {
    assert.deepEqual(findingBadge({ policyVerdict: 'SAFE', status: 'figma-only-change' }), policyVerdictBadge('SAFE'));
    assert.deepEqual(findingBadge({ policyVerdict: 'REVIEW', status: 'code-only-change' }), policyVerdictBadge('REVIEW'));
    assert.deepEqual(findingBadge({ policyVerdict: 'REVIEW', status: 'unmapped-code-entity' }), policyVerdictBadge('REVIEW'));
  });

  test('NOT_APPLICABLE passes through to policyVerdictBadge unchanged (defensive — never actually reaches the findings list)', () => {
    assert.deepEqual(findingBadge({ policyVerdict: 'NOT_APPLICABLE', status: 'out-of-scope-entity' }), policyVerdictBadge('NOT_APPLICABLE'));
  });

  test('BLOCKED + unmapped-figma-entity gets a distinct neutral "UNMAPPED" badge — not the red BLOCKED/✕ one', () => {
    const badge = findingBadge({ policyVerdict: 'BLOCKED', status: 'unmapped-figma-entity' });
    assert.equal(badge.tone, 'neutral');
    assert.equal(badge.label, 'UNMAPPED');
    assert.notEqual(badge.symbol, '✕');
    assert.notEqual(badge.tone, 'critical');
  });

  test('BLOCKED + both-changed-conflict keeps the red BLOCKED/✕ badge (genuinely ambiguous)', () => {
    assert.deepEqual(findingBadge({ policyVerdict: 'BLOCKED', status: 'both-changed-conflict' }), policyVerdictBadge('BLOCKED'));
  });

  test('BLOCKED + registry-expectation-mismatch keeps the red BLOCKED/✕ badge (genuinely ambiguous)', () => {
    assert.deepEqual(findingBadge({ policyVerdict: 'BLOCKED', status: 'registry-expectation-mismatch' }), policyVerdictBadge('BLOCKED'));
  });
});

describe('outcomeBadge', () => {
  test('applied-verification-incomplete gets a distinct warning badge — neither the green "Applied" success badge nor a red failure badge', () => {
    const badge = outcomeBadge('applied-verification-incomplete');
    assert.equal(badge.tone, 'warning');
    assert.notEqual(badge.tone, 'safe');
    assert.notEqual(badge.tone, 'critical');
    assert.notEqual(badge, outcomeBadge('applied'));
    assert.notEqual(badge, outcomeBadge('failed-verification'));
  });
});
