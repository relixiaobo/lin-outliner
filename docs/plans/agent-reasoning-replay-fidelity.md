# Agent Reasoning Replay Fidelity

## Goal

Prevent provider reasoning summaries from leaking into the visible transcript as
ordinary assistant commentary such as `[Reasoning]`. Preserve native reasoning
replay while its provider signature is valid, and keep unsigned canonical
reasoning out of assistant prose when rebuilding later provider context.

## Non-goals

- Do not hide arbitrary provider text in the renderer or add a presentation-only
  filter for `[Reasoning]`.
- Do not persist provider-private reasoning signatures or create a second
  provider transcript beside canonical Thread history.
- Do not change the canonical `reasoning` or `agentMessage` protocol shapes.
- Do not suppress genuine command failures, validation errors, tool output, or
  other process Items.
- Do not rewrite already sealed Turns or migrate existing development data.

## Shape

This plan is shape (a): one complete feature in one PR. Provider projection,
history reconstruction, stream normalization safeguards, specification updates,
and regression coverage ship together.

## Evidence

A real multi-tool Turn produced a visible commentary Item containing
`[Reasoning]\n**Using stdlib for XHTML parsing**`. The stored Item was an
`agentMessage` with `phase: commentary`, so the renderer was consuming canonical
data correctly.

The captured provider interaction establishes the preceding sequence:

1. Earlier reasoning summaries in the same active Turn were returned as native
   thinking blocks with provider signatures.
2. Before the affected provider call, six of those summaries appeared in the
   outgoing request as assistant `output_text` blocks prefixed with
   `[Reasoning]`.
3. The provider then returned the same format as a text block, used zero
   reasoning tokens for that call, and attached a tool call.
4. Stream normalization correctly classified the text block as a commentary
   `agentMessage`; later calls returned to native thinking blocks.

The issue is therefore request-context contamination, not renderer styling or
history-store corruption. Three matching canonical leaks were found across the
examined development history, all on the same custom OpenAI Responses route, so
the failure is intermittent but repeatable.

## Collision Result

- PR #450 has merged its provider-call budget enforcement, and PR #451 has
  merged the `ThreadService` decomposition. The implementation can now target
  the settled `CanonicalContextProjector` / `PiTurnExecutor` boundary and
  `TurnLifecycle` ownership directly.
- Current open PRs #455 and #456 touch `SubagentCollaboration`; neither touches
  context projection, `PiTurnExecutor`, or the provider-call kernel. PR #453 is
  renderer-only and PR #454 is docs-only, so there is no active file collision.
- The change does not require `src/core/commands.ts`, `src/core/types.ts`,
  `package.json`, or another infrastructure-ownership file.
- This dev PR records only the design and does not edit main-owned
  `docs/TASKS.md` or `CHANGELOG.md`.

## Design

### Replay Invariants

Provider projection must distinguish ephemeral provider messages from canonical
history instead of representing both as assistant prose:

- Within the active Turn, retain a native thinking block only when its signature
  belongs to the same provider, API, and model targeted by the next call. This
  state remains in memory for the duration of execution and is discarded with
  the runtime session.
- Across Turns, canonical `reasoning` Items have no provider-private signature.
  Omit them from rebuilt provider messages. Never convert them to a text block,
  and never introduce a textual `[Reasoning]` marker.
- Provider/model changes invalidate native reasoning replay. Omit the unsigned
  reasoning block while retaining ordinary assistant messages, tool calls, and
  tool results.
- Canonical `agentMessage` Items remain assistant text. Tool calls and results
  remain paired exactly as today, so removing unsigned reasoning cannot break
  tool-call continuity.

Canonical reasoning remains durable and visible through the established
`Thinking` / `Thought` disclosure. It is omitted only from later provider input
when it cannot be represented with its native contract.

### Active-turn Projection

Keep the provider's complete in-memory assistant message through each tool loop.
The next provider request should receive its signed native reasoning item and
the associated tool call. No intermediate canonical projection may downgrade
that reasoning to `output_text`.

`PiTurnExecutor` currently asks `CanonicalContextProjector` to rebuild every
provider request after the active `ItemRecorder` flushes. Preserve that
canonical authority for durable messages and tool pairing, but let the
projection boundary retain the current provider message's signed reasoning
parts in memory for the same Turn. It must not persist those private parts or
substitute the kernel transcript for canonical history.

The provider-payload boundary owns the final compatibility decision. A signed
reasoning item may be replayed only when the target identity and active Turn
match; all other cases drop the reasoning part before serialization. The
payload must contain no synthetic `[Reasoning]` assistant text produced by
Tenon.

### Cross-turn Reconstruction

Change canonical history reconstruction so a `reasoning` Item contributes no
assistant text. Continue reconstructing user messages, ordinary commentary and
final answers, tools and full tool results, Subagent activity, viewed images,
and compaction context under their existing rules.

Dropping unsigned reasoning is intentional: it avoids teaching the provider
that an internal label is valid user-visible prose, while preserving the
observable work and results needed for conversation continuity. Do not replace
the marker with another label; that would retain the same failure mode under a
different string.

### Stream Normalization

Continue treating provider text as `agentMessage` and provider thinking as
`reasoning`. The structural replay fix should prevent Tenon-authored marker
leaks before the request is sent.

Do not silently reclassify arbitrary text beginning with `[Reasoning]`: a
provider may legitimately quote that string, and normalization must not infer
hidden semantics from prose. If live verification still produces the exact
marker after outgoing requests are clean, record that as a separate provider
compatibility finding rather than adding a renderer heuristic.

### Existing History

Sealed Turns remain immutable. Existing leaked `agentMessage` Items continue to
render and copy as recorded facts. Pre-release development data may be wiped
under the repository's existing policy; this feature adds no migration or legacy
reader.

## Anticipated Files

- `src/main/agent/context/ContextProjector.ts`
- `src/main/agent/runtime/PiTurnExecutor.ts`
- The narrow provider-projection type or kernel seam under
  `src/main/agent/runtime/kernel/` only if the current in-memory provider
  message cannot be retained inside `PiTurnExecutor`
- `tests/core/agentPiTurnExecutor.test.ts` and focused runtime-kernel tests
- `docs/spec/agent-model-runtime.md`

Renderer files and canonical protocol files should remain unchanged unless live
evidence disproves the request-boundary diagnosis.

## Risks

- Omitting unsigned historical reasoning removes some model-visible process
  context. Ordinary messages, tool calls, and complete results remain, and those
  are the durable behavioral evidence; tests must verify continuity across a
  tool-heavy prior Turn.
- Replaying a signature against a different provider, API, or model can cause a
  provider validation failure. Identity matching must fail closed by omitting
  the reasoning part.
- A projection change can accidentally make the kernel transcript a competing
  history authority. Tests must prove that only same-Turn signed reasoning is
  retained from memory while every durable message and tool pair still comes
  from canonical Items.

## Open Questions

None for product behavior. Main may choose the narrowest in-memory handoff at
the settled projection boundary while preserving these invariants.

## Verification

- Unit-test canonical history reconstruction with reasoning before and between
  tool calls; no reconstructed assistant text contains `[Reasoning]`, and tool
  calls/results remain paired and ordered.
- Test a multi-call active Turn with signed native reasoning, a failed tool, and
  a retry. The next captured provider payload retains native reasoning where
  valid and contains no synthetic reasoning `output_text`.
- Test provider/model mismatch: unsigned or foreign reasoning is omitted without
  dropping ordinary assistant text or breaking tool-result pairing.
- Test stream normalization independently: native thinking still records a
  canonical `reasoning` Item, ordinary commentary still records an
  `agentMessage`, and a command failure remains visible.
- Run a real custom OpenAI Responses Turn with several tool loops and one
  intentional recoverable failure. Inspect Model Interactions and the canonical
  rollout to confirm clean requests, correct Item types, and no visible injected
  marker.
- Run `bun run typecheck`, `bun run test:core`, `bun run test:renderer`, the
  relevant Agent E2E scope, `bun run docs:check`, and `git diff --check`.
