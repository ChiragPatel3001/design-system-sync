/**
 * Stage 6F — the ONLY thing the dashboard's "Run agent" action is allowed
 * to invoke. This file contains zero policy/edit/reconciliation logic of
 * its own — it validates that the incoming request is exactly the shape
 * the agent boundary accepts (a `reconciliationId` string, plus an
 * optional `reauthorize` boolean — see below), then calls the real,
 * unmodified `runAgentForFinding()` from agent-run.ts with the real
 * production deps (`createProductionAgentRunDeps()`). Every safety
 * guarantee (single file, single declaration, SAFE-only, revert-on-
 * failure, audit trail, loop prevention) already lives in agent-run.ts/
 * agent-policy.ts/agent-targeting.ts and is exercised exactly as
 * `npm run sync:agent` exercises it — this handler adds nothing beyond
 * "parse the HTTP request, call the CLI's own entry function, return its
 * result".
 *
 * In particular, the request body is NEVER trusted for anything beyond
 * `reconciliationId` and `reauthorize`: there is no `filePath`,
 * `declarationIdentifier`, or `after` field this handler reads — WHICH
 * file and WHICH declaration change is decided entirely inside
 * `runAgentForFinding` (by agent-targeting.ts), exactly as it is for the
 * CLI.
 *
 * `reauthorize` — explicit human re-authorization of a finding whose
 * automatic retry was refused by loop prevention (see agent-run.ts's
 * `hasPriorFailedAttempt`/`RunAgentForFindingOptions`). This handler does
 * NOT trust the client's claim that reauthorization is warranted — it
 * only forwards the flag; `runAgentForFinding` independently re-derives
 * the real policy verdict and every other gate regardless of what this
 * flag says, so a client sending `reauthorize: true` for a finding with
 * no prior failure, or one that is REVIEW/BLOCKED, or SAFE-then-drifted,
 * has zero effect beyond what a normal request would already do. This is
 * deliberately NOT a generic "force"/"skip safety" field — it has
 * exactly one effect (see agent-run.ts) and nothing else reads it.
 *
 * `sourceOfTruth` — explicit human-directed resolution of a token-level
 * both-changed-conflict finding (Part 18; see agent-run.ts's
 * `RunAgentForFindingOptions.humanDirectedSourceOfTruth`). Same
 * discipline as `reauthorize`: this handler does not trust the client's
 * claim that the target is eligible — it only forwards the value;
 * `runAgentForFinding` independently, structurally validates that the
 * targeted finding really is `entityType: 'token'` and
 * `status: 'both-changed-conflict'`, throwing immediately (before any
 * write) for anything else, e.g. a `registry-expectation-mismatch` or a
 * component-level finding like "button".
 */
import { runAgentForFinding, type AgentRunDeps, type AgentAuditRecord } from './agent-run.ts';

export class DashboardAgentRequestError extends Error {}

/** The ONLY accepted request shape — a single reconciliationId (never an array/batch) plus an optional reauthorize boolean and an optional sourceOfTruth. */
export interface RunAgentRequestBody {
  reconciliationId: string;
  reauthorize: boolean;
  sourceOfTruth: 'figma' | 'code' | null;
}

/**
 * Validates an arbitrary, untrusted HTTP request body down to exactly
 * `{ reconciliationId: string, reauthorize?: boolean, sourceOfTruth?: 'figma' | 'code' }`
 * — rejects a missing id, a non-string id, a non-boolean `reauthorize`,
 * an invalid `sourceOfTruth`, and an array (which would otherwise look
 * like "run several findings at once"). Any other field on the body (a
 * stray `filePath`, `declarationIdentifier`, `after`, etc.) is silently
 * ignored, never read — the dashboard has no mechanism to make those
 * reach the edit engine.
 */
export function parseRunAgentRequestBody(body: unknown): RunAgentRequestBody {
  if (Array.isArray(body)) {
    throw new DashboardAgentRequestError('Batch execution is not supported — the agent boundary accepts exactly one reconciliationId per invocation.');
  }
  if (typeof body !== 'object' || body === null) {
    throw new DashboardAgentRequestError('Request body must be a JSON object with a "reconciliationId" field.');
  }
  const record = body as Record<string, unknown>;

  const reconciliationId = record.reconciliationId;
  if (typeof reconciliationId !== 'string' || reconciliationId.length === 0) {
    throw new DashboardAgentRequestError('"reconciliationId" must be a non-empty string.');
  }

  if ('reauthorize' in record && typeof record.reauthorize !== 'boolean') {
    throw new DashboardAgentRequestError('"reauthorize", if present, must be a boolean.');
  }
  const reauthorize = record.reauthorize === true;

  if ('sourceOfTruth' in record && record.sourceOfTruth !== undefined && record.sourceOfTruth !== 'figma' && record.sourceOfTruth !== 'code') {
    throw new DashboardAgentRequestError('"sourceOfTruth", if present, must be "figma" or "code".');
  }
  const sourceOfTruth = record.sourceOfTruth === 'figma' || record.sourceOfTruth === 'code' ? record.sourceOfTruth : null;

  return { reconciliationId, reauthorize, sourceOfTruth };
}

/**
 * Runs the real agent pipeline for exactly one finding. `deps` is
 * injectable purely for testing (isolated fixtures, mirroring
 * agent-run.test.ts's own pattern) — the dashboard server always calls
 * this with `createProductionAgentRunDeps()` (agent-run.ts).
 */
export async function handleRunAgentRequest(body: unknown, deps: AgentRunDeps): Promise<AgentAuditRecord> {
  const { reconciliationId, reauthorize, sourceOfTruth } = parseRunAgentRequestBody(body);
  return runAgentForFinding(reconciliationId, deps, new Date().toISOString(), {
    humanReauthorized: reauthorize,
    ...(sourceOfTruth ? { humanDirectedSourceOfTruth: sourceOfTruth } : {}),
  });
}
