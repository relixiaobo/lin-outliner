# Agent Delegated-Scope Permissions

## Goal

Replace the current prompt-heavy agent permission experience with a smaller
runtime model:

```text
delegated scope -> default allow
boundary crossing -> ask, and remember as a bounded grant
safety floor -> block
```

The product principle is that the agent is the user's delegated operator, not an
untrusted stranger. When the user has handed Tenon a working domain, the agent
should be free to do what the user could reasonably do in that domain: read,
write, reorganize, transform files, run local validation, and repair its own
mistakes. Approval should be reserved for crossing a trust boundary, not for
ordinary work.

This is a plan-track, security-sensitive change. Shape: **one complete feature
PR** that replaces the permission semantics end-to-end, updates the spec in the
same change, and leaves the system in a coherent state. Internal build order can
stage the taxonomy, evaluator, runtime/UI, and tests, but no partial PR should
ship a second permission model.

## Non-goals

- Do not weaken Electron/native hardening, CSP, navigation blocking, renderer
  sandboxing, userData isolation, or secret storage.
- Do not let the model decide whether permission is needed. The runtime owns the
  boundary decision.
- Do not treat "has side effects" as "dangerous". Local mutation inside the
  delegated scope is normal agent work.
- Do not rely on broad `Action(shell.project_script)` or `Bash(*)` grants to
  reduce prompts.
- Do not introduce migrations. The app is pre-release; stale permission settings
  can normalize or be reset.
- Do not add per-folder workspace trust UI unless this PR also introduces an
  explicit user gesture for handing Tenon that folder.

## Current Problem

The existing system has the right central seam: every governed tool call goes
through `evaluateAgentToolPermission`, and main runtime plus skill-shell share
the same evaluator and ask resolver. The issue is the vocabulary above that
seam.

Today several concepts are collapsed into the same outcome:

- a true safety redline;
- a command the parser did not recognize;
- a static command outside the allowlist;
- a user preference for extra confirmation;
- a boundary crossing into external systems or untrusted local paths.

The worst case is shell classification. `shell.unknown` defaults to `deny` and
`unknownShellDescriptor` marks it as a `platformHardBlock` and redline. A static
but unprofiled command such as `which soffice` therefore becomes a tell-only
`permission_notice`, even though the correct behavior is a direct allow for a
read-only probe. The user sees noise and cannot approve the action.

The current "Always allow" path also stores broad action grants such as
`Action(shell.project_script)`. That reduces prompts by widening a category, not
by remembering the bounded operation the user actually approved.

## Design

### One User Model

The user-facing model is:

> The agent can work freely where you delegated authority. It asks before
> crossing that boundary. It cannot perform safety-floor actions.

Settings should eventually present this as delegated areas and grants, not as a
mode ladder that users must interpret. `Ask First`, `Balanced`, and `Full Access`
can remain as compatibility storage during the change, but the product concept
should move to delegated scope plus boundary grants.

### Delegated Scope

Delegated scope is the set of places and capabilities the user has already
handed to the agent. In v1 it includes:

- Tenon documents and outliner state;
- the agent workdir;
- the agent scratch/output area for reads;
- user-provided attachments and copied local files materialized by Tenon;
- explicit paths/folders added through a future handoff gesture, if that gesture
  ships in the same PR;
- external account capabilities only after the user has connected and granted
  that capability.

Inside delegated scope, ordinary work defaults to `allow`:

- outliner reads, edits, creates, deletes, undo/redo;
- workdir file read, write, edit, and scoped delete;
- file conversion and media/PDF processing whose input/output stay in delegated
  roots;
- local read/probe/search shell;
- local project validation scripts;
- temporary build cleanup inside the workdir;
- web search and web fetch reads.

Deletion inside delegated scope is not automatically dangerous. The safety
boundary is scope and recoverability, not the existence of a delete verb. Root,
home, whole-workdir, sensitive, and unscoped recursive deletes remain guarded by
the safety floor or a boundary prompt.

### Boundary Crossing

Boundary crossing means the action leaves delegated scope or changes an external
system. It should ask, and approval should produce a bounded remembered grant
when the user chooses "always".

Ask-level examples:

- reading a local path the user has not delegated;
- reading sensitive local paths;
- dependency installation or package-manager mutation;
- git push and GitHub CLI mutation;
- deployment and package publishing;
- sending email/messages or writing to external services;
- network writes from shell;
- long-running background processes;
- sandbox or execution containment overrides;
- agent config writes and other runtime-control changes.

These are not hard redlines by default. They are authorization moments.

### Safety Floor

The safety floor is intentionally narrow and non-configurable. It blocks actions
that are hidden, self-amplifying, credential-exfiltrating, host-destructive, or
real-world irreversible.

Hard-block examples:

- hidden execution: `eval`, backticks/command substitution used to construct
  executable text, base64/openssl decode piped into a shell, `curl|sh` and
  equivalent remote-code pipes;
- credential or private-data exfiltration: sensitive file/path mention combined
  with a network or opaque external sink;
- persistence and self-amplification: writes to shell startup files, cron,
  LaunchAgents, systemd user units, git hooks, agent permission files, provider
  secrets, or other runtime trust stores;
- host destruction: recursive root/home/whole-workdir delete, disk formatting,
  raw disk writes, root ownership/permission changes, shutdown/reboot;
- payment, purchases, or legal/real-world commitments;
- direct permission-system mutation by the agent.

Static but unprofiled shell is not a safety-floor action. It should be a
boundary prompt or a learned profile miss.

### Effect Taxonomy

Replace broad action-kind-only decisions with an effect descriptor that every
tool call can project:

```ts
type OperationEffect =
  | 'read'
  | 'write'
  | 'delete'
  | 'execute'
  | 'network_read'
  | 'network_write'
  | 'external_mutation'
  | 'sensitive_access'
  | 'persistence'
  | 'permission_control'
  | 'payment';

interface OperationProfile {
  id: string;
  effects: OperationEffect[];
  scope: 'delegated' | 'boundary' | 'safety_floor';
  reversible: boolean;
  audit: 'event' | 'diff' | 'tool_output';
  grantPattern?: string;
}
```

`AgentToolActionKind` can remain as the event and settings compatibility
identifier, but the evaluator should choose `allow | ask | deny` from
`scope + effects + safety floor`, not from action kind alone.

The research skill plan should use this same taxonomy for read-only catalog
restriction. There should not be a second, hand-maintained "read-only" list.

### Shell Profiles

The shell path should become profile based:

- `shell.read_probe` — `pwd`, `date`, `which`, `command -v`, `type -p`, `stat`,
  `file`, safe environment probes.
- `shell.read_search` — `ls`, `cat`, `rg`, safe `grep`, safe `find`, `head`,
  `tail`, `wc`, non-mutating `sed`.
- `shell.safe_filter` — stdin-only filter profiles inspired by OpenClaw safe
  bins: `head`, `tail`, `wc`, `cut`, `sort`, `uniq`, `jq`, `tr`, with denied
  flags and no filesystem operands unless explicitly profiled.
- `shell.git_read` — `git status`, `diff`, `log`, `show`, `branch`.
- `shell.project_validation` — known local validation/build/test commands such
  as `bun run typecheck`, `bun test`, `npm test`, `pnpm test`, `make test`,
  `vitest`, `pytest`, with no publish/deploy/install subcommands.
- `shell.package_mutation` — dependency install/update/remove; asks unless a
  bounded package-manager grant exists.
- `shell.external_mutation` — git push, GitHub mutation, deploy, publish, email,
  messaging, cloud CLIs; asks.
- `shell.unprofiled_static` — parsed static command that has no profile; asks.
- `shell.opaque` — hidden/dynamic execution; blocks when it hits the safety floor
  or asks only when the opaque form is not itself a redline.

The immediate bug class disappears because `which soffice` and
`command -v libreoffice` are `shell.read_probe`, not unknown shell.

### Typed Tools Before Shell

High-frequency automation should use typed tools instead of generic shell.

Add a document/file conversion tool for the current PPT/PDF/image workflow:

```ts
interface FileConvertInput {
  input_path: string;
  output_format: 'pdf' | 'png' | 'jpg' | 'txt';
  output_dir?: string;
}
```

The implementation resolves paths through the same delegated-root rules, uses
`spawn(file, argv, { shell: false })`, and records outputs as structured tool
results. A LibreOffice/PDF conversion inside delegated roots is ordinary work and
should not ask.

This reduces shell surface while giving the agent more freedom.

### Remembered Grants

Replace broad "always allow this action kind" as the primary flow with bounded
profile grants:

```ts
type TrustGrant =
  | { kind: 'profile'; profileId: string; pattern: string; scope: 'global' | { kind: 'folder'; root: string } }
  | { kind: 'path'; access: 'read' | 'write'; root: string }
  | { kind: 'external_capability'; provider: string; capability: string }
  | { kind: 'skill_hash'; skillFile: string; contentHash: string; source: 'user' | 'project' };
```

Examples:

- allow `shell.project_validation:bun run typecheck` in this delegated root;
- allow `file.convert:pptx->pdf` inside the agent workdir;
- allow `git.push` for the current repo remote;
- allow package mutation in this root;
- allow reading a selected folder.

Fallback exact-command hashes are acceptable for static commands that cannot be
represented by a safer profile, but they should be a last resort.

### Approval UI

Approval cards should appear only for boundary crossings. Copy should name the
boundary, not the implementation detail.

Preferred actions:

- **Allow Once**
- **Always Allow This Boundary**
- **Deny**

Tell-only cards remain only for safety-floor blocks. Remove or demote "Hand
everything to Tenon / Full Access" as a normal escape hatch; the default model
should be permissive enough that users do not need a panic bypass.

### Events and Audit

More freedom needs stronger audit, not more prompts.

Every allowed local mutation should already have a useful trace:

- outliner operations are undoable and evented;
- file writes/edits carry diffs or structured patches;
- shell/project validation records command, cwd, exit code, and output;
- conversion tools record input, output, tool binary, and format;
- remembered grants record provenance from approval card or Settings.

The transcript should show what happened without interrupting before every
normal local action.

### Evaluation Pipeline

The new runtime order:

1. Normalize tool call into descriptors with `OperationProfile`.
2. Apply safety-floor checks. Any floor hit returns `deny` and a tell-only
   notice.
3. Apply explicit configured deny grants.
4. Apply restricted delegation sandbox and skill `allowed-tools` narrowing.
5. Resolve delegated scope. In-scope ordinary effects allow.
6. Apply remembered profile/path/external grants.
7. Boundary misses ask if an approval channel exists.
8. Unattended boundary misses return structured `permission_denied`; absence is
   never approval.

This preserves the existing central seam but gives it cleaner vocabulary.

## Expected File Scope

- `src/core/agentPermissionModel.ts` — action/effect/profile taxonomy and
  read-only partition.
- `src/main/agentPermissions.ts` — evaluator, shell profiles, safety floor,
  boundary miss behavior.
- `src/main/agentToolPermissionRules.ts` — grant parsing, profile grant matching,
  broad-rule rejection.
- `src/main/agentToolPermissionStore.ts` — store shape for profile/path grants
  or compatibility normalization.
- `src/main/agentRuntime.ts` — approval resolution, "always" persistence,
  `permission_notice` semantics.
- `src/main/agentSkillShell.ts` — parity with main runtime.
- `src/main/agentLocalTools.ts` and tool catalog/descriptions — typed conversion
  tool and shell guidance.
- `src/renderer/ui/agent/AgentComposer.tsx` — approval-card copy/actions.
- `src/renderer/ui/agent/AgentSettingsView.tsx` and
  `permissionSettingsModel.ts` — delegated grants/security settings.
- `src/core/i18n/messages/en.ts` and `zh-Hans.ts` — new copy.
- `docs/spec/agent-tool-permissions.md`, `docs/spec/agent-tool-design.md`, and
  `docs/spec/agent-skills.md` — spec sync.
- Permission, runtime, skill-shell, renderer, and e2e tests.

## Tests

- Matrix tests for delegated scope, boundary crossing, and safety-floor block.
- Shell profile tests:
  - `which soffice`, `command -v libreoffice`, `stat`, and `file` allow as
    read probes;
  - safe `find`/`grep`/`sed` allow; `find -exec`, `find -delete`, and `sed -i`
    do not use read profiles;
  - static unprofiled commands ask, not hard block;
  - opaque hidden execution hits ask/block according to safety-floor rules.
- Typed conversion tests for input/output inside and outside delegated roots.
- Grant tests proving "always" stores bounded profile/path grants, not broad
  shell action grants.
- Safety tests proving grants cannot bypass host destruction, sensitive
  exfiltration, persistence writes, permission modification, or payment.
- Skill-shell parity tests.
- Approval UI tests: boundary asks show allow-once/always/deny; safety-floor
  notices remain dismiss-only.
- Settings tests for grant display, revocation, diagnostics, and compatibility
  normalization.
- Docs check after adding the board entry from main.

## Collision Self-Check

Open PR scan found no branch currently claiming the permission evaluator or
security settings implementation. The adjacent item is the research skill plan,
which intends to derive read-only tool restriction from `AgentToolActionKind`.
This plan should coordinate by making the effect/profile taxonomy the shared
source for that read-only partition.

`docs/TASKS.md` and `CHANGELOG.md` are main-owned and intentionally not edited by
this dev-agent plan draft.

## Open Questions

- Should the first implementation remove the visible three-mode control, or keep
  it as a compatibility advanced setting while the user-facing copy moves to
  delegated scope?
- Do we introduce an explicit folder handoff gesture in this PR, or limit v1 to
  current app-owned roots and attachments?
- Which external capabilities are ready to model as remembered boundary grants
  now: GitHub, git remotes, web write, email/messages, deploy?
- Should dependency installation be remembered per package manager and root, or
  stay ask-only until there is a richer package-diff preview?
- How much shell parsing should be improved now versus shifted into typed tools?
