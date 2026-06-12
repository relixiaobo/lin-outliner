# Agent Skills

Lin implements agent skills as local `SKILL.md` instruction bundles that the model can discover, invoke, and carry across compaction. The execution path is integrated through `pi-agent-core`.

## Search Paths

Code-registered `built-in` skills load first. They are immutable, ship with the
app, and cannot be shadowed by mutable local skills with the same name. The
current built-in skill is `/skillify`, a user- and model-invocable workflow for
creating or updating local skills through normal file tools; its `when_to_use`
gates it to explicit user save/update requests, so a conversational "save this
as a skill" routes through the curated guidance instead of ad-hoc file writes.
Built-ins are code-registered instructions, not local `SKILL.md` files. Like
cc-2.1 bundled skills, they only receive a `Base directory` prefix when they have
real extracted reference files. Current built-ins have no extracted files, so
their prompts contain only the skill body; post-compact bookkeeping records them
as `built-in:<name>` rather than a readable file path.

Default mutable skill directories are always enabled:

- `~/.agents/skills`
- `<workspace>/.agents/skills`

Each skill is a directory with a `SKILL.md` file. Additional skill directories can be configured in Agent settings; those directories are appended after the defaults and can be absolute, workspace-relative, `~/...`, `$HOME/...`, or `${HOME}/...`.

Every skill carries one of three sources, symmetric with agent definitions: `built-in` (code-registered, immutable), `user` (the personal library — `~/.agents/skills` plus configured directories outside the workspace root), and `project` (the work context — `<workspace>/.agents/skills`, configured directories inside the root, and nested `.agents/skills` directories discovered at runtime near touched files). Runtime discovery is a discovery mode, not a separate source.

## Frontmatter

Supported frontmatter fields:

- `description`: short listing text shown to the model.
- `when_to_use` or `when-to-use`: extra trigger guidance appended to the listing.
- `allowed-tools`: preapproval rules such as `file_read` or `Bash(git diff:*)`.
- `arguments`: named argument bindings for `$name` replacement.
- `argument-hint`: user-facing hint for slash skill usage.
- `disable-model-invocation`: prevents automatic model invocation through the `skill` tool.
- `user-invocable`: controls slash skill usage.
- `model`: optional model override for inline skills, or child-agent model override for forked skills.
- `effort`: optional reasoning effort override for inline skills, or child-agent effort override for forked skills.
- `shell`: optional shell for embedded command expansion. Lin currently supports `bash`.
- `context: fork`: runs the rendered skill body through the same-conversation delegation runtime instead of injecting it into the parent context.
- `agent`: optional agent definition for `context: fork` skills. If omitted, Lin uses the built-in `general` agent. If provided, the agent definition must resolve; Lin fails the skill invocation instead of silently falling back to another agent.
- `paths`: path-conditional activation patterns.

Mutable skill bodies are loaded with:

```text
Base directory for this skill: <skill-directory>

<SKILL.md body>
```

Built-in skill bodies with no extracted reference files are loaded without a
directory prefix:

```text
<skill body>
```

Argument placeholders are `$ARGUMENTS`, `$ARGUMENTS[n]`, `$0`, `$name`, `${AGENT_SKILL_DIR}`, and `${AGENT_CONVERSATION_ID}`.
For mutable skills, `${AGENT_SKILL_DIR}` resolves to the skill directory. For
built-in skills without extracted reference files, `${AGENT_SKILL_DIR}` is not
substituted because there is no real directory to read from.

Skill bodies may include embedded shell commands using fenced blocks that start with ```` ```! ```` or inline `!` command spans. Commands are expanded only when the skill is invoked, after argument and environment placeholder substitution. They execute through the same local bash runner and permission policy used by normal agent tool calls; in `restricted` mode the skill must grant a matching `allowed-tools` rule such as `Bash(git status:*)`.

Additional files inside a mutable skill directory are not inserted automatically. Skills should refer to them with `${AGENT_SKILL_DIR}` and ask the agent to read or execute only the specific files needed for the task. This keeps the default context small while still supporting progressive disclosure for reference Markdown files, scripts, and assets. Built-in skills without extracted reference files have no adjacent files to read.

## Runtime Flow

At the start of a normal user turn, Lin injects a hidden skill listing reminder containing only skills that have not already been listed in the conversation. This avoids repeated listing text and preserves provider prompt cache friendliness.

When the model calls the `skill` tool for an inline skill:

1. `AgentSkillRuntime` resolves and validates the skill.
2. The skill body is rendered with arguments and supported embedded shell output.
3. `allowed-tools` is recorded as run-scoped permission metadata.
4. `model` and `effort` are recorded as a one-turn effect.
5. The rendered skill content is recorded for post-compact restoration.
6. The tool returns `Launching skill: <name>`.
7. `pi-agent-core` receives the loaded skill as a steering user message before the next provider request.
8. `prepareNextTurn` applies the model/effort override for that next provider request only.

When the model calls the `skill` tool for a `context: fork` skill:

1. `AgentSkillRuntime` resolves, validates, and renders the skill body.
2. `AgentDelegationRuntime` starts a sidechain child run using the rendered skill body as the child prompt.
3. The skill's `agent` field selects the agent definition; if absent, Lin uses `general`.
4. The skill's `allowed-tools` rules are passed as child-run preapproval metadata.
5. The skill's `model` and `effort` fields apply to the child agent run.
6. The parent receives only the final child-run result or error as the `skill` tool result.
7. The rendered skill body is not injected into the parent context and is not recorded as an invoked parent skill for compact restore.

Slash skills use the same loader and apply the same `allowed-tools`, `model`, and `effort` metadata. `/compact` and `/dream` are built-in runtime commands and are handled before slash skill resolution. `/skillify` is a built-in skill that is both user- and model-invocable; the skills it writes are still born unratified.

Path-conditional skills remain hidden until a touched file matches `paths`. Directory patterns such as `src` match files under that directory, glob patterns such as `src/**/*.ts` use glob semantics, and dynamically discovered nested `.agents/skills` directories are skipped when they are ignored by the workspace gitignore rules.

File writes into any skill directory are treated as skill-content writes, not
generic local file edits. **Identity has one source of truth**: the same
resolver (`resolveSkillContentTarget`) that the registry loads from also powers
the file-tool gateway and the `agent.skill.write` permission classification, so
the loader's notion of "what is a skill" and the governance layer's can never
disagree — including additional configured skill directories and nested
`.agents/skills` dirs discovered at runtime.

The write boundary makes **no policy decisions — only validity, safety, and
recording**: the gateway asks for the `agent.skill.write` permission action,
validates `SKILL.md` frontmatter and support-file shape as immediate feedback to
the model, rejects secret-looking content (skill-specific by design: skills are
durable instructions injected into future contexts, an exfiltration amplifier),
rejects hidden/executable support files, records rollback metadata in the tool
details, records the written content hash as provenance, and hot-reloads the
skill registry.

**Ratification** is the policy layer, enforced at listing/invocation time, not
at write time. Each mutable skill has one **trust record** in
`agent-skill-provenance.json` (userData; mirrored in-memory in the registry),
keyed by resolved skill file path:

- `agentHash` — sha256 of the last `SKILL.md` content written through the agent
  file-tool path (provenance: who produced the current bytes);
- `acceptedHash` — sha256 of the content the user explicitly accepted for
  automatic model use (trust: a positive record over exact bytes);
- `previousVersion` — the one version preceding the last agent edit, for
  single-step undo.

Ratification is a **pure derivation**, never stored:

```text
ratified = built-in
        || currentHash === acceptedHash
        || (source === user && currentHash !== agentHash)
```

`project` skills are workspace-borne content and therefore require explicit
exact-byte acceptance before automatic model use, even when the bytes were
hand-edited by the user. A cloned repository with `.agents/skills/.../SKILL.md`
therefore loads the skill for Settings and slash invocation, but the model never
sees it until the user accepts the current content hash. `user` source skills
keep the earlier personal-library rule: bytes that do not match the last
agent-written hash self-ratify, while current agent-written bytes need
acceptance.

An unratified skill is:

- excluded from the automatic model skill listing;
- a model-triggered (`skill` tool) invocation raises a `skill_trust` interrupt
  card when the conversation has an approval channel;
- if the user accepts, Lin records the exact content hash and the same tool call
  re-resolves the skill before loading it;
- if the user declines, acceptance fails, or there is no approval channel, the
  `skill` tool returns `skill_not_ratified`;
- slash invocation always works, with `allowed-tools` honored in full — the
  user's command is per-run consent.

Escalation through self-authored `allowed-tools` is therefore structurally
impossible on the model path; there is no write-time allowed-tools heuristic and
lin never force-writes `disable-model-invocation` into an authored file (it
remains an ordinary user-set frontmatter knob). Ratifying paths fall out of the
derivation: **accepting** any mutable skill records `acceptedHash`; for
`user`-source skills only, a hand-edit changes the content hash away from
`agentHash` and self-ratifies. An agent re-patch records a fresh `agentHash`,
leaves a stale `acceptedHash`, and the skill drops back to unratified. Record
loss (wiped userData) fails open for `user` source skills but fails closed for
`project` skills, which have no trust fact without `acceptedHash`. Acceptance is
a positive trust fact and a UX completion, not a new security boundary.

**Acceptance UI.** The primary in-flow path is the composer `skill_trust` card:
the first automatic model invocation of an unratified mutable skill asks the user
to accept the exact current content hash. The card is tied to the active run's
abort signal; stopping the run resolves it as declined and the `skill` tool
returns `skill_not_ratified` instead of leaving a stale pending approval. The
Settings → Skills tab remains a secondary management surface; it marks
unratified rows "pending acceptance" with an **Accept** control, and accepted
rows expose **Revoke acceptance**. The Security page also projects accepted skill
hashes in **Granted Trust**. Both the card and Settings path call
`agent_accept_skill`, which records
`acceptedHash = contentHash`; `agent_revoke_skill_acceptance` clears it. Accept
carries the `expectedHash` the renderer/runtime displayed and is refused on
mismatch, so an agent write landing between render and click can never be
accepted sight-unseen. A trust action also re-derives trust in every live
conversation's registry (the Settings panel runs without a conversation; each
conversation holds its own in-memory trust map over the same store), so an
accepted skill joins running conversations' model listings without a restart.
Acceptance grants nothing beyond the skill's own frontmatter — the permission
floor still stands above it, and a `disable-model-invocation: true` skill stays
user-only even when accepted. Trust records are keyed by resolved file path: a
user rename/move orphans the record, so the skill at its new path is re-derived
from source. `user` source skills with no record are ratified; `project` source
skills with no record are unratified until accepted again. This intentionally
makes trust per clone/path for workspace-borne skills. Orphaned records are not
garbage-collected (accepted: bounded by the number of skills ever agent-written,
and a returning file at the old path correctly picks its record back up).

**Single-step undo.** The gateway captures the pre-write content at each
`SKILL.md` agent write and stores it as the trust record's `previousVersion`
(bounded to one version — deeper history is git's job). The Skills tab exposes
**Undo last agent edit** (`agent_undo_skill_agent_edit`): the restore is
validated by the same skill-write validator, written to disk, and the
provenance facts of the previous version are restored, so ratification
re-derives with no special case — restoring an accepted project version or a
user-source original ratifies, while restoring an unaccepted project version or
an earlier agent version is unratified again. Undo may only overwrite
the agent's own bytes: it is offered and executed only while the on-disk
content still hashes to `agentHash` (the action re-reads the file), so it can
never destroy a user hand-edit made after the agent write. The slot is consumed
on undo (strictly one-shot); a create has no previous version and offers no
undo. The restored bytes are written LF-normalized (the canonical hash domain;
line endings of a CRLF/BOM-authored skill are not preserved — accepted,
pre-release).

Successful skill writes also append a run-scoped skill audit event beside the
completed tool call: `skill.created` for a new `SKILL.md`, `skill.replaced` for a
whole-file replacement, and `skill.patched` for focused edits or support-file
writes. The event records the skill id, source, tool actor, and hash transition
summary; the full previous content stays in the file-tool result details for
rollback tooling. This is execution audit detail, so it lives in the producing
run ledger rather than the conversation log.

## Reference Alignment

Lin tracks the stable local-skill path from the cc-2.1 reference. cc-2.1 is the
primary reference for invocation semantics and skillify UX; OpenClaw and Hermes
are supplemental references for safety, recovery, provenance, and curation.

- immutable code-registered built-in skills plus directory skills as `<skill-name>/SKILL.md`;
- one model-facing skill invocation tool;
- user slash invocation for user-invocable skills;
- `allowed-tools` as run-scoped permission metadata;
- `model` and `effort` as one-turn overrides;
- `context: fork` through a sidechain agent;
- path-conditional activation and dynamic nested skill discovery;
- post-compact restoration of invoked skill content;
- `skillify`-style authoring through ordinary `file_write` / `file_edit`.

Lin intentionally uses `.agents/skills` and the lowercase `skill` tool name
instead of cc-2.1's `.claude/skills` and `Skill` tool name. This is a product
namespace choice, not a behavioral difference.

Agent-managed skill edits follow cc-2.1's smaller tool surface:
`skillify`-style workflows plus ordinary file write/edit tools after review and
confirmation. Lin adds skill-path permission classification, validation, rollback
metadata, and hot reload instead of a separate model-facing skill CRUD tool
family.

## Compatibility Decisions

Lin follows the stable local skill invocation path from the reference
implementation where it maps cleanly onto `pi-agent-core`:

| Capability | Lin decision |
| --- | --- |
| Directory skills | Supported as `<skill-name>/SKILL.md`. Single-file legacy command skills are intentionally not supported. |
| Built-in skills | Supported as immutable code-registered skills loaded before mutable skill directories. Mutable local skills cannot shadow a built-in skill with the same name. |
| Automatic listing | Supported. New model-invocable **ratified** skills are listed once per conversation and persisted across compact restore; unratified agent-authored and workspace-borne skills stay out of the model listing. |
| Skill invocation | Supported through the `skill` tool and slash composer adapter. Both paths share rendering, permissions, model, and effort handling. |
| Embedded shell | Supported for `bash` only, at invocation time, after argument and placeholder substitution. |
| Reference files and scripts | Supported through `${AGENT_SKILL_DIR}` plus normal `file_read` or `bash` calls. They are not bulk-loaded. |
| `allowed-tools` | Supported as run-scoped preapproval metadata, not as a tool visibility list. |
| `model` and `effort` | Supported as one-turn `pi-agent-core` loop updates. |
| `paths` | Supported for path-conditional activation and dynamic nested skill discovery. |
| `context: fork` and `agent` | Supported through the same-conversation `Agent`/delegation runtime. Forked skill bodies run in a sidechain child run and return only the final result to the parent. |
| `hooks` | Not supported. Lin currently has no skill hook registration layer, so hook frontmatter is ignored. |
| Agent-managed skill writes | Supported through cc-2.1-style workflows that use existing `file_write`/`file_edit` calls. Any write into a registry-recognized skill directory is classified as `agent.skill.write` (single resolver, shared with the loader), ask-gated, validated as feedback, audit-event-emitting, rollback-metadata-bearing, provenance-hash-recorded, and registry-hot-reloaded. Agent-written skills are born unratified: slash-invocable immediately, model-invocable only after the user accepts the exact bytes from the in-flow `skill_trust` card or Settings. User-source hand-edits still self-ratify; project-source content always needs exact-byte acceptance. |
| Legacy command directories | Not supported. Lin uses the agent skills standard path under `.agents/skills`. |
| MCP/plugin/remote skills | Not supported. The current registry is local filesystem skills plus configured additional directories. |
| Managed/policy skills | Built-in skills are supported as the immutable app-managed floor. Lin has no separate admin-managed policy skill layer. |
| `skillify` | Supported as the built-in user- and model-invocable workflow (`when_to_use`-gated to explicit user save requests). It uses the same local `SKILL.md` shape and existing file write/edit tools after review and confirmation. |
| Automatic skill improvement | Supported only as user-directed or accepted-review skill maintenance in the first self-modification release. Background conversation review that silently rewrites skills is not supported. |
| Per-skill invocation permission suggestions | Not supported as a dedicated UI. The `skill` tool still goes through the global runtime permission policy, and the skill's own `allowed-tools` narrow downstream tool calls. |

## Compaction

`/compact [instructions]` creates a no-tools summary request. The summary response is expected to contain an `<analysis>` block and a `<summary>` block; only the summary is retained.

The same compact engine is also used automatically:

- before a model call when the active context crosses the auto-compact threshold
- after a provider context-length error, followed by one retry from the compacted root

Before model-context assembly, Lin runs tool-output slimming on the active path. Large tool results are persisted as payloads and replaced with stable `<persisted-output>` preview labels. Per-tool-batch budget decisions are frozen by `toolCallId` and recorded as event-log replacements, so restored conversations reuse the same model-visible content instead of re-deciding and breaking prompt-cache stability.

If the compact summary request itself exceeds the provider context limit, Lin retries by dropping the oldest API-round groups from the summary input. Reactive compact also clones the latest pending user/tool tail after the compact root before retrying, so the model continues from the same work item instead of relying on the summary to restate it exactly.

After compacting, Lin restores the most recent full text file reads into a hidden reminder with bounded per-file and total size. File-edit freshness state is cleared and rebuilt only for restored files, matching the model-visible context after compact.

After compaction, the model-context branch becomes a new root user message with:

- visible marker text: `Conversation compacted.`
- hidden compact summary reminder
- hidden invoked skills reminder
- hidden listed-skills state reminder
- hidden restored file context reminder, when recent file reads fit the restore budget

The renderer does not show this root as a normal user bubble. `compaction.completed` is projected as a dedicated compact boundary row with the trigger (`manual`, `auto`, or `reactive`) and an expandable summary. The hidden reminders remain model-only context.

The listed-skills state reminder is intentionally tiny. It prevents a restored compacted conversation from re-injecting the full skill listing after app restart.

## Memory Dream

`/dream` is a built-in runtime command, handled before slash skill resolution. It
requests the same runtime-owned no-tools Dream consolidation path (offline
replay of recorded episodic evidence, distilled into durable memory) used by the
schedule. Unlike `/compact`, it does not replace the model-context root. During a
manual run, the renderer appends an active Dream boundary row; when the run
finishes, the conversation log records a `dream.finished` marker on a hidden
system-reminder anchor so the chat stream keeps a visible Dreamed/failed/skipped
row after reload.

The model can also call the foreground `dream` tool when the user asks to run,
test, refresh, or consolidate Memory Dream. This tool is trigger-only and
permission-gated. It cannot supply memory facts, select another agent, or bypass
the runtime-owned consolidation worker; it only requests the current agent's
Dream path and returns status/counts to the model. Tool-triggered Dreams record the
same `dream.finished` marker after the tool turn settles, so the chat stream
shows the same Dream boundary row as `/dream`.

### Reference Alignment

Lin intentionally keeps the model-context parts of the reference compact path and drops compatibility layers that do not map to the current product architecture.

Replicated behavior:

- Run stable tool-result slimming before compact/model context assembly.
- Run time-based microcompact before auto compact, keeping the latest compactable tool results.
- Auto compact before a model call when the active context crosses the model threshold.
- Reactive compact after a provider context-length error, then retry from the compacted root.
- Retry compact-summary requests that are themselves too large by dropping oldest API-round groups and inserting a synthetic truncation marker when needed.
- Preserve the latest reactive user/tool tail after compact so the failed turn can continue.
- Restore invoked skill content after compact with per-skill and total budgets.
- Preserve listed-skill state after compact without re-injecting the full listing.
- Restore recent full text file reads after compact, bounded to 5 files, about 5k tokens per file, and about 50k tokens total.
- Skip file restore when a preserved tail already contains a real full `file_read`, but do not skip when the preserved tail only contains a `file_unchanged` stub.
- Clear file-edit freshness on compact and rebuild it only for restored files.
- Stop repeated auto-compact attempts after consecutive failures.

Intentional omissions:

- Session-memory compact: omitted because Lin does not use this memory model.
- Pre/post/session-start compact hooks: omitted until Lin has a first-class hook system.
- Plan-mode and plan-file attachments: omitted because Lin does not have that separate plan-mode runtime.
- Task-output-file compatibility tools: omitted because Lin follows cc-2.1's preferred path of surfacing durable output references that can be read with `file_read`. `AgentStatus` remains only for explicit same-conversation status/wait checks.
- Deferred-tool/MCP delta re-announcement: omitted for now because Lin's tool registry is stable in `pi-agent-core`; future plugin/app tools should add their own compact restore state.
- Provider-specific cache-edit microcompact: omitted because it depends on cache editing support that is not available through the generic pi provider path. Lin uses stable event-log replacements instead.
- Prompt-cache telemetry and survey plumbing: omitted because it is observability, not model-visible behavior.
- Partial compact around a selected transcript pivot: omitted until there is a UI workflow that needs it.
- Legacy command directories and legacy config paths: omitted because Lin follows the agent skills standard paths only.

## Permission Inputs

The user-facing default policy is the app-level Security `safetyMode`
(`ask_first`, `balanced`, `full_access`) described in
`agent-tool-permissions.md`. Agent definitions and skills cannot widen above that
global policy.

Agent settings expose only a narrow delegation sandbox:

- **Follow global**: no sandbox; the run uses the global safety mode and normal
  descriptor defaults.
- **Restricted**: only a small safe base set is allowed unless a matching
  `allowed-tools` rule preapproves the tool call.

Legacy `permission-mode: trusted` frontmatter is ignored. Skill `allowed-tools`
is preapproval metadata, not a visibility allowlist. Inline skill rules are
scoped to the current parent agent run and cleared when the run ends, stops, or
resets. `context: fork` skill rules are passed to the child run as preapproved
tool rules.
