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

**Decision: extend our `AppendOnlySeqLog`** (`agentEventStore.ts:1733`) with a
structured diagnostic-event schema — **not** `electron-log`. The deciding factor
is the stated future of *scrubbed logs uploaded to a cloud platform*: that path's
hard, risky part is **reliable redaction**, and redaction is auditable only over
**structured, typed records** (an allow-list of which fields may leave), not over
a logger's free-text lines. Structured records also map ~1:1 onto a cloud event
model (level / message / fingerprint / tags), so "ship to cloud" later becomes a
transport + a redaction pass, not a re-model. `electron-log` would save one-time
plumbing (rotation, renderer transport, uncaught hooks) but we already have those
patterns (the memory log's `maybeCompactMemoryLog`; the preload IPC bridge), and
under the structured-only discipline the cloud future demands, its
casual-line-logging ergonomics mostly evaporate. No new dependency; consistent
with the event-sourced architecture (#152 spirit — diagnostics is a distinct
family from the domain event logs, but the same append-only mechanism).

- **Record schema (Sentry-event-shaped, upload-ready):** `{ ts, domain, severity,
  code?, fingerprint, message, context? }`. `fingerprint` is the **signature dedup**
  key (so the Dream 400 is one record reading "×N" with `count` + `firstAt` /
  `lastAt`, not N lines) **and** the future cloud dedup key.
- **Redaction at the write boundary:** an allow-list scrub runs **before** write,
  so what is stored locally is already what would ship — no "clean locally, leak
  on upload" drift. `message`/`context` length-capped.
- **Bounded + rotating** (mirror `maybeCompactMemoryLog`) so a flood can't grow
  the file unbounded. No back-compat reader pre-release (format change → wipe dev
  userData).
- **Future cloud upload — shape for it, do not build it (A7/YAGNI):** keep a
  conceptual transport seam, but ship **no uploader** now. Schema is upload-ready;
  the pipeline is a clean later follow-up if/when we decide to send.

### P4 — Find & send (the only user-facing surface)

**Logging is silent — no proactive prompt, badge, or toast, ever** (PM-ratified:
record quietly; the user is never interrupted). Analysis happens on **our** side,
so there is **no in-app dashboard** either. The only surface is a passive way to
hand us the log **when we ask for it**, in Settings:

- **"Reveal diagnostics log"** → `shell.showItemInFolder(logPath)` opens the log
  in Finder so the user can attach it.
- **"Export diagnostics…"** → a save dialog (or sanitized-clipboard copy via the
  allow-listed `clipboard-sanitized-write`) that bundles the recent log + minimal
  environment (app version, provider id, OS) into one artifact to send us.

No accumulation hint, no `fatal` interruption — uncaught/fatal records land in the
file like everything else; we pull them when we ask.

## Decisions (PM-ratified 2026-06-11)

- **Local-only, no remote platform / no egress.** Hand-off to us is
  user-initiated (find/export the log and send it). Rules out Sentry/GlitchTip.
- **Silent recording — no proactive user-facing signal of any kind** (no hint,
  badge, toast; `fatal` does not interrupt). The user is never bothered; we ask
  for the log when we need it.
- **No in-app dashboard.** Analysis is on our side; the only surface is
  find-&-send (P4).
- **Substrate = extend `AppendOnlySeqLog` with a structured, upload-ready schema**
  (not `electron-log`), chosen for the stated future of scrubbed cloud upload —
  redaction is auditable only over structured records (see P3).

## Open questions

None blocking. The only deferred item is the **cloud-upload pipeline itself**
(transport + opt-in + the send trigger), intentionally not built now (A7/YAGNI);
the schema is shaped so it is a clean later follow-up.

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
- [ ] P3 diagnostic log on `AppendOnlySeqLog` + structured upload-ready schema +
      fingerprint dedup + bounded rotation + write-boundary redaction; unit tests
      for dedup/cap/redaction.
- [ ] P4 Settings "Reveal diagnostics log" + "Export diagnostics…" (silent — no
      hint/badge/toast). Visual verification light + dark.
- [ ] Spec: add `docs/spec/error-observability.md` + register in
      `docs/spec/README.md`; fold this design in on ship.
