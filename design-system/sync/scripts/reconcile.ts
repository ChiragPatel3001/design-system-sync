/**
 * `npm run sync:reconcile` — the Stage 5D orchestration/persistence layer
 * on top of Stage 5C's pure `reconcileSnapshots()`. This module adds NO
 * new reconciliation semantics of its own: it loads the five already-
 * persisted inputs Stage 5C's function needs, calls that function
 * unmodified, and writes what it returns to disk. It never decides
 * whether a record is "safe", never proposes or applies a fix, never
 * contacts Figma, and never writes to any design-system source-of-truth
 * file (registry.json, any baseline, any snapshot, source/Storybook
 * files) — the only files this module ever writes are its own output
 * under design-system/sync/reconciliation/.
 *
 *   Figma snapshot ─┐
 *                    ├─> Stage 5C pure reconciliation ─> ReconciliationRecord[]
 *   Code snapshot ───┤
 *                    │
 *   Registry ────────┘
 *                          │
 *                          ▼
 *                    Stage 5D CLI (this file)
 *                          │
 *                          ├─> immutable run record (reconciliation/records/)
 *                          └─> latest.json (mutable convenience pointer)
 *
 * Reads the CURRENT ON-DISK state only — never rebuilds/refreshes a
 * snapshot itself (unlike check.ts/figma-check.ts/code-check.ts, which
 * DO rebuild "current" from source on every run). Figma baseline/current
 * and Code baseline/current are read verbatim from their persisted JSON
 * files; the registry snapshot is built fresh from registry.json (there
 * is no separate persisted "registry current.json" input here — the
 * registry has no baseline/current split in reconcileSnapshots()'s
 * signature, only Figma and Code do); the crosswalk is built fresh from
 * registry.json using the existing, unmodified Stage 5B logic
 * (`buildReconciliationCrosswalk`) — never reimplemented here.
 *
 * This deliberately means: if the persisted Code baseline.json predates
 * Stage 5A's tokenDefinitions field (as the real one in this repository
 * currently does), this command does NOT silently refresh or rewrite it
 * — it uses it exactly as reconcile-compare.ts already handles that case
 * (a defensive `?? []`, producing real code-only-change records for
 * every registry-mapped token), and additionally surfaces it as an
 * explicit warning (see computeFreshnessWarnings) so it's visible in the
 * run output, not just buried in a long record list.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGISTRY_PATH, MANIFEST_PATH } from './paths.ts';
import { FIGMA_BASELINE_PATH, FIGMA_CURRENT_PATH } from './figma-paths.ts';
import { CODE_BASELINE_PATH, CODE_CURRENT_PATH } from './code-paths.ts';
import { RECONCILIATION_RECORDS_DIR, RECONCILIATION_LATEST_PATH, relToRoot } from './reconcile-paths.ts';
import { loadRegistry, loadManifestMeta, buildSnapshot } from './snapshot.ts';
import { readFigmaSnapshotFile } from './figma-snapshot.ts';
import { readCodeSnapshotFile } from './code-snapshot.ts';
import { loadRegistryJson, buildReconciliationCrosswalk } from './reconcile-crosswalk.ts';
import { reconcileSnapshots, type ReconcileSnapshotsInput, type RegistryUnresolvedEntry } from './reconcile-compare.ts';
import type { ReconciliationRecord, ReconciliationRun, ReconciliationStatus, ReconciliationWarning } from './reconcile-types.ts';

const SCHEMA_VERSION = '1.0.0';

/** Raised by loadReconciliationInputs (a required input is missing/malformed) or persistReconciliationRun (an immutable record would be overwritten). Always caught by main(), never left to crash with a raw stack trace — the message alone identifies exactly what went wrong. */
export class ReconcileError extends Error {}

// ---------------------------------------------------------------------
// Input loading — the only I/O in this module besides persistence.
// Every loader below is REUSED, not reimplemented, from the engine that
// owns it (snapshot.ts, figma-snapshot.ts, code-snapshot.ts,
// reconcile-crosswalk.ts) — this module only adds a clear, specific
// "which input failed and why" error around each call.
// ---------------------------------------------------------------------

export interface ReconcileInputPaths {
  registryPath: string;
  manifestPath: string;
  figmaBaselinePath: string;
  figmaCurrentPath: string;
  codeBaselinePath: string;
  codeCurrentPath: string;
}

function loadOrFail<T>(label: string, loader: () => T): T {
  try {
    return loader();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ReconcileError(`Could not load required input "${label}": ${reason}`);
  }
}

/**
 * Loads every input reconcileSnapshots() needs, from the files currently
 * on disk — no filesystem writes, no Figma/network calls, no rebuilding.
 * Throws ReconcileError (never a raw fs/JSON error) naming exactly which
 * input failed, whether that's because the file doesn't exist or because
 * its content isn't valid JSON.
 */
export function loadReconciliationInputs(paths: ReconcileInputPaths): ReconcileSnapshotsInput {
  const registryJsonForSnapshot = loadOrFail(paths.registryPath, () => loadRegistry(paths.registryPath));
  const manifestMeta = loadOrFail(paths.manifestPath, () => loadManifestMeta(paths.manifestPath));
  const registrySnapshot = loadOrFail('registry snapshot (derived from registry.json + manifest)', () =>
    buildSnapshot(registryJsonForSnapshot, manifestMeta, {
      registryPath: relToRootSafe(paths.registryPath),
      manifestPath: relToRootSafe(paths.manifestPath),
    }),
  );

  const figmaBaseline = loadOrFail(paths.figmaBaselinePath, () => readFigmaSnapshotFile(paths.figmaBaselinePath));
  const figmaCurrent = loadOrFail(paths.figmaCurrentPath, () => readFigmaSnapshotFile(paths.figmaCurrentPath));
  const codeBaseline = loadOrFail(paths.codeBaselinePath, () => readCodeSnapshotFile(paths.codeBaselinePath));
  const codeCurrent = loadOrFail(paths.codeCurrentPath, () => readCodeSnapshotFile(paths.codeCurrentPath));

  const registryJsonForCrosswalk = loadOrFail(paths.registryPath, () => loadRegistryJson(paths.registryPath));
  const crosswalk = loadOrFail('reconciliation crosswalk (derived from registry.json)', () =>
    buildReconciliationCrosswalk(registryJsonForCrosswalk, { registryPath: relToRootSafe(paths.registryPath) }),
  );

  const registryUnresolved = loadOrFail(`${paths.registryPath} (unresolved[])`, () => {
    const raw = JSON.parse(readFileSync(paths.registryPath, 'utf8')) as { unresolved?: RegistryUnresolvedEntry[] };
    return raw.unresolved ?? [];
  });

  return { registrySnapshot, registryUnresolved, figmaBaseline, figmaCurrent, codeBaseline, codeCurrent, crosswalk };
}

/** path.relative() against an unrelated root would still work for display purposes, but a path that isn't under ROOT at all (e.g. a test fixture in the OS temp dir) shouldn't be forced through reconcile-paths.ts's ROOT-anchored relToRoot — this falls back to the absolute path in that case. */
function relToRootSafe(absolutePath: string): string {
  try {
    const rel = relToRoot(absolutePath);
    return rel.startsWith('..') ? absolutePath : rel;
  } catch {
    return absolutePath;
  }
}

// ---------------------------------------------------------------------
// Freshness warnings — deterministic, based only on the inputs' own
// recorded timestamps compared against EACH OTHER (never against
// wall-clock "now"), plus one structural check. Never changes a
// ReconciliationRecord's status.
// ---------------------------------------------------------------------

export const WARNING_DATE_MISMATCH = 'figma-code-registry-date-mismatch';
export const WARNING_CODE_BASELINE_MISSING_TOKEN_DEFINITIONS = 'code-baseline-missing-token-definitions';

function dateOnly(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

export interface FreshnessInput {
  registryUpdatedOn: string;
  figmaCapturedAt: string;
  codeGeneratedAt: string;
  codeBaselineHasTokenDefinitions: boolean;
}

/**
 * Compares each input's own recorded date against the others' — never
 * `new Date()` — at calendar-day granularity (the natural, non-arbitrary
 * granularity `registryUpdatedOn` itself already uses; no numeric "N
 * hours/days" threshold is invented). A mismatch is reported as a
 * warning, never as a change to any record's status.
 */
export function computeFreshnessWarnings(input: FreshnessInput): ReconciliationWarning[] {
  const warnings: ReconciliationWarning[] = [];

  const dates = {
    registry: dateOnly(input.registryUpdatedOn),
    figma: dateOnly(input.figmaCapturedAt),
    code: dateOnly(input.codeGeneratedAt),
  };
  if (new Set(Object.values(dates)).size > 1) {
    warnings.push({
      code: WARNING_DATE_MISMATCH,
      message: `Inputs were captured/updated on different calendar dates — registry: ${dates.registry}, Figma current: ${dates.figma}, Code current: ${dates.code}. This does not change any reconciliation result; it only means the three sources were last touched at different times.`,
    });
  }

  if (!input.codeBaselineHasTokenDefinitions) {
    warnings.push({
      code: WARNING_CODE_BASELINE_MISSING_TOKEN_DEFINITIONS,
      message:
        'The Code baseline has no tokenDefinitions field (it predates Stage 5A). Every registry-mapped token will likely appear as a code-side change against this baseline until it is refreshed — this run did not refresh it (see reconcile-compare.ts\'s defensive handling of this exact condition).',
    });
  }

  return warnings.sort((a, b) => a.code.localeCompare(b.code));
}

// ---------------------------------------------------------------------
// Deterministic run identity — same sortKeysDeep+sha256+slice(16)
// approach every snapshot engine already uses (snapshot.ts,
// code-snapshot.ts, figma-snapshot.ts, and reconcile-compare.ts's own
// per-record reconciliationId), duplicated locally rather than imported,
// consistent with this project's established per-engine convention.
// Deliberately NOT reused by importing one of those modules' hashing
// helpers: none of them export theirs, and duplicating four lines is
// cheaper than adding a shared coupling those engines were specifically
// designed to avoid.
// ---------------------------------------------------------------------

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export interface RunIdSources {
  registrySnapshotId: string;
  figmaBaselineId: string;
  figmaCurrentId: string;
  codeBaselineId: string;
  codeCurrentId: string;
}

/**
 * Deterministic: a pure function of the five source content-hashes plus
 * the final records array. Never includes generatedAt, filesystem
 * ordering (the records array is already deterministically sorted by
 * reconcileSnapshots() itself before this is called), machine-specific
 * paths, or randomness. Including the five source ids (not just
 * `records`) means even a run that happens to produce zero records still
 * gets a runId tied to exactly which inputs produced that empty result —
 * two different "nothing changed" states from different inputs don't
 * collide.
 */
export function computeRunId(sources: RunIdSources, records: ReconciliationRecord[]): string {
  const canonical = JSON.stringify(sortKeysDeep({ sources, records }));
  return sha256(canonical).slice(0, 16);
}

// ---------------------------------------------------------------------
// Assembling the run (pure — generatedAt is a parameter, never generated
// internally, so this stays as testable/deterministic as everything
// above it).
// ---------------------------------------------------------------------

const ALL_STATUSES: ReconciliationStatus[] = [
  'figma-only-change',
  'code-only-change',
  'both-changed-compatible',
  'both-changed-conflict',
  'registry-expectation-mismatch',
  'unmapped-figma-entity',
  'unmapped-code-entity',
  'deleted-figma-entity',
  'deleted-code-entity',
  'identity-mismatch',
  'intentional-documented-deviation',
  'out-of-scope-entity',
];

function emptyStatusCounts(): Record<ReconciliationStatus, number> {
  const counts = {} as Record<ReconciliationStatus, number>;
  for (const status of ALL_STATUSES) counts[status] = 0;
  return counts;
}

export function buildReconciliationRun(
  input: ReconcileSnapshotsInput,
  records: ReconciliationRecord[],
  generatedAt: string,
): ReconciliationRun {
  const sources = {
    registrySnapshotId: input.registrySnapshot.snapshotId,
    registryUpdatedOn: input.registrySnapshot.sources.registryUpdatedOn,
    figmaBaselineId: input.figmaBaseline.snapshotId,
    figmaCurrentId: input.figmaCurrent.snapshotId,
    codeBaselineId: input.codeBaseline.snapshotId,
    codeCurrentId: input.codeCurrent.snapshotId,
  };

  const runId = computeRunId(sources, records);

  const statusCounts = emptyStatusCounts();
  for (const record of records) statusCounts[record.status]++;

  const warnings = computeFreshnessWarnings({
    registryUpdatedOn: sources.registryUpdatedOn,
    figmaCapturedAt: input.figmaCurrent.source.capturedAt,
    codeGeneratedAt: input.codeCurrent.generatedAt,
    codeBaselineHasTokenDefinitions: Array.isArray(input.codeBaseline.tokenDefinitions),
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    generatedAt,
    sources,
    recordCount: records.length,
    conflictCount: statusCounts['both-changed-conflict'],
    statusCounts,
    warnings,
    records,
  };
}

// ---------------------------------------------------------------------
// Persistence. Only ever called with an already-complete, already-
// serializable ReconciliationRun — nothing partial is ever written.
// ---------------------------------------------------------------------

export interface ReconciliationOutputPaths {
  recordsDir: string;
  latestPath: string;
}

/**
 * Writes the immutable per-run record (never overwritten — mirrors
 * check.ts/figma-check.ts/code-check.ts's own "refuse to clobber"
 * precedent for their history files) and then replaces latest.json (a
 * full copy of the same content — mirrors code-snapshots/current.json
 * being a full copy alongside baseline.json, not a thin pointer).
 * Serializes BEFORE writing anything, so a serialization failure can
 * never leave a half-written file on disk.
 */
export function persistReconciliationRun(run: ReconciliationRun, outputPaths: ReconciliationOutputPaths): { recordPath: string } {
  const serialized = JSON.stringify(run, null, 2) + '\n';

  const fileSafeStamp = run.generatedAt.replace(/[:.]/g, '-');
  const recordPath = path.join(outputPaths.recordsDir, `${fileSafeStamp}_${run.runId}.json`);

  if (existsSync(recordPath)) {
    throw new ReconcileError(`Refusing to overwrite existing immutable reconciliation record at ${recordPath}.`);
  }

  mkdirSync(outputPaths.recordsDir, { recursive: true });
  writeFileSync(recordPath, serialized, 'utf8');

  mkdirSync(path.dirname(outputPaths.latestPath), { recursive: true });
  writeFileSync(outputPaths.latestPath, serialized, 'utf8');

  return { recordPath };
}

// ---------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------

function printSummary(run: ReconciliationRun): void {
  console.log(`Reconciliation run: ${run.runId}  (${run.generatedAt})`);
  console.log(`  registryUpdatedOn:  ${run.sources.registryUpdatedOn}`);
  console.log(`  Figma snapshot:     ${run.sources.figmaCurrentId}  (baseline ${run.sources.figmaBaselineId})`);
  console.log(`  Code snapshot:      ${run.sources.codeCurrentId}  (baseline ${run.sources.codeBaselineId})`);

  if (run.warnings.length > 0) {
    console.log('');
    console.log(`Warnings (${run.warnings.length}):`);
    for (const warning of run.warnings) {
      console.log(`  - [${warning.code}] ${warning.message}`);
    }
  }

  console.log('');
  if (run.recordCount === 0) {
    console.log('No reconciliation records — no drift or disagreement detected across Figma, Code, and the registry.');
    return;
  }

  console.log(`${run.recordCount} reconciliation record(s):`);
  for (const status of ALL_STATUSES) {
    if (run.statusCounts[status] > 0) console.log(`  ${status}: ${run.statusCounts[status]}`);
  }
  console.log(`  conflicts (both-changed-conflict): ${run.conflictCount}`);
}

function main(): void {
  let input: ReconcileSnapshotsInput;
  try {
    input = loadReconciliationInputs({
      registryPath: REGISTRY_PATH,
      manifestPath: MANIFEST_PATH,
      figmaBaselinePath: FIGMA_BASELINE_PATH,
      figmaCurrentPath: FIGMA_CURRENT_PATH,
      codeBaselinePath: CODE_BASELINE_PATH,
      codeCurrentPath: CODE_CURRENT_PATH,
    });
  } catch (err) {
    console.error(err instanceof ReconcileError ? err.message : `Unexpected error loading reconciliation inputs: ${err}`);
    process.exitCode = 1;
    return;
  }

  // reconcileSnapshots() is Stage 5C's pure, unmodified function — this
  // module makes no comparison/semantic decisions of its own.
  const records = reconcileSnapshots(input);
  const generatedAt = new Date().toISOString();
  const run = buildReconciliationRun(input, records, generatedAt);

  printSummary(run);

  try {
    const { recordPath } = persistReconciliationRun(run, {
      recordsDir: RECONCILIATION_RECORDS_DIR,
      latestPath: RECONCILIATION_LATEST_PATH,
    });
    console.log('');
    console.log(`Reconciliation record written: ${relToRoot(recordPath)}`);
    console.log(`latest.json updated:           ${relToRoot(RECONCILIATION_LATEST_PATH)}`);
  } catch (err) {
    console.error(err instanceof ReconcileError ? err.message : `Unexpected error persisting the reconciliation run: ${err}`);
    process.exitCode = 1;
    return;
  }
}

// Only run when this file is executed directly (`node reconcile.ts` / `npm
// run sync:reconcile`), never when reconcile.test.ts (or anything else)
// imports the pure/testable functions above — otherwise merely importing
// this module for its exports would trigger a real run against the real
// repository, which is exactly what section 13's path-injection
// requirement and the "never use real repository files as mutable test
// fixtures" rule exist to prevent.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
