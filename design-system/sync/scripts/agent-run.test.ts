import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  runAgentForFinding,
  createMockReasoner,
  applyEditToFile,
  validateProposedEdit,
  hasPriorFailedAttempt,
  computeAuditId,
  isEquivalentLengthValue,
  verifyResolution,
  type AgentRunDeps,
  type AgentAuditRecord,
  type ValidationStepResult,
} from './agent-run.ts';
import type { PolicyDecision } from './agent-policy-types.ts';
import { loadReconciliationInputs, buildReconciliationRun, persistReconciliationRun, type ReconcileInputPaths, type ReconciliationOutputPaths } from './reconcile.ts';
import { reconcileSnapshots } from './reconcile-compare.ts';
import { buildCodeSnapshot, writeCodeSnapshotFile } from './code-snapshot.ts';
import type { ReconciliationRecord, ReconciliationRun } from './reconcile-types.ts';

// =======================================================================
// Isolated fixture scaffolding. Never the real repository: every path
// below lives under a fresh mkdtempSync() directory, removed in `after`.
// =======================================================================

interface ScenarioPaths {
  tempRoot: string;
  componentsDir: string;
  tokensDir: string;
  reconciliationInputPaths: ReconcileInputPaths;
  reconciliationOutputPaths: ReconciliationOutputPaths;
  agentHistoryPaths: { recordsDir: string; latestPath: string };
}

function scaffoldScenarioPaths(tempRoot: string): ScenarioPaths {
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
    reconciliationInputPaths: {
      registryPath: path.join(fixturesDir, 'registry.json'),
      manifestPath: path.join(fixturesDir, 'manifest.json'),
      figmaBaselinePath: path.join(fixturesDir, 'figma-baseline.json'),
      figmaCurrentPath: path.join(fixturesDir, 'figma-current.json'),
      codeBaselinePath: path.join(fixturesDir, 'code-baseline.json'),
      codeCurrentPath: path.join(fixturesDir, 'code-current.json'),
    },
    reconciliationOutputPaths: {
      recordsDir: path.join(tempRoot, 'reconciliation', 'records'),
      latestPath: path.join(tempRoot, 'reconciliation', 'latest.json'),
    },
    agentHistoryPaths: {
      recordsDir: path.join(tempRoot, 'agent-history', 'records'),
      latestPath: path.join(tempRoot, 'agent-history', 'latest.json'),
    },
  };
}

function writeRegistryFixture(scenario: ScenarioPaths, tokens: Record<string, unknown>[]): void {
  writeFileSync(
    scenario.reconciliationInputPaths.registryPath,
    JSON.stringify({ registryUpdatedOn: '2026-01-01', components: [], tokens, textStyles: [], unresolved: [] }),
    'utf8',
  );
  writeFileSync(scenario.reconciliationInputPaths.manifestPath, JSON.stringify({ source: { extractedOn: '2026-01-01' } }), 'utf8');
}

function writeFigmaFixture(filePath: string, snapshotId: string, variables: { name: string; value: string }[]): void {
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

/** Builds the CodeSnapshot from the REAL, current fixture source files (never hand-authored JSON), matching what the real sync:code-check CLI does internally, and writes it to the given output path. */
function buildAndWriteCodeSnapshot(scenario: ScenarioPaths, outputPath: string): void {
  const snapshot = buildCodeSnapshot({ componentsDir: scenario.componentsDir, rootForRelativePaths: scenario.tempRoot, tokensDir: scenario.tokensDir });
  writeCodeSnapshotFile(outputPath, snapshot);
}

/** Rebuilds the reconciliation "before" run genuinely — through loadReconciliationInputs()+reconcileSnapshots()+buildReconciliationRun(), never a hand-fabricated ReconciliationRecord. */
function reconcileAndPersist(scenario: ScenarioPaths, generatedAt: string): ReconciliationRun {
  const input = loadReconciliationInputs(scenario.reconciliationInputPaths);
  const records = reconcileSnapshots(input);
  const run = buildReconciliationRun(input, records, generatedAt);
  persistReconciliationRun(run, scenario.reconciliationOutputPaths);
  return run;
}

/** Test-scoped validation levels 1-2: real, meaningful checks appropriate to a bare token-CSS-only fixture (no package.json/tsc/vite/storybook exist in it) — never a fake "always passes". Levels 3-4 are honestly marked not-applicable-to-this-fixture rather than pretending to run a full build. */
function makeFixtureValidators(scenario: ScenarioPaths, tokensCssPath: string, expectedValue: string, cssVariable = '--widget-color') {
  const runLevel1 = (): ValidationStepResult => {
    const content = readFileSync(tokensCssPath, 'utf8');
    const passed = /^\s*:root\s*\{[\s\S]*\}\s*$/.test(content.trim());
    return { level: 1, command: 'fixture: CSS root-block syntax sanity check', passed };
  };
  const runLevel2 = (): ValidationStepResult => {
    const snapshot = buildCodeSnapshot({ componentsDir: scenario.componentsDir, rootForRelativePaths: scenario.tempRoot, tokensDir: scenario.tokensDir });
    const def = snapshot.tokenDefinitions.find((t) => t.cssVariable === cssVariable);
    const passed = def?.value === expectedValue;
    return { level: 2, command: 'fixture: buildCodeSnapshot() re-extracts the expected value', passed };
  };
  const runLevel3 = (): ValidationStepResult => ({ level: 3, command: 'fixture: full build not applicable (no package.json in this fixture)', passed: true });
  const runLevel4 = (): ValidationStepResult => ({ level: 4, command: 'fixture: Storybook build not applicable (no Storybook config in this fixture)', passed: true });
  return { runLevel1, runLevel2, runLevel3, runLevel4 };
}

function makeDeps(scenario: ScenarioPaths, tokensCssPath: string, expectedAfterValue: string, reasonerAfterValue: string | null, cssVariable = '--widget-color'): AgentRunDeps {
  const validators = makeFixtureValidators(scenario, tokensCssPath, expectedAfterValue, cssVariable);
  return {
    rootDir: scenario.tempRoot,
    reconciliationInputPaths: scenario.reconciliationInputPaths,
    reconciliationOutputPaths: scenario.reconciliationOutputPaths,
    agentHistoryPaths: scenario.agentHistoryPaths,
    reasoner: createMockReasoner(reasonerAfterValue ?? expectedAfterValue),
    runLevel1: validators.runLevel1,
    runLevel2: validators.runLevel2,
    runLevel3: validators.runLevel3,
    runLevel4: validators.runLevel4,
    refreshCodeSnapshot: () => buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeCurrentPath),
    reRunReconciliation: (generatedAt: string) => reconcileAndPersist(scenario, generatedAt),
  };
}

function findRecordByEntityId(run: ReconciliationRun, entityId: string): ReconciliationRecord {
  const record = run.records.find((r) => r.entityId === entityId);
  assert.ok(record, `expected a reconciliation record for entityId "${entityId}"`);
  return record as ReconciliationRecord;
}

// =======================================================================
// Part 12 — the isolated end-to-end test. Every discrepancy below emerges
// from the real reconciliation machinery (loadReconciliationInputs +
// reconcileSnapshots), never a hand-fabricated ReconciliationRecord.
// =======================================================================

describe('agent-run.ts — isolated end-to-end (Part 12)', () => {
  test('a genuine figma-only-change resolves through the full lifecycle: policy -> targeting -> mock reasoning -> edit -> validation -> re-snapshot -> re-reconciliation -> verification -> audit', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-run-e2e-'));
    try {
      const scenario = scaffoldScenarioPaths(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'colors.css');

      // Real source: one raw-literal token declaration, no alias, no component.
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #111111;\n}\n', 'utf8');

      writeRegistryFixture(scenario, [
        {
          tokenId: 'widget-color',
          sourceType: 'figma-variable',
          figmaName: 'Mapped/Widget/color',
          cssVariable: '--widget-color',
          consumedBy: [],
        },
      ]);

      // Figma drifted (baseline #111111 -> current #222222); code has not.
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaBaselinePath, 'figma-baseline', [{ name: 'Widget/color', value: '#111111' }]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaCurrentPath, 'figma-current', [{ name: 'Widget/color', value: '#222222' }]);

      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeBaselinePath);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeCurrentPath);

      const beforeRun = reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');
      const targetedRecordBefore = findRecordByEntityId(beforeRun, 'widget-color');
      assert.equal(targetedRecordBefore.status, 'figma-only-change', 'the discrepancy must be a genuine figma-only-change, produced by real reconciliation machinery');

      const originalFileContent = readFileSync(tokensCssPath, 'utf8');
      const deps = makeDeps(scenario, tokensCssPath, '#222222', null);

      const audit = await runAgentForFinding(targetedRecordBefore.reconciliationId, deps, '2026-01-02T00:00:00.000Z');

      // 1-3. Exactly one file changed, exactly one declaration, the intended value applied.
      assert.deepEqual(audit.filesModified, ['src/tokens/colors.css']);
      const finalContent = readFileSync(tokensCssPath, 'utf8');
      assert.match(finalContent, /--widget-color:\s*#222222;/);
      assert.equal((finalContent.match(/--widget-color:/g) ?? []).length, 1);
      assert.notEqual(finalContent, originalFileContent);

      // 4. No baseline was modified.
      const baselineAfter = JSON.parse(readFileSync(scenario.reconciliationInputPaths.codeBaselinePath, 'utf8'));
      assert.equal(baselineAfter.tokenDefinitions.find((t: { cssVariable: string }) => t.cssVariable === '--widget-color').value, '#111111');

      // 5. Validation levels 1-4 executed.
      const levels1to4 = audit.validation.filter((v) => v.level <= 4);
      assert.deepEqual(levels1to4.map((v) => v.level), [1, 2, 3, 4]);
      assert.ok(levels1to4.every((v) => v.passed));

      // 6. Code snapshot current state was refreshed.
      const codeCurrentAfter = JSON.parse(readFileSync(scenario.reconciliationInputPaths.codeCurrentPath, 'utf8'));
      assert.equal(codeCurrentAfter.tokenDefinitions.find((t: { cssVariable: string }) => t.cssVariable === '--widget-color').value, '#222222');

      // 7. A new reconciliation run was produced.
      assert.ok(audit.reconciliationAfterRunId);
      assert.notEqual(audit.reconciliationAfterRunId, beforeRun.runId);
      assert.ok(existsSync(scenario.reconciliationOutputPaths.latestPath));

      // 8. The original finding resolved (code now matches Figma's current value).
      assert.equal(audit.findingAfter, 'resolved');

      // 9. No unrelated findings appeared (only the targeted token had any record at all in this minimal fixture).
      const afterRun: ReconciliationRun = JSON.parse(readFileSync(scenario.reconciliationOutputPaths.latestPath, 'utf8'));
      const otherRecords = afterRun.records.filter((r) => r.entityId !== 'widget-color');
      assert.deepEqual(otherRecords, []);

      // 10-13. Audit record exists, references the correct run/finding, has before/after.
      assert.ok(existsSync(scenario.agentHistoryPaths.latestPath));
      const persistedAudit: AgentAuditRecord = JSON.parse(readFileSync(scenario.agentHistoryPaths.latestPath, 'utf8'));
      assert.equal(persistedAudit.auditId, audit.auditId);
      assert.equal(audit.reconciliationRunId, beforeRun.runId);
      assert.equal(audit.reconciliationId, targetedRecordBefore.reconciliationId);
      assert.deepEqual(audit.change, { before: '#111111', after: '#222222' });

      // 14. filesModified contains exactly one file.
      assert.equal(audit.filesModified.length, 1);

      // 15. outcome is applied.
      assert.equal(audit.outcome, 'applied');

      // 16. The agent stops after one edit — no second reconciliationId was ever passed, and this single call only ever wrote one file (already asserted above).
      const recordFiles = readdirSync(scenario.agentHistoryPaths.recordsDir);
      assert.equal(recordFiles.length, 1);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  // Stage 6E — Test 8: the same real lifecycle as above, but for a
  // length-valued token where Stage 5's own exact-string comparison
  // produces `both-changed-conflict` after a genuinely correct edit
  // (Figma resolves to "24"; Code's raw literal is "24px") — this is the
  // exact representational gap Stage 6D's real proof hit. Proves the
  // Stage 6E verification normalization (not reconcile-compare.ts, which
  // is never touched) is what turns this into `outcome: 'applied'`.
  test('Stage 6E: a figma-only-change to a px-length token resolves via verification normalization, not an exact string match', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-run-e2e-length-'));
    try {
      const scenario = scaffoldScenarioPaths(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'typography.css');

      // Real source: one raw-literal length token, already establishing the px convention.
      writeFileSync(tokensCssPath, ':root {\n  --widget-length: 20px;\n}\n', 'utf8');

      writeRegistryFixture(scenario, [
        {
          tokenId: 'widget-length',
          sourceType: 'figma-variable',
          figmaName: 'Mapped/Widget/length',
          cssVariable: '--widget-length',
          consumedBy: [],
        },
      ]);

      // Figma drifted (baseline "20" -> current "24", unitless — Figma's own representation); code has not.
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaBaselinePath, 'figma-baseline-len', [{ name: 'Widget/length', value: '20' }]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaCurrentPath, 'figma-current-len', [{ name: 'Widget/length', value: '24' }]);

      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeBaselinePath);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeCurrentPath);

      const beforeRun = reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');
      const targetedRecordBefore = findRecordByEntityId(beforeRun, 'widget-length');
      assert.equal(targetedRecordBefore.status, 'figma-only-change');

      // The mock reasoner proposes "24px" — matching the file's own established px convention.
      const deps = makeDeps(scenario, tokensCssPath, '24px', null, '--widget-length');

      const audit = await runAgentForFinding(targetedRecordBefore.reconciliationId, deps, '2026-01-02T00:00:00.000Z');

      // Confirm Stage 5's OWN comparison really did land on both-changed-conflict
      // (exact string "24" !== "24px") — i.e. this test is genuinely exercising
      // the representational gap, not something that would have resolved anyway.
      const afterRun: ReconciliationRun = JSON.parse(readFileSync(scenario.reconciliationOutputPaths.latestPath, 'utf8'));
      const afterRecord = afterRun.records.find((r) => r.entityId === 'widget-length');
      assert.ok(afterRecord, 'expected the targeted record to still be present in the after-run');
      assert.equal(afterRecord!.status, 'both-changed-conflict', 'Stage 5\'s exact-string comparison must still call this a conflict — reconcile-compare.ts is unmodified');
      assert.equal(afterRecord!.figma?.current, '24');
      assert.equal(afterRecord!.code?.current, '24px');

      // Exactly one file, one declaration, edited.
      assert.deepEqual(audit.filesModified, ['src/tokens/typography.css']);
      assert.match(readFileSync(tokensCssPath, 'utf8'), /--widget-length:\s*24px;/);

      // The Stage 6E verification layer recognizes the equivalence and does NOT roll back.
      assert.equal(audit.findingAfter, 'resolved');
      assert.equal(audit.outcome, 'applied');
      assert.deepEqual(audit.change, { before: '20px', after: '24px' });

      // No unrelated findings in this minimal fixture.
      const otherRecords = afterRun.records.filter((r) => r.entityId !== 'widget-length');
      assert.deepEqual(otherRecords, []);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// =======================================================================
// Part 13 — BLOCKED / REVIEW / no-SAFE / previously-failed.
// =======================================================================

describe('agent-run.ts — BLOCKED / REVIEW / no-SAFE / previously-failed (Part 13)', () => {
  test('A. a BLOCKED finding: zero writes, reasoner never invoked, audit record written, outcome = blocked', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-run-blocked-'));
    try {
      const scenario = scaffoldScenarioPaths(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'colors.css');
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #111111;\n}\n', 'utf8');

      writeRegistryFixture(scenario, [
        { tokenId: 'widget-color', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/color', cssVariable: '--widget-color', consumedBy: [] },
      ]);
      // Both sides changed, to DIFFERENT values -> both-changed-conflict -> BLOCKED.
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaBaselinePath, 'figma-baseline', [{ name: 'Widget/color', value: '#111111' }]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaCurrentPath, 'figma-current', [{ name: 'Widget/color', value: '#222222' }]);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeBaselinePath);
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #333333;\n}\n', 'utf8');
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeCurrentPath);

      const beforeRun = reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');
      const record = findRecordByEntityId(beforeRun, 'widget-color');
      assert.equal(record.status, 'both-changed-conflict');

      let reasonerCalled = false;
      const deps = makeDeps(scenario, tokensCssPath, '#222222', '#222222');
      deps.reasoner = (ctx) => {
        reasonerCalled = true;
        return { filePath: ctx.editTarget.filePath, declarationIdentifier: ctx.editTarget.declarationIdentifier, before: ctx.editTarget.currentValue, after: '#222222', rationale: 'should never run' };
      };

      const contentBefore = readFileSync(tokensCssPath, 'utf8');
      const audit = await runAgentForFinding(record.reconciliationId, deps, '2026-01-02T00:00:00.000Z');

      assert.equal(reasonerCalled, false);
      assert.equal(readFileSync(tokensCssPath, 'utf8'), contentBefore);
      assert.equal(audit.outcome, 'blocked');
      assert.equal(audit.policyDecision.verdict, 'BLOCKED');
      assert.deepEqual(audit.filesModified, []);
      assert.ok(existsSync(scenario.agentHistoryPaths.latestPath));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('B. a REVIEW finding: zero writes, no proposed edit applied, audit records why human approval is required', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-run-review-'));
    try {
      const scenario = scaffoldScenarioPaths(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'colors.css');
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #111111;\n}\n', 'utf8');

      writeRegistryFixture(scenario, [
        { tokenId: 'widget-color', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/color', cssVariable: '--widget-color', consumedBy: [] },
      ]);
      // Figma unchanged, code changed -> code-only-change -> REVIEW.
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaBaselinePath, 'figma-baseline', [{ name: 'Widget/color', value: '#111111' }]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaCurrentPath, 'figma-current', [{ name: 'Widget/color', value: '#111111' }]);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeBaselinePath);
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #333333;\n}\n', 'utf8');
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeCurrentPath);

      const beforeRun = reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');
      const record = findRecordByEntityId(beforeRun, 'widget-color');
      assert.equal(record.status, 'code-only-change');

      const contentBefore = readFileSync(tokensCssPath, 'utf8');
      const deps = makeDeps(scenario, tokensCssPath, '#111111', '#111111');
      const audit = await runAgentForFinding(record.reconciliationId, deps, '2026-01-02T00:00:00.000Z');

      assert.equal(readFileSync(tokensCssPath, 'utf8'), contentBefore);
      assert.deepEqual(audit.filesModified, []);
      assert.equal(audit.policyDecision.verdict, 'REVIEW');
      assert.equal(audit.policyDecision.requiresHumanApproval, true);
      assert.ok(audit.stopReason.length > 0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('C. no SAFE findings: zero writes, reasoner never invoked, reports no safe action', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-run-nosafe-'));
    try {
      const scenario = scaffoldScenarioPaths(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'colors.css');
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #111111;\n}\n', 'utf8');

      writeRegistryFixture(scenario, [
        { tokenId: 'widget-color', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/color', cssVariable: '--widget-color', consumedBy: [] },
      ]);
      // Nothing changed anywhere -> zero records -> nothing SAFE to select.
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaBaselinePath, 'figma-baseline', [{ name: 'Widget/color', value: '#111111' }]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaCurrentPath, 'figma-current', [{ name: 'Widget/color', value: '#111111' }]);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeBaselinePath);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeCurrentPath);

      const beforeRun = reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');
      assert.deepEqual(beforeRun.records, []);

      let reasonerCalled = false;
      const deps = makeDeps(scenario, tokensCssPath, '#222222', '#222222');
      deps.reasoner = () => {
        reasonerCalled = true;
        throw new Error('should never be called');
      };

      // Mirrors main()'s own "no id given" listing path: classify everything in the run and confirm none are SAFE.
      await assert.rejects(() => runAgentForFinding('nonexistent-id', deps, '2026-01-02T00:00:00.000Z'));
      assert.equal(reasonerCalled, false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('D. a previously-failed finding: prior failure detected, zero writes, no automatic retry', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-run-prior-failure-'));
    try {
      const scenario = scaffoldScenarioPaths(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'colors.css');
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #111111;\n}\n', 'utf8');

      writeRegistryFixture(scenario, [
        { tokenId: 'widget-color', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/color', cssVariable: '--widget-color', consumedBy: [] },
      ]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaBaselinePath, 'figma-baseline', [{ name: 'Widget/color', value: '#111111' }]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaCurrentPath, 'figma-current', [{ name: 'Widget/color', value: '#222222' }]);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeBaselinePath);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeCurrentPath);

      const beforeRun = reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');
      const record = findRecordByEntityId(beforeRun, 'widget-color');
      assert.equal(record.status, 'figma-only-change');

      // First attempt: force a validation failure deliberately (level 1 always fails), so a "failed-validation" audit record exists.
      const failingDeps = makeDeps(scenario, tokensCssPath, '#222222', '#222222');
      failingDeps.runLevel1 = () => ({ level: 1, command: 'fixture: deliberately failing check', passed: false });
      const firstAudit = await runAgentForFinding(record.reconciliationId, failingDeps, '2026-01-02T00:00:00.000Z');
      assert.equal(firstAudit.outcome, 'failed-validation');
      assert.equal(readFileSync(tokensCssPath, 'utf8'), ':root {\n  --widget-color: #111111;\n}\n', 'the failed edit must have been reverted');

      // Second attempt, same reconciliationId, now with working validators: must still refuse automatically.
      let reasonerCalled = false;
      const secondDeps = makeDeps(scenario, tokensCssPath, '#222222', '#222222');
      secondDeps.reasoner = () => {
        reasonerCalled = true;
        throw new Error('should never be called — prior failure must block automatic retry');
      };
      assert.equal(hasPriorFailedAttempt(scenario.agentHistoryPaths.recordsDir, record.reconciliationId), true);

      const secondAudit = await runAgentForFinding(record.reconciliationId, secondDeps, '2026-01-03T00:00:00.000Z');
      assert.equal(reasonerCalled, false);
      assert.equal(secondAudit.outcome, 'no-safe-action');
      assert.equal(readFileSync(tokensCssPath, 'utf8'), ':root {\n  --widget-color: #111111;\n}\n');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// =======================================================================
// Small unit tests for the standalone pure/near-pure helpers.
// =======================================================================

describe('applyEditToFile', () => {
  test('replaces exactly one declaration and verifies the result', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-apply-edit-'));
    try {
      const filePath = path.join(tempRoot, 'tokens.css');
      writeFileSync(filePath, ':root {\n  --a: 1px;\n  --b: 2px;\n}\n', 'utf8');
      const result = applyEditToFile(filePath, '--a', '1px', '5px');
      assert.equal(result.applied, true);
      const content = readFileSync(filePath, 'utf8');
      assert.match(content, /--a:\s*5px;/);
      assert.match(content, /--b:\s*2px;/); // untouched
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('refuses and does not write when the expected current value is not found', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-apply-edit-mismatch-'));
    try {
      const filePath = path.join(tempRoot, 'tokens.css');
      const original = ':root {\n  --a: 1px;\n}\n';
      writeFileSync(filePath, original, 'utf8');
      const result = applyEditToFile(filePath, '--a', '999px', '5px');
      assert.equal(result.applied, false);
      assert.equal(readFileSync(filePath, 'utf8'), original);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('refuses when the same declaration+value appears more than once', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-apply-edit-ambiguous-'));
    try {
      const filePath = path.join(tempRoot, 'tokens.css');
      const original = ':root {\n  --a: 1px;\n}\n.other {\n  --a: 1px;\n}\n';
      writeFileSync(filePath, original, 'utf8');
      const result = applyEditToFile(filePath, '--a', '1px', '5px');
      assert.equal(result.applied, false);
      assert.equal(readFileSync(filePath, 'utf8'), original);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('validateProposedEdit', () => {
  const target = { filePath: 'src/tokens/colors.css', kind: 'css-custom-property-value' as const, declarationIdentifier: '--a', currentValue: '1px' };

  test('accepts a proposal matching the target exactly', () => {
    const result = validateProposedEdit({ filePath: target.filePath, declarationIdentifier: target.declarationIdentifier, before: '1px', after: '2px', rationale: 'x' }, target);
    assert.equal(result.valid, true);
  });

  test('rejects a different file path', () => {
    const result = validateProposedEdit({ filePath: 'src/tokens/other.css', declarationIdentifier: target.declarationIdentifier, before: '1px', after: '2px', rationale: 'x' }, target);
    assert.equal(result.valid, false);
  });

  test('rejects a mismatched before-value', () => {
    const result = validateProposedEdit({ filePath: target.filePath, declarationIdentifier: target.declarationIdentifier, before: 'WRONG', after: '2px', rationale: 'x' }, target);
    assert.equal(result.valid, false);
  });

  test('rejects a no-op proposal', () => {
    const result = validateProposedEdit({ filePath: target.filePath, declarationIdentifier: target.declarationIdentifier, before: '1px', after: '1px', rationale: 'x' }, target);
    assert.equal(result.valid, false);
  });
});

describe('computeAuditId', () => {
  test('is deterministic and independent of generatedAt (generatedAt is not part of the hashed shape)', () => {
    const base = {
      reconciliationRunId: 'r1',
      reconciliationId: 'f1',
      findingBefore: {} as ReconciliationRecord,
      policyDecision: {
        reconciliationId: 'f1',
        status: 'figma-only-change',
        verdict: 'SAFE',
        reason: 'x',
        requiredEvidence: [],
        requiredValidationLevels: [1],
        requiresHumanApproval: false,
      } satisfies PolicyDecision,
      editTarget: null,
      filesInspected: [],
      filesModified: [],
      change: null,
      validation: [],
      reconciliationAfterRunId: null,
      findingAfter: 'unresolved' as const,
      outcome: 'no-safe-action' as const,
      stopReason: 'x',
    };
    assert.equal(computeAuditId(base), computeAuditId(base));
  });
});

// =======================================================================
// Stage 6E — narrow, deterministic, verification-only normalization.
// isEquivalentLengthValue is pure, so it's tested directly rather than
// only through the full E2E lifecycle (which Test 8 above already
// covers). See agent-run.ts's own Stage 6E header comment for the full
// rationale/boundaries this function must respect.
// =======================================================================

describe('isEquivalentLengthValue (Stage 6E)', () => {
  test('Test 1 — a Figma unitless number is equivalent to Code\'s px literal when the prior value already establishes the px convention', () => {
    assert.equal(isEquivalentLengthValue('24', '24px', '20px'), true);
  });

  test('Test 2 — a unitless declaration (e.g. font-weight) never has px silently appended', () => {
    // priorCodeValue "400" does not itself establish a px convention (no "px" suffix at all) —
    // normalization must not fire, even though every value here looks numeric.
    assert.equal(isEquivalentLengthValue('400', '400px', '400'), false);
    assert.equal(isEquivalentLengthValue('400', '400', '400'), false); // exact matches are handled elsewhere (RESOLVED_OUTCOME_STATUSES), not by this function
  });

  test('Test 3 — an incorrect value remains unresolved (numbers genuinely differ)', () => {
    assert.equal(isEquivalentLengthValue('24', '20px', '20px'), false);
  });

  test('Test 4 — a var() alias is never treated as equivalent', () => {
    assert.equal(isEquivalentLengthValue('24', 'var(--some-token)', '20px'), false);
    assert.equal(isEquivalentLengthValue('24', 'var(--some-token)', 'var(--some-token)'), false);
  });

  test('Test 5 — non-length values (colors, font stacks) are never normalized', () => {
    assert.equal(isEquivalentLengthValue('#8a38f5', '#8a38f5', '#111111'), false);
    assert.equal(isEquivalentLengthValue('Inter', "'Inter', sans-serif", "'Inter', sans-serif"), false);
  });

  test('rejects when the CURRENT code value is not a bare px literal (shorthand/expression)', () => {
    assert.equal(isEquivalentLengthValue('24', 'calc(24px + 1px)', '20px'), false);
  });

  test('rejects a non-numeric Figma value even when the code side looks like a valid px literal', () => {
    assert.equal(isEquivalentLengthValue('auto', '24px', '20px'), false);
  });
});

describe('verifyResolution (Stage 6E normalization)', () => {
  function makeTokenValueRecord(opts: {
    reconciliationId: string;
    status: ReconciliationRecord['status'];
    entityId?: string;
    figma?: ReconciliationRecord['figma'];
    code?: ReconciliationRecord['code'];
  }): ReconciliationRecord {
    return {
      reconciliationId: opts.reconciliationId,
      entityType: 'token',
      entityId: opts.entityId ?? 'widget-length',
      registryId: opts.entityId ?? 'widget-length',
      field: 'value',
      status: opts.status,
      figma: opts.figma ?? null,
      code: opts.code ?? null,
      registryExpected: null,
      affectedComponents: [],
      sources: { figmaBaselineId: 'fb', figmaCurrentId: 'fc', codeBaselineId: 'cb', codeCurrentId: 'cc' },
      detail: 'fixture record',
    };
  }

  function makeRun(records: ReconciliationRecord[], runId: string): ReconciliationRun {
    return {
      schemaVersion: '1.0.0',
      runId,
      generatedAt: '2026-01-01T00:00:00.000Z',
      sources: { registrySnapshotId: 'r', registryUpdatedOn: '2026-01-01', figmaBaselineId: 'fb', figmaCurrentId: 'fc', codeBaselineId: 'cb', codeCurrentId: 'cc' },
      recordCount: records.length,
      conflictCount: records.filter((r) => r.status === 'both-changed-conflict').length,
      statusCounts: {} as ReconciliationRun['statusCounts'], // not read by verifyResolution
      warnings: [],
      records,
    };
  }

  test('a both-changed-conflict caused by Figma-unitless vs Code-px is resolved when the prior value proves the px convention', () => {
    const targetedRecordBefore = makeTokenValueRecord({
      reconciliationId: 'f1',
      status: 'figma-only-change',
      figma: { current: '24', baseline: '20', changed: true },
      code: { current: '20px', baseline: '20px', changed: false },
    });
    const beforeRun = makeRun([targetedRecordBefore], 'run-before');
    const afterRecord = makeTokenValueRecord({
      reconciliationId: 'f2', // reconciliationId legitimately differs run-to-run — verifyResolution keys on (entityType, entityId, field), never this field
      status: 'both-changed-conflict',
      figma: { current: '24', baseline: '20', changed: true },
      code: { current: '24px', baseline: '20px', changed: true },
    });
    const afterRun = makeRun([afterRecord], 'run-after');

    const result = verifyResolution(targetedRecordBefore, beforeRun, afterRun);
    assert.equal(result.resolved, true);
    assert.deepEqual(result.newFindings, []);
    assert.deepEqual(result.unrelatedMutations, []);
  });

  test('a both-changed-conflict with a genuinely different numeric value is NOT resolved', () => {
    const targetedRecordBefore = makeTokenValueRecord({
      reconciliationId: 'f1',
      status: 'figma-only-change',
      figma: { current: '24', baseline: '20', changed: true },
      code: { current: '20px', baseline: '20px', changed: false },
    });
    const beforeRun = makeRun([targetedRecordBefore], 'run-before');
    // Simulates a wrong edit (e.g. "25px" instead of "24px").
    const afterRecord = makeTokenValueRecord({
      reconciliationId: 'f2',
      status: 'both-changed-conflict',
      figma: { current: '24', baseline: '20', changed: true },
      code: { current: '25px', baseline: '20px', changed: true },
    });
    const afterRun = makeRun([afterRecord], 'run-after');

    const result = verifyResolution(targetedRecordBefore, beforeRun, afterRun);
    assert.equal(result.resolved, false);
  });

  test('Test 7 — an unrelated new finding is still reported even when the targeted record itself normalizes as resolved', () => {
    const targetedRecordBefore = makeTokenValueRecord({
      reconciliationId: 'f1',
      entityId: 'widget-length',
      status: 'figma-only-change',
      figma: { current: '24', baseline: '20', changed: true },
      code: { current: '20px', baseline: '20px', changed: false },
    });
    const beforeRun = makeRun([targetedRecordBefore], 'run-before');

    const afterTargetRecord = makeTokenValueRecord({
      reconciliationId: 'f2',
      entityId: 'widget-length',
      status: 'both-changed-conflict',
      figma: { current: '24', baseline: '20', changed: true },
      code: { current: '24px', baseline: '20px', changed: true },
    });
    // An unrelated record that did NOT exist in beforeRun — must never be hidden by the targeted record's own resolution.
    const unrelatedNewRecord = makeTokenValueRecord({
      reconciliationId: 'f3',
      entityId: 'some-other-token',
      status: 'code-only-change',
      figma: { current: '#fff', baseline: '#fff', changed: false },
      code: { current: '#000', baseline: '#fff', changed: true },
    });
    const afterRun = makeRun([afterTargetRecord, unrelatedNewRecord], 'run-after');

    const result = verifyResolution(targetedRecordBefore, beforeRun, afterRun);
    assert.equal(result.resolved, true, 'the targeted finding itself did resolve via normalization');
    assert.equal(result.newFindings.length, 1, 'the unrelated new finding must still be reported, never hidden');
    assert.equal(result.newFindings[0].entityId, 'some-other-token');
  });

  test('does not normalize a non-token / non-value record even if it happens to be both-changed-conflict', () => {
    const targetedRecordBefore: ReconciliationRecord = {
      reconciliationId: 'f1',
      entityType: 'component',
      entityId: 'widget',
      registryId: 'widget',
      field: 'component',
      status: 'figma-only-change',
      figma: { current: { x: 1 }, baseline: { x: 0 }, changed: true },
      code: { current: { x: 0 }, baseline: { x: 0 }, changed: false },
      registryExpected: null,
      affectedComponents: [],
      sources: { figmaBaselineId: 'fb', figmaCurrentId: 'fc', codeBaselineId: 'cb', codeCurrentId: 'cc' },
      detail: 'fixture record',
    };
    const beforeRun = makeRun([targetedRecordBefore], 'run-before');
    const afterRecord: ReconciliationRecord = {
      ...targetedRecordBefore,
      reconciliationId: 'f2',
      status: 'both-changed-conflict',
      figma: { current: { x: 1 }, baseline: { x: 0 }, changed: true },
      code: { current: { x: 1 }, baseline: { x: 0 }, changed: true },
    };
    const afterRun = makeRun([afterRecord], 'run-after');

    const result = verifyResolution(targetedRecordBefore, beforeRun, afterRun);
    assert.equal(result.resolved, false, 'component records must never go through the token-only length normalization path');
  });
});

