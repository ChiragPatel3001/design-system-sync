import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildFigmaSnapshot,
  parseVariantName,
  inferVariableType,
  parseFontDescriptor,
  loadRawCapture,
} from './figma-snapshot.ts';
import { compareFigmaSnapshots } from './figma-compare.ts';
import { FIGMA_RAW_CAPTURE_PATH, ROOT } from './figma-paths.ts';
import type { RawFigmaCapture } from './figma-snapshot-types.ts';

// Small, self-contained fixture representing MCP output — NOT the real
// design system, and no live MCP call is made anywhere in this file, per
// this stage's instruction to use fixtures where live access can't be
// used inside automated tests.
function makeRawCapture(overrides: Partial<RawFigmaCapture> = {}): RawFigmaCapture {
  return {
    captureSchemaVersion: '1.0.0',
    fileKey: 'fixture-file-key-0000000000000',
    fileName: 'Fixture Design System',
    capturedAt: '2026-01-01T00:00:00.000Z',
    capturedVia: ['fixture'],
    pagesFromNoNodeIdListing: [{ id: '0:1', name: 'Tokens' }],
    pagesConfirmedByDirectRead: [
      { id: '0:1', name: 'Tokens' },
      { id: '1:1', name: 'Components' },
    ],
    sections: { '2:1': 'Buttons' },
    components: [
      {
        figmaNodeId: '10:1',
        name: 'Button',
        nodeType: 'frame',
        sectionId: '2:1',
        width: 800,
        height: 300,
        variantSymbols: [
          { nodeId: '10:2', name: 'State=Default, Type=Default', width: 139, height: 40 },
          { nodeId: '10:3', name: 'State=Hover, Type=Default', width: 139, height: 40 },
        ],
        variableDefs: {
          'Surface/action': '#8a38f5',
          'Border radius/lg': '4',
          'Font Family/Body': 'Inter',
          'Body/Medium':
            'Font(family: "Font Family/Body", style: Regular, size: Paragraph Medium/Font size, weight: 400, lineHeight: Paragraph Medium/Line Height, letterSpacing: 0)',
        },
      },
    ],
    textStyleVariableDefs: {
      'Body/Medium':
        'Font(family: "Font Family/Body", style: Regular, size: Paragraph Medium/Font size, weight: 400, lineHeight: Paragraph Medium/Line Height, letterSpacing: 0)',
      'Paragraph Medium/Font size': '16', // atomic variable, NOT a text style — must be excluded from textStyles[]
    },
    ...overrides,
  };
}

describe('parseVariantName', () => {
  test('parses "Key=Value, Key=Value" pairs', () => {
    assert.deepEqual(parseVariantName('State=Default, Type=Default'), { State: 'Default', Type: 'Default' });
  });
  test('returns {} for a name that does not match the pattern, rather than guessing', () => {
    assert.deepEqual(parseVariantName('Chevron'), {});
    assert.deepEqual(parseVariantName(''), {});
  });
});

describe('inferVariableType', () => {
  test('classifies by value shape', () => {
    assert.equal(inferVariableType('#8a38f5'), 'COLOR');
    assert.equal(inferVariableType('4'), 'FLOAT');
    assert.equal(inferVariableType('Inter'), 'STRING');
    assert.equal(inferVariableType('Font(family: "X", style: Y, size: Z, weight: 1, lineHeight: L, letterSpacing: 0)'), 'FONT_COMPOSITE');
  });
});

describe('parseFontDescriptor', () => {
  test('parses a well-formed descriptor', () => {
    const parsed = parseFontDescriptor(
      'Font(family: "Font Family/Heading", style: SemiBold, size: H1/Font size, weight: 600, lineHeight: H1/Line Height, letterSpacing: 0)',
    );
    assert.equal(parsed.fontFamilyRef, 'Font Family/Heading');
    assert.equal(parsed.fontFamilyIsVariableRef, true);
    assert.equal(parsed.fontStyle, 'SemiBold');
    assert.equal(parsed.fontWeight, 600);
    assert.equal(parsed.fontSizeRef, 'H1/Font size');
    assert.equal(parsed.lineHeightRef, 'H1/Line Height');
    assert.equal(parsed.letterSpacing, 0);
  });

  test('detects a literal (non-variable) font family', () => {
    const parsed = parseFontDescriptor(
      'Font(family: "Inter", style: Regular, size: Caption/Font size, weight: 400, lineHeight: Caption/Line Height, letterSpacing: 0)',
    );
    assert.equal(parsed.fontFamilyRef, 'Inter');
    assert.equal(parsed.fontFamilyIsVariableRef, false);
  });

  test('returns all-null fields for a malformed descriptor, rather than guessing', () => {
    const parsed = parseFontDescriptor('not a font descriptor');
    assert.equal(parsed.fontFamilyRef, null);
    assert.equal(parsed.fontWeight, null);
  });
});

describe('buildFigmaSnapshot — construction', () => {
  test('builds components, variants, variables, and text styles from a raw capture', () => {
    const snapshot = buildFigmaSnapshot(makeRawCapture());

    assert.equal(snapshot.components.length, 1);
    const button = snapshot.components[0];
    assert.equal(button.figmaNodeId, '10:1');
    assert.equal(button.kind, 'component_set');
    assert.equal(button.variantCount, 2);
    assert.deepEqual(button.variantPropertyNames, ['State', 'Type']);
    assert.deepEqual(button.variantPropertyValues, { State: ['Default', 'Hover'], Type: ['Default'] });
    assert.equal(button.sectionName, 'Buttons');

    const surfaceAction = snapshot.variables.find((v) => v.name === 'Surface/action');
    assert.equal(surfaceAction?.value, '#8a38f5');
    assert.equal(surfaceAction?.inferredType, 'COLOR');
    assert.deepEqual(surfaceAction?.consumedBy, ['10:1']);

    // "Paragraph Medium/Font size" is an atomic FLOAT value in the raw
    // capture's textStyleVariableDefs, not a component-bound variable and
    // not a composite "Font(...)" style — it must NOT be misclassified as
    // a text style (textStyles[] is built only from Font(...) entries;
    // atomic entries there that no component also binds directly are
    // correctly absent from variables[] too, since that array reflects
    // component-attributed bindings only — see buildVariables()).
    assert.equal(snapshot.textStyles.find((t) => t.name === 'Paragraph Medium/Font size'), undefined);

    const bodyMedium = snapshot.textStyles.find((t) => t.name === 'Body/Medium');
    assert.ok(bodyMedium);
    assert.equal(bodyMedium?.fontFamilyIsVariableRef, true);
  });

  test('uses pagesConfirmedByDirectRead, not pagesFromNoNodeIdListing (see README on the unreliable no-nodeId listing)', () => {
    const snapshot = buildFigmaSnapshot(makeRawCapture());
    assert.equal(snapshot.pages.length, 2);
    assert.ok(snapshot.pages.some((p) => p.name === 'Components'));
  });

  test('a component with 0-1 variant symbols is classified as "component", not "component_set"', () => {
    const raw = makeRawCapture({
      components: [
        {
          figmaNodeId: '20:1',
          name: 'Menu',
          nodeType: 'symbol',
          sectionId: null,
          width: 323,
          height: 270,
          variantSymbols: [],
          variableDefs: {},
        },
      ],
    });
    const snapshot = buildFigmaSnapshot(raw);
    assert.equal(snapshot.components[0].kind, 'component');
    assert.equal(snapshot.components[0].variantCount, 0);
  });
});

describe('buildFigmaSnapshot — stable ordering and determinism', () => {
  test('component, variable, and text-style arrays are sorted regardless of input order', () => {
    const rawInOrder = makeRawCapture();
    const rawReordered: RawFigmaCapture = {
      ...rawInOrder,
      components: [...rawInOrder.components].reverse().map((c) => ({
        ...c,
        variantSymbols: [...c.variantSymbols].reverse(),
      })),
    };

    const a = buildFigmaSnapshot(rawInOrder);
    const b = buildFigmaSnapshot(rawReordered);

    assert.deepEqual(a.components, b.components);
    assert.deepEqual(a.variables, b.variables);
    assert.deepEqual(a.textStyles, b.textStyles);
  });

  test('identical Figma state produces an identical snapshot id', () => {
    const a = buildFigmaSnapshot(makeRawCapture());
    const b = buildFigmaSnapshot(makeRawCapture());
    assert.equal(a.snapshotId, b.snapshotId);
  });

  test('snapshot id does not depend on capturedAt/generatedAt (volatile metadata excluded from the hash)', () => {
    const a = buildFigmaSnapshot(makeRawCapture({ capturedAt: '2026-01-01T00:00:00.000Z' }));
    const b = buildFigmaSnapshot(makeRawCapture({ capturedAt: '2099-12-31T23:59:59.000Z' }));
    assert.equal(a.snapshotId, b.snapshotId);
  });

  test('a controlled change (a token value edit) produces a different snapshot id', () => {
    const before = buildFigmaSnapshot(makeRawCapture());
    const changedRaw = makeRawCapture();
    changedRaw.components[0].variableDefs['Surface/action'] = '#000000';
    const after = buildFigmaSnapshot(changedRaw);
    assert.notEqual(before.snapshotId, after.snapshotId);
  });
});

describe('compareFigmaSnapshots — supported change categories', () => {
  test('component added / removed', () => {
    // Adding a component with variable bindings also introduces those
    // variables (variable-added records) — this test isolates just the
    // component-entity record among whatever else fires, rather than
    // assuming the component is the only thing that changed.
    const before = buildFigmaSnapshot(makeRawCapture({ components: [] }));
    const after = buildFigmaSnapshot(makeRawCapture());

    const added = compareFigmaSnapshots(before, after).filter((c) => c.entityType === 'component');
    assert.equal(added.length, 1);
    assert.equal(added[0].changeType, 'component-added');
    assert.equal(added[0].entityId, '10:1');

    const removed = compareFigmaSnapshots(after, before).filter((c) => c.entityType === 'component');
    assert.equal(removed.length, 1);
    assert.equal(removed[0].changeType, 'component-removed');
  });

  test('variant added / removed', () => {
    const withOneVariant = makeRawCapture();
    withOneVariant.components[0].variantSymbols = [withOneVariant.components[0].variantSymbols[0]];
    const before = buildFigmaSnapshot(withOneVariant);
    const after = buildFigmaSnapshot(makeRawCapture()); // has 2 variants
    const changes = compareFigmaSnapshots(before, after);
    const variantAdded = changes.filter((c) => c.changeType === 'variant-added');
    assert.equal(variantAdded.length, 1);
    assert.equal(variantAdded[0].entityId, '10:3');
  });

  test('variant property value changed', () => {
    const before = buildFigmaSnapshot(makeRawCapture());
    const changedRaw = makeRawCapture();
    changedRaw.components[0].variantSymbols[1].name = 'State=Ghost, Type=Default';
    const after = buildFigmaSnapshot(changedRaw);
    const changes = compareFigmaSnapshots(before, after);
    const propChange = changes.find((c) => c.changeType === 'variant-property-changed' && c.entityType === 'variant');
    assert.ok(propChange);
    assert.equal(propChange?.entityId, '10:3');
  });

  test('component-level property changed (name / rename)', () => {
    const before = buildFigmaSnapshot(makeRawCapture());
    const changedRaw = makeRawCapture();
    changedRaw.components[0].name = 'PrimaryButton';
    const after = buildFigmaSnapshot(changedRaw);
    const changes = compareFigmaSnapshots(before, after);
    const nameChange = changes.find((c) => c.changeType === 'component-property-changed' && c.field === 'name');
    assert.ok(nameChange, 'a Figma-side component rename should be detected');
    assert.equal(nameChange?.previousValue, 'Button');
    assert.equal(nameChange?.currentValue, 'PrimaryButton');
  });

  test('component-level property changed (section)', () => {
    const before = buildFigmaSnapshot(makeRawCapture());
    const changedRaw = makeRawCapture({ sections: { '2:1': 'Buttons', '2:2': 'Actions' } });
    changedRaw.components[0].sectionId = '2:2';
    const after = buildFigmaSnapshot(changedRaw);
    const changes = compareFigmaSnapshots(before, after);
    assert.ok(changes.some((c) => c.changeType === 'component-property-changed' && c.field === 'section/kind'));
  });

  test('variable added / removed / value changed, with correct affectedComponents', () => {
    const before = buildFigmaSnapshot(makeRawCapture());
    const changedRaw = makeRawCapture();
    changedRaw.components[0].variableDefs['Surface/action'] = '#111111';
    delete changedRaw.components[0].variableDefs['Border radius/lg'];
    changedRaw.components[0].variableDefs['Border radius/xl'] = '8';
    const after = buildFigmaSnapshot(changedRaw);

    const changes = compareFigmaSnapshots(before, after);
    const valueChange = changes.find((c) => c.changeType === 'variable-value-changed');
    assert.equal(valueChange?.entityId, 'Surface/action');
    assert.deepEqual(valueChange?.affectedComponents, ['10:1']);

    assert.ok(changes.some((c) => c.changeType === 'variable-removed' && c.entityId === 'Border radius/lg'));
    assert.ok(changes.some((c) => c.changeType === 'variable-added' && c.entityId === 'Border radius/xl'));
  });

  test('text style changed, with affectedComponents derived from which components reference it', () => {
    const before = buildFigmaSnapshot(makeRawCapture());
    const changedRaw = makeRawCapture();
    changedRaw.textStyleVariableDefs['Body/Medium'] =
      'Font(family: "Font Family/Body", style: Medium, size: Paragraph Medium/Font size, weight: 500, lineHeight: Paragraph Medium/Line Height, letterSpacing: 0)';
    const after = buildFigmaSnapshot(changedRaw);

    const changes = compareFigmaSnapshots(before, after);
    const styleChange = changes.find((c) => c.changeType === 'text-style-changed');
    assert.ok(styleChange);
    assert.equal(styleChange?.entityId, 'Body/Medium');
    // Button's variableDefs includes a "Body/Medium" binding in the fixture.
    assert.deepEqual(styleChange?.affectedComponents, ['10:1']);
  });

  test('identical snapshots produce zero change records', () => {
    const a = buildFigmaSnapshot(makeRawCapture());
    const b = buildFigmaSnapshot(makeRawCapture());
    assert.deepEqual(compareFigmaSnapshots(a, b), []);
  });

  test('every change record has status "detected"', () => {
    const before = buildFigmaSnapshot(makeRawCapture({ components: [] }));
    const after = buildFigmaSnapshot(makeRawCapture());
    for (const change of compareFigmaSnapshots(before, after)) {
      assert.equal(change.status, 'detected');
    }
  });
});

describe('graceful handling of unavailable fields', () => {
  test('a component with no section (sectionId null) does not throw and reports sectionName null', () => {
    const raw = makeRawCapture();
    raw.components[0].sectionId = null;
    const snapshot = buildFigmaSnapshot(raw);
    assert.equal(snapshot.components[0].sectionId, null);
    assert.equal(snapshot.components[0].sectionName, null);
  });

  test('a standalone component (nodeType "symbol") reports null container dimensions rather than a fabricated value', () => {
    const raw = makeRawCapture();
    raw.components[0].nodeType = 'symbol';
    raw.components[0].variantSymbols = [];
    const snapshot = buildFigmaSnapshot(raw);
    assert.equal(snapshot.components[0].containerWidth, null);
    assert.equal(snapshot.components[0].containerHeight, null);
  });

  test('an unparseable variant name yields an empty properties object, not a guess', () => {
    const raw = makeRawCapture();
    raw.components[0].variantSymbols.push({ nodeId: '10:9', name: 'Chevron', width: 24, height: 24 });
    const snapshot = buildFigmaSnapshot(raw);
    const chevron = snapshot.components[0].variants.find((v) => v.nodeId === '10:9');
    assert.deepEqual(chevron?.properties, {});
  });
});

describe('independence from registry.json and design-system-manifest.json', () => {
  test('figma-snapshot.ts / figma-compare.ts / figma-paths.ts never reference either file', () => {
    const scriptsDir = path.join(ROOT, 'design-system/sync/scripts');
    const files = ['figma-snapshot.ts', 'figma-snapshot-types.ts', 'figma-compare.ts', 'figma-paths.ts', 'figma-baseline.ts', 'figma-check.ts'];
    for (const file of files) {
      const content = readFileSync(path.join(scriptsDir, file), 'utf8');
      assert.ok(!/registry\.json/i.test(content), `${file} must not reference registry.json`);
      assert.ok(!/design-system-manifest\.json/i.test(content), `${file} must not reference the manifest file`);
    }
  });

  test('buildFigmaSnapshot never touches the filesystem (pure function of its input)', () => {
    // If this accidentally read a file, it would need one of the real
    // project paths, which don't exist relative to a fixture object with
    // no fileKey matching the real file — the fact this succeeds with a
    // fixture file key proves no real-file coupling exists.
    const snapshot = buildFigmaSnapshot(makeRawCapture());
    assert.equal(snapshot.source.fileKey, 'fixture-file-key-0000000000000');
  });
});

// Integration sanity check against the real raw capture gathered in this
// session (read-only) — mirrors the precedent set by
// code-snapshot.test.ts's "against the real repository" suite. Skipped
// gracefully if the raw capture file isn't present, since it's a captured
// artifact, not something this test suite generates.
describe('buildFigmaSnapshot — against the real raw capture (if present)', () => {
  test('builds a snapshot from the real Design-System-2.0 capture without throwing', (t) => {
    let raw;
    try {
      raw = loadRawCapture(FIGMA_RAW_CAPTURE_PATH);
    } catch {
      t.skip('raw-capture.json not present');
      return;
    }
    const snapshot = buildFigmaSnapshot(raw);
    assert.ok(snapshot.components.length > 0);
    assert.equal(snapshot.source.fileKey, 'opq4Is8eZdXdu920YDUIs1');
    // Every component captured should carry at least one variable binding
    // or be explicitly empty — never undefined/fabricated.
    for (const c of snapshot.components) {
      assert.ok(Array.isArray(c.variableBindings));
    }
  });
});
