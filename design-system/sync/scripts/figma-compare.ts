/**
 * Deterministic comparison between two FigmaSnapshots. Same pattern as
 * compare.ts / code-compare.ts: index by id, diff fields, emit a hashed
 * changeId. No I/O, no LLM, no judgment.
 *
 * Only categories backed by data this stage could reliably extract are
 * implemented. Notably absent: "alias changed" — the available Figma MCP
 * tools do not expose variable alias chains (see
 * figma-snapshots/README.md); adding that category would mean comparing
 * data that was never actually retrieved, which the task this stage
 * followed from explicitly rules out ("do not fabricate"). If alias data
 * becomes available from a different source in a future stage, add it
 * then — not by inventing values now.
 */
import { createHash } from 'node:crypto';
import type {
  FigmaSnapshot,
  FigmaComponentEntry,
  FigmaVariableEntry,
  FigmaTextStyleEntry,
  FigmaVariantEntry,
} from './figma-snapshot-types.ts';

export type FigmaChangeType =
  | 'component-added'
  | 'component-removed'
  | 'variant-added'
  | 'variant-removed'
  | 'variant-property-changed'
  | 'variant-dimension-changed'
  | 'component-property-changed'
  | 'variable-added'
  | 'variable-removed'
  | 'variable-value-changed'
  | 'text-style-added'
  | 'text-style-removed'
  | 'text-style-changed';

export type FigmaEntityType = 'component' | 'variant' | 'variable' | 'text-style';

export interface FigmaChangeRecord {
  changeId: string;
  timestamp: string;
  sourceSnapshot: { previous: string; current: string };
  entityType: FigmaEntityType;
  entityId: string;
  changeType: FigmaChangeType;
  field: string;
  previousValue: unknown;
  currentValue: unknown;
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

export function compareFigmaSnapshots(previous: FigmaSnapshot, current: FigmaSnapshot): FigmaChangeRecord[] {
  const changes: FigmaChangeRecord[] = [];
  const timestamp = new Date().toISOString();
  const sourceSnapshot = { previous: previous.snapshotId, current: current.snapshotId };

  function emit(
    entityType: FigmaEntityType,
    entityId: string,
    changeType: FigmaChangeType,
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

  // ---------------- components (incl. variants nested within) ----------------
  const prevComps = indexBy(previous.components, (c) => c.figmaNodeId);
  const currComps = indexBy(current.components, (c) => c.figmaNodeId);
  const allComponentIds = [...new Set([...prevComps.keys(), ...currComps.keys()])].sort();

  for (const id of allComponentIds) {
    const prev: FigmaComponentEntry | undefined = prevComps.get(id);
    const curr: FigmaComponentEntry | undefined = currComps.get(id);

    if (!prev && curr) {
      emit('component', id, 'component-added', 'component', null, curr, [id]);
      continue;
    }
    if (prev && !curr) {
      emit('component', id, 'component-removed', 'component', prev, null, [id]);
      continue;
    }
    if (!prev || !curr) continue; // unreachable, narrows types below

    // component-level "properties": name, section, kind, container
    // dimensions — the only component-level attributes this stage's MCP
    // access can see. True Figma component properties (boolean/instance-
    // swap/text props) require Code Connect access, unavailable on this
    // plan tier — see README.
    if (prev.name !== curr.name) {
      emit('component', id, 'component-property-changed', 'name', prev.name, curr.name, [id]);
    }
    if (
      prev.sectionId !== curr.sectionId ||
      prev.sectionName !== curr.sectionName ||
      prev.kind !== curr.kind
    ) {
      emit(
        'component',
        id,
        'component-property-changed',
        'section/kind',
        { sectionId: prev.sectionId, sectionName: prev.sectionName, kind: prev.kind },
        { sectionId: curr.sectionId, sectionName: curr.sectionName, kind: curr.kind },
        [id],
      );
    }
    if (prev.containerWidth !== curr.containerWidth || prev.containerHeight !== curr.containerHeight) {
      emit(
        'component',
        id,
        'component-property-changed',
        'containerDimensions',
        { width: prev.containerWidth, height: prev.containerHeight },
        { width: curr.containerWidth, height: curr.containerHeight },
        [id],
      );
    }
    if (!deepEqual(prev.variantPropertyNames, curr.variantPropertyNames) || !deepEqual(prev.variantPropertyValues, curr.variantPropertyValues)) {
      emit(
        'component',
        id,
        'variant-property-changed',
        'variantPropertyValues',
        { names: prev.variantPropertyNames, values: prev.variantPropertyValues },
        { names: curr.variantPropertyNames, values: curr.variantPropertyValues },
        [id],
      );
    }

    // ---- variants nested within this component ----
    const prevVariants = indexBy(prev.variants, (v) => v.nodeId);
    const currVariants = indexBy(curr.variants, (v) => v.nodeId);
    const allVariantIds = [...new Set([...prevVariants.keys(), ...currVariants.keys()])].sort();

    for (const variantId of allVariantIds) {
      const prevVariant: FigmaVariantEntry | undefined = prevVariants.get(variantId);
      const currVariant: FigmaVariantEntry | undefined = currVariants.get(variantId);

      if (!prevVariant && currVariant) {
        emit('variant', variantId, 'variant-added', 'variant', null, currVariant, [id]);
        continue;
      }
      if (prevVariant && !currVariant) {
        emit('variant', variantId, 'variant-removed', 'variant', prevVariant, null, [id]);
        continue;
      }
      if (!prevVariant || !currVariant) continue;

      if (!deepEqual(prevVariant.properties, currVariant.properties)) {
        emit(
          'variant',
          variantId,
          'variant-property-changed',
          'properties',
          prevVariant.properties,
          currVariant.properties,
          [id],
        );
      }
      if (prevVariant.width !== currVariant.width || prevVariant.height !== currVariant.height) {
        emit(
          'variant',
          variantId,
          'variant-dimension-changed',
          'width/height',
          { width: prevVariant.width, height: prevVariant.height },
          { width: currVariant.width, height: currVariant.height },
          [id],
        );
      }
    }
  }

  // ---------------- variables ----------------
  const prevVars = indexBy(previous.variables, (v) => v.name);
  const currVars = indexBy(current.variables, (v) => v.name);
  const allVarNames = [...new Set([...prevVars.keys(), ...currVars.keys()])].sort();

  for (const name of allVarNames) {
    const prev: FigmaVariableEntry | undefined = prevVars.get(name);
    const curr: FigmaVariableEntry | undefined = currVars.get(name);

    if (!prev && curr) {
      emit('variable', name, 'variable-added', 'variable', null, curr, curr.consumedBy);
      continue;
    }
    if (prev && !curr) {
      emit('variable', name, 'variable-removed', 'variable', prev, null, prev.consumedBy);
      continue;
    }
    if (prev && curr && prev.value !== curr.value) {
      const affected = [...new Set([...prev.consumedBy, ...curr.consumedBy])];
      emit('variable', name, 'variable-value-changed', 'value', prev.value, curr.value, affected);
    }
  }

  // ---------------- text styles ----------------
  const prevStyles = indexBy(previous.textStyles, (t) => t.name);
  const currStyles = indexBy(current.textStyles, (t) => t.name);
  const allStyleNames = [...new Set([...prevStyles.keys(), ...currStyles.keys()])].sort();

  function componentsUsingTextStyle(snapshot: FigmaSnapshot, styleName: string): string[] {
    return snapshot.components
      .filter((c) => c.variableBindings.some((b) => b.name === styleName))
      .map((c) => c.figmaNodeId)
      .sort();
  }

  for (const name of allStyleNames) {
    const prev: FigmaTextStyleEntry | undefined = prevStyles.get(name);
    const curr: FigmaTextStyleEntry | undefined = currStyles.get(name);

    if (!prev && curr) {
      emit('text-style', name, 'text-style-added', 'textStyle', null, curr, componentsUsingTextStyle(current, name));
      continue;
    }
    if (prev && !curr) {
      emit('text-style', name, 'text-style-removed', 'textStyle', prev, null, componentsUsingTextStyle(previous, name));
      continue;
    }
    if (prev && curr && !deepEqual(prev, curr)) {
      const affected = [
        ...new Set([...componentsUsingTextStyle(previous, name), ...componentsUsingTextStyle(current, name)]),
      ];
      emit('text-style', name, 'text-style-changed', 'textStyle', prev, curr, affected);
    }
  }

  return changes;
}
