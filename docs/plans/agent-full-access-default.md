# Agent Full Access Only

## Goal

Make every Tenon agent file tool and local process run with the filesystem
authority of the current OS account. Remove the agent process sandbox, folder
capabilities, access-mode switching, and their recovery UI so imports and local
tooling do not stop at a Tenon-specific filesystem boundary.

This is shape **(a)**: one complete feature in one PR. Runtime policy, process
execution, persisted settings, renderer transport, Settings, event replay,
documentation, tests, and a real Tana import are changed and verified together.

## Non-goals

- Do not weaken Electron renderer isolation, CSP, navigation guards, the
  permission-handler allow-list, single-instance behavior, or per-clone
  `userData` isolation.
- Do not bypass macOS TCC, administrator authorization, Keychain controls, CLI
  login, or service credentials.
- Do not remove explicit `Action(...)` and `Command(...)` blocks, capability
  audit events, scoped tool catalogs, or run profiles.
- Do not remove read-before-edit, trash-backed deletion, skill-definition
  validation, or other typed-tool correctness contracts.
- Do not add per-command confirmations or consequence scoring.
- Do not add worktree, container, VM, port, process, or service isolation
  between concurrent agents.
- Do not change the outline command model or expose Node APIs to the renderer.

## Design

### One Access Model

A Run first receives its tool catalog. For a tool that exists in that catalog,
the runtime derives action descriptors for audit and explicit block matching.
An exact user block returns `unavailable`; every other call executes. There is
no filesystem mode, folder-root coverage check, control-plane exception, or
capability acquisition step.

Local-file audit and Block action kinds use `file.*.local_path` or
`file.*.sensitive_local_path`. The old `allowed_file_area` /
`outside_allowed_file_area` distinction is removed with the boundary it
described.

`agent-capabilities.json` persists only:

```json
{
  "blocks": ["Action(git.publish_remote)"]
}
```

The parser ignores unrelated JSON fields as ordinary unknown input but does
not implement a legacy mode or folder reader. Settings patches remove blocks
only. The Security pane shows a fixed **Full Access** status, explicit blocks,
and a truthful host-account boundary description.

### Files And Processes

Relative file paths continue to resolve against the Run workdir. Absolute paths
address the host filesystem directly, including paths outside the workdir and
Tenon `userData`, subject only to the current OS account and native system
authorization. File tools keep their operation-specific correctness rules.

`AgentProcessExecutor` directly spawns foreground and background shell work,
embedded Skill shell commands, ripgrep, document converters, and helper
processes. It owns environment construction, explicitly private environment-key
removal, timeout/output handling, and process-tree termination. It carries no
filesystem snapshot or sandbox adapter and never invokes `sandbox-exec`.

### Runs, Sub-agents, And Skills

The same host-account access applies to the main agent, delegated sub-agents,
scheduled/Dream Runs, and isolated Skills whenever their catalog contains a
file or process tool. Tool catalogs and run profiles still restrict which tools
the model can call; they do not isolate filesystem, processes, ports, Git state,
databases, credentials, or services.

Concurrent agents can therefore interfere when they touch the same worktree,
file, process, port, application state, or remote service. Avoiding that requires
separate worktrees, `userData` directories, ports, accounts, containers, or VMs
chosen by the workflow. This change does not claim concurrency isolation.

Typed Skill writes remain validated and hot-reloaded. Shell and external-editor
writes are validated when discovered; invalid definitions remain unloaded.

### Runtime And Storage Cut

Delete folder request/resolution commands, transient renderer events, durable
notification payloads, replay projection state, acquisition registries, and
composer cards. Capability audit contracts narrow to `allow | unavailable`.

Because replay state loses a persisted field, bump the agent event-store layout
and checkpoint versions. Startup wipes only agent event-store-owned paths for a
stale generation; outline documents, imported Tana nodes, assets, and unrelated
application data remain untouched. Pre-release policy requires this clean cut
instead of a compatibility reader.

The system prompt always states host-account Full Access and directs the model
to report native OS or provider denials directly. It does not describe folder
acquisition or an access-mode switch.

### Security Boundary

Full Access intentionally lets a file/process-capable Run read or change any
host path available to Tenon, including Tenon stores and plaintext provider
credentials, and combine that access with network-capable tools or processes.
Explicit blocks are dispatch policy, not tamper-resistant containment, because
a running process can modify their on-disk store.

Electron's renderer sandbox remains a separate product boundary. Native TCC,
administrator prompts, Keychain policy, and service authentication remain
owned by macOS or the provider.

### Verification

- Typecheck and run core, renderer, documentation, and focused E2E suites.
- Verify direct file and process access outside the workdir, blocks, audit
  events, Skill shell behavior, and absence of folder recovery transport.
- Inspect Security Settings in light and dark themes for truthful copy and
  stable layout.
- Import `/Users/lixiaobo/Downloads/b8AyeCJNsefK@2026-07-03.json` through the
  supported Tana inspect/transform/validate/preview/commit path in the isolated
  `dev:codex-2` profile and confirm zero unaccounted coverage.

### Files And Collision

The implementation removes the filesystem-mode and folder-capability modules
and updates capability policy/store/events, local tools, process execution,
runtime, prompt, renderer API/state/UI, event replay, tests, and the directly
affected agent specs. It changes the shared command/type protocol as one
coordinated deletion.

The Draft PR is the file-scope claim. PR #408 overlapped `main.ts`, Settings,
and i18n; this branch is rebased after it and preserves
`PreviewTranslationCacheStore` wiring. No dependency or build file changes.

### Risks

- Leaving one process helper on the old adapter would create inconsistent
  access between bash, Skills, converters, and imports.
- Leaving replay or IPC shapes behind would preserve unreachable recovery
  behavior and complicate the runtime.
- Broad host access exposes credentials and makes prompt injection or mistaken
  commands more consequential; the Settings copy and spec must state this.
- Shared host resources mean concurrent agents can race or overwrite each
  other; Full Access must not be described as isolated execution.
- The event-store generation bump must remain scoped to agent ledgers so Tana
  and outline data are not erased.

## Open Questions

None. The PM approved Full Access-only execution and removal of the agent
filesystem/process containment mode.
