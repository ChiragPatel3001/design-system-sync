/**
 * Pure, deterministic reconciliation comparison (Stage 5C). Joins the
 * Stage 5B identity crosswalk against already-captured registry, Figma,
 * and Code state to answer exactly one question per entity: "do the
 * independently observed sides agree with each other and with the
 * registry's recorded expectation, and if not, what kind of disagreement
 * is it?"
 *
 * This module NEVER decides whether a disagreement is good or bad, never
 * proposes or applies a fix, and never writes anywhere. It has no
 * filesystem I/O, no network calls, no Figma/Git calls, generates no
 * timestamps and no random ids, and never mutates its inputs — every
 * array copy below is a fresh spread/map/filter, never an in-place sort
 * or push onto something a caller passed in. The same five inputs always
 * produce the same output.
 *
 * Reuse, not reinvention: temporal "did Figma change" / "did Code
 * change" facts are obtained by calling the EXISTING, already-tested
 * compareFigmaSnapshots()/compareCodeSnapshots() (imported, not
 * reimplemented — this module does not modify either), and one-hop
 * affected-components expansion reuses impact.ts's oneHopUsedBy /
 * directTokenConsumers rather than introducing a second dependency-graph
 * model. Registry-side context comes from the registry-snapshot engine's
 * own Snapshot type (types.ts) — this stage's entire job is to join
 * across all three engines, so depending on their (unmodified) public
 * types and pure functions here is the point, not a violation of the
 * capture-stage independence those engines maintain from EACH OTHER.
 *
 * ---------------------------------------------------------------------
 * Two distinct comparison axes (see design-system/sync/README.md's
 * "affectedComponents is one hop only" precedent for the project's
 * general practice of keeping distinct facts on distinct fields/records
 * rather than collapsing them):
 *
 *   (1) TEMPORAL — did this side's OWN state drift from its OWN baseline?
 *       figma-only-change / code-only-change / both-changed-compatible /
 *       both-changed-conflict. Nothing is emitted when neither side
 *       drifted.
 *
 *   (2) EXPECTATION — does the registry's long-recorded value for a
 *       component's Figma-side facts (variant property names/values/
 *       count — the only Figma-side facts the registry itself records)
 *       match what the CURRENT Figma capture actually shows? This is
 *       `registry-expectation-mismatch` (see reconcile-types.ts for why
 *       this status was added). It fires independently of (1) — the real
 *       Button case fires it with ZERO temporal drift on either side,
 *       because the mismatch (registry: "Property 1", Figma: "State")
 *       has apparently existed since the registry was authored, not
 *       something that changed during this project.
 *
 * Only components have an expectation axis: the registry records no
 * comparable per-token Figma value (registry.tokens[].figmaValue is a
 * typed JSON value in Figma's own type system; a FigmaSnapshot variable's
 * `value` is always a plain string — already different representations
 * before even considering aliasing) and no comparable per-component Code
 * value (React variant props vs Figma variant properties are a DIFFERENT
 * representation by the registry's own admission — see registry.json's
 * reactPropMapping, e.g. Button's "Property 1": "implemented as CSS
 * :hover/:focus-visible/:disabled — not a prop"). Attempting either
 * comparison would not be "deterministic equality under a documented
 * rule" — it would be comparing two representations nothing in this
 * codebase claims are equivalent, which is exactly the "invented
 * semantic compatibility" this stage was told not to do.
 *
 * ---------------------------------------------------------------------
 * Token "compatible" vs "conflict" — the one place a Figma-vs-Code raw
 * VALUE equality check IS attempted (only when both sides changed since
 * baseline): compatible means the current Figma variable value string is
 * character-identical to the current Code token definition's raw value
 * string. This is a real, simple, fully deterministic rule — but be
 * aware of what it actually measures: CodeSnapshot.tokenDefinitions
 * captures each CSS custom property's LITERAL, unresolved source text by
 * design (Stage 5A; e.g. "--radius-lg: var(--scale-100);" is captured as
 * "var(--scale-100)", never resolved to "4"), while a FigmaSnapshot
 * variable's value is always the fully RESOLVED final value ("4"). For
 * any token whose code definition is itself an alias (which is true of
 * essentially every real Mapped/Alias-collection token in this registry
 * — confirmed by direct inspection), this equality will be false even
 * when the token is, in every meaningful sense, unchanged and correct.
 * That is reported as `both-changed-conflict`, honestly, rather than
 * silently assumed compatible — resolving the alias chain so this
 * comparison becomes meaningful for aliased tokens is exactly the kind
 * of interpretation/normalization work this stage was told not to do;
 * it belongs to a later stage with an explicit, documented resolution
 * rule.
 *
 * ---------------------------------------------------------------------
 * Figma subtree consumption (see figma-snapshot-types.ts:
 * RawFigmaComponentCapture.variableDefs — "every variable bound anywhere
 * in this node's subtree", NOT just this node's own direct styling):
 * FigmaVariableEntry.consumedBy is therefore subtree-inclusive — e.g. the
 * real captured "Border radius/lg" variable's consumedBy includes
 * form-field's Figma node (18:256, "Input") purely because form-field
 * renders a nested TextField instance that itself uses that radius, even
 * though form-field's OWN registry tokenIds list does not include
 * radius-lg and its own code never references --radius-lg directly. This
 * module NEVER compares Figma's consumedBy against the registry's or
 * CodeSnapshot's consumption lists, and NEVER uses it as evidence for any
 * status above — see the real-data regression test in
 * reconcile-compare.test.ts. A token record's `affectedComponents` is
 * always the registry's own directly-authored consumedBy (via
 * impact.ts's directTokenConsumers), never Figma's.
 *
 * ---------------------------------------------------------------------
 * Reconciliation entity boundary (Stage 5E — additive): NOT every entity
 * a snapshot happens to contain is a reconciliation entity. The Code
 * token reverse pass below distinguishes `unmapped-code-entity` (inside
 * the boundary — registry-tracked or directly consumed by a tracked
 * component's own CSS — but unmapped) from `out-of-scope-entity`
 * (neither — real design-token infrastructure this POC's registry never
 * catalogues by design; see design-system/registry-schema.md's own
 * "Scope" section and consumedCssVariables() below). The Figma-variable
 * reverse pass also now recognizes registry.json's textStyles[] as a
 * distinct, crosswalk-resolvable entity kind (see reconcile-types.ts's
 * TextStyleIdentityMapping), so a tracked text style like "Body/Medium"
 * is no longer indistinguishable from a genuine gap. Neither change
 * touches the temporal or expectation axes above, or any other status.
 */
import { createHash } from 'node:crypto';
import type { Snapshot } from './types.ts';
import { oneHopUsedBy, directTokenConsumers } from './impact.ts';
import type { FigmaSnapshot, FigmaVariableEntry } from './figma-snapshot-types.ts';
import { compareFigmaSnapshots } from './figma-compare.ts';
import type { CodeSnapshot } from './code-snapshot-types.ts';
import { compareCodeSnapshots } from './code-compare.ts';
import type {
  ReconciliationCrosswalk,
  ReconciliationRecord,
  ReconciliationStatus,
  ReconciliationSideObservation,
} from './reconcile-types.ts';

// ---------------------------------------------------------------------
// registry.json's unresolved[] shape (only the fields this module reads).
// Not part of the registry-snapshot engine's own Snapshot type (types.ts
// does not carry unresolved[] at all), so it's accepted as its own input
// rather than invented as an addition to that engine's type.
// ---------------------------------------------------------------------

export interface RegistryUnresolvedEntry {
  entity: string;
  tokenId: string;
}

/**
 * True iff registry.json's unresolved[] documents this exact
 * (entity, tokenId) pair — the only deterministic, structured signal
 * available for section 12 ("documented deviations"). `knownLimitations`
 * is deliberately NOT consulted here: per
 * design-system/registry-schema.md, it is free text ("Free-text notes on
 * Figma limitations or deliberate code deviations"), not a structured,
 * per-field record — matching it to a specific reconciliation record
 * would require substring/text matching, which is exactly the "fuzzy
 * matching" this stage was told not to implement. See
 * reconcile-compare.test.ts and this module's final report for why, on
 * the real registry, this lookup is never actually reached by any
 * comparison this stage performs (nothing here computes a per-
 * component-per-token fact — that would be the subtree-consumption
 * comparison section 6 explicitly forbids) — it is implemented and
 * tested as a pure utility for a future stage to call, not invented
 * output.
 */
export function isDocumentedUnresolved(
  unresolved: RegistryUnresolvedEntry[],
  entity: string,
  tokenId: string,
): boolean {
  return unresolved.some((u) => u.entity === entity && u.tokenId === tokenId);
}

// ---------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Sorts a Figma-style variant-properties shape so key order and each value array's order never cause a false mismatch — applied to BOTH sides before comparing, since registry.json's own figmaVariantProperties is authored (not guaranteed pre-sorted) while a FigmaSnapshot's is already sorted by construction. */
function normalizeVariantProperties(props: Record<string, string[]>): { names: string[]; values: Record<string, string[]> } {
  const names = Object.keys(props).sort();
  const values: Record<string, string[]> = {};
  for (const name of names) values[name] = [...props[name]].sort();
  return { names, values };
}

function makeReconciliationId(parts: (string | null)[]): string {
  return createHash('sha256').update(parts.map((p) => p ?? '\u0000').join('|')).digest('hex').slice(0, 12);
}

/**
 * The union of every registry-tracked component's own
 * `cssCustomPropertiesConsumed` (see code-snapshot-types.ts —
 * already computed by code-snapshot.ts via a direct, per-component
 * `var(--...)` grep of that component's own .css file; nothing new is
 * extracted here). This is the reconciliation entity boundary for Code
 * tokens (see the Code-token reverse pass below and
 * reconcile-types.ts's `out-of-scope-entity` doc comment) — deliberately
 * NOT the same as "every variable this component's subtree might touch"
 * (that would be the Figma-side subtree-consumption problem this module
 * already refuses to rely on elsewhere).
 */
export function consumedCssVariables(codeSnapshot: CodeSnapshot): Set<string> {
  const consumed = new Set<string>();
  for (const component of codeSnapshot.components) {
    for (const cssVariable of component.cssCustomPropertiesConsumed) consumed.add(cssVariable);
  }
  return consumed;
}

// ---------------------------------------------------------------------
// Input / output shape.
// ---------------------------------------------------------------------

export interface ReconcileSnapshotsInput {
  registrySnapshot: Snapshot;
  registryUnresolved: RegistryUnresolvedEntry[];
  figmaBaseline: FigmaSnapshot;
  figmaCurrent: FigmaSnapshot;
  codeBaseline: CodeSnapshot;
  codeCurrent: CodeSnapshot;
  crosswalk: ReconciliationCrosswalk;
}

export function reconcileSnapshots(input: ReconcileSnapshotsInput): ReconciliationRecord[] {
  const { registrySnapshot, figmaBaseline, figmaCurrent, codeBaseline, codeCurrent, crosswalk } = input;

  const sources = {
    figmaBaselineId: figmaBaseline.snapshotId,
    figmaCurrentId: figmaCurrent.snapshotId,
    codeBaselineId: codeBaseline.snapshotId,
    codeCurrentId: codeCurrent.snapshotId,
  };

  // Reused, not reimplemented — see module header.
  const figmaChanges = compareFigmaSnapshots(figmaBaseline, figmaCurrent);
  const codeChanges = compareCodeSnapshots(codeBaseline, codeCurrent);

  const registryComponentsById = new Map(registrySnapshot.components.map((c) => [c.id, c]));

  const records: ReconciliationRecord[] = [];

  function emit(
    entityType: ReconciliationRecord['entityType'],
    entityId: string,
    registryId: string | null,
    field: string,
    status: ReconciliationStatus,
    figma: ReconciliationSideObservation | null,
    code: ReconciliationSideObservation | null,
    registryExpected: unknown,
    affectedComponents: string[],
    detail: string,
  ): void {
    records.push({
      reconciliationId: makeReconciliationId([entityType, entityId, field, status, ...Object.values(sources)]),
      entityType,
      entityId,
      registryId,
      field,
      status,
      figma,
      code,
      registryExpected,
      affectedComponents: [...new Set(affectedComponents)].sort(),
      sources,
      detail,
    });
  }

  // =====================================================================
  // Components — one pass per crosswalk mapping (registry-anchored).
  // =====================================================================

  for (const mapping of crosswalk.components) {
    const registryComponentId = mapping.registryComponentId;
    const affected = [registryComponentId, ...oneHopUsedBy(registrySnapshot, registryComponentId)];

    // Section 10: an unresolved codePath is ALWAYS an identity problem,
    // never silently treated as a deletion. Nothing else is attempted
    // for this component.
    if (mapping.status === 'unresolved-code-path') {
      emit(
        'component',
        registryComponentId,
        registryComponentId,
        'identity',
        'identity-mismatch',
        null,
        null,
        mapping.codePath,
        affected,
        `registry codePath "${mapping.codePath}" does not match the src/components/<Name>/<Name>.tsx convention — no CodeSnapshot componentId could be derived.`,
      );
      continue;
    }

    const figmaNodeId = mapping.figmaNodeId;
    const codeComponentId = mapping.codeComponentId as string; // non-null: status !== 'unresolved-code-path'

    const figmaCurrentEntry = figmaCurrent.components.find((c) => c.figmaNodeId === figmaNodeId);
    const figmaBaselineEntry = figmaBaseline.components.find((c) => c.figmaNodeId === figmaNodeId);
    const codeCurrentEntry = codeCurrent.components.find((c) => c.componentId === codeComponentId);
    const codeBaselineEntry = codeBaseline.components.find((c) => c.componentId === codeComponentId);

    let figmaResolvable = true;
    if (!figmaCurrentEntry) {
      figmaResolvable = false;
      const wasThere = !!figmaBaselineEntry;
      emit(
        'component',
        registryComponentId,
        registryComponentId,
        'existence',
        wasThere ? 'deleted-figma-entity' : 'unmapped-figma-entity',
        { current: null, baseline: figmaBaselineEntry ?? null, changed: null },
        null,
        null,
        affected,
        wasThere
          ? `registry component "${registryComponentId}" maps to Figma node ${figmaNodeId}, which was present in the Figma baseline capture but is absent from the current one.`
          : `registry component "${registryComponentId}" maps to Figma node ${figmaNodeId}, which is not present in the Figma baseline or current capture — never observed.`,
      );
    }

    let codeResolvable = true;
    if (!codeCurrentEntry) {
      codeResolvable = false;
      const wasThere = !!codeBaselineEntry;
      emit(
        'component',
        registryComponentId,
        registryComponentId,
        'existence',
        wasThere ? 'deleted-code-entity' : 'unmapped-code-entity',
        null,
        { current: null, baseline: codeBaselineEntry ?? null, changed: null },
        null,
        affected,
        wasThere
          ? `registry component "${registryComponentId}" maps to CodeSnapshot component "${codeComponentId}", which was present in the code baseline but is absent from the current CodeSnapshot.`
          : `registry component "${registryComponentId}" maps to CodeSnapshot component "${codeComponentId}", which is not present in the code baseline or current CodeSnapshot — never observed.`,
      );
    }

    // ---- Expectation axis: registry-recorded variant facts vs current Figma. ----
    let expectationMatches: boolean | null = null;
    if (figmaResolvable) {
      const registryEntry = registryComponentsById.get(registryComponentId);
      if (registryEntry) {
        const registryExpected = {
          ...normalizeVariantProperties(registryEntry.figmaVariantProperties),
          variantCount: registryEntry.variantCount,
        };
        const figmaObserved = {
          ...normalizeVariantProperties(figmaCurrentEntry!.variantPropertyValues),
          variantCount: figmaCurrentEntry!.variantCount,
        };
        expectationMatches = deepEqual(registryExpected, figmaObserved);
        if (!expectationMatches) {
          emit(
            'component',
            registryComponentId,
            registryComponentId,
            'variantProperties',
            'registry-expectation-mismatch',
            { current: figmaObserved, baseline: null, changed: null },
            null,
            registryExpected,
            affected,
            `registry-recorded variant properties for "${registryComponentId}" (names: ${registryExpected.names.join(', ')}) do not match the current Figma capture's variant properties (names: ${figmaObserved.names.join(', ')}) for node ${figmaNodeId}.`,
          );
        }
      }
    }

    // ---- Temporal axis. ----
    const figmaChanged = figmaResolvable
      ? figmaChanges.some(
          (r) =>
            (r.entityType === 'component' && r.entityId === figmaNodeId) ||
            (r.entityType === 'variant' && r.affectedComponents.includes(figmaNodeId)),
        )
      : null;
    const codeChanged = codeResolvable ? codeChanges.some((r) => r.entityId === codeComponentId) : null;

    if (figmaResolvable && codeResolvable) {
      if (figmaChanged && codeChanged) {
        const compatible = expectationMatches !== false; // the only sound oracle available for components — see module header
        emit(
          'component',
          registryComponentId,
          registryComponentId,
          'component',
          compatible ? 'both-changed-compatible' : 'both-changed-conflict',
          { current: figmaCurrentEntry, baseline: figmaBaselineEntry ?? null, changed: true },
          { current: codeCurrentEntry, baseline: codeBaselineEntry ?? null, changed: true },
          null,
          affected,
          `both Figma and Code state changed since their respective baselines for "${registryComponentId}"; ${compatible ? 'the registry-recorded expectation still matches the current Figma state' : 'the registry-recorded expectation no longer matches the current Figma state'}.`,
        );
      } else if (figmaChanged) {
        emit(
          'component',
          registryComponentId,
          registryComponentId,
          'component',
          'figma-only-change',
          { current: figmaCurrentEntry, baseline: figmaBaselineEntry ?? null, changed: true },
          { current: codeCurrentEntry, baseline: codeBaselineEntry ?? null, changed: false },
          null,
          affected,
          `Figma state changed since baseline for node ${figmaNodeId}; CodeSnapshot state for "${codeComponentId}" did not.`,
        );
      } else if (codeChanged) {
        emit(
          'component',
          registryComponentId,
          registryComponentId,
          'component',
          'code-only-change',
          { current: figmaCurrentEntry, baseline: figmaBaselineEntry ?? null, changed: false },
          { current: codeCurrentEntry, baseline: codeBaselineEntry ?? null, changed: true },
          null,
          affected,
          `CodeSnapshot state changed since baseline for "${codeComponentId}"; Figma state for node ${figmaNodeId} did not.`,
        );
      }
      // neither changed -> no temporal record; the expectation-axis record above (if any) already covers "current sides disagree".
    } else if (codeResolvable && codeChanged) {
      // Figma side unresolvable (already reported above) — code-side temporal fact is still real and independently reportable.
      emit(
        'component',
        registryComponentId,
        registryComponentId,
        'component',
        'code-only-change',
        null,
        { current: codeCurrentEntry, baseline: codeBaselineEntry ?? null, changed: true },
        null,
        affected,
        `CodeSnapshot state changed since baseline for "${codeComponentId}" (Figma side could not be resolved this run — see the existence record above).`,
      );
    } else if (figmaResolvable && figmaChanged) {
      emit(
        'component',
        registryComponentId,
        registryComponentId,
        'component',
        'figma-only-change',
        { current: figmaCurrentEntry, baseline: figmaBaselineEntry ?? null, changed: true },
        null,
        null,
        affected,
        `Figma state changed since baseline for node ${figmaNodeId} (Code side could not be resolved this run — see the existence record above).`,
      );
    }
  }

  // =====================================================================
  // Tokens — one pass per crosswalk mapping (registry-anchored).
  // =====================================================================

  for (const mapping of crosswalk.tokens) {
    const registryTokenId = mapping.registryTokenId;
    const cssVariable = mapping.cssVariable;
    const isInferred = mapping.registrySourceType === 'inferred';
    // A colliding normalizedFigmaName is not a safe join key (see
    // reconcile-crosswalk.ts / reconcile-types.ts) — treat it the same as
    // "not Figma-backed" for THIS stage rather than guessing which of the
    // colliding registry tokens a given Figma variable actually belongs to.
    const normalizedFigmaName = mapping.status === 'collision' ? null : mapping.normalizedFigmaName;
    const figmaApplicable = !isInferred && normalizedFigmaName !== null;

    const affected = directTokenConsumers(registrySnapshot, registryTokenId);

    const codeCurrentDef = codeCurrent.tokenDefinitions.find((t) => t.cssVariable === cssVariable);
    // codeBaseline.tokenDefinitions can be absent on a real, on-disk
    // baseline captured before Stage 5A added this field — defensive
    // fallback for that real, observed condition (see
    // reconcile-compare.test.ts's dedicated regression test), not
    // speculative validation.
    const codeBaselineDef = (codeBaseline.tokenDefinitions ?? []).find((t) => t.cssVariable === cssVariable);

    let codeResolvable = true;
    if (!codeCurrentDef) {
      codeResolvable = false;
      const wasThere = !!codeBaselineDef;
      emit(
        'token',
        registryTokenId,
        registryTokenId,
        'existence',
        wasThere ? 'deleted-code-entity' : 'unmapped-code-entity',
        null,
        { current: null, baseline: codeBaselineDef ?? null, changed: null },
        null,
        affected,
        wasThere
          ? `registry token "${registryTokenId}" maps to CSS variable "${cssVariable}", which was present in the code baseline's tokenDefinitions but is absent from the current CodeSnapshot.`
          : `registry token "${registryTokenId}" maps to CSS variable "${cssVariable}", which is not present in the code baseline or current CodeSnapshot's tokenDefinitions — never observed.`,
      );
    }

    let figmaResolvable = false;
    let figmaCurrentVar: FigmaVariableEntry | undefined;
    let figmaBaselineVar: FigmaVariableEntry | undefined;
    if (figmaApplicable) {
      figmaCurrentVar = figmaCurrent.variables.find((v) => v.name === normalizedFigmaName);
      figmaBaselineVar = figmaBaseline.variables.find((v) => v.name === normalizedFigmaName);
      if (!figmaCurrentVar) {
        const wasThere = !!figmaBaselineVar;
        // Section 5: this is the real case (e.g. "Text/Caption",
        // "Scale/200", "Scale/300", "Caption/Font size",
        // "Caption/Line Height") — an unmapped/unobserved Figma-side
        // entity, deliberately NOT reported as a value conflict.
        emit(
          'token',
          registryTokenId,
          registryTokenId,
          'existence',
          wasThere ? 'deleted-figma-entity' : 'unmapped-figma-entity',
          { current: null, baseline: figmaBaselineVar ?? null, changed: null },
          null,
          null,
          affected,
          wasThere
            ? `registry token "${registryTokenId}" normalizes to Figma variable name "${normalizedFigmaName}", which was present in the Figma baseline capture but is absent from the current one.`
            : `registry token "${registryTokenId}" normalizes to Figma variable name "${normalizedFigmaName}", which is not present in the Figma baseline or current capture — an unmapped/unobserved Figma-side entity, not a value conflict.`,
        );
      } else {
        figmaResolvable = true;
      }
    }

    if (!codeResolvable) continue; // nothing further to compare without a current code value

    const codeChanged = codeCurrentDef!.value !== codeBaselineDef?.value;

    if (figmaResolvable) {
      const figmaChanged = figmaCurrentVar!.value !== figmaBaselineVar!.value;
      if (figmaChanged && codeChanged) {
        const compatible = figmaCurrentVar!.value === codeCurrentDef!.value; // see module header on what this equality does/doesn't prove
        emit(
          'token',
          registryTokenId,
          registryTokenId,
          'value',
          compatible ? 'both-changed-compatible' : 'both-changed-conflict',
          { current: figmaCurrentVar!.value, baseline: figmaBaselineVar!.value, changed: true },
          { current: codeCurrentDef!.value, baseline: codeBaselineDef?.value ?? null, changed: true },
          null,
          affected,
          `both the Figma variable "${normalizedFigmaName}" and the code definition "${cssVariable}" changed since their respective baselines; ${compatible ? 'their current raw values are identical' : 'their current raw values differ (see module header: code stores the unresolved alias/literal text, Figma reports the fully resolved value)'}.`,
        );
      } else if (figmaChanged) {
        emit(
          'token',
          registryTokenId,
          registryTokenId,
          'value',
          'figma-only-change',
          { current: figmaCurrentVar!.value, baseline: figmaBaselineVar!.value, changed: true },
          { current: codeCurrentDef!.value, baseline: codeBaselineDef?.value ?? null, changed: false },
          null,
          affected,
          `Figma variable "${normalizedFigmaName}" changed since baseline; code definition "${cssVariable}" did not.`,
        );
      } else if (codeChanged) {
        emit(
          'token',
          registryTokenId,
          registryTokenId,
          'value',
          'code-only-change',
          { current: figmaCurrentVar!.value, baseline: figmaBaselineVar!.value, changed: false },
          { current: codeCurrentDef!.value, baseline: codeBaselineDef?.value ?? null, changed: true },
          null,
          affected,
          `code definition "${cssVariable}" changed since baseline; Figma variable "${normalizedFigmaName}" did not.`,
        );
      }
      // neither changed -> no temporal record.
    } else if (codeChanged) {
      // Not Figma-applicable (inferred token) or Figma side unresolvable
      // this run (already reported above) — the code-side temporal fact
      // is still real and independently reportable.
      emit(
        'token',
        registryTokenId,
        registryTokenId,
        'value',
        'code-only-change',
        null,
        { current: codeCurrentDef!.value, baseline: codeBaselineDef?.value ?? null, changed: true },
        null,
        affected,
        isInferred
          ? `code definition "${cssVariable}" changed since baseline; this token is registrySourceType "inferred" (font-weight-body-style — no Figma variable exists for it, so no Figma value is invented or compared).`
          : `code definition "${cssVariable}" changed since baseline (Figma side could not be resolved this run — see the existence/collision record above, if any).`,
      );
    }
  }

  // =====================================================================
  // Reverse pass (section 9, cases i/ii): entities observed in a CURRENT
  // snapshot that no crosswalk mapping references at all. registryId is
  // null here — there is no registry entity to attach these to.
  // =====================================================================

  const crosswalkFigmaNodeIds = new Set(crosswalk.components.map((c) => c.figmaNodeId));
  for (const c of figmaCurrent.components) {
    if (crosswalkFigmaNodeIds.has(c.figmaNodeId)) continue;
    emit(
      'component',
      c.figmaNodeId,
      null,
      'existence',
      'unmapped-figma-entity',
      { current: c, baseline: null, changed: null },
      null,
      null,
      [],
      `Figma component "${c.name}" (node ${c.figmaNodeId}) is present in the current Figma capture but no registry component maps to it.`,
    );
  }

  // A Figma variable name is "claimed" either by a resolved token mapping
  // (normalizedFigmaName) or by a text-style mapping (figmaName) — see
  // reconcile-types.ts's TextStyleIdentityMapping header comment for why
  // registry.json's textStyles[] is a distinct entity kind the crosswalk
  // previously never read at all (e.g. "Body/Medium").
  const crosswalkClaimedFigmaVariableNames = new Set([
    ...crosswalk.tokens.filter((t) => t.status === 'resolved' && t.normalizedFigmaName !== null).map((t) => t.normalizedFigmaName as string),
    ...crosswalk.textStyles.map((t) => t.figmaName),
  ]);
  for (const v of figmaCurrent.variables) {
    if (crosswalkClaimedFigmaVariableNames.has(v.name)) continue;
    emit(
      'token',
      v.name,
      null,
      'existence',
      'unmapped-figma-entity',
      { current: v, baseline: null, changed: null },
      null,
      null,
      [],
      `Figma variable "${v.name}" is present in the current Figma capture but no registry token normalizes to it.`,
    );
  }

  const crosswalkCodeComponentIds = new Set(
    crosswalk.components.map((c) => c.codeComponentId).filter((id): id is string => id !== null),
  );
  for (const c of codeCurrent.components) {
    if (crosswalkCodeComponentIds.has(c.componentId)) continue;
    emit(
      'component',
      c.componentId,
      null,
      'existence',
      'unmapped-code-entity',
      null,
      { current: c, baseline: null, changed: null },
      null,
      [],
      `CodeSnapshot component "${c.componentId}" is present in the current CodeSnapshot but no registry component maps to it.`,
    );
  }

  // A Code token definition is reconciliation-ELIGIBLE (a candidate for
  // "unmapped-code-entity") iff it is registry-tracked OR directly
  // consumed by at least one registry-tracked component's own CSS (see
  // consumedCssVariables() below — the same direct, per-component,
  // grepped signal design-system/registry-schema.md's own documented
  // scope rule already relies on: "only *consumed* tokens are
  // catalogued"). Everything else in src/tokens/**/*.css (confirmed by
  // direct inspection: the full Brand/Alias raw-palette tiers plus unused
  // typography/spacing/radius steps — real, intentional design-token
  // infrastructure, not a gap) is out of the reconciliation entity
  // boundary entirely — reported as `out-of-scope-entity`, never silently
  // dropped, and never conflated with an actual missing mapping. This
  // uses ONLY already-captured CodeSnapshot data (cssCustomPropertiesConsumed,
  // computed by code-snapshot.ts's own component-CSS grep) — no subtree
  // consumption, no name-similarity/prefix heuristics, no alias-chain
  // resolution, no manifest coverage treated as an implicit mapping.
  const crosswalkCssVariables = new Set(crosswalk.tokens.map((t) => t.cssVariable));
  const consumedCodeCssVariables = consumedCssVariables(codeCurrent);
  for (const t of codeCurrent.tokenDefinitions) {
    if (crosswalkCssVariables.has(t.cssVariable)) continue;
    const eligible = consumedCodeCssVariables.has(t.cssVariable);
    emit(
      'token',
      t.cssVariable,
      null,
      'existence',
      eligible ? 'unmapped-code-entity' : 'out-of-scope-entity',
      null,
      { current: t, baseline: null, changed: null },
      null,
      [],
      eligible
        ? `CodeSnapshot token definition "${t.cssVariable}" is directly consumed by at least one registry-tracked component's own CSS, but no registry token maps to it.`
        : `CodeSnapshot token definition "${t.cssVariable}" is neither registry-tracked nor directly consumed by any registry-tracked component's own CSS — outside the reconciliation entity boundary (see design-system/registry-schema.md's "Scope: only consumed tokens are catalogued").`,
    );
  }

  // Deterministic final ordering, independent of the order records were
  // pushed in above.
  return [...records].sort(
    (a, b) =>
      a.entityType.localeCompare(b.entityType) ||
      a.entityId.localeCompare(b.entityId) ||
      a.field.localeCompare(b.field) ||
      a.status.localeCompare(b.status),
  );
}
