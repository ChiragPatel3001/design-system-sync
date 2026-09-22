import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { handleReconcileRequest, isReconcileRunInFlight, ReconcileAlreadyRunningError, DashboardReconcileError, type DashboardReconcileDeps } from './dashboard-reconcile-handler.ts';
import { buildCodeSnapshot, writeCodeSnapshotFile } from './code-snapshot.ts';
import type { ReconcileInputPaths, ReconciliationOutputPaths } from './reconcile.ts';

// =======================================================================
// Isolated fixture scaffolding — never the real repository. Deliberately
// exercises the REAL loadReconciliationInputs/reconcileSnapshots/
// buildReconciliationRun/persistReconciliationRun through
// handleReconcileRequest; only `refreshCode`/`refreshFigma` are injected
// (they're the two things a real dashboard would otherwise reach out to
// live infrastructure for — everything downstream of them is the actual
// production reconciliation engine).
// =======================================================================

interface Scenario {
  tempRoot: string;
  componentsDir: string;
  tokensDir: string;
  deps: DashboardReconcileDeps;
}

function scaffold(tempRoot: string): Scenario {
  const componentsDir = path.join(tempRoot, 'src', 'components');
  const tokensDir = path.join(tempRoot, 'src', 'tokens');
  mkdirSync(componentsDir, { recursive: true });
  mkdirSync(tokensDir, { recursive: true });
  const fixturesDir = path.join(tempRoot, 'fixtures');
  mkdirSync(fixturesDir, { recursive: true });

  const reconciliationInputPaths: ReconcileInputPaths = {
    registryPath: path.join(fixturesDir, 'registry.json'),
    manifestPath: path.join(fixturesDir, 'manifest.json'),
    figmaBaselinePath: path.join(fixturesDir, 'figma-baseline.json'),
    figmaCurrentPath: path.join(fixturesDir, 'figma-current.json'),
    codeBaselinePath: path.join(fixturesDir, 'code-baseline.json'),
    codeCurrentPath: path.join(fixturesDir, 'code-current.json'),
  };
  const reconciliationOutputPaths: ReconciliationOutputPaths = {
    recordsDir: path.join(tempRoot, 'reconciliation', 'records'),
    latestPath: path.join(tempRoot, 'reconciliation', 'latest.json'),
  };

  const deps: DashboardReconcileDeps = {
    refreshCode: () => {
      const snapshot = buildCodeSnapshot({ componentsDir, rootForRelativePaths: tempRoot, tokensDir });
      writeCodeSnapshotFile(reconciliationInputPaths.codeCurrentPath, snapshot);
      return { snapshotId: snapshot.snapshotId, changeCount: 0 };
    },
    refreshFigma: async () => ({ ok: true, snapshotId: null }), // Figma current.json is written directly by the fixture below, like sync:code-check would
    reconciliationInputPaths,
    reconciliationOutputPaths,
  };

  return { tempRoot, componentsDir, tokensDir, deps };
}

function writeRegistry(scenario: Scenario, tokens: Record<string, unknown>[]): void {
  writeFileSync(scenario.deps.reconciliationInputPaths.registryPath, JSON.stringify({ registryUpdatedOn: '2026-01-01', components: [], tokens, textStyles: [], unresolved: [] }), 'utf8');
  writeFileSync(scenario.deps.reconciliationInputPaths.manifestPath, JSON.stringify({ source: { extractedOn: '2026-01-01' } }), 'utf8');
}

function writeFigma(filePath: string, snapshotId: string, variables: { name: string; value: string }[]): void {
  writeFileSync(
    filePath,
    JSON.stringify({
      schemaVersion: '1.0.0',
      snapshotId,
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: { fileKey: 'fixture', fileName: 'fixture', capturedAt: '2026-01-01T00:00:00.000Z' },
      pages: [],
      components: [],
      variables: variables.map((v) => ({ name: v.name, value: v.value, inferredType: 'COLOR', consumedBy: [] })),
      textStyles: [],
    }),
    'utf8',
  );
}

function writeCodeBaseline(scenario: Scenario): void {
  const snapshot = buildCodeSnapshot({ componentsDir: scenario.componentsDir, rootForRelativePaths: scenario.tempRoot, tokensDir: scenario.tokensDir });
  writeCodeSnapshotFile(scenario.deps.reconciliationInputPaths.codeBaselinePath, snapshot);
}

describe('handleReconcileRequest', () => {
  test('runs the real reconciliation engine end-to-end and returns the real, persisted runId', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'dashboard-reconcile-'));
    try {
      const scenario = scaffold(tempRoot);
      writeFileSync(path.join(scenario.tokensDir, 'colors.css'), ':root {\n  --widget-color: #111111;\n}\n', 'utf8');
      writeRegistry(scenario, [{ tokenId: 'widget-color', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/color', cssVariable: '--widget-color', consumedBy: [] }]);
      writeFigma(scenario.deps.reconciliationInputPaths.figmaBaselinePath, 'fb', [{ name: 'Widget/color', value: '#111111' }]);
      writeFigma(scenario.deps.reconciliationInputPaths.figmaCurrentPath, 'fc', [{ name: 'Widget/color', value: '#222222' }]);
      writeCodeBaseline(scenario);

      const summary = await handleReconcileRequest(scenario.deps);

      // A real, genuinely produced figma-only-change record (not fabricated).
      const record = summary.run.records.find((r) => r.entityId === 'widget-color');
      assert.ok(record);
      assert.equal(record!.status, 'figma-only-change');

      // The returned runId matches exactly what was actually persisted to disk.
      assert.ok(existsSync(scenario.deps.reconciliationOutputPaths.latestPath));
      const persisted = JSON.parse(readFileSync(scenario.deps.reconciliationOutputPaths.latestPath, 'utf8'));
      assert.equal(persisted.runId, summary.run.runId);

      assert.ok(summary.codeSnapshotId);
    } finally {
      // best-effort cleanup; not asserted
    }
  });

  test('rejects a concurrent run while one is already in flight', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'dashboard-reconcile-concurrent-'));
    const scenario = scaffold(tempRoot);
    writeFileSync(path.join(scenario.tokensDir, 'colors.css'), ':root {\n  --widget-color: #111111;\n}\n', 'utf8');
    writeRegistry(scenario, [{ tokenId: 'widget-color', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/color', cssVariable: '--widget-color', consumedBy: [] }]);
    writeFigma(scenario.deps.reconciliationInputPaths.figmaBaselinePath, 'fb', [{ name: 'Widget/color', value: '#111111' }]);
    writeFigma(scenario.deps.reconciliationInputPaths.figmaCurrentPath, 'fc', [{ name: 'Widget/color', value: '#111111' }]);
    writeCodeBaseline(scenario);

    // A deliberately slow refreshFigma opens a window for a second call to land while the first is still running.
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    scenario.deps.refreshFigma = async () => {
      await gate;
      return { ok: true, snapshotId: null };
    };

    assert.equal(isReconcileRunInFlight(), false);
    const firstRun = handleReconcileRequest(scenario.deps);
    assert.equal(isReconcileRunInFlight(), true);

    await assert.rejects(() => handleReconcileRequest(scenario.deps), ReconcileAlreadyRunningError);

    releaseFirst();
    await firstRun;
    assert.equal(isReconcileRunInFlight(), false);
  });

  test('a code refresh failure produces a clear error and never persists a run', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'dashboard-reconcile-codefail-'));
    const scenario = scaffold(tempRoot);
    writeRegistry(scenario, []);
    writeFigma(scenario.deps.reconciliationInputPaths.figmaBaselinePath, 'fb', []);
    writeFigma(scenario.deps.reconciliationInputPaths.figmaCurrentPath, 'fc', []);
    writeCodeBaseline(scenario);

    scenario.deps.refreshCode = () => {
      throw new Error('simulated code refresh failure');
    };

    await assert.rejects(() => handleReconcileRequest(scenario.deps), DashboardReconcileError);
    assert.equal(existsSync(scenario.deps.reconciliationOutputPaths.latestPath), false);
    assert.equal(isReconcileRunInFlight(), false); // lock released even on failure
  });

  test('a Figma refresh failure produces a clear error and never persists a run', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'dashboard-reconcile-figmafail-'));
    const scenario = scaffold(tempRoot);
    writeRegistry(scenario, []);
    writeFigma(scenario.deps.reconciliationInputPaths.figmaBaselinePath, 'fb', []);
    writeFigma(scenario.deps.reconciliationInputPaths.figmaCurrentPath, 'fc', []);
    writeCodeBaseline(scenario);

    scenario.deps.refreshFigma = async () => ({ ok: false, message: 'Could not reach the Figma Dev Mode MCP Server (simulated).' });

    await assert.rejects(() => handleReconcileRequest(scenario.deps), DashboardReconcileError);
    assert.equal(existsSync(scenario.deps.reconciliationOutputPaths.latestPath), false);
  });
});
