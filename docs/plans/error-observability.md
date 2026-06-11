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
(P1–P3)** vs **Surfacing (P4)** — but the plan ships as one feature.

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

- **No remote platform, no egress — local-only, full stop (PM-ratified
  2026-06-11).** No Sentry / GlitchTip / any error-tracking server, even
  self-hosted. The hand-off to us is **user-initiated**: when something looks
  wrong, the user finds/exports the local diagnostic log and sends it to us;
  analysis happens on our side. This is the design, not a "revisit later" — it
  rules out the otherwise-mature buy options (Sentry & friends are built around
  shipping events to a server) and is *why* we keep a small local subsystem.
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

### P3 — Local diagnostic log (the substrate)

A bounded, rotating, findable local log file that captures handled + unhandled
errors from both main and renderer. **Substrate is the one real build decision**
(settle at claim time; touches deps → infrastructure-ownership):

- **Option A — adopt `electron-log` (lean).** Mature, MIT, Electron-standard:
  main + renderer transports, size rotation, a documented log path, and built-in
  uncaught/rejection hooks (`log.errorHandler` / `log.catchErrors`). Treats
  diagnostics as *operational logging*, distinct from the event-sourced **domain**
  logs — so it does not contradict the #152 "one shared seq-log" rule (that rule
  is about the conversation/run/memory event logs, a different family). Cost: one
  new dependency (coordinate `package.json` / `bun.lock`). **Recommended** — the
  value here is a robust rotating file we can point a user at, which `electron-log`
  gives for almost nothing.
- **Option B — extend our `AppendOnlySeqLog`** (`agentEventStore.ts:1733`). No new
  dep, structured JSONL we already parse. Cost: we re-build rotation + the
  renderer→main transport + uncaught hooks that `electron-log` ships.

Either way: structured records `(domain, severity, code?, message, context?,
count, firstAt, lastAt)`; **signature dedup** so the Dream 400 is one line reading
"×N", not N lines; **length-capped + redacted** message/context (strip obvious
secrets/paths before write — the log may be sent to us); **bounded** size. No
back-compat reader pre-release (format change → wipe dev userData).

### P4 — Find & send (the only user-facing surface)

Because analysis happens on **our** side, there is **no in-app dashboard** — just
a way for the user to find the log and send it to us, in Settings:

- **"Reveal diagnostics log"** → `shell.showItemInFolder(logPath)` opens the log
  in Finder so the user can attach it.
- **"Export diagnostics…"** → a save dialog (or sanitized-clipboard copy via the
  allow-listed `clipboard-sanitized-write`) that bundles the recent log + minimal
  environment (app version, provider id, OS) into one artifact to send us.
- *(Optional, can defer)* a restrained "something went wrong — Settings →
  Diagnostics" hint when `error`/`fatal` records accumulate, so the user knows a
  log exists to send. No layout shift (B7); status color only (B4); respects
  reduced-motion/contrast (B8). If we skip it in v1, the fallback is simply
  telling the user where to look when we ask for a log.

## Decisions (PM-ratified 2026-06-11)

- **Local-only, no remote platform / no egress.** Hand-off to us is
  user-initiated (find/export the log and send it). Resolves the old Q4 and
  rules out Sentry/GlitchTip.
- **No in-app dashboard.** Analysis is on our side; the user-facing surface is
  just find-&-send (P4). Resolves the old "view home" / "user-vs-dev v1"
  questions.

## Open questions (remaining)

1. **Substrate** — adopt `electron-log` (Option A, recommended) or extend our
   `AppendOnlySeqLog` (Option B)? A reversible call but it touches deps
   (infrastructure-ownership); settle at build-claim time.
2. **In-app "go look" hint** — ship the optional P4 accumulation hint in v1, or
   skip it and just tell the user where the log is when we ask? (Leaning skip for
   v1.)
3. **`fatal` routing** — should an uncaught `fatal` ever surface to the user at
   all (a quiet "an error was logged" note), or stay silent in the file until we
   ask for it?

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
- [ ] P3 diagnostic log substrate (`electron-log` or `AppendOnlySeqLog`) +
      signature dedup + bounded rotation + redaction; unit tests for
      dedup/cap/redaction.
- [ ] P4 Settings "Reveal diagnostics log" + "Export diagnostics…"; (optional)
      accumulation hint. Visual verification light + dark.
- [ ] Spec: add `docs/spec/error-observability.md` + register in
      `docs/spec/README.md`; fold this design in on ship.
