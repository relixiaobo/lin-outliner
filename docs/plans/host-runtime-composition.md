# Desktop Host Composition And Resource Ownership

## Goal

Replace Electron main's implicit process-wide object graph with one explicit,
statically typed `DesktopHost` composition root while preserving the complete
post-#592 desktop and standalone Outline Runtime behavior.

A reviewer should be able to answer these questions without reading all of
`src/main/main.ts`:

- which owner constructs each long-lived service and bridge;
- which concrete operation starts each service, in what order, and with what
  failure policy;
- which owner releases every listener, timer, subscription, protocol, IPC
  handler, worker, store, client, and child process relationship;
- which state is authoritative in Electron main, the Agent subsystem, or the
  standalone Outline Runtime; and
- which shutdown steps are reversible cleanup versus the data-safety and
  authenticated Runtime-shutdown protocol.

`src/main/main.ts` becomes the fixed Electron bootstrap and native process-event
entry. It preserves pre-ready identity, `userData`, security, privileged-scheme,
diagnostic, and single-instance invariants; creates one `DesktopHost` only for
the winning application instance; and delegates post-ready behavior through
narrow typed methods.

This refactor adopts the useful part of Cordis -- composition outside consumers
and explicit ownership of effects -- without adopting a dynamic plugin runtime.
It makes no startup-speed, interaction-latency, memory-use, or line-count claim.

## Non-goals

- No Cordis, service locator, string-keyed context, dependency solver, Fiber
  state machine, configuration-driven module loading, hot reload, or runtime
  service replacement.
- No user-installable Host or renderer plugins, feature enable/disable system,
  third-party module loading, or plugin trust and permission model.
- No generic `ServiceModule<T> { service; close() }`. A domain may expose several
  capabilities, and construction, readiness, admission, durability, ordered
  quiescence, final release, and process exit remain different protocols.
- No `StartupCoordinator`, startup phase framework, first-window reorder,
  per-handler readiness gate, persistent startup-failure UI, or implementation
  of `startup-window-first`.
- No change to the Outliner Runtime contract, ChangeSet/Operation/Event model,
  Thread/Turn/Item protocol, Agent tools, Memory semantics, Automation behavior,
  action registry, renderer capabilities, or preload surface.
- No return of document state, durability, search indexing, AssetRecords, or
  ContentStore authority to Electron main.
- No replacement of the #592 Runtime freeze, drain, commit-freeze, authenticated
  shutdown, descriptor-release, or writer-lock-release protocol with ordinary
  disposal.
- No generic application database, database-per-module rule, cross-domain
  schema, or duplicate copy of document, Agent, Memory, Automation, resource,
  settings, diagnostic, or cache data.
- No visual, menu, notification-copy, or settings change.

## Design

### Delivery Shape

**Shape:** (a) ONE complete internal refactor in one PR. Static composition,
effect ownership, transport extraction, construction rollback, startup-order
preservation, safe-quit wiring, source guards, and current-spec updates ship
together. No intermediate merge may leave two composition roots, two quit
authorities, or a mixture of owned and process-exit-only IPC registrations.

The implementation starts from a main branch containing #592 and must not run
in parallel with another change that edits Agent construction, Host resource
resolution, `src/main/main.ts`, `AppQuitCoordinator`, or the Outline desktop
lifecycle. The exact order relative to the Agent resource-reference lifecycle is
the directional question under **Open questions**.

### Post-#592 Process And Data Authorities

Composition owns object relationships; it does not move authoritative state:

```text
Electron main
  |- native windows, menus, dialogs, permissions, protocols, IPC admission
  |- DesktopHost construction, startup, reversible effects, and quit adapter
  |- OutlineDocumentService desktop adapter
  |    |- accepted main-process mutation queue
  |    |- Runtime Event watch/reconnect and live desktop Projection
  |    |- Operation waiters and durability-failure observation
  |    `- personal-access ranking synchronization
  |- Agent Thread/Turn/Item stores, Memory control data, and Automation data
  `- local settings, credentials, diagnostics, caches, and node-access stats

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

`OutlineDocumentService` is therefore not the document authority and is not a
stateless transport wrapper. It is the stateful desktop adapter that preserves
the mutation tail, Event-to-Projection ordering, Runtime replacement recovery,
durability monitoring, and ranking synchronization recovered by #592. Moving
its construction must preserve those responsibilities and their tests.

Memory prose remains ordinary editable Outliner Nodes. `MemoryControlStore`
retains only Agent-owned control, lineage, recovery, visibility, citation, and
publication facts. `MemoryExtension` observes committed Runtime projection
deliveries, including their Operation causation, and publishes through the same
main-process mutation queue. `NodeAccessStore` remains local personal-ranking
state; its bridge mirrors full and incremental updates into the Runtime read
model without becoming document state.

The neutral `ContentStore` remains a physical exact-revision service shared by
the Runtime and future Agent references. It does not become a Host database or
logical file registry.

### Fixed Bootstrap And Host Boundary

`src/main/main.ts` retains only work that must precede or surround an ordinary
Host instance:

1. set application identity;
2. resolve and set `userData` before any service reads it;
3. create the diagnostic sink and install early process-failure handlers;
4. apply pre-ready command-line and privileged-scheme configuration;
5. acquire the single-instance lock and terminate the loser without constructing
   service graphs or starting background work;
6. create one `DesktopHost` for the winning instance;
7. call `DesktopHost.start()` from `app.whenReady()`; and
8. forward `second-instance`, `window-all-closed`, `before-quit`, activation,
   and development-parent death through narrow Host entry points where they need
   Host state.

The bootstrap does not expose a partially constructed Host to Electron event
callbacks. Construction failure disposes every acquired resource, reports the
original error plus cleanup failures, and exits with the existing failure
semantics.

An asynchronous `DesktopHost.start()` failure is not reduced to root-scope
disposal. The Host first withdraws any partially published transport/window,
stops only the producers that reached their started state, closes desktop
Runtime consumers, requests bounded authenticated shutdown of the exact Runtime
instance when one was started, and finally disposes remaining effects. Runtime
shutdown retains its own freeze-and-durability behavior. Cleanup errors are
reported, while the original startup error remains the failure returned to the
bootstrap. This is a failed-start rollback, not another user-facing quit path:
it presents no Retry/Cancel/Quit Anyway decision and owns no ordinary quit event.

The target responsibility split is:

```text
main.ts
  `- fixed bootstrap
       `- createDesktopHost(environment)
            |- static typed domain composition
            |- DesktopHost.start(): explicit current startup order
            |- ResourceScope: reversible effects and final release
            `- AppQuitCoordinator: durability, irreversible teardown,
                                    authenticated Runtime shutdown, and exit
```

There is deliberately no host-wide readiness object. `DesktopHost.start()` is a
one-caller orchestration method, not a readiness authority. Existing service
owners keep their current `init()`, `initialize()`, `load()`, `start()`, retry,
and single-flight semantics. IPC remains unpublished until the current awaited
startup sequence completes.

### Current Construction Graph

`createDesktopHost(environment)` reproduces the following post-#592 graph with
typed factory parameters and typed exports:

```text
Bootstrap environment + DiagnosticLogStore/reportError
  |
  |- Outline desktop boundary
  |    |- development-session identity and Runtime launch description
  |    |- OutlineClientSupervisor
  |    |- DesktopOutlineClient                 (renderer Outline transport)
  |    |- OutlineDocumentService               (main desktop adapter)
  |    |    `- durability failure -> DiagnosticLogStore
  |    `- OutlineDesktopAssetService
  |
  |- Agent host
  |    |- managed Skills + BrowserPilotHost + configuration + worktrees
  |    |- MemoryControlStore
  |    |- TimelineMemoryStore -> OutlineDocumentService
  |    |- MemoryExtension
  |    |- PiTurnExecutor -> one-time ToolRuntime binding
  |    |- ThreadService
  |    |- AutomationStore/Worktree/Dispatcher/Scheduler/Service
  |    `- ToolRuntime -> ThreadService + AutomationService
  |
  |- projection bridges
  |    |- Outline projection -> MemoryExtension
  |    `- Outline projection <-> NodeAccessStore <-> Runtime ranking sync
  |
  |- preview host
  |    |- PreviewTranslationCacheStore + PageTranslationService
  |    `- LocalFilePreviewStreamRegistry + URL-preview session
  |
  |- native files, windows, launcher, updates, and ActionInvocationService
  `- capability-grouped IPC/protocol/native-event transport
```

The current graph contains real constructor cycles. They are represented as
one-time local bindings with narrow callback types, not hidden by a mutable
service bag:

- `PiTurnExecutor` callbacks reach `ToolRuntime`, which is created after
  `ThreadService`;
- `AttachmentResolver` callbacks reach `ThreadService` after it is opened; and
- `AutomationDispatcher` and `AutomationScheduler` callbacks reach the final
  `AutomationService`.

Each binding fails immediately if invoked before composition completes. It can
be assigned once only. No `any`, string registry, global singleton lookup, or
general-purpose late-binding container is introduced.

Existing domain registries remain domain registries: Agent extensions, canonical
model tools, actions, Runtime capabilities, and renderer capabilities keep their
current identity and admission authority.

### Current Startup And Publication Graph

`DesktopHost.start()` preserves this exact post-#592 order:

1. reconcile provider configuration best-effort and clear a stale remembered
   selection when the active provider changes;
2. await `OutlineDocumentService.init()`, which establishes the Runtime watch,
   reads the initial Projection, and incorporates buffered Events;
3. initialize the Memory mutation index from that live Projection;
4. await `ThreadService.initialize()`;
5. await `MemoryExtension.startWorker()`;
6. await `AutomationService.start()`;
7. register the `powerMonitor` resume wake effect;
8. load `NodeAccessStore` with warning-level degradation;
9. replace the Runtime personal-access ranking from the loaded snapshot with
   warning-level degradation;
10. install the app icon and About metadata;
11. register the authority-validated asset and opaque local-preview protocols;
12. apply the stored native theme and configure default/URL-preview sessions;
13. register desktop IPC;
14. create the Main window;
15. schedule the app-update and managed-Skill update timers; and
16. create the Launcher window, register its renderer capabilities and hotkey,
    install the application menu, and register activation handling.

Construction-time background work that currently bootstraps managed Skills,
loads Agent settings, or prunes scratch remains explicitly inventoried. The
refactor may move it behind the winning-instance boundary, but may not add an
await to the first-window path, make optional failure fatal, or silently run it
twice.

`startup-window-first` remains a later behavioral feature. It owns window-first
publication, capability-specific readiness gates, DAG parallelism, persistent
failure UI, and measurement. This refactor neither anticipates that mechanism
nor adds unused readiness scaffolding for it.

### ResourceScope Owns Effects, Not Protocols

`ResourceScope` is a thin owner for reversible process-lifetime effects:

```ts
interface ResourceScope {
  defer(dispose: () => void | Promise<void>): void;
  child(name: string): ResourceScope;
  dispose(): Promise<void>;
}
```

It owns cancellation/unregistration for Electron and process listeners, timers,
watchers, subscriptions, global hotkeys, protocol handlers, IPC handlers,
transport connections, and idempotent final release that has no independent
ordering semantics. Named child scopes may be released early at an explicit
Host lifecycle point and remain idempotent when the parent later disposes.

The contract requires:

- reverse-registration disposal;
- one cached disposal promise so concurrent and repeated callers join the same
  work;
- exactly-once invocation of every disposer;
- continuation after an individual disposer fails;
- normalized aggregate reporting with child ownership context; and
- construction rollback for every effect acquired before a later step fails.

Use `AsyncDisposableStack` when the Electron runtime and TypeScript library
surface both support it. The wrapper remains necessary because raw concurrent
`disposeAsync()` callers do not by themselves provide the Host's shared-promise
contract or named error reporting. If the current ES2022 configuration needs
`ESNext.Disposable`, coordinate the smallest explicit `tsconfig.json` change
with its infrastructure owner.

`ResourceScope` does not freeze admissions, calculate an accepted frontier,
wait for durability, choose Retry/Cancel/Quit Anyway, stop ordered Agent
producers, commit a Runtime freeze, authenticate a Runtime instance, request
Runtime shutdown, wait for descriptor/writer-lock release, or call
`app.quit()`/`app.exit()`.

`closeAgentServices()` remains the ordered Agent shutdown protocol. Individual
Memory, Thread, and Automation stores are not registered as independent generic
disposers. Outline desktop consumers are released at their explicit position
before Runtime shutdown. `OutlineClientSupervisor.shutdown()` is never placed in
any `ResourceScope`.

### Post-#592 Quit Graph

`AppQuitCoordinator` remains the only safe-quit and irreversible-exit authority.
The Host supplies typed adapters to its existing verbs; it does not replace the
coordinator with `DesktopHost.close()`.

```text
before-quit
  -> freeze local Outline mutation admission synchronously
  -> await every caller already admitted to OutlineDocumentService.mutationTail
  -> install the cross-client Runtime freeze barrier
  -> read latest accepted Runtime revision
  -> drain that revision to durable (bounded attempt)
       |- failure/timeout -> Retry -> repeat the same in-flight drain
       |- failure/timeout -> Cancel -> Runtime unfreeze + local unfreeze
       `- failure/timeout -> Quit Anyway -> continue irreversibly
  -> commit Runtime admission freeze
  -> teardown desktop consumers and local domains
       |- unregister hotkeys, resume/listener/transport effects
       |- dispose PageTranslationService
       |- bounded best-effort local flushes
       |- Automation stop -> Memory worker stop -> ThreadService close
       |                    -> Memory store close -> Automation store close
       `- close DesktopOutlineClient and OutlineDocumentService
  -> authenticated OutlineClientSupervisor.shutdown(signal)
       |- validate contract digest, development session, descriptor owner,
       |  live instance identity, and ownership again
       |- request shutdown of that exact Runtime
       `- wait for descriptor and writer-lock ownership to disappear
  -> app.exit(0), even after a late teardown/shutdown failure
```

The existing drain and Runtime-shutdown timeouts remain independent. Closing a
watch or client cannot abort an admitted mutation before the durability barrier,
and shutdown cannot happen while a desktop Runtime consumer remains live. A
cancel before the irreversible phase restores the exact existing local and
Runtime admission state; nothing attempts to reconstruct disposed services.

### Desktop Transport Ownership

Replace `registerIpc()` with capability-grouped registrars. Each registrar:

- receives only the services and window authorization it uses;
- preserves the exact channel, payload decoder, capability/sender check, and
  error semantics;
- returns or immediately registers a disposer that removes every handler and
  listener it added; and
- has focused wrong-window and unregistered-sender coverage.

The post-#592 groups are:

- Outline Runtime renderer transport;
- app updates;
- action invocation and renderer-step acknowledgement;
- Agent Core, message context menu, Memory, and Automation;
- the admitted app-command router for Agent, assets, preview, and translation;
- node-access observation and Runtime ranking synchronization;
- windows, Settings, Launcher, theme, locale, and translation preferences;
- provider configuration, Agent settings, and diagnostics; and
- native file picking/search/preview/open/reveal plus attachment upload.

Protocols are owned separately from IPC because `protocol.unhandle()` and
session lifetime differ from `ipcMain.removeHandler()`. Window/WebContents
listeners belong to the window instance that registered them, not the process
transport scope. Renderer capability registration and sender checks remain at
the current least-privilege boundary.

### Implementation Surface

The expected implementation surface is concrete rather than deferred to the
first coding step:

- `src/main/desktopHost/createDesktopHost.ts` -- the sole typed composition root;
- `src/main/desktopHost/resourceScope.ts` -- reversible effect ownership;
- `src/main/desktopHost/outlineHost.ts` -- supervisor, desktop clients/adapters,
  assets, and typed quit exports without Runtime authority;
- `src/main/desktopHost/nodeAccessBridge.ts` -- projection pruning and Runtime
  personal-ranking synchronization;
- `src/main/desktopHost/previewHost.ts` -- page translation, preview cache,
  local streams, and URL-preview session ownership;
- `src/main/desktopHost/windowHost.ts` -- Main/Settings/provider/Launcher window
  state and native window effects;
- `src/main/desktopHost/actionHost.ts` -- `ActionInvocationService` wiring;
- `src/main/desktopHost/transport/` -- the capability-grouped registrars above;
- `src/main/agent/createAgentHost.ts` plus focused managed-Skill, execution,
  Memory, and Automation builders; no broad `agentServices` bag;
- `src/main/localFiles/` -- existing picker, search, metadata, icon, thumbnail,
  and bounded-preview behavior extracted without semantic change;
- `src/main/outlineClient/ipc.ts` -- disposer-returning Outline registration;
- `src/main/main.ts` -- fixed bootstrap and Host event forwarding; and
- focused tests for `ResourceScope`, construction rollback, current startup
  order, transport disposal/admission, and the complete quit graph.

The refactor updates brittle source guards rather than weakening them, including
the guards in `appQuitCoordinator.test.ts`, `outlineRetirement.test.ts`, and
`urlPreviewSecurity.test.ts`. Current architecture is folded into
`docs/spec/architecture.md`, `agent-core.md`, `agent-memory.md`,
`agent-automations.md`, and `error-observability.md` where the ownership graph is
described.

No public protocol change is expected. `package.json`, `bun.lock`,
`src/core/commands.ts`, `src/core/types.ts`, and preload contracts remain out of
scope. `tsconfig.json` changes only under the coordinated disposable-library
condition above. Dev agents do not edit `docs/TASKS.md` or `CHANGELOG.md`.

### Responsibility Audit And Build Order

#592 demonstrated that a mechanically successful architecture cutover can omit
mature responsibilities. This refactor therefore treats the current tree, not a
handwritten checklist or an old `main.ts`, as the migration queue.

Before moving code, generate and retain review evidence for every current:

- top-level service/store/client construction;
- `init`, `initialize`, `load`, `start`, `subscribe`, and projection-observer
  edge;
- timer, process/Electron/WebContents listener, global hotkey, protocol, and IPC
  registration;
- startup degradation branch and diagnostic route;
- quit freeze/drain/decision/teardown/shutdown step; and
- main-process mutable global that survives startup.

Each entry receives one disposition: retained bootstrap, moved to a named owner,
replaced by an equivalent typed edge, or explicitly removed under a separate
ratified decision. This refactor has no planned removals. Re-running the driver
derives the remaining queue from source and finishes with zero unclassified
entries. File existence and empty source queries, not agent memory, prove
completion.

Build inside the single implementation PR in this order:

1. add the generated responsibility inventory and behavioral/source guards;
2. add and fully test `ResourceScope` without changing startup or quit order;
3. extract the Outline desktop boundary and encode the #592 quit adapters;
4. extract `AgentHost`, preserving its one-time cycles and ordered shutdown;
5. extract node-access, preview, native-file, action, window, and update owners;
6. replace the monolithic transport with owned capability registrars;
7. create `DesktopHost.start()` with the exact current sequence;
8. reduce `main.ts` to the fixed bootstrap and event forwarding only after every
   responsibility has a classified destination;
9. fold the final graph into current specs; and
10. run the full automated and real-desktop gate before removing the migration
    inventory from generated `tmp/` output. Durable guard logic remains tracked.

### Cordis Adoption Gate

Static composition is the target architecture, not temporary scaffolding. A
separate PM-ratified design may reconsider Cordis only when a concrete product
requirement needs runtime graph semantics, such as supported Host profiles with
materially different graphs, user-visible capability replacement or
enable/disable, trusted third-party modules with an isolation and permission
model, or live unload/reload. A large `main.ts`, directory symmetry with DSH, or
calling internal domains "plugins" is not sufficient.

If that gate is crossed, typed factories may become plugin adapters, but service
identity, dependency disappearance, active-Turn unload, persistent-state
compatibility, configuration validation, renderer loading, and third-party trust
require their own design. This refactor does not pre-commit those answers.

### Failure Policy

Required Outline, Agent Thread, Memory, and Automation startup failures retain
their current fatal behavior. Provider reconciliation, node-access loading and
ranking sync, update checks, managed-Skill refresh, scratch cleanup, derived
caches, optional external tools, and inspection-only observers retain their
current bounded degradation and diagnostic routes.

Cleanup failure never skips later cleanup. Construction rollback and late
teardown report errors with ownership context while preserving the original
failure. Renderer-visible errors contain no secret, raw private path, or Host
internal identity. No capability enters a hidden Cordis-style `PENDING` state.

### Verification

Focused tests prove:

- construction failure releases every acquired effect exactly once and never
  publishes a partial Host;
- failed startup withdraws partial publication, stops only started producers,
  closes Runtime consumers, and attempts bounded exact-instance Runtime shutdown
  while preserving the original startup failure;
- concurrent and repeated scope disposal joins one completion;
- child and parent scopes release in reverse ownership order;
- one disposer failure does not prevent later disposal and failures aggregate;
- `DesktopHost.start()` follows the exact post-#592 sequence without adding
  readiness gates or duplicate starts;
- the node-access snapshot is synchronized after load, and later projection and
  access changes keep local and Runtime ranking state aligned;
- every transport registrar preserves sender/capability rejection and removes
  its complete registration set;
- quit preserves local admission closure, admitted-tail settlement, Runtime
  freeze/drain, Retry/Cancel/Quit Anyway, commit freeze, ordered consumer close,
  authenticated exact-instance shutdown, descriptor/writer-lock release, and
  exit-after-late-failure;
- packaged relaunch after committed freeze starts a different writable Runtime;
  and
- the generated responsibility audit reports zero unclassified or duplicated
  owners, with only the fixed bootstrap allow-list remaining in `main.ts`.

Run `bun run typecheck`, `bun run test:core`, `bun run test:renderer`, relevant
Electron E2E and packaged Runtime lifecycle coverage, `bun run docs:check`, and
`git diff --check`. Record the existing first-window probe before and after;
investigate a material regression without claiming an optimization.

Real-desktop verification covers first launch, Runtime connection/replacement,
Outliner mutation and durability settlement, Memory publication, personal
ranking, one Agent tool round, Automation wake/resume, Preview, Settings and
Provider Config, Launcher summon, window close/reopen, quit cancel/retry/quit
anyway, and immediate packaged relaunch with no lost accepted work, frozen
Runtime reuse, stale descriptor, held writer lock, or residual desktop process.

### Acceptance Criteria

- One typed `DesktopHost` is the sole composition root for the winning Electron
  instance.
- Dependency composition, explicit startup order, reversible effect disposal,
  domain shutdown, safe quit, and Runtime process shutdown remain separate and
  inspectable.
- `OutlineDocumentService` retains every #592 desktop-adapter responsibility;
  the standalone Runtime retains every document/data authority.
- Every post-lock reversible effect has one named owner and disposer; permanent
  pre-ready process invariants are explicit in the bootstrap allow-list, and
  every ordered domain protocol stays outside generic disposal.
- `main.ts` contains only the fixed bootstrap and narrow native event entry;
  there is no line-count target.
- Startup publication and failure behavior match the post-#592 baseline.
- The complete freeze/drain/decision/consumer-close/authenticated-shutdown/exit
  graph is preserved, including immediate packaged relaunch writability.
- No Cordis dependency, dynamic plugin runtime, service bag, generic service
  wrapper, alternate data store, or renderer plugin system lands.
- Current specs describe the resulting ownership and lifecycle graph, and the
  responsibility audit has no unclassified entry.

## Open questions

- **Sequencing authority:** the earlier #591 review proposed `#587 -> #591 ->
  Agent Result And Resource Reference Lifecycle -> Cross-Thread Reference` so
  the Host foundation precedes its new resolver/workspace consumers. After #592,
  the main-owned board records `#587 -> Agent Result And Resource Reference
  Lifecycle -> Cross-Thread Reference` and does not place #591 in that chain.
  These are conflicting directional decisions. Recommendation: main and the PM
  explicitly choose one before implementation. If #591 stays before the file
  lifecycle, it must provide a stable typed insertion point for the later Host
  resolver without inventing that feature. If product work keeps the board's
  order, #591 waits until the file-lifecycle graph settles and must not block it.

## Checklist

- [ ] Resolve the sequencing conflict with the main-owned board.
- [ ] Rebase on the selected dependency tip and repeat the open-PR file collision
  check.
- [ ] Generate the post-#592 responsibility inventory from source.
- [ ] Add resource, rollback, startup-order, quit-order, Runtime-relaunch,
  sender-admission, and architecture guards before moving ownership.
- [ ] Move complete owners in reviewable green commits inside one PR.
- [ ] Remove superseded globals, wiring, forwarding helpers, and registrations
  only after the audit classifies their replacement.
- [ ] Update current specifications in the same PR.
- [ ] Run automated gates and real-desktop startup/quit/relaunch verification.
