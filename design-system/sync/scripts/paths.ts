/** Shared path constants for the sync CLI scripts, resolved relative to this file's own location so they work regardless of the process's current working directory. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../../..');

export const REGISTRY_PATH = path.join(ROOT, 'design-system/registry.json');
export const MANIFEST_PATH = path.join(ROOT, 'design-system-manifest.json');

export const SNAPSHOTS_DIR = path.join(ROOT, 'design-system/sync/snapshots');
export const BASELINE_PATH = path.join(SNAPSHOTS_DIR, 'baseline.json');
export const CURRENT_PATH = path.join(SNAPSHOTS_DIR, 'current.json');
export const ARCHIVE_DIR = path.join(SNAPSHOTS_DIR, 'archive');

export const HISTORY_DIR = path.join(ROOT, 'design-system/history');

/** Path relative to ROOT, forward-slashed, for readable console/file output regardless of OS. */
export function relToRoot(absolutePath: string): string {
  return path.relative(ROOT, absolutePath).split(path.sep).join('/');
}
