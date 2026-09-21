/**
 * Builds the deterministic Figma <-> Code identity crosswalk (Stage 5B) —
 * see reconcile-types.ts for the full type-level scope boundary.
 *
 * This module reads ONLY the registry's own mapping file (the audited,
 * authored layer). It deliberately never imports from the FigmaSnapshot
 * engine, the CodeSnapshot engine, or the registry-snapshot engine's own
 * modules, and it never reads any of their snapshot-output directories or
 * the design-tool extraction manifest. Identity comes from the registry;
 * a future reconciliation layer is what will JOIN this crosswalk against
 * independently captured snapshots. Building that join, or comparing
 * values across it, is explicitly not this stage's job.
 *
 * Parsing (loadRegistryJson, reading the file) is kept separate from the
 * pure mapping logic below it (buildReconciliationCrosswalk and its
 * helpers), mirroring snapshot.ts's own loadRegistry/buildSnapshot split
 * — everything below the loader has zero filesystem I/O and is a pure
 * function of its input, so it's independently testable with fixtures.
 *
 * The sha256/sortKeysDeep-style content hashing the other two engines use
 * is deliberately NOT reproduced here: this stage produces no persisted,
 * diffable artifact (no baseline/current/archive, no CLI script) — only
 * an in-memory crosswalk a caller can build on demand. Adding a content
 * hash now would be scaffolding for comparison logic that belongs to a
 * later stage, not something this stage's output actually needs yet.
 */
import { readFileSync } from 'node:fs';
import type {
  ReconciliationCrosswalk,
  ComponentIdentityMapping,
  ComponentDependencyEdge,
  TokenIdentityMapping,
  TokenNormalizationCollision,
  TextStyleIdentityMapping,
} from './reconcile-types.ts';

const SCHEMA_VERSION = '1.0.0';

// ---------------------------------------------------------------------
// Shape of the on-disk registry.json we read (only the fields this
// crosswalk consumes).
// ---------------------------------------------------------------------

interface RegistryComponentJson {
  id: string;
  figmaNodeId: string;
  figmaName: string;
  codePath: string;
  storybook: { storyFile: string; title: string; storyIds: string[] };
  dependsOnComponents: ComponentDependencyEdge[];
}

interface RegistryTokenJson {
  tokenId: string;
  sourceType: 'figma-variable' | 'inferred';
  figmaName: string | null;
  cssVariable: string;
  consumedBy: string[];
}

interface RegistryTextStyleJson {
  textStyleId: string;
  figmaName: string;
  tokenIds: string[];
  consumedBy: string[];
}

export interface RegistryJson {
  registryUpdatedOn: string;
  components: RegistryComponentJson[];
  tokens: RegistryTokenJson[];
  textStyles: RegistryTextStyleJson[];
}

/** Thin loader — parses registry.json and does nothing else. All mapping logic lives in the pure functions below. */
export function loadRegistryJson(registryPath: string): RegistryJson {
  return JSON.parse(readFileSync(registryPath, 'utf8')) as RegistryJson;
}

// ---------------------------------------------------------------------
// Component identity
// ---------------------------------------------------------------------

// Mirrors the CodeSnapshot engine's own componentId convention exactly
// (a directory under src/components/ is only a component if it has a
// matching <Name>.tsx file) — duplicated here as a name-shape check
// rather than imported, to keep this crosswalk's only real dependency
// the registry file itself.
const CODE_COMPONENT_PATH_RE = /^src\/components\/([^/]+)\/\1\.tsx$/;

/**
 * Derives the expected CodeSnapshot-side componentId from a registry
 * codePath, e.g. "src/components/Button/Button.tsx" -> "Button". Returns
 * `null` (never a guess) when codePath doesn't match the
 * `src/components/<Name>/<Name>.tsx` convention this codebase's
 * CodeSnapshot engine itself requires.
 */
export function deriveCodeComponentId(codePath: string): string | null {
  const match = CODE_COMPONENT_PATH_RE.exec(codePath);
  return match ? match[1] : null;
}

export function resolveComponentMapping(component: RegistryComponentJson): ComponentIdentityMapping {
  const codeComponentId = deriveCodeComponentId(component.codePath);
  return {
    registryComponentId: component.id,
    figmaNodeId: component.figmaNodeId,
    figmaName: component.figmaName,
    codeComponentId,
    codePath: component.codePath,
    storybook: {
      storyFile: component.storybook.storyFile,
      title: component.storybook.title,
      storyIds: [...component.storybook.storyIds].sort(),
    },
    status: codeComponentId !== null ? 'resolved' : 'unresolved-code-path',
    dependsOnComponents: [...component.dependsOnComponents].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// ---------------------------------------------------------------------
// Text-style identity (Stage 5E). Identity only, no normalization — a
// text-style's figmaName ("Body/Medium") is already unqualified (it has
// no collection prefix the way a token's figmaName does), so there is no
// analogue of normalizeFigmaTokenName() needed here.
// ---------------------------------------------------------------------

export function resolveTextStyleMapping(textStyle: RegistryTextStyleJson): TextStyleIdentityMapping {
  return {
    registryTextStyleId: textStyle.textStyleId,
    figmaName: textStyle.figmaName,
    tokenIds: [...textStyle.tokenIds].sort(),
    consumedBy: [...textStyle.consumedBy].sort(),
  };
}

// ---------------------------------------------------------------------
// Token identity + name normalization
// ---------------------------------------------------------------------

/**
 * Collection-prefix segments actually observed on design-system/registry.json's
 * token figmaNames (confirmed by direct inspection of every tokens[]
 * entry — not assumed). Registry token names are collection-qualified
 * (e.g. "Mapped/Surface/action", "Alias/Border radius/lg"); the captured
 * design-tool variable names for the same tokens omit that leading
 * segment (e.g. "Surface/action", "Border radius/lg"). This is the exact
 * list normalizeFigmaTokenName() treats as strippable — deliberately a
 * closed list, not "strip whatever the first segment is", so an
 * unrecognized prefix is left qualified (still distinguishable) instead
 * of being silently cut and possibly colliding with something else.
 */
export const KNOWN_FIGMA_COLLECTION_PREFIXES = ['Alias', 'Brand', 'Mapped', 'Responsive'] as const;

/**
 * Strips `figmaName`'s leading `<prefix>/` segment when that prefix is in
 * `knownPrefixes`; otherwise returns `figmaName` unchanged (this covers
 * both "no `/` at all" and "first segment isn't a known prefix" — an
 * already-normalized name, e.g. "Surface/action", passes through as-is).
 * Pure string transformation — never checks whether the result actually
 * exists anywhere.
 */
export function normalizeFigmaTokenName(figmaName: string, knownPrefixes: readonly string[]): string {
  const slashIndex = figmaName.indexOf('/');
  if (slashIndex === -1) return figmaName;
  const firstSegment = figmaName.slice(0, slashIndex);
  if (!knownPrefixes.includes(firstSegment)) return figmaName;
  return figmaName.slice(slashIndex + 1);
}

/**
 * Groups the given (registryTokenId, normalizedFigmaName) pairs by
 * normalizedFigmaName and reports every group with 2+ members as a
 * collision. Entries with a null normalizedFigmaName (non-Figma-backed
 * tokens) are never part of a collision. Returns `[]`, sorted by
 * normalizedFigmaName, deterministic regardless of input order.
 */
export function detectTokenNormalizationCollisions(
  entries: { registryTokenId: string; normalizedFigmaName: string | null }[],
): TokenNormalizationCollision[] {
  const byName = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.normalizedFigmaName === null) continue;
    const existing = byName.get(entry.normalizedFigmaName);
    if (existing) {
      existing.push(entry.registryTokenId);
    } else {
      byName.set(entry.normalizedFigmaName, [entry.registryTokenId]);
    }
  }

  const collisions: TokenNormalizationCollision[] = [];
  for (const [normalizedFigmaName, registryTokenIds] of byName) {
    if (registryTokenIds.length > 1) {
      collisions.push({ normalizedFigmaName, registryTokenIds: [...registryTokenIds].sort() });
    }
  }
  return collisions.sort((a, b) => a.normalizedFigmaName.localeCompare(b.normalizedFigmaName));
}

// ---------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------

export interface BuildCrosswalkOptions {
  /** Used only to record where this crosswalk was built from — never read from. */
  registryPath: string;
}

/**
 * Pure transform from parsed registry JSON to a ReconciliationCrosswalk.
 * No filesystem I/O; no reference to any captured Figma or code snapshot.
 */
export function buildReconciliationCrosswalk(
  registry: RegistryJson,
  opts: BuildCrosswalkOptions,
): ReconciliationCrosswalk {
  const components = registry.components
    .map(resolveComponentMapping)
    .sort((a, b) => a.registryComponentId.localeCompare(b.registryComponentId));

  const normalized = registry.tokens.map((token) => ({
    token,
    normalizedFigmaName:
      token.figmaName !== null ? normalizeFigmaTokenName(token.figmaName, KNOWN_FIGMA_COLLECTION_PREFIXES) : null,
  }));

  const collisions = detectTokenNormalizationCollisions(
    normalized.map(({ token, normalizedFigmaName }) => ({ registryTokenId: token.tokenId, normalizedFigmaName })),
  );
  const collidingNames = new Set(collisions.map((c) => c.normalizedFigmaName));

  const tokens: TokenIdentityMapping[] = normalized
    .map(({ token, normalizedFigmaName }) => ({
      registryTokenId: token.tokenId,
      registrySourceType: token.sourceType,
      figmaName: token.figmaName,
      normalizedFigmaName,
      cssVariable: token.cssVariable,
      status: (normalizedFigmaName !== null && collidingNames.has(normalizedFigmaName)
        ? 'collision'
        : 'resolved') as TokenIdentityMapping['status'],
      consumedBy: [...token.consumedBy].sort(),
    }))
    .sort((a, b) => a.registryTokenId.localeCompare(b.registryTokenId));

  const textStyles = registry.textStyles
    .map(resolveTextStyleMapping)
    .sort((a, b) => a.registryTextStyleId.localeCompare(b.registryTextStyleId));

  return {
    schemaVersion: SCHEMA_VERSION,
    source: {
      registryPath: opts.registryPath,
      registryUpdatedOn: registry.registryUpdatedOn,
    },
    knownFigmaCollectionPrefixes: [...KNOWN_FIGMA_COLLECTION_PREFIXES],
    components,
    tokens,
    tokenNormalizationCollisions: collisions,
    textStyles,
  };
}
