/**
 * Deterministic policy engine (Stage 6B). Pure function:
 *
 *   ReconciliationRecord + crosswalk + codeCurrent  ->  PolicyDecision
 *
 * No Claude call, no arbitrary source-file inspection (only the already-
 * captured, already-structured CodeSnapshot/crosswalk data Stage 5 itself
 * produces), no mutation, no filesystem I/O. This module answers "what is
 * Claude allowed to do", never "is this a good idea" — severity/intent
 * judgment stays out of scope here exactly as it stays out of scope in
 * reconcile-compare.ts itself.
 *
 * Only ONE status can ever reach SAFE in Stage 6B: `figma-only-change`,
 * and only for a token-value finding that satisfies every one of the 9
 * conditions below. Every other status is a fixed REVIEW/BLOCKED/
 * NOT_APPLICABLE verdict, independent of any evidence — see the table in
 * classifyRecord()'s switch.
 */
import type { ReconciliationCrosswalk, ReconciliationRecord } from './reconcile-types.ts';
import type { CodeSnapshot } from './code-snapshot-types.ts';
import type { PolicyDecision, PolicyVerdict } from './agent-policy-types.ts';

const VALIDATION_LEVELS_FOR_SAFE_TOKEN_VALUE = [1, 2, 3, 4, 5, 6];

function decision(
  record: ReconciliationRecord,
  verdict: PolicyVerdict,
  reason: string,
  requiredEvidence: string[],
  requiredValidationLevels: number[],
): PolicyDecision {
  return {
    reconciliationId: record.reconciliationId,
    status: record.status,
    verdict,
    reason,
    requiredEvidence,
    requiredValidationLevels,
    requiresHumanApproval: verdict === 'REVIEW' || verdict === 'BLOCKED',
  };
}

const VAR_ALIAS_RE = /^var\(/;

/**
 * Evaluates the 9 SAFE subconditions for a `figma-only-change` record, in
 * order. Returns the first failing condition's evidence label and reason
 * (deterministic — always the same failure is reported first for the same
 * input), or `null` (with the full list of satisfied evidence) if every
 * condition holds.
 */
function evaluateFigmaOnlyChangeSafety(
  record: ReconciliationRecord,
  crosswalk: ReconciliationCrosswalk,
  codeCurrent: CodeSnapshot,
): { satisfied: true; evidence: string[] } | { satisfied: false; reason: string; evidence: string[] } {
  const evidence: string[] = [];

  // 1. The entity is registry-mapped.
  if (record.registryId === null) {
    return { satisfied: false, reason: 'registryId is null — the entity is not registry-mapped (a reverse-pass/unmapped finding).', evidence };
  }
  evidence.push('entity is registry-mapped (registryId is non-null)');

  // 8. Token-value synchronization only, never an identity/name change (checked early: everything below assumes a token entity).
  if (record.entityType !== 'token' || record.field !== 'value') {
    return {
      satisfied: false,
      reason: `finding is entityType "${record.entityType}" / field "${record.field}" — Stage 6B only supports token value-synchronization findings (entityType "token", field "value"), never identity/name/structural changes.`,
      evidence,
    };
  }
  evidence.push('finding is a token value-synchronization change (entityType "token", field "value")');

  // 2 & 9. Crosswalk mapping resolves unambiguously (not collision/unresolved).
  const mapping = crosswalk.tokens.find((t) => t.registryTokenId === record.registryId);
  if (!mapping) {
    return { satisfied: false, reason: `no crosswalk token mapping found for registryTokenId "${record.registryId}".`, evidence };
  }
  if (mapping.status !== 'resolved') {
    return {
      satisfied: false,
      reason: `crosswalk token mapping for "${record.registryId}" has status "${mapping.status}", not "resolved" — an ambiguous/collision mapping is never a safe join key.`,
      evidence,
    };
  }
  evidence.push(`crosswalk token mapping for "${record.registryId}" is unambiguous (status "resolved")`);

  // 3, 4, 7. Resolves to exactly one code declaration (one file, one CSS custom property).
  const matches = codeCurrent.tokenDefinitions.filter((t) => t.cssVariable === mapping.cssVariable);
  if (matches.length === 0) {
    return { satisfied: false, reason: `no CodeSnapshot.tokenDefinitions entry exists for cssVariable "${mapping.cssVariable}".`, evidence };
  }
  if (matches.length > 1) {
    return {
      satisfied: false,
      reason: `${matches.length} CodeSnapshot.tokenDefinitions entries exist for cssVariable "${mapping.cssVariable}" — the edit cannot be constrained to a single declaration.`,
      evidence,
    };
  }
  const definition = matches[0];
  evidence.push(`exactly one code declaration exists for "${mapping.cssVariable}" (in ${definition.sourceFilePath})`);

  // 5 & 6. Raw literal, not a var() alias.
  if (VAR_ALIAS_RE.test(definition.value.trim())) {
    return {
      satisfied: false,
      reason: `code declaration "${mapping.cssVariable}: ${definition.value};" is a var() alias, not a raw literal — alias-chain resolution is out of scope for Stage 6B.`,
      evidence,
    };
  }
  evidence.push(`code declaration value "${definition.value}" is a raw literal, not a var() alias`);

  return { satisfied: true, evidence };
}

/**
 * Pure classification. Takes the full three-input context every SAFE
 * subcondition needs — crosswalk and codeCurrent are already-captured,
 * already-structured Stage 5 data, not "arbitrary source file inspection".
 */
export function classifyRecord(input: {
  record: ReconciliationRecord;
  crosswalk: ReconciliationCrosswalk;
  codeCurrent: CodeSnapshot;
}): PolicyDecision {
  const { record, crosswalk, codeCurrent } = input;

  switch (record.status) {
    case 'both-changed-compatible':
      return decision(record, 'NOT_APPLICABLE', 'Already converged. No action required.', [], []);

    case 'figma-only-change': {
      const result = evaluateFigmaOnlyChangeSafety(record, crosswalk, codeCurrent);
      if (result.satisfied) {
        return decision(
          record,
          'SAFE',
          'All 9 SAFE conditions satisfied: registry-mapped, unambiguous crosswalk mapping, single code declaration, raw literal value, token-value synchronization only.',
          result.evidence,
          VALIDATION_LEVELS_FOR_SAFE_TOKEN_VALUE,
        );
      }
      return decision(record, 'REVIEW', `Not SAFE: ${result.reason}`, result.evidence, []);
    }

    case 'code-only-change':
      return decision(
        record,
        'REVIEW',
        'Code changed without a corresponding Figma change; intent cannot be inferred. No automatic edit.',
        [],
        [],
      );

    case 'both-changed-conflict':
      return decision(record, 'BLOCKED', 'Both sides changed and disagree — a real or possibly-false conflict either way; no automatic edit.', [], []);

    case 'registry-expectation-mismatch':
      return decision(record, 'BLOCKED', 'Registry is human-owned; the registry is never automatically corrected.', [], []);

    case 'unmapped-figma-entity':
      return decision(
        record,
        'BLOCKED',
        'Ownership cannot be inferred from subtree-inclusive Figma variable capture; never treated as evidence.',
        [],
        [],
      );

    case 'unmapped-code-entity':
      return decision(
        record,
        'REVIEW',
        'Whether to add registry coverage or remove the code declaration is a human/product decision, not inferable.',
        [],
        [],
      );

    case 'out-of-scope-entity':
      return decision(record, 'NOT_APPLICABLE', 'Intentionally outside the reconciliation entity boundary (Stage 5E). No action.', [], []);

    case 'identity-mismatch':
      return decision(record, 'REVIEW', 'A broken registry codePath or a real missing/renamed file — requires human judgment to distinguish.', [], []);

    case 'deleted-figma-entity':
      return decision(record, 'REVIEW', 'Could be a real deletion or a capture/baseline artifact — requires human judgment to distinguish.', [], []);

    case 'deleted-code-entity':
      return decision(record, 'REVIEW', 'Could be a real deletion or a capture/baseline artifact — requires human judgment to distinguish.', [], []);

    case 'intentional-documented-deviation':
      return decision(record, 'NOT_APPLICABLE', 'Already deliberately excused via registry.json\'s unresolved[]. No action.', [], []);

    default: {
      // Exhaustiveness guard: if reconcile-types.ts ever adds a status,
      // this must fail loudly (a type error at compile time) rather than
      // silently defaulting to an unsafe verdict.
      const exhaustive: never = record.status;
      throw new Error(`agent-policy: no policy defined for reconciliation status "${exhaustive}".`);
    }
  }
}

/** Convenience: classify every record in a run, in the same deterministic order reconcileSnapshots() already sorted them in. */
export function classifyRecords(input: {
  records: ReconciliationRecord[];
  crosswalk: ReconciliationCrosswalk;
  codeCurrent: CodeSnapshot;
}): PolicyDecision[] {
  return input.records.map((record) => classifyRecord({ record, crosswalk: input.crosswalk, codeCurrent: input.codeCurrent }));
}
