/**
 * Stage 6F — the ONLY thing the dashboard's "Run agent" action is allowed
 * to invoke. This file contains zero policy/edit/reconciliation logic of
 * its own — it validates that the incoming request is exactly the one
 * shape the agent boundary accepts (a single `reconciliationId` string),
 * then calls the real, unmodified `runAgentForFinding()` from
 * agent-run.ts with the real production deps
 * (`createProductionAgentRunDeps()`). Every safety guarantee (single
 * file, single declaration, SAFE-only, revert-on-failure, audit trail,
 * loop prevention) already lives in agent-run.ts/agent-policy.ts/
 * agent-targeting.ts and is exercised exactly as `npm run sync:agent`
 * exercises it — this handler adds nothing beyond "parse the HTTP
 * request, call the CLI's own entry function, return its result".
 *
 * In particular, the request body is NEVER trusted for anything beyond
 * `reconciliationId`: there is no `filePath`, `declarationIdentifier`, or
 * `after` field this handler reads — WHICH file and WHICH declaration
 * change is decided entirely inside `runAgentForFinding` (by
 * agent-targeting.ts), exactly as it is for the CLI.
 */
import { runAgentForFinding, type AgentRunDeps, type AgentAuditRecord } from './agent-run.ts';

export class DashboardAgentRequestError extends Error {}

/** The ONLY accepted request shape — a single reconciliationId, never an array, never additional targeting fields. */
export interface RunAgentRequestBody {
  reconciliationId: string;
}

/**
 * Validates an arbitrary, untrusted HTTP request body down to exactly
 * `{ reconciliationId: string }` — rejects a missing id, a non-string id,
 * and an array (which would otherwise look like "run several findings at
 * once"). Any other field on the body (a stray `filePath`,
 * `declarationIdentifier`, `after`, etc.) is silently ignored, never
 * read — the dashboard has no mechanism to make those reach the edit
 * engine.
 */
export function parseRunAgentRequestBody(body: unknown): RunAgentRequestBody {
  if (Array.isArray(body)) {
    throw new DashboardAgentRequestError('Batch execution is not supported — the agent boundary accepts exactly one reconciliationId per invocation.');
  }
  if (typeof body !== 'object' || body === null) {
    throw new DashboardAgentRequestError('Request body must be a JSON object with a "reconciliationId" field.');
  }
  const reconciliationId = (body as Record<string, unknown>).reconciliationId;
  if (typeof reconciliationId !== 'string' || reconciliationId.length === 0) {
    throw new DashboardAgentRequestError('"reconciliationId" must be a non-empty string.');
  }
  return { reconciliationId };
}

/**
 * Runs the real agent pipeline for exactly one finding. `deps` is
 * injectable purely for testing (isolated fixtures, mirroring
 * agent-run.test.ts's own pattern) — the dashboard server always calls
 * this with `createProductionAgentRunDeps()` (agent-run.ts).
 */
export async function handleRunAgentRequest(body: unknown, deps: AgentRunDeps): Promise<AgentAuditRecord> {
  const { reconciliationId } = parseRunAgentRequestBody(body);
  return runAgentForFinding(reconciliationId, deps, new Date().toISOString());
}
