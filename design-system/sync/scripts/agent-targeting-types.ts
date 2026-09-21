/**
 * Types for the deterministic source-targeting layer (Stage 6B). See
 * agent-targeting.ts's header for why this is the actual security
 * boundary of the agent: Claude never chooses a file or declaration —
 * it only ever receives one already-resolved `EditTarget`.
 */

export type EditTargetKind = 'css-custom-property-value' | 'ts-prop-type' | 'ts-variant-union';

export interface EditTarget {
  /** Relative to the repository (or fixture) root — exactly one file. */
  filePath: string;
  kind: EditTargetKind;
  /** The exact declaration identity within that file (a CSS custom-property name, a prop name, a variant union type name — Stage 6B only ever produces 'css-custom-property-value' targets; the other two kinds are reserved for a future stage). */
  declarationIdentifier: string;
  /** The exact current value, read from the already-captured CodeSnapshot — never re-read from disk at targeting time (agent-run.ts re-confirms it against the live file immediately before editing). */
  currentValue: string;
}
