# Agent Project Capability Parity

This standalone restoration alternative supplies the capability baseline for
the broader [Projects and Conversation Work Folders](../conversation-work-folders.md)
design. It does not define that design's multi-folder behavior.

## Goal

Restore the Agent-facing Project capabilities shipped in PR #651 while keeping
the dedicated Project model tools removed. A reader asking the Agent to inspect,
create, edit, assign, unassign, or delete a Project must retain an executable
workflow. Replacing a model tool with UI-only instructions is a capability loss.

This is one complete feature in one PR: packaged CLI, discoverable built-in Skill,
Host admission and operations, native confirmation, UI refresh, and verification.
The separate [conversation work-folder design](../conversation-work-folders.md)
adds durable directory selection and history visibility. Project capability
parity remains independently shippable and does not depend on that behavior.

## Non-goals

Restoring `project_inspect` or `project_manage` to the model catalog; direct Agent
database edits; changing optional directories, task cwd, configuration selection,
membership lineage, or Automation deletion rules; automatic binding after visiting
a path; unrelated Git, verification, or process changes from PR #660.

## Design

### Evidence and decision

[PR #651](https://github.com/relixiaobo/lin-outliner/pull/651) shipped root-Agent
inspection and native-confirmed proposals over `ProjectService`.
[PR #660](https://github.com/relixiaobo/lin-outliner/pull/660) removed both tools
and their proposal/confirmation wiring without an Agent-callable replacement.
The user clarified that tool removal must preserve functionality. Use the shipped
pre-retirement behavior as the parity baseline, including cancellation and revision
checks; do not restore an earlier unshipped Workspace design.

FR-1: Provide a packaged `project` CLI and a discoverable built-in Project Skill.
The Agent invokes the CLI through Bash. Help/schema and one typed command registry
define bounded input and output. CLI code forwards operations to the live Host;
it does not open private stores or implement a second Project lifecycle.

### Capability and acceptance map

| Reader intent | Required replacement behavior | Acceptance |
| --- | --- | --- |
| List Projects or identify this Chat's Project | Bounded, pageable catalog with canonical directory hints, current membership, and exact revisions | AC-1 |
| Create a Project | Create a named Project with an optional directory using the existing validation and native confirmation | AC-2 |
| Rename a Project or change/clear its directory | Apply the explicitly inspected revision after native confirmation | AC-3 |
| Associate or move a Chat; remove its association | Bind/unbind the selected eligible root and its canonical descendants, preserving membership conflict checks | AC-4 |
| Delete a Project | Confirm consequences, enforce Automation dependencies, and preserve Chats, files, and live tasks | AC-5 |
| Cancel or stop an operation | Cancel the proposal, stop before persistence where cancellation wins, and report the actual outcome | AC-6 |

### Flow, rules, and failure recovery

FR-2: The Skill teaches inspect, choose an unambiguous target, submit the exact
change, and report the Host result. Existing durable organizational intent is the
trigger. Reading files or executing commands alone does not express that intent.
Current-Chat identity comes from trusted invocation context. Preserve the eligible
caller and explicit target rules of the retired root-Thread tools; knowing an ID
does not broaden authority. Do not add name-based silent rebinding.

FR-3: Agent-origin mutations retain the pre-retirement native confirmation path,
including canonical path/name, affected Chat, cancellation, and post-confirmation
revision/directory revalidation. A cancelled proposal is not retried unless the
reader requests it again. UI operations continue through the same service with
their existing interaction semantics. This design adds no second confirmation.

FR-4: Creating and then associating a Project is a sequence of supported operations.
If creation succeeds but assignment fails or is cancelled, report the created
Project and unchanged membership separately. Do not claim atomic completion,
blindly recreate after an uncertain response, or invent rollback deletion.

FR-5: Reuse the existing packaged-CLI/private-Host transport patterns for an
invocation-bound Project adapter. Preserve Host capability checks, trusted source
Thread/Turn/Item identity, exact request binding, cancellation, and lifecycle
availability. Caller identity or approval cannot be supplied by ordinary JSON or
an ambient environment variable. The adapter must not depend on enabling the
delegation experiment or alter its runtime contract.

FR-6: Successful CLI mutations refresh open Project UI and history through the
existing renderer catalog invalidation path. An unreadable catalog or stale
revision is reported as unavailable/conflict; it is never shown as successful
binding or guessed from cwd. Results stay bounded and omit unrelated Thread IDs.

### Implementation scope and collision check

Expected ownership: new `src/project/` CLI/contract/launcher files; Project Skill
under `src/main/builtInSkills/`; `ProjectService`; focused Bash capability/admission
adapters; `ToolRuntime`; `ThreadService`; Agent/Desktop/window Host composition;
`useProjectCatalog`; native-confirmation localization; package resources/build
registration; focused CLI, service, cancellation, transport, and UI tests.
Update Agent Core, tool-design, permission, Skill, integration, and rendering specs
with the final behavior. Existing Project storage remains authoritative.

`package.json` is infrastructure-owned: coordinate an isolated packaging/interface
change before dependent implementation, as required by the repository workflow.
Do not edit the board, changelog, dependency lock, or document command/type surface.

Collision evidence was refreshed against `origin/main` at `7c17f32d`: #664 startup
fault isolation and #668 scheduled-work design are integrated. Consume the final
fallible Host construction, cleanup, and availability gates. Open #669 claims
unified records, runtime context, and Thread lifecycle. Its scope, conversation
work folders, and future scheduling CLI work can overlap Bash/Host transport and
require a fresh claim-time check and shared-owner coordination. Profile/recovery
plans also require rechecking shared Host ownership.

## Open questions

- OQ-1: Ratify the proposed CLI/Skill implementation and shared packaging/interface
  scope. Capability preservation is the supplied product constraint, not an open
  choice between Agent execution and UI-only instructions.

## Acceptance and verification

- AC-1: Through the actual Skill/CLI/Bash path, the Agent lists more than one
  catalog page and reads current membership, including explicit no-membership.
- AC-2: Create works with and without a directory; invalid directories fail before
  persistence, cancellation creates nothing, and uncertainty does not duplicate it.
- AC-3: Rename/root update/root clearing preserve existing validation; competing
  edits during confirmation fail revision validation without overwriting newer data.
- AC-4: Bind, move, and unbind preserve canonical descendant behavior; the actual
  caller/target is checked and neither task cwd nor configuration is changed.
- AC-5: Deletion preserves Chats/files/tasks, rejects active dependency conflicts,
  and retains the existing restart reconciliation behavior.
- AC-6: Cancelled native dialogs, stopped Turns, unavailable Hosts, expired or
  modified invocation authority, and partial create/assign outcomes are truthful.
- AC-7: An open Project/history surface reflects successful CLI changes without
  requiring manual focus changes; selection and unsent conversation input survive.
- AC-8: Source and packaged launches expose the working replacement; the provider
  catalog still excludes both retired tools. Test caller capability restrictions
  through the real Bash admission path, not only the service in isolation.

Run typecheck, focused Core and renderer suites, actual CLI/Host integration and
packaged-launch smoke checks, light/dark confirmation/catalog verification,
docs checks, and diff checks. Tool absence alone is not a capability-parity test.
