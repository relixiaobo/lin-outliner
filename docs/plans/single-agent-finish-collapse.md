# Finish the single-agent collapse — enforce the one-Neva invariant

## Goal

Make **"there is exactly one agent, Neva"** a hard, code-enforced product
invariant. After #294 the data model already collapsed (one memory pool,
channels-only, editable built-in Neva), but the surfaces that can *create*,
*load*, or *delegate to* a **second** agent are still live. This plan removes
all of them, leaving only Neva and her **same-agent fork sub-runs** (research,
background self-work — a fork *is* Neva, not another agent).

This also closes **finding #1 of the #294 post-merge `/code-review max`** (memory
privacy): a non-fork delegated file agent runs as a principal ≠ Neva and its
`recall` reads Neva's pool. The correct fix is not memory-pool scoping — it is
removing the ability for a reader ≠ Neva to exist at all. Once no non-fork agent
can be spawned or loaded, the cross-principal read path is unreachable.

This is the **"teardown slice"** that `src/core/agentChannel.ts:18-25` already
anticipates: `isMultiAgentConversation()` is hardwired to `return false` with a
comment that the POV / reader-neutral shared-log machinery "get[s] removed
wholesale in the teardown slice."

## Non-goals

- **Do not touch Neva's editability.** The built-in assistant stays fully
  editable in place via the settings overlay (`updateAgentDefinition`'s
  `source === 'built-in'` branch, `agentRuntime.ts:1633`). Display name, persona,
  tools, skills, model, effort all keep working. The composer model/effort chip
  (#296) and the tool-edit hot-swap (#299) stay.
- **Do not remove same-agent forks.** Research (`/research`), background
  self-work, dream, and Task sub-runs are forks of Neva (contextMode `'fork'`,
  `memoryOwnerAgentId === Neva`). They stay. See
  `agent-program-is-plan-authority` / `research-skill-readonly-fork-decision`.
- **No migration / back-compat.** Pre-release. Any `~/.agents/agents/*` or
  `<root>/.agents/agents/*` files the user dropped simply stop being loaded —
  they are external files, not app-owned data, so there is nothing to wipe or
  migrate. Historical run records that stored a non-Neva `agent_type` (debug data
  only) are acceptably left dangling.

## Shape

**(a) ONE complete feature in one PR.** The invariant is only true when *every*
second-agent surface is gone; a half-done version (e.g. remove the authoring UI
but keep file-agent loading) still violates it. The three areas below are
**build-order within one PR**, not separate releases (cf. A7). They land
together. Each is independently reviewable, but none ships alone.

> ⚠️ **Touches the protocol surface.** This removes three command kinds from
> `src/core/commands.ts` (an infrastructure-ownership file). Coordinate with the
> main agent before landing; because it is a *removal* (nothing new for siblings
> to build on) it can ride in the single PR, but it must be called out at plan
> approval.

## Design

The change is almost entirely **deletion**, plus making two `agent`-tool
parameters/branches fork-only. Anchors below are verified against `main` at
`39be3784`.

### Area 1 — Remove the agent-authoring ("create a new agent") surface (#286)

Everything that creates / duplicates / deletes an agent *definition*. Keep the
**update** path (it edits Neva).

| Layer | Remove | Keep |
|---|---|---|
| Skill | `/create-agent` skill `agentSkills.ts:93` (and its i18n + any test) | `research` skill `agentSkills.ts:141` |
| File ops | `agentAuthoring.ts` `createAgentDefinitionFile` (:181), `deleteAgentDefinitionFile` (:212), `duplicateAgentDefinitionFile` (:223) | `updateAgentDefinitionFile` (:200) — used by non-built-in update; safe to keep even if no file agents remain, or remove if it becomes unreachable (see note) |
| Runtime | `agentRuntime.ts` `createAgentDefinition` (:1613), `deleteAgentDefinition` (:1701), `duplicateAgentDefinition` (:1707) | `updateAgentDefinition` (:1622) — **Neva edit path, load-bearing**; `reloadAgentDefinitions` |
| IPC | `main.ts` cases `agent_create_agent_definition` (:2547), `agent_delete_agent_definition` (:2559), `agent_duplicate_agent_definition` (:2561) | `agent_update_agent_definition` (:2553) |
| Command kind | `commands.ts:154` create, `:156` delete, `:157` duplicate | `commands.ts:155` update |
| Renderer client | `client.ts` `agentCreateAgentDefinition`, `agentDeleteAgentDefinition`, `agentDuplicateAgentDefinition` | `agentUpdateAgentDefinition` |
| Settings UI | `AgentSettingsView.tsx` `openAgentCreate` (:396) + the "New agent" `InsetRow` (:1340-1345); `AgentConfigWindow.tsx` `createAgent` / `deleteAgent` / `duplicateAgent` + the `mode:'create'` / `agent={null}` path; `AgentEditor.tsx` `onCreate`, create-mode (`agent === null`), `newAgentScaffold` | `AgentEditor.tsx` `onUpdate` + edit-mode; `AgentConfigWindow.tsx` `updateAgent` |
| i18n | `en.ts` / `zh-Hans.ts` keys: `newAgent`, `createTitle`, `createAgent` (+ delete/duplicate copy) | `editTitle`, `saveAgent` |

**Note on `file_write` self-authoring (audit, do NOT blanket-remove):** the
Explore pass flagged `agentLocalTools.ts` `createFileWriteTool` /
`validateSelfDefinitionContentWriteOrThrow` / `selfDefinitionSurfaceForPath`.
`file_write` is a **general** tool that also writes skills and ordinary files —
it must stay. Only the branch that *validates/permits writing a new `AGENT.md`
agent-definition* is in scope. Confirm whether that validation solely serves
agent creation; if it is shared with skill self-authoring (which we keep — see
`agent-skill-write-gate-removed`), leave it. This is the one place to read
carefully rather than delete by name.

### Area 2 — Remove file-backed agent loading + cross-agent ("fresh") delegation

Make the registry hold **only Neva**, and make the `agent` tool **fork-only**.

- **Registry loads only Neva.** `agentDelegation.ts` `ensureLoaded` (:1440)
  currently seeds Neva then scans `agentSearchDirs`. Drop the scan; keep the
  built-in seed (`createTenonAssistantAgentDefinition`, :1484) and the implicit
  fork pseudo-agent (`createForkAgentDefinition`, :1470).
  - Remove `agentSearchDirs` (:1498) and `loadAgentsFromDir` (:1520).
  - Remove the `includeUserAgents` option (constructor default `?? true`,
    :380) and the `additionalAgentDirectories` plumbing into the registry (it
    exists only to find more *agent* files; the **skill** directory plumbing is
    separate and stays).
- **`agent` tool becomes fork-only.** The single control point is
  `agentDelegation.ts:622` `const contextMode = params.agent_type ? 'fresh' : 'fork'`.
  - Remove the `agent_type` parameter from the tool schema (:95) and from the
    tool description (`createAgentDelegationTools`).
  - Hardwire `contextMode = 'fork'`; delete the `'fresh'` branch and
    `resolveFreshAgent` (registry lookup by name). `executingAgentId` /
    `memoryOwnerAgentId` (:640-645) collapse to always-parent (= Neva).
  - `invokeSkillChildAgent` (:512) only adds `agent_type` when a skill sets an
    explicit `agent` field; with fresh removed, drop `resolveSkillAgentType` and
    the skill `agent` field (research has none, so research is unaffected).
  - Run-record fields `agent_type` (:1668 write, :1780 read) become vestigial.
    Removing them is fine pre-release; if cheaper, leave the reader tolerant.
- **Keep the fork machinery and the child-run control tools** `AgentStatus` /
  `AgentSend` / `AgentStop` — they operate on Neva's own forks.

**Decision needed (see Open questions):** keep the user-facing fork-only `agent`
tool, or remove it entirely and let only skills (`/research`, dream, Task) spawn
forks?

### Area 3 — Remove the now-dead multi-agent residue

With Areas 1–2 done, `isMultiAgentConversation()` returning `false` makes a
block of machinery provably dead. Remove it (the `agentChannel.ts:18` comment
invites exactly this):

- `isMultiAgentConversation` (`agentChannel.ts:25`) and the
  reader-neutral shared-log / POV-inspector machinery it gates, including the
  `_members`-threaded POV assembly.
- Orphaned i18n keys with **no live renderer reference**: `inspectMemberPov`,
  `povInspectorAriaLabel`, `povInspectorTitle`, `closePovInspector`
  (`en.ts:895-900`, `zh-Hans.ts:827-832`) and any member-roster/invite copy.
- The `members` projection is now always `[Neva]` (single-member); it still
  feeds the composer (`renderer/agent/runtime.ts:1307`,
  `AgentComposerEditor.tsx:343`), so **keep it** but treat it as single-Neva.
- `AgentDebugConversationShape = 'dm' | 'channel'` (`agentTypes.ts:237`): the
  `'channel'` branch is debug-view-only and now unreachable (one member ⇒
  `'dm'`). **Optional** low-priority cleanup; not load-bearing for the invariant.

### Memory privacy (finding #1) — what changes

`memoryReadPrincipals()` already returns `[Neva]` and `memoryEntryVisibleToReader`
already returns the entry verbatim for the same principal. Once Area 2 removes
the only way to get a reader ≠ Neva, the **cross-principal** branch of
`memoryEntryVisibleToReader` (secret redaction + source-stripping) and
`crossPrincipalEvidenceRefusal` become dead code.

**Recommendation:** keep `memoryReadPrincipals()` / same-principal behavior as
is, and **keep** the cross-principal redaction branch as cheap defense-in-depth
(it is a pure guard with no live caller, so it cannot misfire) — or delete it as
dead code if the reviewer prefers a smaller surface. Either is low-risk; call it
in the PR. Do **not** re-introduce `memoryIsolation` or per-reader pools.

## Verification

- `bun run typecheck` + `bun run test:core` + `bun run test:renderer` +
  `bun run docs:check` green.
- Remove or rewrite tests that assert the deleted surfaces: agent create /
  duplicate / delete (`agentAuthoring.test.ts`), file-agent loading, fresh /
  `agent_type` consult, and any cross-principal memory-leak test. A test that
  *encodes* a removed capability is deleted, not relaxed.
- Add tests for the new invariant: (a) the registry resolves **only** Neva
  (file agents under a temp `.agents/agents/` are ignored); (b) the `agent` tool
  with no `agent_type` forks Neva (memoryOwnerAgentId === Neva); (c) `/research`
  still runs as a read-only fork.
- Manual: Settings → Agents shows Neva, editable, **no "New agent" button**, no
  delete/duplicate; dropping an `AGENT.md` under `.agents/agents/` has no effect.
- Spec (A6): fold the end-state into the agent specs
  (`docs/spec/agent-*`), and reconcile `agent-communication-colleague-model` /
  `agent-program` language that presumes multiple agents. The colleague/contact
  model (`agent-communication-colleague-model`) is **superseded** by the
  single-Neva invariant — update or retire it in the same change.

## Open questions

1. **Keep the fork-only `agent` tool, or remove it?** (Area 2.) Recommendation:
   **keep it, fork-only** — a fork is Neva delegating to herself for parallel /
   isolated work (not a second agent), and it is genuinely useful. Removing
   `agent_type` is enough to enforce the invariant. *Directional → PM ratifies.*
2. **Delete the now-dead cross-principal memory redaction, or keep as a guard?**
   Recommendation: keep (zero live callers, cannot misfire). Reviewer's call.
3. **Audit boundary for `file_write` self-definition validation** (Area 1 note):
   confirm it does not also guard skill self-authoring before removing any of it.
