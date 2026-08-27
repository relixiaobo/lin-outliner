# Startup Window First

**Shape:** (a) ONE complete feature in one PR.

## Goal

First paint must not wait for the world. Today `app.whenReady` awaits, in
series, provider-config reconciliation → `OutlineDocumentService.init()`
(standalone Runtime discovery/start, verified snapshot plus
`WorkspaceTransactionLog` replay, and initial projection transfer) →
`threadService.initialize()` → the memory worker →
`automationService.start()` → the node-access store — and only then calls
`createWindow()`. On a large or recovery-heavy document the user stares at
nothing while the Runtime and Agent services initialize.

This also falsifies the perf program's "Verified-good: startup does not block
on the large workspace file (window paints first)" claim — corrected in
`docs/plans/performance-optimization.md` in the same change that lands this
plan.

## Non-goals

- No splash screen; the pending state stays the renderer's existing loading
  state. The one addition is the persistent startup-**failure** surface in the
  Design — a load that fails must not vanish after a 6-second notice.
- No change to `userData` resolution order — `ELECTRON_USER_DATA_DIR` handling
  stays ahead of everything (A5), as do the security defaults (A3) and the
  single-instance lock.
- No service semantic changes; only when they start relative to the window.

## Design

- **Create the window first.** After the ready-path essentials (userData
  resolution, single-instance lock, protocol/security wiring),
  `createWindow()` runs before service initialization. The renderer's existing
  async `init_workspace` round trip already tolerates a pending document — it
  shows its loading state until the reply arrives; that contract stays.
- **Keep document init single-flight.** `OutlineDocumentService.init()` already
  stores one shared promise while Runtime connection, projection read, and watch
  establishment are in flight; concurrent callers await the same work, and a
  failure clears the promise for retry. Window-first relies on and regression-
  tests that contract instead of introducing another readiness authority.
- **Gate IPC on readiness, not the window on services.** Document and agent
  IPC handlers await their service's readiness promise so an early renderer
  request parks briefly instead of racing an uninitialized service. The gating
  set includes the **node-access store** — search ranking reads it
  synchronously for personal ranking, and today it loads before the window
  exists; with window-first, affected searches wait for it too.
- **DAG-ordered bring-up — NOT free-for-all parallelism.** Blind
  parallelization is unsafe: `ThreadService.initialize()` performs
  turn-admission prepare work, `MemoryExtension.startWorker()` calls the same
  `prepareForTurnAdmission` whose guard flag is set only AFTER its awaits (two
  concurrent callers both run it), and `AutomationService.start()` dispatches
  work immediately on wake. The order is a dependency DAG:
  provider-config reconcile + document ready → `threadService.initialize()` →
  then the memory worker ∥ automations (their prerequisite is the thread
  service, not each other). As part of this PR, `prepareForTurnAdmission`
  becomes single-flight (a stored promise, not a post-await boolean) so
  concurrent callers coalesce instead of double-running. The node-access store
  has no Agent dependency and loads alongside document readiness.
- **Keep search indexing out of startup.** Runtime's `OutlineSelectionIndex`
  builds its text index only when a textual selector first needs it. Window-first
  preserves that lazy boundary; repeated-request index reuse belongs to
  `interaction-jank-cleanups`, not this startup PR.
- **Measure the current persistence boundary.** There is no `saveCore()` or
  `WorkspaceSaver`. Runtime verifies and replays its snapshot/transaction log,
  performs required initial reconciliation before serving, and schedules
  maintenance/compaction after startup. Window creation may precede Runtime
  readiness, while projection-dependent IPC continues to await the same
  `OutlineDocumentService.init()` promise.
- **A persistent startup-failure surface.** The renderer shell currently has no
  startup-failure channel, and `ActionNotice` auto-dismisses after seconds —
  unacceptable for "the document failed to load". Window-first adds a minimal
  persistent failure state: what failed, a Retry action (re-invokes the shared
  readiness promise), and a Quit action. This is a deliberate, PM-visible
  exception to "no new loading UI".

## Verification

- **Measurement (A9):** cold-start time-to-first-paint on the large test
  document, before/after, numbers in the PR body.
- e2e: the existing boot smoke stays green; a new assertion that the window is
  visible before `init_workspace` resolves on a delayed-document fixture.
- Unit: concurrent `OutlineDocumentService.init()` calls connect/read/watch once;
  a failed init rejects all waiters and a retry succeeds cleanly.
- Unit: concurrent `prepareForTurnAdmission` callers coalesce (counter).
- Unit: an early projection-dependent request waits for Runtime readiness; an
  early personal-ranked search also waits for node-access readiness.
- Manual: kill the workspace file → persistent failure surface with working
  Retry.

## Open questions

- Failure-surface copy and placement are PM-ratified at the one-pager (it is
  the plan's only new user-visible UI).
