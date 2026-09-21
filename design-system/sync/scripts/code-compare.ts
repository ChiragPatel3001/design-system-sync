/**
 * Deterministic comparison between two CodeSnapshots. Mirrors compare.ts's
 * pattern (index by id, diff fields, emit a hashed changeId) applied to
 * CodeSnapshot's fields instead of the registry's — kept as a distinct
 * module/type rather than extending compare.ts, per this stage's
 * requirement not to modify the existing registry snapshot implementation.
 * No I/O, no LLM, no judgment: only "what changed" and "what does the
 * code's own import graph say is directly affected".
 */
import { createHash } from 'node:crypto';
import type { CodeSnapshot, CodeComponentEntry } from './code-snapshot-types.ts';

export type CodeChangeType =
  | 'component-added'
  | 'component-removed'
  | 'source-hash-changed'
  | 'props-changed'
  | 'css-consumed-changed'
  | 'css-defined-changed'
  | 'dependency-changed'
  | 'storybook-changed'
  | 'variants-changed';

export interface CodeChangeRecord {
  changeId: string;
  timestamp: string;
  sourceSnapshot: { previous: string; current: string };
  entityType: 'component';
  entityId: string;
  changeType: CodeChangeType;
  field: string;
  previousValue: unknown;
  currentValue: unknown;
  /** componentId plus any component whose componentDependencies directly names it — one hop, read from the snapshot's own import-derived graph, never guessed. */
  affectedComponents: string[];
  status: 'detected';
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function indexBy<T>(items: T[], key: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(key(item), item);
  return map;
}

function oneHopDependents(snapshot: CodeSnapshot, componentId: string): string[] {
  return snapshot.components
    .filter((c) => c.componentDependencies.includes(componentId))
    .map((c) => c.componentId)
    .sort();
}

export function compareCodeSnapshots(previous: CodeSnapshot, current: CodeSnapshot): CodeChangeRecord[] {
  const changes: CodeChangeRecord[] = [];
  const timestamp = new Date().toISOString();
  const sourceSnapshot = { previous: previous.snapshotId, current: current.snapshotId };

  function emit(
    entityId: string,
    changeType: CodeChangeType,
    field: string,
    previousValue: unknown,
    currentValue: unknown,
    affectedComponents: string[],
  ): void {
    const changeId = createHash('sha256')
      .update(['component', entityId, changeType, field, previous.snapshotId, current.snapshotId].join('|'))
      .digest('hex')
      .slice(0, 12);
    changes.push({
      changeId,
      timestamp,
      sourceSnapshot,
      entityType: 'component',
      entityId,
      changeType,
      field,
      previousValue,
      currentValue,
      affectedComponents: [...new Set(affectedComponents)].sort(),
      status: 'detected',
    });
  }

  const prevComps = indexBy(previous.components, (c) => c.componentId);
  const currComps = indexBy(current.components, (c) => c.componentId);
  const allIds = [...new Set([...prevComps.keys(), ...currComps.keys()])].sort();

  for (const id of allIds) {
    const prev: CodeComponentEntry | undefined = prevComps.get(id);
    const curr: CodeComponentEntry | undefined = currComps.get(id);

    if (!prev && curr) {
      emit(id, 'component-added', 'component', null, curr, [id, ...oneHopDependents(current, id)]);
      continue;
    }
    if (prev && !curr) {
      emit(id, 'component-removed', 'component', prev, null, [id, ...oneHopDependents(previous, id)]);
      continue;
    }
    if (!prev || !curr) continue; // unreachable, narrows types below

    const affected = [...new Set([id, ...oneHopDependents(current, id), ...oneHopDependents(previous, id)])];

    if (!deepEqual(prev.sourceHashes, curr.sourceHashes)) {
      emit(id, 'source-hash-changed', 'sourceHashes', prev.sourceHashes, curr.sourceHashes, affected);
    }
    if (!deepEqual(prev.props, curr.props) || prev.propsBaseType !== curr.propsBaseType) {
      emit(
        id,
        'props-changed',
        'props',
        { props: prev.props, propsBaseType: prev.propsBaseType },
        { props: curr.props, propsBaseType: curr.propsBaseType },
        affected,
      );
    }
    if (!deepEqual(prev.variants, curr.variants)) {
      emit(id, 'variants-changed', 'variants', prev.variants, curr.variants, affected);
    }
    if (!deepEqual(prev.cssCustomPropertiesConsumed, curr.cssCustomPropertiesConsumed)) {
      emit(
        id,
        'css-consumed-changed',
        'cssCustomPropertiesConsumed',
        prev.cssCustomPropertiesConsumed,
        curr.cssCustomPropertiesConsumed,
        affected,
      );
    }
    if (!deepEqual(prev.cssCustomPropertiesDefined, curr.cssCustomPropertiesDefined)) {
      emit(
        id,
        'css-defined-changed',
        'cssCustomPropertiesDefined',
        prev.cssCustomPropertiesDefined,
        curr.cssCustomPropertiesDefined,
        affected,
      );
    }
    if (!deepEqual(prev.componentDependencies, curr.componentDependencies)) {
      emit(
        id,
        'dependency-changed',
        'componentDependencies',
        prev.componentDependencies,
        curr.componentDependencies,
        affected,
      );
    }
    if (!deepEqual(prev.storybook, curr.storybook)) {
      emit(id, 'storybook-changed', 'storybook', prev.storybook, curr.storybook, affected);
    }
  }

  return changes;
}
