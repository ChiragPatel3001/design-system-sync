/**
 * Path constants for the FigmaSnapshot CLI scripts. Kept fully separate
 * from paths.ts and code-paths.ts, matching this stage's requirement that
 * Figma snapshots are stored independently of the registry and code
 * snapshot systems.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../../..');

export const FIGMA_SNAPSHOTS_DIR = path.join(ROOT, 'design-system/sync/figma-snapshots');
export const FIGMA_RAW_CAPTURE_PATH = path.join(FIGMA_SNAPSHOTS_DIR, 'raw-capture.json');
export const FIGMA_BASELINE_PATH = path.join(FIGMA_SNAPSHOTS_DIR, 'baseline.json');
export const FIGMA_CURRENT_PATH = path.join(FIGMA_SNAPSHOTS_DIR, 'current.json');
export const FIGMA_ARCHIVE_DIR = path.join(FIGMA_SNAPSHOTS_DIR, 'archive');
export const FIGMA_HISTORY_DIR = path.join(FIGMA_SNAPSHOTS_DIR, 'history');

/** Path relative to ROOT, forward-slashed, for readable console/file output regardless of OS. */
export function relToRoot(absolutePath: string): string {
  return path.relative(ROOT, absolutePath).split(path.sep).join('/');
}
