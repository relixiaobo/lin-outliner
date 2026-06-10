---
status: draft
priority: P2
owner: unassigned
created: 2026-06-10
updated: 2026-06-10
---

# Memory: align docs, prompts, and tools with the academic model

**Shape: (a) ONE complete feature in one PR.** Language surfaces only — zero
storage, schema, or tool-contract change. **Subsumes the former D2**
(`agent-memory-encoding-signal`, now superseded into this plan) so the Dream
prompt is rewritten once, not twice.

**Authority:** `agent-memory-foundations.md` (the binding glossary + authoring
rules, PM directive 2026-06-10) and `agent-data-model.md` § *Canonical memory
vocabulary*.

## Goal

Every model-facing and user-facing memory language surface speaks the academic
model — same behavior contracts, professionally grounded language, plus the one
encoding-policy improvement (prediction-error weighting) folded in:

1. **Dream extraction prompt** (`src/main/agentDreamExtraction.ts:262-309`,
   subject framings `:331+`) — rewrite as *consolidation* instructions: the
   role framing names the process (offline consolidation of the episodic
   record into the principal's semantic store), and the selection criteria are
   stated as *encoding policy*: durable, context-free knowledge (semantic);
   **novelty/prediction-error-weighted** (outcomes that diverged from what was
   assumed or intended — the folded-in D2 cue); reconsolidation framing for
   updates (new evidence touching an existing fact yields `update`/`invalidate`,
   not a duplicate). The evidence-fence anti-injection mechanics stay verbatim.
2. **Briefing rendering** (`src/main/agentMemoryBriefing.ts`) — the briefing
   introduces itself as the working-memory slice of the semantic store; zone
   semantics unchanged (`<self>` second person, `<principal>` third person);
   copy aligned, structure untouched.
3. **`recall` tool description** (`src/main/agentRecallTool.ts:29-48`) —
   described as *cued retrieval over the semantic store*, `include_evidence` as
   *source access* (descending the index to the episodic record). Parameter
   names/shapes unchanged (the tool contract is settled).
4. **Settings memory UI copy + i18n** — en + zh-Hans aligned with §5.4 of the
   foundations (forgetting language never says delete; "invalidated"/"inactive").
5. **Spec sync (A6)** — `agent-skills.md`/`agent-tool-design.md` (wherever the
   Dream/recall contracts are documented — locate at claim) re-worded to the
   canonical vocabulary; `agent-data-model` delta list updated.

## Boundary (钉死)

- **NO tool schema/parameter change; NO storage/event change; NO behavior
  change beyond the encoding-policy cue.** If alignment seems to require any,
  stop and escalate.
- The Dream **anti-injection fence and JSON output contract stay byte-level
  intact** in spirit — re-verify the guard tests still pass.
- NOT D1 (strengths), D3 (reverse index), D4 (ranking) — those stay separate.

## Acceptance

- [ ] All five surfaces use the foundations vocabulary; a doc-side grep guard
      (or review checklist in the PR) confirms none of the banned invented
      terms appear in memory prompts/copy.
- [ ] D2's encoding test lands here: a fixture span with a clear
      user-correction and a tool-surprise → extraction proposes facts citing
      those spans (model-in-loop if the harness supports it; else prompt
      snapshot + manual note).
- [ ] Dream guard/extraction tests + `bun run test:core` green vs baselines;
      i18n coverage stays complete; Settings visual check light + dark.
- [ ] Spec synced; this plan archived `done`;
      `agent-memory-encoding-signal` already archived `superseded`.

## Collision self-check (2026-06-10, plan time)

Touches Dream prompt, briefing copy, recall description, Settings copy/i18n.
No overlap with M3-A (`agent-channel-peers` — runtime routing/UI); safe to run
in parallel with it. Overlaps future D1/D4 surfaces — this ships first.
Re-run `gh pr list` at claim time.
