/**
 * Deterministic source-targeting layer (Stage 6B). Pure function:
 *
 *   ReconciliationRecord + crosswalk + codeCurrent  ->  EditTarget | null
 *
 * This is deliberately STRICTER and fully independent of agent-policy.ts
 * — it re-derives its own answer from the same three inputs rather than
 * trusting a PolicyDecision, so a policy bug can never, by itself, cause
 * an edit to be misdirected. `agent-run.ts` requires BOTH a SAFE
 * PolicyDecision AND a non-null EditTarget before touching any file.
 *
 * THE TARGET IS THE SECURITY BOUNDARY: Claude is never given a file path
 * or declaration name to choose — it is only ever handed the single
 * EditTarget this function already resolved, and the edit engine
 * (agent-run.ts) refuses any proposal that doesn't match it exactly.
 *
 * Stage 6B supports exactly one target kind: a single CSS custom-
 * property VALUE declared exactly once in CodeSnapshot.tokenDefinitions,
 * traced from the registry via the crosswalk:
 *
 *   ReconciliationRecord.registryId
 *     -> crosswalk.tokens.find(registryTokenId === registryId)
 *     -> cssVariable
 *     -> codeCurrent.tokenDefinitions.find(cssVariable === cssVariable)
 *     -> { sourceFilePath, cssVariable, value }
 */
import type { ReconciliationCrosswalk, ReconciliationRecord } from './reconcile-types.ts';
import type { CodeSnapshot } from './code-snapshot-types.ts';
import type { EditTarget } from './agent-targeting-types.ts';

const VAR_ALIAS_RE = /^var\(/;

export function resolveEditTarget(input: {
  record: ReconciliationRecord;
  crosswalk: ReconciliationCrosswalk;
  codeCurrent: CodeSnapshot;
}): EditTarget | null {
  const { record, crosswalk, codeCurrent } = input;

  // Only token value-synchronization findings are representable as a
  // single CSS custom-property target in Stage 6B.
  if (record.entityType !== 'token') return null;
  if (record.field !== 'value') return null;
  if (record.registryId === null) return null;

  const mapping = crosswalk.tokens.find((t) => t.registryTokenId === record.registryId);
  if (!mapping) return null;
  if (mapping.status !== 'resolved') return null; // unresolved-collision mapping — never a safe join key

  const matches = codeCurrent.tokenDefinitions.filter((t) => t.cssVariable === mapping.cssVariable);
  if (matches.length !== 1) return null; // zero (nothing to target) or multiple (ambiguous) — both refuse

  const definition = matches[0];
  if (VAR_ALIAS_RE.test(definition.value.trim())) return null; // alias-chain resolution unsupported

  return {
    filePath: definition.sourceFilePath,
    kind: 'css-custom-property-value',
    declarationIdentifier: definition.cssVariable,
    currentValue: definition.value,
  };
}
