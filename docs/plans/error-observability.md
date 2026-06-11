---
status: draft
priority: P2
owner: unassigned
created: 2026-06-11
updated: 2026-06-11
---

# Error observability — collect, aggregate, and surface runtime failures

**Shape: (a) ONE complete feature in one PR** (the PM's call: land the whole
error-observability subsystem together). Any "phases" below are *build order
within that one PR* (A7 foundation-before-consumers), not separate releases. If
the diff grows past comfortable review, the natural split seam is **Foundation
(P1–P3)** vs **Surfacing (P4–P5)** — but the plan ships as one feature.

> **Who builds it.** A dev clone claims and builds this; the main agent only
> gates it. Drafting this plan does not make it main's to implement.

## Why now

The Dream `prompt_cache_key` bug (#188) and its flood (#189/#190) are the
textbook symptom of the gap: the provider returned HTTP 400 on **every** Dream,
the runtime *caught* it and `console.warn`-ed, and a `failed` run was written to
the ledger every 60 s — yet nobody noticed until it was hunted down by hand. The
defect was never "uncaught"; it was **caught and silenced**. #189's backoff
treated the *symptom* (flood volume). This plan treats the *cause*: a caught
failure that degrades behavior must also become **visible and aggregatable** in
one place a human or a dev agent looks.

### Current state (what we already collect, and the holes)

| Error source | Today | Visibility |
|---|---|---|
| Foreground (chat context) | `emitError(conversationId, msg)` → renderer `type:'error'` (~20 sites) | ✅ user sees it in-conversation |
| Background / scheduled (Dream, command scheduler) | `console.warn(…)` (agentRuntime ×4, main ×6) | ❌ terminal only — **this is the hole that bit us** |
| Run outcomes | `failed` status + `errorMessage` in the run ledger (`listPrincipalRunMetaProjections`) | ⚠️ per-principal, no aggregation, no overview |
| Unexpected throw / unhandled rejection | *nothing* — no `uncaughtException` / `unhandledRejection` / `window.onerror` | ❌ fully invisible (only SIGINT/SIGTERM quit hooks exist) |

So the missing pieces are: **(1) one reporting choke point, (2) a global safety
net, (3) an append-only aggregating store, (4) a surface a human/agent reads.**

## Goal

A failure anywhere in the app — handled-but-degrading, unhandled, foreground, or
background — lands as a structured, deduplicated record in one local log, and is
legible without reading the terminal. "Something feels off" becomes a structured
artifact a dev agent can root-cause.

## Non-goals

- **No cloud telemetry / crash-reporting SaaS.** Local-first + the privacy
  posture (agent memory and conversations are sensitive; A3 keeps no spare
  network egress) mean nothing is sent anywhere. Revisit only when there are real
  external users — and then opt-in + content-scrubbed. Designing a remote
  pipeline now violates A7 (building against a mechanism we will not ship).
- **No replacement of `emitError`.** The foreground in-conversation error channel
  stays; reporting is *additional* (and `emitError` sites also report).
- **No automatic remediation.** Backoff/retry policy is per-subsystem (cf. the
  Dream backoff); this subsystem observes, it does not self-heal.
- **No new heavy dependency.** Reuse the existing seq-log primitive and surface
  infrastructure.

## Design

### P1 — One reporting choke point (`reportError`)

A single main-process entry: `reportError(report: ErrorReport)` where
`ErrorReport = { domain, severity, code?, message, context?, error? }`.

- `domain`: `'dream' | 'command' | 'agent-tool' | 'provider' | 'persistence' |
  'render' | 'uncaught' | …` (string union, extended as needed).
- `severity`: `'warn' | 'error' | 'fatal'`.
- `context`: small **structured** metadata only (ids, counts, status codes) —
  **never** raw conversation/document content (privacy; see P3).
- Replaces the scattered `console.warn` in background paths (Dream `fireDream`
  catch, command scheduler, persistence). `emitError` call sites *also* call
  `reportError` so foreground failures are aggregated too, not just shown once.

This is the **foundation** (A7): settle the reporting seam before any store or
view is built on it.

### P2 — Global safety net

Install in main: `process.on('uncaughtException')` and
`process.on('unhandledRejection')` → `reportError({domain:'uncaught', severity:'fatal', …})`.
In the renderer: `window.onerror` / `window.onunhandledrejection` → bridge to
`reportError` over a new preload IPC channel (contextIsolation-safe; the bridge
is the only seam — A2). Catches the unknown-unknowns the typed paths miss.

### P3 — Append-only diagnostic log (reuse the shared seq-log)

A third instance of the existing `AppendOnlySeqLog<TEvent>`
(`agentEventStore.ts:1733`) — **not** a parallel implementation (the #152
decision: one shared append-only seq-log primitive across conversation / run /
memory; this is its fourth consumer). Stored in `userData` beside the agent
logs.

- **Dedup/aggregation by signature.** Key on `(domain, code, message-shape)`;
  collapse repeats into one record with `count` + `firstAt` / `lastAt`. The Dream
  400 would be **one** entry reading "×N", not N lines — the aggregation is the
  point.
- **Bounded.** Cap entries (ring/compaction like the memory log's
  `maybeCompactMemoryLog`) so a flood can't grow the file unbounded.
- **Privacy.** `message`/`context` are length-capped and structured; a redaction
  pass strips obvious secrets/paths before write. Pre-release we carry no
  back-compat reader — a format change wipes `~/.lin-outliner-*` dev userData
  (storage-format rule).

### P4 — Surfacing (read path)

- A **diagnostics view**: either a new `?surface=diagnostics` window
  (`src/renderer/main.tsx` surface routing) or a section under the existing
  `settings` surface — a reverse-chronological, grouped list of diagnostic
  records (domain, severity, count, last-seen, expandable detail) that also folds
  in `failed` run-ledger entries. Dev-facing first; honors the design system
  (status colors carry status meaning only — B4; neutral functional state — B3).
- A **status signal**: a restrained indicator (rail/status area) when unseen
  `error`/`fatal` records accumulate, cleared on view. No layout shift on state
  change (B7); respects reduced-motion/contrast (B8).

### P5 — "Copy diagnostics" bundle

A user-initiated action that serializes the recent diagnostic log + environment
(app version, provider id, OS) into a copyable bundle — the structured artifact
the PM hands to a dev agent to root-cause. **User-initiated and user-visible
only**; never auto-uploaded (A3). Goes through the sanitized-clipboard path
already in the permission allow-list (`clipboard-sanitized-write`).

## Open questions (need PM direction)

1. **Diagnostics view home** — its own `?surface=diagnostics` window, or a tab
   inside Settings? (Own window = cleaner separation, more chrome work; Settings
   tab = cheaper, but Settings gets busy.)
2. **User-facing vs dev-facing v1** — is the first cut just for us (the PM + dev
   agents reading a log/bundle), or already polished for the eventual end user
   (gentle, non-alarming surfacing)? Affects how much P4 UI polish v1 carries.
3. **Severity routing** — should `fatal` (uncaught) ever interrupt the user
   (toast/modal), or always stay passive in the diagnostics surface?
4. **Confirm local-only-now** — assumed yes (Non-goals). Veto if you want a
   remote hook designed-for (not built) from day one.

## Sequencing / collisions

- **#184 (`cc-2/agent-run-unification`)** is broadly rewriting `agentRuntime.ts`,
  including the catch-sites P1 would touch. **Build this AFTER #184 lands**, or
  coordinate an interface-only `reportError` signature PR first
  (shared-interface-first). Flag at claim time.
- The preload IPC channel for renderer→main error bridging touches the
  protocol/preload seam (infrastructure-ownership) — land its interface
  deliberately, not as a drive-by.

## Build order (within the one PR)

- [ ] P1 `reportError` seam + replace background `console.warn`; `emitError`
      sites also report. (Foundation.)
- [ ] P2 global `uncaughtException` / `unhandledRejection` / `window.onerror`
      handlers → `reportError`.
- [ ] P3 diagnostic `AppendOnlySeqLog` instance + signature dedup + bounded
      compaction + redaction; unit tests for dedup/cap/redaction.
- [ ] P4 diagnostics view (incl. failed-run fold-in) + status signal; visual
      verification light + dark.
- [ ] P5 copy-diagnostics bundle via sanitized clipboard.
- [ ] Spec: add `docs/spec/error-observability.md` + register in
      `docs/spec/README.md`; fold this design in on ship.
