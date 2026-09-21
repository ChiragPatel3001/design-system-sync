/**
 * `npm run sync:check` — builds the current snapshot from
 * design-system/registry.json, compares it against the baseline snapshot,
 * prints what it finds, and appends an immutable record to
 * design-system/history/. Never modifies Figma, React, CSS, Storybook, or
 * the registry itself — read-only against everything except its own
 * snapshot/history output.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HistoryRecord } from './types.ts';
import {
  REGISTRY_PATH,
  MANIFEST_PATH,
  BASELINE_PATH,
  CURRENT_PATH,
  ARCHIVE_DIR,
  HISTORY_DIR,
  relToRoot,
} from './paths.ts';
import {
  loadRegistry,
  loadManifestMeta,
  buildSnapshot,
  writeSnapshotFile,
  readSnapshotFile,
  archiveSnapshot,
} from './snapshot.ts';
import { compareSnapshots } from './compare.ts';
import { expandImpact } from './impact.ts';

function main(): void {
  if (!existsSync(BASELINE_PATH)) {
    console.error('No baseline snapshot found.');
    console.error('Run `npm run sync:baseline` first to establish one.');
    process.exitCode = 1;
    return;
  }

  const previous = readSnapshotFile(BASELINE_PATH);

  const registry = loadRegistry(REGISTRY_PATH);
  const manifestMeta = loadManifestMeta(MANIFEST_PATH);
  const current = buildSnapshot(registry, manifestMeta, {
    registryPath: relToRoot(REGISTRY_PATH),
    manifestPath: relToRoot(MANIFEST_PATH),
  });

  writeSnapshotFile(CURRENT_PATH, current);
  archiveSnapshot(ARCHIVE_DIR, current);

  const changes = compareSnapshots(previous, current);

  console.log(`Baseline snapshot:  ${previous.snapshotId} (${previous.generatedAt})`);
  console.log(`Current snapshot:   ${current.snapshotId} (${current.generatedAt})`);
  console.log('');

  if (changes.length === 0) {
    console.log('No changes detected. 0 change records.');
  } else {
    console.log(`${changes.length} change record(s) detected:`);
    console.log('');
    for (const change of changes) {
      console.log(`- [${change.changeType}] ${change.entityType}:${change.entityId}  (field: ${change.field})`);
      console.log(`    changeId: ${change.changeId}  status: ${change.status}`);
      console.log(`    directly affects: ${change.affectedComponents.join(', ') || '(none)'}`);
    }

    const seed = [...new Set(changes.flatMap((c) => c.affectedComponents))];
    const expanded = expandImpact(current, seed);
    console.log('');
    console.log('Expanded impact (transitive, informational only — not persisted on the change records):');
    console.log(`  ${expanded.join(', ') || '(none)'}`);
  }

  // A history record is written every run, even with zero changes: it's
  // proof a check happened at this time against this baseline, which is
  // part of "enough metadata to reconstruct what happened later."
  mkdirSync(HISTORY_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const runId = `${current.snapshotId}_${Date.now()}`;
  const fileSafeStamp = generatedAt.replace(/[:.]/g, '-');
  const historyFileName = `${fileSafeStamp}_${current.snapshotId}.json`;
  const historyPath = path.join(HISTORY_DIR, historyFileName);

  if (existsSync(historyPath)) {
    // Millisecond collision is astronomically unlikely but history
    // records must never be overwritten — refuse rather than clobber.
    console.error(`Refusing to overwrite existing history record at ${relToRoot(historyPath)}.`);
    process.exitCode = 1;
    return;
  }

  const historyRecord: HistoryRecord = {
    runId,
    generatedAt,
    previousSnapshotId: previous.snapshotId,
    currentSnapshotId: current.snapshotId,
    changeCount: changes.length,
    changes,
  };
  writeFileSync(historyPath, JSON.stringify(historyRecord, null, 2) + '\n', 'utf8');

  console.log('');
  console.log(`History record written: ${relToRoot(historyPath)}`);
}

main();
