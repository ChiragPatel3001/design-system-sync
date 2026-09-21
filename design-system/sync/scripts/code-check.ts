/**
 * `npm run sync:code-check` — builds the current CodeSnapshot from
 * src/components/**, compares it against the code baseline, prints what
 * it finds, and appends an immutable record to
 * design-system/sync/code-snapshots/history/. Reads only source files;
 * never touches the registry mapping file, the Figma-extraction manifest,
 * or Figma, and never writes to src/components/**.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
import { compareCodeSnapshots } from './code-compare.ts';

function main(): void {
  if (!existsSync(CODE_BASELINE_PATH)) {
    console.error('No code baseline found.');
    console.error('Run `npm run sync:code-baseline` first to establish one.');
    process.exitCode = 1;
    return;
  }

  const previous = readCodeSnapshotFile(CODE_BASELINE_PATH);
  const current = buildCodeSnapshot({ componentsDir: COMPONENTS_DIR, rootForRelativePaths: ROOT, tokensDir: TOKENS_DIR });

  writeCodeSnapshotFile(CODE_CURRENT_PATH, current);
  archiveCodeSnapshot(CODE_ARCHIVE_DIR, current);

  const changes = compareCodeSnapshots(previous, current);

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

  mkdirSync(CODE_HISTORY_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const runId = `${current.snapshotId}_${Date.now()}`;
  const fileSafeStamp = generatedAt.replace(/[:.]/g, '-');
  const historyPath = path.join(CODE_HISTORY_DIR, `${fileSafeStamp}_${current.snapshotId}.json`);

  if (existsSync(historyPath)) {
    console.error(`Refusing to overwrite existing history record at ${relToRoot(historyPath)}.`);
    process.exitCode = 1;
    return;
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

  console.log('');
  console.log(`History record written: ${relToRoot(historyPath)}`);
}

main();
