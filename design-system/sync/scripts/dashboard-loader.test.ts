import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadDashboardViewModel, type DashboardLoaderPaths } from './dashboard-loader.ts';
import { buildCodeSnapshot, writeCodeSnapshotFile } from './code-snapshot.ts';
import { loadReconciliationInputs, buildReconciliationRun, persistReconciliationRun } from './reconcile.ts';
import { reconcileSnapshots } from './reconcile-compare.ts';
import { runAgentForFinding, createMockReasoner, AGENT_HISTORY_RECORDS_DIR, AGENT_HISTORY_LATEST_PATH, type AgentRunDeps, type ValidationStepResult } from './agent-run.ts';
import { REGISTRY_PATH, MANIFEST_PATH } from './paths.ts';
import { FIGMA_BASELINE_PATH, FIGMA_CURRENT_PATH } from './figma-paths.ts';
import { CODE_BASELINE_PATH, CODE_CURRENT_PATH } from './code-paths.ts';
import { RECONCILIATION_RECORDS_DIR, RECONCILIATION_LATEST_PATH } from './reconcile-paths.ts';

// =======================================================================
// Real-repository read-only tests. Never writes anywhere — loadDashboardViewModel
// has no filesystem-write path at all.
// =======================================================================

describe('loadDashboardViewModel — against the real repository (read-only)', () => {
  const realPaths: DashboardLoaderPaths = {
    reconciliationInputPaths: {
      registryPath: REGISTRY_PATH,
      manifestPath: MANIFEST_PATH,
      figmaBaselinePath: FIGMA_BASELINE_PATH,
      figmaCurrentPath: FIGMA_CURRENT_PATH,
      codeBaselinePath: CODE_BASELINE_PATH,
      codeCurrentPath: CODE_CURRENT_PATH,
    },
    reconciliationOutputPaths: { recordsDir: RECONCILIATION_RECORDS_DIR, latestPath: RECONCILIATION_LATEST_PATH },
    agentHistoryPaths: { recordsDir: AGENT_HISTORY_RECORDS_DIR, latestPath: AGENT_HISTORY_LATEST_PATH },
  };

  test('loads the real, currently-persisted reconciliation run', () => {
    const vm = loadDashboardViewModel(realPaths);
    assert.equal(vm.reconciliation.available, true);
    assert.ok(vm.reconciliation.runId);
    assert.ok(vm.metrics.findings >= 0);
    assert.equal(vm.metrics.findings, vm.metrics.safe + vm.metrics.review + vm.metrics.blocked);
  });

  test('never surfaces an out-of-scope-entity or intentional-documented-deviation record as a "finding" (agent-policy.ts classifies both NOT_APPLICABLE)', () => {
    const vm = loadDashboardViewModel(realPaths);
    for (const finding of vm.findings) {
      assert.notEqual(finding.status, 'out-of-scope-entity');
      assert.notEqual(finding.status, 'intentional-documented-deviation');
    }
  });

  test('only a SAFE finding ever carries a non-null editTarget', () => {
    const vm = loadDashboardViewModel(realPaths);
    for (const finding of vm.findings) {
      if (finding.policyVerdict !== 'SAFE') assert.equal(finding.editTarget, null);
    }
  });
});

// =======================================================================
// Isolated-fixture tests — missing/empty data, and full SAFE/REVIEW/BLOCKED
// classification + agent-run integration.
// =======================================================================

interface ScenarioPaths {
  tempRoot: string;
  componentsDir: string;
  tokensDir: string;
  loaderPaths: DashboardLoaderPaths;
}

function scaffold(tempRoot: string): ScenarioPaths {
  const componentsDir = path.join(tempRoot, 'src', 'components');
  const tokensDir = path.join(tempRoot, 'src', 'tokens');
  mkdirSync(componentsDir, { recursive: true });
  mkdirSync(tokensDir, { recursive: true });
  const fixturesDir = path.join(tempRoot, 'fixtures');
  mkdirSync(fixturesDir, { recursive: true });

  return {
    tempRoot,
    componentsDir,
    tokensDir,
    loaderPaths: {
      reconciliationInputPaths: {
        registryPath: path.join(fixturesDir, 'registry.json'),
        manifestPath: path.join(fixturesDir, 'manifest.json'),
        figmaBaselinePath: path.join(fixturesDir, 'figma-baseline.json'),
        figmaCurrentPath: path.join(fixturesDir, 'figma-current.json'),
        codeBaselinePath: path.join(fixturesDir, 'code-baseline.json'),
        codeCurrentPath: path.join(fixturesDir, 'code-current.json'),
      },
      reconciliationOutputPaths: { recordsDir: path.join(tempRoot, 'reconciliation', 'records'), latestPath: path.join(tempRoot, 'reconciliation', 'latest.json') },
      agentHistoryPaths: { recordsDir: path.join(tempRoot, 'agent-history', 'records'), latestPath: path.join(tempRoot, 'agent-history', 'latest.json') },
    },
  };
}

function writeRegistry(scenario: ScenarioPaths, tokens: Record<string, unknown>[]): void {
  writeFileSync(
    scenario.loaderPaths.reconciliationInputPaths.registryPath,
    JSON.stringify({ registryUpdatedOn: '2026-01-01', components: [], tokens, textStyles: [], unresolved: [] }),
    'utf8',
  );
  writeFileSync(scenario.loaderPaths.reconciliationInputPaths.manifestPath, JSON.stringify({ source: { extractedOn: '2026-01-01' } }), 'utf8');
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

function buildAndWriteCode(scenario: ScenarioPaths, outputPath: string): void {
  const snapshot = buildCodeSnapshot({ componentsDir: scenario.componentsDir, rootForRelativePaths: scenario.tempRoot, tokensDir: scenario.tokensDir });
  writeCodeSnapshotFile(outputPath, snapshot);
}

function reconcileAndPersist(scenario: ScenarioPaths, generatedAt: string) {
  const input = loadReconciliationInputs(scenario.loaderPaths.reconciliationInputPaths);
  const records = reconcileSnapshots(input);
  const run = buildReconciliationRun(input, records, generatedAt);
  persistReconciliationRun(run, scenario.loaderPaths.reconciliationOutputPaths);
  return run;
}

describe('loadDashboardViewModel — missing/empty data (Part 17: "Data")', () => {
  test('a missing latest.json is handled gracefully (no reconciliation run yet)', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'dashboard-loader-missing-'));
    try {
      const scenario = scaffold(tempRoot);
      const vm = loadDashboardViewModel(scenario.loaderPaths);
      assert.equal(vm.reconciliation.available, false);
      assert.deepEqual(vm.findings, []);
      assert.deepEqual(vm.metrics, { findings: 0, safe: 0, review: 0, blocked: 0 });
      assert.equal(vm.systemStatus.tone, 'unknown');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('empty agent history is handled gracefully (no agent runs yet)', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'dashboard-loader-noagent-'));
    try {
      const scenario = scaffold(tempRoot);
      writeFileSync(path.join(scenario.tokensDir, 'colors.css'), ':root {\n  --widget-color: #111111;\n}\n', 'utf8');
      writeRegistry(scenario, []);
      writeFigma(scenario.loaderPaths.reconciliationInputPaths.figmaBaselinePath, 'fb', []);
      writeFigma(scenario.loaderPaths.reconciliationInputPaths.figmaCurrentPath, 'fc', []);
      buildAndWriteCode(scenario, scenario.loaderPaths.reconciliationInputPaths.codeBaselinePath);
      buildAndWriteCode(scenario, scenario.loaderPaths.reconciliationInputPaths.codeCurrentPath);
      reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');

      const vm = loadDashboardViewModel(scenario.loaderPaths);
      assert.equal(vm.reconciliation.available, true);
      assert.deepEqual(vm.agentRuns, []);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('loadDashboardViewModel — SAFE/REVIEW/BLOCKED classification (Part 17: "Policy")', () => {
  test('a genuine figma-only-change is surfaced as a SAFE finding with a resolved editTarget; an unmapped Figma entity is surfaced as BLOCKED with no editTarget', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'dashboard-loader-policy-'));
    try {
      const scenario = scaffold(tempRoot);
      writeFileSync(path.join(scenario.tokensDir, 'colors.css'), ':root {\n  --widget-color: #111111;\n}\n', 'utf8');
      writeRegistry(scenario, [{ tokenId: 'widget-color', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/color', cssVariable: '--widget-color', consumedBy: [] }]);
      writeFigma(scenario.loaderPaths.reconciliationInputPaths.figmaBaselinePath, 'fb', [
        { name: 'Widget/color', value: '#111111' },
      ]);
      // An unmapped Figma variable ("Unmapped/thing") produces a real unmapped-figma-entity -> BLOCKED record.
      writeFigma(scenario.loaderPaths.reconciliationInputPaths.figmaCurrentPath, 'fc', [
        { name: 'Widget/color', value: '#222222' },
        { name: 'Unmapped/thing', value: '#333333' },
      ]);
      buildAndWriteCode(scenario, scenario.loaderPaths.reconciliationInputPaths.codeBaselinePath);
      buildAndWriteCode(scenario, scenario.loaderPaths.reconciliationInputPaths.codeCurrentPath);
      reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');

      const vm = loadDashboardViewModel(scenario.loaderPaths);
      assert.equal(vm.metrics.safe, 1);
      assert.equal(vm.metrics.blocked, 1);

      const safeFinding = vm.findings.find((f) => f.policyVerdict === 'SAFE');
      assert.ok(safeFinding);
      assert.equal(safeFinding!.entityId, 'widget-color');
      assert.equal(safeFinding!.status, 'figma-only-change');
      assert.ok(safeFinding!.editTarget);
      assert.equal(safeFinding!.editTarget!.declarationIdentifier, '--widget-color');

      const blockedFinding = vm.findings.find((f) => f.policyVerdict === 'BLOCKED');
      assert.ok(blockedFinding);
      assert.equal(blockedFinding!.editTarget, null);

      // Sort order: SAFE first.
      assert.equal(vm.findings[0].policyVerdict, 'SAFE');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('loadDashboardViewModel — real agent history integration', () => {
  test('a real agent run (produced by the actual runAgentForFinding pipeline) is surfaced with the correct outcome and validation summary', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'dashboard-loader-agentrun-'));
    try {
      const scenario = scaffold(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'colors.css');
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #111111;\n}\n', 'utf8');
      writeRegistry(scenario, [{ tokenId: 'widget-color', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/color', cssVariable: '--widget-color', consumedBy: [] }]);
      writeFigma(scenario.loaderPaths.reconciliationInputPaths.figmaBaselinePath, 'fb', [{ name: 'Widget/color', value: '#111111' }]);
      writeFigma(scenario.loaderPaths.reconciliationInputPaths.figmaCurrentPath, 'fc', [{ name: 'Widget/color', value: '#222222' }]);
      buildAndWriteCode(scenario, scenario.loaderPaths.reconciliationInputPaths.codeBaselinePath);
      buildAndWriteCode(scenario, scenario.loaderPaths.reconciliationInputPaths.codeCurrentPath);
      const beforeRun = reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');
      const target = beforeRun.records.find((r) => r.entityId === 'widget-color')!;

      const alwaysPass = (level: number, command: string): ValidationStepResult => ({ level, command, passed: true });
      const deps: AgentRunDeps = {
        rootDir: scenario.tempRoot,
        reconciliationInputPaths: scenario.loaderPaths.reconciliationInputPaths,
        reconciliationOutputPaths: scenario.loaderPaths.reconciliationOutputPaths,
        agentHistoryPaths: scenario.loaderPaths.agentHistoryPaths,
        reasoner: createMockReasoner('#222222'),
        runLevel1: () => alwaysPass(1, 'fixture level 1'),
        runLevel2: () => alwaysPass(2, 'fixture level 2'),
        runLevel3: () => alwaysPass(3, 'fixture level 3'),
        runLevel4: () => alwaysPass(4, 'fixture level 4'),
        refreshCodeSnapshot: () => buildAndWriteCode(scenario, scenario.loaderPaths.reconciliationInputPaths.codeCurrentPath),
        reRunReconciliation: (generatedAt: string) => reconcileAndPersist(scenario, generatedAt),
      };

      await runAgentForFinding(target.reconciliationId, deps, '2026-01-02T00:00:00.000Z');

      const vm = loadDashboardViewModel(scenario.loaderPaths);
      assert.equal(vm.agentRuns.length, 1);
      const run = vm.agentRuns[0];
      assert.equal(run.outcome, 'applied');
      assert.equal(run.entityId, 'widget-color');
      assert.equal(run.validationSummary, '6/6 passed'); // levels 1-4 (fixture validators) + 5-6 (refreshCodeSnapshot/reRunReconciliation), matching agent-run.ts's own validation array shape
      assert.deepEqual(run.change, { before: '#111111', after: '#222222' });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
