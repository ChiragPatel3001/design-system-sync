import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRecord, classifyRecords } from './agent-policy.ts';
import type { ReconciliationCrosswalk, ReconciliationRecord, ReconciliationStatus } from './reconcile-types.ts';
import type { CodeSnapshot } from './code-snapshot-types.ts';

// =======================================================================
// Minimal fixture builders — mirror reconcile-compare.test.ts's own
// pattern (plain object literals matching the real interfaces, no
// filesystem I/O anywhere in this file).
// =======================================================================

function makeRecord(overrides: Partial<ReconciliationRecord> = {}): ReconciliationRecord {
  return {
    reconciliationId: 'rec-1',
    entityType: 'token',
    entityId: 'widget-color',
    registryId: 'widget-color',
    field: 'value',
    status: 'figma-only-change',
    figma: { current: '#222222', baseline: '#111111', changed: true },
    code: { current: '#111111', baseline: '#111111', changed: false },
    registryExpected: null,
    affectedComponents: ['widget'],
    sources: { figmaBaselineId: 'fb', figmaCurrentId: 'fc', codeBaselineId: 'cb', codeCurrentId: 'cc' },
    detail: 'fixture',
    ...overrides,
  };
}

function makeCrosswalk(overrides: Partial<ReconciliationCrosswalk> = {}): ReconciliationCrosswalk {
  return {
    schemaVersion: '1.0.0',
    source: { registryPath: 'fixture', registryUpdatedOn: '2026-01-01' },
    knownFigmaCollectionPrefixes: [],
    components: [],
    tokens: [
      {
        registryTokenId: 'widget-color',
        registrySourceType: 'figma-variable',
        figmaName: 'Mapped/Widget/color',
        normalizedFigmaName: 'Widget/color',
        cssVariable: '--widget-color',
        status: 'resolved',
        consumedBy: ['widget'],
      },
    ],
    tokenNormalizationCollisions: [],
    textStyles: [],
    ...overrides,
  };
}

function makeCodeSnapshot(overrides: Partial<CodeSnapshot> = {}): CodeSnapshot {
  return {
    schemaVersion: '1.0.0',
    snapshotId: 'cc',
    generatedAt: '2026-01-01T00:00:00.000Z',
    sourceRoot: 'src/components',
    components: [],
    tokenDefinitions: [{ cssVariable: '--widget-color', value: '#222222', sourceFilePath: 'src/tokens/colors.css' }],
    ...overrides,
  };
}

const cleanCrosswalk = makeCrosswalk();
const cleanCodeCurrent = makeCodeSnapshot();

// =======================================================================
// Every status -> correct verdict (the fixed table).
// =======================================================================

describe('classifyRecord — every ReconciliationStatus', () => {
  const table: { status: ReconciliationStatus; verdict: 'SAFE' | 'REVIEW' | 'BLOCKED' | 'NOT_APPLICABLE' }[] = [
    { status: 'both-changed-compatible', verdict: 'NOT_APPLICABLE' },
    { status: 'code-only-change', verdict: 'REVIEW' },
    { status: 'both-changed-conflict', verdict: 'BLOCKED' },
    { status: 'registry-expectation-mismatch', verdict: 'BLOCKED' },
    { status: 'unmapped-figma-entity', verdict: 'BLOCKED' },
    { status: 'unmapped-code-entity', verdict: 'REVIEW' },
    { status: 'out-of-scope-entity', verdict: 'NOT_APPLICABLE' },
    { status: 'identity-mismatch', verdict: 'REVIEW' },
    { status: 'deleted-figma-entity', verdict: 'REVIEW' },
    { status: 'deleted-code-entity', verdict: 'REVIEW' },
    { status: 'intentional-documented-deviation', verdict: 'NOT_APPLICABLE' },
  ];

  for (const { status, verdict } of table) {
    test(`${status} -> ${verdict}`, () => {
      const record = makeRecord({ status });
      const result = classifyRecord({ record, crosswalk: cleanCrosswalk, codeCurrent: cleanCodeCurrent });
      assert.equal(result.verdict, verdict);
      assert.equal(result.status, status);
      assert.equal(result.reconciliationId, record.reconciliationId);
      assert.equal(result.requiresHumanApproval, verdict === 'REVIEW' || verdict === 'BLOCKED');
      if (verdict !== 'SAFE') assert.deepEqual(result.requiredValidationLevels, []);
    });
  }

  test('figma-only-change under clean conditions is the only status that can reach SAFE', () => {
    const record = makeRecord({ status: 'figma-only-change' });
    const result = classifyRecord({ record, crosswalk: cleanCrosswalk, codeCurrent: cleanCodeCurrent });
    assert.equal(result.verdict, 'SAFE');
    assert.equal(result.requiresHumanApproval, false);
    assert.deepEqual(result.requiredValidationLevels, [1, 2, 3, 4, 5, 6]);
    assert.ok(result.requiredEvidence.length > 0);
  });

  test('an unrecognized status throws rather than silently defaulting to an unsafe verdict', () => {
    const record = makeRecord({ status: 'not-a-real-status' as ReconciliationStatus });
    assert.throws(() => classifyRecord({ record, crosswalk: cleanCrosswalk, codeCurrent: cleanCodeCurrent }));
  });
});

// =======================================================================
// SAFE subconditions, individually.
// =======================================================================

describe('classifyRecord — figma-only-change SAFE subconditions', () => {
  test('resolved mapping + raw literal => SAFE', () => {
    const result = classifyRecord({ record: makeRecord(), crosswalk: cleanCrosswalk, codeCurrent: cleanCodeCurrent });
    assert.equal(result.verdict, 'SAFE');
  });

  test('resolved mapping + var() alias => REVIEW', () => {
    const codeCurrent = makeCodeSnapshot({
      tokenDefinitions: [{ cssVariable: '--widget-color', value: 'var(--brand-purple-500)', sourceFilePath: 'src/tokens/colors.css' }],
    });
    const result = classifyRecord({ record: makeRecord(), crosswalk: cleanCrosswalk, codeCurrent });
    assert.equal(result.verdict, 'REVIEW');
    assert.match(result.reason, /var\(\) alias/);
  });

  test('ambiguous/collision crosswalk mapping => REVIEW', () => {
    const crosswalk = makeCrosswalk({
      tokens: [{ ...cleanCrosswalk.tokens[0], status: 'collision' }],
    });
    const result = classifyRecord({ record: makeRecord(), crosswalk, codeCurrent: cleanCodeCurrent });
    assert.equal(result.verdict, 'REVIEW');
    assert.match(result.reason, /collision/);
  });

  test('unresolved mapping (no crosswalk entry at all) => REVIEW', () => {
    const crosswalk = makeCrosswalk({ tokens: [] });
    const result = classifyRecord({ record: makeRecord(), crosswalk, codeCurrent: cleanCodeCurrent });
    assert.equal(result.verdict, 'REVIEW');
    assert.match(result.reason, /no crosswalk token mapping/);
  });

  test('multi-declaration target => REVIEW', () => {
    const codeCurrent = makeCodeSnapshot({
      tokenDefinitions: [
        { cssVariable: '--widget-color', value: '#222222', sourceFilePath: 'src/tokens/colors.css' },
        { cssVariable: '--widget-color', value: '#222222', sourceFilePath: 'src/tokens/colors-legacy.css' },
      ],
    });
    const result = classifyRecord({ record: makeRecord(), crosswalk: cleanCrosswalk, codeCurrent });
    assert.equal(result.verdict, 'REVIEW');
    assert.match(result.reason, /2 CodeSnapshot\.tokenDefinitions entries/);
  });

  test('zero matching declarations => REVIEW', () => {
    const codeCurrent = makeCodeSnapshot({ tokenDefinitions: [] });
    const result = classifyRecord({ record: makeRecord(), crosswalk: cleanCrosswalk, codeCurrent });
    assert.equal(result.verdict, 'REVIEW');
    assert.match(result.reason, /no CodeSnapshot\.tokenDefinitions entry/);
  });

  test('registryId null (reverse-pass finding) => REVIEW', () => {
    const record = makeRecord({ registryId: null });
    const result = classifyRecord({ record, crosswalk: cleanCrosswalk, codeCurrent: cleanCodeCurrent });
    assert.equal(result.verdict, 'REVIEW');
    assert.match(result.reason, /registryId is null/);
  });

  test('non-token structural change (component entityType) => REVIEW, not SAFE', () => {
    const record = makeRecord({ entityType: 'component', entityId: 'widget', field: 'component' });
    const result = classifyRecord({ record, crosswalk: cleanCrosswalk, codeCurrent: cleanCodeCurrent });
    assert.equal(result.verdict, 'REVIEW');
    assert.match(result.reason, /only supports token value-synchronization findings/);
  });

  test('token identity/name-shaped field (not "value") => REVIEW, not SAFE', () => {
    const record = makeRecord({ field: 'existence' });
    const result = classifyRecord({ record, crosswalk: cleanCrosswalk, codeCurrent: cleanCodeCurrent });
    assert.equal(result.verdict, 'REVIEW');
  });

  test('registry identity/name change (registry-expectation-mismatch) => BLOCKED regardless of evidence', () => {
    const record = makeRecord({ status: 'registry-expectation-mismatch', field: 'variantProperties', entityType: 'component' });
    const result = classifyRecord({ record, crosswalk: cleanCrosswalk, codeCurrent: cleanCodeCurrent });
    assert.equal(result.verdict, 'BLOCKED');
  });
});

describe('classifyRecords', () => {
  test('classifies every record in a list, preserving order', () => {
    const records = [makeRecord({ reconciliationId: 'a', status: 'out-of-scope-entity' }), makeRecord({ reconciliationId: 'b' })];
    const results = classifyRecords({ records, crosswalk: cleanCrosswalk, codeCurrent: cleanCodeCurrent });
    assert.deepEqual(results.map((r) => r.reconciliationId), ['a', 'b']);
    assert.equal(results[0].verdict, 'NOT_APPLICABLE');
    assert.equal(results[1].verdict, 'SAFE');
  });
});
