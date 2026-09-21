import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  loadRegistryJson,
  buildReconciliationCrosswalk,
  deriveCodeComponentId,
  normalizeFigmaTokenName,
  detectTokenNormalizationCollisions,
  resolveComponentMapping,
  resolveTextStyleMapping,
  KNOWN_FIGMA_COLLECTION_PREFIXES,
  type RegistryJson,
} from './reconcile-crosswalk.ts';
import { REGISTRY_PATH, ROOT, relToRoot } from './reconcile-paths.ts';

// ---------------------------------------------------------------------
// Against the real registry (read-only integration check).
// ---------------------------------------------------------------------

describe('buildReconciliationCrosswalk — against the real registry', () => {
  const registry = loadRegistryJson(REGISTRY_PATH);
  const crosswalk = buildReconciliationCrosswalk(registry, { registryPath: relToRoot(REGISTRY_PATH) });

  test('captures all 10 registered components and 40 catalogued tokens', () => {
    assert.equal(crosswalk.components.length, 10);
    assert.equal(crosswalk.tokens.length, 40);
  });

  test('Button maps across registry/Figma/code exactly as authored', () => {
    const button = crosswalk.components.find((c) => c.registryComponentId === 'button');
    assert.ok(button);
    assert.equal(button?.figmaNodeId, '15:664');
    assert.equal(button?.figmaName, 'Button');
    assert.equal(button?.codePath, 'src/components/Button/Button.tsx');
    assert.equal(button?.codeComponentId, 'Button');
    assert.equal(button?.status, 'resolved');
    // The three identifiers are genuinely different strings — the
    // crosswalk must not collapse them into one.
    assert.notEqual(button?.registryComponentId, button?.codeComponentId);
  });

  test('FormField: codePath-derived CodeSnapshot identity is correct', () => {
    const formField = crosswalk.components.find((c) => c.registryComponentId === 'form-field');
    assert.ok(formField);
    assert.equal(formField?.codePath, 'src/components/FormField/FormField.tsx');
    assert.equal(formField?.codeComponentId, 'FormField');
    assert.equal(formField?.status, 'resolved');
  });

  test('a component with dependencies (form-field) preserves dependency metadata verbatim without using it to invent identity', () => {
    const formField = crosswalk.components.find((c) => c.registryComponentId === 'form-field');
    assert.ok(formField);
    assert.deepEqual(
      formField?.dependsOnComponents,
      [
        { id: 'field-label', relationship: 'renders' },
        { id: 'text-field', relationship: 'renders' },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    // Identity still comes only from form-field's own codePath, not from
    // anything about field-label/text-field.
    assert.equal(formField?.codeComponentId, 'FormField');
  });

  test('radius-lg maps across registry/Figma/code exactly as authored', () => {
    const radiusLg = crosswalk.tokens.find((t) => t.registryTokenId === 'radius-lg');
    assert.ok(radiusLg);
    assert.equal(radiusLg?.figmaName, 'Alias/Border radius/lg');
    assert.equal(radiusLg?.normalizedFigmaName, 'Border radius/lg');
    assert.equal(radiusLg?.cssVariable, '--radius-lg');
    assert.equal(radiusLg?.status, 'resolved');
  });

  test('color-surface-action (a real Mapped token) verifies collection-prefix normalization', () => {
    const token = crosswalk.tokens.find((t) => t.registryTokenId === 'color-surface-action');
    assert.ok(token);
    assert.equal(token?.figmaName, 'Mapped/Surface/action');
    assert.equal(token?.normalizedFigmaName, 'Surface/action');
  });

  test('original registry figmaName is preserved unchanged alongside the normalized form', () => {
    const token = crosswalk.tokens.find((t) => t.registryTokenId === 'color-surface-action');
    assert.equal(token?.figmaName, 'Mapped/Surface/action');
    assert.notEqual(token?.figmaName, token?.normalizedFigmaName);
  });

  test('original registry cssVariable is preserved verbatim', () => {
    const token = crosswalk.tokens.find((t) => t.registryTokenId === 'radius-lg');
    assert.equal(token?.cssVariable, '--radius-lg');
  });

  test('the one non-Figma-backed token (font-weight-body, sourceType "inferred") has null figmaName/normalizedFigmaName, never fabricated', () => {
    const token = crosswalk.tokens.find((t) => t.registryTokenId === 'font-weight-body');
    assert.ok(token);
    assert.equal(token?.registrySourceType, 'inferred');
    assert.equal(token?.figmaName, null);
    assert.equal(token?.normalizedFigmaName, null);
  });

  test('the real registry has zero token-normalization collisions under the observed prefix set', () => {
    assert.deepEqual(crosswalk.tokenNormalizationCollisions, []);
    assert.ok(crosswalk.tokens.every((t) => t.status === 'resolved'));
  });

  test('knownFigmaCollectionPrefixes on the output matches the prefixes actually observed in the real registry', () => {
    assert.deepEqual([...crosswalk.knownFigmaCollectionPrefixes].sort(), ['Alias', 'Brand', 'Mapped', 'Responsive']);
  });

  test('every real registry codePath resolves to a non-null codeComponentId (no accidental unresolved mappings today)', () => {
    for (const c of crosswalk.components) {
      assert.notEqual(c.codeComponentId, null, `${c.registryComponentId} should resolve`);
      assert.equal(c.status, 'resolved');
    }
  });

  test('the real registry produces exactly two text-style mappings, matching registry.json\'s textStyles[] verbatim — none inferred or synthesized', () => {
    assert.equal(crosswalk.textStyles.length, 2);
    assert.deepEqual(
      crosswalk.textStyles.map((t) => t.registryTextStyleId),
      ['body-medium', 'caption'],
    );
  });

  test('body-medium maps to the real registry figmaName "Body/Medium"', () => {
    const bodyMedium = crosswalk.textStyles.find((t) => t.registryTextStyleId === 'body-medium');
    assert.ok(bodyMedium);
    assert.equal(bodyMedium?.figmaName, 'Body/Medium');
    assert.deepEqual(bodyMedium?.tokenIds, ['alias-font-family-body', 'font-size-paragraph-medium', 'line-height-paragraph-medium']);
  });

  test('caption maps to its real registry figmaName verbatim (the compound "Responsive/Caption (used via Mapped/Text/Caption color pairing)" string — preserved exactly as authored, not shortened to "Caption")', () => {
    const caption = crosswalk.textStyles.find((t) => t.registryTextStyleId === 'caption');
    assert.ok(caption);
    assert.equal(caption?.figmaName, 'Responsive/Caption (used via Mapped/Text/Caption color pairing)');
  });
});

// ---------------------------------------------------------------------
// resolveTextStyleMapping — pure unit test (synthetic).
// ---------------------------------------------------------------------

describe('resolveTextStyleMapping', () => {
  test('maps a synthetic registry text-style entry, sorting tokenIds/consumedBy for determinism', () => {
    const mapping = resolveTextStyleMapping({
      textStyleId: 'heading-1',
      figmaName: 'Heading/H1',
      tokenIds: ['line-height-h1', 'font-size-h1'],
      consumedBy: ['widget-b', 'widget-a'],
    });
    assert.deepEqual(mapping, {
      registryTextStyleId: 'heading-1',
      figmaName: 'Heading/H1',
      tokenIds: ['font-size-h1', 'line-height-h1'],
      consumedBy: ['widget-a', 'widget-b'],
    });
  });
});

// ---------------------------------------------------------------------
// deriveCodeComponentId — pure unit tests.
// ---------------------------------------------------------------------

describe('deriveCodeComponentId', () => {
  test('derives the componentId from a well-formed codePath', () => {
    assert.equal(deriveCodeComponentId('src/components/Button/Button.tsx'), 'Button');
  });

  test('returns null when the file name does not match the directory name', () => {
    assert.equal(deriveCodeComponentId('src/components/Button/index.tsx'), null);
  });

  test('returns null for a synthetic invalid codePath entirely outside src/components', () => {
    assert.equal(deriveCodeComponentId('src/legacy/Button.tsx'), null);
  });

  test('returns null for a nested path that does not match the flat <Name>/<Name>.tsx convention', () => {
    assert.equal(deriveCodeComponentId('src/components/Button/parts/Button.tsx'), null);
  });
});

// ---------------------------------------------------------------------
// normalizeFigmaTokenName — pure unit tests.
// ---------------------------------------------------------------------

describe('normalizeFigmaTokenName', () => {
  test('strips a normal Mapped-prefixed name', () => {
    assert.equal(normalizeFigmaTokenName('Mapped/Surface/action', KNOWN_FIGMA_COLLECTION_PREFIXES), 'Surface/action');
  });

  test('strips a normal Alias-prefixed name', () => {
    assert.equal(
      normalizeFigmaTokenName('Alias/Border radius/lg', KNOWN_FIGMA_COLLECTION_PREFIXES),
      'Border radius/lg',
    );
  });

  test('strips a Brand-prefixed name (another real prefix found in the registry)', () => {
    assert.equal(normalizeFigmaTokenName('Brand/Scale/200', KNOWN_FIGMA_COLLECTION_PREFIXES), 'Scale/200');
  });

  test('strips a Responsive-prefixed name (another real prefix found in the registry)', () => {
    assert.equal(
      normalizeFigmaTokenName('Responsive/Caption/Font size', KNOWN_FIGMA_COLLECTION_PREFIXES),
      'Caption/Font size',
    );
  });

  test('leaves an already-normalized Figma name unchanged (first segment is not a known prefix)', () => {
    assert.equal(normalizeFigmaTokenName('Surface/action', KNOWN_FIGMA_COLLECTION_PREFIXES), 'Surface/action');
  });

  test('leaves a no-prefix (single-segment) name unchanged', () => {
    assert.equal(normalizeFigmaTokenName('Standalone', KNOWN_FIGMA_COLLECTION_PREFIXES), 'Standalone');
  });

  test('does not invent a prefix that was not observed in the registry: an unrecognized first segment is left qualified', () => {
    assert.equal(normalizeFigmaTokenName('Semantic/Surface/action', KNOWN_FIGMA_COLLECTION_PREFIXES), 'Semantic/Surface/action');
  });
});

// ---------------------------------------------------------------------
// detectTokenNormalizationCollisions — pure unit tests, including a
// synthetic collision the real registry does not currently have.
// ---------------------------------------------------------------------

describe('detectTokenNormalizationCollisions', () => {
  test('reports no collisions when every normalized name is unique', () => {
    const result = detectTokenNormalizationCollisions([
      { registryTokenId: 'a', normalizedFigmaName: 'Surface/action' },
      { registryTokenId: 'b', normalizedFigmaName: 'Surface/disabled' },
    ]);
    assert.deepEqual(result, []);
  });

  test('ignores entries with a null normalizedFigmaName', () => {
    const result = detectTokenNormalizationCollisions([
      { registryTokenId: 'a', normalizedFigmaName: null },
      { registryTokenId: 'b', normalizedFigmaName: null },
    ]);
    assert.deepEqual(result, []);
  });

  test('synthetic collision: two registry tokens normalizing to the same Figma name are reported explicitly, not silently resolved to one', () => {
    const result = detectTokenNormalizationCollisions([
      { registryTokenId: 'color-surface-action-legacy', normalizedFigmaName: 'Surface/action' },
      { registryTokenId: 'color-surface-action', normalizedFigmaName: 'Surface/action' },
    ]);
    assert.deepEqual(result, [
      { normalizedFigmaName: 'Surface/action', registryTokenIds: ['color-surface-action', 'color-surface-action-legacy'] },
    ]);
  });

  test('a 3-way collision reports all three ids together, sorted', () => {
    const result = detectTokenNormalizationCollisions([
      { registryTokenId: 'c', normalizedFigmaName: 'X/y' },
      { registryTokenId: 'a', normalizedFigmaName: 'X/y' },
      { registryTokenId: 'b', normalizedFigmaName: 'X/y' },
    ]);
    assert.deepEqual(result, [{ normalizedFigmaName: 'X/y', registryTokenIds: ['a', 'b', 'c'] }]);
  });
});

// ---------------------------------------------------------------------
// buildReconciliationCrosswalk — synthetic-fixture behavior tests
// (collision propagation end-to-end, invalid codePath, purity).
// ---------------------------------------------------------------------

function makeSyntheticRegistry(overrides: Partial<RegistryJson> = {}): RegistryJson {
  return {
    registryUpdatedOn: '2026-01-01',
    components: [],
    tokens: [],
    textStyles: [],
    ...overrides,
  };
}

describe('buildReconciliationCrosswalk — synthetic fixtures', () => {
  test('a synthetic collision fixture is reported as an explicit collision, and both colliding tokens are marked status "collision" (neither silently chosen)', () => {
    const registry = makeSyntheticRegistry({
      tokens: [
        {
          tokenId: 'color-surface-action',
          sourceType: 'figma-variable',
          figmaName: 'Mapped/Surface/action',
          cssVariable: '--color-surface-action',
          consumedBy: [],
        },
        {
          tokenId: 'color-surface-action-alias',
          sourceType: 'figma-variable',
          figmaName: 'Alias/Surface/action',
          cssVariable: '--color-surface-action-alias',
          consumedBy: [],
        },
      ],
    });

    const crosswalk = buildReconciliationCrosswalk(registry, { registryPath: 'fixture' });

    assert.deepEqual(crosswalk.tokenNormalizationCollisions, [
      { normalizedFigmaName: 'Surface/action', registryTokenIds: ['color-surface-action', 'color-surface-action-alias'] },
    ]);
    const a = crosswalk.tokens.find((t) => t.registryTokenId === 'color-surface-action');
    const b = crosswalk.tokens.find((t) => t.registryTokenId === 'color-surface-action-alias');
    assert.equal(a?.status, 'collision');
    assert.equal(b?.status, 'collision');
    // Both normalized names are still populated, not withheld.
    assert.equal(a?.normalizedFigmaName, 'Surface/action');
    assert.equal(b?.normalizedFigmaName, 'Surface/action');
  });

  test('a synthetic invalid codePath becomes an explicit unresolved mapping, never a fuzzy match onto another component', () => {
    const registry = makeSyntheticRegistry({
      components: [
        {
          id: 'widget',
          figmaNodeId: '99:1',
          figmaName: 'Widget',
          codePath: 'src/components/Widget/index.tsx', // does not match Widget/Widget.tsx
          storybook: { storyFile: 'src/components/Widget/Widget.stories.tsx', title: 'Components/Widget', storyIds: [] },
          dependsOnComponents: [],
        },
        {
          id: 'button', // a real-looking other component that a fuzzy matcher might wrongly pick
          figmaNodeId: '15:664',
          figmaName: 'Button',
          codePath: 'src/components/Button/Button.tsx',
          storybook: { storyFile: 'src/components/Button/Button.stories.tsx', title: 'Components/Button', storyIds: [] },
          dependsOnComponents: [],
        },
      ],
    });

    const crosswalk = buildReconciliationCrosswalk(registry, { registryPath: 'fixture' });
    const widget = crosswalk.components.find((c) => c.registryComponentId === 'widget');

    assert.equal(widget?.codeComponentId, null);
    assert.equal(widget?.status, 'unresolved-code-path');
    // It must not have been matched onto "Button" or anything else.
    assert.notEqual(widget?.codeComponentId, 'Button');
  });

  test('buildReconciliationCrosswalk is a pure function of its input — no filesystem access, even with a non-existent registryPath', () => {
    const registry = makeSyntheticRegistry({
      components: [
        {
          id: 'x',
          figmaNodeId: '1:1',
          figmaName: 'X',
          codePath: 'src/components/X/X.tsx',
          storybook: { storyFile: 'src/components/X/X.stories.tsx', title: 'Components/X', storyIds: ['b', 'a'] },
          dependsOnComponents: [],
        },
      ],
    });
    // registryPath below points nowhere on disk — if this function touched
    // the filesystem using it, this call would throw.
    const crosswalk = buildReconciliationCrosswalk(registry, { registryPath: '/does/not/exist/registry.json' });
    assert.equal(crosswalk.components[0].codeComponentId, 'X');
    // storybook.storyIds is sorted deterministically, independent of input order.
    assert.deepEqual(crosswalk.components[0].storybook.storyIds, ['a', 'b']);
  });

  test('resolveComponentMapping (the per-component pure helper) is consistent with buildReconciliationCrosswalk for the same input', () => {
    const component = {
      id: 'button',
      figmaNodeId: '15:664',
      figmaName: 'Button',
      codePath: 'src/components/Button/Button.tsx',
      storybook: { storyFile: 'src/components/Button/Button.stories.tsx', title: 'Components/Button', storyIds: [] },
      dependsOnComponents: [],
    };
    const direct = resolveComponentMapping(component);
    const viaCrosswalk = buildReconciliationCrosswalk(makeSyntheticRegistry({ components: [component] }), {
      registryPath: 'fixture',
    }).components[0];
    assert.deepEqual(direct, viaCrosswalk);
  });
});

// ---------------------------------------------------------------------
// Independence from FigmaSnapshot, CodeSnapshot, and the extraction
// manifest — the crosswalk's identity source must remain the registry.
// ---------------------------------------------------------------------

describe('reconcile-crosswalk independence from FigmaSnapshot, CodeSnapshot, and the manifest', () => {
  test('reconcile-crosswalk.ts / reconcile-types.ts / reconcile-paths.ts never reference FigmaSnapshot files, CodeSnapshot files, or the manifest', () => {
    const scriptsDir = path.join(ROOT, 'design-system/sync/scripts');
    const files = ['reconcile-crosswalk.ts', 'reconcile-types.ts', 'reconcile-paths.ts'];
    for (const file of files) {
      const content = readFileSync(path.join(scriptsDir, file), 'utf8');
      assert.ok(!/figma-snapshot/i.test(content), `${file} must not reference FigmaSnapshot files`);
      assert.ok(!/code-snapshot/i.test(content), `${file} must not reference CodeSnapshot files`);
      assert.ok(!/design-system-manifest\.json/i.test(content), `${file} must not reference the manifest file`);
    }
  });
});
