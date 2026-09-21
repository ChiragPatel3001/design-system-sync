# Agent history (Stage 6B)

`npm run sync:agent -- <reconciliationId>` — the audit trail of every
Claude sync agent invocation. Separate from `design-system/sync/reconciliation/`
on purpose: that directory is reconciliation's own log (what Stage 5C/5D
observed); this one is the agent's own log (what Stage 6B *did about* one
specific observation). Mixing the two would blur exactly the boundary
this project has kept explicit at every prior stage — see
`../reconciliation/README.md`'s own rationale for the same separation
from the registry engine's `design-system/history/`.

## What this stage's agent actually does

Given one already-persisted reconciliation finding, `agent-run.ts`:

1. Classifies it with a **deterministic policy** (`agent-policy.ts`) — no
   Claude call. Only `figma-only-change` on a registry-mapped, alias-free,
   single-declaration token value can ever reach `SAFE`; every other
   status is a fixed `REVIEW`/`BLOCKED`/`NOT_APPLICABLE` verdict.
2. Resolves an **exact, single-file, single-declaration edit target**
   (`agent-targeting.ts`) — independently of the policy decision, and
   stricter than it. This target is the actual security boundary: Claude
   is never given a file path or declaration name to choose, only the
   one target this layer already resolved.
3. Only for a `SAFE` finding with a resolved target: hands a constrained
   `ReasonerContext` (the finding, the policy decision, the target, the
   target file's content, its sibling declarations) to a `Reasoner`. In
   Stage 6B this is a deterministic mock (`createMockReasoner`) — no live
   Claude API is wired up yet; a future stage can swap in a real one
   without touching anything else in this file.
4. Validates the reasoner's `ProposedEdit` against the target exactly
   (file, declaration, current value must all match) before touching
   anything.
5. Applies the edit through a narrow, self-verifying operation
   (`applyEditToFile`) — refuses if the expected current declaration
   isn't found verbatim exactly once, and re-reads the file afterward to
   confirm exactly one declaration changed.
6. Runs validation levels 1–4 (typecheck, targeted test, build, Storybook
   build), then refreshes the Code *current* snapshot (never a baseline)
   and re-runs reconciliation using the existing, unmodified CLIs.
7. Verifies the *actual* reconciliation records — never record counts —
   confirming the targeted finding resolved and nothing unrelated moved.
8. Reverts the edit on any failure at any of the above steps.
9. Writes exactly one immutable audit record either way.

## What this stage's agent does NOT do

Everything Stage 5F/6A already established as out of scope for automatic
action: it never touches `registry.json`, never contacts Figma, never
refreshes a baseline, never edits more than one file or declaration,
never resolves `registry-expectation-mismatch`/`both-changed-conflict`/
`unmapped-figma-entity` automatically, and never retries a finding that
already failed once without an explicit human override (none exists yet).

## Directory layout

```
design-system/sync/agent-history/
  README.md            this file
  latest.json           mutable convenience pointer — a full copy of the most recent audit record
  records/
    <timestamp>_<auditId>.json   one immutable file per agent invocation that considered a finding, never overwritten
```

Same conventions as every other engine in this project (content-addressed
`auditId`, independent of `generatedAt`; immutable `records/`; a `latest.json`
that is never itself the source of truth).

## Running it

```
npm run sync:agent                          # lists SAFE findings in the latest reconciliation run, or says there are none — zero writes
npm run sync:agent -- <reconciliationId>     # acts on exactly one, explicitly identified finding
```

Never chooses a finding on your behalf. If no id is given, nothing is
modified and nothing is written to this directory — only an explicit,
human-chosen `reconciliationId` results in an audit record.
