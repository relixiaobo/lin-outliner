---
status: draft
priority: P3
owner: unassigned
phase: memory-D2 (fast-track-insertable)
created: 2026-06-10
updated: 2026-06-10
---

# Memory D2: encoding signal — prediction-error-weighted encoding

**Shape: (a) ONE complete feature in one PR — small.** Nearly prompt-only;
explicitly **fast-track-insertable** at any point (does not wait for M3).

> **PM clarification (2026-06-10):** the earlier "错题集 / lessons-learned"
> phrasing was an offhand PM example, **not a product requirement**. This plan
> stands (or falls) on the academic encoding literature alone, and stays
> optional P3.

## Goal

Sharpen *what consolidation encodes*, per the standard memory-science finding:
**prediction error gates encoding** — surprising / expectation-violating events
are preferentially consolidated over expected ones (the novelty/PE encoding
effect; in the AI-memory lineage, Schank's dynamic-memory "expectation-failure
reminding"; cf. event segmentation at prediction-error boundaries).

Today Dream's extraction prompt asks for "facts worth keeping" generically,
giving expected and surprising content equal footing. This PR adds
**prediction error as a first-class extraction cue**: the Dream prompt
instructs the model to weight spans where outcomes diverged from what was
predicted or intended (a correction from the user, a tool result contradicting
an assumption, an abandoned approach), alongside — not replacing — stable
preferences/identity facts.

## Design

1. **Prompt:** extend the Dream extraction instructions
   (`src/main/agentDreamExtraction.ts` — re-verify at claim) with the
   prediction-error cue + a one-line framing rule for such facts
   ("when X was assumed, Y happened; therefore Z").
2. **No schema change.** A prediction-error-encoded fact is still a flat
   `fact` with `sources[]` — no `kind` field (settled: kinds were rejected;
   such a memory is distinguishable by its content, not a stored tag).
3. **Eval-style test:** a fixture transcript containing a clear user-correction
   and a clear tool-surprise; assert the extraction proposes facts citing those
   spans (model-in-loop test if the harness supports it; otherwise a prompt
   snapshot test + manual verification note in the PR).

## Non-goals

- NOT a stored `kind`/tag on entries; NOT retrieval changes (D1/D4); NOT new
  events. If the dev finds the fix genuinely needs schema, stop and escalate.

## Acceptance

- [ ] Prompt updated; extraction on the fixture surfaces the correction + the
      surprise as candidate facts with correct sources.
- [ ] Existing Dream tests green; `bun run typecheck` + `bun run test:core` vs
      baselines.
- [ ] Spec note in `agent-skills.md`/`agent-tool-design.md` (wherever Dream's
      extraction contract lives — locate at claim) + archive this plan `done`.

## Collision self-check (plan time 2026-06-10)

Touches only the Dream extraction prompt + tests. No protocol surface. Safe to
run in parallel with anything except a concurrent Dream-prompt change — check
`gh pr list` at claim.
