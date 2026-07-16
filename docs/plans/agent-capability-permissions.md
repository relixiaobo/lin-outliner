# Agent Capability Permissions

## Goal

Give the agent the authority of a delegated operator without asking the user to
review risk. Existing resources execute immediately. A genuinely missing
resource follows the owning system's acquisition flow once, is remembered by
that owner, and then executes. Product invariants and system failures return an
honest unavailable result; they are not permission decisions and never offer a
"continue anyway" path.

Freedom is bounded by ownership, not action type:

- the **user data plane** is available within the current workspace and every
  persistent folder capability, including an explicitly granted filesystem
  root;
- the **Tenon control plane** remains inaccessible to agent file/process tools
  and is mutated only through product commands and services;
- the **host boundary** is the user's OS account, native authorization, and
  service credentials, not a Tenon command-risk classifier.

The observable authorization model is:

```text
allow                execute immediately
capability_required  acquire a missing resource, remember it, then execute
unavailable          the owner cannot provide this operation in the current context
```

Folder access is the only Tenon-owned capability acquisition in this feature.
OAuth, Keychain, TCC, and administrator authorization remain owned by their
provider or OS. Missing product input remains `ask_user_question`, outside the
authorization model.

This is shape **(a)**: one complete feature in one PR. Control-plane isolation,
folder capabilities, process execution, policy removal, runtime events, UI,
tests, and current specs ship together. Broad host capabilities must not land
before the private control plane is structurally excluded.

## Non-goals

- Do not ask for confirmation because an action is destructive, irreversible,
  external, unfamiliar, expensive, or hard to classify.
- Do not add publish, deploy, install, message-send, network, payment, or host
  administration approvals.
- Do not expose Tenon-stored provider credentials to child processes. A user
  may separately provide ambient CLI credentials through their own environment
  or the owning service's login flow.
- Do not weaken Electron renderer isolation, CSP, navigation guards,
  single-instance behavior, or per-clone `userData` isolation.
- Do not claim hostile-code containment. The process boundary implements folder
  capabilities and protects the Tenon control plane; Docker, Apple Events, OS
  services, and deliberately malicious executables remain outside that claim.
- Do not enable executable skill support. Executable support files still depend
  on the separate untrusted-code sandbox design.
- Do not preserve pre-release permission protocol or storage compatibility.

## Design

### Product Invariants

- **BR-1:** A tool with every required resource executes without a Tenon
  confirmation.
- **BR-2:** One persistent folder capability grants read/write access to that
  canonical directory and descendants across Runs, conversations, and restarts.
- **BR-3:** The filesystem root is a valid explicit capability. Granting it does
  not expose the Tenon control plane.
- **BR-4:** Selecting, dropping, or explicitly handing a folder to Tenon is
  already a grant gesture and never causes a duplicate prompt.
- **BR-5:** Shell syntax and action classification are audit-only. No command
  name, consequence, or parser uncertainty changes authorization.
- **BR-6:** User ambient environment variables reach child processes. Secrets
  loaded from Tenon's private provider store never enter a child environment.
- **BR-7:** Network behavior is consistent across tools. An unprivileged fetch
  client may access public, loopback, and private targets without Tenon auth.
- **BR-8:** Read-only or scoped Runs receive a narrowed tool catalog before the
  model runs. They do not discover their scope through permission failures.
- **BR-9:** Explicit user block rules remain direct and default-empty.
- **BR-10:** Audit and recovery observe execution; they never gate it.

### Ownership Boundary

The clean-slate boundary is a private control directory and agent-visible data
roots. The brownfield implementation keeps the current directory layout but
enforces the same boundary in one place:

| Resource | Agent read | Agent write | Mutation path |
|---|---:|---:|---|
| current workdir | yes | yes | file tools or process |
| attachment scratch | yes | no | app ingestion |
| output/cleanup scratch | yes | yes | file tools or process |
| persistent user folder | yes | yes | file tools or process |
| active skill resources | yes | no | invocation context |
| Tenon `userData` control state | no | no | product command/service only |

The workdir and scratch directories are explicit exceptions when they live
inside `userData`. Every other `userData` descendant is denied for both reads
and writes, even when Home or `/` is granted. The rule covers future files and
subdirectories rather than enumerating only today's three credential files.

Typed file tools apply the same ownership check before filesystem access. The
macOS process profile applies an immutable protected-container rule with
workdir/scratch exceptions. Tests use a real process to prove that a root
capability can read/write arbitrary user data but cannot read or mutate control
state.

### Decision Pipeline

```text
tool exists in this Run
  -> explicit user block
  -> product ownership invariant
  -> resource capability resolution
  -> execution
  -> audit and recovery
```

There is no host-destruction, payment, consequence, or general risk stage.
Unknown tools are unavailable because the tool catalog does not contain them.
Restricted tools are absent from that Run's catalog. OS-denied operations return
their real process/provider error.

Replace `allow | folder_required | blocked` with
`allow | capability_required | unavailable`. A capability request has a typed
kind; this feature implements only `folder`. Rename transient runtime transport,
commands, renderer projection, and UI away from approval terminology. There is
no persisted compatibility reader.

### Folder Capability Service

`FolderCapabilityService` remains the authority for user filesystem roots. It
canonicalizes existing directories with realpath, compacts nested grants,
persists private JSON atomically, and publishes serialized grant/revocation
events.

Remove every special rejection of the filesystem root. A root grant is explicit
full filesystem authority under the user's OS account, while the protected
control container remains excluded. The folder request shows the exact canonical
root and offers **Grant and remember** / **Cancel** only.

Revocation commits before publication and terminates active foreground or
background processes whose immutable snapshot contains the revoked user root.

### Unified Process Executor

Every agent-launched process uses `AgentProcessExecutor`: foreground/background
bash, skill shell, ripgrep, converters, and helper commands. The executor owns
spawn, environment construction, process-tree termination, output capture,
timeout, and the immutable capability snapshot.

On macOS, `MacOSFileSandboxAdapter` continues to use one probed Seatbelt adapter.
The profile:

1. allows ordinary process, network, IPC, and OS behavior;
2. allows reads/writes from the capability snapshot;
3. denies the protected `userData` container for reads and writes;
4. re-allows only the app-owned workdir/scratch exceptions inside that container.

If the adapter is unavailable, child processes fail honestly because Tenon
cannot enforce either folder capabilities or control-plane isolation. There is
no model-facing bypass.

Undeclared process filesystem access returns recoverable
`folder_access_required`; the model issues a fresh call with `required_folders`,
which preflights before process start. Tenon never replays a partially started
command.

### Credential Provenance

Delete name-based environment filtering. `OPENAI_API_KEY`, `GITHUB_TOKEN`,
`AWS_*`, and other variables inherited from the user's launch environment are
user-owned ambient capabilities and remain available to CLI tools.

The executor accepts an explicit set of private environment keys for any caller
that injects Tenon-owned values. Current provider credentials are loaded in main
and passed directly to provider requests, not copied into process environment.
Tests prove both directions: ambient credentials survive, explicitly private
injected values do not.

### Direct Host And Network Execution

Remove command hard-deny rules for recursive root/home deletion, disk tools,
raw devices, shutdown/reboot, and root permission changes. Remove the dormant
`payment` / `purchase` name guard. The OS account and native authorization own
those effects.

Remove private-network rejection from the unprivileged `web_fetch` route so
localhost and intranet development behave like bash networking. A future fetch
route that carries privileged cookies or credentials must be a distinct tool
with its own service contract, not a hidden exception here.

### Skills And Scoped Runs

Shell writes under `.agents/skills` are ordinary user-data writes and are no
longer process-denied or command-blocked. File-tool writes keep the existing
validated authoring gateway, provenance, undo, and immediate hot reload. Shell
or external-editor writes are validated at discovery/load time; invalid skills
remain unloaded with diagnostics instead of being treated as a permission
violation.

Remove restricted-mode permission evaluation and run-scoped preapproval rules.
Verifier, Research, isolated-skill, and explicitly scoped Runs derive a narrowed
tool catalog before model execution. A tool excluded from the catalog cannot be
called. Folder capabilities and the control-plane boundary still apply to every
visible tool.

### Interaction Flows

#### Foreground folder acquisition

1. A file tool targets a path or bash declares `required_folders`.
2. Ownership invariants reject private control-plane access without UI.
3. The folder service computes uncovered canonical roots.
4. The runtime creates one deduplicated folder request before side effects.
5. Grant persists the roots, re-evaluates, and executes once; Cancel aborts the
   call.

#### Unattended acquisition

An unattended Agent Session records one durable `needs_input` folder request
and stops before process launch. Granting the folder starts a new continuation
Session after the original is terminal. It never replays an earlier process.

#### OS/provider acquisition

OAuth, Keychain, TCC, administrator auth, and CLI login use their native owner
flow. Tenon may surface the concrete remediation but never adds a duplicate risk
confirmation. Success is remembered by the owning system.

### Events, Settings, And UI

Permission events become capability events with outcomes
`allow | capability_required | unavailable`. Folder acquisition uses
`capability_request` / `capability_resolved` runtime transport and a single
`agent_resolve_capability` command. Remove approval-named permission types and
persisted approval events.

Settings -> Security contains:

- **Folder access**: add, list, and revoke persistent roots, including `/`;
- **Your blocks**: list and remove explicit user blocks;
- **System boundary**: explain that Tenon control state is private while host
  operations follow the user's OS authority.

Audit descriptors remain human-readable activity metadata. They cannot change
the authorization result.

### Existing Behavior Removed

- all consequence/risk decisions, soft blocks, timers, and command exceptions;
- host-destruction and payment command/name hard blocks;
- `permissionMode` restricted evaluation and preapproval permission rules;
- root capability rejection;
- name-based child environment secret stripping;
- shell-write denial for governed skill directories;
- private-network `web_fetch` rejection for the unprivileged fetch tool;
- approval-named permission protocol and persisted approval events;
- sandbox override arguments and run-scoped folder grants.

## Files And Collision

Expected areas:

- `src/core/agentPermissionModel.ts`, `agentEventLog.ts`, `agentTypes.ts`, and
  `types.ts` for the clean capability protocol;
- `src/main/agentPermissions.ts`, `agentPermissionEvents.ts`,
  `agentToolPermissionRules.ts`, and `agentToolPermissionStore.ts`;
- `src/main/agentFolderCapabilities.ts`, `agentProcessExecutor.ts`,
  `agentLocalTools.ts`, `agentToolProcess.ts`, `agentSkillShell.ts`,
  `agentRuntime.ts`, and `main.ts`;
- unprivileged fetch validation and skill discovery/load diagnostics;
- renderer API/runtime, Composer, Security settings, localization, mocks, and
  focused core/renderer/E2E tests;
- current permission, tool, skill, architecture, and progress specs.

`docs/TASKS.md` and `CHANGELOG.md` remain main-agent owned. No dependency change
is planned, so `package.json` and `bun.lock` remain untouched.

Collision result on 2026-07-16: open PR #403 owns EPUB translation only and has
no file overlap. Sync-readiness PR #402 is merged into this branch before the
control-plane work; its document persistence changes are treated as current
main behavior.

## Risks

- **Delegated authority:** A mistaken agent or prompt injection can cause
  irreversible effects inside granted resources or through authenticated host
  services. This is the accepted maximum-freedom tradeoff; audit and recovery
  must not be misrepresented as prevention.
- **Protected-container ordering:** Seatbelt rule order must be proven with real
  process tests for Home and `/` capabilities, control-state denial, and allowed
  workdir/scratch exceptions.
- **Ambient credentials:** Passing the user's environment enables authenticated
  CLI effects. Tenon-owned provider values must remain provenance-separated and
  tests must fail if a private key reaches a child.
- **Deprecated platform mechanism:** `sandbox-exec` remains behind one adapter
  and health probe. A supported replacement is the revisit trigger.
- **Skill reload asymmetry:** Shell writes may not carry gateway provenance or
  immediate undo. Load-time validation and refresh behavior must be explicit.
- **Protocol breadth:** Removing pre-release approval/restricted protocol touches
  main, preload/API, renderer, mocks, and event replay together; no mixed model
  may remain.

## Open Questions

None. The selected target is ownership-based delegated authority: unrestricted
actions over user-capable resources, private Tenon control state, owner-specific
capability remediation, default-empty user blocks, and no risk review.

## Acceptance Criteria

- [ ] **AC-1:** Home and `/` can be persistently granted and reused without
      duplicate UI.
- [ ] **AC-2:** A root-capable file tool and real child process cannot read or write Tenon
      control state, but can read/write workdir and output scratch exceptions.
- [ ] **AC-3:** Ambient `GITHUB_TOKEN`, cloud credentials, and custom token variables reach
      child processes; explicitly private injected values do not.
- [ ] **AC-4:** Root/home deletion syntax, shutdown, disk tools, package installs, deploys,
      `git push`, unknown shell, and network writes produce no Tenon prompt/block.
- [ ] **AC-5:** `web_fetch` reaches localhost/private targets through its unprivileged
      client without credentials attached by Tenon.
- [ ] **AC-6:** Shell writes under `.agents/skills` are not permission-blocked; invalid
      definitions remain unloaded with a concrete diagnostic.
- [ ] **AC-7:** Verifier, Research, and scoped Runs never receive tools outside their
      catalog and no longer depend on restricted permission evaluation.
- [ ] **AC-8:** Foreground and unattended folder acquisition retain dedupe, persistence,
      continuation, and revocation semantics.
- [ ] **AC-9:** No approval-named permission transport, host hard-block matcher, payment
      guard, root rejection, or generic environment-name scrub remains.
- [ ] **AC-10:** Original Tana cleanup completes with zero permission cards and
      `unaccounted: 0`.
- [ ] **AC-11:** `bun run typecheck`, relevant core/renderer/E2E tests,
      `bun run docs:check`, and `git diff --check` pass, except the main-owned
      board reference until integration.
- [ ] **AC-12:** Security settings and capability cards pass light/dark visual verification.
