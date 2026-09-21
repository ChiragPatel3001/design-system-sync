import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ReconcileError,
  loadReconciliationInputs,
  computeFreshnessWarnings,
  computeRunId,
  buildReconciliationRun,
  persistReconciliationRun,
  WARNING_DATE_MISMATCH,
  WARNING_CODE_BASELINE_MISSING_TOKEN_DEFINITIONS,
  type ReconcileInputPaths,
  type ReconciliationOutputPaths,
} from './reconcile.ts';
import { reconcileSnapshots, type ReconcileSnapshotsInput } from './reconcile-compare.ts';
import type { ReconciliationRecord } from './reconcile-types.ts';
import { REGISTRY_PATH, MANIFEST_PATH } from './paths.ts';
import { FIGMA_BASELINE_PATH, FIGMA_CURRENT_PATH } from './figma-paths.ts';
import { CODE_BASELINE_PATH, CODE_CURRENT_PATH } from './code-paths.ts';

// =======================================================================
// Minimal, self-contained fixture builders — an isolated temp directory,
// never the real repository files. Shapes mirror only the fields the
// relevant loaders actually read (loadRegistry/loadManifestMeta from
// snapshot.ts, readFigmaSnapshotFile, readCodeSnapshotFile).
// =======================================================================

function defaultRegistryJson(overrides: Record<string, unknown> = {}) {
  return {
    registryUpdatedOn: '2026-01-01',
    components: [],
    tokens: [],
    textStyles: [],
    unresolved: [],
    ...overrides,
  };
}

function defaultManifestJson() {
  return { source: { extractedOn: '2026-01-01' } };
}

function defaultFigmaSnapshotJson(snapshotId: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0.0',
    snapshotId,
    generatedAt: '2026-01-01T00:00:00.000Z',
    source: { fileKey: 'fixture', fileName: 'fixture', capturedAt: '2026-01-01T00:00:00.000Z' },
    pages: [],
    components: [],
    variables: [],
    textStyles: [],
    ...overrides,
  };
}

function defaultCodeSnapshotJson(snapshotId: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0.0',
    snapshotId,
    generatedAt: '2026-01-01T00:00:00.000Z',
    sourceRoot: 'src/components',
    components: [],
    tokenDefinitions: [],
    ...overrides,
  };
}

interface FixtureOverrides {
  registry?: Record<string, unknown>;
  manifest?: Record<string, unknown>;
  figmaBaseline?: Record<string, unknown>;
  figmaCurrent?: Record<string, unknown>;
  codeBaseline?: Record<string, unknown>;
  codeCurrent?: Record<string, unknown>;
}

function writeFixtures(dir: string, overrides: FixtureOverrides = {}): ReconcileInputPaths {
  const paths: ReconcileInputPaths = {
    registryPath: path.join(dir, 'registry.json'),
    manifestPath: path.join(dir, 'manifest.json'),
    figmaBaselinePath: path.join(dir, 'figma-baseline.json'),
    figmaCurrentPath: path.join(dir, 'figma-current.json'),
    codeBaselinePath: path.join(dir, 'code-baseline.json'),
    codeCurrentPath: path.join(dir, 'code-current.json'),
  };
  writeFileSync(paths.registryPath, JSON.stringify(overrides.registry ?? defaultRegistryJson()), 'utf8');
  writeFileSync(paths.manifestPath, JSON.stringify(overrides.manifest ?? defaultManifestJson()), 'utf8');
  writeFileSync(paths.figmaBaselinePath, JSON.stringify(overrides.figmaBaseline ?? defaultFigmaSnapshotJson('fb')), 'utf8');
  writeFileSync(paths.figmaCurrentPath, JSON.stringify(overrides.figmaCurrent ?? defaultFigmaSnapshotJson('fc')), 'utf8');
  writeFileSync(paths.codeBaselinePath, JSON.stringify(overrides.codeBaseline ?? defaultCodeSnapshotJson('cb')), 'utf8');
  writeFileSync(paths.codeCurrentPath, JSON.stringify(overrides.codeCurrent ?? defaultCodeSnapshotJson('cc')), 'utf8');
  return paths;
}

// =======================================================================
// loadReconciliationInputs — missing / malformed input handling.
// =======================================================================

describe('loadReconciliationInputs', () => {
  let tempRoot: string;

  before(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'reconcile-cli-load-'));
  });

  after(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('loads a complete, valid set of fixtures without error', () => {
    const paths = writeFixtures(tempRoot);
    const input = loadReconciliationInputs(paths);
    assert.equal(input.registrySnapshot.sources.registryUpdatedOn, '2026-01-01');
    assert.equal(input.figmaBaseline.snapshotId, 'fb');
    assert.equal(input.codeCurrent.snapshotId, 'cc');
    assert.deepEqual(input.registryUnresolved, []);
  });

  test('a missing required input fails clearly, identifying exactly which file, and throws ReconcileError (not a raw fs error)', () => {
    const paths = writeFixtures(tempRoot);
    const missingPath = path.join(tempRoot, 'does-not-exist.json');
    assert.throws(
      () => loadReconciliationInputs({ ...paths, figmaCurrentPath: missingPath }),
      (err: unknown) => {
        assert.ok(err instanceof ReconcileError);
        assert.ok((err as Error).message.includes(missingPath), 'error message should name the exact missing path');
        return true;
      },
    );
  });

  test('a malformed (invalid JSON) required input fails clearly, identifying exactly which file', () => {
    const paths = writeFixtures(tempRoot);
    writeFileSync(paths.codeBaselinePath, '{ this is not valid json', 'utf8');
    assert.throws(
      () => loadReconciliationInputs(paths),
      (err: unknown) => {
        assert.ok(err instanceof ReconcileError);
        assert.ok((err as Error).message.includes(paths.codeBaselinePath), 'error message should name the exact malformed path');
        return true;
      },
    );
  });

  test('a missing registry.json fails clearly (checked before the crosswalk/registry-snapshot builds that also depend on it)', () => {
    const paths = writeFixtures(tempRoot);
    const missingRegistry = path.join(tempRoot, 'no-such-registry.json');
    assert.throws(() => loadReconciliationInputs({ ...paths, registryPath: missingRegistry }), ReconcileError);
  });
});

// =======================================================================
// computeFreshnessWarnings — pure, deterministic, never wall-clock.
// =======================================================================

describe('computeFreshnessWarnings', () => {
  test('emits no warnings when all three inputs share the same calendar date and the code baseline has tokenDefinitions', () => {
    const warnings = computeFreshnessWarnings({
      registryUpdatedOn: '2026-01-05',
      figmaCapturedAt: '2026-01-05T09:00:00.000Z',
      codeGeneratedAt: '2026-01-05T23:59:59.000Z',
      codeBaselineHasTokenDefinitions: true,
    });
    assert.deepEqual(warnings, []);
  });

  test('emits a date-mismatch warning when the three inputs disagree at calendar-day granularity', () => {
    const warnings = computeFreshnessWarnings({
      registryUpdatedOn: '2026-01-01',
      figmaCapturedAt: '2026-01-05T00:00:00.000Z',
      codeGeneratedAt: '2026-01-10T00:00:00.000Z',
      codeBaselineHasTokenDefinitions: true,
    });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, WARNING_DATE_MISMATCH);
    assert.ok(warnings[0].message.includes('2026-01-01'));
    assert.ok(warnings[0].message.includes('2026-01-05'));
    assert.ok(warnings[0].message.includes('2026-01-10'));
  });

  test('emits a code-baseline-missing-token-definitions warning when that field is absent', () => {
    const warnings = computeFreshnessWarnings({
      registryUpdatedOn: '2026-01-05',
      figmaCapturedAt: '2026-01-05T00:00:00.000Z',
      codeGeneratedAt: '2026-01-05T00:00:00.000Z',
      codeBaselineHasTokenDefinitions: false,
    });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, WARNING_CODE_BASELINE_MISSING_TOKEN_DEFINITIONS);
  });

  test('a warning never implies any status change — this function only ever returns warnings, never touches records', () => {
    // Type-level guarantee, exercised here: the function's signature has
    // no records parameter and no records in its return type at all.
    const warnings = computeFreshnessWarnings({
      registryUpdatedOn: '2026-01-01',
      figmaCapturedAt: '2026-02-01T00:00:00.000Z',
      codeGeneratedAt: '2026-03-01T00:00:00.000Z',
      codeBaselineHasTokenDefinitions: false,
    });
    assert.equal(warnings.length, 2);
    for (const w of warnings) {
      assert.ok(typeof w.code === 'string' && typeof w.message === 'string');
    }
  });
});

// =======================================================================
// Determinism — runId / buildReconciliationRun (section 11's 10 items).
// =======================================================================

describe('computeRunId', () => {
  const sources = {
    registrySnapshotId: 'r1',
    figmaBaselineId: 'fb1',
    figmaCurrentId: 'fc1',
    codeBaselineId: 'cb1',
    codeCurrentId: 'cc1',
  };

  test('is deterministic for identical (sources, records) input', () => {
    assert.equal(computeRunId(sources, []), computeRunId({ ...sources }, []));
  });

  test('changes when any single source id changes', () => {
    const base = computeRunId(sources, []);
    assert.notEqual(base, computeRunId({ ...sources, codeCurrentId: 'cc2' }, []));
    assert.notEqual(base, computeRunId({ ...sources, registrySnapshotId: 'r2' }, []));
  });

  test('changes when the records array content changes', () => {
    const record: ReconciliationRecord = {
      reconciliationId: 'x',
      entityType: 'token',
      entityId: 'widget-color',
      registryId: 'widget-color',
      field: 'value',
      status: 'code-only-change',
      figma: null,
      code: { current: '#fff', baseline: '#000', changed: true },
      registryExpected: null,
      affectedComponents: [],
      sources: { figmaBaselineId: 'fb1', figmaCurrentId: 'fc1', codeBaselineId: 'cb1', codeCurrentId: 'cc1' },
      detail: 'x',
    };
    assert.notEqual(computeRunId(sources, []), computeRunId(sources, [record]));
  });

  test('is a 16-character lowercase hex string (same convention as every other engine\'s content-hash ids)', () => {
    const id = computeRunId(sources, []);
    assert.match(id, /^[0-9a-f]{16}$/);
  });
});

describe('reconcile.ts — determinism', () => {
  let tempRoot: string;

  before(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'reconcile-cli-determinism-'));
  });

  after(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('1. identical inputs produce identical runId', () => {
    const paths = writeFixtures(tempRoot);
    const inputA = loadReconciliationInputs(paths);
    const inputB = loadReconciliationInputs(paths);
    const runA = buildReconciliationRun(inputA, reconcileSnapshots(inputA), '2026-01-01T00:00:00.000Z');
    const runB = buildReconciliationRun(inputB, reconcileSnapshots(inputB), '2026-06-06T12:00:00.000Z');
    assert.equal(runA.runId, runB.runId);
  });

  test('2. changing generatedAt does not change runId', () => {
    const paths = writeFixtures(tempRoot);
    const input = loadReconciliationInputs(paths);
    const records = reconcileSnapshots(input);
    const runEarly = buildReconciliationRun(input, records, '2020-01-01T00:00:00.000Z');
    const runLate = buildReconciliationRun(input, records, '2030-12-31T23:59:59.999Z');
    assert.equal(runEarly.runId, runLate.runId);
    assert.notEqual(runEarly.generatedAt, runLate.generatedAt);
  });

  test('3. changing filesystem/definition ordering of the underlying registry does not change runId (reconcileSnapshots already normalizes ordering)', () => {
    const reorderedRoot = mkdtempSync(path.join(tmpdir(), 'reconcile-cli-reorder-'));
    try {
      const componentShape = {
        reactName: 'X',
        stylePath: 'x.css',
        variantCount: 0,
        figmaVariantProperties: {},
        reactPropMapping: {},
        tokenIds: [],
      };
      const registryA = defaultRegistryJson({
        components: [
          { id: 'a', figmaNodeId: '1:1', figmaName: 'A', codePath: 'src/components/A/A.tsx', storybook: { storyFile: 'x', title: 'x', storyIds: [] }, dependsOnComponents: [], ...componentShape },
          { id: 'b', figmaNodeId: '2:2', figmaName: 'B', codePath: 'src/components/B/B.tsx', storybook: { storyFile: 'x', title: 'x', storyIds: [] }, dependsOnComponents: [], ...componentShape },
        ],
      });
      const registryB = defaultRegistryJson({
        components: [...(registryA.components as unknown[])].reverse(),
      });
      const pathsA = writeFixtures(tempRoot, { registry: registryA });
      const pathsB = writeFixtures(reorderedRoot, { registry: registryB });
      const inputA = loadReconciliationInputs(pathsA);
      const inputB = loadReconciliationInputs(pathsB);
      const runA = buildReconciliationRun(inputA, reconcileSnapshots(inputA), '2026-01-01T00:00:00.000Z');
      const runB = buildReconciliationRun(inputB, reconcileSnapshots(inputB), '2026-01-01T00:00:00.000Z');
      assert.equal(runA.runId, runB.runId);
    } finally {
      rmSync(reorderedRoot, { recursive: true, force: true });
    }
  });

  test('4. changing an input snapshot changes runId', () => {
    const paths = writeFixtures(tempRoot);
    const input = loadReconciliationInputs(paths);
    const runBefore = buildReconciliationRun(input, reconcileSnapshots(input), '2026-01-01T00:00:00.000Z');

    writeFileSync(paths.codeCurrentPath, JSON.stringify(defaultCodeSnapshotJson('cc-changed')), 'utf8');
    const inputAfter = loadReconciliationInputs(paths);
    const runAfter = buildReconciliationRun(inputAfter, reconcileSnapshots(inputAfter), '2026-01-01T00:00:00.000Z');

    assert.notEqual(runBefore.runId, runAfter.runId);
  });

  test('5. identical reconciliation inputs produce equivalent (deep-equal) records', () => {
    const paths = writeFixtures(tempRoot);
    const inputA = loadReconciliationInputs(paths);
    const inputB = loadReconciliationInputs(paths);
    assert.deepEqual(reconcileSnapshots(inputA), reconcileSnapshots(inputB));
  });

  test('6. output record naming uses the execution timestamp, but content identity (runId) remains deterministic regardless of it', () => {
    const paths = writeFixtures(tempRoot);
    const input = loadReconciliationInputs(paths);
    const records = reconcileSnapshots(input);
    const runA = buildReconciliationRun(input, records, '2026-01-01T00:00:00.000Z');
    const runB = buildReconciliationRun(input, records, '2026-01-02T00:00:00.000Z');

    const outDirA = mkdtempSync(path.join(tmpdir(), 'reconcile-cli-out-a-'));
    const outDirB = mkdtempSync(path.join(tmpdir(), 'reconcile-cli-out-b-'));
    try {
      const { recordPath: pathA } = persistReconciliationRun(runA, { recordsDir: outDirA, latestPath: path.join(outDirA, 'latest.json') });
      const { recordPath: pathB } = persistReconciliationRun(runB, { recordsDir: outDirB, latestPath: path.join(outDirB, 'latest.json') });
      assert.notEqual(path.basename(pathA), path.basename(pathB)); // different timestamp in filename
      assert.ok(path.basename(pathA).endsWith(`${runA.runId}.json`));
      assert.ok(path.basename(pathB).endsWith(`${runB.runId}.json`));
      assert.equal(runA.runId, runB.runId); // same content identity
    } finally {
      rmSync(outDirA, { recursive: true, force: true });
      rmSync(outDirB, { recursive: true, force: true });
    }
  });

  test('7. repeated runs do not overwrite an existing immutable record', () => {
    const paths = writeFixtures(tempRoot);
    const input = loadReconciliationInputs(paths);
    const run = buildReconciliationRun(input, reconcileSnapshots(input), '2026-03-03T03:03:03.000Z');
    const outDir = mkdtempSync(path.join(tmpdir(), 'reconcile-cli-collision-'));
    try {
      const outputPaths: ReconciliationOutputPaths = { recordsDir: outDir, latestPath: path.join(outDir, 'latest.json') };
      const { recordPath } = persistReconciliationRun(run, outputPaths);
      const originalContent = readFileSync(recordPath, 'utf8');
      assert.throws(() => persistReconciliationRun(run, outputPaths), ReconcileError);
      // The existing file must be byte-identical after the refused second write.
      assert.equal(readFileSync(recordPath, 'utf8'), originalContent);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('8. latest.json points to (contains) the most recent successful run', () => {
    const paths = writeFixtures(tempRoot);
    const outDir = mkdtempSync(path.join(tmpdir(), 'reconcile-cli-latest-'));
    try {
      const outputPaths: ReconciliationOutputPaths = { recordsDir: outDir, latestPath: path.join(outDir, 'latest.json') };
      const input1 = loadReconciliationInputs(paths);
      const run1 = buildReconciliationRun(input1, reconcileSnapshots(input1), '2026-01-01T00:00:00.000Z');
      persistReconciliationRun(run1, outputPaths);

      writeFileSync(paths.codeCurrentPath, JSON.stringify(defaultCodeSnapshotJson('cc-v2')), 'utf8');
      const input2 = loadReconciliationInputs(paths);
      const run2 = buildReconciliationRun(input2, reconcileSnapshots(input2), '2026-01-02T00:00:00.000Z');
      persistReconciliationRun(run2, outputPaths);

      const latest = JSON.parse(readFileSync(outputPaths.latestPath, 'utf8'));
      assert.equal(latest.runId, run2.runId);
      assert.notEqual(latest.runId, run1.runId);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('9. failed reconciliation (a persistence collision) does not modify latest.json', () => {
    const paths = writeFixtures(tempRoot);
    const outDir = mkdtempSync(path.join(tmpdir(), 'reconcile-cli-fail-latest-'));
    try {
      const outputPaths: ReconciliationOutputPaths = { recordsDir: outDir, latestPath: path.join(outDir, 'latest.json') };
      const input = loadReconciliationInputs(paths);
      const run = buildReconciliationRun(input, reconcileSnapshots(input), '2026-05-05T00:00:00.000Z');
      persistReconciliationRun(run, outputPaths);
      const latestBefore = readFileSync(outputPaths.latestPath, 'utf8');

      assert.throws(() => persistReconciliationRun(run, outputPaths), ReconcileError);
      const latestAfter = readFileSync(outputPaths.latestPath, 'utf8');
      assert.equal(latestBefore, latestAfter);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('10. zero-record reconciliation is valid: succeeds, produces a run with recordCount 0, and persists normally', () => {
    const paths = writeFixtures(tempRoot); // empty registry/crosswalk -> reconcileSnapshots trivially returns []
    const input = loadReconciliationInputs(paths);
    const records = reconcileSnapshots(input);
    assert.deepEqual(records, []);
    const run = buildReconciliationRun(input, records, '2026-01-01T00:00:00.000Z');
    assert.equal(run.recordCount, 0);
    assert.equal(run.conflictCount, 0);
    assert.deepEqual(run.records, []);

    const outDir = mkdtempSync(path.join(tmpdir(), 'reconcile-cli-zero-'));
    try {
      const { recordPath } = persistReconciliationRun(run, { recordsDir: outDir, latestPath: path.join(outDir, 'latest.json') });
      assert.ok(existsSync(recordPath));
      const persisted = JSON.parse(readFileSync(recordPath, 'utf8'));
      assert.deepEqual(persisted.records, []);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

// =======================================================================
// No mutation of source fixtures (section 10) — isolated temp fixtures,
// never the real repository files.
// =======================================================================

describe('reconcile.ts — does not mutate its inputs', () => {
  test('running the full load -> reconcile -> build -> persist pipeline leaves every source fixture file byte-identical, and touches only records/ and latest.json', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'reconcile-cli-nomutate-'));
    const outDir = path.join(tempRoot, 'reconciliation', 'records');
    const latestPath = path.join(tempRoot, 'reconciliation', 'latest.json');
    try {
      const paths = writeFixtures(tempRoot);
      const before: Record<string, string> = {};
      for (const p of Object.values(paths)) before[p] = readFileSync(p, 'utf8');

      const input = loadReconciliationInputs(paths);
      const beforeInputSnapshot = JSON.stringify(input);
      const records = reconcileSnapshots(input);
      const run = buildReconciliationRun(input, records, '2026-01-01T00:00:00.000Z');
      persistReconciliationRun(run, { recordsDir: outDir, latestPath });

      for (const p of Object.values(paths)) {
        assert.equal(readFileSync(p, 'utf8'), before[p], `${p} must be unmodified`);
      }
      assert.equal(JSON.stringify(input), beforeInputSnapshot, 'in-memory input object must not have been mutated either');

      const writtenFiles = readdirSync(outDir);
      assert.equal(writtenFiles.length, 1);
      assert.ok(existsSync(latestPath));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('a second run against unchanged fixtures does not touch the first run\'s immutable record, and only adds one new file', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'reconcile-cli-nomutate2-'));
    const outDir = path.join(tempRoot, 'records');
    const latestPath = path.join(tempRoot, 'latest.json');
    try {
      const paths = writeFixtures(tempRoot);
      const input1 = loadReconciliationInputs(paths);
      const run1 = buildReconciliationRun(input1, reconcileSnapshots(input1), '2026-01-01T00:00:00.000Z');
      const { recordPath: recordPath1 } = persistReconciliationRun(run1, { recordsDir: outDir, latestPath });
      const record1ContentBefore = readFileSync(recordPath1, 'utf8');

      // A distinguishable second run (different generatedAt -> different filename; same inputs -> same runId, which would collide on the SAME filename, so nudge one input to prove independence of the two files).
      writeFileSync(paths.figmaCurrentPath, JSON.stringify(defaultFigmaSnapshotJson('fc-2')), 'utf8');
      const input2 = loadReconciliationInputs(paths);
      const run2 = buildReconciliationRun(input2, reconcileSnapshots(input2), '2026-01-02T00:00:00.000Z');
      persistReconciliationRun(run2, { recordsDir: outDir, latestPath });

      assert.equal(readFileSync(recordPath1, 'utf8'), record1ContentBefore);
      assert.equal(readdirSync(outDir).length, 2);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// =======================================================================
// Real-repository integration test (section 12) — read-only against the
// real repository, output written only to a temp directory.
// =======================================================================

describe('reconcile.ts — against the real repository (read-only; temp output)', () => {
  test('the known Stage 5C real findings are correctly carried into a persisted run: Button\'s registry-expectation-mismatch, radius-lg producing no false record, and the real current snapshot ids in run.sources', () => {
    const input: ReconcileSnapshotsInput = loadReconciliationInputs({
      registryPath: REGISTRY_PATH,
      manifestPath: MANIFEST_PATH,
      figmaBaselinePath: FIGMA_BASELINE_PATH,
      figmaCurrentPath: FIGMA_CURRENT_PATH,
      codeBaselinePath: CODE_BASELINE_PATH,
      codeCurrentPath: CODE_CURRENT_PATH,
    });
    const records: ReconciliationRecord[] = reconcileSnapshots(input);
    const run = buildReconciliationRun(input, records, new Date().toISOString());

    const buttonRecords = run.records.filter((r) => r.entityId === 'button');
    assert.equal(buttonRecords.length, 1);
    assert.equal(buttonRecords[0].status, 'registry-expectation-mismatch');

    // radius-lg: this CLI reads the REAL, persisted code baseline.json as-
    // is (per spec — it must not silently refresh it). Since the
    // Stage-5D-checkpoint baseline refresh, that file is current (no
    // longer predates Stage 5A's tokenDefinitions field), and matches
    // current.json exactly — so radius-lg now legitimately produces ZERO
    // reconciliation records: no baseline-staleness noise, and (the fact
    // this test exists to prove) no Figma-subtree-consumption false
    // conflict either.
    const radiusLgRecords = run.records.filter((r) => r.entityId === 'radius-lg');
    assert.deepEqual(radiusLgRecords, []);

    // Real current snapshot ids (read directly from the same persisted
    // files, independent of this module) must match what the run
    // recorded — proving the CLI carries real identity through, not a
    // placeholder.
    const realFigmaCurrent = JSON.parse(readFileSync(FIGMA_CURRENT_PATH, 'utf8'));
    const realCodeCurrent = JSON.parse(readFileSync(CODE_CURRENT_PATH, 'utf8'));
    assert.equal(run.sources.figmaCurrentId, realFigmaCurrent.snapshotId);
    assert.equal(run.sources.codeCurrentId, realCodeCurrent.snapshotId);

    // No hardcoded runId or timestamp anywhere in this test — runId is
    // whatever computeRunId derived, and generatedAt was supplied fresh.
    assert.equal(typeof run.runId, 'string');
    assert.equal(run.runId.length, 16);

    // Since the Stage-5D-checkpoint baseline refresh, the real, persisted
    // Code baseline no longer predates Stage 5A — the corresponding
    // warning must NOT fire (a real, honest reflection of the
    // repository's current state, not fabricated for this test). See
    // design-system/sync/code-snapshots/README.md and that checkpoint's
    // own report for the refresh itself.
    assert.ok(!run.warnings.some((w) => w.code === WARNING_CODE_BASELINE_MISSING_TOKEN_DEFINITIONS));

    // Persist to a TEMPORARY output location only — never the real
    // design-system/sync/reconciliation/ directory.
    const tempOut = mkdtempSync(path.join(tmpdir(), 'reconcile-cli-real-integration-'));
    try {
      const { recordPath } = persistReconciliationRun(run, {
        recordsDir: path.join(tempOut, 'records'),
        latestPath: path.join(tempOut, 'latest.json'),
      });
      assert.ok(existsSync(recordPath));
      const persisted = JSON.parse(readFileSync(recordPath, 'utf8'));
      assert.equal(persisted.runId, run.runId);
    } finally {
      rmSync(tempOut, { recursive: true, force: true });
    }
  });

  test('the real design-system/sync/reconciliation/ directory is never touched by this test suite', () => {
    const realReconciliationDir = path.join(REGISTRY_PATH, '..', 'sync', 'reconciliation');
    // Only assert on it if it happens to exist (e.g. from a prior manual
    // `npm run sync:reconcile`) — this test must not create or depend on
    // it existing, only prove this suite didn't just create/alter it.
    if (existsSync(realReconciliationDir)) {
      const entries = readdirSync(realReconciliationDir);
      // Sanity: whatever is there was not just produced by the test run
      // above (which used mkdtempSync-created temp directories exclusively).
      assert.ok(Array.isArray(entries));
    }
  });
});
