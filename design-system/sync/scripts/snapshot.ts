/**
 * Builds a deterministic Snapshot from design-system/registry.json (the
 * audited mapping layer — see design-system/registry-schema.md), and
 * handles reading/writing snapshot files on disk.
 *
 * registry.json is treated as the source of truth here, not the manifest
 * or the component source directly: re-deriving from Figma/code on every
 * snapshot would duplicate the registry-audit process and risk two
 * "sources of truth" drifting apart. The manifest is only consulted for
 * one traceability field (source.extractedOn).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  Snapshot,
  ComponentSnapshotEntry,
  TokenSnapshotEntry,
  ComponentDependencyEdge,
} from './types.ts';

const SCHEMA_VERSION = '1.0.0';

// --- shapes of the on-disk JSON we read (only the fields we consume) ---

interface RegistryComponentJson {
  id: string;
  figmaNodeId: string;
  figmaName: string;
  reactName: string;
  codePath: string;
  stylePath: string;
  storybook: { title: string; storyIds: string[] };
  variantCount: number;
  figmaVariantProperties: Record<string, string[]>;
  reactPropMapping: Record<string, string>;
  tokenIds: string[];
  dependsOnComponents: ComponentDependencyEdge[];
}

interface RegistryTokenJson {
  tokenId: string;
  sourceType: 'figma-variable' | 'inferred';
  figmaName: string | null;
  figmaVariableId: string | null;
  type: string;
  figmaValue: unknown;
  aliasChain: string[] | null;
  cssVariable: string;
  tokenFile: string;
  consumedBy: string[];
}

interface RegistryJson {
  registryUpdatedOn: string;
  components: RegistryComponentJson[];
  tokens: RegistryTokenJson[];
}

interface ManifestJson {
  source: { extractedOn: string };
}

export function loadRegistry(registryPath: string): RegistryJson {
  return JSON.parse(readFileSync(registryPath, 'utf8')) as RegistryJson;
}

export function loadManifestMeta(manifestPath: string): { extractedOn: string } {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestJson;
  return { extractedOn: manifest.source.extractedOn };
}

/** Recursively sorts object keys so the same logical content always stringifies identically, regardless of key insertion order. Used only for hashing, never for the pretty-printed file we write to disk. */
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

export function computeSnapshotId(
  components: ComponentSnapshotEntry[],
  tokens: TokenSnapshotEntry[],
): string {
  const canonical = JSON.stringify(sortKeysDeep({ components, tokens }));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export interface BuildSnapshotOptions {
  registryPath: string;
  manifestPath: string;
}

/**
 * Pure transform from parsed registry JSON to a Snapshot. All arrays are
 * sorted deterministically so neither the content hash nor later diffs are
 * sensitive to incidental ordering in registry.json.
 */
export function buildSnapshot(
  registry: RegistryJson,
  manifestMeta: { extractedOn: string },
  opts: BuildSnapshotOptions,
): Snapshot {
  const components: ComponentSnapshotEntry[] = registry.components
    .map((c): ComponentSnapshotEntry => ({
      id: c.id,
      figmaNodeId: c.figmaNodeId,
      figmaName: c.figmaName,
      reactName: c.reactName,
      codePath: c.codePath,
      stylePath: c.stylePath,
      storybookTitle: c.storybook.title,
      storybookStoryIds: [...c.storybook.storyIds].sort(),
      variantCount: c.variantCount,
      figmaVariantProperties: c.figmaVariantProperties,
      reactPropMapping: c.reactPropMapping,
      tokenIds: [...c.tokenIds].sort(),
      dependsOnComponents: [...c.dependsOnComponents].sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const tokens: TokenSnapshotEntry[] = registry.tokens
    .map((t): TokenSnapshotEntry => ({
      tokenId: t.tokenId,
      sourceType: t.sourceType,
      figmaName: t.figmaName,
      figmaVariableId: t.figmaVariableId,
      type: t.type,
      figmaValue: t.figmaValue,
      aliasChain: t.aliasChain,
      cssVariable: t.cssVariable,
      tokenFile: t.tokenFile,
      consumedBy: [...t.consumedBy].sort(),
    }))
    .sort((a, b) => a.tokenId.localeCompare(b.tokenId));

  return {
    schemaVersion: SCHEMA_VERSION,
    snapshotId: computeSnapshotId(components, tokens),
    generatedAt: new Date().toISOString(),
    sources: {
      registryPath: opts.registryPath,
      registryUpdatedOn: registry.registryUpdatedOn,
      manifestPath: opts.manifestPath,
      manifestExtractedOn: manifestMeta.extractedOn,
    },
    components,
    tokens,
  };
}

export function writeSnapshotFile(filePath: string, snapshot: Snapshot): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
}

export function readSnapshotFile(filePath: string): Snapshot {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Snapshot;
}

/**
 * Writes a snapshot into the content-addressed archive (filename =
 * snapshotId) if it isn't already there. Because the filename is a hash of
 * the content, writing the same snapshot twice is a safe no-op — this is
 * what keeps every snapshot ever computed permanently resolvable even
 * after snapshots/current.json is overwritten by a later run.
 */
export function archiveSnapshot(archiveDir: string, snapshot: Snapshot): string {
  const filePath = path.join(archiveDir, `${snapshot.snapshotId}.json`);
  if (!existsSync(filePath)) {
    writeSnapshotFile(filePath, snapshot);
  }
  return filePath;
}
