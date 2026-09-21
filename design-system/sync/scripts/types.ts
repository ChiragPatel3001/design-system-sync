/**
 * Shared types for the sync engine's snapshot + comparison layer.
 *
 * This module has zero I/O and zero external dependencies on purpose —
 * everything here is a plain data shape so snapshot.ts / compare.ts /
 * impact.ts stay pure and independently testable.
 */

/** How one component relates to another, per design-system/registry-schema.md. */
export type DependencyRelationship = 'renders' | 'expects-children-of';

export interface ComponentDependencyEdge {
  id: string;
  relationship: DependencyRelationship;
}

/** One component entity, as captured at snapshot time. Mirrors registry.json's components[] shape 1:1, minus fields the sync engine doesn't need to diff (e.g. knownLimitations, which is prose, not structured state). */
export interface ComponentSnapshotEntry {
  id: string;
  figmaNodeId: string;
  figmaName: string;
  reactName: string;
  codePath: string;
  stylePath: string;
  storybookTitle: string;
  storybookStoryIds: string[];
  variantCount: number;
  figmaVariantProperties: Record<string, string[]>;
  reactPropMapping: Record<string, string>;
  tokenIds: string[];
  dependsOnComponents: ComponentDependencyEdge[];
}

/** One design-token entity, as captured at snapshot time. Mirrors registry.json's tokens[] shape 1:1. `figmaName`/`figmaVariableId`/`aliasChain` are `null` for the one token with sourceType "inferred" (font-weight-body) — never invented. */
export interface TokenSnapshotEntry {
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

export interface Snapshot {
  schemaVersion: string;
  /** Deterministic content hash of {components, tokens} — see snapshot.ts computeSnapshotId. Two snapshots with identical component/token state always get the same id, regardless of when they were generated. */
  snapshotId: string;
  generatedAt: string;
  sources: {
    registryPath: string;
    registryUpdatedOn: string;
    manifestPath: string;
    manifestExtractedOn: string;
  };
  components: ComponentSnapshotEntry[];
  tokens: TokenSnapshotEntry[];
}

export type EntityType = 'component' | 'token';

export type ChangeType =
  | 'token-value-changed'
  | 'token-alias-changed'
  | 'token-added'
  | 'token-removed'
  | 'component-added'
  | 'component-removed'
  | 'component-variant-changed'
  | 'component-property-changed'
  | 'storybook-mapping-changed'
  | 'code-path-changed'
  | 'dependency-changed';

/** Only "detected" exists yet. Approval/rejection/applied states belong to the future Claude-based sync agent, not this deterministic layer. */
export type ChangeStatus = 'detected';

export interface ChangeRecord {
  changeId: string;
  timestamp: string;
  sourceSnapshot: {
    previous: string;
    current: string;
  };
  entityType: EntityType;
  entityId: string;
  changeType: ChangeType;
  /** Which field on the entity changed (e.g. "figmaValue", "aliasChain", "tokenIds"). */
  field: string;
  previousValue: unknown;
  currentValue: unknown;
  /** Component ids directly/deterministically affected — one hop only. See design-system/sync/README.md for why this is intentionally not the full transitive closure. */
  affectedComponents: string[];
  status: ChangeStatus;
}

export interface HistoryRecord {
  runId: string;
  generatedAt: string;
  previousSnapshotId: string;
  currentSnapshotId: string;
  changeCount: number;
  changes: ChangeRecord[];
}
