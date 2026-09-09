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

PRs #653 and #654 split recovery into three complete features. Startup fault
isolation ships in #664; its current owner contracts live in the
[Desktop Host lifecycle](spec/architecture.md#desktop-host-lifecycle) and
[Agent startup availability](spec/agent-thread-rendering.md#startup-availability).
Unified session records and targeted conversation recovery remain unimplemented.
The record plan separates historical originals from new reading-Thread image/PDF
observations; record-discovery eligibility remains gated on its OQ-1 product
decision. The original recovery aggregate remains archived as provenance.

PR #665 integrates the global Memory/profile design. Its two core delivery
units remain unimplemented: Node retention quality, and profile files/direct
learning. Their startup predecessor is complete in #664. Unified records precedes
profile learning, and targeted recovery follows the final profile owner so its
closure includes file acceptance, provenance, pending work and retention.
Optional views, richer temporal behavior and narrower Node Reset remain outside
that chain. Component-source/precedence examples are required before profile
consumers are built; core Reset UI retains the existing Node subtree scope until
the optional narrower behavior ships.

PR #668 integrates the scheduled-work redesign as one complete implementation
feature: a stable task/results workspace, independent timing/execution/attention,
and a packaged scheduling CLI with an on-demand Skill. Implementation follows
unified records and consumes the shipped startup owners. The plan's local
catch-up promise and task/work-location choices (OQ-1/OQ-2) remain explicit
product decisions before implementation; merging the design ships no runtime.

PR #670 integrates the [Project and conversation work-folder design](plans/conversation-work-folders.md)
as one complete implementation feature: Project source folders and a primary,
independent conversation defaults, packaged CLI/Skill operations, and composer
Add/status controls with compact model/effort labels. Implementation follows
unified records (#669); OQ-1 still requires product ratification. The reviewed
application-default state remains distinct from adopting a Project primary.
This merge records the design only; the runtime and composer changes are pending.

Two independent Agent interaction follow-ups are recorded for dev implementation:
[reliable, bounded user input](plans/user-input-request-recovery.md) and
[background continuation policy](plans/background-task-continuation-policy.md).
Prioritize the missing answer surface. Both require a live shared-owner check
against #669; order their common Turn/protocol/store edits rather than building
against competing interfaces. The background plan's OQ-1 service-exit default
requires implementation ratification. The question plan's OQ-1 is an unresolved
incident diagnostic, not a reason to defer its reproduced recovery/cleanup fixes.
The question feature also gives every request a finite deadline (60 seconds by
default), returning an explicit no-answer result so the same Agent Turn can
continue without treating silence as approval. These entries record designs
only; neither runtime fix has shipped.
PR #671 completes their Task control/receipt and session-local answer-draft
contracts and aligns scheduled questions with the same settlement owner. The
later question/scheduling implementation verifies their shared consumer without
adding a second timer or releasing an executing run's foreground slot on timeout.

Workbench Units A-E shipped through #658. PR #660 subsequently simplified the
workbench to UI-owned Projects, native Git/test commands guided by Skills, and
generic Goal/Task state. Private verification and Git evidence, Project model
tools, and directory claims are retired. Execution context, passive instruction
discovery, actual isolation, and validated parent/child Task ownership remain.
The workbench plans are archived and current contracts live in the specs.

Settings Unit G shipped in #656 over #659 and #660, completing the file-first
Settings series and releasing the startup-fault-isolation predecessor. Settings
operations remain UI-owned; Agent configuration uses public files and the
configuration Skill. The final catalog has 20 tools, with the twelve Settings
tools and `file_delete`, `project_inspect`, and `project_manage` retired. New
claims consume the merged Settings and generic workbench contracts.

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
Unit G's unified navigation, source discovery, domain managers, and tool
retirement shipped in #656. The aggregate and discovery plans are archived;
current behavior lives in the specs. The separate Settings WorkingText consumer
remains in the active working-state plan.

Trajectory paging shipped in #625 and exact-or-unavailable evidence completed
in #627; the plan is archived and its shared-file claim is released. Bounded
summaries remain navigation aids, not forensic evidence authority. Link/preview
interaction polish shipped in #621 and released the shared preview-shell lane.
The remaining primary queue is eligible under its live collision checks,
including the released Agent and Skill ownership from #628. The remaining plans
stay active until their implementation, spec fold, and archive move complete.

## Primary Delivery Queue

This queue is executable: **every row is one substantial, independently
reviewable PR backed by an active design**. A multi-unit plan may supply several
named complete features; internal build stages stay inside each feature's PR.
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
  unified-session-records (settle OQ-1 before implementation)
  memory-agent-profile: Node retention quality
  file-preview-office
  url-static-reader
  computer-pilot-managed-skill

Selected integration order:
  Settings G (#656, shipped) ~> startup-fault-isolation (#664, shipped)
  Workbench (#660, shipped) ~> startup-fault-isolation (#664, shipped)
  startup-fault-isolation (#664, shipped) ~> unified-session-records
  unified-session-records -> scheduled-work-redesign
  unified-session-records -> conversation-work-folders
  unified-session-records ~> memory-agent-profile: profile files/direct learning
  memory-agent-profile: profile files/direct learning ~> targeted-thread-recovery
  startup-fault-isolation (#664, shipped) ~> memory-agent-profile: Node retention quality
  memory-agent-profile: Node retention quality ~> profile files/direct learning

Capability prerequisite:
  startup-fault-isolation (#664, shipped) -> targeted-thread-recovery
```

| Priority | Plan / PR claim | Status | Eligible after |
| --- | --- | --- | --- |
| P1 | [user-input-request-recovery](plans/user-input-request-recovery.md) | `draft` | Design refined in #671: recover questions, retain unsent answer drafts, and continue after a default 60-second unanswered wait. Coordinate #669; prioritize before background-policy edits and verify the later scheduled consumer. |
| P2 | [background-task-continuation-policy](plans/background-task-continuation-policy.md) | `draft` | Task control/receipt design refined in #671. Ratify OQ-1 and coordinate #669 plus question-recovery shared interfaces; preserve scheduled-run and delegated-result ownership. |
| P2 | [unified-session-records](plans/unified-session-records.md) | `draft` | **Startup predecessor complete (#664)**; cover generic Task outputs, context, artifacts and isolation, and settle OQ-1 before claiming implementation |
| P2 | [memory-agent-profile: Node retention quality](plans/memory-agent-profile.md#implementation-ownership-and-complete-delivery-units) | `draft` | **Now; startup predecessor complete (#664)**; independent complete Node quality feature. Recheck actual overlap with unified records and land shared Memory changes before the selected profile unit. |
| P2 | [memory-agent-profile: Profile files and direct learning](plans/memory-agent-profile.md#implementation-ownership-and-complete-delivery-units) | `draft` | After unified records and selected Node-quality shared changes; demonstrate component sources/precedence before consumers. One complete profile, direct-learning, activation and lifecycle feature. |
| P2 | [scheduled-work-redesign](plans/scheduled-work-redesign.md) | `draft` | After unified records; startup is complete in #664. Settle OQ-1/OQ-2 and coordinate Host/Bash admission plus exact run/Task ownership. Consume #671's shared question settlement and draft recovery; one complete UI/CLI feature. |
| P2 | [conversation-work-folders](plans/conversation-work-folders.md) | `draft` | Design integrated in #670; after unified records (#669) and OQ-1 ratification. One complete Project/folder/CLI/composer feature; coordinate scheduling, recovery/profile, and question-recovery shared owners. |
| P2 | [targeted-thread-recovery](plans/targeted-thread-recovery.md) | `draft` | After unified records and the profile owner; startup is complete in #664; include final profile file/admission/provenance/pending-work/retention contracts in verified rebuild/removal. |
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

The recovery/records sequence consumes #660's generic command outcomes,
retained/expired output and artifacts, Goal accounting, execution context,
and process-isolation/settlement owners. It has no private check-attempt or
Git-review manifest producer to recover. Native-state reconciliation precedes
new mutations after uncertain outcomes. A future terminal or additional sandbox
backend does not extend the completed workbench integration gate.

The Memory/profile rows are the two selected complete units of #665, with
separate PRs and status. Their shared design remains active until those units
are implemented and folded into the specs. Optional additions need their own
exact scope and claim; they are not prerequisite work for this queue.

Collision lanes remain claim-time constraints alongside the selected order:

- Conversation work folders consume #669's final Thread metadata, context and
  record owners. Coordinate Project/Automation resolution and packaged CLI/Bash
  admission with scheduled work, retained settings with profile/recovery owners,
  and composer/Turn changes with question recovery and background continuation.
  Refresh claims before implementation; existing Automation work locations and
  delegated isolation must retain their independent ownership.
- Scheduled work and profile learning can proceed in parallel after their
  predecessors where they consume established owners. Shared admission,
  configuration or learning changes require explicit collision ordering;
  neither Node quality nor optional Memory additions is an unconditional
  scheduled-work prerequisite. Whichever of scheduled work and targeted recovery
  lands later must cover the final assignment/run references, pending delivery,
  request identity and retention fences of the earlier feature.
- Profile learning consumes final startup admission and exact-record sources;
  targeted recovery consumes the resulting profile owner rather than assuming
  all retained Memory is in Nodes. Node quality can proceed independently of
  unified records where actual files permit. Its selected order before profile
  learning avoids reworking shared Memory mechanisms, not a functional
  prerequisite between the two complete features. Neither broadens the record
  plan's still-pending discovery decision or source-Thread access.
- #664 completes startup fault isolation over the shared Host/preload and domain
  destinations from #656 and generic Task/runtime evidence from #660/#663.
  Consumers use the current startup admission, issue and retry contracts; actual
  file overlap still requires a claim-time check with exact symbols.
- Readable records consume generic Task/context/artifact retention; they do not
  grant publication or process-adoption authority, or authenticate a current
  source revision. Further delegation retains its own collision check and
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

These plans retain their own delivery contracts and separate start conditions.
The Settings predecessor above is complete. Any multi-PR aggregate is reshaped
to claim-sized plans before implementation.

| Priority | Plan | Status | Start condition and collision boundary |
| --- | --- | --- | --- |
| P1 | [project-development-workbench](plans/archive/project-development-workbench.md) | `done` | Units A-E completed in #646, #649/#651, #655, #657, and #658; final contracts live in the specs. |
| P1 | [project-context-runtime](plans/archive/project-context-runtime.md) | `done` | Bounded discovery, immutable successor delivery, freshness validation, and restart recovery shipped in #649; optional Project catalog, confirmed membership, deletion fencing, and Project-backed Automation hints completed in #651. |
| P1 | [verification-self-iteration](plans/archive/verification-self-iteration.md) | `done` | Source-bound checks, finite correction budgets, retained evidence, and delegation-aware mutation fencing shipped in #655. |
| P2 | [git-review-publication](plans/archive/git-review-publication.md) | `done` | Reviewed selected-file commits, immutable evidence, and explicit push/PR publication with remote reconciliation shipped in #657. |
| P2 | [execution-sandbox-process](plans/archive/execution-sandbox-process.md) | `done` | Actual isolation receipts, context observations, and the bounded tmux experiment shipped in #658; measured lifecycle limits do not establish a persistent-terminal capability. |
| P1 | [agent-delegation-runtime](plans/agent-delegation-runtime.md) | `in-progress` | Generic Tool Tasks Unit 1 shipped in #623, internal delegation plus Subagent/isolated-Skill retirement shipped in #628, and the external Runner adapter feature shipped in #637. Remaining work follows the aggregate plan's declared boundaries. |
| P2 | [settings-control-plane](plans/archive/settings-control-plane.md) | `done` | Units A-G completed through #656; the aggregate and discovery plans are archived and current contracts live in the specs. |
| P2 | [interaction-jank-cleanups](plans/archive/interaction-jank-cleanups.md) | `done` | PR-1 chrome scroll batching shipped in #630, PR-2 definition caches in #632, the Runtime-index unit shipped in #633, and PR-3 translation geometry shipped in #634. |
| P2 | [semantic-working-state](plans/semantic-working-state.md) | `draft` | Remaining Settings WorkingText consumer; target #656's connection-test button and per-operation Skill feedback. Units B/D/G's domain behavior is already shipped. |
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
  scoped pre-#663 Agent stores plus pre-#619 Outline storage-v2 workspaces, and
  verify fresh packaged/dev first launch. This covers the input-author, context
  dependency-manifest, unified Agent resource-reference, whole-Turn
  `history/rerun` event-name, #611 user-view/additional-context payload-shape,
  #619 required Operation-intent identity, and #646/#649 execution-context
  snapshot shape cuts (including series and capture identity), plus #658's
  required Task isolation evidence, terminal receipt v3, and supervisor identity
  v2, plus #663's nullable Task timeout. Use fresh clone-specific userData for
  development verification; no migration or automatic deletion ships.
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

- **Task responsibility and input recovery design refinement** (`done`, #671, 2026-09-09) - Task acknowledgement/watch receipts, unsent answer recovery and scheduled question settlement are specified; all three runtime features remain unimplemented.
- **conversation-work-folders design integration** (`done`, #670, 2026-09-09) - Project sources, independent conversation defaults, CLI/Skill access and composer controls are specified; implementation follows #669 and OQ-1 ratification.
- **scheduled-work design integration** (`done`, #668, 2026-09-09) - the task/results workspace and CLI/Skill design is integrated; implementation follows unified records, with OQ-1/OQ-2 still pending.
- **startup-fault-isolation** (`done`, #664, 2026-09-09) - scoped startup recovery preserves healthy notes, chat drafts and notifications; owner retry and configuration recovery are specified, and the [plan is archived](plans/archive/startup-fault-isolation.md).
- **default-model-selection** (`done`, #666, 2026-09-09) - queued saves retain each chosen text model, display the persisted result, and preserve the selection across Settings reopening and app restart.
- **shortcut-initial-read** (`done`, #667, 2026-09-09) - live shortcut changes supersede late initial reads and errors, preserving the latest bindings and source digest for subsequent edits.
- **memory-agent-profile design integration** (`done`, #665, 2026-09-09) - two complete core units and their activation/Reset boundaries are approved; profile learning precedes targeted recovery, and runtime remains pending.
- **development-process-lifecycle** (`done`, #663, 2026-09-09) - requested background servers retain ownership without a default deadline, running logs preserve multiline secret context, and nested desktops resolve their own Runtime launch; [plan archived](plans/archive/development-process-lifecycle.md).
- **web-search-http** (`done`, #662, 2026-09-09) - bounded Parallel/Exa HTTP search replaces Google/DuckDuckGo browser search, preserving independent Bing Images and #661's web-fetch contract; [plan archived](plans/archive/web-search-http.md).
- **tool-output-boundaries** (`done`, #661, 2026-09-09) - partial reads and oversized search, web, image, and task results now satisfy the shared output contract while preserving continuation, artifacts, and terminal state; current behavior is recorded in the tool specification.
- **settings-discovery / Settings complete** (`done`, #656, 2026-09-09) - unified Settings, file-based Agent configuration, safe credential previews and draft-preserving conflict retry complete Units A-G; [discovery](plans/archive/settings-discovery.md) and the [aggregate](plans/archive/settings-control-plane.md) are archived.
- **workbench-tool-boundaries** (`done`, #660, 2026-09-09) - UI Projects and native Git/test Skills replace private workbench tools and directory claims while preserving generic Task ownership/isolation; [plan archived](plans/archive/workbench-tool-boundaries.md).
- **remove-file-delete-tool** (`done`, #659, 2026-09-09) - local deletion now uses Bash command semantics without automatic Agent trash; existing policy/isolation and canonical deletion history remain, and the [plan is archived](plans/archive/remove-file-delete-tool.md).
- **execution-sandbox-process / workbench complete** (`done`, #658, 2026-09-09) - actual isolation evidence and bounded tmux lifecycle measurements complete Units A-E; [Unit E](plans/archive/execution-sandbox-process.md) and the [aggregate](plans/archive/project-development-workbench.md) are archived.
- **git-review-publication** (`done`, #657, 2026-09-09) - reviewed selected-file commits, immutable evidence, and explicit push/PR publication with remote reconciliation shipped; [plan archived](plans/archive/git-review-publication.md).
- **verification-self-iteration** (`done`, #655, 2026-09-08) - source-bound checks, bounded correction, evidence recovery and delegation-aware mutation fencing shipped; [plan archived](plans/archive/verification-self-iteration.md).
- **recovery/records design integration** (`done`, #653/#654, 2026-09-08) - three complete plans define startup isolation, unified records and targeted recovery after Settings G and workbench A-E; runtime remains pending.
- **settings-control-plane Unit F** (`done`, #652, 2026-09-08) - public keybindings, the Keyboard Shortcuts editor, live handlers/hints, conflict-safe native replacement, and restart recovery shipped.
- **project-context-runtime complete** (`done`, #651, 2026-09-08) - optional Projects, confirmed Chat grouping and lineage inheritance, durable deletion fencing, immutable Automation hints, and stale Runtime startup recovery shipped; [plan archived](plans/archive/project-context-runtime.md).
- **project-context-runtime discovery** (`done`, #649, 2026-09-08) - bounded scoped discovery, immutable successor publication, foreground evidence retention, Git/source freshness validation, and paged restart recovery shipped; Project catalog/lifecycle completed in #651.
- **settings-control-plane Unit E3** (`done`, #650, 2026-09-08) - Host-owned application/release/update information, fixed support destinations and diagnostics reveal/export shipped; #656 later retired the model tools while retaining UI operations.
- **workbench context-publication design gate** (`done`, #645, 2026-09-07) - approved immutable model-facing publications, scoped baselines, and compaction recovery across the plan series; runtime delivery followed in #646 and #649.
- **project-development-workbench Unit A** (`done`, #646, 2026-09-07) - task-owned execution context, scoped admission and receipts, canonical publication/compaction recovery, Thread consumers, delegation/native launchers, Automation dispatch, and renderer details shipped; B-E completed in #649/#651, #655, #657, and #658.
- **project-development-workbench design gate** (`done`, #639, 2026-09-07) - approved task-scoped execution, context, verification, publication, and process designs; all implementation units followed in #646, #649/#651, #655, #657, and #658.
- **skill-declarative-settings** (`done`, #643, 2026-09-07) - Skill-owned file-backed read/update routes preserve source spelling and queued toggle state; the dependent Unit D lifecycle/provenance work shipped next in #644.
- **skill-lifecycle-operations** (`done`, #644, 2026-09-07) - root-only Skill inspection and management tools now share the Host-owned lifecycle with the Settings Library, use revision/hash-bound targets and native human review, and preserve governed one-step Agent edit undo; [plan archived](plans/archive/skill-lifecycle-operations.md).
- **memory-operations** (`done`, #647, 2026-09-07) - people and root Agents now share bounded Memory inspection, native-confirmed exact-target Reset with durable recovery, saved-search opening, and revision-guarded per-Thread mode controls; [plan archived](plans/archive/memory-operations.md).
- **preview-translation-data-operations** (`done`, #648, 2026-09-08) - preview-local translation controls, native-confirmed saved-translation and website-data clearing, and root-Agent inspection/management tools now share Host-owned lifecycle and revision boundaries; [plan archived](plans/archive/preview-translation-data-operations.md).
- **agent-skill-curation-report** (`done`, #642, 2026-09-06) - Settings now offers an opt-in, read-only report over the loaded Skill registry; unchanged user/project Skills with reliable Agent-write provenance are analyzed for broken or root-escaping Markdown resources, exact content duplicates, and retired tool names, while excluded sources and hashes remain visible; [plan archived](plans/archive/agent-skill-curation-report.md).
- **agent-skill-authoring-foundation** (`done`, #641, 2026-09-06) - local Skill sources now persist explicit `skill` or `container` modes, exact Skill bindings stay scoped to the selected directory, and discovery, reload, authoring, and unbind share that identity; [plan archived](plans/archive/agent-skill-authoring-foundation.md).
- **settings-control-plane Unit A** (`done`, #636, 2026-09-05) - file-backed JSONC preferences, schema/status/recovery, global Skill/tool controls, and the configuration Skill converge through the Host.
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
- **web-search-serp-recovery** (`done`, #615, 2026-09-02) - original Google/DuckDuckGo recovery shipped here; #662 replaced that implementation with HTTP providers while preserving truthful empty/failure outcomes; [original plan archived](plans/archive/web-search-serp-recovery.md).
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
