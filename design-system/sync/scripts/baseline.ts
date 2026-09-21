/**
 * `npm run sync:baseline` — explicitly establishes the first known
 * snapshot. Running this does not produce change records: a baseline is
 * the reference point changes are measured against, not a change itself.
 *
 * Refuses to overwrite an existing baseline unless --force is passed, so
 * the reference point can't be silently replaced by a routine re-run.
 */
import { existsSync } from 'node:fs';
import {
  REGISTRY_PATH,
  MANIFEST_PATH,
  BASELINE_PATH,
  CURRENT_PATH,
  ARCHIVE_DIR,
  relToRoot,
} from './paths.ts';
import { loadRegistry, loadManifestMeta, buildSnapshot, writeSnapshotFile, archiveSnapshot } from './snapshot.ts';

function main(): void {
  const force = process.argv.includes('--force');

  if (existsSync(BASELINE_PATH) && !force) {
    console.error(`A baseline snapshot already exists at ${relToRoot(BASELINE_PATH)}.`);
    console.error('Re-run with --force to replace it. This does not delete existing history records in design-system/history/.');
    process.exitCode = 1;
    return;
  }

  const registry = loadRegistry(REGISTRY_PATH);
  const manifestMeta = loadManifestMeta(MANIFEST_PATH);
  const snapshot = buildSnapshot(registry, manifestMeta, {
    registryPath: relToRoot(REGISTRY_PATH),
    manifestPath: relToRoot(MANIFEST_PATH),
  });

  writeSnapshotFile(BASELINE_PATH, snapshot);
  writeSnapshotFile(CURRENT_PATH, snapshot);
  archiveSnapshot(ARCHIVE_DIR, snapshot);

  console.log('Baseline snapshot created.');
  console.log(`  snapshotId: ${snapshot.snapshotId}`);
  console.log(`  components: ${snapshot.components.length}`);
  console.log(`  tokens:     ${snapshot.tokens.length}`);
  console.log(`  written to: ${relToRoot(BASELINE_PATH)}`);
  console.log('\nRun `npm run sync:check` to compare future registry states against this baseline.');
}

main();
