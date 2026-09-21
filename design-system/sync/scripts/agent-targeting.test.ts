import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEditTarget } from './agent-targeting.ts';
import type { ReconciliationCrosswalk, ReconciliationRecord } from './reconcile-types.ts';
import type { CodeSnapshot } from './code-snapshot-types.ts';
import { loadRegistryJson, buildReconciliationCrosswalk } from './reconcile-crosswalk.ts';
import { REGISTRY_PATH } from './reconcile-paths.ts';
import { buildCodeSnapshot } from './code-snapshot.ts';
import { COMPONENTS_DIR, TOKENS_DIR, ROOT as CODE_ROOT } from './code-paths.ts';

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

describe('resolveEditTarget — synthetic fixtures', () => {
  test('a clean, resolved token target resolves correctly', () => {
    const target = resolveEditTarget({ record: makeRecord(), crosswalk: cleanCrosswalk, codeCurrent: cleanCodeCurrent });
    assert.deepEqual(target, {
      filePath: 'src/tokens/colors.css',
      kind: 'css-custom-property-value',
      declarationIdentifier: '--widget-color',
      currentValue: '#222222',
    });
  });

  test('unresolved crosswalk mapping (no entry at all) -> null', () => {
    const target = resolveEditTarget({ record: makeRecord(), crosswalk: makeCrosswalk({ tokens: [] }), codeCurrent: cleanCodeCurrent });
    assert.equal(target, null);
  });

  test('collision crosswalk mapping -> null', () => {
    const crosswalk = makeCrosswalk({ tokens: [{ ...cleanCrosswalk.tokens[0], status: 'collision' }] });
    const target = resolveEditTarget({ record: makeRecord(), crosswalk, codeCurrent: cleanCodeCurrent });
    assert.equal(target, null);
  });

  test('null registryId -> null', () => {
    const target = resolveEditTarget({ record: makeRecord({ registryId: null }), crosswalk: cleanCrosswalk, codeCurrent: cleanCodeCurrent });
    assert.equal(target, null);
  });

  test('multiple possible declarations -> null', () => {
    const codeCurrent = makeCodeSnapshot({
      tokenDefinitions: [
        { cssVariable: '--widget-color', value: '#222222', sourceFilePath: 'src/tokens/colors.css' },
        { cssVariable: '--widget-color', value: '#222222', sourceFilePath: 'src/tokens/colors-legacy.css' },
      ],
    });
    const target = resolveEditTarget({ record: makeRecord(), crosswalk: cleanCrosswalk, codeCurrent });
    assert.equal(target, null);
  });

  test('zero matching declarations -> null', () => {
    const target = resolveEditTarget({ record: makeRecord(), crosswalk: cleanCrosswalk, codeCurrent: makeCodeSnapshot({ tokenDefinitions: [] }) });
    assert.equal(target, null);
  });

  test('a var() alias declaration -> null (alias resolution unsupported in Stage 6B)', () => {
    const codeCurrent = makeCodeSnapshot({
      tokenDefinitions: [{ cssVariable: '--widget-color', value: 'var(--brand-purple-500)', sourceFilePath: 'src/tokens/colors.css' }],
    });
    const target = resolveEditTarget({ record: makeRecord(), crosswalk: cleanCrosswalk, codeCurrent });
    assert.equal(target, null);
  });

  test('unsupported finding (component entityType) -> null', () => {
    const record = makeRecord({ entityType: 'component', entityId: 'widget', field: 'component' });
    const target = resolveEditTarget({ record, crosswalk: cleanCrosswalk, codeCurrent: cleanCodeCurrent });
    assert.equal(target, null);
  });

  test('unsupported finding (field is not "value") -> null', () => {
    const target = resolveEditTarget({ record: makeRecord({ field: 'existence' }), crosswalk: cleanCrosswalk, codeCurrent: cleanCodeCurrent });
    assert.equal(target, null);
  });
});

describe('resolveEditTarget — real repository integration', () => {
  test('font-size-paragraph-medium resolves to the exact real file, CSS variable, and current value (read-only, real token not modified)', () => {
    const registryJson = loadRegistryJson(REGISTRY_PATH);
    const crosswalk = buildReconciliationCrosswalk(registryJson, { registryPath: 'design-system/registry.json' });
    const codeCurrent = buildCodeSnapshot({ componentsDir: COMPONENTS_DIR, rootForRelativePaths: CODE_ROOT, tokensDir: TOKENS_DIR });

    const record = makeRecord({
      entityType: 'token',
      entityId: 'font-size-paragraph-medium',
      registryId: 'font-size-paragraph-medium',
      field: 'value',
    });

    const target = resolveEditTarget({ record, crosswalk, codeCurrent });
    assert.ok(target, 'expected a resolved target for font-size-paragraph-medium');
    assert.equal(target?.filePath, 'src/tokens/typography.css');
    assert.equal(target?.declarationIdentifier, '--font-size-paragraph-medium');
    assert.equal(target?.currentValue, '16px');
    assert.equal(target?.kind, 'css-custom-property-value');
  });

  test('line-height-paragraph-medium resolves to the exact real file, CSS variable, and current value (read-only, real token not modified)', () => {
    const registryJson = loadRegistryJson(REGISTRY_PATH);
    const crosswalk = buildReconciliationCrosswalk(registryJson, { registryPath: 'design-system/registry.json' });
    const codeCurrent = buildCodeSnapshot({ componentsDir: COMPONENTS_DIR, rootForRelativePaths: CODE_ROOT, tokensDir: TOKENS_DIR });

    const record = makeRecord({
      entityType: 'token',
      entityId: 'line-height-paragraph-medium',
      registryId: 'line-height-paragraph-medium',
      field: 'value',
    });

    const target = resolveEditTarget({ record, crosswalk, codeCurrent });
    assert.ok(target, 'expected a resolved target for line-height-paragraph-medium');
    assert.equal(target?.filePath, 'src/tokens/typography.css');
    assert.equal(target?.declarationIdentifier, '--line-height-paragraph-medium');
    assert.equal(target?.currentValue, '20px');
  });

  test('a real aliased token (radius-lg) resolves to null — targeting correctly refuses alias declarations even for real, well-mapped tokens', () => {
    const registryJson = loadRegistryJson(REGISTRY_PATH);
    const crosswalk = buildReconciliationCrosswalk(registryJson, { registryPath: 'design-system/registry.json' });
    const codeCurrent = buildCodeSnapshot({ componentsDir: COMPONENTS_DIR, rootForRelativePaths: CODE_ROOT, tokensDir: TOKENS_DIR });

    const record = makeRecord({ entityType: 'token', entityId: 'radius-lg', registryId: 'radius-lg', field: 'value' });
    const target = resolveEditTarget({ record, crosswalk, codeCurrent });
    assert.equal(target, null);
  });
});
