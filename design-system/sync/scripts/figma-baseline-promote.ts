/**
 * Promotes exactly ONE variable's value in the FIGMA baseline
 * (`figma-snapshots/baseline.json`) — never a whole-file replacement
 * (that remains `figma-baseline.ts`'s own mechanism, completely
 * untouched by this file) and never the Code baseline.
 *
 * Why this exists: `code-baseline-promote.ts` promotes only the CODE
 * baseline after a successful apply, which leaves the FIGMA baseline
 * permanently stale relative to Figma's own current value. Since
 * reconcile-compare.ts compares each side against its OWN baseline
 * independently, that stale Figma baseline makes the very same entity
 * resurface as a fresh SAFE figma-only-change finding on every
 * subsequent reconcile — even though code and Figma are now genuinely
 * converged. This module closes that gap for the one case where it's
 * safe to: a `figma-only-change` SAFE apply, where Figma's own current
 * value is exactly the value that was just applied to code (see
 * agent-run.ts's call site — this is never invoked for a
 * code-only-change/REVIEW finding, and never for a both-changed-conflict
 * or any future human-directed resolution).
 *
 * This module is called ONLY from agent-run.ts's `runAgentForFinding`,
 * ONLY after the CODE baseline promotion for the same run has already
 * succeeded. It never decides anything about safety, policy, or
 * verification itself — it is a bookkeeping step on top of an
 * already-proven-correct result.
 */
import { readFigmaSnapshotFile, writeFigmaSnapshotFile, archiveFigmaSnapshot, computeFigmaSnapshotId } from './figma-snapshot.ts';
import { FIGMA_BASELINE_PATH, FIGMA_ARCHIVE_DIR } from './figma-paths.ts';
import type { FigmaSnapshot } from './figma-snapshot-types.ts';

export class FigmaBaselinePromoteError extends Error {}

export interface PromoteFigmaBaselinePaths {
  figmaBaselinePath: string;
  figmaArchiveDir: string;
}

export interface PromoteFigmaBaselineResult {
  previousValue: string;
  newSnapshotId: string;
}

/**
 * Updates baseline.json's ONE `variables` entry for `variableName`
 * (the normalized Figma variable name — the same join key
 * reconcile-compare.ts uses) to `newValue` — but only if its current
 * baseline value is exactly `expectedPreviousValue`, mirroring
 * `promoteCodeBaselineForToken`'s own verify-before-write discipline:
 * this refuses (throws, never silently overwrites) if the baseline has
 * drifted from what the caller expected since the run started. Nothing
 * else in the snapshot changes — not `components[]`, not `pages`, not
 * `textStyles`, not any other variable — except `snapshotId`
 * (recomputed via the existing `computeFigmaSnapshotId`) and
 * `generatedAt`.
 */
export function promoteFigmaBaselineForVariable(
  paths: PromoteFigmaBaselinePaths,
  variableName: string,
  expectedPreviousValue: string,
  newValue: string,
): PromoteFigmaBaselineResult {
  const baseline = readFigmaSnapshotFile(paths.figmaBaselinePath);

  const index = baseline.variables.findIndex((v) => v.name === variableName);
  if (index === -1) {
    throw new FigmaBaselinePromoteError(`No baseline variables entry exists for "${variableName}" — refusing to promote a baseline entry that isn't there.`);
  }

  const existing = baseline.variables[index];
  if (existing.value !== expectedPreviousValue) {
    throw new FigmaBaselinePromoteError(
      `Baseline value for "${variableName}" is "${existing.value}", not the expected "${expectedPreviousValue}" — refusing to promote (the baseline may have changed since this run started).`,
    );
  }

  const updatedVariables = baseline.variables.map((v, i) => (i === index ? { ...v, value: newValue } : v));
  const newSnapshotId = computeFigmaSnapshotId({ pages: baseline.pages, components: baseline.components, variables: updatedVariables, textStyles: baseline.textStyles });

  const updatedSnapshot: FigmaSnapshot = {
    ...baseline,
    snapshotId: newSnapshotId,
    generatedAt: new Date().toISOString(),
    variables: updatedVariables,
  };

  writeFigmaSnapshotFile(paths.figmaBaselinePath, updatedSnapshot);
  archiveFigmaSnapshot(paths.figmaArchiveDir, updatedSnapshot);

  return { previousValue: existing.value, newSnapshotId };
}

/** The real, production baseline path — used by agent-run.ts's `createProductionAgentRunDeps()`. */
export function createProductionPromoteFigmaBaselinePaths(): PromoteFigmaBaselinePaths {
  return { figmaBaselinePath: FIGMA_BASELINE_PATH, figmaArchiveDir: FIGMA_ARCHIVE_DIR };
}
