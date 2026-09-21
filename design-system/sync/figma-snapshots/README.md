# Figma snapshots

An independent, deterministic view of the **live Figma design system**,
analogous to `design-system/sync/code-snapshots/` but sourced from Figma
MCP tool output instead of `src/components/**`. Neither
`design-system/registry.json` nor `design-system-manifest.json` was used
to build this — see "What was and wasn't used as a source" below.

## The investigation this schema is grounded in

Before writing any schema, every capability listed in this stage's
instructions was tested live against the real file
(`opq4Is8eZdXdu920YDUIs1`, "Design-System-2.0") with the Figma MCP tools
actually available in this session. Nothing below is assumed.

| Capability | Status | Notes |
|---|---|---|
| File/document identity | **Reliable** | `whoami` (account/team) + the file key itself. |
| Page list | **Partially reliable** | `get_metadata` called with no `nodeId` returned only 1 of the file's 2 pages ("Tokens", missing "Components"). Calling `get_metadata` with each page's node id directly returned both correctly. The snapshot uses the **direct-read** list only — see `pagesConfirmedByDirectRead` vs `pagesFromNoNodeIdListing` in the raw capture. |
| Component / component_set IDs & names | **Reliable** | `get_metadata` on the Components canvas returns every frame/symbol with id, name, position, size. |
| Variants | **Reliable** | Component_set variants appear as child `<symbol>` elements; their `name` attribute is the Figma-native `"Key=Value, Key=Value"` string. |
| Variant property names & values | **Reliable** | Parsed directly from the variant symbol names above (e.g. `"State=Default, Type=Default"` → `{State: "Default", Type: "Default"}`). No inference involved — a name that doesn't match this pattern parses to `{}`, never a guess. |
| Component properties (boolean/instance-swap/text props) | **Unavailable** | `get_context_for_code_connect` and `list_file_components_for_code_connect` — the two tools that expose this — both require a Dev/Full seat on an **Organization or Enterprise** Figma plan. This account is on a "pro" tier team; both calls failed with a plan-upgrade error. Not attempted to work around. |
| Variables (name → resolved value) | **Reliable** | `get_variable_defs(nodeId)` returns a flat `{name: value}` dict for every variable bound anywhere in that node's subtree. Confirmed working at component and section granularity; confirmed **failing** at whole-canvas/page granularity ("nothing selected" error) — see below. |
| Variable IDs | **Unavailable** | `get_variable_defs` does not return them, and no other available MCP tool lists variables by ID. The original manifest's `figmaVariableId` values came from a **user-supplied native Variables export file** (per the manifest's own `source.method` field) — a one-time manual input, not a live MCP capability. This stage has no equivalent source, so variable IDs are not in the FigmaSnapshot. |
| Variable values | **Reliable** (as resolved strings) | See above. Returned already-resolved through the alias chain, as a string (e.g. `"#8a38f5"`, `"4"`, `"Inter"`) — no type tag. |
| Aliases (alias chains) | **Unavailable** | Same root cause as variable IDs — only came from the manual export before, no MCP tool exposes it. `figma-compare.ts` deliberately has **no** "alias changed" comparison category as a result — adding one would mean comparing data never actually retrieved. |
| Variable collections / modes | **Unavailable** | Same as above. |
| Text styles | **Reliable** | `get_variable_defs` on the user-added specimen frame (`70:170`, same node the original manifest used) returns each named style as a `"Font(family: ..., style: ..., size: ..., weight: ..., lineHeight: ..., letterSpacing: ...)"` descriptor, parsed with a documented, tested regex. |
| Fills / strokes / effects / precise typography / padding / gap / corner radius as structured properties | **Partially available, not implemented this stage** | `get_design_context` *does* surface these — but only embedded as Tailwind-arbitrary-value class strings inside generated React/JSX code (e.g. `` bg-[var(--surface\/action,#8a38f5)] ``, `` rounded-[var(--border-radius\/lg,4px)] ``), meant for one-time code-authoring assistance, not as a stable structured API. Extracting it reliably would mean regex-parsing generated code, and the tool is heavy (screenshot + full code generation) — impractical to call once per component (67 nodes) on every snapshot. Corner radius and border width/color *are* already covered reliably via `get_variable_defs`, since this design system binds them to named variables everywhere. Raw geometric fills/strokes/effects on non-token-bound properties are out of scope for this stage — flagged as a real gap, not silently dropped. |
| Dimensions (width/height) | **Reliable** | `get_metadata` reports these directly for every node — component_set container frames and individual variants alike. |
| Component relationships / instances | **Not implemented this stage** | `get_metadata`'s XML does show nesting (e.g. `Input` containing `Label`/`Field` as visible layers in some cases), but reliably distinguishing "contains an instance of X" from "just visually resembles X" needs either Code Connect (blocked, see above) or per-node `get_design_context` calls (same cost/fragility issue as fills/strokes). Not attempted this stage. |

### Two more findings from the live investigation, not assumptions

- **Button's variant property is now named `"State"` in Figma**, not
  `"Property 1"` as the manifest (extracted 2026-09-20) and
  `design-system/registry.json` both record. `Button_Icon`'s is still
  `"Property 1"`. This is a genuine, live difference — exactly the kind of
  Figma-originated drift this whole snapshot system exists to eventually
  detect (reconciliation against the registry is a later stage, not this
  one).
- **The Disabled/Transparent size discrepancies the manifest recorded**
  (`Button` 15:868 measuring 141×42 vs. 139×40 siblings — finding F09;
  `Button_Icon` 15:928 similarly 42×42 vs. 40×40) **were not reproduced**
  in this session's `get_metadata` read — every variant in both
  component_sets now reports uniform sibling dimensions. This could mean
  the discrepancy was fixed in Figma since extraction, or that
  `get_metadata`'s reported frame size differs from whatever measurement
  method originally produced those figures (possibly a rendered/visual
  measurement vs. the frame's set size). Recorded as observed, not
  resolved one way or the other — this is exactly the kind of question a
  future reconciliation stage should chase down, not something to guess
  the answer to here.

## Architecture — why this isn't one self-contained script

`sync:check` (registry) and `sync:code-check` (code) are both fully
self-contained: `node check.ts` / `node code-check.ts` can re-read
`registry.json` / `src/components/**` from disk on every invocation,
because `node:fs` is available to a plain Node process.

**Figma MCP tools are not.** They only exist inside an agent's (Claude's)
interactive tool-calling session — there is no npm-installable client a
standalone `node figma-check.ts` process can import to reach
`get_metadata` or `get_variable_defs` the way it can import `node:fs`.
This is a real architectural boundary, not an oversight, and is called out
explicitly rather than worked around with something that would only
pretend to be live.

So this system is split into two steps:

1. **Capture** (agentic, not deterministic in timing, but the data is
   real): an agent with Figma MCP access runs the investigation above and
   writes the results to `raw-capture.json`, in the `RawFigmaCapture`
   shape (`figma-snapshot-types.ts`).
2. **Build** (deterministic, pure, fully testable without any live
   access): `figma-snapshot.ts`'s `buildFigmaSnapshot()` transforms
   `raw-capture.json` into the canonical, hashed `FigmaSnapshot` — exactly
   the kind of pure function `code-snapshot.ts` and `snapshot.ts` also
   are. `figma-baseline.ts` / `figma-check.ts` only do step 2.

`npm run sync:figma-check` therefore compares the baseline against
whatever is currently in `raw-capture.json` — **not** against Figma's
actual current state unless an agent has just refreshed that file. Running
it back-to-back with no re-capture in between correctly reports zero
changes (the file didn't change), which is expected behavior, not a bug.

## Directory layout

```
design-system/sync/figma-snapshots/
  README.md
  raw-capture.json     the last live MCP capture (refreshed by an agent, not by any npm script)
  baseline.json          the reference FigmaSnapshot (replaced only via --force)
  current.json             the most recently built FigmaSnapshot (overwritten every run)
  archive/
    <snapshotId>.json        every FigmaSnapshot ever built, content-addressed, never overwritten
  history/
    <timestamp>_<snapshotId>.json   one immutable record per `sync:figma-check` run
```

## Commands

- `npm run sync:figma-baseline` — builds the first FigmaSnapshot from
  `raw-capture.json`. `--force` to replace an existing baseline.
- `npm run sync:figma-check` — builds a current FigmaSnapshot from
  `raw-capture.json`, compares it to the baseline via
  `compareFigmaSnapshots()` (`figma-compare.ts`), prints the results, and
  appends a history record.
- `npm run sync:figma-test` — runs `figma-snapshot.test.ts` (Node's
  built-in test runner; no live MCP call anywhere in the suite — small
  fixture objects stand in for MCP output, per this stage's instructions).

## What was and wasn't used as a source

- **`design-system-manifest.json`**: read by no script in this stage.
  Referenced only in this README, for comparing *findings* (e.g. the
  Button property-name rename, the F09 dimension question above) — never
  imported, parsed, or used to populate the FigmaSnapshot.
- **`design-system/registry.json`**: same — not read by any script here.
- Both are enforced by a test (`figma-snapshot.test.ts`, "independence
  from registry.json and design-system-manifest.json") that greps every
  new script file for either filename.

## Room to grow: adding variable IDs, aliases, collections, modes, effects later

The "Unavailable" rows in the table above aren't dead ends — the schema
was deliberately kept additive so they can be filled in later without a
breaking change:

- `schemaVersion` (on `FigmaSnapshot`) and `captureSchemaVersion` (on
  `RawFigmaCapture`) exist specifically so a future format change has a
  place to signal itself.
- `computeFigmaSnapshotId` hashes whatever object it's given
  (`{pages, components, variables, textStyles}`) via a generic recursive
  key-sort — adding a new *field* to an existing entry (e.g.
  `FigmaVariableEntry.figmaVariableId`, `.aliasChain`, `.collectionName`,
  `.modeName`) automatically flows into the hash with no change to the
  hashing function itself. Adding a whole new top-level array (e.g.
  `effects: FigmaEffectEntry[]`) only requires adding that key to the
  object passed into `computeFigmaSnapshotId` — a small, explicit,
  reviewable diff, not a rearchitecture.
- Every "unavailable" field this stage documented has a specific, named
  reason (plan-tier restriction, tool limitation, no live equivalent to a
  manual export) rather than a vague "not done yet" — so whoever picks
  this up later knows exactly which capability gap to close first (Code
  Connect access unlocks component properties and relationships; a
  variables-by-ID tool or a fresh manual export unlocks IDs/aliases/
  collections/modes; a structured fills/strokes/effects API, or accepting
  the cost of parsing `get_design_context` per node, unlocks visual
  properties).
- `figma-compare.ts` already separates its change categories per concern
  (component/variant/variable/text-style) — a new field on an existing
  entity mostly means one more `if` inside the matching block, not a new
  traversal.

## What this still doesn't do

Same boundary as the code-snapshot system, plus the capture/build split
above. This stage does not compare a FigmaSnapshot against the registry or
against a CodeSnapshot — that reconciliation, and the registry's role in
it, is explicitly the next stage, not this one.
