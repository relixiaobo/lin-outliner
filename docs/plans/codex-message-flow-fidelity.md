# Codex message-flow fidelity

Raise our agent transcript to a **1:1 reproduction of the OpenAI Codex desktop
client's message-flow interaction**. Grounded in a read-only reverse-engineering
of that client, captured in `tmp/research/codex-client/MESSAGE-FLOW-GAP.md` (the
gap doc — the corrected, authoritative state machine; every claim cites the exact
Codex minified symbol / token / i18n string). **Read the gap doc first**; this
plan is the build design, the gap doc is the evidence.

## Why this supersedes the previous 4-gap design

The first version of this plan closed four *cosmetic* gaps (counted summary, live
ticker, "Thinking" shimmer, duration units) while listing the structurally
load-bearing behaviors as **Non-goals**. Testing showed the result is not 1:1 —
because the spine was the Non-goals, not the leaves. The corrected gap doc (§8)
shows Codex's flow is **one `typed-item stream → render-group splitter → three
independent collapse state machines`, with the `worked-for` item as the
structural fold line.** PR #311 built the leaves onto our legacy per-message block
renderer, without that substrate; the leaves can't read right without the trunk.
This plan rebuilds the trunk.

## Goal

Render an assistant turn the way Codex does:

- a turn is a **flat typed render-unit stream** run through a **render-group
  splitter** (the 6 groupable unit types; `assistant-message` is a hard boundary;
  `reasoning` breaks a tool run; single `mcp`/`exec` units don't fold);
- consecutive tool activity folds into ONE **counted, kind-named, tense-aware,
  Set-deduped** summary group (gap doc §3);
- the **turn body auto-collapses to a one-line `worked-for` divider the moment the
  final answer starts streaming**, expandable + persisted (gap doc §4);
- per-item state is faithful: **4-state steps** (running / done-green /
  failed-red / pending-dim), **reasoning "Thinking" → "Thought for {elapsed}"**,
  the **default active cue is a static label** (the shimmer is a Codex A/B
  experiment, not the default), durations roll up to days (gap doc §2, §5, §6, §7).

## Non-goals

- **Codex's visual *design language*** (its exact colors, type scale, blob
  gradients). We match the *interaction logic and states*; the skin stays our
  ratified design system (B-rules). 1:1 here = behavioral, not pixel.
- **`STEPS_PROSE` / `STEPS_COMMANDS` user detail-mode toggle** (gap doc §3d) — ship
  a single default mode (≈ `STEPS_COMMANDS`); revisit only if the PM wants the
  setting. Low fidelity cost.
- **Measured-line long-text fold** (`use-measured-text-collapse`, gap doc §9) —
  nice-to-have; not in this set unless a PR comes in cheap.
- **Steering / hook-feedback "pinned-through-collapse" rows** — we have no steering
  entity; the `persistentEntries` bucket is just the final answer for us.
- **No new `src/core` document commands or stored conversation kinds.** The
  render-unit stream and grouping are **renderer-side view-model derivation** from
  the existing agent event-replay state; per-turn collapse is renderer UI state.
  (If timing/`worked-for` needs a core signal, that is an isolated protocol PR
  decided first — see Open questions.)

## Shape

**A SET of independent, complete features — ordered ONLY by genuine dependency**,
each its own PR, each shippable and reviewable alone (no "scaffold now, useful
later" slices). Foundation first (A7). PR-1 is the substrate + the first visible
capability; PR-2 and PR-3 consume it.

```
PR-1  render-group substrate + counted tool-activity group   (foundation + visible)
PR-2  per-turn auto-collapse + worked-for divider entity      (depends on PR-1 stream)
PR-3  per-item state fidelity: reasoning lifecycle, active cue,
      4-state step, duration/anchor                            (depends on PR-1 unit model)
```

#311's i18n tense family, `toolActivityKind` map, and `formatRunDuration` rollup
are **salvageable inputs** to PR-1/PR-3 — see "Disposition of #311".

---

## PR-1 — Render-group substrate + counted tool-activity group

The foundation: replace the ad-hoc "consecutive `toolCall`" grouping with a real
typed-unit stream + splitter, and render a faithful counted summary group.

### 1a. Render-unit model (renderer view-model)

In the renderer projection layer (`src/renderer/agent/runtime.ts` /
`agentRenderProjection.ts`), derive per assistant turn a normalized unit list
(gap doc §1, `Re`):

```ts
type RenderUnitKind =
  | 'exploration' | 'patch' | 'exec' | 'mcpToolCall'
  | 'approvalReview' | 'webSearch' | 'assistantMessage' | 'other';
// 'other' = reasoning, todo, plan, generated-image, worked-for, notices, …
```

`exec` units carry a parsed sub-kind `{ read | search | listFiles | unknown }`
derived from the tool call (gap doc §1) so a shell/read call can summarize as
"Read N files" / "Searched code" / "Listed files", not "Ran N commands".

### 1b. Splitter (pure, unit-tested) — mirror `split-items-into-render-groups`

```ts
type RenderGroup =
  | { kind: 'unit'; unit: RenderUnit }
  | { kind: 'toolActivity'; id: string; members: RenderUnit[]; summary: ToolActivitySummary };

export function splitIntoRenderGroups(units: RenderUnit[], mode: DetailMode): RenderGroup[];
```

Rules (gap doc §3a):
- A tool-activity run = maximal consecutive units in
  `{exploration, patch, exec, mcpToolCall, approvalReview, webSearch}`.
- `assistantMessage` and `other` (incl. **reasoning**) **break** the run.
- A lone `mcpToolCall`, or (non-prose) a non-current lone `exec`, passes through
  as its own `unit` group (no redundant wrapper).
- Each run ≥ the fold threshold becomes one `toolActivity` group with a `summary`.

### 1c. Counted summary accumulator (pure, unit-tested) — mirror `Ft`/`It`/`Lt`

```ts
interface ToolActivitySummary {
  commandCount: number; createdFileCount: number; editedFileCount: number;
  deletedFileCount: number; exploredFileCount: number; loadedToolCount: number;
  searchCount: number; listCount: number; mcpToolCallCount: number;
  webSearchCount: number; deniedRequestCount: number; timedOutRequestCount: number;
  changedLineCount: number;
  mcpToolCallSources: Array<{ name: string; count: number }>;
  running: boolean;           // any member still running → present-continuous tense
}
```

- Counts use **`Set<string>` over paths** so duplicate file paths dedupe (gap doc
  §3b) — not a naive length.
- `running` is **per-member** (`getToolCallStatus(..., outcome)` — reuse the
  `outcome` signal from the merged `fix/tool-call-spinner-stuck`), so a
  settled-but-resultless member counts done. This kills the current
  `agentProcessSummary.ts:39` group-global "Running…" mislabel.

### 1d. Summary copy — the full tense matrix (i18n)

Add under `agent.process.toolActivity` in `en.ts` + `zh-Hans.ts` + `types.ts`.
Each kind needs **running + done** forms, pluralized; leading (Title) vs joined
(lowercase) handled by the composer, not duplicated keys (gap doc §3c):

```
command:   Ran # commands     / Running # commands
fileCreate Created # files    / Creating # files
fileEdit   Edited # files     / Editing # files
fileDelete Deleted # files    / Deleting # files
read       Read # files       / Reading # files
search     Searched code      / Searching code
list       Listed files       / Listing files
web        Searched the web   / Searching the web
mcp        Called # tools     / Calling # tools     (+ per-source "Used {name}")
loaded     Loaded # tools     / Loading # tools
denied     Denied # requests
timedOut   # requests timed out
```

Compose: single-kind run → that phrase; mixed → per-kind fragments joined by
" · " (first capitalized, rest `toLowerCase()`); `changedLineCount>0` appends
" • N lines" for patch runs. **Drop** the `other`-collapses-whole-group behavior
(current `agentProcessSummary.ts:34`) — an unmapped tool contributes a generic
"called a tool" fragment, it does not blank the whole summary.

### 1e. Group component

`AgentToolActivityGroup.tsx`: a disclosure (reuse the existing toggle affordance /
`ButtonControl` + chevron, B6/B10) whose header is the composed summary (running
tense while any member runs) and whose expanded body renders the member rows via
the existing `AgentToolCallBlock`. Collapse state keyed by `activity:${firstId}`
(machine B, gap doc §3) — independent of the turn-body collapse (machine C, PR-2).

**Complete on its own:** PR-1 changes tool activity to render as faithful counted
groups with correct tense and dedup, expandable to rows. Reviewable without PR-2/3.

---

## PR-2 — Per-turn auto-collapse + `worked-for` divider entity

The spine. Reverses the two former Non-goals (auto-collapse-on-answer-start; the
divider entity) — **PM-ratified 2026-06-20** (full rebuild to 1:1).

### 2a. Per-turn collapse state (machine C, gap doc §4a)

A renderer-side per-turn collapse store keyed by turn id (persist across reloads —
mirror Codex `collapsedTurnsById`; decide store: existing renderer persisted UI
state, NOT core document state):

```ts
shouldAllowCollapse = hasFinalAssistantStarted && !turnCancelled && hasRenderableActivity
isCollapsed = persistedChoice ?? !preventAutoCollapse   // default collapsed once answer starts
```

`hasFinalAssistantStarted` = the turn's first `assistantMessage` unit has begun
streaming. `preventAutoCollapse` = a live tool still running (our analog of
Codex's active-MCP guard). A user toggle writes `persistedChoice` and always wins.
Cancelled/interrupted turns never auto-collapse.

### 2b. The `worked-for` divider unit (gap doc §4b–c)

Synthesize a `worked-for` render unit at the **end of the activity, immediately
before the final answer** (partition analog of Codex `LO`/`BO`:
`{collapsibleEntries, persistentEntries, workedForItem}`). It carries
`{ status: 'working'|'sealed', startedAtMs, completedAtMs }` from the turn's run
timing.

Three live states, ticking 1s while working (`elapsedMs = (completedAtMs ?? now) -
startedAtMs` — **anchored on run start, NOT `message.timestamp`**, fixing the
current "2d" bug):

```
working & <1s   → "Working"            (bare, no number)
working & ≥1s   → "Working for {time}" (live tick)
sealed          → "Worked for {time}"
```

### 2c. Collapsed header = the divider, 3-way fallback (gap doc §4c)

When the turn body is collapsed, the header IS a toggle button (chevron 0°↔90°)
rendering, in priority:

```
worked-for unit present → "Working for …" / "Worked for {time}"
else static duration     → "Worked for {time}"
else                     → "{N} previous messages"  (N = collapsed unit count)
```

Clicking toggles + persists; expanding reveals `collapsibleEntries`. New i18n:
`workingFor`, `working`, `workedFor`, `previousMessagesSummary`.

**Complete on its own:** the turn collapses to one divider line on answer-start,
expandable. This is the single most visible Codex gesture.

---

## PR-3 — Per-item state fidelity

Per-item visual/textual states. May split into 3a/3b at review if large; each part
is independently complete.

### 3a. Reasoning lifecycle + active-cue correction (gap doc §5, §6)

- Reasoning: active → **"Thinking"** (static); sealed →
  **"Thought for {elapsed}"** / "Thought". Strip a leading `**gist**` line.
- **Correct the active cue:** the default is a **static label**, not a shimmer.
  The thinking phase shows **"Thinking"**, never "Working for 3s" (fixes the
  #311 live-collapsed divergence). Keep the shimmer ONLY behind an off-by-default
  flag (it is a Codex A/B experiment); the per-running-step spinner stays.

### 3b. 4-state step model + duration/anchor (gap doc §2, §7)

- `getToolCallStatus` gains a **4th `pending` (declared-but-not-started)** state
  ONLY if the projection cheaply distinguishes it from `running`; else defer and
  note in the PR (don't add core events for an icon). Visual: running ring / done
  **green** ring+check / failed **red** ring+✕ / pending **dim hollow** ring
  (mirror `progress-step-row`).
- `formatRunDuration`: roll up to **days**, keep all non-zero units
  (`1h 5m 3s`, `2d 3h`); unit-test boundaries (59s/60s/90s/3600s/3661s/86400s).

---

## Disposition of #311

#311 implements the superseded 4-gap design on the legacy substrate, with known
bugs (group-global tense `agentProcessSummary.ts:39`; `other` collapses the whole
group `:34`; `message.timestamp` anchor; shimmer-as-default; thinking phase shows
"Working for 3s"). **Recommendation: close #311 without merging**, salvaging its
i18n tense family, `toolActivityKind` map, and `formatRunDuration` rollup into
PR-1/PR-3. Merging it first would ship the wrong substrate and then immediately
rework it. (PM decision — see Open questions.)

## Files (indicative)

- `src/renderer/agent/runtime.ts` / `agentRenderProjection.ts` — render-unit
  stream, splitter, summary accumulator, worked-for synthesis, per-turn collapse
  derivation (PR-1, PR-2).
- `src/renderer/ui/agent/AgentToolActivityGroup.tsx` (new) — counted group (PR-1).
- `src/renderer/ui/agent/AgentProcessTimeline.tsx` / `AgentProcessBlock.tsx` /
  `AgentAssistantTurnContent.tsx` — consume groups, render the divider/collapse
  (PR-1, PR-2).
- `src/renderer/ui/agent/agentProcessSummary.ts` — rewrite per 1c/1d.
- `src/renderer/ui/agent/AgentToolCallBlock.tsx` — `toolActivityKind`, 4-state
  status, exec sub-kind (PR-1, PR-3).
- `src/renderer/ui/agent/agentProcessTypes.ts` — `formatRunDuration` rollup (PR-3).
- `src/core/i18n/messages/{en,zh-Hans}.ts` + `types.ts` — tense family, divider,
  reasoning copy.
- Tests: splitter + summary accumulator (dedup, tense, boundaries), collapse
  decision, duration boundaries, divider 3-way fallback.

## Test plan

Per PR: `bun run typecheck` · `bun run test:renderer` (new pure-function suites:
splitter, summary, collapse decision, duration) · `bun run test:core` (no core
change expected) · `bun run docs:check`. **Visual light + dark** is the deciding
gate for every PR (grouped disclosure, divider line, collapse animation, 4-state
icons) — headless light+dark technique (`emulateMedia(colorScheme)`).

## Decisions (ratified) + open build-time questions

**Ratified 2026-06-20 (PM):**
- **Full rebuild to 1:1** — reverse the two former spine Non-goals
  (auto-collapse-on-answer-start + `worked-for` divider entity); build the 3-PR SET.
- **#311: close and salvage** — do not merge the legacy-substrate version; lift its
  i18n tense family, `toolActivityKind` map, and `formatRunDuration` rollup into
  PR-1/PR-3.
- **Detail mode: single default** (≈ `STEPS_COMMANDS`); no user toggle this round.

**Open at build time (decide in the PR, not blocking):**
1. **Persisted collapse store:** renderer-only persisted UI state is the default
   (no core change). If run-start timing for the `worked-for` divider isn't already
   on the entry, PR-2 may need a tiny isolated projection addition — flag in the PR,
   not a protocol change.
2. **Fold threshold:** group runs of length ≥ 2 (lone tool renders as today); tune
   if a single grouped row reads better.
