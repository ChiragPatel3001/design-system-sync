/**
 * `npm run sync:code-check` — builds the current CodeSnapshot from
 * src/components/**, compares it against the code baseline, prints what
 * it finds, and appends an immutable record to
 * design-system/sync/code-snapshots/history/. Reads only source files;
 * never touches the registry mapping file, the Figma-extraction manifest,
 * or Figma, and never writes to src/components/**.
 *
 * `refreshCodeSnapshot()` is the actual work, extracted and exported so
 * the dashboard's "Run Reconcile" action
 * (dashboard-reconcile-handler.ts) can call the SAME function this CLI
 * uses rather than a second copy of it. `main()` below is now a thin CLI
 * wrapper around it — same console output, same behavior, unchanged.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPONENTS_DIR,
  TOKENS_DIR,
  ROOT,
  CODE_BASELINE_PATH,
  CODE_CURRENT_PATH,
  CODE_ARCHIVE_DIR,
  CODE_HISTORY_DIR,
  relToRoot,
} from './code-paths.ts';
import { buildCodeSnapshot, writeCodeSnapshotFile, readCodeSnapshotFile, archiveCodeSnapshot } from './code-snapshot.ts';
import { compareCodeSnapshots, type CodeChangeRecord } from './code-compare.ts';
import type { CodeSnapshot } from './code-snapshot-types.ts';

export class CodeCheckError extends Error {}

export interface CodeRefreshResult {
  previous: CodeSnapshot;
  current: CodeSnapshot;
  changes: CodeChangeRecord[];
  historyPath: string;
}

/**
 * Rebuilds the current CodeSnapshot from source, writes/archives it,
 * compares it against the baseline, and appends an immutable history
 * record — exactly what `npm run sync:code-check` has always done. Never
 * refreshes the baseline. Throws `CodeCheckError` (never a raw fs error)
 * on a missing baseline or a history-record filename collision.
 */
export function refreshCodeSnapshot(): CodeRefreshResult {
  if (!existsSync(CODE_BASELINE_PATH)) {
    throw new CodeCheckError('No code baseline found. Run `npm run sync:code-baseline` first to establish one.');
  }

  const previous = readCodeSnapshotFile(CODE_BASELINE_PATH);
  const current = buildCodeSnapshot({ componentsDir: COMPONENTS_DIR, rootForRelativePaths: ROOT, tokensDir: TOKENS_DIR });

  writeCodeSnapshotFile(CODE_CURRENT_PATH, current);
  archiveCodeSnapshot(CODE_ARCHIVE_DIR, current);

  const changes = compareCodeSnapshots(previous, current);

  mkdirSync(CODE_HISTORY_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const runId = `${current.snapshotId}_${Date.now()}`;
  const fileSafeStamp = generatedAt.replace(/[:.]/g, '-');
  const historyPath = path.join(CODE_HISTORY_DIR, `${fileSafeStamp}_${current.snapshotId}.json`);

  if (existsSync(historyPath)) {
    throw new CodeCheckError(`Refusing to overwrite existing history record at ${relToRoot(historyPath)}.`);
  }

  writeFileSync(
    historyPath,
    JSON.stringify(
      {
        runId,
        generatedAt,
        previousSnapshotId: previous.snapshotId,
        currentSnapshotId: current.snapshotId,
        changeCount: changes.length,
        changes,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  return { previous, current, changes, historyPath };
}

function main(): void {
  let result: CodeRefreshResult;
  try {
    result = refreshCodeSnapshot();
  } catch (err) {
    console.error(err instanceof CodeCheckError ? err.message : `Unexpected error: ${err}`);
    process.exitCode = 1;
    return;
  }

  const { previous, current, changes, historyPath } = result;

  console.log(`Code baseline snapshot: ${previous.snapshotId} (${previous.generatedAt})`);
  console.log(`Code current snapshot:  ${current.snapshotId} (${current.generatedAt})`);
  console.log('');

  if (changes.length === 0) {
    console.log('No code changes detected. 0 change records.');
  } else {
    console.log(`${changes.length} code change record(s) detected:`);
    console.log('');
    for (const change of changes) {
      console.log(`- [${change.changeType}] component:${change.entityId}  (field: ${change.field})`);
      console.log(`    changeId: ${change.changeId}  status: ${change.status}`);
      console.log(`    directly affects: ${change.affectedComponents.join(', ') || '(none)'}`);
    }
  }

  console.log('');
  console.log(`History record written: ${relToRoot(historyPath)}`);
}

// Only run when this file is executed directly (`node code-check.ts` /
// `npm run sync:code-check`), never when something else imports
// `refreshCodeSnapshot` for its own use (dashboard-reconcile-handler.ts,
// tests) — mirrors reconcile.ts's / agent-run.ts's own established guard
// for exactly the same reason: importing a module's exports must never
// itself trigger a real run against the real repository.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
