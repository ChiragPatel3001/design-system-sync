/**
 * `npm run sync:figma-baseline` — builds and records the first known
 * FigmaSnapshot from design-system/sync/figma-snapshots/raw-capture.json.
 *
 * Does NOT call Figma live — it cannot (see figma-snapshot.ts's header
 * comment). It transforms whatever was last captured there into a
 * deterministic snapshot. Refreshing raw-capture.json itself requires an
 * agent with live Figma MCP access to re-run the investigation and save
 * new results — a manual/agentic step, not something this script does.
 */
import { existsSync } from 'node:fs';
import {
  FIGMA_RAW_CAPTURE_PATH,
  FIGMA_BASELINE_PATH,
  FIGMA_CURRENT_PATH,
  FIGMA_ARCHIVE_DIR,
  relToRoot,
} from './figma-paths.ts';
import { loadRawCapture, buildFigmaSnapshot, writeFigmaSnapshotFile, archiveFigmaSnapshot } from './figma-snapshot.ts';

function main(): void {
  const force = process.argv.includes('--force');

  if (!existsSync(FIGMA_RAW_CAPTURE_PATH)) {
    console.error(`No raw Figma capture found at ${relToRoot(FIGMA_RAW_CAPTURE_PATH)}.`);
    console.error('This file must be produced by an agent with live Figma MCP access before a baseline can be built.');
    process.exitCode = 1;
    return;
  }

  if (existsSync(FIGMA_BASELINE_PATH) && !force) {
    console.error(`A Figma baseline already exists at ${relToRoot(FIGMA_BASELINE_PATH)}.`);
    console.error('Re-run with --force to replace it.');
    process.exitCode = 1;
    return;
  }

  const raw = loadRawCapture(FIGMA_RAW_CAPTURE_PATH);
  const snapshot = buildFigmaSnapshot(raw);

  writeFigmaSnapshotFile(FIGMA_BASELINE_PATH, snapshot);
  writeFigmaSnapshotFile(FIGMA_CURRENT_PATH, snapshot);
  archiveFigmaSnapshot(FIGMA_ARCHIVE_DIR, snapshot);

  console.log('Figma baseline snapshot created.');
  console.log(`  snapshotId: ${snapshot.snapshotId}`);
  console.log(`  source file: ${snapshot.source.fileName} (${snapshot.source.fileKey})`);
  console.log(`  pages:      ${snapshot.pages.length}`);
  console.log(`  components: ${snapshot.components.length}`);
  console.log(`  variables:  ${snapshot.variables.length}`);
  console.log(`  textStyles: ${snapshot.textStyles.length}`);
  console.log(`  built from: ${relToRoot(FIGMA_RAW_CAPTURE_PATH)} (captured ${raw.capturedAt})`);
  console.log(`  written to: ${relToRoot(FIGMA_BASELINE_PATH)}`);
  console.log(
    '\nRun `npm run sync:figma-check` to compare raw-capture.json against this baseline. ' +
      'That command does not itself contact Figma — refresh raw-capture.json via an agent with Figma MCP access first if you need the comparison to reflect current Figma state.',
  );
}

main();
