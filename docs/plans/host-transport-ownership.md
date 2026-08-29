# Desktop Host Transport Ownership

**Shape:** ONE complete internal refactor in one PR.

## Goal

Give every Electron IPC handler, protocol registration, and process-lifetime
native transport effect one capability-scoped owner and one idempotent release
path while preserving current channels, payloads, sender checks, errors, and
quit behavior.

## Non-goals

- No `DesktopHost` composition root yet.
- No Agent, Outline, resource-preview, or window-service extraction.
- No public preload/Runtime protocol or user-visible behavior change.
- No service locator, dynamic plugin runtime, hot reload, or generic module
  lifecycle abstraction.

## Design

Replace monolithic `registerIpc()` and exit-only registrations with grouped
registrars for Outline, Agent/Memory/Automation, actions, updates, Source/assets,
preview/translation, native files, windows/settings/launcher, providers, and
diagnostics. Each registrar receives only the capabilities and window admission
it needs and returns one idempotent owner whose `dispose()` removes exactly its
handlers and listeners.

Protocols remain distinct from IPC because session lifetime and
`protocol.unhandle()` differ from `ipcMain.removeHandler()`. Window/WebContents
listeners remain with the owning window surface. `main.ts` is still the
composition root and explicitly disposes the combined transport during the
existing quit path.

A tracked `scripts/host-composition-audit/` driver derives the registration and
effect inventory from the exact dependency-tip source. Its committed baseline
records the commit and tree identity, machine-generated inventory, and a
disposition ledger mapping every entry to retained bootstrap, one named owner,
an equivalent typed edge, or a separately ratified removal. Source queries and
guards detect new unowned or duplicate effects; a README gives one-command
reproduction and the expected zero queues.

The baseline covers the complete future Host cut, not only transport: service/
store/client construction, startup and projection edges, degradation and
diagnostic branches, timers/listeners/hotkeys/protocols/IPC, mutable process
globals, and the freeze/drain/decision/teardown/Runtime-shutdown graph. This PR
classifies its transport slice; each successor classifies its claimed slice
without regenerating a different historical baseline.

Generated reports remain under `tmp/host-composition-audit/`. The driver,
baseline, inventory, dispositions, and reconstruction material remain tracked.
If a GitHub single-branch clone cannot reach the baseline tree, store a bounded
reconstruction patch anchored to a reachable parent and verify its tree hash
before comparison. This PR reaches zero unclassified transport entries; later
Host plans extend this same audit, and final cutover reaches zero unclassified
and zero duplicate owners across the complete baseline.

### Dependencies and collisions

`outline-source-model` lands first because it finalizes Source, native-file, and
preview transport contracts. No later Host plan or Agent transport consumer
starts before this PR merges.

### Verification

Tests prove complete unregistration, repeated disposal, partial-registration
rollback, sender/capability rejection, protocol release, and unchanged success/
error envelopes. The audit reproduces from a GitHub single-branch clean clone
and reaches zero for the claimed transport surface.

### Acceptance criteria

- Every current IPC/protocol/native transport registration has one named owner.
- Disposal removes the complete claimed surface exactly once and continues
  through individual release failures with aggregate diagnostics.
- Existing renderer/preload behavior and least-privilege sender checks are byte-
  and behavior-compatible.
- `main.ts` remains functioning and explicitly owns startup/quit sequencing.
- The tracked audit reproduces its exact baseline and reports zero unclassified
  transport entries without relying on an agent-maintained checklist.

## Open questions

None.

## Implementation checklist

- [ ] Add the tracked driver, exact-tree baseline, generated inventory,
      dispositions, guards, and clean-clone reconstruction.
- [ ] Extract capability registrars and explicit owners without changing DTOs.
- [ ] Add unregistration, rollback, authorization, and composition tests.
- [ ] Update Host/transport specs and run required repository checks.
