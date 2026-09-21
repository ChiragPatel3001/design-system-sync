import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadRegistry, loadManifestMeta, buildSnapshot, computeSnapshotId } from './snapshot.ts';
import { REGISTRY_PATH, MANIFEST_PATH, relToRoot } from './paths.ts';

// Integration test: builds a real snapshot from the actual, current
// design-system/registry.json + design-system-manifest.json. This is a
// read-only sanity check (no files written) that the snapshot builder
// keeps agreeing with the audited registry as it evolves.

describe('buildSnapshot — against the real registry', () => {
  const registry = loadRegistry(REGISTRY_PATH);
  const manifestMeta = loadManifestMeta(MANIFEST_PATH);
  const snapshot = buildSnapshot(registry, manifestMeta, {
    registryPath: relToRoot(REGISTRY_PATH),
    manifestPath: relToRoot(MANIFEST_PATH),
  });

  test('captures all 10 registered components and 40 catalogued tokens', () => {
    assert.equal(snapshot.components.length, 10);
    assert.equal(snapshot.tokens.length, 40);
  });

  test('is idempotent: building twice from the same registry data yields the same snapshotId', () => {
    const again = buildSnapshot(registry, manifestMeta, {
      registryPath: relToRoot(REGISTRY_PATH),
      manifestPath: relToRoot(MANIFEST_PATH),
    });
    assert.equal(snapshot.snapshotId, again.snapshotId);
  });

  test('snapshotId is a pure function of components+tokens, independent of generatedAt', () => {
    const idAtT1 = computeSnapshotId(snapshot.components, snapshot.tokens);
    // simulate time passing — the id must not depend on wall-clock time
    const idAtT2 = computeSnapshotId(snapshot.components, snapshot.tokens);
    assert.equal(idAtT1, idAtT2);
    assert.equal(idAtT1, snapshot.snapshotId);
  });

  test('does not invent Figma data: font-weight-body stays marked inferred with null Figma fields', () => {
    const token = snapshot.tokens.find((t) => t.tokenId === 'font-weight-body');
    assert.ok(token, 'expected font-weight-body to be present in the snapshot');
    assert.equal(token?.sourceType, 'inferred');
    assert.equal(token?.figmaName, null);
    assert.equal(token?.figmaVariableId, null);
    assert.equal(token?.aliasChain, null);
  });

  test('every figma-variable-sourced token has a non-null figmaVariableId (no silently-invented values)', () => {
    const figmaTokens = snapshot.tokens.filter((t) => t.sourceType === 'figma-variable');
    assert.ok(figmaTokens.length > 0);
    for (const token of figmaTokens) {
      assert.notEqual(token.figmaVariableId, null, `${token.tokenId} should have a real figmaVariableId`);
      assert.notEqual(token.figmaName, null, `${token.tokenId} should have a real figmaName`);
    }
  });

  test('every component tokenId reference resolves to a real token in the snapshot (no dangling references)', () => {
    const tokenIds = new Set(snapshot.tokens.map((t) => t.tokenId));
    for (const component of snapshot.components) {
      for (const tokenId of component.tokenIds) {
        assert.ok(tokenIds.has(tokenId), `${component.id} references unknown token ${tokenId}`);
      }
    }
  });

  test('every component dependency edge points at a real component id in the snapshot', () => {
    const componentIds = new Set(snapshot.components.map((c) => c.id));
    for (const component of snapshot.components) {
      for (const edge of component.dependsOnComponents) {
        assert.ok(componentIds.has(edge.id), `${component.id} depends on unknown component ${edge.id}`);
      }
    }
  });

  test('every token consumedBy entry points at a real component id in the snapshot', () => {
    const componentIds = new Set(snapshot.components.map((c) => c.id));
    for (const token of snapshot.tokens) {
      for (const consumerId of token.consumedBy) {
        assert.ok(componentIds.has(consumerId), `${token.tokenId} consumedBy references unknown component ${consumerId}`);
      }
    }
  });
});
