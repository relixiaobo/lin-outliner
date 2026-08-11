# Startup Window First

**Shape:** (a) ONE complete feature in one PR.

## Goal

First paint must not wait for the world. Today `app.whenReady` awaits, in
series, provider-config reconciliation → `documentService.initWorkspace()`
(workspace read + Loro import + `materializeState` + a **full BM25 text-index
build** + possibly a full `saveCore()`) → `threadService.initialize()` → the
memory worker → `automationService.start()` → the node-access store → the
import API server — and only then calls `createWindow()`. On a large document
the user stares at nothing while the main process builds a search index.

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
- **Document init becomes single-flight.** `initWorkspace` currently guards
  with a completion boolean only, and the renderer calls `initWorkspace` on
  mount — window-first makes main's init and the renderer's call concurrent,
  so two `loadCore` runs could race. Replace the boolean with one shared
  readiness **promise** (first caller starts the work, everyone else awaits the
  same promise), with unified failure propagation: a failed init rejects every
  waiter identically and is retryable, never half-initialized.
- **Gate IPC on readiness, not the window on services.** Document and agent
  IPC handlers await their service's readiness promise so an early renderer
  request parks briefly instead of racing an uninitialized service. The gating
  set includes the **node-access store** — search ranking reads it
  synchronously via the transient-search-options provider, and today it loads
  before the window exists; with window-first, search waits for it too.
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
  concurrent callers coalesce instead of double-running. The import API server
  and node-access store load have no agent dependency and start alongside the
  document read.
- **Move the BM25 build off the critical path — without freezing main later.**
  Deferring the build does not help if the deferred build still runs
  `rebuildTextSearchIndex` synchronously; the build itself becomes chunked
  (cooperative slices on the main loop) or runs in a worker. Installation is
  **revisioned**: the build records the document revision it started from, and
  on completion either replays the deltas that arrived meanwhile before
  installing, or discards and rebuilds — a stale index is never installed. A
  search issued before the first install awaits the build's promise.
- The startup `saveCore()` (when `initWorkspace` decides one is needed) joins
  the normal coalesced save path instead of blocking init.
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
- Unit: concurrent `initWorkspace` calls (main + renderer) run `loadCore` once
  (single-flight counter); a failed init rejects all waiters and a retry
  succeeds cleanly.
- Unit: concurrent `prepareForTurnAdmission` callers coalesce (counter).
- Unit: an early `search` request issued before the index build completes
  returns the same results as one issued after (awaits the build); an index
  built across interleaved mutations installs only after replaying them
  (revision check), or rebuilds.
- Manual: kill the workspace file → persistent failure surface with working
  Retry.

## Open questions

- Whether the text index builds chunked-on-main or in a worker — the dev
  decides with the probe; the bound is that neither first paint nor later
  interaction waits on an O(document) synchronous build.
- Failure-surface copy and placement are PM-ratified at the one-pager (it is
  the plan's only new user-visible UI).
