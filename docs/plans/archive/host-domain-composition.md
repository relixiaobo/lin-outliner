# Desktop Host Domain Composition

**Shape:** ONE complete internal refactor in one PR.

## Goal

Move the two authoritative backend client graphs out of `main.ts` into typed
Agent and Outline desktop hosts while preserving every post-#592 responsibility,
startup dependency, degradation path, and quit adapter.

Combining Agent and Outline extraction makes this PR a meaningful composition
boundary: after it merges, domain construction and cross-domain callbacks are
explicit, while `main.ts` still performs application orchestration. Splitting
individual stores or services would create review-only scaffolding and repeated
constructor churn.

## Non-goals

- No resource-preview, native-window, or application-service extraction.
- No final `DesktopHost`, Host lifecycle arbiter, startup reorder, or safe-quit
  redesign.
- No change to Outline Runtime, Thread/Turn/Item, Memory, Automation, tool,
  command, or preload contracts.
- No movement of document authority, AssetRecords, ContentStore, or indexes back
  into Electron main.

## Design

### Agent host

`createAgentHost()` owns managed Skills, configuration, workspaces, Memory
stores/extensions, `PiTurnExecutor`, one-time ToolRuntime bindings,
`ThreadService`, Automation components, and their current explicit startup and
ordered close adapters. It exports narrow Agent, Memory, and Automation
capabilities rather than a mutable service bag.

Real constructor cycles use assign-once typed callbacks that fail before
composition completes. Constructors acquire synchronous objects only; timers,
workers, refreshes, and connections remain explicit startup operations.

### Outline desktop host

`createOutlineDesktopHost()` owns `OutlineClientSupervisor`, desktop clients,
`OutlineDocumentService`, assets, projection observation, operation/durability
waiters, node-access ranking synchronization, and current Runtime-recovery
adapters. `OutlineDocumentService` remains the stateful desktop adapter and does
not claim document authority or exclusive ownership of a Runtime process.

### Composition boundary

`main.ts` constructs both hosts, supplies their typed cross-domain edges, and
keeps the existing startup and quit order. Existing optional initialization
continues to degrade with diagnostics rather than becoming fatal. The shared
responsibility audit proves each baseline domain service, producer, observer,
and shutdown edge is retained exactly once.

### Dependencies and collisions

`host-transport-ownership` lands first so domain capabilities target final
transport owners. `host-platform-composition` follows this PR. Agent Large-Text,
Skill authoring, and other Agent Host consumers wait for the complete Host chain,
not this intermediate extraction.

### Verification

Composition tests construct production graphs with injected external
authorities, verify one-time bindings, preserve startup order and degradation,
and close only started services. Runtime reconnect/projection, accepted mutation
settlement, Memory, Automation, and Thread admission fixtures remain green. The
responsibility audit has no unclassified or duplicate domain entry.

### Acceptance criteria

- Agent and Outline construction no longer live in `main.ts`.
- Each host exports narrow typed capabilities and explicit startup/close
  adapters without changing public behavior.
- Document and Agent authority remain in their existing domain stores/services.
- Current startup, failure, reconnect, durability, and quit behavior is preserved.
- No unused interface or later-only scaffold is introduced.

## Open questions

None.

## Implementation checklist

- [ ] Re-derive both domain graphs from the merged dependency tip.
- [ ] Extract Agent and Outline hosts with typed assign-once seams.
- [ ] Preserve startup, degradation, durability, and close ordering.
- [ ] Extend the responsibility audit and run focused plus repository checks.
