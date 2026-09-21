# Code snapshots

An independent, deterministic view of the design system's actual
**implementation** state — built only from `src/components/**`. This is a
sibling to `design-system/sync/snapshots/` (the registry-derived
snapshots), not a replacement for it, and the two are intentionally kept
apart:

- `design-system/sync/snapshots/` answers "has our *recorded description*
  of the system (`design-system/registry.json`) changed since we last
  recorded it?"
- `design-system/sync/code-snapshots/` answers "has the *actual code*
  changed?" — independent of whether anyone has updated the registry to
  match.

The architecture audit that preceded this stage established that the
registry-snapshot engine alone cannot detect code-originated drift, since
it never reads `src/components/**`. This is the first piece that closes
that gap. It still does not compare code against the registry or against
Figma — that cross-kind reconciliation is explicitly a later stage.

## What builds a CodeSnapshot, and from what

`design-system/sync/scripts/code-snapshot.ts` (`buildCodeSnapshot()`)
reads **only** files under `src/components/`:

- Every `<Name>/<Name>.tsx` — parsed with the TypeScript compiler API
  (`typescript`, already a project devDependency; no new dependency was
  added) for exports, the `<Name>Props` type, prop types, string-literal
  variant unions, and import statements.
- Every `<Name>/<Name>.css` — regex-scanned for `var(--...)` (consumed
  custom properties) and `--name:` (locally-defined custom properties).
- Every `<Name>/<Name>.stories.tsx` — regex-scanned for the `title:`
  string and `export const <Name>` identifiers; Storybook story ids are
  then *computed* from those (see `code-snapshot.ts`'s comments on the
  empirically-verified id algorithm) rather than read from a running
  Storybook instance.

It never reads the registry mapping file, the Figma-extraction manifest,
or anything Figma-related, and it never calls a Figma MCP tool. This is
tested explicitly in `code-snapshot.test.ts`.

## Token definitions (`tokenDefinitions`)

In addition to the component-level view above, `buildCodeSnapshot()`
optionally reads every `src/tokens/**/*.css` file (passed as `tokensDir`;
omitted from a call, `tokenDefinitions` is simply `[]`) and records each
`--name: value;` custom-property definition it finds as a
`CodeTokenDefinition { cssVariable, value, sourceFilePath }`.

The `value` is captured **exactly as written**, never resolved through a
`var(...)` alias chain — e.g. `--radius-lg: var(--scale-100);` is recorded
with `value: "var(--scale-100)"`, not the number that alias ultimately
resolves to. This is source-derived data only, intended for a later stage
to compare against Figma variable values; that comparison itself
(resolving alias chains, matching a code token to a Figma one) is not
part of this stage.

This is a separate concept from `cssCustomPropertiesConsumed` /
`cssCustomPropertiesDefined` on each component entry, which record only
*names* seen in a component's own `.css` file (consumption/local
definition), not the token system's own source-of-truth definitions.

`tokenDefinitions` is sorted by `cssVariable`, then `sourceFilePath`, then
`value`, so its order never depends on filesystem enumeration order — and
it feeds into `snapshotId` exactly like `components` does, so a change to
a token's source definition changes the snapshot id.

## Identity is independent, on purpose

Each entry's `componentId` is the literal directory name under
`src/components/` (e.g. `"IconButton"`) — not the registry's curated,
kebab-cased `id` (`"icon-button"`). These are deliberately two separate
identity schemes right now. Correlating them (so a future reconciliation
engine can say "code's `IconButton` *is* registry's `icon-button` *is*
Figma's `Button_Icon`") is the registry's job in a later stage, not
something this stage assumes or computes.

## Directory layout

```
design-system/sync/code-snapshots/
  baseline.json      the reference CodeSnapshot (replaced only via --force)
  current.json         the most recently built CodeSnapshot (overwritten every run)
  archive/
    <snapshotId>.json    every CodeSnapshot ever computed, content-addressed, never overwritten
  history/
    <timestamp>_<snapshotId>.json   one immutable record per `sync:code-check` run
```

Mirrors `design-system/sync/snapshots/` and `design-system/history/`'s
conventions exactly (content-addressed archive, refuse-to-overwrite
baseline, one history file per run, history written even for zero
changes) — but stored under its own tree, per this stage's requirement
that code snapshots live separately from the registry ones. The history
here is also kept separate from `design-system/history/`, since that
folder's own README specifically describes it as the registry-check
engine's log; this stage doesn't modify that file or its meaning.

## Commands

- `npm run sync:code-baseline` — builds and records the first known
  CodeSnapshot. `--force` to replace an existing one.
- `npm run sync:code-check` — builds the current CodeSnapshot, compares it
  against the baseline via `compareCodeSnapshots()` (`code-compare.ts`,
  the same index-and-diff pattern as the registry engine's `compare.ts`,
  applied to code-derived fields: source hashes, props, variants, CSS
  tokens consumed/defined, component dependencies, Storybook mapping),
  prints the results, and appends a record to
  `code-snapshots/history/`.
- `npm run sync:code-test` — runs `code-snapshot.test.ts` via Node's
  built-in test runner (no new test-framework dependency).

## What this still doesn't do

Same boundary as the registry engine, plus one more: this still cannot
tell you whether the code is *correct* relative to Figma or the registry
— only whether the code itself has changed since the code baseline was
recorded. Comparing a CodeSnapshot against the registry (or, later, a
FigmaSnapshot) to find actual drift is reconciliation, and is explicitly
out of scope for this stage.
