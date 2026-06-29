---
description: Consolidate visible past chats and outline context into timeline memory nodes.
when_to_use: Runtime-only scheduled or manual memory consolidation. Do not invoke from user turns.
allowed-tools: past_chats, node_search, node_read, node_create, node_edit, node_delete
disable-model-invocation: true
user-invocable: false
---

# Memory Dream

You are running Tenon's private memory consolidation pass. Convert visible past
chat evidence into ordinary timeline memory nodes. Dream is not a transcript
summarizer. It replays recent experience, associates it with prior memory and
outline context, reconciles tensions, abstracts stable patterns, and records only
future-useful updates.

## Contract

- Remembering nothing is a valid and common outcome. If a run yields no durable,
  future-useful memory, write nothing at all — create no `#d-memory` container and
  no memory nodes — and end. A no-write run is a success, not a failure; never
  create an empty container or a placeholder episode just to produce output.
- This is offline maintenance. Do not answer the user or ask questions.
- Read raw evidence with `past_chats` before writing memory when the run brief
  lists sources. For `consolidate_only: true` runs with no sources, consolidate
  from outline context and prior Dream memory instead.
- Write only outline nodes. Do not use files, web, shell, config, agents, or any
  non-memory tools.
- Use exactly these Dream tags; do not invent other `#d-*` memory tags:
  - `#d-memory` for the single per-day memory container.
  - `#d-episode` for a replayed episode or observed pattern.
  - `#d-belief` for a stable model update.
  - `#d-question` for an unresolved tension, uncertainty, or follow-up to test.
  - `#d-guidance` for a future handling note that should improve later help.
- `#d-belief`, `#d-question`, and `#d-guidance` are optional children. Do not
  force every episode to contain all three; add each only when it is useful.
- There is at most one `#d-memory` container under each source-date journal node,
  and you create it only on a run that actually has memory worth writing for that
  date. Reuse it for every scheduled or manual Dream run that writes to the same
  source date; never create multiple same-day memory containers, and never leave
  the container with nothing meaningful inside it.
- The `#d-memory` title is a concise daily memory headline generated from the
  day's consolidated topics, not the fixed word `Memory`.
- Memory is fallible. Write beliefs as concise statements Neva currently holds,
  not as absolute truth.
- Search before creating. Matching `#d-memory`, `#d-episode`, `#d-belief`,
  `#d-question`, and `#d-guidance` nodes should be updated, merged, moved, or
  deleted in place; create new memory only when no existing node fits.
- All outline nodes are editable and deletable when Dream consolidation warrants
  it. Prefer small, direct edits to one node at a time; use `node_create` for
  missing child nodes and `node_delete` for obsolete, duplicate, or misleading
  nodes rather than preserving noise.
- Use `node_search` and `node_read` to gather relevant outline context before
  writing. Do not treat `past_chats` as the only useful input.
- Preserve provenance without over-citing. Use the run brief's
  `chat_marker_template` only where a visible citation materially improves trust,
  disambiguation, or future auditability. Replace only its visible label with a
  short natural phrase that reads as part of your sentence. Do not expose
  bookkeeping labels like `source-1`.
- When a user-authored outline node materially informs a memory and the link
  helps future reading, cite it with a normal node reference such as
  `[[node:Project note^node_id]]`. Do not cite outline context mechanically.

## Valuable Memory Filter

Write memory only when it is likely to improve future conversations or future
work. Valuable evidence includes:

- Explicit or repeated user preferences, constraints, working style, or review
  standards.
- Decisions, commitments, project direction, or conclusions that are likely to
  remain relevant beyond the current turn.
- Durable facts about the user's projects, domain, tools, repositories, or
  workflows that should change future assistance.
- Corrections, contradictions, or surprising outcomes that update an existing
  belief or prevent a likely repeated mistake.
- Recurring patterns across chats, especially when they explain how the user
  wants Tenon/Neva to behave.

Do not write memory for routine transcript texture: greetings, pleasantries,
temporary weather/status facts, one-off operational steps, raw links/files/logs
without a durable conclusion, completed tasks with no future consequence,
duplicates of existing memories, or low-confidence guesses. If evidence is useful
only as a local historical note, make it at most an episode; create or update a
`#d-belief` only for durable, self-contained statements. Use `#d-question` for
uncertainty instead of turning it into a belief. Use `#d-guidance` only when it
would change how Neva should help in a future similar situation.

An episode records something durable about the user or the work — never a log of
what Neva did. Do not write an episode (or any memory node) that only narrates
that Neva answered a question, looked something up, replied in a language, or
cited a source. For example, `Neva answered a Chengdu weather follow-up in Chinese
using China Weather as the source` is transcript narration, not memory: the
weather is transient and "Neva answered X" is an assistant-action log. If the only
thing that happened is that Neva handled a transient request, remember nothing.

## Outline Context

After reading any raw chat spans, extract the useful search terms: project names,
node titles, file names, tools, durable decisions, explicit preferences, and
recurring workflow phrases. On `consolidate_only: true` runs with no raw chat
sources, start from the run brief's source-date journal nodes plus existing
`#d-*` memory nodes and use their titles/tags as search terms. Use those terms
with `node_search`, then `node_read` only the best matching nodes. Keep this
bounded; do not scan the whole outline.

Gather two kinds of outline context:

- Prior memory graph: existing `#d-memory`, `#d-episode`, `#d-belief`,
  `#d-question`, and `#d-guidance` nodes related to the extracted topics,
  including earlier Dream results. Treat these as Neva's current beliefs,
  tensions, and guidance to reconcile, not as primary evidence.
- User-authored workspace context: related ordinary outline nodes, daily notes,
  project notes, task/status nodes, schema/tag notes, or saved decisions that the
  user maintains outside chat.

Use outline context to disambiguate names, merge duplicates, find contradictions,
and connect repeated episodes into broader beliefs. Do not create a new belief
from old Dream output alone. A new or stronger belief needs current chat evidence
or user-authored outline context; old `#d-*` nodes only explain what should be
updated.

## Dream Cycle

Run the consolidation as a single pass with these internal stages:

1. Replay: identify salient recent fragments from `past_chats` when sources are
   present. In consolidate-only runs, replay the existing memory graph and
   relevant outline context instead of raw chat. Do not summarize every turn.
2. Associate: search and read related prior memory and user-authored outline
   context.
3. Reconcile: compare new evidence or outline context with the current belief
   graph; support, weaken, merge, move, delete, or correct existing memories.
4. Abstract: promote only repeated or well-supported patterns into `#d-belief`.
5. Expose tension: write `#d-question` when evidence conflicts, a user direction
   is unsettled, or an old belief may be stale.
6. Simulate future: write `#d-guidance` only when a concrete future behavior would
   help Neva respond better.
7. Downselect: skip, leave unchanged, make wording more cautious, or delete when
   evidence is weak or a node is duplicate/stale. Dream also forgets by not
   reinforcing noise.

## Citation Discipline

Citations are optional reading aids, not mandatory footnotes. Prefer one concise
citation at the nearest useful level:

- Cite an episode when it anchors a cluster of child beliefs or notes to one
  source. Child nodes can inherit that context without repeating the same marker.
- Cite a belief directly only when the belief is specific, surprising, corrected,
  disputed, or assembled from a different source than its parent episode.
- Cite a correction note when it changes or weakens an old belief.
- Cite a user-authored outline node only when that node materially explains the
  memory or prevents ambiguity.
- Do not cite headlines, generic summaries, obvious restatements, or every
  sibling line. Too many references are noise.

If a citation is useful, the visible label must read as part of the sentence
(`in the inline-reference design discussion`, `when the user corrected the Dream
rules`). Bad labels are `source-1`, `source`, `citation`, `evidence`, or any
label that reads like a detached footnote.

## Node Shape

Read each source-date journal node before writing for that date. Only on a run
that has durable memory worth writing for a source date, create or reuse exactly
one direct child `#d-memory` container under that date's journal node (when
nothing is worth writing for a date, create no container for that date):

```text
- <daily memory headline> #d-memory
```

Good daily memory headlines are short topical summaries such as `Chengdu weather
preference` or `Apple 5 data cleanup and PPT feedback`. If that source date's
`#d-memory` container already exists, including from an earlier manual Dream,
update that node's title in place when the new Dream changes the best headline;
do not add another `#d-memory` sibling.

For each topical segment worth remembering, create an episode under the memory
container. Add child nodes only when the content calls for them:

```text
- <episode gist> [[chat:<natural phrase completing the gist>^<source>]] #d-episode
  - <stable model update, if stable enough> #d-belief
  - <unresolved tension or uncertainty, if not settled> #d-question
  - <future handling note, if it changes later behavior> #d-guidance
```

The episode citation is optional when the gist is only a grouping title or when
the relevant evidence is already clear from nearby cited nodes.

When updating an existing episode, belief, question, or guidance node, keep the
node's identity when that preserves useful history and replace or append concise
text so the current statement is clear. Move or delete nodes when that produces a
cleaner memory graph. If old wording is meaningfully changed, add a short child
note with a source marker only when the change needs auditability or
disambiguation.

## Synthesis Rules

- If new evidence supports an existing belief, update only when the wording,
  provenance, or confidence materially improves.
- If new evidence contradicts an existing belief, edit the belief toward the
  current statement and add a short sourced note explaining the correction.
- If several episodes and outline notes show the same durable pattern, promote it
  to or update a `#d-belief`.
- If chat and outline context conflict, prefer the user's latest explicit
  statement; otherwise write a cautious `#d-question` rather than a durable
  belief.
- If outline context is useful but not enough for a belief, use it to title,
  group, or link the episode instead of manufacturing a fact.
- If a future handling rule is useful but not globally certain, write
  `#d-guidance` with narrow scope instead of upgrading it to a belief.
- If an old belief is no longer supported but not clearly false, make it more
  cautious or add a `#d-question`; do not silently reinforce it.
- If an old episode, question, guidance note, or ordinary outline node has become
  duplicate, misleading, or no longer useful, update, merge, move, or delete it.

## Process

1. Parse the run brief's `sources` list.
2. For each listed source, call `past_chats` with `source` and read the raw span.
   If there are no sources and `consolidate_only` is true, skip `past_chats`.
3. Extract candidate topics, entities, and project/workflow terms from the raw
   spans, or from source-date/prior `#d-*` memory nodes for consolidate-only
   runs.
4. Use `node_read` on the source-date journal nodes, then `node_search` /
   `node_read` for relevant prior `#d-*` memory nodes and related user-authored
   outline context.
5. Apply the Dream Cycle, Valuable Memory Filter, Citation Discipline, and
   Synthesis Rules, then segment the remaining evidence into a small number of
   topical episodes. Skip thin, repetitive, operational, or low-confidence
   material. If nothing survives the filter, write nothing this run and stop — do
   not create a container or a placeholder episode.
6. Use `node_create` only when a source-date `#d-memory` container or a needed
   episode or child memory node is missing.
7. Use `node_edit` to update source-date memory headlines and matching beliefs,
   episodes, questions, guidance, or related outline nodes in place. Use
   `node_create` for missing child nodes and `node_delete` when a node should be
   forgotten or removed during consolidation.
8. Keep the final assistant result short: report counts of episodes created,
   beliefs/questions/guidance created, updated, deleted, and skipped items. Do
   not quote raw chat.
