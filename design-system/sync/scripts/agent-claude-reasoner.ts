/**
 * Stage 6C — the Claude reasoning adapter. Fills the EXISTING `Reasoner`
 * boundary (agent-run.ts) with a real (or, for tests, mock) Claude call.
 * This module owns exactly one decision: "what value should replace the
 * already-authorized target's current value, and why". It owns nothing
 * else — see the module-level separation this file enforces structurally
 * below, not just by convention:
 *
 *   Deterministic (agent-policy.ts / agent-targeting.ts, unchanged):
 *     - WHETHER the finding is safe to act on at all
 *     - WHICH file is editable
 *     - WHICH declaration within it is editable
 *     - WHETHER a proposal structurally matches the authorized target
 *     - WHETHER validation/reconciliation prove the change
 *
 *   Claude (this file):
 *     - WHAT the new value should be, given the finding, the policy
 *       decision, the target's current value, the target file's content,
 *       and its sibling declarations (for local convention — e.g. `px`
 *       vs unitless, matching Part 16's guidance: no global unit rule is
 *       hard-coded anywhere in this codebase; that judgment call is
 *       exactly what belongs to Claude's contextual reading, per finding,
 *       never a blanket rule, since e.g. font-weight in this same
 *       repository is legitimately unitless while font-size is not)
 *
 * Claude NEVER supplies `filePath`, `declarationIdentifier`, or `before`
 * — those three ProposedEdit fields are always filled in by this
 * adapter FROM THE ALREADY-RESOLVED EditTarget, never from Claude's
 * response, even if Claude's response happened to contain them. This is
 * a structural guarantee, not just a downstream rejection: Claude's
 * expected response shape (see ClaudeStructuredResponse below) doesn't
 * even have fields for them, and any unexpected extra field in the
 * response is treated as a fail-closed rejection (see
 * parseClaudeResponse). agent-run.ts's own `validateProposedEdit()`
 * still re-checks the fully-assembled ProposedEdit against the target
 * afterward, unmodified — this adapter adds a second, independent layer
 * of the same guarantee rather than replacing it.
 */
import type { ReasonerContext, ProposedEdit, Reasoner } from './agent-run.ts';

export class ClaudeReasoningError extends Error {}

// =======================================================================
// The injectable Claude client boundary. Narrow on purpose: "send this
// prompt, get raw text back" — not a general SDK wrapper. Production uses
// a real fetch()-backed implementation; tests inject a deterministic mock
// that never makes a network call.
// =======================================================================

export interface ClaudeClient {
  requestStructuredEdit(prompt: string): Promise<string>;
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const ANTHROPIC_MODEL = 'claude-sonnet-5';
const MAX_RESPONSE_TOKENS = 512;

/**
 * The real, production Claude client — native `fetch`, zero new
 * dependencies (Node 24 already has `fetch` built in; this project adds
 * no HTTP/SDK package for the same reason it has never added a test
 * framework or a CSS parser). Reads `ANTHROPIC_API_KEY` from the
 * environment; NEVER hard-codes a key, never falls back to a default,
 * and fails closed with a clear error the moment it's constructed if the
 * key is missing — exactly like `notImplementedReasoner`'s existing
 * "fail loudly, never silently guess" precedent in agent-run.ts.
 */
export function createAnthropicClaudeClient(env: NodeJS.ProcessEnv = process.env): ClaudeClient {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ClaudeReasoningError(
      'ANTHROPIC_API_KEY is not set. This adapter never invents or hard-codes credentials — set the environment variable, or use a MockClaudeClient (see agent-claude-reasoner.test.ts) for testing.',
    );
  }

  return {
    async requestStructuredEdit(prompt: string): Promise<string> {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: MAX_RESPONSE_TOKENS,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new ClaudeReasoningError(`Claude API request failed: ${response.status} ${response.statusText}. ${body}`.trim());
      }

      const payload = (await response.json()) as { content?: { type: string; text?: string }[] };
      const textBlock = payload.content?.find((block) => block.type === 'text' && typeof block.text === 'string');
      if (!textBlock?.text) {
        throw new ClaudeReasoningError('Claude API response contained no text content block.');
      }
      return textBlock.text;
    },
  };
}

/** Deterministic test double — never makes a network call. `response` may be a fixed string or a function, so a test can also simulate a client-level failure (e.g. a thrown network error). */
export function createMockClaudeClient(response: string | (() => string)): ClaudeClient {
  return {
    async requestStructuredEdit(): Promise<string> {
      return typeof response === 'function' ? response() : response;
    },
  };
}

// =======================================================================
// Prompt construction. Tightly scoped: states the finding, the policy
// decision that authorized this attempt, the exact (already-resolved)
// target, its current value, the target file's content, sibling
// declarations for local-convention context, and an explicit,
// enumerated list of constraints — never invites Claude to choose a
// file, a declaration, or to return anything beyond the two fields it
// actually owns.
// =======================================================================

export function buildPrompt(context: ReasonerContext): string {
  const { record, policyDecision, editTarget, fileContent, siblingDeclarations, humanDirected } = context;

  const siblingLines = siblingDeclarations.length
    ? siblingDeclarations.map((s) => `  ${s.identifier}: ${s.value};`).join('\n')
    : '  (no other declarations in this file)';

  // Only ever present for a human-directed resolution of a
  // both-changed-conflict toward 'figma' (see agent-run.ts's Part 18) —
  // explains why a proposal is being requested even though the POLICY
  // DECISION section below (deliberately left unaltered) still reads
  // BLOCKED, so Claude isn't misled by that apparent contradiction.
  const humanDirectedNote = humanDirected
    ? `\nHUMAN-DIRECTED OVERRIDE\n  A human reviewer has already examined this conflict and explicitly directed that the Figma current value below is authoritative for this one case, overriding the policy verdict above for this one exception only. Propose the replacement value for the code declaration that matches Figma's current value, following the same local-convention rules as always (see OTHER DECLARATIONS below).\n`
    : '';

  return `You are proposing a single, minimal value replacement for an already-authorized design-token synchronization edit. You do not choose what is edited — that has already been decided deterministically. You only decide what the new value should be.

RECONCILIATION FINDING
  entity: ${record.entityType} "${record.entityId}"
  status: ${record.status}
  detail: ${record.detail}
  Figma current value: ${JSON.stringify(record.figma?.current ?? null)}
  Figma baseline value: ${JSON.stringify(record.figma?.baseline ?? null)}
  Code current value:   ${JSON.stringify(record.code?.current ?? null)}
  Code baseline value:  ${JSON.stringify(record.code?.baseline ?? null)}

POLICY DECISION THAT AUTHORIZED THIS ATTEMPT
  verdict: ${policyDecision.verdict}
  reason: ${policyDecision.reason}
${humanDirectedNote}
AUTHORIZED EDIT TARGET (fixed — you may not change or reinterpret this)
  file: ${editTarget.filePath}
  declaration: ${editTarget.declarationIdentifier}
  current value: ${editTarget.currentValue}

FULL CONTENT OF THE TARGET FILE (for context only — you may not propose changing anything else in it)
---
${fileContent}
---

OTHER DECLARATIONS IN THE SAME FILE (for inferring local convention — e.g. whether values in this file use "px", are unitless, or follow some other pattern; different properties in this codebase legitimately use different conventions, so infer this per-file/per-property, never assume one global rule)
${siblingLines}

CONSTRAINTS (all mandatory)
  - You may propose a new value for the declaration "${editTarget.declarationIdentifier}" in "${editTarget.filePath}" ONLY. You may not propose any other file, any other declaration, or additional edits of any kind.
  - Your replacement value must follow the local convention already established by the sibling declarations shown above (e.g. matching unit suffix conventions).
  - Do not rename anything. Do not modify unrelated declarations. Do not suggest edits outside the authorized target.
  - Your replacement must be a single scalar value (e.g. "18px", "#8a38f5") — never a patch, a diff, or multi-line output.
  - If you are not confident in a single correct replacement value, you must refuse rather than guess: respond with {"replacement": null, "reasoning": "<why you are refusing>"}.

RESPONSE FORMAT (mandatory — respond with ONLY this JSON object and nothing else, no prose before or after it, no markdown code fence)
{"replacement": "<the new value as a plain string, or null to refuse>", "reasoning": "<one or two sentences explaining your choice>"}`;
}

// =======================================================================
// Response parsing — fail closed. No heuristic recovery from malformed
// output; any violation of the expected shape is an immediate rejection.
// =======================================================================

interface ClaudeStructuredResponse {
  replacement: string | null;
  reasoning?: string;
}

const ALLOWED_RESPONSE_KEYS = new Set(['replacement', 'reasoning']);
const DIFF_MARKER_RE = /^(---|\+\+\+|@@|diff --git)/;

function parseClaudeResponse(rawText: string): ClaudeStructuredResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.trim());
  } catch {
    throw new ClaudeReasoningError(`Claude response was not valid JSON: ${rawText.slice(0, 200)}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ClaudeReasoningError('Claude response was not a single JSON object.');
  }

  const record = parsed as Record<string, unknown>;
  const extraKeys = Object.keys(record).filter((k) => !ALLOWED_RESPONSE_KEYS.has(k));
  if (extraKeys.length > 0) {
    throw new ClaudeReasoningError(
      `Claude response contained unexpected additional field(s): ${extraKeys.join(', ')}. Only "replacement" and "reasoning" are permitted — Claude must never supply a file path, declaration identifier, or additional edits.`,
    );
  }

  if (!('replacement' in record)) {
    throw new ClaudeReasoningError('Claude response is missing the required "replacement" field.');
  }

  const replacement = record.replacement;
  if (replacement === null) {
    const reason = typeof record.reasoning === 'string' && record.reasoning.trim() ? record.reasoning : 'Claude declined to propose a replacement.';
    throw new ClaudeReasoningError(`Claude refused to propose an edit: ${reason}`);
  }

  if (typeof replacement !== 'string' || replacement.trim().length === 0) {
    throw new ClaudeReasoningError('Claude response\'s "replacement" field must be a non-empty string (or null to refuse).');
  }

  if (replacement.includes('\n') || DIFF_MARKER_RE.test(replacement.trim())) {
    throw new ClaudeReasoningError('Claude response\'s "replacement" looks like a patch/diff or multi-line output, not a scalar value — refusing.');
  }

  if (record.reasoning !== undefined && typeof record.reasoning !== 'string') {
    throw new ClaudeReasoningError('Claude response\'s "reasoning" field, if present, must be a string.');
  }

  return { replacement: replacement.trim(), reasoning: typeof record.reasoning === 'string' ? record.reasoning.trim() : undefined };
}

// =======================================================================
// The adapter itself — satisfies the EXISTING Reasoner type unchanged in
// shape (still `(ReasonerContext) => ProposedEdit`, just now async-
// capable at the type level in agent-run.ts). `filePath`,
// `declarationIdentifier`, and `before` are always taken from
// `context.editTarget` — never from Claude's response.
// =======================================================================

export function createClaudeReasoner(client: ClaudeClient): Reasoner {
  return async (context: ReasonerContext): Promise<ProposedEdit> => {
    const prompt = buildPrompt(context);
    const rawText = await client.requestStructuredEdit(prompt);
    const parsed = parseClaudeResponse(rawText);

    return {
      filePath: context.editTarget.filePath,
      declarationIdentifier: context.editTarget.declarationIdentifier,
      before: context.editTarget.currentValue,
      after: parsed.replacement as string,
      rationale: parsed.reasoning ?? 'Claude reasoning adapter: no rationale provided.',
    };
  };
}
