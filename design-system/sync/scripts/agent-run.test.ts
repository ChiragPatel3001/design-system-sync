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
  AgentError,
  createProductionAgentRunDeps,
  createProductionReconciliationOutputPaths,
  type AgentRunDeps,
  type AgentAuditRecord,
  type ValidationStepResult,
} from './agent-run.ts';
import type { PolicyDecision } from './agent-policy-types.ts';
import { loadReconciliationInputs, buildReconciliationRun, persistReconciliationRun, type ReconcileInputPaths, type ReconciliationOutputPaths } from './reconcile.ts';
import { reconcileSnapshots } from './reconcile-compare.ts';
import { buildCodeSnapshot, writeCodeSnapshotFile } from './code-snapshot.ts';
import { promoteCodeBaselineForToken } from './code-baseline-promote.ts';
import { promoteFigmaBaselineForVariable } from './figma-baseline-promote.ts';
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
  codeArchiveDir: string;
  figmaArchiveDir: string;
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
    codeArchiveDir: path.join(tempRoot, 'code-snapshots', 'archive'),
    figmaArchiveDir: path.join(tempRoot, 'figma-snapshots', 'archive'),
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
    promoteCodeBaseline: (cssVariable: string, previousValue: string, newValue: string) => {
      promoteCodeBaselineForToken(
        { codeBaselinePath: scenario.reconciliationInputPaths.codeBaselinePath, codeArchiveDir: scenario.codeArchiveDir },
        cssVariable,
        previousValue,
        newValue,
      );
    },
    promoteFigmaBaseline: (variableName: string, previousValue: string, newValue: string) => {
      promoteFigmaBaselineForVariable(
        { figmaBaselinePath: scenario.reconciliationInputPaths.figmaBaselinePath, figmaArchiveDir: scenario.figmaArchiveDir },
        variableName,
        previousValue,
        newValue,
      );
    },
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

      // 4. The CODE baseline for this one entity was promoted to the newly
      // applied value (Part 15 / Phase 1) — this run's outcome is
      // 'applied', so this is the intended new behavior, not a leftover
      // pre-Phase-1 assumption. Since this finding is a figma-only-change
      // SAFE apply, the FIGMA baseline is ALSO promoted for the same
      // entity (Part 16 / Phase 2), so both sides converge together.
      assert.equal(audit.codeBaselinePromoted, true);
      assert.equal(audit.figmaBaselinePromoted, true);
      const baselineAfter = JSON.parse(readFileSync(scenario.reconciliationInputPaths.codeBaselinePath, 'utf8'));
      assert.equal(baselineAfter.tokenDefinitions.find((t: { cssVariable: string }) => t.cssVariable === '--widget-color').value, '#222222');
      const figmaBaselineAfter = JSON.parse(readFileSync(scenario.reconciliationInputPaths.figmaBaselinePath, 'utf8'));
      assert.equal(figmaBaselineAfter.variables.find((v: { name: string }) => v.name === 'Widget/color').value, '#222222');

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

      // 9. No findings at all remain for this entity. latest.json here is
      // the run AFTER both baselines promoted (reconciliationAfterRunId
      // above) — with BOTH sides now matching their own baselines, this
      // entity produces no reconciliation record at all, not a fresh
      // figma-only-change (Part 16 / Phase 2: promoting only the code
      // baseline, as Phase 1 did alone, would have left this resurfacing
      // forever; promoting Figma's too closes that gap).
      const afterRun: ReconciliationRun = JSON.parse(readFileSync(scenario.reconciliationOutputPaths.latestPath, 'utf8'));
      const widgetColorRecordAfter = afterRun.records.find((r) => r.entityId === 'widget-color');
      assert.equal(widgetColorRecordAfter, undefined, 'the entity must no longer appear in reconciliation records at all once both baselines have converged');

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

      // Confirm Stage 5's OWN Level-6 comparison really did land on
      // both-changed-conflict (exact string "24" !== "24px") — i.e. this
      // test is genuinely exercising the representational gap, not
      // something that would have resolved anyway. Since Phase 1's own
      // code-baseline promotion (see Part 15 below) now runs a SECOND
      // reconciliation immediately afterward and latest.json reflects
      // only that final one, the pre-promotion Level-6 run is instead
      // located among the immutable per-run records persistReconciliationRun()
      // always archives (see reconcile.ts) — never overwritten, so it is
      // still there regardless of what ran after it.
      const recordFiles = readdirSync(scenario.reconciliationOutputPaths.recordsDir);
      const archivedRuns: ReconciliationRun[] = recordFiles.map((f) => JSON.parse(readFileSync(path.join(scenario.reconciliationOutputPaths.recordsDir, f), 'utf8')));
      const conflictRun = archivedRuns.find((r) => r.records.some((rec) => rec.entityId === 'widget-length' && rec.status === 'both-changed-conflict'));
      assert.ok(conflictRun, 'expected an archived run capturing the pre-promotion both-changed-conflict state');
      const afterRecord = conflictRun!.records.find((r) => r.entityId === 'widget-length');
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
      const otherRecords = conflictRun!.records.filter((r) => r.entityId !== 'widget-length');
      assert.deepEqual(otherRecords, []);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// =======================================================================
// Part 19 — the audit-trail gap found during Phase 3 real-repo
// verification: if the post-apply refresh/reconcile (levels 5-6) fails
// (e.g. a live Figma MCP rate limit), an already-applied, already
// pre-apply-validated edit must NEVER be left with no audit record at
// all, and must NEVER be rolled back over an unrelated external
// failure. See agent-run.ts's `finalizeVerificationIncomplete`.
// =======================================================================

describe('agent-run.ts — applied-verification-incomplete (Part 19)', () => {
  test('Level 6 (reRunReconciliation) throwing after a real apply: a complete audit record is written, the edit is NOT rolled back, and loop prevention does not block a legitimate future retry', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-run-verification-incomplete-l6-'));
    try {
      const scenario = scaffoldScenarioPaths(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'colors.css');
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #111111;\n}\n', 'utf8');

      writeRegistryFixture(scenario, [
        { tokenId: 'widget-color', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/color', cssVariable: '--widget-color', consumedBy: [] },
      ]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaBaselinePath, 'fb', [{ name: 'Widget/color', value: '#111111' }]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaCurrentPath, 'fc', [{ name: 'Widget/color', value: '#222222' }]);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeBaselinePath);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeCurrentPath);

      const beforeRun = reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');
      const targetedRecordBefore = findRecordByEntityId(beforeRun, 'widget-color');
      assert.equal(targetedRecordBefore.status, 'figma-only-change');

      const baseDeps = makeDeps(scenario, tokensCssPath, '#222222', null);
      // Simulates exactly what happened live during Phase 3 verification:
      // the edit applies and passes levels 1-4 cleanly, then Level 6
      // (re-reconcile, which in production shells out to `npm run
      // sync:reconcile` and attempts a live Figma MCP refresh) throws.
      const deps: AgentRunDeps = {
        ...baseDeps,
        reRunReconciliation: () => {
          throw new Error('simulated: Figma Dev Mode MCP Server rate limit exceeded, please try again tomorrow');
        },
      };

      const audit = await runAgentForFinding(targetedRecordBefore.reconciliationId, deps, '2026-01-02T00:00:00.000Z');

      // The outcome honestly distinguishes this from both a clean success
      // and a genuine failure.
      assert.equal(audit.outcome, 'applied-verification-incomplete');
      assert.equal(audit.findingAfter, 'unresolved');
      assert.equal(audit.reconciliationAfterRunId, null);

      // The edit itself is real and was NOT rolled back — it was already
      // independently validated by levels 1-4 before Level 6 ever ran.
      assert.deepEqual(audit.filesModified, ['src/tokens/colors.css']);
      assert.deepEqual(audit.change, { before: '#111111', after: '#222222' });
      assert.match(readFileSync(tokensCssPath, 'utf8'), /--widget-color:\s*#222222;/, 'the file on disk must still reflect the applied edit, not a reverted one');

      // Neither baseline promotion ever ran (it happens strictly after a
      // confirmed clean verification, which never completed here).
      assert.equal(audit.codeBaselinePromoted, false);
      assert.equal(audit.figmaBaselinePromoted, false);

      // Validation levels 1-5 are recorded as genuinely passed (Level 5's
      // refreshCodeSnapshot succeeds before Level 6's reRunReconciliation
      // throws); level 6 is recorded as genuinely failed, with the real,
      // unmodified error message — never dropped, never paraphrased away.
      assert.deepEqual(
        audit.validation.map((v) => v.level),
        [1, 2, 3, 4, 5, 6],
      );
      assert.ok(audit.validation.slice(0, 5).every((v) => v.passed));
      const level6 = audit.validation.find((v) => v.level === 6);
      assert.equal(level6?.passed, false);
      assert.match(level6?.output ?? '', /rate limit exceeded/);

      // The stopReason names the specific downstream failure verbatim.
      assert.match(audit.stopReason, /rate limit exceeded/);
      assert.match(audit.stopReason, /NOT reverted/);

      // A COMPLETE audit record was actually persisted to disk — not
      // silently dropped, not merely returned in-memory.
      assert.ok(existsSync(scenario.agentHistoryPaths.latestPath));
      const persisted: AgentAuditRecord = JSON.parse(readFileSync(scenario.agentHistoryPaths.latestPath, 'utf8'));
      assert.equal(persisted.auditId, audit.auditId);
      assert.equal(persisted.outcome, 'applied-verification-incomplete');
      const recordFiles = readdirSync(scenario.agentHistoryPaths.recordsDir);
      assert.equal(recordFiles.length, 1);

      // Loop prevention does NOT treat this as a failed attempt — the edit
      // succeeded; only an unrelated downstream step didn't complete. A
      // legitimate future retry against this same finding must not be
      // blocked by hasPriorFailedAttempt.
      assert.equal(hasPriorFailedAttempt(scenario.agentHistoryPaths.recordsDir, targetedRecordBefore.reconciliationId), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('Level 5 (refreshCodeSnapshot) throwing after a real apply is also recorded as applied-verification-incomplete, distinctly from a Level 6 failure', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-run-verification-incomplete-l5-'));
    try {
      const scenario = scaffoldScenarioPaths(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'colors.css');
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #111111;\n}\n', 'utf8');

      writeRegistryFixture(scenario, [
        { tokenId: 'widget-color', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/color', cssVariable: '--widget-color', consumedBy: [] },
      ]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaBaselinePath, 'fb', [{ name: 'Widget/color', value: '#111111' }]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaCurrentPath, 'fc', [{ name: 'Widget/color', value: '#222222' }]);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeBaselinePath);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeCurrentPath);

      const beforeRun = reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');
      const targetedRecordBefore = findRecordByEntityId(beforeRun, 'widget-color');

      const baseDeps = makeDeps(scenario, tokensCssPath, '#222222', null);
      const deps: AgentRunDeps = {
        ...baseDeps,
        refreshCodeSnapshot: () => {
          throw new Error('simulated: sync:code-check failed');
        },
      };

      const audit = await runAgentForFinding(targetedRecordBefore.reconciliationId, deps, '2026-01-02T00:00:00.000Z');

      assert.equal(audit.outcome, 'applied-verification-incomplete');
      assert.deepEqual(audit.change, { before: '#111111', after: '#222222' });
      assert.match(readFileSync(tokensCssPath, 'utf8'), /--widget-color:\s*#222222;/);
      assert.deepEqual(
        audit.validation.map((v) => v.level),
        [1, 2, 3, 4, 5],
      );
      const level5 = audit.validation.find((v) => v.level === 5);
      assert.equal(level5?.passed, false);
      assert.match(level5?.output ?? '', /sync:code-check failed/);
      assert.equal(hasPriorFailedAttempt(scenario.agentHistoryPaths.recordsDir, targetedRecordBefore.reconciliationId), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// =======================================================================
// Part 15/16 (Phase 1 + Phase 2) — baseline promotion after a successful
// apply. See code-baseline-promote.ts's/figma-baseline-promote.ts's own
// headers for the full rationale: a representational-gap token (Figma's
// unitless resolved value vs Code's px-suffixed literal) produces a
// *permanent* both-changed-conflict -> BLOCKED record after every
// successful fix, because neither baseline is otherwise ever refreshed.
// Phase 1 promoted only the CODE baseline (which, alone, still leaves a
// figma-only-change finding resurfacing after every apply, since Figma's
// baseline stays stale). Phase 2 additionally promotes the FIGMA
// baseline, but ONLY for a figma-only-change SAFE apply — never for
// code-only-change/REVIEW, never for both-changed-conflict, never for a
// future human-directed resolution.
// =======================================================================

describe('agent-run.ts — baseline promotion after a successful apply (Part 15/16 / Phase 1+2)', () => {
  test('promotes both the CODE and FIGMA baselines for a figma-only-change SAFE apply, and the subsequent reconcile shows no finding at all for that entity', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-run-baseline-promote-'));
    try {
      const scenario = scaffoldScenarioPaths(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'typography.css');

      // Same representational-gap setup as the Stage 6E test above:
      // Figma reports a unitless length, Code stores a px literal.
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

      writeFigmaFixture(scenario.reconciliationInputPaths.figmaBaselinePath, 'figma-baseline-len', [{ name: 'Widget/length', value: '20' }]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaCurrentPath, 'figma-current-len', [{ name: 'Widget/length', value: '24' }]);

      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeBaselinePath);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeCurrentPath);

      const beforeRun = reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');
      const targetedRecordBefore = findRecordByEntityId(beforeRun, 'widget-length');
      assert.equal(targetedRecordBefore.status, 'figma-only-change');

      // Confirm the CODE baseline has not been promoted yet.
      const baselineBefore = JSON.parse(readFileSync(scenario.reconciliationInputPaths.codeBaselinePath, 'utf8'));
      assert.equal(baselineBefore.tokenDefinitions.find((t: { cssVariable: string }) => t.cssVariable === '--widget-length').value, '20px');

      const deps = makeDeps(scenario, tokensCssPath, '24px', null, '--widget-length');

      const audit = await runAgentForFinding(targetedRecordBefore.reconciliationId, deps, '2026-01-02T00:00:00.000Z');

      assert.equal(audit.outcome, 'applied');
      assert.equal(audit.findingAfter, 'resolved');
      assert.equal(audit.codeBaselinePromoted, true, 'a clean successful apply must promote the one CODE baseline entry it changed');
      // This finding is a figma-only-change SAFE apply, so the FIGMA
      // baseline is ALSO promoted for the same entity (Part 16 / Phase 2).
      assert.equal(audit.figmaBaselinePromoted, true, 'a figma-only-change SAFE apply must also promote the FIGMA baseline for the same entity');

      // The CODE baseline file itself was updated for ONLY this one entity.
      const baselineAfter = JSON.parse(readFileSync(scenario.reconciliationInputPaths.codeBaselinePath, 'utf8'));
      assert.equal(
        baselineAfter.tokenDefinitions.find((t: { cssVariable: string }) => t.cssVariable === '--widget-length').value,
        '24px',
        'the code baseline for --widget-length must now read 24px',
      );

      // The FIGMA baseline file itself was updated for ONLY this one variable.
      const figmaBaselineAfter = JSON.parse(readFileSync(scenario.reconciliationInputPaths.figmaBaselinePath, 'utf8'));
      assert.equal(
        figmaBaselineAfter.variables.find((v: { name: string }) => v.name === 'Widget/length').value,
        '24',
        'the figma baseline for "Widget/length" must now read the resolved current value "24"',
      );

      // The persisted Stage 5 record (reconciliationAfterRunId, which the
      // agent updated after each promotion) no longer shows
      // both-changed-conflict for this entity — and, since BOTH sides now
      // match their own baselines, no record exists for it at all
      // (superseding Phase 1 alone, which only promoted the code side and
      // left it resurfacing as a fresh figma-only-change every time).
      const finalRun: ReconciliationRun = JSON.parse(readFileSync(scenario.reconciliationOutputPaths.latestPath, 'utf8'));
      assert.equal(finalRun.runId, audit.reconciliationAfterRunId, 'the audit record must point at the final, post-promotion reconciliation run');
      const finalRecord = finalRun.records.find((r) => r.entityId === 'widget-length');
      assert.equal(finalRecord, undefined, 'once both baselines converge, the entity must produce no reconciliation record at all — not a fresh SAFE finding');

      // A wholly independent, later reconcile (not one the agent itself
      // triggered) confirms both promoted baselines are durably persisted,
      // not just an artifact of the re-reconciliations inside this run.
      const laterRun = reconcileAndPersist(scenario, '2026-01-03T00:00:00.000Z');
      const laterRecord = laterRun.records.find((r) => r.entityId === 'widget-length');
      assert.equal(laterRecord, undefined, 'a fresh, independent reconcile must still show no finding for this entity');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('a promotion whose expected previous value has drifted since the run started is refused, and does not fail the already-verified-successful apply', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-run-baseline-promote-drift-'));
    try {
      const scenario = scaffoldScenarioPaths(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'typography.css');
      writeFileSync(tokensCssPath, ':root {\n  --widget-length: 20px;\n}\n', 'utf8');

      writeRegistryFixture(scenario, [
        { tokenId: 'widget-length', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/length', cssVariable: '--widget-length', consumedBy: [] },
      ]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaBaselinePath, 'figma-baseline-len', [{ name: 'Widget/length', value: '20' }]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaCurrentPath, 'figma-current-len', [{ name: 'Widget/length', value: '24' }]);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeBaselinePath);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeCurrentPath);

      const beforeRun = reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');
      const targetedRecordBefore = findRecordByEntityId(beforeRun, 'widget-length');

      // Simulate the baseline having drifted (e.g. a concurrent promotion)
      // since the run started, by pointing promoteCodeBaseline at a
      // deliberately WRONG expected-previous-value path: reuse makeDeps
      // but override promoteCodeBaseline to always throw, mirroring what
      // promoteCodeBaselineForToken itself would do on a real mismatch.
      const deps = makeDeps(scenario, tokensCssPath, '24px', null, '--widget-length');
      const throwingDeps: AgentRunDeps = {
        ...deps,
        promoteCodeBaseline: () => {
          throw new Error('simulated: baseline value has drifted since this run started');
        },
      };

      const audit = await runAgentForFinding(targetedRecordBefore.reconciliationId, throwingDeps, '2026-01-02T00:00:00.000Z');

      // The edit itself still succeeded and was NOT rolled back — promotion
      // failure is bookkeeping-only, never fatal to an already-verified fix.
      assert.equal(audit.outcome, 'applied');
      assert.equal(audit.findingAfter, 'resolved');
      assert.match(readFileSync(tokensCssPath, 'utf8'), /--widget-length:\s*24px;/);

      // But promotion itself is honestly recorded as not having happened.
      // The Figma baseline promotion never even attempts to run, since
      // it's gated on the code baseline promotion having succeeded first.
      assert.equal(audit.codeBaselinePromoted, false);
      assert.equal(audit.figmaBaselinePromoted, false);
      assert.match(audit.stopReason, /baseline promotion did not complete/i);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('a FIGMA promotion whose expected previous value has drifted is refused without rolling back the already-applied edit or the (already-succeeded) code baseline promotion', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-run-baseline-promote-figma-drift-'));
    try {
      const scenario = scaffoldScenarioPaths(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'typography.css');
      writeFileSync(tokensCssPath, ':root {\n  --widget-length: 20px;\n}\n', 'utf8');

      writeRegistryFixture(scenario, [
        { tokenId: 'widget-length', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/length', cssVariable: '--widget-length', consumedBy: [] },
      ]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaBaselinePath, 'figma-baseline-len', [{ name: 'Widget/length', value: '20' }]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaCurrentPath, 'figma-current-len', [{ name: 'Widget/length', value: '24' }]);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeBaselinePath);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeCurrentPath);

      const beforeRun = reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');
      const targetedRecordBefore = findRecordByEntityId(beforeRun, 'widget-length');

      const deps = makeDeps(scenario, tokensCssPath, '24px', null, '--widget-length');
      const throwingFigmaDeps: AgentRunDeps = {
        ...deps,
        promoteFigmaBaseline: () => {
          throw new Error('simulated: Figma baseline value has drifted since this run started');
        },
      };

      const audit = await runAgentForFinding(targetedRecordBefore.reconciliationId, throwingFigmaDeps, '2026-01-02T00:00:00.000Z');

      // The edit and the code baseline promotion both still succeeded.
      assert.equal(audit.outcome, 'applied');
      assert.equal(audit.findingAfter, 'resolved');
      assert.match(readFileSync(tokensCssPath, 'utf8'), /--widget-length:\s*24px;/);
      assert.equal(audit.codeBaselinePromoted, true);
      const baselineAfter = JSON.parse(readFileSync(scenario.reconciliationInputPaths.codeBaselinePath, 'utf8'));
      assert.equal(baselineAfter.tokenDefinitions.find((t: { cssVariable: string }) => t.cssVariable === '--widget-length').value, '24px');

      // But the Figma baseline promotion itself is honestly recorded as not having happened.
      assert.equal(audit.figmaBaselinePromoted, false);
      assert.match(audit.stopReason, /figma baseline promotion did not complete/i);

      // The Figma baseline file itself was never touched.
      const figmaBaselineAfter = JSON.parse(readFileSync(scenario.reconciliationInputPaths.figmaBaselinePath, 'utf8'));
      assert.equal(figmaBaselineAfter.variables.find((v: { name: string }) => v.name === 'Widget/length').value, '20');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('a code-only-change REVIEW finding never triggers Figma baseline promotion (scope: figma-only-change SAFE applies only)', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-run-baseline-promote-scope-'));
    try {
      const scenario = scaffoldScenarioPaths(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'colors.css');
      // Figma unchanged, code changed since baseline -> code-only-change -> REVIEW (never SAFE).
      writeRegistryFixture(scenario, [
        { tokenId: 'widget-color', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/color', cssVariable: '--widget-color', consumedBy: [] },
      ]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaBaselinePath, 'figma-baseline', [{ name: 'Widget/color', value: '#111111' }]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaCurrentPath, 'figma-current', [{ name: 'Widget/color', value: '#111111' }]);

      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #111111;\n}\n', 'utf8');
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeBaselinePath);
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #333333;\n}\n', 'utf8');
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeCurrentPath);

      const beforeRun = reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');
      const targetedRecordBefore = findRecordByEntityId(beforeRun, 'widget-color');
      assert.equal(targetedRecordBefore.status, 'code-only-change');

      const deps = makeDeps(scenario, tokensCssPath, '#333333', null);
      const canaryDeps: AgentRunDeps = {
        ...deps,
        promoteFigmaBaseline: () => {
          throw new Error('promoteFigmaBaseline must never be invoked for a code-only-change/REVIEW finding');
        },
      };

      const audit = await runAgentForFinding(targetedRecordBefore.reconciliationId, canaryDeps, '2026-01-02T00:00:00.000Z');

      assert.equal(audit.policyDecision.verdict, 'REVIEW');
      assert.equal(audit.outcome, 'no-safe-action');
      assert.equal(audit.figmaBaselinePromoted, false);
      assert.deepEqual(audit.filesModified, []);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// =======================================================================
// Part 18 — human-directed resolution of a token-level both-changed-
// conflict finding. Scoped ONLY to entityType 'token' + status
// 'both-changed-conflict' — never registry-expectation-mismatch, never
// any component-level finding (they have no single-value editTarget).
// =======================================================================

describe('agent-run.ts — human-directed resolution (Part 18)', () => {
  test("sourceOfTruth: 'figma' — reuses the SAME reasoner->validate->apply->verify pipeline, edits code to match Figma, promotes BOTH baselines, and the conflict clears", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-run-human-directed-figma-'));
    try {
      const scenario = scaffoldScenarioPaths(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'typography.css');

      // A genuine both-changed-conflict: Figma resolves to "24" (unitless),
      // code independently drifted to "30px" — raw strings differ from
      // each other AND from what Figma's value would look like as px, so
      // Stage 5's own exact-string comparison genuinely calls this a
      // conflict (not a representational-gap false positive).
      writeFileSync(tokensCssPath, ':root {\n  --widget-length: 20px;\n}\n', 'utf8');
      writeRegistryFixture(scenario, [
        { tokenId: 'widget-length', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/length', cssVariable: '--widget-length', consumedBy: [] },
      ]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaBaselinePath, 'figma-baseline-len', [{ name: 'Widget/length', value: '20' }]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaCurrentPath, 'figma-current-len', [{ name: 'Widget/length', value: '24' }]);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeBaselinePath);
      writeFileSync(tokensCssPath, ':root {\n  --widget-length: 30px;\n}\n', 'utf8');
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeCurrentPath);

      const beforeRun = reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');
      const targetedRecordBefore = findRecordByEntityId(beforeRun, 'widget-length');
      assert.equal(targetedRecordBefore.status, 'both-changed-conflict');
      assert.equal(targetedRecordBefore.figma?.current, '24');
      assert.equal(targetedRecordBefore.code?.current, '30px');

      // The mock reasoner proposes "24px" — matching Figma's resolved
      // value, following the file's own established px convention (the
      // same thing a real Claude call would be asked to do — see the
      // "HUMAN-DIRECTED OVERRIDE" prompt addition in agent-claude-reasoner.ts).
      const deps = makeDeps(scenario, tokensCssPath, '24px', null, '--widget-length');

      const audit = await runAgentForFinding(targetedRecordBefore.reconciliationId, deps, '2026-01-02T00:00:00.000Z', { humanDirectedSourceOfTruth: 'figma' });

      assert.equal(audit.outcome, 'applied');
      assert.equal(audit.humanDirected, true);
      assert.equal(audit.sourceOfTruth, 'figma');
      assert.equal(audit.policyDecision.verdict, 'BLOCKED', 'the real policy fact is preserved untouched — only the gate was bypassed, never the recorded verdict');
      assert.deepEqual(audit.filesModified, ['src/tokens/typography.css']);
      assert.deepEqual(audit.change, { before: '30px', after: '24px' });
      assert.match(readFileSync(tokensCssPath, 'utf8'), /--widget-length:\s*24px;/);

      // Both baselines promoted — full convergence, same as the
      // figma-only-change SAFE path (Part 15/16).
      assert.equal(audit.codeBaselinePromoted, true);
      assert.equal(audit.figmaBaselinePromoted, true);
      const codeBaselineAfter = JSON.parse(readFileSync(scenario.reconciliationInputPaths.codeBaselinePath, 'utf8'));
      assert.equal(codeBaselineAfter.tokenDefinitions.find((t: { cssVariable: string }) => t.cssVariable === '--widget-length').value, '24px');
      const figmaBaselineAfter = JSON.parse(readFileSync(scenario.reconciliationInputPaths.figmaBaselinePath, 'utf8'));
      assert.equal(figmaBaselineAfter.variables.find((v: { name: string }) => v.name === 'Widget/length').value, '24');

      // The conflict no longer appears at all.
      const finalRun: ReconciliationRun = JSON.parse(readFileSync(scenario.reconciliationOutputPaths.latestPath, 'utf8'));
      assert.equal(finalRun.runId, audit.reconciliationAfterRunId);
      assert.equal(finalRun.records.find((r) => r.entityId === 'widget-length'), undefined);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("sourceOfTruth: 'code' — never invokes the reasoner or edits any file, promotes BOTH baselines to their own current values, and the conflict clears", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-run-human-directed-code-'));
    try {
      const scenario = scaffoldScenarioPaths(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'typography.css');

      writeFileSync(tokensCssPath, ':root {\n  --widget-length: 20px;\n}\n', 'utf8');
      writeRegistryFixture(scenario, [
        { tokenId: 'widget-length', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/length', cssVariable: '--widget-length', consumedBy: [] },
      ]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaBaselinePath, 'figma-baseline-len', [{ name: 'Widget/length', value: '20' }]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaCurrentPath, 'figma-current-len', [{ name: 'Widget/length', value: '24' }]);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeBaselinePath);
      writeFileSync(tokensCssPath, ':root {\n  --widget-length: 30px;\n}\n', 'utf8');
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeCurrentPath);

      const beforeRun = reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');
      const targetedRecordBefore = findRecordByEntityId(beforeRun, 'widget-length');
      assert.equal(targetedRecordBefore.status, 'both-changed-conflict');

      const contentBefore = readFileSync(tokensCssPath, 'utf8');
      const baseDeps = makeDeps(scenario, tokensCssPath, '24px', null, '--widget-length');
      // Canary: the reasoner (and, by extension, the edit engine) must
      // never be invoked for the 'code' direction — there is nothing to
      // propose, and validateProposedEdit's own no-op rule would
      // correctly refuse a before===after edit anyway.
      const deps: AgentRunDeps = { ...baseDeps, reasoner: () => { throw new Error('reasoner must never be invoked for a human-directed "code" resolution'); } };

      const audit = await runAgentForFinding(targetedRecordBefore.reconciliationId, deps, '2026-01-02T00:00:00.000Z', { humanDirectedSourceOfTruth: 'code' });

      assert.equal(audit.outcome, 'applied');
      assert.equal(audit.humanDirected, true);
      assert.equal(audit.sourceOfTruth, 'code');
      assert.deepEqual(audit.filesModified, [], 'no file is ever edited for the "code" direction');
      assert.equal(audit.change, null);
      assert.equal(readFileSync(tokensCssPath, 'utf8'), contentBefore, 'the source file is byte-identical to before this run');

      // Both baselines promoted to their OWN current values.
      assert.equal(audit.codeBaselinePromoted, true);
      assert.equal(audit.figmaBaselinePromoted, true);
      const codeBaselineAfter = JSON.parse(readFileSync(scenario.reconciliationInputPaths.codeBaselinePath, 'utf8'));
      assert.equal(codeBaselineAfter.tokenDefinitions.find((t: { cssVariable: string }) => t.cssVariable === '--widget-length').value, '30px');
      const figmaBaselineAfter = JSON.parse(readFileSync(scenario.reconciliationInputPaths.figmaBaselinePath, 'utf8'));
      assert.equal(figmaBaselineAfter.variables.find((v: { name: string }) => v.name === 'Widget/length').value, '24');

      // The conflict no longer appears at all — code's own choice (30px) is
      // preserved, and the finding is honestly gone, not silently hidden.
      const finalRun: ReconciliationRun = JSON.parse(readFileSync(scenario.reconciliationOutputPaths.latestPath, 'utf8'));
      assert.equal(finalRun.runId, audit.reconciliationAfterRunId);
      assert.equal(finalRun.records.find((r) => r.entityId === 'widget-length'), undefined);

      // A wholly independent, later reconcile confirms this is durable.
      const laterRun = reconcileAndPersist(scenario, '2026-01-03T00:00:00.000Z');
      assert.equal(laterRun.records.find((r) => r.entityId === 'widget-length'), undefined);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('scope canary: a token-level finding that is NOT both-changed-conflict (e.g. figma-only-change) refuses human-directed resolution', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-run-human-directed-scope-status-'));
    try {
      const scenario = scaffoldScenarioPaths(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'colors.css');
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #111111;\n}\n', 'utf8');
      writeRegistryFixture(scenario, [
        { tokenId: 'widget-color', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/color', cssVariable: '--widget-color', consumedBy: [] },
      ]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaBaselinePath, 'fb', [{ name: 'Widget/color', value: '#111111' }]);
      writeFigmaFixture(scenario.reconciliationInputPaths.figmaCurrentPath, 'fc', [{ name: 'Widget/color', value: '#222222' }]);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeBaselinePath);
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeCurrentPath);

      const beforeRun = reconcileAndPersist(scenario, '2026-01-01T00:00:00.000Z');
      const targetedRecordBefore = findRecordByEntityId(beforeRun, 'widget-color');
      assert.equal(targetedRecordBefore.status, 'figma-only-change');

      const deps = makeDeps(scenario, tokensCssPath, '#222222', null);

      await assert.rejects(
        () => runAgentForFinding(targetedRecordBefore.reconciliationId, deps, '2026-01-02T00:00:00.000Z', { humanDirectedSourceOfTruth: 'figma' }),
        (err: unknown) => err instanceof AgentError && /only supported for token-level both-changed-conflict findings/.test(err.message),
      );

      // Zero writes: no file touched, no audit record persisted.
      assert.equal(readFileSync(tokensCssPath, 'utf8'), ':root {\n  --widget-color: #111111;\n}\n');
      assert.ok(!existsSync(scenario.agentHistoryPaths.latestPath));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('scope canary: a REAL component-level registry-expectation-mismatch finding ("button", read against the actual repository) refuses human-directed resolution — zero writes', async () => {
    // Read-only against the real repository: the scope check throws
    // BEFORE any of AgentRunDeps's functions (reasoner, validation
    // levels, refreshCodeSnapshot, reRunReconciliation, either baseline
    // promotion) are ever called, so this is safe to run against the
    // real, production reconciliation data and paths — it writes nothing.
    const outputPaths = createProductionReconciliationOutputPaths();
    const latest: ReconciliationRun = JSON.parse(readFileSync(outputPaths.latestPath, 'utf8'));
    const button = latest.records.find((r) => r.entityId === 'button' && r.status === 'registry-expectation-mismatch');
    assert.ok(button, 'expected the real repository to still have its known "button" registry-expectation-mismatch finding');

    const deps = createProductionAgentRunDeps();
    await assert.rejects(
      () => runAgentForFinding(button!.reconciliationId, deps, '2026-01-02T00:00:00.000Z', { humanDirectedSourceOfTruth: 'figma' }),
      (err: unknown) => err instanceof AgentError && /only supported for token-level both-changed-conflict findings/.test(err.message),
    );
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
      assert.equal(firstAudit.humanReauthorized, false);
      assert.equal(secondAudit.humanReauthorized, false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// =======================================================================
// Part 14 — explicit human re-authorization of a previously-failed
// finding. hasPriorFailedAttempt() and the automatic-retry refusal above
// (Part 13.D) are completely unmodified; this only proves that passing
// `{ humanReauthorized: true }` un-blocks EXACTLY that one refusal, never
// anything else in the pipeline.
// =======================================================================

describe('agent-run.ts — explicit human re-authorization (Part 14)', () => {
  test('a human-reauthorized retry proceeds through the full pipeline and succeeds once the underlying failure is fixed', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-run-reauth-success-'));
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

      // First attempt: deliberately broken level-1 validator (simulates the real Windows execFileSync/npx ENOENT bug) -> failed-validation, reverted.
      const failingDeps = makeDeps(scenario, tokensCssPath, '#222222', '#222222');
      failingDeps.runLevel1 = () => ({ level: 1, command: 'fixture: deliberately failing check', passed: false });
      const firstAudit = await runAgentForFinding(record.reconciliationId, failingDeps, '2026-01-02T00:00:00.000Z');
      assert.equal(firstAudit.outcome, 'failed-validation');
      assert.equal(firstAudit.humanReauthorized, false);
      assert.equal(hasPriorFailedAttempt(scenario.agentHistoryPaths.recordsDir, record.reconciliationId), true);

      // Without reauthorization, a normal retry is still refused (unchanged behavior).
      const unauthorizedDeps = makeDeps(scenario, tokensCssPath, '#222222', '#222222');
      const unauthorizedAudit = await runAgentForFinding(record.reconciliationId, unauthorizedDeps, '2026-01-03T00:00:00.000Z');
      assert.equal(unauthorizedAudit.outcome, 'no-safe-action');
      assert.equal(unauthorizedAudit.policyDecision.verdict, 'BLOCKED');
      assert.equal(unauthorizedAudit.editTarget, null);

      // The underlying cause is now "fixed" (working validators) and a human explicitly re-authorizes.
      const reauthorizedDeps = makeDeps(scenario, tokensCssPath, '#222222', '#222222');
      const reauthorizedAudit = await runAgentForFinding(record.reconciliationId, reauthorizedDeps, '2026-01-04T00:00:00.000Z', { humanReauthorized: true });

      assert.equal(reauthorizedAudit.outcome, 'applied');
      assert.equal(reauthorizedAudit.humanReauthorized, true, 'the audit trail must record that this run was explicitly human re-authorized');
      assert.deepEqual(reauthorizedAudit.filesModified, ['src/tokens/colors.css']);
      assert.match(readFileSync(tokensCssPath, 'utf8'), /--widget-color:\s*#222222;/);

      // Immutability: the original failed record is untouched, not deleted, not rewritten.
      const recordFiles = readdirSync(scenario.agentHistoryPaths.recordsDir);
      assert.equal(recordFiles.length, 3);
      const stillThere = JSON.parse(readFileSync(path.join(scenario.agentHistoryPaths.recordsDir, recordFiles.find((f) => f.includes(firstAudit.auditId))!), 'utf8'));
      assert.equal(stillThere.outcome, 'failed-validation');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('reauthorization never bypasses a non-SAFE current policy verdict', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-run-reauth-nonsafe-'));
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

      const failingDeps = makeDeps(scenario, tokensCssPath, '#222222', '#222222');
      failingDeps.runLevel1 = () => ({ level: 1, command: 'fixture: deliberately failing check', passed: false });
      await runAgentForFinding(record.reconciliationId, failingDeps, '2026-01-02T00:00:00.000Z');
      assert.equal(hasPriorFailedAttempt(scenario.agentHistoryPaths.recordsDir, record.reconciliationId), true);

      // Between attempts, code drifts independently -> both-changed-* on
      // the NEXT reconciliation. Re-reconcile against the real, current
      // (already-edited-then-reverted-back) fixture state so the SAFE
      // precondition genuinely no longer holds, without hand-fabricating
      // a record.
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #333333;\n}\n', 'utf8');
      buildAndWriteCodeSnapshot(scenario, scenario.reconciliationInputPaths.codeCurrentPath);
      const afterDriftRun = reconcileAndPersist(scenario, '2026-01-03T00:00:00.000Z');
      const driftedRecord = findRecordByEntityId(afterDriftRun, 'widget-color');
      assert.equal(driftedRecord.status, 'both-changed-conflict'); // Figma "#222222" vs Code "#333333" -> no longer SAFE

      let reasonerCalled = false;
      const reauthorizedDeps = makeDeps(scenario, tokensCssPath, '#222222', '#222222');
      reauthorizedDeps.reasoner = () => {
        reasonerCalled = true;
        throw new Error('must never be called — reauthorization must not bypass a non-SAFE verdict');
      };

      const audit = await runAgentForFinding(driftedRecord.reconciliationId, reauthorizedDeps, '2026-01-04T00:00:00.000Z', { humanReauthorized: true });

      assert.equal(reasonerCalled, false);
      assert.equal(audit.policyDecision.verdict, 'BLOCKED');
      assert.equal(audit.editTarget, null);
      assert.equal(audit.humanReauthorized, true, 'the flag is still recorded even though it had no effect');
      assert.equal(readFileSync(tokensCssPath, 'utf8'), ':root {\n  --widget-color: #333333;\n}\n', 'untouched by this refused run');
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
      humanReauthorized: false,
      codeBaselinePromoted: false,
      figmaBaselinePromoted: false,
      humanDirected: false,
      sourceOfTruth: null,
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

