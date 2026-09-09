# Tasks

This is the single live board across all clones. It owns active-work status,
priority, integration order, release gates, and a short recent-completion
window. Designs live in `docs/plans/`; current behavior lives in `docs/spec/`;
retrospectives live in `CHANGELOG.md` and merged PRs. Dev agents read this board
and claim work with a Draft PR but do not edit it. The main agent updates it at
integration.

The live collision radar is `gh pr list` plus this board. At the 2026-09-05
audit, the Settings design revision shipped in PR #626. Internal Agent
delegation and legacy retirement shipped in PR #628; the external Runner
adapter feature shipped in PR #637; the Skill identity and authoring foundation
shipped in PR #641; Memory operations shipped in PR #647. The current package version is `0.8.0`;
the latest published train is `v0.7.0`.

## In Flight

PRs #653 and #654 integrated the startup-recovery and unified-record designs.
Execution is now three complete plans: startup fault isolation, unified session
records, and targeted conversation recovery. The original recovery aggregate is
archived as provenance; each active plan carries its own full contract. The
record plan separates historical originals from new reading-Thread image/PDF
observations. Runtime behavior has not shipped. Record-discovery eligibility
remains gated on the explicit product decision in that plan's OQ-1.

Verification Unit C shipped in #655 and Git publication Unit D in #657; both
plans are archived. Settings Unit G is claimed by #656. Complete Settings G
and workbench execution/process Unit E before starting the recovery/records
implementation queue. Planning and
read-only collision checks need not wait for those merges.

PR #639 approved the capability-first development workbench design; #645 revised
its cache/publication contract. Unit A shipped in #646 as one complete
execution-context refactor over the shipped delegation/native-launcher and
Settings mechanisms, including frozen publication boundaries, scoped reduction,
and compaction restore. PR #649 shipped Unit B's bounded discovery, immutable
successor delivery, and freshness validation; PR #651 completes its optional
Project catalog, confirmed membership, deletion fencing, and Project-backed
Automation hints. Unit C's source-bound verification and bounded correction
shipped in #655 over that context/profile mechanism. Unit D's reviewed commits
and explicit publication shipped in #657. The Unit B-D plans are archived;
the aggregate plan and Unit E remain active under their own prerequisites and
collision checks.

PR #628 shipped internal Agent delegation and complete Subagent/isolated-Skill
retirement under the design merged in #620. Generic Background Tool Tasks
shipped in #623, and the external Runner adapter feature shipped in #637. The
legacy delegation behavior is retired and overlapping claims must use the final
delegation mechanisms.

PR #629 completed window-first startup. The Agent Host composition shipped in
#628 preserves the owning readiness boundaries and recoverable startup behavior
in [Desktop Host lifecycle](spec/architecture.md#desktop-host-lifecycle).

PR #626 shipped the file-first Settings design revision. PR #636 now ships Unit
A: file-backed preferences, schema/status/recovery, global Skill/tool controls,
and the configuration Skill. PR #638 now ships Unit B: file-backed model
connections, model declarations, and default model selection. PR #640 now ships
Unit C: layered root Agent configuration, source inspection/schema discovery,
JSONC-preserving edits, and public delegation policy. PR #643 ships Skill
declarative settings ownership; Unit D's Agent-facing lifecycle/provenance
operations shipped in #644, E1 Memory operations shipped in #647, E2 preview
translation/data operations shipped in #648, and E3 application/diagnostics
operations shipped in #650. Unit F's configurable shortcuts shipped in #652.
Unit G is now eligible under its declared collision checks.
The aggregate plan remains their design authority under its dependency and
collision checks.

Trajectory paging shipped in #625 and exact-or-unavailable evidence completed
in #627; the plan is archived and its shared-file claim is released. Bounded
summaries remain navigation aids, not forensic evidence authority. Link/preview
interaction polish shipped in #621 and released the shared preview-shell lane.
The remaining primary queue is eligible under its live collision checks,
including the released Agent and Skill ownership from #628. The remaining plans
stay active until their implementation, spec fold, and archive move complete.

## Primary Delivery Queue

This queue is executable: **every row is one substantial, independently
reviewable PR and one active plan**. Internal build stages stay inside that PR.
Named consumers fan out only after their last predecessor merges; collision-
ordered pairs remain linear.

Each linked active plan is the complete execution authority for its claim.
Archived aggregate plans serve only as provenance records; an implementation
never depends on their retained detail or rejected reasoning to recover a
protocol, security rule, user flow, or acceptance criterion.

- `->` is a contract or same-plan predecessor: the successor consumes the
  predecessor's merged result.
- `~>` is a selected A7 integration order: the behavior may be independent, but
  the successor must target the predecessors' final mechanisms. A series-level
  edge includes all approved delivery units, not only its currently open PRs.

```text
Parallel now eligible:
  file-preview-office
  url-static-reader
  computer-pilot-managed-skill

Selected integration order:
  Settings G (#656) ~> startup-fault-isolation
  Workbench A-E (remaining D, E) ~> startup-fault-isolation
  startup-fault-isolation ~> unified-session-records ~> targeted-thread-recovery

Capability prerequisite:
  startup-fault-isolation -> targeted-thread-recovery
```

| Priority | Plan / PR claim | Status | Eligible after |
| --- | --- | --- | --- |
| P1 | [startup-fault-isolation](plans/startup-fault-isolation.md) | `draft` | After Settings G and all approved workbench A-E units (remaining D, E); consume final Host, admission and restart ownership |
| P2 | [unified-session-records](plans/unified-session-records.md) | `draft` | After startup fault isolation over the completed workbench series; cover C/D/E evidence and settle OQ-1 before claiming implementation |
| P2 | [targeted-thread-recovery](plans/targeted-thread-recovery.md) | `draft` | After startup issue/lifecycle and unified source/provenance/publication mechanisms; one complete verified rebuild/removal feature |
| P2 | [file-preview-office](plans/file-preview-office.md) | `draft` | **Now; Desktop Host shipped in #603**; preview-shell lane clear |
| P2 | [url-static-reader](plans/url-static-reader.md) | `draft` | **Now; Desktop Host shipped in #603**; preview-shell lane clear |
| P3 | [computer-pilot-managed-skill](plans/computer-pilot-managed-skill.md) | `draft` | **Now; Agent resource lifecycle shipped in #607** |

The Host composition, Bash stdin, Outline CLI Skill, Agent resource,
Cross-Thread Reference, root-Turn recovery, and delegated-failure-truth
foundations are complete. The managed Computer Pilot Skill may proceed under
its live collision check. Build-ready work outside this queue remains
independently claimable under its own collision boundary.

The split also absorbs three former planless tasks without losing their intent:

- `inline-media-alt-text` shipped across #598 and #599 as editable Node content
  plus direct intrinsic image presentation; the retired `mediaAlt` field receives
  no replacement command.
- `skill-directory-is-itself-a-skill` shipped as the explicit binding identity in
  PR #641, completing the Skill authoring foundation before curation consumes it.
- `computer-pilot-managed-skill` now has its own complete plan and consumes the
  final Host plus Agent resource lifecycle; both foundations are complete.

The series-level boundary avoids revisiting startup readiness, record source
coverage, and recovery closure as workbench producers change. C owns check and
attempt evidence; D adds review manifests and durable publication outcomes;
E settles isolation receipts and interactive-process ownership, captures and
restart behavior. The new sequence consumes all three, not just #655.

This is a delivery order, not a claim that each workbench feature is required
to display a startup error. Workbench completion means the approved A-E units
have shipped, including E's bounded experiment and its recorded outcome. A
possible later native terminal, additional sandbox backend, or other follow-up
proposal does not extend this gate. C/D/E retain their own prerequisites and
live collision checks; the series-level edge does not invent C -> D -> E.

Collision lanes remain claim-time constraints alongside the selected order:

- #656 settles shared Host/preload and domain destinations before startup fault
  isolation rewires fallible construction and failure routes. Workbench C/D/E
  settle task/runtime evidence and process lifecycle before that new sequence.
  Actual file overlap still requires a claim-time check with exact symbols;
  the selected series order does not depend on an open PR already listing it.
- Workbench C/D/E consume Tool Tasks, execution context, and original evidence;
  they precede the new sequence and do not wait for readable record files.
  Those files cannot authorize a current check pass, commit, process adoption
  or sandbox claim. Further delegation retains its own collision check and
  hidden-session discovery boundaries.
- `file-preview-office`, `url-static-reader`, and the preview/translation units
  in Interaction Jank must not overlap on shared preview shell files; #605 is the
  merged baseline for every later claim.
- PR #604 settled Agent Bash stdin before Agent resource lifecycle because both
  rewrite Agent protocol/codec, `ToolPayloadStore`, context dependencies, Thread
  lifecycle, canonical-to-renderer projection, preload, and Host transport.
  Internal text remains a private Item dependency and never becomes a file
  resource.
## Other Active Plans

These plans retain their own delivery contracts. Settings and the workbench
series supply the predecessors above; the other plans keep their separate
start conditions. Any multi-PR aggregate is reshaped to claim-sized plans
before implementation.

| Priority | Plan | Status | Start condition and collision boundary |
| --- | --- | --- | --- |
| P1 | [project-development-workbench](plans/project-development-workbench.md) | `in-progress` | Design approved in #639 and revised in #645. Unit A shipped in #646, B in #649/#651, C in #655, and D in #657. Complete remaining E under its prerequisites/collision checks before the recovery/records queue. |
| P1 | [project-context-runtime](plans/archive/project-context-runtime.md) | `done` | Bounded discovery, immutable successor delivery, freshness validation, and restart recovery shipped in #649; optional Project catalog, confirmed membership, deletion fencing, and Project-backed Automation hints completed in #651. |
| P1 | [verification-self-iteration](plans/archive/verification-self-iteration.md) | `done` | Source-bound checks, finite correction budgets, retained evidence, and delegation-aware mutation fencing shipped in #655. |
| P2 | [git-review-publication](plans/archive/git-review-publication.md) | `done` | Reviewed selected-file commits, immutable evidence, and explicit push/PR publication with remote reconciliation shipped in #657. |
| P2 | [execution-sandbox-process](plans/execution-sandbox-process.md) | `draft` | Unit A prerequisite shipped; truthful isolation receipts and the bounded interactive-process experiment precede the recovery/records queue. Recheck process/receipt collisions before claiming. |
| P1 | [agent-delegation-runtime](plans/agent-delegation-runtime.md) | `in-progress` | Generic Tool Tasks Unit 1 shipped in #623, internal delegation plus Subagent/isolated-Skill retirement shipped in #628, and the external Runner adapter feature shipped in #637. Remaining work follows the aggregate plan's declared boundaries. |
| P2 | [settings-control-plane](plans/settings-control-plane.md) | `in-progress` | Units A-F are shipped, with F in #652. #656 claims Unit G's final discovery/domain-manager cut; it precedes startup fault isolation on shared Host/preload/routes and does not wait for recovery. |
| P2 | [interaction-jank-cleanups](plans/archive/interaction-jank-cleanups.md) | `done` | PR-1 chrome scroll batching shipped in #630, PR-2 definition caches in #632, the Runtime-index unit shipped in #633, and PR-3 translation geometry shipped in #634. |
| P2 | [semantic-working-state](plans/semantic-working-state.md) | `draft` | Settings redesign landed in #626; Provider/managed-Skill working-state behavior is absorbed by Units B and D, so claim it through those units rather than as a separate implementation. |
| P3 | [floating-toolbar-polish](plans/floating-toolbar-polish.md) | `draft` | Heading toggle is build-ready and renderer-only. Atomic tagged extraction is eligible after #598. |
| P3 | [icon-semantics](plans/archive/icon-semantics.md) | `done` | Shipped in PR #631: semantic Iconoir presentation and renderer tool-summary cleanup. |
| P3 | [performance-optimization](plans/performance-optimization.md) | `draft` | Three measured tails only. Core mutation indexes are eligible after #598; filename-fallback reuse and text normalization are independent. |
| P3 | [dark-mode-contrast-pass](plans/dark-mode-contrast-pass.md) | `draft` | Runs last after active visual consumers. #377's tertiary lift is shipped; only rendered failures justify further token changes. |

## Small And Release Work

These items have no active plan file. Each is a complete fast-track change or a
verification gate; create a plan only if implementation discovers a significant
contract or user-visible decision.

### Release gates

- **Persisted-schema cutover verification** (release gate) — before the next
  packaged train, stop every Tenon process, manually reset installed and clone-
  scoped pre-#649 Agent stores plus pre-#619 Outline storage-v2 workspaces, and
  verify fresh packaged/dev first launch. This covers the input-author, context
  dependency-manifest, unified Agent resource-reference, whole-Turn
  `history/rerun` event-name, #611 user-view/additional-context payload-shape,
  #619 required Operation-intent identity, and #646/#649 execution-context
  snapshot shape cuts (including series and capture identity); no migration or
  automatic deletion ships.
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

- **startup-data-recovery aggregate** (`superseded`, #653/#654) - execution
  authority is now the three complete plans in the primary queue; the
  [original recovery design](plans/archive/startup-data-recovery.md) is provenance,
  not an implementation prerequisite. No recovery runtime is marked shipped.
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

- **git-review-publication** (`done`, #657, 2026-09-09) - reviewed selected-file commits, immutable evidence, and explicit push/PR publication with remote reconciliation shipped; [plan archived](plans/archive/git-review-publication.md).
- **verification-self-iteration** (`done`, #655, 2026-09-08) - source-bound checks, bounded correction, evidence recovery and delegation-aware mutation fencing shipped; [plan archived](plans/archive/verification-self-iteration.md).
- **recovery/records design integration** (`done`, #653/#654, 2026-09-08) - three complete plans define startup isolation, unified records and targeted recovery after Settings G and workbench A-E; runtime remains pending.
- **settings-control-plane Unit F** (`done`, #652, 2026-09-08) - public keybindings, the Keyboard Shortcuts editor, live handlers/hints, conflict-safe native replacement, and restart recovery shipped; Unit G remains in the active aggregate plan.
- **project-context-runtime complete** (`done`, #651, 2026-09-08) - optional Projects, confirmed Chat grouping and lineage inheritance, durable deletion fencing, immutable Automation hints, and stale Runtime startup recovery shipped; [plan archived](plans/archive/project-context-runtime.md).
- **project-context-runtime discovery** (`done`, #649, 2026-09-08) - bounded scoped discovery, immutable successor publication, foreground evidence retention, Git/source freshness validation, and paged restart recovery shipped; Project catalog/lifecycle completed in #651.
- **settings-control-plane Unit E3** (`done`, #650, 2026-09-08) - people and root Agents share bounded application/release/update inspection, fixed support destinations, and local diagnostics reveal/export through the Host; Unit G remains in the active aggregate plan.
- **workbench context-publication design gate** (`done`, #645, 2026-09-07) - approved immutable model-facing publications, scoped baselines, and compaction recovery across the plan series; runtime delivery followed in #646 and #649.
- **project-development-workbench Unit A** (`done`, #646, 2026-09-07) - task-owned execution context, scoped admission and receipts, canonical publication/compaction recovery, Thread consumers, delegation/native launchers, Automation dispatch, and renderer details are shipped; Unit E remains active after B completed in #651, C in #655, and D in #657.
- **project-development-workbench design gate** (`done`, #639, 2026-09-07) - approved task-scoped execution, context, verification, publication, and process designs; implementation followed in #646, #649/#651, #655 and #657, with Unit E remaining.
- **skill-declarative-settings** (`done`, #643, 2026-09-07) - Skill-owned file-backed read/update routes preserve source spelling and queued toggle state; the dependent Unit D lifecycle/provenance work shipped next in #644.
- **skill-lifecycle-operations** (`done`, #644, 2026-09-07) - root-only Skill inspection and management tools now share the Host-owned lifecycle with the Settings Library, use revision/hash-bound targets and native human review, and preserve governed one-step Agent edit undo; [plan archived](plans/archive/skill-lifecycle-operations.md).
- **memory-operations** (`done`, #647, 2026-09-07) - people and root Agents now share bounded Memory inspection, native-confirmed exact-target Reset with durable recovery, saved-search opening, and revision-guarded per-Thread mode controls; [plan archived](plans/archive/memory-operations.md).
- **preview-translation-data-operations** (`done`, #648, 2026-09-08) - preview-local translation controls, native-confirmed saved-translation and website-data clearing, and root-Agent inspection/management tools now share Host-owned lifecycle and revision boundaries; [plan archived](plans/archive/preview-translation-data-operations.md).
- **agent-skill-curation-report** (`done`, #642, 2026-09-06) - Settings now offers an opt-in, read-only report over the loaded Skill registry; unchanged user/project Skills with reliable Agent-write provenance are analyzed for broken or root-escaping Markdown resources, exact content duplicates, and retired tool names, while excluded sources and hashes remain visible; [plan archived](plans/archive/agent-skill-curation-report.md).
- **agent-skill-authoring-foundation** (`done`, #641, 2026-09-06) - local Skill sources now persist explicit `skill` or `container` modes, exact Skill bindings stay scoped to the selected directory, and discovery, reload, authoring, and unbind share that identity; [plan archived](plans/archive/agent-skill-authoring-foundation.md).
- **settings-control-plane Unit A** (`done`, #636, 2026-09-05) - file-backed JSONC preferences, schema/status/recovery, global Skill/tool controls, and the configuration Skill now converge through the Host; Units B-G remain in the active plan.
- **settings-control-plane Unit B** (`done`, #638, 2026-09-06) - model connections, exact model declarations, image defaults, and application model selection now use the public JSONC settings source while credentials, catalogs, and runtime state remain domain-owned; [plan archived](plans/archive/settings-model-configuration.md).
- **settings-control-plane Unit C** (`done`, #640, 2026-09-06) - layered root Agent configuration now has source inspection, generated schemas, comment-preserving JSONC edits, and public delegation policy in `config/settings.jsonc`; [plan archived](plans/archive/settings-root-configuration.md).
- **codex-cli-adapter** (`done`, #637, 2026-09-06) - user-enabled Codex, Claude Code, and OpenClaw launchers now run through the generic Tool Task path with stdin delivery, PATH readiness checks, sanitized provider environments, cancellation, bounded output, and managed worktrees; [plan archived](plans/archive/codex-cli-adapter.md).
- **interaction-jank-cleanups PR-3** (`done`, #634, 2026-09-05) - URL and EPUB translation scheduling now use near-viewport candidates, cached layout positions, observer-driven far-jump updates, and layout refresh signals; [plan archived](plans/archive/interaction-jank-cleanups.md).
- **interaction-jank-cleanups PR-2** (`done`, #632, 2026-09-05) - definition catalogs survive unrelated projection deltas while table field usage groups remain current; translation geometry remains open.
- **supervised-Bash-status-normalization** (`done`, #635, 2026-09-05) - durable Tool Task states now map to the stable public Bash status vocabulary before result validation.
- **interaction-jank-cleanups Runtime-index unit** (`done`, #633, 2026-09-05) - Runtime selection indexes are reused within a document and asset-metadata revision, with explicit invalidation for asset ingestion, reconciliation, and collection.
- **agent-delegation-runtime internal cutover** (`done`, #628, 2026-09-05) - the packaged `delegate` CLI, root-owned hidden Agent Sessions, internal Runner, durable settlement and cancellation recovery, and complete Subagent/isolated-Skill retirement are shipped; external Runner adapters followed in #637.
- **startup-window-first** (`done`, #629, 2026-09-05) - the desktop window paints before service startup; readiness gates, persistent Retry/Quit, and Agent conversation recovery are verified; [plan archived](plans/archive/startup-window-first.md).
- **workspace-document-status-audit** (`done`, fast-track, 2026-09-05) - refreshed open claims, the pending Settings design boundary, README runtime ownership, and document lifecycle checks.
- **agent-trajectory-evidence-fidelity Unit 2 / complete** (`done`, #627,
  2026-09-05) — Trajectory now preserves exact-or-unavailable Context, Request,
  Assistant, Tool Input/Output, Raw, copy, restart, and fork evidence; the unused
  export route and partial-coverage state are retired, and the plan is archived
  at [agent-trajectory-evidence-fidelity](plans/archive/agent-trajectory-evidence-fidelity.md).
- **agent-delegation-runtime Unit 1** (`done`, #623, 2026-09-04) — durable
  generic Tool Tasks now supervise foreground and explicit-background Bash with
  packaged recovery, bounded scheduling/detail, exactly-once completion, and
  shared controls/UI; later units delivered internal delegation, legacy
  retirement, and external Runner adapters.
- **link-preview-interaction-polish** (`done`, #621, 2026-09-04) — pasted links
  retain canonical identity, Source previews use content-aware defaults,
  attachment selection is composite, and Outline/Table share one view toolbar
  plus a keyboard-accessible **View as** submenu; plan archived at
  [link-preview-interaction-polish](plans/archive/link-preview-interaction-polish.md).
- **agent-delegation-runtime plan gate** (`done`, #620, 2026-09-04) — Agent
  delegation now has approved design authority for generic Background Tool
  Tasks, internal multi-Turn delegation, Subagent and isolated-Skill retirement,
  and separate external Runner adapters; the plan remains active for
  implementation, with its generic Tool Task Unit 1 shipped in #623.
- **agent-trajectory-evidence-fidelity Unit 1** (`done`, #625, 2026-09-03) —
  Trajectory now pages real dense Turn ranks, coalesces live tail refreshes, and
  retains at most three renderer pages while cache-independent detail/export
  reads and exact catalog boundaries preserve the scoped window contract; this
  paging foundation was completed by the exact-evidence unit in #627.
- **electron-main-esm-startup** (`done`, fast-track, 2026-09-03) — development
  startup and optional macOS native addon resolution now use ESM-compatible
  module-directory paths, with a source guard covering both call sites.
- **pi-ai-0-84-upgrade** (`done`, #622, 2026-09-03) — provider-scoped dynamic
  catalogs now use generation-safe publication through durable cancellation,
  isolated credential probes, and current Baseten/Qwen provider metadata; plan
  archived at [pi-ai-0-84-upgrade](plans/archive/pi-ai-0-84-upgrade.md).
- **outline-agent-first-interface** (`done`, #619, 2026-09-03) — Outline Agent
  authoring now uses one semantic Node/Field/View/Operation interface with
  verified compact receipts, immutable replay identity, and a storage-v3
  boundary; plan archived at
  [outline-agent-first-interface](plans/archive/outline-agent-first-interface.md).
- **agent-execution-selection-settings** (`done`, #618, 2026-09-03) — child
  Agent model and reasoning choices now live in Settings, resolve over the
  direct parent's effective selection, and retain visible runtime fallback;
  plan archived at
  [agent-execution-selection-settings](plans/archive/agent-execution-selection-settings.md).
- **outline-agent-interface-contract** (`done`, #617, 2026-09-02) — the public
  Outline CLI now routes common Agent work through bounded executable recipes,
  narrow porcelain inputs, and closed-loop receipts; plan archived at
  [outline-agent-interface-contract](plans/archive/outline-agent-interface-contract.md).
- **thread-interaction-polish** (`done`, #616, 2026-09-02) — New Thread now
  uses the registry-owned `Command+Shift+O` shortcut, compact Threads chrome
  keeps Trajectory inspection contextual, short sends remain in natural flow,
  and provider cache-breakpoint paths survive Trajectory decoding; plan archived
  at [thread-interaction-polish](plans/archive/thread-interaction-polish.md).
- **agent-model-context-language-contract** (`done`, #611, 2026-09-02) — Agent
  Turns now receive compact semantic context with explicit authority and purpose,
  complete readable Pane targets, truthful focus/selection state, and distinct
  viewed versus supplied content; plan archived at
  [agent-model-context-language-contract](plans/archive/agent-model-context-language-contract.md).
- **web-search-serp-recovery** (`done`, #615, 2026-09-02) — Google organic
  discovery now resolves bounded provider-private `/goto` capabilities without
  requesting result content, while the Google/DuckDuckGo chain distinguishes
  authoritative empty SERPs from diagnostic failures; plan archived at
  [web-search-serp-recovery](plans/archive/web-search-serp-recovery.md).
- **agent-tool-result-envelope-contract** (`done`, #613, 2026-09-02) — all
  Tenon-owned model tools now share one Kernel-enforced semantic result envelope,
  bounded model projection, private Host details, and first-header-only durable
  transformation; plan archived at
  [agent-tool-result-envelope-contract](plans/archive/agent-tool-result-envelope-contract.md).
- **agent-delegated-failure-truth** (`done`, #614, 2026-09-02) — immutable
  per-generation receipts now preserve delegated outcomes, stop provenance,
  direct-parent notification state, and historical anchors while stable Agents
  continue running; plan archived at
  [agent-delegated-failure-truth](plans/archive/agent-delegated-failure-truth.md).
- **agent-root-turn-recovery** (`done`, #612, 2026-09-01) — failed root Turns
  now offer main-authorized Continue and Rerun paths with linked canonical
  continuation, explicit settled-tool replay confirmation, and distinct
  provider Retry semantics; plan archived at
  [agent-root-turn-recovery](plans/archive/agent-root-turn-recovery.md).
- **agent-provider-tool-call-identity** (`done`, #610, 2026-09-01) — Agent tool
  execution now uses Host UUIDv7 identity separately from bounded provider replay
  correlation, with exact same-model restoration and collision-safe cross-model
  projection; plan archived at
  [agent-provider-tool-call-identity](plans/archive/agent-provider-tool-call-identity.md).
- **skill-invocation-input-contract** (`done`, #609, 2026-09-01) — Skill
  catalogs now distinguish load-only, parameterized, and isolated input while
  preserving every retained contract under a hard budget; plan archived at
  [skill-invocation-input-contract](plans/archive/skill-invocation-input-contract.md).
- **agent-cross-thread-reference** (`done`, #608, 2026-09-01) — composers,
  transcripts, and Agents now share canonical Thread references with bounded
  same-profile search/read, safe historical citations, and root-Thread navigation;
  plan archived at
  [agent-cross-thread-reference](plans/archive/agent-cross-thread-reference.md).
- **agent-result-and-file-lifecycle** (`done`, #607, 2026-09-01) — Agent files
  now use unified source/exact-revision references, intent-aware final citations,
  isolated root workspaces, and bounded delegated handoff; plan archived at
  [agent-result-and-file-lifecycle](plans/archive/agent-result-and-file-lifecycle.md).
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
