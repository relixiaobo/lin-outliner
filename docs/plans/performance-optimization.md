---
status: in-progress
priority: P0
owner: relixiaobo
created: 2026-06-04
updated: 2026-06-04
---

# Performance Optimization Program

Scope: the document data flow across the `core → IPC → renderer` seam, the
outliner render path, the agent streaming/transcript path, and main-process
persistence/IO. This is a **catalog + roadmap**, not a single change: it grades
every known performance finding by priority so the items can be sequenced into
separate PRs (the keystone, P1, is large enough to grow its own detailed plan).

Findings were produced by a three-way audit — a four-area read-only sweep, a
second independent review (Codex), and direct `file:line` verification of every
contested or high-stakes claim — plus the existing probes
(`renderProbe.ts`/`measureRenderIndex`, `probe-text-search-index`). Where the
three sources converged independently, the item is marked **(3×)**.

## Goal

Make per-edit and per-streamed-frame cost scale with the size of the **change**,
not the size of the **whole document / whole transcript / whole history**. Today
a single-character edit pays O(N) in several places at once (N = node count);
a single streamed token pays O(transcript) plus a full index-file rewrite.

Concretely, in priority order:

1. Remove the cheapest, zero-risk write amplification immediately (P0).
2. Land an **incremental projection** protocol so the renderer ingests a node
   delta instead of re-deriving "what changed" from a full projection (P1 — the
   keystone; it unlocks a whole class of P3 memo wins at once).
3. Default the outliner to the windowed/flat renderer; make the agent streaming
   path emit deltas (P2).
4. Incrementalize the remaining localized O(N) scans (P3 — several become
   no-ops once P1 lands).

## Non-goals

- No rewrite of the Loro CRDT model or the command/event-sourcing contract — the
  apply path is already incremental (state cache, projection cache, inverted
  text index, event-log checkpoints all verified incremental).
- No new persistence engine in this program. SQLite-ifying the agent event
  search index is noted as a P3 *option*, not a commitment.
- Not chasing micro-allocations where the probe shows headroom: incremental text
  search measured fine (10k corpus: single upsert 0.56 ms, edit+search 4.6 ms).
  Search is **not** the bottleneck; projection diff + virtualization are.

## Priority tiers

| Tier | Meaning | Lane | Gate |
|------|---------|------|------|
| **P0** | Quick win: low risk, no protocol change, do now | fast-track | `/code-review` (medium) |
| **P1** | Keystone: highest leverage, touches the `core↔renderer` protocol | plan-track | shared-interface-first + `/code-review ultra` |
| **P2** | Structural: changes a render/streaming path, user-visible behavior | plan-track | `/code-review` + visual verify (light/dark) |
| **P3** | Localized O(N) cleanup; several are unlocked/trivialized by P1 | fast-track each | `/code-review` (medium) |

Severity = impact at scale. Effort = rough build size. "Unlocked by P1" means the
fix is mostly free once stable per-node identity exists in the renderer.

---

## The cross-cutting insight (why P1 is the keystone)

The renderer is full of `useMemo` / `React.memo` keyed off `index.byId` (or
`projection`). But `byId` is **reborn as a fresh `Map` on every keystroke**
(`document.ts:37` `new Map(projection.nodes.map(...))`), because the projection
is structure-cloned across IPC and every node object is a fresh reference. So
those memos only de-dupe *within one projection version* (across UI-state
re-renders) — they **cannot de-dupe across keystrokes**.

This single fact explains a cluster of "full O(N) per keystroke" findings that
look independent but share one root: `dateNoteCounts` (`NodePanel.tsx:292`),
`resolveBacklinks` behind the memoized References display (`systemFields.ts:102`
via `OutlinerFieldRow.tsx:197`), `referenceCandidates` (`referenceCandidates.ts:139`),
and the `renderRev` signature/reverse-edge passes themselves. Give the renderer a
**delta** with stable identity for unchanged nodes (P1) and this entire cluster
collapses at once, instead of being optimized one memo at a time.

---

## P0 — Quick wins (do now, fast-track)

| ID | Finding | Location | Trigger | Fix |
|----|---------|----------|---------|-----|
| P0-1 | Agent session/search index **fully rewritten per streamed token** (read + `JSON.parse` + pretty-print + atomic write of the whole file) | `agentEventStore.ts:139-140` (`updateSessionIndex`/`updateSearchIndex` in `appendEvents`), called per `assistant_message.delta` (`agentRuntime.ts:2257-2273`); whole-file write at `:558`,`:573` | every streamed token batch (~tens/sec); scales O(all messages ever) | Indexes are derived caches: update only at durable message boundaries (`assistant_message.completed`, `user_message.created`, `tool_result.*`) or debounce; the `events.jsonl` append is the source of truth and stays per-delta. **(3×)** |
| P0-2 | Pretty-printed (`JSON.stringify(x, null, 2)`) full-document/state writes | doc snapshot `core.ts:232`; agent indexes `agentEventStore.ts:558,573` | every save / every index update | Drop `null, 2` everywhere — these are machine-read files. One-line, zero-risk. |

Both are surgical, no behavior change, no protocol change. P0-1 is the fastest-firing offender in the codebase; P0-2 roughly halves the bytes written on every save.

> **Status: shipped** in PR #117 (`cc/perf-p0-write-amplification`, merged `d29f110`) —
> P0-1 skips the index rewrite for delta-only batches; P0-2 drops `null, 2` from the doc
> snapshot + both agent indexes.

---

## P1 — Incremental projection protocol (the keystone)

**Problem.** Every committed mutation rebuilds and ships the **entire**
projection over IPC, and the renderer re-derives the change set from scratch:

- `assembleProjection` rebuilds the full `nodes` array — `projection.ts:46`,
  via `core.projection()` `core.ts:242`, emitted on every mutation at
  `documentService.ts:723` → `webContents.send` `main.ts:133`. The whole array
  is structure-cloned across the process boundary. **O(N) CPU + O(N) clone per
  edit.** **(3×)**
- Renderer rebuilds the whole `byId` Map (`document.ts:37`), then
  `JSON.stringify`s **every node** to diff signatures (`renderRev.ts:22`), then
  rebuilds three full reverse-edge maps (`renderRev.ts:50-68`). **Three O(N)
  full-document passes per keystroke.** **(3×)**

The irony: core already computes exactly the change set the renderer is paying
O(N) to rediscover — `revisionDelta().changedNodeIds` (`core.ts:269-275`),
backed by the per-node projection cache (`core.ts:292-316`,
`projectionNodesFor`).

**Design direction.**

1. Define a delta projection envelope on the protocol surface (this is the
   coordinated change — `src/core/types.ts`, `projection.ts`, the IPC document
   event): `{ revision, changedNodes: NodeProjection[], removedIds: NodeId[] }`.
   The full projection remains for init / restore / full rebuild only.
2. `documentService.emitProjectionChanged` sends the delta built from
   `changedNodeIds` (+ removed) instead of `core.projection()`.
3. Renderer `useRenderIndex` (`document.ts:53`) applies the delta in place:
   patch `byId` for changed/removed ids, **preserve references for unchanged
   nodes**, and bump `renderRev` directly from the delta's changed set + the
   reverse-edge closure — deleting the whole-document `JSON.stringify` signature
   pass (`renderRev.ts:20-24`) and incrementalizing `buildReverseEdges`
   (maintain the edge maps across renders, patch only changed nodes).

**Why first among the big items.** It is the only fix that (a) attacks the
per-keystroke hot path directly, and (b) makes the P3 memo cluster effective for
free (see the cross-cutting insight). It is also the only item that touches the
protocol surface, so per `AGENTS.md` it lands as a **human-led interface-only PR
first**, then the renderer builds on top.

**Risks.** Delta correctness on structural moves (a node's parent changes →
both old and new parent must be in `changedNodes`); undo/redo/revert/import must
still force a full projection; reference/tag/inline-ref reverse edges must be
patched, not just direct fields. Guard with the existing `renderRev.test.ts`
plus new delta-application tests; keep a full-projection fallback path.

**Subsumes:** renderer H1/H2/H3, core H2/H3, Codex #1/#3.

---

## P2 — Structural (render & streaming paths)

### P2-1 — Default the windowed/flat outliner renderer **(3×)**

The default path is the recursive `OutlinerView → OutlinerItem → nested
OutlinerView`, which **mounts every expanded node** (full `RichTextEditor` +
effects + interaction hook). The windowed renderer exists
(`OutlinerFlatView.tsx`, `VIRTUALIZE_MIN_ROWS = 60`) but is gated off behind
`localStorage('lin:flat-outliner') === '1'` (`OutlinerFlatView.tsx:35,41`),
selected in `NodePanel.tsx:795`. Per-row `React.memo` keeps *re-renders* cheap,
but mount cost, DOM size, and memory scale with **total expanded rows**, not the
viewport — the main scaling cliff for large docs (load/expand/scroll).

- Fix: verify parity, then make flat/virtual the default; keep the recursive
  path as a debug fallback flag.
- Bonus: with flat-view, rows are built once in a single `useMemo`, which
  retires P3-1 (`OutlinerView`/`OutlinerFieldRow` not memoized →
  `buildOutlinerRows` re-runs per subtree per keystroke, `OutlinerView.tsx:49`).
- Watch when enabling: `FlatRowShell` measures each windowed row via
  `getBoundingClientRect().height` + a `ResizeObserver`, and a height correction
  adjusts `scrollTop` synchronously in a `useLayoutEffect` (`OutlinerFlatView.tsx:165-174,320-340`)
  — a potential layout-thrash source under fast scroll once this is the live
  path. Mitigate by batching measurements / using `ResizeObserver` `borderBoxSize`
  instead of a sync rect read.
- Severity: high · Effort: medium (mostly parity verification) · Risk: medium
  (behavioral — needs light/dark visual verify + keyboard-nav/scroll parity).

### P2-2 — Agent streaming: emit a delta, memoize transcript rows

Two coupled costs make a streamed turn O(transcript) **per frame** (≈60/s):

- Main rebuilds the **entire** agent render projection every 16 ms coalesce tick
  (`agentRuntime.ts:1664` → `buildAgentRenderProjection` over all messages),
  then structure-clones it over IPC. **(3×, Codex #9)**
- Renderer `runtime.ts:791-841` `publish→buildView` rebuilds every entry/message
  with **fresh identities** each frame (`buildToolResultMap`, `buildEntries`,
  `new Set(...)`, `sessionCost`), defeating downstream memo; and
  `AgentMessageRow`/`AgentTranscriptRowShell` are **not** `memo`'d
  (`AgentMessageRow.tsx:352`), so the whole visible transcript re-renders.
- Streaming markdown re-runs `remend` + `marked` `Lexer.lex` over the **full
  accumulated tail text** each frame → O(n²) over a message
  (`AgentMarkdown.tsx:274-284`, `:48-56`). **Note:** finished/non-tail blocks are
  **already** memoized (`MemoizedMarkdownBlock`, `:243`), and `remend` is already
  wrapped in `useMemo` — so the fix is to throttle/incrementalize the live-tail
  reparse, **not** to re-add block-level memo (which exists).
- Auto-scroll `useLayoutEffect` reads `scrollHeight` (forced reflow) every frame
  via the per-frame `revision` dep (`AgentChatPanel.tsx:659-662`).

Fix direction: stream a **delta for the single active message** (append/patch a
message store) rather than re-emitting the whole projection; structurally reuse
unchanged entries so identities are stable; then `memo` the transcript rows;
throttle the live-tail markdown reparse; coalesce auto-scroll into one rAF and
drop `revision` from its deps.

- Severity: high (streaming UX) · Effort: medium-large · Risk: low-medium.

### P2-3 — Debounce/coalesce structural-mutation saves

Text edits are already debounced into a 700 ms undo group before save
(`documentService.ts:67,262-284`), but **structural** mutations
(create/move/indent/toggle/tag/field) each call `saveCore` immediately
(`documentService.ts:212`), and `serializeState` exports the **whole Loro
snapshot incl. history** → base64 → stringify each time (`core.ts:227-232`,
`loroDocument.ts:153`). A burst of structural edits writes once per edit.

- Fix: coalesce/debounce `saveCore` for structural mutations like text edits;
  consider Loro incremental `export({ mode: 'update' })` + periodic snapshot
  compaction so the per-save cost is O(change), not O(doc + full history).
- Severity: medium-high · Effort: medium · Risk: medium (durability/crash-safety
  — keep the mutation queue + before-quit flush; tune the debounce window).

---

## P3 — Localized O(N) cleanups

Grouped by what they touch. Items marked **↑P1** become no-ops or trivial once
the incremental projection lands (stable `byId` identity makes their memo hold
across keystrokes); they are listed so nothing is lost, but should be revisited
*after* P1 rather than fixed pre-emptively.

### Renderer input / display hot paths

| ID | Finding | Location | Note |
|----|---------|----------|------|
| P3-1 | `OutlinerView`/`OutlinerFieldRow` not memoized → `buildOutlinerRows` (filter/sort/group, recursive `childText`) re-runs per subtree per keystroke | `OutlinerView.tsx:49`, `OutlinerFieldRow.tsx:107`, `outlinerRows.ts:153,327,412` | retired by **P2-1**; else add memo + cache field-value primitives per build (Codex #4/#5) |
| P3-2 | References display re-runs an O(N) backlink scan every keystroke (memo keyed on per-frame `byId`) | `systemFields.ts:102` via `OutlinerFieldRow.tsx:197` | **↑P1**; deeper fix: maintain a reverse-reference index (target→referrers) |
| P3-3 | `@`/reference & field picker filter+map+rank+sort the **whole** projection per keystroke, with per-candidate ancestor walks | `referenceCandidates.ts:139`, `useFieldNameReuse.ts:57` | reuse the main-process text index or a renderer-side label/fieldDef index (Codex #6) |
| P3-4 | Day-page note counts scan all of `byId`, memo dep `byId` reborn each keystroke | `NodePanel.tsx:292` | **↑P1**; or move counts into projection metadata / incremental date index (Codex #7) |
| P3-5 | `index` object identity changes every keystroke → unmemoized siblings (`Sidebar`, `AgentDock`, `CommandPalette`) re-render | `App.tsx:51` (consumers `:337`/`:374`/`:405`) | memo heavy consumers against the slice they use |
| P3-6 | `AgentDebugPanel` fires 3 IPC round-trips per streamed frame while open | `AgentDebugPanel.tsx:239-292` | dev-only; throttle/skip-in-flight |
| P3-21 | A code block being edited re-highlights the **whole block** through Shiki on every keystroke (unthrottled; correctly cancellable + plain fallback, so non-blocking) | `CodeBlockRow.tsx:101-105`, `AgentMarkdown.tsx:48-56`, `AgentToolCallBlock.tsx:392-396` | debounce re-highlight while typing in large blocks; low until big blocks feel laggy |

### Core scans (reverse-index candidates)

| ID | Finding | Location | Note |
|----|---------|----------|------|
| P3-7 | `removeSubtreeDirect` clones + double-`JSON.stringify`s every node per delete; `collectSubtreeAndDependentReferences` `while(changed)` re-scans all nodes → O(removed × N) | `core.ts:2749-2763`, `:3145-3168` | reverse-reference index so cleanup touches only real referrers |
| P3-8 | `backlinks` / `hasExternalReferencesToTarget` full-node scans with per-node ancestor walks | `core.ts:1911-1924`, `:3186-3197` | same reverse-reference index |
| P3-9 | O(N) tag/field-def lookups by name on create/apply | `core.ts:3771-3801` (`findTagByName`, `findFieldDefByName`, `findNodesWithTag`, `nextTagColor`) | name→id index for the small schema set |
| P3-10 | `materializeState()` shallow-spreads all N nodes; 122 `snapshot()` call sites, ≥2 per command | `loroDocument.ts:346-352`, `core.ts` (122×) | stable cached container ref invalidated on patch; hoist repeated `snapshot()` per command |

### Search / agent history (scale with corpus, not per-keystroke)

| ID | Finding | Location | Note |
|----|---------|----------|------|
| P3-11 | Structured search rebuilds a full-doc node `Map` per call **and** clones it again | `searchEngine.ts:399-409`, `:222` | cache `SearchIndex` keyed by `core.revision()`; drop defensive clone |
| P3-12 | Search candidate filtering does two ancestor walks + fresh `Set` per candidate | `searchEngine.ts:1640-1689` | precompute `inTrash`/condition flags in one tree walk at index build |
| P3-13 | Incremental text-search refresh clones the whole node `Map` | `documentService.ts:592` | mutate the changed ids in place |
| P3-22 | `materializeSearchNodeResultsDirect` inner `.find` over a node's children when reordering result refs | `core.ts:2254-2257` | bounded to one search node's children on explicit refresh; index children by id if it shows up. Low |
| P3-14 | Agent search index **cold rebuild** replays all events of all sessions; can land inside a streaming append | `agentEventStore.ts:452-461` | background/lazy rebuild, schema-version migration; **probe: 838 ms / 553 MB heap** at scale (Codex) — startup pressure as history grows |
| P3-15 | `cloneReplayState` deep-clones full session via `JSON.parse(JSON.stringify(...))` per checkpoint | `agentEventStore.ts:938-940` | use `structuredClone()` |
| P3-16 | `pruneCheckpoints` reads + parses every checkpoint file to decide deletions | `agentEventStore.ts:494-530` | prune by filename seq (`parseCheckpointSeq`) without reading contents |

### Main-process IO / bundle

| ID | Finding | Location | Note |
|----|---------|----------|------|
| P3-17 | Local file-search fallback spawns `rg --files --hidden` over the **entire home dir** | `main.ts:1336-1350` (`rgFileNameMatches`) | fires only when Spotlight misses; debounce + limit roots + cache (Codex #11) |
| P3-18 | Asset lookup `readdir`s the dir to find a file; serve `readFile`s the whole file | `assetService.ts:99,121` | `assetId→filename` metadata map; stream/range for large media (Codex #10) |
| P3-19 | Shiki statically imports the full `bundledLanguages` registry (~235 **lazy** import thunks — grammars are already code-split, loaded on demand) | `shikiHighlighter.ts:1-8` | cost is registry wiring/parse + bundle size, **not** eager grammar load; `shiki/core` + explicit ~23-language set trims that. Benefit is bundle/init, modest. Highlighter is already a cached singleton — good |
| P3-20 | Tokenizer double-normalizes (`normalizeSearchText` re-run after analyze) | `textSearchAnalyzer.ts:97` | accept a pre-normalized flag (low) |

---

## Verified-good (do not touch — confirmed not problems)

- Per-row `OutlinerItem` memo comparator is precise (`OutlinerItem.tsx:2009-2039`,
  `renderRev` + `rowUiState`); untouched rows correctly skip re-render.
- Core apply path is incremental: Loro state cache (`loroDocument.ts:354-369`),
  projection cache (`core.ts:292-316`), operation journal capped at 500 with
  `affectedNodeIds` (no O(N) fallback), agent event-log checkpoint replay.
- Inverted text-search index (BM25, incremental upsert/remove); module-level
  cached regexes/segmenter. Probe confirms incremental search is fine.
- ProseMirror editors are created once and reused (`RichTextEditor.tsx:351`,
  `AgentComposerEditor.tsx:506`); Shiki highlighter is a cached singleton with
  lazy per-language loading.
- No `ipcRenderer.sendSync` on the renderer hot path; startup does not block on
  the large workspace file (window paints first, `init_workspace` is async); only
  timer is a dev-only `unref`'d watchdog. (One deliberate seed `sendSync` exists
  in `src/preload/index.ts:109`, added by #110 for the language bootstrap —
  one-time, not hot.)

**Acknowledged and deliberately deferred** (confirmed, judged not worth a change
now — recorded so they are not "lost"):

- Synchronous `readFileSync` of tiny state files before first paint —
  `windowState.ts:25`, `appPreferences.ts:25` (geometry + theme). One-time, a
  few bytes, and the document load itself is async, so the window is not blocked.
  Acceptable as-is; revisit only if pre-paint cost ever matters.
- `RichTextEditor` rebuilds a `DecorationSet` per transaction
  (`RichTextEditor.tsx:357-370`); outliner rows are single-paragraph so the walk
  is O(1)-ish. Not a problem at current row shapes; noted for completeness.

---

## Suggested sequencing

1. **P0-1, P0-2** — land immediately (fast-track, one small PR). Biggest
   bang-per-line; unblocks nothing but stops the worst write amplification.
2. **P1** — interface-only PR for the delta projection envelope (PM-led, touches
   protocol), then the core emit change, then the renderer ingestion. Establish
   a baseline first (`measureRenderIndex` `index=` time at a known doc size) and
   re-measure after.
3. **P2-1** (default virtualization) and **P2-2** (streaming delta) in parallel —
   independent paths, different files.
4. **P3** — sweep after P1; start with the reverse-reference index (retires
   P3-2/P3-7/P3-8 together), then the search/agent-history items. Re-check the
   **↑P1** items first — several will already be gone.

## Open questions

- **Delta granularity (P1):** node-level patches vs field-level patches? Start
  node-level (simplest correct unit; matches the projection cache granularity).
- **Save coalescing window (P2-3):** reuse the 700 ms text window for structural
  edits, or a shorter one? Trade durability vs write volume — needs a call on
  acceptable data-loss-on-crash window (crash-safety is also covered by the
  before-quit flush + mutation queue).
- **Agent index storage (P3-14):** keep JSON-with-in-memory-cache, or move to
  SQLite once history is large? Decide on measured corpus growth, not now.
- **Ownership/coordination:** P1 touches `src/core/types.ts` + `projection.ts`
  (infrastructure-ownership files) — must be claimed and interface-first per
  `AGENTS.md`; the rest can fan out across dev clones once P1's interface lands.

## Checklist

- [x] P0-1 agent index update at message boundaries (or debounced) — shipped #117
- [x] P0-2 drop `null, 2` from doc snapshot + agent index writes — shipped #117
- [~] P1 delta projection envelope → core emit → renderer ingest; delete whole-doc signature pass — **PR-A shipped #119** (`ProjectionUpdate` union, `buildProjectionUpdate`, `reduceProjection` with stable unchanged-node identity, `nodeSignatures` pass deleted). PR-B (incrementalize reverse edges) still open — see `incremental-projection.md`
- [ ] P2-1 default flat/virtual outliner after parity verify (light/dark)
- [ ] P2-2 agent streaming delta + transcript row memo + tail-markdown throttle + rAF auto-scroll
- [ ] P2-3 coalesce structural-mutation saves; evaluate Loro incremental export
- [ ] P3 reverse-reference index (P3-2/7/8), render memo/lookup cleanups
      (P3-1/3/4/5/6/9/10), search index caching (P3-11/12/13/22),
      agent-history cold-rebuild/clone (P3-14/15/16), main IO (P3-17/18),
      Shiki langs + code-block re-highlight (P3-19/21), tokenizer (P3-20)
