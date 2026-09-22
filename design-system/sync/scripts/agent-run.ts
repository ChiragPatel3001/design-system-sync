/**
 * `npm run sync:agent -- <reconciliationId>` — Stage 6B: the first working
 * version of the Claude sync agent's safety architecture (Stage 6A's
 * design). This module NEVER decides whether an arbitrary change is safe
 * — that was already decided, deterministically, by agent-policy.ts
 * (verdict) and agent-targeting.ts (exact file+declaration), both of
 * which run BEFORE anything here touches a file. Claude (or, in Stage 6B,
 * a constrained mock reasoner — see Reasoner below) only ever decides HOW
 * to fill in one already-authorized value change.
 *
 *   Stage 5 evidence (reconcile.ts's latest run)
 *         |
 *   deterministic policy    (agent-policy.ts)      <- no file touched
 *         |
 *   deterministic targeting (agent-targeting.ts)   <- no file touched
 *         |
 *   Claude reasoning         (Reasoner)             <- proposes; cannot choose file/declaration
 *         |
 *   narrowly constrained edit (applyEditToFile)     <- one file, one declaration, verified
 *         |
 *   validation levels 1-4                            <- typecheck / targeted test / build / storybook
 *         |
 *   re-snapshot (sync:code-check) + re-reconcile (sync:reconcile)
 *         |
 *   deterministic verification (verifyResolution)    <- compares actual records, not counts
 *         |
 *   immutable audit record (design-system/sync/agent-history/)
 *
 * Never recaptures Figma, never rebuilds a FigmaSnapshot, never refreshes
 * any baseline, never edits more than one file, never edits more than one
 * declaration, never lets the reasoner choose a path.
 *
 * Production (`main()`) shells out to the EXISTING CLI commands
 * (`npm run sync:code-check`, `npm run sync:reconcile`) for the
 * re-snapshot/re-reconcile steps, exactly as Stage 6A's report specifies
 * ("use the existing architecture") — those commands cannot be imported
 * directly for this purpose: unlike reconcile.ts, code-check.ts has no
 * path-injection support and unconditionally runs its own `main()` at
 * import time (verified before writing this file). Tests therefore inject
 * alternative implementations of the same two steps that call the
 * already-exported, already-pure functions those CLIs themselves use
 * (`buildCodeSnapshot`/`writeCodeSnapshotFile`, and reconcile.ts's own
 * `loadReconciliationInputs`/`buildReconciliationRun`/
 * `persistReconciliationRun`) against temp-fixture paths — never against
 * the real repository.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REGISTRY_PATH, MANIFEST_PATH } from './paths.ts';
import { FIGMA_BASELINE_PATH, FIGMA_CURRENT_PATH } from './figma-paths.ts';
import { CODE_BASELINE_PATH, CODE_CURRENT_PATH } from './code-paths.ts';
import { RECONCILIATION_RECORDS_DIR, RECONCILIATION_LATEST_PATH } from './reconcile-paths.ts';
import { loadReconciliationInputs, type ReconcileInputPaths, type ReconciliationOutputPaths } from './reconcile.ts';
import { classifyRecord } from './agent-policy.ts';
import type { PolicyDecision } from './agent-policy-types.ts';
import { resolveEditTarget } from './agent-targeting.ts';
import type { EditTarget } from './agent-targeting-types.ts';
import type { ReconciliationRecord, ReconciliationRun } from './reconcile-types.ts';
import { createAnthropicClaudeClient, createClaudeReasoner } from './agent-claude-reasoner.ts';
import { promoteCodeBaselineForToken, createProductionPromoteCodeBaselinePaths } from './code-baseline-promote.ts';
import { promoteFigmaBaselineForVariable, createProductionPromoteFigmaBaselinePaths } from './figma-baseline-promote.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

export const AGENT_HISTORY_DIR = path.join(ROOT, 'design-system/sync/agent-history');
export const AGENT_HISTORY_RECORDS_DIR = path.join(AGENT_HISTORY_DIR, 'records');
export const AGENT_HISTORY_LATEST_PATH = path.join(AGENT_HISTORY_DIR, 'latest.json');

export class AgentError extends Error {}

// =======================================================================
// Reasoning boundary. Claude receives ONLY a ReasonerContext (the
// finding, the policy decision, the already-resolved EditTarget, the
// target file's content, and its sibling declarations) and must return a
// ProposedEdit. It cannot name a different file or declaration — the
// deterministic layer below validates the proposal against `editTarget`
// and refuses anything that doesn't match exactly (validateProposedEdit).
// =======================================================================

export interface SiblingDeclaration {
  identifier: string;
  value: string;
}

export interface ReasonerContext {
  record: ReconciliationRecord;
  policyDecision: PolicyDecision;
  editTarget: EditTarget;
  fileContent: string;
  siblingDeclarations: SiblingDeclaration[];
  /**
   * Present ONLY for an explicit human-directed resolution (Part 18) of a
   * token-level `both-changed-conflict` finding toward Figma — tells the
   * reasoner which side a human has already decided is authoritative, so
   * it isn't misled by `policyDecision` (which, correctly and honestly,
   * still reads BLOCKED — that fact is never altered, only the gate that
   * would otherwise have refused to reach the reasoner at all). Never set
   * for a normal SAFE run, and never for the `sourceOfTruth: 'code'`
   * direction, which never reaches the reasoner at all (see
   * runAgentForFinding's own comment on why).
   */
  humanDirected?: { sourceOfTruth: 'figma' };
}

export interface ProposedEdit {
  filePath: string;
  declarationIdentifier: string;
  before: string;
  after: string;
  rationale: string;
}

/**
 * `ProposedEdit | Promise<ProposedEdit>` — widened for Stage 6C so a real
 * Claude call (inherently async: it's a network request) satisfies this
 * type without any other change to this file's architecture. Every
 * existing sync reasoner (createMockReasoner, notImplementedReasoner)
 * still satisfies this type completely unchanged — a plain value is
 * assignable wherever `T | Promise<T>` is expected.
 */
export type Reasoner = (context: ReasonerContext) => ProposedEdit | Promise<ProposedEdit>;

/**
 * A deterministic stand-in for a real Claude reasoning call. Stage 6B
 * does not wire up a live model — this exists so the full lifecycle can
 * be proven end-to-end without depending on an external API, and so a
 * later stage can swap in a real reasoner without touching anything
 * else in this file (the Reasoner type is the only contract it must
 * satisfy).
 */
export function createMockReasoner(after: string, rationale = 'mock reasoner: deterministic proposed value for Stage 6B proof-of-concept'): Reasoner {
  return (context: ReasonerContext): ProposedEdit => ({
    filePath: context.editTarget.filePath,
    declarationIdentifier: context.editTarget.declarationIdentifier,
    before: context.editTarget.currentValue,
    after,
    rationale,
  });
}

/** The reasoner used by `main()` in real production runs — Stage 6B has no live reasoning call wired up. This only matters if a SAFE finding is ever actually reached (none exist in the real repository today); it fails loudly rather than silently guessing. */
export const notImplementedReasoner: Reasoner = () => {
  throw new AgentError(
    'No live Claude reasoning adapter is configured in Stage 6B. A SAFE finding was reached, but this build has no reasoner to propose an edit — pass an explicit Reasoner (see createMockReasoner) or wait for a future stage to wire a real one.',
  );
};

/** Regex-extracts every other `--name: value;` declaration in the same file, for the reasoner's local-convention context (e.g. sibling `px`-suffixed values) — same boundary-character convention code-snapshot.ts's own token-definition regex uses. */
export function extractSiblingDeclarations(fileContent: string, excludeIdentifier: string): SiblingDeclaration[] {
  const re = /(?:^|[;{\s])(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);/gm;
  const siblings: SiblingDeclaration[] = [];
  for (const m of fileContent.matchAll(re)) {
    if (m[1] === excludeIdentifier) continue;
    siblings.push({ identifier: m[1], value: m[2].trim() });
  }
  return siblings;
}

// =======================================================================
// Deterministic proposal validation — the last check before any file is
// touched. A proposal that doesn't match the already-resolved EditTarget
// exactly is rejected, never partially honored.
// =======================================================================

export function validateProposedEdit(proposed: ProposedEdit, target: EditTarget): { valid: boolean; reason?: string } {
  if (proposed.filePath !== target.filePath) {
    return { valid: false, reason: `proposed filePath "${proposed.filePath}" does not match the authorized target "${target.filePath}".` };
  }
  if (proposed.declarationIdentifier !== target.declarationIdentifier) {
    return {
      valid: false,
      reason: `proposed declarationIdentifier "${proposed.declarationIdentifier}" does not match the authorized target "${target.declarationIdentifier}".`,
    };
  }
  if (proposed.before !== target.currentValue) {
    return { valid: false, reason: `proposed "before" value "${proposed.before}" does not match the target's currentValue "${target.currentValue}".` };
  }
  if (proposed.after === proposed.before) {
    return { valid: false, reason: 'proposed edit is a no-op (before === after).' };
  }
  return { valid: true };
}

// =======================================================================
// Part 4 — the narrow, deterministic edit engine. The ONLY supported
// mutation in Stage 6B: replace the value of exactly one CSS custom-
// property declaration in exactly one file. Never a broad search-and-
// replace: the expected current declaration must exist verbatim, exactly
// once, before anything is written; after writing, the file is re-read
// and re-verified before the operation is reported successful.
// =======================================================================

export interface ApplyEditResult {
  applied: boolean;
  reason?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Same function used both to apply an edit (expectedCurrentValue = target.currentValue, newValue = proposed.after) and to revert one (expectedCurrentValue = proposed.after, newValue = proposed.before) — see agent-run.ts's revertEdit(). */
export function applyEditToFile(filePath: string, declarationIdentifier: string, expectedCurrentValue: string, newValue: string): ApplyEditResult {
  if (!existsSync(filePath)) {
    return { applied: false, reason: `target file does not exist: ${filePath}` };
  }
  const original = readFileSync(filePath, 'utf8');

  const escapedIdentifier = escapeRegExp(declarationIdentifier);
  const escapedExpected = escapeRegExp(expectedCurrentValue);
  const declarationRe = new RegExp(`(^|[;{\\s])(${escapedIdentifier})(\\s*:\\s*)${escapedExpected}(\\s*;)`, 'gm');

  const matches = [...original.matchAll(declarationRe)];
  if (matches.length === 0) {
    return {
      applied: false,
      reason: `expected declaration "${declarationIdentifier}: ${expectedCurrentValue};" was not found in ${filePath} — refusing to edit (the file may have changed since targeting).`,
    };
  }
  if (matches.length > 1) {
    return {
      applied: false,
      reason: `found ${matches.length} matching declarations for "${declarationIdentifier}: ${expectedCurrentValue};" in ${filePath} — refusing an ambiguous edit.`,
    };
  }

  const updated = original.replace(
    declarationRe,
    (_whole: string, boundary: string, name: string, colon: string, terminator: string) => `${boundary}${name}${colon}${newValue}${terminator}`,
  );
  writeFileSync(filePath, updated, 'utf8');

  // Post-write verification: exactly one declaration for this identifier now exists, with the new value.
  const after = readFileSync(filePath, 'utf8');
  const identifierRe = new RegExp(`(?:^|[;{\\s])${escapedIdentifier}\\s*:\\s*([^;]+);`, 'gm');
  const afterMatches = [...after.matchAll(identifierRe)];
  if (afterMatches.length !== 1 || afterMatches[0][1].trim() !== newValue.trim()) {
    writeFileSync(filePath, original, 'utf8'); // restore — never leave an unexplained partial edit
    return { applied: false, reason: `post-write verification failed for "${declarationIdentifier}" in ${filePath} — file restored to its original content.` };
  }

  return { applied: true };
}

function revertEdit(filePath: string, declarationIdentifier: string, appliedValue: string, originalValue: string): ApplyEditResult {
  return applyEditToFile(filePath, declarationIdentifier, appliedValue, originalValue);
}

// =======================================================================
// Validation orchestration (levels 1-6). Levels 1-4 are supplied by the
// caller (real subprocess commands in production; fixture-appropriate
// proxies in tests — see agent-run.test.ts). Levels 5-6 are the
// re-snapshot/re-reconcile steps, also caller-supplied for the same
// reason (code-check.ts/reconcile.ts's CLIs cannot target a temp fixture
// — see this module's header).
// =======================================================================

export interface ValidationStepResult {
  level: number;
  command: string;
  passed: boolean;
  output?: string;
}

export type ValidationRunner = () => ValidationStepResult;

export interface AgentRunDeps {
  /** Absolute root the EditTarget's filePath is relative to (the real repo ROOT in production; a temp fixture root in tests). */
  rootDir: string;
  reconciliationInputPaths: ReconcileInputPaths;
  reconciliationOutputPaths: ReconciliationOutputPaths;
  agentHistoryPaths: { recordsDir: string; latestPath: string };
  reasoner: Reasoner;
  runLevel1: ValidationRunner;
  runLevel2: ValidationRunner;
  runLevel3: ValidationRunner;
  runLevel4: ValidationRunner;
  /** Level 5 — refreshes the Code current snapshot from source (never the baseline). */
  refreshCodeSnapshot: () => void;
  /** Level 6 — re-runs reconciliation and returns the newly persisted run. */
  reRunReconciliation: (generatedAt: string) => ReconciliationRun;
  /**
   * Called ONLY after `verifyResolution()` has already confirmed a
   * successful edit resolved its targeted finding — promotes exactly
   * the one CSS custom-property value this run changed in the CODE
   * baseline (never the Figma baseline, never any other declaration).
   * See code-baseline-promote.ts. May throw `CodeBaselinePromoteError`;
   * `runAgentForFinding` treats that as non-fatal to an already-verified
   * successful run (see its own comment at the call site).
   */
  promoteCodeBaseline: (cssVariable: string, previousValue: string, newValue: string) => void;
  /**
   * Called ONLY after `promoteCodeBaseline` has already succeeded for a
   * `figma-only-change` SAFE apply — promotes exactly the one Figma
   * variable this run's finding was about in the FIGMA baseline (never
   * any other variable, never `components[]`/`pages`/`textStyles`). See
   * figma-baseline-promote.ts.
   */
  promoteFigmaBaseline: (variableName: string, previousValue: string, newValue: string) => void;
}

function runShellValidation(level: number, label: string, command: string, args: string[], cwd: string): ValidationStepResult {
  try {
    // Windows resolves `npx`/`npm` to a `.cmd` shim, which execFileSync
    // cannot spawn directly without shell involvement (throws ENOENT
    // before the command ever runs) — shell: true on win32 only, same
    // command/args/cwd/output handling otherwise.
    const output = execFileSync(command, args, { cwd, stdio: 'pipe', encoding: 'utf8', shell: process.platform === 'win32' });
    return { level, command: label, passed: true, output };
  } catch (err) {
    const output = err instanceof Error ? err.message : String(err);
    return { level, command: label, passed: false, output };
  }
}

// =======================================================================
// Audit record (Part 11).
// =======================================================================

/**
 * `applied-verification-incomplete` — the edit was applied and passed
 * every PRE-apply check (levels 1-4: typecheck/targeted test/build/
 * storybook), but the POST-apply refresh/reconcile (levels 5-6) failed
 * before it could confirm resolution or promote any baseline — e.g. a
 * live Figma MCP rate limit. Deliberately distinct from both `applied`
 * (would overclaim verification that never completed) and
 * `failed-verification` (would wrongly suggest the edit itself was
 * reverted/rejected, and would wrongly block a future retry via
 * hasPriorFailedAttempt — see that function's own comment). See
 * runAgentForFinding's Level 5/6 handling.
 */
export type AgentOutcome = 'applied' | 'no-safe-action' | 'blocked' | 'failed-validation' | 'failed-verification' | 'applied-verification-incomplete';

export interface AgentAuditRecord {
  auditId: string;
  generatedAt: string;
  reconciliationRunId: string;
  reconciliationId: string;
  findingBefore: ReconciliationRecord;
  policyDecision: PolicyDecision;
  editTarget: EditTarget | null;
  filesInspected: string[];
  filesModified: string[];
  change: { before: string; after: string } | null;
  validation: ValidationStepResult[];
  reconciliationAfterRunId: string | null;
  findingAfter: 'resolved' | 'unresolved' | 'new-findings-introduced';
  outcome: AgentOutcome;
  stopReason: string;
  /**
   * True iff this invocation was an explicit human re-authorization of a
   * finding with a recorded prior failed attempt (see
   * `runAgentForFinding`'s `options.humanReauthorized` and
   * `hasPriorFailedAttempt`, both otherwise completely unchanged) —
   * false for every normal run (CLI, first-time dashboard click, or any
   * finding with no prior failure at all). Always present so the audit
   * trail makes the distinction explicit rather than leaving it
   * inferable only by cross-referencing other records.
   */
  humanReauthorized: boolean;
  /**
   * True iff this run's outcome was 'applied' AND the one CODE
   * baseline entry this run changed was successfully promoted to the
   * newly-applied value (see code-baseline-promote.ts). False for
   * every non-'applied' outcome, and also false — never fatal to an
   * already-verified-successful run — if promotion itself failed (the
   * failure reason, if any, is folded into `stopReason` on that
   * specific finalize() call; the run's own outcome stays 'applied').
   */
  codeBaselinePromoted: boolean;
  /**
   * True iff this run's outcome was 'applied' AND the finding was a
   * `figma-only-change` SAFE apply AND the one FIGMA baseline variable
   * this run's finding was about was successfully promoted to Figma's
   * own current value (see figma-baseline-promote.ts). False for every
   * other outcome/status, and also false — never fatal — if promotion
   * itself failed (folded into `stopReason`, same discipline as
   * `codeBaselinePromoted`).
   */
  figmaBaselinePromoted: boolean;
  /**
   * True iff this run was an explicit human-directed resolution of a
   * token-level `both-changed-conflict` finding (see
   * `RunAgentForFindingOptions.humanDirectedSourceOfTruth`) — false for
   * every normal run (CLI, first-time dashboard click, reauthorized
   * retry of a SAFE finding). Always present so the audit trail makes
   * explicit WHY a run against a finding whose `policyDecision.verdict`
   * still (correctly, honestly) reads BLOCKED was nonetheless acted on.
   */
  humanDirected: boolean;
  /**
   * The human's own explicit choice of which side is authoritative, for
   * a `humanDirected` run — `null` for every other run. Never inferred;
   * always exactly what the human passed in (see
   * `RunAgentForFindingOptions`).
   */
  sourceOfTruth: 'figma' | 'code' | null;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Deterministic — never includes `generatedAt`, matching every other content-hash id in this project. */
export function computeAuditId(record: Omit<AgentAuditRecord, 'auditId' | 'generatedAt'>): string {
  const canonical = JSON.stringify(sortKeysDeep(record));
  return sha256(canonical).slice(0, 16);
}

export interface AgentHistoryOutputPaths {
  recordsDir: string;
  latestPath: string;
}

/** Mirrors persistReconciliationRun()'s own convention exactly: immutable per-run file, never overwritten; latest.json a full mutable copy. */
export function persistAuditRecord(record: AgentAuditRecord, outputPaths: AgentHistoryOutputPaths): { recordPath: string } {
  const serialized = JSON.stringify(record, null, 2) + '\n';
  const fileSafeStamp = record.generatedAt.replace(/[:.]/g, '-');
  const recordPath = path.join(outputPaths.recordsDir, `${fileSafeStamp}_${record.auditId}.json`);

  if (existsSync(recordPath)) {
    throw new AgentError(`Refusing to overwrite existing immutable agent audit record at ${recordPath}.`);
  }

  mkdirSync(outputPaths.recordsDir, { recursive: true });
  writeFileSync(recordPath, serialized, 'utf8');

  mkdirSync(path.dirname(outputPaths.latestPath), { recursive: true });
  writeFileSync(outputPaths.latestPath, serialized, 'utf8');

  return { recordPath };
}

/**
 * Part 10 — loop prevention: true iff a prior audit record for this
 * exact reconciliationId exists with a failure outcome
 * (`failed-validation` or `failed-verification` — an explicit allowlist,
 * not "anything other than applied"). `applied-verification-incomplete`
 * is deliberately NOT in this list: that outcome means the edit itself
 * succeeded and passed every pre-apply check — only the post-apply
 * refresh/reconcile (an unrelated external dependency, e.g. a live
 * Figma MCP rate limit) didn't complete. Treating it as a failure here
 * would wrongly block a legitimate future retry over a problem that has
 * nothing to do with whether the edit itself was safe or correct.
 */
export function hasPriorFailedAttempt(recordsDir: string, reconciliationId: string): boolean {
  if (!existsSync(recordsDir)) return false;
  for (const fileName of readdirSync(recordsDir)) {
    if (!fileName.endsWith('.json')) continue;
    let record: AgentAuditRecord;
    try {
      record = JSON.parse(readFileSync(path.join(recordsDir, fileName), 'utf8')) as AgentAuditRecord;
    } catch {
      continue; // not a well-formed audit record — ignore rather than crash the safety check
    }
    if (record.reconciliationId === reconciliationId && (record.outcome === 'failed-validation' || record.outcome === 'failed-verification')) {
      return true;
    }
  }
  return false;
}

// =======================================================================
// Part 9 — reconciliation verification. Compares ACTUAL records (by
// entityType+entityId+field — never by reconciliationId, which embeds
// the four source snapshot ids and therefore changes for EVERY record on
// EVERY run, including completely unrelated ones), never record counts.
// =======================================================================

function findingKey(record: ReconciliationRecord): string {
  return `${record.entityType}\u0000${record.entityId}\u0000${record.field}`;
}

export interface VerificationResult {
  resolved: boolean;
  newFindings: ReconciliationRecord[];
  unrelatedMutations: ReconciliationRecord[];
}

/**
 * A finding at the SAME (entityType, entityId, field) key is "resolved"
 * if it's either absent from the new run, or has settled on one of these
 * — never a hardcoded assumption that "fixed" means "no record at all".
 * In particular: the agent never refreshes a baseline (forbidden), so a
 * genuinely successful edit to a `figma-only-change` token will, on the
 * VERY NEXT reconciliation, correctly show `both-changed-compatible`
 * (code now differs from its own untouched baseline too, and the two
 * current values agree) rather than silence — that is the architecture
 * working as designed, not a failure to resolve anything.
 */
const RESOLVED_OUTCOME_STATUSES = new Set(['both-changed-compatible']);

// =======================================================================
// Stage 6E — narrow, deterministic, VERIFICATION-ONLY normalization.
//
// reconcile-compare.ts (Stage 5, unmodified, never touched here) compares
// a token's Figma current value against its Code current value by exact
// string equality — see that file's own header comment on why: Figma's
// captured value is always the fully RESOLVED number ("24"), while
// CodeSnapshot.tokenDefinitions captures the LITERAL, unresolved CSS
// source text ("24px"). For a plain length token (no alias, no
// expression), that means a genuinely correct fix still comes back as
// `both-changed-conflict`, not `both-changed-compatible` — an honest
// limitation of Stage 5's representation, not a bug (see Stage 6D's real
// end-to-end proof, which hit exactly this).
//
// This function answers a DIFFERENT, narrower question than
// reconcile-compare.ts's own comparison: not "do these two values match
// in general", but "did THIS SPECIFIC EDIT, to THIS SPECIFIC DECLARATION,
// actually achieve what it set out to achieve" — using ONLY evidence this
// exact declaration itself already provides. It is deliberately NOT a
// general CSS/Figma value parser:
//
//   - It only recognizes one shape: a bare `<number>px` CSS literal
//     against Figma's bare resolved number.
//   - The px convention must already be PROVEN by this exact
//     declaration's OWN prior value (`priorCodeValue` — the value on disk
//     before this edit, i.e. `targetedRecord.code.current`). A value is
//     never assumed to be a length just because it looks numeric — see
//     `font-weight-body` (code value "400", no "px"), which this
//     correctly leaves alone: `priorCodeValue` "400" doesn't match
//     PLAIN_PX_LENGTH_RE, so normalization never even attempts to apply.
//   - It never fires for a `var(...)` alias, a color, a composite/
//     shorthand value, or anything with more than a bare number+"px" —
//     any of those fail PLAIN_PX_LENGTH_RE and fall through unresolved.
//
// This ONLY affects verifyResolution()'s `resolved` boolean for the ONE
// record this run's edit targeted. It never touches reconcile-compare.ts,
// never changes a persisted ReconciliationRecord's `status`, never
// affects any other record's resolved/unrelated-mutation classification,
// and never runs unless the targeted record's status is exactly
// `both-changed-conflict` for an `entityType: 'token'`, `field: 'value'`
// record — the only shape `resolveEditTarget`'s own
// `css-custom-property-value` kind ever produces (see
// agent-targeting.ts), so this can never be reached by a component
// record, an existence record, or anything else.
// =======================================================================

const PLAIN_PX_LENGTH_RE = /^(-?\d+(?:\.\d+)?)px$/;
const PLAIN_NUMBER_RE = /^-?\d+(?:\.\d+)?$/;

/**
 * True iff `figmaValue` (Figma's resolved, unitless number as a string)
 * and `codeValue` (Code's current raw CSS literal) express the SAME px
 * length — and only when `priorCodeValue` (this exact declaration's OWN
 * value before the edit) already proves the px convention applies here.
 * See the block comment above for the full rationale and boundaries.
 */
export function isEquivalentLengthValue(figmaValue: unknown, codeValue: unknown, priorCodeValue: unknown): boolean {
  if (typeof figmaValue !== 'string' || typeof codeValue !== 'string' || typeof priorCodeValue !== 'string') return false;

  // The px convention must already be established BY THIS EXACT
  // DECLARATION's own prior value — never inferred from sibling
  // declarations, a file-wide guess, or a global "numbers are lengths"
  // assumption.
  if (!PLAIN_PX_LENGTH_RE.test(priorCodeValue.trim())) return false;

  const codeMatch = PLAIN_PX_LENGTH_RE.exec(codeValue.trim());
  if (!codeMatch) return false;

  const figmaTrimmed = figmaValue.trim();
  if (!PLAIN_NUMBER_RE.test(figmaTrimmed)) return false;

  return Number(codeMatch[1]) === Number(figmaTrimmed);
}

export function verifyResolution(targetedRecord: ReconciliationRecord, beforeRun: ReconciliationRun, afterRun: ReconciliationRun): VerificationResult {
  const targetKey = findingKey(targetedRecord);
  const beforeByKey = new Map(beforeRun.records.map((r) => [findingKey(r), r]));
  const afterByKey = new Map(afterRun.records.map((r) => [findingKey(r), r]));

  const afterTargetRecord = afterByKey.get(targetKey);
  let resolved = !afterTargetRecord || RESOLVED_OUTCOME_STATUSES.has(afterTargetRecord.status);

  // Stage 6E fallback: only for the exact record this run targeted, only
  // for a token value-synchronization record, and only when Stage 5's own
  // exact-string comparison called it a conflict — never for any other
  // record, never for any other status, never changing what
  // reconcile-compare.ts itself produced.
  if (
    !resolved &&
    afterTargetRecord !== undefined &&
    afterTargetRecord.status === 'both-changed-conflict' &&
    afterTargetRecord.entityType === 'token' &&
    afterTargetRecord.field === 'value'
  ) {
    resolved = isEquivalentLengthValue(afterTargetRecord.figma?.current, afterTargetRecord.code?.current, targetedRecord.code?.current ?? null);
  }

  const newFindings: ReconciliationRecord[] = [];
  const unrelatedMutations: ReconciliationRecord[] = [];

  for (const [key, afterRecord] of afterByKey) {
    if (key === targetKey) continue;
    const beforeRecord = beforeByKey.get(key);
    if (!beforeRecord) {
      newFindings.push(afterRecord);
    } else if (beforeRecord.status !== afterRecord.status || JSON.stringify(beforeRecord.detail) !== JSON.stringify(afterRecord.detail)) {
      unrelatedMutations.push(afterRecord);
    }
  }
  for (const [key, beforeRecord] of beforeByKey) {
    if (key === targetKey) continue;
    if (!afterByKey.has(key)) unrelatedMutations.push(beforeRecord);
  }

  return { resolved, newFindings, unrelatedMutations };
}

// =======================================================================
// Core orchestration — one invocation, one finding, at most one edit.
// =======================================================================

function readReconciliationRun(latestPath: string): ReconciliationRun {
  if (!existsSync(latestPath)) {
    throw new AgentError(`No reconciliation run found at ${latestPath}. Run \`npm run sync:reconcile\` first.`);
  }
  return JSON.parse(readFileSync(latestPath, 'utf8')) as ReconciliationRun;
}

function finalize(
  fields: Omit<AgentAuditRecord, 'auditId' | 'generatedAt'>,
  generatedAt: string,
  historyPaths: AgentHistoryOutputPaths,
): AgentAuditRecord {
  const auditId = computeAuditId(fields);
  const record: AgentAuditRecord = { ...fields, auditId, generatedAt };
  persistAuditRecord(record, historyPaths);
  return record;
}

export interface RunAgentForFindingOptions {
  /**
   * Explicit human re-authorization of a finding with a recorded prior
   * failed attempt — the ONLY thing this does is let execution proceed
   * past the loop-prevention early-return below when
   * `hasPriorFailedAttempt` is true; `hasPriorFailedAttempt` itself, and
   * every check after it (policy re-classification, targeting, the
   * reasoner boundary, deterministic proposal validation, validation
   * levels, verification, rollback), are completely unaffected and run
   * exactly as they do for any other SAFE finding. In particular this is
   * NOT a generic "skip safety" flag: if the freshly-reclassified policy
   * verdict is REVIEW or BLOCKED, or targeting fails, the run is refused
   * exactly as before — reauthorization only ever un-blocks one prior
   * loop-prevention refusal, nothing else. Defaults to false, preserving
   * every existing call site (the CLI, and every existing test)
   * unchanged.
   */
  humanReauthorized?: boolean;
  /**
   * Present ONLY for an explicit human-directed resolution of a
   * token-level `both-changed-conflict` finding (Part 18) — the human's
   * own choice of which side is authoritative, passed in explicitly
   * rather than inferred. The ONLY thing this does is let execution
   * proceed past the policy-verdict SAFE gate for THIS one entry point,
   * for a finding that is STRUCTURALLY VALIDATED (immediately, by
   * throwing `AgentError` otherwise) to be `entityType: 'token'` and
   * `status: 'both-changed-conflict'` — this can never be used to
   * bypass the gate for a `registry-expectation-mismatch` or any
   * component-level finding (e.g. "button"), which have no single-value
   * editTarget and are explicitly out of scope. Every other check (loop
   * prevention via `hasPriorFailedAttempt`, targeting via
   * `resolveEditTarget`, deterministic proposal validation, validation
   * levels, verification) is completely unaffected — in particular loop
   * prevention is NOT bypassed by this option; a previously-failed
   * human-directed attempt still requires `humanReauthorized: true` the
   * same as any other retry. `'figma'` reuses the SAME reasoner ->
   * validate -> apply -> verify -> promote-both-baselines pipeline
   * proven for SAFE findings (see the reasoner's own `humanDirected`
   * context). `'code'` never reaches the reasoner or the edit engine at
   * all — the code side already holds the chosen value, so there is
   * nothing to propose (and `validateProposedEdit`'s own no-op rule,
   * unmodified, would correctly refuse a same-value edit); it instead
   * promotes both baselines directly to their own current values, which
   * is what actually resolves the conflict (see runAgentForFinding's
   * own comment at that branch). Defaults to undefined, preserving
   * every existing call site unchanged.
   */
  humanDirectedSourceOfTruth?: 'figma' | 'code';
}

export async function runAgentForFinding(
  reconciliationId: string,
  deps: AgentRunDeps,
  generatedAt: string,
  options: RunAgentForFindingOptions = {},
): Promise<AgentAuditRecord> {
  const humanReauthorized = options.humanReauthorized ?? false;

  const beforeRun = readReconciliationRun(deps.reconciliationOutputPaths.latestPath);
  const record = beforeRun.records.find((r) => r.reconciliationId === reconciliationId);
  if (!record) {
    throw new AgentError(`No reconciliation record with id "${reconciliationId}" exists in the latest run (${beforeRun.runId}).`);
  }

  // Part 18 — human-directed resolution: STRUCTURALLY scoped to
  // token-level both-changed-conflict findings only, checked immediately
  // and unconditionally (never trusting the client further than this) —
  // see RunAgentForFindingOptions.humanDirectedSourceOfTruth's own
  // comment for why this can never reach a registry-expectation-mismatch
  // or a component-level finding.
  const humanDirectedSourceOfTruth = options.humanDirectedSourceOfTruth ?? null;
  const isHumanDirected = humanDirectedSourceOfTruth !== null;
  if (isHumanDirected && (record.entityType !== 'token' || record.status !== 'both-changed-conflict')) {
    throw new AgentError(
      `Human-directed resolution is only supported for token-level both-changed-conflict findings (got entityType="${record.entityType}", status="${record.status}").`,
    );
  }

  const commonFields = {
    reconciliationRunId: beforeRun.runId,
    reconciliationId,
    findingBefore: record,
    humanReauthorized,
    codeBaselinePromoted: false,
    figmaBaselinePromoted: false,
    humanDirected: isHumanDirected,
    sourceOfTruth: humanDirectedSourceOfTruth,
  };

  // Part 10 — loop prevention: refuse automatic re-execution of a
  // previously-failed finding, UNLESS a human has explicitly
  // re-authorized this exact invocation (see RunAgentForFindingOptions
  // above). hasPriorFailedAttempt() itself is unmodified.
  if (hasPriorFailedAttempt(deps.agentHistoryPaths.recordsDir, reconciliationId) && !humanReauthorized) {
    const placeholderPolicy: PolicyDecision = {
      reconciliationId,
      status: record.status,
      verdict: 'BLOCKED',
      reason: 'refused: a previous attempt at this exact finding already failed',
      requiredEvidence: [],
      requiredValidationLevels: [],
      requiresHumanApproval: true,
    };
    return finalize(
      {
        ...commonFields,
        policyDecision: placeholderPolicy,
        editTarget: null,
        filesInspected: [],
        filesModified: [],
        change: null,
        validation: [],
        reconciliationAfterRunId: null,
        findingAfter: 'unresolved',
        outcome: 'no-safe-action',
        stopReason: 'A previous automatic attempt at this exact finding already failed. Automatic re-execution is refused; a human must re-authorize it explicitly (no override mechanism exists yet).',
      },
      generatedAt,
      deps.agentHistoryPaths,
    );
  }

  // Reload fresh evidence and confirm it's not stale relative to the loaded run.
  const freshInput = loadReconciliationInputs(deps.reconciliationInputPaths);
  if (
    freshInput.figmaBaseline.snapshotId !== beforeRun.sources.figmaBaselineId ||
    freshInput.figmaCurrent.snapshotId !== beforeRun.sources.figmaCurrentId ||
    freshInput.codeBaseline.snapshotId !== beforeRun.sources.codeBaselineId ||
    freshInput.codeCurrent.snapshotId !== beforeRun.sources.codeCurrentId
  ) {
    throw new AgentError('The loaded reconciliation run is stale relative to the current on-disk snapshots. Run `npm run sync:reconcile` again before invoking the agent.');
  }

  const policyDecision = classifyRecord({ record, crosswalk: freshInput.crosswalk, codeCurrent: freshInput.codeCurrent });

  if (policyDecision.verdict !== 'SAFE' && !isHumanDirected) {
    const outcome: AgentOutcome = policyDecision.verdict === 'BLOCKED' ? 'blocked' : 'no-safe-action';
    return finalize(
      {
        ...commonFields,
        policyDecision,
        editTarget: null,
        filesInspected: [],
        filesModified: [],
        change: null,
        validation: [],
        reconciliationAfterRunId: null,
        findingAfter: 'unresolved',
        outcome,
        stopReason: policyDecision.reason,
      },
      generatedAt,
      deps.agentHistoryPaths,
    );
  }

  const editTarget = resolveEditTarget({ record, crosswalk: freshInput.crosswalk, codeCurrent: freshInput.codeCurrent });
  if (!editTarget) {
    return finalize(
      {
        ...commonFields,
        policyDecision,
        editTarget: null,
        filesInspected: [],
        filesModified: [],
        change: null,
        validation: [],
        reconciliationAfterRunId: null,
        findingAfter: 'unresolved',
        outcome: 'no-safe-action',
        stopReason: isHumanDirected
          ? 'Human-directed resolution was requested, but targeting (the stricter, final gate) could not resolve a unique single-file/single-declaration edit target. Refusing to act.'
          : 'Policy verdict was SAFE, but targeting (the stricter, final gate) could not resolve a unique single-file/single-declaration edit target. Refusing to act.',
      },
      generatedAt,
      deps.agentHistoryPaths,
    );
  }

  // Part 18 — human-directed resolution toward CODE: the human has
  // reviewed this both-changed-conflict and decided the code's current
  // value is correct; Figma's divergent current value is not to be
  // adopted. There is nothing to EDIT (code already holds the chosen
  // value) — `validateProposedEdit`'s own no-op rule (unmodified) would
  // correctly refuse a before===after edit, so this branch never invokes
  // the reasoner or the edit engine at all. Instead it promotes BOTH
  // baselines directly to their own current values — the same promotion
  // functions the SAFE/figma-directed path uses — which is what actually
  // resolves the conflict: reconcile-compare.ts (unmodified) compares
  // each side only against its OWN baseline, so once neither side
  // differs from its own (now-promoted) baseline, no record is produced
  // for this entity at all. Unlike the file-edit path, a promotion
  // failure here is NOT bookkeeping-only for the CODE baseline — since no
  // edit happened, a failed code-baseline promotion means this action
  // accomplished nothing and must be reported as a failure. The FIGMA
  // baseline promotion keeps the SAME bookkeeping-only discipline the
  // SAFE path already established (a partial promotion is a safe,
  // honestly-reportable state, not a corrupted one).
  if (isHumanDirected && humanDirectedSourceOfTruth === 'code') {
    if (record.code === null || typeof record.code.baseline !== 'string' || typeof record.code.current !== 'string') {
      return finalize(
        {
          ...commonFields,
          policyDecision,
          editTarget,
          filesInspected: [],
          filesModified: [],
          change: null,
          validation: [],
          reconciliationAfterRunId: null,
          findingAfter: 'unresolved',
          outcome: 'failed-verification',
          stopReason: 'Human-directed resolution toward "code" requires a string code.baseline/code.current observation, which this finding does not have — refusing.',
        },
        generatedAt,
        deps.agentHistoryPaths,
      );
    }
    if (record.figma === null || typeof record.figma.baseline !== 'string' || typeof record.figma.current !== 'string') {
      return finalize(
        {
          ...commonFields,
          policyDecision,
          editTarget,
          filesInspected: [],
          filesModified: [],
          change: null,
          validation: [],
          reconciliationAfterRunId: null,
          findingAfter: 'unresolved',
          outcome: 'failed-verification',
          stopReason: 'Human-directed resolution toward "code" requires a string figma.baseline/figma.current observation, which this finding does not have — refusing.',
        },
        generatedAt,
        deps.agentHistoryPaths,
      );
    }

    let codeBaselinePromoted = false;
    try {
      deps.promoteCodeBaseline(editTarget.declarationIdentifier, record.code.baseline, record.code.current);
      codeBaselinePromoted = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return finalize(
        {
          ...commonFields,
          policyDecision,
          editTarget,
          filesInspected: [],
          filesModified: [],
          change: null,
          validation: [],
          reconciliationAfterRunId: null,
          findingAfter: 'unresolved',
          outcome: 'failed-verification',
          stopReason: `Human-directed resolution toward "code" could not promote the CODE baseline, so nothing was resolved: ${message}`,
        },
        generatedAt,
        deps.agentHistoryPaths,
      );
    }

    let figmaBaselinePromoted = false;
    let promotionNote = '';
    try {
      const figmaMapping = freshInput.crosswalk.tokens.find((t) => t.registryTokenId === record.registryId);
      const variableName = figmaMapping && figmaMapping.status === 'resolved' ? figmaMapping.normalizedFigmaName : null;
      if (!variableName) {
        throw new AgentError(`No resolved Figma variable name is available for registry token "${record.registryId}" — refusing to promote the Figma baseline.`);
      }
      deps.promoteFigmaBaseline(variableName, record.figma.baseline, record.figma.current);
      figmaBaselinePromoted = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      promotionNote = ` (Figma baseline promotion did not complete: ${message})`;
    }

    const finalAfterRun = deps.reRunReconciliation(new Date().toISOString());
    const verification = verifyResolution(record, beforeRun, finalAfterRun);
    const cleanlyResolved = verification.resolved && verification.newFindings.length === 0 && verification.unrelatedMutations.length === 0;

    return finalize(
      {
        ...commonFields,
        policyDecision,
        editTarget,
        filesInspected: [],
        filesModified: [],
        change: null,
        validation: [],
        reconciliationAfterRunId: finalAfterRun.runId,
        findingAfter: cleanlyResolved ? 'resolved' : verification.newFindings.length > 0 ? 'new-findings-introduced' : 'unresolved',
        outcome: cleanlyResolved ? 'applied' : 'failed-verification',
        codeBaselinePromoted,
        figmaBaselinePromoted,
        stopReason: cleanlyResolved
          ? `Completed successfully: human-directed resolution toward "code" — both baselines were promoted to their own current values, and re-reconciliation confirms the conflict no longer appears.${promotionNote}`
          : `Baselines were promoted, but re-reconciliation did not confirm a clean resolution (resolved=${verification.resolved}, newFindings=${verification.newFindings.length}, unrelatedMutations=${verification.unrelatedMutations.length}). No file was changed by this action, and baseline promotions are never reverted (reverting would reintroduce a known-stale baseline value) — investigate manually.${promotionNote}`,
      },
      generatedAt,
      deps.agentHistoryPaths,
    );
  }

  const absoluteFilePath = path.join(deps.rootDir, editTarget.filePath);
  const fileContent = readFileSync(absoluteFilePath, 'utf8');
  const siblingDeclarations = extractSiblingDeclarations(fileContent, editTarget.declarationIdentifier);
  const filesInspected = [editTarget.filePath];

  // Reaching this line with isHumanDirected true means humanDirectedSourceOfTruth === 'figma'
  // ('code' already returned above) — pass that through so the reasoner
  // isn't misled by policyDecision still (correctly) reading BLOCKED.
  const context: ReasonerContext = {
    record,
    policyDecision,
    editTarget,
    fileContent,
    siblingDeclarations,
    ...(isHumanDirected ? { humanDirected: { sourceOfTruth: 'figma' as const } } : {}),
  };
  let proposed: ProposedEdit;
  try {
    proposed = await deps.reasoner(context);
  } catch (err) {
    // A reasoner may legitimately refuse (e.g. the Claude adapter's
    // "uncertain -> refuse" path) or fail (malformed response, network
    // error). Either way this is a normal, audited outcome — never an
    // unhandled exception — so the audit trail always records that
    // reasoning was attempted and why it didn't produce an edit.
    const reason = err instanceof Error ? err.message : String(err);
    return finalize(
      {
        ...commonFields,
        policyDecision,
        editTarget,
        filesInspected,
        filesModified: [],
        change: null,
        validation: [],
        reconciliationAfterRunId: null,
        findingAfter: 'unresolved',
        outcome: 'no-safe-action',
        stopReason: `Reasoner did not produce a proposal: ${reason}`,
      },
      generatedAt,
      deps.agentHistoryPaths,
    );
  }

  const proposalCheck = validateProposedEdit(proposed, editTarget);
  if (!proposalCheck.valid) {
    return finalize(
      {
        ...commonFields,
        policyDecision,
        editTarget,
        filesInspected,
        filesModified: [],
        change: null,
        validation: [],
        reconciliationAfterRunId: null,
        findingAfter: 'unresolved',
        outcome: 'blocked',
        stopReason: `Reasoner proposal rejected by the deterministic validator: ${proposalCheck.reason}`,
      },
      generatedAt,
      deps.agentHistoryPaths,
    );
  }

  const applyResult = applyEditToFile(absoluteFilePath, editTarget.declarationIdentifier, editTarget.currentValue, proposed.after);
  if (!applyResult.applied) {
    return finalize(
      {
        ...commonFields,
        policyDecision,
        editTarget,
        filesInspected,
        filesModified: [],
        change: null,
        validation: [],
        reconciliationAfterRunId: null,
        findingAfter: 'unresolved',
        outcome: 'failed-validation',
        stopReason: `Edit could not be safely applied: ${applyResult.reason}`,
      },
      generatedAt,
      deps.agentHistoryPaths,
    );
  }

  const filesModified = [editTarget.filePath];
  const change = { before: proposed.before, after: proposed.after };

  // Validation levels 1-4.
  const validation: ValidationStepResult[] = [];
  for (const runLevel of [deps.runLevel1, deps.runLevel2, deps.runLevel3, deps.runLevel4]) {
    const result = runLevel();
    validation.push(result);
    if (!result.passed) {
      revertEdit(absoluteFilePath, editTarget.declarationIdentifier, proposed.after, proposed.before);
      return finalize(
        {
          ...commonFields,
          policyDecision,
          editTarget,
          filesInspected,
          filesModified: [],
          change: null,
          validation,
          reconciliationAfterRunId: null,
          findingAfter: 'unresolved',
          outcome: 'failed-validation',
          stopReason: `Validation level ${result.level} failed (${result.command}). The edit was reverted.`,
        },
        generatedAt,
        deps.agentHistoryPaths,
      );
    }
  }

  // Levels 5-6 (re-snapshot, re-reconcile) are wrapped separately from
  // levels 1-4: by this point the edit has ALREADY been applied and has
  // ALREADY independently passed every pre-apply check (typecheck,
  // targeted test, build, storybook) — it is real and correct regardless
  // of what happens next. Levels 5-6 depend on external, unrelated
  // machinery (in production, a live Figma MCP refresh as part of
  // `npm run sync:reconcile`) that can fail for reasons that have
  // nothing to do with the edit's own safety or correctness — e.g. a
  // rate limit (this happened for real during Phase 3 real-repo
  // verification: the edit was left on disk, correct and validated, but
  // with no audit record at all, since an uncaught exception here used
  // to propagate straight out of this function). If either throws, the
  // edit is deliberately NOT reverted (reverting an already-validated
  // fix over an unrelated downstream failure would be wrong), and a
  // complete audit record is still written — honestly labeled
  // `applied-verification-incomplete`, never silently dropped, never
  // misrepresented as a normal `applied` or as a `failed-*` outcome
  // (which would also wrongly block a future retry — see
  // hasPriorFailedAttempt's own comment).
  const finalizeVerificationIncomplete = (level: number, command: string, message: string): AgentAuditRecord => {
    validation.push({ level, command, passed: false, output: message });
    return finalize(
      {
        ...commonFields,
        policyDecision,
        editTarget,
        filesInspected,
        filesModified,
        change,
        validation,
        reconciliationAfterRunId: null,
        findingAfter: 'unresolved',
        outcome: 'applied-verification-incomplete',
        codeBaselinePromoted: false,
        figmaBaselinePromoted: false,
        stopReason: `The edit was applied and passed all pre-apply validation (levels 1-4), but post-apply verification (${command}) failed before it could confirm resolution or promote any baseline: ${message}. The edit was NOT reverted — it was already independently validated. Once the underlying issue is resolved, run reconciliation and re-invoke the agent on this finding to complete verification and baseline promotion.`,
      },
      generatedAt,
      deps.agentHistoryPaths,
    );
  };

  // Level 5 — re-snapshot (current only, never a baseline).
  try {
    deps.refreshCodeSnapshot();
    validation.push({ level: 5, command: 'sync:code-check (refresh current CodeSnapshot)', passed: true });
  } catch (err) {
    return finalizeVerificationIncomplete(5, 'sync:code-check (refresh current CodeSnapshot)', err instanceof Error ? err.message : String(err));
  }

  // Level 6 — re-reconcile.
  let afterRun: ReconciliationRun;
  try {
    afterRun = deps.reRunReconciliation(generatedAt);
    validation.push({ level: 6, command: 'sync:reconcile', passed: true });
  } catch (err) {
    return finalizeVerificationIncomplete(6, 'sync:reconcile', err instanceof Error ? err.message : String(err));
  }

  const verification = verifyResolution(record, beforeRun, afterRun);
  if (!verification.resolved || verification.newFindings.length > 0 || verification.unrelatedMutations.length > 0) {
    revertEdit(absoluteFilePath, editTarget.declarationIdentifier, proposed.after, proposed.before);
    const findingAfter: AgentAuditRecord['findingAfter'] = !verification.resolved
      ? 'unresolved'
      : verification.newFindings.length > 0
        ? 'new-findings-introduced'
        : 'unresolved';
    return finalize(
      {
        ...commonFields,
        policyDecision,
        editTarget,
        filesInspected,
        filesModified: [],
        change: null,
        validation,
        reconciliationAfterRunId: afterRun.runId,
        findingAfter,
        outcome: 'failed-verification',
        stopReason: `Re-reconciliation did not confirm a clean resolution (resolved=${verification.resolved}, newFindings=${verification.newFindings.length}, unrelatedMutations=${verification.unrelatedMutations.length}). The edit was reverted.`,
      },
      generatedAt,
      deps.agentHistoryPaths,
    );
  }

  // Baseline promotion (Phase 1) — runs ONLY after verifyResolution() has
  // already independently confirmed a clean resolution above. Promotes
  // exactly the one CODE baseline entry this run changed, then
  // re-reconciles once more so the persisted Stage 5 record reflects the
  // promoted baseline. A promotion (or post-promotion reconcile) failure
  // is bookkeeping-only and must never roll back or fail an
  // already-verified-successful edit — it is folded into stopReason and
  // codeBaselinePromoted stays false.
  //
  // The expected PRIOR baseline value is `record.code?.baseline` — the
  // baseline this run actually started with — NOT `proposed.before`
  // (editTarget.currentValue, i.e. code's CURRENT value). For a
  // figma-only-change SAFE apply those two are always equal (code hasn't
  // drifted, so its current IS its baseline), but for a human-directed
  // resolution of a both-changed-conflict (Part 18) code has already
  // drifted from its own baseline BEFORE this run's edit — using
  // `proposed.before` there would ask promoteCodeBaselineForToken to
  // verify against the wrong prior value and spuriously fail every time.
  let finalAfterRun = afterRun;
  let codeBaselinePromoted = false;
  let figmaBaselinePromoted = false;
  let promotionNote = '';
  try {
    if (typeof record.code?.baseline !== 'string') {
      throw new AgentError('The targeted finding\'s code.baseline observation is missing or non-string — refusing to promote the code baseline.');
    }
    deps.promoteCodeBaseline(editTarget.declarationIdentifier, record.code.baseline, proposed.after);
    codeBaselinePromoted = true;
    finalAfterRun = deps.reRunReconciliation(new Date().toISOString());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    promotionNote += ` (Code baseline promotion did not complete: ${message})`;
  }

  // Figma baseline promotion — scoped to a figma-only-change SAFE apply,
  // OR a human-directed resolution of a both-changed-conflict toward
  // 'figma' (Part 18; the 'code' direction promotes both baselines in
  // its own dedicated branch above and never reaches this line). Never
  // for code-only-change/REVIEW. Without this, code and Figma being
  // genuinely converged still leaves Figma's OWN baseline stale relative
  // to Figma's OWN current value, so the entity would resurface as a
  // fresh SAFE figma-only-change on every subsequent reconcile forever.
  // Runs only once the code baseline promotion above has already
  // succeeded, so both sides promote together or not at all.
  if (codeBaselinePromoted && (record.status === 'figma-only-change' || (isHumanDirected && humanDirectedSourceOfTruth === 'figma'))) {
    try {
      const figmaMapping = freshInput.crosswalk.tokens.find((t) => t.registryTokenId === record.registryId);
      const variableName = figmaMapping && figmaMapping.status === 'resolved' ? figmaMapping.normalizedFigmaName : null;
      if (!variableName) {
        throw new AgentError(`No resolved Figma variable name is available for registry token "${record.registryId}" — refusing to promote the Figma baseline.`);
      }
      if (record.figma === null || typeof record.figma.baseline !== 'string' || typeof record.figma.current !== 'string') {
        throw new AgentError('The targeted finding\'s Figma observation is missing or non-string — refusing to promote the Figma baseline.');
      }
      deps.promoteFigmaBaseline(variableName, record.figma.baseline, record.figma.current);
      figmaBaselinePromoted = true;
      finalAfterRun = deps.reRunReconciliation(new Date().toISOString());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      promotionNote += ` (Figma baseline promotion did not complete: ${message})`;
    }
  }

  return finalize(
    {
      ...commonFields,
      policyDecision,
      editTarget,
      filesInspected,
      filesModified,
      change,
      validation,
      reconciliationAfterRunId: finalAfterRun.runId,
      findingAfter: 'resolved',
      outcome: 'applied',
      codeBaselinePromoted,
      figmaBaselinePromoted,
      stopReason: `Completed successfully: the targeted finding resolved, no new findings, no unrelated mutations.${promotionNote}`,
    },
    generatedAt,
    deps.agentHistoryPaths,
  );
}

// =======================================================================
// CLI entry point.
// =======================================================================

/** The real repository's reconciliation input paths — factored out so both `main()` and the Stage 6F dashboard's server-side API adapter (dashboard-loader.ts / dashboard-agent-handler.ts) construct the SAME production wiring instead of a second, drifting copy of it. Never used by tests, which always pass their own fixture paths. */
export function createProductionReconciliationInputPaths(): ReconcileInputPaths {
  return {
    registryPath: REGISTRY_PATH,
    manifestPath: MANIFEST_PATH,
    figmaBaselinePath: FIGMA_BASELINE_PATH,
    figmaCurrentPath: FIGMA_CURRENT_PATH,
    codeBaselinePath: CODE_BASELINE_PATH,
    codeCurrentPath: CODE_CURRENT_PATH,
  };
}

export function createProductionReconciliationOutputPaths(): ReconciliationOutputPaths {
  return { recordsDir: RECONCILIATION_RECORDS_DIR, latestPath: RECONCILIATION_LATEST_PATH };
}

/**
 * The exact `AgentRunDeps` production uses against the real repository —
 * real shell validation commands, real `sync:code-check`/`sync:reconcile`
 * CLIs, the real Claude reasoning adapter. `main()` below and the Stage 6F
 * dashboard's `/api/agent/run` handler both call this SAME function
 * (rather than each hand-assembling their own `AgentRunDeps`), so there is
 * exactly one place that decides what "running the real agent" means.
 */
export function createProductionAgentRunDeps(): AgentRunDeps {
  return {
    rootDir: ROOT,
    reconciliationInputPaths: createProductionReconciliationInputPaths(),
    reconciliationOutputPaths: createProductionReconciliationOutputPaths(),
    agentHistoryPaths: { recordsDir: AGENT_HISTORY_RECORDS_DIR, latestPath: AGENT_HISTORY_LATEST_PATH },
    // Constructed lazily, inside the reasoner call itself, so a missing
    // ANTHROPIC_API_KEY only matters if a SAFE finding is actually
    // reached (mirrors notImplementedReasoner's own "only matters if
    // reached" precedent) — and, since runAgentForFinding now wraps the
    // reasoner call in a try/catch, a missing key becomes a normal,
    // audited "no-safe-action" outcome rather than an uncaught crash.
    reasoner: (context) => createClaudeReasoner(createAnthropicClaudeClient())(context),
    runLevel1: () => runShellValidation(1, 'npx tsc --noEmit', 'npx', ['tsc', '--noEmit'], ROOT),
    runLevel2: () => runShellValidation(2, 'npm run sync:code-test', 'npm', ['run', 'sync:code-test'], ROOT),
    runLevel3: () => runShellValidation(3, 'npm run build', 'npm', ['run', 'build'], ROOT),
    runLevel4: () => runShellValidation(4, 'npm run build-storybook', 'npm', ['run', 'build-storybook'], ROOT),
    refreshCodeSnapshot: () => {
      execFileSync('npm', ['run', 'sync:code-check'], { cwd: ROOT, stdio: 'pipe', shell: process.platform === 'win32' });
    },
    reRunReconciliation: () => {
      execFileSync('npm', ['run', 'sync:reconcile'], { cwd: ROOT, stdio: 'pipe', shell: process.platform === 'win32' });
      // Per Part 8: never infer success from exit code for reconciliation —
      // read the persisted JSON it just wrote.
      return readReconciliationRun(RECONCILIATION_LATEST_PATH);
    },
    promoteCodeBaseline: (cssVariable, previousValue, newValue) => {
      promoteCodeBaselineForToken(createProductionPromoteCodeBaselinePaths(), cssVariable, previousValue, newValue);
    },
    promoteFigmaBaseline: (variableName, previousValue, newValue) => {
      promoteFigmaBaselineForVariable(createProductionPromoteFigmaBaselinePaths(), variableName, previousValue, newValue);
    },
  };
}

function printAuditSummary(audit: AgentAuditRecord): void {
  console.log(`Agent run: ${audit.auditId}  (${audit.generatedAt})`);
  console.log(`  reconciliationId: ${audit.reconciliationId}`);
  console.log(`  policy verdict:   ${audit.policyDecision.verdict}`);
  console.log(`  outcome:          ${audit.outcome}`);
  console.log(`  filesModified:    ${audit.filesModified.join(', ') || '(none)'}`);
  console.log(`  stopReason:       ${audit.stopReason}`);
}

async function main(): Promise<void> {
  const reconciliationId = process.argv[2];
  const reconciliationInputPaths = createProductionReconciliationInputPaths();
  const reconciliationOutputPaths = createProductionReconciliationOutputPaths();

  if (!reconciliationId) {
    // Part 7 — never silently choose. List SAFE findings, or say there are none. Zero writes.
    let run: ReconciliationRun;
    try {
      run = readReconciliationRun(reconciliationOutputPaths.latestPath);
    } catch (err) {
      console.error(err instanceof AgentError ? err.message : `Unexpected error reading the latest reconciliation run: ${err}`);
      process.exitCode = 1;
      return;
    }
    const input = loadReconciliationInputs(reconciliationInputPaths);
    const decisions = run.records.map((r) => classifyRecord({ record: r, crosswalk: input.crosswalk, codeCurrent: input.codeCurrent }));
    const safe = decisions.filter((d) => d.verdict === 'SAFE');
    if (safe.length === 0) {
      console.log('No actionable SAFE findings in the latest reconciliation run.');
      console.log(`Run \`npm run sync:reconcile\` first if you expect this to be out of date. (runId: ${run.runId})`);
      return;
    }
    console.log(`${safe.length} SAFE finding(s) available (runId: ${run.runId}):`);
    for (const d of safe) {
      console.log(`  ${d.reconciliationId}  [${d.status}]  ${d.reason}`);
    }
    console.log('');
    console.log('Run again with one of the ids above: npm run sync:agent -- <reconciliationId>');
    return;
  }

  const deps = createProductionAgentRunDeps();

  try {
    const audit = await runAgentForFinding(reconciliationId, deps, new Date().toISOString());
    printAuditSummary(audit);
    if (audit.outcome !== 'applied') process.exitCode = 1;
  } catch (err) {
    console.error(err instanceof AgentError ? err.message : `Unexpected agent error: ${err}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
