# Reconciliation (Stage 5D)

`npm run sync:reconcile` — the persistence/orchestration layer on top of
Stage 5C's pure `reconcileSnapshots()` (see
`../scripts/reconcile-compare.ts`) and Stage 5B's identity crosswalk (see
`../scripts/reconcile-crosswalk.ts`). This directory holds what that
command writes.

**This is an analysis artifact, not a new source of truth.** A
reconciliation run states facts about how the registry, Figma, and Code
currently relate to each other and to their own baselines. It never
changes the registry, never writes to Figma, never touches source code,
and proposes nothing — no fix, no patch, no approval workflow. Turning a
`ReconciliationRecord` into an action is explicitly out of scope for this
stage and belongs to a future one.

## What it reads

Five files, exactly as they currently sit on disk — this command never
rebuilds or refreshes any of them:

- `design-system/registry.json` (plus `design-system-manifest.json`, only
  for the one metadata field `buildSnapshot()` already needs)
- `design-system/sync/figma-snapshots/baseline.json` and `current.json`
- `design-system/sync/code-snapshots/baseline.json` and `current.json`

The identity crosswalk is built fresh from the current `registry.json`
using the unmodified Stage 5B logic (`buildReconciliationCrosswalk`) —
never read from a persisted file (Stage 5B never persists one).

It never calls a Figma MCP tool, never re-derives a snapshot from source,
and never modifies any of the five files above, any snapshot archive, any
history record, or `registry.json` itself.

## What it writes

```
design-system/sync/reconciliation/
  README.md              this file
  latest.json             mutable convenience pointer — a full copy of the most recent successful run
  records/
    <timestamp>_<runId>.json   one immutable file per run, never overwritten
```

Only these two locations are ever written. If reconciliation itself
fails (a required input is missing or malformed) or persistence fails (an
immutable record would be overwritten), nothing is written at all —
`latest.json` and every existing record are left exactly as they were.

## Run identity (`runId`) vs `generatedAt`

Same distinction the registry/Figma/Code snapshot engines already draw
between a content hash and a timestamp (see `../README.md`,
`../figma-snapshots/README.md`, `../code-snapshots/README.md`):

- **`runId`** is a deterministic SHA-256 (truncated to 16 hex chars) of
  the registry snapshot id, the Figma baseline/current ids, the Code
  baseline/current ids, and the final `records[]` array — sorted-keys
  canonicalized the same way every other engine's `computeXSnapshotId`
  already works (see `computeRunId` in `../scripts/reconcile.ts`). It
  never includes `generatedAt`, filesystem enumeration order, machine
  paths, or randomness. **Two runs against byte-identical inputs always
  get the same `runId`, no matter when either one ran.**
- **`generatedAt`** is the real wall-clock time the run executed, kept
  only for human-readable history and for building each immutable
  record's filename. It has zero influence on `runId`, on any
  `ReconciliationRecord`, or on the comparison result itself.

## `latest.json` vs the immutable records

`records/<timestamp>_<runId>.json` is permanent — `reconcile.ts` refuses
to overwrite an existing file there (the timestamp+runId combination
would have to collide exactly, which in practice means running the
command twice in the same millisecond against identical inputs; the
command errors out rather than silently doing nothing or clobbering).

`latest.json` is a full copy of the most recent successful run's content,
replaced every time the command succeeds. It exists purely for
convenience (read one well-known path instead of listing `records/` and
finding the newest file) — it is never the source of truth, and nothing
should assume it reflects anything beyond "whatever the last successful
run produced."

## Stale/missing-input warnings

Every run's `warnings[]` array (see `ReconciliationWarning` in
`../scripts/reconcile-types.ts`) is computed deterministically from the
inputs' own recorded timestamps — **never from the current wall-clock
time** — and never changes any record's `status`. Two checks exist today:

- **`figma-code-registry-date-mismatch`** — the registry's
  `registryUpdatedOn`, the Figma current capture's `capturedAt`, and the
  Code current snapshot's `generatedAt` don't share the same calendar
  date. No numeric "N hours/days" threshold is invented; calendar-day
  granularity is the same precision `registryUpdatedOn` itself already
  uses, so a mismatch here is a fact about the inputs, not a guess.
- **`code-baseline-missing-token-definitions`** — the persisted Code
  baseline predates Stage 5A's `tokenDefinitions` field. This is real in
  this repository today: `code-snapshots/baseline.json` has no
  `tokenDefinitions` key at all, so every registry-mapped token shows up
  as a `code-only-change` against it until that baseline is refreshed
  (`npm run sync:code-baseline --force` — something `reconcile.ts` itself
  deliberately never does). `reconcile-compare.ts` already handles the
  missing field defensively (falls back to `[]` rather than throwing);
  this warning just makes that condition visible instead of leaving it
  buried in a long record list.

## Zero-record runs

A run that finds nothing to report (no drift, no mismatch, no unmapped or
deleted entity) still succeeds and still writes a normal run record —
`recordCount: 0`, `records: []` — exactly like the registry/Code/Figma
engines' own history conventions (a "nothing changed" run is still proof
a check happened, not an absence of evidence). Nothing is ever fabricated
to make the output non-empty.

## Running it

```
npm run sync:reconcile
```

Prints a short, deterministic summary — `runId`, the registry/Figma/Code
identities involved, any warnings, the total record count, counts grouped
by status, and the conflict count — then reports where the two output
files were written. It does **not** dump every record to the console by
default; the persisted JSON file has the complete list.

## Interpreting the output

Every record's `status` (see `ReconciliationStatus` in
`../scripts/reconcile-types.ts` and the full semantics in
`../scripts/reconcile-compare.ts`'s header comment) is one of:

| status | meaning |
| --- | --- |
| `figma-only-change` / `code-only-change` | that side drifted from its own baseline; the other didn't |
| `both-changed-compatible` / `both-changed-conflict` | both sides drifted; their current raw values do (or don't) match, character-for-character |
| `registry-expectation-mismatch` | the registry's own recorded value disagrees with the *current* Figma capture — independent of any baseline drift (this is the real Button case: registry says variant property "Property 1", the live capture calls it "State") |
| `unmapped-figma-entity` / `unmapped-code-entity` | an entity the registry expects has never been observed on that side, or an entity observed on that side has no registry mapping at all |
| `deleted-figma-entity` / `deleted-code-entity` | a registry-mapped entity was present in that side's baseline but is gone from current |
| `identity-mismatch` | the registry's `codePath` doesn't resolve to a valid CodeSnapshot component id at all — never silently treated as a deletion |
| `intentional-documented-deviation` | reserved for a difference `registry.json`'s `unresolved[]` structurally documents as expected; not currently produced by any comparison this engine performs (see `reconcile-compare.ts`'s header for why) |

**`conflictCount`** in the run summary/record counts only
`both-changed-conflict` specifically — the one status that most directly
means "the two observed sides disagree after both changed." The other
statuses are facts worth knowing, not necessarily conflicts.

This stage proposes nothing. Every record is an observation for a human
(or a later stage) to act on — this command itself never edits the
registry, never writes to Figma, and never touches source code.
