# Implementation notes — POC stage 1

Source of truth: `design-system-manifest.json` (extracted 2026-09-20, last re-read
2026-09-21). This file documents every implementation decision that wasn't a
direct, unambiguous transcription of manifest data — per instruction, known
Figma limitations are documented here rather than silently "fixed" or treated
as bugs. Cross-reference: `design-system/registry.json` (`knownLimitations`
per component) and the manifest's own `findings[]` array (F01–F26).

## Architecture-wide decisions

### 1. Interaction states → CSS, not props
Every Figma component set mixes two kinds of variant axis: genuine
interaction states (Hover, Focus, Disabled — and, for menu items, "State")
and genuine design variants (Type, Status meaning selected/unselected,
Link's Active/Disabled). Replicating the interaction-state axis as a
component prop (e.g. `state="hover"`) would fight the browser and make the
components unusable as real interactive controls. Instead:

- **Hover** → CSS `:hover`
- **Focus** → CSS `:focus-visible` (or `:focus-within` for TextField, since
  the visual container isn't the focusable element; `:has(:focus-visible)`
  for CheckboxControl, since the input is visually hidden inside a styled
  wrapper)
- **Disabled** → the native HTML `disabled` attribute wherever the element
  supports one (`<button>`, `<input>`)

Only genuine design-variant axes (Type, Status, Link's Active/Disabled) are
exposed as explicit props, spelled `variant` throughout for consistency.

### 2. `Type` → `variant` prop
Figma's "Type" variant axis (Button, Button_Icon, Field, Link) is exposed as
a `variant` prop, not `type`, because `type` is already the native HTML
attribute on `<button>` and `<input>` (submit/button/reset,
text/email/etc.) and reusing it would collide with real DOM semantics.

### 3. Token naming preserves Figma's own inconsistencies
Per the synchronization requirement, token names are not renamed for
prettiness. This includes keeping Figma's own naming quirks that the
manifest's own findings log (F20) already flags as drift, rather than
"fixing" them during conversion:
- `Brand/Purple/500-Default` → `--brand-purple-500-default` (every other
  500 step across the other five ramps is plain `500`, matching Figma).
- The CSS variable tree mirrors the manifest's documented
  `tokens.collectionChain` exactly: `--color-surface-action` (Mapped) →
  `var(--alias-primary-500)` (Alias) → `var(--brand-purple-500-default)`
  (Brand). Every `aliasOf` relationship recorded in the manifest is
  reproduced as a `var()` reference, not a duplicated literal value.

### 4. Unbound spacing values are left literal, not invented as tokens
The manifest documents that Figma has a numeric `Brand/Scale` ramp but no
semantic spacing collection, and explicitly calls out two raw values with
no matching Scale step: `.menu item`'s 9px gap and `Input`'s 13px column
gap (`tokens.typography.spacing.note`). Rather than invent a fake token for
these (which would misrepresent what actually exists in Figma), MenuItem.css
and FormField.css use the literal `9px` / `13px` values with a comment
pointing back to that manifest note.

### 5. Icons are consumer-supplied `ReactNode`, not bundled assets
The manifest notes actual SVG icon paths could not be captured (temporary
local asset URLs only). Every icon slot across all 10 components accepts a
plain `ReactNode`, so any icon source can be plugged in later. The demo app
(`src/App.tsx`, `src/demo-icons.tsx`) uses generic placeholder glyphs purely
to exercise the icon slots — they are not claimed to be pixel-accurate
reproductions of the Figma icons, and are not exported from `src/index.ts`.

### 6. Focus rings approximated via `outline` + `outline-offset`
Figma expresses focus rings as a stroke with a negative "inset" (e.g. Button:
`Border/focus`, width `Border width/md`, inset `-3`). CSS has no identical
concept; each ring is implemented as `outline: <width> solid <color>` with
an `outline-offset` chosen to visually match the stated inset magnitude.
Colors and widths are always the exact token values; only the geometric
mapping (inset → offset) is an approximation.

## Per-component decisions

**FieldLabel** (`Label`, 17:50) — Manifest finding **F02** notes that
Label's "Property 1" variant axis is not actually an interaction state like
Button/Button_Icon's — Label has exactly one variant, "Required", and it's
really driven by the separate `required` boolean property. Implemented as a
plain `required?: boolean` prop, no variant enum. Separately: the required
asterisk has no color token anywhere in the manifest (`icons[]` lists it
with size only, no token). `--color-text-error` is used as a reasonable
default for a required-field marker; this is an inferred value, not a
manifest value.

**TextField** (`Field`, 18:130) — Figma's `label` component property is
placeholder text shown inside the field, not an associated `<label>`
element (the real label is the separate Label/FieldLabel component,
composed by Input/FormField). Renamed to `placeholder` in React to avoid
confusion with accessible-label semantics.

**FormField** (`Input`, 18:256) — Figma's "Type" variant (Default/email) was
two fixed content presets (different label text, icon, and placeholder).
Hardcoding two presets would not be a reusable component, so this is
generalized: label, placeholder, and leading icon are ordinary props, and
`type` maps directly to the native `<input type>` attribute. FormField also
preserves the manifest-documented fact that Input hardcodes its nested
Field to `Status=Default, Type=Default` — no `variant` prop is forwarded to
the nested TextField.

**CheckboxControl** (`.Checkbox item`, 19:667) — Manifest finding **F05**:
no Selected variant has a check-glyph layer anywhere in Figma. A checkmark
SVG was added in code (visible via `color`/`currentColor` when `:checked`)
so the control is legible when selected — an addition, not a value taken
from Figma. Separately, the manifest records that two variants (Unselected
Default 19:666, Unselected hover 19:669) intentionally have no bound
border-width variable in Figma, confirmed by the user as by-design; these
are implemented at `Border width/sm` like the other 6 variants, per the
manifest's own recommendation (`borderWidthVerification` note on that
component). State styling uses the CSS `:has()` selector, which requires a
modern evergreen browser — acceptable for a POC, worth flagging if older
browser support becomes a requirement.

**MenuItem** (`.menu item`, 18:315) — Manifest finding **F11**: Figma
defines no focus state for this component. Since MenuItem renders as a real
`<button role="menuitem">`, a `:focus-visible` outline using the same
`Border/focus` token used elsewhere was added for keyboard accessibility —
this is an addition beyond the Figma spec, clearly separated in the CSS
comment from the token-sourced styles above it. Separately, Figma measured
a fixed 270px label width inside a 323px-wide item; the React label uses
`flex: 1` instead so the component isn't locked to that exact container
width.

**Menu** (18:384) — Figma measured this component at a fixed 323px width;
the React version defaults to 100% width (`max-width: 323px`) so it can be
reused in other layouts. The `.menu item/.scrollbar` sub-component and the
`scrollbar` boolean property are out of scope for this POC (not one of the
10 approved components); native `overflow-y: auto` is used instead.

**Link** (18:503) — Manifest finding **F12**: Code Connect maps this
component's trailing icon to `IconArrowUpRight` with `size="48"` onto what
is actually a 20px icon slot in the layout. Reproducing that mismatch would
visually break the component, so the icon slot is sized at the correct 20px
in code; the 48px Code Connect mapping is treated as a Figma-side data
quality issue, not a value to copy. Separately: "Active" and "Disabled" are
kept as explicit `variant` values rather than CSS states, because an anchor
has no native equivalent for either (`:active` in CSS means "currently
being clicked," a different concept from Figma's "Active" meaning
"current/selected page"; there is no native `disabled` attribute on `<a>`).
`variant="disabled"` is implemented via `aria-disabled`, `tabIndex={-1}`,
a withheld `href`, and `pointer-events: none`.

## Deliberately out of scope for this stage
- **Dropdown** (18:473) and **Breadcrumb / Breadcrumb_items** (18:639 /
  18:545) — excluded per the approved component list; see
  `design-system/registry.json`'s `excludedFromPoc` for the reasoning
  carried over from the proposal stage.
- **`.menu item/.scrollbar`** (18:387) — not one of the 10 approved
  components.
- Storybook, the Figma↔code sync engine, and GitHub automation — explicitly
  deferred per this stage's instructions.

## Build verification
`npx tsc --noEmit` and `npm run build` (which runs the same typecheck, then
`vite build`) both completed with zero errors against this implementation.
No changes were made to `design-system-manifest.json` to achieve this.
