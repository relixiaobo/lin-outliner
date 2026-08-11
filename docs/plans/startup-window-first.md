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

- No splash screen or new loading UI beyond what the renderer already shows
  while `init_workspace` is pending.
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
- **Gate IPC on readiness, not the window on services.** Document and agent
  IPC handlers await their service's readiness promise
  (`documentService.ready`, `threadService.ready`, …) so an early renderer
  request parks briefly instead of racing an uninitialized service. No handler
  answers before its service is ready; the window just paints while they come
  up.
- **Parallelize service bring-up.** `threadService`, the memory worker,
  `automationService`, node-access store, and the import API server initialize
  concurrently after the workspace read, not in series.
- **Move the BM25 build off the critical path.** `initWorkspace` stops building
  the full text index inline; the index builds in an idle task after first
  paint (or lazily on first search, whichever the dev finds cleaner). A search
  issued before the build finishes awaits the build's promise — correct, just
  possibly a beat slower in the first seconds of a session.
- The startup `saveCore()` (when `initWorkspace` decides one is needed) joins
  the normal coalesced save path instead of blocking init.

## Verification

- **Measurement (A9):** cold-start time-to-first-paint on the large test
  document, before/after, numbers in the PR body.
- e2e: the existing boot smoke stays green; a new assertion that the window is
  visible before `init_workspace` resolves on a delayed-document fixture.
- Unit: an early `search` request issued before the index build completes
  returns the same results as one issued after (awaits the build).

## Open questions

- Whether the text index builds idle-eagerly or lazily on first search — the
  dev decides with the probe; the bound is that first paint never waits on it.
