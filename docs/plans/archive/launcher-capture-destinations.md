---
status: superseded
priority: P2
owner: unassigned
created: 2026-06-04
updated: 2026-06-04
related: lazy-like-global-launcher.md, launcher-ai-actions.md, unified-command-surface.md
---

> **Superseded by `unified-command-surface.md` (2026-06-04).** In the ratified
> design Capture is a verb, the destination is a chip-rail target (D4), Go-to is a
> verb (D1), and "more actions" is the WYSIWYG verb list / secondary-action panel
> (D1/D4) — so the standalone launcher-local ⌘K menu this plan rebuilt is replaced.
> The load-bearing contracts (Inbox node resolve/create, the `destination` capture
> IPC param, recent-destinations persistence, navigation via
> `LAUNCHER_NAVIGATE_TO_NODE_CHANNEL`) are folded into
> `unified-command-surface.md` → "Preserved contracts". Kept as history.

# Launcher Capture Destinations, Secondary Actions & Navigation

## Why this plan exists

Split out of `lazy-like-global-launcher.md`. The launcher shipped capturing **only
to Today**, with a single action per row. Everything below was present **only as
disabled "coming soon" placeholders** and was removed — a feature lands in the
launcher when it works, not greyed-out. This plan rebuilds them for real.

Removed in the shipping launcher, to be rebuilt here:

- The **⌘K secondary-action menu** (mechanism) — `menuIndex` state, ⌘K key
  handling, the "Actions ⌘K" button, the `.launcher-kmenu*` styles, and the
  `comingSoon` flag. The `actions: LauncherItemAction[]` array shape was **kept**
  (every row just has one action today), so re-lighting ⌘K is additive.
- `Save to Inbox` secondary action (the `SOON_INBOX` stub, `'save-inbox'` id).
- `Go to Today` command (`open-today`) and the broader navigation set.

## Goal

1. **Secondary actions** return: a row can expose more than its primary action,
   reachable via **⌘K** (and shown in the action bar as "Actions ⌘K").
2. **Capture destinations beyond Today**: "Save to Inbox", and a **destination
   picker** so a capture can land in Today, Inbox, or a chosen node.
3. **Navigation commands**: "Go to Today", "Go to Library", and a **Recent
   destinations** list (most-recent capture/jump targets), all as launcher
   commands or quick rows.

## Non-goals

- No reintroduction of disabled placeholders. Each item ships only when wired.
- No full folder/tag taxonomy here — destinations are existing nodes (Today,
  Inbox, recents, a searched node), not a new organizational system.
- The launcher stays light — the picker is a thin row list, not a tree browser.

## Design (to be ratified)

### 1. ⌘K secondary-action mechanism (the foundation — land first)

Re-add to `LauncherApp.tsx`: `menuIndex` state, ⌘K toggle + menu arrow/Enter
handling, the "Actions ⌘K" action-bar button (rendered only when
`activeItem.actions.length > 1`), and the `.launcher-kmenu` level-1 opaque popover
(B5/B10). The popover anchors bottom-right above the action bar — restore the
`position: relative` anchor on `.launcher` and the `.launcher-kmenu*` styles. This
is the consumer-bearing foundation for both Save-to-Inbox here and
`Ask AI with source` in `launcher-ai-actions.md` (A7).

> History: the original implementation lived in git before removal — see this
> plan's branch base. Rebuild from there rather than from scratch.

### 2. Save to Inbox

A secondary action on capture rows (`actions[1]`): same capture as `capture-page`
/ `capture-note` but the destination node is **Inbox** instead of Today. Needs a
resolved Inbox node id in main (create-if-missing) and a `destination` param on
the capture IPC (`launcher.createContextCapture` / `launcher.createCapture`).

### 3. Destination picker

When the user wants somewhere other than the default: a ⌘K action "Capture to…"
opens a short list — Today, Inbox, recent destinations, then live node-search
matches (reuse the existing `launcher.searchNodes`). Selecting one captures there.
Open question: inline sub-list vs a transient second step.

### 4. Navigation commands + recent destinations

- `open-today` "Go to Today" and `open-library` "Go to Library": commands that
  navigate the main window (reuse `LAUNCHER_NAVIGATE_TO_NODE_CHANNEL` →
  `navigateRoot` + `focusNode`, the same path inline node results already use).
- **Recent destinations**: main remembers the last N capture/navigation targets
  (persisted in `userData`) and surfaces them as quick rows when the query is
  empty — the launcher's "where was I" affordance.

### Contracts touched

- Launcher IPC: `destination` param on capture verbs; possibly `launcher.recents()`.
- Main: resolve/create Inbox; recents persistence; navigation reuses the existing
  node-navigate channel.
- `LauncherCommandId` re-widens to include `open-today` / `open-library` as they
  land. preload + IPC are A3-sensitive → interface-first PR, then build.

## Open questions (for the PM)

1. Is there an existing "Inbox" concept/node, or does this plan define one?
2. Destination picker: inline expanding sub-list under the row, or a transient
   second screen (type-to-filter destinations)?
3. Recent destinations: capture targets only, or capture **and** navigation
   targets in one list?
4. Default capture destination — stay "Today", or make it user-configurable?

## Subtasks

- [ ] Rebuild the ⌘K secondary-action mechanism (foundation).
- [ ] Resolve/create Inbox node in main; add `destination` to capture IPC.
- [ ] "Save to Inbox" secondary action + tests.
- [ ] Destination picker (Today / Inbox / recents / node search).
- [ ] `open-today` / `open-library` navigation commands.
- [ ] Recent-destinations persistence + empty-query rows.
- [ ] Update `lazy-like-global-launcher.md` As-built + fold design into `spec/`.
