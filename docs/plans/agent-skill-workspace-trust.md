---
status: draft
priority: P2
owner: unassigned
created: 2026-06-10
updated: 2026-06-10
---

# Workspace trust for `project` skills (per-skill acceptance)

**Shape: (a) ONE complete feature in one PR.** The named follow-up from PR #175.

> **Direction PM-ratified 2026-06-10: reuse the per-skill acceptance mechanism**
> (#175) rather than a VS Code-style whole-repo trust gate or a two-layer model.
> Zero new concepts; the same ratified-derivation + Skills-tab accept flow.

## Goal

Skills that arrive **with a cloned repository** must not be silently trusted as
if the user wrote them. A `project` skill becomes model-invocable only after the
user has explicitly accepted **those exact bytes** in Settings → Skills — the
same acceptance the user already performs for agent-written skills.

## The hole (verified 2026-06-10, `file:line`)

- Skill parsing defaults to trust: `ratified: true`
  (`src/main/agentSkills.ts:1249-1252` — "Trust default").
- The registry flips `ratified` to false **only** when the content hash matches a
  recorded agent write and is unaccepted
  (`src/main/agentSkills.ts:1036-1040`: `!(record?.agentHash === currentHash) ||
  accepted`).
- Project skills load from `.agents/skills` under the work root with source
  `'project'` (`src/main/agentSkills.ts:1090, :989-990`). A cloned repo's skills
  have **no provenance record** → ratified → listed to the model (if not
  `disable-model-invocation`). A malicious skill in a cloned repo is a prompt
  injection that runs on every turn the model chooses to invoke it.

## Design

1. **Flip the default for `source === 'project'`:** ratified **iff**
   `acceptedHash === currentHash` (provenance store value already carries
   `acceptedHash`, `src/main/agentSkillProvenanceStore.ts:53`). No record → NOT
   ratified. Unaccepted project skills keep today's agent-written semantics:
   loaded, listed in Settings, **slash-invocable by the user** (an explicit user
   action), but excluded from the automatic model skill listing
   (`getModelInvocableSkills` already filters on `ratified`).
2. **No hand-edit self-ratification for project skills.** The user-skill rule
   "an edit changes the hash and self-ratifies" must NOT apply: editing a
   repo-borne skill still requires accepting the new bytes (acceptance is always
   of exact content). Re-acceptance after any content change falls out of the
   hash rule for free.
3. **`user` and `built-in` sources unchanged.** User-dir skills keep the trust
   default; built-ins keep their immutable floor. Agent-written records keep the
   #175 logic everywhere.
4. **UI:** the Skills tab's existing accept flow covers project skills; add a
   visible "from workspace — not yet accepted" state so the pending set is
   discoverable (reuse the #175 unratified affordance; no new surface).
5. **Spec sync (A6):** fold into `docs/spec/agent-skills.md` (trust model
   section); archive this plan `done`.

Known friction, accepted with the direction: the user's **own** project skills
also need a one-time accept per content change — authorship is not
distinguishable from cloned content, and one uniform rule beats a guessable
heuristic.

## Non-goals (boundary — 钉死)

- **NOT executable-script support-file ratify+sandbox** — stays deferred (#175
  merge note).
- **NOT a whole-repo trust prompt** — rejected option; granularity is the skill.
- **NOT M2 skill-curation dry-run** — deferred alongside self-mod M2.
- **NOT provenance-store re-keying** — keys stay skill file paths; a different
  clone path simply means re-acceptance (per-clone trust is intended).

## Acceptance

- [ ] Fixture test: a `project` skill with no provenance record loads
      unratified and is absent from the model skill listing; `/name` slash
      invocation still works; accept → ratified + listed; any content change →
      drops back to unratified.
- [ ] Regression: `user` + `built-in` skills and agent-written acceptance
      behavior unchanged.
- [ ] `bun run typecheck` + `bun run test:core` green vs known baselines; Skills
      tab visual check light + dark.
- [ ] Spec sync per Design 5; plan archived `done`.

## Collision self-check (2026-06-10, plan time)

- Touches `src/main/agentSkills.ts` / `agentSkillProvenanceStore.ts` /
  Skills-tab UI — the #175 surface, currently unclaimed (no open PR touches
  skills). No overlap with Phase 1 (memory) or M3 plans. Re-run `gh pr list` at
  claim time.
