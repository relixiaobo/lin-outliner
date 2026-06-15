# Unified Agent Context Architecture — one composer, layered by scope × volatility

**Part of the [[agent-program]].** A foundational refactor (A7): replace today's
**three hand-rolled system-prompt assemblers** with **one composer**, so every agent —
built-in, user-authored, and child run — gets a consistent, cache-optimal,
safety-complete context built the same way. This is the *organization* of context, not
new agent capability ([[conversational-agent-authoring]] is the capability that consumes
it). It carries forward the cache-discipline invariant from [[agent-conversation-model]]
and the "no framework firmware in the per-agent registry / safety floor is
non-negotiable" principle from [[agent-self-modification]] + A3.

## Goal

A **single composition pipeline** that sorts every block of context by two explicit
axes — **scope** (universal → per-agent) and **volatility** (stable → per-turn) — and
*derives* each block's position from those tags rather than hand-placing it. The result:

- the cacheable prefix is **maximal and monotonic** (most-shared/most-stable first);
- the perception + safety **firmware is universal and framework-owned** (an author can't
  omit it — closing today's gap where custom agents get none);
- an agent's stored definition is a **pure persona + capability delta** (the `body` field
  has exactly one meaning everywhere);
- there is **one representation** for all agents (no "built-in is a constant, custom is a
  file" split) and **one assembly path** (no per-kind hand-rolling).

## Non-goals

- **Not a storage-format change.** The AGENT.md `frontmatter` (metadata) + `body`
  (persona) split already separates the right things; keep it. The composer changes how a
  definition is *assembled into a prompt*, not how it is *stored*.
- **Not new agent capabilities.** What an agent can *do* is [[conversational-agent-authoring]]
  and the tool/permission plans; this is how its context is *assembled*.
- **Not re-introducing tool-operating conventions into the prompt.** Per-tool syntax rides
  each tool's `description` (settled in PR #248); the composer never carries it.
- **Not changing per-turn reminder content.** The `environment` / `<memory>` / user-view /
  time blocks keep their current content; this plan only formalizes their position as the
  **uncached tail** and forbids leaking any of them into the cached prefix.
- **No migration / back-compat.** Pre-release: rewrite the assemblers and delete the old
  three; wipe dev `userData` if any persisted shape changes.

## Background — the current state (motivation)

The same conceptual thing (an agent's system prompt) is built three different ways:

| agent kind | assembler | what it includes | order |
|---|---|---|---|
| built-in Neva | `LIN_AGENT_SYSTEM_PROMPT` constant (`agentSystemPrompt.ts:82`) | all 4 sections | persona-first |
| custom (DM/Channel) | `buildAgentMemberSystemPrompt` (`agentRuntime.ts:6106`) | identity + **body only** | persona-first |
| child run | `buildFreshAgentSystemPrompt` (`agentDelegation.ts:1578`) | header + shared-core + body | header-first, shared in the middle |

Four consequences, each a thing this plan fixes:

1. **Three divergent assemblers** for one concept — every new agent kind re-rolls the
   structure (violates A7).
2. **Inconsistent firmware.** Child runs get `LIN_CHILD_AGENT_CORE_PROMPT` (the shared
   `system-context` + `communication-and-safety` sections); **custom agents get nothing
   shared** — only their `body`. So whether an agent has the perception/safety scaffold
   depends on which path built it. This is a real consistency hole (defense-in-depth:
   the hard permission system still gates tools regardless, so it is not "custom agents
   run unbounded" — but the prompt-level floor is missing).
3. **`body` has two meanings.** Neva's `body` = the whole prompt
   (`createTenonAssistantAgentDefinition`, `agentDelegation.ts:1468`, `body:
   LIN_AGENT_SYSTEM_PROMPT`); a custom agent's `body` = persona only.
4. **The `audience: shared | main` model is half-applied.** It exists in
   `agentSystemPrompt.ts`; child runs honor it (filter to `shared`), but the custom-member
   path bypasses the section model entirely and hand-builds a string. The abstraction
   exists but is not the single source of truth.

The architecture was clean for the world it was built for — *one* built-in agent plus
ephemeral children. The product moved to *many* user-authored peer agents; the
prompt-assembly layer never got refactored to match.

## Design

### The organizing principle

Two axes; **position is derived, not hand-placed:**

- **scope** — universal (every agent) → capability-cohort → per-agent.
- **volatility** — never changes → per-agent-stable → per-conversation → per-turn.

Sort every block by *(scope desc, volatility desc)*. Because the prompt cache
prefix-matches, the most-shared + most-stable content sits deepest in the prefix and is
reused the most; the most-specific + most-volatile sits in the uncached tail.

### The layered stack

```
compose = composeAgentPrompt(agentDef, context)   ← the ONE entry; every agent uses it

══ SYSTEM PROMPT (cacheable region, ordered most-shared/stable → least) ══
 L0  Kernel firmware       byte-identical for EVERY agent · framework-owned · non-removable
       perception (read <system-reminder> blocks, read-before-act, untrusted-content)
       + conduct & safety floor (no invention, confirm-before-confirmed, permission
         results are normal, destructive needs confirmation, injection handling)
     ──────── cache breakpoint (multi-agent: cross-agent shared up to here)
 L1  Capability modules    present iff the agent has the faculty · byte-identical per cohort
       memory framing (iff memory) · delegation framing (iff it can spawn) · …
       (cross-tool framing only; per-tool syntax stays on tool descriptions)
 L2  Persona               per-agent · the only delta
       "You are X." + character / instructions  (= the stored `body`)
     ──────── cache breakpoint (= the per-agent prompt boundary, today's system-prompt point)
══ TOOLS (per-agent, generated from capability declarations) ══  ── breakpoint (last tool)
══ HISTORY (frozen, replays verbatim) ══
══ TAIL (recomputed every turn, UNCACHED) ══
       environment (DM/Channel/roster) · <memory> briefing ·
       user-view state (snapshot first turn / diff after) · time/locale · the user message
     ──────── breakpoint (last user block)
```

Human through-line (the framing that motivated this): **L0 = birth firmware** (the
perception + conduct floor every human shares) → **L1 = the faculties you have** (memory,
language) → **L2 = acquired personality** → **tail = your present sensory input and
situation.**

### The single composer

`composeAgentPrompt(agentDef, context)` is the **only** function that produces an agent's
system prompt. Every agent kind is the same pipeline with a different delta:

- **built-in Neva** — persona authored in code (or a read-only bundled AGENT.md — see Open
  questions);
- **user/project custom** — persona authored in its AGENT.md `body`;
- **child run** — persona = its `body` plus an L1-level **child-directive module** (the
  headless-worker rules) the composer adds when `contextMode` is a fresh child.

The three current assemblers are deleted.

### L0 — firmware: framework-owned, universal, non-removable

The perception + safety floor is **injected by the composer**, never stored in any
AGENT.md. This makes it impossible for an authored agent to ship without it, which is both
the clean choice and the fix for consequence #2. It aligns with **A3** (security defaults
are non-negotiable, never regress) and with [[agent-self-modification]]'s rule that
framework safety rules are not author-editable.

### L1 — capability modules

One self-contained block per faculty the agent actually has — the **cross-tool** framing
that is not specific to any single tool (e.g. "durable memory is written only by Dream /
Settings; `recall` is cued retrieval"). Present iff the capability is present, so a
memory-less child simply omits the memory module; byte-identical across every agent that
*has* the faculty (so it stays cacheable within the cohort). Per-tool conventions remain
on tool descriptions (not here).

### L2 — persona: the pure delta

`"You are X."` + the agent's character/instructions. After this refactor the `body` field
means exactly one thing for every agent. **Neva's in-code body slims to persona-only**
(her identity + memory *attitude*); the mechanical memory framing currently in her prompt
moves into the **L1 memory module** so it is shared with every memory-bearing agent rather
than duplicated in her persona.

### Uniform representation

Every agent — including built-ins — has the same shape: identity metadata + capability
declarations + persona `body`. Firmware (L0) and capability modules (L1) are framework
code, never part of a stored definition. Built-ins may still be authored as in-code
definitions for now; the important representation boundary is that they enter the composer
as the same `AgentDefinition` shape as user/project agents.

### Cache discipline

Monotonic prefix by construction. A `cache_control` breakpoint at **L0-end** lets a second
agent (within the TTL) hit the firmware segment another agent already warmed; from **L1
down it caches per-agent**; the tail stays uncached (today's invariant, kept). Honest
bound: under Anthropic's 4-breakpoint budget the **cross-agent shared segment is L0
only** — L1/L2 ride the per-agent cache. The L0-end breakpoint is redundant in a
single-agent DM (firmware is already cached per-agent via the L2-end point), so emit it
only where it can reuse a warmed firmware segment: multi-agent Channel runs and fresh
child runs. The deterministic acceptance surface is request shape: the provider payload
must contain L0 + rest-of-stable-prompt system blocks while preserving the last-tool and
last-user breakpoints. Live Anthropic `cacheRead` / `cacheWrite` deltas remain observable
through the existing debug usage pipeline, but are not a correctness condition for this
refactor.

### The hard wall (kept as an enforced invariant)

The cacheable system prompt and the per-turn uncached tail stay strictly separated. With
tag-derived positioning, the composer **cannot** place a per-turn block in the cached
prefix — the bug class ("stable info re-sent every turn in the tail" / "volatile info
poisoning the cached prefix") becomes structurally impossible, not merely avoided by
discipline.

## Execution

**Shape (b): a SET of independent complete PRs**, ordered by genuine dependency. Each is
shippable and verifiable alone — not a scaffold-then-fill slice.

- **PR 1 — the unified composer (foundation).** Introduce `composeAgentPrompt`; define the
  L0 firmware / L1 capability modules / L2 persona blocks; route built-in, custom, and
  child through it; **delete the three assemblers**; inject L0 universally (custom agents
  *gain* the firmware — the one intended behavior change); slim Neva's body to
  persona-only and relocate the mechanical memory framing into the L1 memory module. Spec
  sync (`agent-pi-mono-implementation.md` § System Prompt). Behavior-preserving for Neva +
  children; closes the safety/consistency gap for custom agents. Complete on its own.
- **PR 2 — cross-agent cache breakpoint (optimization).** Emit the L0-end `cache_control`
  where it can share a warmed firmware prefix. Pure performance, depends on PR 1,
  shippable alone.
  - **Implementation seam:** Tenon keeps pi-agent's single `systemPrompt` state shape, then
    rewrites the Anthropic provider payload in `onPayload` by splitting the system block
    into `L0 firmware` + `rest of stable prompt`. The two system blocks keep the L0-end and
    per-agent-end breakpoints; the existing last-tool and last-user breakpoints remain, so
    the request stays within Anthropic's 4-breakpoint budget. The rewrite is gated to
    multi-agent Channel runs and fresh child runs; single-agent DMs, forked children, and
    non-Anthropic providers keep the provider payload unchanged.

## Decisions

- **Built-in representation.** Keep built-ins as in-code definitions for now. The composer
  removes the prompt-assembly asymmetry; moving built-ins to bundled read-only AGENT.md
  files would be a storage/packaging cleanup, not part of this architecture.
- **L1 module boundaries.** Ship only shared cross-tool framing with a current consumer:
  memory framing and the fresh-child directive. Web/files/delegation modules can be added
  later only when they remove real duplication across tools or agent kinds.
- **Persona primacy.** Keep firmware-first. The cache-optimal order is the architecture;
  no tunable orientation line ships until a measured model-quality issue justifies it.
- **Firmware escape hatch.** None. L0 is framework-owned and non-removable. Advanced
  authors can specialize persona/capabilities, but they cannot remove the perception and
  conduct floor.
- **Breakpoint spend.** Gate L0 breakpoint emission to multi-agent Channel runs and fresh
  child runs. Single-agent DMs, fork children, non-Anthropic providers, and non-composer
  prompts keep the provider payload unchanged.
