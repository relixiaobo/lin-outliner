# Codex message-flow fidelity

Raise our agent process/transcript render to match the **OpenAI Codex desktop
client**'s message-flow interaction. Grounded in a read-only reverse-engineering of
that client (Electron/Vite/CSS-Modules), captured in
`tmp/research/codex-client/MESSAGE-FLOW-GAP.md` (the gap doc; every claim there
cites the exact Codex token/class/i18n string). Read that first — this plan is the
build design; the gap doc is the evidence.

## Goal

Close the four highest-impact fidelity gaps so the message flow reads like Codex's:
tool activity folds into **counted, kind-named summaries**, the live header **ticks
"Working for {t}"**, the active cue is a **"Thinking" text shimmer** (not a bare
spinner), and durations/statuses match Codex's vocabulary.

## Non-goals (deliberate divergences to KEEP — do not "fix")

- **No auto-collapse-on-answer-start.** Codex auto-collapses the agent body the
  moment the final answer streams (`IO`); we keep our sticky behavior — the process
  stays as the user left it through live→sealed, per the shipped
  `agent-process-stable-disclosure` (#297) and `agent-event-log-rendering.md`. All
  work below is independent of the collapse default.
- Keep our richer collapsed fallback "Thought · used N tools" over Codex's "{N}
  previous messages".
- No steering/hook-feedback "pinned-through-collapse" rows (we have no steering
  entity).
- No `STEPS_PROSE`/`STEPS_COMMANDS` user detail-mode toggle — a single default
  grouping is enough for parity.

## Shape

**ONE complete feature, ONE PR, ONE agent.** The four parts A–D below are
**build-order within that single PR** (A7 foundation-before-consumers), NOT separate
releases. Build leaf utilities first (D-duration, i18n family, kind map), then the
core grouping/summary (A), then the header ticker (B) and shimmer (C), then the 4th
status (D-status). The PR is reviewable as one coherent "match Codex message flow"
change. Branch: one topic branch; mark ready when typecheck + test:core +
test:renderer + visual (light+dark) all pass.

---

## Part A — Tool-activity grouping + counted, kind-named summary (High)

Today a run of tool calls renders as N discrete `AgentToolCallBlock` rows, and the
collapsed header summarizes everything as a generic "Used N tools". Codex folds a
run of **consecutive** tool/command items into ONE `collapsed-tool-activity`
disclosure whose summary names the **kind, count, and tense** ("Ran 3 commands",
"Read 5 files", "Searching the web"), expandable to the individual rows.

### A1. Tool-name → activity-kind map (new helper)

Add to `AgentToolCallBlock.tsx` (next to `getToolIcon`/`summarizeToolCall`, which
already switch on `toolCall.name`), exported for reuse:

```ts
export type ToolActivityKind =
  | 'command' | 'fileCreate' | 'fileEdit' | 'fileDelete'
  | 'read' | 'search' | 'web' | 'memory' | 'skill' | 'other';

export function toolActivityKind(name: string): ToolActivityKind {
  switch (name) {
    case 'bash': return 'command';
    case 'file_write': case 'node_create': return 'fileCreate';
    case 'file_edit': case 'node_edit': return 'fileEdit';
    case 'node_delete': return 'fileDelete';
    case 'node_read': return 'read';
    case 'node_search': return 'search';
    case 'web_search': case 'web_fetch': return 'web';
    case 'recall': case 'dream': return 'memory';
    case 'skill': return 'skill';
    default: return 'other'; // Agent/AgentStatus/AgentSend/AgentStop never reach here (child-run rows, not grouped)
  }
}
```

### A2. Grouping (new synthetic block + render)

Group consecutive `toolCall` segments in `AgentProcessTimeline.tsx` **before**
`blocks.map`. Rules:

- A run = maximal sequence of adjacent `kind:'toolCall'` blocks **that are not child
  runs** (`!block.childRun && !childRunsByParentToolCallId?.get(block.toolCall.id)`).
  A child-run tool call breaks the run and renders standalone (it has rich inline
  content we must not hide). Thinking/narration also break the run.
- A run of length **≥ 2** renders as ONE `AgentToolActivityGroup` disclosure
  (collapsed by default) whose body is the existing `AgentToolCallBlock` rows
  verbatim. A run of length 1 renders as today (a lone `AgentToolCallBlock`) — no
  redundant wrapper.
- The group's own collapse state uses the existing `expandState` keyed by a stable
  id, e.g. `activity:${firstToolCallId}`.

Helper (pure, unit-testable):

```ts
type TimelineRenderUnit =
  | { kind: 'block'; block: AgentProcessSegmentBlock }
  | { kind: 'toolActivity'; id: string; members: Array<Extract<AgentProcessSegmentBlock,{kind:'toolCall'}>> };

export function groupTimelineUnits(
  blocks: AgentProcessSegmentBlock[],
  isChildRun: (b: Extract<AgentProcessSegmentBlock,{kind:'toolCall'}>) => boolean,
): TimelineRenderUnit[];
```

### A3. Counted summary copy (new i18n family)

Add a `toolActivity` sub-family under `agent.process` in BOTH
`src/core/i18n/messages/en.ts` and `src/core/i18n/messages/zh-Hans.ts` (the
`process:` block — en at en.ts:1012, zh at zh-Hans.ts:927). Each kind has a
**running** and **done** form; counts pluralize. The group summary, when all members
share a kind, is that kind's phrase; when mixed, compose the per-kind sub-phrases
joined by " · " (capitalize the first), falling back to the existing
`usedTools({count})` only when > 2 distinct kinds.

Exact `en` copy to add (mirror in `zh-Hans`):

```ts
toolActivity: {
  // done / running, count-pluralized. Leading=sentence-initial (capitalized).
  command:     ({ count }) => `Ran ${count === 1 ? 'a command' : `${count} commands`}`,
  commandRun:  ({ count }) => `Running ${count === 1 ? 'a command' : `${count} commands`}`,
  fileCreate:    ({ count }) => `Created ${count === 1 ? 'a file' : `${count} files`}`,
  fileCreateRun: ({ count }) => `Creating ${count === 1 ? 'a file' : `${count} files`}`,
  fileEdit:    ({ count }) => `Edited ${count === 1 ? 'a file' : `${count} files`}`,
  fileEditRun: ({ count }) => `Editing ${count === 1 ? 'a file' : `${count} files`}`,
  fileDelete:    ({ count }) => `Deleted ${count === 1 ? 'a file' : `${count} files`}`,
  fileDeleteRun: ({ count }) => `Deleting ${count === 1 ? 'a file' : `${count} files`}`,
  read:    ({ count }) => `Read ${count === 1 ? 'a node' : `${count} nodes`}`,
  readRun: ({ count }) => `Reading ${count === 1 ? 'a node' : `${count} nodes`}`,
  search:    () => 'Searched',
  searchRun: () => 'Searching',
  web:    () => 'Searched the web',
  webRun: () => 'Searching the web',
  memory:    () => 'Recalled memory',
  memoryRun: () => 'Recalling memory',
  skill:    ({ count }) => `Used ${count === 1 ? 'a skill' : `${count} skills`}`,
  skillRun: ({ count }) => `Using ${count === 1 ? 'a skill' : `${count} skills`}`,
  // mixed-kind joiner uses these as lowercase non-leading fragments via toLowerCase()
},
```

`zh-Hans` copy (same keys): `command: ({count}) => \`运行了 ${count} 个命令\``,
`commandRun: 运行 ${count} 个命令`, `read: 读取了 ${count} 个节点`, `web: 搜索了网页` /
`webRun: 正在搜索网页`, `memory: 检索了记忆`, `skill: 使用了 ${count} 个技能`, etc.
(Per AGENTS.md the repo copy is English; the user-facing zh strings are the product's
localization and live in `zh-Hans.ts`.)

### A4. Summary composition + group component

- `AgentToolActivityGroup.tsx` (new): a disclosure row (reuse `ButtonControl` +
  chevron, same affordance as `AgentProcessBlock`'s toggle, B6/B10) whose header text
  is `summarizeToolActivity(members, anyPending)` and whose expanded body maps members
  to `AgentToolCallBlock`. While any member is pending the header uses the *running*
  i18n form; the spinner/active treatment follows Part C.
- `summarizeToolActivity(members, running)` (new, in `AgentProcessBlock.tsx` or a
  shared `agentProcessSummary.ts`): bucket members by `toolActivityKind`, pick the
  i18n form per bucket (running vs done), compose. Member done/error/pending derives
  from `getToolCallStatus(... , outcome)` — **reuse the `outcome` signal added by
  the `fix/tool-call-spinner-stuck` branch** so a settled-but-resultless member
  counts done, not pending.
- `summarizeProcess` (`AgentProcessBlock.tsx`): the collapsed header keeps composing
  "Thought · …", but the tool portion now uses `summarizeToolActivity` of the turn's
  tool calls instead of the single `usedTools({count})` line.

---

## Part B — Live "Working for {t}" ticker + bare "Working" under 1s (Med)

Codex's live header ticks `Working for {time}` (≥1s) / bare `Working` (<1s, no
number — avoids a "0s" flicker), settling to `Worked for {time}` on seal. We only
show the static sealed header; live we show the running tool / thinking preview but
no elapsed clock, and sub-1s prints "<1s".

### B1. Live elapsed source + ticker hook

`AgentProcessBlock` already receives `turnActive` and `workedForMs` (sealed). For
the LIVE clock it needs the producing run's start. Thread it down:

- Source: the producing run's start time. The simplest existing anchor is the
  assistant message `createdAt` (≈ run start) — thread it as a new optional prop
  `liveStartedAtMs?: number` from `AgentMessageRow` (it has `entry.message.timestamp`
  / the entity `createdAt`) → `AgentTurnProcessFold`/`AgentProcessBlock`. If a more
  precise run `startedAt` is readily available on the entry, prefer it (note it in
  the PR).
- New hook `useElapsedTick(startedAtMs, active)` (small, colocated): when `active`,
  `setInterval(…, 1000)` bumps a state counter; cleared on inactive/unmount. Returns
  `Date.now() - startedAtMs`. One interval per live process block is fine (there is
  at most one live turn).

### B2. Header copy

- In `summarizeProcess`'s `liveCollapsed` branch: when there is **no currently
  pending tool to name** (the existing running-tool path stays — it is more
  informative), show the live clock: `elapsedMs >= 1000 ? process.workingFor({
  duration: formatRunDuration(elapsedMs) }) : process.working`.
- Add i18n `workingFor: ({ duration }) => \`Working for ${duration}\`` (en) /
  `用时 ${duration}…` or `处理中 ${duration}` (zh) next to `working`/`workedFor`.
- Drop the `"<1s"` literal from the LIVE path (bare "Working"); `formatRunDuration`'s
  own "<1s" stays for any non-live caller, but with Part D it only returns "<1s" for
  sealed sub-1s which is acceptable. (If desired, change `formatRunDuration` to never
  emit "<1s" and let callers decide — keep that minimal.)

---

## Part C — "Thinking" text shimmer as the active cue (Med — biggest "feels like Codex")

Codex's primary "alive" cue is a **cadenced text shimmer** sweeping the "Thinking"
label (mask-gradient sweep, `steps(48,end)`, re-arms ~every 4s), NOT a spinner;
reduced-motion turns it off (CSS `@media` + JS `matchMedia` guard). We use a
`LoaderIcon` in the collapsed header (`AgentProcessBlock.tsx:286`).

### C1. Shimmer component + CSS (token-driven, achromatic)

- `AgentTextShimmer.tsx` (new): wraps label text in a `<span>` with a class that
  applies a sweeping mask. Achromatic only (B3/B4): base color `var(--text-secondary)`,
  highlight `var(--text-primary)` (NO brand/accent). Our styles are global token CSS
  (NOT CSS Modules) — add to the agent CSS file (where `agent-process-spinner` lives).

```css
.agent-text-shimmer { position: relative; }
.agent-text-shimmer.is-active {
  background: linear-gradient(90deg, var(--text-secondary) 0%, var(--text-primary) 50%, var(--text-secondary) 100%);
  background-size: 200% 100%;
  -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: agent-text-shimmer-sweep 1s steps(48, end);
  animation-iteration-count: 1;
}
/* JS re-arms the .is-active class ~every 4s (initial 600ms delay, 1s sweep). */
@keyframes agent-text-shimmer-sweep { from { background-position: 200% 0; } to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .agent-text-shimmer.is-active { animation: none; color: var(--text-secondary); -webkit-text-fill-color: currentColor; } }
```

- JS cadence + reduced-motion guard: reuse the project's reduced-motion hook if one
  exists (grep `prefers-reduced-motion` / `useReducedMotion` in `src/renderer`); else
  a `matchMedia('(prefers-reduced-motion: reduce)')` guard. When reduced, never add
  `is-active`. Cadence: `is-active` for 1s, off, re-arm every ~4s while the turn is
  active.

### C2. Wiring

- Replace the collapsed-header `LoaderIcon` slot with `AgentTextShimmer` on the
  active label ("Working"/"Working for …"/"Thinking"), preserving the single
  trailing slot (B7 "labels don't move"; the slot still swaps shimmer↔chevron on
  collapse/seal). Keep the per-running-tool-row spinner (`agent-tool-call-spinner`)
  as-is — Codex also keeps a per-step ring.
- **Gate decision at the visual review:** if the shimmer reads off-brand in
  light+dark or trips a design-system guard (B11), fall back to keeping the spinner.
  The gap doc marks this part "optional/taste" — do not block A/B/D on it.

---

## Part D — Duration day-rollup + a 4th "not-started" status (Low)

### D1. `formatRunDuration` (agentProcessTypes.ts:36)

Extend the current function (which tops out at hours and drops seconds in the hour
form) to roll up to **days** and keep all non-zero units, matching Codex's `qd`
(`1h 5m 3s`, `2d 3h`):

```ts
// after: if (minutes < 60) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
const hours = Math.floor(minutes / 60);
if (hours < 24) return [ `${hours}h`, minutes % 60 && `${minutes % 60}m`, rest && `${rest}s` ].filter(Boolean).join(' ');
const days = Math.floor(hours / 24);
return [ `${days}d`, hours % 24 && `${hours % 24}h`, minutes % 60 && `${minutes % 60}m` ].filter(Boolean).join(' ');
```

Unit-test the boundaries (59s, 60s, 90s, 3600s, 3661s, 86400s, 90061s).

### D2. Fourth status icon (conditional — defer if not cheap)

Codex's `progress-step-row` has four states: running (ring) / done (check-circle) /
failed (x-circle) / **not-started (hollow circle)**. Our `getToolCallStatus` is
three-state (pending=running, done, error). Add a `'queued'`/'not-started' state ONLY
if the projection cheaply distinguishes "tool call declared but `tool_execution_start`
not yet fired" from "executing". If that signal is not readily available without new
plumbing, **defer this half** and note it in the PR (the other three parts stand
alone). Do not add new core events just for an icon.

---

## i18n keys — summary of additions

`agent.process` (en.ts + zh-Hans.ts):
- `workingFor({ duration })`
- `toolActivity.{command,commandRun,fileCreate,fileCreateRun,fileEdit,fileEditRun,
  fileDelete,fileDeleteRun,read,readRun,search,searchRun,web,webRun,memory,memoryRun,
  skill,skillRun}`

The `i18n/types.ts` message-shape type must be updated to include these (typecheck
enforces both locales stay in sync).

## Files touched

- `src/core/i18n/messages/en.ts`, `src/core/i18n/messages/zh-Hans.ts`,
  `src/core/i18n/types.ts` — new keys.
- `src/renderer/ui/agent/AgentToolCallBlock.tsx` — `toolActivityKind` + export;
  optional 4th status in `getToolCallStatus`.
- `src/renderer/ui/agent/AgentToolActivityGroup.tsx` (new) — the group disclosure.
- `src/renderer/ui/agent/AgentProcessTimeline.tsx` — `groupTimelineUnits` + render
  groups.
- `src/renderer/ui/agent/AgentProcessBlock.tsx` — `summarizeToolActivity`,
  `summarizeProcess` tool portion, live ticker in `liveCollapsed`.
- `src/renderer/ui/agent/AgentAssistantTurnContent.tsx` /
  `AgentMessageRow.tsx` — thread `liveStartedAtMs`.
- `src/renderer/ui/agent/AgentTextShimmer.tsx` (new) + the agent CSS file — shimmer.
- `src/renderer/ui/agent/agentProcessTypes.ts` — `formatRunDuration` day-rollup.
- Tests: `tests/renderer/agentProcess.test.ts` (grouping, summary per kind, duration
  boundaries, ticker threshold), `tests/renderer/agentToolCallBlock.test.ts`
  (`toolActivityKind`).

## Test plan

`bun run typecheck` · `bun run test:renderer` (new cases above) · `bun run test:core`
(no core change expected; run to be safe) · `bun run docs:check`. **Visual light +
dark** is the deciding gate for Part C (shimmer) and for the grouped disclosure
look — use the headless light+dark technique (throwaway Playwright spec +
`emulateMedia(colorScheme)`).

## Open questions

- A2: group runs of length ≥ 2 (lone tool calls render as today) — confirm at build,
  tune if a single grouped row reads better.
- A4: mixed-kind summary composition vs falling back to "used N tools" past 2 kinds —
  pick the most legible; settle with the copy review.
- B1: use assistant-message `createdAt` as the live-elapsed anchor, or a more precise
  run `startedAt` if cheaply on the entry?
- C2: does the text shimmer survive the design-system guard + light/dark, or keep the
  spinner? Decided at the visual gate.
- D2: can we cheaply distinguish "not-started" from "executing" for the 4th status,
  or defer that half?
