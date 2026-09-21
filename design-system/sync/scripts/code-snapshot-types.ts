/**
 * Types for the CodeSnapshot — an independent view of the design system's
 * actual implementation state, built ONLY from src/components/**. This is
 * deliberately a different shape from types.ts's Snapshot (which is built
 * from the registry mapping file): a code-derived snapshot naturally has
 * fields (raw TS prop types, source hashes, import specifiers) that a
 * registry-derived snapshot doesn't, and vice versa (Figma node ids,
 * Storybook story ids "as recorded"). See the architecture-audit
 * conversation this stage followed from.
 */

export interface CodePropEntry {
  name: string;
  /** Raw TypeScript type text exactly as written in source — not resolved or expanded (e.g. inherited HTML-attribute members are NOT enumerated; see propsBaseType). */
  type: string;
  optional: boolean;
}

export type VariantUnionSource = 'exported-type-alias' | 'inline-prop-type';

export interface CodeVariantUnion {
  /** The exported type alias name (e.g. "ButtonVariant"), or the prop name if the union was declared inline on a prop instead of as its own named type. */
  name: string;
  values: string[];
  source: VariantUnionSource;
}

export interface CodeImportEntry {
  /** Import specifier exactly as written, e.g. "../FieldLabel/FieldLabel", "react", "./Button.css". */
  specifier: string;
  isRelative: boolean;
  isTypeOnly: boolean;
  /**
   * The directory name under src/components/ this import resolves to, IF
   * the specifier matches this codebase's "../X/X" component-folder
   * convention exactly. `null` when it doesn't match — never guessed.
   */
  resolvedComponentDir: string | null;
}

export interface CodeSourceHashes {
  /** sha256 of the component's own .tsx file, verbatim bytes. */
  component: string;
  /** sha256 of the component's .css file, or null if none exists. */
  styles: string | null;
  /** sha256 of the component's .stories.tsx file, or null if none exists. */
  stories: string | null;
}

export interface CodeStorybookInfo {
  storyFilePath: string | null;
  /** The literal `title:` string found in the story file's meta object, or null if not found/no story file. */
  title: string | null;
  /** Raw `export const <Name>` identifiers found in the story file. */
  storyExportNames: string[];
  /**
   * Story ids computed from title + export name using Storybook's own id
   * convention (title segments lowercased and joined with "-"; export
   * names split at camelCase boundaries and joined with "-"). This
   * algorithm was empirically verified against a live Storybook instance's
   * /index.json in an earlier stage of this project — it is a static
   * projection, not something fetched from a running Storybook, and is
   * labeled as computed for that reason.
   */
  computedStoryIds: string[];
}

export interface CodeComponentEntry {
  /**
   * The code-side identity: the directory name under src/components/.
   * Deliberately independent of the registry mapping file's `id` field —
   * this stage does not read the registry, so this is a *different* identity scheme
   * that a future reconciliation stage will need to correlate with the
   * registry's `id` (today they happen to differ only in casing for most
   * components, e.g. "IconButton" here vs. "icon-button" in the registry;
   * that correlation is not assumed or computed here).
   */
  componentId: string;
  sourceFilePath: string;
  cssFilePath: string | null;
  /** Top-level exported function/const identifiers starting with an uppercase letter (the React component naming convention). */
  exportedComponents: string[];
  /** Top-level exported interface/type-alias identifiers. */
  exportedTypes: string[];
  /**
   * Locally-declared members of the `<componentId>Props` interface/type,
   * if one was found by that exact name. `null` if no such type exists in
   * the file (not fabricated as an empty array, which would imply "found,
   * but has zero props" rather than "not found").
   */
  props: CodePropEntry[] | null;
  /** Raw text of the Props type's `extends`/base-type clause, e.g. `extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>`. `null` if there is none. */
  propsBaseType: string | null;
  variants: CodeVariantUnion[];
  cssCustomPropertiesConsumed: string[];
  cssCustomPropertiesDefined: string[];
  imports: CodeImportEntry[];
  /** Deduplicated, sorted subset of `imports` whose specifier resolved to another src/components/ directory — the code-derived component dependency graph. */
  componentDependencies: string[];
  storybook: CodeStorybookInfo;
  sourceHashes: CodeSourceHashes;
}

export interface CodeSnapshot {
  schemaVersion: string;
  /** Deterministic content hash of `components[]` — see code-snapshot.ts computeCodeSnapshotId. */
  snapshotId: string;
  generatedAt: string;
  sourceRoot: string;
  components: CodeComponentEntry[];
}
