import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createClaudeReasoner, createMockClaudeClient, createAnthropicClaudeClient, buildPrompt, ClaudeReasoningError } from './agent-claude-reasoner.ts';
import { runAgentForFinding, validateProposedEdit, type ReasonerContext, type AgentRunDeps } from './agent-run.ts';
import { promoteCodeBaselineForToken } from './code-baseline-promote.ts';
import { promoteFigmaBaselineForVariable } from './figma-baseline-promote.ts';
import { loadReconciliationInputs, buildReconciliationRun, persistReconciliationRun, type ReconcileInputPaths, type ReconciliationOutputPaths } from './reconcile.ts';
import { reconcileSnapshots } from './reconcile-compare.ts';
import { buildCodeSnapshot, writeCodeSnapshotFile } from './code-snapshot.ts';
import type { PolicyDecision } from './agent-policy-types.ts';
import type { EditTarget } from './agent-targeting-types.ts';
import type { ReconciliationRecord } from './reconcile-types.ts';

// =======================================================================
// A minimal, self-contained ReasonerContext fixture — mirrors
// agent-policy.test.ts / agent-targeting.test.ts's own plain-object-
// literal style. No filesystem I/O anywhere in the unit-test section.
// =======================================================================

function makeContext(overrides: Partial<ReasonerContext> = {}): ReasonerContext {
  const editTarget: EditTarget = { filePath: 'src/tokens/colors.css', kind: 'css-custom-property-value', declarationIdentifier: '--widget-color', currentValue: '#111111' };
  const policyDecision: PolicyDecision = {
    reconciliationId: 'rec-1',
    status: 'figma-only-change',
    verdict: 'SAFE',
    reason: 'fixture',
    requiredEvidence: [],
    requiredValidationLevels: [1, 2, 3, 4, 5, 6],
    requiresHumanApproval: false,
  };
  const record: ReconciliationRecord = {
    reconciliationId: 'rec-1',
    entityType: 'token',
    entityId: 'widget-color',
    registryId: 'widget-color',
    field: 'value',
    status: 'figma-only-change',
    figma: { current: '#222222', baseline: '#111111', changed: true },
    code: { current: '#111111', baseline: '#111111', changed: false },
    registryExpected: null,
    affectedComponents: [],
    sources: { figmaBaselineId: 'fb', figmaCurrentId: 'fc', codeBaselineId: 'cb', codeCurrentId: 'cc' },
    detail: 'fixture',
  };
  return {
    record,
    policyDecision,
    editTarget,
    fileContent: ':root {\n  --widget-color: #111111;\n  --other-color: #333333;\n}\n',
    siblingDeclarations: [{ identifier: '--other-color', value: '#333333' }],
    ...overrides,
  };
}

function jsonResponse(obj: unknown): string {
  return JSON.stringify(obj);
}

// =======================================================================
// 1-6, 8 — the adapter's own fail-closed behavior.
// =======================================================================

describe('createClaudeReasoner — adapter behavior', () => {
  test('1. a valid Claude response produces a valid ProposedEdit', async () => {
    const client = createMockClaudeClient(jsonResponse({ replacement: '#222222', reasoning: 'matches the current Figma value' }));
    const reasoner = createClaudeReasoner(client);
    const proposed = await Promise.resolve(reasoner(makeContext()));
    assert.deepEqual(proposed, {
      filePath: 'src/tokens/colors.css',
      declarationIdentifier: '--widget-color',
      before: '#111111',
      after: '#222222',
      rationale: 'matches the current Figma value',
    });
  });

  test('2. a malformed (non-JSON) response fails closed', async () => {
    const client = createMockClaudeClient('this is not json at all');
    const reasoner = createClaudeReasoner(client);
    await assert.rejects(() => Promise.resolve(reasoner(makeContext())), ClaudeReasoningError);
  });

  test('2b. JSON that is not an object (e.g. an array) fails closed', async () => {
    const client = createMockClaudeClient(jsonResponse(['#222222']));
    const reasoner = createClaudeReasoner(client);
    await assert.rejects(() => Promise.resolve(reasoner(makeContext())), ClaudeReasoningError);
  });

  test('3. a response missing "replacement" fails closed', async () => {
    const client = createMockClaudeClient(jsonResponse({ reasoning: 'no replacement field here' }));
    const reasoner = createClaudeReasoner(client);
    await assert.rejects(() => Promise.resolve(reasoner(makeContext())), ClaudeReasoningError);
  });

  test('3b. an empty-string "replacement" fails closed', async () => {
    const client = createMockClaudeClient(jsonResponse({ replacement: '   ', reasoning: 'x' }));
    const reasoner = createClaudeReasoner(client);
    await assert.rejects(() => Promise.resolve(reasoner(makeContext())), ClaudeReasoningError);
  });

  test('3c. an explicit refusal (replacement: null) fails closed with the given reasoning', async () => {
    const client = createMockClaudeClient(jsonResponse({ replacement: null, reasoning: 'not confident in the correct unit convention' }));
    const reasoner = createClaudeReasoner(client);
    await assert.rejects(() => Promise.resolve(reasoner(makeContext())), /not confident in the correct unit convention/);
  });

  test('4. Claude attempting to return a different file is structurally impossible — the adapter never reads a file path from the response at all, and always uses the authorized target\'s', async () => {
    // Even if Claude's raw text somehow smuggled a filePath-shaped key, the
    // strict-allowed-keys check in parseClaudeResponse rejects it outright
    // before the adapter would ever have a chance to use it.
    const client = createMockClaudeClient(jsonResponse({ replacement: '#222222', reasoning: 'x', filePath: 'src/tokens/OTHER.css' }));
    const reasoner = createClaudeReasoner(client);
    await assert.rejects(() => Promise.resolve(reasoner(makeContext())), /unexpected additional field/);
  });

  test('5. Claude attempting to return a different declaration is rejected the same way', async () => {
    const client = createMockClaudeClient(jsonResponse({ replacement: '#222222', reasoning: 'x', declarationIdentifier: '--other-color' }));
    const reasoner = createClaudeReasoner(client);
    await assert.rejects(() => Promise.resolve(reasoner(makeContext())), /unexpected additional field/);
  });

  test('6. Claude proposing an unrelated multi-file/multi-change edit is rejected', async () => {
    const client = createMockClaudeClient(
      jsonResponse({ replacement: '#222222', reasoning: 'x', additionalEdits: [{ file: 'src/tokens/spacing.css', value: '4px' }] }),
    );
    const reasoner = createClaudeReasoner(client);
    await assert.rejects(() => Promise.resolve(reasoner(makeContext())), /unexpected additional field/);
  });

  test('6b. a patch/diff-shaped "replacement" is rejected rather than treated as a scalar value', async () => {
    const client = createMockClaudeClient(jsonResponse({ replacement: '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new', reasoning: 'x' }));
    const reasoner = createClaudeReasoner(client);
    await assert.rejects(() => Promise.resolve(reasoner(makeContext())), /patch\/diff/);
  });

  test('6c. a multi-line "replacement" (even without diff markers) is rejected — a scalar value never contains a newline', async () => {
    const client = createMockClaudeClient(jsonResponse({ replacement: '#222222\n#333333', reasoning: 'x' }));
    const reasoner = createClaudeReasoner(client);
    await assert.rejects(() => Promise.resolve(reasoner(makeContext())), /patch\/diff/);
  });

  test('7. the expected minimal value change is accepted by the adapter, and then accepted by the existing validateProposedEdit() layer unmodified', async () => {
    const context = makeContext();
    const client = createMockClaudeClient(jsonResponse({ replacement: '#222222', reasoning: 'aligns with the current Figma value' }));
    const reasoner = createClaudeReasoner(client);
    const proposed = await reasoner(context);
    const result = validateProposedEdit(proposed, context.editTarget);
    assert.equal(result.valid, true);
  });

  test('8. the mock client can be injected and never makes a network call', async () => {
    let called = false;
    const client = createMockClaudeClient(() => {
      called = true;
      return jsonResponse({ replacement: '#222222', reasoning: 'x' });
    });
    const reasoner = createClaudeReasoner(client);
    await Promise.resolve(reasoner(makeContext()));
    assert.equal(called, true); // the mock ran, but it's a plain function — no fetch/network module was ever touched
  });

  test('a non-string "reasoning" fails closed', async () => {
    const client = createMockClaudeClient(jsonResponse({ replacement: '#222222', reasoning: 42 }));
    const reasoner = createClaudeReasoner(client);
    await assert.rejects(() => Promise.resolve(reasoner(makeContext())), ClaudeReasoningError);
  });

  test('a client-level failure (e.g. simulated network error) propagates as a rejected promise, not a silent fallback', async () => {
    const client = { requestStructuredEdit: async () => { throw new Error('simulated network failure'); } };
    const reasoner = createClaudeReasoner(client);
    await assert.rejects(() => Promise.resolve(reasoner(makeContext())), /simulated network failure/);
  });
});

describe('createAnthropicClaudeClient — credential handling', () => {
  test('fails closed with a clear error when ANTHROPIC_API_KEY is absent — never invents or hard-codes a credential', () => {
    assert.throws(() => createAnthropicClaudeClient({}), ClaudeReasoningError);
  });

  test('constructs successfully when a key is present (no network call is made merely by constructing the client)', () => {
    assert.doesNotThrow(() => createAnthropicClaudeClient({ ANTHROPIC_API_KEY: 'fixture-key-not-a-real-credential' }));
  });
});

describe('buildPrompt', () => {
  test('includes the finding, policy decision, exact target, current value, file content, and sibling declarations', () => {
    const prompt = buildPrompt(makeContext());
    assert.match(prompt, /widget-color/);
    assert.match(prompt, /figma-only-change/);
    assert.match(prompt, /SAFE/);
    assert.match(prompt, /src\/tokens\/colors\.css/);
    assert.match(prompt, /--widget-color/);
    assert.match(prompt, /#111111/);
    assert.match(prompt, /--other-color: #333333/);
  });

  test('explicitly states the constraints: single target only, no renames, refuse if uncertain', () => {
    const prompt = buildPrompt(makeContext());
    assert.match(prompt, /ONLY/);
    assert.match(prompt, /[Dd]o not rename/);
    assert.match(prompt, /refuse/i);
  });
});

// =======================================================================
// 9 (partial — full suite confirmed separately) + a real end-to-end proof
// that the deterministic agent lifecycle, unmodified, produces a safe
// ProposedEdit when driven by the Claude reasoning boundary instead of
// the plain mock reasoner. The discrepancy below emerges from real
// reconciliation machinery, never a hand-fabricated ReconciliationRecord
// — same discipline as agent-run.test.ts's own Part 12 test.
// =======================================================================

describe('createClaudeReasoner — integration with the real deterministic agent lifecycle', () => {
  test('a genuine figma-only-change resolves end-to-end when driven by createClaudeReasoner(mockClient) instead of createMockReasoner', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-claude-integration-'));
    try {
      const componentsDir = path.join(tempRoot, 'src', 'components');
      const tokensDir = path.join(tempRoot, 'src', 'tokens');
      mkdirSync(componentsDir, { recursive: true });
      mkdirSync(tokensDir, { recursive: true });
      const tokensCssPath = path.join(tokensDir, 'colors.css');
      writeFileSync(tokensCssPath, ':root {\n  --widget-color: #111111;\n}\n', 'utf8');

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
      const agentHistoryPaths = { recordsDir: path.join(tempRoot, 'agent-history', 'records'), latestPath: path.join(tempRoot, 'agent-history', 'latest.json') };

      writeFileSync(
        reconciliationInputPaths.registryPath,
        JSON.stringify({
          registryUpdatedOn: '2026-01-01',
          components: [],
          tokens: [{ tokenId: 'widget-color', sourceType: 'figma-variable', figmaName: 'Mapped/Widget/color', cssVariable: '--widget-color', consumedBy: [] }],
          textStyles: [],
          unresolved: [],
        }),
        'utf8',
      );
      writeFileSync(reconciliationInputPaths.manifestPath, JSON.stringify({ source: { extractedOn: '2026-01-01' } }), 'utf8');

      const makeFigmaSnapshot = (snapshotId: string, value: string) =>
        JSON.stringify({
          schemaVersion: '1.0.0',
          snapshotId,
          generatedAt: '2026-01-01T00:00:00.000Z',
          source: { fileKey: 'fixture', fileName: 'fixture', capturedAt: '2026-01-01T00:00:00.000Z' },
          pages: [],
          components: [],
          variables: [{ name: 'Widget/color', value, inferredType: 'COLOR', consumedBy: [] }],
          textStyles: [],
        });
      writeFileSync(reconciliationInputPaths.figmaBaselinePath, makeFigmaSnapshot('figma-baseline', '#111111'), 'utf8');
      writeFileSync(reconciliationInputPaths.figmaCurrentPath, makeFigmaSnapshot('figma-current', '#222222'), 'utf8');

      const buildAndWriteCode = (outputPath: string) => {
        const snapshot = buildCodeSnapshot({ componentsDir, rootForRelativePaths: tempRoot, tokensDir });
        writeCodeSnapshotFile(outputPath, snapshot);
      };
      buildAndWriteCode(reconciliationInputPaths.codeBaselinePath);
      buildAndWriteCode(reconciliationInputPaths.codeCurrentPath);

      const reconcileAndPersist = (generatedAt: string) => {
        const input = loadReconciliationInputs(reconciliationInputPaths);
        const records = reconcileSnapshots(input);
        const run = buildReconciliationRun(input, records, generatedAt);
        persistReconciliationRun(run, reconciliationOutputPaths);
        return run;
      };

      const beforeRun = reconcileAndPersist('2026-01-01T00:00:00.000Z');
      const targetedRecord = beforeRun.records.find((r) => r.entityId === 'widget-color');
      assert.ok(targetedRecord);
      assert.equal(targetedRecord?.status, 'figma-only-change');

      // The ONLY thing replaced here is the Claude API boundary itself —
      // everything else (policy, targeting, edit, validation, re-snapshot,
      // re-reconciliation, verification, audit) is the real, unmodified
      // agent-run.ts lifecycle.
      const mockClient = createMockClaudeClient(jsonResponse({ replacement: '#222222', reasoning: 'matches the current Figma value; both sides use plain hex colors here' }));

      const deps: AgentRunDeps = {
        rootDir: tempRoot,
        reconciliationInputPaths,
        reconciliationOutputPaths,
        agentHistoryPaths,
        reasoner: createClaudeReasoner(mockClient),
        runLevel1: () => ({ level: 1, command: 'fixture: CSS syntax sanity', passed: true }),
        runLevel2: () => ({ level: 2, command: 'fixture: re-extraction check', passed: true }),
        runLevel3: () => ({ level: 3, command: 'fixture: build not applicable', passed: true }),
        runLevel4: () => ({ level: 4, command: 'fixture: storybook not applicable', passed: true }),
        refreshCodeSnapshot: () => buildAndWriteCode(reconciliationInputPaths.codeCurrentPath),
        reRunReconciliation: (generatedAt: string) => reconcileAndPersist(generatedAt),
        promoteCodeBaseline: (cssVariable: string, previousValue: string, newValue: string) => {
          promoteCodeBaselineForToken(
            { codeBaselinePath: reconciliationInputPaths.codeBaselinePath, codeArchiveDir: path.join(tempRoot, 'code-snapshots', 'archive') },
            cssVariable,
            previousValue,
            newValue,
          );
        },
        promoteFigmaBaseline: (variableName: string, previousValue: string, newValue: string) => {
          promoteFigmaBaselineForVariable(
            { figmaBaselinePath: reconciliationInputPaths.figmaBaselinePath, figmaArchiveDir: path.join(tempRoot, 'figma-snapshots', 'archive') },
            variableName,
            previousValue,
            newValue,
          );
        },
      };

      const audit = await runAgentForFinding(targetedRecord!.reconciliationId, deps, '2026-01-02T00:00:00.000Z');

      assert.equal(audit.outcome, 'applied');
      assert.deepEqual(audit.filesModified, ['src/tokens/colors.css']);
      assert.deepEqual(audit.change, { before: '#111111', after: '#222222' });
      assert.match(readFileSync(tokensCssPath, 'utf8'), /--widget-color:\s*#222222;/);
      assert.equal(audit.findingAfter, 'resolved');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
