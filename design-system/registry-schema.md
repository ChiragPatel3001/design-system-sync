# Registry schema

This document explains the shape of `design-system/registry.json` — what
each section means, how identities are formed, how the four layers (Figma,
manifest, code, Storybook) connect, and the rules for keeping it correct as
the project grows. It is the reference for anyone (human or the future sync
engine) reading or extending the registry.

`registry.json`'s `registrySchemaVersion` field states which version of this
document it was written against. This document describes **2.0.0**.

## What the registry is for

The registry is the **only** file that ties all four layers together:

```
Figma component  →  design-system-manifest.json (extraction)
       ↕
  registry.json  ←  the mapping layer this document describes
       ↕
React component  →  src/components/**
       ↕
Storybook story  →  src/components/**/*.stories.tsx
```

Nothing here regenerates or duplicates the manifest's data wholesale —
`design-system-manifest.json` stays the single source of truth for
Figma-side facts (values, alias chains, variant lists, node IDs). The
registry stores just enough of that data, plus code-side and Storybook-side
facts gathered by reading the actual source files, to answer the seven
questions this stage was scoped to:

1. **What entity is this?** → every top-level array entry has an
   `entityType` (`"component"`, `"token"`, `"text-style"`).
2. **Where in Figma?** → `figmaNodeId` / `figmaName` (components),
   `figmaName` / `figmaVariableId` (tokens).
3. **Where in code?** → `codePath` / `stylePath` (components), `cssVariable`
   / `tokenFile` (tokens).
4. **Where in Storybook?** → `storybook.title` / `storybook.storyFile` /
   `storybook.storyIds`.
5. **Which tokens does it depend on?** → `tokenIds` (components), the
   reverse `consumedBy` (tokens).
6. **Which variants/properties does it support?** → `figmaVariantProperties`
   / `reactPropMapping` / `variantCount`.
7. **What else depends on it?** → `dependsOnComponents` /
   `usedByComponents` (components), `consumedBy` (tokens and text styles).

## Component identity

Each entry in `components[]` describes one React component and the single
Figma component (or component_set) it implements.

| Field | Meaning | Source of truth |
|---|---|---|
| `id` | **Stable internal ID.** Lowercase kebab-case, derived once from the React component's name and never changed casually (e.g. `"icon-button"` for `IconButton`). This is the primary key every other section references — prefer it over `figmaNodeId` or `reactName` when linking entities together, since it's shorter and code-native. | assigned by this registry |
| `entityType` | Always `"component"` here. | — |
| `figmaNodeId` | The Figma node ID (`"15:664"`). **Never changes** even if the component is renamed in Figma — a node ID identifies a specific node, not a name. | manifest |
| `figmaName` | The component's name as it appears in Figma (`"Button_Icon"`, `".menu item"`). Can drift if renamed in Figma; `figmaNodeId` is the durable identifier, this is the display counterpart. | manifest |
| `figmaKind` | `"component"` or `"component_set"`. | manifest |
| `figmaInternal` | `true` only when the Figma name starts with `.` (Figma's own convention for hiding a component from library publishing). Only present when true. | manifest |
| `figmaSection` | Which Components-page section the node lives in. | manifest |
| `reactName` | The exported React component name. | code (`export function X`) |
| `codePath` / `stylePath` | Paths to the `.tsx` / `.css` files. | code (verified to exist on disk) |
| `storybook` | See below. | Storybook story files |
| `variantCount` | Total Figma variant nodes inside the component_set (or 0 for a plain component). | manifest |
| `figmaVariantProperties` | The literal Figma variant axes and their values (e.g. `{"Type": ["Default","Outline","Transparent"]}`). | manifest |
| `reactPropMapping` | For each Figma variant axis / component property, how it was implemented in React (a prop, a CSS pseudo-class, a native HTML attribute, or "not implemented"). This is the load-bearing field for understanding *why* the code doesn't mirror Figma's variant list 1:1. | code + manifest, cross-referenced |
| `tokenIds` | Design tokens referenced **directly** in this component's own `.css` file (not tokens pulled in transitively through a composed child — see "Dependency mapping" below). | code (`.css` file, grepped for `var(--...)`) |
| `dependsOnComponents` / `usedByComponents` | See "Dependency mapping." | code imports + manifest `relationships[]` |
| `knownLimitations` | Free-text notes on Figma limitations or deliberate code deviations. Mirrors (doesn't replace) `design-system/implementation-notes.md`. | manifest findings + implementation notes |

### Stable ID rules

- `id` is assigned once and is not renamed to "clean it up" later. If a
  component is renamed in React, keep the existing `id` and update
  `reactName` — `id` is the durable key, `reactName` is a display fact
  about current code.
- Never create a second `id` for the same `figmaNodeId`. If you think you
  need to, you're probably looking at a variant of an existing component,
  not a new one.
- `figmaNodeId` is copied verbatim from the manifest and is never
  reformatted, renamed, or guessed. If it's not in the manifest, it doesn't
  go in the registry.

### The `storybook` block

```json
"storybook": {
  "storyFile": "src/components/Button/Button.stories.tsx",
  "title": "Components/Button",
  "storyIds": ["components-button--default", "..."]
}
```

`title` and `storyIds` are **not hand-typed** — they must match exactly
what Storybook itself generates from the `.stories.tsx` file's `meta.title`
and each `export const <Name>`. `storyIds` follow Storybook's own
`kebab-case(title) + "--" + kebab-case(exportName)` algorithm (the display
`name:` override in a story does **not** change its ID — only the export
identifier does). When adding or renaming a story, regenerate this block
from the actual file (or from a running instance's `/index.json`), never by
hand-guessing the kebab-case conversion.

## Token identity

Each entry in `tokens[]` describes one CSS custom property and, where one
exists, the Figma variable it implements.

| Field | Meaning | Source of truth |
|---|---|---|
| `tokenId` | **Stable ID**, always identical to `cssVariable` minus its leading `--` (e.g. `cssVariable: "--color-surface-action"` → `tokenId: "color-surface-action"`). Deliberately *not* a separate invented naming scheme: the CSS variable already is a stable, unique, code-native identifier, so reusing it avoids a second mapping that could drift out of sync with the code. | derived (1:1 with `cssVariable`) |
| `sourceType` | `"figma-variable"` for tokens that trace to a real Figma variable, or `"inferred"` for the one token that doesn't (`font-weight-body` — see "Unresolved and audit findings"). | — |
| `figmaName` | The manifest's full path for the variable (`"Mapped/Surface/action"`), i.e. `"<collection>/<name>"`. `null` when `sourceType` is `"inferred"`. | manifest |
| `figmaVariableId` | The manifest's `figmaVariableId` (`"VariableID:9:477"`). `null` when inferred. | manifest |
| `type` | The Figma variable type (`COLOR`, `FLOAT`, `STRING`), or `"INFERRED"` for the one non-Figma token. | manifest |
| `figmaValue` | The **resolved** value at the token's own tier (e.g. Mapped-tier tokens show the Mapped value, which happens to equal its Alias/Brand ancestors — see `aliasChain`). | manifest |
| `aliasChain` | Copied verbatim from the manifest's own `aliasChain` for that variable — the full alias path down to the Brand primitive. `null` for the one inferred token. | manifest |
| `cssVariable` | The literal CSS custom property name, exactly as declared in `src/tokens/*.css`. | code |
| `tokenFile` | Which file under `src/tokens/` declares it. | code |
| `consumedBy` | Component `id`s whose `.css` file references this variable via `var(--...)`. This is the reverse index of every component's `tokenIds` — computed, not hand-maintained; the two must always agree. | code (grepped) |

### Scope: only *consumed* tokens are catalogued

`src/tokens/*.css` implements the manifest's full token set (238 Figma
variables), but `tokens[]` in the registry only catalogues the ~40 that at
least one of the 10 registered components actually consumes right now
(verified by grepping every component `.css` file for `var(--...)`). A
token with no consumer yet contributes nothing to answer questions 5–7
above, and adding one speculatively would risk documenting a mapping that
was never actually checked against real usage. When a new component is
registered and consumes a previously-uncatalogued token, add that token's
entry the same way: verify its manifest data first, then add it — don't
copy an entry that "looks similar."

### Text styles

`textStyles[]` is a small, separate catalog for the two *composite* text
styles current components actually use (`Body/Medium`, `Caption`). A text
style isn't a single Figma variable — the manifest models it as its own
entity (`tokens.typography.textStyles`) referencing 3–4 atomic variables
(font size, line height, paragraph spacing, font family) together. Each
`textStyles[]` entry lists which atomic `tokenIds` make it up and which
component `id`s consume that combination. Components reference the atomic
CSS variables directly (there is no single `--text-style-body-medium`
custom property) — `textStyles[]` exists purely so the sync engine (and
readers) can recognize "these three tokens always travel together as
Body/Medium" rather than seeing three unrelated dependencies.

## Dependency mapping

Two independent graphs live in the registry:

**Component → token** (`tokenIds` on a component, mirrored by `consumedBy`
on each token/text-style). Directly answers "if this Figma token's value
changes, which components need visual review?"

**Component → component** (`dependsOnComponents`, mirrored by
`usedByComponents`). Every edge has a `relationship`:

- `"renders"` — the component's `.tsx` file literally imports and renders
  the other component (a hard, compile-time dependency; verified by
  grepping `import ... from '../X/X'`). Example: `form-field` **renders**
  `field-label` and `text-field`; `checkbox` **renders**
  `checkbox-control`.
- `"expects-children-of"` — the component is designed to receive instances
  of the other component as `children`, per the manifest's own
  `relationships[]` list (Figma's "contains" data) and how the Storybook
  stories/demo app compose them — but there is **no import-level coupling**
  in the code. Example: `menu` **expects-children-of** `menu-item` (`Menu`
  renders arbitrary `ReactNode` children; it does not import `MenuItem`).

This distinction matters for impact analysis: a breaking change to
`field-label`'s props is a compile error in `form-field` immediately: a
breaking change to `menu-item`'s props only breaks `menu`'s *usages*
(stories, consuming apps), not `menu.tsx` itself. Don't collapse the two
into one relationship type — a future diff engine needs to tell "this will
fail to build" apart from "this will look wrong at runtime."

Every `dependsOnComponents` edge has a matching `usedByComponents` edge on
the target component with the same `relationship`, and vice versa. Keep
them symmetric by construction — add or remove both ends together.

**Transitivity is not pre-computed.** `form-field.tokenIds` lists only the
tokens `FormField.css` itself references directly (the hint row's
Caption/text-caption tokens) — not the tokens `field-label` and
`text-field` also depend on. A consumer that needs "every token that could
visually affect FormField" walks `dependsOnComponents` first, then unions
in each dependency's own `tokenIds`. Pre-computing and storing that union
here would mean two representations of the same fact that could silently
drift apart; walking the graph is cheap and always correct.

## Unresolved and audit findings

Two arrays exist specifically so genuine gaps are visible instead of
silently smoothed over:

- **`unresolved[]`** — a component↔token (or similar) edge exists in code,
  but the specific Figma source for *that exact usage* could not be
  verified against the manifest, even though the token itself is real and
  correctly documented elsewhere. As of this audit there is exactly one:
  `field-label`'s use of `color-text-error` for its required-asterisk
  glyph (the manifest documents the asterisk's size but no color token for
  it). Don't resolve one of these by guessing a plausible-looking Figma
  source — only close it once the manifest is re-extracted with the
  missing data, or the user confirms it directly.
- **`auditFindings[]`** — things this audit discovered that are fully
  understood (not a traceability gap) but weren't fixed, because this
  stage's instructions were audit-only ("do not modify component
  implementation"). Currently one: `font-weight-body` is applied in
  `Button.css` but not in the other five components that also render
  Body/Medium text. Fixing this is a code change, out of scope here — it's
  recorded so it isn't lost.

Both arrays are meant to stay short. If either grows large, that's a signal
the underlying manifest or code needs attention, not that the registry
needs a bigger "known issues" dumping ground.

## Rules for keeping the registry synchronized

1. **The manifest wins for Figma facts.** Never hand-type a `figmaValue`,
   `figmaVariableId`, `aliasChain`, or variant list — copy it from
   `design-system-manifest.json`, and if the manifest doesn't have it,
   the registry doesn't get it either (use `unresolved[]`).
2. **The code wins for code facts.** `tokenIds`, `codePath`, `stylePath`,
   `dependsOnComponents` (the `"renders"` kind) are derived by reading the
   actual `.tsx`/`.css` files (grep for `var(--...)` and `import`
   statements), never assumed from what a component "should" use.
3. **The story files win for Storybook facts.** `storybook.title` and
   `storyIds` are derived from the actual `meta.title` and `export const`
   names in each `.stories.tsx` file (or a running Storybook's
   `/index.json`), never hand-typed from memory.
4. **IDs are permanent once assigned.** Don't rename a component `id` or a
   `tokenId` to make it read better — every rename is a breaking change for
   anything that referenced it (including, eventually, the diff engine's
   history). If a Figma-side name changes, update `figmaName`, not `id`.
5. **One entity, one entry.** Before adding a component, check whether its
   `figmaNodeId` already has an entry (it might be mid-refactor under a
   different `reactName`). Before adding a token, check whether its
   `cssVariable` already exists under a different consumer list.
6. **Every edge is bidirectional.** Adding a `dependsOnComponents` entry
   without its mirrored `usedByComponents` entry (or a `tokenIds` entry
   without appearing in that token's `consumedBy`) is an inconsistent
   registry, not a partially-updated one. Add both sides in the same edit.
7. **When in doubt, use `unresolved[]` or `auditFindings[]`.** A guessed
   mapping is worse than a documented gap — the whole point of this
   registry is that a future diff/sync engine can trust every edge it
   contains without re-deriving it from scratch.

## What this registry does *not* do yet

This is a static snapshot, audited and hand-assembled. It does not:

- Detect when the manifest, code, or Storybook drift from what's recorded
  here (that's the future diff engine).
- Automatically regenerate itself from source (everything above was
  derived by reading the actual files during this audit, then written
  once).
- Cover the four excluded components (`Dropdown`, `Breadcrumb`,
  `Breadcrumb_items`, `.menu item/.scrollbar` — see `excludedFromPoc[]`),
  since none of them have code yet.

Building the engine that keeps this file automatically correct is
explicitly the next stage, not this one.
