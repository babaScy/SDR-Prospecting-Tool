# Visual refresh — design

## Problem

The app works (pull → qualify → review → assign), but looks bare-bones: plain
panels, raw `<select>`/`<table>` styling, text-and-emoji buttons ("✓ Accept",
"✕ Reject"), a plain `<h1>` topbar. Now that roles and the table view are
built, it's worth a visual pass to make it feel like a real internal tool
before wider team rollout.

## Goals

1. A cohesive, polished dark visual system — purple/indigo-forward, inspired
   by (not copied from) WOLF+'s brand, since this is a sibling Scytale
   product.
2. Small SVG icons replacing today's text/emoji action buttons and sort
   indicators.
3. Per-screen polish: better empty/loading states, clearer stat/summary
   presentation, a proper segmented control for the Table/Card toggle.
4. Zero behavior change — no new routes, no changed data flow, no new props
   beyond what rendering icons requires. Purely how things look.

## Non-goals

- No workflow/interaction changes (confirmed: the pain point is visual, not
  functional) — every click-path, filter, and API call stays exactly as-is.
- No new npm dependencies — icons are hand-written inline SVGs in one shared
  file, not an icon library; font is a Google Fonts `@import`, not a package.
- No reuse of WOLF+'s actual logo asset or exact hex values — "inspired, not
  identical" per your call.
- No responsive/mobile layout work — this is an internal desktop tool, same
  assumption the app already makes today.
- No dark/light theme toggle — dark-only, matching today.

## Design tokens (`frontend/src/styles.css`)

Replace the existing `:root` variables with a fuller palette:

```
--bg:         #0d0e14   (page background)
--panel:      #171922   (cards/panels)
--panel-2:    #1f222e   (hover/nested surfaces, inputs)
--border:     #2a2d3a
--text:       #e8e9ee
--muted:      #8b8fa3
--primary:    #7c6fee   (indigo-violet accent)
--primary-dk: #6355d1   (hover/active state)
--pink:       #e2588a   (secondary accent, sparingly — e.g. gradient mark)
--green:      #34d399   (qualified / accepted / success)
--red:        #f87171   (disqualified / rejected / danger)
--amber:      #fbbf24   (nei / pending / warning)
```

Font: `@import` Google Fonts **Inter** (400/500/600/700), replacing the
current system-font stack, with the system stack kept as fallback. Spacing
stays on the existing 4/8/12/16/20/24px rhythm; panel radius moves from 12px
to 14px, buttons/inputs to 10px, for a slightly softer feel.

## Icons (`frontend/src/icons.jsx`, new)

One file exporting ~8 small stateless components, each a single inline
`<svg>` (20px, `currentColor` stroke, no fill) so they inherit button/text
color automatically:

`IconCheck`, `IconX`, `IconUndo`, `IconChevronUp`, `IconChevronDown`,
`IconArrowLeft`, `IconTable`, `IconCards`.

Each takes no props beyond standard `className`/`style` passthrough — they're
purely presentational, no logic.

## Per-screen changes

**`App.jsx` (topbar)** — replace the plain `<h1>Prospector</h1>` with a small
wordmark: a 22px rounded-square gradient mark (`--primary` → `--pink`,
CSS-only, no image asset) next to "Prospector" in Inter 600. Nav buttons
become pill-shaped with subtle active-state background (already close to
today's style, refined radius/spacing). User chip becomes a compact rounded
pill: initials-avatar circle (first letter of the email's local part,
background tinted by role — indigo for admin, a muted tone for SDR) + email +
role text, with "Switch" as a small icon+text ghost button reusing
`IconUndo` (a "start over" glyph reads fine for "switch identity" — no 9th
icon needed).

**`UserPicker.jsx`** — same centered-card layout, but each row becomes a
clickable card (not just a radio + label) with a colored initials circle,
email, and role badge; selected state gets a `--primary` border/glow.
"Continue" becomes a full-width primary button.

**`PullScreen.jsx`** — form row spacing/alignment refined (no field changes).
The active-pull panel gets a real animated progress bar (width from
`pulledCount/requestedCount` where known, indeterminate striped animation
while `pulling`/`qualifying` and count is 0) plus a status pill using the
existing badge classes with the refreshed palette. Progress log keeps its
monospace treatment, refined padding/border.

**`ListsScreen.jsx`** — the totals strip becomes distinct stat cards (icon +
colored number + label) instead of plain flex numbers; icons are simple
colored dots/shapes per metric, not one of the 8 action icons (keeps the icon
set small and purposeful). Table rows get a clearer hover state and the
status column uses refreshed pill badges. Empty state ("No lists yet — run a
pull first") gets a small icon + the existing copy, centered.

**`ListDetailScreen.jsx`** — Table/Card toggle becomes a proper two-segment
control (single rounded container, active segment filled) using `IconTable`
and `IconCards`, replacing the current two separate buttons.

**`ListTable.jsx`** — Accept/Reject/Undo buttons gain `IconCheck`/`IconX`/
`IconUndo` alongside their existing labels. Column-header sort indicators
switch from literal `▲`/`▼` characters to `IconChevronUp`/`IconChevronDown`.
Filter `<select>`s get the refreshed input styling from the token update
(no structural change).

**`ReviewScreen.jsx`** — progress bar restyled with the new palette/radius.
Accept/Reject buttons gain `IconCheck`/`IconX` next to their text (keeping
size/prominence — these are the primary action of the whole screen). "Undo
last" gains `IconUndo`. The "Review complete 🎉" panel keeps its friendly
tone but gets a cleaner stat-card layout matching `ListsScreen`'s new stat
cards, for visual consistency between the two "you're done" moments.

**`LeadCard.jsx`** — header row (name, domain link, verdict badge, tier
badge) gets tighter alignment; the reasoning block becomes a more clearly
styled callout (refined left-border/background treatment already present,
just restyled with new tokens); the signal grid keeps its current
label/value structure — no new icons per signal (avoids diluting the icon set
down to decoration).

## Testing

No functional/logic changes, so no new automated tests. Verification is
visual: manual browser check per screen (topbar, picker, pull, lists +
summary, list table with filters/sort/actions, card review, empty states)
against the same isolated temp-server approach used for prior features,
confirming no console errors and that every existing interaction (accept/
reject/undo, toggle, sort, filter, switch-user) still works — only the
presentation changes.
