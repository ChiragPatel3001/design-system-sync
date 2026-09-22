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
import { promoteCodeBaselineForToken } from './code-baseline-promote.ts';
import { promoteFigmaBaselineForVariable } from './figma-baseline-promote.ts';
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
    assert.equal(vm.metrics.findings, vm.metrics.safe + vm.metrics.review + vm.metrics.blocked + vm.metrics.unmapped);
  });

  test('never surfaces an out-of-scope-entity or intentional-documented-deviation record as a "finding" (agent-policy.ts classifies both NOT_APPLICABLE)', () => {
    const vm = loadDashboardViewModel(realPaths);
    for (const finding of vm.findings) {
      assert.notEqual(finding.status, 'out-of-scope-entity');
      assert.notEqual(finding.status, 'intentional-documented-deviation');
    }
  });

  test('the real "button" registry-expectation-mismatch finding never carries an editTarget — human-directed resolution (Part 18) is scoped to token-level both-changed-conflict only', () => {
    const vm = loadDashboardViewModel(realPaths);
    const button = vm.findings.find((f) => f.entityId === 'button' && f.status === 'registry-expectation-mismatch');
    assert.ok(button, 'expected the real repository to still have its known "button" registry-expectation-mismatch finding');
    assert.equal(button!.entityType, 'component');
    assert.equal(button!.editTarget, null);
  });

  test('a non-SAFE finding only ever carries a non-null editTarget when it is a token-level both-changed-conflict (Part 18) — never for any other status', () => {
    const vm = loadDashboardViewModel(realPaths);
    for (const finding of vm.findings) {
      if (finding.policyVerdict !== 'SAFE' && finding.editTarget !== null) {
        assert.equal(finding.entityType, 'token');
        assert.equal(finding.status, 'both-changed-conflict');
      }
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
      assert.deepEqual(vm.metrics, { findings: 0, safe: 0, review: 0, blocked: 0, unmapped: 0 });
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
  test('a genuine figma-only-change is surfaced as a SAFE finding with a resolved editTarget; an unmapped Figma entity is surfaced as BLOCKED (policyVerdict unchanged) but counted in metrics.unmapped, not metrics.blocked', () => {
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
      // The only BLOCKED-verdict finding here is unmapped-figma-entity (a
      // coverage gap), so it must land in metrics.unmapped, not metrics.blocked.
      assert.equal(vm.metrics.blocked, 0);
      assert.equal(vm.metrics.unmapped, 1);

      const safeFinding = vm.findings.find((f) => f.policyVerdict === 'SAFE');
      assert.ok(safeFinding);
      assert.equal(safeFinding!.entityId, 'widget-color');
      assert.equal(safeFinding!.status, 'figma-only-change');
      assert.ok(safeFinding!.editTarget);
      assert.equal(safeFinding!.editTarget!.declarationIdentifier, '--widget-color');

      // policyVerdict itself is untouched by the display-layer split — this
      // finding is still, honestly, 'BLOCKED' per agent-policy.ts.
      const blockedFinding = vm.findings.find((f) => f.policyVerdict === 'BLOCKED');
      assert.ok(blockedFinding);
      assert.equal(blockedFinding!.status, 'unmapped-figma-entity');
      assert.equal(blockedFinding!.editTarget, null);

      // Sort order: SAFE first.
      assert.equal(vm.findings[0].policyVerdict, 'SAFE');

      // registryPath is the absolute registry.json path used by this
      // fixture's own reconciliationInputPaths — a display-only
      // pass-through, never read/written by loadDashboardViewModel itself.
      assert.equal(vm.registryPath, scenario.loaderPaths.reconciliationInputPaths.registryPath);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('metrics.blocked and metrics.unmapped are split by status, not merged: a genuinely ambiguous both-changed-conflict counts as blocked; both unmapped-figma-entity cases (Figma-present and Figma-absent) count as unmapped', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'dashboard-loader-metrics-split-'));
    try {
      const scenario = scaffold(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'typography.css');

      // widget-color: figma-only-change -> SAFE.
      // widget-length: both-changed-conflict (Figma "24" vs code "24px", raw
      // string mismatch — the representational-gap case) -> genuinely
      // ambiguous, must stay in metrics.blocked.
      // ghost-token: registry maps to a Figma name never observed in either
      // capture -> unmapped-figma-entity with figma.current null ("Fix mapping").
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #111111;\n  --widget-length: 20px;\n  --ghost-token: 1px;\n}\n', 'utf8');
      writeRegistry(scenario, [
        { tokenId: 'widget-color', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/color', cssVariable: '--widget-color', consumedBy: [] },
        { tokenId: 'widget-length', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/length', cssVariable: '--widget-length', consumedBy: [] },
        { tokenId: 'ghost-token', sourceType: 'figma-variable', figmaName: 'Mapped/Ghost/token', cssVariable: '--ghost-token', consumedBy: [] },
      ]);
      writeFigma(scenario.loaderPaths.reconciliationInputPaths.figmaBaselinePath, 'fb', [
        { name: 'Widget/color', value: '#111111' },
        { name: 'Widget/length', value: '20' },
      ]);
      // "Unmapped/thing" is a real Figma variable no registry token
      // normalizes to -> unmapped-figma-entity with figma.current PRESENT
      // ("Add to registry"). "Ghost/token" never appears here or in the
      // baseline at all, matching registry's expectation of it.
      writeFigma(scenario.loaderPaths.reconciliationInputPaths.figmaCurrentPath, 'fc', [
        { name: 'Widget/color', value: '#222222' },
        { name: 'Widget/length', value: '24' },
        { name: 'Unmapped/thing', value: '#333333' },
      ]);

      buildAndWriteCode(scenario, scenario.loaderPaths.reconciliationInputPaths.codeBaselinePath);
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #111111;\n  --widget-length: 24px;\n  --ghost-token: 1px;\n}\n', 'utf8');
      buildAndWriteCode(scenario, scenario.loaderPaths.reconciliationInputPaths.codeCurrentPath);

      reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');
      const vm = loadDashboardViewModel(scenario.loaderPaths);

      assert.equal(vm.metrics.findings, 4);
      assert.equal(vm.metrics.safe, 1);
      assert.equal(vm.metrics.review, 0);
      assert.equal(vm.metrics.blocked, 1, 'only the genuinely ambiguous both-changed-conflict finding counts as blocked');
      assert.equal(vm.metrics.unmapped, 2, 'both unmapped-figma-entity findings (Figma-present and Figma-absent) count as unmapped, not blocked');

      const conflictFinding = vm.findings.find((f) => f.status === 'both-changed-conflict');
      assert.ok(conflictFinding);
      assert.equal(conflictFinding!.entityId, 'widget-length');
      assert.equal(conflictFinding!.policyVerdict, 'BLOCKED');

      const unmappedFindings = vm.findings.filter((f) => f.status === 'unmapped-figma-entity');
      assert.equal(unmappedFindings.length, 2);
      assert.ok(unmappedFindings.every((f) => f.policyVerdict === 'BLOCKED'), 'unmapped-figma-entity findings keep policyVerdict BLOCKED — only the display bucket changes');

      const figmaPresentCase = unmappedFindings.find((f) => f.entityId === 'Unmapped/thing');
      assert.ok(figmaPresentCase);
      assert.notEqual(figmaPresentCase!.figma, null);
      assert.notEqual(figmaPresentCase!.figma!.current, null);

      const figmaAbsentCase = unmappedFindings.find((f) => f.entityId === 'ghost-token');
      assert.ok(figmaAbsentCase);
      assert.equal(figmaAbsentCase!.figma?.current, null);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('loadDashboardViewModel — human-directed resolution eligibility (Part 18)', () => {
  test('a token-level both-changed-conflict finding carries a non-null editTarget (Resolve is eligible), even though policyVerdict is honestly BLOCKED', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'dashboard-loader-conflict-edittarget-'));
    try {
      const scenario = scaffold(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'typography.css');
      writeFileSync(tokensCssPath, ':root {\n  --widget-length: 20px;\n}\n', 'utf8');
      writeRegistry(scenario, [{ tokenId: 'widget-length', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/length', cssVariable: '--widget-length', consumedBy: [] }]);
      writeFigma(scenario.loaderPaths.reconciliationInputPaths.figmaBaselinePath, 'fb-len', [{ name: 'Widget/length', value: '20' }]);
      writeFigma(scenario.loaderPaths.reconciliationInputPaths.figmaCurrentPath, 'fc-len', [{ name: 'Widget/length', value: '24' }]);
      buildAndWriteCode(scenario, scenario.loaderPaths.reconciliationInputPaths.codeBaselinePath);
      writeFileSync(tokensCssPath, ':root {\n  --widget-length: 30px;\n}\n', 'utf8');
      buildAndWriteCode(scenario, scenario.loaderPaths.reconciliationInputPaths.codeCurrentPath);
      reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');

      const vm = loadDashboardViewModel(scenario.loaderPaths);
      const finding = vm.findings.find((f) => f.entityId === 'widget-length');
      assert.ok(finding);
      assert.equal(finding!.status, 'both-changed-conflict');
      assert.equal(finding!.policyVerdict, 'BLOCKED');
      assert.ok(finding!.editTarget, 'a token-level both-changed-conflict finding must carry a resolvable editTarget for the Resolve UI action');
      assert.equal(finding!.editTarget!.declarationIdentifier, '--widget-length');
      assert.equal(finding!.editTarget!.currentValue, '30px');
      assert.equal(vm.metrics.blocked, 1);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('an unmapped-figma-entity finding never carries an editTarget, even though it is entityType "token" — only both-changed-conflict is eligible', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'dashboard-loader-unmapped-no-edittarget-'));
    try {
      const scenario = scaffold(tempRoot);
      writeFileSync(path.join(scenario.tokensDir, 'colors.css'), ':root {\n  --widget-color: #111111;\n}\n', 'utf8');
      writeRegistry(scenario, [{ tokenId: 'widget-color', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/color', cssVariable: '--widget-color', consumedBy: [] }]);
      writeFigma(scenario.loaderPaths.reconciliationInputPaths.figmaBaselinePath, 'fb', [{ name: 'Widget/color', value: '#111111' }]);
      // "Unmapped/thing" is a real Figma variable no registry token normalizes to -> unmapped-figma-entity.
      writeFigma(scenario.loaderPaths.reconciliationInputPaths.figmaCurrentPath, 'fc', [
        { name: 'Widget/color', value: '#111111' },
        { name: 'Unmapped/thing', value: '#333333' },
      ]);
      buildAndWriteCode(scenario, scenario.loaderPaths.reconciliationInputPaths.codeBaselinePath);
      buildAndWriteCode(scenario, scenario.loaderPaths.reconciliationInputPaths.codeCurrentPath);
      reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');

      const vm = loadDashboardViewModel(scenario.loaderPaths);
      const finding = vm.findings.find((f) => f.entityId === 'Unmapped/thing');
      assert.ok(finding);
      assert.equal(finding!.entityType, 'token');
      assert.equal(finding!.status, 'unmapped-figma-entity');
      assert.equal(finding!.editTarget, null);
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
        promoteCodeBaseline: (cssVariable: string, previousValue: string, newValue: string) => {
          promoteCodeBaselineForToken(
            { codeBaselinePath: scenario.loaderPaths.reconciliationInputPaths.codeBaselinePath, codeArchiveDir: path.join(scenario.tempRoot, 'code-snapshots', 'archive') },
            cssVariable,
            previousValue,
            newValue,
          );
        },
        promoteFigmaBaseline: (variableName: string, previousValue: string, newValue: string) => {
          promoteFigmaBaselineForVariable(
            { figmaBaselinePath: scenario.loaderPaths.reconciliationInputPaths.figmaBaselinePath, figmaArchiveDir: path.join(scenario.tempRoot, 'figma-snapshots', 'archive') },
            variableName,
            previousValue,
            newValue,
          );
        },
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
