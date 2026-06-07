---
status: draft
priority: P2
owner: unassigned
created: 2026-06-07
updated: 2026-06-07
---

# Agent Dream — Scheduled Reflective Memory Run

## Essence

> **Waking = everyday thinking. Sleep = reorganization.** A human consolidates
> long-term memory on a (circadian) **schedule**, not "whenever idle" — and a
> busy mind never gets idle anyway. Tenon's agent should sleep on a schedule too.

**Dream is not a new mechanism — it is a run.** Specifically a *reflective*
run-type: the **same agent** (identity + persona), triggered by a **schedule**
instead of a message, reading the experience it has not yet slept on, and
**writing its own memory** instead of replying.

During waking hours the agent only **reads** durable memory (the per-turn
`<agent-memory>` reminder + the read-only `recall` tool); it never writes inline.
Durable memory is (re)written only by the Dream run.

## Goal

- Model durable memory write-back as a **reflective run** of the agent, on the
  **same `run` abstraction** as foreground/scheduled runs — not a bespoke
  side-mechanism.
- **Trigger = a `date` schedule** (reusing `agent-scheduled-routines`'s `date`
  machinery), plus a manual **`/dream`** override. No per-turn cadence, no idle
  detection.
- One Dream run does the whole job in a single pass over the un-slept evidence:
  **extract** new durable facts **and consolidate** existing memory
  (dedupe / merge / prune / contradiction-resolve) — one net change-set.

## Non-goals (explicitly unchanged)

- **Read surface** — `recall` (read-only, single tool) stays exactly as #158.
- **Human write path** — Settings/Profile list/edit/forget stays.
- **No model-visible memory write tool** — the #157 write-authority decision
  stands; memory writes happen only inside the Dream run, runtime-scheduled and
  bounded.
- **Per-turn `<agent-memory>` reminder injection** — "everyday thinking"
  (read-only) stays per-turn; only the *write-back* is a scheduled run.
- **Storage format, isolation tiers, `originWorkspace`, provenance, undo
  invalidation** — all from #157/#158/#159 stand unchanged.

## Design

### Dream is a run; **trigger and run-type are orthogonal axes**

- **run-type** = what *kind* of run it is: `interactive` (reply) ·
  **`reflective`** (Dream: writes memory) · …
- **trigger** = what *started* it: `user` · `agent` · `schedule(date)`.

A reflective run is *usually* `schedule`-triggered, but `/dream` makes it
`user`-triggered. The two axes do not collapse into each other.

| run | run-type | trigger | anchor | output |
|---|---|---|---|---|
| foreground turn | interactive | `user` (message) | conversation | reply |
| subagent / `@` / coordinator | interactive | `agent` | conversation | result |
| scheduled routine | interactive | `schedule(date)` | conversation (the routine's) | reply / effects |
| **Dream (auto)** | **reflective** | `schedule(date)` | **agent (no conversation)** | memory |
| **Dream (`/dream`)** | **reflective** | `user` | **agent (no conversation)** | memory |

### Trigger — `date` schedule (+ manual `/dream`)

- **Automatic**: a per-agent `date` schedule, reusing the `date` (when + repeat)
  machinery from [[agent-scheduled-routines]]. Default cadence TBD (e.g. daily).
  Dream and a scheduled routine are **siblings under the `schedule(date)`
  trigger but distinct run-types** — Dream is **not** a built-in routine (a
  routine is a full agent run with tools; Dream is the restricted reflective run).
- **Manual**: `/dream` forces a run now, bypassing the schedule and the
  enough-content heuristic (the user explicitly asked). First user-facing Dream
  affordance — useful for power users + testing + transparency.

### Gates on fire

```
fire(agent, source):                       // source ∈ {schedule, manual}
  if agent.dreaming:    return reject("already dreaming")          // hard: lock
  if not canRun(agent): return reject("no provider / offline")     // hard
  newVol = experienceVolumeSince(agent.dreamWatermark)             // new evidence since last sleep
  if source == schedule and newVol < DREAM_MIN_VOLUME:
                        return skip          // too little to be worth a pass — wait for next schedule
  if source == manual and newVol == 0:
                        consolidateOnly(agent); return  // /dream with nothing new → tidy existing memory
  dream(agent)          // reconcile (new evidence + current memory) → advance watermark
```

- **Hard constraints (both paths):** `lock` (single in-flight Dream per agent),
  `canRun` (provider configured + online; else no-op / user-visible reason).
- **Heuristic gate (automatic path only):** new-evidence volume must reach
  `DREAM_MIN_VOLUME` — *too little content, no need to dream*. `/dream` bypasses it.
- **`/dream` with no new evidence → `consolidateOnly`** (DECIDED): run the
  consolidation half (dedupe / merge / contradiction-resolve over existing
  memory) — it is meaningful without new material; not a no-op.
- **`has-new-experience` counts conversation/run evidence only**, never the
  agent's own `memory.*`/`dream.*` events — otherwise a Dream's writes would
  re-trigger Dream (infinite loop).

### The reflective run

- **Persona is intrinsic, not injected.** Because Dream *is* the agent, its
  persona (its `AgentDefinition` identity/role) is the run's system prompt —
  minus foreground operational tooling, plus a reflection instruction, **no
  tools**. (Implementation reuses #159's `completeSimple` no-tools call.)
- **Guard — persona shapes salience, not truth.** What is worth remembering and
  how to phrase/merge it is judged *as this agent*; but every action must be
  **grounded in the raw evidence**, never persona-invented or editorialized
  beyond it (the #157 invariant).
- **One pass = extract + consolidate.** Read (new evidence since the watermark +
  current visible memory), emit one net change-set of add / update / forget /
  merge. Not two phases.
- **Reuse #159's apply path verbatim**, so its isolation/provenance/dedup
  invariants and regression tests carry over: `read-only-global` writes nothing;
  `isolated` only touches in-scope entries; `add` tags `originWorkspace`,
  `update` preserves the entry's own; same-key update is a no-op; out-of-scope
  `memoryId` is skipped; provenance bound to `conversationId`/`messageRange`/
  `runId`/`eventId`.

### Per-agent state (scheduling is per-agent; logic is shared)

One runtime scheduler, per-agent state — agent A can Dream while agent B is busy.

| state | meaning |
|---|---|
| `dreamSchedule` (`date`) | this agent's Dream cadence |
| `dreamWatermark` (eventId) | last evidence event a successful Dream processed |
| `dreaming` (bool) | the lock |

`experienceVolumeSince(watermark)` measures un-slept evidence — unit (chars vs.
completed turns) is an open question; chars correlate best with extraction
cost/value.

### Output / observability

A Dream run emits the usual `memory.entry_*` events **plus a `dream.completed`
event** (watermark range processed + change counts) for audit and the future
per-agent task panel. `dream.completed` is a **new taxonomy event** — coordinate
per A4/A7 (additive).

### Protocol cost — `RunMeta` anchor generalization (the one real change)

Runs already carry `trigger` provenance, so `trigger: schedule`/`user` for Dream
fits. The **only** structural friction is that `RunMeta` mandates a
`conversationId` anchor, while a Dream run is **agent-level / cross-conversation**.
Generalize: a run anchors to an **agent**, and **optionally** targets a
conversation (foreground/routine = conversation-targeted; Dream = agent-only).
This touches `src/core/types.ts` (protocol surface) → **interface-first + PM
ratification** (A4/A7). It pays off beyond Dream (clarifies subagent/routine runs).

### Reuse from #159 (redirect, not rewrite)

#159's `agentDreamExtraction` worker — span builder, extraction prompt, action
parser, `applyDreamMemoryActions` (isolation/provenance/dedup) — is **kept**.
What changes: the **trigger** (per-turn → `schedule(date)` + `/dream`), the
**evidence range** (last run → since-watermark, bounded/chunked), and adding the
**consolidation** half to the prompt + action schema.

## Open questions (tuning + one protocol decision)

- **`RunMeta` anchor generalization** (the protocol decision): optional
  `conversationId`, or a distinct agent-level run variant? Interface-first.
- **`date` default cadence** — daily? every N hours? per-agent configurable
  surface (a Settings field vs. a `date` like routines).
- **`DREAM_MIN_VOLUME`** — value + unit (new chars vs. completed turns).
- **Watermark granularity** — per agent vs. aggregating several conversations
  touched since the last sleep; backlog chunking / per-pass budget for a large gap.
- **`consolidateOnly` cadence** — also run a periodic full-set re-consolidation
  independent of new evidence (vs. only via `/dream`)?
- **`/dream` surface** — a slash command / skill vs. a Settings action; what it
  reports back (it has no conversation output of its own).
- **Dream visibility** — surface `dream.completed` in the M2 per-agent task panel?

## Rejected alternatives (path not taken — kept for the record)

- **Per-turn trigger (#159's first slice).** Fired after every completed turn.
  Rejected: too frequent (one extra completion per turn, most turns yield
  nothing), redundant over overlapping evidence, no real immediacy benefit
  (in-conversation context is already raw), and it churns un-settled facts
  (add-then-forget). #159's *worker* is reused; only its trigger is dropped.
- **Idle / "rest" predicate** (idle-threshold + debounce + `powerMonitor` +
  `rested ∨ overdue`). Rejected: a continuously busy agent may **never** go idle,
  so it would never Dream (falling back to a periodic timer — at which point
  "rest" is just a worse-named schedule); and it carried two thresholds plus OS
  signals for no gain over a plain `date`. `date` is simpler, robust to busy
  agents, and more faithful to the circadian sleep metaphor.

## Relationship to existing work

- **Supersedes the per-turn *trigger*** from #159 (`agent-dream-extraction`);
  reuses its worker internals.
- **Detailed design for** [[agent-conversation-model]]'s `Offline consolidation`
  item; when shipped, update `agent-tool-design.md` /
  `agent-pi-mono-implementation.md` / conversation-model §Memory and flip that item.
- **Sibling of** [[agent-scheduled-routines]] under the `schedule(date)` trigger
  (shared cadence machinery, distinct run-type).
- **Builds toward** memory v3 consolidation (M3) — the deeper cross-session
  version of the consolidation step introduced here.
- **Future consideration:** if M3 ever introduces *cross-agent shared* memory,
  persona-coloured phrasing destined for a shared pool should be more neutral;
  not in scope while each agent owns its own memory line.

## Checklist

- [ ] Decide the `RunMeta` anchor generalization (agent-level run); land it
  interface-first (protocol surface, PM ratify).
- [ ] Add per-agent Dream state: `dreamSchedule` (`date`), `dreamWatermark`,
  `dreaming` lock; reuse `agent-scheduled-routines` `date` machinery for the
  scheduler.
- [ ] Implement `fire(agent, source)` with the hard `lock`/`canRun` gates, the
  `DREAM_MIN_VOLUME` heuristic on the automatic path, and `consolidateOnly` for
  `/dream` with no new evidence.
- [ ] Remove the per-turn `queueDreamMemoryExtractionAfterTurn` call sites;
  repurpose `dreamMemoryExtractionEnabled` for the scheduled trigger.
- [ ] Generalize the evidence range to "since watermark" (bounded, chunked);
  keep provenance shape. Exclude `memory.*`/`dream.*` from `has-new-experience`.
- [ ] Run as the reflective run: agent persona as system prompt, no tools; one
  pass = extract + consolidate; keep `applyDreamMemoryActions` invariants.
- [ ] `/dream` command surface.
- [ ] Emit `dream.completed` (taxonomy add; coordinate A4/A7).
- [ ] Tests: schedule fires a Dream (not per turn); `DREAM_MIN_VOLUME` skips a
  thin auto run; `/dream` forces; `/dream` with no new evidence consolidates;
  watermark advances and isn't reprocessed; isolation/`read-only-global`/no-op
  invariants hold; foreground never blocked.
- [ ] Spec updates + flip the conversation-model offline-consolidation item.
