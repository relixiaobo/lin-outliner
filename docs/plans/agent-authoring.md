---
status: draft
priority: P2
owner: relixiaobo
created: 2026-06-08
updated: 2026-06-08
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
- **No runtime/invocation/memory/isolation change.** Spawning, the
  fresh-vs-fork seam, memory ownership, and isolation tiers are untouched.
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

## Open questions (for PM / drafting dev to resolve)

1. **Edit affordance:** structured form (per-field) only, raw `AGENT.md` text
   editor only, or both (form with a "raw" toggle)? *Lean: structured form for
   the common fields + a raw body editor for the persona.*
2. **Default storage location on create:** `~/.agents/agents` (global,
   cross-workspace) vs `<workspace>/.agents/agents` (project, git-trackable)?
   Offer a choice at create time, or pick a default? *Lean: offer a choice,
   default to global user dir.*
3. **Hot-reload mechanism:** registry invalidation on write + an explicit
   "reload" action (deterministic) vs `fs.watch` on the agents dirs (automatic,
   more edge cases)? *Lean: invalidation-on-write now; defer `fs.watch`.*
4. **Built-in editing:** confirm duplicate-to-user (built-ins immutable) is the
   intended UX (vs an override layer).
5. **Priority / sequencing:** is this a third parallel lane now, or queued behind
   Lane B? (Plan is written to run in parallel.)
6. **Scope of Slice 3:** ship the disable-by-identity fix with this plan, or pull
   it out as a standalone fast-track cleanup?

## Subtasks

- [ ] **Slice 1** — `AgentDefinitionRegistry` create/update/delete/duplicate +
  reload; `AGENT.md` serializer (inverse of `parseAgentMarkdown`); IPC channels +
  preload; path containment + name sanitization; unit tests (round-trip
  serialize/parse, reload-makes-new-agent-visible, built-in not writable).
- [ ] **Slice 2** — settings editor + "New agent" + duplicate-built-in; validation;
  refresh on `lin:settings-changed`; renderer tests.
- [ ] **Slice 3** — `additionalAgentDirectories` settings UI; `disabledAgents`
  keyed on `agentId`; update runtime check + UI.
- [ ] Spec: fold the authoring/management surface into `docs/spec/` (the
  agent-subagent runtime / settings spec) per A6.
- [ ] Gate: `/code-review`; add `/security-review` (renderer-driven file write);
  visual verification (light + dark) for the new settings editor.
