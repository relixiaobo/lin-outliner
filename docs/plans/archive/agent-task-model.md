---
status: superseded
priority: P2
owner: relixiaobo
created: 2026-06-08
updated: 2026-06-08
---

# Agent / Task Model — SUPERSEDED (redirected into the agent program)

**Status: superseded (2026-06-08).** This began as a follow-on from
[[agent-authoring]] (#167): pull the "subagent is no longer an agent *type*" thread
to its end and reprocess the agent subsystem around **Agent (profile) + Task
(run)**. Main's review (PR #168) **redirected** it: the repo already has a
PM-approved, in-progress program — [[agent-program]] (M0–M3) /
[[agent-conversation-model]] (the spine) / [[agent-data-model]] (the persistence
contract) — that already owns this territory. This plan was drafted **without
finding that program** and reinvented the model (DM | Channel | Task run-shapes, a
top conversation switcher, model-onto-profile), conflicting with several
already-ratified decisions. Kept to record the path not taken.

## What was right (salvaged → folded into [[agent-conversation-model]] §Code mapping)

The post-#167 kernel was sound and survives as a **bounded clean-cut** note in
conv-model:

- **"subagent" is not an agent type** — it's an agent running a task.
- **Retire `general`** — post-#167 it is an empty-body built-in
  (`agentSubagents.ts:1295`), redundant with the primary identity run fresh.
- **`fork` is a context mode**, not a throwaway pseudo-`AgentDefinition`.
- **Capability is profile-only** — drop the `Agent` tool's per-call `model`/`effort`
  overrides (`agentSubagents.ts:635-636`).

## Why the standalone framing was redirected (verified vs code + approved plans)

| #168 proposed | Conflict (verified) |
|---|---|
| `conversation = DM \| Channel` stored kind, "channel-ready types" | `AgentConversationMeta` has only `members + goal`, **no `kind`** (`agentEventLog.ts:109`); [[agent-conversation-model]] + [[agent-program]] F2 explicitly **forbid a stored kind**. |
| Full rename subagent → task incl. **storage** | [[agent-program]] M3 note: must **not** redesign `agentSubagentIdentity.ts` / `agentSubagentTranscript.ts`. Rename is contract + UX only. |
| Redefine **Task** = every `Agent` call (incl. sync foreground) | [[agent-data-model]] `RunMeta.kind` already fixes Task = off-floor `background` run. Same name, different meaning. |
| "memory-owner rename is just wording" | Identity strings (`built-in:tenon:assistant`, `…:general`) are on-disk memory keys; renaming/retiring **orphans** persisted memory — a dev-`userData` wipe, not a no-op. |
| "Option A: model onto profile (new decision)" | Already **PM-ratified** in [[agent-conversation-model]] §Agent (model moves onto the agent profile). Not new. |
| DM/Channel foreground + Providers/Permissions reorg in one PR | That is M1–M3 across the program; [[agent-conversation-model]] owns DM/Channel; scope creep. |

One tell: #168's only forward wikilink was a non-existent `[[agent-channels]]` —
channels are already owned by [[agent-conversation-model]]. The plan was authored
blind to the program.

## Disposition

- Kernel folded into [[agent-conversation-model]] §Code mapping (the bounded
  CLEAN-CUT note), honoring F2 no-stored-`kind`, the protected identity/transcript
  seams, Task = `background`, and identity-rename = dev wipe.
- DM/Channel/foreground/config-unification → already owned by
  [[agent-conversation-model]] / [[agent-program]] (M1–M3); nothing new to add.
- This file archived; PR #168 redirected to carry the fold + this record.
