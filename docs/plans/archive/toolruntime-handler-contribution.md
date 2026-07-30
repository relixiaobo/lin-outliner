# ToolRuntime Handler Contribution — domain modules own their tool handlers

Shape: **(a) ONE complete feature in one PR.** Line references are against
main at `7f9b38cb` (post-#451); re-derive with `rg` at build time (A11).

## Goal

Retire the last altitude mix the incident era exposed: collaboration tool
HANDLER BODIES (parse/validate → call domain → format result) live inside
`runtime/ToolRuntime.ts` — runtime infrastructure — which forced the budget
plan's ToolRuntime carve-out and makes every collaboration-parameter change
touch runtime/. After this PR:

- `SubagentCollaboration` contributes its six collaboration tools through the
  SAME contribution seam extensions already use;
- `ToolRuntime` is pure dispatch/assembly (catalog aggregation,
  canonicalization, identity/collision checks) with ZERO domain logic;
- the budget plan's "ToolRuntime spawn_agent handler only" carve-out retires —
  "runtime/ contains no domain logic" becomes true by construction;
- the seam is the documented landing zone for `agent-browser-control`'s
  provider work (its plan revision builds on this).

## Non-goals

- No behavior change: tool names, schemas, descriptions, argument validation,
  error texts, and result shapes are byte-identical. This is a move plus a
  seam, not a redesign.
- **No provider-catalog byte drift** — the load-bearing risk. The tool
  catalog's serialized order and content feed the stable provider prefix
  (L0/L1 composition; `canonicalizeAgentTools`, `PiTurnExecutor.ts:525`,
  applied at `:151`). A silent order change would degrade every user's prompt
  cache with zero failing tests today. This plan adds the guard that makes
  that impossible (see Verification) — the guard is a deliverable, not a nicety.
- No changes to `src/core/` (contracts in `core/agent/tools.ts` stay), no
  changes to `runtime/kernel/**` or `PiTurnExecutor.ts` beyond none-at-all
  (they consume `createTools` output, which is unchanged).
- No migration of OTHER tool families in this PR: core agent tools
  (`agentTools.ts` et al.) stay as-is — they are capability-layer, not
  domain-module state, and moving them buys nothing now. One family proves
  the seam; the seam is generic.

## Current state (verified facts)

- `runtime/ToolRuntime.ts` is 572 lines; the six collaboration handlers sit
  at `:191-247` (`collaborationTool(` helper at `:475`), each a thin adapter
  onto facade methods (`spawnCollaborationAgent`, `sendCollaborationMessage`,
  `followupCollaborationTask`, `waitForCollaborationActivity`,
  `listCollaborationAgents`, `interruptCollaborationAgent`) whose
  implementations live in `thread/SubagentCollaboration.ts` since #451.
- A contribution seam ALREADY EXISTS: `extensionToolContributions`
  (`ToolRuntime.ts:94`) — extensions contribute tools; only built-ins bypass
  it. This plan unifies on the existing pattern rather than inventing one.
- Tool identity/collision policy: registry assembly rejects collisions before
  a tool reaches a model (spec: agent-subagent-threads.md Collaboration
  Tools); the `collaboration` namespace encodes as `namespace__name` for flat
  providers.
- Per-turn context: handlers close over `threadId`/`turnId`/`itemId` supplied
  by `createTools(context)` — the contribution interface must carry the same
  turn context.
- The budget plan's carve-out and its retirement note:
  `docs/plans/subagent-budget-propagation.md` (tripwire section) and
  `docs/plans/archive/threadservice-decomposition.md` (deferred notes) both
  point here.

## Design

### 1. The contribution interface (narrow, mirrors the extension seam)

In `thread/SubagentCollaboration.ts`:

```ts
collaborationToolContributions(turn: {
  threadId: ThreadId; turnId: string;
}): readonly AgentTool[]  // the six tools, handlers bound to this module
```

The `collaborationTool(` wrapper helper and the six handler bodies MOVE
(verbatim — same validation helpers, same error strings, same result
formatting) from `ToolRuntime.ts` into `SubagentCollaboration.ts`. Calls that
today go through the facade (`this.service.*`) become direct module calls —
the facade methods themselves stay (renderer/host still use them; facade
freeze from #451 holds).

### 2. ToolRuntime becomes assembly-only

`createTools` composes: core agent tools + skill runtime tools + dynamic
tools + `service.collaborationToolContributions(...)` + extension
contributions — in EXACTLY the current concatenation order (order is
cache-load-bearing; see Non-goals). The `collaborationTool` helper and
handler bodies are deleted from ToolRuntime; `rg "spawnCollaborationAgent"
src/main/agent/runtime/` returns nothing.

### 3. Carve-out retirement (same PR)

`docs/plans/subagent-budget-propagation.md`: replace the ToolRuntime
carve-out paragraph with one line noting it retired here. Spec
(`agent-tool-design.md`): one paragraph — tool handlers are contributed by
their owning domain modules; `runtime/` is dispatch only; this is the landing
zone for future command families (browser control).

## Verification

- **Catalog byte-stability guard (the load-bearing test, written FIRST,
  passing against main BEFORE the move):** serialize the full canonicalized
  tool catalog for a representative context (names, order, descriptions,
  JSON-schemas) and snapshot it; the test asserts byte-equality. Recorded on
  main, must pass unchanged on the branch — the judge that makes catalog
  drift impossible, for this PR and every future contribution migration.
  Validate the judge: a deliberate reorder/description-edit must fail it.
- Existing suites unmodified: `test:core` (collab tool tests target behavior,
  not file location), `test:renderer`, `docs:check`, typecheck.
- Tripwires: `git diff origin/main -- src/core/ src/main/agent/runtime/kernel/
  src/main/agent/runtime/PiTurnExecutor.ts` → empty; ToolRuntime line count
  strictly decreases (~572 → ~420); handler bodies' diff is move-only
  (`git diff --color-moved` review).
- Real-run smoke: one spawn/wait/steer round-trip on cc-switch confirming
  identical tool behavior and — via Model Interactions — an identical
  provider tool list to a pre-change run.

## Open questions

None blocking. Deferred: migrating further families (goal-for-turn tools,
skill tool) onto the seam — only when a change pressure actually touches
them (A7: no speculative moves).

## Checklist

- [ ] Catalog byte-stability snapshot recorded on main; judge validated
- [ ] Six handlers + helper moved verbatim; contribution seam wired
- [ ] ToolRuntime assembly-only; runtime/ grep for domain calls empty
- [ ] Carve-out retired in budget plan; spec paragraph
- [ ] Full gates + real-run smoke; move-only diff review
