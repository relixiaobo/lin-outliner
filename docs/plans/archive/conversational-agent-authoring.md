# Conversational Agent Authoring — create an agent through chat

**Part of the [[agent-program]].** The `agentify` twin of `skillify` — and now **fully
symmetric** with it, with **no new tool**: a user-directed *interview → confirm-in-chat →
write* skill that turns a conversation into a reusable custom **agent**, exactly the way
`skillify` turns one into a reusable **skill**. The agent drafts an AGENT.md and writes it
with the **existing `file_write` tool**; the only enabling change is making the agent's own
self-definition directories writable, plus a hot-reload hook on the agent registry.

## Goal

Let a user ask their agent, in normal conversation, to build a reusable custom agent. The
agent **designs** it (interviews for purpose, when it should run, what tools and tone it
needs; drafts a tight `description` + body + the AGENT.md frontmatter), shows the full file,
and — on the user's OK in chat — **writes it with `file_write`**, after which it is
immediately live and appears in Settings like any other agent. The exact `skillify` shape,
for agents.

## Non-goals

- **No new agent tool.** Authoring reuses the existing `file_write`; the only new code is the
  `create-agent` skill + the write-boundary slice + the reload hook. (This is the load-bearing
  constraint — a dedicated `propose_agent` / `create_agent` tool was considered and rejected
  as the *less* clean option.)
- **No generic agent CRUD tool family** for the model (`agent_create` / `agent_patch` /
  `agent_delete`). Authoring is a skill that writes an AGENT.md, not a mutation API.
- **Create-only this PR.** Editing / tuning / deleting an existing agent through chat is a
  follow-up; the Settings agent editor already edits/deletes.
- **Not a general file-jail removal.** This widens the file-write boundary to **exactly the
  agent's own self-definition dirs** (skills + agents), nothing else — distinct from the broad
  "file tools read/write anywhere" question that [[agent-permission-blacklist-default-allow]]
  (#277) deferred to a separate filesystem-contract plan.
- **Not multi-agent "configure each other."** Who-configures-whom across agents is
  [[agent-conversation-model]]'s (M3), not this.

## Background — why a skill + a boundary slice, not a tool

`skillify` is clean because skills are model-writable via `file_write` + hot-reload. Agents
should work the same way. Investigation showed why they don't today, and what the minimal fix
is:

- **The file-write jail blocks the real registry.** `file_write` is realpath-jailed to the
  workspace root (`agentLocalTools.ts` `resolveWorkspacePath` / `allowedRealRoots`, default
  root `<userData>/agent-workdir`). The user-scope agent registry `~/.agents/agents` — and even
  `~/.agents/skills` — is **outside** that jail, with no entry in the (empty by default)
  granted write roots. So `file_write` cannot reach it, and **`skillify` itself cannot write
  user-scope skills today** — a latent gap.
- **There is no "project" agent in the product.** `localRoot` is just env/cwd with zero UI
  ([[no-workspace-concept-product-fact]]); "project scope" resolves to `<userData>/agent-workdir`
  — app scratch, not a meaningful project. The agents that matter are **user-scope**
  `~/.agents/agents` (what the Settings editor writes).
- **The old "model never writes agent definitions" stance is dead.** Its only rationale was
  self-escalation — a created agent out-powering its creator. The `agent-capability-ceiling`
  resolution killed it: a created agent's `permissionMode` is type-locked to `'restricted'`
  (`AgentDelegationPermissionMode`), `tools` only filters which tools are wired, and every run
  passes the global gate + non-negotiable floor. A written agent is at most a convenience
  packaging of restricted, already-gated behavior.

So the clean move is to make the agent's own **self-definition directories** a writable surface
(the symmetric counterpart of skills already being model-writable), add the one piece of
plumbing agents lack (a reload on write), and author via the existing `file_write`. No new
tool — and skillify's user-scope gap closes for free.

## Design

### Shape

**Shape (a): ONE complete feature in ONE PR.** The three pieces (the `create-agent` skill, the
self-definition write boundary, the agent-registry reload hook) are build-order *within* one PR
(foundation before consumers, A7). The PR ships only when create-an-agent-through-chat works
end-to-end and the new agent goes live.

### Mechanism (now truly symmetric with `skillify`)

```text
user asks for an agent
  -> agent interviews (purpose / when it runs / tools / tone)
  -> agent drafts a full AGENT.md, shows it in chat, confirms with the user
  -> agent writes it with the existing file_write into <workspace>/.agents/agents/<name>/AGENT.md
     (or ~/.agents/agents/<name>/AGENT.md after explicit personal/global write scope)
  -> the write-completion path validates the AGENT.md and reloads the agent registry
     (the mirror of skills' notifySkillContentWritten -> reloadAll, for agents)
  -> the new agent is live (durable peer, in the dock, listed in Settings)
```

### The three pieces

1. **Skill `create-agent`** (bundled, built-in immutable floor — add to
   `DEFAULT_BUILT_IN_SKILLS` in `agentSkills.ts`). Pure *workflow knowledge*, no write power of
   its own. `when_to_use`: the user wants to build / needs a specialized or reusable agent. It
   teaches the agent to interview for the load-bearing fields (purpose, activation, tool needs,
   tone/voice), draft a tight `description` (the routing line) + a focused body + the AGENT.md
   frontmatter (`name`, `description`, `tools`, `restricted` permission mode, `model`), **show
   the full AGENT.md, confirm with the user, then `file_write` it.** The direct twin of the
   bundled `skillify` skill.

2. **Self-definition write boundary** (the enabling change). Treat project self-definition
   directories — `<localRoot>/.agents/agents` and `<localRoot>/.agents/skills` — as the standing
   file-tool surface. Personal/global roots (`~/.agents/agents` and `~/.agents/skills`) remain
   reachable only through an explicit handed write scope, not implicitly from every workspace.
   The content gateway still recognizes both project and personal/global targets once the
   ordinary file-tool permission boundary has allowed the path. This keeps the authoring model
   first-class without turning a random workspace into a bridge to the user's global registry.

3. **Agent-registry hot-reload hook**. In the file-write completion path (`agentLocalTools.ts`,
   where skill writes are already recognized → validated → reload), recognize writes under the
   agents dir (`agentsDirForStorage`), **validate** the AGENT.md parses (reuse the unified parser
   from #184), then call `reloadAgentDefinitions()` and surface the new agent — the mirror of
   skills' `validateAgentSkillContentWrite` / `notifySkillContentWritten` → `reloadAll`. A
   malformed write fails gracefully back to the model as a normal file-write error; the registry
   is never left broken.

### Confirmation & safety

- **Confirmation is in-chat, `skillify`-style** — the skill teaches the model to show the full
  AGENT.md and confirm before writing. Consistent with [[agent-skill-write-gate-removed]]:
  skill/agent writes carry **no system write-gate**; the floor is invocation-time (the agent
  runs `restricted` + globally gated). This fits the novice-friendly default-allow direction
  better than a settings form.
- **The created agent has no special powers.** `permissionMode` is type-locked to `'restricted'`
  (`AgentDelegationPermissionMode`, `types.ts:798/851`; `AgentEditor` offers only `restricted`);
  `tools` only filters wiring; every run hits the global `decideAgentOperationEffect` + floor.
  Nothing escalates — which is why no ceiling and no privileged bridge tool are needed.
- **The boundary stays narrow + jailed.** `file_write` still realpath-jails every write; project
  self-definition dirs are inside the workdir, and personal/global self-definition dirs require
  explicit write scope. Writes anywhere outside the workdir + handed scopes are still refused.
- **Audit.** The write/reload path emits a creation event to the agent event log (initiator =
  `user`, via = `create-agent` skill), consistent with the self-mod event-log requirement.
- **Aligned with #277.** Writing an agent is **not** on the [[agent-permission-blacklist-default-allow]]
  hard redline — it is not permission self-mod (that floor is `agent.permission.modify` only,
  `agentPermissions.ts:1461`) and not a soft block. Under default-allow it runs silently, backed
  by audit + a settings-visible, deletable result.

### Stance & boundary scope (the load-bearing PM decision)

This **deliberately makes project self-definition dirs model-writable** — what the old design
refused ("the model never reaches this surface — only the user, through the settings UI").
Skills already crossed this line conceptually (model-writable via `file_write`, write-gate
removed, safety = the invocation floor); this **completes** it for project agents and skills.
Personal/global agents and skills remain writable through existing file tools only after an
explicit personal/global write scope, not through a new privileged mutation API. The created
agent is still `restricted` + globally gated, so no new capability is unlocked. The reversal is
the thing `/security-review` confirms at the gate.

### Reuse (no new infrastructure)

- **Write surface:** the existing `file_write` tool (realpath-jailed) — same as `skillify`.
- **Hot-reload:** the existing `reloadAgentDefinitions()` (`agentDelegation.ts`) + the skills
  `notify → reloadAll` pattern (`agentSkills.ts`) as the template.
- **Parser:** the unified AGENT.md parser (#184 run-unification).
- **Skill registry:** `agentSkills.ts` built-in floor + the `/skillify` precedent.

### Files (anticipated)

- **New:** the `create-agent` bundled skill (body + entry in `DEFAULT_BUILT_IN_SKILLS`,
  `agentSkills.ts`).
- **Changed:** `agentLocalTools.ts` — recognize agent-dir writes in the write-completion path
  after the ordinary file boundary allows the path → validate the AGENT.md →
  `reloadAgentDefinitions()` + surface the new agent (mirror the skills branch); a creation
  audit event.
- **Tests + spec:** `docs/spec/agent-tool-permissions.md` (the self-definition write boundary);
  `docs/spec/agent-tool-design.md` (the `create-agent` skill + the agent-write reload affordance);
  **revise the [[agent-self-modification]] / `agentAuthoring` "model never writes the agent
  registry" stance** — project agents and skills join as model-writable, hot-reloaded,
  invocation-gated self-definition content; personal/global targets require explicit write scope.
- **Not in this plan:** no new tool, no custom UI, no IPC round-trip, no ceiling clamp.

### Gate

`typecheck` + `test:core` + `test:renderer` + `docs:check`; **security-sensitive (a file-write
boundary change) → `/security-review`**; file-tool boundary + registry touch → `/code-review
ultra`. No custom UI ships, so there is no visual gate.

## Open questions

- **Boundary scope.** Project self-dirs are standing file-tool roots because they are under the
  workdir. User/global self-dirs require explicit handed write scope; this avoids making every
  workspace an ambient bridge to `~/.agents`.
- **Fold in the skillify user-scope fix?** User/global `~/.agents/skills` is recognized by the
  content gateway when an explicit write scope reaches it, but it is not implicitly writable.
- **Confirmation richness.** `skillify`-style in-chat confirm only (recommend — matches the #277
  novice direction), or also offer a one-click "open the existing agent editor prefilled"?
  *Recommend: in-chat only for v1; the Settings editor already handles post-hoc edits.*
- **Capture scope.** Support only explicit "build me an agent that does X" (v1), or also "turn
  this conversation / these instructions into an agent" (infer an implicit spec)? *Recommend:
  explicit-only for v1.*
- **Validation strictness.** Require `name` + `description`, tolerate unknown frontmatter keys
  (as the parser already does), reject only on parse failure? *Recommend: yes.*
- **`#General` touchpoint (soft, not a dependency).** A newly-created durable agent should flow
  through whatever "a durable peer appeared" hook [[default-general-channel]] adds for
  auto-membership later. That mechanism is not built yet (design only); this plan does not depend
  on it.

## Implementation checklist (build-order within the one PR)

- [ ] `create-agent` bundled skill (interview → draft AGENT.md → show → confirm → `file_write`)
      in `DEFAULT_BUILT_IN_SKILLS`.
- [ ] Self-definition write boundary: keep project `.agents/{agents,skills}` under the normal
      workdir file area, require explicit write scope for user/global `~/.agents/{agents,skills}`,
      and validate both through the same content gateway.
- [ ] Agent-registry hot-reload hook in the file-write completion path: recognize agents-dir
      writes, validate the AGENT.md, `reloadAgentDefinitions()` + surface the new agent (mirror
      `notifySkillContentWritten` → `reloadAll`); malformed → graceful file-write error.
- [ ] Creation audit event (initiator = `user`, via = `create-agent` skill).
- [ ] Tests: interview → write → agent-live happy path; malformed AGENT.md → graceful error,
      registry intact; a written agent runs `restricted` + gated; writes outside the workdir +
      handed scopes are still refused; user/global self-definition writes require explicit scope.
- [ ] Spec sync: `agent-tool-permissions.md` (self-definition write boundary) +
      `agent-tool-design.md` + revise the [[agent-self-modification]] "model never writes the
      agent registry" stance.
