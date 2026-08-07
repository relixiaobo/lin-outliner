# Launcher Hardening & Discoverability

## Goal

One usability pass on the *shipped* command surface: fix the launcher's
interaction defects, bring its footer onto the ratified visual language, and
make the surface reachable without keyboard-only knowledge — without
pre-building anything `unified-command-surface.md` PR 2 owns. The presentation
authority is that plan's **D6a**; this PR implements it early on the current
surface so PR 2 inherits the CSS.

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
4. **P1 — the surface is keyboard-only knowledge.** The in-app palette hangs off
   `⌘K` with no visible entry point; the launcher's global hotkey is displayed
   nowhere (`launcher:getInitialState().hotkey` is delivered and never
   rendered); if both candidate accelerators are taken, registration fails
   silently and the launcher is unreachable with zero indication. Search is
   fused into these surfaces, so a mouse-first user cannot discover search at
   all (PM-raised).
5. **P2 — error/busy state rendered inside the primary button.**
   `primaryLabel = busy ? saving : error ?? label` (`LauncherApp.tsx:191`): the
   error text replaces the action hint inside a clickable button, with no status
   styling and no visible retry affordance.
6. **P2 — footer reads as a stray button.** The footer's only content is a
   bottom-right button restating the selected row's full title (`run-command`
   rows use `command.title` verbatim, `launcherModel.ts:139`), so the list says
   *Open main window* and the button repeats *Open main window*.
7. **P3 — row clicks steal focus from the always-focused input.** Rows lack the
   `onMouseDown` preventDefault the footer button has; on the error path the
   input is left unfocused.
8. **P3 — the empty state is unreachable.** A non-empty query always synthesizes
   a capture-note row and an empty query always lists the two static commands,
   so `navItems.length === 0` never holds and the `emptyState` string is dead.

**Shape (a): ONE complete feature in one PR.** All of it is renderer/settings
work plus one read-only IPC; internal ordering below is build order, not
separate releases. (Merged from the earlier `launcher-interaction-hardening` +
`command-surface-discoverability` drafts, PM-directed 2026-08-06 — one PR
removes their shared-file choreography and the two-step `formatHotkey` move.)

## Non-goals

- **Nothing `unified-command-surface` PR 2 owns.** No idle-content rows, no
  section headers, no `Actions ⌘K`, no chip, no object model, and no changes to
  the in-app `CommandPalette.tsx` (PR 2 deletes it). Its D3/D6 empty-query
  object list is the real fix for the launcher's empty look; nothing here
  anticipates it.
- **No mutation-protocol changes.** The one IPC addition is a read-only
  hotkey getter; the race mitigation is renderer-only and explicitly interim
  (PR 2's invocation + pending-ambient-slot model is the authoritative fix and
  deletes it).
- No capture-semantics, provider, or hotkey-registration changes; no shortcut
  customization UI; no menu-bar/tray affordance.

## Design

### D1 — IME composition guard

Adopt the palette's guard verbatim at the top of `onKeyDown`:

```ts
if (isImeComposingEvent(event)) return;
```

- Import `isImeComposingEvent` from `../ui/interactions/imeKeyboard` (the helper
  is DOM-free; the launcher bundle stays editor-free — it has no imports).
- Pass the React synthetic event exactly as `CommandPalette.tsx` does — the
  helper's `key === 'Process'` / `keyCode === 229` fallbacks are what fire for
  synthetics.
- Behavior: while composing, Enter/arrows/Escape belong to the IME. Escape
  therefore does NOT hide the window mid-composition; a second Escape after
  composition ends still hides.

### D2 — WITHDRAWN: no renderer-side guard for the show→context race

*Withdrawn 2026-08-07 after the `/code-review high` gate on PR #497. Recorded
rather than deleted, because the reasoning is what stops it being re-proposed.*

The plan called for a bounded renderer-side wait: an empty-query Enter would hold
up to 600 ms for the in-flight capture, then act on the current top row. It was
built, and the review found **five** correctness defects in it, all from one
cause — an async continuation with no identity and no cancellation. During the
wait the user can dismiss the launcher, click a different row, toggle it off and
on, or keep typing; the continuation observes none of that and resumes anyway. It
fired actions the user had cancelled, ran a second action alongside a clicked
row, acted on a *later* open's pre-context list, and captured half-typed text.

Making it correct needs an open-generation token captured before the await and
revalidated after, plus routing every other action path through the same guard —
which is a small, badly-placed copy of the invocation lifecycle
`unified-command-surface` PR 2 introduces properly. Paying that cost for a
mitigation that PR 2 deletes is a bad trade, so the race stays open and stays
PR 2's to close (its D6a). `docs/spec/launcher.md` records it as a known gap.

**Enter is therefore synchronous, as it shipped.** The rest of this plan is
unaffected: D2 was the only element that introduced asynchrony.

### D3 — Error copy and error/busy presentation

- **Copy:** delete `saveFailedRestart` (en + zh-Hans). Both capture failure
  branches show the generic `saveFailed`; log the exception detail to the
  renderer console for the dev loop instead.
- **Presentation:** the footer gains a left-aligned status zone which carries busy
  ("Saving…") and error text. Error text uses
  `--status-danger` (status color carrying status meaning — B4-compliant) at
  meta size; busy text stays `--text-secondary`.
- The right-side primary hint always shows the action label — never an error,
  never "Saving…". It is disabled while busy (unchanged).
- Errors still clear on the next query/selection change (existing behavior);
  Enter with the error showing retries the action (existing behavior, now
  legible).

### D4 — Footer: hint cluster, not a restated button

**The visual authority is `unified-command-surface.md` D6a** — this plan
implements that bar anatomy early on the shipped surface, in the same
`launcher.css` classes and tokens, so PR 2 inherits the CSS and rewrites only
JSX. Keep the ratified divider-free, whitespace-separated footer (B-clean).
Change what is in it:

- **Left — identity + status (D6a):** at rest, the `APP_NAME` mark plus the
  formatted summon hotkey (`formatHotkey(state.hotkey)` — the value
  `getInitialState` already delivers and nothing renders today) at `--font-meta`
  in `--text-tertiary`; it teaches the keystroke to users who arrive by mouse
  through the sidebar Search row (D7). During execution the zone carries the
  D3 status (busy, then error). `formatHotkey` is used from its new core home
  (D8 moves it in this same PR).
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
the `emptyState` string (en + zh-Hans). Rationale in Goal item 8; PR 2's
empty-query object list keeps the list non-empty by construction too, so this
is not a state the next surface reintroduces.

### D7 — Sidebar Search entry

- **Placement:** first row of the primary nav group, above Today
  (`primaryNavItems`, `src/renderer/ui/Sidebar.tsx:32-37`). Search is the
  universal entry point (Notion/Linear convention: topmost). Note
  `primaryNavItems` maps keys to `navTargets` node ids — Search is an *action*,
  not a nav target, so render it as its own row above the mapped loop rather
  than forcing a pseudo-target into the record.
- **Row anatomy:** existing sidebar-row primitive + `SearchIcon`
  (`src/renderer/ui/icons.ts` already exports it), label from new
  `t.shell.sidebar.search` (en "Search", zh-Hans "搜索"), and a right-aligned
  shortcut hint.
- **Shortcut hint:** derived from the shortcut registry, never hardcoded —
  format the first binding of `global.command_palette`
  (`shortcutRegistry.ts:139`, `binding('k', { mod: true })` → `⌘K` on macOS).
  If the registry already has a display formatter, reuse it; otherwise add a
  small formatter next to the registry (mod → `⌘`, shift → `⇧`, alt → `⌥`,
  key uppercased) so future rebinds flow through. Rendered as quiet meta text
  (`--text-tertiary`, `--font-meta`), always visible — visibility is the
  point. Not a `.kbd` chip box: sidebar rows keep their flat look; the chip
  treatment stays in overlays.
- **Wiring:** `App.tsx` owns the palette state (`setCommandOpen(true)` on
  `global.command_palette`, `useWorkspaceKeyboard.ts:220-224`). Thread one new
  callback `onOpenSearch` into `Sidebar` alongside `onOpenSettings` and route
  the row through it. **Single call site is a requirement:** when
  `unified-command-surface` PR 2 retires `⌘K` and deletes the palette, this
  row retargets to the panel summon and the hint re-derives from whatever
  binding remains — a two-line change recorded in that plan's step 12 sweep.
- **A11y:** same semantics as the other nav rows (button, focus-visible ring);
  the hint is `aria-hidden` (the row's accessible name stays "Search").

### D8 — Settings shows the global launcher hotkey

- **Data path:** main already holds the winner in `launcherHotkeyAccelerator`
  (`src/main/main.ts:1671`, set at `main.ts:4076-4077`, `null` when both
  candidates were taken). Expose it read-only to the settings renderer the same
  way the General pane reads theme state (`window.lin.*`,
  `SettingsGeneralSection.tsx:49-68`): a preload method
  `getLauncherHotkey(): Promise<string | null>` over a new
  `ipcMain.handle('lin:launcher-hotkey')`. Read-only, no args, no secrets —
  keep the preload surface minimal and typed like its neighbors.
- **Rendering:** a "Global launcher" row in `SettingsGeneralSection.tsx`:
  - registered → the formatted accelerator, e.g. `⌘⇧␣`, via `formatHotkey`;
  - `null` → quiet warning copy (en: "Not available — the candidate shortcuts
    are in use by other apps. Quit the conflicting app and relaunch Tenon.";
    zh-Hans equivalent), `--text-secondary` with a status icon, not a red
    banner (informational, not destructive).
- **`formatHotkey` moves to core, once.** It lives unused-by-UI in
  `src/renderer/launcher/launcherModel.ts:268` (exported + unit-tested). Move
  it to `src/core/launcher/commands.ts` next to the channel/view types; the
  launcher footer (D4) and the settings row both import the core home; move
  its test block from `launcherModel.test.ts` into the core test suite.
  (`src/core/launcher/commands.ts` is launcher-IPC shared surface, not the
  A4-protected document protocol — still, it's an additive pure function;
  note it in the PR body.)
- i18n: new strings in both `en.ts` and `zh-Hans.ts` (sidebar label, settings
  row label, value fallback, warning copy).

### Spec updates (A6, same PR)

`docs/spec/launcher.md`:

- "The modeless model": document the IME guard (composition keys never drive
  the launcher) and the row/footer mousedown focus-retention rule.
- "Show sequence" / "Inline node search": document the interim empty-query
  Enter wait (marked interim, owned by this plan, deleted by
  `unified-command-surface` PR 2).
- "Commands": the action-label rule (command rows use the generic verb; the
  footer never restates the row title) and the footer structure (left
  identity/status zone, right primary hint).
- "Hotkey": the registered accelerator is surfaced in the launcher footer and
  Settings → General, including the registration-failure state.
- Remove the empty-state sentence if present.

`docs/spec/workspace-layout.md` (sidebar section): the Search row, its
position, and the registry-derived hint.

### Collision check (run at claim time, 2026-08-06 snapshot)

Open PRs: #494 (`cc-2/whats-new-user-notes`) — no file overlap. The two
`unified-command-surface` implementation PRs are unclaimed; PR 2 rewrites the
launcher renderer wholesale and retargets the sidebar row. **Merge order:**
this PR is small and lands first; PR 2 rebases over it (its rewrite wins
conflicts). If PR 2 is already in flight when this is claimed, coordinate on
the PR threads before starting.

## Verification

- `bun run typecheck`; extend `tests/renderer/launcherApp.test.tsx`:
  - composing keydown (`keyCode: 229` / `key: 'Process'`) for Enter, arrows,
    and Escape → no action fired, selection unmoved, no hide call;
  - Enter is synchronous: it runs the row that is showing, and a context
    arriving afterwards never retro-fires a second action (D2 withdrawn);
  - capture failure → status zone shows `saveFailed`, primary hint still shows
    the action label;
  - `run-command` primary label is the verb, not the command title;
  - the idle footer renders the app mark + the formatted hotkey from
    `getInitialState().hotkey`, and renders no hotkey when it is `null`.
- Update `tests/renderer/launcherModel.test.ts` for the label change; move the
  `formatHotkey` cases to the core suite unchanged.
- Sidebar/settings renderer tests:
  - Sidebar renders the Search row first with the registry-derived hint text
    (assert it changes when the registry binding is stubbed differently — the
    no-hardcoding guard);
  - clicking the row fires `onOpenSearch`;
  - settings General row renders the formatted hotkey, and the warning state
    when the IPC returns `null`.
- Manual (dev run, `bun run dev:<clone>`): pinyin composition Enter/arrow/Esc;
  hotkey → immediate Enter over a browser page captures the page; sidebar row
  opens the palette; Settings shows the hotkey, and the warning state with
  `LIN_LAUNCHER_HOTKEY` set to a taken accelerator. Light + dark visual
  verification at the gate.

## Open questions

None — reversible presentation details (exact spacing, wordmark vs. glyph,
settings-row placement) are the implementer's call under the design-system
tokens.
