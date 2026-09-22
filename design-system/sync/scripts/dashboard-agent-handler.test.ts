import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseRunAgentRequestBody, handleRunAgentRequest, DashboardAgentRequestError } from './dashboard-agent-handler.ts';
import { createMockReasoner, type AgentRunDeps, type ValidationStepResult } from './agent-run.ts';
import { loadReconciliationInputs, buildReconciliationRun, persistReconciliationRun } from './reconcile.ts';
import { reconcileSnapshots } from './reconcile-compare.ts';
import { buildCodeSnapshot, writeCodeSnapshotFile } from './code-snapshot.ts';
import { promoteCodeBaselineForToken } from './code-baseline-promote.ts';
import { promoteFigmaBaselineForVariable } from './figma-baseline-promote.ts';

// =======================================================================
// Part 17 "Safety" — the dashboard's request boundary can never smuggle
// a file path, a declaration identifier, or more than one finding into
// the real agent pipeline.
// =======================================================================

describe('parseRunAgentRequestBody — the only shape the dashboard boundary accepts', () => {
  test('accepts { reconciliationId: string }, defaulting reauthorize to false and sourceOfTruth to null', () => {
    const parsed = parseRunAgentRequestBody({ reconciliationId: 'abc123' });
    assert.deepEqual(parsed, { reconciliationId: 'abc123', reauthorize: false, sourceOfTruth: null });
  });

  test('accepts an explicit reauthorize: true', () => {
    const parsed = parseRunAgentRequestBody({ reconciliationId: 'abc123', reauthorize: true });
    assert.deepEqual(parsed, { reconciliationId: 'abc123', reauthorize: true, sourceOfTruth: null });
  });

  test('rejects a non-boolean reauthorize', () => {
    assert.throws(() => parseRunAgentRequestBody({ reconciliationId: 'abc123', reauthorize: 'yes' }), DashboardAgentRequestError);
  });

  test('accepts an explicit sourceOfTruth: "figma" or "code"', () => {
    assert.deepEqual(parseRunAgentRequestBody({ reconciliationId: 'abc123', sourceOfTruth: 'figma' }), {
      reconciliationId: 'abc123',
      reauthorize: false,
      sourceOfTruth: 'figma',
    });
    assert.deepEqual(parseRunAgentRequestBody({ reconciliationId: 'abc123', sourceOfTruth: 'code' }), {
      reconciliationId: 'abc123',
      reauthorize: false,
      sourceOfTruth: 'code',
    });
  });

  test('rejects an invalid sourceOfTruth', () => {
    assert.throws(() => parseRunAgentRequestBody({ reconciliationId: 'abc123', sourceOfTruth: 'registry' }), DashboardAgentRequestError);
    assert.throws(() => parseRunAgentRequestBody({ reconciliationId: 'abc123', sourceOfTruth: true }), DashboardAgentRequestError);
  });

  test('rejects a batch/array request (no multi-finding execution)', () => {
    assert.throws(() => parseRunAgentRequestBody([{ reconciliationId: 'a' }, { reconciliationId: 'b' }]), DashboardAgentRequestError);
  });

  test('rejects a missing reconciliationId', () => {
    assert.throws(() => parseRunAgentRequestBody({}), DashboardAgentRequestError);
  });

  test('rejects a non-string reconciliationId', () => {
    assert.throws(() => parseRunAgentRequestBody({ reconciliationId: 123 }), DashboardAgentRequestError);
  });

  test('ignores an attempted filePath/declarationIdentifier override — the parsed result never carries them', () => {
    const parsed = parseRunAgentRequestBody({
      reconciliationId: 'abc123',
      filePath: 'src/tokens/typography.css',
      declarationIdentifier: '--anything-i-want',
      after: 'attacker-controlled-value',
    });
    assert.deepEqual(Object.keys(parsed).sort(), ['reauthorize', 'reconciliationId', 'sourceOfTruth']);
  });

  test('rejects a non-object body (string, number, null)', () => {
    assert.throws(() => parseRunAgentRequestBody('not-an-object'), DashboardAgentRequestError);
    assert.throws(() => parseRunAgentRequestBody(42), DashboardAgentRequestError);
    assert.throws(() => parseRunAgentRequestBody(null), DashboardAgentRequestError);
  });
});

// =======================================================================
// End-to-end: a stray filePath/declarationIdentifier field in the request
// body has NO effect on which file/declaration actually gets edited —
// targeting still comes entirely from agent-targeting.ts, driven only by
// the reconciliationId.
// =======================================================================

describe('handleRunAgentRequest — request fields beyond reconciliationId have no effect', () => {
  function scaffold(tempRoot: string) {
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
      reconciliationOutputPaths: { recordsDir: path.join(tempRoot, 'reconciliation', 'records'), latestPath: path.join(tempRoot, 'reconciliation', 'latest.json') },
      agentHistoryPaths: { recordsDir: path.join(tempRoot, 'agent-history', 'records'), latestPath: path.join(tempRoot, 'agent-history', 'latest.json') },
      codeArchiveDir: path.join(tempRoot, 'code-snapshots', 'archive'),
      figmaArchiveDir: path.join(tempRoot, 'figma-snapshots', 'archive'),
    };
  }

  function makePromoteCodeBaseline(scenario: ReturnType<typeof scaffold>) {
    return (cssVariable: string, previousValue: string, newValue: string) => {
      promoteCodeBaselineForToken(
        { codeBaselinePath: scenario.reconciliationInputPaths.codeBaselinePath, codeArchiveDir: scenario.codeArchiveDir },
        cssVariable,
        previousValue,
        newValue,
      );
    };
  }

  function makePromoteFigmaBaseline(scenario: ReturnType<typeof scaffold>) {
    return (variableName: string, previousValue: string, newValue: string) => {
      promoteFigmaBaselineForVariable(
        { figmaBaselinePath: scenario.reconciliationInputPaths.figmaBaselinePath, figmaArchiveDir: scenario.figmaArchiveDir },
        variableName,
        previousValue,
        newValue,
      );
    };
  }

  test('a SAFE finding is still edited at its ONE authorized target, never at an attacker-supplied filePath/declarationIdentifier', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'dashboard-handler-safety-'));
    try {
      const scenario = scaffold(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'colors.css');
      const decoyCssPath = path.join(scenario.tokensDir, 'decoy.css');
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #111111;\n}\n', 'utf8');
      writeFileSync(decoyCssPath, ':root {\n  --decoy: #000000;\n}\n', 'utf8');

      writeFileSync(
        scenario.reconciliationInputPaths.registryPath,
        JSON.stringify({ registryUpdatedOn: '2026-01-01', components: [], tokens: [{ tokenId: 'widget-color', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/color', cssVariable: '--widget-color', consumedBy: [] }], textStyles: [], unresolved: [] }),
        'utf8',
      );
      writeFileSync(scenario.reconciliationInputPaths.manifestPath, JSON.stringify({ source: { extractedOn: '2026-01-01' } }), 'utf8');
      const writeFigma = (p: string, id: string, value: string) =>
        writeFileSync(p, JSON.stringify({ schemaVersion: '1.0.0', snapshotId: id, generatedAt: '2026-01-01T00:00:00.000Z', source: { fileKey: 'f', fileName: 'f', capturedAt: '2026-01-01T00:00:00.000Z' }, pages: [], components: [], variables: [{ name: 'Widget/color', value, inferredType: 'COLOR', consumedBy: [] }], textStyles: [] }), 'utf8');
      writeFigma(scenario.reconciliationInputPaths.figmaBaselinePath, 'fb', '#111111');
      writeFigma(scenario.reconciliationInputPaths.figmaCurrentPath, 'fc', '#222222');

      const buildAndWriteCode = (out: string) => writeCodeSnapshotFile(out, buildCodeSnapshot({ componentsDir: scenario.componentsDir, rootForRelativePaths: scenario.tempRoot, tokensDir: scenario.tokensDir }));
      buildAndWriteCode(scenario.reconciliationInputPaths.codeBaselinePath);
      buildAndWriteCode(scenario.reconciliationInputPaths.codeCurrentPath);

      const input = loadReconciliationInputs(scenario.reconciliationInputPaths);
      const records = reconcileSnapshots(input);
      const beforeRun = buildReconciliationRun(input, records, '2026-01-01T00:00:00.000Z');
      persistReconciliationRun(beforeRun, scenario.reconciliationOutputPaths);
      const target = beforeRun.records.find((r) => r.entityId === 'widget-color')!;

      const alwaysPass = (level: number, command: string): ValidationStepResult => ({ level, command, passed: true });
      const deps: AgentRunDeps = {
        rootDir: scenario.tempRoot,
        reconciliationInputPaths: scenario.reconciliationInputPaths,
        reconciliationOutputPaths: scenario.reconciliationOutputPaths,
        agentHistoryPaths: scenario.agentHistoryPaths,
        reasoner: createMockReasoner('#222222'),
        runLevel1: () => alwaysPass(1, 'l1'),
        runLevel2: () => alwaysPass(2, 'l2'),
        runLevel3: () => alwaysPass(3, 'l3'),
        runLevel4: () => alwaysPass(4, 'l4'),
        refreshCodeSnapshot: () => buildAndWriteCode(scenario.reconciliationInputPaths.codeCurrentPath),
        reRunReconciliation: (generatedAt: string) => {
          const freshInput = loadReconciliationInputs(scenario.reconciliationInputPaths);
          const freshRecords = reconcileSnapshots(freshInput);
          const run = buildReconciliationRun(freshInput, freshRecords, generatedAt);
          persistReconciliationRun(run, scenario.reconciliationOutputPaths);
          return run;
        },
        promoteCodeBaseline: makePromoteCodeBaseline(scenario),
        promoteFigmaBaseline: makePromoteFigmaBaseline(scenario),
      };

      // The request body carries an attacker-shaped payload beyond reconciliationId.
      const audit = await handleRunAgentRequest(
        {
          reconciliationId: target.reconciliationId,
          filePath: 'src/tokens/decoy.css',
          declarationIdentifier: '--decoy',
          after: '#ff00ff',
        },
        deps,
      );

      assert.equal(audit.outcome, 'applied');
      assert.deepEqual(audit.filesModified, ['src/tokens/colors.css']); // the REAL, resolved target — never the decoy
      assert.equal(readFileSync(decoyCssPath, 'utf8'), ':root {\n  --decoy: #000000;\n}\n'); // decoy file untouched
      assert.match(readFileSync(tokensCssPath, 'utf8'), /--widget-color:\s*#222222;/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('a REVIEW finding is refused (no edit, zero writes) even via the dashboard boundary — policy is never bypassed', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'dashboard-handler-review-'));
    try {
      const scenario = scaffold(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'colors.css');
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #333333;\n}\n', 'utf8');
      writeFileSync(
        scenario.reconciliationInputPaths.registryPath,
        JSON.stringify({ registryUpdatedOn: '2026-01-01', components: [], tokens: [{ tokenId: 'widget-color', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/color', cssVariable: '--widget-color', consumedBy: [] }], textStyles: [], unresolved: [] }),
        'utf8',
      );
      writeFileSync(scenario.reconciliationInputPaths.manifestPath, JSON.stringify({ source: { extractedOn: '2026-01-01' } }), 'utf8');
      const writeFigma = (p: string, id: string, value: string) =>
        writeFileSync(p, JSON.stringify({ schemaVersion: '1.0.0', snapshotId: id, generatedAt: '2026-01-01T00:00:00.000Z', source: { fileKey: 'f', fileName: 'f', capturedAt: '2026-01-01T00:00:00.000Z' }, pages: [], components: [], variables: [{ name: 'Widget/color', value, inferredType: 'COLOR', consumedBy: [] }], textStyles: [] }), 'utf8');
      // Figma unchanged, code changed -> code-only-change -> REVIEW.
      writeFigma(scenario.reconciliationInputPaths.figmaBaselinePath, 'fb', '#111111');
      writeFigma(scenario.reconciliationInputPaths.figmaCurrentPath, 'fc', '#111111');

      const buildAndWriteCode = (out: string) => writeCodeSnapshotFile(out, buildCodeSnapshot({ componentsDir: scenario.componentsDir, rootForRelativePaths: scenario.tempRoot, tokensDir: scenario.tokensDir }));
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #111111;\n}\n', 'utf8');
      buildAndWriteCode(scenario.reconciliationInputPaths.codeBaselinePath);
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #333333;\n}\n', 'utf8');
      buildAndWriteCode(scenario.reconciliationInputPaths.codeCurrentPath);

      const input = loadReconciliationInputs(scenario.reconciliationInputPaths);
      const records = reconcileSnapshots(input);
      const beforeRun = buildReconciliationRun(input, records, '2026-01-01T00:00:00.000Z');
      persistReconciliationRun(beforeRun, scenario.reconciliationOutputPaths);
      const target = beforeRun.records.find((r) => r.entityId === 'widget-color')!;
      assert.equal(target.status, 'code-only-change');

      const contentBefore = readFileSync(tokensCssPath, 'utf8');
      let reasonerCalled = false;
      const deps: AgentRunDeps = {
        rootDir: scenario.tempRoot,
        reconciliationInputPaths: scenario.reconciliationInputPaths,
        reconciliationOutputPaths: scenario.reconciliationOutputPaths,
        agentHistoryPaths: scenario.agentHistoryPaths,
        reasoner: () => {
          reasonerCalled = true;
          throw new Error('must never be called for a non-SAFE finding');
        },
        runLevel1: () => ({ level: 1, command: 'l1', passed: true }),
        runLevel2: () => ({ level: 2, command: 'l2', passed: true }),
        runLevel3: () => ({ level: 3, command: 'l3', passed: true }),
        runLevel4: () => ({ level: 4, command: 'l4', passed: true }),
        refreshCodeSnapshot: () => buildAndWriteCode(scenario.reconciliationInputPaths.codeCurrentPath),
        reRunReconciliation: (generatedAt: string) => {
          const freshInput = loadReconciliationInputs(scenario.reconciliationInputPaths);
          const freshRecords = reconcileSnapshots(freshInput);
          const run = buildReconciliationRun(freshInput, freshRecords, generatedAt);
          persistReconciliationRun(run, scenario.reconciliationOutputPaths);
          return run;
        },
        promoteCodeBaseline: makePromoteCodeBaseline(scenario),
        promoteFigmaBaseline: makePromoteFigmaBaseline(scenario),
      };

      const audit = await handleRunAgentRequest({ reconciliationId: target.reconciliationId }, deps);

      assert.equal(reasonerCalled, false);
      assert.equal(audit.policyDecision.verdict, 'REVIEW');
      assert.deepEqual(audit.filesModified, []);
      assert.equal(readFileSync(tokensCssPath, 'utf8'), contentBefore);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('a "reauthorize: true" request body un-blocks a finding refused by loop prevention, and the audit record marks it human-reauthorized', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'dashboard-handler-reauth-'));
    try {
      const scenario = scaffold(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'colors.css');
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #111111;\n}\n', 'utf8');

      writeFileSync(
        scenario.reconciliationInputPaths.registryPath,
        JSON.stringify({ registryUpdatedOn: '2026-01-01', components: [], tokens: [{ tokenId: 'widget-color', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/color', cssVariable: '--widget-color', consumedBy: [] }], textStyles: [], unresolved: [] }),
        'utf8',
      );
      writeFileSync(scenario.reconciliationInputPaths.manifestPath, JSON.stringify({ source: { extractedOn: '2026-01-01' } }), 'utf8');
      const writeFigma = (p: string, id: string, value: string) =>
        writeFileSync(p, JSON.stringify({ schemaVersion: '1.0.0', snapshotId: id, generatedAt: '2026-01-01T00:00:00.000Z', source: { fileKey: 'f', fileName: 'f', capturedAt: '2026-01-01T00:00:00.000Z' }, pages: [], components: [], variables: [{ name: 'Widget/color', value, inferredType: 'COLOR', consumedBy: [] }], textStyles: [] }), 'utf8');
      writeFigma(scenario.reconciliationInputPaths.figmaBaselinePath, 'fb', '#111111');
      writeFigma(scenario.reconciliationInputPaths.figmaCurrentPath, 'fc', '#222222');

      const buildAndWriteCode = (out: string) => writeCodeSnapshotFile(out, buildCodeSnapshot({ componentsDir: scenario.componentsDir, rootForRelativePaths: scenario.tempRoot, tokensDir: scenario.tokensDir }));
      buildAndWriteCode(scenario.reconciliationInputPaths.codeBaselinePath);
      buildAndWriteCode(scenario.reconciliationInputPaths.codeCurrentPath);

      const input = loadReconciliationInputs(scenario.reconciliationInputPaths);
      const records = reconcileSnapshots(input);
      const beforeRun = buildReconciliationRun(input, records, '2026-01-01T00:00:00.000Z');
      persistReconciliationRun(beforeRun, scenario.reconciliationOutputPaths);
      const target = beforeRun.records.find((r) => r.entityId === 'widget-color')!;

      const reRunReconciliation = (generatedAt: string) => {
        const freshInput = loadReconciliationInputs(scenario.reconciliationInputPaths);
        const freshRecords = reconcileSnapshots(freshInput);
        const run = buildReconciliationRun(freshInput, freshRecords, generatedAt);
        persistReconciliationRun(run, scenario.reconciliationOutputPaths);
        return run;
      };

      // First, unauthorized request: deliberately broken level 1 -> failed-validation.
      const failingDeps: AgentRunDeps = {
        rootDir: scenario.tempRoot,
        reconciliationInputPaths: scenario.reconciliationInputPaths,
        reconciliationOutputPaths: scenario.reconciliationOutputPaths,
        agentHistoryPaths: scenario.agentHistoryPaths,
        reasoner: createMockReasoner('#222222'),
        runLevel1: () => ({ level: 1, command: 'l1', passed: false }),
        runLevel2: () => ({ level: 2, command: 'l2', passed: true }),
        runLevel3: () => ({ level: 3, command: 'l3', passed: true }),
        runLevel4: () => ({ level: 4, command: 'l4', passed: true }),
        refreshCodeSnapshot: () => buildAndWriteCode(scenario.reconciliationInputPaths.codeCurrentPath),
        reRunReconciliation,
        promoteCodeBaseline: makePromoteCodeBaseline(scenario),
        promoteFigmaBaseline: makePromoteFigmaBaseline(scenario),
      };
      const firstAudit = await handleRunAgentRequest({ reconciliationId: target.reconciliationId }, failingDeps);
      assert.equal(firstAudit.outcome, 'failed-validation');
      assert.equal(firstAudit.humanReauthorized, false);

      const workingDeps: AgentRunDeps = { ...failingDeps, runLevel1: () => ({ level: 1, command: 'l1', passed: true }) };

      // A plain retry (no reauthorize) is still refused via the dashboard boundary.
      const blockedAudit = await handleRunAgentRequest({ reconciliationId: target.reconciliationId }, workingDeps);
      assert.equal(blockedAudit.outcome, 'no-safe-action');
      assert.equal(blockedAudit.policyDecision.verdict, 'BLOCKED');

      // Explicit reauthorization via the request body succeeds now that the underlying issue is fixed.
      const reauthorizedAudit = await handleRunAgentRequest({ reconciliationId: target.reconciliationId, reauthorize: true }, workingDeps);
      assert.equal(reauthorizedAudit.outcome, 'applied');
      assert.equal(reauthorizedAudit.humanReauthorized, true);
      assert.match(readFileSync(tokensCssPath, 'utf8'), /--widget-color:\s*#222222;/);

      // The original failed record remains, unmodified, immutable.
      assert.equal(firstAudit.outcome, 'failed-validation');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('a "sourceOfTruth" request field threads through to a human-directed resolution of a real both-changed-conflict, via the dashboard boundary', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'dashboard-handler-human-directed-'));
    try {
      const scenario = scaffold(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'typography.css');
      writeFileSync(tokensCssPath, ':root {\n  --widget-length: 20px;\n}\n', 'utf8');

      writeFileSync(
        scenario.reconciliationInputPaths.registryPath,
        JSON.stringify({
          registryUpdatedOn: '2026-01-01',
          components: [],
          tokens: [{ tokenId: 'widget-length', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/length', cssVariable: '--widget-length', consumedBy: [] }],
          textStyles: [],
          unresolved: [],
        }),
        'utf8',
      );
      writeFileSync(scenario.reconciliationInputPaths.manifestPath, JSON.stringify({ source: { extractedOn: '2026-01-01' } }), 'utf8');
      const writeFigma = (p: string, id: string, value: string) =>
        writeFileSync(
          p,
          JSON.stringify({
            schemaVersion: '1.0.0',
            snapshotId: id,
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: { fileKey: 'f', fileName: 'f', capturedAt: '2026-01-01T00:00:00.000Z' },
            pages: [],
            components: [],
            variables: [{ name: 'Widget/length', value, inferredType: 'FLOAT', consumedBy: [] }],
            textStyles: [],
          }),
          'utf8',
        );
      writeFigma(scenario.reconciliationInputPaths.figmaBaselinePath, 'fb-len', '20');
      writeFigma(scenario.reconciliationInputPaths.figmaCurrentPath, 'fc-len', '24');

      const buildAndWriteCode = (out: string) => writeCodeSnapshotFile(out, buildCodeSnapshot({ componentsDir: scenario.componentsDir, rootForRelativePaths: scenario.tempRoot, tokensDir: scenario.tokensDir }));
      buildAndWriteCode(scenario.reconciliationInputPaths.codeBaselinePath);
      writeFileSync(tokensCssPath, ':root {\n  --widget-length: 30px;\n}\n', 'utf8');
      buildAndWriteCode(scenario.reconciliationInputPaths.codeCurrentPath);

      const input = loadReconciliationInputs(scenario.reconciliationInputPaths);
      const records = reconcileSnapshots(input);
      const beforeRun = buildReconciliationRun(input, records, '2026-01-01T00:00:00.000Z');
      persistReconciliationRun(beforeRun, scenario.reconciliationOutputPaths);
      const target = beforeRun.records.find((r) => r.entityId === 'widget-length')!;
      assert.equal(target.status, 'both-changed-conflict');

      const alwaysPass = (level: number, command: string): ValidationStepResult => ({ level, command, passed: true });
      const deps: AgentRunDeps = {
        rootDir: scenario.tempRoot,
        reconciliationInputPaths: scenario.reconciliationInputPaths,
        reconciliationOutputPaths: scenario.reconciliationOutputPaths,
        agentHistoryPaths: scenario.agentHistoryPaths,
        reasoner: createMockReasoner('24px'),
        runLevel1: () => alwaysPass(1, 'l1'),
        runLevel2: () => alwaysPass(2, 'l2'),
        runLevel3: () => alwaysPass(3, 'l3'),
        runLevel4: () => alwaysPass(4, 'l4'),
        refreshCodeSnapshot: () => buildAndWriteCode(scenario.reconciliationInputPaths.codeCurrentPath),
        reRunReconciliation: (generatedAt: string) => {
          const freshInput = loadReconciliationInputs(scenario.reconciliationInputPaths);
          const freshRecords = reconcileSnapshots(freshInput);
          const run = buildReconciliationRun(freshInput, freshRecords, generatedAt);
          persistReconciliationRun(run, scenario.reconciliationOutputPaths);
          return run;
        },
        promoteCodeBaseline: makePromoteCodeBaseline(scenario),
        promoteFigmaBaseline: makePromoteFigmaBaseline(scenario),
      };

      // The request body carries the human's explicit choice — never
      // trusted blindly: runAgentForFinding independently re-validates
      // the finding's real entityType/status before acting on it.
      const audit = await handleRunAgentRequest({ reconciliationId: target.reconciliationId, sourceOfTruth: 'figma' }, deps);

      assert.equal(audit.outcome, 'applied');
      assert.equal(audit.humanDirected, true);
      assert.equal(audit.sourceOfTruth, 'figma');
      assert.match(readFileSync(tokensCssPath, 'utf8'), /--widget-length:\s*24px;/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('a "sourceOfTruth" request field against a SAFE (non-conflict) finding is refused via the dashboard boundary — scope is enforced server-side, not just hidden client-side', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'dashboard-handler-human-directed-scope-'));
    try {
      const scenario = scaffold(tempRoot);
      const tokensCssPath = path.join(scenario.tokensDir, 'colors.css');
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #111111;\n}\n', 'utf8');
      writeFileSync(
        scenario.reconciliationInputPaths.registryPath,
        JSON.stringify({ registryUpdatedOn: '2026-01-01', components: [], tokens: [{ tokenId: 'widget-color', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/color', cssVariable: '--widget-color', consumedBy: [] }], textStyles: [], unresolved: [] }),
        'utf8',
      );
      writeFileSync(scenario.reconciliationInputPaths.manifestPath, JSON.stringify({ source: { extractedOn: '2026-01-01' } }), 'utf8');
      const writeFigma = (p: string, id: string, value: string) =>
        writeFileSync(p, JSON.stringify({ schemaVersion: '1.0.0', snapshotId: id, generatedAt: '2026-01-01T00:00:00.000Z', source: { fileKey: 'f', fileName: 'f', capturedAt: '2026-01-01T00:00:00.000Z' }, pages: [], components: [], variables: [{ name: 'Widget/color', value, inferredType: 'COLOR', consumedBy: [] }], textStyles: [] }), 'utf8');
      writeFigma(scenario.reconciliationInputPaths.figmaBaselinePath, 'fb', '#111111');
      writeFigma(scenario.reconciliationInputPaths.figmaCurrentPath, 'fc', '#222222');

      const buildAndWriteCode = (out: string) => writeCodeSnapshotFile(out, buildCodeSnapshot({ componentsDir: scenario.componentsDir, rootForRelativePaths: scenario.tempRoot, tokensDir: scenario.tokensDir }));
      buildAndWriteCode(scenario.reconciliationInputPaths.codeBaselinePath);
      buildAndWriteCode(scenario.reconciliationInputPaths.codeCurrentPath);

      const input = loadReconciliationInputs(scenario.reconciliationInputPaths);
      const records = reconcileSnapshots(input);
      const beforeRun = buildReconciliationRun(input, records, '2026-01-01T00:00:00.000Z');
      persistReconciliationRun(beforeRun, scenario.reconciliationOutputPaths);
      const target = beforeRun.records.find((r) => r.entityId === 'widget-color')!;
      assert.equal(target.status, 'figma-only-change');

      const alwaysPass = (level: number, command: string): ValidationStepResult => ({ level, command, passed: true });
      const deps: AgentRunDeps = {
        rootDir: scenario.tempRoot,
        reconciliationInputPaths: scenario.reconciliationInputPaths,
        reconciliationOutputPaths: scenario.reconciliationOutputPaths,
        agentHistoryPaths: scenario.agentHistoryPaths,
        reasoner: createMockReasoner('#222222'),
        runLevel1: () => alwaysPass(1, 'l1'),
        runLevel2: () => alwaysPass(2, 'l2'),
        runLevel3: () => alwaysPass(3, 'l3'),
        runLevel4: () => alwaysPass(4, 'l4'),
        refreshCodeSnapshot: () => buildAndWriteCode(scenario.reconciliationInputPaths.codeCurrentPath),
        reRunReconciliation: (generatedAt: string) => {
          const freshInput = loadReconciliationInputs(scenario.reconciliationInputPaths);
          const freshRecords = reconcileSnapshots(freshInput);
          const run = buildReconciliationRun(freshInput, freshRecords, generatedAt);
          persistReconciliationRun(run, scenario.reconciliationOutputPaths);
          return run;
        },
        promoteCodeBaseline: makePromoteCodeBaseline(scenario),
        promoteFigmaBaseline: makePromoteFigmaBaseline(scenario),
      };

      await assert.rejects(() => handleRunAgentRequest({ reconciliationId: target.reconciliationId, sourceOfTruth: 'figma' }, deps), /only supported for token-level both-changed-conflict findings/);
      assert.equal(readFileSync(tokensCssPath, 'utf8'), ':root {\n  --widget-color: #111111;\n}\n');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
