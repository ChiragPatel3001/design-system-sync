import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { refreshFigmaCapture, FigmaRefreshError } from './figma-refresh.ts';
import { createStaticCaptureSource, type FigmaCaptureSource } from './figma-capture-source.ts';
import { buildFigmaSnapshot } from './figma-snapshot.ts';
import type { RawFigmaCapture } from './figma-snapshot-types.ts';

function makeCapture(lineHeight: string): RawFigmaCapture {
  return {
    captureSchemaVersion: '1.0.0',
    fileKey: 'fixture-file-key',
    fileName: 'Fixture Design System',
    capturedAt: '2026-01-01T00:00:00.000Z',
    capturedVia: ['manual mcp investigation'],
    pagesFromNoNodeIdListing: [],
    pagesConfirmedByDirectRead: [{ id: '0:1', name: 'Tokens' }],
    sections: {},
    components: [
      {
        figmaNodeId: '15:664',
        name: 'Button',
        nodeType: 'frame',
        sectionId: null,
        width: 844,
        height: 346,
        variantSymbols: [],
        variableDefs: { 'Paragraph Medium/Line Height': lineHeight },
      },
    ],
    textStyleVariableDefs: {},
  };
}

describe('refreshFigmaCapture', () => {
  test('writes a fresh raw-capture.json and rebuilds current.json from an injected capture source', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'figma-refresh-'));
    try {
      const rawCapturePath = path.join(tempRoot, 'raw-capture.json');
      const figmaCurrentPath = path.join(tempRoot, 'current.json');
      const figmaArchiveDir = path.join(tempRoot, 'archive');
      mkdirSync(figmaArchiveDir, { recursive: true });

      // The existing capture on disk (the "before" state — line height 20).
      writeFileSync(rawCapturePath, JSON.stringify(makeCapture('20')), 'utf8');

      // The injected source represents what a real Figma-side edit would produce.
      const refreshedCapture = makeCapture('24');
      const source: FigmaCaptureSource = createStaticCaptureSource(refreshedCapture);

      const result = await refreshFigmaCapture({ rawCapturePath, figmaCurrentPath, figmaArchiveDir }, source);

      // raw-capture.json now reflects the fresh capture.
      const persistedRaw = JSON.parse(readFileSync(rawCapturePath, 'utf8')) as RawFigmaCapture;
      assert.equal(persistedRaw.components[0].variableDefs['Paragraph Medium/Line Height'], '24');

      // current.json was rebuilt via the real buildFigmaSnapshot(), not reimplemented here.
      const persistedSnapshot = JSON.parse(readFileSync(figmaCurrentPath, 'utf8'));
      const expectedSnapshot = buildFigmaSnapshot(refreshedCapture);
      assert.equal(persistedSnapshot.snapshotId, expectedSnapshot.snapshotId);
      assert.equal(result.snapshot.snapshotId, expectedSnapshot.snapshotId);

      // Archived by content hash.
      assert.ok(existsSync(path.join(figmaArchiveDir, `${expectedSnapshot.snapshotId}.json`)));

      // The returned result's rawCapture matches what was persisted.
      assert.equal(result.rawCapture.components[0].variableDefs['Paragraph Medium/Line Height'], '24');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('refuses to run without an existing raw-capture.json to seed from', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'figma-refresh-missing-'));
    try {
      const rawCapturePath = path.join(tempRoot, 'raw-capture.json'); // deliberately never created
      const figmaCurrentPath = path.join(tempRoot, 'current.json');
      const figmaArchiveDir = path.join(tempRoot, 'archive');

      await assert.rejects(
        () => refreshFigmaCapture({ rawCapturePath, figmaCurrentPath, figmaArchiveDir }, createStaticCaptureSource(makeCapture('24'))),
        FigmaRefreshError,
      );
      assert.equal(existsSync(figmaCurrentPath), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('a capture source failure propagates without writing a partial current.json', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'figma-refresh-sourcefail-'));
    try {
      const rawCapturePath = path.join(tempRoot, 'raw-capture.json');
      const figmaCurrentPath = path.join(tempRoot, 'current.json');
      const figmaArchiveDir = path.join(tempRoot, 'archive');
      writeFileSync(rawCapturePath, JSON.stringify(makeCapture('20')), 'utf8');

      const failingSource: FigmaCaptureSource = {
        capture: async () => {
          throw new Error('simulated capture source failure');
        },
      };

      await assert.rejects(() => refreshFigmaCapture({ rawCapturePath, figmaCurrentPath, figmaArchiveDir }, failingSource));
      assert.equal(existsSync(figmaCurrentPath), false);
      // raw-capture.json must remain exactly as it was — never partially overwritten.
      const stillOriginal = JSON.parse(readFileSync(rawCapturePath, 'utf8')) as RawFigmaCapture;
      assert.equal(stillOriginal.components[0].variableDefs['Paragraph Medium/Line Height'], '20');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
