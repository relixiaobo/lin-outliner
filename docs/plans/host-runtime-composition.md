# Desktop Host Composition And Resource Ownership

## Goal

Replace Electron main's implicit process-wide object graph with explicit,
statically typed owners and one final `DesktopHost` composition root while
preserving the complete post-#592 and post-#587 desktop behavior on `main`.

A reviewer should be able to answer these questions without reading all of
`src/main/main.ts`:

- which owner constructs each long-lived service and bridge;
- which concrete operation starts each service, in what order, and with what
  failure policy;
- which owner releases every listener, timer, subscription, protocol, IPC
  handler, worker, store, client, and child-process relationship;
- what happens when startup failure and an ordinary quit race;
- which state is authoritative in Electron main, the Agent subsystem, or the
  standalone Outline Runtime; and
- which shutdown steps are reversible cleanup versus durability, user decision,
  authenticated Runtime shutdown, and process exit.

`src/main/main.ts` remains the fixed pre-ready Electron bootstrap until the final
delivery unit. That unit creates one `DesktopHost` for the winning application
instance and delegates post-ready behavior through narrow typed methods.

This refactor adopts the useful part of Cordis -- composition outside consumers
and explicit ownership of effects -- without adopting a dynamic plugin runtime.
It makes no startup-speed, interaction-latency, memory-use, or line-count claim.

## Non-goals

- No Cordis, service locator, string-keyed context, dependency solver, Fiber
  state machine, configuration-driven module loading, hot reload, or runtime
  service replacement.
- No user-installable Host or renderer plugins, feature enable/disable system,
  third-party module loading, or plugin trust and permission model.
- No generic `ServiceModule` wrapper with only `service` and `close` members. Construction, readiness,
  admission, durability, ordered quiescence, effect release, and process exit
  remain different protocols.
- No `StartupCoordinator`, startup DAG framework, first-window reorder,
  per-handler readiness gate, persistent startup-failure UI, or implementation
  of `startup-window-first`.
- No change to the Outline Runtime protocol, ChangeSet/Operation/Event model,
  Thread/Turn/Item protocol, Agent tools, Memory semantics, Automation behavior,
  action registry, renderer capabilities, or preload surface.
- No Runtime launch lease or new assertion that an authenticated Runtime is
  owned exclusively by the current Desktop Host.
- No return of document state, durability, search indexing, AssetRecords, or
  ContentStore authority to Electron main.
- No replacement of the Runtime freeze, drain, commit-freeze, authenticated
  shutdown, descriptor-release, or writer-lock-release protocol with ordinary
  disposal.
- No generic application database, database-per-module rule, cross-domain
  schema, or duplicate copy of document, Agent, Memory, Automation, resource,
  settings, diagnostic, or cache data.
- No visual, menu, notification-copy, or settings change.

## Design

### Requirements

- **FR-1:** The final winning Electron instance owns exactly one statically
  typed `DesktopHost`; `main.ts` retains only pre-ready bootstrap and native
  process-event forwarding.
- **FR-2:** Every long-lived listener, timer, subscription, protocol, IPC
  handler, worker, store, client, and child-process relationship has one named
  owner and one idempotent release path.
- **FR-3:** Construction, startup readiness, lifecycle arbitration, reversible
  cleanup, durability, ordered domain shutdown, Runtime shutdown, and process
  exit remain explicit distinct protocols.
- **FR-4:** Startup failure and quit share one lifecycle authority so a producer
  cannot start after teardown begins and a resource cannot be released twice.
- **FR-5:** Ordinary quit preserves accepted-work settlement, user
  Retry/Cancel/Quit Anyway decisions, Runtime freeze/drain, authenticated
  shutdown, descriptor and writer-lock release, and exit ordering.
- **FR-6:** Electron main composes Outline, Agent, Memory, Automation, resource,
  preview, settings, and native-window authorities without duplicating their
  state or protocols.
- **FR-7:** The six delivery units land serially after Source PR-I; each is a
  complete behavior-preserving refactor with a reproducible responsibility
  audit and no unused scaffold.

### Delivery Shape

**Shape:** (b) A SET of complete internal refactors. Each delivery unit leaves
one functioning composition root, preserves behavior, reduces an independently
verifiable ownership problem, and can merge without a later unit being required
to make it useful. `main.ts` remains the composition root through the extraction
units; only the final unit replaces it with `DesktopHost`. No unit is an empty
scaffold or an unused interface for a later PR.

1. **Owned desktop transport.** Replace the monolithic `registerIpc()` and
   process-exit-only registrations with capability-grouped IPC and protocol
   registrars. Each registrar returns one idempotent owner whose `dispose()`
   removes exactly what it registered. `main.ts` explicitly tears down the
   combined transport on quit. This unit includes sender/capability rejection and
   complete-unregistration tests.
2. **Agent Host extraction.** Move the final Agent construction graph, one-time
   constructor bindings, explicit startup methods, and `closeAgentServices()`
   adapter behind `createAgentHost()`. It returns narrow Agent, Memory, and
   Automation capabilities rather than a mutable service bag. `main.ts` keeps the
   current startup and quit order.
3. **Outline desktop extraction.** Move `OutlineClientSupervisor`, desktop
   clients, `OutlineDocumentService`, assets, projection observation, and
   node-access ranking synchronization behind `createOutlineDesktopHost()`.
   Preserve the complete Runtime-recovery responsibility set and expose explicit
   durability and quit adapters without claiming Runtime process ownership.
4. **Resource, preview, and native-file extraction.** Starting from the final
   Source PR-I contracts, move exact-file grants/resolution, local picker/search,
   preview streams, URL-preview session, translation, and cache ownership behind
   `createResourcePreviewHost()`. Preserve the mature preview stack and its
   authority checks; Source PR-F is not required for this unit.
5. **Native window and application-service extraction.** Move Main, Settings,
   Provider Config, and Launcher window state plus action invocation, updates,
   theme/locale preferences, menu, hotkey, and window-scoped effects behind
   narrow typed owners. `main.ts` still sequences startup and quit.
6. **DesktopHost cutover.** Compose the already extracted owners in
   `createDesktopHost()`, add the private Host lifecycle arbiter and
   `ResourceScope`, move explicit startup orchestration into `DesktopHost.start()`,
   and reduce `main.ts` to fixed bootstrap and native process-event forwarding.

The units land serially because each edits `main.ts`, but none blocks review on a
multi-domain mega-diff. Every unit rebases on the previous merged unit and reruns
the responsibility audit and open-claim collision check.

### Dependency And Collision Order

The implementation baseline is not the current plan branch. Product contracts
that replace the surfaces being composed land first:

```text
Outline Source PR-I
  -> Host composition delivery set
       |- Agent Large-Text Arguments And Bash Stdin
       |    |- Agent Result And Resource Reference Lifecycle
       |    |    |- Agent Cross-Thread Reference
       |    |    `- Agent Failure Recovery Experience
       |    `- Outline CLI Skill Workflow Efficiency (+ Source PR-I)
       `- Startup Window First
```

Source PR-I is a hard dependency because it owns the final Source protocol,
Host-private exact-file grant, selected preview host, current preview consumers,
and native-file authorization boundary. The Host delivery set then establishes
the final `DesktopHost`, `createAgentHost()`, `createResourcePreviewHost()`,
lifecycle arbiter, reversible-effect ownership, and explicit quit adapters.
Agent Large-Text Arguments then adds its canonical/renderer Item split and its
Agent IPC projection against the final Agent Host and transport registrars. It
has no semantic dependency on Source, but implementing it before this Host cut
would knowingly add new registration and projection work to the implicit
`main.ts` graph only for this plan to relocate it. This is therefore an
architecture-order edge under A7, not a product-contract edge.

Agent Resource Lifecycle adds its resolver, conversation workspaces,
ContentStore links, citation settlement, and cleanup barriers as typed consumers
inside that graph instead of first extending today's implicit `main.ts` graph and
relocating them afterward. It follows the large-text cut because both features
change Agent protocol/codec, Item projection, context dependencies,
`ToolPayloadStore`, Thread lifecycle, and the renderer bridge. Internal textual
bindings remain private Item dependencies and never become file resources.

Source PR-F is an independent renderer composition enhancement and has no
architectural dependency edge after Source PR-I. Agent Cross-Thread Reference
and Agent Failure Recovery remain after Agent Resource Lifecycle. The latter is
an implementation-order edge over shared Agent history/lifecycle surfaces, not a
new file-lifecycle behavior dependency. `startup-window-first` consumes the final
`DesktopHost.start()` boundary rather than introducing readiness behavior that a
later composition refactor must move. Agent Resource Lifecycle and
`startup-window-first` have no dependency edge between them; their merge order is
decided by the live file collision check after Host composition lands.

The current collision result is:

- No implementation PR is open at this audit. Source PR-I overlaps the
  resource/preview/native-file
  implementation surface and must merge before the Host delivery set.
- Agent Result And Resource Reference Lifecycle has no open implementation claim.
  It overlaps Agent construction, Host resource resolution, ContentStore
  relationships, cleanup, and quit barriers and starts after the Host set.
- Agent Large-Text Arguments has no product-contract dependency on this plan,
  but its implementation follows the Host set because it overlaps `main.ts`,
  Agent transport/projection, service construction, and lifecycle ownership.
- Source PR-F is independent after Source PR-I. Cross-Thread Reference follows
  Agent Resource Lifecycle. Agent Failure Recovery also follows that lifecycle
  cut. Startup Window First follows Host composition and repeats its collision
  check against any live Agent lifecycle work.

After Source PR-I merges, the first Host implementation owner runs `gh pr list`,
scans `docs/TASKS.md`, compares every intended file with live PR claims, and
records the exact result in that implementation PR. No implementation unit starts
against an unmerged future contract.

### Process And Data Authorities

Composition owns object relationships; it does not move authoritative state:

```text
Electron main
  |- native windows, menus, dialogs, permissions, protocols, and IPC admission
  |- DesktopHost construction, startup arbitration, reversible effects, and quit adapter
  |- OutlineDocumentService desktop adapter
  |    |- accepted main-process mutation queue
  |    |- Runtime Event watch/reconnect and live desktop Projection
  |    |- Operation waiters and durability-failure observation
  |    `- personal-access ranking synchronization
  |- Agent Thread/Turn/Item stores, Memory control data, and Automation data
  `- local settings, credentials, diagnostics, caches, grants, and access stats

Standalone Outline Runtime
  |- authoritative live Core and document revision
  |- ChangeSet execution, Operation/Event ordering, and accepted/durable frontier
  |- transaction log, recovery, batching, maintenance, and writer lock
  |- long-lived read model and text-search index
  |- protected definitions and Runtime-side capability admission
  `- Outline AssetRecords and exact-revision retention over ContentStore

Renderer
  `- folded projection and UI-session state received through preload/IPC
```

`OutlineDocumentService` remains the stateful desktop adapter that preserves the
mutation tail, Event-to-Projection ordering, Runtime replacement recovery,
durability monitoring, and ranking synchronization recovered by #592. It is not
the document authority and is not reduced to a stateless transport wrapper.

Memory prose remains ordinary editable Outline Nodes. `MemoryControlStore`
retains only Agent-owned control, lineage, recovery, visibility, citation, and
publication facts. `MemoryExtension` observes committed Runtime projection
deliveries and publishes through the same main-process mutation queue.
`NodeAccessStore` remains local personal-ranking state mirrored into the Runtime
read model. The neutral `ContentStore` remains a physical exact-revision service,
not a Host database or logical file registry.

### Fixed Bootstrap And Final Host Boundary

The final `src/main/main.ts` retains only work that must precede or surround an
ordinary Host instance:

1. set application identity;
2. resolve and set `userData` before any service reads it;
3. create the diagnostic sink and install early process-failure handlers;
4. apply pre-ready command-line and privileged-scheme configuration;
5. acquire the single-instance lock and terminate the loser without constructing
   service graphs or starting background work;
6. construct one `DesktopHost` for the winning instance;
7. call `DesktopHost.start()` from `app.whenReady()`; and
8. forward `second-instance`, `window-all-closed`, `before-quit`, activation,
   and development-parent death through narrow Host entry points.

All work that starts a timer, worker, subscription, asynchronous refresh, or
external connection moves out of constructors into an explicit Host startup
step. Construction acquires only synchronous objects and reversible resources,
so a `constructed` Host has no untracked background producer.

The final responsibility split is:

```text
main.ts
  `- fixed bootstrap
       `- createDesktopHost(environment)
            |- static typed domain composition
            |- HostLifecycle: start/quit/failure arbitration
            |- DesktopHost.start(): explicit current startup order
            |- ResourceScope: reversible effects and final release
            `- AppQuitCoordinator: durability, user decision,
                                    authenticated Runtime shutdown, and exit
```

There is no host-wide readiness object. `DesktopHost.start()` is one-caller
orchestration, not a readiness authority. Existing service owners keep their
current `init()`, `initialize()`, `load()`, `start()`, retry, and single-flight
semantics. IPC and windows remain unpublished until the awaited startup sequence
completes.

### Construction And Startup Graph

The extracted factories reproduce the final dependency-tip graph with typed
parameters and typed exports:

```text
Bootstrap environment + DiagnosticLogStore/reportError
  |
  |- Outline desktop host
  |    |- OutlineClientSupervisor
  |    |- DesktopOutlineClient
  |    |- OutlineDocumentService
  |    |- OutlineDesktopAssetService
  |    `- projection/node-access bridges
  |
  |- Agent host
  |    |- managed Skills + BrowserPilotHost + configuration + workspaces
  |    |- MemoryControlStore + TimelineMemoryStore + MemoryExtension
  |    |- PiTurnExecutor -> one-time ToolRuntime binding
  |    |- ThreadService
  |    |- AutomationStore/Worktree/Dispatcher/Scheduler/Service
  |    `- ToolRuntime -> ThreadService + AutomationService
  |
  |- resource and preview host
  |    |- Source resolver + exact-file grant store
  |    |- PreviewTranslationCacheStore + PageTranslationService
  |    `- local preview streams + URL-preview session + native files
  |
  |- native window and application-service hosts
  `- capability-grouped IPC/protocol/native-event transport
```

Real constructor cycles remain one-time local bindings with narrow callback
types. Each binding fails if invoked before composition completes and can be
assigned once only. No `any`, string registry, global singleton lookup, or
general-purpose late-binding container is introduced.

`DesktopHost.start()` preserves the exact dependency-tip sequence. Its current
baseline begins with provider reconciliation, `OutlineDocumentService.init()`,
Memory mutation-index initialization, `ThreadService.initialize()`, the Memory
worker, Automation, power-resume wake registration, node-access load and Runtime
ranking replacement, then native protocols/session security, desktop IPC, Main
window, update timers, Launcher, hotkey, menu, and activation handling. The
implementation records this sequence from source after its dependencies merge;
it does not copy an older numbered list into code.

Optional provider cleanup, node-access synchronization, update checks, managed
Skill refresh, scratch cleanup, derived caches, and inspection-only observers
retain their existing bounded degradation and diagnostic routes. Moving them
behind the winning-instance boundary may not add first-window awaits, make an
optional failure fatal, or run work twice.

### Host Lifecycle Arbitration

The final Host owns one private lifecycle; it is not exposed as product
readiness:

```text
constructed -> starting -> started
      |            |          |
      |            `----------+-> quitting -> disposed
      `-----------------------'
                                  |
                                  `- Cancel before teardown -> started

starting -> failed -> disposed
```

`start()` is a permanently single-flight operation with one cached promise.
`requestQuit()` is single-flight only within the current quit attempt. Only the
transition winner owns that attempt:

- `start()` may be called only from `constructed`. It records every completed
  startup milestone and every producer that reached its started state.
- `requestQuit()` synchronously changes `constructed`, `starting`, or `started`
  to `quitting`, closes publication admission, and sets a quit-requested flag
  before returning the current attempt promise. Concurrent callers join that
  promise.
- Startup checks that flag before and after every awaited boundary, before
  starting another producer, and before publishing protocols, IPC, windows,
  timers, hotkeys, or activation listeners. It never begins another step after
  quit wins.
- An in-flight domain operation is joined rather than abandoned unless that
  domain already provides a proven abort contract. After it settles, startup
  returns an internal `interrupted-for-quit` outcome and hands its milestone
  ledger to the quit path. It does not run failed-start rollback.
- If startup failure wins the transition first, failed-start rollback owns all
  cleanup and a later quit request joins it. If quit wins first, the quit path
  owns cleanup and exit while the startup error is diagnostic context only.
- A reversible Cancel restores `started` and clears the completed quit-attempt
  promise. A later OS quit creates a new attempt, freezes and drains again, and
  may proceed to teardown and exit. An irreversible attempt reaches `disposed`;
  later calls are terminal no-ops.

If quit arrives before `OutlineDocumentService.init()` succeeds, no renderer or
mutation-capable producer has been published or started. The Host joins the
current startup step, closes constructed clients and effects, and exits without
pretending there is an accepted document frontier to drain. If Outline init has
succeeded, the ordinary `AppQuitCoordinator` path runs over the milestone ledger
and closes only services that actually started. This prevents startup from
creating Automation, IPC, protocols, or windows after teardown has begun.

Focused race tests request quit at every awaited startup boundary and prove one
terminal owner, no post-quit publication, no duplicate close, and no abandoned
started producer.

### Failed-Start Rollback And Runtime Ownership

`OutlineClientSupervisor.connect()` may attach to an existing compatible Runtime
or launch one, and its result carries no exclusive Host ownership lease.
Authenticated descriptor and live-instance validation prove which Runtime is
being addressed; they do not prove that the current `DesktopHost.start()` created
or exclusively owns it.

Therefore failed-start rollback never calls `OutlineClientSupervisor.shutdown()`.
If Outline initialization completed, rollback first freezes local mutation
admission, joins the accepted main-process mutation tail, reads the latest
accepted revision, and makes one bounded `drainToRevision()` attempt before
stopping started producers. A drain failure is reported with the startup failure
and does not turn rollback into a user-decision dialog or Runtime shutdown. The
Host then closes desktop Runtime consumers and releases reversible effects. If
Outline did not become ready, it closes only the clients and resources that were
acquired. Cleanup errors are aggregated while the original startup error remains
the fatal error returned to bootstrap. The compatible Runtime remains available
for a subsequent desktop launch or another client.

Ordinary user quit is intentionally different and preserves current behavior:
after the durability and irreversible-freeze protocol, `AppQuitCoordinator`
requests authenticated shutdown of the exact current Runtime and waits for its
descriptor and writer lock to disappear. Adding a future launch receipt or
exclusive Runtime lease would be a separate protocol design, not an inference
made by this refactor.

### ResourceScope Owns Effects, Not Protocols

The final cutover introduces a thin `ResourceScope` owner for reversible
process-lifetime effects already exposed by the extraction units. It registers
synchronous or asynchronous disposers through `defer`, creates named child
scopes through `child`, and exposes one asynchronous `dispose` settlement.

It owns cancellation or unregistration for Electron/process/WebContents
listeners, timers, watchers, subscriptions, global hotkeys, protocol handlers,
IPC handlers, transport connections, and idempotent release without independent
domain ordering semantics. Named child scopes may be released early and remain
idempotent when the parent later disposes.

The contract requires reverse-registration disposal, one cached disposal promise,
exactly-once disposer invocation, continuation after individual failures,
aggregate error reporting with ownership context, and construction rollback.
Use `AsyncDisposableStack` only if the final Electron and TypeScript library
surface supports it without broad build changes; the named shared-promise wrapper
remains the Host contract.

`ResourceScope` does not freeze admissions, calculate an accepted frontier, wait
for durability, choose Retry/Cancel/Quit Anyway, stop ordered Agent producers,
commit a Runtime freeze, authenticate or shut down a Runtime, wait for descriptor
or writer-lock release, or exit the app. `closeAgentServices()` and Outline
consumer close remain explicit ordered domain protocols. Supervisor shutdown is
never registered as a generic disposer.

### Safe-Quit Graph

`AppQuitCoordinator` remains the only ordinary safe-quit and irreversible-exit
authority. `DesktopHost` supplies typed adapters and the started-service ledger;
it does not replace the coordinator with a generic `close()`:

```text
before-quit
  -> Host lifecycle wins/joins terminal ownership
  -> freeze local Outline mutation admission synchronously
  -> await callers already admitted to OutlineDocumentService.mutationTail
  -> install the cross-client Runtime freeze barrier
  -> read latest accepted Runtime revision
  -> drain that revision to durable (bounded attempt)
       |- Retry -> repeat the same in-flight drain
       |- Cancel -> Runtime unfreeze + local unfreeze + return to started
       `- Quit Anyway -> continue irreversibly
  -> commit Runtime admission freeze
  -> teardown desktop consumers and local domains
       |- dispose transport, protocols, listeners, hotkeys, and timers
       |- dispose preview and translation services
       |- bounded best-effort local flushes
       |- Automation stop -> Memory worker stop -> ThreadService close
       |                    -> Memory store close -> Automation store close
       `- close DesktopOutlineClient and OutlineDocumentService
  -> authenticated OutlineClientSupervisor.shutdown(signal)
       |- validate contract/session/descriptor/live instance again
       |- request shutdown of that exact Runtime
       `- wait for descriptor and writer-lock release
  -> app.exit(0), even after late teardown/shutdown failure
```

Cancel is available only before irreversible teardown. It restores the exact
local and Runtime admission state and transitions `quitting` back to `started`;
no service has been disposed at that point. The Host clears that attempt's
single-flight promise only after restoration completes, so concurrent callers
still share one decision while a later quit drains again. This is the sole
deliberate non-monotonic user-decision edge. A quit that interrupted startup has
no window or user decision surface and cannot cancel back into a partially
started Host.

### Desktop Transport Ownership

Capability-grouped registrars receive only the services and window authorization
they use, preserve exact channel/payload/error behavior, and return one disposer
covering every handler and listener they add. The groups are derived from the
dependency-tip source and include:

- Outline Runtime renderer transport;
- app updates;
- action invocation and renderer-step acknowledgement;
- Agent Core, message context menu, Memory, and Automation;
- admitted app commands for Agent, Source/assets, preview, and translation;
- node-access observation and Runtime ranking synchronization;
- windows, Settings, Launcher, theme, locale, and preferences;
- provider configuration, Agent settings, and diagnostics; and
- native file picking/search/preview/read/copy plus attachment admission.

Protocols remain separate from IPC because `protocol.unhandle()` and session
lifetime differ from `ipcMain.removeHandler()`. Window/WebContents listeners
belong to their window owner. Renderer capability registration and sender checks
remain at the current least-privilege boundary. Source PR-I's verified-handle
rules remain authoritative; this refactor cannot reintroduce unsafe path-only
Open/Reveal for live external Sources.

### Durable Responsibility Audit

The first implementation unit creates and tracks
`scripts/host-composition-audit/`; later units extend the same audit. It follows
the runtime-recovery audit's clean-clone model and contains:

- a driver that derives baseline responsibilities from source rather than a
  hand-maintained checklist;
- a baseline manifest with the exact dependency-tip commit and tree identity;
- a machine-generated baseline inventory;
- a tracked disposition ledger mapping every baseline entry to retained
  bootstrap, named owner, equivalent typed edge, or separately ratified removal;
- source queries and guards that detect new unowned or duplicate effects; and
- a README describing one-command reproduction and expected zero queues.

The inventory covers service/store/client construction; startup and projection
edges; timers and Electron/process/WebContents listeners; hotkeys, protocols and
IPC; degradation/diagnostic branches; mutable process globals; and the complete
freeze/drain/decision/teardown/shutdown graph. This plan has no intended removal.

Generated reports live in `tmp/host-composition-audit/`, but the driver, baseline,
inventory, dispositions, and reconstruction material remain tracked. If a
GitHub single-branch clone cannot reach the baseline tree, the audit stores a
compressed reconstruction patch anchored to a reachable parent and verifies the
tree hash before comparison. Every delivery unit passes with zero unclassified
entries in its claimed surface; the final unit passes with zero unclassified and
zero duplicate owners across the complete baseline.

### Implementation Surface

The expected target surface, re-derived from the dependency tip, includes:

- `src/main/desktopHost/createDesktopHost.ts` and `hostLifecycle.ts`;
- `src/main/desktopHost/resourceScope.ts`;
- `src/main/desktopHost/createOutlineDesktopHost.ts` and the node-access bridge;
- `src/main/agent/createAgentHost.ts` plus focused existing domain builders;
- `src/main/desktopHost/createResourcePreviewHost.ts` and `src/main/localFiles/`;
- `src/main/desktopHost/createWindowHost.ts` and application-service owners;
- `src/main/desktopHost/transport/` capability registrars;
- disposer-returning registration in `src/main/outlineClient/ipc.ts`;
- `src/main/main.ts` fixed bootstrap and Host event forwarding; and
- `scripts/host-composition-audit/` with focused ownership/lifecycle tests.

No public protocol change is expected. `package.json`, `bun.lock`,
`src/core/commands.ts`, `src/core/types.ts`, and preload contracts remain out of
scope. A build-config change requires a separate coordinated interface decision;
the implementation may use a small local stack instead. Dev agents do not edit
`docs/TASKS.md` or `CHANGELOG.md`.

### Cordis Adoption Gate

Static composition is the target architecture, not temporary scaffolding. A
separate PM-ratified design may reconsider Cordis only when a concrete product
requirement needs runtime graph semantics: materially different supported Host
profiles, user-visible capability replacement or enable/disable, trusted
third-party modules with isolation and permissions, or live unload/reload.

A large `main.ts`, directory symmetry with DSH, or calling internal domains
"plugins" is insufficient. If the gate is crossed, typed factories may become
plugin adapters, but service identity, dependency disappearance, active-Turn
unload, persistent-state compatibility, renderer loading, and third-party trust
require their own design.

### Verification

Focused tests prove:

- each extraction unit leaves one root and preserves the exact startup/quit
  calls owned by `main.ts` until final cutover;
- every transport registrar preserves sender/capability rejection and removes
  its complete registration set exactly once;
- construction failure releases every acquired reversible effect and never
  publishes a partial Host;
- failed startup freezes and joins admitted local mutation work, stops only
  started producers, closes desktop consumers, does not shut down the Runtime,
  and preserves the original startup error;
- quit at every startup await boundary prevents later producer start or
  publication and yields one terminal cleanup owner;
- concurrent callers share one current quit attempt, while Cancel restores
  `started`, clears that attempt, and a later quit performs a new drain and exits;
- concurrent/repeated scope disposal joins one completion, releases children in
  reverse ownership order, continues after failure, and aggregates errors;
- the exact dependency-tip startup order has no duplicate starts or hidden
  readiness gate;
- node-access snapshots and later changes keep local and Runtime ranking aligned;
- ordinary quit preserves admission closure, accepted-tail settlement, Runtime
  freeze/drain, Retry/Cancel/Quit Anyway, ordered consumer close, authenticated
  shutdown, descriptor/writer-lock release, and exit after late failure;
- packaged relaunch after committed freeze starts or connects to a writable
  Runtime, while failed startup leaves a compatible Runtime reusable; and
- the tracked audit reproduces from a GitHub single-branch clean clone with zero
  unclassified and duplicate owners.

Each delivery unit runs `bun run typecheck`, relevant Core/renderer/E2E tests,
`bun run docs:check`, and `git diff --check`. The final cutover runs the complete
Core and renderer suites, relevant Electron E2E and packaged Runtime lifecycle
coverage, and records the existing first-window probe before and after without
claiming an optimization.

Real-desktop verification covers first launch, Runtime connection/replacement,
Outliner mutation and durability settlement, Memory publication, personal
ranking, one Agent tool round, Automation wake/resume, Source/local-file preview,
Settings and Provider Config, Launcher summon, window close/reopen, quit during
startup, quit cancel/retry/quit-anyway, fatal startup recovery, and immediate
packaged relaunch with no lost accepted work, frozen Runtime reuse, stale
descriptor, held writer lock, or residual desktop process.

### Acceptance Criteria

- **AC-1:** Every delivery unit is independently shippable, keeps one composition root,
  and has a clean-clone zero-unclassified audit for its claimed surface.
- **AC-2:** The final winning Electron instance has one typed `DesktopHost` composition
  root; `main.ts` contains only fixed bootstrap and narrow native event entry.
- **AC-3:** Dependency composition, startup orchestration, lifecycle arbitration,
  reversible disposal, ordered domain shutdown, safe quit, and Runtime process
  shutdown remain separate and inspectable.
- **AC-4:** Startup failure and ordinary quit cannot concurrently start and tear down the
  same producer, publish transport after quit, or clean up one resource twice.
- **AC-5:** Concurrent quit callers share only the active attempt; Cancel permits a later
  attempt to drain, tear down, and exit.
- **AC-6:** Failed-start rollback never treats authenticated Runtime identity as Host
  ownership and never issues Runtime shutdown without an explicit future lease.
- **AC-7:** `OutlineDocumentService` retains every recovered desktop-adapter
  responsibility; the standalone Runtime retains document/data authority.
- **AC-8:** Every reversible effect has one named owner and disposer; every ordered domain
  protocol remains outside generic disposal.
- **AC-9:** Current Source, Agent resource, preview, file authorization, Memory, and
  Automation contracts are composed without duplicate stores or compatibility
  layers.
- **AC-10:** No Cordis dependency, dynamic plugin runtime, service bag, generic service
  wrapper, alternate data store, or renderer plugin system lands.
- **AC-11:** Current specs describe the resulting ownership and lifecycle graph, and the
  durable audit reports no unclassified or duplicate owner.

## Open questions

None. Runtime launch ownership, lifecycle race policy, dependency order,
delivery granularity, and audit retention are fixed by this design. A future
exclusive Runtime launch lease or Cordis adoption requires a separate ratified
contract.

## Checklist

- [ ] Merge Source PR-I; rebase the first Host unit on that exact dependency tip.
- [ ] Repeat the open-PR/file collision check before every delivery unit.
- [ ] In the first unit, add the tracked audit driver, baseline manifest,
      inventory, dispositions, and clean-clone reproduction.
- [ ] Ship owned transport, Agent Host, Outline desktop, resource/preview,
      native-window/application, and final DesktopHost units as complete PRs.
- [ ] After the Host set, let Agent Large-Text Arguments and Startup Window First
      claim their independent work in live-collision order; keep Agent Resource
      Lifecycle after Large-Text, then keep Cross-Thread Reference and Agent
      Failure Recovery after Resource Lifecycle.
- [ ] Add lifecycle race, failed-start non-shutdown, startup/quit order,
      sender-admission, Runtime-relaunch, and ownership guards with their units.
- [ ] Remove a global, forwarding helper, or registration only after the audit
      classifies its replacement.
- [ ] Fold each shipped ownership boundary into current specs in the same PR.
- [ ] Run automated gates and real-desktop startup/quit/relaunch verification for
      the final cutover.
