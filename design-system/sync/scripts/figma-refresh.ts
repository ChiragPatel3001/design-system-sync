/**
 * Orchestrates one automatic Figma capture refresh:
 *
 *   FigmaCaptureSource.capture()  ->  RawFigmaCapture
 *         |  (written to raw-capture.json — the existing "current
 *         |   capture" cache, never a baseline)
 *   buildFigmaSnapshot()          ->  FigmaSnapshot      <- figma-snapshot.ts, unmodified
 *         |
 *   figma-snapshots/current.json + archive/<snapshotId>.json
 *
 * This module adds NO new snapshot-building logic — it only wires
 * figma-capture-source.ts's new capture boundary to the EXISTING,
 * unmodified figma-snapshot.ts functions (`loadRawCapture`,
 * `buildFigmaSnapshot`, `writeFigmaSnapshotFile`, `archiveFigmaSnapshot`)
 * that figma-check.ts's CLI already uses for the same two steps. Never
 * touches a baseline, the registry, or anything under reconcile*.ts.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { loadRawCapture, buildFigmaSnapshot, writeFigmaSnapshotFile, archiveFigmaSnapshot } from './figma-snapshot.ts';
import { createFigmaDevModeMcpCaptureSource, type FigmaCaptureSource } from './figma-capture-source.ts';
import type { RawFigmaCapture, FigmaSnapshot } from './figma-snapshot-types.ts';

export class FigmaRefreshError extends Error {}

export interface FigmaRefreshPaths {
  rawCapturePath: string;
  figmaCurrentPath: string;
  figmaArchiveDir: string;
}

export interface FigmaRefreshResult {
  rawCapture: RawFigmaCapture;
  snapshot: FigmaSnapshot;
}

/**
 * Refreshes `raw-capture.json` from a live capture source, then rebuilds
 * `figma-snapshots/current.json` (+ archive entry) from it. `source`
 * defaults to the real `createFigmaDevModeMcpCaptureSource`, seeded from
 * whatever is currently on disk; tests inject a deterministic source
 * instead (see figma-refresh.test.ts).
 */
export async function refreshFigmaCapture(paths: FigmaRefreshPaths, source?: FigmaCaptureSource): Promise<FigmaRefreshResult> {
  if (!existsSync(paths.rawCapturePath)) {
    throw new FigmaRefreshError(
      `No existing raw Figma capture found at ${paths.rawCapturePath} to refresh from. An initial agent-assisted capture must exist first — see figma-snapshots/README.md.`,
    );
  }

  const previousCapture = loadRawCapture(paths.rawCapturePath);
  const captureSource = source ?? createFigmaDevModeMcpCaptureSource({ previousCapture, serverUrl: process.env.FIGMA_MCP_SERVER_URL });

  const rawCapture = await captureSource.capture();
  writeFileSync(paths.rawCapturePath, JSON.stringify(rawCapture, null, 2) + '\n', 'utf8');

  const snapshot = buildFigmaSnapshot(rawCapture);
  writeFigmaSnapshotFile(paths.figmaCurrentPath, snapshot);
  archiveFigmaSnapshot(paths.figmaArchiveDir, snapshot);

  return { rawCapture, snapshot };
}
