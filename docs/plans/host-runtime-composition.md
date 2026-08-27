# Desktop Host Composition And Resource Ownership

**Shape:** (a) ONE complete internal refactor in one PR after the standalone
Outliner Runtime cutover lands. The typed composition root, startup
coordination, resource ownership, desktop transport extraction, shutdown
preservation, architecture guards, and current-spec updates ship together. No
intermediate state with two composition or quit authorities is mergeable.

## Goal

Replace Electron main's implicit process-wide object graph with one explicit,
statically typed `DesktopHost` composition root. A reviewer should be able to
answer these questions without reading all of `src/main/main.ts`:

- which domain creates and owns each long-lived service;
- which dependency must be ready before another operation may run;
- which listener, timer, subscription, protocol, IPC registration, worker, or
  store releases each acquired resource; and
- which steps belong to safe quit rather than ordinary resource disposal.

`src/main/main.ts` becomes the fixed Electron bootstrap and native event entry.
It preserves pre-ready security and `userData` invariants, creates one
`DesktopHost`, and delegates post-ready application events through narrow typed
methods. The refactor preserves current product behavior and domain authorities;
it makes no startup-speed, interaction-latency, memory-use, or file-size claim.

The design adopts the useful part of Cordis -- composition outside consumers
and ownership of reversible effects -- without adopting a dynamic plugin
runtime. Tenon currently has one known Electron host graph, so constructor and
factory arguments remain the dependency mechanism.

## Non-goals

- No Cordis, service locator, string-keyed context, dependency solver, Fiber
  state machine, configuration-driven module loading, hot reload, or runtime
  service replacement.
- No user-installable Host or renderer plugins, feature enable/disable system,
  npm/local module loading, or third-party trust and permission model.
- No generic `ServiceModule<T> { service; close() }`. A module may export
  several capabilities; a resource is not necessarily a service; readiness,
  quiescence, durability, and disposal are different protocols.
- No startup reorder or `startup-window-first` implementation. This refactor
  records and preserves the post-#584 startup graph; startup optimization stays
  a separately measured, user-visible change.
- No change to Outliner, ChangeSet, Operation, Thread/Turn/Item, Agent tool,
  Memory, Automation, action, renderer capability, or preload contracts.
- No return of document authority, workspace persistence, recovery, or asset
  reachability to Electron main after the standalone Runtime cutover.
- No generic application database, database-per-module rule, cross-domain
  schema, or duplicate copy of document, Agent, Memory, Automation, or resource
  data.
- No renderer plugin architecture, React rewrite, visual change, menu change,
  notification-copy change, or new settings.
- No line-count target. Moving construction alone will not remove native
  security, window, local-file, and transport behavior from the product.

## Design

### Prerequisite And Rebase Contract

Implementation starts only from a main branch containing the complete
`outliner-runtime-cli` cutover. That change replaces the current in-main
`DocumentService` authority with a desktop `OutlineClient`, Runtime supervision,
and a revision-ordered Event subscription. The desktop may settle submitted
ChangeSets and release its Runtime lease during quit, but it does not flush or
close Runtime-owned workspace persistence.

After that cutover, derive the real construction, readiness, registration, and
shutdown graphs from the rebased tree. Do not copy the current `main.ts` graph
or the current `startup-window-first` DAG into the implementation. Re-review
`startup-window-first` against the Runtime client boundary; its current
`documentService.initWorkspace()` and BM25 assumptions will no longer describe
the host.

The active `agent-result-and-file-lifecycle` design remains authoritative for
the app-level `ContentStore` and resource-reference settlement. This refactor
may own a ContentStore process handle only where the rebased graph requires it;
it does not redefine exact revisions, retention anchors, logical references,
or collection.

### Four Separate Responsibilities

The host architecture keeps four responsibilities explicit:

```text
main.ts
  -> createDesktopHost(environment)
       |- static typed domain composition
       |- StartupCoordinator: start and readiness dependencies
       |- ResourceScope: reversible process-lifetime effects
       `- AppQuitCoordinator: freeze, settle, decision, teardown, exit
```

They are connected deliberately but never collapsed into one universal
lifecycle:

- composition says what depends on what;
- startup says when a capability may be used;
- resource scope says how ordinary acquired effects are released; and
- quit coordination protects accepted user work and owns irreversible exit.

`DesktopHost` stores handles to existing authorities; it does not copy domain
state or become a new business-logic object. Its public methods are derived
only from post-ready Electron events such as activation, URL opening, resume,
window recreation, and quit request.

### Fixed Bootstrap

`src/main/main.ts` retains operations that must precede or surround an ordinary
host instance:

1. resolve and set `userData` before any service reads it;
2. register privileged schemes before `app.ready`;
3. acquire the application single-instance lock and terminate the loser;
4. install early process diagnostics;
5. enter `app.whenReady()`, construct one complete `DesktopHost`, and publish it
   to event callbacks only after successful construction; and
6. forward process/application events to narrow Host methods.

Existing navigation, redirect, permission, CSP, window-open, renderer
capability, and sender-admission rules remain unchanged. Post-ready registration
may move into owned native modules, but no generic dispatcher may widen an IPC,
protocol, or window boundary.

### Static Typed Composition

`createDesktopHost(environment)` is the sole post-ready composition root.
Factories receive exact concrete interfaces and return the capabilities their
consumers need. They never read from a mutable service bag or resolve a service
by name. A representative factory shape is:

```ts
function createAgentModule(
  dependencies: AgentDependencies,
  resources: ResourceScope,
): AgentExports
```

`AgentExports` may contain several handles; it is not wrapped as one synthetic
service. Memory remains inside the Agent ownership family because its worker,
control ledger, Thread integration, and Outliner publication are Agent
extensions. This directory choice does not change data authority: published
Memory prose is ordinary Nodes in the Outliner Runtime, while the Memory
control store retains only control, lineage, recovery, and visibility facts.

Likely ownership areas after #584 include the Outline client, Agent and its
extensions, native windows/actions, previews/updates, diagnostics, and desktop
transport. These are review landmarks, not mandatory `createXServices()`
buckets. A factory exists only when the rebased dependency graph shows a
cohesive owner; broad `agentServices` or `previewServices` bags that merely hide
unrelated construction are forbidden. Cycles are broken with narrow callbacks
or publisher interfaces owned by the composition root, never mutable globals
or `any` registries.

Existing domain registries remain domain registries:

- the Agent extension registry owns Agent extensions;
- the canonical model-tool registry owns model tool identity and admission;
- the action registry owns object/action semantics;
- the Outliner Runtime capability registry owns document operations; and
- renderer capability registration owns which window may call each desktop
  transport surface.

### Startup Coordinator

`StartupCoordinator` expresses the actual post-#584 readiness DAG using typed
handles and named phases. It is a small host-specific coordinator, not a
dynamic scheduler or plugin state machine. It distinguishes:

- pre-ready fixed bootstrap;
- capabilities required before the first usable Main window;
- work deferred until after the first-window boundary; and
- facilities created on demand.

The coordinator preserves the rebased ordering and failure policy. It does not
make every factory eager, await existing background work on the critical path,
or parallelize tasks merely because their promises can run concurrently.
Readiness that may be requested from more than one caller is single-flight;
failure is reported consistently and retries only where the owning domain
already supports retry.

An IPC handler waits on the exact capability readiness it needs, not a universal
"application ready" promise. Deferred work has an owner, cancellation path, and
diagnostic route. Startup readiness never calls resource disposal itself;
`createDesktopHost` handles failed construction by disposing everything already
acquired before rethrowing the original startup error with cleanup context.

### Resource Scope

`ResourceScope` owns ordinary reversible effects with process or child-module
lifetime:

```ts
interface ResourceScope {
  defer(dispose: () => void | Promise<void>): void;
  child(name: string): ResourceScope;
  dispose(): Promise<void>;
}
```

It accepts cancellation functions for Electron listeners, timers, watchers,
subscriptions, hotkeys, protocol/IPC handlers, transport connections, and
services whose shutdown has no separate domain ordering semantics. A child is
registered with its parent immediately, may be disposed early, and remains
idempotent when the parent later disposes.

Implement the stack with the platform `AsyncDisposableStack` where the rebased
Electron runtime and TypeScript type surface support it. The wrapper remains
necessary because the Host contract is stronger than the raw primitive:

- reverse-registration disposal;
- one cached disposal promise so concurrent calls join the same work;
- exactly-once disposal;
- continuation after an individual disposer fails;
- normalized reporting of all cleanup failures; and
- named child scopes for diagnostics.

If TypeScript still omits the disposable declarations under the project's
`ES2022` library set, add the smallest deliberate `ESNext.Disposable` type
configuration change with infrastructure-owner coordination. Do not replace the
standard stack with a new lifecycle framework to avoid that coordination.

Transactional construction belongs to `createDesktopHost`, not to the stack:
every acquired effect is deferred before the next fallible construction step;
a catch path awaits scope disposal and never publishes a partial Host.

`ResourceScope` does not decide when work is durable, stop accepting mutations,
wait for Agent Turns, settle ChangeSets, select retry/cancel/quit-anyway, or call
`app.quit()`/`app.exit()`.

### Quit Coordination

`AppQuitCoordinator` remains the only user-data safety and irreversible-exit
authority. Its post-#584 host adapter uses the concrete domain verbs present
after the Runtime cutover; it is not replaced by `DesktopHost.close()` or a
module-wide `close()` convention.

The semantic order remains:

1. freeze new desktop and producer admission;
2. settle work already accepted by the desktop, including submitted Outliner
   ChangeSets through the Runtime client boundary;
3. on a recoverable settlement failure, let the user retry, cancel quit, or
   explicitly quit anyway;
4. commit the admission freeze and enter irreversible teardown;
5. stop producers/workers, close domain stores using their own ordered
   protocols, release the desktop Runtime lease, and dispose remaining lexical
   resources; and
6. exit even if a late teardown step reports failure.

The exact ordered list is regenerated from the rebased host. Independent
best-effort flushes may remain parallel where their contracts permit it, but a
generic `Promise.all` cannot replace load-bearing sequencing. A cancellation
before irreversible teardown reopens only the admissions that the existing
coordinator contract permits.

### Desktop Transport

Capability-grouped registrars replace the monolithic registration block. Each
registrar receives only the service handles and window authorization it needs,
registers the exact current IPC/protocol/listener surface, and defers the
matching unregister operation into its child `ResourceScope`.

Outliner, Agent, Automation, settings, resources, actions, preview, launcher,
and native window registrars remain separately testable where those boundaries
exist after #584. Preload contracts and renderer capabilities do not widen.
Native file pickers, external URL opening, window actions, and other OS effects
remain in Electron main-side modules even though document operations move to
the Runtime.

### Data Ownership

Composition changes object lifetime, not persistent truth:

- the standalone Outliner Runtime owns document state, Operations, recovery,
  Events, Outline AssetRecords, and workspace durability;
- `ThreadService` and its stores own Thread/Turn/Item and Run history;
- Memory prose is stored as ordinary Outliner Nodes, while Memory-specific
  control data stays in its existing Agent store;
- Automation keeps its schedule, claim, and continuity records;
- the app-level ContentStore keeps exact byte revisions and mechanical
  retention state without becoming a logical product database;
- settings, credentials, diagnostics, update state, and caches retain their
  existing local stores; and
- renderer state remains a projection and UI-session concern.

A module may own a domain store because its feature needs one. Plugin shape or
directory symmetry never creates a database requirement, and `ResourceScope`
disposal never deletes persisted data.

### Failure Policy

Required authority failure aborts Host construction visibly and rolls back
already acquired resources. Optional update checks, derived caches, optional
external tools, and inspection-only capabilities continue through their
existing bounded degradation and diagnostic paths. No capability waits forever
in a hidden Cordis-style `PENDING` state.

Cleanup failure cannot skip later cleanup. The Host reports resource-scope and
domain teardown failures with ownership context, preserves stable error codes,
and does not leak secrets or private paths into renderer-visible messages.

### Cordis Adoption Gate

Static composition is the target, not temporary scaffolding. A new PM-ratified
plan may reconsider Cordis only when a concrete product requirement needs
runtime composition semantics, for example:

- multiple supported Host profiles with materially different service graphs;
- user-visible replacement or enable/disable of whole capabilities;
- trusted third-party modules with an approved isolation and permission model;
- live unload/reload; or
- repeated graph/lifecycle failures that static typed composition cannot
  express or diagnose.

Large files, aesthetic symmetry with DSH, or a desire to call internal features
"plugins" are not sufficient. If the gate is crossed, typed factories may be
adapted into plugins, but service identity, dependency loss, active-Turn unload,
configuration validation, renderer loading, and third-party trust require a
separate design.

### Build Order Inside The Implementation PR

1. Rebase after #584, inventory constructors, registrations, readiness edges,
   process globals, and shutdown steps from artifacts on disk, and re-audit
   `startup-window-first` plus open PR collisions.
2. Add `ResourceScope` with focused tests and immediately use it in one complete
   low-risk owner; coordinate the disposable type-library change if required.
3. Add `DesktopHost` and `StartupCoordinator`, preserving the measured startup
   order and construction-failure behavior.
4. Move cohesive domain construction and desktop transport registrars behind
   typed factories, one green commit at a time, while retaining domain
   registries and data authorities.
5. Connect the existing `AppQuitCoordinator` to the new owners with explicit
   post-#584 settlement and teardown verbs; delete the superseded quit closure.
6. Reduce `main.ts` to the fixed bootstrap and native event delegation, then
   remove superseded globals and forwarding helpers.
7. Fold the resulting ownership/readiness graph into current specs and run the
   full automated and real-desktop gate.

The work queue is derived from remaining constructor, registration, timer,
listener, subscription, IPC, and process-global hits in the rebased `main.ts`.
Completion is an empty result or a documented bootstrap allow-list, not a
hand-maintained migration checklist.

### Expected Surface

The exact file list is regenerated after #584. Expected ownership areas are:

- `src/main/main.ts`;
- new `src/main/desktopHost/` composition, startup, resource, transport, and
  domain-owner modules;
- existing main services only where a narrow factory or shutdown seam is
  required;
- focused core/main tests for resource scope, construction rollback, startup
  ordering, quit ordering, and sender admission;
- existing Electron E2E and packaged smoke coverage; and
- `docs/spec/architecture.md`, `docs/spec/agent-core.md`, and
  `docs/spec/error-observability.md` where the final graph changes current
  descriptions.

No public protocol change is expected. `package.json`, `bun.lock`,
`src/core/commands.ts`, `src/core/types.ts`, and preload contracts remain out of
scope. `tsconfig.json` changes only if the standard disposable type library
requires the coordinated addition described above.

### Risk Controls

- **Stale graph:** #584 replaces document authority and desktop settlement.
  Implementation cannot claim current constructor names as the target; its
  first artifact is a regenerated post-cutover graph and empty-result queue.
- **New dependency drawer:** moving code without narrowing dependencies would
  only relocate `main.ts`. Factory signatures and architecture guards expose
  exact imports, exports, globals, and registrations after every move.
- **Quit regression:** a generic disposer could release a store before accepted
  work settles. Ordered domain shutdown remains outside `ResourceScope`, and
  coordinator tests cover retry, cancel, quit-anyway, and late teardown errors.
- **Startup regression:** extraction may accidentally await optional work or
  double-start a readiness path. Preserve the rebased DAG, require single-flight
  readiness, and compare the existing first-window probe before and after.
- **Security regression:** splitting transport can omit a sender, window, or
  navigation check. Registrars move existing admission checks intact and retain
  wrong-sender tests; no generic dispatcher is introduced.
- **Platform mismatch:** runtime support for `AsyncDisposableStack` does not by
  itself provide project type declarations or the Host's join semantics. Gate
  the small type-library change explicitly and test the wrapper contract.

### Verification

Focused tests prove:

- construction failure disposes every acquired resource exactly once and never
  publishes a partial Host;
- concurrent and repeated scope disposal joins one completion;
- child and parent scopes release effects in reverse ownership order;
- one disposer failure does not prevent later disposal and all failures are
  reported;
- startup follows the post-#584 readiness graph without duplicate start work;
- quit preserves freeze, settlement, user decision, irreversible teardown, and
  exit ordering;
- optional capability failure degrades while required authority failure aborts;
- deferred work starts only at its existing boundary and is cancelled on
  teardown;
- every desktop transport registrar preserves wrong-window/unregistered-sender
  rejection; and
- the architecture guard finds no unowned constructor, timer, listener,
  subscription, IPC block, or process-wide service variable in `main.ts`
  outside the bootstrap allow-list.

Run `bun run typecheck`, both unit suites, relevant E2E and packaged smoke
coverage, `bun run docs:check`, and `git diff --check`. Record a pre-refactor and
post-refactor first-window timing using the existing probe; investigate material
regression without claiming an optimization.

Real-desktop verification covers first launch, Runtime connection and Outliner
mutation settlement, one Agent tool round, Memory publication, Automation wake,
Preview, Settings and Provider Config, Launcher summon, window close/reopen,
macOS resume, quit cancel/retry/quit-anyway paths, and relaunch with no lost
accepted work or residual desktop process.

### Acceptance Criteria

- One typed `DesktopHost` is the sole post-ready composition root.
- Dependency composition, startup readiness, resource disposal, and safe quit
  are separate, inspectable mechanisms.
- Every process-lifetime effect has one owner and disposer; every ordered domain
  shutdown remains in its domain or the quit coordinator.
- `main.ts` contains only fixed bootstrap, security/event entry, and explicit
  allow-listed native behavior; there is no line-count target.
- Startup behavior and first-window critical path match the rebased baseline
  within measurement noise unless a separately ratified plan changes them.
- Outliner, Agent, Memory, Automation, ContentStore, previews, actions, updates,
  windows, renderer capabilities, and persisted data retain their authorities
  and behavior.
- No Cordis dependency, dynamic plugin runtime, generic service wrapper,
  service bag, alternate data store, or renderer plugin system lands.
- Current specs describe the final graph and the future Cordis adoption gate.

## Open questions

- The exact factory boundaries and readiness DAG are intentionally derived from
  the tree after #584 lands; changing the authorities fixed above requires PM
  review rather than an implementation-local decision.
- Re-review `startup-window-first` after that graph is recorded. It may consume
  `StartupCoordinator`, but it must not be silently folded into this
  behavior-preserving refactor.

## Checklist

- [ ] Rebase after #584 and regenerate construction, readiness, resource,
  transport, startup, and shutdown inventories.
- [ ] Re-run the open-PR collision check and record the real overlap in the PR.
- [ ] Re-audit `startup-window-first` against the standalone Runtime client.
- [ ] Add resource, rollback, readiness, shutdown-order, sender-admission, and
  architecture guards before moving ownership.
- [ ] Move complete owners in reviewable green commits inside one PR.
- [ ] Remove superseded globals, wiring, and forwarding helpers.
- [ ] Update current specifications in the same PR.
- [ ] Run automated gates and real-desktop startup/quit verification.
