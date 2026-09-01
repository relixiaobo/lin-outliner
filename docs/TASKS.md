# Tasks

This is the single live board across all clones. It owns active-work status,
priority, integration order, release gates, and a short recent-completion
window. Designs live in `docs/plans/`; current behavior lives in `docs/spec/`;
retrospectives live in `CHANGELOG.md` and merged PRs. Dev agents read this board
and claim work with a Draft PR but do not edit it. The main agent updates it at
integration.

The live collision radar is `gh pr list` plus this board. No implementation PR
was open at the 2026-08-29 audit. The current package version is `0.8.0`; the
latest published train is `v0.7.0`.

## In Flight

`agent-result-and-file-lifecycle` is the only open implementation PR (#607).
`outline-cli-skill-efficiency` shipped in #606, so the public Outline CLI and
built-in Skill lane is clear. `media-preview-polish` shipped in #605, so the
shared preview-shell lane is also clear. Startup Window, preview readers, and
Skill authoring remain independently eligible under their collision lanes. The
remaining plans from #588/#589 and #591 stay active below until their
implementation, spec fold, and archive move complete.

## Primary Delivery Queue

This queue is executable: **every row is one substantial, independently
reviewable PR and one active plan**. Internal build stages stay inside that PR.
The critical mechanism lane is linear; named consumers fan out only after their
last predecessor merges.

Each linked active plan is the complete execution authority for its claim.
Archived aggregate plans serve only as provenance records; an implementation
never depends on their retained detail or rejected reasoning to recover a
protocol, security rule, user flow, or acceptance criterion.

- `->` is a contract or same-plan predecessor: the successor consumes the
  predecessor's merged result.
- `~>` is a selected A7 collision order: the behavior may be independent, but
  the successor must target the predecessor's final shared mechanism.

```text
Critical mechanism lane:
  agent-result-and-file-lifecycle

Parallel now eligible:
  startup-window-first
  file-preview-office
  url-static-reader
  agent-skill-authoring-foundation -> agent-skill-curation-report
  agent-result-and-file-lifecycle (continues the critical lane)

Parallel after agent-result-and-file-lifecycle:
  agent-cross-thread-reference
  agent-root-turn-recovery ~> agent-delegated-failure-truth
  computer-pilot-managed-skill
```

| Priority | Plan / PR claim | Status | Eligible after |
| --- | --- | --- | --- |
| P1 | [agent-result-and-file-lifecycle](plans/agent-result-and-file-lifecycle.md) | `draft`, ratified in #588/#589 | **Now; Bash stdin shipped in #604**; all three build stages stay inside this PR |
| P1 | [agent-cross-thread-reference](plans/agent-cross-thread-reference.md) | `draft`, ratified in #589 | `agent-result-and-file-lifecycle` |
| P1 | [agent-root-turn-recovery](plans/agent-root-turn-recovery.md) | `draft` | `agent-result-and-file-lifecycle` by A7 collision order |
| P1 | [agent-delegated-failure-truth](plans/agent-delegated-failure-truth.md) | `draft` | `agent-root-turn-recovery` claim serialization |
| P2 | [startup-window-first](plans/startup-window-first.md) | `draft` | **Now; Desktop Host shipped in #603** |
| P2 | [file-preview-office](plans/file-preview-office.md) | `draft` | **Now; Desktop Host shipped in #603**; preview-shell lane clear |
| P2 | [url-static-reader](plans/url-static-reader.md) | `draft` | **Now; Desktop Host shipped in #603**; preview-shell lane clear |
| P2 | [agent-skill-authoring-foundation](plans/agent-skill-authoring-foundation.md) | `draft` | **Now; Desktop Host shipped in #603** |
| P3 | [agent-skill-curation-report](plans/agent-skill-curation-report.md) | `draft` | `agent-skill-authoring-foundation` |
| P3 | [computer-pilot-managed-skill](plans/computer-pilot-managed-skill.md) | `draft` | `agent-result-and-file-lifecycle` |

`agent-result-and-file-lifecycle` is the active primary-queue claim. Build-ready
work outside this queue remains independently claimable under its own collision
boundary. The Host composition, Bash stdin, and Outline CLI Skill foundations
are complete. Agent resource references, conversation workspaces/final
citations, and delegated handoff remain three foundation-first build stages
inside one atomic feature PR rather than three partial releases.

The split also absorbs three former planless tasks without losing their intent:

- `inline-media-alt-text` shipped across #598 and #599 as editable Node content
  plus direct intrinsic image presentation; the retired `mediaAlt` field receives
  no replacement command.
- `skill-directory-is-itself-a-skill` becomes the explicit binding identity in
  `agent-skill-authoring-foundation`, before script authoring consumes it.
- `computer-pilot-managed-skill` now has its own complete plan and waits for the
  final Host plus Agent resource lifecycle instead of targeting the #582 shape
  immediately before that shape is replaced.

Collision lanes remain claim-time constraints, not hidden graph edges:

- `file-preview-office`, `url-static-reader`, and the preview/translation units
  in Interaction Jank must not overlap on shared preview shell files; #605 is the
  merged baseline for every later claim.
- PR #604 settled Agent Bash stdin before Agent resource lifecycle because both
  rewrite Agent protocol/codec, `ToolPayloadStore`, context dependencies, Thread
  lifecycle, canonical-to-renderer projection, preload, and Host transport.
  Internal text remains a private Item dependency and never becomes a file
  resource.
- Cross-Thread Reference and Failure Recovery repeat the live file check after
  Agent resource lifecycle; a collision serializes claims but does not invent a
  semantic dependency between the two features.

## Other Active Plans

These plans are outside the primary chain. Any multi-PR aggregate here is
reshaped to claim-sized plans before implementation; this first pass deliberately
does not mix their product decisions into the architectural queue above.

| Priority | Plan | Status | Start condition and collision boundary |
| --- | --- | --- | --- |
| P2 | [interaction-jank-cleanups](plans/interaction-jank-cleanups.md) | `draft` | Definition-cache and Runtime-index units are eligible after #598; preview units use the live preview-shell lane. |
| P2 | [semantic-working-state](plans/semantic-working-state.md) | `draft` | Build-ready Settings-only tail. Thread/Plan `WorkingText` shipped in #531; this plan contains only Provider and managed-Skill consumers. |
| P3 | [floating-toolbar-polish](plans/floating-toolbar-polish.md) | `draft` | Heading toggle is build-ready and renderer-only. Atomic tagged extraction is eligible after #598. |
| P3 | [icon-semantics](plans/icon-semantics.md) | `draft` | Build-ready renderer mapping cleanup. Update action menu, launcher, picker, and attachment mappings together; status color is out of scope. |
| P3 | [performance-optimization](plans/performance-optimization.md) | `draft` | Three measured tails only. Core mutation indexes are eligible after #598; filename-fallback reuse and text normalization are independent. |
| P3 | [dark-mode-contrast-pass](plans/dark-mode-contrast-pass.md) | `draft` | Runs last after active visual consumers. #377's tertiary lift is shipped; only rendered failures justify further token changes. |

## Small And Release Work

These items have no active plan file. Each is a complete fast-track change or a
verification gate; create a plan only if implementation discovers a significant
contract or user-visible decision.

### Release gates

- **Agent persisted-schema cutover verification** (release gate) — before the
  next packaged train, stop every Tenon process, manually reset installed and
  clone-scoped pre-#604 Agent stores, and verify fresh packaged/dev first launch.
  This covers the input-author and context dependency-manifest cuts; no migration
  or automatic deletion ships.
- **Launcher NSPanel packaged verification** — one `.dmg` pass for Cmd+Tab,
  fullscreen floating, focus, dock icon, and light/dark behavior.

### Build-ready product tails

- **dual-auth-clarity** (P3) — use the existing dual-auth provider capability
  set to show an explicit API key/OAuth segmented choice; single credential
  ownership remains unchanged.
- **agent-hygiene-checks** (P3) — add untrusted-data framing to current web-fetch
  model input and a bounded same-action/same-result repetition notice.
- **i18n-followups** (P3) — add plural rules, route remaining date/number sites
  through locale-threaded formatters, then add languages only with complete
  surface coverage.
- **reference-index-compaction-tails** (P3) — replace fixed-unit cooperative
  yielding with a wall-time budget and queue an `@` selection while display
  reachability resolves.

### Reliability and maintenance tails

- **ThreadTurnView render-body refs** (P3) — latch `turnRef`,
  `responseTailTurnRef`, and `contentGrouperRef` after commit so abandoned React
  renders cannot advance event-handler state.
- **Renderer trash predicate convergence** (P3) — route both active table-field
  predicates through the projection-aware `isNodeInTrash` authority.
- **Flaky Bash host-environment test** (P3) — make wait helpers throw named
  timeout errors and use an appropriate background-process deadline; the full
  suite currently exposes load-dependent failures.
- **Update-check review tail** (P3) — architecture-select DMGs, separate release
  and changelog timeouts, guard toggle rollback against newer state, and cache
  negative release-note lookup.
- **Backlink/query review tests** (P3) — cover field-kind backlinks, Agent
  `include_backlinks`, ref-role allowlist behavior, and case-fold edges; do not
  merge semantically different tokenizers.
- **E2E visual-media baseline fixture** (P3) — make the five emulated media
  preferences the suite default with an explicit opt-out for preference tests.
- **Run-dependent E2E stabilization** (P2) — treat the changing failure set as
  one isolated-port/worktree problem; do not board individual red specs from a
  handful of samples.
- **Agent truncation dialects** (P3) — unify the three forensic text/payload
  markers while listing unrelated ingestion markers as deliberate.
- **Smoke-suite repair and freeze wiring** (P2) — repair the deterministic
  real-Electron subset, separate network cases, and wire boot coverage into the
  release freeze and command table.
- **Plan reference guard** (P3) — extend `docs:check` from line-reference
  rejection to resolving durable symbol/test-title references in active
  authorities.
- **Scripts and tests typecheck coverage** (P3) — add dedicated TypeScript
  projects or equivalent coverage for both directories and fix the first real
  failures rather than excluding them.

## Shelved And Standing Decisions

- **agent-self-modification** (`shelved`) — the old configuration-tool/hook plan
  described removed tools and an incorrect extension-hook gap. Reopen only after
  the PM chooses the self-configuration capability boundary and a clean
  validated file-edit design. Path not taken:
  [agent-self-modification](plans/archive/agent-self-modification.md).
- **agent-generative-ui** (`shelved`) — bounded inline widgets still require a
  PM decision on script execution, CSP/bridge authority, state persistence, and
  export. The archived design also split protocol groundwork from the usable
  feature and must be reshaped before approval:
  [agent-generative-ui](plans/archive/agent-generative-ui.md).
- **launcher-provider-expansion** (`shelved`) — URL-only labels for authenticated
  apps are not automatically valuable, native readers have separate TCC and
  product boundaries, and #598 replaced the capture resource contract.
  Choose one complete provider capability before rewriting:
  [launcher-provider-expansion](plans/archive/launcher-provider-expansion.md).
- **signed-builds-and-auto-update** (`shelved`, external gate) — requires Apple
  Developer membership, signing, and notarization before background update is
  technically possible.
- **macOS Liquid Glass icon** (`shelved`) — requires an Icon Composer design and
  Xcode 26 packaging dependency; recipe retained in
  [macos-liquid-glass-icon](plans/archive/macos-liquid-glass-icon.md).
- **Windows secret ACL hardening** (`shelved`) — reopen when Windows becomes a
  supported target; macOS remains the supported platform.
- **legacy-agent-program** (`superseded`) — the Conversation/Run/EventStore
  program was delivered, then replaced by the current Agent Core
  Thread/Turn/Item architecture. Its old protocol reservations and unchecked
  milestone tails are not active work. Historical records:
  [agent-program](plans/archive/agent-program.md),
  [agent-conversation-model](plans/archive/agent-conversation-model.md), and
  [agent-data-model](plans/archive/agent-data-model.md).
- [agent-memory-foundations](plans/reference/agent-memory-foundations.md) and
  [nodex-parity-decisions](plans/reference/nodex-parity-decisions.md) are
  standing authorities, not implementation units.
- [browser-extension-integration](plans/reference/browser-extension-integration.md)
  records the explicit internal Preview reader boundary; it is not approved
  external-browser integration work.

## Recently Completed

One line per recent shipped integration. Older history and review detail live in
[CHANGELOG.md](../CHANGELOG.md) and merged PRs.

- **outline-cli-skill-efficiency** (`done`, #606, 2026-09-01) — the public CLI
  gained compact complete-resource input, typed bounded receipts, exact schema
  recovery, view inspection, and bounded watch resync while the built-in Skill
  moved to one porcelain-first mutation plus narrow verification; plan archived
  at [outline-cli-skill-efficiency](plans/archive/outline-cli-skill-efficiency.md).
- **media-preview-polish** (`done`, #605, 2026-08-31) — Source actions now
  reveal without reflow while direct audio and video share one responsive Media
  Chrome HUD, scoped shortcuts, and viewport-filling video fullscreen; plan
  archived at [media-preview-polish](plans/archive/media-preview-polish.md).
- **agent-bash-stdin-transport** (`done`, #604, 2026-08-31) — Bash gained exact
  bounded foreground stdin over Thread-private large-text dependencies with
  canonical replay, renderer projection, and complete fork/prune lifecycle;
  plan archived at
  [agent-bash-stdin-transport](plans/archive/agent-bash-stdin-transport.md).
- **desktop-host-cutover** (`done`, #603, 2026-08-31) — the final typed
  `DesktopHost` now owns startup, race-safe quit/Cancel arbitration, reversible
  effects, and ordered cleanup while `main.ts` retains fixed Electron bootstrap;
  plan archived at [desktop-host-cutover](plans/archive/desktop-host-cutover.md).
- **host-platform-composition** (`done`, #602, 2026-08-31) — Electron-native
  resource, preview, window, and application ownership moved behind typed
  platform Hosts with explicit release and complete-tree audits; plan archived
  at [host-platform-composition](plans/archive/host-platform-composition.md).
- **outline-source-preview** (`done`, #599, 2026-08-31) — ordinary Outline
  Sources gained preview-first composition, type-specific image/media/web
  presentation, stable marker/guide geometry, and exact bare-URL paste; plan
  archived at [outline-source-preview](plans/archive/outline-source-preview.md).
- **host-domain-composition** (`done`, #601, 2026-08-30) — Agent and Outline
  backend graphs moved behind narrow typed Hosts with explicit lifecycle and a
  complete-tree construction audit; plan archived at
  [host-domain-composition](plans/archive/host-domain-composition.md).
- **host-transport-ownership** (`done`, #600, 2026-08-30) — every desktop IPC,
  protocol, session, and process-lifetime transport effect gained one named,
  idempotently disposable owner plus a reproducible baseline audit; plan
  archived at
  [host-transport-ownership](plans/archive/host-transport-ownership.md).
- **outline-source-model** (`done`, #598, 2026-08-30) — URLs, files, and managed
  media became ordinary Nodes with editable built-in URI field values and exact
  Host/asset authority; plan archived at
  [outline-source-model](plans/archive/outline-source-model.md).
- **agent-composer-input-history** (`done`, #587, 2026-08-29) — exact-Thread
  reader input recall, structured references/attachments, author trust, and
  renderability shipped; plan archived at
  [agent-composer-input-history](plans/archive/agent-composer-input-history.md).
- **outliner-runtime-recovery** (`done`, #592, 2026-08-28) — restored complete
  desktop, durability, Memory, asset, ranking, and lifecycle responsibilities;
  plan archived at
  [outliner-runtime-recovery](plans/archive/outliner-runtime-recovery.md).
- **outliner-runtime-cli** (`done`, #584, 2026-08-27) — standalone Runtime,
  transactional recovery, public CLI, and neutral ContentStore shipped; plan
  archived at [outliner-runtime-cli](plans/archive/outliner-runtime-cli.md).
- **reference-uri-unification** (`done`, #590, 2026-08-26) — canonical Node/file
  reference URI codec and complete cutover shipped; plan archived at
  [reference-uri-unification](plans/archive/reference-uri-unification.md).
- **composer-large-paste-attachment** (`done`, #586, 2026-08-24) — large text
  pastes became managed linked attachments; plan archived at
  [composer-large-paste-attachment](plans/archive/composer-large-paste-attachment.md).
- **agent-tool-artifact-resources** (`done`, #582, 2026-08-23) — durable
  execution-scoped tool artifacts and lifecycle shipped; plan archived at
  [agent-tool-artifact-resources](plans/archive/agent-tool-artifact-resources.md).
