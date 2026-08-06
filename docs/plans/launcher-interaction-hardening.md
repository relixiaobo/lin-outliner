# Launcher Interaction Hardening

## Goal

Fix the shipped global launcher's interaction defects and its footer
presentation — the things users hit today, on the surface they use today —
without pre-building anything `unified-command-surface.md` PR 2 owns.

Source: the 2026-08-06 systematic launcher review (main agent). The defects:

1. **P0 — no IME composition guard.** `LauncherApp.onKeyDown`
   (`src/renderer/launcher/LauncherApp.tsx:170-189`) handles Escape / arrows /
   Enter with no composition check. Committing a pinyin candidate with Enter
   fires the active row's action (captures half-typed text, or runs *Open main
   window* and dismisses the launcher); arrowing through IME candidates also
   moves the row selection; Escape during composition hides the window. The
   in-app palette already guards via `isImeComposingEvent`
   (`src/renderer/ui/CommandPalette.tsx:206`); the launcher never adopted it.
2. **P1 — show→context race.** The capture context arrives *after* the window
   takes focus (`showLauncherWindow` awaits only `getFrontmostApp`; the tab read
   finishes later and is pushed over `LAUNCHER_CONTEXT_CHANNEL`,
   `src/main/main.ts:1725-1755`). Until it lands, the top row is *Open main
   window* — so the spec's own golden path, hotkey → Enter, can open the main
   window instead of capturing the page the user was looking at.
3. **P1 — dev-only error copy ships to users.** Any exception in the capture IPC
   surfaces `saveFailedRestart` — "restart the dev app (main process does not
   hot-reload)" — in packaged builds too (`LauncherApp.tsx:161`).
4. **P2 — error/busy state rendered inside the primary button.**
   `primaryLabel = busy ? saving : error ?? label` (`LauncherApp.tsx:191`): the
   error text replaces the action hint inside a clickable button, with no status
   styling and no visible retry affordance.
5. **P2 — footer reads as a stray button.** The footer's only content is a
   bottom-right button restating the selected row's full title (`run-command`
   rows use `command.title` verbatim, `launcherModel.ts:139`), so the list says
   *Open main window* and the button repeats *Open main window*. Raycast's
   footer is a slim hint bar: identity on the left, "verb ↵" hints on the right.
6. **P3 — row clicks steal focus from the always-focused input.** Rows lack the
   `onMouseDown` preventDefault the footer button has; on the error path the
   input is left unfocused.
7. **P3 — the empty state is unreachable.** A non-empty query always synthesizes
   a capture-note row and an empty query always lists the two static commands,
   so `navItems.length === 0` never holds and the `emptyState` string is dead.

**Shape (a): ONE complete feature in one PR** — a correctness-and-presentation
pass on the existing launcher renderer. Internal ordering below is build order,
not separate releases.

## Non-goals

- **Nothing `unified-command-surface` PR 2 owns.** No idle-content rows
  (Go to Today / recents), no section headers, no `Actions ⌘K`, no chip, no
  object model, and no changes to the in-app `CommandPalette.tsx` (PR 2 deletes
  it). Its D3 empty-query object list is the real fix for the launcher's empty
  look; nothing here anticipates it.
- **No IPC / protocol changes.** The race mitigation is renderer-only and
  explicitly interim; PR 2's invocation + pending-ambient-slot model is the
  authoritative fix and deletes it.
- No capture-semantics, provider, or hotkey-registration changes.
- No hotkey display in the launcher footer — inside the launcher the hotkey has
  no discovery value (the user just pressed it). Hotkey visibility lives in
  `command-surface-discoverability.md`.

## Design

### D1 — IME composition guard

Adopt the palette's guard verbatim at the top of `onKeyDown`:

```ts
if (isImeComposingEvent(event)) return;
```

- Import `isImeComposingEvent` from `../ui/interactions/imeKeyboard` (the helper
  is DOM-free; the launcher bundle stays editor-free — verify nothing heavier
  rides in via that module's imports; it has none today).
- Pass the React synthetic event exactly as `CommandPalette.tsx` does — the
  helper's `key === 'Process'` / `keyCode === 229` fallbacks are what fire for
  synthetics.
- Behavior: while composing, Enter/arrows/Escape belong to the IME. Escape
  therefore does NOT hide the window mid-composition (matches the palette's
  intent); a second Escape after composition ends still hides.

### D2 — Interim guard for the show→context race

Renderer-only, and deliberately minimal:

- Track `contextPending`: set `true` on `onShown`, cleared by the first
  `onContext` for that open. Hold a promise (resolved by `onContext`) in a ref.
- On Enter **with an empty trimmed query** while `contextPending`: await
  `Promise.race([contextArrival, timeout(600ms)])`, then re-derive the current
  top row (from latest state, not the stale closure) and run it. The footer
  status zone (D3) shows a `capturing` hint while waiting; the wait is
  single-shot and re-entrancy stays behind the existing `runningRef`.
- Non-empty-query Enter does not wait: typed text always has a valid immediate
  action (capture-note), and delaying every Enter would punish the common typing
  path to cover a rarer ambiguity.
- If the wait times out (capture failed or is genuinely slow), run the top row
  as-is — identical to today's behavior, never a dead Enter (A12).
- Mark the block with a comment naming `unified-command-surface` PR 2 as its
  replacement, so the PR 2 sweep deletes it with the rest of the model.

### D3 — Error copy and error/busy presentation

- **Copy:** delete `saveFailedRestart` (en + zh-Hans). Both capture failure
  branches show the generic `saveFailed`; log the exception detail to the
  renderer console for the dev loop instead.
- **Presentation:** the footer gains a left-aligned status zone,
  `<span class="launcher-actionbar-status" role="status">`, which carries busy
  ("Saving…", new "Capturing…" from D2) and error text. Error text uses
  `--status-danger` (status color carrying status meaning — B4-compliant) at
  meta size; busy text stays `--text-secondary`.
- The right-side primary hint always shows the action label — never an error,
  never "Saving…". It is disabled while busy (unchanged).
- Errors still clear on the next query/selection change (existing behavior);
  Enter with the error showing retries the action (existing behavior, now
  legible).

### D4 — Footer: hint cluster, not a restated button

Keep the ratified divider-free, whitespace-separated footer (B-clean). Change
what is in it:

- **Left:** the status zone from D3. When idle, it shows the app identity — the
  `APP_NAME` wordmark at meta size, `--text-tertiary` (Raycast puts its mark
  here; it also visually anchors the bar so the right cluster stops floating
  alone).
- **Right:** the primary hint keeps its ghost-button behavior (click = Enter,
  mousedown-preventDefault) but is styled as a hint: `--font-meta` size,
  `--text-secondary`, tightened padding (drop the `--control-size-md`
  min-height bulk), label then `↵` kbd chip. No fill at rest (already ghost);
  hover keeps the existing quiet `--fill-2`.
- **Labels become verbs.** `run-command` rows stop using `command.title` as the
  action label (`launcherModel.ts:139`): use the existing
  `t.launcher.actions.open` ("Open") — both static commands are surface-opens,
  and the row title already names the target. Capture rows keep their
  descriptive labels ("Capture page to Today", "New node in Today") — there the
  label IS the information.
- CSS work stays in `launcher.css` (`.launcher-actionbar*`); the in-app
  palette's `.command-action-bar` is untouched (PR 2 deletes that surface).

### D5 — Row clicks keep the input focused

Add `onMouseDown={(e) => e.preventDefault()}` to `LauncherRow`, matching the
footer button, so a click never blurs the always-focused input (visible on the
capture-error path, where the launcher stays open).

### D6 — Remove the unreachable empty state

Delete the `navItems.length === 0` branch, the `launcher-empty` CSS block, and
the `emptyState` string (en + zh-Hans). Rationale in Goal item 7; PR 2's
empty-query object list keeps the list non-empty by construction too, so this
is not a state the next surface reintroduces.

### Spec updates (A6, same PR)

`docs/spec/launcher.md`:

- "The modeless model": document the IME guard (composition keys never drive
  the launcher) and the row/footer mousedown focus-retention rule.
- "Show sequence" / "Inline node search": document the interim empty-query
  Enter wait (marked interim, owned by this plan, deleted by
  `unified-command-surface` PR 2).
- "Commands": note the action-label rule (command rows use the generic verb;
  the footer never restates the row title) and the footer structure (left
  status/identity zone, right primary hint).
- Remove the empty-state sentence if present.

### Collision check (run at claim time, 2026-08-06 snapshot)

Open PRs: #494 (`cc-2/whats-new-user-notes`) — no file overlap. The two
`unified-command-surface` implementation PRs are unclaimed; PR 2 rewrites this
renderer wholesale. **Merge order:** this PR is small and lands first; PR 2
rebases over it trivially (its rewrite wins conflicts). If PR 2 is already in
flight when this is claimed, coordinate on the PR threads before starting.
`command-surface-discoverability.md` touches the tail of `launcherModel.ts`
(relocating `formatHotkey`) and the i18n message files — disjoint regions;
land this PR first.

## Verification

- `bun run typecheck`; extend `tests/renderer/launcherApp.test.tsx`:
  - composing keydown (`keyCode: 229` / `key: 'Process'`) for Enter, arrows,
    and Escape → no action fired, selection unmoved, no hide call;
  - empty-query Enter while context pending → action deferred until the context
    resolves (fake timers), and runs the capture row, not the command row;
    timeout path runs the current top row;
  - capture failure → status zone shows `saveFailed`, primary hint still shows
    the action label;
  - `run-command` primary label is the verb, not the command title.
- Update `tests/renderer/launcherModel.test.ts` for the label change.
- Manual (dev run, `bun run dev:<clone>`): pinyin composition Enter/arrow/Esc;
  hotkey → immediate Enter over a browser page captures the page; light + dark
  footer check (visual verification at the gate).

## Open questions

None — reversible presentation details (exact spacing, wordmark vs. glyph) are
the implementer's call under the design-system tokens.
