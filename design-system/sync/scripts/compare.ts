/**
 * Deterministic snapshot comparison. No I/O, no randomness, no LLM calls —
 * this module only answers "what changed?" and "what does that directly
 * affect?", never "is this change good or bad?" (see design-system/sync/README.md).
 */
import { createHash } from 'node:crypto';
import type {
  Snapshot,
  ChangeRecord,
  ChangeType,
  ComponentSnapshotEntry,
  TokenSnapshotEntry,
  EntityType,
} from './types.ts';

function deepEqual(a: unknown, b: unknown): boolean {
  // Safe here: every value flowing through this comparison was produced by
  // buildSnapshot(), which already sorts every array and preserves stable
  // key order — so structural JSON equality is exact value equality, not
  // an ordering artifact.
  return JSON.stringify(a) === JSON.stringify(b);
}

function indexBy<T>(items: T[], key: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(key(item), item);
  return map;
}

/** Components whose dependsOnComponents list directly names `componentId` — i.e. one hop "used by", read straight from the snapshot's preserved relationships (never guessed). */
function oneHopUsedBy(snapshot: Snapshot, componentId: string): string[] {
  return snapshot.components
    .filter((c) => c.dependsOnComponents.some((d) => d.id === componentId))
    .map((c) => c.id)
    .sort();
}

export function compareSnapshots(previous: Snapshot, current: Snapshot): ChangeRecord[] {
  const changes: ChangeRecord[] = [];
  const timestamp = new Date().toISOString();
  const sourceSnapshot = { previous: previous.snapshotId, current: current.snapshotId };

  function emit(
    entityType: EntityType,
    entityId: string,
    changeType: ChangeType,
    field: string,
    previousValue: unknown,
    currentValue: unknown,
    affectedComponents: string[],
  ): void {
    const changeId = createHash('sha256')
      .update([entityType, entityId, changeType, field, previous.snapshotId, current.snapshotId].join('|'))
      .digest('hex')
      .slice(0, 12);
    changes.push({
      changeId,
      timestamp,
      sourceSnapshot,
      entityType,
      entityId,
      changeType,
      field,
      previousValue,
      currentValue,
      affectedComponents: [...new Set(affectedComponents)].sort(),
      status: 'detected',
    });
  }

  // ---------------- tokens ----------------
  const prevTokens = indexBy(previous.tokens, (t) => t.tokenId);
  const currTokens = indexBy(current.tokens, (t) => t.tokenId);
  const allTokenIds = [...new Set([...prevTokens.keys(), ...currTokens.keys()])].sort();

  for (const tokenId of allTokenIds) {
    const prev: TokenSnapshotEntry | undefined = prevTokens.get(tokenId);
    const curr: TokenSnapshotEntry | undefined = currTokens.get(tokenId);

    if (!prev && curr) {
      emit('token', tokenId, 'token-added', 'token', null, curr, curr.consumedBy);
      continue;
    }
    if (prev && !curr) {
      emit('token', tokenId, 'token-removed', 'token', prev, null, prev.consumedBy);
      continue;
    }
    if (prev && curr) {
      // Prefer the current consumedBy list when both exist (it reflects
      // who is affected by the state being changed TO); fall back to the
      // union so a consumer that was dropped in the same run is still
      // notified once.
      const affected = [...new Set([...curr.consumedBy, ...prev.consumedBy])];
      if (!deepEqual(prev.figmaValue, curr.figmaValue)) {
        emit('token', tokenId, 'token-value-changed', 'figmaValue', prev.figmaValue, curr.figmaValue, affected);
      }
      if (!deepEqual(prev.aliasChain, curr.aliasChain)) {
        emit('token', tokenId, 'token-alias-changed', 'aliasChain', prev.aliasChain, curr.aliasChain, affected);
      }
    }
  }

  // ---------------- components ----------------
  const prevComps = indexBy(previous.components, (c) => c.id);
  const currComps = indexBy(current.components, (c) => c.id);
  const allComponentIds = [...new Set([...prevComps.keys(), ...currComps.keys()])].sort();

  for (const id of allComponentIds) {
    const prev: ComponentSnapshotEntry | undefined = prevComps.get(id);
    const curr: ComponentSnapshotEntry | undefined = currComps.get(id);

    if (!prev && curr) {
      emit('component', id, 'component-added', 'component', null, curr, [id, ...oneHopUsedBy(current, id)]);
      continue;
    }
    if (prev && !curr) {
      emit('component', id, 'component-removed', 'component', prev, null, [id, ...oneHopUsedBy(previous, id)]);
      continue;
    }
    if (!prev || !curr) continue; // unreachable, narrows types below

    const affected = [...new Set([id, ...oneHopUsedBy(current, id), ...oneHopUsedBy(previous, id)])];

    if (prev.figmaName !== curr.figmaName || prev.figmaNodeId !== curr.figmaNodeId) {
      emit(
        'component',
        id,
        'component-property-changed',
        'figmaIdentity',
        { figmaNodeId: prev.figmaNodeId, figmaName: prev.figmaName },
        { figmaNodeId: curr.figmaNodeId, figmaName: curr.figmaName },
        affected,
      );
    }
    if (
      !deepEqual(prev.figmaVariantProperties, curr.figmaVariantProperties) ||
      prev.variantCount !== curr.variantCount
    ) {
      emit(
        'component',
        id,
        'component-variant-changed',
        'figmaVariantProperties',
        { variantCount: prev.variantCount, figmaVariantProperties: prev.figmaVariantProperties },
        { variantCount: curr.variantCount, figmaVariantProperties: curr.figmaVariantProperties },
        affected,
      );
    }
    if (!deepEqual(prev.reactPropMapping, curr.reactPropMapping)) {
      emit(
        'component',
        id,
        'component-property-changed',
        'reactPropMapping',
        prev.reactPropMapping,
        curr.reactPropMapping,
        affected,
      );
    }
    if (prev.storybookTitle !== curr.storybookTitle || !deepEqual(prev.storybookStoryIds, curr.storybookStoryIds)) {
      emit(
        'component',
        id,
        'storybook-mapping-changed',
        'storybook',
        { title: prev.storybookTitle, storyIds: prev.storybookStoryIds },
        { title: curr.storybookTitle, storyIds: curr.storybookStoryIds },
        affected,
      );
    }
    if (prev.codePath !== curr.codePath || prev.stylePath !== curr.stylePath) {
      emit(
        'component',
        id,
        'code-path-changed',
        'codePath',
        { codePath: prev.codePath, stylePath: prev.stylePath },
        { codePath: curr.codePath, stylePath: curr.stylePath },
        affected,
      );
    }
    if (!deepEqual(prev.tokenIds, curr.tokenIds)) {
      emit('component', id, 'dependency-changed', 'tokenIds', prev.tokenIds, curr.tokenIds, affected);
    }
    if (!deepEqual(prev.dependsOnComponents, curr.dependsOnComponents)) {
      emit(
        'component',
        id,
        'dependency-changed',
        'dependsOnComponents',
        prev.dependsOnComponents,
        curr.dependsOnComponents,
        affected,
      );
    }
  }

  return changes;
}
