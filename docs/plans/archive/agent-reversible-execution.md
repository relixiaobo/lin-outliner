---
status: shelved
priority: P0
owner: relixiaobo
created: 2026-05-28
updated: 2026-05-30
---

# Agent Reversible Execution

This plan is shelved. The current authority for agent permission implementation
is [`agent-tool-permissions.md`](agent-tool-permissions.md).

The new plan keeps reversibility as an action descriptor and an important input
to default policy, confirmation copy, and future checkpoint/undo work. It no
longer treats reversibility as the primary permission gate. Runtime action
kinds, platform hard blocks, global rules, and a classifier-backed `ask`
resolver are the implementation contract.

The historical content below remains only as background and is not a current
implementation contract.

The cleanest permission model for Lin's agent is not a smarter approval prompt.
It is making approval prompts rare enough to mean something. This plan provides
the single organizing rule behind permissions and the load-bearing piece that
lets that rule hold: a reliable checkpoint/undo engine.

It is the foundation for [`agent-permissions.md`](agent-permissions.md), not a
replacement. That plan enumerates a per-area allow/ask/deny matrix; this plan
states the one rule those rows are instances of, so the matrix can shrink to its
irreducible core.

## The Problem It Solves

Approval gates conflate two unrelated questions — *is this action safe?* and *is
the human watching right now?* — and resolve both by blocking. The observed
failure modes:

- **Approval fatigue.** A prompt the user always rubber-stamps adds no safety,
  only friction, and trains the reflex that defeats the prompt that matters.
- **Blocking on an absent human.** A serial `ask` stalls the whole run on a
  human who stepped away, turning a mildly risky step into a dead task.

Both vanish if prompts become rare and the common path never blocks.

## Goal

Make reversibility the gate. The agent acts freely on anything it can undo, and
asks only for the small set of actions that genuinely escape undo. Concretely:

- Every reversible action runs immediately, captured in a checkpoint.
- The user gets a trustworthy one-click "undo this run" — approval moves from
  *before* to *after*.
- A prompt fires only for irreversible / outward-facing actions, which are rare
  enough that the user actually reads them.

## Non-goals

- Do not keep the once/session/always rule lifetimes, persistent allowlists, or
  risk-scoring tiers as the *primary* mechanism. They exist to manage prompt
  volume; if the volume problem is solved at the root, they become optional
  refinements, not load-bearing structure.
- Do not weaken redline `deny`. Reversibility lowers `ask` to `allow`; it never
  lowers a redline. `rm -rf /`, secret exfiltration, and permission
  self-modification stay denied regardless of any checkpoint.
- Do not promise reversibility for effects we cannot actually capture (network,
  external state, unbounded shell). Those stay `ask`. Honesty here is the whole
  point — a checkpoint that silently fails to restore is worse than a prompt.
- Do not build an OS-level shell sandbox in v1 (see Open Questions).

## Design

### The single rule

Replace the per-area risk matrix as the *primary* gate with one classification,
applied after redline checks:

```txt
deny  (redline: machine destruction, exfiltration, self-modification)
  >  ask   (effect escapes the checkpoint boundary: irreversible / outward)
  >  allow (effect is fully captured by a restorable checkpoint)
```

An action is **reversible** iff restoring its checkpoint fully undoes it. That
is a deterministic fact about the tool and its resolved arguments — computed in
TypeScript, never asserted by the model. The existing matrix rows in
`agent-permissions.md` are then *instances* of this rule (e.g. "delete to trash"
is reversible → allow; "permanently clear trash" escapes undo → ask; "bypass the
operation journal" defeats the checkpoint itself → deny), not a separate source
of truth to maintain by hand.

### Reversibility by tool family

| Family | Reversible? | How the checkpoint captures it |
| --- | --- | --- |
| Document / node tools | Yes (today) | Already wrapped in operation transactions grouped for undo (per `agent-permissions.md` baseline). Native. |
| File writes inside workspace | Yes (needs work) | Pre-write content snapshot of touched paths; restore replays prior bytes / deletes created files. This is the one real engineering piece. |
| File deletes inside workspace | Yes | Route through trash / snapshot, not raw unlink. |
| Local read-only shell, reads, search, tests | Yes (no effect) | Nothing to undo. |
| Shell with side effects we cannot bound | No | Cannot be captured → `ask`. The residual prompt source. |
| Network, `git push`, external APIs, spending | No (outward) | Leaves the machine → `ask`, rare by nature. |

The honest boundary: **reversibility is guaranteed only inside the checkpoint
boundary (the workspace + the document store).** Anything that reaches outside
it, or that we cannot confine, is not reversible and keeps a prompt.

### The Checkpoint engine (load-bearing)

A checkpoint is a restorable snapshot taken before an agent step (or run) that
mutates state inside the boundary. The run becomes a sequence of checkpoints
with restore-to-here.

1. **Document.** Reuse the existing agent operation journal / undo grouping. No
   new mechanism — just ensure every document-mutating tool call participates in
   a labeled group.
2. **Workspace files.** Before a file write/delete, snapshot the affected paths
   (content + existence). Keep snapshots for the life of the run (and a short
   tail after) so undo works after the agent finishes. Cheap copy-on-write of
   only-touched files, not a full workspace copy.
3. **Shell.** Out of scope to checkpoint generally. Shell whose effects we
   cannot prove are confined to the snapshot boundary stays `ask`. If an OS
   sandbox lands later, sandbox-confined shell can move to `allow` + checkpoint.

The checkpoint's reliability *is* the security property. If a snapshot cannot be
taken (e.g. path outside the boundary, too large, permission error), the action
is treated as not reversible → `ask`. Fail toward the prompt, never toward a
silent best-effort undo.

### Approve-after UX

Because the agent acts freely, the user needs a trustworthy place to review and
revert, replacing the pre-approval modal:

- The transcript shows what the agent did, grouped per checkpoint, with a
  one-click **Undo this run** / **Undo to here**.
- For the rare `ask`, keep the minimal composer approval card already specified
  in `agent-permissions.md` — but now it appears seldom, so it carries weight.
- An absent human costs only the one truly-irreversible step that is waiting,
  not the whole run; everything reversible already happened and is undoable.

### What this removes

The simplification is the deliverable, not a side effect. If reversibility is
the gate, the following stop being load-bearing:

- once / session / always rule lifetimes (existed to cut repeat prompts);
- a persisted user allowlist + its management UI (existed to remember "always
  allow");
- the broad `ask` half of the policy matrix (collapses into "is it reversible?");
- per-tool risk scoring and "autopilot" toggles.

What remains is small and durable: redline `deny`, the reversible/irreversible
classifier, the checkpoint engine, and an undo surface.

## Open Questions

- **Snapshot scope & cost.** Per-touched-file copy-on-write vs a workspace-level
  `git stash`-style snapshot. What is the size/perf ceiling before a write
  becomes `ask`?
- **Snapshot lifetime.** How long are run checkpoints retained after the run
  ends, and where (memory, `userData`, alongside the event log)? Undo must
  survive at least until the user has plausibly reviewed the run.
- **Shell confinement.** Without a sandbox, how aggressively do we classify
  shell as side-effecting? Is a conservative allowlist of provably-read-only
  commands worth it, or does all non-trivial shell just `ask`?
- **`git commit`.** Local and arguably reversible (reset). Does it become
  `allow` once file/document undo is strong, or stay `ask` as durable history?
- **Reconciliation with `agent-permissions.md`.** Should that plan's matrix be
  rewritten as derived examples of this rule, or kept as the explicit policy
  table with this plan supplying the engine? (Owner decision; that file is not
  edited by this plan.)

## Implementation Checklist

1. Define `isReversible(action): boolean` in `src/main/agentPermissions.ts`,
   computed from tool name + resolved arguments + the checkpoint boundary, and
   fold it into the existing `allow | ask | deny` decision *below* redline deny.
2. Confirm every document-mutating agent tool participates in a labeled
   operation group; add grouping where missing.
3. Build the workspace file-snapshot checkpoint: snapshot-before-write, restore,
   and "snapshot impossible → ask" fallback. Cover create / overwrite / delete.
4. Add run-level checkpoint bookkeeping in `src/main/agentRuntime.ts`: open a
   checkpoint per step that mutates the boundary; expose restore-to-here.
5. Add the **Undo this run / Undo to here** surface to the agent transcript UI.
6. Keep the rare-`ask` path (the minimal composer card) wired through
   `approval.requested` / `approval.resolved`; verify the common reversible path
   never reaches it.
7. Tests asserting final behavior + reason from the reversibility classifier:
   reversible document edit → `allow`; in-workspace overwrite with snapshot →
   `allow`; overwrite when snapshot fails → `ask`; `git push` → `ask`; secret
   exfiltration → `deny` (redline beats any checkpoint); plus restore correctness
   tests for the file-snapshot engine.
