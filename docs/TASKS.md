# Tasks

This is the single live board for status, priority, integration order and release
gates. Designs live in `docs/plans/`; current behavior lives in `docs/spec/`;
review detail and older completions live in `CHANGELOG.md` and merged PRs.
Dev agents read this board and claim work with Draft PRs; main updates it.

## In Flight

Status refresh: 2026-09-13. GitHub has **no open PRs**. The latest product
integration is #689 (`0d05e97a6`): local data compatibility, backup and recovery.
All eight active designs below are `draft`; no implementation claim is open.
Refresh `gh pr list` before claiming files: this snapshot is not a lock.

The development train is `0.8.0`; the latest published release remains `v0.7.0`
(2026-08-23). Merged features have not yet shipped in a new packaged release.

The main E2E signal is reporting, not a merge gate. Follow the
[report](https://github.com/relixiaobo/lin-outliner/issues/476) for completed
measurements and [live main runs](https://github.com/relixiaobo/lin-outliner/actions?query=branch%3Amain)
for queued, superseded or cancelled runs. PR #689's final-head samples were still
running at merge. A green workflow conclusion does not mean the test suite
passed; do not attribute older samples to the new integration.

## Delivered Contracts

These owners are available for consumers; their archived designs reserve no
files and add no implementation or approval prerequisite.

| Area | Delivered owner / evidence |
| --- | --- |
| Outline and content | #598/#599/#603/#607/#619 supply Source-backed Nodes, public Runtime commands and canonical resource ownership. |
| Agent execution | #623/#628/#637 supply generic Tool Tasks and delegated Sessions; delegation remains experimental and disabled by default. |
| Configuration and startup | #656 supplies file-backed Settings; #664 supplies scoped startup fault isolation. |
| Local data lifecycle | #689 supplies physical format admission, verified local backups, resumable recovery and historical execution fences; [current contract](spec/data-lifecycle.md). |
| Conversation records | #669 supplies source-aware publication and ordinary-file access across eligible roots. |
| Questions and Task responsibility | #672/#673 supply deadline/settlement, independent drafts, service handoff, event receipts and continuation ownership. |
| Projects and execution evidence | #676/#677/#678/#679 supply image observations, owned service evidence, descriptor-safe control transport and Project-owned defaults. |
| Task admission and recovery | #681/#683/#684 supply exact action admission, outcome-aware recovery and attributable observations. |
| Memory and Profile | #685/#686 supply Node retention quality, completed-day names, editable Profile files and direct personal learning; [current contract](spec/agent-memory.md). |
| Scheduled tasks | #682 supplies task windows, authenticated CLI/Skill access, local timing, canonical results, exact Stop and shared renderer state; [current contract](spec/agent-automations.md). |

## Primary Delivery Queue

Each row is one complete feature. At most two significant changes may await PM
review. There is no active claim today; existing PM decisions persist.

| Priority | Plan | Status | Next action / eligibility |
| --- | --- | --- | --- |
| P1 | [data-compatibility-release-enforcement](plans/data-compatibility-release-enforcement.md) | `draft` | Automate the existing populated fixture/restore driver in the main-owned release workflow, preserve immutable supported-release fixtures and publish compatibility evidence; local lifecycle Feature 1 is integrated in #689. |
| P2 | [targeted-thread-recovery](plans/archive/targeted-thread-recovery.md) | `done` | Targeted rebuild/removal now verifies source or exact closure, retains WAL-aware owner evidence, fences recovery across restart, and exposes recovery only after verified completion; [plan archived](plans/archive/targeted-thread-recovery.md). |
| P2 | [file-preview-office](plans/file-preview-office.md) | `draft` | Prove TypeScript DOCX/XLSX extraction and archive limits with Python absent, then deliver shared Agent/preview reading in one feature; preserve the current PPTX owner. |
| P2 | [url-static-reader](plans/url-static-reader.md) | `draft` | Share extraction while preserving Agent calls without UI selection, explicit acquisition and remote-image policy. Prefer after Office on shared preview/extraction files. |
| P3 | [computer-pilot-managed-skill](plans/computer-pilot-managed-skill.md) | `draft` | Pin and verify Skill/CLI acquisition and per-execution outputs. Consume delivered Host, resource and image owners; final native/TCC/provider acceptance still needs evidence. |

### Contract dependencies and selected order

Targeted recovery consumes the final startup, record, question, Task and Profile
contracts and covers the now-delivered scheduled-run closure. No predecessor
implementation remains queued. Optional Memory views, temporal refinements and
narrower Node Reset remain unimplemented design options with no active claim;
they are not prerequisites.

Office and URL reading share extraction/preview owners: prefer Office first,
then URL. Computer Pilot can proceed independently using #676's image normalizer.
Settings WorkingText and the heading toggle have separate renderer scopes.
The extraction half of floating-toolbar work consumes the already-shipped Source
and Runtime contract; it needs coordinated protocol ownership, not another Source
model implementation. Performance changes require measurements before selection.

### Decisions and implementation preparation

| Scope | Preparation still required |
| --- | --- |
| Office | Establish the parser/license/archive policy, cached spreadsheet-value behavior and shared extraction without Python. |
| URL | Specify acquisition and remote-image policy while preserving the Agent's existing read modes. |
| Computer Pilot | Verify reproducible CLI acquisition separately from managed Skill integrity and macOS TCC consent. |
| Performance / dark contrast | Freeze a workload or release candidate and measure/inspect it before changing code or tokens. |

### Shared-owner handoffs

- **Recovery:** `ProfileFileStore`, `AutomationStore`, Thread/Turn and Tool Task
  owners retain exact source, receipt, acknowledgement and pending-delivery
  relationships. Removing a conversation is not implicit Profile Reset and cannot
  turn a stale run request into new execution.
- **Project and scheduling:** a task owns its admitted location. The Project
  primary resolves an initial choice; unrelated chat edits cannot redirect it.
  CLI admission and process control remain with their current owners.
- **Questions and processes:** timeout settles only the exact live question and
  preserves its draft. Pause, run Stop and process Stop retain separate meanings;
  no consumer adds another timer, process registry or completion ledger.
- **Preview and managed Skills:** preserve source access, per-execution outputs,
  actual isolation and common image normalization. An installed Skill or successful
  CLI exit does not prove screenshot fidelity or application readiness.

## Other Active Plans

These are independent complete units or explicit closure/verification work.
None implicitly blocks the primary queue. Refresh actual file scopes before
claiming; an aggregate's optional additions do not reserve an entire subsystem.

| Priority | Plan | Status | Start condition and collision boundary |
| --- | --- | --- | --- |
| P2 | [semantic-working-state](plans/semantic-working-state.md) | `draft` | Eligible now: Settings-only WorkingText consumer over #656; no provider/Skill lifecycle changes. Coordinate the exact Settings component/spec scope. |
| P3 | [floating-toolbar-polish](plans/floating-toolbar-polish.md) | `draft` | Two complete claims: renderer heading toggle is eligible now; atomic tagged extraction is separately eligible after shipped #598 and needs coordinated Core command/type ownership. |
| P3 | [performance-optimization](plans/performance-optimization.md) | `draft` | Three independent unmeasured candidates: Core indexes, filename fallback and text normalization. Freeze current-operation baselines before implementation; close immaterial candidates without a rewrite. Order Core changes with tagged extraction and refresh actual `nativeLocalFileHost` and file-tool overlap. |
| P3 | [dark-mode-contrast-pass](plans/dark-mode-contrast-pass.md) | `draft` | Final verification of the selected release's landed visual surfaces. Do not wait for every future visual backlog item; every feature still supplies its own light/dark evidence. |

## Small And Release Work

These items have no active plan file. Each is a complete fast-track change or a
verification gate; create a plan only if implementation discovers a significant
contract or user-visible decision.

Run-dependent E2E stabilization and smoke-suite repair are independent reliability
work that can proceed beside the feature lanes with main-owned workflow scope.
They do not waive focused feature acceptance or turn queued non-gating samples
into a blanket dependency for every PR.

### Release gates

- **Supported-data baseline verification** (release gate) — the first packaged
  train containing #689 establishes the supported baseline. Run
  `bun scripts/check-data-lifecycle.ts` and applicable saved release fixtures
  before publishing, retain an immutable populated fixture with exact version
  provenance, and verify packaged/dev startup and recovery with isolated data.
  Unsupported pre-baseline formats remain preserved for recovery; a data wipe
  cannot substitute for compatibility verification. Automated publication
  enforcement remains the separate draft feature above.
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

- **Original Outline Runtime timeout** (P2, `draft`) — retain #675 OQ-2 as an
  unresolved causal investigation. Its original data was removed before the
  investigation; isolated invalid-store and nonpublishing-child fixtures verify
  failure channels only. Require new retained evidence before a runtime fix,
  timeout increase or retry change; this does not block #676/#677's delivered repairs.
- **delegation-graduation-evidence** (P3, `draft`) — preserve FR-9/AC-17 from
  the [archived runtime design](plans/archive/agent-delegation-runtime.md): freeze
  a representative task corpus and compare sequential/delegated wall time, total
  usage/cost (unknown when unavailable), failures, duplicate work and ownership-
  recovery cost. Record reproducible runs before a graduation decision. No such
  evidence was confirmed in this audit; delegation stays experimental and off by
  default, and this measurement does not block the shipped runtime or consumers.
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
  handful of samples. Replace `file:line` comparison identities with stable test
  identities: the #673 gate verified six unchanged tests failing 5/5 on both
  branch and exact base but labelled introduced after a one-line fixture shift.
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
  authority belongs to the startup, record and targeted-recovery owners; the
  [original recovery design](plans/archive/startup-data-recovery.md) is provenance,
  not an implementation prerequisite. Startup isolation and records shipped in
  #664/#669; targeted recovery remains pending.
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

One line per recent integration. Older entries remain in
[CHANGELOG.md](../CHANGELOG.md) and Git history; archived plans retain design provenance.

- **data-compatibility-foundation: local lifecycle** (`done`, #689, 2026-09-13) - versioned admission, verified backups, resumable recovery and historical execution fences are integrated; [original design archived](plans/archive/data-compatibility-foundation.md), with release automation tracked separately above.
- **workspace-document-status-refresh** (`done`, fast-track, 2026-09-12) - reconciled GitHub claims, release/CI evidence, all active designs and delivered owners; removed completed local review workspaces after preserving their changes and evidence.
- **scheduled-work-redesign** (`done`, #682, 2026-09-12) - task windows, authenticated CLI, canonical results and exact run Stop are integrated; [plan archived](plans/archive/scheduled-work-redesign.md).
- **memory-profile-direct-learning** (`done`, #686, 2026-09-12) - editable Profile files, direct personal learning, activation and retained-source lifecycle are integrated; [plan archived](plans/archive/memory-profile-direct-learning.md).
- **memory-agent-profile: Node quality** (`done`, #685, 2026-09-12) - bounded source-aware retention, independent support and completed-day naming are integrated; [core design archived](plans/archive/memory-agent-profile.md).
- **tool-recovery-and-evidence-integrity** (`done`, #680/#681/#683/#684, 2026-09-11) - exact Task action admission, receipt-aware recovery and attributable observations are shipped; [plan archived](plans/archive/tool-recovery-and-evidence-integrity.md).
- **composer-project-menu** (`done`, #679, 2026-09-11) - searchable composer Project selection, editing and creation now own future task defaults; independent chat folders are retired and the [plan is archived](plans/archive/composer-project-menu.md).
- **agent-evidence-and-service-readiness** (`done`, #675/#676/#677, 2026-09-11) - actual image pixels and owned cross-directory readiness evidence are delivered; [plan archived](plans/archive/agent-evidence-and-service-readiness.md), original timeout investigation retained separately.
- **source-cli-cleanup** (`done`, #678, 2026-09-11) - supervisor standard stdin avoids closing reused Host descriptors; exact user stdin and private fd 3 remain separate.
- **conversation-work-folders** (`done`, #674, 2026-09-11) - multi-folder Projects and scoped CLI/Skill operations shipped; #679 replaces the independent conversation defaults; [plan archived](plans/archive/conversation-work-folders.md).
- **background-task-continuation-policy** (`done`, #673, 2026-09-11) - verified service handoff, explicit watches and exact-event Stop/acknowledgement govern continuation; [plan archived](plans/archive/background-task-continuation-policy.md).
- **user-input-request-recovery** (`done`, #672, 2026-09-11) - ordered question recovery, bounded exactly-once settlement and independent session-local answer/message drafts are shipped; [plan archived](plans/archive/user-input-request-recovery.md).
- **unified-session-records** (`done`, #669, 2026-09-09) - ordinary file tools recover retained conversation evidence with exact sources, active publication and bounded continuation/search; [plan archived](plans/archive/unified-session-records.md).
- **Execution-order audit** (`done`, 2026-09-09) - reconciled 15 active plans, #669's review state, contract dependencies, selected integration lanes and product gates; runtime features remain in their own rows.
- **Design-validity audit and delegation closure** (`done`, 2026-09-09) - audited 15 designs, revised five and retained nine; the three shipped delegation units are [archived](plans/archive/agent-delegation-runtime.md), with graduation measurement preserved separately and no experimental graduation claimed.
- **Task responsibility and input recovery design refinement** (`done`, #671, 2026-09-09) - Task acknowledgement/watch receipts, unsent answer recovery and scheduled question settlement are specified; #672/#673 subsequently delivered input recovery and Task policy, and #682 supplies their scheduled-work consumer.
- **conversation-work-folders design integration** (`done`, #670, 2026-09-09) - Project sources, independent conversation defaults, CLI/Skill access and composer controls are specified; #674 subsequently delivered the approved runtime design.
- **startup-fault-isolation** (`done`, #664, 2026-09-09) - scoped startup recovery preserves healthy notes, chat drafts and notifications; owner retry and configuration recovery are specified, and the [plan is archived](plans/archive/startup-fault-isolation.md).
- **default-model-selection** (`done`, #666, 2026-09-09) - queued saves retain each chosen text model, display the persisted result, and preserve the selection across Settings reopening and app restart.
- **shortcut-initial-read** (`done`, #667, 2026-09-09) - live shortcut changes supersede late initial reads and errors, preserving the latest bindings and source digest for subsequent edits.
- **development-process-lifecycle** (`done`, #663, 2026-09-09) - requested background servers retain ownership without a default deadline, running logs preserve multiline secret context, and nested desktops resolve their own Runtime launch; [plan archived](plans/archive/development-process-lifecycle.md).
