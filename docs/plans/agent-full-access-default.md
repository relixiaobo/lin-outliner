# Agent Full Access Default

## Goal

Make Tenon agents operate like a trusted local coding agent by default. A Run
must be able to read and write every path available to the current OS account,
launch local runtimes and package managers without a Seatbelt wrapper, and use
Tenon's local CLI bridges without acquiring folder capabilities first.

Keep the current folder-capability sandbox as an explicit **Restricted** mode
for users who choose it. The default and missing persisted value is **Full
Access** for both existing and new development profiles.

This is shape **(a)**: one complete feature in one PR. The persisted mode,
runtime policy, process execution, Settings surface, documentation, tests, and
real Tana import verification ship together.

## Non-goals

- Do not weaken Electron renderer isolation, CSP, navigation guards,
  single-instance behavior, or per-clone `userData` isolation.
- Do not bypass native macOS TCC, administrator authorization, Keychain access
  controls, or service login requirements.
- Do not migrate provider credentials back to Keychain or change their current
  plaintext `0600` storage. Full Access intentionally accepts that an agent
  process can read and modify those credentials.
- Do not remove Restricted mode, its remembered folder roots, or its capability
  request/recovery flow.
- Do not add per-command approval prompts or consequence scoring.
- Do not make user block rules tamper-resistant in Full Access. They remain a
  dispatch policy, not a containment boundary, because a full-access process can
  modify the local policy store.
- Do not change the document command protocol or expose Node APIs to the
  renderer.

## Design

### Product Decisions

- **DEC-1:** Tenon exposes two filesystem execution modes:
  `full-access` and `restricted`.
- **DEC-2:** A missing, malformed, or pre-feature mode value resolves to
  `full-access`. No compatibility migration rewrites the file merely to record
  the default.
- **DEC-3:** The selected mode applies to foreground, background, delegated,
  and scheduled Runs. A restricted tool catalog such as Dream remains
  restricted by tool availability, but any file/process tool it does receive
  follows the global mode.
- **DEC-4:** Explicit `Action(...)` and `Command(...)` blocks are evaluated in
  both modes before execution. Full Access does not claim that the on-disk block
  store is protected from an already-running process.
- **DEC-5:** Full Access uses the current macOS account as the filesystem
  boundary. Tenon's `userData`, including document state, event logs,
  capability settings, provider credentials, and Import API descriptors, is
  directly accessible.
- **DEC-6:** Restricted preserves the current ownership model: folder
  capability roots are agent-visible while Tenon control state stays private.

### Persisted Mode

Extend `agent-capabilities.json` with one optional field:

```json
{
  "filesystemMode": "restricted",
  "folders": ["/absolute/path"],
  "blocks": ["Action(git.publish_remote)"]
}
```

`AgentCapabilityConfig` always carries the normalized mode. Serialization
preserves folder grants and blocks when the mode changes. Existing folder roots
remain stored while Full Access is selected so switching back to Restricted
restores the user's prior scopes.

The existing Settings save command accepts a mode replacement alongside folder
and block removals. Folder selection remains an immediate grant; the mode
change remains a draft until Save, consistent with the rest of the Security
pane.

### Tool Capability Evaluation

The decision pipeline remains:

```text
tool exists in this Run
  -> explicit user block
  -> filesystem mode
  -> execution
  -> audit and recovery
```

In Full Access, capability evaluation still derives action descriptors for
audit and exact user-block matching, then allows the call. It does not apply
folder-root coverage, emit `folder_access_required`, or reject Tenon control
state. Typed file tools therefore have the same filesystem authority as bash.

In Restricted, the existing control-plane and folder-capability checks remain
unchanged. Folder request cards, durable unattended recovery, remembered roots,
and revocation behavior are reachable only from this mode.

### Process Execution

Every process snapshot carries the normalized filesystem mode and revocation
generation. `AgentProcessExecutor` chooses one of two paths:

- **Full Access:** spawn the requested executable directly after environment
  sanitization. Do not probe or invoke `/usr/bin/sandbox-exec`, overlay control
  plane protections, or translate folder roots into a Seatbelt profile.
- **Restricted:** retain the current `MacOSFileSandboxAdapter`, protected
  `userData` overlay, immutable root snapshot, and Seatbelt health probe.

All process call sites continue to supply a snapshot; there is no separate
per-caller bypass. This keeps foreground/background bash, skill shell, ripgrep,
converters, and helper commands on one authoritative mode.

### Mode Transition And Revocation

Changing the persisted mode increments the same serialized snapshot generation
used by folder revocation. The service publishes a mode-change event only after
the new document is durable.

The process executor terminates every active agent process on a mode change.
Snapshot generation is checked before and after restricted sandbox preparation,
so a process prepared under the old mode cannot start after the change. New
calls read the new mode and construct a fresh snapshot.

Pending folder capability requests are not replayed while Full Access is
active. Runtime recovery treats them as covered and resolves/continues them
under the newly selected mode; switching to Restricted resumes normal folder
coverage semantics.

### Settings

Settings -> Security begins with an **Agent Access** segmented mode control:

- **Full Access**: default; local processes and file tools can read and modify
  everything available to the macOS account, including Tenon data and stored
  provider credentials.
- **Restricted**: processes use the macOS sandbox; file access is limited to the
  workdir and remembered folders; Tenon control state remains private.

The Folder Access group is shown only for Restricted mode. Existing grants are
not deleted when hidden. Your Blocks remains visible in both modes. The System
Boundary copy reflects the selected mode and never claims that Tenon control
state is private in Full Access.

Changing modes and saving shows no second confirmation: selecting Full Access
is the user's explicit authorization gesture. The control has stable dimensions,
keyboard focus, and light/dark coverage.

### Prompt And Documentation

The system prompt describes the selected mode rather than always instructing
the model to use folder capability recovery. Full Access tells the agent to
operate under the host account and report native OS/provider denials directly.
Restricted retains the current folder capability guidance.

`docs/spec/agent-tool-permissions.md` becomes authoritative for both modes and
states the accepted plaintext-secret and control-state consequences. Related
permission wording in the agent tool design is updated only where it would
otherwise contradict the new default.

### Security Consequences

Full Access deliberately combines filesystem read/write access with the
existing process network authority. A prompt-injected or mistaken agent can:

- read and exfiltrate `agent-secrets.json`, OAuth tokens, shell credentials, and
  other files readable by the user;
- modify Tenon document/event stores outside the command layer and corrupt
  state;
- alter capability settings, explicit blocks, startup files, repositories, or
  other host data;
- exercise the same authority from an unattended Agent Session if its tool
  catalog includes file or process tools.

These are accepted Full Access semantics, not residual implementation bugs.
Restricted remains the containment option.

## Requirements And Acceptance

- **FR-1:** Missing persisted mode resolves to Full Access.
- **FR-2:** Full Access file tools and processes use the current OS account's
  filesystem authority without folder acquisition or Seatbelt.
- **FR-3:** Restricted preserves current folder and control-plane enforcement.
- **FR-4:** Mode changes are durable, invalidate stale snapshots, and terminate
  active agent processes.
- **FR-5:** Settings accurately presents and persists both modes without
  deleting remembered folders or blocks.
- **FR-6:** Tana import can complete through the supported `tenon-import`
  inspect, transform, validate, preview, and commit path in `dev:main`.

- **AC-1:** With no `filesystemMode` field, a file tool can read and write an
  absolute path outside the workdir without a capability request.
- **AC-2:** In Full Access, a real child process can read a file under another
  user-visible directory and read the Tenon Import API descriptor without
  `/usr/bin/sandbox-exec` in its launch command.
- **AC-3:** In Restricted, existing process tests still deny an ungranted path
  and Tenon control state while allowing granted roots.
- **AC-4:** An explicit block prevents its matching dispatch in either mode.
- **AC-5:** Saving Restricted during an active Full Access process terminates
  that process and rejects a stale spawn snapshot.
- **AC-6:** Switching Full Access -> Restricted -> Full Access preserves the
  prior folder and block lists.
- **AC-7:** Security Settings render the selected mode and truthful boundary
  copy in English and Simplified Chinese, light and dark modes.
- **AC-8:** The approved Tana export produces valid inspection, pack, coverage,
  validation, preview, and committed import results in isolated `dev:main`
  data.

## Files And Collision

Expected areas:

- `src/main/agentCapabilityRules.ts`, `agentFolderCapabilities.ts`,
  `agentCapabilityStore.ts`, and `agentCapabilities.ts` for mode persistence and
  tool policy;
- `src/main/agentProcessExecutor.ts`, `agentSkillShell.ts`, `agentRuntime.ts`,
  and `agentSystemPrompt.ts` for process snapshots, transitions, recovery, and
  prompt truthfulness;
- `src/renderer/ui/agent/AgentSettingsView.tsx`, renderer capability settings
  helpers, and `src/core/i18n/messages/*` for the Settings surface;
- focused core, renderer, and E2E permission tests;
- `docs/spec/agent-tool-permissions.md` and any directly contradictory agent
  tool wording.

Collision check at approval time:

- PR #407 (Issue persistence): no overlapping implementation files;
- PR #409 (Table view): plan-file-only claim, no overlap;
- PR #408 (preview translation cache): overlaps
  `AgentSettingsView.tsx` and both i18n message files. This feature is ordered
  after #408 and must rebase it before final verification. It does not modify
  preview translation behavior.

No infrastructure-ownership file or core command/type protocol change is
planned. If implementation proves that `package.json`, `main.ts`,
`src/core/commands.ts`, or `src/core/types.ts` must change, stop and coordinate
that scope before editing.

## Risks

- A mode default implemented in only the process layer would leave typed tools
  blocked and recreate the current inconsistent behavior.
- A mode default implemented only in capability evaluation would let bash start
  with an unexpectedly restricted snapshot.
- A Full -> Restricted transition that does not terminate old processes leaves
  an unsandboxed escape after the UI claims restriction.
- Hiding Folder Access must not erase existing grants.
- Full Access makes plaintext provider secrets and the Import API bearer token
  agent-readable; Settings and specs must say so explicitly.
- PR #408 can create textual conflicts in Settings/i18n even though the product
  behavior is independent.

## Open Questions

None. The PM approved Full Access as the default, optional Restricted mode, and
the resulting access to plaintext Tenon credentials and all `userData`.

## Implementation Checklist

- [ ] 1. Persist and normalize the mode, covering FR-1 and FR-5.
- [ ] 2. Make tool evaluation mode-aware, covering FR-2, FR-3, and FR-4.
- [ ] 3. Make process snapshots and transitions mode-aware, covering FR-2,
      FR-3, and FR-4.
- [ ] 4. Update runtime recovery and prompt behavior, covering FR-1 through
      FR-4.
- [ ] 5. Build the Settings surface and copy, covering FR-5.
- [ ] 6. Update current specs, covering all approved security consequences.
- [ ] 7. Run automated and real Tana import verification, covering AC-1 through
      AC-8.
