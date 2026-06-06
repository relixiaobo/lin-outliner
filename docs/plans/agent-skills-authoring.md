---
status: in-progress
priority: P1
owner: relixiaobo
created: 2026-06-05
updated: 2026-06-06
---

# Agent Skills — Structure & Governed Self-Authoring

Owns the skill subsystem's **structure** (where skills live, how they bind to an
agent) and **governed self-authoring** (how an agent creates / edits skills
safely). Extracted from [[agent-conversation-model]] (its former §Skills — the
taxonomy) and [[agent-self-modification]] (§7 Skill Maintenance + §8 Curation —
the workflow/policy) so the **same capability lives in one place** instead of two.
Sits on the **M0 foundation** defined in [[agent-program]]; the program doc owns the
cross-plan event taxonomy and the protocol-surface change list this plan depends on.

## Goal

- **One unified skill library; agents bind by name** — no per-agent skill storage.
- A **`built-in` immutable floor** that ships and versions with the app (the skill
  analog of the A3 security floor).
- **Governed self-authoring**: an agent can create / edit `user` (and workspace)
  skills under review · audit · snapshot · rollback — **never** the `built-in` floor,
  **never** self-escalating its own tool permissions.

## Non-goals

- **Memory** → owned by [[agent-conversation-model]].
- **The config tool / runtime_status / doctor / hooks / config recovery** → owned by
  [[agent-self-modification]]. This plan reuses their permission + audit machinery; it
  does not redefine it.
- **A model-facing skill-CRUD tool family** (`skill_create` / `skill_patch` /
  `skill_replace` / `skill_write_support_file`). Authoring rides `skillify`-style
  review flows + the existing `file_write` / `file_edit` tools (the cc-2.1 decision —
  smaller model-facing surface). Hermes's `skill_manage` is borrowed only for its
  validation / provenance / rollback / curation *mechanics*, not as a tool.
- **Remote / MCP / plugin skill lifecycle; legacy command directories.** Out of scope.
- **Background silent skill rewriting.** Curation is opt-in, dry-run-first, and only
  over agent-created skills (§Curation).

## Current state (shipped vs planned)

**Before M1** (`docs/spec/agent-skills.md`; `agentSkills.ts`): discovery +
invocation from `~/.agents/skills` (source `user`) and `<localFileRoot>/.agents/skills`
(source `project`) + additional configured dirs + runtime `dynamic` discovery
(`discoverSkillDirsForPaths`, `agentSkills.ts:702`); path-conditional skills;
embedded-shell expansion; `allowed-tools` as **run-scoped preapproval, not a
visibility allowlist** (`agent-skills.md:189`); per-invocation `model` / `effort`
override; `context: fork`.

**M1 implementation in this branch adds**: code-registered immutable `built-in`
skills, slash-only `/skillify`, governed self-authoring through `file_write` /
`file_edit`, `.agents/skills/**` permission classification (`agent.skill.write`),
validation and no-escalation guards, registry hot-reload after successful skill
writes, and `skill.created` / `skill.patched` / `skill.replaced` audit events.
Rollback UI and opt-in curation remain later work.

## Design

### Structure — one unified library, many bindings

Two orthogonal questions, kept separate: where a skill is *stored*, and which skills
an agent *binds*.

**Storage — one unified place; agents do NOT own private folders.**

| Source | Where | Mutable | Role |
|---|---|---|---|
| `built-in` (**new**) | app, code-registered | no — ships & versions with the app | the skill analog of the A3 floor; neither user nor agent can edit |
| `user` | `~/.agents/skills` | yes | **the unified authorable library** — every one of the user's agents draws from it; the **self-authoring target** |
| `project` | `<localFileRoot>/.agents/skills` | yes | brought along by the **external clone/repo** the agent's files point at; in scope only while working there |
| `dynamic` | discovered near worked-on files | yes | runtime, gitignore-aware (`discoverSkillDirsForPaths`, `agentSkills.ts:702`) |

- `built-in` mirrors the **already-existing built-in *agent*** path
  (`source:'built-in'`, `agentSubagents.ts:1206,1222`) and cc-2.1's
  `registerBundledSkill` / `src/skills/bundled/*` — implemented as **code
  registration, not editable files**, so "iterates with the app, user can't edit"
  falls out for free. It restores the agent/skill symmetry: `AgentDefinition.source`
  already carries `'built-in'` (`types.ts:705`) while `SkillDefinition.source` does
  not (`:724`). Net protocol change = add `'built-in'` to `SkillDefinition.source`
  (M0, interface-first — [[agent-program]]).
- `project` is **not** a Tenon-native "projects" feature (Tenon has none) — it is the
  external work-context the agent operates on, which may ship its own
  `.agents/skills/`. Kept as-is and clarified, **not** renamed.

**Binding — which skills an agent uses.** `AgentDefinition.skills: string[]` is
already the mechanism (iterated at `agentSubagents.ts:640`, parsed from agent
frontmatter `:1313`): a **by-name selection over the unified library**, not
ownership. Specialization = different bindings (a researcher carries research skills a
writer doesn't), not different storage. **Skills bind to the agent identity, never to
a conversation** — they travel into every DM/Channel the agent is in, exactly like the
memory line and the rest of capability. A Channel that "needs skill X" gets it by
staffing a member who binds X, or via the shared `project` work-context — never a
room-owned skill bag (that would reintroduce per-session config). The coordinator's
"who can do X?" is therefore answerable per-member from binding lists
([[agent-conversation-model]] §Channel routing).

### Self-authoring — governed write

An agent that writes a new skill writes it into the **unified `user` store** (not a
private folder) and adds the name to its own binding; it is then discoverable /
bindable by other agents (dovetails "agents configure each other"). **Authorship is
metadata** (author / `version` / provenance fields), not a separate directory. The
**promotion ladder**: self-authored in `user` → bound by more agents as it proves
general → finally blessed into `built-in` in an app release. This is the skills
counterpart of the memory write/consolidate loop ([[agent-conversation-model]] §Memory
model).

**User flows** (cc-2.1 `skillify` UX + existing file tools):

```text
/skillify <workflow or selected messages>
save this as a skill
update the <skill-name> skill with what we just learned
fix the skill that failed
```

**Write requirements** (from self-modification §7, carried verbatim in intent):

- No dedicated model-facing skill-CRUD tool. Use `skillify`-style review/confirm +
  `file_write` / `file_edit`; prefer `file_edit` for existing skills, `file_write` only
  for new skills / major rewrites / unpatchable malformed files.
- Generate or update a concrete `SKILL.md` in the stable shape of
  `docs/spec/agent-skills.md`; write only to standard `.agents/skills` roots.
- **Allow writes only to `user`-local and workspace (`project`) skills.** Additional
  configured dirs are read-only unless explicitly marked writable. **Never `built-in`.**
- Classify any `file_write` / `file_edit` under `.agents/skills/**` as a
  **skill-content write**, not a generic document edit — distinct permission / audit
  / snapshot path.
- **Agent-initiated** writes must show the full `SKILL.md` or a focused diff and ask
  for explicit confirmation; they default to **draft / disabled** until accepted, and
  carry `agent-created` provenance. **User-directed** writes ("save this as a skill")
  may use a compact approval — the user's command is already the intent — and may
  enable immediately when the user asked for that.
- Write atomically; snapshot the previous version; expose undo. Validate frontmatter,
  size, paths, supported subdirs before/after write; surface failures as repairable.
- Reject path traversal, symlinks escaping the skill dir, executable/binary support
  files unless explicitly allowed, and secret-looking content.

**The security floor** is not a "system skill" category (that is just `built-in`) but
the existing dimensions, enforced on any self-authored / edited skill:

- **No allowed-tools self-escalation** — a skill's `allowedTools` cannot grant the
  agent tools it is not already permitted; the A3 / permission floor stands *above*
  skills, never below. **Never infer broad `allowed-tools` from a successful session.**
- **Model-invocable gating** — auto-invokable skills (`modelInvocable`) are the
  higher-risk class; a self-authored skill defaults to **user-invocable-only** until
  ratified.
- **Instructions vs executable scripts** — Markdown instructions are config-grade
  (cheap to author); a skill bundling an **executable script** crosses the code/A3
  floor and needs **ratify + sandbox** (cc-2.1 gates bundled scripts behind
  workspace-trust; hermes allowlists + mtime-revalidates).
- **Never `built-in`** — agents author `user` / `project`, never the immutable floor.

**Hot-reload.** Self-authoring needs the skill registry to pick up a newly written
skill **without a process restart**: the registry is **startup-loaded and cached**
(`agentSubagents.ts:1141,1255`) — the same startup-cache problem as memory in
`.agents/` ([[agent-conversation-model]] §5) — so this extends the existing on-demand
`discoverSkillDirsForPaths` path to hot-reload a freshly authored skill.

### Curation (later — opt-in, agent-created only)

Background skill curation ships **only after** controlled authoring, and stays
deliberately conservative (self-modification §8):

- Curate **only agent-created skills** by default; never silently mutate pinned or
  user-authored skills.
- **Prefer archive over delete**; snapshot before any mutation; produce a review
  report; support **dry run**; apply only when the user enables it.
- The first version **reports** stale / duplicate / malformed / unused agent-created
  skills — it does **not** auto-edit `SKILL.md` from a background pass. A background
  model never rewrites a skill on inferred preference without an approved concrete
  patch.

### Policy matrix (skill rows)

| Area | Read | Review preview | Auto write | Ask write | Deny |
|---|---|---|---|---|---|
| Skill creation | allow templates | allow | explicit user-requested local create | ask for agent-initiated create | broad tool preapproval; legacy command dirs; `built-in` writes |
| Agent-created skill edits | allow diffs | allow | explicit user-requested patch | ask for agent-initiated patch | silent background mutation |
| User-authored skill edits | allow diffs | allow | deny | ask | silent mutation of user-authored skills |
| Skill curation | allow reports | allow | deny initially | ask | user-authored silent mutation |

## Protocol surface & events (M0 dependency)

- **`SkillDefinition.source += 'built-in'`** (`src/core/types.ts`) — protocol surface;
  land **interface-first** in M0 ([[agent-program]] foundation).
- **`skill.*` events** (create / patch / replace / support-file-write / enable /
  disable / rollback / curation-report) live in the **program event taxonomy**
  ([[agent-program]] — design once, shared with hooks/notifications), not invented here.

## Phases (mapped to program milestones)

- **M0 (foundation)** — add `'built-in'` to `SkillDefinition.source` + a
  code-registered built-in skill path; register the `skill.*` event family in the
  program taxonomy. Interface-first, no behavior change.
- **M1 (single-agent self)** — structure clarification (binding is selection over the
  unified library); `skillify` + file-tool authoring; `.agents/skills/**` write
  classification; provenance / snapshot / rollback; registry **hot-reload**;
  draft-default for agent-initiated writes.
- **M2 (off-floor + extension)** — opt-in curation **dry-run reports** (agent-created
  only). Skill-declared hooks register as run-scoped or conversation-scoped
  transients and ride the hooks work in [[agent-self-modification]] (on the
  program event bus).

## Open questions

- **Compact card vs full diff** for explicit user-requested skill writes by default?
- **Writable additional dirs** — keep additional configured skill dirs read-only, or
  allow an explicit `writable` mark?
- **Per-skill permission suggestions** — adopt cc-2.1-style per-skill invocation
  permission hints, or is the global permission center enough?
- **Where bundled adapters ship** (from [[agent-import-skill]]): a built-in
  `import/adapters/` skill bundle (versions with the app → `built-in`) vs the user
  `~/.agents/skills` dir. Leaning `built-in` now that the source exists.
- **Authorship metadata shape** — which frontmatter fields record author / provenance
  / promotion state (reuse `version`, add `source-author` / `provenance`?).

## Build checklist

- [x] Add `'built-in'` to `SkillDefinition.source` (interface-first, M0) + a
      code-registered built-in skill loader (mirrors built-in agents).
- [x] Confirm binding semantics: `AgentDefinition.skills` selects over the unified
      library; document that there is no per-agent storage.
- [x] Slash-only built-in `/skillify` workflow.
- [ ] Natural-language "save/update this as a skill" handling.
- [x] Skill-content write classification for `.agents/skills/**` (permission / audit).
- [ ] Diff / full-`SKILL.md` preview + confirmation; draft-default for agent-initiated.
- [x] Provenance metadata in tool details + `skill.created` / `skill.patched` /
      `skill.replaced` events.
- [ ] Snapshot storage + rollback UI.
- [x] Skill registry hot-reload (extend `discoverSkillDirsForPaths`).
- [x] Allowed-tools no-escalation guard; model-invocable defaults user-only until ratified.
- [x] Deny executable-script support files in the self-authoring file-tool path.
- [ ] Ratify + sandbox gate for executable-script support files.
- [ ] Curation dry-run reports (agent-created only) — M2.
- [x] Spec update: `docs/spec/agent-skills.md` (built-in source + authoring + hot-reload).
