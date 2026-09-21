# Sync engine — stage 1 (deterministic change detection)

This is **not** an automatic synchronization engine. It answers exactly two
questions, deterministically, with no LLM involved:

1. **What changed** between a recorded baseline state and the current
   state of `design-system/registry.json`?
2. **What is directly affected**, per the dependency relationships already
   recorded in the registry?

It does not decide whether a change is good or bad, does not touch Figma,
React, CSS, or Storybook, and does not auto-approve or auto-apply anything.
Every change record it produces starts (and, at this stage, stays) at
`status: "detected"`. A future Claude-based sync agent is meant to sit on
top of this layer and do the reasoning/approval work — see "What this
stage deliberately does not do" below.

## Why it reads `registry.json`, not Figma or `src/` directly

`design-system/registry.json` is already the audited mapping layer between
Figma, code, and Storybook (see `design-system/registry-schema.md`). Snapshots
are built from it, not by re-deriving component/token facts from the manifest
or by re-grepping `src/components/**` on every run. Re-deriving independently
would create a second "source of truth" that could silently drift from the
registry; this way, there is exactly one audited mapping layer, and the sync
engine's job is to notice when *that* layer changes over time.

## Directory layout

```
design-system/
  sync/
    scripts/
      types.ts             shared TypeScript types (Snapshot, ChangeRecord, ...)
      snapshot.ts           builds a Snapshot from registry.json; snapshot file I/O
      compare.ts             pure, deterministic diff: (previous, current) -> ChangeRecord[]
      impact.ts               graph traversal over dependsOnComponents/consumedBy
      paths.ts                 shared path constants for the CLI scripts
      baseline.ts               CLI: `npm run sync:baseline`
      check.ts                   CLI: `npm run sync:check`
      compare.test.ts            unit tests for compare.ts (node:test)
      snapshot.test.ts            integration tests against the real registry.json
    snapshots/
      baseline.json           the reference snapshot (only replaced via `--force`)
      current.json              the most recently computed snapshot (overwritten every run)
      archive/
        <snapshotId>.json        every snapshot ever computed, content-addressed, never overwritten
  history/
    <timestamp>_<snapshotId>.json   one immutable record per `sync:check` run (see design-system/history/README.md)
```

This deviates from the `sync/snapshots/`, `sync/changes/`, `sync/scripts/`
starting-point sketch in one way: there is no `sync/changes/`. Change
records live in the top-level `design-system/history/` instead, because the
task's own "History" section describes that folder as the permanent home
for immutable change records — keeping a second `changes/` folder under
`sync/` as well would just split one concept across two places.

## Commands

### `npm run sync:baseline`

Builds a snapshot from the current `registry.json` and writes it to
`sync/snapshots/baseline.json` (plus `current.json` and the archive). This
is a deliberate, explicit action — it does **not** run the comparison, so
creating a baseline never itself produces change records. Refuses to
overwrite an existing baseline unless you pass `--force`.

### `npm run sync:check`

1. Builds a fresh snapshot from the current `registry.json` ("current").
2. Reads `sync/snapshots/baseline.json` ("previous"). Errors out with a
   clear message if no baseline exists yet.
3. Runs `compareSnapshots(previous, current)`.
4. Prints every detected change, plus (informationally) the transitive
   impact expansion via `impact.ts`.
5. Writes an immutable record to `design-system/history/`, even when zero
   changes were found — a "nothing changed" run is still a fact worth
   keeping (proof a check happened, and when).

Note that `sync:check` always compares against the **baseline**, not
against "whatever the last check saw." There is deliberately no
"promote current state to new baseline" command yet — adding one (so a
reviewed/accepted change stops being reported on every subsequent run) is
a reasonable next step, but it's an approval-adjacent action, which this
stage explicitly leaves to the future sync agent.

### `npm run sync:test`

Runs the comparison-logic test suite via Node's built-in test runner
(`node --test`) — no test framework dependency was added; Node 24's
native TypeScript execution (`node file.ts`) and built-in `node:test` /
`node:assert` cover this without any new package.

## Snapshot shape

See `types.ts` for the exact shape. In short, a `Snapshot` has:

- `schemaVersion`, `snapshotId` (a content hash — see below), `generatedAt`,
  `sources` (which registry/manifest files and versions it was built from)
- `components[]` — id, Figma node id/name, React name, code/style paths,
  Storybook title + story ids, variant count/properties, prop mapping,
  `tokenIds`, `dependsOnComponents`
- `tokens[]` — id, `sourceType` (`"figma-variable"` or `"inferred"`),
  Figma name/variable id (or `null` — never invented), type, value, alias
  chain, CSS variable, defining file, `consumedBy`

**`snapshotId` is a content hash**, not a timestamp: it's a truncated
SHA-256 of the canonicalized `{components, tokens}` (see
`computeSnapshotId` in `snapshot.ts`). Two snapshots built from identical
registry content always get the same id, regardless of when they were
generated — this is what makes the archive folder's content-addressed
storage safe (writing the same content twice is a no-op) and what makes
"no changes" reliably detectable.

## Change record shape

See `types.ts` for the exact shape. Every `ChangeRecord` has: `changeId`
(a deterministic hash of entity + change type + field + the two snapshot
ids — re-running the same comparison always reproduces the same id),
`timestamp`, `sourceSnapshot` (`{previous, current}` snapshot ids),
`entityType`, `entityId`, `changeType`, `field`, `previousValue`,
`currentValue`, `affectedComponents`, and `status` (always `"detected"`
right now).

`changeType` is one of the 11 categories this stage was scoped to detect:
`token-value-changed`, `token-alias-changed`, `token-added`,
`token-removed`, `component-added`, `component-removed`,
`component-variant-changed`, `component-property-changed`,
`storybook-mapping-changed`, `code-path-changed`, `dependency-changed`.

### `affectedComponents` is one hop only, on purpose

For a token change, it's exactly that token's `consumedBy` list. For a
component change, it's that component plus anything that directly
`renders` or `expects-children-of` it (read straight from
`dependsOnComponents`/the registry's preserved relationships — never
guessed). It is **not** the full transitive closure. `impact.ts` exports
`expandImpact()`, a deterministic breadth-first traversal over the same
graph, for anything that needs the fuller picture (the CLI prints it as a
separate, clearly-labeled "informational" section). Keeping the two
separate means a change record's `affectedComponents` stays a fact
("these are the direct, known consumers"), while "how far should this
ripple" stays an open question for whoever consumes the graph next.

## What this stage deliberately does not do

- No LLM/Claude API call anywhere in `scripts/`.
- No judgment about whether a change is safe, correct, or wanted.
- No automatic approval, application, or rollback.
- No baseline "promotion" — moving the reference point forward after a
  change is reviewed is not implemented.
- No webhook, dashboard, or Figma-write capability.

Those are explicitly the next stages, sitting on top of this one.
