# Agent Skills

Lin implements agent skills as local `SKILL.md` instruction bundles that the model can discover, invoke, and carry across compaction. The execution path is integrated through `pi-agent-core`.

## Search Paths

Default skill directories are always enabled:

- `~/.agents/skills`
- `<workspace>/.agents/skills`

Each skill is a directory with a `SKILL.md` file. Additional skill directories can be configured in Agent settings; those directories are appended after the defaults and can be absolute, workspace-relative, `~/...`, `$HOME/...`, or `${HOME}/...`.

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
- `context: fork`: runs the rendered skill body through the same-session subagent runtime instead of injecting it into the parent context.
- `agent`: optional agent definition for `context: fork` skills. If omitted, Lin uses the built-in `general` agent. If provided, the agent definition must resolve; Lin fails the skill invocation instead of silently falling back to another agent.
- `paths`: path-conditional activation patterns.

The skill body is loaded with:

```text
Base directory for this skill: <skill-directory>

<SKILL.md body>
```

Argument placeholders are `$ARGUMENTS`, `$ARGUMENTS[n]`, `$0`, `$name`, `${AGENT_SKILL_DIR}`, and `${AGENT_SESSION_ID}`.

Skill bodies may include embedded shell commands using fenced blocks that start with ```` ```! ```` or inline `!` command spans. Commands are expanded only when the skill is invoked, after argument and environment placeholder substitution. They execute through the same local bash runner and permission policy used by normal agent tool calls; in `restricted` mode the skill must grant a matching `allowed-tools` rule such as `Bash(git status:*)`.

Additional files inside the skill directory are not inserted automatically. Skills should refer to them with `${AGENT_SKILL_DIR}` and ask the agent to read or execute only the specific files needed for the task. This keeps the default context small while still supporting progressive disclosure for reference Markdown files, scripts, and assets.

## Runtime Flow

At the start of a normal user turn, Lin injects a hidden skill listing reminder containing only skills that have not already been listed in the session. This avoids repeated listing text and preserves provider prompt cache friendliness.

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
2. `AgentSubagentRuntime` starts a sidechain subagent run using the rendered skill body as the child prompt.
3. The skill's `agent` field selects the agent definition; if absent, Lin uses `general`.
4. The skill's `allowed-tools` rules are passed as child-run preapproval metadata.
5. The skill's `model` and `effort` fields apply to the child agent run.
6. The parent receives only the final subagent result or error as the `skill` tool result.
7. The rendered skill body is not injected into the parent context and is not recorded as an invoked parent skill for compact restore.

Slash skills use the same loader and apply the same `allowed-tools`, `model`, and `effort` metadata. `/compact` is a built-in runtime command and is handled before slash skill resolution.

Path-conditional skills remain hidden until a touched file matches `paths`. Directory patterns such as `src` match files under that directory, glob patterns such as `src/**/*.ts` use glob semantics, and dynamically discovered nested `.agents/skills` directories are skipped when they are ignored by the workspace gitignore rules.

## Compatibility Decisions

Lin follows the stable automatic-skill path from the reference implementation where it maps cleanly onto `pi-agent-core`:

| Capability | Lin decision |
| --- | --- |
| Directory skills | Supported as `<skill-name>/SKILL.md`. Single-file legacy command skills are intentionally not supported. |
| Automatic listing | Supported. New model-invocable skills are listed once per session and persisted across compact restore. |
| Skill invocation | Supported through the `skill` tool and slash composer adapter. Both paths share rendering, permissions, model, and effort handling. |
| Embedded shell | Supported for `bash` only, at invocation time, after argument and placeholder substitution. |
| Reference files and scripts | Supported through `${AGENT_SKILL_DIR}` plus normal `file_read` or `bash` calls. They are not bulk-loaded. |
| `allowed-tools` | Supported as run-scoped preapproval metadata, not as a tool visibility list. |
| `model` and `effort` | Supported as one-turn `pi-agent-core` loop updates. |
| `paths` | Supported for path-conditional activation and dynamic nested skill discovery. |
| `context: fork` and `agent` | Supported through the same-session `Agent`/subagent runtime. Forked skill bodies run in a sidechain subagent and return only the final result to the parent. |
| `hooks` | Not supported. Lin currently has no skill hook registration layer, so hook frontmatter is ignored. |
| Legacy command directories | Not supported. Lin uses the agent skills standard path under `.agents/skills`. |

## Compaction

`/compact [instructions]` creates a no-tools summary request. The summary response is expected to contain an `<analysis>` block and a `<summary>` block; only the summary is retained.

The same compact engine is also used automatically:

- before a model call when the active context crosses the auto-compact threshold
- after a provider context-length error, followed by one retry from the compacted root

Before model-context assembly, Lin runs tool-output slimming on the active path. Large tool results are persisted as payloads and replaced with stable `<persisted-output>` preview labels. Per-tool-batch budget decisions are frozen by `toolCallId` and recorded as event-log replacements, so restored sessions reuse the same model-visible content instead of re-deciding and breaking prompt-cache stability.

If the compact summary request itself exceeds the provider context limit, Lin retries by dropping the oldest API-round groups from the summary input. Reactive compact also clones the latest pending user/tool tail after the compact root before retrying, so the model continues from the same work item instead of relying on the summary to restate it exactly.

After compacting, Lin restores the most recent full text file reads into a hidden reminder with bounded per-file and total size. File-edit freshness state is cleared and rebuilt only for restored files, matching the model-visible context after compact.

After compaction, the active event-log branch becomes a new root user message with:

- visible text: `Conversation compacted.`
- hidden compact summary reminder
- hidden invoked skills reminder
- hidden listed-skills state reminder
- hidden restored file context reminder, when recent file reads fit the restore budget

The listed-skills state reminder is intentionally tiny. It prevents a restored compacted session from re-injecting the full skill listing after app restart.

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
- Task-output-file and task-status compatibility tools: omitted because Lin uses `AgentStatus`, `AgentSend`, `AgentStop`, and persisted `subagent_run` events for same-session subagents.
- Deferred-tool/MCP delta re-announcement: omitted for now because Lin's tool registry is stable in `pi-agent-core`; future plugin/app tools should add their own compact restore state.
- Provider-specific cache-edit microcompact: omitted because it depends on cache editing support that is not available through the generic pi provider path. Lin uses stable event-log replacements instead.
- Prompt-cache telemetry and survey plumbing: omitted because it is observability, not model-visible behavior.
- Partial compact around a selected transcript pivot: omitted until there is a UI workflow that needs it.
- Legacy command directories and legacy config paths: omitted because Lin follows the agent skills standard paths only.

## Permission Mode

Agent settings expose two modes:

- `trusted`: default. Most tool calls are allowed, with hard blocks for catastrophic filesystem/disk/power commands and workspace-boundary file access.
- `restricted`: only a small safe base set is allowed unless a matching `allowed-tools` rule preapproves the tool call.

Skill `allowed-tools` is preapproval metadata, not a visibility allowlist. Inline skill rules are scoped to the current parent agent run and cleared when the run ends, stops, or resets. `context: fork` skill rules are passed to the child subagent run as preapproved tool rules.
