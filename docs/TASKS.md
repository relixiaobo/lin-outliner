# Tasks

This is the single live board across all clones. It owns active-work status,
priority, integration order, release gates, and a short recent-completion
window. Designs live in `docs/plans/`; current behavior lives in `docs/spec/`;
retrospectives live in `CHANGELOG.md` and merged PRs. Dev agents read this board
and claim work with a Draft PR but do not edit it. The main agent updates it at
integration.

The live collision radar is `gh pr list` plus this board. The current package
version is `0.8.0`; the latest published train is `v0.7.0`. Refresh claims before
starting or integrating work; the audit below is a dated snapshot, not a lock.

## In Flight

Design-validity audit: 2026-09-09, main `122d199f`, all 15 then-active top-level
plans, current code/specifications and live GitHub claims. One completed aggregate
is now archived, leaving 14 active designs. The only open implementation PR is
**#669, unified session records**, at head `6458abb1`. It has submitted fixes for
the two P2 findings on reviewed head `81f86b0b`: cursor newline consistency and
matching-line context when a byte cursor is unavailable. Re-review the new head
before its integration gate; this audit does not verify those fixes. No downstream
implementation is claimed by merging its design or by this audit.

The board previously labelled unified records as draft and omitted the #670/#671
work from its main dependency graph. #665, #668, #670 and #671 integrated designs,
not profile learning, scheduled work, work folders or interaction fixes. The two
reported interaction failures remain present on main: `requestUserInput` still
permits an omitted deadline and `ToolTaskStore.pendingDelivery` still selects
terminal background work without a service-handoff agreement.

Verified predecessor contracts are already available: Source/preview/desktop
Hosts (#598/#599/#603), generic Agent resources (#607), Tool Tasks/delegation/native
launchers (#623/#628/#637), file-first Settings through #656, simplified workbench
and isolation (#658/#660/#663), and startup fault isolation (#664). Consume the
current specifications; these completed series do not reserve future work.

The delegation closure audit confirms its three runtime units in #623/#628/#637
and current Task/delegation specs. The original plan's no-runner-override and
CLI-owned verification requirements were replaced by subsequent contracts;
Host-owned worktree base revisions, changed paths and patch resources remain.
Do not restore retired private Git/test mechanisms to satisfy historical wording.
The aggregate is archived as provenance.
Its uncompleted sequential-versus-delegated value measurement remains an explicit
verification item below, and delegation remains experimental and disabled by
default. Optional vendor protocols do not extend the primary queue.

## Design Validity Audit

This is a code/specification audit, not product acceptance or evidence that an
unimplemented feature works. The 15-plan disposition is **one archive, five
targeted revisions, nine retained designs**. The retained goals have no evidenced
reason for wholesale replanning; explicit product questions and feature-specific
acceptance still apply. Standing references and archived designs are not queued
features.

| Design | Disposition | Evidence and resulting boundary |
| --- | --- | --- |
| [agent-delegation-runtime](plans/archive/agent-delegation-runtime.md) | Archive delivered runtime aggregate | `ToolTaskStore`/`ToolTaskService`, `DelegationCoordinator`, `InternalDelegationSessionRuntime` and `ExternalAgentCliLauncher` cover the three shipped units. Current spec replaces AC-19's runner ban with admitted selection. AC-24's worktree/patch guarantees persist through the Host, while #660 replaced private Git/test mechanisms; do not re-create CLI verification ownership. Preserve FR-9/AC-17 measurement separately. |
| [file-preview-office](plans/file-preview-office.md) | Revise extraction approach | `ingestRichDocumentAsMarkdown` still uses local MarkItDown/Python for DOCX/XLSX, unlike bounded `agentPptxIngestion`. A wrapper cannot meet the no-external-runtime goal. Prove TypeScript extraction, then cut over Agent and preview together; retain independent XLS/EPUB behavior. |
| [url-static-reader](plans/url-static-reader.md) | Revise shared-reader boundary | `extractPageContent` and `agentWebTools` already support extraction plus raw/metadata/matching/binary projections. Sharing static extraction must preserve Agent calls without UI selection, their existing modes, and separate acquisition authority. |
| [computer-pilot-managed-skill](plans/computer-pilot-managed-skill.md) | Refresh admission and acquisition | `ManagedSkillShellEnvironmentRegistry` and `BrowserPilotHost.processEnvironment` provide current eligible-root and per-execution ownership. Use file-backed availability rather than retired Role/enabled-record policy; distinguish Skill integrity from CLI readiness and isolate concurrent output roots. |
| [performance-optimization](plans/performance-optimization.md) | Reframe as measured candidates | Core scans, `nativeLocalFileHost.rgFileNameMatches` and repeated normalization in `analyzeTextSearchField` still exist, but no current baseline establishes worthwhile latency savings. Each of the three independent candidates must first pass a fixed-fixture measurement threshold; an immaterial candidate can close without a rewrite. |
| [dark-mode-contrast-pass](plans/dark-mode-contrast-pass.md) | Bound the verification scope | The current ink tokens and prior tertiary-text correction already exist. Freeze one release candidate and finite shipped-surface inventory; future visual proposals are not dependencies. A clean visual walk can finish verification without token edits. |
| [unified-session-records](plans/unified-session-records.md) | Retain; implementation in review | #669 implements the ordinary-file/source publication cutover. Re-review its submitted fixes and reconcile recorded approval; do not rewrite a concurrently implemented contract because its consumers are queued. |
| [user-input-request-recovery](plans/user-input-request-recovery.md) | Retain; current defect | `requestUserInput` permits an absent deadline, and renderer pending requests depend on live events. The bounded no-answer outcome, recoverable presentation, exact-request cancellation and session-local drafts still address the observed failure. |
| [background-task-continuation-policy](plans/background-task-continuation-policy.md) | Retain; current defect | `ToolTaskStore.pendingDelivery` selects terminal work without service handoff, and `ToolTaskService` can start a completion Turn. Launch receipt, explicit watch and event acknowledgement remain necessary; exit code/log text cannot establish user intent. |
| [conversation-work-folders](plans/conversation-work-folders.md) | Retain; location contract still absent | Current Task isolation and UI Projects do not provide the proposed multi-folder Project owner and independent ordinary-conversation default. Keep the explicit OQ-1 and consume current Task/CLI owners. |
| [scheduled-work-redesign](plans/scheduled-work-redesign.md) | Retain; complete replacement feature | Current Automation scheduling does not supply the planned task/results workspace and CLI lifecycle. Keep one complete feature, settle local catch-up/location questions and consume final record/question/Task owners; document length alone is not a reason to ship partial scaffolding. |
| [memory-agent-profile](plans/memory-agent-profile.md) | Retain; two independent core units | Current Phase1 bounded rollouts and Phase2 publication do not implement the proposed retention quality or editable Profile/direct-learning loop. Keep Node quality and Profile learning distinct; optional views, temporal memory and narrower Reset are not prerequisites. |
| [targeted-thread-recovery](plans/targeted-thread-recovery.md) | Retain; final-owner dependency is real | Readable session records are not a complete reconstructable Thread store. Exact owner closure and source-loss versus accepted-learning semantics remain necessary; consume final records/Profile owners and the lifecycle owners that actually ship. |
| [semantic-working-state](plans/semantic-working-state.md) | Retain; small consumer feature | Settings provider/managed-Skill surfaces still have raw labels and spinner-only gaps. Keep WorkingText scoped to Settings operations over existing lifecycle truth, without introducing another state owner. |
| [floating-toolbar-polish](plans/floating-toolbar-polish.md) | Retain; two complete features | `ToolbarMark` still excludes heading, and tagged extraction has no `defaultExtractParentId` route. The heading control and atomic tagged extraction remain independent; only the latter needs shared Core ownership. |

The revisions above correct execution premises, not shipped behavior. Office
parser feasibility, Computer Pilot executable acquisition and performance probes
must produce evidence before consumers or optimizations are built. No current
parser/library choice or measured performance win is asserted by this audit.

## Primary Delivery Queue

Each implementation row is one independently useful, complete feature PR.
Internal build steps and contract examples stay inside that feature; they are
not separately releasable scaffolding. The PM reviews at most two significant
changes at once. Planning, fixtures and disjoint implementation can proceed in
parallel; shared-owner mutations need an explicit integration order.

### Contract dependencies and selected order

`->` means the successor consumes the predecessor's required final contract.
`~>` means the selected integration order avoids replacing shared mechanisms
twice; it is not a claim that either feature is intrinsically unusable alone.
The sequences cover the named complete units, not every optional extension in
an aggregate plan.

```text
Required contract consumption:
  unified-session-records -> profile files/direct learning
  unified-session-records -> scheduled-work-redesign
  unified-session-records -> targeted-thread-recovery
  profile files/direct learning -> targeted-thread-recovery

Preferred shared Agent/Host integration lane:
  #669 fixes and gate
    ~> user-input-request-recovery
    ~> background-task-continuation-policy
    ~> conversation-work-folders
    ~> scheduled-work-redesign
    ~> targeted-thread-recovery

Memory lane:
  Node retention quality ~> profile files/direct learning
  profile files/direct learning also waits for unified records

Preview lane:
  file-preview-office ~> url-static-reader
  shared file-tool changes consume #669 first
```

The selected Agent lane prioritizes today's lost question and unsolicited
continuation, then settles Project location/CLI and Task responsibility before
scheduling consumes them. Recovery is preferably integrated after the selected
new state owners so its deletion/rebuild closure is verified once against them.
The records/profile prerequisites for recovery remain mandatory; scheduling,
work folders and background policy are selected collision order only.

An unresolved product decision must not hold every later independent feature.
Skip an unready branch, choose another eligible complete feature, and update the
selected order before its shared files are claimed. Whichever feature lands
later must adapt and test the earlier owner's final contract; it may not recreate
an interim owner. Optional Memory views or future delegation adapters never
extend these prerequisites.

| Priority | Plan / PR claim | Status | Next action / eligibility |
| --- | --- | --- | --- |
| P1 | [unified-session-records](plans/unified-session-records.md), #669 | `in-progress` | First integration: re-review submitted fixes at `6458abb1`, reconcile OQ-1 with the recorded approval, and pass the gate. |
| P1 | [user-input-request-recovery](plans/user-input-request-recovery.md) | `draft` | Next shared Agent claim after #669: visible/recoverable questions, 60-second default, typed no-answer outcome, session-local drafts. Its incident OQ-1 is diagnostic, not a start blocker. |
| P2 | [background-task-continuation-policy](plans/background-task-continuation-policy.md) | `draft` | Prefer after question recovery; ratify the service-exit OQ-1. Ship launch/handoff, exact-event acknowledgement, independent watch and receipts together. |
| P2 | [conversation-work-folders](plans/conversation-work-folders.md) | `draft` | After #669 by selected Thread/context order, with its own OQ-1 ratified. Prefer after interaction fixes and before scheduling on Project resolution, CLI and composer owners. |
| P2 | [scheduled-work-redesign](plans/scheduled-work-redesign.md) | `draft` | Requires unified records and OQ-1/OQ-2. Prefer after input, Task policy and work folders; one complete UI/CLI feature consuming their final owners. |
| P2 | [memory-agent-profile: Node retention quality](plans/memory-agent-profile.md#implementation-ownership-and-complete-delivery-units) | `draft` | Eligible now on Memory-local files; preserve the existing source interface during #669. Freeze quality/coverage fixtures before implementation. |
| P2 | [memory-agent-profile: Profile files and direct learning](plans/memory-agent-profile.md#implementation-ownership-and-complete-delivery-units) | `draft` | After #669 and selected Node-quality changes. Demonstrate edit/source/activation contracts before consumers; parallel with the Agent lane only where shared context/configuration owners remain settled. |
| P2 | [targeted-thread-recovery](plans/targeted-thread-recovery.md) | `draft` | Requires final records and profile owners. Prefer after other selected lifecycle consumers; verify exact question, Task, Project and scheduled-run closure through their actual owners. |
| P2 | [file-preview-office](plans/file-preview-office.md) | `draft` | Prove no-Python DOCX/XLSX extraction and archive policy first; cut over Agent and preview in the same feature. Order overlapping file-tool changes after #669; take the first preview-shell claim and ship all three readers together. |
| P2 | [url-static-reader](plans/url-static-reader.md) | `draft` | Network/image-policy and existing Agent-mode fixtures can start now. Prefer after Office on preview shell/extraction wiring; preserve each caller's acquisition authority without a renderer fetch path. |
| P3 | [computer-pilot-managed-skill](plans/computer-pilot-managed-skill.md) | `draft` | Prove both Skill and CLI acquisition plus packaged/TCC behavior. Refresh #669 Host/resource overlap; use current file-backed admission and per-execution output ownership. |

### Decisions and implementation preparation

Merging a plan records its design; it does not settle every explicitly retained
open question. Reuse existing PM decisions instead of requesting them again.

| Scope | Decision / preparation still to resolve | Effect on execution |
| --- | --- | --- |
| Unified records OQ-1 | #669 says cross-Profile persistent roots, Automation roots and self were approved, with exclusions/delegation isolation. Reconcile the plan's remaining OQ wording with that approval at the gate. | Do not silently broaden discovery or turn an already accepted decision into a new serial vote. |
| Background policy OQ-1 | Confirm whether all handed-over service exits, including nonzero/uncertain exits, stay factual UI updates without an Agent reply unless a watch exists. | Gates this feature's implementation; question recovery can proceed independently. |
| Work folders OQ-1 | Confirm multi-folder Projects, primary initialization and independent existing-chat move/folder semantics. | Gates Project/folder implementation, not Memory or question recovery. |
| Scheduled work OQ-1/OQ-2 | Confirm local current-state catch-up/missed-once behavior and the task/result workspace with one primary work location. | Gates the scheduling feature; it is not a prerequisite for profile learning or targeted recovery. |
| Profile core unit | Show direct edit, scoped correction, source removal, interrupted save and next-Turn activation examples. | Internal contract work before consumers in the same complete feature, not an extra proposal phase or mandatory approval inbox. |
| Office / URL / Computer Pilot | Resolve parser/archive policy, shared remote-image policy, and reproducible CLI acquisition respectively. | Bounded technical preparation inside each feature; dependency/build ownership still requires coordination. |

### Shared-owner handoffs

- **Thread/Turn and records:** #669 claims `ThreadService`, `TurnLifecycle`,
  `ThreadCatalogOps`, resource/source publication, `ToolRuntime`, `agentLocalTools`,
  `stablePrompt` and shared specs. Its interface fixes land before consumers
  rewrite those areas. An ordinary file reference does not grant source access,
  process control or authority to replay work.
  Work folders and question recovery follow #669 because of this active rewrite;
  readable-record publication is not their intrinsic product prerequisite.
- **Input and Task lifecycle:** question recovery owns deadline/settlement and
  renderer draft state; background policy owns Task responsibility/disposition.
  Scheduling consumes both. Timeout keeps the same execution and slot until its
  owner settles. It clears only the exact question cause, not unread results or
  unrelated issues. No consumer adds a second timer or completion ledger.
- **Project and scheduling:** a conversation default supplies an explicit initial
  choice only. A scheduled assignment saves its own work location and resolves
  Project primary through the Project owner; later conversation edits cannot
  redirect it. CLI packaging/admission is shared, not a second management server.
- **Memory and recovery:** Node quality precedes profile learning by selected
  Memory-file order. Scheduled work can consume existing configuration without
  waiting for profile learning. Recovery must fence whichever accepted profile,
  Task, question, Project and run references actually exist; losing a source
  Thread is not implicit forgetting of an accepted user-wide preference.
- **Preview and peripheral work:** Office/URL share preview shell, translation and
  Agent extraction files. Computer Pilot can use existing managed-Skill and
  resource owners after its exact Host overlap is resolved. Settings WorkingText
  and the heading toggle have separate renderer entry points; they do not depend
  on completion of the Agent queue.

## Other Active Plans

These are independent complete units or explicit closure/verification work.
None implicitly blocks the primary queue. Refresh actual file scopes before
claiming; an aggregate's optional additions do not reserve an entire subsystem.

| Priority | Plan | Status | Start condition and collision boundary |
| --- | --- | --- | --- |
| P2 | [semantic-working-state](plans/semantic-working-state.md) | `draft` | Eligible now: Settings-only WorkingText consumer over #656; no provider/Skill lifecycle changes. Coordinate the exact Settings component/spec scope. |
| P3 | [floating-toolbar-polish](plans/floating-toolbar-polish.md) | `draft` | Two complete claims: renderer heading toggle is eligible now; atomic tagged extraction is separately eligible after shipped #598 and needs coordinated Core command/type ownership. |
| P3 | [performance-optimization](plans/performance-optimization.md) | `draft` | Three independent unmeasured candidates: Core indexes, filename fallback and text normalization. Freeze current-operation baselines before implementation; close immaterial candidates without a rewrite. Order Core changes with tagged extraction and refresh the actual `nativeLocalFileHost` overlap rather than assuming all search work waits for #669. |
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

- **Execution-order audit** (`done`, 2026-09-09) - reconciled 15 active plans, #669's review state, contract dependencies, selected integration lanes and product gates; runtime features remain in their own rows.
- **Design-validity audit and delegation closure** (`done`, 2026-09-09) - audited 15 designs, revised five and retained nine; the three shipped delegation units are [archived](plans/archive/agent-delegation-runtime.md), with graduation measurement preserved separately and no experimental graduation claimed.
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
  and separate external Runner adapters; its three runtime units subsequently
  shipped in #623/#628/#637 and the aggregate is now archived.
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
