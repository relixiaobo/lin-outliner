# Agent Tool Label Vocabulary

## Goal

Every tool row and tool group in the transcript reads as a sentence about what
the agent *did*, in the user's terms — never as a model-facing tool identifier,
a shell fragment, or a bare count. The transcript is the user's account of the
run; today large stretches of it are only legible to whoever wrote the tool
catalog.

## Non-goals

- No change to model-facing tool names (`file_glob`, `node_read`, …). Those are
  deliberately machine-clear and were settled by #381
  (`agent-tool-clarity-names`); this plan governs only what the *renderer*
  shows.
- No change to run-state truthfulness, status colour, or process labels — those
  are `agent-run-presentation-consistency.md` (PRs A/B/C).
- No new tool, no new Item type, no change to what tools report.
- Not a translation pass: `zh-Hans` gains the same keys, nothing more.

## Shape

Shape **(b): two independent complete features.** Both shipped in the
run-presentation status PR at the PM's call (2026-07-30) rather than as separate
releases — see each section.

- **PR 1 — one vocabulary, with subjects.** Single rows stop printing raw tool
  identifiers and join the human activity vocabulary that groups already use;
  both single rows and groups name their subject. Ships inside the
  run-presentation status PR at the PM's call (2026-07-30): the two change the
  same two label functions, and shipping status visuals alone would have
  released a row that is visually correct and verbally wrong.
- **PR 2 — command legibility.** A command row says what ran, not the shell
  plumbing that ran it.

PR 1 is the bulk of the win and is self-contained. PR 2 is a different
mechanism and carries one protocol question (below), so it must not block PR 1.

## Collision Result

`gh pr list` (2026-07-30): #461 (this clone, tool-row status visuals) touches
the same two functions in `ThreadItemView.tsx` (`summarizeThreadToolItem`,
`summarizeThreadToolActivity`) — this plan is sequenced strictly *behind* #461
and rebases on it, so status visuals and label vocabulary never land in one
diff. #455 owns failure *copy mapping* for subagent budgets (PM ruling
2026-07-30) and is unaffected: this plan changes the activity vocabulary, not
error text. #458 (scroll/follow), #460 (subagent transcript), #457/#459 (plans)
do not touch this surface.

No infrastructure-ownership files. PR 2 populates and reads
`CommandExecutionThreadItem.commandActions`, but that field is **already
declared** (`protocol.ts:841-850`) **and already decoded**
(`decodeCommandAction`, `codec.ts:3245-3252`, with
`exactKeys(['kind', 'command', 'path', 'query'])`) — only its producer and its
consumer are missing. So PR 2 changes no protocol shape and needs no
interface-only PR: it is a main-process producer plus a renderer consumer on
surface that already exists.

## Current defects (evidence)

From a real run (`node_read` → `file_glob` ×3 → `file_read` → `python3` ×3 →
`file_read` groups), against `main` at `3d44f0f1`:

- **V1 — Single rows print the model's tool identifier.** `dynamicToolCall` and
  `mcpToolCall` rows go through `namedToolSummary`
  (`ThreadItemView.tsx:895-903`), which formats
  `[namespace, tool].join('.')` — so the user reads **"Used node_read"**,
  **"Used file_glob"**, **"Used file_read"**. The row names the API, not the act.
- **V2 — The human vocabulary already exists and is simply not reached.** The
  *group* path maps the same items through `dynamicToolActivityKind`
  (`:1092-1113`) onto 18 activity kinds and 36 already-translated phrases
  (`en.ts:1197-1256`) — "Read 3 files", "Searched files". Single rows and groups
  therefore speak two different languages about identical work. This is one
  fallback, not a missing feature.
- **V3 — Subjects are collected and then discarded.** `summarizeThreadToolActivity`
  fills `bucket.subjects` with real file paths and node ids
  (`dynamicToolSubjects`, `:1115-1131`) and then reports only `subjects.size`
  (`:1049-1053`) — hence **"Read 3 files"** with no indication of *which*, the
  row the PM flagged. The data for "Read intro.xhtml, ch01.xhtml and 1 more" is
  already in hand.
- **V4 — Search tools carry no subject at all.** `file_glob` / `file_grep` take
  a `pattern` argument (`agentLocalTools.ts:536-550`), but `dynamicToolSubjects`
  has no branch for them, so they fall back to `item.id` and count as one
  anonymous subject. Three consecutive globs read as "Searched files" three
  times with nothing to distinguish them.
- **V5 — `skill`, `web_fetch`, and MCP rows lose their one identifying
  argument.** Same cause as V4: no subject branch, so a skill invocation reads
  "Used a skill" rather than naming the skill.
- **V10 — Failure has six different idioms.** `Command failed · "x"`,
  `Failed to change 2 files`, `x failed`, `Web search failed · "q"` — one per
  kind, so a scanning user re-learns the pattern per tool and never sees what a
  failed call was *trying* to do.
- **V11 — Collaboration rows leak their identifiers too.** `collabAgentToolCall`
  goes through the same `namedToolSummary`, so the transcript reads `Used
  spawn_agent` / `Used wait_agent`. Unlike MCP this is a **closed set** of six
  tools, so there is no excuse for the identifier.
- **V12 — `web_fetch` is described as a web search.** Both `web_fetch` and
  `web_search` map to the single `web` kind, so fetching a page renders
  "Searched the web for https://…".
- **V13 — `node_create` would name the wrong thing.** Its only id-shaped
  argument is `parent_id`; naming it would claim the parent was created.
- **V6 — Command rows show shell plumbing.** `summarizeThreadToolItem` quotes
  `firstLine(item.command)` (`:864-871`), so a heredoc becomes **`Ran "python3 -
  <<'PY'"`** — the first line of a heredoc is pure syntax, and three different
  scripts render identically. A `cd X && real-work` chain surfaces the `cd`.
- **V7 — Long commands truncate at the wrong end.** `quoteSubject` cuts at 72
  characters (`:1370-1373`), so **`Ran "cd /Users/lixiaobo/.lin-outliner-codex-3/age…"`**
  spends the whole budget on an absolute path prefix and drops the operative
  command. Paths are never shortened (no `~`, no basename).
- **V8 — A homogeneous group wears a generic wrench.** `ThreadToolActivityGroup`
  always passes `GenericToolIcon` (`:249`), so a group of six file reads shows a
  wrench next to "Read 6 files" while every individual read row shows the
  file-read glyph.
- **V9 — Counts are subject counts, described as tool counts.** `fileChange`
  contributes one subject per changed path and `dynamicToolCall` one per
  argument path, so "Read 6 files" can come from two calls — defensible, but the
  group's own tooltip and the process divider reuse the same string with no way
  to tell six calls from six files.

## Design

### PR 1 — one vocabulary, with subjects

- `summarizeThreadToolItem` routes `dynamicToolCall` (and `mcpToolCall` where an
  identity maps) through the **same** `ToolActivityKind` derivation the group
  path uses, so a single row and a group of one are worded from one source.
  `namedToolSummary` survives only as the genuine fallback: an unmapped MCP or
  plugin tool, where the tool's name really is the most informative thing known.
- A per-kind **subject phrase** replaces the bare count where a subject exists:
  the activity vocabulary gains a subject-bearing variant per kind
  (`readFile({name})` beside `readFiles({count})`). Display names are
  basenames, not paths; nodes use their title through the existing
  `DocumentIndex`, falling back to the id.
- `dynamicToolSubjects` gains branches for the arguments V4/V5 identified —
  `pattern` (glob/grep), `url` (web_fetch), `query` (web_search), the skill
  identity — so those rows and groups can name themselves.
- Group summaries name up to **two** subjects and then elide ("Read
  intro.xhtml, ch01.xhtml and 4 more"), the full list staying in the existing
  `title` (PM-ratified, 2026-07-30). A one-subject group degrades naturally to
  the single-row wording, which is what makes single rows and groups one
  vocabulary rather than two.
- Node subjects display their **title** through the existing
  `threadNodeReferenceDisplayLabel` helper, falling back to the id — the same
  resolution user-message node references already use, so the transcript stays
  internally consistent. This does mean the label reflects the node's current
  title rather than its title at call time; that is the established behaviour
  for node references and is preferable to showing a UUID.
- `ThreadToolActivityGroup` passes the group's own kind glyph when every member
  shares one kind, and `GenericToolIcon` only for genuinely mixed groups (V8).
- One failure idiom replaces the six per-kind phrasings (V10): the act, then
  the outcome as an annotation (`Read intro.xhtml · failed`). This *deletes*
  eight i18n keys and adds two.
- The six collaboration tools get real copy (V11) — "Started an agent", "Waited
  for an agent" — since the set is closed.
- `web_fetch` splits out of the `web` kind into its own "Fetched …" family
  (V12), and `node_create` names nothing rather than naming its parent (V13).
- A single `fileChange` names its paths too ("Changed a.ts, b.ts and 1 more"),
  since the subjects were equally available there.
- Where a subject phrase would be ungrammatical past one item — "Used the
  dataviz, run skill" — the summary falls back to counting.
- Every new phrase lands in `en.ts` + `zh-Hans.ts` in the same change, and the
  whole matrix is pinned by an exhaustive copy table
  (`tests/renderer/threadToolCopy.test.ts`) so a wording change is reviewed as a
  diff of that table rather than found in a transcript.

### PR 2 — command legibility

The PM ratified "the layer that ran the command reports what it did, instead of
the renderer guessing from shell syntax" (2026-07-30), choosing `commandActions`
as the vehicle. Implementation found a **better source for the same principle**,
and took it:

- **The caller already writes the sentence.** The `bash` tool's contract asks
  for a "clear, concise description of what this command does in active voice"
  (`agentLocalTools.ts:602-610`), and `normalizeBashParams` already validates it
  (`:1548`). It was then dropped on the floor —
  `PiTurnExecutor.ts:870-886` built the Item from the same `args` and never read
  `description`. This beats `commandActions` on the plan's own terms: it is the
  author's statement of intent, not a classification reconstructed from the
  command string, and `interpretCommandResult` could never have distinguished
  three `python3 - <<'PY'` heredocs at all.
- **Protocol.** `CommandExecutionThreadItem` gains
  `description: string | null`, decoded with `record.description ?? null` so
  Threads persisted before the field decode with `null` instead of failing —
  additive, no dev-data wipe. `commandActions` stays as it was; this plan does
  not fill it, and a later pass may retire it.
- **Consumer.** The description is the row's label when present; the shell text
  stays one expand away in Arguments.
- **Fallback**, since `description` is optional in the schema: the command text
  with the parts that are provably not the point removed — a heredoc body, a
  leading `cd X &&`, the Thread working-directory prefix. It does not attempt to
  understand the command (V6/V7).

## Open questions

None blocking. The PM ratified caller-reported command legibility (not
renderer-side shell heuristics) and the two-subjects-then-elide summary shape on
2026-07-30. Node-subject titling is a decided local, following the existing
node-reference precedent.

One thing to watch after this ships: `description` is **optional** in the `bash`
schema, so how often rows actually get it is a live-run question, not a
static one. The tool description already instructs the caller to supply it and
the fallback is now decent either way; if real runs show it frequently missing,
the cheap next move is making it `required` in `BASH_PARAMETERS` rather than
reviving shell parsing. `commandActions` remains declared, decoded, and unused —
a later pass should either fill it or retire it, but nothing depends on it now.
