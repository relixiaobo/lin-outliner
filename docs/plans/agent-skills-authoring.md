# Agent Skills — Structure & Governed Self-Authoring

Owns the skill subsystem's **structure** (where skills live, how they bind to an
agent) and **governed self-authoring** (how an agent creates / edits skills
safely). Extracted from [[agent-conversation-model]] (its former §Skills — the
taxonomy) and [[agent-self-modification]] (§7 Skill Maintenance + §8 Curation —
the workflow/policy) so the **same capability lives in one place** instead of two.
Sits on the **M0 foundation** defined in [[agent-program]]; the program doc owns the
cross-plan event taxonomy and the protocol-surface change list this plan depends on.

**Scope.** The skill system covers structure (unified library, by-name binding, the
`built-in` floor) and self-authoring v1 (`/skillify`, governed `.agents/skills` writes,
hot-reload, no-escalation guard) — design in `docs/spec/agent-skills.md`; a convergence pass
(source taxonomy collapsed to `AgentSourceKind`, single skill-path resolver, ratification
gate re-layered onto invocation); skill acceptance (the ratification loop + single-step
undo); workspace-trust gate for cloned-repo `project` skills; and the shipped Skillify
creative UX (v2 body, contract-aware direct writing, and natural-language
save/update routing).
Remaining tails are executable-script support-file ratify+sandbox and opt-in curation
dry-run (ride with M2 self-mod). (Lifecycle status lives in `docs/TASKS.md`.)

**Convergence pass.** A design review found the M1 skill implementation had three seams
worth fixing pre-launch (see *Governance layering & single-source identity* below): a
redundant `dynamic` `source` value, two disagreeing
definitions of "what is a skill" (a real governance hole), and write-time governance heavier
than it needed to be. The fix landed as **one convergence PR (#174)** that collapsed the
`source` taxonomy, gave skill-path identity a single source of truth, and re-layered
governance along the cc-2.1 split (validation→load, no-escalation→invocation,
model-invocability→listing). The `types.ts` interface change rode **in the same PR** (PM
call — not carved out). It was the prerequisite for the Skillify v2 creative-UX work
(`save as skill` + contract-aware direct writing), which later shipped on top.

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

**Shipped implementation includes**: code-registered immutable `built-in` skills,
slash-only `/skillify`, governed self-authoring through `file_write` / `file_edit`,
skill-content validation and no-escalation guards, registry hot-reload after
successful skill writes, `skill.created` / `skill.patched` / `skill.replaced` audit
events, Skillify v2 contract clarification, and natural-language routing into the
Skillify path. Opt-in curation remains later work.

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

### Skillify Upgrade — creative UX execution unit

**Shape: ONE complete feature in one PR.** This creative-UX unit shipped as #230
and #271, not as a new skill subsystem. It upgrades the built-in `/skillify`
workflow from "thin write guidance" to a Tenon-native capture/update workflow,
while continuing to use the existing skill runtime, existing file tools, and the
existing ratification/acceptance model.

#### Goal

Make explicit user requests such as "save this as a skill", "turn that workflow
into a skill", "update the import skill with what we just learned", or
`/skillify <description>` produce a durable, reviewable `SKILL.md` that captures
the repeatable process with enough structure for future use.

The upgraded workflow should reliably produce:

- a stable skill name and storage target (`user` vs `project`);
- a concise `description`, precise `when_to_use`, and conservative trigger
  examples;
- arguments and `argument-hint` only when future invocations need them;
- an explicit execution mode (`inline` by default, `context: fork` only for
  self-contained work, optional `agent` only when the chosen agent definition is
  essential);
- step-by-step instructions with success criteria, artifacts, human checkpoints,
  and hard rules where they matter;
- minimal `allowed-tools` for the future skill, not a replay of every tool used
  while authoring it;
- direct `file_write` / `file_edit` when the explicit request determines the
  contract, with clarification only for a missing material choice.

#### Non-goals

- No new model-facing skill CRUD tools. The workflow still writes through
  `file_write` / `file_edit` after review, matching the current cc-2.1-aligned
  surface.
- No new trust or permission primitive. Agent-written skills are ratified by
  default; exact-byte acceptance in Settings is optional audit metadata, not an
  invocation gate.
- No dedicated preview-card protocol in this PR. The complete `SKILL.md` or
  focused diff is shown only when it is needed to resolve a material ambiguity.
  The ordinary folder-capability policy remains the only file access surface.
- No executable support-file authoring. The existing M1 deny path for executable
  support files stays in force until a separate ratify+sandbox design lands.
- No background curation or silent skill rewriting.

#### Design

**1. Replace the built-in body with a Tenon-specific Skillify v2 workflow.**

`src/main/agentSkills.ts` keeps `/skillify` as a code-registered immutable
built-in, but the body becomes a structured authoring playbook derived from the
cc-2.1 workflow and translated into Tenon terms:

- Analyze the current conversation before asking questions: repeatable process,
  inputs, steps, user corrections, required artifacts, tool needs, and success
  criteria.
- Do not over-interview. For a simple explicit request, ask only for missing
  name/storage/trigger details; for ambiguous or broad workflows, run a short
  structured interview.
- Use `ask_user_question` only for a real choice that cannot be inferred. If the
  current runtime cannot use it, ask one concise plain-language question in the
  normal conversation.
- Use Tenon paths and frontmatter: `.agents/skills/<skill-name>/SKILL.md`,
  lowercase `skill` tool semantics, no `.claude/skills`, and no `name`
  frontmatter field because identity comes from the directory name.
- Explain `user` vs `project` storage in product terms: personal workflows go to
  `~/.agents/skills`; repo/workspace-specific workflows go to
  `<workspace>/.agents/skills`.
- Use Tenon execution vocabulary: inline skill, `context: fork`, optional
  `agent`, and path-conditional `paths`. Do not mention cc-2.1-only concepts such
  as "Teammate" or legacy command directories.

**2. Creation and update paths are distinct.**

For a new skill:

- propose a normalized skill directory name;
- choose user/project storage with the user;
- write one `SKILL.md` with the stable supported frontmatter shape;
- keep instructions concise and put large references in explicit support files
  only when necessary.

For an existing skill:

- resolve and read the current `SKILL.md` first;
- preserve existing `description`, `when_to_use`, `arguments`, `paths`,
  `context`, `agent`, `model`, `effort`, and `allowed-tools` unless the user
  explicitly wants to change them or the change is required by the new workflow;
- prefer a focused `file_edit` patch over whole-file replacement;
- show a focused diff, and call out any changes to `allowed-tools`,
  auto-invocation, storage path, or execution mode before writing.

**3. Explicit authoring intent is sufficient; ambiguity is resolved before writing.**

Before writing:

- infer the storage target, invocation form, model invocation state,
  `allowed-tools`, and execution mode from the explicit request and conversation;
- write directly when those inputs determine one coherent contract;
- show the complete file or focused diff only when it is needed to obtain a
  missing material decision; persistence or agent authorship alone never creates
  a confirmation step.

After writing:

- report the exact path;
- state how to invoke it (`/<skill-name> ...`);
- explain that slash and eligible automatic model use are available immediately;
  optional exact-byte acceptance remains visible in Settings for audit;
- if the write failed validation, repair the draft and retry only after showing
  the corrected preview when the change is material.

**4. `allowed-tools` becomes an authored contract.**

Skillify v2 must not infer broad preapproval from the session that produced the
skill. It should:

- separate tools needed to author the skill from tools needed to run the future
  workflow;
- omit `allowed-tools` when no preapproval is needed;
- prefer narrow read/search rules for discovery-heavy workflows;
- keep writes, bash, external actions, and irreversible operations out of
  preapproval unless the workflow's whole point requires them and the pattern can
  be narrow;
- flag broad `allowed-tools` as a review item in the preview summary.

**5. Trigger quality is a success criterion.**

`when_to_use` must include positive and negative guidance. A good trigger starts
with "Use when..." and names example user requests; it should also say when not
to auto-invoke if the phrase is ambiguous or the workflow is destructive,
infrequent, or judgment-heavy. Such skills should default to user-invoked slash
usage with `disable-model-invocation: true` unless the user explicitly wants
automatic invocation.

#### Touched files

- `src/main/agentSkills.ts` — replace the built-in `/skillify` body with the
  Skillify v2 workflow text; keep the existing immutable built-in registration
  and `whenToUse` gate.
- `docs/spec/agent-skills.md` — describe the upgraded Skillify contract under
  reference alignment / compatibility.
- `docs/spec/agent-tool-design.md` — if needed, clarify that Skillify preview
  uses normal conversation + `ask_user_question`, not a skill CRUD tool.
- `tests/core/agentSkills.test.ts` or a small focused unit test — pin the
  built-in body's Tenon-specific invariants: `.agents/skills`, no `.claude`
  path, no `name` frontmatter, preview-before-write, existing-skill read before
  patch, conservative `allowed-tools`, and unratified-after-write messaging.

#### Risks

- **Over-asking.** cc-2.1's interview loop is thorough but can become heavy.
  Mitigation: make "do not over-interview simple skills" a first-class rule.
- **Wrong namespace leakage.** The reference uses `.claude/skills`, `Skill`,
  and `name:` frontmatter. Mitigation: tests pin Tenon's `.agents/skills` and
  directory-derived identity.
- **Overbroad preapproval.** A model may copy authoring tools into the future
  skill. Mitigation: preview summary must flag `allowed-tools`; tests pin the
  body text that separates authoring tools from runtime tools.
- **False sense of acceptance.** Saving and accepting are separate. Mitigation:
  the success message explicitly states slash availability vs automatic
  model-invocation trust.

#### Verification

- `bun run typecheck`
- `bun run test:core -- agentSkills`
- `bun run docs:check`
- No renderer visual verification is required unless the implementation adds a
  dedicated preview surface, which this plan does not require.

#### Collision check

Last refreshed 2026-07-01: no open PR currently claims `/skillify`,
`agentSkills.ts`, or `docs/spec/agent-skills.md`. The historical adjacent PRs
reviewed when this section was drafted have merged: #229
`cc-2/agent-workdir-relocation` and #227 `codex/file-preview-pdf`. If a future
branch edits the same `docs/spec/agent-tool-design.md` paragraph, keep the
Skillify note as a narrow clarification rather than a broad rewrite.

**Write requirements** (from self-modification §7, carried verbatim in intent):

- No dedicated model-facing skill-CRUD tool. Use `skillify`-style contract
  resolution + `file_write` / `file_edit`; prefer `file_edit` for existing skills, `file_write` only
  for new skills / major rewrites / unpatchable malformed files.
- Generate or update a concrete `SKILL.md` in the stable shape of
  `docs/spec/agent-skills.md`; write only to standard `.agents/skills` roots.
- **Allow writes only to `user`-local and workspace (`project`) skills.** Additional
  configured dirs are read-only unless explicitly marked writable. **Never `built-in`.**
- Classify any `file_write` / `file_edit` under `.agents/skills/**` as a
  **skill-content write**, not a generic document edit — distinct permission / audit
  / snapshot path.
- Explicit user-directed writes run once the skill contract is determined. The
  gateway records the content hash for provenance and optional exact-byte
  acceptance, but all otherwise eligible skills remain ratified by default and
  available for slash and model invocation.
- Write atomically; snapshot the previous version; expose undo. Validate frontmatter,
  size, paths, supported subdirs before/after write; surface failures as repairable.
- Reject path traversal, symlinks escaping the skill dir, executable/binary support
  files unless explicitly allowed, and secret-looking content.

**The security floor** is not a "system skill" category (that is just `built-in`) but
the existing dimensions, enforced on any self-authored / edited skill:

- **No allowed-tools self-escalation** — a skill's `allowedTools` cannot grant the
  agent tools it is not already permitted; the A3 / permission floor stands *above*
  skills, never below. **Never infer broad `allowed-tools` from a successful session.**
- **Model-invocable gating** — explicit frontmatter/settings controls remain the
  only model-invocation gates; authorship does not add an approval prompt.
- **Instructions vs executable scripts** — Markdown instructions are config-grade
  (cheap to author). Executable support files remain disabled until a dedicated
  design routes them through the shared `AgentProcessExecutor`, immutable folder
  capability snapshots, content validation, and mtime/hash revalidation. It must
  not add a second process sandbox or a generic confirmation card.
- **Never `built-in`** — agents author `user` / `project`, never the immutable floor.

**Hot-reload.** Self-authoring needs the skill registry to pick up a newly written
skill **without a process restart**: the registry is **startup-loaded and cached**
(`agentSubagents.ts:1141,1255`) — the same startup-cache problem as memory in
`.agents/` ([[agent-conversation-model]] §5) — so this extends the existing on-demand
`discoverSkillDirsForPaths` path to hot-reload a freshly authored skill.

### Governance layering & single-source identity (convergence, 2026-06-09)

The shipped M1 works but carries three seams. Each is grounded in code; the fix is one
coherent convergence PR. The reference is **cc-2.1** (Claude Code 2.1), whose skill
authoring is: ordinary `Write`/`Edit` file tools (no typed skill-CRUD tool), path-keyed
write detection in the filesystem-permission layer, skills confined to canonical
locations, and contract resolution carried as *skillify instructions* — not a runtime
pipeline (`~/.research-repos/cc-2.1/src/skills/bundled/skillify.ts`,
`utils/permissions/filesystem.ts:101`).

**Seam 1 — `dynamic` is a category error on the `source` axis.** `SkillDefinition.source`
is `'built-in' | 'user' | 'project' | 'dynamic'` (`types.ts:821`) while
`AgentDefinition.source` is `'built-in' | 'user' | 'project'` (`:802`) — the claimed
agent/skill symmetry is broken. No code branches on `source === 'dynamic'`; it is only
ever unioned on (`AgentSourceKind | 'dynamic'` at `agentSkillAuthoring.ts:11/18/144`,
`agentEventLog.ts:890`, `agentRuntime.ts:5369`). A `dynamic` skill physically lives under
the work root (a nested `.agents/skills`); "dynamic" describes *how it was discovered*
(runtime walk-up from touched files, gitignore-aware, `discoverSkillDirsForPaths`,
`agentSkills.ts:751`), not *where it lives*. Path-conditional activation is already a
separate mechanism (`conditionalSkills` + `paths`, `agentSkills.ts:644,706`), so
`dynamic` carries no weight.

→ **Fix:** collapse `source` to `'built-in' | 'user' | 'project'` (= `AgentSourceKind`,
symmetric with agents). Nested-discovered dirs classify by the *same* location rule the
configured-dir branch already uses (`isPathInside(dir, root) ? 'project' : 'user'`,
`agentSkills.ts:787`). Drop the `| 'dynamic'` unions. No behavior change (nothing reads
it). The collapsed taxonomy equals the natural mental model: **`built-in` (app, immutable)
· `user` (your unified library — hand-authored + imported) · `project` (came with the
work context, whether root-level or nested-discovered)**.

**Seam 2 — two disagreeing definitions of "what is a skill" (governance hole).** The
loader recognizes skill dirs from the *real configured set* (defaults +
`additionalSkillDirectories`, classified by location, `agentSkills.ts:782-787`). The
write-governance detector recognizes them from a *hardcoded path regex* (only
`~/.agents/skills`, `<root>/.agents/skills`, and nested `.agents/skills`,
`agentSkillAuthoring.ts:85-99`). They disagree: a skill in an additional configured dir
that is outside the root and not named `.agents/skills` (e.g. `~/team-skills/`) is loaded
as a real, model-invocable `user` skill, but a `file_edit` to its `SKILL.md` is **not**
recognized as a skill content write — no validation, no audit, no no-escalation guard,
no hot-reload. This hole exists *because* lin added `additionalSkillDirectories`, which
cc-2.1 does not have (cc-2.1's path-regex is trivially single-source because skills only
live in canonical locations). We keep the feature (PM 2026-06-09: cannot drop it).

→ **Fix:** one authoritative resolver. The `AgentSkillRuntime`/registry exposes
`resolveSkillTarget(filePath): SkillTarget | null`, built from the *same* dir set the
loader enumerates (defaults + `additionalSkillDirectories` + on-demand
`discoverSkillDirsForPaths([filePath])`). The loader uses it to enumerate; the file-tool
gateway (`agentLocalTools.ts:911,986`) calls it to detect a skill write. The hardcoded
regex in `detectAgentSkillContentTarget` is deleted. **Recognition ≠ permission:** every
real skill dir is recognized/governed; whether a given dir is *writable* (the
additional-dirs question) becomes a separate permission policy (default read-only), denied
at the permission layer — never by the detector failing to see it.

**Seam 3 — write-time governance is heavier than it needs to be.** lin runs frontmatter
validation, support-file shape checks, a `RISKY_ALLOWED_TOOL_NAMES` no-escalation guard,
secret scanning, path-traversal/symlink/exec checks, audit, snapshot, and forced
`disable-model-invocation` all at write time (`agentSkillAuthoring.ts`). Verified against
the invocation path: catastrophic/platform hard-blocks and global denies are enforced at
invocation regardless of preapproval (`agentPermissions.ts:271,281,297`), so the guard's
"can't exceed the floor" portion is **redundant**; but skill `allowed-tools` *do* grant in
restricted mode (`:311`), so the "don't preapprove risky tools" portion is **not**
redundant. cc-2.1 handles the latter by human review (skillify confirm) + the floor, not a
write-time string guard.

→ **Fix — re-layer along the cc-2.1 split** (corrected in the 2026-06-10 re-review;
two rows of the first draft were mis-layered):

| Current write-time check | Layer | Why |
|---|---|---|
| skill-path detection | **write boundary** (the resolver, Seam 2) | thin routing gate; must be here |
| frontmatter / support-file validation | **write boundary as model feedback; load time as enforcement** | a bad write must fail loudly back to the model (a "successful" write whose skill silently fails to load is a worse feedback loop); the loader stays tolerant of hand-authored files |
| no-escalation (`RISKY_ALLOWED_TOOL_NAMES` reject) | **invocation time** (ratification gate, below) | structural + robust; deletes the leaky string heuristic |
| forced `disable-model-invocation` | **listing + invocation time** (ratification gate) | stop mutating the authored file; policy lives in runtime |
| secret scan | **stays at the skill write boundary** | skills are durable instructions injected into future contexts (an exfil amplifier) — skill-specific; a global secret block on all file writes would false-positive on ordinary code |
| hidden / executable support files, size caps | **stays at the skill write boundary** | support files ride skill invocation — skill-specific; lin has no sandbox to delegate to |
| audit events (`skill.created/...`) | **write boundary** | they are *about* the write |
| snapshot / rollback metadata + provenance hash record | **write boundary** | must capture prior content + record authorship at the write |
| hot-reload | **write boundary** | registry must see the new file |

The write boundary's contract: **no policy decisions at write — only validity, safety,
and recording** (resolver gate → permission → validation feedback → audit → snapshot →
provenance hash → hot-reload). The two *policy* checks move to the ratification gate.

**The ratification model (the centerpiece — simplified in the 2026-06-10 re-review).**
The two write-time policy checks — no-escalation and forced model-invocation-off — are
the *same* idea: *a skill the user has not accepted must not be wielded by the model on
its own initiative.* The runtime already distinguishes the trigger at invocation
(`trigger: 'agent' | 'slash'`, `agentSkills.ts:392,400`), which permits a much simpler
gate than the first draft's "inert allowed-tools" machinery:

- **Unratified** (agent-authored, not yet accepted): excluded from the model skill
  listing, and a `trigger: 'agent'` invocation is **refused** outright. **Slash
  invocation always works, with `allowed-tools` honored in full** — the user typing
  `/name` is per-run consent, the same consent model as cc-2.1's skillify confirm.
  Escalation is structurally impossible: the model path is closed entirely, and the
  slash path is user-initiated.
- **Ratified** (`built-in` · user-authored · accepted agent skills · `project` skills —
  the workspace-trust boundary for cloned-repo skills is a named follow-up, not this
  PR): model-invocable per frontmatter; `allowed-tools` live as preapproval.

**The marker is a runtime hash record, not frontmatter** (decided by the threat model,
not preference): frontmatter provenance is self-reported — a hostile repo can write
`provenance: user`, and trust cannot live inside the artifact being trusted. Instead the
file-tool gateway records `(skill file → content hash)` at every agent `SKILL.md` write
(in-memory always, persisted to userData when wired). A skill is unratified iff its
current content hash matches the recorded agent-written hash. Consequences that fall out
for free:

- **A user hand-edit changes the hash → the skill self-ratifies** — today's escape hatch
  ("the user edits the file") is preserved with clean semantics: touched by a human =
  the human's.
- `disable-model-invocation` returns to being an ordinary user-set frontmatter knob; lin
  never force-writes policy into an authored file.
- An agent patch to a user-authored skill records the new hash → the skill drops to
  slash-only until the user touches/accepts it. Safe direction; documented behavior.
- Record loss (wiped userData) fails open to ratified — acceptable for the agent-write
  threat; PR A's acceptance record hardens this.

Authorship and trust stay split: the gateway-recorded hash carries *provenance* (who
wrote this version — a fact), ratification (did the user accept — a decision) is derived
now and becomes an explicit acceptance record in PR A. The file is never rewritten to
encode policy.

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

| Area | Read | Direct write | Clarify | Block |
|---|---|---|---|---|
| Skill creation | allow templates | explicit user-requested local create | missing identity/storage/trigger/behavior | `built-in` writes; invalid or executable content |
| Existing skill edit | allow current file/diff | explicit user-requested patch | materially ambiguous contract change | silent background mutation |
| Skill curation | allow reports | only an explicitly requested concrete patch | unresolved curation choice | inferred background rewriting |

## Protocol surface & events (M0 dependency)

- **`SkillDefinition.source += 'built-in'`** (`src/core/types.ts`) — protocol surface;
  landed in M1 (#153).
- **Convergence: `SkillDefinition.source` collapses to `AgentSourceKind`**
  (`'built-in' | 'user' | 'project'`, dropping `'dynamic'`) — protocol surface. Per PM
  2026-06-09 this interface change rides **in the convergence PR** (not carved out into a
  standalone interface-only PR), because the enum literal has compile fallout (loader
  tagging + the `| 'dynamic'` unions) that must move with it and the change is pure cleanup
  with no behavior effect.
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
- **M1 convergence** — collapse the `source` taxonomy, single skill-path resolver, and
  governance re-layering (validation→load, no-escalation→invocation ratification,
  model-invocability→listing). One PR; interface change rides in-PR. See *Governance
  layering & single-source identity*. Prerequisite for the shipped Skillify v2
  creative-UX work (`save as skill` + contract-aware authoring).
- **M2 (off-floor + extension)** — opt-in curation **dry-run reports** (agent-created
  only). Skill-declared hooks register as run-scoped or conversation-scoped
  transients and ride the hooks work in [[agent-self-modification]] (on the
  program event bus).

## Open questions

- **Compact card vs full diff** for explicit user-requested skill writes by default?
  (Now an instruction-layer concern — carried in `skillify` like cc-2.1, resolved in the
  creative-UX PR (#230), not the convergence PR.)
- ~~**Writable additional dirs**~~ — **resolved (convergence):** recognition ≠ permission.
  All real skill dirs are recognized/governed via the single resolver; writability is a
  separate permission policy (default read-only), denied at the permission layer.
- ~~**Per-skill permission suggestions**~~ — **resolved:** no dedicated prompt or
  UI. `allowed-tools` is restricted-Run preapproval metadata; the global folder
  capability service and hard floor remain authoritative.
- **Where bundled adapters ship** (from [[agent-import-skill]]): a built-in
  `import/adapters/` skill bundle (versions with the app → `built-in`) vs the user
  `~/.agents/skills` dir. Leaning `built-in` now that the source exists.
- ~~**Authorship metadata shape**~~ — **resolved (2026-06-10 re-review):** not
  frontmatter (self-reported, forgeable by a hostile repo) — a **gateway-recorded
  content-hash record** (in-memory always; persisted to userData when wired). Ratified
  iff the current file hash differs from the last agent-written hash; a user hand-edit
  self-ratifies. PR A adds the explicit acceptance record on top.
- **Workspace trust for `project` skills** (named follow-up, not this PR): a cloned
  repo's `.agents/skills` with broad `allowed-tools` is model-invocable today; cc-2.1
  gates this behind workspace trust. Orthogonal to agent self-authoring — needs its own
  plan.

## Build checklist

- [x] Add `'built-in'` to `SkillDefinition.source` (interface-first, M0) + a
      code-registered built-in skill loader (mirrors built-in agents).
- [x] Confirm binding semantics: `AgentDefinition.skills` selects over the unified
      library; document that there is no per-agent storage.
- [x] Slash-only built-in `/skillify` workflow.
- [x] **Skillify v2 body** — capture/update prompt, contract clarification
      contract, conservative `allowed-tools` guidance, and Tenon namespace tests
      shipped in #230. See *Skillify Upgrade — creative UX execution unit*
      above.
- [x] **Natural-language Skillify routing** — explicit "save/update/fix this as a
      skill" requests normalize to the `/skillify` path; shipped in #271.
- [x] Skill-content write classification for `.agents/skills/**` (permission / audit).
- [x] Diff / full-`SKILL.md` preview available when a material choice remains;
      explicit fully determined requests write directly with no new model-facing
      skill CRUD tool.
- [x] Provenance metadata in tool details + `skill.created` / `skill.patched` /
      `skill.replaced` events.
- [x] **PR A — skill acceptance** (close the ratification loop) — **merged #175**: explicit
      accept/revoke + positive trust record + `skillify` model-invocable + single-step undo.
      Carved into its own focused plan, archived `done`: [[agent-skill-acceptance]]
      (`docs/plans/archive/agent-skill-acceptance.md`, PM-ratified boundary 2026-06-10).
      Preview/confirm stays instruction-layer (already shipped).
- [x] ~~Snapshot storage + rollback UI~~ — **slimmed (PM 2026-06-10):** cc's "PR B"
      collapses to a **single-step undo** reusing the gateway's recorded `previousContent`,
      folded into PR A's Skills tab; deep history is git's job for `project` skills. No
      bespoke multi-version snapshot subsystem.
- [x] Skill registry hot-reload (extend `discoverSkillDirsForPaths`).
- [x] Allowed-tools no-escalation guard; model-invocable defaults user-only until ratified.
- [x] Deny executable-script support files in the self-authoring file-tool path.
- [ ] Validated executable-support-file route through the shared
      `AgentProcessExecutor`; no duplicate sandbox or trust prompt.
- [ ] Curation dry-run reports (agent-created only) — M2.
- [x] Spec update: `docs/spec/agent-skills.md` (built-in source + authoring + hot-reload).

### Convergence PR (one complete change; interface change rides in-PR)

- [x] **Seam 1** — collapse `SkillDefinition.source` to `AgentSourceKind`
      (`'built-in' | 'user' | 'project'`); tag nested-discovered dirs by location
      (`isPathInside(dir, root) ? 'project' : 'user'`); remove every `| 'dynamic'` union
      (`types.ts`, `agentSkills.ts`, `agentSkillAuthoring.ts`, `agentEventLog.ts`,
      `agentRuntime.ts`).
- [x] **Seam 2** — add `AgentSkillRuntime.resolveSkillTarget(filePath)` as the single skill-
      path source of truth (defaults + `additionalSkillDirectories` + nested dirs);
      loader enumerates through it; the file-tool gateway detects skill writes through
      it; delete the hardcoded regex in `detectAgentSkillContentTarget`.
- [x] **Seam 2** — recognition ≠ permission. Skill writes use the ordinary
      `file_write` / `file_edit` permission decision; recognition only drives
      validation, audit events, rollback metadata, provenance, and hot reload.
- [x] **Seam 3 / ratification** — gateway records `(skill file → content hash)` on every
      agent `SKILL.md` write (in-memory in the registry; persisted to
      `agent-skill-provenance.json` in userData, shared by subagent runtimes). A skill is
      unratified iff its current hash matches the record. `SkillDefinition` gains
      `ratified` + `contentHash`.
- [x] **Seam 3** — listing: `getModelInvocableSkills` excludes unratified skills.
      Invocation: `trigger: 'agent'` on an unratified skill is refused
      (`skill_not_ratified`); slash invocation unaffected, `allowed-tools` honored in
      full (user intent = per-run consent). Note: agent-definition skill *preload* also
      runs as `trigger: 'agent'`, so a bound-but-unratified skill is refused at preload —
      correct, since binding names the skill, not its content.
- [x] **Seam 3** — delete the write-time `RISKY_ALLOWED_TOOL_NAMES` no-escalation reject
      and the forced `disable-model-invocation` requirement; update `/skillify`
      instructions + gateway feedback text to describe the ratification semantics.
- [x] **Seam 4 (corrected)** — validity/safety checks (size, hidden/exec support files,
      secret scan, frontmatter shape) STAY at the write boundary as model feedback;
      loader stays tolerant of hand-authored files. No policy decisions at write.
- [x] `bun run typecheck` + `test:core` (779 pass) + `test:renderer` (389 pass); spec
      updated in the SAME change (A6): collapsed source taxonomy, single resolver, the
      no-policy-at-write contract, and the ratification model.
