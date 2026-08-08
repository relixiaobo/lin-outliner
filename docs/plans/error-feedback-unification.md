# Error Feedback Unification

One notification surface for "the thing you just did failed", in territory no
feature owns — and a stated rule for what does NOT belong there, so the next
error someone adds lands in the right layer without redesigning this.

Ratified by the PM 2026-08-08 from the usage-scenario walkthrough. Position
(window top-center) is the PM's call after weighing bottom-center and the
top-right convention; the deciding constraint is that the right edge belongs to
the agent dock, so any right-anchored toast reads as the agent failing — which
is the misattribution that was reported.

## Goal

From the user's perspective:

1. **One place means "that didn't work".** Every transient failure of a
   user-initiated action — an outliner command, a palette command, a file/pane
   operation, an agent dock action — appears as one toast at the **window
   top-center**, regardless of where the action happened. The position is fixed
   (window-relative, not canvas-relative), so it never moves when the dock
   opens or closes, and it sits over no feature's controls-territory.
2. **It behaves like feedback, not like a lodged state.** It auto-dismisses
   (~6s), stays while hovered, and can be dismissed by its close control. The
   current toast never leaves until manually closed — an event rendered as a
   permanent fixture.
3. **Errors that are not events stay where they are.** A failed Turn, tool row,
   delegation row, or automation run is part of the record and renders in the
   record. A provider that is not configured, a thread list that failed to
   load, are conditions of a surface and stay in that surface (the dock).
   Field validation stays beside its field. The Settings window keeps its
   inline errors.

The classifying sentence, recorded in the spec: **the result of one action is a
notification; a condition that persists belongs to the surface it describes; a
part of a record belongs in the record.**

## Non-goals

- No queueing/stacking. Single slot; a newer error replaces the older one. At
  this app's error volume a queue is over-engineering.
- No structured source labels ("Outliner: rename failed"). Scenario analysis
  showed toast traffic is overwhelmingly the action the user just performed —
  the source is self-evident; the rare background message names its subject in
  the message text itself.
- No OS Notification Center integration. True background events (automation
  finished while writing) are the genre the macOS top-right convention belongs
  to; today that traffic is ~zero. When it materializes, native system
  notifications are the answer — noted here so the intent survives.
- No change to content-layer error rendering (failed Turns, tool rows,
  delegation rows, automation runs) or to Settings-window inline errors.

## Shape

Shape **(a): one complete feature in one PR.**

## Collision result

Checked 2026-08-08. Open PR #505 (`cc-2/unified-command-surface-pr2`) deletes
`CommandPalette.tsx` and touches its consumers (`App.tsx` among them) plus
`docs/spec/workspace-layout.md` — a soft adjacency, different regions of both
files (this plan touches the toast markup and the layout spec's toast sentence;
#505 touches the palette wiring and launcher sections). Coordinate at rebase,
not by serializing. No board item overlaps.

## Design

**The component.** The existing `.error` toast in `App.tsx` becomes the single
notification surface: repositioned to window top-center (`position: fixed`,
top anchor below the topbar's traffic-light margin, horizontally centered),
auto-dismissing on a ~6s timer that pauses on hover and resets on message
replacement, dismissible via the existing close control, `role="alert"` kept.
Entry/exit is a short fade/slide that the global reduced-motion reset already
flattens. `toast-error.css` is renamed in place to carry the new geometry; the
danger styling and elevation tokens stay.

**The feeders.** All existing `setError` / `reportActionError` /
`onError={setError}` traffic keeps flowing to it — those are all
action-results. The agent dock's `actionError` (Stop failed, open failed,
create failed — the transient third of `.thread-dock-error`) migrates to the
same sink via `reportActionError`, and the dock strip keeps rendering only the
persistent conditions: `providerError` and `snapshot.error` (surface states,
with the existing empty-state/settings affordances). The strip's markup stays
for those two; only the transient feeder moves.

**The timer.** Owned by the toast component, not the callers: replacement
resets it, hover pauses it, close clears it. No caller-side timeout knowledge —
the current `ATTACHMENT_ERROR_TIMEOUT_MS` pattern in `ThreadView` stays local
to the composer attachment strip (it is inline field-adjacent feedback, not
this toast).

**Spec.** `docs/spec/workspace-layout.md` gains the notification-layer
paragraph (position, behavior, the classifying rule) and its existing
toast-failure-wave sentence is folded into it. `docs/spec/design-system.md` is
touched only if a new token is needed (none expected — reuse `--z-toast`,
danger colors, elevation).

**Files.** `src/renderer/ui/App.tsx`,
`src/renderer/styles/toast-error.css`,
`src/renderer/ui/interactions/actionSteps.ts` (unchanged sink, possibly a
convenience re-export), `src/renderer/agent/components/ThreadDock.tsx`, specs,
renderer tests, e2e (`outliner-triggers.spec.ts` pins `.error` count; new
assertions for position, auto-dismiss, hover-persist, and the dock action
failure landing in the toast).

## Open questions

None. Position and the classification rule ratified 2026-08-08; "no source
labels" and "single slot" are recorded above as deliberate.

## Verification

- Renderer test (`actionNotice.test.tsx`): the timer lifecycle — it dismisses
  itself, it holds while hovered and restarts on leave, it survives host
  re-renders that hand it a fresh callback, and an identical repeated failure
  restarts the countdown rather than inheriting the previous one's remainder.
  `window.setTimeout` is stubbed rather than faked, so the assertions can be
  about how many timers exist and with what delay.
- Guard test (`actionNoticeCss.test.ts`): the anchor. This is the actual
  regression risk — a notice that drifts back to an edge still "looks fine" in
  review while reintroducing the reported bug — so the guard pins centred-on-
  window, forbids `right`/`bottom` on the notice, requires it to clear
  `--chrome-height`, and requires every keyframe to carry the centring offset.
- **No E2E was added, deliberately.** Producing a real action failure in E2E
  would require a test-only failure hook in production code, which is a worse
  trade than the coverage is worth; the anchor and the lifecycle are both
  pinned above. The existing `outliner-triggers` assertion that no notice
  appears on a successful path is retargeted to the new class.
- `bun run typecheck`, `bun run test:core`, `bun run test:renderer`, focused
  `PLAYWRIGHT_PORT=<free> bun run test:e2e`, `bun run docs:check`; specs in the
  same change (A6). Light + dark visual pass at the gate.
