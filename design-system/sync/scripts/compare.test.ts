import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compareSnapshots } from './compare.ts';
import type { Snapshot, ComponentSnapshotEntry, TokenSnapshotEntry } from './types.ts';

// ---- fixture builders -----------------------------------------------
// Small, self-contained fixtures — deliberately not derived from the real
// registry.json, so these tests stay fast, isolated, and unaffected by
// future registry edits.

function makeToken(overrides: Partial<TokenSnapshotEntry> = {}): TokenSnapshotEntry {
  return {
    tokenId: 'color-surface-action',
    sourceType: 'figma-variable',
    figmaName: 'Mapped/Surface/action',
    figmaVariableId: 'VariableID:9:477',
    type: 'COLOR',
    figmaValue: '#8a38f5',
    aliasChain: ['Mapped/Surface/action', 'Alias/Primary/500', 'Brand/Purple/500-Default'],
    cssVariable: '--color-surface-action',
    tokenFile: 'src/tokens/colors.css',
    consumedBy: ['button', 'icon-button'],
    ...overrides,
  };
}

function makeComponent(overrides: Partial<ComponentSnapshotEntry> = {}): ComponentSnapshotEntry {
  return {
    id: 'button',
    figmaNodeId: '15:664',
    figmaName: 'Button',
    reactName: 'Button',
    codePath: 'src/components/Button/Button.tsx',
    stylePath: 'src/components/Button/Button.css',
    storybookTitle: 'Components/Button',
    storybookStoryIds: ['components-button--default'],
    variantCount: 12,
    figmaVariantProperties: { Type: ['Default', 'Outline', 'Transparent'] },
    reactPropMapping: { Type: "variant: 'default' | 'outline' | 'transparent'" },
    tokenIds: ['color-surface-action'],
    dependsOnComponents: [],
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const components = overrides.components ?? [makeComponent()];
  const tokens = overrides.tokens ?? [makeToken()];
  return {
    schemaVersion: '1.0.0',
    snapshotId: 'test-snapshot',
    generatedAt: '2026-01-01T00:00:00.000Z',
    sources: {
      registryPath: 'design-system/registry.json',
      registryUpdatedOn: '2026-01-01',
      manifestPath: 'design-system-manifest.json',
      manifestExtractedOn: '2026-01-01',
    },
    ...overrides,
    components,
    tokens,
  };
}

function byType(changes: ReturnType<typeof compareSnapshots>, changeType: string) {
  return changes.filter((c) => c.changeType === changeType);
}

describe('compareSnapshots — required scenarios', () => {
  test('1. identical snapshots produce zero change records', () => {
    const previous = makeSnapshot({ snapshotId: 'a' });
    const current = makeSnapshot({ snapshotId: 'b' }); // same content, different id metadata
    const changes = compareSnapshots(previous, current);
    assert.deepEqual(changes, []);
  });

  test('2. a token value change produces exactly one token-value-changed record', () => {
    const previous = makeSnapshot({ tokens: [makeToken({ figmaValue: '#8a38f5' })] });
    const current = makeSnapshot({ tokens: [makeToken({ figmaValue: '#000000' })] });
    const changes = compareSnapshots(previous, current);

    assert.equal(changes.length, 1);
    const [change] = changes;
    assert.equal(change.changeType, 'token-value-changed');
    assert.equal(change.entityType, 'token');
    assert.equal(change.entityId, 'color-surface-action');
    assert.equal(change.previousValue, '#8a38f5');
    assert.equal(change.currentValue, '#000000');
    assert.equal(change.status, 'detected');
  });

  test('3. a token change identifies its affected components via consumedBy', () => {
    const previous = makeSnapshot({
      tokens: [makeToken({ figmaValue: '#8a38f5', consumedBy: ['button', 'icon-button', 'menu-item'] })],
    });
    const current = makeSnapshot({
      tokens: [makeToken({ figmaValue: '#123456', consumedBy: ['button', 'icon-button', 'menu-item'] })],
    });
    const changes = compareSnapshots(previous, current);

    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0].affectedComponents, ['button', 'icon-button', 'menu-item']);
  });

  test('4. a component variant change is detected', () => {
    const previous = makeSnapshot({
      components: [makeComponent({ variantCount: 12, figmaVariantProperties: { Type: ['Default', 'Outline'] } })],
    });
    const current = makeSnapshot({
      components: [
        makeComponent({ variantCount: 16, figmaVariantProperties: { Type: ['Default', 'Outline', 'Ghost'] } }),
      ],
    });
    const changes = compareSnapshots(previous, current);

    const variantChanges = byType(changes, 'component-variant-changed');
    assert.equal(variantChanges.length, 1);
    assert.equal(variantChanges[0].entityId, 'button');
    assert.equal(variantChanges[0].entityType, 'component');
  });

  test('5. a new component produces a component-added record', () => {
    const previous = makeSnapshot({ components: [makeComponent({ id: 'button' })] });
    const current = makeSnapshot({
      components: [makeComponent({ id: 'button' }), makeComponent({ id: 'link', figmaNodeId: '18:503' })],
    });
    const changes = compareSnapshots(previous, current);

    assert.equal(changes.length, 1);
    assert.equal(changes[0].changeType, 'component-added');
    assert.equal(changes[0].entityId, 'link');
    assert.equal(changes[0].previousValue, null);
    assert.ok(changes[0].currentValue);
  });

  test('6. a removed component produces a component-removed record', () => {
    const previous = makeSnapshot({
      components: [makeComponent({ id: 'button' }), makeComponent({ id: 'link', figmaNodeId: '18:503' })],
    });
    const current = makeSnapshot({ components: [makeComponent({ id: 'button' })] });
    const changes = compareSnapshots(previous, current);

    assert.equal(changes.length, 1);
    assert.equal(changes[0].changeType, 'component-removed');
    assert.equal(changes[0].entityId, 'link');
    assert.equal(changes[0].currentValue, null);
  });

  test('7. an alias-chain change produces a token-alias-changed record', () => {
    const previous = makeSnapshot({
      tokens: [makeToken({ aliasChain: ['Mapped/Surface/action', 'Alias/Primary/500', 'Brand/Purple/500-Default'] })],
    });
    const current = makeSnapshot({
      tokens: [makeToken({ aliasChain: ['Mapped/Surface/action', 'Alias/Primary/600', 'Brand/Purple/600'] })],
    });
    const changes = compareSnapshots(previous, current);

    assert.equal(changes.length, 1);
    assert.equal(changes[0].changeType, 'token-alias-changed');
    assert.equal(changes[0].entityId, 'color-surface-action');
  });
});

describe('compareSnapshots — remaining change categories', () => {
  test('token addition produces a token-added record', () => {
    const previous = makeSnapshot({ tokens: [makeToken({ tokenId: 'radius-lg' })] });
    const current = makeSnapshot({
      tokens: [makeToken({ tokenId: 'radius-lg' }), makeToken({ tokenId: 'radius-xl', consumedBy: ['checkbox-control'] })],
    });
    const changes = compareSnapshots(previous, current);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].changeType, 'token-added');
    assert.equal(changes[0].entityId, 'radius-xl');
    assert.deepEqual(changes[0].affectedComponents, ['checkbox-control']);
  });

  test('token removal produces a token-removed record', () => {
    const previous = makeSnapshot({
      tokens: [makeToken({ tokenId: 'radius-lg' }), makeToken({ tokenId: 'radius-xl', consumedBy: ['checkbox-control'] })],
    });
    const current = makeSnapshot({ tokens: [makeToken({ tokenId: 'radius-lg' })] });
    const changes = compareSnapshots(previous, current);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].changeType, 'token-removed');
    assert.equal(changes[0].entityId, 'radius-xl');
  });

  test('a reactPropMapping change produces a component-property-changed record', () => {
    const previous = makeSnapshot({ components: [makeComponent({ reactPropMapping: { Type: 'variant: string' } })] });
    const current = makeSnapshot({
      components: [makeComponent({ reactPropMapping: { Type: 'variant: string', Icon: 'icon?: ReactNode' } })],
    });
    const changes = compareSnapshots(previous, current);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].changeType, 'component-property-changed');
    assert.equal(changes[0].field, 'reactPropMapping');
  });

  test('a Storybook title/story-id change produces a storybook-mapping-changed record', () => {
    const previous = makeSnapshot({
      components: [makeComponent({ storybookTitle: 'Components/Button', storybookStoryIds: ['components-button--default'] })],
    });
    const current = makeSnapshot({
      components: [
        makeComponent({
          storybookTitle: 'Components/Button',
          storybookStoryIds: ['components-button--default', 'components-button--hover'],
        }),
      ],
    });
    const changes = compareSnapshots(previous, current);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].changeType, 'storybook-mapping-changed');
  });

  test('a codePath change produces a code-path-changed record', () => {
    const previous = makeSnapshot({ components: [makeComponent({ codePath: 'src/components/Button/Button.tsx' })] });
    const current = makeSnapshot({
      components: [makeComponent({ codePath: 'src/components/Button/index.tsx' })],
    });
    const changes = compareSnapshots(previous, current);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].changeType, 'code-path-changed');
  });

  test('a tokenIds change produces a dependency-changed record', () => {
    const previous = makeSnapshot({ components: [makeComponent({ tokenIds: ['color-surface-action'] })] });
    const current = makeSnapshot({
      components: [makeComponent({ tokenIds: ['color-surface-action', 'radius-lg'] })],
    });
    const changes = compareSnapshots(previous, current);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].changeType, 'dependency-changed');
    assert.equal(changes[0].field, 'tokenIds');
  });

  test('a dependsOnComponents change produces a dependency-changed record and reaches the dependent via affectedComponents', () => {
    const previous = makeSnapshot({
      components: [
        makeComponent({ id: 'form-field', dependsOnComponents: [] }),
        makeComponent({ id: 'field-label', figmaNodeId: '17:50' }),
      ],
    });
    const current = makeSnapshot({
      components: [
        makeComponent({ id: 'form-field', dependsOnComponents: [{ id: 'field-label', relationship: 'renders' }] }),
        makeComponent({ id: 'field-label', figmaNodeId: '17:50' }),
      ],
    });
    const changes = compareSnapshots(previous, current);
    const depChanges = byType(changes, 'dependency-changed');
    assert.equal(depChanges.length, 1);
    assert.equal(depChanges[0].entityId, 'form-field');
    assert.equal(depChanges[0].field, 'dependsOnComponents');
    assert.ok(depChanges[0].affectedComponents.includes('form-field'));
  });

  test('a component-property-changed record for a Figma-side rename (figmaName/figmaNodeId)', () => {
    const previous = makeSnapshot({ components: [makeComponent({ figmaName: 'Button' })] });
    const current = makeSnapshot({ components: [makeComponent({ figmaName: 'PrimaryButton' })] });
    const changes = compareSnapshots(previous, current);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].changeType, 'component-property-changed');
    assert.equal(changes[0].field, 'figmaIdentity');
  });
});

describe('compareSnapshots — determinism and impact', () => {
  test('affectedComponents for a component change includes components that render/expect-children-of it', () => {
    const previous = makeSnapshot({
      components: [
        makeComponent({ id: 'field-label', figmaVariantProperties: { Property: ['Required'] } }),
        makeComponent({ id: 'form-field', dependsOnComponents: [{ id: 'field-label', relationship: 'renders' }] }),
      ],
    });
    const current = makeSnapshot({
      components: [
        makeComponent({ id: 'field-label', figmaVariantProperties: { Property: ['Required', 'Optional'] } }),
        makeComponent({ id: 'form-field', dependsOnComponents: [{ id: 'field-label', relationship: 'renders' }] }),
      ],
    });
    const changes = compareSnapshots(previous, current);
    const variantChange = byType(changes, 'component-variant-changed')[0];
    assert.ok(variantChange, 'expected a variant change on field-label');
    assert.deepEqual(variantChange.affectedComponents, ['field-label', 'form-field']);
  });

  test('re-running the same comparison produces identical changeIds (idempotent)', () => {
    const previous = makeSnapshot({ tokens: [makeToken({ figmaValue: '#8a38f5' })] });
    const current = makeSnapshot({ tokens: [makeToken({ figmaValue: '#000000' })] });

    const run1 = compareSnapshots(previous, current);
    const run2 = compareSnapshots(previous, current);

    assert.equal(run1.length, 1);
    assert.equal(run1[0].changeId, run2[0].changeId);
  });

  test('every change record has status "detected" and never auto-approves', () => {
    const previous = makeSnapshot({ tokens: [makeToken({ figmaValue: '#8a38f5' })] });
    const current = makeSnapshot({ tokens: [makeToken({ figmaValue: '#000000' })] });
    const changes = compareSnapshots(previous, current);
    for (const change of changes) {
      assert.equal(change.status, 'detected');
    }
  });
});
