/**
 * Builds a CodeSnapshot: a deterministic, independent view of the design
 * system's actual implementation, derived ONLY from files under
 * src/components/. This module never reads the registry mapping file, the
 * Figma-extraction manifest, or live Figma data of any kind — see
 * design-system/sync/code-snapshots/README.md for why that independence is
 * the entire point of this stage.
 *
 * Parsing uses the TypeScript compiler API (`typescript`, already an
 * existing devDependency of this project — no new dependency was added)
 * for anything TS-structural (exports, prop shapes, imports), and plain
 * regex for CSS custom properties and Storybook story metadata, which are
 * simple enough not to need a parser.
 */
import ts from 'typescript';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  CodeSnapshot,
  CodeComponentEntry,
  CodePropEntry,
  CodeVariantUnion,
  CodeImportEntry,
  CodeStorybookInfo,
} from './code-snapshot-types.ts';

const SCHEMA_VERSION = '1.0.0';

// ---------------------------------------------------------------------
// Hashing. Deliberately duplicated (not imported) from snapshot.ts's
// equivalent logic: this stage must not modify the existing registry
// snapshot implementation, and importing from it would create a coupling
// this stage is specifically trying to avoid. The algorithm is the same
// (sort object keys recursively, stringify, sha256, truncate) so both
// snapshot kinds compute ids the same deterministic way, per requirement
// "consistent with the existing snapshot architecture" — consistent in
// approach, not in shared code.
// ---------------------------------------------------------------------

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function computeCodeSnapshotId(components: CodeComponentEntry[]): string {
  const canonical = JSON.stringify(sortKeysDeep(components));
  return sha256(canonical).slice(0, 16);
}

// ---------------------------------------------------------------------
// Storybook story-id projection. Storybook's actual `toId()` lowercases
// and hyphenates title segments WITHOUT splitting camelCase (e.g. the
// title segment "FieldLabel" becomes "fieldlabel", not "field-label"),
// but DOES split camelCase in the story's export name (e.g. the export
// "WithHelpIcon" becomes "with-help-icon"). This was verified empirically
// against a live Storybook instance's /index.json in an earlier stage —
// every one of the 48 real story ids matched this rule. It's implemented
// here as a static, standalone projection (no Storybook process involved)
// and is explicitly labeled `computedStoryIds` in the output, not treated
// as equivalent to reading a live index.
// ---------------------------------------------------------------------

function sanitizeTitleSegment(segment: string): string {
  return segment
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sanitizeTitle(title: string): string {
  return title.split('/').map(sanitizeTitleSegment).join('-');
}

function sanitizeExportName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function computeStoryId(title: string, exportName: string): string {
  return `${sanitizeTitle(title)}--${sanitizeExportName(exportName)}`;
}

// ---------------------------------------------------------------------
// CSS extraction (regex — CSS custom-property syntax is simple/regular
// enough not to need a parser).
// ---------------------------------------------------------------------

function extractCssCustomProperties(cssContent: string): { consumed: string[]; defined: string[] } {
  const consumed = new Set<string>();
  for (const m of cssContent.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) consumed.add(m[1]);

  const defined = new Set<string>();
  for (const m of cssContent.matchAll(/(?:^|[;{\s])(--[a-zA-Z0-9_-]+)\s*:/gm)) defined.add(m[1]);

  return { consumed: [...consumed].sort(), defined: [...defined].sort() };
}

// ---------------------------------------------------------------------
// Storybook story-file extraction (regex — the two facts we need, a
// quoted `title:` string and `export const <Name>` identifiers, don't
// need a full parse; the registry-audit stage used and verified the same
// approach against live Storybook output).
// ---------------------------------------------------------------------

function parseStoryFile(content: string): { title: string | null; storyExportNames: string[] } {
  const titleMatch = /title:\s*['"]([^'"]+)['"]/.exec(content);
  const title = titleMatch ? titleMatch[1] : null;

  const names = new Set<string>();
  for (const m of content.matchAll(/^export const ([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]/gm)) {
    names.add(m[1]);
  }

  return { title, storyExportNames: [...names].sort() };
}

// ---------------------------------------------------------------------
// Component .tsx extraction via the TypeScript compiler API.
// ---------------------------------------------------------------------

function isExported(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/** Returns the union's string literal values, or null if it isn't a pure string-literal union (e.g. it includes `undefined`, a number, a type reference, ...) — never reports a partial/misleading union. */
function extractStringUnion(typeNode: ts.TypeNode): string[] | null {
  if (!ts.isUnionTypeNode(typeNode)) return null;
  const values: string[] = [];
  for (const member of typeNode.types) {
    if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) {
      values.push(member.literal.text);
    } else {
      return null;
    }
  }
  return values;
}

interface ParsedComponentFile {
  exportedComponents: string[];
  exportedTypes: string[];
  imports: CodeImportEntry[];
  props: CodePropEntry[] | null;
  propsBaseType: string | null;
  variants: CodeVariantUnion[];
}

function parseComponentFile(componentId: string, absolutePath: string, content: string): ParsedComponentFile {
  const sourceFile = ts.createSourceFile(absolutePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const propsTypeName = `${componentId}Props`;

  const exportedComponents: string[] = [];
  const exportedTypes: string[] = [];
  const imports: CodeImportEntry[] = [];
  const typeAliasVariants: CodeVariantUnion[] = [];
  let propsNode: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | undefined;

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const specifier = stmt.moduleSpecifier.text;
      const isRelative = specifier.startsWith('.');
      const match = /^\.\.\/([^/]+)\/\1$/.exec(specifier);
      imports.push({
        specifier,
        isRelative,
        isTypeOnly: stmt.importClause?.isTypeOnly ?? false,
        resolvedComponentDir: isRelative && match ? match[1] : null,
      });
      continue;
    }

    if (ts.isFunctionDeclaration(stmt) && stmt.name && isExported(stmt)) {
      if (/^[A-Z]/.test(stmt.name.text)) exportedComponents.push(stmt.name.text);
      continue;
    }

    if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && /^[A-Z]/.test(decl.name.text)) {
          exportedComponents.push(decl.name.text);
        }
      }
      continue;
    }

    if (ts.isInterfaceDeclaration(stmt) && isExported(stmt)) {
      exportedTypes.push(stmt.name.text);
      if (stmt.name.text === propsTypeName) propsNode = stmt;
      continue;
    }

    if (ts.isTypeAliasDeclaration(stmt) && isExported(stmt)) {
      exportedTypes.push(stmt.name.text);
      if (stmt.name.text === propsTypeName) propsNode = stmt;
      const union = extractStringUnion(stmt.type);
      if (union) typeAliasVariants.push({ name: stmt.name.text, values: union, source: 'exported-type-alias' });
      continue;
    }
  }

  let props: CodePropEntry[] | null = null;
  let propsBaseType: string | null = null;
  const inlineVariants: CodeVariantUnion[] = [];

  if (propsNode && ts.isInterfaceDeclaration(propsNode)) {
    props = [];
    for (const member of propsNode.members) {
      if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
        const typeText = member.type ? member.type.getText(sourceFile) : 'unknown';
        props.push({ name: member.name.text, type: typeText, optional: !!member.questionToken });
        if (member.type) {
          const union = extractStringUnion(member.type);
          if (union) inlineVariants.push({ name: member.name.text, values: union, source: 'inline-prop-type' });
        }
      }
    }
    if (propsNode.heritageClauses?.length) {
      propsBaseType = propsNode.heritageClauses.map((h) => h.getText(sourceFile)).join('; ');
    }
  } else if (propsNode && ts.isTypeAliasDeclaration(propsNode)) {
    if (ts.isTypeLiteralNode(propsNode.type)) {
      props = [];
      for (const member of propsNode.type.members) {
        if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
          const typeText = member.type ? member.type.getText(sourceFile) : 'unknown';
          props.push({ name: member.name.text, type: typeText, optional: !!member.questionToken });
        }
      }
    } else {
      // e.g. `export type CheckboxControlProps = Omit<InputHTMLAttributes<...>, 'type'>;`
      // — no locally-added members, just a base type. Report that base
      // type verbatim rather than guessing at what it expands to.
      props = [];
      propsBaseType = propsNode.type.getText(sourceFile);
    }
  }

  return {
    exportedComponents: [...new Set(exportedComponents)].sort(),
    exportedTypes: [...new Set(exportedTypes)].sort(),
    imports,
    props,
    propsBaseType,
    variants: [...typeAliasVariants, ...inlineVariants],
  };
}

// ---------------------------------------------------------------------
// Discovery + assembly.
// ---------------------------------------------------------------------

export interface BuildCodeSnapshotOptions {
  /** Absolute path to src/components. */
  componentsDir: string;
  /** Used only to compute the relative paths stored in the snapshot (e.g. project root), never read from. */
  rootForRelativePaths: string;
}

function toRelative(absolutePath: string, root: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

export function buildCodeSnapshot(opts: BuildCodeSnapshotOptions): CodeSnapshot {
  const directoryNames = readdirSync(opts.componentsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const components: CodeComponentEntry[] = [];

  for (const componentId of directoryNames) {
    const dir = path.join(opts.componentsDir, componentId);
    const tsxPath = path.join(dir, `${componentId}.tsx`);

    // A directory under src/components/ is only treated as a component if
    // it has a matching <Name>.tsx file — this codebase's own convention.
    // Anything else is skipped, not fabricated into a hollow entry.
    if (!existsSync(tsxPath)) continue;

    const cssPath = path.join(dir, `${componentId}.css`);
    const storiesPath = path.join(dir, `${componentId}.stories.tsx`);

    const tsxContent = readFileSync(tsxPath, 'utf8');
    const cssContent = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : null;
    const storiesContent = existsSync(storiesPath) ? readFileSync(storiesPath, 'utf8') : null;

    const parsed = parseComponentFile(componentId, tsxPath, tsxContent);
    const css = cssContent !== null ? extractCssCustomProperties(cssContent) : { consumed: [], defined: [] };
    const story = storiesContent !== null ? parseStoryFile(storiesContent) : { title: null, storyExportNames: [] };

    const componentDependencies = [
      ...new Set(
        parsed.imports
          .map((imp) => imp.resolvedComponentDir)
          .filter((dir): dir is string => dir !== null),
      ),
    ].sort();

    const computedStoryIds = story.title
      ? [...story.storyExportNames].map((name) => computeStoryId(story.title as string, name)).sort()
      : [];

    const storybook: CodeStorybookInfo = {
      storyFilePath: storiesContent !== null ? toRelative(storiesPath, opts.rootForRelativePaths) : null,
      title: story.title,
      storyExportNames: story.storyExportNames,
      computedStoryIds,
    };

    components.push({
      componentId,
      sourceFilePath: toRelative(tsxPath, opts.rootForRelativePaths),
      cssFilePath: cssContent !== null ? toRelative(cssPath, opts.rootForRelativePaths) : null,
      exportedComponents: parsed.exportedComponents,
      exportedTypes: parsed.exportedTypes,
      props: parsed.props,
      propsBaseType: parsed.propsBaseType,
      variants: parsed.variants,
      cssCustomPropertiesConsumed: css.consumed,
      cssCustomPropertiesDefined: css.defined,
      imports: parsed.imports,
      componentDependencies,
      storybook,
      sourceHashes: {
        component: sha256(tsxContent),
        styles: cssContent !== null ? sha256(cssContent) : null,
        stories: storiesContent !== null ? sha256(storiesContent) : null,
      },
    });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    snapshotId: computeCodeSnapshotId(components),
    generatedAt: new Date().toISOString(),
    sourceRoot: toRelative(opts.componentsDir, opts.rootForRelativePaths),
    components,
  };
}

export function writeCodeSnapshotFile(filePath: string, snapshot: CodeSnapshot): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
}

export function readCodeSnapshotFile(filePath: string): CodeSnapshot {
  return JSON.parse(readFileSync(filePath, 'utf8')) as CodeSnapshot;
}

/** Content-addressed archive write, mirroring the registry snapshot's archiveSnapshot() behavior: filename = snapshotId, so writing identical content twice is a safe no-op. */
export function archiveCodeSnapshot(archiveDir: string, snapshot: CodeSnapshot): string {
  const filePath = path.join(archiveDir, `${snapshot.snapshotId}.json`);
  if (!existsSync(filePath)) {
    writeCodeSnapshotFile(filePath, snapshot);
  }
  return filePath;
}
