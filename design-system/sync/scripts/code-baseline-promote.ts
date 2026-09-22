/**
 * Promotes exactly ONE token's value in the CODE baseline
 * (`code-snapshots/baseline.json`) — never a whole-file replacement
 * (that remains `code-baseline.ts`'s own `--force` mechanism, completely
 * untouched by this file) and never the Figma baseline.
 *
 * Why this exists: after `runAgentForFinding()` applies and verifies a
 * fix, the CODE baseline is deliberately never refreshed by the rest of
 * the pipeline (see agent-run.ts's long-standing "never refresh a
 * baseline" rule) — Stage 5's own reconciliation therefore compares the
 * new code value against the OLD baseline on every subsequent run,
 * forever. For a token whose Figma-resolved value and Code raw-literal
 * value are never byte-identical strings (e.g. a length: Figma reports
 * `"24"`, Code stores `"24px"`), this produces a *permanent*
 * `both-changed-conflict` record after every successful fix —
 * `both-changed-conflict` maps to policy verdict BLOCKED, so the
 * dashboard shows an already-resolved finding as newly BLOCKED forever.
 * (For tokens where the two raw strings DO match exactly — e.g. a
 * color, `"#222222"` on both sides — reconciliation already produces
 * `both-changed-compatible`, i.e. NOT_APPLICABLE, with no code change
 * needed here; this module only matters for the representational-gap
 * case.)
 *
 * This module is called ONLY from agent-run.ts's `runAgentForFinding`,
 * ONLY after `verifyResolution()` has ALREADY independently confirmed
 * (via the existing, unmodified Stage 6E verification layer) that this
 * exact edit resolved the finding it targeted. It never decides
 * anything about safety, policy, or verification itself — it is a
 * bookkeeping step on top of an already-proven-correct result.
 */
import { readCodeSnapshotFile, writeCodeSnapshotFile, archiveCodeSnapshot, computeCodeSnapshotId } from './code-snapshot.ts';
import { CODE_BASELINE_PATH, CODE_ARCHIVE_DIR } from './code-paths.ts';
import type { CodeSnapshot } from './code-snapshot-types.ts';

export class CodeBaselinePromoteError extends Error {}

export interface PromoteCodeBaselinePaths {
  codeBaselinePath: string;
  codeArchiveDir: string;
}

export interface PromoteCodeBaselineResult {
  previousValue: string;
  newSnapshotId: string;
}

/**
 * Updates baseline.json's ONE `tokenDefinitions` entry for `cssVariable`
 * to `newValue` — but only if its current baseline value is exactly
 * `expectedPreviousValue`, mirroring `applyEditToFile()`'s own
 * verify-before-write discipline: this refuses (throws, never silently
 * overwrites) if the baseline has drifted from what the caller expected
 * since the run started. Nothing else in the snapshot changes — not
 * `components[]`, not any other token — except `snapshotId` (recomputed
 * via the existing `computeCodeSnapshotId`, since it is a deterministic
 * content hash of the whole snapshot) and `generatedAt`.
 */
export function promoteCodeBaselineForToken(paths: PromoteCodeBaselinePaths, cssVariable: string, expectedPreviousValue: string, newValue: string): PromoteCodeBaselineResult {
  const baseline = readCodeSnapshotFile(paths.codeBaselinePath);

  const index = baseline.tokenDefinitions.findIndex((t) => t.cssVariable === cssVariable);
  if (index === -1) {
    throw new CodeBaselinePromoteError(`No baseline tokenDefinitions entry exists for "${cssVariable}" — refusing to promote a baseline entry that isn't there.`);
  }

  const existing = baseline.tokenDefinitions[index];
  if (existing.value !== expectedPreviousValue) {
    throw new CodeBaselinePromoteError(
      `Baseline value for "${cssVariable}" is "${existing.value}", not the expected "${expectedPreviousValue}" — refusing to promote (the baseline may have changed since this run started).`,
    );
  }

  const updatedTokenDefinitions = baseline.tokenDefinitions.map((t, i) => (i === index ? { ...t, value: newValue } : t));
  const newSnapshotId = computeCodeSnapshotId(baseline.components, updatedTokenDefinitions);

  const updatedSnapshot: CodeSnapshot = {
    ...baseline,
    snapshotId: newSnapshotId,
    generatedAt: new Date().toISOString(),
    tokenDefinitions: updatedTokenDefinitions,
  };

  writeCodeSnapshotFile(paths.codeBaselinePath, updatedSnapshot);
  archiveCodeSnapshot(paths.codeArchiveDir, updatedSnapshot);

  return { previousValue: existing.value, newSnapshotId };
}

/** The real, production baseline path — used by agent-run.ts's `createProductionAgentRunDeps()`. */
export function createProductionPromoteCodeBaselinePaths(): PromoteCodeBaselinePaths {
  return { codeBaselinePath: CODE_BASELINE_PATH, codeArchiveDir: CODE_ARCHIVE_DIR };
}
