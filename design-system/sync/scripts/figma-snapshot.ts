/**
 * Builds a deterministic FigmaSnapshot from a RawFigmaCapture.
 *
 * IMPORTANT ARCHITECTURAL CONSTRAINT (see README.md for full discussion):
 * this module — unlike code-snapshot.ts, which calls `node:fs` directly —
 * cannot itself call live Figma MCP tools. Figma MCP tools
 * (get_metadata, get_variable_defs, etc.) only exist inside an agent's
 * interactive tool-calling session; there is no npm-installable client a
 * plain `node script.ts` process can import to reach them the way it can
 * import `node:fs`. So the live-data-gathering step is necessarily done
 * by an agent (Claude) with MCP access, which saves what it gathers to
 * design-system/sync/figma-snapshots/raw-capture.json. This module then
 * does the same kind of deterministic, testable, pure transform that
 * code-snapshot.ts does — just starting from that JSON file instead of
 * from `src/components/**`.
 *
 * Neither the registry mapping file nor the Figma-extraction manifest is read here.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  RawFigmaCapture,
  RawFigmaComponentCapture,
  FigmaSnapshot,
  FigmaComponentEntry,
  FigmaVariantEntry,
  FigmaVariableEntry,
  FigmaTextStyleEntry,
  FigmaVariableInferredType,
} from './figma-snapshot-types.ts';

const SCHEMA_VERSION = '1.0.0';

export function loadRawCapture(filePath: string): RawFigmaCapture {
  return JSON.parse(readFileSync(filePath, 'utf8')) as RawFigmaCapture;
}

// ---------------------------------------------------------------------
// Hashing — same algorithm as snapshot.ts/code-snapshot.ts (sort keys
// recursively, stringify, sha256, truncate), duplicated rather than
// imported so this module has zero coupling to the other two snapshot
// engines' files (mirrors code-snapshot.ts's own stated rationale).
// ---------------------------------------------------------------------

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

export function computeFigmaSnapshotId(content: {
  pages: FigmaSnapshot['pages'];
  components: FigmaComponentEntry[];
  variables: FigmaVariableEntry[];
  textStyles: FigmaTextStyleEntry[];
}): string {
  const canonical = JSON.stringify(sortKeysDeep(content));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------

/** "State=Default, Type=Default" -> {State: "Default", Type: "Default"}. Returns {} if the name doesn't match the "Key=Value" pattern (never guessed). */
export function parseVariantName(name: string): Record<string, string> {
  const properties: Record<string, string> = {};
  const parts = name.split(',').map((p) => p.trim());
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) return {}; // doesn't match the pattern at all — bail out rather than report a partial/misleading result
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key || !value) return {};
    properties[key] = value;
  }
  return properties;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const FLOAT_RE = /^-?\d+(\.\d+)?$/;
const FONT_COMPOSITE_RE = /^Font\(/;

export function inferVariableType(value: string): FigmaVariableInferredType {
  if (FONT_COMPOSITE_RE.test(value)) return 'FONT_COMPOSITE';
  if (COLOR_RE.test(value)) return 'COLOR';
  if (FLOAT_RE.test(value)) return 'FLOAT';
  return 'STRING';
}

const FONT_DESCRIPTOR_RE =
  /^Font\(family: "([^"]*)", style: ([^,]+), size: ([^,]+), weight: ([0-9.]+), lineHeight: ([^,]+), letterSpacing: ([0-9.]+)\)$/;

export interface ParsedFontDescriptor {
  fontFamilyRef: string | null;
  fontFamilyIsVariableRef: boolean;
  fontStyle: string | null;
  fontWeight: number | null;
  fontSizeRef: string | null;
  lineHeightRef: string | null;
  letterSpacing: number | null;
}

/** Parses the "Font(family: ..., style: ..., size: ..., weight: ..., lineHeight: ..., letterSpacing: ...)" descriptor get_variable_defs returns for composite text-style variables. Returns all-null fields if the descriptor doesn't match this exact grammar — never guessed. */
export function parseFontDescriptor(descriptor: string): ParsedFontDescriptor {
  const match = FONT_DESCRIPTOR_RE.exec(descriptor);
  if (!match) {
    return {
      fontFamilyRef: null,
      fontFamilyIsVariableRef: false,
      fontStyle: null,
      fontWeight: null,
      fontSizeRef: null,
      lineHeightRef: null,
      letterSpacing: null,
    };
  }
  const [, family, style, size, weight, lineHeight, letterSpacing] = match;
  return {
    fontFamilyRef: family,
    fontFamilyIsVariableRef: family.includes('/'),
    fontStyle: style.trim(),
    fontWeight: Number(weight),
    fontSizeRef: size.trim(),
    lineHeightRef: lineHeight.trim(),
    letterSpacing: Number(letterSpacing),
  };
}

// ---------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------

function buildComponentEntry(
  raw: RawFigmaComponentCapture,
  sections: Record<string, string>,
): FigmaComponentEntry {
  const variants: FigmaVariantEntry[] = [...raw.variantSymbols]
    .map((symbol) => ({
      nodeId: symbol.nodeId,
      properties: parseVariantName(symbol.name),
      width: symbol.width,
      height: symbol.height,
    }))
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId));

  const propertyNames = new Set<string>();
  const propertyValues = new Map<string, Set<string>>();
  for (const variant of variants) {
    for (const [key, value] of Object.entries(variant.properties)) {
      propertyNames.add(key);
      if (!propertyValues.has(key)) propertyValues.set(key, new Set());
      propertyValues.get(key)!.add(value);
    }
  }

  const variantPropertyValues: Record<string, string[]> = {};
  for (const [key, values] of propertyValues) {
    variantPropertyValues[key] = [...values].sort();
  }

  const variableBindings = Object.entries(raw.variableDefs)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    figmaNodeId: raw.figmaNodeId,
    name: raw.name,
    kind: variants.length >= 2 ? 'component_set' : 'component',
    sectionId: raw.sectionId,
    sectionName: raw.sectionId ? (sections[raw.sectionId] ?? null) : null,
    containerWidth: raw.nodeType === 'frame' ? raw.width : null,
    containerHeight: raw.nodeType === 'frame' ? raw.height : null,
    variantCount: variants.length,
    variantPropertyNames: [...propertyNames].sort(),
    variantPropertyValues,
    variants,
    variableBindings,
  };
}

function buildVariables(components: FigmaComponentEntry[]): FigmaVariableEntry[] {
  const byName = new Map<string, { value: string; consumedBy: Set<string> }>();
  for (const component of components) {
    for (const binding of component.variableBindings) {
      if (!byName.has(binding.name)) {
        byName.set(binding.name, { value: binding.value, consumedBy: new Set() });
      }
      byName.get(binding.name)!.consumedBy.add(component.figmaNodeId);
    }
  }
  return [...byName.entries()]
    .map(([name, { value, consumedBy }]) => ({
      name,
      value,
      inferredType: inferVariableType(value),
      consumedBy: [...consumedBy].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildTextStyles(textStyleVariableDefs: Record<string, string>): FigmaTextStyleEntry[] {
  const entries: FigmaTextStyleEntry[] = [];
  for (const [name, value] of Object.entries(textStyleVariableDefs)) {
    if (!FONT_COMPOSITE_RE.test(value)) continue; // only the composite "Font(...)" entries are text styles; atomic Hn/Font size etc. are plain variables, not styles themselves
    const parsed = parseFontDescriptor(value);
    entries.push({ name, rawDescriptor: value, ...parsed });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function buildFigmaSnapshot(raw: RawFigmaCapture): FigmaSnapshot {
  const components = [...raw.components]
    .map((c) => buildComponentEntry(c, raw.sections))
    .sort((a, b) => a.figmaNodeId.localeCompare(b.figmaNodeId));

  const variables = buildVariables(components);
  const textStyles = buildTextStyles(raw.textStyleVariableDefs);
  const pages = [...raw.pagesConfirmedByDirectRead].sort((a, b) => a.id.localeCompare(b.id));

  return {
    schemaVersion: SCHEMA_VERSION,
    snapshotId: computeFigmaSnapshotId({ pages, components, variables, textStyles }),
    generatedAt: new Date().toISOString(),
    source: {
      fileKey: raw.fileKey,
      fileName: raw.fileName,
      capturedAt: raw.capturedAt,
    },
    pages,
    components,
    variables,
    textStyles,
  };
}

// ---------------------------------------------------------------------
// File I/O — mirrors code-snapshot.ts's read/write/archive pattern.
// ---------------------------------------------------------------------

export function writeFigmaSnapshotFile(filePath: string, snapshot: FigmaSnapshot): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
}

export function readFigmaSnapshotFile(filePath: string): FigmaSnapshot {
  return JSON.parse(readFileSync(filePath, 'utf8')) as FigmaSnapshot;
}

export function archiveFigmaSnapshot(archiveDir: string, snapshot: FigmaSnapshot): string {
  const filePath = path.join(archiveDir, `${snapshot.snapshotId}.json`);
  if (!existsSync(filePath)) {
    writeFigmaSnapshotFile(filePath, snapshot);
  }
  return filePath;
}
