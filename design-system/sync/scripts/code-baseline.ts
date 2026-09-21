/**
 * `npm run sync:code-baseline` — establishes the first known CodeSnapshot.
 * Reads only src/components/**; never touches the registry mapping file,
 * the Figma-extraction manifest, or Figma itself. Refuses to overwrite an
 * existing baseline unless --force is passed, mirroring the registry
 * engine's baseline.ts safety behavior.
 */
import { existsSync } from 'node:fs';
import { COMPONENTS_DIR, TOKENS_DIR, ROOT, CODE_BASELINE_PATH, CODE_CURRENT_PATH, CODE_ARCHIVE_DIR, relToRoot } from './code-paths.ts';
import { buildCodeSnapshot, writeCodeSnapshotFile, archiveCodeSnapshot } from './code-snapshot.ts';

function main(): void {
  const force = process.argv.includes('--force');

  if (existsSync(CODE_BASELINE_PATH) && !force) {
    console.error(`A code baseline already exists at ${relToRoot(CODE_BASELINE_PATH)}.`);
    console.error('Re-run with --force to replace it.');
    process.exitCode = 1;
    return;
  }

  const snapshot = buildCodeSnapshot({ componentsDir: COMPONENTS_DIR, rootForRelativePaths: ROOT, tokensDir: TOKENS_DIR });

  writeCodeSnapshotFile(CODE_BASELINE_PATH, snapshot);
  writeCodeSnapshotFile(CODE_CURRENT_PATH, snapshot);
  archiveCodeSnapshot(CODE_ARCHIVE_DIR, snapshot);

  console.log('Code baseline snapshot created.');
  console.log(`  snapshotId: ${snapshot.snapshotId}`);
  console.log(`  components: ${snapshot.components.length}`);
  console.log(`  tokenDefinitions: ${snapshot.tokenDefinitions.length}`);
  console.log(`  source:     ${snapshot.sourceRoot} (the registry mapping file and Figma were not read)`);
  console.log(`  written to: ${relToRoot(CODE_BASELINE_PATH)}`);
  console.log('\nRun `npm run sync:code-check` to compare future code state against this baseline.');
}

main();
