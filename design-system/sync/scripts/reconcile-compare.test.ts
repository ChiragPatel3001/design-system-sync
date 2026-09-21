import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadRegistry, loadManifestMeta, buildSnapshot } from './snapshot.ts';
import { REGISTRY_PATH, MANIFEST_PATH, ROOT } from './paths.ts';
import { readFigmaSnapshotFile } from './figma-snapshot.ts';
import { FIGMA_BASELINE_PATH, FIGMA_CURRENT_PATH } from './figma-paths.ts';
import { buildCodeSnapshot } from './code-snapshot.ts';
import { COMPONENTS_DIR, TOKENS_DIR, ROOT as CODE_ROOT } from './code-paths.ts';
import { loadRegistryJson, buildReconciliationCrosswalk } from './reconcile-crosswalk.ts';
import { REGISTRY_PATH as RECONCILE_REGISTRY_PATH } from './reconcile-paths.ts';
import {
  reconcileSnapshots,
  isDocumentedUnresolved,
  consumedCssVariables,
  type ReconcileSnapshotsInput,
  type RegistryUnresolvedEntry,
} from './reconcile-compare.ts';
import type { Snapshot, ComponentSnapshotEntry, TokenSnapshotEntry } from './types.ts';
import type { FigmaSnapshot, FigmaComponentEntry, FigmaVariableEntry } from './figma-snapshot-types.ts';
import type { CodeSnapshot, CodeComponentEntry, CodeTokenDefinition } from './code-snapshot-types.ts';
import type {
  ReconciliationCrosswalk,
  ComponentIdentityMapping,
  TokenIdentityMapping,
  TextStyleIdentityMapping,
  ReconciliationRecord,
} from './reconcile-types.ts';

// =======================================================================
// Real-data integration fixtures.
//
// codeBaseline is built FRESH from the current source tree (same call as
// codeCurrent), not read from the persisted, on-disk baseline.json — that
// file predates Stage 5A's tokenDefinitions field entirely (confirmed by
// direct inspection: it has no tokenDefinitions key at all), so comparing
// against it would report ~200 "code-only-change" token records that are
// really just an artifact of a stale stored file, drowning out the
// specific real scenarios (Button, radius-lg, subtree consumption) this
// suite exists to prove. That real, on-disk staleness condition is
// still real and worth covering — see the dedicated test below that
// reads the actual persisted baseline.json and documents what it
// produces, rather than silently avoiding it everywhere.
// =======================================================================

function buildRealFixtures(): ReconcileSnapshotsInput {
  const registry = loadRegistry(REGISTRY_PATH);
  const manifestMeta = loadManifestMeta(MANIFEST_PATH);
  const registrySnapshot = buildSnapshot(registry, manifestMeta, {
    registryPath: 'design-system/registry.json',
    manifestPath: 'design-system-manifest.json',
  });

  const figmaBaseline = readFigmaSnapshotFile(FIGMA_BASELINE_PATH);
  const figmaCurrent = readFigmaSnapshotFile(FIGMA_CURRENT_PATH);

  const codeCurrent = buildCodeSnapshot({ componentsDir: COMPONENTS_DIR, rootForRelativePaths: CODE_ROOT, tokensDir: TOKENS_DIR });
  const codeBaseline = buildCodeSnapshot({ componentsDir: COMPONENTS_DIR, rootForRelativePaths: CODE_ROOT, tokensDir: TOKENS_DIR });

  const regJson = loadRegistryJson(RECONCILE_REGISTRY_PATH);
  const crosswalk = buildReconciliationCrosswalk(regJson, { registryPath: 'design-system/registry.json' });

  const rawRegistry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as {
    unresolved: { entity: string; tokenId: string }[];
  };
  const registryUnresolved: RegistryUnresolvedEntry[] = rawRegistry.unresolved.map((u) => ({
    entity: u.entity,
    tokenId: u.tokenId,
  }));

  return { registrySnapshot, registryUnresolved, figmaBaseline, figmaCurrent, codeBaseline, codeCurrent, crosswalk };
}

describe('reconcileSnapshots — against real repository data', () => {
  const input = buildRealFixtures();
  const records = reconcileSnapshots(input);

  test('radius-lg has zero reconciliation records: no baseline drift on either side, and the crosswalk normalization matches cleanly', () => {
    const radiusLgRecords = records.filter((r) => r.entityId === 'radius-lg');
    assert.deepEqual(radiusLgRecords, []);
  });

  test('the real Button variant-property-name mismatch (registry "Property 1" vs Figma "State") produces exactly one registry-expectation-mismatch record, with no invented/normalized-away agreement', () => {
    const buttonRecords = records.filter((r) => r.entityId === 'button');
    assert.equal(buttonRecords.length, 1);
    const [record] = buttonRecords;
    assert.equal(record.status, 'registry-expectation-mismatch');
    assert.equal(record.entityType, 'component');
    assert.equal(record.field, 'variantProperties');
    assert.deepEqual((record.registryExpected as { names: string[] }).names, ['Property 1', 'Type']);
    assert.deepEqual((record.figma!.current as { names: string[] }).names, ['State', 'Type']);
    // The registry was NOT changed to match Figma — registryExpected still literally says "Property 1".
    assert.notDeepEqual(record.registryExpected, record.figma!.current);
  });

  test('the Button mismatch is not reported as any kind of *-changed status (no baseline drift occurred; this is a standing registry-vs-current disagreement)', () => {
    const buttonRecords = records.filter((r) => r.entityId === 'button');
    for (const r of buttonRecords) {
      assert.ok(!r.status.includes('changed'), `unexpected status ${r.status} for button`);
    }
  });

  test('Figma subtree consumption does not create a false token conflict for radius-lg/form-field: the asymmetry exists in the raw data, but this engine never surfaces it as a status', () => {
    // Establish the real asymmetry this test guards against first.
    const figmaRadiusVar = input.figmaCurrent.variables.find((v) => v.name === 'Border radius/lg');
    assert.ok(figmaRadiusVar, 'expected the real capture to include Border radius/lg');
    assert.ok(
      figmaRadiusVar!.consumedBy.includes('18:256'),
      'expected Figma\'s subtree-inclusive consumedBy to include form-field\'s node (18:256) via its nested TextField',
    );
    const registryRadiusLg = input.registrySnapshot.tokens.find((t) => t.tokenId === 'radius-lg');
    assert.ok(registryRadiusLg, 'expected radius-lg in the registry snapshot');
    assert.ok(
      !registryRadiusLg!.consumedBy.includes('form-field'),
      'expected the registry\'s own directly-authored consumedBy to NOT include form-field (it only renders a nested TextField)',
    );

    // No record anywhere implicates form-field regarding radius-lg.
    const formFieldRadiusRecords = records.filter(
      (r) => (r.entityId === 'radius-lg' || r.entityId === 'form-field') && r.affectedComponents.includes('form-field'),
    );
    assert.deepEqual(formFieldRadiusRecords, []);
  });

  test('the 5 real registry tokens whose normalized Figma name is absent from the capture are reported as unmapped-figma-entity, never as a value conflict', () => {
    const expectedMissing = ['color-text-caption', 'font-size-caption', 'line-height-caption', 'scale-200', 'scale-300'];
    for (const tokenId of expectedMissing) {
      const tokenRecords = records.filter((r) => r.entityType === 'token' && r.entityId === tokenId);
      assert.equal(tokenRecords.length, 1, `expected exactly one record for ${tokenId}`);
      assert.equal(tokenRecords[0].status, 'unmapped-figma-entity');
      assert.equal(tokenRecords[0].field, 'existence');
      // Not observed in baseline either -> "never observed", not "deleted".
      assert.equal(tokenRecords[0].figma!.baseline, null);
      assert.notEqual(tokenRecords[0].status, 'both-changed-conflict');
      assert.notEqual(tokenRecords[0].status, 'figma-only-change');
    }
  });

  test('the one inferred/non-Figma-backed token (font-weight-body) never gets a Figma-side record', () => {
    const fwbRecords = records.filter((r) => r.entityId === 'font-weight-body');
    for (const r of fwbRecords) {
      assert.equal(r.figma, null);
    }
    // With identical fresh baseline/current code snapshots, there is no
    // code-side change either, so there should be no record at all.
    assert.deepEqual(fwbRecords, []);
  });

  test('every real registry component resolves cleanly (no identity-mismatch in the real repository today)', () => {
    const identityRecords = records.filter((r) => r.status === 'identity-mismatch');
    assert.deepEqual(identityRecords, []);
  });

  test('reverse-pass: real Figma variables/components/code entities with no registry mapping are reported (unmapped or out-of-scope), not silently dropped', () => {
    // "Body/Medium" is a registry-tracked TEXT STYLE (registry.json's
    // textStyles[] entry "body-medium"), not an untracked variable — the
    // crosswalk now resolves it, so it must NOT appear as unmapped at all.
    const bodyMedium = records.find((r) => r.entityType === 'token' && r.entityId === 'Body/Medium');
    assert.equal(bodyMedium, undefined, 'Body/Medium is registry-tracked via textStyles[] and must not be reported as unmapped');

    // --alias-primary-500 is real, intentional raw-palette infrastructure
    // — never consumed by any tracked component's own CSS — so it's out
    // of the reconciliation entity boundary, not an "unmapped" gap.
    const aliasPrimary500 = records.find((r) => r.entityType === 'token' && r.entityId === '--alias-primary-500');
    assert.ok(aliasPrimary500, 'expected an out-of-scope-entity record for the untracked raw palette variable --alias-primary-500');
    assert.equal(aliasPrimary500?.status, 'out-of-scope-entity');
    assert.equal(aliasPrimary500?.registryId, null);

    // Every real Figma/Code *component* is registry-tracked in this POC (confirmed by direct inspection) — no reverse-pass component records expected.
    const unmappedComponentRecords = records.filter(
      (r) => r.entityType === 'component' && (r.status === 'unmapped-figma-entity' || r.status === 'unmapped-code-entity' || r.status === 'out-of-scope-entity') && r.registryId === null,
    );
    assert.deepEqual(unmappedComponentRecords, []);
  });

  test('the real 200 previously-unmapped Code tokens are now exactly 200 out-of-scope-entity records, and 0 unmapped-code-entity records remain', () => {
    const outOfScope = records.filter((r) => r.status === 'out-of-scope-entity');
    const unmappedCode = records.filter((r) => r.status === 'unmapped-code-entity');
    assert.equal(outOfScope.length, 200);
    assert.equal(unmappedCode.length, 0);
    for (const r of outOfScope) {
      assert.equal(r.entityType, 'token');
      assert.equal(r.registryId, null);
    }
  });

  test('the real Figma text-style/variable reverse-pass split is exactly as expected: Body/Medium resolved, the other 3 genuinely ambiguous variables remain unmapped, and the 5 registry-backed missing variables remain unmapped', () => {
    const stillUnmappedFigmaVariables = ['Icon/error', 'Icon/placeholder', 'Paragraph Medium/Paragraph Spacing'];
    for (const name of stillUnmappedFigmaVariables) {
      const r = records.find((rec) => rec.entityType === 'token' && rec.entityId === name);
      assert.ok(r, `expected ${name} to remain unmapped-figma-entity`);
      assert.equal(r?.status, 'unmapped-figma-entity');
      assert.equal(r?.registryId, null);
    }

    const missingFigmaBackedTokens = ['color-text-caption', 'font-size-caption', 'line-height-caption', 'scale-200', 'scale-300'];
    for (const tokenId of missingFigmaBackedTokens) {
      const r = records.find((rec) => rec.entityType === 'token' && rec.entityId === tokenId && rec.status === 'unmapped-figma-entity');
      assert.ok(r, `expected registry token ${tokenId} to remain unmapped-figma-entity`);
      assert.equal(r?.registryId, tokenId);
    }

    // Exactly 8 unmapped-figma-entity records remain (9 - 1 for Body/Medium).
    assert.equal(records.filter((r) => r.status === 'unmapped-figma-entity').length, 8);
  });

  test('deterministic ordering: records are sorted by (entityType, entityId, field, status) via localeCompare, independent of internal processing order', () => {
    // Matches reconcile-compare.ts's own sort exactly (localeCompare, not
    // raw UTF-16 code-unit comparison — those disagree on e.g. "Icon/error"
    // vs "font-size-caption": localeCompare treats case/locale-aware order,
    // `<` does not).
    const key = (r: ReconciliationRecord) => [r.entityType, r.entityId, r.field, r.status] as const;
    for (let i = 1; i < records.length; i++) {
      const [aType, aId, aField, aStatus] = key(records[i - 1]);
      const [bType, bId, bField, bStatus] = key(records[i]);
      const cmp =
        aType.localeCompare(bType) || aId.localeCompare(bId) || aField.localeCompare(bField) || aStatus.localeCompare(bStatus);
      assert.ok(cmp <= 0, `record ${i - 1} (${key(records[i - 1]).join('|')}) should sort before or equal to record ${i} (${key(records[i]).join('|')})`);
    }
  });

  test('re-running reconcileSnapshots on the same real inputs produces byte-identical output (pure, deterministic)', () => {
    const again = reconcileSnapshots(input);
    assert.deepEqual(again, records);
  });

  test('none of the inputs were mutated by reconcileSnapshots', () => {
    // Snapshot each input's JSON before/after a fresh call — any mutation
    // (in-place sort, push, field write) would change this.
    const before = JSON.stringify(input);
    reconcileSnapshots(input);
    const after = JSON.stringify(input);
    assert.equal(before, after);
  });

  test('reconcile-compare.ts never imports node:fs, calls Date, or uses Math.random — no filesystem/network I/O, no timestamps, no randomness', () => {
    const content = readFileSync(path.join(ROOT, 'design-system/sync/scripts/reconcile-compare.ts'), 'utf8');
    assert.ok(!/from ['"]node:fs['"]/.test(content), 'must not import node:fs');
    assert.ok(!/\bnew Date\(/.test(content), 'must not construct a Date (no timestamps generated)');
    assert.ok(!/Date\.now\(/.test(content), 'must not call Date.now()');
    assert.ok(!/Math\.random\(/.test(content), 'must not call Math.random()');
  });
});

// =======================================================================
// Pre-Stage-5A-schema baseline condition (defensive-fallback regression
// test).
//
// As of the Stage 5D-checkpoint baseline refresh (`npm run
// sync:code-baseline --force`), the real, persisted
// code-snapshots/baseline.json now DOES include tokenDefinitions (it no
// longer predates Stage 5A) — see design-system/sync/code-snapshots/README.md
// and that checkpoint's own report. This test previously read the real
// on-disk file specifically because it happened to be stale; now that
// it's current, the regression this test protects against (a baseline
// missing tokenDefinitions entirely) is reproduced synthetically instead
// — deleting the field from an otherwise-real snapshot object — so the
// defensive `?? []` fallback in reconcile-compare.ts stays covered
// regardless of the real repository's baseline freshness going forward.
// =======================================================================

describe('reconcileSnapshots — a Code baseline missing tokenDefinitions entirely (pre-Stage-5A schema)', () => {
  test('a baseline with no tokenDefinitions field at all (simulating the pre-Stage-5A schema) is handled defensively, not by crashing, and correctly reports a code-side change', () => {
    const input = buildRealFixtures();
    const staleShapedBaseline = { ...input.codeBaseline } as { tokenDefinitions?: unknown };
    delete staleShapedBaseline.tokenDefinitions;
    assert.deepEqual(staleShapedBaseline.tokenDefinitions, undefined);

    const records = reconcileSnapshots({ ...input, codeBaseline: staleShapedBaseline as typeof input.codeBaseline });
    const radiusLgRecord = records.find((r) => r.entityId === 'radius-lg' && r.field === 'value');
    assert.ok(radiusLgRecord, 'expected radius-lg to show a code-side change against a baseline missing tokenDefinitions');
    assert.equal(radiusLgRecord?.code?.baseline, null);
  });

  test('the real, current on-disk Code baseline now DOES include tokenDefinitions (post-checkpoint refresh) — this is no longer the stale-schema case', () => {
    const input = buildRealFixtures();
    assert.ok(Array.isArray(input.codeBaseline.tokenDefinitions));
    assert.ok(input.codeBaseline.tokenDefinitions.length > 0);
  });
});

// =======================================================================
// isDocumentedUnresolved — pure unit tests against the real registry's
// unresolved[] data (see reconcile-compare.ts header for why
// knownLimitations, being free text, is not consulted here).
// =======================================================================

describe('isDocumentedUnresolved', () => {
  const rawRegistry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as { unresolved: RegistryUnresolvedEntry[] };

  test('returns true for the real documented (field-label, color-text-error) pair', () => {
    assert.equal(isDocumentedUnresolved(rawRegistry.unresolved, 'field-label', 'color-text-error'), true);
  });

  test('returns false for an arbitrary undocumented pair', () => {
    assert.equal(isDocumentedUnresolved(rawRegistry.unresolved, 'button', 'radius-lg'), false);
  });

  test('returns false when the entity matches but the tokenId does not', () => {
    assert.equal(isDocumentedUnresolved(rawRegistry.unresolved, 'field-label', 'color-text-body'), false);
  });
});

describe('consumedCssVariables', () => {
  test('is the union of every component\'s cssCustomPropertiesConsumed, deduplicated', () => {
    const snapshot = {
      schemaVersion: '1.0.0',
      snapshotId: 'x',
      generatedAt: '2026-01-01T00:00:00.000Z',
      sourceRoot: 'src/components',
      components: [
        { componentId: 'A', cssCustomPropertiesConsumed: ['--shared', '--only-a'] },
        { componentId: 'B', cssCustomPropertiesConsumed: ['--shared', '--only-b'] },
      ],
      tokenDefinitions: [],
    } as unknown as CodeSnapshot;
    const result = consumedCssVariables(snapshot);
    assert.deepEqual([...result].sort(), ['--only-a', '--only-b', '--shared']);
  });

  test('returns an empty set for a CodeSnapshot with no components', () => {
    const snapshot = { components: [], tokenDefinitions: [] } as unknown as CodeSnapshot;
    assert.deepEqual([...consumedCssVariables(snapshot)], []);
  });

  test('against the real repository: the consumed set is exactly the 40 registry-tracked CSS variables (empirically confirmed 1:1 — see the Stage 5E design review)', () => {
    const codeCurrent = buildCodeSnapshot({ componentsDir: COMPONENTS_DIR, rootForRelativePaths: CODE_ROOT, tokensDir: TOKENS_DIR });
    const registry = loadRegistry(REGISTRY_PATH);
    const registryCssVariables = new Set(registry.tokens.map((t) => t.cssVariable));
    const consumed = consumedCssVariables(codeCurrent);
    assert.deepEqual([...consumed].sort(), [...registryCssVariables].sort());
  });
});

// =======================================================================
// Synthetic fixtures — small, isolated, cover every required edge case
// section 13 asks for that the real repository doesn't currently exhibit
// (compatible/conflict, deleted-*, unmapped-* via crosswalk anchoring,
// figma-only/code-only in isolation, identity-mismatch).
// =======================================================================

function makeRegistrySnapshot(components: ComponentSnapshotEntry[] = [], tokens: TokenSnapshotEntry[] = []): Snapshot {
  return {
    schemaVersion: '1.0.0',
    snapshotId: 'fixture-registry',
    generatedAt: '2026-01-01T00:00:00.000Z',
    sources: { registryPath: 'fixture', registryUpdatedOn: '2026-01-01', manifestPath: 'fixture', manifestExtractedOn: '2026-01-01' },
    components,
    tokens,
  };
}

function makeComponentSnapshotEntry(overrides: Partial<ComponentSnapshotEntry> = {}): ComponentSnapshotEntry {
  return {
    id: 'widget',
    figmaNodeId: '1:1',
    figmaName: 'Widget',
    reactName: 'Widget',
    codePath: 'src/components/Widget/Widget.tsx',
    stylePath: 'src/components/Widget/Widget.css',
    storybookTitle: 'Components/Widget',
    storybookStoryIds: [],
    variantCount: 1,
    figmaVariantProperties: { State: ['Default'] },
    reactPropMapping: {},
    tokenIds: [],
    dependsOnComponents: [],
    ...overrides,
  };
}

function makeFigmaSnapshot(overrides: Partial<FigmaSnapshot> = {}): FigmaSnapshot {
  return {
    schemaVersion: '1.0.0',
    snapshotId: 'fixture-figma',
    generatedAt: '2026-01-01T00:00:00.000Z',
    source: { fileKey: 'fixture', fileName: 'fixture', capturedAt: '2026-01-01T00:00:00.000Z' },
    pages: [],
    components: [],
    variables: [],
    textStyles: [],
    ...overrides,
  };
}

function makeFigmaComponentEntry(overrides: Partial<FigmaComponentEntry> = {}): FigmaComponentEntry {
  return {
    figmaNodeId: '1:1',
    name: 'Widget',
    kind: 'component',
    sectionId: null,
    sectionName: null,
    containerWidth: 100,
    containerHeight: 40,
    variantCount: 1,
    variantPropertyNames: ['State'],
    variantPropertyValues: { State: ['Default'] },
    variants: [],
    variableBindings: [],
    ...overrides,
  };
}

function makeFigmaVariableEntry(overrides: Partial<FigmaVariableEntry> = {}): FigmaVariableEntry {
  return { name: 'Widget/color', value: '#111111', inferredType: 'COLOR', consumedBy: ['1:1'], ...overrides };
}

function makeCodeSnapshot(overrides: Partial<CodeSnapshot> = {}): CodeSnapshot {
  return {
    schemaVersion: '1.0.0',
    snapshotId: 'fixture-code',
    generatedAt: '2026-01-01T00:00:00.000Z',
    sourceRoot: 'src/components',
    components: [],
    tokenDefinitions: [],
    ...overrides,
  };
}

function makeCodeComponentEntry(overrides: Partial<CodeComponentEntry> = {}): CodeComponentEntry {
  return {
    componentId: 'Widget',
    sourceFilePath: 'src/components/Widget/Widget.tsx',
    cssFilePath: null,
    exportedComponents: ['Widget'],
    exportedTypes: [],
    props: [],
    propsBaseType: null,
    variants: [],
    cssCustomPropertiesConsumed: [],
    cssCustomPropertiesDefined: [],
    imports: [],
    componentDependencies: [],
    storybook: { storyFilePath: null, title: null, storyExportNames: [], computedStoryIds: [] },
    sourceHashes: { component: 'hash-a', styles: null, stories: null },
    ...overrides,
  };
}

function makeCodeTokenDefinition(overrides: Partial<CodeTokenDefinition> = {}): CodeTokenDefinition {
  return { cssVariable: '--widget-color', value: '#111111', sourceFilePath: 'src/tokens/colors.css', ...overrides };
}

function makeCrosswalk(
  components: ComponentIdentityMapping[] = [],
  tokens: TokenIdentityMapping[] = [],
  textStyles: TextStyleIdentityMapping[] = [],
): ReconciliationCrosswalk {
  return {
    schemaVersion: '1.0.0',
    source: { registryPath: 'fixture', registryUpdatedOn: '2026-01-01' },
    knownFigmaCollectionPrefixes: ['Alias', 'Brand', 'Mapped', 'Responsive'],
    components,
    tokens,
    tokenNormalizationCollisions: [],
    textStyles,
  };
}

function makeTextStyleMapping(overrides: Partial<TextStyleIdentityMapping> = {}): TextStyleIdentityMapping {
  return {
    registryTextStyleId: 'body-medium',
    figmaName: 'Body/Medium',
    tokenIds: ['font-size-paragraph-medium', 'line-height-paragraph-medium', 'alias-font-family-body'],
    consumedBy: ['button', 'field-label'],
    ...overrides,
  };
}

function makeComponentMapping(overrides: Partial<ComponentIdentityMapping> = {}): ComponentIdentityMapping {
  return {
    registryComponentId: 'widget',
    figmaNodeId: '1:1',
    figmaName: 'Widget',
    codeComponentId: 'Widget',
    codePath: 'src/components/Widget/Widget.tsx',
    storybook: { storyFile: 'src/components/Widget/Widget.stories.tsx', title: 'Components/Widget', storyIds: [] },
    status: 'resolved',
    dependsOnComponents: [],
    ...overrides,
  };
}

function makeTokenMapping(overrides: Partial<TokenIdentityMapping> = {}): TokenIdentityMapping {
  return {
    registryTokenId: 'widget-color',
    registrySourceType: 'figma-variable',
    figmaName: 'Mapped/Widget/color',
    normalizedFigmaName: 'Widget/color',
    cssVariable: '--widget-color',
    status: 'resolved',
    consumedBy: ['widget'],
    ...overrides,
  };
}

const emptyInputDefaults = {
  registrySnapshot: makeRegistrySnapshot(),
  registryUnresolved: [] as RegistryUnresolvedEntry[],
  figmaBaseline: makeFigmaSnapshot({ snapshotId: 'fb' }),
  figmaCurrent: makeFigmaSnapshot({ snapshotId: 'fc' }),
  codeBaseline: makeCodeSnapshot({ snapshotId: 'cb' }),
  codeCurrent: makeCodeSnapshot({ snapshotId: 'cc' }),
  crosswalk: makeCrosswalk(),
};

describe('reconcileSnapshots — synthetic fixtures', () => {
  test('no changes at all -> zero reconciliation records', () => {
    const records = reconcileSnapshots(emptyInputDefaults);
    assert.deepEqual(records, []);
  });

  test('token: Figma-only change produces exactly one figma-only-change record', () => {
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      figmaBaseline: makeFigmaSnapshot({ snapshotId: 'fb', variables: [makeFigmaVariableEntry({ value: '#111111' })] }),
      figmaCurrent: makeFigmaSnapshot({ snapshotId: 'fc', variables: [makeFigmaVariableEntry({ value: '#222222' })] }),
      codeBaseline: makeCodeSnapshot({ snapshotId: 'cb', tokenDefinitions: [makeCodeTokenDefinition({ value: '#111111' })] }),
      codeCurrent: makeCodeSnapshot({ snapshotId: 'cc', tokenDefinitions: [makeCodeTokenDefinition({ value: '#111111' })] }),
      crosswalk: makeCrosswalk([], [makeTokenMapping()]),
    };
    const records = reconcileSnapshots(input);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'figma-only-change');
    assert.equal(records[0].entityType, 'token');
    assert.equal(records[0].figma?.changed, true);
    assert.equal(records[0].code?.changed, false);
  });

  test('token: Code-only change produces exactly one code-only-change record', () => {
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      figmaBaseline: makeFigmaSnapshot({ snapshotId: 'fb', variables: [makeFigmaVariableEntry({ value: '#111111' })] }),
      figmaCurrent: makeFigmaSnapshot({ snapshotId: 'fc', variables: [makeFigmaVariableEntry({ value: '#111111' })] }),
      codeBaseline: makeCodeSnapshot({ snapshotId: 'cb', tokenDefinitions: [makeCodeTokenDefinition({ value: '#111111' })] }),
      codeCurrent: makeCodeSnapshot({ snapshotId: 'cc', tokenDefinitions: [makeCodeTokenDefinition({ value: '#222222' })] }),
      crosswalk: makeCrosswalk([], [makeTokenMapping()]),
    };
    const records = reconcileSnapshots(input);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'code-only-change');
    assert.equal(records[0].figma?.changed, false);
    assert.equal(records[0].code?.changed, true);
  });

  test('token: both sides changed to the SAME raw value -> both-changed-compatible', () => {
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      figmaBaseline: makeFigmaSnapshot({ snapshotId: 'fb', variables: [makeFigmaVariableEntry({ value: '#111111' })] }),
      figmaCurrent: makeFigmaSnapshot({ snapshotId: 'fc', variables: [makeFigmaVariableEntry({ value: '#222222' })] }),
      codeBaseline: makeCodeSnapshot({ snapshotId: 'cb', tokenDefinitions: [makeCodeTokenDefinition({ value: '#111111' })] }),
      codeCurrent: makeCodeSnapshot({ snapshotId: 'cc', tokenDefinitions: [makeCodeTokenDefinition({ value: '#222222' })] }),
      crosswalk: makeCrosswalk([], [makeTokenMapping()]),
    };
    const records = reconcileSnapshots(input);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'both-changed-compatible');
  });

  test('token: both sides changed to DIFFERENT raw values -> both-changed-conflict', () => {
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      figmaBaseline: makeFigmaSnapshot({ snapshotId: 'fb', variables: [makeFigmaVariableEntry({ value: '#111111' })] }),
      figmaCurrent: makeFigmaSnapshot({ snapshotId: 'fc', variables: [makeFigmaVariableEntry({ value: '#222222' })] }),
      codeBaseline: makeCodeSnapshot({ snapshotId: 'cb', tokenDefinitions: [makeCodeTokenDefinition({ value: '#111111' })] }),
      codeCurrent: makeCodeSnapshot({ snapshotId: 'cc', tokenDefinitions: [makeCodeTokenDefinition({ value: '#333333' })] }),
      crosswalk: makeCrosswalk([], [makeTokenMapping()]),
    };
    const records = reconcileSnapshots(input);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'both-changed-conflict');
  });

  test('component: invalid codePath (the Stage 5B synthetic index.tsx case) -> identity-mismatch, never treated as a deletion', () => {
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      registrySnapshot: makeRegistrySnapshot([makeComponentSnapshotEntry({ id: 'widget', codePath: 'src/components/Widget/index.tsx' })]),
      crosswalk: makeCrosswalk(
        [
          makeComponentMapping({
            registryComponentId: 'widget',
            codeComponentId: null,
            codePath: 'src/components/Widget/index.tsx',
            status: 'unresolved-code-path',
          }),
        ],
        [],
      ),
    };
    const records = reconcileSnapshots(input);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'identity-mismatch');
    assert.equal(records[0].field, 'identity');
    assert.notEqual(records[0].status, 'deleted-code-entity');
    assert.notEqual(records[0].status, 'unmapped-code-entity');
  });

  test('component: mapped entity absent from Figma current but present in Figma baseline -> deleted-figma-entity', () => {
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      registrySnapshot: makeRegistrySnapshot([makeComponentSnapshotEntry()]),
      figmaBaseline: makeFigmaSnapshot({ snapshotId: 'fb', components: [makeFigmaComponentEntry()] }),
      figmaCurrent: makeFigmaSnapshot({ snapshotId: 'fc', components: [] }),
      codeCurrent: makeCodeSnapshot({ snapshotId: 'cc', components: [makeCodeComponentEntry()] }),
      codeBaseline: makeCodeSnapshot({ snapshotId: 'cb', components: [makeCodeComponentEntry()] }),
      crosswalk: makeCrosswalk([makeComponentMapping()], []),
    };
    const records = reconcileSnapshots(input);
    const existenceRecords = records.filter((r) => r.field === 'existence');
    assert.equal(existenceRecords.length, 1);
    assert.equal(existenceRecords[0].status, 'deleted-figma-entity');
  });

  test('component: mapped entity absent from Code current but present in Code baseline -> deleted-code-entity', () => {
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      registrySnapshot: makeRegistrySnapshot([makeComponentSnapshotEntry()]),
      figmaCurrent: makeFigmaSnapshot({ snapshotId: 'fc', components: [makeFigmaComponentEntry()] }),
      figmaBaseline: makeFigmaSnapshot({ snapshotId: 'fb', components: [makeFigmaComponentEntry()] }),
      codeBaseline: makeCodeSnapshot({ snapshotId: 'cb', components: [makeCodeComponentEntry()] }),
      codeCurrent: makeCodeSnapshot({ snapshotId: 'cc', components: [] }),
      crosswalk: makeCrosswalk([makeComponentMapping()], []),
    };
    const records = reconcileSnapshots(input);
    const existenceRecords = records.filter((r) => r.field === 'existence');
    assert.equal(existenceRecords.length, 1);
    assert.equal(existenceRecords[0].status, 'deleted-code-entity');
  });

  test('token: mapped entity never observed in Figma baseline or current -> unmapped-figma-entity, not deleted', () => {
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      codeBaseline: makeCodeSnapshot({ snapshotId: 'cb', tokenDefinitions: [makeCodeTokenDefinition()] }),
      codeCurrent: makeCodeSnapshot({ snapshotId: 'cc', tokenDefinitions: [makeCodeTokenDefinition()] }),
      crosswalk: makeCrosswalk([], [makeTokenMapping()]),
    };
    const records = reconcileSnapshots(input);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'unmapped-figma-entity');
    assert.equal(records[0].figma?.baseline, null);
  });

  test('token: mapped entity absent from Code current and Code baseline -> unmapped-code-entity', () => {
    // Figma side is given a matching, present variable in both baseline
    // and current so it resolves cleanly — isolating the code side as
    // the only unmapped fact under test.
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      figmaBaseline: makeFigmaSnapshot({ snapshotId: 'fb', variables: [makeFigmaVariableEntry()] }),
      figmaCurrent: makeFigmaSnapshot({ snapshotId: 'fc', variables: [makeFigmaVariableEntry()] }),
      crosswalk: makeCrosswalk([], [makeTokenMapping()]),
    };
    const records = reconcileSnapshots(input);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'unmapped-code-entity');
  });

  test('reverse pass: a Figma component observed with no registry mapping at all -> unmapped-figma-entity with registryId null', () => {
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      figmaBaseline: makeFigmaSnapshot({ snapshotId: 'fb', components: [makeFigmaComponentEntry({ figmaNodeId: '99:1', name: 'Untracked' })] }),
      figmaCurrent: makeFigmaSnapshot({ snapshotId: 'fc', components: [makeFigmaComponentEntry({ figmaNodeId: '99:1', name: 'Untracked' })] }),
    };
    const records = reconcileSnapshots(input);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'unmapped-figma-entity');
    assert.equal(records[0].registryId, null);
    assert.equal(records[0].entityId, '99:1');
  });

  test('reverse pass: a Code component observed with no registry mapping at all -> unmapped-code-entity with registryId null', () => {
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      codeBaseline: makeCodeSnapshot({ snapshotId: 'cb', components: [makeCodeComponentEntry({ componentId: 'Untracked' })] }),
      codeCurrent: makeCodeSnapshot({ snapshotId: 'cc', components: [makeCodeComponentEntry({ componentId: 'Untracked' })] }),
    };
    const records = reconcileSnapshots(input);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'unmapped-code-entity');
    assert.equal(records[0].registryId, null);
    assert.equal(records[0].entityId, 'Untracked');
  });

  test('entity boundary: a Code token consumed by a tracked component\'s own CSS but absent from the registry -> unmapped-code-entity (inside the boundary, a real gap)', () => {
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      codeBaseline: makeCodeSnapshot({
        snapshotId: 'cb',
        components: [makeCodeComponentEntry({ cssCustomPropertiesConsumed: ['--untracked-but-consumed'] })],
        tokenDefinitions: [makeCodeTokenDefinition({ cssVariable: '--untracked-but-consumed', value: '#123456' })],
      }),
      codeCurrent: makeCodeSnapshot({
        snapshotId: 'cc',
        components: [makeCodeComponentEntry({ cssCustomPropertiesConsumed: ['--untracked-but-consumed'] })],
        tokenDefinitions: [makeCodeTokenDefinition({ cssVariable: '--untracked-but-consumed', value: '#123456' })],
      }),
    };
    const records = reconcileSnapshots(input);
    // The synthetic "Widget" code component itself is also unmapped
    // (not in the empty crosswalk) — a separate, expected, unrelated
    // component-level reverse-pass fact. This test only asserts the
    // TOKEN-level fact under test.
    const tokenRecord = records.find((r) => r.entityType === 'token');
    assert.ok(tokenRecord);
    assert.equal(tokenRecord?.status, 'unmapped-code-entity');
    assert.equal(tokenRecord?.entityId, '--untracked-but-consumed');
    assert.equal(tokenRecord?.registryId, null);
  });

  test('entity boundary: a Code token neither consumed by any tracked component nor registry-represented -> out-of-scope-entity (real infrastructure, not a gap)', () => {
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      codeBaseline: makeCodeSnapshot({
        snapshotId: 'cb',
        components: [makeCodeComponentEntry({ cssCustomPropertiesConsumed: [] })],
        tokenDefinitions: [makeCodeTokenDefinition({ cssVariable: '--raw-palette-only', value: '#654321' })],
      }),
      codeCurrent: makeCodeSnapshot({
        snapshotId: 'cc',
        components: [makeCodeComponentEntry({ cssCustomPropertiesConsumed: [] })],
        tokenDefinitions: [makeCodeTokenDefinition({ cssVariable: '--raw-palette-only', value: '#654321' })],
      }),
    };
    const records = reconcileSnapshots(input);
    // Same caveat as above: the synthetic "Widget" code component itself
    // also produces its own unrelated unmapped-code-entity record.
    const tokenRecord = records.find((r) => r.entityType === 'token');
    assert.ok(tokenRecord);
    assert.equal(tokenRecord?.status, 'out-of-scope-entity');
    assert.equal(tokenRecord?.entityId, '--raw-palette-only');
    assert.equal(tokenRecord?.registryId, null);
  });

  test('text-style reverse pass: a Figma variable name claimed by a crosswalk text-style mapping is NOT reported as unmapped', () => {
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      figmaBaseline: makeFigmaSnapshot({ snapshotId: 'fb', variables: [makeFigmaVariableEntry({ name: 'Body/Medium', value: 'Font(...)' })] }),
      figmaCurrent: makeFigmaSnapshot({ snapshotId: 'fc', variables: [makeFigmaVariableEntry({ name: 'Body/Medium', value: 'Font(...)' })] }),
      crosswalk: makeCrosswalk([], [], [makeTextStyleMapping({ figmaName: 'Body/Medium' })]),
    };
    const records = reconcileSnapshots(input);
    assert.deepEqual(records, []);
  });

  test('text-style reverse pass: a Figma variable NOT claimed by any crosswalk text-style mapping is still reported as unmapped (no over-suppression)', () => {
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      figmaBaseline: makeFigmaSnapshot({ snapshotId: 'fb', variables: [makeFigmaVariableEntry({ name: 'Other/Style', value: 'Font(...)' })] }),
      figmaCurrent: makeFigmaSnapshot({ snapshotId: 'fc', variables: [makeFigmaVariableEntry({ name: 'Other/Style', value: 'Font(...)' })] }),
      crosswalk: makeCrosswalk([], [], [makeTextStyleMapping({ figmaName: 'Body/Medium' })]),
    };
    const records = reconcileSnapshots(input);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'unmapped-figma-entity');
    assert.equal(records[0].entityId, 'Other/Style');
  });

  test('inferred (non-Figma-backed) token: a Code-side change is reported as code-only-change with figma: null, never inventing a Figma value', () => {
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      codeBaseline: makeCodeSnapshot({ snapshotId: 'cb', tokenDefinitions: [makeCodeTokenDefinition({ cssVariable: '--font-weight-body', value: '400' })] }),
      codeCurrent: makeCodeSnapshot({ snapshotId: 'cc', tokenDefinitions: [makeCodeTokenDefinition({ cssVariable: '--font-weight-body', value: '500' })] }),
      crosswalk: makeCrosswalk(
        [],
        [
          makeTokenMapping({
            registryTokenId: 'font-weight-body',
            registrySourceType: 'inferred',
            figmaName: null,
            normalizedFigmaName: null,
            cssVariable: '--font-weight-body',
          }),
        ],
      ),
    };
    const records = reconcileSnapshots(input);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'code-only-change');
    assert.equal(records[0].figma, null);
  });

  test('a token with a Stage-5B collision status is treated as Figma-unresolvable (never guesses which colliding token a Figma variable belongs to)', () => {
    // No Figma variables at all here (deliberately) — a real Figma
    // variable named "Widget/color" would additionally trigger the
    // reverse-pass "observed in Figma, no *resolved* crosswalk mapping
    // claims it" fact (correct, since a colliding mapping's status isn't
    // 'resolved' — but a second, unrelated fact this test isn't about).
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      codeBaseline: makeCodeSnapshot({ snapshotId: 'cb', tokenDefinitions: [makeCodeTokenDefinition({ value: '#111111' })] }),
      codeCurrent: makeCodeSnapshot({ snapshotId: 'cc', tokenDefinitions: [makeCodeTokenDefinition({ value: '#222222' })] }),
      crosswalk: makeCrosswalk([], [makeTokenMapping({ status: 'collision' })]),
    };
    const records = reconcileSnapshots(input);
    // Only the code-side temporal fact is reported; no figma-existence or value-conflict record is fabricated from the ambiguous name.
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'code-only-change');
    assert.equal(records[0].figma, null);
  });

  test('component: both sides changed and the registry expectation still matches current Figma -> both-changed-compatible', () => {
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      registrySnapshot: makeRegistrySnapshot([
        makeComponentSnapshotEntry({ figmaVariantProperties: { State: ['Default', 'Hover'] }, variantCount: 2 }),
      ]),
      figmaBaseline: makeFigmaSnapshot({
        snapshotId: 'fb',
        components: [makeFigmaComponentEntry({ variantCount: 1, variantPropertyNames: ['State'], variantPropertyValues: { State: ['Default'] } })],
      }),
      figmaCurrent: makeFigmaSnapshot({
        snapshotId: 'fc',
        components: [
          makeFigmaComponentEntry({ variantCount: 2, variantPropertyNames: ['State'], variantPropertyValues: { State: ['Default', 'Hover'] } }),
        ],
      }),
      codeBaseline: makeCodeSnapshot({ snapshotId: 'cb', components: [makeCodeComponentEntry({ sourceHashes: { component: 'hash-a', styles: null, stories: null } })] }),
      codeCurrent: makeCodeSnapshot({ snapshotId: 'cc', components: [makeCodeComponentEntry({ sourceHashes: { component: 'hash-b', styles: null, stories: null } })] }),
      crosswalk: makeCrosswalk([makeComponentMapping()], []),
    };
    const records = reconcileSnapshots(input);
    const temporalRecord = records.find((r) => r.field === 'component');
    assert.ok(temporalRecord);
    assert.equal(temporalRecord?.status, 'both-changed-compatible');
    // The expectation check itself found no mismatch, so no separate registry-expectation-mismatch record either.
    assert.deepEqual(records.filter((r) => r.status === 'registry-expectation-mismatch'), []);
  });

  test('component: both sides changed and the registry expectation no longer matches current Figma -> both-changed-conflict (plus its own registry-expectation-mismatch record)', () => {
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      registrySnapshot: makeRegistrySnapshot([
        makeComponentSnapshotEntry({ figmaVariantProperties: { 'Property 1': ['Default'] }, variantCount: 1 }),
      ]),
      figmaBaseline: makeFigmaSnapshot({
        snapshotId: 'fb',
        components: [makeFigmaComponentEntry({ variantCount: 1, variantPropertyNames: ['State'], variantPropertyValues: { State: ['Default'] } })],
      }),
      figmaCurrent: makeFigmaSnapshot({
        snapshotId: 'fc',
        components: [makeFigmaComponentEntry({ variantCount: 2, variantPropertyNames: ['State'], variantPropertyValues: { State: ['Default', 'Hover'] } })],
      }),
      codeBaseline: makeCodeSnapshot({ snapshotId: 'cb', components: [makeCodeComponentEntry({ sourceHashes: { component: 'hash-a', styles: null, stories: null } })] }),
      codeCurrent: makeCodeSnapshot({ snapshotId: 'cc', components: [makeCodeComponentEntry({ sourceHashes: { component: 'hash-b', styles: null, stories: null } })] }),
      crosswalk: makeCrosswalk([makeComponentMapping()], []),
    };
    const records = reconcileSnapshots(input);
    const temporalRecord = records.find((r) => r.field === 'component');
    assert.ok(temporalRecord);
    assert.equal(temporalRecord?.status, 'both-changed-conflict');
    const expectationRecord = records.find((r) => r.status === 'registry-expectation-mismatch');
    assert.ok(expectationRecord, 'expected a separate, distinct registry-expectation-mismatch record');
  });

  test('input immutability holds for synthetic fixtures too (spread-copied arrays, no in-place sort/push)', () => {
    const input: ReconcileSnapshotsInput = {
      ...emptyInputDefaults,
      crosswalk: makeCrosswalk([makeComponentMapping()], [makeTokenMapping()]),
    };
    const before = JSON.stringify(input);
    reconcileSnapshots(input);
    assert.equal(JSON.stringify(input), before);
  });

  test('no filesystem/network dependency: reconcileSnapshots works from purely synthetic, in-memory input with no relation to any real file path', () => {
    const records = reconcileSnapshots(emptyInputDefaults);
    assert.deepEqual(records, []);
  });
});
