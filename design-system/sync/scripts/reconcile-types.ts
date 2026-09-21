/**
 * Types for the deterministic Figma <-> Code identity crosswalk (Stage
 * 5B). This crosswalk is the layer a future reconciliation engine will
 * use to JOIN independently observed Figma-side and Code-side entities
 * against design-system/registry.json's authored identity. This stage
 * builds ONLY the crosswalk — no comparison, no "did X change", no
 * conflict/confidence/proposed-action logic. See reconcile-crosswalk.ts's
 * header comment for the full scope boundary.
 *
 * Every mapping here originates from registry.json — the registry is the
 * authored identity/mapping layer, and stays authoritative. This module
 * never infers a mapping from name similarity, and it never reads a
 * captured code snapshot or a captured design-tool snapshot to construct
 * identity; it may at most preserve, verbatim, the join keys the registry
 * itself already records (a component node id, a code file path, a
 * variable name, a CSS custom property name).
 *
 * The three systems this crosswalk joins do NOT share one identity
 * scheme, and this module deliberately does not pretend they do:
 *   registry id            "button"
 *   design-tool node id    "15:664"
 *   code component id      "Button"
 * All three are preserved side by side, never collapsed into each other.
 */

// ---------------------------------------------------------------------
// Component identity
// ---------------------------------------------------------------------

/**
 * Duplicated from the registry-snapshot engine's own dependency-edge
 * shape (types.ts) rather than imported — see reconcile-crosswalk.ts's
 * header comment for why this crosswalk deliberately avoids importing
 * from any other engine's modules.
 */
export type ComponentDependencyRelationship = 'renders' | 'expects-children-of';

export interface ComponentDependencyEdge {
  id: string;
  relationship: ComponentDependencyRelationship;
}

export type ComponentIdentityStatus = 'resolved' | 'unresolved-code-path';

export interface ComponentIdentityMapping {
  /** The registry's own identity — registry.json components[].id, e.g. "button". */
  registryComponentId: string;
  /** The registry's authoritative design-tool join key — components[].figmaNodeId, e.g. "15:664". Never inferred, never re-derived. */
  figmaNodeId: string;
  /** components[].figmaName, preserved verbatim, e.g. "Button". Identity only — display name, not a join key. */
  figmaName: string;
  /**
   * The code-side identity, deterministically DERIVED from the registry's
   * codePath by deriveCodeComponentId() — NOT registry.id, and NOT read
   * from an actual captured code snapshot (identity must originate from
   * the registry; see module header). `null` exactly when codePath
   * doesn't match this codebase's `src/components/<Name>/<Name>.tsx`
   * convention — see `status`.
   */
  codeComponentId: string | null;
  /** The registry's authoritative code-side join key — components[].codePath, preserved verbatim. */
  codePath: string;
  storybook: {
    storyFile: string;
    title: string;
    /** Sorted for determinism — order in registry.json is not meaningful. */
    storyIds: string[];
  };
  /**
   * 'resolved' when codeComponentId was successfully derived; when
   * codePath doesn't match the expected convention this is
   * 'unresolved-code-path' and codeComponentId is null — an explicit,
   * observable failure rather than a silent fuzzy match onto some other
   * component.
   */
  status: ComponentIdentityStatus;
  /**
   * The registry's authored component dependency graph for this
   * component, preserved exactly as written (ids + relationship) — NOT
   * expanded transitively, and never used to invent or adjust identity.
   */
  dependsOnComponents: ComponentDependencyEdge[];
}

// ---------------------------------------------------------------------
// Token identity
// ---------------------------------------------------------------------

export type TokenIdentityStatus = 'resolved' | 'collision';

export interface TokenIdentityMapping {
  /** registry.json tokens[].tokenId, e.g. "radius-lg". */
  registryTokenId: string;
  /** registry.json tokens[].sourceType, preserved verbatim. */
  registrySourceType: 'figma-variable' | 'inferred';
  /**
   * tokens[].figmaName exactly as authored, collection-qualified, e.g.
   * "Alias/Border radius/lg". `null` for the one registry token with
   * sourceType "inferred" (font-weight-body), which has no Figma
   * variable at all — never fabricated.
   */
  figmaName: string | null;
  /**
   * figmaName with its known collection-prefix segment stripped — see
   * normalizeFigmaTokenName() in reconcile-crosswalk.ts for the exact
   * rule and the real prefixes it was derived from. `null` iff figmaName
   * is null.
   *
   * This is a NAME TRANSFORMATION ONLY. It does not assert that a
   * variable with this name currently exists anywhere — checking that
   * against a captured design-tool snapshot is optional validation, and
   * comparing values is reconciliation; neither happens here.
   */
  normalizedFigmaName: string | null;
  /**
   * The code-side identity — registry.json tokens[].cssVariable, e.g.
   * "--radius-lg". The registry has no separate "code token id"; the CSS
   * custom-property name IS the deterministic code-side join key (see
   * CodeSnapshot.tokenDefinitions[].cssVariable). Never derived from
   * cssVariable back to a registryTokenId — only ever forward.
   */
  cssVariable: string;
  /**
   * 'resolved' normally. 'collision' when this token's
   * normalizedFigmaName is shared with one or more other registry
   * tokens — see detectTokenNormalizationCollisions() and
   * `tokenNormalizationCollisions` below. A colliding entry's
   * normalizedFigmaName is still populated, never withheld or silently
   * reassigned to just one of the colliding tokens — callers MUST check
   * `status` before treating normalizedFigmaName as a safe join key.
   */
  status: TokenIdentityStatus;
  /**
   * registry.json tokens[].consumedBy, preserved exactly as authored
   * (sorted for determinism). NOT compared against any design-tool or
   * code-side consumption data here — see reconcile-crosswalk.ts header
   * for why that (the "subtree consumption" problem) is explicitly out
   * of scope for this stage.
   */
  consumedBy: string[];
}

/** One normalization collision: two or more registry tokens whose figmaName strips down to the same normalizedFigmaName. */
export interface TokenNormalizationCollision {
  normalizedFigmaName: string;
  /** Sorted, length >= 2. */
  registryTokenIds: string[];
}

// ---------------------------------------------------------------------
// Text-style identity (Stage 5E — additive). The registry tracks Figma
// text styles as their own entity kind (registry.json's textStyles[]),
// structurally separate from tokens[] and components[]. The crosswalk
// previously never read that array at all, which meant a text style like
// "Body/Medium" — genuinely registry-tracked — had no crosswalk entity to
// resolve against, and so was indistinguishable from a real gap when
// reconciliation's reverse pass walked every observed Figma variable name
// (see reconcile-compare.ts's Figma-variable reverse pass). This mapping
// closes exactly that: identity only, no comparison/status logic here,
// same as ComponentIdentityMapping/TokenIdentityMapping above.
// ---------------------------------------------------------------------

export interface TextStyleIdentityMapping {
  /** registry.json textStyles[].textStyleId, e.g. "body-medium". */
  registryTextStyleId: string;
  /** registry.json textStyles[].figmaName, preserved verbatim, e.g. "Body/Medium" — the join key against an observed Figma variable/text-style name. Never inferred, never re-derived. */
  figmaName: string;
  /** registry.json textStyles[].tokenIds, preserved verbatim — the atomic registry tokens this text style is composed of. Not expanded or resolved here. */
  tokenIds: string[];
  /** registry.json textStyles[].consumedBy, preserved exactly as authored (sorted for determinism). */
  consumedBy: string[];
}

// ---------------------------------------------------------------------
// The crosswalk itself
// ---------------------------------------------------------------------

export interface ReconciliationCrosswalk {
  schemaVersion: string;
  source: {
    registryPath: string;
    registryUpdatedOn: string;
  };
  /**
   * The collection-prefix segments this crosswalk treats as strippable
   * by normalizeFigmaTokenName, e.g. ["Alias", "Brand", "Mapped",
   * "Responsive"] — recorded on the output itself (not just hardcoded
   * silently in the function) so the rule a given crosswalk was built
   * with is always traceable from its own data.
   */
  knownFigmaCollectionPrefixes: string[];
  /** Sorted by registryComponentId. */
  components: ComponentIdentityMapping[];
  /** Sorted by registryTokenId. */
  tokens: TokenIdentityMapping[];
  /** Sorted by normalizedFigmaName. Empty when no two registry tokens normalize to the same name — as is currently true of the real registry. */
  tokenNormalizationCollisions: TokenNormalizationCollision[];
  /** Sorted by registryTextStyleId. */
  textStyles: TextStyleIdentityMapping[];
}

// ---------------------------------------------------------------------
// Reconciliation comparison records (Stage 5C — see reconcile-compare.ts).
//
// This section is a small additive extension to this file, made only
// because Stage 5C's task genuinely needs it: the crosswalk above (Stage
// 5B) has no notion of "did something change" or "do the two sides
// agree" at all — it is pure identity mapping. Nothing above this point
// was changed.
//
// One status was added beyond the 10 the Stage 5C task named
// ("figma-only-change" through "intentional-documented-deviation"):
// `registry-expectation-mismatch`. Justification: the task's own Button
// example (registry records variant property "Property 1"; the live
// Figma capture actually calls it "State") is explicitly required to
// "produce a concrete reconciliation difference" (see reconcile-compare.ts
// section 3), and the task separately requires distinguishing "current
// sides disagree" from the four temporal figma/code-changed statuses
// (see reconcile-compare.ts section 8's five distinguishable outcomes:
// Figma changed, Code changed, both changed, neither changed, current
// sides disagree). None of the 10 given statuses is that: the four
// `*-changed` statuses are all about drift from a *baseline*, and the
// Button case involves no baseline drift at all (Figma's own baseline
// and current captures agree with each other — only the registry's
// long-recorded expectation disagrees with both). Without this status,
// that required scenario would have no way to be represented; adding it
// was the smallest change that made it representable without overloading
// an existing status with a different meaning than its name implies.
// ---------------------------------------------------------------------

export type ReconciliationEntityType = 'component' | 'token';

export type ReconciliationStatus =
  | 'figma-only-change'
  | 'code-only-change'
  | 'both-changed-compatible'
  | 'both-changed-conflict'
  | 'registry-expectation-mismatch'
  | 'unmapped-figma-entity'
  | 'unmapped-code-entity'
  | 'deleted-figma-entity'
  | 'deleted-code-entity'
  | 'identity-mismatch'
  | 'intentional-documented-deviation'
  | 'out-of-scope-entity';

/**
 * `out-of-scope-entity` (Stage 5E — additive, one status) vs
 * `unmapped-code-entity` — these are NOT the same fact, and must never be
 * conflated:
 *
 * - `unmapped-code-entity` means the Code entity IS inside the
 *   reconciliation entity boundary (it's registry-tracked, or directly
 *   consumed by a registry-tracked component's own CSS) but has no
 *   registry mapping — a real, actionable gap.
 * - `out-of-scope-entity` means the Code entity is NEITHER registry-
 *   tracked NOR directly consumed by any registry-tracked component's
 *   own CSS — it is intentionally outside the reconciliation entity
 *   boundary altogether (see reconcile-compare.ts's consumedCssVariables
 *   helper). Per design-system/registry-schema.md's own documented
 *   policy ("Scope: only *consumed* tokens are catalogued"), the vast
 *   majority of `src/tokens/**\/*.css` is real, intentional design-token
 *   infrastructure (the full Brand/Alias palette, unused typography/
 *   spacing/radius steps) that this POC's registry deliberately never
 *   catalogues — reporting these as "unmapped" would misrepresent
 *   correct, intentional scope as a gap. `out-of-scope-entity` keeps
 *   them visible (never silently dropped — see reconcile-compare.ts's
 *   header on why every discovered entity gets a record) while
 *   correctly distinguishing "not applicable" from "missing".
 *
 * Currently only emitted for Code tokens (see reconcile-compare.ts's
 * Code-token reverse pass). Not applied to Figma entities: unlike Code's
 * `cssCustomPropertiesConsumed` (direct, per-component, grepped from each
 * component's own .css file), Figma's only analogous signal
 * (FigmaVariableEntry.consumedBy) is subtree-inclusive and therefore not
 * proof of direct, in-scope consumption — using it the same way would
 * reintroduce exactly the false-positive risk reconcile-compare.ts's
 * header already documents and refuses to rely on elsewhere.
 */

/** One side's (Figma's or Code's) observed state for a reconciliation record's field, at both its own current and baseline capture. */
export interface ReconciliationSideObservation {
  /** The value observed in that side's current capture, or `null` when the entity isn't observable there at all (see the record's `status`/`detail` for why — never conflated with "the value is actually null"). */
  current: unknown;
  /** The value observed in that side's baseline capture, or `null` when not observable there. */
  baseline: unknown;
  /** Whether `current` differs from `baseline` by deterministic equality. `null` when either side isn't observable, making the comparison not applicable rather than "unchanged". */
  changed: boolean | null;
}

export interface ReconciliationRecord {
  /** Deterministic hash of (entityType, entityId, field, status, the four source snapshot ids) — never a timestamp or random id; see reconcile-compare.ts header for why no timestamp is generated anywhere in this stage. */
  reconciliationId: string;
  entityType: ReconciliationEntityType;
  /**
   * The best available identifier for this record's subject: the
   * registry's own id (registryComponentId/registryTokenId) when the
   * crosswalk resolved one, otherwise the raw observed identifier
   * (a Figma node id, a Figma variable name, a CSS custom-property name,
   * or a CodeSnapshot componentId) for an entity the crosswalk could not
   * resolve to any registry mapping at all. Always present.
   */
  entityId: string;
  /** The registry's own identity for this entity, when the crosswalk resolved one; `null` only for a reverse-direction unmapped-*-entity record — see `entityId`. */
  registryId: string | null;
  /** What this record is about, e.g. "existence", "identity", "variantProperties", "value". */
  field: string;
  status: ReconciliationStatus;
  /** `null` when this record isn't about a Figma-side observation at all (e.g. a pure code-existence record, or an inferred/non-Figma-backed token). */
  figma: ReconciliationSideObservation | null;
  /** `null` when this record isn't about a Code-side observation at all. */
  code: ReconciliationSideObservation | null;
  /** The registry's own recorded/authored value for `field`, populated only for `registry-expectation-mismatch` records — `null` otherwise (never fabricated for statuses it doesn't apply to). */
  registryExpected: unknown;
  /**
   * One-hop affected components — this entity plus, for components, its
   * direct dependents (see impact.ts's oneHopUsedBy), or for tokens, the
   * registry's own recorded `consumedBy` (see impact.ts's
   * directTokenConsumers). Deliberately never the Figma-observed
   * consumedBy list, which is subtree-inclusive and therefore not
   * evidence of *direct* consumption — see reconcile-compare.ts's header
   * comment on Figma subtree consumption.
   */
  affectedComponents: string[];
  /** The four snapshot ids this record was computed from. No timestamp field exists on this type at all — see reconcile-compare.ts header. */
  sources: {
    figmaBaselineId: string;
    figmaCurrentId: string;
    codeBaselineId: string;
    codeCurrentId: string;
  };
  /** A short, deterministic, templated explanation of exactly which condition produced this record's `status` — restates a fact already computed above, never a judgment call. */
  detail: string;
}

// ---------------------------------------------------------------------
// Reconciliation runs (Stage 5D — see reconcile.ts). Another small,
// additive extension: Stage 5C's reconcileSnapshots() returns a plain
// ReconciliationRecord[], with no notion of a persisted "run" at all (no
// run id, no source-snapshot summary, no warnings). Stage 5D is purely an
// orchestration/persistence layer on top of that pure function — see
// reconcile.ts's header — and needs a wrapper shape to persist. Nothing
// above this point changed; ReconciliationRecord's meaning and the
// statuses in reconcile-compare.ts are untouched.
// ---------------------------------------------------------------------

/**
 * A deterministic, non-blocking observation about input freshness (see
 * reconcile.ts's computeFreshnessWarnings) — e.g. the registry, Figma,
 * and Code inputs were captured/updated on different calendar dates, or
 * the persisted Code baseline predates Stage 5A's tokenDefinitions field.
 * A warning never changes any ReconciliationRecord's status; it only
 * makes an already-true fact about the inputs visible.
 */
export interface ReconciliationWarning {
  /** Stable, kebab-case identifier for this warning's kind, e.g. "code-baseline-missing-token-definitions" — never free text, so callers can match on it. */
  code: string;
  /** Human-readable explanation, deterministically templated from the same facts `code` identifies — never a judgment about whether the staleness matters. */
  message: string;
}

export interface ReconciliationRun {
  schemaVersion: string;
  /**
   * Deterministic content hash (see reconcile.ts's computeRunId) of the
   * four source snapshot ids, the registry snapshot id, and the final
   * records array — NOT of `generatedAt` or anything timestamp-derived.
   * Two runs against byte-identical inputs always get the same runId,
   * regardless of when either ran.
   */
  runId: string;
  /** Wall-clock time this run executed, for human-readable history only — has no influence on `runId`, on any ReconciliationRecord, or on reconciliation results. */
  generatedAt: string;
  sources: {
    registrySnapshotId: string;
    registryUpdatedOn: string;
    figmaBaselineId: string;
    figmaCurrentId: string;
    codeBaselineId: string;
    codeCurrentId: string;
  };
  recordCount: number;
  /** Count of records with status "both-changed-conflict" specifically — the one status that most directly means "the two observed sides disagree after both changed". */
  conflictCount: number;
  /** Every ReconciliationStatus is always present as a key, even at 0 — a consumer never has to distinguish "absent" from "zero". */
  statusCounts: Record<ReconciliationStatus, number>;
  warnings: ReconciliationWarning[];
  records: ReconciliationRecord[];
}
