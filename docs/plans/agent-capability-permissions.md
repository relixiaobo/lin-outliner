# Agent Capability Permissions

## Goal

Make direct execution the default and reserve interruption for one honest case:
Tenon is missing a folder capability that the user can grant.

The agent is a delegated operator. Permission UI is capability remediation, not
risk review. Command complexity, reversibility, external effects, and parser
uncertainty never ask the user to judge an operation. Existing capabilities run
immediately; a newly handed folder is remembered across Runs, conversations,
and app restarts.

The permission path has exactly three observable outcomes:

```text
allow            execute immediately
folder_required  acquire one persistent folder capability, then execute
blocked          refuse without offering an override
```

This is shape **(a)**: one complete feature in one PR. The capability store,
process boundary, foreground/background/skill execution, runtime events, UI,
tests, and specs ship together. A partial change would preserve a bypass or
misrepresent the runtime.

## Non-goals

- Do not ask for confirmation because an action is risky, irreversible,
  external, unfamiliar, or difficult to classify.
- Do not add network, publish, deploy, install, or message-send approvals.
- Do not weaken Electron host security, renderer sandboxing, CSP, navigation
  guards, secret storage, or per-clone `userData` isolation.
- Do not build an adversarial arbitrary-code container. The process boundary
  governs direct filesystem access by normal agent-launched processes; it does
  not promise containment against a deliberately malicious program escaping
  through Docker, Apple Events, or another privileged host service.
- Do not enable executable skill support. Such support remains blocked until
  the separate untrusted-code sandbox design is complete.
- Do not conflate missing product input with permission. A workflow may still
  ask for a destination, format, or other required decision when it cannot be
  inferred safely.
- Do not preserve pre-release permission storage compatibility. Delete the old
  rule reader rather than carrying two models.

## Design

### Product Invariants

- **BR-1:** Any operation with all required capabilities executes without a
  Tenon confirmation.
- **BR-2:** One folder grant covers read and write access to that canonical
  folder and its descendants, globally and persistently.
- **BR-3:** Selecting, dropping, or explicitly mentioning a folder is itself a
  grant gesture and never causes a second Tenon prompt.
- **BR-4:** A hard platform guard, user block, or restricted-Run denial fails
  directly and never offers "continue anyway."
- **BR-5:** General shell parsing is audit-only. Unknown syntax, empty segments,
  heredocs, substitutions, and variable assignments cannot produce a prompt.
- **BR-6:** OS or provider authorization uses the owning system's flow. Tenon
  does not stack a duplicate confirmation on top.

### Four Independent Layers

```text
tool call
  -> hard guards
  -> folder capabilities
  -> execution
  -> audit
```

Each layer has one job:

1. **Hard guards** return `blocked` for the non-overridable platform floor,
   explicit user blocks, and restricted-Run capability denials.
2. **Folder capabilities** return `allow` or `folder_required`; they never score
   risk.
3. **Execution** applies the resolved capability snapshot to file tools and
   child processes.
4. **Audit** derives human-readable action labels after the authorization
   decision. Classification cannot alter that decision.

Delete the current cross-coupling between shell classification, consequence
ranking, soft blocks, approval cards, and remembered command exceptions.

### Folder Capability Service

Add one `FolderCapabilityService` as the only authority for local roots. It
canonicalizes existing directories with realpath, removes nested duplicates,
answers containment queries, persists user grants atomically with private file
permissions, and publishes revocation events.

The effective root set is typed by origin and access:

| Root | Access | Lifetime |
|---|---|---|
| current workdir | read/write | Run context |
| app attachments | read | app-owned |
| app cleanup/output | read/write | app-owned |
| active skill resources | read | active invocation |
| user-handed folder | read/write | persistent |

Persist only canonical folder roots and explicit user block rules. Remove the
generic grant DSL, read/write `Scope(...)` variants, run-scoped once grants,
external/command grants, and `softBlockAllows`.

Explicit handoff routes and the runtime request route call the same grant API.
A runtime request shows the canonical folder that will be granted. If macOS
needs a native privacy grant, the action opens the system directory picker;
otherwise the single Tenon action persists the capability directly.

### Unified Agent Process Executor

Add one `AgentProcessExecutor` and route every agent-driven process through it:

- foreground bash;
- explicit and automatically backgrounded bash;
- embedded skill shell;
- model-driven document/PDF/image converters and search helpers.

The executor receives an immutable capability snapshot and owns spawn, process
group termination, output capture, timeout, and capability metadata. Delete
parallel process launch implementations where they would create different
authorization semantics.

`bash` gains a structured `required_folders` argument. The model declares only
folders outside the implicit root set. The runtime canonicalizes and preflights
them before process start, so approval never retries a partially executed
command.

On macOS, a narrow `MacOSFileSandboxAdapter` builds a per-process Seatbelt
profile and launches through `/usr/bin/sandbox-exec`. The profile allows normal
process and network behavior while constraining direct user-data reads and
writes to the immutable root snapshot plus required system/app temporary paths.
No third-party sandbox package owns Tenon's policy. The adapter performs a
startup health probe and fails closed if the platform mechanism is unavailable.

An undeclared filesystem access is denied by the process sandbox and returned
as a recoverable `folder_access_required` result when the target can be
identified. The runtime never auto-replays that command. The model may issue a
new call with the missing folder declared, which then preflights before launch.

Remove `dangerouslyDisableSandbox` from schemas, normalization, permission
descriptors, results, and tests. No model-facing or persisted sandbox bypass
exists.

### Interaction Flows

#### Foreground capability acquisition

1. A tool call declares or inherently targets a local path.
2. Hard guards run first; a blocked call fails without UI.
3. The folder service finds one or more uncovered canonical folders.
4. The runtime creates one deduplicated folder request before any side effect.
5. **Grant and remember** persists the folder, re-evaluates the original call,
   and executes it once. **Cancel** aborts only that call.
6. There is no allow-once option, countdown, or command exception.

#### Unattended capability acquisition

An unattended Agent Session cannot wait on ephemeral renderer state. It records
one durable `needs-input` folder request and stops before process launch. The
origin conversation surfaces the request once. Granting the folder schedules a
new execution attempt; it does not replay an old process that may have started.

#### Revocation

Revocation removes the persisted root immediately for new calls. The process
executor tracks each active capability snapshot and terminates foreground or
background processes that still hold the revoked root before reporting the
revocation complete.

### Hard Guards

Keep a small structural floor rather than a general risk classifier:

- host-wide destruction such as root/home erase, disk erase, shutdown/reboot,
  or recursive root ownership/permission changes;
- mutation of Tenon's permission, provider credential, or protected secret
  stores through agent tools;
- payment without a product-owned payment flow;
- explicit user block rules;
- restricted-Run tool/capability ceilings.

Hard guards return `blocked` and an audit reason. They never create an approval
request and no folder grant can bypass them. Remote-code pipes, persistence
writes, publishes, dependency installs, network writes, and static unknown
commands are not prompt categories.

Tenon-owned provider secrets remain structurally unavailable to child
processes. User-owned files inside a handed folder are within the user's grant
and may be used as part of the requested work; do not pretend a shell-string
exfiltration heuristic is an enforceable confidentiality boundary.

### Events And UI

Keep `tool.permission.checked` and `tool.permission.resolved`, but reduce new
outcomes to `allow | folder_required | blocked`. Tool permission requests no
longer emit a second `approval.*` event track. Generic approvals and
`ask_user_question` remain separate product interactions.

Settings -> Security contains three plain sections:

- **Folder access**: add, list, and revoke persistent folder capabilities;
- **Your blocks**: list and remove explicit user blocks;
- **System protections**: read-only explanation of the small hard floor.

The composer renders one compact folder-capability request with the canonical
path and **Grant and remember** / **Cancel** actions. Remove soft-block copy,
countdowns, allow-once, command exceptions, and raw grant-rule diagnostics.

### Existing Behavior Removed

- `soft_blocked` decisions and built-in soft blocks;
- `autoBlockMs` and countdown timers;
- allow-once and exact-command always-allow paths;
- `softBlockAllows` and generic scope/command/external grants;
- general consequence/risk decisions;
- shell unknown/empty-segment permission decisions;
- duplicate permission plus approval event recording;
- run-scoped file grants;
- sandbox override arguments.

## Files And Ownership

Expected areas:

- `src/core/agentPermissionModel.ts`, `src/core/agentEventLog.ts`;
- `src/main/agentPermissions.ts`, `agentPermissionEvents.ts`,
  `agentPermissionAskResolver.ts`, `agentToolPermissionRules.ts`,
  `agentToolPermissionStore.ts`;
- `src/main/agentLocalTools.ts`, `agentToolProcess.ts`, `agentSkillShell.ts`,
  `agentRuntime.ts`, and a new capability/process-sandbox module;
- `src/main/main.ts` for native folder acquisition;
- renderer API types, runtime projection, Composer capability UI, Security
  settings, and English/Simplified Chinese messages;
- focused core/renderer/E2E tests;
- `docs/spec/agent-tool-permissions.md`, `agent-tool-design.md`,
  `agent-skills.md`, and `agent-progress.md`;
- `docs/plans/agent-skills-authoring.md` only to point its future executable
  support at the shared executor without enabling that feature.

`docs/TASKS.md` and `CHANGELOG.md` remain main-agent owned. No dependency change
is planned, so `package.json` and `bun.lock` should remain untouched.

## Risks

- **Deprecated platform mechanism.** `sandbox-exec` is deprecated. Keep it
  behind one adapter, health-probe it in dev/package tests, and fail closed. A
  supported replacement is the revisit trigger, not a reason to duplicate
  policy now.
- **CLI compatibility.** Build tools read caches/config outside the workdir.
  Keep system/tool roots explicit, test the real command corpus, and add an
  app-owned root only when it is necessary and narrower than a user folder.
- **Path races.** Background processes can race typed file operations. Recheck
  canonical containment at the operation boundary and add symlink-replacement
  regressions; the process sandbox remains the child-process enforcement layer.
- **Revocation races.** Serialize store mutation, root publication, and process
  termination so Settings cannot report success while an old process retains
  the capability.
- **Overclaiming containment.** Specs and UI must state the delegated-operator
  boundary honestly. Executable skill support remains disabled rather than
  relying on this filesystem-only sandbox as hostile-code isolation.

## Open Questions

None. The product direction selects persistent read/write folder capabilities,
default direct execution, direct hard denial, and the delegated-operator threat
model.

## Verification

- [ ] Original Tana cleanup command completes with zero permission cards.
- [ ] Unknown static shell, heredocs, installs, network writes, and `git push`
      execute without permission UI.
- [ ] File tools and every shell path request an uncovered folder exactly once.
- [ ] A grant survives a new Run, conversation, and app restart.
- [ ] Explicit folder handoff creates no duplicate request.
- [ ] Foreground, background, skill shell, and converter processes share the
      same effective roots.
- [ ] Hard guards and user blocks fail without an approval card.
- [ ] Undeclared process access cannot escape the filesystem boundary or
      trigger automatic replay.
- [ ] Revocation terminates affected active processes and blocks new access.
- [ ] `bun run typecheck`, relevant core/renderer/E2E tests,
      `bun run docs:check`, and `git diff --check` pass.
- [ ] Packaged app smoke covers sandbox availability, the real Tana route, and
      persistent grant restore.
- [ ] Settings and the folder request pass light/dark visual verification.
