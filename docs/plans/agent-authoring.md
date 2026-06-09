---
status: in-progress
priority: P2
owner: relixiaobo
created: 2026-06-08
updated: 2026-06-09
---

# Agent Authoring & Management

**Part of the [[agent-program]] (M2 extension surface).** This plan owns the
**user-facing** path to create, edit, and manage **agent definitions** (the
`AGENT.md` persona files). It is the agent-side analogue of
[[agent-skills-authoring]] (which owns *skills*); agent definitions are currently
read-only everywhere ([[agent-self-modification]] treats them as a read-only
self-observation target; [[agent-conversation-model]] loads them startup-cached
and read-only). This plan does **not** touch the agent runtime, invocation,
memory, or isolation semantics.

**Status (2026-06-09).** **Core landed (#167)** — create/edit/duplicate/manage `AGENT.md`
with a Form⇄Raw editor, hot-reload, disable-by-identity, plus subagent system-prompt
unification. **Remaining:** the review-gate follow-ups (consolidate the two `AGENT.md`
parsers; read-only render for `additionalAgentDirectories`; `effort`-outside-catalog guard;
a `TOOL_CATALOG` link guard-test).

## Goal

Give the user a first-class, in-app way to **create, edit, duplicate, enable/
disable, and locate** their own agent definitions — closing the gap where
authoring is filesystem-only and requires an app restart to take effect.

Concretely, after this lands a user can, without leaving the app and without a
restart:

- create a new agent (name, description, persona body, and the optional
  `model` / `effort` / `permissionMode` / `maxTurns` / `tools` / `skills`
  overrides);
- edit an existing **user/project** agent;
- duplicate a **built-in** agent into an editable user copy;
- choose where it is stored (global vs workspace);
- see it appear in the subagent picker immediately (hot-reload).

## Non-goals

- **No model-driven agent authoring.** The model cannot create or edit agent
  definitions — no `/agentify`, no `agent_create` tool. The agent-definition
  write surface stays **user-driven only**, mirroring the closed memory-write
  surface and [[agent-self-modification]]'s read-only treatment of agent defs.
  (A future agent-assisted scaffold is a separate plan if ever wanted.)
- **No `AgentDefinition` protocol change.** Reuse the existing shape
  (`src/core/types.ts:741-757`) verbatim — it already carries every field the
  editor needs. This keeps the plan **out of `src/core/types.ts`** and therefore
  cleanly parallel with [[agent-scheduled-routines]] (see Collision self-check).
- ~~**No runtime/invocation/memory/isolation change.**~~ **Amended 2026-06-08
  (PM-ratified):** folded in **subagent system-prompt unification** — a fresh
  subagent now reuses the shared core of the main system prompt (capabilities /
  tool conventions / safety) + a headless directive instead of a bespoke minimal
  prompt, and built-in `general` collapses to a zero-persona default. This is the
  ONLY invocation-semantics change; spawning routing, the fresh-vs-fork seam,
  memory ownership, and isolation tiers remain untouched. Design folded into
  `docs/spec/agent-subagent-runtime-plan.md` (Fresh Subagent → System prompt).
- **No built-in mutation.** `general` and `fork` (`agentSubagents.ts:1293-1321`)
  stay immutable; editing one means duplicating to a user agent.
- **Not multi-agent / channels.** Out of scope.

## Current state (the gap — code-grounded)

- **What an agent is:** `AgentDefinition` — `name`, `displayName?`, `source`
  (`'built-in' | 'user' | 'project'`), `rootDir`, `agentFile`, `description`,
  `tools?`, `disallowedTools?`, `model?`, `effort?`, `permissionMode?`,
  `maxTurns?`, `skills?`, `background?`, `body` (the persona → system prompt).
  `src/core/types.ts:741-757`.
- **On disk:** one directory per agent containing **`AGENT.md`**
  (`agentSubagents.ts:48`) — YAML frontmatter + Markdown body, same convention as
  `SKILL.md`.
- **Locations** (`agentSearchDirs`, `agentSubagents.ts:1323-1335`):
  `~/.agents/agents/<name>/AGENT.md` (`source: user`),
  `<workspace-root>/.agents/agents/<name>/AGENT.md` (`source: project`), plus
  `additionalAgentDirectories` from runtime settings (source by inside/outside
  workspace).
- **Loading:** scanned + parsed + **cached at startup** (`ensureLoaded`,
  `agentSubagents.ts:1272-1283`). **No hot-reload** — a new/edited agent needs an
  app restart. (Skills already hot-reload; agents do not.)
- **Identity:** `${source}:${namespace}:${name}` — built-in → `tenon`, else
  `sha256(agentFile).slice(0,16)` (`agentSubagentIdentity.ts:6-10`).
- **Settings UI today** (`AgentSettingsView.tsx`): **read-only** detail card
  (persona shown `readOnly`, `:1105`) + an enable/disable switch. Disable is
  keyed on the **bare `name`** (`:606,609-612,1082`) → two same-named agents from
  different sources are disabled together (a real collision the richer identity
  already solves). No create, no edit, no agent-directory input (skills have a
  directory field; agents do not).

## Design

Three slices. Slice 1 (main) is the foundation; Slice 2 (renderer UI) builds on
it; Slice 3 is cleanup that can land independently. Slices 1+3 can start in
parallel; Slice 2 depends on Slice 1's IPC.

### Slice 1 — registry write + hot-reload (main)

Extend `AgentDefinitionRegistry` (`agentSubagents.ts`) with a **write +
invalidate** surface, exposed over new IPC channels (additive in `main.ts` +
preload bridge — no protocol-type change):

- `createUserAgent(input)` / `updateUserAgent(agentId, input)` /
  `deleteUserAgent(agentId)` — serialize `input` to `AGENT.md` frontmatter+body
  and atomic-write it under the chosen agents dir; then invalidate the startup
  cache and re-scan so the change is live without restart.
- `duplicateAgent(sourceAgentId, newName, targetDir)` — read a built-in/any
  definition, write it as a new user agent.
- A **reload** entry point (clear `loaded`/`agents`/`seenAgentFileIds`,
  re-`ensureLoaded`) — reused after every write and available as an explicit
  "reload agents" action.

Write target: only within a known agents dir
(`~/.agents/agents/<name>/` or `<workspace>/.agents/agents/<name>/`), name run
through `normalizeAgentName`, path containment enforced in main (reject
traversal). Built-in `rootDir === 'built-in'` is never a write target.

**In-flight safety:** a run resolves its `AgentDefinition` at spawn
(`agentSubagents.ts:532-537`); reload only affects *future* spawns, so a live run
is unaffected. No need to touch running runs.

### Slice 2 — create / edit UI (renderer)

Turn the read-only agent detail in `AgentSettingsView.tsx` into an editor and add
a **"New agent"** action:

- form fields map 1:1 to `AgentDefinition`: name, description, persona body
  (multiline), and the optional `model` / `effort` (reuse the reasoning-level
  control) / `permissionMode` (trusted/restricted) / `maxTurns` / `tools` /
  `skills` (reuse the skill list);
- **built-in** selected → fields stay read-only, primary action is **"Duplicate
  to my agents"**; user/project selected → **Save** / **Delete**;
- validation (non-empty unique name within target dir, valid frontmatter) before
  the IPC write; on save, the registry reloads and the list refreshes (reuse the
  existing settings-changed broadcast `lin:settings-changed`).

See Open Questions for the form-vs-raw-`AGENT.md` decision.

### Slice 3 — directories UI + disable-by-identity fix (independent)

- **Agent directories UI:** add the missing `additionalAgentDirectories` editor
  to settings (mirror the existing skills-directory field), wired to
  `AgentDefinitionRegistry.updateAdditionalAgentDirectories`
  (`agentSubagents.ts:1245-1252`).
- **Disable-by-identity:** change `disabledAgents` from bare `name` to the full
  `agentId` (`agentSubagentIdentity.ts`) so disabling one source's agent no
  longer disables a same-named agent from another source. This is a stored-
  settings shape change; per [[storage-format-no-backcompat-prerelease]] just
  switch it and wipe dev `userData` (no migration). Update the runtime check
  (`agentSubagents.ts:537`) and the UI key (`AgentSettingsView.tsx:606+`).

### Security (A2/A3)

- All writes go through **main**; the renderer only sends desired fields. Path
  containment + name sanitization in main; reject anything outside the agents
  dirs (no traversal). No Node in the renderer.
- A user-authored persona `body` becomes a system prompt. Note the existing
  framing that agent-definition bodies are "trusted context, not user-authored
  instructions" (`agent-data-model.md:467`) — this stays consistent because the
  **user is the author**; the boundary that matters (the *model* must not write
  agent defs) is preserved by the Non-goal above. Worth a one-line security-
  review at the gate since it adds a renderer-driven file-write path.

### Collision self-check (vs in-flight work)

`gh pr list` + `docs/TASKS.md` + the file scopes below:

| File | This plan | [[agent-scheduled-routines]] (Lane B) | Result |
|---|---|---|---|
| `src/core/types.ts` | **avoid** (reuse `AgentDefinition`) | adds `NodeType: command`, `ViewSystemField: sys:lastRunAt` | no overlap **iff** this plan holds its Non-goal |
| `src/main/agentSubagents.ts` (registry) | ✅ write/reload | — | mine |
| `src/main/agentRuntime.ts` / `agentEventStore.ts` | — | ✅ scheduling | theirs |
| `src/renderer/.../AgentSettingsView.tsx` | ✅ editor | — | mine |
| `AgentChatPanel` / `AgentDock.tsx` | — | ✅ | theirs |
| `src/main/main.ts` + preload | ✅ additive IPC | ✅ additive IPC | additive, low-risk; coordinate channel names |

**Conclusion: parallelizable with Lane B.** The only shared protocol file is
`src/core/types.ts`, which this plan deliberately does not touch (Non-goal). If
that ever changes, sequence shared-interface-first behind Lane B's types change.
`main.ts` IPC is additive on both sides.

## Open questions — resolved (PM-ratified 2026-06-08)

1. **Edit affordance:** **a structured Form ⇄ a raw `AGENT.md` editor, switchable
   modes** (redesigned 2026-06-08 from the original form-only lean, per PM
   screenshots). `AgentEditor.tsx` carries a `SegmentedControl` Form/Raw toggle in
   the header: **Form** shows structured controls (name / description / model /
   effort / permission-mode / max-turns / background) plus **toggle lists** for
   tools and skills (each catalog/installed item is a `SwitchControl` row — all-on
   or all-off ⇒ unrestricted, a proper subset is stored); **Raw** is the full
   `AGENT.md` text. Switching converts losslessly through the shared
   `src/core/agentMarkdown.ts` (`serializeAgentMarkdown` on Form→Raw,
   `parseAgentAuthoringInput` on Raw→Form) so the two views are always the same
   data and the renderer never re-implements the format that main's loader reads.
2. **Default storage location on create:** **offer a choice, default global**
   (the lean). A `user` / `project` segmented control on the create form, seeded
   to `user` (`~/.agents/agents`).
3. **Hot-reload mechanism:** **invalidation-on-write** (the lean).
   `AgentDefinitionRegistry.reload()` after every write across all live sessions;
   `fs.watch` deferred.
4. **Built-in editing:** **duplicate-to-user** confirmed. Built-ins render through
   the **same** `AgentEditor` as a user agent, just **read-only** (every control
   disabled; the Form/Raw toggle stays live so the AGENT.md is viewable; the only
   action is "Duplicate to my agents") — so `general` and a user agent are one
   abstraction, not two surfaces (redesign 2026-06-08: the earlier bespoke
   read-only specs card was dropped). A **new** agent seeds a scaffold (real
   defaults: `permission-mode: restricted`, `effort: medium`, `max-turns: 20`, a
   starter persona; all tools on; model inherit) so neither Form nor Raw starts
   blank.
5. **Priority / sequencing:** ran as a **parallel lane** alongside Lane B; the
   only shared file is `src/core/commands.ts` (additive — new command names
   appended at the end, no overlap with Lane B's mid-list insertion).
6. **Scope of Slice 3:** **bundled into this PR** (disable-by-identity +
   directories UI), not split out.

Reversible locals decided during build (recorded per AGENTS.md): tools/skills are
**on/off toggle lists** — the tool list is a curated catalog of the common
subagent tools (`TOOL_CATALOG` in `AgentEditor.tsx`; the internal outliner/node
tools are omitted), and any tool/skill the file carries outside the catalog is
preserved (`extraTools`/`extraSkills`) so editing in Form mode never silently
drops it; `model` is a free-text override (placeholder `inherit`); the editor's
Save/Delete/Duplicate commit to disk immediately and are a separate surface from
the footer (which still owns the runtime-settings save: enable/disable +
directories), mirroring how provider config and runtime settings already split.

## Subtasks

- [x] **Slice 1** — authoring write surface (`src/main/agentAuthoring.ts`:
  create/update/delete/duplicate) + the shared format layer
  (`src/core/agentMarkdown.ts`: `serializeAgentMarkdown` /
  `parseAgentAuthoringInput` / `parseAgentMarkdownDocument`, the inverse of the
  registry's `parseAgentMarkdown`, pure — used by **both** main and the renderer
  so the Form⇄Raw toggle can't drift); `AgentDefinitionRegistry.reload()` +
  `AgentRuntime.reloadAgentDefinitions` (all live sessions); additive IPC; path
  containment + slug sanitization; unit tests (`tests/core/agentAuthoring.test.ts`
  — round-trip, duplicate-rejection, traversal guard, built-in-not-writable;
  `tests/core/agentMarkdown.test.ts` — serialize⇄parse round-trip + tolerance).
- [x] **Slice 2** — settings editor (`AgentEditor.tsx`) with the Form ⇄ Raw mode
  toggle and tools/skills as on/off toggle lists + "New agent" +
  duplicate-built-in; validation; list/picker refresh via the reloaded view list;
  renderer tests (`tests/renderer/agentEditor.test.tsx`).
- [x] **Slice 3** — `additionalAgentDirectories` settings UI; `disabledAgents`
  keyed on `agentId`; runtime check + UI updated.
- [x] **Subagent prompt unification** (PM-ratified scope add) — tag
  `LIN_AGENT_SYSTEM_PROMPT_SECTIONS` with an `audience` and export
  `LIN_SUBAGENT_CORE_PROMPT` (the shared subset); `buildFreshAgentSystemPrompt`
  = subagent identity + headless directive + shared core + persona body; empty
  built-in `general`'s body. Tests: `tests/core/agentSystemPrompt.test.ts`
  (audience split + core subset), `tests/core/agentSubagentPrompt.test.ts`
  (composition). Token cost measured (~80 → ~1.2k per fresh subagent prompt).
- [x] Spec: folded the authoring/management surface into
  `docs/spec/agent-subagent-runtime-plan.md` (registry → Authoring & hot-reload /
  Disabling by identity; Fresh Subagent → System prompt) per A6.
- [ ] Gate (main agent): `/code-review`; add `/security-review` (renderer-driven
  file write); visual verification (light + dark) for the new settings editor.
