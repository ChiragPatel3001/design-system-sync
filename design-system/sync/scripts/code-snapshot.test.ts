import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCodeSnapshot } from './code-snapshot.ts';
import { COMPONENTS_DIR, TOKENS_DIR, ROOT } from './code-paths.ts';

// Integration tests against the real, current repository (read-only — no
// files are written by these tests; buildCodeSnapshot itself performs no
// writes).

describe('buildCodeSnapshot — against the real repository', () => {
  const snapshot = buildCodeSnapshot({ componentsDir: COMPONENTS_DIR, rootForRelativePaths: ROOT, tokensDir: TOKENS_DIR });

  test('discovers all 10 current components', () => {
    assert.equal(snapshot.components.length, 10);
    const ids = snapshot.components.map((c) => c.componentId).sort();
    assert.deepEqual(ids, [
      'Button',
      'Checkbox',
      'CheckboxControl',
      'FieldLabel',
      'FormField',
      'IconButton',
      'Link',
      'Menu',
      'MenuItem',
      'TextField',
    ]);
  });

  test('source file paths resolve to real files under src/components', () => {
    for (const c of snapshot.components) {
      assert.ok(c.sourceFilePath.endsWith(`${c.componentId}.tsx`));
      assert.ok(existsSync(path.join(ROOT, c.sourceFilePath)), `${c.sourceFilePath} should exist on disk`);
    }
  });

  test('CSS file paths resolve to real files for every component', () => {
    for (const c of snapshot.components) {
      assert.ok(c.cssFilePath, `${c.componentId} should have a detected CSS file`);
      assert.ok(existsSync(path.join(ROOT, c.cssFilePath as string)));
    }
  });

  test('CSS custom properties are extracted correctly', () => {
    const button = snapshot.components.find((c) => c.componentId === 'Button');
    assert.ok(button);
    assert.ok(button!.cssCustomPropertiesConsumed.includes('--color-surface-action'));
    assert.ok(button!.cssCustomPropertiesConsumed.includes('--radius-lg'));
    // none of the current 10 components locally define new custom
    // properties — they only consume tokens from src/tokens/*.css.
    for (const c of snapshot.components) {
      assert.deepEqual(c.cssCustomPropertiesDefined, []);
    }
  });

  test('cross-component React imports/dependencies are detected from real import statements', () => {
    const formField = snapshot.components.find((c) => c.componentId === 'FormField');
    assert.deepEqual(formField?.componentDependencies, ['FieldLabel', 'TextField']);

    const checkbox = snapshot.components.find((c) => c.componentId === 'Checkbox');
    assert.deepEqual(checkbox?.componentDependencies, ['CheckboxControl']);

    // Menu.tsx renders arbitrary `children` and never imports MenuItem —
    // this independently reconfirms (from code alone) what the registry
    // audit separately found by reading the manifest's relationships.
    const menu = snapshot.components.find((c) => c.componentId === 'Menu');
    assert.deepEqual(menu?.componentDependencies, []);

    // A component with zero cross-component imports at all.
    const button = snapshot.components.find((c) => c.componentId === 'Button');
    assert.deepEqual(button?.componentDependencies, []);
  });

  test('Storybook story files are detected with title, export names, and computed ids', () => {
    for (const c of snapshot.components) {
      assert.ok(c.storybook.storyFilePath, `${c.componentId} should have a detected story file`);
      assert.ok(c.storybook.title, `${c.componentId} should have a detected title`);
      assert.ok(c.storybook.storyExportNames.length > 0);
    }
    const button = snapshot.components.find((c) => c.componentId === 'Button');
    assert.equal(button?.storybook.title, 'Components/Button');
    assert.ok(button?.storybook.storyExportNames.includes('WithIcon'));
    assert.ok(button?.storybook.computedStoryIds.includes('components-button--with-icon'));

    const checkboxControl = snapshot.components.find((c) => c.componentId === 'CheckboxControl');
    assert.equal(checkboxControl?.storybook.title, 'Components/Internal/CheckboxControl');
    assert.ok(checkboxControl?.storybook.computedStoryIds.includes('components-internal-checkboxcontrol--disabled-selected'));
  });

  test('locates each Props type and reports its declared members without fabricating inherited ones', () => {
    for (const c of snapshot.components) {
      assert.ok(c.props !== null, `${c.componentId}Props should have been found`);
    }
    // CheckboxControlProps = Omit<InputHTMLAttributes<...>, 'type' | 'size'>
    // has zero locally-declared members — props should be [], not fabricated.
    const checkboxControl = snapshot.components.find((c) => c.componentId === 'CheckboxControl');
    assert.deepEqual(checkboxControl?.props, []);
    assert.match(checkboxControl?.propsBaseType ?? '', /Omit<\s*InputHTMLAttributes/);
  });

  test('captures declared string-literal variant unions where present', () => {
    const button = snapshot.components.find((c) => c.componentId === 'Button');
    const variant = button?.variants.find((v) => v.name === 'ButtonVariant');
    assert.deepEqual(variant?.values, ['default', 'outline', 'transparent']);
    assert.equal(variant?.source, 'exported-type-alias');

    // Menu has no variant union at all — should be an empty array, not guessed.
    const menu = snapshot.components.find((c) => c.componentId === 'Menu');
    assert.deepEqual(menu?.variants, []);
  });

  test('captures real token definitions from src/tokens/**/*.css, including literal (unresolved) alias values', () => {
    // A plain literal value.
    const purple500 = snapshot.tokenDefinitions.find((t) => t.cssVariable === '--brand-purple-500-default');
    assert.equal(purple500?.value, '#8a38f5');
    assert.equal(purple500?.sourceFilePath, 'src/tokens/colors.css');

    // A var()-alias value — must be preserved literally, NOT resolved to "4".
    const radiusLg = snapshot.tokenDefinitions.find((t) => t.cssVariable === '--radius-lg');
    assert.equal(radiusLg?.value, 'var(--scale-100)');
    assert.equal(radiusLg?.sourceFilePath, 'src/tokens/radius.css');

    // Definitions from more than one token file are present.
    const files = new Set(snapshot.tokenDefinitions.map((t) => t.sourceFilePath));
    assert.ok(files.has('src/tokens/colors.css'));
    assert.ok(files.has('src/tokens/radius.css'));
    assert.ok(files.has('src/tokens/borders.css'));
    assert.ok(files.has('src/tokens/spacing.css'));
    assert.ok(files.has('src/tokens/typography.css'));

    // index.css only @imports the others and sets plain (non-custom)
    // properties on `*`/`body` — it should contribute zero definitions.
    assert.ok(!files.has('src/tokens/index.css'));
  });
});

describe('buildCodeSnapshot — determinism', () => {
  test('source hashes are deterministic across repeated builds', () => {
    const a = buildCodeSnapshot({ componentsDir: COMPONENTS_DIR, rootForRelativePaths: ROOT });
    const b = buildCodeSnapshot({ componentsDir: COMPONENTS_DIR, rootForRelativePaths: ROOT });
    for (let i = 0; i < a.components.length; i++) {
      assert.deepEqual(a.components[i].sourceHashes, b.components[i].sourceHashes);
    }
  });

  test('identical code produces identical snapshot ids', () => {
    const a = buildCodeSnapshot({ componentsDir: COMPONENTS_DIR, rootForRelativePaths: ROOT });
    const b = buildCodeSnapshot({ componentsDir: COMPONENTS_DIR, rootForRelativePaths: ROOT });
    assert.equal(a.snapshotId, b.snapshotId);
  });
});

// Uses isolated temp directories (never the real repo) to prove
// tokenDefinitions extraction/determinism behavior in a controlled way,
// independent of whatever the real src/tokens/**/*.css happens to contain.
describe('buildCodeSnapshot — token definitions (isolated fixture)', () => {
  let tempRoot: string;
  let componentsDir: string;
  let tokensDir: string;

  before(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'code-snapshot-tokens-fixture-'));
    componentsDir = path.join(tempRoot, 'src', 'components');
    tokensDir = path.join(tempRoot, 'src', 'tokens');
    mkdirSync(componentsDir, { recursive: true });
    mkdirSync(tokensDir, { recursive: true });
  });

  after(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('a normal CSS custom-property definition is captured', () => {
    writeFileSync(path.join(tokensDir, 'colors.css'), ':root {\n  --color-text-primary: #111111;\n}\n', 'utf8');
    const snapshot = buildCodeSnapshot({ componentsDir, rootForRelativePaths: tempRoot, tokensDir });
    const def = snapshot.tokenDefinitions.find((t) => t.cssVariable === '--color-text-primary');
    assert.equal(def?.value, '#111111');
    assert.equal(def?.sourceFilePath, 'src/tokens/colors.css');
  });

  test('a var() alias definition preserves its literal source value, not a resolved one', () => {
    writeFileSync(
      path.join(tokensDir, 'colors.css'),
      ':root {\n  --brand-purple-500-default: #8a38f5;\n  --color-surface-action: var(--brand-purple-500-default);\n}\n',
      'utf8',
    );
    const snapshot = buildCodeSnapshot({ componentsDir, rootForRelativePaths: tempRoot, tokensDir });
    const alias = snapshot.tokenDefinitions.find((t) => t.cssVariable === '--color-surface-action');
    assert.equal(alias?.value, 'var(--brand-purple-500-default)');
  });

  test('definitions from multiple token CSS files are all captured', () => {
    writeFileSync(path.join(tokensDir, 'colors.css'), ':root {\n  --color-text-primary: #111111;\n}\n', 'utf8');
    writeFileSync(path.join(tokensDir, 'radius.css'), ':root {\n  --radius-lg: var(--scale-100);\n}\n', 'utf8');
    const snapshot = buildCodeSnapshot({ componentsDir, rootForRelativePaths: tempRoot, tokensDir });
    const files = new Set(snapshot.tokenDefinitions.map((t) => t.sourceFilePath));
    assert.ok(files.has('src/tokens/colors.css'));
    assert.ok(files.has('src/tokens/radius.css'));
  });

  test('tokenDefinitions ordering is deterministic (sorted by cssVariable)', () => {
    writeFileSync(
      path.join(tokensDir, 'colors.css'),
      ':root {\n  --z-last: 1;\n  --a-first: 2;\n  --m-middle: 3;\n}\n',
      'utf8',
    );
    const snapshot = buildCodeSnapshot({ componentsDir, rootForRelativePaths: tempRoot, tokensDir });
    const names = snapshot.tokenDefinitions.map((t) => t.cssVariable);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(names, sorted);
  });

  test('unrelated CSS/component files do not create token definitions', () => {
    // Reset tokensDir first — earlier tests in this describe block leave
    // files behind (e.g. radius.css from the "multiple files" test above),
    // and this test needs to know its token file count precisely.
    rmSync(tokensDir, { recursive: true, force: true });
    mkdirSync(tokensDir, { recursive: true });
    writeFileSync(path.join(tokensDir, 'colors.css'), ':root {\n  --color-text-primary: #111111;\n}\n', 'utf8');
    const dir = path.join(componentsDir, 'Gadget');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'Gadget.tsx'), 'export function Gadget() { return null; }\n', 'utf8');
    writeFileSync(path.join(dir, 'Gadget.css'), '.ds-gadget { --gadget-local: 4px; color: red; }\n', 'utf8');

    const snapshot = buildCodeSnapshot({ componentsDir, rootForRelativePaths: tempRoot, tokensDir });
    assert.equal(snapshot.tokenDefinitions.length, 1);
    assert.equal(snapshot.tokenDefinitions[0].cssVariable, '--color-text-primary');
    // The component's own CSS custom property still shows up where it
    // always has — under the component entry, not tokenDefinitions.
    assert.ok(snapshot.components[0].cssCustomPropertiesDefined.includes('--gadget-local'));
  });

  test('snapshot ids change when a token definition changes', () => {
    writeFileSync(path.join(tokensDir, 'colors.css'), ':root {\n  --color-text-primary: #111111;\n}\n', 'utf8');
    const before = buildCodeSnapshot({ componentsDir, rootForRelativePaths: tempRoot, tokensDir });

    writeFileSync(path.join(tokensDir, 'colors.css'), ':root {\n  --color-text-primary: #222222;\n}\n', 'utf8');
    const after = buildCodeSnapshot({ componentsDir, rootForRelativePaths: tempRoot, tokensDir });

    assert.notEqual(before.snapshotId, after.snapshotId);
  });

  test('snapshot ids are identical when only filesystem/write ordering differs', () => {
    rmSync(tokensDir, { recursive: true, force: true });
    mkdirSync(tokensDir, { recursive: true });
    writeFileSync(path.join(tokensDir, 'colors.css'), ':root {\n  --color-text-primary: #111111;\n}\n', 'utf8');
    writeFileSync(path.join(tokensDir, 'radius.css'), ':root {\n  --radius-lg: var(--scale-100);\n}\n', 'utf8');
    const a = buildCodeSnapshot({ componentsDir, rootForRelativePaths: tempRoot, tokensDir });

    // Same two files, same final content — but written in the reverse
    // order, into a freshly (re)created directory, so any OS-level
    // creation-order-dependent directory enumeration would differ here.
    rmSync(tokensDir, { recursive: true, force: true });
    mkdirSync(tokensDir, { recursive: true });
    writeFileSync(path.join(tokensDir, 'radius.css'), ':root {\n  --radius-lg: var(--scale-100);\n}\n', 'utf8');
    writeFileSync(path.join(tokensDir, 'colors.css'), ':root {\n  --color-text-primary: #111111;\n}\n', 'utf8');
    const b = buildCodeSnapshot({ componentsDir, rootForRelativePaths: tempRoot, tokensDir });

    assert.equal(a.snapshotId, b.snapshotId);
    assert.deepEqual(a.tokenDefinitions, b.tokenDefinitions);
  });

  test('tokenDefinitions defaults to [] when tokensDir is not provided (existing call sites are unaffected)', () => {
    const snapshot = buildCodeSnapshot({ componentsDir, rootForRelativePaths: tempRoot });
    assert.deepEqual(snapshot.tokenDefinitions, []);
  });
});

// Uses an isolated temp directory (never the real repo) so a "controlled
// source change" can be demonstrated without touching any existing
// component, per this stage's "do not modify existing components" rule.
describe('buildCodeSnapshot — controlled source change (isolated fixture)', () => {
  let tempRoot: string;
  let componentsDir: string;
  let widgetTsxPath: string;

  before(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'code-snapshot-fixture-'));
    componentsDir = path.join(tempRoot, 'src', 'components');
    const dir = path.join(componentsDir, 'Widget');
    mkdirSync(dir, { recursive: true });
    widgetTsxPath = path.join(dir, 'Widget.tsx');
    writeFileSync(widgetTsxPath, 'export function Widget() { return null; }\n', 'utf8');
    writeFileSync(path.join(dir, 'Widget.css'), '.ds-widget { color: var(--color-text-body); }\n', 'utf8');
  });

  after(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('missing Storybook file is represented as null, not fabricated', () => {
    const snapshot = buildCodeSnapshot({ componentsDir, rootForRelativePaths: tempRoot });
    assert.equal(snapshot.components.length, 1);
    assert.equal(snapshot.components[0].storybook.storyFilePath, null);
    assert.equal(snapshot.components[0].storybook.title, null);
    assert.deepEqual(snapshot.components[0].storybook.computedStoryIds, []);
  });

  // Each test below writes its own known starting content rather than
  // relying on the shared `before()` state, so the tests stay correct
  // regardless of execution order (the describe block's `before()` only
  // runs once, so tests that mutate widgetTsxPath would otherwise leak
  // state into later tests).

  test('a controlled source change produces a different snapshot id and source hash', () => {
    writeFileSync(widgetTsxPath, 'export function Widget() { return null; }\n', 'utf8');
    const beforeSnapshot = buildCodeSnapshot({ componentsDir, rootForRelativePaths: tempRoot });

    writeFileSync(widgetTsxPath, "export function Widget() { return 'changed'; }\n", 'utf8');
    const afterSnapshot = buildCodeSnapshot({ componentsDir, rootForRelativePaths: tempRoot });

    assert.notEqual(beforeSnapshot.snapshotId, afterSnapshot.snapshotId);
    assert.notEqual(
      beforeSnapshot.components[0].sourceHashes.component,
      afterSnapshot.components[0].sourceHashes.component,
    );
    // CSS was untouched — its hash should be stable even though the
    // overall snapshot id (which covers all components) changed.
    assert.equal(beforeSnapshot.components[0].sourceHashes.styles, afterSnapshot.components[0].sourceHashes.styles);
  });

  test('reverting the content reproduces the original snapshot id (content-addressed, not append-only)', () => {
    writeFileSync(widgetTsxPath, 'export function Widget() { return null; }\n', 'utf8');
    const original = buildCodeSnapshot({ componentsDir, rootForRelativePaths: tempRoot });

    writeFileSync(widgetTsxPath, 'export function Widget() { return "temporary"; }\n', 'utf8');
    buildCodeSnapshot({ componentsDir, rootForRelativePaths: tempRoot });

    writeFileSync(widgetTsxPath, 'export function Widget() { return null; }\n', 'utf8'); // back to the exact original bytes
    const reverted = buildCodeSnapshot({ componentsDir, rootForRelativePaths: tempRoot });

    assert.equal(original.snapshotId, reverted.snapshotId);
  });
});

describe('CodeSnapshot independence from registry.json and Figma', () => {
  test('registry.json is not required to build the CodeSnapshot (real build already proves this — no registry read occurred above)', () => {
    // buildCodeSnapshot() was already called many times above using only
    // COMPONENTS_DIR/ROOT from code-paths.ts, which never references
    // registry.json — if it had, TypeScript's own module resolution in
    // code-paths.ts would show it, checked explicitly below.
    const snapshot = buildCodeSnapshot({ componentsDir: COMPONENTS_DIR, rootForRelativePaths: ROOT });
    assert.equal(snapshot.components.length, 10);
  });

  test('the CodeSnapshot source files never reference registry.json or the Figma manifest file', () => {
    // Checks for actual file-path references only (not the word "Figma" in
    // general — several comments in this codebase legitimately explain
    // *why* Figma/registry.json are avoided, which is documentation, not
    // a dependency).
    const scriptsDir = path.join(ROOT, 'design-system/sync/scripts');
    const files = ['code-snapshot.ts', 'code-snapshot-types.ts', 'code-compare.ts', 'code-paths.ts', 'code-baseline.ts', 'code-check.ts'];
    for (const file of files) {
      const content = readFileSync(path.join(scriptsDir, file), 'utf8');
      assert.ok(!/registry\.json/i.test(content), `${file} must not reference registry.json`);
      assert.ok(!/design-system-manifest\.json/i.test(content), `${file} must not reference the Figma manifest file`);
    }
  });
});
