---
status: draft
priority: P2
owner: cc-2
created: 2026-06-04
updated: 2026-06-04
related: lazy-like-global-launcher.md, launcher-capture-destinations.md
---

# Launcher AI Actions

## Why this plan exists

Split out of `lazy-like-global-launcher.md`. The launcher shipped with capture +
inline node search + `open-main` / `open-settings` only. The AI entry points were
present **only as disabled "coming soon" placeholders**, which we removed (a
feature appears in the launcher *when it works*, never greyed-out). This plan is
where that AI work actually lands.

Removed in the shipping launcher, to be rebuilt here:

- The `ask-ai` static command "Ask AI without context".
- The `Ask AI with source` secondary action on capture rows (the `SOON_ASK_AI`
  stub) and the `'ask-ai'` action id.

## Goal

From the launcher, the user can start an AI conversation in two ways:

1. **Ask AI (no context)** — a command row; Enter opens an AI session seeded only
   by what the user typed.
2. **Ask AI with this source** — a *secondary action* on a capture row; Enter
   captures the current page/selection **and** opens an AI session seeded with
   that captured source as context.

## Non-goals

- No new AI model/provider plumbing here if the app already has an agent/chat
  surface — this plan wires the launcher *into* it, not the inference layer.
- No background/automatic AI summarization of captures (that's a capture-pipeline
  concern, not a launcher action).
- No multi-turn chat UI inside the launcher window itself — the launcher stays
  light (no editor/markdown/streaming surface). It hands off to the main window's
  AI surface and dismisses.

## Design (to be ratified)

### Entry points

- **Command**: re-add a launcher command (`ask-ai`) titled "Ask AI" (final copy
  TBD). It is added to `getStaticLauncherCommands()` only once it routes to a real
  AI surface — never as a disabled row.
- **Secondary action**: re-add `Ask AI with source` to capture rows' `actions[]`
  as `actions[1+]`. This **requires the ⌘K secondary-action mechanism**, which was
  also removed and is rebuilt in `launcher-capture-destinations.md` — that is a
  hard dependency (A7: foundation before consumers). Land the ⌘K mechanism first,
  then this hangs off it.

### Behavior

- "Ask AI (no context)" → `launcher.executeCommand('ask-ai')` → main opens/focuses
  the AI surface in the main window, pre-filling the typed text as the prompt, and
  hides the launcher.
- "Ask AI with this source" → capture the page (same path as `capture-page`), then
  open the AI surface seeded with the new source node as context. One Enter, two
  effects; the launcher hides on success.

### IPC / contracts

- Likely a new main→renderer channel (mirroring `LAUNCHER_NAVIGATE_TO_NODE_CHANNEL`)
  to focus the main window's AI surface with a seed prompt / seed node id.
- New launcher IPC verb (e.g. `launcher.askAi({ prompt?, sourceNodeId? })`).
- These touch the preload bridge + main IPC (A3-sensitive) — interface-first PR,
  then build.

## Open questions (for the PM)

1. Does an AI conversation surface already exist in the main window to hand off
   to, or does this plan also stand up that surface?
2. Final command copy: "Ask AI" vs "Ask AI without context" vs "New AI chat".
3. For "Ask AI with source", is capture-then-ask the right coupling, or should it
   ask against an *already-captured* source only?

## Subtasks

- [ ] Confirm the main-window AI surface this routes into (Open question 1).
- [ ] Land the ⌘K secondary-action mechanism (dependency — see capture-destinations).
- [ ] Add `ask-ai` command + IPC route → AI surface with seed prompt.
- [ ] Add `Ask AI with source` secondary action (capture + seed-with-source).
- [ ] Tests: model rows/actions; IPC handler; navigation contract.
- [ ] Update `lazy-like-global-launcher.md` As-built + fold design into `spec/`.
