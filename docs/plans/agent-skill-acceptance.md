---
status: draft
priority: P1
owner: relixiaobo
created: 2026-06-10
---

# Agent Skill Acceptance — close the ratification loop

Makes PR #174's ratification gate usable: the user can **accept** an agent-authored
skill into automatic (model) use without hand-editing the file. One complete feature,
one PR. This is the "PR A" creative-UX tail of [[agent-skills-authoring]], scoped down
to the one real gap (PM-ratified boundary, 2026-06-10).

**Why this is the next PR.** #174 stood up the gate — agent-authored skills are born
unratified (hidden from the model listing, `trigger: 'agent'` refused), slash always
works. But the *only* way to promote a good agent-written skill to automatic use today
is to hand-edit the file so its hash stops matching the recorded agent write. Without an
explicit "accept" path, the convergence UX is a half-product.

## Goal

- One-click promotion of an unratified, agent-authored skill to model-invocable, from
  the Skills settings panel.
- Trust becomes a **positive, explicit record** (the user accepted exactly these bytes),
  split from provenance (who wrote these bytes) — the direction the parent plan states.

## Non-goals (boundary — fixed)

- **No runtime preview/diff pipeline.** Preview-before-write stays instruction-layer in
  `skillify` (already shipped in #174: "show the full SKILL.md or a focused diff and
  confirm before writing"). Do not build a diff UI.
- **No snapshot store / rollback UI** — that is the separate "PR B" decision.
- **No workspace-trust gate** for cloned-repo `project` skills — separate plan.
- **No M2 curation.**
- **No change to the gate semantics** from #174 (listing exclusion + `trigger: 'agent'`
  refusal stay as-is); this PR only adds the positive signal the gate already consumes.
- **Not a fail-open fix.** Store loss (wiped userData) still fails open to ratified —
  inherent to side-record trust, accepted in #174. Acceptance is a UX completion plus a
  positive trust fact, NOT a new security boundary. State this honestly; do not claim it
  closes the hole.

## Design

1. **One trust record.** Extend the `agent-skill-provenance.json` value from `string` to
   `{ agentHash?: string; acceptedHash?: string }`, keyed by resolved skill file. The
   agent-write hash (recorded by the gateway) and the user-acceptance hash live in one
   store, one path key. Pre-release format change → wipe `~/.lin-outliner-*` dev userData,
   no migration / no back-compat reader.

2. **`ratified` stays a pure derivation** (in `addLoadedSkill`):

   ```
   ratified = source === 'built-in'
            || currentHash !== agentHash      // a human produced these bytes
            || currentHash === acceptedHash   // the user accepted these bytes
   ```

   i.e. unratified iff `agentHash === currentHash && acceptedHash !== currentHash`. No
   state machine. Both desirable behaviours fall out for free: a user hand-edit changes
   `currentHash` away from `agentHash` → ratified; an agent re-patch records a fresh
   `agentHash` and leaves `acceptedHash` stale → drops back to unratified.

3. **Accept / revoke actions.** New IPC `agent_accept_skill(name)` → registry records
   `acceptedHash = skill.contentHash`, persists, hot-reloads. `agent_revoke_skill_acceptance(name)`
   clears `acceptedHash`. Acceptance grants nothing beyond the skill's own frontmatter —
   the A3 permission floor still stands above it, and a `disable-model-invocation: true`
   skill stays user-only even when accepted.

4. **Skills tab** (`src/renderer/ui/agent/AgentSettingsView.tsx`): each row already shows
   a `source` chip + an enable/disable toggle and already receives `ratified`. Add a
   "pending acceptance" indicator on agent-authored unratified rows plus an **Accept**
   control (Revoke on accepted ones). Built-in / hand-authored rows are unaffected
   (always ratified). Honour `prefers-*` + the design-system tokens; no brand accent for
   the state (B3/B4).

5. **NL save-as-skill.** Flip the `skillify` built-in to `modelInvocable: true` so a
   conversational "save this as a skill / update the X skill" picks up the curated
   skillify guidance (naming, minimal `allowed-tools`, preview/confirm) instead of
   ad-hoc file writes. Its `whenToUse` already gates it to user-requested saves; the
   written skill is still born unratified, so this widens discovery, not trust.

## Touched files

`src/main/agentSkillProvenanceStore.ts` (value shape), `src/main/agentSkills.ts`
(derivation + accept/revoke + skillify flag), the agent IPC layer +
`src/renderer/api/client.ts` / `types.ts` (new commands), `src/renderer/ui/agent/AgentSettingsView.tsx`
(UI), `docs/spec/agent-skills.md` (A6). Protocol: `SkillDefinition` is unchanged —
`ratified` / `contentHash` already exist; no `src/core/types.ts` change unless the accept
IPC needs a new request/response shape (keep it out of the protocol surface if possible).

## Risks

- **Store format change** — handled by a dev-userData wipe (pre-release; no migration).
- **`skillify` model-invocable** could let the model auto-decide to skillify. Bounded:
  gated by `whenToUse`, the write is still ask-gated, and the result is born unratified —
  worst case is a draft skill the user ignores. Surface to PM at ratify.
- **Acceptance keyed by resolved file path** → a rename/move re-requires accept (same
  property as #174 provenance). Documented behaviour.

## Open questions (PM ratify)

- `skillify` → model-invocable: **recommend yes** (it is the NL path; gated by `whenToUse`).
- Revoke in v1: **recommend yes** (trivial; clearing `acceptedHash` — avoids a half-product).

## Checklist (one PR; internal build order — A7 foundation before consumers)

- [ ] Store value `{ agentHash, acceptedHash }` + the `ratified` derivation in `addLoadedSkill`.
- [ ] `agent_accept_skill` / `agent_revoke_skill_acceptance` IPC + registry methods + hot-reload.
- [ ] Skills-tab pending-acceptance indicator + Accept/Revoke control.
- [ ] `skillify` `modelInvocable: true`.
- [ ] Spec update (A6); `bun run typecheck` + `test:core` + `test:renderer`; light+dark
      visual verification of the Skills tab; `/code-review` (trust-adjacent + IPC surface).
