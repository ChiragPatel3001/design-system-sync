/**
 * Path constants for the reconciliation crosswalk (Stage 5B) and, since
 * Stage 5D, the reconciliation CLI's persisted output. Kept fully
 * separate from paths.ts, code-paths.ts, and figma-paths.ts, matching
 * this project's existing convention that each engine duplicates its own
 * tiny path wiring rather than importing another engine's — see those
 * modules' own header comments.
 *
 * Stage 5D's reconciliation output constants below are additive: Stage
 * 5B/5C had no persistence at all (crosswalks and comparison records
 * were always built on demand, in memory). reconcile.ts is the first
 * thing in this file's history that writes anywhere.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../../..');

export const REGISTRY_PATH = path.join(ROOT, 'design-system/registry.json');

export const RECONCILIATION_DIR = path.join(ROOT, 'design-system/sync/reconciliation');
/** One immutable file per `sync:reconcile` run, named `<timestamp>_<runId>.json` — see reconcile.ts. Never overwritten. */
export const RECONCILIATION_RECORDS_DIR = path.join(RECONCILIATION_DIR, 'records');
/** Mutable convenience pointer — a full copy of the most recent successful run, replaced on every successful run. Never the source of truth; the matching file under records/ is. */
export const RECONCILIATION_LATEST_PATH = path.join(RECONCILIATION_DIR, 'latest.json');

/** Path relative to ROOT, forward-slashed, for readable console/file output regardless of OS. */
export function relToRoot(absolutePath: string): string {
  return path.relative(ROOT, absolutePath).split(path.sep).join('/');
}
