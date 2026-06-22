# De-couple tool-output slimming from the canonical transcript

## Goal

Tool-output context slimming (the budget offload + the time-based microcompact)
must shrink only the **model's** per-request context, never the canonical
transcript the UI renders and search indexes. Today a `tool_result.replaced`
event overwrites the reduced record's `content`, so an old `web_search` /
`web_fetch` result that was full at creation later renders as **input-only / no
output** and drops out of search. After this change the canonical `content`
stays full forever; only the copy handed to the model is slimmed.

This is the Claude Code 2.1 stance (its `query.ts` slims a throwaway
`messagesForQuery` copy and journals the decision to a sideband; the persisted
transcript and TUI keep full content). We reach the same place with **no new
sideband**: the existing `tool_result.replaced` event already *is* the durable,
monotonic slim-decision journal — we only change what the reducer does with it.

## Non-goals

- Not changing *when* or *what* gets slimmed (same budget/microcompact triggers,
  thresholds, `COMPACTABLE_TOOL_NAMES`, keep-recent-N). Only the *application
  point* moves: model-view instead of canonical.
- Not touching the >50K immediate offload at creation time
  (`afterToolResultForModelContext`): a result that was already a `payload_ref`
  in its `tool_result.created` event stays a preview in the UI — that is
  pre-existing and orthogonal.
- Not a migration. Pre-release: the new optional field is additive; old logs
  replay fine (a record with no `tool_result.replaced` simply has no slim copy).

## Design

**Shape change.** `AgentEventMessageRecord` gains an optional
`modelSlimmedContent?: AgentPersistedContent[]` — the model-only substitution for
this tool result. `content` remains the canonical full output.

A tool result's **model-facing** content is `modelSlimmedContent ?? content`; its
**canonical** content is always `content`. Every consumer picks the right one:

| Consumer | Reads | Why |
|---|---|---|
| Model-context derivation (`runtimePiMessageFromRecord`) | model-facing | the model sees the slim |
| Renderer projection (`toRenderMessageEntity`) | canonical | the UI shows full output |
| Search index (`agentEventStore`) | canonical | full output stays searchable |
| Slim-decision helpers (budget / microcompact) | model-facing | "already slimmed?" must test the model view, else it re-slims every turn |

**Reducer (`agentEventLog.ts` `tool_result.replaced`).** Stop overwriting
`content` / `outputSummary` / `updatedAt`. Instead set
`message.modelSlimmedContent = cloneContent(event.content)` and record the source
seq (provenance). The event still persists exactly as before — it is the durable
slim-decision record, so the model view is reconstructed identically on replay
(monotonic ⇒ prompt-cache stable: once slimmed, a result is never un-slimmed,
because the canonical `content` is never what the decision logic reads back).

**Model derivation (`agentRuntime.ts` `runtimePiMessageFromRecord`).** The
`toolResult` branch derives content from `message.modelSlimmedContent ??
message.content`.

**Slim-decision helpers (`agentToolOutputSlimming.ts`).** "Is this result already
slimmed?" must read the model view now that canonical stays full, or every turn
re-emits a `tool_result.replaced` (infinite duplicate events):
- `restoreToolResultBudgetStateFromMessages`: detect the `<persisted-output>`
  payload_ref in `modelSlimmedContent ?? content`.
- `collectMicrocompactCandidates`: skip already-`[cleared]` results and compute
  size from `modelSlimmedContent ?? content`.
- `collectToolResultBatches` (budget sizing) keeps reading `content`: a *fresh*
  (not-yet-seen) result has no slim copy, so its full size is the right measure
  of what it currently costs the model; seen results are frozen out by `seenIds`
  regardless of size.

**Search index (`agentEventStore.ts`).** On `tool_result.replaced`, keep the full
searchable text already indexed by `tool_result.created`; only advance
`latestSeq` and register the offload payload id for retrieval. Do not re-index
the slimmed text.

**Renderer.** No code change: `toRenderMessageEntity` already reads `content`,
which is now always full. The "input-only / no output" rows become full again.

### Build order (single PR, one complete feature)

1. Field on `AgentEventMessageRecord` + reducer writes `modelSlimmedContent`.
2. Model derivation reads model-facing content.
3. Slim-decision helpers read model-facing content.
4. Search index keeps full text on replace.
5. Tests: reducer keeps `content` full + sets slim copy; derivation slims;
   projection/search stay full; microcompact/budget don't re-emit on a
   slimmed result.

## Open questions

None blocking. (`outputSummary` deliberately keeps its full/original value so the
projection's summary matches the now-full body.)
