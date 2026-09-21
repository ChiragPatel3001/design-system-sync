/**
 * Types for the FigmaSnapshot — an independent view of the actual live
 * Figma design system, analogous to CodeSnapshot but built from Figma MCP
 * output instead of source files. See
 * design-system/sync/figma-snapshots/README.md for the full investigation
 * this schema is grounded in (what the available Figma MCP tools can and
 * cannot reliably retrieve).
 *
 * Two layers are modeled here:
 *  - RawFigmaCapture: the raw shape of actual Figma MCP tool responses,
 *    gathered by an agent with live MCP access (see figma-snapshot.ts's
 *    header comment for why this can't be gathered by a plain script).
 *  - FigmaSnapshot: the deterministic, canonicalized transform of a
 *    RawFigmaCapture — sorted, hashed, comparable.
 */

// ---------------------------------------------------------------------
// Raw capture shape (mirrors actual MCP tool output, not yet canonicalized)
// ---------------------------------------------------------------------

export interface RawFigmaVariantSymbol {
  nodeId: string;
  /** The symbol's name exactly as Figma reports it, e.g. "State=Default, Type=Default" — parsed into variantPropertyName/value pairs during the deterministic transform, not here. */
  name: string;
  width: number;
  height: number;
}

export interface RawFigmaComponentCapture {
  figmaNodeId: string;
  name: string;
  /** The get_metadata XML tag for this node: "frame" (component_set-like, has variant children) or "symbol" (a single component/instance, no variants). Reflects exactly what get_metadata reported — not Figma's internal COMPONENT/COMPONENT_SET/INSTANCE type, which the MCP's XML output does not expose directly. */
  nodeType: 'frame' | 'symbol';
  sectionId: string | null;
  /** Dimensions of this specific node as reported by get_metadata. For a component_set "frame", this is the container that visually holds every variant example side by side — NOT one variant's own size. Each variant's own size is in variantSymbols[]. */
  width: number | null;
  height: number | null;
  variantSymbols: RawFigmaVariantSymbol[];
  /** Flat {variableName: resolvedValueString} exactly as returned by get_variable_defs(figmaNodeId) — every variable bound anywhere in this node's subtree. Figma does not return variable IDs, alias chains, or collection/mode info through this tool — see README. */
  variableDefs: Record<string, string>;
}

export interface RawFigmaCapture {
  /** Self-documenting note carried in the JSON file itself (mirrors the registry mapping file's own `$schemaNote` convention) — this is a captured MCP snapshot, not a source of truth; re-reading this file does not re-contact Figma. See design-system/sync/figma-snapshots/README.md. */
  $note?: string;
  captureSchemaVersion: string;
  fileKey: string;
  fileName: string;
  /** When this capture was gathered — informational only, excluded from the FigmaSnapshot content hash. */
  capturedAt: string;
  capturedVia: string[];
  /** Pages returned by get_metadata called WITHOUT a nodeId. Empirically found to be unreliable — see README ("pages" capability classified as unavailable/partial). */
  pagesFromNoNodeIdListing: { id: string; name: string }[];
  /** Pages confirmed to exist by directly reading each node id with get_metadata. This is the reliable page list. */
  pagesConfirmedByDirectRead: { id: string; name: string }[];
  sections: Record<string, string>;
  components: RawFigmaComponentCapture[];
  /** get_variable_defs output for the text-styles specimen frame (the same node the original manifest used). */
  textStyleVariableDefs: Record<string, string>;
}

// ---------------------------------------------------------------------
// Deterministic FigmaSnapshot shape
// ---------------------------------------------------------------------

export interface FigmaVariantEntry {
  nodeId: string;
  /** Parsed from the symbol name, e.g. "State=Default, Type=Default" -> {State: "Default", Type: "Default"}. Empty object if the name didn't match the "Key=Value, Key=Value" pattern (never guessed). */
  properties: Record<string, string>;
  width: number;
  height: number;
}

export interface FigmaVariableBinding {
  name: string;
  /** The resolved value exactly as returned by get_variable_defs, as a string (Figma does not tag a type through this tool — see FigmaVariableEntry.inferredType for a separate, explicitly-labeled best-effort classification). */
  value: string;
}

export interface FigmaComponentEntry {
  figmaNodeId: string;
  name: string;
  /** "component_set" when 2+ variant symbols were found, "component" when exactly 0 or 1 (no meaningful variant axis) — derived, not a value Figma's MCP output tags directly. */
  kind: 'component_set' | 'component';
  sectionId: string | null;
  sectionName: string | null;
  /** The component_set container frame's own dimensions (see RawFigmaComponentCapture.width/height) — null for standalone components with no frame wrapper. */
  containerWidth: number | null;
  containerHeight: number | null;
  variantCount: number;
  /** Sorted union of variant property names across all variants, e.g. ["State", "Type"]. */
  variantPropertyNames: string[];
  /** Property name -> sorted unique values observed across variants, e.g. {"State": ["Default","Disabled","Focus","Hover"]}. */
  variantPropertyValues: Record<string, string[]>;
  /** Sorted by nodeId. */
  variants: FigmaVariantEntry[];
  /** Sorted by name. Every variable bound anywhere in this component's subtree. */
  variableBindings: FigmaVariableBinding[];
}

export type FigmaVariableInferredType = 'COLOR' | 'FLOAT' | 'STRING' | 'FONT_COMPOSITE';

export interface FigmaVariableEntry {
  name: string;
  value: string;
  /**
   * Best-effort classification from the shape of `value` (e.g. `#` + 6 hex
   * digits -> COLOR, a plain number -> FLOAT, a "Font(...)" descriptor ->
   * FONT_COMPOSITE, anything else -> STRING). This is INFERRED, not a type
   * Figma's MCP output tags directly — never conflate with the manifest's
   * `type` field, which came from the user-supplied Variables export, a
   * different and more authoritative source this stage does not have.
   */
  inferredType: FigmaVariableInferredType;
  /** Figma component node ids whose variableBindings included this name, sorted. */
  consumedBy: string[];
}

export interface FigmaTextStyleEntry {
  /** e.g. "Heading/H1", "Body/Medium", "Body/caption". */
  name: string;
  /** The original "Font(family: ..., style: ..., size: ..., weight: ..., lineHeight: ..., letterSpacing: ...)" descriptor string, preserved verbatim for traceability. */
  rawDescriptor: string;
  /** Parsed fields below — null if the descriptor didn't match the expected "Font(...)" grammar (never guessed). */
  fontFamilyRef: string | null;
  /** True when fontFamilyRef looks like a variable name (e.g. "Font Family/Body") rather than a literal font name (e.g. "Inter") — distinguishes a token-bound family from a hardcoded one, same distinction the manifest's F25 finding drew. */
  fontFamilyIsVariableRef: boolean;
  fontStyle: string | null;
  fontWeight: number | null;
  fontSizeRef: string | null;
  lineHeightRef: string | null;
  letterSpacing: number | null;
}

export interface FigmaSnapshot {
  schemaVersion: string;
  /** Deterministic content hash of {pages, components, variables, textStyles} — see figma-snapshot.ts computeFigmaSnapshotId. Excludes capturedAt/generatedAt and any other volatile metadata. */
  snapshotId: string;
  generatedAt: string;
  source: {
    fileKey: string;
    fileName: string;
    capturedAt: string;
  };
  /** The reliable page list (pagesConfirmedByDirectRead from the raw capture) — see README for why the no-nodeId listing is not used here. */
  pages: { id: string; name: string }[];
  components: FigmaComponentEntry[];
  variables: FigmaVariableEntry[];
  textStyles: FigmaTextStyleEntry[];
}
