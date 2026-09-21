/**
 * `npm run sync:figma-check` — builds a FigmaSnapshot from whatever is
 * currently in design-system/sync/figma-snapshots/raw-capture.json,
 * compares it against the Figma baseline, prints the results, and writes
 * a record to figma-snapshots/history/.
 *
 * Does NOT itself refresh raw-capture.json from live Figma (it cannot —
 * see figma-snapshot.ts). To check against truly current Figma state, an
 * agent with Figma MCP access must re-run the investigation and overwrite
 * raw-capture.json BEFORE running this command. Running it back-to-back
 * with no re-capture in between compares the baseline against itself and
 * correctly reports zero changes — that's expected, not a bug.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  FIGMA_RAW_CAPTURE_PATH,
  FIGMA_BASELINE_PATH,
  FIGMA_CURRENT_PATH,
  FIGMA_ARCHIVE_DIR,
  FIGMA_HISTORY_DIR,
  relToRoot,
} from './figma-paths.ts';
import {
  loadRawCapture,
  buildFigmaSnapshot,
  writeFigmaSnapshotFile,
  readFigmaSnapshotFile,
  archiveFigmaSnapshot,
} from './figma-snapshot.ts';
import { compareFigmaSnapshots } from './figma-compare.ts';

function main(): void {
  if (!existsSync(FIGMA_BASELINE_PATH)) {
    console.error('No Figma baseline found. Run `npm run sync:figma-baseline` first.');
    process.exitCode = 1;
    return;
  }
  if (!existsSync(FIGMA_RAW_CAPTURE_PATH)) {
    console.error(`No raw Figma capture found at ${relToRoot(FIGMA_RAW_CAPTURE_PATH)}.`);
    process.exitCode = 1;
    return;
  }

  const previous = readFigmaSnapshotFile(FIGMA_BASELINE_PATH);
  const raw = loadRawCapture(FIGMA_RAW_CAPTURE_PATH);
  const current = buildFigmaSnapshot(raw);

  writeFigmaSnapshotFile(FIGMA_CURRENT_PATH, current);
  archiveFigmaSnapshot(FIGMA_ARCHIVE_DIR, current);

  const changes = compareFigmaSnapshots(previous, current);

  console.log(`Figma baseline snapshot: ${previous.snapshotId} (captured ${previous.source.capturedAt})`);
  console.log(`Figma current snapshot:  ${current.snapshotId} (captured ${current.source.capturedAt})`);
  console.log(
    '(Both snapshots were built from raw-capture.json. This command does not contact Figma itself — ' +
      'if the two "captured" timestamps above are identical, raw-capture.json was not refreshed before this run.)',
  );
  console.log('');

  if (changes.length === 0) {
    console.log('No Figma changes detected. 0 change records.');
  } else {
    console.log(`${changes.length} Figma change record(s) detected:`);
    console.log('');
    for (const change of changes) {
      console.log(`- [${change.changeType}] ${change.entityType}:${change.entityId}  (field: ${change.field})`);
      console.log(`    changeId: ${change.changeId}  status: ${change.status}`);
      console.log(`    directly affects: ${change.affectedComponents.join(', ') || '(none)'}`);
    }
  }

  mkdirSync(FIGMA_HISTORY_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const runId = `${current.snapshotId}_${Date.now()}`;
  const fileSafeStamp = generatedAt.replace(/[:.]/g, '-');
  const historyPath = path.join(FIGMA_HISTORY_DIR, `${fileSafeStamp}_${current.snapshotId}.json`);

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
