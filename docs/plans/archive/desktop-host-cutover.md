# Desktop Host Cutover And Lifecycle

**Shape:** ONE complete internal refactor in one PR.

## Goal

Compose the extracted transport, domain, and platform owners behind one final
`DesktopHost`, reduce `main.ts` to fixed Electron bootstrap/event forwarding,
and make startup, failed-start rollback, ordinary quit, and reversible effect
release explicit and race-safe.

## Non-goals

- No startup-window-first behavior; the existing window/service order is
  preserved for this refactor.
- No public protocol, product UI, command, Agent, Runtime, or preview behavior
  change.
- No Cordis, service locator, dependency solver, plugin runtime, or generic
  `close()` protocol that erases domain ordering.
- No assertion that the desktop exclusively owns an attached Outline Runtime.

## Design

### Fixed bootstrap

`main.ts` retains app identity, early `userData`, diagnostics/process-failure
handlers, pre-ready schemes/security, single-instance lock, one
`createDesktopHost(environment)`, `DesktopHost.start()` from `app.whenReady()`,
and forwarding of Electron process/window lifecycle events.

### Lifecycle arbitration

One private lifecycle owns `constructed -> starting -> started -> quitting ->
disposed`, plus failed-start rollback and the sole reversible Cancel edge back
to `started`. Startup is permanently single-flight. Quit is single-flight per
attempt, synchronously closes publication admission, joins in-flight startup
steps, and prevents any producer/effect from starting after quit wins.

Construction acquires synchronous objects and reversible effects only. Explicit
startup methods preserve the current dependency sequence. A milestone ledger
lets rollback/quit close only work that actually started and prevents duplicate
cleanup when startup failure races quit.

`DesktopHost.start()` is one-caller orchestration, not a second readiness
authority. Existing service-local initialization/single-flight contracts remain
authoritative, and IPC plus windows stay unpublished until the required startup
sequence completes.

### Reversible effects and domain protocols

A thin `ResourceScope` owns listeners, timers, watchers, subscriptions,
hotkeys, protocols, IPC owners, and other reversible effects with reverse-order,
exactly-once asynchronous disposal and aggregate diagnostics. It does not own
durability, user decisions, Agent shutdown ordering, authenticated Runtime
shutdown, or process exit.

The scope exposes `defer`, named `child` scopes, and one cached asynchronous
disposal settlement. Children may release early and remain idempotent when the
parent later disposes. Construction rollback and concurrent/repeated disposal
invoke each disposer once, continue after individual failures, and report
aggregated errors with ownership context.

`AppQuitCoordinator` remains the ordinary safe-quit authority: freeze local
mutation admission, join accepted work, install Runtime freeze, drain the latest
accepted revision, offer Retry/Cancel/Quit Anyway before irreversible teardown,
stop domains in order, authenticate shutdown of the exact current Runtime, wait
for descriptor/writer-lock release, then exit.

Failed-start rollback is intentionally different. It makes a bounded durability
attempt only when Outline initialization completed, releases local consumers and
effects, aggregates cleanup errors under the original startup failure, and does
not shut down a compatible Runtime that may predate this Host.

### Dependencies and collisions

`host-platform-composition` is the direct predecessor. After this PR merges,
Agent large-text, Startup Window, file-preview extensions, Skill authoring,
Computer Pilot, and other Host consumers may target final owners. They do not
modify the implicit `main.ts` graph before this cut.

### Verification

Race tests request quit at every awaited startup boundary and cover startup
failure winning, quit winning, Cancel/retry, repeated OS quit, partial startup,
cleanup failure, and authenticated Runtime shutdown. The final responsibility
audit has zero unclassified and zero duplicate effects across the complete
baseline.

Record the existing first-window probe before and after cutover without claiming
an optimization. Real-desktop and packaged verification covers first launch,
Runtime connection/replacement, Outliner mutation and durability, Memory
publication, personal ranking, one Agent tool round, Automation wake/resume,
Source/local-file preview, Settings and Provider Config, Launcher summon,
window close/reopen, quit during startup, Cancel/Retry/Quit Anyway, fatal-start
rollback, and immediate relaunch. Relaunch must leave no lost accepted work,
frozen reusable Runtime, stale descriptor, held writer lock, or residual desktop
process.

### Acceptance criteria

- The winning Electron instance owns exactly one `DesktopHost`; `main.ts`
  contains only fixed bootstrap and event forwarding.
- No producer or publication starts after quit wins, and no resource is released
  twice.
- Cancel is available only before irreversible teardown and restores the exact
  admission state.
- Failed-start rollback never infers exclusive Runtime ownership.
- Ordinary quit preserves accepted-work settlement, durability choice, ordered
  teardown, authenticated shutdown, and final exit behavior.
- The complete responsibility audit reaches zero without a removed behavior.
- Before/after first-window and real packaged lifecycle evidence preserves every
  baseline responsibility without turning this refactor into a latency claim.

## Open questions

Use `AsyncDisposableStack` only if the merged Electron/TypeScript surface
supports it without build changes; otherwise keep the local shared-promise
`ResourceScope` contract.

## Implementation checklist

- [ ] Compose the final typed owners and reduce `main.ts`.
- [ ] Add lifecycle arbitration, milestone ledger, and reversible scope.
- [ ] Preserve the safe-quit graph and distinct failed-start rollback.
- [ ] Complete race, shutdown, audit, repository, and packaged smoke checks.
