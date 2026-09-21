/**
 * Path constants for the CodeSnapshot CLI scripts. Deliberately a separate
 * file from paths.ts (the registry-snapshot one) rather than adding to or
 * importing from it — this stage must not modify the existing registry
 * snapshot implementation, and keeping the two fully independent also
 * matches the point of this stage: a CodeSnapshot must not depend on
 * anything registry-related, including its path wiring.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../../..');

export const COMPONENTS_DIR = path.join(ROOT, 'src/components');
export const TOKENS_DIR = path.join(ROOT, 'src/tokens');

export const CODE_SNAPSHOTS_DIR = path.join(ROOT, 'design-system/sync/code-snapshots');
export const CODE_BASELINE_PATH = path.join(CODE_SNAPSHOTS_DIR, 'baseline.json');
export const CODE_CURRENT_PATH = path.join(CODE_SNAPSHOTS_DIR, 'current.json');
export const CODE_ARCHIVE_DIR = path.join(CODE_SNAPSHOTS_DIR, 'archive');

// Kept separate from design-system/history/ (which is specifically the
// registry snapshot engine's immutable log — see its own README) so this
// stage never needs to touch that engine's files or reinterpret their
// meaning, per this stage's "don't modify the existing registry snapshot
// implementation" requirement.
export const CODE_HISTORY_DIR = path.join(CODE_SNAPSHOTS_DIR, 'history');

/** Path relative to ROOT, forward-slashed, for readable console/file output regardless of OS. */
export function relToRoot(absolutePath: string): string {
  return path.relative(ROOT, absolutePath).split(path.sep).join('/');
}
