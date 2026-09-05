# Changelog

All notable changes to Tenon are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries reference the pull request that introduced them when one exists.

## [Unreleased]

`main` is the `0.8.0` train; entries here move under the next tag.

### Added

- **Agent Trajectory now preserves exact execution evidence end to end (PR
  #627, codex-2)** — Context, provider Request and Assistant response, Tool
  Input/Output, Raw, and copy now expose the complete retained value from their
  named runtime boundaries or report that evidence unavailable; restart and
  fork retain the same fidelity. Bounded ledger summaries remain navigation
  aids without becoming evidence, while the old sanitization/truncation paths,
  `partialCoverage` state, and unreachable trajectory export route are removed.
  Gate review found a High transport-telemetry secret leak plus Medium
  provider-ID correlation and spec/plan drift defects; all were fixed before
  the final no-findings review. Verified with typecheck, `docs:check`, 2,898
  passing Core tests with 6 skipped, 37 focused renderer tests, whitespace
  checks, and five successful GitHub E2E samples on the implementation head;
  the docs-only final head's non-gating samples remained running at merge.

- **Background Bash now runs as durable generic Tool Tasks (PR #623,
  codex-4)** — explicit background commands return persistent Thread-owned task
  handles, while foreground commands keep waiting on the same supervised path
  until factual terminal settlement. A packaged standalone supervisor owns
  nonce-bound process identity, heartbeat and quiescent receipts, exact stdin,
  bounded output and artifacts, process-group cancellation, restart recovery,
  durable admission leases, storage pressure, retention, and exactly-once root
  completion delivery. Generic `task_status` / `task_stop` controls and a shared
  task strip expose progress, detail, cleanup, and terminal truth without adding
  delegation concepts. Gate review found one High queued-foreground
  cancellation/shutdown race and one Medium packaged environment leak; both
  were fixed before the final no-findings review. Verified against current
  `main` with typecheck, `docs:check`, whitespace checks, 2,896 passing Core
  tests with 6 skipped, 1,519 renderer tests, focused Tool Task and Bash suites,
  plus the branch's packaged build and real packaged-supervisor smoke; the non-
  gating five-sample GitHub E2E signal remained running at merge.

- **Links, Source previews, and view controls now share one consistent
  interaction model (PR #621, codex-3)** — pasted bare URLs keep their canonical
  identity while link-marked content opens externally; managed assets, linked
  files, and YouTube sources default to visible previews while generic URLs stay
  explicit. Attachment preview and title selection now form one stable frame,
  field-only children participate in disclosure without changing content
  insertion, and optimistic Tab relocation preserves the intended editor focus.
  Outline and Table use the same full configuration toolbar, while the Node
  context menu owns the pointer- and keyboard-accessible **View as** submenu;
  saved grouping remains dormant in Table and returns in Outline. Gate review
  found four Medium toolbar-default, design-guard, disclosure-test, and Table-
  projection defects; all were fixed before the final no-findings review.
  Verified with typecheck, `docs:check`, 2,865 passing Core tests with 6 skipped,
  1,514 renderer tests, targeted interaction Playwright flows, 18 light/dark
  runtime surface checks, four inspected light/dark screenshots, whitespace
  checks, and five successful GitHub E2E samples plus baseline subtraction.

- **Agent delegation now has an approved execution plan (PR #620, codex-4)**
  — the merged design replaces Subagents and isolated Skills with generic durable
  Background Tool Tasks, a Skill-guided `delegate` CLI, hidden root-owned Agent
  Sessions, Host-attested direct-exec launch admission, settlement and
  cancellation fences, lifecycle/retention rules, and one complete feature per
  delivery unit. Gate review found High design-contract defects across Runner
  authority, delivery settlement, cancellation, process truth, and launch
  capability scope; all were fixed before the final no-findings review. Verified
  with `docs:check`, whitespace checks, product-spec inspection, and green PR
  E2E signal samples. This is design authority only: runtime behavior remains
  unchanged until #623 and the later internal delegation cutover ship.

- **Trajectory inspection now pages live history through a bounded, truthful
  window (PR #625, codex-2)** — main reads only the Turn ranges needed to cover a
  record page, caches bounded completed-Turn summaries, and coalesces live tail
  refreshes; renderer retains at most three contiguous pages without hiding an
  unloaded gap or evicting the selected page. Gate review found one High sparse-
  ordinal paging defect and two Medium cache/export and empty-catalog boundary
  defects; all were fixed with dense Turn ranks, cache-independent authoritative
  export reads, and an explicit final catalog fingerprint. Verified with
  typecheck, `docs:check`, 2,862 passing Core tests with 6 skipped, 57 focused
  Core tests, the targeted Electron Trajectory E2E, two additional light/dark
  visual passes, and five GitHub E2E samples with green baseline subtraction.
  This ships only the plan's paging/performance unit: exact Context, Request,
  Assistant, Tool Input/Output, Raw, copy, restart, and fork evidence remains the
  active exact-or-unavailable unit and is not claimed complete.

- **Dynamic model catalogs now publish through generation-safe pi-ai 0.84
  collections (PR #622, codex)** — provider-scoped refreshes carry cancellation
  through the durable JSON store to the final atomic commit, so an older request
  cannot overwrite memory or disk after a newer generation supersedes it.
  Unsaved-credential probes use isolated credential and catalog stores, explicit
  refresh failures remain observable, and unsupported pending/deferred provider
  responses stay out of inspection-only Turn diagnostics. The updated catalog
  adds Baseten and Qwen Token Plan Individual with stable Settings names and
  credential links while retaining Tenon's existing retry, Turn, and transport
  ownership. Gate review found three Medium cancellation-window and regression-
  determinism defects across three rounds; all were fixed before the final no-
  findings review. Verified with typecheck, `docs:check`, build, 2,857 passing
  Core tests with 6 skipped, 1,498 renderer tests, 49 focused tests, 50 repeated
  catalog-race passes, 50 repeated JSON-store barrier passes, and whitespace
  checks; the non-gating five-sample GitHub E2E signal remained running at merge.

- **Outline Agent authoring now uses one semantic interface from intent through
  durable receipt (PR #619, codex-2)** — direct creation, exact reads, bounded
  edits, reusable Fields, Views, Saved Searches, lifecycle operations, imports,
  exports, history, and recovery share one public Node/Field/View/Operation
  vocabulary, while Outline, Table, Cards, and Calendar remain projections over
  the same document state. Registry-derived help, recipes, schemas, permission
  classification, the built-in Skill, and compact receipts now keep common
  workflows executable without storage-shaped traversal or speculative schema
  discovery. Reviewed mutations persist distinct submitted-intent and normalized
  execution identities, replay immutable effect summaries before consulting
  current state, and resolve exact Field identities ahead of same-name lookup.
  The required Operation intent identity advances the Outline workspace to
  storage version 3; pre-#619 v2 workspaces follow the pre-release manual-reset
  policy rather than a compatibility reader. Gate review found three High and
  ten Medium idempotency, receipt, Field-resolution, lowering, probe, and storage-
  boundary defects across four rounds; all were fixed before the final no-
  findings review. Verified with typecheck, `docs:check`, 60 focused tests,
  2,833 passing Core tests with 6 skipped, 1,486 renderer tests, a real 10,000-
  Node Runtime probe, a main-to-PR storage-boundary A/B, whitespace checks, and
  five successful GitHub E2E samples plus baseline subtraction.

- **Child Agent model choices now live in Agent Settings (PR #618, codex-4)**
  — every collaboration Agent type starts by following its direct parent's
  provider, model, and reasoning effort, while an optional user/project setting
  can select a currently usable model without expanding the model-visible
  `agent` tool. Fresh spawns validate before durable admission, persist the
  effective execution snapshot, and visibly fall back to the complete parent
  selection when a saved choice becomes unavailable. Definition, presentation,
  capability, and execution edits remain one atomic configuration write, and a
  custom Role reads execution state only from its winning configuration layer.
  Gate review found one High cross-layer selection leak and two Medium custom-
  endpoint and Settings deep-link defects; all three were fixed before the final
  no-findings review. Verified with typecheck, `docs:check`, 57 focused tests,
  47 Agent Settings Playwright tests, 1,497 renderer tests, and 2,836 passing
  Core tests with 6 skipped and one load-dependent timeout that passed alone in
  1.62 seconds. All five non-gating GitHub E2E samples subsequently passed with
  baseline subtraction also green.

- **Outline Agent workflows now use one direct, closed-loop public interface
  (PR #617, codex-2)** — the built-in Skill routes known work straight to narrow
  porcelain commands and unfamiliar structured work to bounded executable
  recipes, while success, failure, history, projection, watch, asset, and import
  receipts preserve the exact downstream handles needed for the next step.
  Exact-target inputs no longer carry generic query grammar, bulk selection
  requires an explicit bound, and import adapters, test fixtures, maintained
  specs, and packaged Skill content now have separate ownership. The retired
  generated command manuals and reference machinery are gone. Gate review found
  one High compile failure, four Medium bounded-selection and receipt gaps, and
  two Low control-encoding and spec-drift defects; all seven were fixed before
  the final no-findings review. Verified with typecheck, `docs:check`, the
  packaged Outline build, 57 focused CLI/interface tests, 2,748 passing Core
  tests with 6 skipped and one load-sensitive timeout that passed alone, and
  whitespace checks. The non-gating five-sample GitHub E2E signal remained
  running at merge.

- **New Threads gain a taught `Command+Shift+O` path and calmer send placement
  (PR #616, codex)** — the registry-owned shortcut uses the existing
  provider-gated, single-flight creation path, opens the Agent rail on success,
  and appears in the New Thread control's native title and accessibility
  metadata. The always-visible Thread-wide Trajectory header action is gone,
  while response actions, native message menus, and the Trajectory workspace
  retain contextual inspection. Sends from transcripts that still fit one
  viewport remain in natural flow; overflowing transcripts retain top anchoring,
  including when a same-turn send supersedes an unsettled disclosure anchor.
  Trajectory details also preserve provider cache-breakpoint JSON paths instead
  of rejecting them as non-digests. Gate review found one Medium disclosure/send
  transaction handoff defect; it was fixed before the final no-findings review.
  Verified with typecheck, `docs:check`, 2,806 passing Core tests with 6 skipped
  and one isolated passing fixed-timeout case, 1,486 renderer tests, focused Core
  and Playwright coverage, light/dark visual checks, whitespace checks, five
  successful GitHub E2E samples, and ten repeated passes for two unrelated
  low-rate E2E signals.

- **Agent Turns now receive one compact semantic context language (PR #611,
  codex-3)** — model-visible dynamic context uses explicit application or
  untrusted authority and observation or instruction purpose without exposing
  canonical payload kinds, reducer state, hashes, or renderer correlation IDs.
  Every real Pane target is described through readable Node, file, directory,
  asset, URL, or Thread identity; input admissions add local time, changed
  working directory, execution mode, distinct focus and selection, supplied
  content, capability changes, and lifecycle recovery only when relevant.
  Host registration exclusively authorizes application instructions, opening a
  resource never implies its content was supplied, and reset, compaction, fork,
  Continue, Rerun, and steering retain their separate canonical semantics. The
  user-view and additional-context payload rewrite is a strict pre-release
  storage cut: pre-#611 installed and clone-scoped Agent stores must be reset
  with every Tenon process stopped. Gate review found three Medium active-Node
  trailing-focus, directory-reference, and observation/instruction-boundary
  defects; all were fixed before the final no-findings review. Verified with
  typecheck, `docs:check`, 46 focused Core tests, 2,805 passing full Core tests
  with 6 skipped and one load-dependent timeout that passed alone, 1,485 full
  renderer tests on the implementation head, and whitespace checks; the
  non-gating five-sample GitHub E2E signal remained running at merge.

- **Web search now recovers trustworthy Google results after provider markup
  drift (PR #615, codex)** — ranked organic candidates preserve direct links and
  opaque Google `/goto` capabilities, while a bounded JavaScript-disabled
  provider window intercepts the first main-frame redirect before the external
  result page is requested. Every recovered target is revalidated as
  credential-free external HTTP(S), DuckDuckGo remains the final fallback, and
  genuine empty SERPs stay distinct from challenges, extraction drift, and
  transport failures. Search metadata remains discovery-only evidence until
  `web_fetch` observes the admitted source. Gate review found two Medium
  authoritative-empty and redirect-probe coverage defects; both were fixed
  before the final no-findings review. Independently verified with typecheck,
  `docs:check`, 32 focused Core tests, and the Electron probe build; the branch
  also reported a 12/12 live Electron search-to-fetch probe, 2,775 passing full
  Core tests with 6 skipped and one load-dependent timeout that passed alone,
  and five successful GitHub E2E samples plus baseline subtraction.

- **Tenon-owned tools now return one enforced semantic result protocol (PR
  #613, codex-3)** — all 22 built-in model tools report success, unchanged,
  partial, denied, or recoverable failure through one Kernel-compiled compact
  header while native MCP, plugin, extension, and other owner results retain
  their own content. Closed per-tool output schemas bound every visible field;
  large file patches are clipped before validation with full Host-private
  details retained, and typed Goal, Thread-history, Automation, and task-stop
  failures remain actionable without disguising unexpected exceptions. Durable
  persistence transforms only the first Tenon header and preserves supplemental
  JSON, document text, native media, and exact unchanged header bytes. Gate
  review found two Medium oversized-patch and business-failure-classification
  defects; both were fixed before the final no-findings review. Verified with
  typecheck, `docs:check`, 406 focused Core tests, a real 10,000-line file-write
  probe, 2,781 passing full Core tests with 6 skipped and two load-dependent
  timeouts that passed alone, and five successful GitHub E2E samples.

- **Delegated Agent history now remains factual across later work (PR #614,
  codex)** — every terminal generation projects an immutable receipt with its
  exact outcome, bounded error, stop provenance, stable parent Item identity,
  partial-output evidence, and direct-parent notification state. Historical
  spawn, resume, and delivery surfaces read that receipt while the stable Agent
  independently reports current liveness, so a failed or user-stopped run cannot
  become Working or Finished after a resume and cannot make the active root look
  failed. Isolated Skills use the same durable terminal pipeline without owing
  parent delivery, and content-free machine Items remain absent from transcript,
  spacing, copy, and accessibility output. Gate review found two High terminal-
  receipt and continuation-anchor defects plus two Medium stop-provenance and
  deterministic E2E-copy defects; all were fixed before the final no-findings
  review. Verified with typecheck, `docs:check`, 287 Core/protocol tests, 134
  targeted renderer tests, two review-relevant Playwright flows, light/dark
  visual QA, whitespace checks, and five successful GitHub E2E samples whose
  classifier reported no branch-introduced failures.

- **Failed Agent Turns now offer distinct Continue and Rerun recovery (PR #612,
  codex)** — Continue preserves the failed Turn and appends a linked Turn from
  complete settled canonical evidence without redispatching historical tools;
  Rerun deliberately replays every accepted input batch and replaces only the
  current-history projection while rollout audit retains the source. Main owns
  eligibility, projection validation, stale-state revalidation, and explicit
  confirmation whenever a settled tool may run again. Provider request Retry
  and stream Reconnecting remain transient states inside the same active Turn,
  and host-only continuation input stays out of the visible transcript. The
  persisted whole-Turn marker rename to `history/rerun` is a strict pre-release
  storage cut: pre-#612 installed and clone-scoped Agent stores must be reset
  with every Tenon process stopped. Gate review found two Medium finalization
  probe and admission-lock ordering defects across two follow-up rounds; both
  were fixed before the final no-findings review. Verified with typecheck,
  `docs:check`, 1,477 renderer tests, 243 ThreadService tests, 390 focused Core
  recovery tests, 61 focused renderer tests, two recovery Playwright flows,
  light/dark action-row and confirmation-dialog visual QA, and whitespace
  checks. The final-head non-gating five-sample GitHub E2E signal remained
  running at merge; the UI-bearing implementation head reported no introduced
  failure against the fifteen-sample `main` baseline.

- **Agent tool execution now separates Host identity from provider replay
  correlation (PR #610, codex-4)** — every provider call receives a fresh UUIDv7
  for Items, events, persistence, causation, and execution, while bounded
  provider IDs and source-model metadata remain Host-private correlation for
  replay. Empty or repeated IDs are healed into paired portable IDs; exact
  same-model history restores provider IDs and opaque thought signatures, while
  cross-model projection derives collision-safe pairs and removes signatures.
  Replay-metadata overflow still executes in the active Turn and later becomes
  bounded evidence, corrupt persisted envelopes fail closed, and renderer DTOs
  never expose the provider envelope. This is a strict pre-release storage cut:
  pre-#610 installed and clone-scoped Agent stores must be reset with every Tenon
  process stopped. Gate review fixed four plan-level identity, signature,
  decode-boundary, and active-history contradictions plus one Medium
  implementation ordering defect; final re-review found no reportable issue.
  Verified with typecheck, `docs:check`, 1,472 renderer tests, 2,756 passing Core
  tests with 6 skipped and one isolated passing high-load timeout, 48 focused
  fix-head tests, real Anthropic/OpenAI/Google serializer probes, and whitespace
  checks; the non-gating five-sample GitHub E2E signal remained queued at merge.

- **Skills now advertise exact invocation input contracts (PR #609, codex-2)**
  — the model-visible catalog distinguishes load-only inline Skills,
  parameterized inline Skills, and isolated exact-task execution before the
  shared `skill` tool is called. Authored hints and argument names remain the
  primary parameter contract, while supported placeholder-only Skills retain a
  generic input path instead of losing their values. Catalog pressure first
  removes repeated load-only prose, then uses compact `[A]`, `[I+]`, and `[I-]`
  labels, and finally keeps a deterministic fitting prefix, so the catalog never
  exceeds its 8,000-character accounting budget without weakening runtime
  admission. Gate review found two Medium argument-compatibility and hard-budget
  defects plus one Low specification contradiction across two follow-up rounds;
  all were fixed before the final no-findings review. Verified with typecheck,
  `docs:check`, 86 focused Core tests, explicit long-name/load-only/parameterized/
  isolated/mixed budget probes, whitespace checks, and five successful GitHub
  E2E samples plus baseline subtraction.

- **Agent conversations can now reference and safely inspect other Threads (PR
  #608, codex)** — typing `@` in the Composer searches same-profile root Threads
  and inserts canonical inline references that survive editing, persistence,
  transcript Markdown, and keyboard or pointer navigation. The new bounded
  `thread_search` and `thread_read` tools expose archived and active history as
  untrusted quoted context without waking, resuming, forking, or mutating the
  source Thread; signed match/page cursors preserve exact navigation while
  optional historical file citations copy through the unified Agent resource
  lifecycle. Tool-output reads stream and verify complete payloads while
  retaining only a 4,000-character projection, apply secret and local-path
  redaction across truncation boundaries, and never materialize unbounded output.
  Per-Thread indexed limits keep synchronous history search both fair and bounded.
  Gate review found four High and four Medium navigation, search-fairness,
  payload-memory, concurrent-copy, query-cost, and credential-boundary defects
  across four follow-up rounds; all were fixed before the final no-findings
  review. Verified with typecheck, `docs:check`, 1,472 renderer tests, 46 focused
  Core tests, targeted Thread-reference E2E, light/dark visual QA, whitespace
  checks, and a 500,000-row history probe using the partial index without a
  temporary sort.

- **Agent files now use one lifecycle from capture through final delivery (PR
  #607, codex-3)** — canonical Agent resource references independently retain a
  current source locator and an immutable exact revision in the shared
  ContentStore, replacing per-Thread binary payload ownership. Ordinary root
  conversations receive isolated managed workspaces inherited by children;
  final `[[file:///...]]` citations preserve model-authored text while binding
  Preview/Open to delivered bytes and Reveal to the current source. Missing or
  denied citations remain honest neutral read-only references, and delegated
  children keep complete answers while parent context receives a bounded text,
  reference, coverage, and transcript-fallback projection. This is an
  intentional strict pre-release storage cut: pre-#607 installed and
  clone-scoped Agent stores must be reset with every Tenon process stopped
  before packaged/development first-launch verification. Gate review found five
  High resource-retention, authority, capture-race, intent, and cleanup defects
  plus one Medium citation-affordance regression; all were fixed, and final
  re-review found no reportable issue. Verified with typecheck, `docs:check`,
  2,724 passing Core tests with 6 skipped and one isolated passing timeout,
  1,469 renderer tests, 296 focused lifecycle tests, 19 cursor-affordance E2E
  tests, light/dark visual QA, whitespace checks, and five successful GitHub E2E
  samples plus baseline subtraction.

- **Outline agents can now express complete resource intents through compact CLI
  workflows (PR #606, codex)** — `outline add --input -` accepts a mode-neutral
  viewed-tree request with up to 10,000 direct items and lowers it into one
  atomic Operation without caller-authored IDs or binding graphs. The new
  `outline view inspect` command composes paginated public reads into compact
  final-state evidence, while deterministic ANSI-free receipts keep ordinary
  output below 4 KiB using typed counts, samples, omission evidence, and digests;
  exact schemas, JSON envelopes, and Diff artifacts remain complete. The
  built-in Outline Skill now routes through porcelain first, sends literal
  structured stdin directly to Bash, selects direct commit versus reviewed
  Diff/apply, and verifies consequential work with one narrow read. Long-lived
  watch streams use record- and byte-bounded backpressure and terminate overflow
  with `resync.required` instead of retaining an unbounded producer backlog.
  Gate review found one High partial-JSON failure and four Medium terminal
  control, error-framing, EPIPE, and backpressure defects; all were fixed, and
  final re-review found no reportable issue. Verified with typecheck,
  `docs:check`, 2,731 passing Core tests with 6 skipped and two known baseline
  failures on the CLI-fix head, 12 focused tests on the final writer head,
  whitespace checks, and five successful GitHub E2E samples on the preceding
  CLI-fix head; the final writer-only head was queued behind another PR at
  merge.

- **Direct audio and video previews now share one polished media HUD (PR #605,
  codex-2)** — Source preview actions recede until whole-preview hover, keyboard
  focus, an open menu, or a coarse pointer needs them, while remaining mounted
  in stable geometry. Audio and video now use the same title, timeline,
  15-second seek, centered play, mute, compact volume, time, and Source-action
  layout; narrow audio keeps mute when its slider hides, and video alone exposes
  fullscreen and the `F` shortcut. Video fullscreen removes inline caps and
  preserves aspect ratio across the viewport, while its frameless contrast
  scrim becomes fully opaque for reduced-transparency and increased-contrast
  preferences. Gate review found one High pair of branch-only URL wrapping and
  Source-row Enter regressions plus two Medium audio-fullscreen and opaque-
  fallback defects. The first follow-up closed three defects, but the same-
  environment classifier kept reporting URL wrapping at `5/5`; a main follow-up
  replaced font-dependent emergency wrapping with an inline control reserve and
  added a narrow-window regression. Re-review found no other reportable issue.
  Verified with typecheck, `docs:check`, 1,460 renderer tests, final-head focused
  renderer tests, repeated critical Playwright runs, whitespace checks,
  light/dark visual QA, and the GitHub E2E signal plus baseline subtraction.

- **Bash can now receive large literal stdin without shell interpolation (PR
  #604, codex)** — foreground `bash` calls accept up to 64 MiB of exact UTF-8
  input through a backpressure-aware child-process stream, with explicit EOF and
  unified early-close, abort, timeout, output, and process settlement. A generic
  tool-owned large-text contract factors eligible JSON argument paths into
  Thread-private, content-addressed dependencies while preserving canonical
  replay, secret scanning, quota accounting, fork/copy, rollback, pruning, and
  deletion. Renderer IPC exposes only item-bound argument identities and bounded
  presentation, including Turns nested inside inherited context; shared RFC 6901
  ordering and exact deep-JSON accounting keep reconstruction and display
  deterministic. Constrained Agents classify stdin consumers from the same
  parsed Bash authority used by capability policy. The context dependency
  manifest is an intentional strict pre-release storage cut: pre-#604 installed
  and clone-scoped Agent stores must be reset with every Tenon process stopped
  before packaged/development first-launch verification. Gate review found four
  Medium privacy, retention, ordering, and display-budget defects; all were fixed.
  A later compatibility finding was withdrawn after confirming the ratified
  clean-reset contract, which is now explicit in the spec and codec guard.
  Verified with typecheck, `docs:check`, 2,727 passing Core tests with 6 skipped
  and one known main-baseline plan-reference failure, 1,461 renderer tests,
  whitespace checks, and all five GitHub E2E sample jobs plus baseline
  subtraction.

- **Outline Sources now present previews as part of the ordinary row flow (PR
  #599, codex-2)** — the selected preview renders before editable Node content
  and its ordinary URI field, with one marker/guide rail and independent child
  disclosure, preview visibility, and Source selection. Images keep intrinsic
  pixels, media keeps native playback chrome, documents keep reader controls,
  recognized YouTube links use bounded click-to-play embeds, and unsupported
  files retain actionable metadata. The shared More + Close group stays inside
  each preview while short or narrow previews fall back to the owning pane for a
  usable action menu. Exact single-line bare-URL paste into an empty ordinary
  Node atomically creates content plus Source without converting prose,
  multiline input, protected text, or non-empty rows. Repeated gate review fixed
  optimistic-row height flashes, Source-value row parity, disclosure ownership,
  stale guide measurement, ready-preview remounts, global focus modality,
  newline URL classification, and short-preview menu collapse; final review
  found no reportable issue. Verified with typecheck, `docs:check`, 22 focused
  renderer tests, 22 attachment E2E tests, whitespace and synthetic-merge
  checks, light/dark evidence, real Electron YouTube verification, and the
  non-gating five-sample GitHub E2E signal plus baseline subtraction.

- **URLs, files, and managed media now share one ordinary Outline Source model
  (PR #598, codex)** — captures, imports, paste/drop, previews, search, Agent
  context, and the public CLI now use ordinary content Nodes plus editable URI
  field values under the stable built-in `field:source` identity. New Nodes have
  no automatic URI entry; entries and values remain normal movable, nestable,
  clonable, and deletable Nodes, while labels named `Source` or `URI` gain no
  special behavior. Managed assets become live only through atomic lease
  settlement, and external files resolve through persistent exact-file grants
  bound to verified open handles, so path or symlink races cannot widen access.
  Preview selection remains local view state, and the retired image/attachment
  Node variants, URL field type, media commands, scalar metadata, and dedicated
  renderer branches are removed in one pre-release protocol cut. Repeated gate
  review fixed verified-handle authority, managed-media search consistency,
  Link/Replace File rollback, generic URI lease consumption, converged-entry
  ordering, stale specs, and expired-before-GC asset publication; final review
  found no reportable issue. Verified with typecheck, `docs:check`, 1,437
  renderer tests, focused Source/asset/Runtime and Playwright suites, whitespace
  checks, and all five GitHub E2E samples plus baseline subtraction.

- **Agent composers now recall complete prior inputs (PR #587, codex-3)** — plain
  Up and Down at the first or last visual line navigate only canonical
  reader-authored messages from the exact Thread, while preserving the unsent
  scratch draft, per-entry working edits, selection, Node/file references,
  attachments, and session-known image previews. Menus, IME composition,
  modified arrows, multiline movement, and pending attachment admission keep
  their existing keyboard ownership. Every canonical provider-role user Item now
  carries an explicit `reader`, `agent`, `host`, or `feature` author through
  admission, persistence, rebuild, Retry, fork, projection, and transcript
  rendering; only reader-authored terminal input is editable or enters history,
  and content-free machine input creates no empty speaker or accessibility row.
  The pre-release persisted-schema cut is intentionally strict, with no migration
  or compatibility reader: pre-#587 installed and clone-scoped Agent stores must
  be reset with every Tenon process stopped before packaged/development
  first-launch verification. Gate review found one High author-admission failure
  and two Medium specification/preview-retention defects; all three were fixed,
  and the final review found no new reportable issue. Verified with typecheck,
  `docs:check`, 1,448 renderer tests, 2,651 passing Core tests with 6 skipped, 7
  focused Chromium history tests, whitespace checks, and all five GitHub E2E
  samples plus baseline subtraction.

- **The Outliner now runs behind one standalone Runtime and public `outline` CLI
  (PR #584, codex)** — desktop and CLI are equal versioned clients of the same
  Selector, Projection, ChangeSet, Diff, Operation, Event, recovery, and
  idempotency contracts. Every accepted mutation settles its document update,
  Operation, recovery patch, asset delta, idempotency receipt, and Event sequence
  in one fsynced `WorkspaceTransactionLog` record; verified replay, snapshot
  compaction, exact revert, bounded streams, private authenticated discovery,
  and unknown-settlement lookup cover restart and interruption. A neutral
  multi-process ContentStore now retains exact revisions through mechanical
  anchors while Runtime-owned AssetRecords track document and thumbnail edges,
  recovery protection, logical collection, and central physical garbage
  collection. The built-in `outline` Skill and import adapter converge Agent and
  Tana workflows on the CLI instead of owning another document path. The former
  main-process document authority, six native Node tools, Import Pack API and
  writer, `tenon-import`, and old asset/persistence paths are removed. Ultra gate
  review found two cleanup-durability defects: interrupted staging could lose its
  ownership record, and successful unlink could be acknowledged before its
  parent directory was fsynced. `0819a9a0` and `5a280cbb` fixed both with
  journal-first staging, recoverable cleanup ownership, unlink plus parent-
  directory fsync settlement, and retained retry state on fsync failure.
  Verified with typecheck, `docs:check`, generated contract guards, 2,557 passing Core tests
  with 6 skipped, 11 focused ContentStore tests, whitespace checks, and all five
  GitHub E2E samples plus baseline subtraction.

- **Node and file references now use one canonical URI contract (PR #590,
  codex-4)** — every current producer and consumer emits `[[node://...]]` or
  `[[file:///...]]`, keeps display names outside identity, resolves Node titles
  live, and admits only UUIDv4 Nodes plus the explicit public system-Node set.
  Private, malformed, unsupported, and consumer-disallowed references degrade
  without exposing internal IDs or aborting the surrounding user action. The
  shared codec preserves identity across rich text, Markdown entities and
  escapes, Agent outline round trips, context projection, search, paste, and
  Thread rendering, while a cutover guard keeps the retired marker grammars out
  of product authority. Repeated deep review exercised public/private candidate
  admission, semantic punctuation, nested and duplicate markers, protected
  literals, display normalization, entity/source alignment, focused-editor
  refresh, and reasoning reachability; every reported finding was fixed and the
  final adversarial matrix found no reportable issue. Verified with typecheck,
  `docs:check`, 2,667 passing Core tests with 6 skipped, 1,382 renderer tests,
  467 additional cross-surface checks, 155 review-only assertions, 14 affected
  E2E tests, whitespace checks, and all five GitHub E2E samples plus baseline
  subtraction.

- **Large pastes now become linked composer attachments (PR #586, codex-4)** —
  pasting at least 4 KiB of plain text creates a managed `Pasted.txt`,
  `Pasted-2.txt`, and so on instead of flooding the editor; smaller pastes stay
  inline. Every image, file, and pasted-text attachment now has one linked inline
  marker and preview-first tray card, with marker selection from the tray,
  identity-driven removal, narrow-rail edge navigation, and light/dark native
  styling. Pending uploads block both button and Enter submission, failed
  replacements restore the selected content and its managed ownership, and a
  second paste cannot invalidate a pending request hidden inside its selection.
  Admission is evaluated against the projected final draft, so replacing one
  complete attachment at the 20-item limit remains valid; per-message limits are
  now 20 total attachments, 10 images, and 24 MiB of normalized prompt-image
  observations, while the existing per-file and Thread-storage limits remain.
  Gate review found five Medium defects across two rounds in keyboard admission,
  pending semantics, rollback ownership, nested pending replacement, and
  replacement-at-limit counting; `8abc0938` and `4fa5cb66` closed all five, and
  the final review found no reportable issue. Verified with typecheck, 1,371
  renderer tests, 2,650 passing Core tests with 6 skipped, 12 focused attachment
  E2E tests, 45 design-token guards, docs and whitespace checks, light/dark visual
  QA, and all five GitHub E2E samples plus baseline subtraction.

- **Tana journal dates can now import directly into canonical Daily Notes (PR
  #583, codex)** — the deterministic Tana adapter recognizes only exact
  `journalPart` records with canonical `YYYY-MM-DD` local dates, defaults eligible
  packs to `native_daily`, and previews the date range plus existing/new day
  counts before writing. Date-section roots append to their canonical day nodes;
  mixed non-date sections remain together under one `Import: <source>` staging
  root, and explicit staging mode remains available. Re-import is deliberately
  append-only: it neither overwrites nor deduplicates prior content. The complete
  pack is validated before one main/Core transaction whose bounded date and node
  chunks retain one rollback frontier, one Undo group, and one operation-history
  entry; verification traverses only the exact roots created by that operation.
  Gate review found two Medium defects: padded or title-mismatched dates could make
  preview disagree with commit, and resolving 2,000 date targets beside 12,000
  existing nodes blocked about 5.27 seconds before the first cooperative yield.
  `438221df` closed both with strict raw-value admission and a single indexed,
  yielding Core date resolver. Re-review found no new reportable issues. Verified
  with typecheck, `docs:check`, 172 focused tests, the complete Core suite (2648
  passed, 6 skipped, 0 failed), whitespace checks, and all five GitHub E2E samples;
  the comparison retained one unrelated 1/5 workspace-layout signal on this
  renderer-free diff under the repository's non-gating E2E policy.

### Fixed

- **Definition option catalogs now survive unrelated document edits (PR #632,
  codex-2)** - table field catalogs and definition tag selectors use a semantic
  definition revision instead of whole-index identity. Definition membership,
  names, configuration descendants, and Trash transitions invalidate the cache;
  table usage groups still follow the current record fields. Gate review found
  one Medium stale-grouping defect, fixed by separating the catalog from row
  usage. Verified with typecheck, `docs:check`, 34 focused renderer tests, real
  Core tag deltas, browser field-entry add/remove deltas, light/dark visual
  inspection, and whitespace checks. This completes PR-2 of the interaction-jank
  plan; translation geometry and Runtime-index reuse remain open. Non-gating
  GitHub E2E samples were still running at merge.

- **Renderer interaction chrome now batches scroll work (PR #630, codex-2)** -
  anchored overlays coalesce geometry updates per animation frame and ignore
  unrelated scroll targets; virtualized Flat/Table outliners share one capture
  dispatcher, panel title docking uses its existing frame scheduler, and the
  workspace keyboard listener remains stable across projection updates. This
  completes PR-1 of the `interaction-jank-cleanups` plan; definition caches,
  preview translation geometry, and Runtime index reuse remain separate units.
  Verified with typecheck, `docs:check`, 1,524 renderer tests, and whitespace
  checks; the non-gating five-sample GitHub E2E signal was queued at merge.

- **The desktop window appears before service startup (PR #629, codex-2)** -
  large workspaces now show the native window while document, provider, Agent,
  and search services initialize behind their owning readiness boundaries.
  Startup failures remain visible with Retry and Quit; recovery preserves
  completed milestones, restarts failed projection reads, and restores existing
  Agent conversations. A three-run 10,040-node Electron measurement reduced
  median first paint from 9.18 to 1.71 seconds; full workspace readiness did not
  improve in the same measurement. Gate review found one Medium failure-cache
  defect that left the Agent dock broken after successful Host Retry; it was
  fixed before the final no-findings review. Verified with typecheck,
  `docs:check`, whitespace checks, 103 focused Core/renderer tests, 40 focused
  ThreadStore/startup tests, seven real-Electron startup smoke tests, inspected
  light/dark and minimum-window failure UI, and five successful GitHub E2E
  samples plus baseline subtraction. The author's full Core run retained two
  timing-sensitive failures that passed isolated rechecks; it was not reported
  as a green full-suite run.

- **Development builds start correctly under the Electron main-process ESM
  bundle** — Desktop Host window composition now uses the module directory
  already resolved by the bootstrap entry, and optional macOS native addons
  derive their development path from `import.meta.url` instead of unavailable
  CommonJS globals. A source guard prevents either path from reintroducing bare
  `__dirname`. Verified with typecheck, `docs:check`, focused Host composition
  tests, and a real `dev:main` launch through Outline Runtime and launcher
  hotkey registration. The complete Core suite retained eight unrelated
  load-sensitive failures; seven passed when isolated, while the existing
  ordinary-write SIGINT timing case remained independently reproducible.

- **The standalone Outliner Runtime again carries the complete mature desktop
  experience (PR #592, codex)** — coalesced and optimistic text, structural, and
  field editing now preserve first-frame focus, editor identity, IME continuity,
  middle-Enter splits, mixed selection deletion, and the full keyboard contract
  over one flat incremental projection. Runtime durability restores accepted
  versus durable settlement, held-Event ordering, a 700 ms idle / five-second
  maximum dirty window, batched transaction records under one fsync, replay-safe
  cursors, and a linearizable quit barrier. Memory definition protection,
  publication and citation ordering, personal ranking synchronization, immutable
  asset metadata and URL authority, bounded media parsing, thumbnail retention,
  Runtime replacement, and cross-frame Agent/Outliner focus ownership are also
  restored. Clean quit now stops the exact authenticated Runtime instance after
  draining it, so a packaged relaunch cannot inherit permanently frozen mutation
  admission. A tracked clean-clone audit reconstructs four lost historical trees
  and classifies all 2,307 retained responsibilities with zero unclassified.
  Gate review found two High ordering defects, two Medium recovery omissions, a
  later High packaged-relaunch defect, and an unreproducible audit boundary; all
  were fixed before the final no-findings review. Verified with typecheck,
  `docs:check`, 2,644 passing Core tests with 6 skipped, 1,436 renderer tests, 59
  focused lifecycle/process tests, local and single-branch recovery audits,
  whitespace checks, and all five GitHub E2E samples plus baseline subtraction.

### Internal

- **Workspace and document status audit (2026-09-05)** - refreshed the live
  board against GitHub: #627 is complete, #628 owns the active internal
  delegation implementation, and #626's Settings rewrite remains a draft
  design rather than current specification. Deferred working-state ownership
  to that design gate, aligned README with standalone Outline Runtime ownership
  and Full Access, and verified plan lifecycle, links, aliases, and indexes.

- **Desktop composition now converges behind one race-safe `DesktopHost` (PR
  #603, codex)** — `main.ts` retains fixed Electron identity, security,
  single-instance, readiness, and lifecycle forwarding while the final Host
  composes typed domain/platform owners, transport, windows, deferred producers,
  and reverse-order `ResourceScope` cleanup. Startup is permanently single-flight
  with resumable outer and Agent-internal milestones; quit synchronously closes
  admission, joins startup, preserves Retry/Cancel/Quit Anyway, confirms Runtime
  unfreeze before Cancel, and exits after early or irreversible cleanup even when
  cleanup reports failure. The complete-tree audit follows transport ownership
  into the new composition root, and packaged smoke now verifies Runtime release
  and clean replacement on relaunch. Gate review found four Medium lifecycle
  races across nested producer startup, partial-start Cancel, failed unfreeze,
  and failed early rollback; all were fixed before the final no-findings review.
  Verified with typecheck, `docs:check`, the Host audit, 62 focused Core tests
  across lifecycle/composition/security surfaces, whitespace checks, and all five
  GitHub E2E samples plus baseline subtraction.

- **Electron-native resource, preview, window, and application ownership now
  lives behind typed platform Hosts (PR #602, codex)** — `main.ts` retains
  startup and quit orchestration while `ResourcePreviewHost` owns URL-preview
  sessions, translation, exact-file grants, native file work, caches, and
  streams, and `WindowApplicationHost` owns windows, menus, hotkeys, updates,
  actions, theme, locale, and their reversible effects. Native `mdfind` and
  `rg` searches now have explicit process ownership: close rejects new scans,
  kills and detaches active children, and awaits settlement through the Host
  release chain. The complete-tree audit rejects missing, off-path, duplicated,
  or miscounted platform construction and effect ownership. Gate review found
  two Medium gaps in off-path audit coverage and subprocess release; both were
  fixed before the final no-findings integration review. The rebase also
  preserved the merged trusted URL-preview referrer hardening inside the new
  Host. Verified with typecheck, `docs:check`, the ownership audit, 21 focused
  Core security/composition/lifecycle tests, whitespace checks, and all five
  pre-rebase GitHub E2E samples under the repository's non-gating signal policy.

- **Agent and Outline backend graphs now live behind narrow typed domain Hosts
  (PR #601, codex)** — `main.ts` now composes capability-grouped configuration,
  worktree, Thread, Memory, Automation, Skill, document, asset, renderer, ranking,
  and quit surfaces without retaining concrete services or per-Turn runtime maps.
  Typed assign-once edges close real constructor cycles while explicit startup,
  projection, ranking, durability, Automation, Memory, Thread, and reverse-close
  ordering preserve the existing desktop behavior. The Host audit now inventories
  every required domain construction across the complete `src/main` tree and
  rejects missing, unowned, or globally duplicated services. Gate review found
  two Medium gaps: the first audit ignored duplicate constructors outside
  `hostDomain/`, and the first Host interfaces still exposed mutable service
  bags. Both were fixed before the final no-findings review, including a real
  duplicate-construction negative fixture and end-to-end failure injection.
  Verified with typecheck, `docs:check`, build, 252 focused Core tests, 1,437
  renderer tests, 2,678 passing full-Core tests with 6 skipped and two existing
  failures, whitespace checks, and all five GitHub E2E samples.

- **Desktop Host transport now has explicit, disposable ownership (PR #600,
  codex)** — all 60 IPC channels, custom protocols, session policy, Automation
  resume, and app/process lifecycle listeners are grouped behind named owners
  with duplicate claims, registration rollback, reverse-order idempotent
  disposal, and aggregate release diagnostics. Quit preserves fail-closed
  permission handlers and the renderer CSP until process exit, while chained
  IPC listener registration stays inside the owned facade. A pinned exact-tree
  Host audit records 2,338 baseline effects and rejects unowned, duplicate, or
  missing transport effects, including listener registrations without a
  one-for-one matching release. Gate review found one High permission teardown
  regression and four audit/facade ownership gaps across repeated passes; all
  were fixed before the final no-findings review. Verified with typecheck,
  `docs:check`, build, 39 focused Host/quit/URL-preview tests, the Host audit,
  whitespace checks, and GitHub E2E sampling under the repository's non-gating
  signal policy.

- **The primary delivery chain now maps one substantial plan to one PR claim** —
  five aggregate plans were preserved in the archive and replaced by 12 claim-
  sized plans, while Computer Pilot gained its own plan. Together with five
  existing single-PR plans, they form an 18-PR executable chain over Source,
  four balanced Host ownership/cutover changes, Agent large-text and resource
  lifecycle, root and delegated failure recovery, preview readers, Skill
  maintenance, and Computer Pilot. Internal build stages that do not form useful
  releases stay inside their owning PR: Agent resource references, workspaces/
  citations, and delegated handoff remain one atomic feature. Three planless
  tails were reconciled rather than duplicated: image alt editing becomes
  ordinary Source Node accessible naming after `mediaAlt` retires, exact Skill-
  directory identity joins script authoring before curation, and Computer Pilot
  waits for final Host/resource contracts instead of targeting an about-to-be-
  replaced artifact shape. A source-fidelity audit then made each active plan
  self-contained: it restored the exact Source field/value/codec and resolver
  contracts, paste/capture settlement and mature-preview inventory, reproducible
  Host ownership audit and real-desktop matrix, plus Provider Retry, Rerun
  refusal, rebuild, and generic renderability acceptance. Archived aggregates
  remain provenance rather than required execution inputs.

- **Active plans and the integration board now describe one executable system
  rather than overlapping histories** — the 19-plan audit checked recent Host,
  Source, Agent-resource, cross-Thread, large-text, and Outline-CLI designs
  against current `main`, then separated contract dependencies from file-level
  collision ordering. The clean chain is Source PR-I, complete Host composition,
  Agent large-text projection, and Agent resource lifecycle; Outline CLI,
  Startup Window First, Source PR-F, cross-Thread reference, and recovery branch
  only where their real contracts require it. Partially shipped File Preview,
  Settings working-state, performance, Skill authoring, floating-toolbar, icon,
  and contrast plans now contain only remaining work. Three unapproved or
  premise-drifted directional plans moved to `archive/` as `shelved`. The board
  dropped duplicated shipped retrospectives while retaining every active plan,
  fast-track tail, release gate, standing decision, and recent completion. The
  shipped Conversation/Run/EventStore program and its data-model authority moved
  from `reference/` to `archive/` as `superseded` because Agent Core's
  Thread/Turn/Item specs replaced them; the remaining Memory glossary now maps
  only to the current Daily Timeline model.

- **Large Agent text and efficient Outline workflows now have two execution-ready
  plans (PR #596 and PR #595, codex)** — the shared foundation stores one or more
  tool-selected textual argument paths as typed Thread-private dependencies over
  a bounded JSON skeleton, with exact replay, canonical Item ownership, lifecycle
  settlement, bounded presentation, and no renderer-visible reference. Bash
  `stdin` is only the first consumer: literal foreground delivery and effective
  consumer classification stay public, while Outline command registrations are
  immutable policy data. The dependent Outline plan then uses only that public
  boundary to replace schema exploration, verbose ChangeSet construction, and
  unbounded receipts with a compact mode-neutral view-backed input, direct safe
  commit, bounded inspection, and consumer-owned capacity evidence. Review
  rejected a top-level `stdin`-specific Core envelope, moved the mechanism to
  plural RFC 6901 bindings, separated file/resource identity from internal text,
  and fixed generic Unicode and binding-count admission before approval. The
  implementation order is the large-text/Bash foundation first; the Outline
  feature follows it and Source PR-I.

- **Desktop Host composition now has one execution-ready ownership architecture
  (PR #591, codex-2)** — six complete serial refactors replace the implicit
  `main.ts` graph with static typed domain factories, explicit startup
  orchestration, private lifecycle arbitration, reversible effect ownership,
  capability-grouped transport, and the existing safe-quit authority. Failed
  startup drains accepted local work without claiming ownership of or shutting
  down an authenticated shared Runtime; ordinary quit remains the sole durability
  and irreversible-exit path. Concurrent quit callers share only one attempt, so
  Cancel can restore `started` before a later quit drains again. The final
  dependency order is Source PR-I, the complete Host set, then Agent resource
  lifecycle and Cross-Thread, while Startup Window First independently consumes
  the final `DesktopHost.start()` boundary. Two review rounds corrected stale
  Runtime premises, duplicate readiness authority, consumer-before-foundation
  ordering, and permanent quit-promise caching before approval.

- **Outline resources now have one execution-ready Source architecture (PR #593,
  codex-4)** — URLs, images, and files converge on ordinary content Nodes with one
  protected ordered `uri` Source field, exact content-free `SourceValueNode`
  values, convergent single-owner commands, lossless classification, and
  Host-private exact-file grants. A complete content-first management baseline
  owns every public Source state before the independent preview-first visual
  enhancement; the later Agent resource lifecycle depends only on that baseline,
  not on UI composition. Repeated plan review closed exact-file scope and TOCTOU,
  replica convergence, write admission, protocol ownership and cardinality,
  independently complete delivery, and stale dependency findings before approval.

- **Reference URIs and historical Thread access now have one execution-ready
  architecture (PR #589, main)** — Node and file citations use canonical
  URI-only markers with resolver-owned labels; ordinary internal `node:<uuid>`
  IDs serialize once as `node://<uuid>`, while current referenceable system Nodes
  use explicit public keys. The file lifecycle now distinguishes profile-wide
  resource resolution from container working sets and copies exact bytes before
  editing across managed roots. A separate cross-Thread plan adds lazy
  `thread://` references, bounded history tools with independent capability
  checks, untrusted transcript projection, and explicit historical-file
  selection without exposing bound source locators.

- **Agent results and file handling now share one reference-based architecture
  (PR #588, main)** — the governing plan keeps terminal results as plain text,
  models source locators and exact revisions as independent representations,
  resolves use through profile context and intent, and limits the neutral
  ContentStore to exact bytes, retention anchors, integrity, and garbage
  collection. The
  Outliner Runtime and Composer History plans now consume that authority without
  introducing physical ownership, a managed artifact directory, structured
  Agent results, or compatibility storage paths.

## [0.7.0] - 2026-08-23

**Agents you can recognize, inspect, and trust.** Every conversation participant
now has a name and generated face, and the Agents settings page lets you rename,
recolor, and configure your Roles. The new Thread-wide Trajectory workspace
replaces one-Turn-at-a-time Model Interactions, your selected model carries into
the next conversation, and completed tool files remain attached to their Thread
across restarts and forks.

Reliability got the same treatment: long transcripts stay painted, provider
failures retry without losing the request, subagent outcomes and budgets settle
from durable execution facts, and failed node or import writes roll back cleanly.
Automations are reachable again, but Threads created before 0.7.0 retain their
old tool snapshot; start a new Thread to use the repaired automation tool. No
outline workspace migration is required.

### Added

- **Completed Agent tool files now remain durable with their Thread (PR #582,
  codex-3)** — binary `web_fetch` responses, bounded foreground and finalized
  background shell output, and safe files from declared managed-Skill output
  roots enter one `ToolArtifactSink` as tool-Item-owned resources. Their stable
  identity survives restart, fork and inherited context, rollback, deletion,
  quota reconciliation, and pruning; current projection rematerializes readable
  handles while durable history excludes disposed execution paths. Browser
  Pilot roots are execution-scoped, concurrent commands cannot claim each
  other's files, and a later isolated-Skill failure preserves artifacts already
  admitted by embedded shell work. Admission and materialization failures
  degrade to bounded stable warnings instead of exposing canonical store paths
  or killing the surrounding tool operation. Gate review found three Medium
  ownership/replay defects across two rounds; all were fixed, and the final deep
  review found no reportable issues. Verified with typecheck, `docs:check`, the
  full Core suite (2637 passed, 6 skipped, 0 failed), 521 focused passing tests,
  and whitespace checks; one E2E sample was green and four were still running at
  merge time.
- **A Thread now has one investigation workspace for its complete Agent
  trajectory (PR #575, codex)** — **Open Trajectory** replaces the single-Turn
  Model Interactions product route with a Thread-wide timeline, virtualized
  Turn-grouped ledger, synchronized search and selection, foldable Assistant
  calls, bidirectional paging, record-specific lazy inspector, whole-Thread
  usage summary, and child-Trajectory navigation. Main owns the typed projection
  over canonical Turns, Items, retained diagnostics, context payloads, and tool
  outputs; renderer receives bounded, credential-redacted evidence instead of
  raw host paths or diagnostics payloads. Active diagnostics degrade
  best-effort, stable identity cursors remain anchored to canonical coverage,
  live refreshes replace only authoritative windows and retire rolled-back Turn
  IDs and suffixes, and detail responses preserve codec-valid typed envelopes
  under one hard evidence budget. The lower-level audited Turn reader remains
  available for internal validation, but it is no longer a renderer route.
  Gate: `/code-review ultra` repeatedly exercised security, pagination,
  projection coverage, active-Turn refresh, response budgets, rollback, export,
  selection, and spec alignment; every reported finding was fixed before the
  final no-issues review at `ed30abad`. Verified with typecheck, `docs:check`,
  28 focused renderer tests, the complete renderer suite (1366 passed), the
  complete Core suite (2612 passed, 6 skipped), focused Agent E2E coverage,
  typography guards, clean merge-tree/diff checks, and the branch's five-sample
  E2E signal was still queued at merge time.
- **Every participant in a Thread now has a name and a face (PR #560, cc-2)** —
  a reader used to meet `explore`; they now meet **Rena**. Agent Roles carry
  `presentation { persona, color }`, and a `presentationOverrides` map in either
  configuration layer re-skins the built-in types and the reserved `main`
  pseudo-key (defaults: Aspen teal for `main`, Rena orange for `explore`, Ada
  blue for `plan`, Bruno amber for `general-purpose`). `identities/get` on the
  agent protocol resolves the roster against the SELECTED conversation's working
  directory, so a project's own Roles and re-skins are seen; resolution happens
  at render time, never recorded on the message, so renaming a persona renames
  the speaker of every message that Agent ever sent. The face is generated, not
  drawn: one soft form filled with the identity's `--identity-tint-*` hue, two
  round-capped eye strokes cut through a mask to the panel behind — no assets, no
  image generation, no network, and no tile or frame, because the form is its own
  edge. An identity with no configured hue derives one from its type name over
  the hues the roster did not take, with the danger-adjacent red kept out of the
  identity palette. Moods are a parameter set over that stroke rig, so states
  morph rather than swap, and they wire only to state the transcript already
  knows — Turn status for the conversation's own agent, registry outcome for a
  delivered report — so an expression only ever restates the status text beside
  it. `nicknameCandidates` retires into `presentation.persona`.
- **The speaker header replaces unattributed prose (PR #560, cc-2)** — a mark
  beside two stacked lines, WHO over WHAT THEY DID, with the words beneath taking
  the whole column: no avatar lane and no hanging indent, because what arrives in
  a 344px deck is documents — tables, code, galleries — and a lane costs 13% of
  the measure. The work line doubles as the process disclosure, so one header is
  also the only control that opens the timeline. This retires the rule that a
  speaker's glyph shares a column with the content rows beneath it (PM
  2026-08-19): a mark sized to anchor two lines cannot also sit on a 12px chip
  glyph's axis, and identity chrome answers a different question than a content
  row does. Both `agent-thread-rendering.md` and `design-system/patterns.md`
  record the supersession with its reason.

- **A model picked in the composer is now the default for the next conversation
  (PR #566, codex)** — the provider, model, and reasoning effort are remembered
  the moment `thread/configuration/set` commits, not at the first message, Turn,
  or model request, so the choice survives a restart and is shared by `/new` and
  the Thread-list action. Creation revalidates the selection against the current
  catalog and falls back to the active provider plus fresh Configuration Profile
  defaults when it no longer resolves — including when the provider store itself
  fails to read, which must never be the reason a conversation cannot start. The
  overlay replaces only model and effort, so the Profile still owns tools,
  Skills, plugins, MCP servers, developer instructions, and capability ceilings,
  and a request that explicitly names a provider or a Profile keeps its own
  pinned values. Because "which provider starts a conversation" now has two
  possible authors, they follow last-explicit-action-wins: a successful Set as
  Active, a provider disable, a provider delete, and a startup reconcile that
  moves the active-provider pointer each clear the memory, and the next composer
  selection re-establishes it. Archived and ephemeral Thread edits are excluded,
  so nudging the effort on an old conversation no longer repoints every future
  one. A child Agent Role with no model or effort override still inherits its
  parent root Thread's effective values, including one applied from this memory
  — stated in the spec rather than left to be discovered from a token bill.

- **The agents in a conversation are now the user's to name, re-skin, and write
  (PR #565, cc-2)** — an **Agents page** under the Agent settings category,
  beside Model services and Skills: an unbounded collection the user creates and
  carries a lifecycle earns a page, and identities are exactly that. The user's
  own Roles list above the built-ins, each row wearing the same generated mark
  the transcript draws, so the editor and the conversation are visibly about one
  participant. Every agent may be renamed and recoloured; only a Role may be
  redefined, because a built-in's behaviour is code rather than configuration
  and a read-only form would invite an edit the surface cannot accept. An
  existing Role's type is fixed — it is the key both dispatch and identity are
  stored under, so renaming in place would orphan both — and the colour swatches
  are the mark itself, with the chosen one marked on the neutral fill ladder
  rather than tinted (B3/B4). Writing fails closed: `AgentConfigurationWriter`
  re-reads one layer, applies one change, and hands the candidate back through
  **the loader's own parser** before keeping it, restoring the previous bytes and
  reporting why if it would not parse (A12). Validating with a second, kinder
  parser is how the two drift apart, so there isn't one, and a layer that already
  fails to parse is reported rather than replaced — a hand-written configuration
  belongs to whoever wrote it. Clearing a presentation field REMOVES the override
  instead of storing it blank, so the built-in default shows through again and a
  later change to that default still reaches the user. A capability list carries
  its three real states: absent leaves what is on disk, `null` removes the
  narrowing, and a list is the exact set — including the empty list, which is a
  ban and not a grant of everything the parent has. Deleting is confirmed and the
  confirmation states the blast radius, which is narrower than "delete" sounds:
  work already running keeps the definition it started with, and past
  conversations still show who spoke. The deferred `profiles/changed`
  notification lands as the settings-changed broadcast the settings window
  already has rather than a new agent-core channel meaning the same thing, so an
  agent renamed in the editor is renamed in an open transcript at once instead of
  at the next conversation switch.

### Fixed

- **Agent writes no longer duplicate or flatten the first rich value in a reused
  field (PR #579, cc)** — when `node_create` or `node_edit` resolves a field name
  to an existing definition without a stored entry on that owner, the first
  non-option value now crosses the field-slot boundary as canonical `RichText`
  through `appendNodes` instead of literal `appendText`. Marks, link
  destinations, and inline-reference targets therefore survive the first write,
  and the same identity used by reconciliation consumes that occurrence rather
  than appending a second value. Repeated identical desired values still retain
  their multiplicity; empty values keep the virtual slot unmaterialized; option
  and whole-value reference paths are unchanged. Gate review found no reportable
  issues. Verified with typecheck, `docs:check`, 146 focused Agent Node tests,
  and the full Core suite (2586 passed, 6 skipped, 0 failed).
- **CLI-only imports now recover without a write-bypass gap (PR #578,
  codex-2)** — `data_import` is gone from the default model-visible tool
  catalog; `/tenon-import` is the single Agent import workflow. Commit writes now
  cross the local CLI/API boundary with a short-lived, single-use Bash Item
  causation token, while preview rejects normalized duplicate tags and fields
  before staging. Materialization failures roll back every document write and
  history entry, and verification mismatches preserve exactly one staging subtree
  with `staged_with_errors`, `stagingRootId`, `operationId`, `mismatches`, and
  `retryAllowed: false` so the Skill stops instead of retrying or deleting by
  hand. Worktree Agents cannot use Bash or embedded Skill shell to commit into
  the live outline: token issuance and capability classification now consume the
  same parsed shell segments, recognized commit segments always contribute
  `outline.edit`, and the CLI rejects unexpected commit arguments before reading
  the pack or contacting the API. Gate: `/code-review` found one High — import
  token issuance and capability classification used different parsing decisions,
  so a command such as `tenon-import commit ... npm install` could receive the
  write token while being classified only as `shell.dependency_install`;
  `f870c5b7` aligned the parser, added `outline.edit` coverage, and rejected
  extra commit args. Re-review found no reportable issues. Verified with
  typecheck, `docs:check`, `import-cli:build`, focused import/capability/policy
  tests, and five green CI samples plus baseline subtraction.
- **Failed Agent Node tools no longer leave partial outline writes behind (PR
  #577, codex-2)** — the Node catalog now treats an `ok:false` `ToolEnvelope` as
  a transaction rollback signal for every Node tool except `outline_undo_stack`.
  The model still receives the original structured error and recovery guidance,
  but earlier document commands from the same tool call are reverted instead of
  becoming a hidden committed mutation. Regression coverage pins the two
  failure shapes that exposed the bug: `node_create` creating part of an outline
  before a later typed-field validation failure, and `node_edit` applying an
  earlier text patch before a later host command fails. `outline_undo_stack`
  remains outside the wrapper because it owns explicit undo/redo semantics.
  Gate: `/code-review` found one Low — the rollback contract was missing from
  `agent-tool-design`; `d6d2237b` added it, and re-review found no reportable
  issues. Verified on the merge state with focused Node tool tests, typecheck,
  `docs:check`, and whitespace checks.
- **Subagent outcomes now state execution facts instead of task completion (PR
  #573, codex-3)** — a delegated Agent generation no longer reports `completed`
  as though the task itself had been judged done. The terminal vocabulary is now
  factual (`finished` / `failed` / `interrupted` / `killed`), with typed terminal
  errors, stop provenance, local generation usage, retained worktree state, and
  retry-stable delivery Turn identity crossing the process seam. Cold reopen can
  show the settled outcome without loading every child Turn, and renderer delivery
  cards remain attached to the exact parent Turn even after manual Retry or a
  later Agent resume.
- **Subagent budgets and parent settlement are now generation-local and bounded
  (PR #573, codex-3)** — the old shared request-tree token pool is gone: each
  delegated execution generation freezes its own breaker, accrues in-flight usage
  before exposing idle admission, and can soft-land or interrupt without borrowing
  or erasing sibling budget state. When a parent must settle while descendants
  exhausted or overshot, it now uses one durable settlement envelope with explicit
  full/excerpted/omitted coverage, prepared admission, overflow detach, and
  carry-forward rows that survive restart. Provider failures, explicit Stop,
  host restart, task_stop, and close-without-provider paths preserve useful
  output and actual stop provenance rather than launching hidden provider work.
  Gate: `/code-review` found one Medium — the first renderer projection kept only
  the stable Agent record's current delivery Turn, so older delivered generations
  lost their report cards after resume; `705b085e` projected delivered
  notifications per generation and the re-review found no further reportable
  issue. Verified with typecheck, `docs:check`, focused core/renderer tests, and
  five green CI E2E samples plus baseline subtraction.

- **Long Thread transcripts now stay painted through jumps, restores, and send
  anchors (PR #572, cc)** — the transcript has one paint owner at every size:
  eight or fewer Turns use ordinary flow layout, nine or more use the measured
  virtual window, and no Turn delegates paint timing to `content-visibility`.
  Virtual math now uses `.thread-transcript-turns` as the coordinate origin, so
  a tall Goal, content padding, or the Goal-to-Turn gap cannot make the window
  mount the wrong rows. Coverage is a pre-paint invariant rather than an overscan
  hope: imperative scroll/event/rAF writers read the browser-clamped viewport and
  synchronously commit an uncovered range before returning, while layout-effect
  writers prepare coverage in one pass and write `scrollTop` from a later
  generation-tagged layout pass that React still completes before paint. Send
  anchoring stages its optimistic and canonical targets, waits for long-message
  disclosure measurement, keeps ownership until two independent stable frames,
  and no longer lets disclosure captures erase a mounted send spacer. Restore
  and virtual-height compensation now use real visible Turn anchors instead of
  relying on a height delta alone, and first-render long user messages start
  clamped until measurement proves they are short. The intended perf trade is
  explicit: distant uncovered jumps can spend one urgent coverage commit, while
  covered incremental scrolling remains coalesced. Gate: `/code-review` found
  one Medium — transcript control `pointerdown` was canceling send anchors before
  the control click ran; `277f9eb7` fixed the classifier and switched the guard
  to a real Playwright click. Verified with typecheck, `docs:check`, the full
  renderer suite, focused Agent Thread E2E coverage, light/dark visual checks,
  a focused merge-state E2E re-run, and five green CI samples plus baseline
  subtraction.
- **A broken Agent configuration no longer kills the Turn waiting on it
  (PR #570, cc-2)** — a malformed user or project `.tenon/agent.json` used to
  throw while every Turn resolved its persona and Role catalog, ending the
  user's action before the model ran. Turn-time reads now degrade only typed
  configuration read/decode failures: the participant keeps its built-in name,
  the renderer receives the same built-in identity roster, and a stable
  built-in-only Role snapshot retracts custom Roles announced before the file
  broke. Programming defects still propagate, while spawn, editor, raw-catalog,
  and writer-validation paths remain fail-closed because continuing there would
  hide or execute unreadable configuration. Diagnostics are bounded and keyed
  by configuration path, and each user/project layer starts a new episode after
  its own successful read rather than waiting for the other layer to recover.
  The reads remain live instead of cached, so the next admitted Turn observes a
  repair. Renderer identity catalogs and stale-response guards are now scoped
  per Thread: root selection, child-detail loading, settings changes, Turn
  admission, and deletion all target the Thread they actually affect. A
  worktree child's prompt and visible speaker therefore resolve from the same
  child cwd instead of borrowing the selected root's identity. Gate:
  `/code-review ultra` found ten issues; the first re-review found three live
  failure/recovery gaps, and the next found the remaining worktree-child scope
  error. `eba322b6`, `610a8945`, and `6833c4f9` closed them in sequence; the
  final re-review found no reportable issue. Verified on the clean merge state
  with typecheck, `docs:check`, 266 focused core tests, 45 focused renderer
  tests, and five green CI E2E samples plus baseline subtraction. The branch
  head also passed the full core suite (2567 pass, 6 environment skips) and full
  renderer suite (1323 pass).
- **Provider failures recover without losing what the user actually asked
  (PR #567, codex-2)** — the initial provider request is no longer counted as a
  retry: transient request failures now show `Retrying 1/5` through
  `Retrying 5/5`, while recovery after a stream starts says `Reconnecting`.
  Structured provider failures use pi-ai's canonical transient classifier, so
  an OpenAI concurrency `rate_limit_exceeded` can recover without broadening
  permanent quota, authentication, or validation failures into retry loops.
  Tenon's replay-safety gates still stop automatic recovery after material
  output or replay-unsafe tool activity, and successful recovery clears the
  runtime-only status instead of leaving a stale terminal error. When the
  automatic budget is exhausted, Retry is now a main-admitted `turn/retry`
  command rather than renderer-side message reconstruction: one durable
  `history/retry` event keeps the old terminal Turn until admission succeeds,
  then atomically replaces it while preserving the original trigger and host
  provenance. The replacement replays every accepted input batch in order —
  initial input and steering, each with its evidence boundary, accepted time,
  and stable client ID — while excluding failed-attempt assistant/tool output
  and runtime-only evidence. This also makes host-authored subagent delivery
  retryable without laundering it into a user message. Gate: `/code-review
  ultra` found that the first implementation selected only the first user
  message and silently dropped accepted steering; `a6295449` rebuilt the full
  sequence and the re-review cleared it. Verified on the clean merge state with
  typecheck, `docs:check`, focused retry tests, and the full core suite (2572
  pass, 6 skipped, 0 fail). The earlier branch head's full renderer suite passed
  1324 tests, the review fix changed no renderer production code, and all five
  CI E2E samples plus baseline subtraction were green.
- **Long messages and model flyouts now expand from a fixed edge (PR #568,
  cc)** — `Show more` used to hold the control below a long message while every
  revealed line appeared above it, pushing the text the reader was looking at
  out of the viewport. Opening now holds the message block unless the transcript
  is riding a real scrollable tail; closing holds the clicked control, the only
  point guaranteed to be on screen. Renderer-owned range is not mistaken for a
  tail: a disclosure runway is excluded from the measurement, and an active
  send spacer selects the block path outright, so the message sent to the top of
  the viewport opens downward without moving either its first line or
  `scrollTop`. The model and reasoning side flyouts now freeze the height that
  chose their opening placement and derive their ceiling from that resolved
  edge, so changing submenu or revealing more models turns the surface into an
  internal scroller instead of teleporting it. Closing resets the hidden
  measurement seed, unchanged placements skip their React write, and both
  overlay paths share one clamping primitive. Gate: `/code-review xhigh` found
  ten issues; the re-review then caught the live send spacer still inventing a
  bottom. The exact counterexample moved the message top from `2px` to
  `-2154px` before the final fix and by `0px` after it. Verified with typecheck,
  `docs:check`, the full renderer suite, seven focused disclosure/scroll e2e
  tests, and five green CI samples.
- **Automations were unreachable and every root Turn died before the model ran
  (PR #564, cc)** — `automation_update`'s schema root was `{ oneOf: [...] }` with
  no `type`, and a provider requires an object-rooted function schema: OpenAI
  answered `Invalid schema for function 'codex_app__automation_update': schema
  must be a JSON Schema of 'type: "object"', got 'type: null'` on every request
  that offered the tool. The built-in Profile enables the whole catalog and the
  tool is `rootThread`-scoped, so the blast radius was every root Turn since
  `f5d2bb04` (2026-07-25); subagent Turns were spared only because scope
  filtering dropped the tool first. The root is now one flat object discriminated
  by `mode`, with each parameter's description naming the modes that take it, and
  the exact per-mode field sets are decoded in `decodeAutomationToolInput` beside
  the Automation decoders the renderer path already used — so model input and
  renderer input meet one set of bounds and one rejection vocabulary, and a patch
  can never carry the identity or the expected revision it is checked against.
  The tool also loses its vendor namespace (`codex_app.automation_update` →
  `automation_update`): a namespace names an MCP server or a plugin, and this was
  the only namespaced host tool among 27. The legacy-residue guard now fails on
  `codex_app` anywhere in active surface. **A Thread created before this version
  keeps the old key in its persisted configuration snapshot and silently loses
  the tool** — the snapshot is never re-resolved and pre-release ships no
  compatibility reader, so the remedy is a new Thread or a userData wipe.
  The lasting repair is the guard that should have caught it: a root union is
  legal JSON Schema that compiles locally, so `providerToolSchemaFailure` now
  states the sendable shape once — an object root carrying no `oneOf`, `anyOf`,
  `allOf`, `enum`, or `not` — the catalog guard asserts it for every static
  contract, and admission decides by *ownership* rather than by registration
  channel, so a host-owned schema fails closed even when a `dynamicTools` factory
  contributed it, which is exactly how this tool reaches the runtime. Gate:
  `/code-review xhigh` found 13, 11 fixed, one accepted as the stated wipe, one
  declined because the round-trip list it asked for would have required the exact
  string the residue guard forbids. The gate's own first suggestion — keeping
  per-mode exactness as a root-sibling `anyOf` — was reversed on the second pass,
  when `agentNodeToolSchemas.ts` turned out to have already recorded, from the
  same provider's own message, that a root union is refused in *any* spelling —
  which is why `node_search` and `node_edit` normalize their mutually exclusive
  argument groups at runtime. That comment is now an enforced rule rather than a
  memory. Verified with typecheck + `docs:check`
  + `test:core` (2514) + `test:renderer` (1280), plus an independent accept/reject
  matrix run through the real compiler and decoder at the gate. Not verified
  against a live provider from any clone.
- **A foreground Agent that spawns background Agents no longer wedges the Turn
  (PR #562 + #563, codex)** — found live on `dev:main`: a root Turn stayed
  `inProgress` forever, its `agent` tool call never completed, and Stop could not
  break it, so only killing the process cleared it. The durable ledger showed
  every participant finished; only the parent's wait never woke. The cause was
  design, not a missing edge — the same "is this child done?" predicate was
  answered in three places, and the foreground path asked it twice, once through
  a hand-rolled edge-triggered wait whose wake-ups could all be spent before it
  parked. #562 deletes that parallel mechanism and attaches the wait to the
  terminal-settlement state machine that already computes the answer, as one
  authority per `{agentId, generation}`. #563 races that wait against the
  invoking Turn's `AbortSignal`, so any future wedge degrades to a cancelled Turn
  instead of a restart; the settlement machine is not cancelled and still records
  the child generation independently. `/code-review xhigh` at the gate rejected
  the first round: the authority's outcome was a bare `resolve()`, which
  collapsed "this generation settled" and "we stopped tracking it" into one
  signal — so a descendant notification Turn (which advances `currentTurnId`
  without advancing the generation), a thread deletion, or app close each woke the
  parent, which then read a still-running Turn and fabricated a completed Agent
  result from it, in practice `Agent finished without text output.` written into
  the parent's rollout. Initial-admission failure was worse: every
  reservation-creation path is gated on `admissionCommitted`, so no reservation
  was ever created and the deferred was never settled at all — the exact deadlock
  the PR set out to remove, reintroduced through a different door. The rework
  makes the outcome an explicit `settled | abandoned | failed`: only `settled`
  lets the caller read the final Turn, admission failure and retry exhaustion
  report `failed`, and generation replacement, Thread deletion, and close report
  `abandoned`, so teardown can no longer fabricate a result. The gate also took a
  spec that contradicted itself, a settlement key derived twice with no assertion
  that the two agreed (now an explicit check), an aborted Stop that stranded the
  child's `agent_message("main")` envelope `pending` until the next process
  start, and a Stop test that spun on an unbounded wait — a regression in the
  liveness property it guards would have surfaced as a suite timeout, which under
  the known load-flake pattern reads as a busy machine rather than a real
  failure. The one path that broke the invariant is now the one path the
  regression test drives. Gate: typecheck + `test:core` (2501 pass) +
  `docs:check`, on an isolated worktree.
- **The model stopped inventing delegations it never made (PR #561, cc)** —
  caught in the `main` dev run: a root Thread streamed
  `[Subagent message sent: …][Subagent finished: …]` to its user as ordinary
  assistant prose. Both were real `agentMessage` deltas — the model wrote them —
  and neither `kind` exists; the protocol has only
  `started | completed | interrupted | errored`. It was not replaying our string,
  it had learned the *shape* `[Subagent X: path (id)]` from the three genuine
  `started` markers `ContextProjector` had pushed into its own assistant content
  seconds earlier, and carried the pattern on. The assistant channel is a
  few-shot demonstration of the model's own prose, so every line Tenon authors
  into it is a worked example of something to write more of. `subAgentActivity`
  and `imageView` now contribute no provider content at all, and — since an Item
  that contributes nothing must not act as a boundary either — are skipped
  *before* the pending-user and tool flushes: a child's `started` activity is
  recorded between the two `agent` calls of one batch, so reaching the flush it
  would have split a single provider assistant message in two and busted that
  much of the cached prefix for zero content. Nothing is lost, because every fact
  already arrives through a channel the model cannot mistake for its own voice:
  the delegation is the `agent`/`skill` tool call and its result, the terminal
  transition is the task notification opening its own Turn, and an isolated
  Skill's outcome is the `skill` result its caller awaits. `imageView` had no
  producer left in `src/` at all. The parent-visible row is untouched — no
  renderer file changed. The failure class was named and deferred in
  `agent-reasoning-replay-fidelity`, which called an imitated delegation
  "strictly worse than a stray reasoning label"; it has now fired, so the spec
  states the rule instead of the deferral. `/code-review high` at the gate found
  the boundary split above, that the rewritten spec paragraph had over-claimed
  ("no bracketed marker **at all**") while `redactedReplayMarker` still authors
  one — deliberately, since it must stay atomic with the tool call whose redacted
  arguments it explains — and two stale claims left behind by the rewrite; all
  four fixed on-branch in 579d524a. Gate: typecheck + `docs:check` + `test:core`
  (2493), with a guard that reproduces the production string on the pre-fix tree
  and a second that pins the one-message, two-tool-call batch.

### Internal

- **Agent composer input history plan (PR #585, codex-3, plan-only)** — ratifies
  terminal-style visual-boundary Up/Down recall for every editable Agent
  composer, derived from reader-authored canonical Items in the exact Thread and
  restoring text, references, attachments, selection, scratch, and resource
  ownership as one structured draft. A durable rich author model separates
  provider role from speaker trust across admission, retry, fork, transcript,
  Edit, and history; exact pre-author rollout and projection rows become neutral
  `unknown` only at persisted read seams, so installed conversations remain
  readable without laundering machine input. Menu and IME owners run before the
  semantic history callback, and only a performed history action consumes the
  key. Three review rounds closed four findings around authorship, deterministic
  rollback anchoring, installed-history compatibility, and input ownership.
  Product behavior is unchanged until the implementation PR ships.
- **Documentation lifecycle and navigation cleanup (main fast-track)** — removed
  obsolete lifecycle frontmatter from 75 archived plans, repaired current and
  historical Markdown links, replaced numeric code-line anchors in active
  planning authorities with stable symbols, restored the required active-plan
  heading contract, and aligned root/module documentation with Tenon naming,
  isolated development commands, and archived-plan locations. `docs:check` now
  guards maintained Markdown links, plan shape, durable references, unique
  `[Unreleased]` categories, instruction aliases, complete spec indexes, and
  stale current-authority paths so the cleanup remains mechanical.
- **Oversized composer paste attachments plan (PR #581, codex-2, plan-only)** —
  ratifies Claude-style large-paste admission for the Agent composer: calibrated
  per-paste thresholds convert one large plain-text paste into one managed
  `pasted-content*.txt` attachment, while aggregate character and node budgets
  keep repeated small pastes from growing ProseMirror without bound. An 8 Mi
  UTF-16 ceiling rejects before encoding; pending atoms preserve position and
  block Send; synchronous and asynchronous failures use distinct recovery
  contracts. Thread switching retains the current draft-discard behavior, and
  identical paste actions remain separate attachments even when that duplicates
  managed bytes. Product behavior is unchanged until the implementation ships.
- **The root-Agent import path is now guarded end to end (PR #580, codex-2)** —
  a focused Core integration test starts the local import API and runs preview
  plus commit through an admitted root-Agent Bash tool and the built-in
  `tenon-import` wrapper. It proves preview receives no write token, commit
  contributes `outline.edit`, the one-time causation token binds to the exact
  Bash Item, and the import creates exactly one staging root and Agent history
  operation. The app and test now share
  `createTenonImportShellEnvironmentProvider`, so the test exercises the
  production token-composition mechanism instead of reconstructing it. Gate
  review found no reportable findings. Verified with 11 focused import tests,
  the full Core suite (2587 passed, 6 skipped, 0 failed), typecheck,
  `docs:check`, `import-cli:build`, and whitespace checks.
- **Agent tool artifact resources plan (PR #576, codex-3, plan-only)** — ratifies
  one existing Thread-resource graph for completed non-image tool artifacts:
  `web_fetch` binaries, bounded foreground and finalized background shell logs,
  and bounded files from typed managed-Skill output roots. Tool Items own the
  references, first-party producers share a runtime artifact sink, and fork,
  rollback, pruning, deletion, and renderer inspection reuse current lifecycle
  authority. Live paths remain execution-scoped access handles; persisted tool
  output keeps stable resource identity, and later Turn, restart, and fork
  projection rematerialize a current `file_read` path. Review closed three plan
  gaps around oversized logs, output-root authority, and stale replay paths. The
  implementation waits for overlapping #575; product behavior is unchanged
  until that PR ships.
- **Agent trajectory workspace plan (PR #574, codex, plan-only)** — ratifies the
  DeepSeek Harness Trajectory interaction target for Tenon: a Thread-wide
  investigation workspace with Input / Assistant / Tools overview, Turn-grouped
  tail ledger, synchronized search and selection, folding, zoom/pan, paging,
  virtualization, record-specific lazy inspector, Thread summary, and typed
  export. The plan retires the pre-release single-Turn Model Interactions route
  rather than maintaining a compatibility path. Tenon keeps canonical
  Thread/Turn/Item authority, audited redacted evidence reads, child-Thread
  navigation instead of flattened descendants, the Electron process boundary,
  and the design system. Product behavior is unchanged until the implementation
  PR ships.
- **Subagent task-outcome contract plan (PR #569, codex-3, plan-only)** — ratifies
  execution facts instead of task-completion claims: a normal delegated run is
  `finished`, one configured breaker belongs to each execution generation, and
  useful output survives every terminal path with its actual stop provenance.
  Nested parents receive one bounded, omission-aware settlement path; abnormal
  terminal origins close without hidden provider work; carry-forward evidence
  protects explicit input and uses prepared cross-store admission, immutable
  delivery roots, rollout-owned Retry aliases, and a Stop-aware overflow detach.
  The plan absorbs the cold-reopen error and delivery-anchor tail left by #544.
  Six review passes closed 17 findings across liveness, capacity, crash recovery,
  routing, Retry identity, and cancellation races. Product behavior is unchanged
  until the implementation PR ships.
- **Thread transcript paint-continuity plan (PR #571, cc, plan-only)** — ratifies
  one paint owner per Turn: ordinary layout for the flow cohort and the measured
  renderer virtualizer for longer transcripts. The implementation will normalize
  range selection to the Turn container instead of raw scroller coordinates and
  repair uncovered ranges through phase-correct writers: event/rAF callbacks may
  commit before returning, while layout effects prepare the range in one pass and
  write only from a later pre-paint pass without lifecycle `flushSync`. Baseline
  threshold `B` and branch threshold `N` keep separate owner assertions over the
  same performance cohorts. Three review rounds closed six findings; product
  behavior is unchanged until the implementation PR ships.

## [0.6.0] - 2026-08-18

**Ask for a table, get a table.** The agent can now see, set, and configure
node views: "整理成表格" produces a real table view over field-structured
records — columns, sorting, filtering, grouping — instead of ASCII art in a
code block. Tags got the same end-to-end attention: a tag's static defaults
now show on every node already carrying it, and template seeds can be
backfilled on demand. Under the hood, agent turns shed their remaining
per-call overhead, sending a message starts on the keystroke, and one
unreadable conversation no longer stops the app from launching. No workspace
format change — upgrading from 0.4.0 or 0.5.0 loads your data as-is.

### Added

- **The Agent can see and set a node's view mode (PR #556, codex-3)** — asked to
  "整理成表格", the Agent produced space-aligned ASCII inside a code block,
  because nothing in its surface knew views existed: `%%view:<mode>%%` parsed but
  persisted only on saved searches, the read paths hid an ordinary table node's
  mode entirely, and no model-facing text mentioned views at all. The directive
  on the owner's line is now the single read/write representation for every node
  — `node_read` and user-view context emit it, `node_create` and `node_edit`
  persist it through the existing `set_view_mode` command, so core's
  entering-table transaction (search materialize-first, column
  auto-initialization in Schema order) comes for free. The settable vocabulary is
  one exported constant of renderer-renderable modes (`list`, `table` today): a
  core-known but unshipped mode (`cards`, `calendar`) fails as
  `view_mode_not_available`, an unknown string as `invalid_view_mode` naming the
  allowed set, and shipping a future view extends the constant rather than the
  surface. Omitting the directive from a complete root outline means `list`, so
  deleting the marker is how the Agent turns a table off; a code-block owner is
  exempt because that syntax cannot carry the directive, and re-applying the
  effective mode is a structural no-op that will not conjure a `viewDef` on a
  plain list node. Guidance teaches the task mapping — rows as direct child
  records, `Field::` names as column identities, values as cells, never a
  Markdown table in a code block — including the one sharp edge: fields present
  when an owner *enters* table mode initialize its columns, so a field added
  later needs a list-and-back re-entry until PR 2 exposes display-field
  configuration. The high gate found 4 issues, all fixed on-branch: the guidance
  told the model to "add columns as fields" on an existing table, a path that
  does not exist (`addMissingTableDisplayFieldsDirect` only runs on entry), so
  the Agent would report success on a column the user never got; deleting
  `%%view:table%%` returned `ok` with the document unchanged, because
  generalizing `applySearchViewSpec` had dropped its warning sites without
  replacing the behavior; `view_mode_not_available` fired on a directive
  `node_read` itself had emitted, permanently blocking every unrelated edit to an
  unrenderable-mode node — A12's fail-closed-at-the-wrong-boundary shape, now
  narrowed to newly requested modes; and an explicit `%%view:list%%` round-tripped
  into a `set_view_mode` that created a stray `viewDef` child on an otherwise
  plain node, with no read-back to tell the model to stop.

- **The Agent can read and write a view's sort, filter, group, and column
  configuration (PR #559, codex-3)** — PR #556 gave the Agent the view *mode*,
  but a table's actual shape stayed invisible: it could turn `%%view:table%%` on
  and then had no way to say what the table sorts by, filters to, groups on, or
  shows as columns, and a field added after the owner entered table mode needed a
  list-and-back re-entry to become a column at all. Persisted configuration now
  serializes as typed lines directly under its owner — `%%view-sort%%`,
  `%%view-filter%%`, `%%view-group%%`, `%%view-display%%` — sharing the
  saved-search rule/operand shape but in a view-specific namespace so they can
  never be mistaken for document children or query rules. `node_read` emits them
  for each requested root without consuming child pagination; `node_edit` treats
  the configuration in a complete editable outline as the desired state and
  reconciles it through the existing `add`/`update`/`remove`/`clear` commands, so
  no new core command was needed. Annotated reads carry each rule's stored Node
  id, and a matcher reserves every annotated line's Node before positional
  matching, so identity survives insertion and reordering rather than being
  handed to whichever line came first. Custom fields accept a field-definition
  reference or an active field-entry id — the id an annotated `Field::` line
  already shows — because requiring the definition id would have named a handle
  no read path exposes. Only ordinary nodes and saved searches own configuration;
  a code block or reference is refused before any mutation, `width` and `order`
  are held to the table's real integer bounds (112–520, and non-negative), and
  the reconciler preserves the two things the grammar cannot express: a column's
  placement and the order Core assigns a freshly added column. The `xhigh` gate
  found 13 issues, all fixed on-branch, and the most valuable one was in the
  tests: the core test host's `update_display_field` shim forwarded only the keys
  it was given, while `documentService` coerces every absent key to `null` — the
  value core reads as *clear this*. Under real semantics an edit that touched
  only a column's width silently deleted its placement, and a new column's
  auto-assigned order was wiped by the very patch that finished creating it;
  under the shim both were invisible and every new view-config test passed. The
  system-field set had also been hand-copied and had drifted from the picker's,
  so `sys:owner` and `sys:day` read back as nothing and an unrelated rename
  deleted the user's grouping, column, and sort rule; it is now derived from
  `core/systemFields.ts`. Verified against the pre-fix tree: six independent
  probes reproducing the reported data loss fail before the fixes and pass after.

### Changed

- **A tool output is read and hash-verified once per agent Turn, not once per
  model call (PR #552, codex-2)** — `CanonicalContextProjector` is deliberately
  rebuilt at every provider boundary so environment, view and additional-context
  deltas replay from canonical state, but only `readContext` was memoized at the
  Turn boundary. Every historical `full` tool-output projection therefore re-read
  its payload file and repeated the SHA-256 verification on every model step,
  making host storage work outputs × model calls. The Turn-scoped immutable read
  cache now covers output payloads too, keyed by the complete
  `ThreadItemOutputReference` and shared by the initial projection and every
  fresh provider-boundary projector — the reference is content-addressed and
  `ToolPayloadStore.readTextReference` re-verifies the digest, so the same key
  can only ever yield the same bytes and the fresh-projector contract is
  untouched. Missing and failed reads stay retryable: `null` and rejected reads
  are evicted rather than negatively cached, so a later canonical write is picked
  up and the `Full tool output is unavailable or corrupt` guard stays reachable.
  On a deterministic storage probe — 100 distinct 50 KB content-addressed outputs
  across 10 provider projections, filesystem cache pre-warmed — reads drop from
  1,000 to 100 and the median from 292.44 ms wall / 230.16 ms CPU to 30.75 ms /
  27.24 ms, about 9.5× less wall time. The plan's second candidate, a diagnostics
  fingerprint/deep-copy cache, was measured and **not** built: with an 80-message
  prefix, 16 stable tools and 10 provider calls, profiling attributed ~73% of the
  416.03 ms baseline to the bounded Secretlint scan and ~1% to SHA
  fingerprinting, so the pre-approved optimization would have bought ~1% in
  exchange for a cross-call redaction cache and new budget accounting — A9's
  measure-before-trading clause taken at its word, and the attribution now
  redirects this plan's remaining PR. The high gate confirmed the immutability
  premise and the eviction path (no microtask race; the awaited derived promise
  means a second caller can never latch onto an entry mid-eviction) and found no
  correctness defect; its one note, carried to the plan's last PR, is that
  successful entries are never evicted, so outputs compacted out of the effective
  context stay resident for the rest of the Turn — bounded per entry by
  `MAX_SINGLE_FULL_OUTPUT_TOKENS` (~32 KB), a few MB in the worst realistic case.

- **A tag's static field default now shows on every node already carrying the
  tag, without writing anything (PR #553, codex)** — a literal value typed into a
  tag's field slot (`Status: Inbox`) is context-free, so it is now read at
  projection time as an inherited ghost rather than stamped into each node when
  the tag is applied. Adding or editing a default is instantly true for every
  instance, past and future, with zero writes and no risk of overwriting a value
  someone typed; the old behavior reached only nodes tagged after the edit. The
  ghost renders in `--text-tertiary` and is inert — it takes no pointer input, so
  clicking or typing in the row creates the user's own value, and a trailing
  check affordance revealed on row hover or keyboard focus is the explicit way to
  accept and materialize the default. A whole-field control such as a checkbox
  shows the inherited state in the native control instead of a text ghost. Once a
  value is stored it is the user's and never tracks the template again. Ghosts
  answer reads as well as renders: search comparison, sort, filter, date and text
  operators, Table, and the agent node projection all resolve the slot's stored
  entry first and its inherited default second (decision D2). The accepted cost,
  ratified with the plan: on a field that carries a static default, `is empty`
  matches nothing, because clearing a stored value dematerializes the entry and
  the ghost returns — the empty state is reached by storing a real value or
  removing the default from the tag. The high gate found five issues, all fixed
  on-branch: the accept control covered the whole value area so no mouse user
  could ever type their own value; `overdueDateRanges` was the one date reader
  left unconverted, so `IS_OVERDUE` disagreed with `DATE_BEFORE` on the same
  nodes; the checkbox suppression test and the ghost render test read different
  values, leaving a checkbox field with no affordance at all when a template
  child rendered empty; `fieldDefinitionHasAutoInitialize` accepted any reference
  instead of validating the strategy, silently hiding a ghost that Search and
  Agent still honored; and the per-slot deleted-node ancestor walk added to the
  search hot path was removed rather than traded, once the slot builder was
  confirmed to filter deleted entries already (A9). Visual verification then
  caught what static reading had missed: the ghost painted directly on top of the
  empty editor's `Empty` placeholder, at the same origin in both themes, so the
  feature's most common state read as illegible overlapping text — the
  placeholder is now suppressed while a ghost shows and restored when the editor
  takes focus, with E2E guards on both halves.

- **A tag's freeform template children can now be handed to nodes that already
  carry the tag, on demand (PR #554, codex)** — template *fields* project at read
  time, but freeform content children stay one-shot seeds copied when the tag is
  applied, so a seed added later never reached older nodes and there was no way
  to give it to them short of re-tagging. Right-clicking a tag badge now offers
  an explicit backfill: `preview_tag_template_backfill(tagId)` reports how many
  active, editable nodes are missing at least one seed and how many clones would
  be added, and `apply_template_to_tagged_nodes(tagId)` adds only the missing
  ones, deduplicated by `templateId`, preserving inherited ancestor-first
  template order, as a single mutation and therefore a single undo step. Explicit
  user intent, no background mirroring and no heuristic about what an unedited
  copy means. Nodes in Trash, locked nodes, and protected document-system tag
  definitions are excluded from both the counts and the writes. The high gate
  found three issues, all fixed on-branch: the backfill skipped the
  locked-node guard that `apply_tag` enforces, so seeds a locked node had
  legitimately refused were injected anyway; the seed set was collected over the
  whole `extends` chain while the target set matched direct appliers only, so
  with `#task extends #work` a new `#work` seed silently missed every `#task`
  node and the dialog's counts understated the work; and a zero-addition preview
  still opened a dialog with a live Apply button that dispatched a no-op. A
  fourth defect was in the new test rather than the feature: it locked its
  fixture node by writing straight to Loro after the Core was live, which
  bypassed touch tracking and tripped the projection-cache verifier on the *next*
  mutation — the failure pointed at an innocent `createNode`, and because the
  test threw before its first assertion the ratified locked-node skip was
  effectively unverified. The fixture is now built before the Core exists.

- **The agent secret scan runs off Electron's main thread, and Turn caches
  release what the provider can no longer reach (PR #557, codex-2)** — the last
  PR of `agent-tool-call-path`, aimed at what PR #552's profiling had actually
  measured: ~73% of the remaining per-model-call cost sat in the Secretlint
  scan, not in the diagnostics work the plan had originally guessed at. Large
  batches now go to a bounded pool of at most two lazy, unreferenced Node
  workers; small batches keep running the direct scanner once, since IPC would
  cost more than the scan. On a synthetic probe the ~4 MB durable workload drops
  from 167.67 ms elapsed / 16.38 ms longest timer delay to 134.24 ms / 5.07 ms,
  and the ~64k-char diagnostics workload from 46.19 ms / 46.09 ms to 26.95 ms /
  1.86 ms — the timer-delay column is the point, not the elapsed one. Private-key
  matching also stopped being quadratic: the old
  `-----BEGIN …-----[\s\S]*?-----END \1-----` pattern made every unmatched
  BEGIN marker rescan to end-of-string, so a large output full of headers with no
  matching END could wedge the scan outright; BEGIN/END markers are now
  pre-indexed and paired by binary search. Alongside it, the Turn-scoped read
  cache learned to evict: each provider boundary records the keys `readContext`
  and `readOutput` actually visited — including the recursive reads made by the
  nested inherited-context projector — and drops everything else when the
  boundary ends, which closes the retention cost PR #552 knowingly carried
  forward. Cleanup boundaries decode canonical Turns once into shared resource,
  context, diagnostics and text-output reference sets instead of four separate
  full decodes; canonical belief rebuild checks `isBeliefBearingTool` before it
  reads and parses a payload, so a long thread no longer reads every `bash` and
  `file_read` output from disk to produce nothing. The `xhigh` gate found 15
  issues, all fixed on-branch, and the packaged-ASAR question it raised was
  answered with a real probe rather than an argument: the built `app.asar` was
  opened and its worker chunk launched from inside the archive. The re-review
  then found the fix for one finding had created a worse one. Moving the scan
  off-thread made a previously unreachable fail-open `catch` load-bearing: a
  worker timeout, crash, or startup failure would have persisted durable tool
  arguments and results **unredacted**, silently, where the old main-thread path
  had always redacted at the cost of a UI hitch. That path is now
  structure-preserving fail-closed — containers and non-string scalars survive,
  every pending string becomes `[redacted]`, and one fixed content-free warning
  is logged — and the watchdog was re-armed at dispatch rather than at enqueue,
  so queue pressure alone can no longer trigger it.

### Fixed

- **Sending a message is one movement now, and it starts on the keystroke (PR
  #558, cc)** — reported by the PM while testing: the transcript jumped after a
  send, in the conversation and in a Subagent's detail view alike. A per-frame
  probe found three movements and a stall that the settled position hid. The
  anchor needed `acceptedTurn.id` from the `turn/submit` round trip, but the Turn
  reaches the transcript on the `turn/started` notification a round trip earlier,
  so the bottom pin owned the gap; submit opened with a jump to the very end, a
  movement spent arriving somewhere it does not stay; the runway spacer and the
  scroll were written a frame apart, so the scroll used numbers the spacer had
  already changed and one frame put the message 42px past the top; and nothing at
  all was on screen between the keystroke and the host's answer. The transcript
  now draws the sent message itself, from the composer, as a view-only
  in-progress Turn appended after the canonical list and never admitted to the
  store; the view mints the `clientUserMessageId` and passes it through the
  submit, which is how the anchor tells its own send from a delegated Agent's
  result delivery arriving in the same window; the anchor runs synchronously from
  the layout effects on the pass the message first renders, so spacer and scroll
  land in one pre-paint pass; a steer keeps the bottom-follow path, since it
  joins a reply the reader is already in the middle of; and the travel is a tween
  over `--motion-layout-duration`, with reduced motion, sub-pixel distances and
  distances over two viewports still cutting. Deliberately not a FLIP transform:
  a transformed descendant contributes its *transformed* geometry to the scroll
  container's overflow, which is exactly the number the runway spacer is computed
  from, so that version undid its own anchor over a dozen frames — tweening the
  scroll keeps every measurement true at every instant. Two `/code-review high`
  rounds. Round 1 found the stand-in row waiting on an id that a whole class of
  sends never writes: `/clear` and `/compact` leave the composer as ordinary text
  and come back as a `contextReset` / `contextCompaction` Item under a Turn of
  their own, so the phantom "sending" bubble sat under the reset it had just
  performed, spinning, for the life of the mount — and the deduplicated repeat,
  which the host answers with no Turn at all, left it there the same way. It also
  found a latched anchor target that could name the stand-in row after that row
  had left the DOM, stranding the pending anchor — and since a pending anchor is
  what suspends the bottom pin, the transcript would never follow a streaming
  reply again for the life of the mount — plus a measured-height entry leaked on
  the refused-send path. The Turn a send became is now resolved by the client id
  *or* by the Turn the host reports accepting, re-run on every anchor pass and
  never latched, and a submission answered with no Turn retires the row on the
  spot. Round 2 confirmed all four fixes and found the new `/clear` guard real —
  it fails against the pre-fix tree — but the coverage claimed for the deleted
  anchor-latch assertion empty: the virtualized-transcript test offered as its
  replacement passes with or without that half of the fix, so that behavior ships
  fixed by construction and unguarded. Gate: typecheck + `docs:check` +
  `test:renderer` (1279) + the full `agent-thread` e2e spec (88).

- **One unreadable Agent conversation no longer stops the app from starting (PR
  #555, main)** — the installed app exited at launch, every launch, against a
  userData directory that had been in daily use since 2026-08-05. PR #535
  collapsed the agent tools into `agent` / `agent_message` / `task_stop` and
  dropped `spawn_agent` / `wait_agent` from the codec enum with no migration,
  which the pre-release rule permits — but its escape hatch is "wipe dev
  userData", and the daily-use install is never wiped. 14 Items recorded on
  2026-08-10 kept the retired names, history is append-only so those rows are
  never rewritten, and the decode threw on every launch. The fatal caller was not
  the one the stack trace named: Node truncates stacks at 10 frames, which cut it
  off exactly at the projection read. The real path is startup's
  `MemoryExtension.prepareForTurnAdmission`, which fans out over every root Thread
  and reads its Turns inside `initialize` with no per-Thread guard — so one
  Thread's bad row ended the process, even though reconciliation had already
  caught the same failure and moved on. Startup now decodes each Thread's history
  once and **quarantines for the session** any Thread that fails: it is kept out
  of resume, out of `persistentRootThreads`, and out of the history reads, which
  answer a named `ThreadBusyError` instead of leaking the codec error, and it is
  reported once as a `thread-history-unreadable` diagnostic. A metadata-only read
  still succeeds, so the Thread list can name what it cannot open. Quarantine is
  in-memory and recomputed each launch, so the bytes stay untouched and a build
  that can read them again picks the Thread back up. A torn rollout still does
  *not* quarantine anything — that history remains browsable out of its
  projection; the only question asked is whether the Thread decodes. Verified
  against the real broken userData. Two review rounds shaped this and both are
  worth reading. The first attempt skipped the undecodable *Item*, which silently
  broke the terminal-Turn mutation check and — because the projected rollout
  snapshot is written back before the old rows are cascaded away — would have
  destroyed the last copy of the very data it was trying to survive. The second
  attempt then placed the readability probe one line after the Thread joined the
  reconciled list, leaving an unguarded prune fan-out to kill the launch anyway,
  and hiding the Thread from `persistentRootThreads()` armed the memory
  orphan-admission sweep to delete its extraction state permanently — a filter is
  invisible to a consumer that treats absence as deletion. The third round found
  that same delete armed once more on a second quarantine path, because the fix
  had introduced two sets that were supposed to agree and did not; the signal now
  evaluates the same predicate the filter does, so it cannot disagree with itself.
  The rules are in `docs/lessons.md` — including that a typecheck scoped to `src`
  will not tell you a test double has gone stale; `docs/spec/agent-core.md` states
  the quarantine contract.

## [0.5.0] - 2026-08-17

**A small train, one fix aboard:** when creating a row from the trailing input
is rejected, Cmd+Enter now leaves the accurate rejection notice on screen
instead of overwriting it with a second, misleading error. (Also rides: test
hygiene for the upload-chunking e2e.) Upgrading from 0.4.0 carries no format
change — your workspace loads as-is; upgraders from 0.3.x still get the 0.4.0
fresh start.

### Fixed

- **A rejected trailing-draft materialization no longer swallows its own error
  on Cmd+Enter (PR #550, codex)** — 0.4.0's fix (PR #548) only guarded the
  *empty* body draft. A draft with text took the `commitDraft` path, which
  discards the create's outcome, so when the create was rejected — a locked or
  otherwise immutable parent — the handler still issued `cycle_done_state`
  against a node that was never created, and core's `node not found` overwrote
  the accurate rejection notice the user should have read. `handleModEnter` now
  routes every non-`realNode` draft through `materializeDraft`, which shares the
  in-flight create promise so a second caller reads the real outcome, and bails
  before the checkbox command when materialization did not succeed; the empty
  field-value draft still returns early, since its synthetic row cannot become a
  checkbox. The `docs/spec/ui-behavior.md` trailing-input matrix and the
  `docs/spec/outliner-parity-matrix.md` per-key list gain the `Mod+Enter` rows
  the behavior had been missing. Covered by an end-to-end regression test that
  rejects both the eager and the retry materialization and asserts no
  `cycle_done_state` is issued; the earlier success test now polls the checkbox
  state instead of the child count, closing a race where it could observe the
  node before the cycle ran. Gate ran typecheck + `docs:check` +
  `test:renderer` (1279) + the trailing-expand and agent-thread e2e specs (109)
  green in an isolated worktree.

### Internal

- **Pathless upload test asserts the chunking contract, not one browser's
  buffer sizes (PR #551, codex)** — the streaming-upload spec pinned the exact
  append sequence `[1 MiB, 1 MiB, 123]`, but chunk boundaries come from
  `file.stream()`'s reader, whose buffer size is Chromium's to choose; the
  renderer only re-splits anything larger than `ATTACHMENT_UPLOAD_CHUNK_BYTES`.
  The assertion now checks what the code actually guarantees — every append is a
  positive integer no larger than the chunk limit, and the appends sum to the
  original byte length — which still fails a regression to a single oversized
  append or to a truncated stream. 20 targeted repeats green.

## [0.4.0] - 2026-08-17

**Your workspace starts fresh on this upgrade.** 0.4.0 changes the on-disk
workspace format — saving is now an incremental append log instead of a
full-document rewrite on every change. Content from 0.3.x does not carry over:
on first launch your old workspace files are set aside next to the new ones
(named `*.incompatible-*`, never deleted) and the app starts clean. Beyond
that, this train is about speed and agents: streaming answers render at a
fraction of their former cost, typing in large documents no longer pays
per-keystroke full-document passes, delegated agent runs are now proper
Subagents with their own work strip and detail view, Table view materializes
the columns its records use, and tag templates finally propagate — editing a
tag's fields updates every node already carrying it, with the crash on
same-named fields fixed.

### Changed

- **A streaming answer no longer janks the whole app (PR #525, codex)** — every
  provider chunk used to pay a full persist cycle of its own: stat+open+write+
  fsync+close on the rollout log, a read→decode→append→stringify→UPDATE of the
  entire accumulated message in the history projection, three codec passes, an
  IPC broadcast, and a whole-snapshot renderer store notify. A Subagent run —
  two concurrent streams — made the outliner stutter under the agent's own
  typing, worst with the Subagent row expanded. Four changes bound that cost:
  rollout appends reuse open handles behind a 16-handle LRU and group-commit
  within 150 ms; adjacent string deltas for the same Turn, Item and delta type
  coalesce within 40 ms (discrete dynamic-tool output still never merges);
  in-progress Items live in a decoded memory overlay applied across every
  history read surface, so the projection stops rewriting the whole message per
  chunk; and the renderer updates snapshots synchronously but delivers delta
  subscriber notifications at most once per animation frame, with lifecycle
  changes still immediate. The rebuildable history projection moves to WAL with
  `synchronous=NORMAL`, while authoritative metadata, Goal, Memory and
  Automation stores keep `FULL`. The same 200-delta probe goes from a 56.11 ms
  median to 5.51 ms — 10.2× — with 200 rollout writes collapsing to 1 and both
  projections ending on the identical complete text. **The durability trade,
  stated plainly:** a hard crash can lose the last at-most-150 ms group-commit
  window of an *unfinished* stream; Item and Turn completion remain forced sync
  barriers, and startup rebuilds any projection found ahead of the surviving
  rollout. The high gate found ten defects, all fixed with eleven regression
  tests. Two would have cost user data: a sticky per-Thread failure map that,
  after one transient disk error, silently discarded every later delta *and*
  then threw that stale error **in place of** the next required lifecycle write
  — skipping it, so the rollout kept an Item that never completed and the next
  launch's assertion killed Agent startup for every Thread; and a reconcile path
  that treated a missing or empty rollout as a mismatch and "repaired" it by
  deleting the Thread's entire projected history. The first is gone — the map
  and its required-notification wrapper are deleted, so a failure is reported
  and the next write still runs. The second now rebuilds the *rollout* from the
  projection instead of the reverse. The rest were misplaced failure boundaries:
  fsyncing a file one line before unlinking it (a throw there skipped the
  unlink and orphaned the transcript), LRU eviction throwing from an `append`'s
  `finally` and thereby rejecting an append that had already durably landed, a
  flush in the middle of the delete cascade that could leave a Thread listed but
  with its goal and budget wiped, and recovery `throw`s on the unguarded startup
  loop — the last two moved to A12's degrade-don't-kill side, so one damaged
  Thread now skips its own resume instead of emptying the Agent pane. The
  overlay's rollback also stopped deep-cloning every open Item on every
  transaction and now journals inverse mutations for only the keys it touched.
- **A malformed tool call no longer kills the Turn on an OpenAI-Responses relay
  (PR #527, codex-2)** — one bad function-tool contract could spin a Turn until
  it died with nothing to show. Three layers close it, and only together. On the
  wire, every Responses-family function tool now carries an explicit boolean
  `strict`: `pi-ai` omitted the field whenever compatibility said strict mode was
  unsupported (including the default official-OpenAI path) and the Codex adapter
  sent `null`, leaving an intermediary free to reinterpret optional fields —
  Tenon now writes `false` in both cases and refuses to send an ambiguous
  contract at all. In the kernel, admission validates the exact prepared JSON:
  the dependency validator used to run `Value.Convert` plus JSON-schema coercion,
  so a model's `"5"` quietly became `5` and each tool received values with
  different JSON semantics from the model output; `prepareArguments` is now the
  only place allowed to normalize, and the admitted value is cloned so a tool
  handler can no longer mutate the assistant message that gets replayed to the
  provider. And a Turn-local fingerprint (canonical identity + schema digest +
  attempted arguments + reason) quarantines a tool on the second *identical*
  rejected call while different arguments still get their retry, with an
  eight-failure ceiling that closes tool exposure for one final response rather
  than looping. Runtime-provided schemas are compiled at their exposure
  boundary, where one malformed extension or MCP contribution is omitted and
  diagnosed while its valid siblings stay available — but a contribution whose
  canonical key collides with a Core tool, or a Core capability schema that
  cannot compile, stays a structural failure instead of silently deleting a
  built-in tool from the thread.
- **Hitting the output-token limit no longer takes the tool away (PR #528,
  main-agent)** — the containment guard above quarantines a tool after two
  identical rejections, and a truncated tool call fed it like a malformed one.
  But truncation says the response ran out of output tokens, not that the tool
  is broken: a large write tends to hit the cap at the same point twice, so the
  agent was told "re-issue the call with complete arguments" and then answered
  its own compliant retry with "that tool is not available" — the write never
  landed. Truncation still counts toward the eight-failure ceiling, so a Turn
  that only ever truncates is still closed rather than spinning, but the tool
  itself stays available for the shorter call the message asks for.
- **Typing no longer pays for the size of your document, once per keystroke
  (PR #530, codex-3)** — before every single command the Memory extension
  assembled the whole document and rescanned the Memory graph several times over
  to decide whether the edit touched a Memory Node; every projection change then
  rebuilt that graph again, re-read the generated rows from SQLite, hashed a
  fresh digest and woke the Memory pipeline. A keystroke in a large outline paid
  all of it twice — before and after the actual mutation. A bootstrapped
  `MemoryMutationIndex` now maintains canonical ownership, protected ancestors,
  reserved-tag membership, active tag definitions, fingerprint inputs and
  ancestor reverse dependencies incrementally from sparse changed-node deltas, so
  after one 3.6 ms bootstrap the guard authorizes from the index and never asks
  for a projection again. Generated-ownership reconciliation stays synchronous —
  a day rename, container move or Trash move still promotes affected generated
  descendants to user-authoritative *before* the Memory write gate releases — but
  visits only the affected reverse-dependency closure instead of the whole graph,
  and digesting plus the pipeline wake coalesce for at most 500 ms from the first
  pending change. On a synthetic 5,009-node document the guard goes from
  `0.436 ms` to `0.000295 ms` per call, ~1,480×, with zero projection reads after
  bootstrap. The high gate found ten defects, all fixed with regression tests.
  The one that would have been visible: draining projection changes after every
  command turned Core's transaction-level "nothing actually changed" detection
  into a per-command one, so an agent transaction that nets to zero — tag then
  untag, move then move back — committed anyway and left a phantom undo step that
  did nothing when you pressed ⌘Z. Net-change detection moved back into Core,
  which now compares each touched node's pre-transaction state against its final
  state. Four more were misplaced failure boundaries around the new observer: it
  ran ahead of the renderer's projection update (so a Memory SQLite error
  silently suppressed the edit on screen), and a failed reconciliation was
  rethrown *after* the document had already committed and saved, which reported
  `error` for nodes the agent had in fact created and led it to make duplicates.
  The observer is now non-authoritative end to end — every phase is contained and
  reported, and a failed commit falls back to the ordinary projection delivery
  that resyncs the index. The remaining fixes: an ancestor walk that could hang
  the main process outright on a transient parent cycle, a graph-change timer
  that could be armed after the Memory store closed during quit, a debounce with
  no maximum wait that could postpone Memory extraction across an entire editing
  session, and three duplicated copies of the canonical-Memory classification
  rules — now one shared implementation, so the mutation guard and the Memory
  pipeline cannot drift apart about which Nodes are Memory.
- **The Thread menu now says what it does to Recall (PR #536, cc)** — the records
  toggle read `Exclude from Records`, sitting between Rename and Delete and naming
  `thread-transcripts/`, a directory you have no other entry point to; read cold it
  parses as a third way to destroy a conversation, which is the one thing it does
  not do. It is now **Hide from Recall** / **Show in Recall** (`Recall unavailable`
  when the state cannot be read), and the hover hint — *Other Threads can look up
  past conversations. Hiding keeps this one out; show it again anytime.* — rides on
  both states instead of only the failure path. The old label also wrapped under its
  icon: it needed 133px and the menu allowed 126px. The menu's 168px width now lives
  once, in `ThreadList.tsx`, where the anchoring math reads it; labels ellipsize
  inside it through a `.thread-action-menu-label` span (`min-width: 0` on both the
  button and the label, whose `auto` minimum is the nowrap label's full width); and
  the menu clips only the inline axis, so a very short viewport scrolls to the last
  item instead of swallowing it. The e2e guard measures every label of every locale
  through a real label element — the mock renders one records state, so measuring
  only what appeared on screen would have left `Show in Recall`, the failure label,
  and every zh-Hans string unguarded.
- **Saving no longer rewrites your whole document while you type (PR #533,
  codex-3)** — every typing group and structural edit used to await a full Loro
  snapshot export plus an atomic file replacement *on the mutation queue*, so the
  next keystroke waited on serialization and disk. Persistence is now an
  append-only update log: a mutation publishes an accepted revision and returns,
  and a `WorkspaceSaver` writes the incremental Loro update to
  `workspace.loro.updates.jsonl` behind a 700 ms idle window with a 5 s max wait,
  serialized writes, capped exponential retry, and immediate service for explicit
  durability requests. On a 536-node document one incremental update is ~183
  bytes captured in ~0.623 ms, against ~669 KB serialized in ~32.6 ms for the
  snapshot it replaces. Trusted document-system transactions still await a real
  durable revision, and a durability failure now rejects the caller without
  hiding or rolling back state the document already committed and indexed.
  Startup validates the log's snapshot digest, replica identity, revision
  continuity, and the Loro version frontier of every record; a torn final record
  is recovered, and any other anomaly is quarantined to an `*.unreadable-*` file
  and repaired rather than making a readable snapshot unopenable. Quit became a
  two-phase state machine: Phase 1 freezes admission — **queuing** later
  mutations rather than rejecting them — and drains to a durable-revision
  barrier, offering Retry / Quit Anyway / Cancel on failure; Cancel resumes every
  queued edit, and irreversible teardown starts only once the barrier holds or
  the user explicitly bypasses it. There is deliberately no total-attempt exit:
  an automatic quit would discard accepted-but-not-durable changes without an
  explicit choice. Text-search maintenance stopped cloning the whole node map per
  patch — incremental patches mutate the published map in place while yielding
  bulk refreshes build in a hidden overlay and publish one completed generation.
  The max gate found 15 defects, 14 fixed with regression tests. The ones that
  would have been visible: any update-log anomaly hard-exited the app at startup
  with no window and no message despite an intact snapshot; a keystroke landing
  mid-fsync pinned the max-wait clock at zero and collapsed the debounce into one
  fsync *per keystroke*, the exact regression the change exists to remove; the
  capture path's implicit Loro commit carried no origin, pushing a phantom
  origin-less step into all three undo managers so ⌘Z had to be pressed twice;
  and a cancelled quit silently discarded every edit typed during the drain.
- **A running Thread now moves its words, not a carousel of spinners (PR #531,
  codex-4)** — spinners conflated "work is advancing" with "data is not ready",
  and a live Turn could show three of them at once. Active tool, Subagent, group
  and Plan rows keep their semantic glyph and instead shimmer the *advancing
  phrase* through one new `WorkingText` primitive — a single text layer that is
  both the accessible name and the paint-only animation surface, so nothing is
  drawn twice. Exactly one surface in a Turn moves: expanding a running group
  freezes its summary and hands the sweep to the live member, and reconnect
  *replaces* the rose generating indicator in the same slot rather than stacking
  a second row beneath it. Reduced motion and increased contrast drop the sweep
  and deepen the running row's glyph instead, so the state survives without
  motion. The high gate found 11 defects, 10 fixed. The ones that would have been
  visible: the `request_user_input` row shimmered while the agent was blocked on
  *you*; the arbitration ran through `.thread-turn:has(...)` descendant rules that
  reached across an expanded Subagent's nested Thread and froze the child's live
  indicator; the reconnect `role="status"` announcement moved inside the
  virtualized Turn window, so scrolling away silenced it for screen readers; and
  once every phrase went static while blocked, the one surface left animating was
  the response glyph — motion claiming progress in precisely the state defined by
  its absence.

- **Table view now arrives with columns, and Search stops stacking two toolbars
  (PR #534, codex)** — switching an outline or saved search to Table used to hand
  you a Title-only grid and leave you to add every column by hand. It now
  materializes columns for the custom fields its records actually use, in Schema
  order, without disturbing columns you had already hidden. Expanded records stop
  repeating their fields as body rows underneath — visible, hidden, and
  not-yet-configured fields all belong to the column model now, reachable through
  Add field's "Fields in use" group. The one exception is deliberate: a field
  entry whose definition you deleted keeps its ordinary row, because the column
  controls can no longer offer it and that row is the only place its stored value
  survives. Rows backed by a reference read and edit their final target's values,
  and a broken or cyclic chain degrades to empty read-only cells instead of
  blocking the row. Search Outline and Search Table now share one compact
  `ViewToolbar` variant in place of the old query-summary bar stacked above a full
  toolbar. Three gate rounds — `/code-review high` twice, then `/code-review
  xhigh` — turned up 29 findings, 27 fixed. The instructive part is where they
  came from: the three heaviest were each introduced by the *previous* round's
  fix. Materializing a saved search before the Table switch (round 1's fix) threw
  on any search whose query no longer evaluates, so the Table button silently did
  nothing; it also ran the query without the text index every other caller
  threads, persisting a substring-scored result set that flipped back on the next
  refresh. Round 2's fix for that then rebuilt the whole text index on every view-
  mode change, including for ordinary nodes. And the xhigh pass caught real data
  loss that two earlier rounds missed: deleting the query-summary bar deleted the
  only surface that reported a query had been truncated past the editor's
  complexity limit, so an over-limit query rendered as if whole and Save wrote the
  truncation back over your omitted rules. Editing and saving are now disabled
  outright for a truncated query rather than merely warned about. Both patterns
  are distilled in `docs/lessons.md`.
- **Agents are now Claude Code Subagents, and a delegated run reports back on its
  own (PR #535, codex-2)** — the Codex-style collaboration protocol is retired.
  Six tools plus `bash_stop` collapse to `agent` / `agent_message` /
  `task_stop`; a child starts fresh instead of forking your conversation, runs in
  the background by default, and its result is delivered to the parent by the
  host rather than waited on. Same-ID steer and resume, depth 3, 20 live
  children, and worktree isolation that also denies outline mutation so an
  isolated child cannot edit the document you are reading. Built-in `worker`,
  `/research`, `readOnlyIsolated`, and `explorer` as a visible Agent type are
  gone, and the Memory prompt block is root-only. **If you scripted a Role with
  `tools: []` it will now refuse to spawn instead of running mute**, and
  `tools: ['*']` inherits the parent pool rather than failing. Five gate rounds,
  23 findings. The heaviest were escapes rather than crashes: an isolated Skill
  inherited the root tool policy instead of its parent's, so an `explore` child
  could write and run shell through a Skill; a nested child of a worktree-
  isolated Agent got the filesystem boundary but not the outline denial; the
  write-boundary check skipped its symlink-defeating half whenever `realpath`
  failed; and the extension/MCP gate was a deny-list missing three
  outward-facing action kinds while its bash sibling was correctly an
  allow-list. Two rounds later the fixes had grown their own defect — giving the
  host the ability to start a Turn on a Thread the user also submits into
  created a race that surfaced `ThreadBusyError`, now closed by a host-owned
  `turn/submit` that serializes renderer submissions in main.

- **A long streaming answer costs less to keep on screen (PR #539, codex)** —
  three costs the delta-pipeline work left behind, all paid once per streamed
  chunk. Thread metadata was re-SELECTed and fully decoded on every recorded
  notification; it now comes from an LRU cache that every mutator invalidates.
  Markdown was re-repaired and re-lexed over the *entire* accumulated message on
  every 80 ms commit; it now re-lexes only a bounded tail, reusing the earlier
  blocks verbatim, and falls back to a full lex when a reference definition
  changes, an edit is not an append, or the boundary is not provably safe. And
  the active Turn re-rendered all of its items per chunk; grouping, the response
  tail, and Subagent projection now reuse their previous output when nothing
  they depend on changed. **What this is not:** the per-commit cost is lower but
  still grows with answer length — `remend` repairs the full text for
  correctness and is itself superlinear, so it now accounts for ~95% of a
  commit (~20 ms at 20 KB, ~80 ms at 40 KB, against ~67 ms and ~260 ms before).
  Roughly 3× better, not flat; the remaining tail is filed as its own item. The
  high gate found three defects. Two blocked the merge, both in the incremental
  lexer, and both were the same class of mistake — an optimization that was fast
  precisely because it skipped work correctness needed: repairing only the tail
  meant an inline marker opened before the frozen boundary was closed
  differently than the full path would close it (visible as text flickering into
  inline code mid-stream and snapping back at the end), and a boundary frozen at
  a blank line could be invalidated by whitespace that arrived later, splitting
  off a phantom empty block. The fix repairs the whole source and re-lexes the
  tail from it, keeps two substantive tokens in the reparsed tail, refuses a
  boundary inside trailing whitespace, and refuses one whose prefix holds an
  unmatched `[` that a later `]:` could turn into a definition. Verified at the
  gate with a differential fuzz built independently of the branch's own — 240,000
  appends over a disjoint fragment alphabet with zero divergence, against a
  control run that breaks the pre-fix code within 932 appends.

- **Typing in a large document no longer rebuilds the whole document on every
  keystroke (PR #541, codex-3)** — the last of the three `typing-hot-path` PRs,
  and the one that closes the board's only P0. Each keystroke used to
  synchronously rebuild document-wide derived data and notify broad React
  subscriptions even when nothing visible had changed: References summaries were
  rebuilt in full behind a cache keyed on a `byId` the delta path replaces every
  time, the `@` picker filtered-mapped-ranked-sorted the entire projection twice
  per key with per-candidate ancestor walks, the agent dock re-rendered its
  transcript off `index` identity with the rail closed, `Sidebar` walked ancestors
  per row to decide Trash styling, and a code block being edited re-highlighted
  through Shiki on every key. Now: reference summaries are maintained
  incrementally and unlinked mentions scan cooperatively; the `@`/`#` pickers
  query a compact posting index over one shared normalized label per node
  (offset postings ordered by generalized suffix-array rank, top-scores per
  block) with a persistent edit overlay compacted *outside* the projection
  commit; display-cycle rules resolve from a cooperatively-built reachability set
  instead of a synchronous graph walk; Sidebar rows and visual rows are memoized
  and incrementally reused; the dock and Thread subscribe to index-derived leaves
  and pause entirely while closed without unmounting user state; and Shiki
  re-highlights on a 150 ms debounce with plain text visible throughout. On the
  probe scenario — 3,000 nodes, 48 inputs, agent rail open with a Subagent
  streaming, References expanded — mean input latency goes from 127.35 ms to
  104.69 ms and p95 from 141.2 ms to 124.1 ms.

  The high gate found five defects. The one that mattered was an optimization
  that recreated the problem it was written to solve: the candidate index built
  one posting string per character offset of an untruncated label, so
  construction was O(Σ label²) — 694 ms and ~160 MB for a single pasted 21.6 KB
  node — and it ran synchronously on the keystroke that pushed the edit overlay
  past 23 entries, i.e. a 340 ms freeze mid-typing on the 24th distinct node
  edited in a session. Two more were user-visible: the `@` picker silently
  dropped a click or Enter on a row that was still enabled because reachability
  had not landed, and the same row could reorder underneath the highlight ~100 ms
  after the popover opened, so an Enter at that moment inserted a reference to a
  node the user was not looking at. The other two were a reachability scan that
  stopped at the first dangling child reference instead of continuing on to find
  later display cycles, and a Sidebar comparator that missed Trash styling for a
  pinned node whose *ancestor* was deleted. The re-gate then held the merge for
  two more: the rebuild was still one synchronous 160–700 ms block, only moved to
  150 ms after typing stopped rather than removed, and its idle debounce re-armed
  on every delta, so a continuous Agent stream could defer compaction forever.
  Both are closed — the build is now sliced cooperatively (a 12,000-node probe
  runs as ~6 s of background work across ~4,500 yields with a longest
  uninterrupted slice of ~7.7 ms, against the 662 ms single pause the gate
  measured before), and a non-resetting 750 ms deadline plus a 256-entry pressure
  trigger guarantee progress, with deltas that arrive mid-build rebased before
  the new base commits.

- **A long streaming answer now costs the same per chunk however long it gets
  (PR #547, codex-3)** — the tail #539 explicitly left open. Markdown repair ran
  over the whole accumulated message on every 80 ms commit and was superlinear,
  so it had grown into ~95% of a commit: ~20 ms at 20 KB, ~80 ms at 40 KB, and
  worse from there. The repair library rescans the text from the start for each
  emphasis marker it inspects; a renderer-local adapter now computes that context
  once per repair as a set of maps and reuses them across the emphasis handlers,
  which makes the pass linear. It is a cost change, not a repair-policy fork —
  the output stays byte-identical to the library's after every append, which is
  what lets the bounded tail lex from #539 keep matching a full repaired lex.
  On a 40 KB answer a commit drops from ~97 ms to ~8 ms. The high gate found the
  fast path guarding itself wrong: it required a `$` in the text, which sent
  every answer *without* one back onto the slow path — the common case for
  answers about code, where `snake_case` identifiers cost 207 ms at 40 KB and
  over a second at 80 KB, and where adding a single `$` to the same text made it
  12–40× faster. Math was never what made the scan expensive; the library
  consults math context before it rejects a literal `_` or `*`. Dropping that
  clause is the difference between the fix working on prose about code and not,
  and it cost nothing: 40 KB of ordinary `**bold**` prose repairs in 11.6 ms
  against 7.6 ms on the old path, linear either way, and text with no emphasis
  markers at all still short-circuits. Verified with ~2.5M differential
  comparisons against the canonical library plus an 800,000-state fuzz of the
  corrected guard, both with zero divergence. Because the copied logic is
  derived from one library version while the dependency admits later ones, that
  committed differential suite is also the compatibility guard: an upstream
  behavior change fails the build instead of silently drifting.

- **An agent tool read stops rebuilding the Memory graph, and the read model
  comes back on (PR #546, codex-2)** — with Memory attached,
  `MemoryExtension.filterProjection` decoded the whole thread history and
  rebuilt the canonical Memory graph on every `getProjection()` (1–3 per node
  tool call, plus an N+1 SQLite read per generated Node), and its mere presence
  disabled the maintained projection index and text-search index for *every*
  agent tool — `node_search` fell back to a linear scan and `node_edit` to
  per-Node `JSON.stringify` diffs, switching #414's work off on this path.
  Canonical membership and explicit ancestor/descendant expansion now reuse the
  incrementally maintained `MemoryMutationIndex`; the hidden-ID set and both
  filtered read views are cached per Turn and keyed by document, control-store
  and explicit-reference revisions, so an in-place projection update invalidates
  them and nothing else has to. The unsupported-generated-Node N+1 becomes one
  grouped JOIN behind a process-local filtering revision. Hidden IDs are
  excluded before text candidates, BM25 corpus statistics, scoring and limits,
  so a filtered search equals an index rebuilt from only the visible records —
  which is what lets the maintained index stay available under filtering, the
  one deliberate behavior change here and PM-ratified: `node_search` now scores
  through the index while Memory filters. On a fixed probe — 20,000 ordinary
  Nodes, 250 canonical Memory Nodes, 12 consecutive filtered reads in one Turn —
  the batch goes from a 197.8–778.9 ms median to ~0.018 ms, about 0.001–0.002 ms
  per cached call; the baseline is a range rather than a single multiplier
  because its spread *is* the old path's allocation and N+1 noise. The high gate
  found four defects and one follow-up. Two mattered: the per-Turn
  explicit-reference recovery latched "complete" even when the targeted Turn read
  missed — which would have hidden every `@`-referenced Node from `node_read` and
  `node_search` for the rest of that Turn, the exact failure the feature exists
  to prevent — and the new `corpusStats` early return allocated a fresh object
  plus three `Map`s per scored record *and* per query term on the **unfiltered**
  path (the renderer launcher, document search, every non-Memory agent search),
  where the old code just read a size. The other two were quieter: a cache guard
  whose two identity comparisons could never fire, because `applyUpdate` mutates
  the projection's Node array and map in place, leaving the whole invariant
  resting on an upstream `Set` happening to be freshly allocated; and filter
  state that a late or orphaned Item notification could create but nothing would
  ever evict. Closing that leak by deleting the eager path narrowed behavior in
  its turn, so the ordering it now depends on is proven instead of assumed:
  recorded Items are canonical before observer delivery, asserted at the earliest
  extension notification for both persistent and ephemeral delegated Turns.
- **A delegated Agent now reads as a participant in the conversation, not a
  widget inside one Turn (PR #544, cc)** — the old presentation derived every
  child from the Turn that spawned it, which was true when delegation was an
  episode inside one Turn and false of the shipped protocol, where an Agent is
  spawned in one Turn, steered in another, resumed in a third and delivers in a
  fourth: a Turn-anchored projection either duplicated the Agent under every
  Turn that touched it or orphaned the generations no Turn owned. A registry
  keyed by stable Agent ID + generation replaces it, fed by a new main→renderer
  execution projection (the seam landed as the PR's first commit, A4-additive),
  so a conversation reopened days later still knows how every generation ended
  instead of calling finished work `Idle`. In the conversation, the delegation
  graph reads as participants exchanging messages: spawn/resume chips at the
  delegating call, every non-reader participant under one speaker-header shape
  (avatar, name, what it did), and a delivered result rendered as a message
  from its Agent — an outlined report card, task as its first line, whose whole
  surface opens the Agent. A header work strip shows this conversation's
  running / just-finished background work (foreground work stays on the Turn it
  blocks); a full-deck pushed detail view covers the conversation rather than
  replacing it (composer-as-user-authority, retained-worktree footer resolved
  main-side by Agent ID, nesting ≤ depth 3); OS notifications fire once per
  terminal background generation, unfocused only, content-free. Identity is a
  new colour category: avatars share the tag chips' `--identity-tint-*` ladder
  (red excluded — it neighbours `--status-danger`) and never paint
  selection/hover/active/focus or status. Two review rounds preceded the gate
  (xhigh 14 + high 10 findings, all 24 fixed on-branch), including a porcelain
  `-z` rename mis-parse in the worktree footer, a Stop that could not reach a
  cold-reopened running Agent, stale OS notifications for already-watched work,
  and two streaming-hot-path memo regressions the existing guard test could not
  see. The two known legibility tails — a failed Agent's error text after a
  cold reopen, and a transient wrong-run report card while a delivery is
  deferred — each need an A4 protocol addition and are board-tracked as
  `subagent-projection-error-surface` rather than smuggled into a fix round.
- **Tag-defined fields are now a read-time projection of the tag chain
  (PR #545, codex)** — tagging a node no longer eagerly stamps template field
  entries onto it: the fields a tag (and the tags it extends) defines are
  projected onto tagged nodes at read time as virtual slots, and a slot becomes
  a real stored entry only when a value is written. Template edits — adding,
  removing, or retyping a field on a tag — now reach every already-tagged node
  immediately, the PM-reported bug that motivated the plan
  (tag-schema-projection PR 1 of 3; defaults-as-ghosts and seed backfill
  follow). Nodes store values only; the tag chain answers structure. The xhigh
  gate (10 finder angles → 47 candidates → 14 verifiers, one executed
  dual-branch repro) confirmed 15 findings, all fixed on-branch with ~600 lines
  of regression tests. The worst: a projected `sys:done` slot bypassed the
  system-write router, so `Done:: true` stopped setting `completedAt` (proven
  by repro); the agent materialization path mistook a focus outcome for a
  created-entry id and patched the owner's body children as field values
  (silent corruption); the slot cache ignored trash membership, so a restored
  node's stored field rows stayed vanished; and a family of
  "virtual slot id is not a node id" consumers — filter/group/sort, drag-drop
  targets, clipboard serialization, Trash rendering — each silently degraded.
  Three typing-hot-path regressions (A9) were rebuilt into precise
  invalidation: field-value keystrokes reuse the visual-rows snapshot again,
  the fieldDef-rename duplicate check walks a candidate set instead of
  projecting every node, and the tagDefinitions revision now bumps only when a
  tag's actual slot shape changes rather than on any Schema-subtree edit.
  Blur-commit on a concurrently-deleted entry degrades to a no-op instead of
  surfacing a raw internal error (A12), and `include_deleted` agent reads
  surface trashed entries on live owners again via `trashedFromParentId` now
  kept on the projection.

### Fixed

- **Upgrading from 0.3.x no longer dead-launches the app (main-agent,
  PM-ratified 2026-08-16)** — the #533 persistence-format change made a
  pre-update-log workspace fail startup outright (`invalid workspace
  persistence revision`), with no failure surface to explain it; verified live
  on a real 0.3.x data directory. Startup now detects the provably older
  envelope shape — a `tenon-workspace` snapshot with no `persistenceRevision`
  field — sets the old snapshot and any log aside as `*.incompatible-*` files
  (never deleting them), and starts a fresh workspace, reporting the recovery
  through the persistence error channel. Corrupt current-format data still
  fails closed: a present-but-invalid revision is not set aside. This is the
  ratified no-migration policy automated, not a migration: old content is not
  read, and the set-aside files are recoverable by hand. Regression tests were
  verified to fail against the pre-fix store, and the fallback was verified
  against the real pre-#533 workspace file that surfaced the crash.
- **Two tags that define the same field name no longer exclude each other
  (PR #540, codex-2)** — a field is now identified by its definition, never by
  its display name, matching Tana (*"whenever you select an existing field to
  use, it is retrieving the settings from the field definition of that field"*).
  Before this, `#chore` and `#bug` each defining a `Status` were mutually
  exclusive with a crash: applying the second threw out of the template-stamp
  assert, and because the tag was pushed onto the node *before* instantiation,
  the failure left the tag applied with partial fields. The same assert crashed
  the checkbox whenever a done-mapped field's name collided. Merging two such
  tags moved the collision inside the merged tag and poisoned every later
  application of it. Same-named fields backed by different definitions now
  simply coexist on a node, rendering as two rows exactly as Tana does — no
  originating-tag suffix. Tag merge no longer unifies definitions by name at
  all; it follows template-child identity, so a merge can no longer rewrite the
  schema of a third tag the user never named (an earlier draft did, document-wide,
  including that tag's option pool). Where two template entries do share a
  definition, their values combine, identical values are not duplicated, and
  instance template origins repoint to the survivor. Name-based writes —
  `Status:: Open` from paste, the agent, or tree materialization — disambiguate
  through the owner's applied tag chains, specific-first by inheritance depth,
  at both the entry and the definition level; a genuinely tied layer still
  refuses, with the entry ids and a remedy. `templateId` healing moved to the
  removal boundary in `removeSubtreeDirect`, which retires a whole class of
  dangling-origin bugs rather than the two known instances. Three review rounds:
  a `high` pass, then a PM redirect to Tana's model that replaced the first
  design outright, then an `xhigh` pass that caught a regression the redirect
  introduced — agent `node_create` applied tags before writing fields, so the
  new coexistence made every such write die mid-outline with the node already
  created and no expressible remedy.
- **Splitting a tagged node no longer re-stamps its template (PR #542,
  codex-2)** — pressing Enter mid-text ran the tag's full template
  instantiation on the new half, so a text edit minted creation-moment data:
  field defaults reset to the template's value and seed children were conjured
  again. A `#meeting` whose template holds a seed child `Agenda` and a `Status`
  default `Inbox`, split while its instance read `Doing`, produced a right half
  reading `Inbox` with a fresh `Agenda` under it. A same-parent split now
  carries the source tags and materializes their inherited field structure,
  including acquisition-time auto-initialization, but clones neither static
  template defaults nor seed content; a cross-parent split still applies the
  destination parent's configured child supertag as a genuine new acquisition.
  Two consequences are pinned by tests and stated in `docs/spec/commands.md`: a
  field configured with both a static default and an auto-init strategy keeps
  the default on the source and receives the auto-initialized value on the new
  sibling, and the sibling's empty field retains its template origin, so
  `value_is_default` hides the source's default-equal value while leaving the
  sibling's empty field visible.
- **Cmd+Enter on an empty trailing input now creates an unchecked checkbox row
  (PR #548, codex)** — the trailing draft commit path intentionally skips
  materializing an empty body, but the keyboard handler still issued
  `cycle_done_state` against the draft's UUID, so core answered `node not
  found` and the user saw an error. The handler now materializes the empty
  body draft under its stable draft ID before cycling, and skips cycling
  entirely for an empty field-value draft, whose synthetic row cannot become a
  checkbox. Covered by an end-to-end regression test; gate ran typecheck +
  `test:renderer` (1279) + the full trailing-expand e2e spec (25) green in an
  isolated worktree.

### Internal

- **Opened the 0.4.0 train (main-agent)** — `package.json` dials to `0.4.0`
  after the v0.3.0 tag so dev builds name the next train.
- **Responses tool-contract hardening plan (PR #526, codex-2, plan-only)** —
  boards the fix for a dead-Turn class observed on an OpenAI-Responses relay:
  an explicit boolean `strict` on every Responses-family function-tool payload
  (absent, or the Codex adapter's `null` sentinel, becomes `false` instead of
  being left to an intermediary), exact non-coercing kernel admission after
  each tool's own `prepareArguments`, and a Turn-local repeated-rejection
  quarantine with an eight-failure ceiling and one final tool-free response.
  Design only; the implementation ships as one PR.
- **Restructured the streaming/subagent plan boundary (main-agent, PM-ratified
  2026-08-14)** — `agent-streaming-followups` slims to the three costs that
  survive the ratified `subagent-interaction` redesign (metadata-record cache,
  incremental streaming lex, streaming-Turn memoization with projection
  output-identity reuse as a bridge); its subagent-projection two-layer cache
  and 1 Hz ticker isolation moved into `subagent-interaction` as contract
  requirements on the new Agent registry and detail components — their
  subjects are replaced there, so optimizing them first would be A7 waste. The
  slimmed perf PR sequences before the interaction redesign. Both plans were
  re-verified against the post-#531/#533/#535 tree: the board's "needs-input
  badge" line was a prototype-iteration leftover the ratified plan drops
  (corrected), the plan's `waitingForSubagents` reference names a symbol #535
  removed (re-anchored to the shipped `SubagentExecutionLedger` vocabulary),
  and the registry's inputs turn out to be main-side only, so the redesign now
  explicitly opens with a main→renderer execution projection as a
  protocol-surface addition.
- **Semantic working-state plan (PR #529, codex-4, plan-only)** — boards the
  split of the Thread spinner's two conflated meanings — "work is advancing"
  vs "data is not ready": Working rows keep their identity glyph and shimmer
  the advancing *text* on a fixed cadence (tokenized, CSS-only), Loading /
  Waiting / Recovery and terminal states keep their existing indicators under
  an explicit retained matrix, only the most specific expanded representation
  animates, and static cues carry every row under reduced motion / increased
  contrast. Design only; ships as two independent PRs (Thread/Plan, then
  Settings).
- **Claude Code subagent parity plan (PR #532, codex-2, plan-only)** — boards
  the replacement of the Codex-style collaboration protocol (mailbox, built-in
  `worker`, `/research` + `readOnlyIsolated`, visible `explorer`) with Claude
  Code's model: `agent` / `agent_message` / `task_stop`, fresh
  background-default children, and host-delivered notifications. Naming
  follows Tenon snake_case, behavior follows Claude Code (PM-ratified).
  Design only; the implementation ships as one PR.
- **Tag schema projection plan (PR #537, cc-2, plan-only)** — boards the fix for
  a PM-reported bug: template edits on a `#tag` never reach nodes that already
  carry it, because the template is a one-shot stamp read only at `apply_tag` and
  `splitNode`. The ratified design stops copying the rules instead of syncing the
  copies: a node's field list becomes a read-time projection of its tag chain
  (nodes store values only, materialized on write, dematerialized on commit-empty,
  auto-init still frozen at tag acquisition), static defaults render as inherited
  ghosts that answer reads and never write, and freeform template children stay
  one-shot seeds with an explicit idempotent backfill command. Three independent
  PRs; PM ratified D1–D4 plus, at the gate, the `is empty` consequence (on a
  defaulted field it matches nothing — there is no per-node way to blank a
  ghost). Two design-review rounds at the gate corrected the plan's premises
  against the real code (splitNode call site, already-implemented search
  operators, instance field-order quirk, `templateId`'s color consumer, the #534
  semantic overlap) before ratification. Design only; PR 1 sequences after #533
  and #534.
- **Tag merge and split fixes plan (PR #538, cc-2, plan-only)** — boards the
  crash-class remainder of the field/supertag audit (the follow-up to #537's
  review), all verified against current core: two tags each defining a
  same-named field are mutually exclusive with a crash (`applyTag` throws out of
  the template-stamp assert, leaving half-applied state since sync `mutate()`
  has no rollback; the same site crashes the checkbox done-mapping); merging
  those tags moves the collision inside the merged tag, after which every
  `applyTag` of it throws forever; and a mid-text split re-stamps
  creation-moment data (template defaults reset, seed children re-conjured).
  Ratified design: collisions skip at the stamp boundary instead of throwing
  while authoring paths stay fail-closed (the A12 line); tag merge unifies
  same-named definitions behind a non-throwing compatibility predicate with a
  keep-both fallback and target-defaults-win dedupe; split stamps field
  structure + auto-init only. One gate-review round folded in: the third caller
  of the stamp helper (done-state mapping) degrades on skip, and the
  unification gate covers all three throw conditions of
  `mergeFieldDefinitionsDirect` including values-compatibility (fields can be
  retyped without revalidating stored values). Two independent PRs; both land
  before tag-schema-projection PR 1, which inherits their behaviors as pinned
  tests.

## [0.3.1] - 2026-08-10

**0.3.1 is an emergency fix: 0.3.0 could not start.**

The 0.3.0 build's desktop bridge failed to load — the new update checker pulled
version-comparison code into the app's sandboxed bridge, which cannot resolve
it — so every window showed "Tenon desktop bridge is unavailable" over an empty
document. The chain is cut, and the build now refuses to package a bridge that
cannot load. **If you installed 0.3.0, download 0.3.1 and drag it over the old
app.**

### Fixed

- **The app starts again (main-agent hotfix)** — `preload/index.ts` imported
  update channels from `core/appUpdate`, whose module graph reaches `semver`
  (and `marked` via the changelog parser); electron-vite externalized those
  into runtime `require()`s the sandboxed preload cannot resolve, so
  `window.lin` never appeared and every window was dead. The zero-dependency
  protocol surface moved to `core/appUpdateProtocol.ts`, the preload imports
  only that, and `app:build` now runs `scripts/check-preload-bundle.ts` between
  bundling and packaging — one bundle, sandbox-safe requires only — so an
  unloadable preload fails the build instead of the first install.

## [0.3.0] - 2026-08-10

**Tenon 0.3 is about memory: the agent remembers what happened, notices what
changed, and the app tells you when there's a newer one.**

- **The agent keeps records** — every conversation now leaves a findable
  transcript; a scheduled task starts by reading how its recent runs ended
  instead of repeating last night's failure; and a long-running goal that hits
  its budget signs off with a proper handoff — progress, remainder, blockers,
  next step — instead of going quiet.
- **It notices the document moving under it** — come back to a conversation
  after editing your outline elsewhere, and the agent is told what changed
  before it answers from stale memory.
- **Your files are findable** — attachments (PDFs, recordings, videos) now
  appear in search, and the audio/video filters finally mean what they say.
- **Tenon tells you about new versions, quietly** — a gentle notice with the
  release note and a download link; never a popup.
- **A dozen fixes** — reading positions stop rewinding when a book or PDF is
  open twice, a restored pane keeps its history, popover lists lay out as rows
  again, a folder you bind stays your folder instead of a Skill namespace,
  deleted rows leave selection and focus, and a provider hiccup mid-answer no
  longer kills the whole turn.

### Added

- **An Automation run knows how its predecessors ended (PR #511, cc)** — a
  standalone Automation run starts on a Thread with no history, so it would repeat
  yesterday's failure with no way of knowing it had ever been attempted. A fresh
  run's prompt now carries a digest of its last three predecessors on the same
  schedule: each one's status, a single bounded outcome line, and the
  `transcriptPath` of that run's own account, so when the summary is not enough the
  model reads the full transcript with the file tools it already has — pull-based,
  no new model tool and no second ledger. Everything in the digest is treated as
  untrusted data: outcome lines collapse to one bounded line, and header values are
  stripped of newlines so a Thread or Automation name cannot forge a metadata line
  in the region of the file that presents itself as structure. The transcript
  artifact generalized on the way — it answers for a Thread rather than only for a
  delegated child, so it lives under `<userData>/thread-transcripts/` now, and
  startup **relocates** the pre-rename `subagent-transcripts` artifacts beneath it
  rather than deleting them (a finished Thread never appends again, so nothing would
  ever rebuild what a delete destroyed) before the orphan sweep reclaims exactly the
  ones whose Thread is gone. The high review gate found eight defects, all fixed in
  the same PR with regression tests verified to fail against the pre-fix code; the
  two carry-forward rules are in `docs/lessons.md` — a relocated call leaves its
  guard behind, and "no migration" licenses wiping dev userData, not deleting what a
  released build wrote.
- **A Goal that runs out of budget signs off instead of going quiet (PR #512,
  codex-2)** — a Goal that hit its token budget used to stop mid-stride with no
  summary; it now gets exactly one flagged wrap-up continuation that reports
  progress, remaining work, blockers, and the clearest next step. Every
  continuation prompt also carries live state — which continuation this is, and
  tokens used/remaining when a budget exists — while the objective and the
  completion-audit doctrine moved off the prompt onto the typed
  `contributeThreadContext` channel, so they are sent once as context evidence
  (objective as untrusted observation, doctrine as application instruction)
  instead of being re-persisted into every continuation Turn. The "exactly one"
  guarantee is **owned state** — a `goal_continuation_state` table with a
  reserve → commit/release protocol and a pre-generated Turn ID — rather than a
  scan of persisted Turn provenance, which is what makes it survive a restart, a
  fork, and a history rollback, and what keeps a pre-existing budget-limited Goal
  silent when the feature first ships. Eligibility is armed only when a
  **completed** Turn crosses the budget, so pressing Stop on the Turn that
  exhausts a Goal no longer starts another one. The high review gate found ten
  defects, all fixed in the same PR with regression tests; the carry-forward rule
  is in `docs/lessons.md` — a once-only guarantee needs a durable record, not a
  scan of history.
- **Every conversation keeps a record, and past sessions become findable (PR
  #519, cc)** — the transcript artifact that #511 generalized now covers every
  persistent Thread, not only delegated children, and a greppable
  `thread-transcripts/index.tsv` lists one row per recorded session (threadId,
  source, cwd, created/updated, status, name, path), newest activity first. A
  root Thread that can read files is told the index exists and when to consult
  it: work that refers to something earlier, repeats something that failed
  before, or asks what was already decided. Discovery is **pull-based** — the
  model reads what it needs with the file tools it already has; no new model
  tool, no second ledger, and nothing loaded into every prompt. Index rows and
  transcripts are labeled records of what happened, not instructions, so their
  content stays untrusted data. The index is a projection of the artifacts on
  disk rather than an accumulated log, so it cannot drift from them; it is
  rewritten by a coalescing single writer and reads its Thread records in one
  query per rewrite. Privacy is a **per-conversation** switch in the Thread
  action menu beside Rename and Delete: excluding removes the artifacts that are
  already there and stops future appends, and the unit is the **session**, so a
  root's delegated Subagent work goes with it rather than staying readable and
  advertised in the index. Re-including rebuilds each artifact immediately from
  canonical history rather than waiting for a next Turn a finished conversation
  will never have. The exclusion lives beside the records in `excluded.txt`, not
  as a column on the Thread record — it must be answerable synchronously while a
  Turn completes, and the metadata store has no schema-evolution step. The high
  review gate found ten defects, all fixed in the same PR: the session-vs-Thread
  exclusion unit and the no-op re-inclusion were the two that mattered, joined by
  a lost-wakeup window in the index writer, a stale index after rename/archive, a
  per-artifact synchronous query on the main-process event loop, a menu item that
  disabled itself under the cursor on every streamed delta, and a swallowed read
  failure that left it inert with nothing said.
- **Tenon tells you a new version exists, quietly (PR #514, codex-3)** — an
  unsigned build had no update channel at all, so the only way to learn about a
  release was to go back to GitHub. Main now polls the fixed
  `relixiaobo/lin-outliner` Releases endpoint: at most one attempt per six hours,
  a five-second deadline, started after the first window exists so startup never
  waits on it, and silent when it fails. Discovery is deliberately **passive** —
  the only ambient UI is a small rose status dot beside General in the Settings
  rail and beside About in the General page; there is no banner, toast, dialog,
  notification, or dock badge, and nothing appears in the main window at all.
  About holds the rest: installed vs available version, that release's own user
  note read from `CHANGELOG.md` at the exact validated tag through the same
  `parseChangelogReleases` contract What's New and release publishing use, the
  last successful check, an explicit recheck that bypasses the throttle, an
  automatic-checks toggle, and a Download update action. The dot is
  presence-based **status**, not an unread notification: opening About does not
  clear it, and it goes away only when the running build catches up or automatic
  checks are off — which is why there is no skip-this-version, remind-later, or
  dismissal lifecycle to get wrong, and why someone three trains behind sees one
  status for the newest train rather than three prompts. Every URL stays
  main-owned; the renderer names an action (`check`, `set automatic`, `open`) and
  can never hand a URL back across IPC, the `.dmg` must sit on GitHub's expected
  release-download path, the release page is the fallback when no usable asset
  exists, and remote Markdown renders with HTML disabled and controlled external
  links. Failure degrades honestly rather than hiding a known update: a note that
  will not fetch or parse still shows version and download, an ambient failure
  leaves the last valid release cached and says nothing, and an explicit failure
  is reported inline in About only. The high review gate found ten defects, seven
  fixed in the same PR. Two were load-bearing: the changelog byte ceiling was
  750 KB against a 562 KB append-only file this repo adds to every merge — one
  more month and every release note would have silently become empty — and both
  GitHub fetches followed redirects with no per-hop host allow-list, so an
  off-origin 302 could have put attacker-authored Markdown in the app's own About
  page and persisted it. Both are now contracts in
  `docs/spec/architecture.md`. The three findings left open are on the board as
  **#514 update-check review tail**; the ceiling lesson is in `docs/lessons.md`.
- **The agent is told when the document moved under it (PR #522, cc)** — the model
  could answer "what does the doc say about pricing" from a twenty-minute-old read,
  confidently and wrongly, and nothing fired: the write path is defended by expected
  revisions, the question-answering path had no equivalent moment. Between Turns, the
  host now compares the revision token each node tool already handed the model against
  the document as it is now, and admits one bounded notice naming up to five nodes that
  moved — with their current content, so the ordinary case costs no re-read — plus who
  changed them, and closing with the instruction the coding agents use in the same
  situation: these edits were deliberate, do not revert them. A node that went to the
  trash is named as deleted. Nothing new had to be persisted or added to a tool
  contract; beliefs rebuild from the tool outputs already in the record, so a restart
  or a fork needs no special case. The high gate found ten defects across two rounds and
  every one of them shipped fixed: the comparison could never match on **any** path
  (`node_read` emits a three-part outline revision, `node_search` an ISO string, and
  thirteen of `node_edit`'s fifteen paths a two-part stamp, all compared against one
  assumed shape), a trashed node fired nothing because the trash is a subtree that never
  stamps `updatedAt`, reporting a node dropped its belief instead of advancing it —
  inverting the whole feature — and the notice was admitted mid-Turn from `steerTurn`,
  consumed before the Turn was durable, rendered outside any guard, and attributed edits
  that predated the model's read. Every one passed the original tests, which hand-wrote
  the token shapes the implementation assumed; the rule that fell out is in
  `docs/lessons.md`.

### Changed

- **Search drops the dead embed model but keeps old queries valid (PR #510,
  codex)** — the `embed` node type existed only in the protocol (nothing ever
  produced one), so the search facets built on it — `HAS_AUDIO`, `HAS_VIDEO`,
  `IS_TYPE embed` — could never match, while the agent was still told they work
  and would report "no audio found" as evidence of absence. The dead type and
  its embed-backed semantics are deleted and the operator guidance stops
  advertising the audio/video facets; `HAS_AUDIO` / `HAS_VIDEO` remain
  parseable-but-inert compatibility terms, so persisted saved searches and
  replayed agent outlines keep executing and simply match nothing until the
  follow-up PR rebuilds them on attachments. `HAS_MEDIA` stays as an alias of
  `HAS_IMAGE`, and the search grammar spec now documents the real `IS_TYPE`
  alias set and candidate rules.
- **A failed tool states its outcome once, where it belongs (PR #518, cc-2)** — an
  expanded tool detail said "failed" three times over: the folded row's own status
  segment, a red sentence beneath the body (`Command failed with exit code 2`), and
  the output heading flipping to `Error`. `ToolDetail` carried two channels for one
  idea — a label and an error string — so every tool type kept them consistent by
  hand and most did it differently. The produced-value section's heading now **is**
  the outcome: the exit code rides the heading it explains (`Output · Exit code 2`),
  a tool's own error message fills the section it produced under an `Error` heading,
  and a failure with neither adds nothing below the row. The status colour lands on
  that heading alone, never on the arguments the tool was *given*. The review gate
  retracted its own headline finding after it had been built — a failing command
  cannot strand its exit code, because the executor writes `aggregatedOutput` and
  `exitCode` from the same tool envelope in one step — so the fix was reverted and
  what the round proved became a `PiTurnExecutor` test pinning that coupling from
  the side that would break it silently.
- **Your files are findable, and the media facets finally mean something (PR
  #516, codex)** — `AttachmentNode` has carried every audio, video and PDF since
  #204/#241, yet it was missing from search's candidate allowlist, so a file could
  not be found by text, by type, or by any facet while the sibling `image` type
  could. Attachments are candidates now: `STRING_MATCH` and the Launcher find a
  file by its filename, `IS_TYPE attachment` matches every searchable file
  including PDFs, and `HAS_AUDIO` / `HAS_VIDEO` stop being the inert compatibility
  terms PR #510 left them as — they read the stored MIME family, with `HAS_MEDIA`
  becoming the real image/audio/video union rather than an alias of `HAS_IMAGE`.
  **This widens existing saved searches**: candidacy is global, not
  operator-specific, so every executable tag, timestamp, field, link or structural
  rule now evaluates an attachment that carries its data — a `HAS_TAG` view under
  a tag-applying parent will list files it did not list before. Launcher rows
  present those hits with a file glyph and a localized `File` label so a file
  never reads as an ordinary note. The high review gate found seven, all fixed in
  the same PR, and one of them changed the design: the classifier's
  `application/octet-stream` → duration fallback and its `image/*` branch were
  both **unreachable** — ingest only records a duration once the MIME is already
  `audio/*`/`video/*`, and the write boundary rejects image-MIME attachments
  outright — so rather than keep two branches no user could reach, the fix moved
  to where the gap actually was: asset ingestion learned AAC, FLAC, Matroska,
  MPEG, Ogg/Opus, AVI, WMA and WMV by signature and extension, so a `.flac` or
  `.mkv` now carries a real family and matches. Stored MIME is the sole authority;
  duration is presentation data, never a kind override. One
  `mediaKindForMimeType` in core replaced three independent copies of the same
  prefix logic (search, file card, preview player), and the tests that had
  "covered" the dead branches by writing straight into `state.nodes` were rebuilt
  through the command surface.

### Fixed

- **A second view of the same book or PDF no longer rewinds your reading position
  (PR #524, codex-4)** — a reader kept the position it had captured when it first
  mounted, for as long as it stayed mounted. Open a book inline, open the same book
  in a split pane, read ahead there, then collapse and re-expand the inline
  preview: the inline reader restored its own stale snapshot and wrote that back
  over the shared record, throwing away the progress made in the other pane. Both
  readers now capture the shared latest position at a **session boundary** —
  keyed by preview identity, display mode, and the loaded document — through one
  `useReadingPositionSession` hook that `EpubPreview` and `PdfPreview` share, so
  re-entering full mode picks up the newest progress while a mounted session's
  target stays fixed and cannot be moved by another surface mid-read. A session
  that opens with no stored position marks itself restored instead of staying
  armed, which is what previously let a first-time reader be yanked to another
  pane's position on its next render. Positions also survive when browser storage
  is unavailable: both writers now update the in-memory cache before the storage
  guard rather than returning early and losing the position entirely. The high
  review gate found eight defects across two rounds — the yank, the lost in-memory
  fallback, and five E2E-quality problems (assertions gated on a shared,
  non-attributable `updatedAt` singleton rather than the reader's settled state)
  — all fixed in the same PR, and the PDF half was fixed at the shared mechanism
  rather than as a second copy of the EPUB patch.
- **A pane whose file preview outlives its node is repaired, not thrown away (PR
  #523, codex-3)** — restoring a same-day layout dropped any pane whose current
  view no longer validated: preview a file node, delete the node, restart, and the
  whole pane vanished along with the outliner it had been opened from. Restore now
  sanitizes the pane into a candidate and repairs it — an invalid current view
  lands on the latest valid **outliner** entry in the pane's Back stack, then
  Forward. Entries skipped on the way there are not discarded but moved to the
  opposite stack in navigation order, so a URL or Turn Diagnostics view stays one
  Back/Forward press away instead of being silently mounted at launch. A preview
  opened as a *fresh* split has no history at all, which is the original bug's own
  path, so those panes now record a `recoveryRootId` — the source pane's live
  outliner root — and fall back to it, then to the live Today/library root.
  Recovery never clones a root that is already on screen (an active recovered pane
  keeps its identity, otherwise the existing valid pane wins), while duplicate
  outliner panes the user opened deliberately with `Cmd+M` are left alone. Runtime
  healing was folded onto the same policy — `repairMissingOutlinerRoots` became
  `repairInvalidPanelViews` and now widens from "missing outliner root" to full
  view validity — so deleting a node with the app open and deleting it before a
  restart no longer land the pane in different places. Turn Diagnostics also gained
  a real close: when sanitization leaves no Back destination and another pane
  remains, its X removes the pane instead of invoking an empty Back stack.
- **Popover lists stack as rows again (PR #515, anti)** — retiring the command
  palette (PR #505) took the shared popover row contract with it: the CSS the
  popovers depended on lived in the palette's selector groups, so slash commands,
  tag and reference suggestions, field-reuse and options pickers lost full-width
  vertical rows, their icon and label slots, the neutral active fill, normal
  enabled opacity, and the generic bullet. The popover-only selectors are rebuilt
  without reviving any dead `.command-*` rule, and `PopoverBulletIcon` now carries
  its own decorative class instead of borrowing the node-marker one. The live
  light/dark runtime surface probe gained the invariants that would have caught
  it — row width against the parent's content box, vertical stacking, active
  state, and a visible bullet. Those guards were themselves hardened at the review
  gate: the bullet check skipped an invisible bullet instead of failing on it, and
  compared a `NaN` parsed from `width: auto` against its threshold, so both blind
  spots exactly matched the regression being repaired; the row-stacking check also
  dropped every `role="menu"` popover on the floor. Each fix was verified by
  re-injecting the original breakage and watching the guard fire.
- **A folder you bind is your folder, not a Skill namespace (PR #513, codex-4)** —
  write governance resolved a Skill target from **path shape alone** and never asked
  whether a Skill had actually loaded there, so inside a directory the user bound by
  hand `<bound>/taxes/2025.md` was validated as support content of a Skill "taxes"
  that does not exist, and `<bound>/Research Notes/summary.md` was refused with
  `invalid_skill_name` though it is not a Skill at all. Ownership now follows what the
  registry admitted: the convention directories (`~/.agents/skills`, the workspace
  `.agents/skills`, nested ones) stay dedicated namespaces where path shape governs
  content before a `SKILL.md` exists, while a bound directory is an ordinary folder in
  which only an **admitted** child root owns its definition and support files. An exact
  `<bound>/<name>/SKILL.md` write remains a governed admission attempt, and admission
  now validates the whole prospective bundle — so authoring the support files first no
  longer smuggles executable, secret-looking, symlinked, or oversized content into a
  Skill, which is the hole the write-order swap opened. Ownership is independent of
  invocation state, and when a convention and a bound candidate overlap the most
  specific valid root wins on **logical** path, not on where a symlink happens to
  point. The high review gate found ten defects, all fixed in the same PR with named
  regression tests: the write-order bypass above, a bind window in which a settings
  change left the in-flight turn resolving against a stale snapshot, alias dedup that
  attributed a write to a container the file was not in, canonical-vs-logical depth
  ranking that governed a symlinked Skill's own `SKILL.md` as its parent's support
  file, a swallowed reload failure reported to the model as success, and a managed-Skill
  mutation path that had come to await a full re-hashing disk rescan inside the
  mutation lock. The fix inverts the refresh model rather than patching each window —
  a definition write invalidates the registry synchronously, and Skill-path resolution
  is async and awaits the reload, failing closed if it cannot complete.
- **Reasoning stops printing its own headline twice (PR #517, cc-2)** — a collapsed
  reasoning block shows a one-line summary; expanding it re-rendered the complete
  source, so a leading paragraph appeared once flattened in the summary and again in
  the body. The body now starts after a leading paragraph or heading the summary
  already carries whole — but only when carrying it whole loses nothing. A paragraph
  containing a link, an image, raw HTML, or a Node reference goes back to the body,
  headline duplication and all: flattening keeps such a token's visible text and
  drops its target, so the tidier rendering would have put a URL in neither place and
  stripped a Node reference of the affordance that opens it.
- **Deleted rows no longer linger in selection, focus, or open editors (PR #521,
  codex)** — when an agent or another view removed rows, renderer-local UI state kept
  their ids: the selection count could report rows that no longer exist (and a batch
  action on them failed with an error), an undo could pop a deleted node's description
  editor back open, and a parked focus or reference request could fire at a dead row.
  Every accepted projection update now reconciles that state against the nodes that
  left the projection — delta removals and full resync reseeds follow the same rule,
  which closes the recovery-path gap the review gate found in the original patch
  (pruning only on deltas meant a resync revived exactly the stale-state class being
  fixed). The spec now also pins the focus convention: outliner-row focus goes through
  the focusRequest rail (IME composition guard); direct `element.focus()` is reserved
  for non-editor chrome. The high review gate found six findings, all fixed in the
  same PR, and the fix extended past the report — a surviving row whose recorded focus
  parent was removed clears the whole focus family, hidden-field expansion keys are
  culled with their rows, and the batch-tag UI closes when pruning empties the
  selection.
- **A relay hiccup no longer kills the whole Turn (PR #520, codex-2)** — pointing Tenon
  at a third-party OpenAI-Responses relay meant a single injected frame or a dropped
  connection ended the answer outright, while the same relay worked fine under other
  clients. Three behaviours close that: a non-terminal frame carrying a **non-empty**
  `error` is dropped instead of thrown on (a `null` or blank one passes through, so a
  relay that stamps `"error": null` on every chunk is not mistaken for noise), a stream
  that goes 300 seconds without a byte is aborted — long enough for the silent gaps that
  are normal at high reasoning effort — and a stream that dies after it already started
  is retried up to three times with backoff. Retry is deliberately narrow: rate limits,
  server and transport failures, and known relay/idle interruptions qualify, while a
  statusless `badRequest` stays terminal so a wrong key, an unknown model, or an
  exhausted quota fails once instead of resending the full context four times. What the
  abandoned attempt already printed stays on screen under a new durable `interrupted`
  message phase, and is excluded from the final answer, Memory, the next request's
  context, signed-reasoning replay, and token accounting — an interrupted segment, the
  reconnect indicator, then a fresh segment, with no concatenation between them. Dropped
  frames are secret-scanned, bounded, and capped at 64 per response before appearing in
  Turn Details. Official OpenAI, Azure Responses, and non-Responses adapters keep their
  existing transport untouched. The high review gate found ten defects, all fixed in the
  same PR; the two load-bearing ones were a retry predicate that defaulted to *retryable*
  for any custom-endpoint error — which also widened the tool-call salvage path, so a
  provider 500 could execute a mutating tool call and report the Turn as successful — and
  the abandoned partial being persisted as a genuine `final_answer`, which fed the
  truncated text back into Memory extraction and the next provider request.

### Internal

- **Opened the 0.3.0 train (main-agent)** — `package.json` dials to `0.3.0`
  after the v0.2.0 tag so dev builds name the next train.
- **Deleted 30 message keys nothing reads (PR #518, cc-2 + main-agent)** — chasing
  one unused string turned into an audit of the whole English tree, asking of every
  leaf whether its identifier is typed anywhere in `src/`, `tests/`, or `scripts/`.
  Thirty were not, across `agent.thread.*` (the eight Item-type display names and
  nine more), `settings.skills.managed*`, `shell.filePreview.*`, `agent.turnDetails.*`,
  and five singles; none was reachable through computed member access either, and all
  were already dead before this train. `i18nCoverage` cannot catch the class — it
  guards that each locale is a subset of English, which says nothing about whether
  English itself is read — so every one of them was a line the next translator would
  have paid for and a promise the UI never kept.

## [0.2.0] - 2026-08-09

**Tenon 0.2 pulls the app together into one command surface — and fixes what
made 0.1 feel rough.**

- **Right-click and ⌘K now share one brain** — every node action lives in a
  single core registry; the context menu and the launcher are two views of it,
  so they can never offer different things. The launcher acts on the row you're
  focused on, and can capture the browser page you're looking at. Indent and
  Outdent join the searchable set; permanent deletion asks with macOS's own
  confirmation sheet.
- **Chinese, Japanese and Korean input works in the launcher** — composition no
  longer breaks mid-word, and the candidate window is no longer covered by the
  launcher itself.
- **Search has a visible home** — a Search row leads the sidebar, and Settings
  shows the global launcher's real shortcut.
- **The agent reads the web again** — page fetching had gone completely blind
  and is fixed, redirects included.
- **Delegated work reads like a colleague** — a subagent is one named row in
  the timeline that opens in place; you're no longer teleported into a child
  conversation. A failed turn gets a real Retry button, and everything you did
  that fails reports to one notice at the top of the window instead of the
  agent's corner.
- **Coming back lands where you were** — reopening a Thread restores your
  reading position instead of dropping you somewhere else in the transcript.
- **Browser Pilot comes preinstalled** — the agent can drive Chrome out of the
  box; removing it sticks.

### Added

- **Search has a visible home in the sidebar (PR #497, main)** — a Search row now
  leads the sidebar and opens the command palette, showing its real shortcut
  beside it (derived from the shortcut registry, so a rebind carries through).
  Search had been fused into keyboard-only surfaces, so a mouse-first user could
  not find it at all. Settings → General gains a read-only Shortcuts row naming
  the global launcher's registered accelerator — including the case where every
  candidate shortcut was taken, which previously left the launcher unreachable
  with no indication anywhere.

- **Browser Pilot arrives already installed (PR #492, codex-4)** — the Skill that
  lets the agent drive Chrome is acquired and enabled on launch instead of
  waiting to be found in the catalog, while staying an ordinary `managed` Skill
  on the public `Agent → browser-pilot → bash → bp → Chrome` path: no bundled
  bytes, no product-owned downloader, no Browser Pilot model tools. The `bp` CLI
  is not fetched at startup — the Skill's own preflight reuses a compatible
  command or installs the pinned tested release on the first task that needs a
  browser. Removing the Skill is durable: uninstall records an opt-out, so the
  default does not quietly reinstall itself on the next launch, and an unreadable
  opt-out file is quarantined *toward* opted-out rather than toward silent
  re-enablement. Host environment reaches the shell through a registry keyed by
  the managed Skills active in the Turn — an integration the user does not have
  contributes nothing, one that fails is logged and skipped rather than taking
  `bash` down with it, and its `$PATH` entry sits behind the user's own
  `LIN_AGENT_EXTRA_TOOL_PATH` override and is admitted only when the directory
  holds nothing but managed links into the pinned install root. Startup
  acquisition is off the turn-admission path, so a slow or captive network delays
  the Skill, not the user's first message.

- **A failed Turn has a way out that is not editing your own message (PR #503,
  cc)** — a crash you did not cause offered Copy, Continue in new chat and
  Details, none of which run the request again; the only recovery was to hover
  your *own* message and press Edit, which frames a system failure as a typo,
  sits across the transcript from the error, and is unavailable outright for a
  message carrying more than one text part. A last Turn you did not end now leads
  its action row with **Retry**, re-sending that Turn's request unchanged through
  the same rollback-and-send path Edit uses — the question is not asked twice and
  the dead Turn does not linger. It appears only where it could actually work: on
  the last Turn, on Threads where you can type at all, and for failures that
  could go differently — a runtime failure, an exhausted Subagent budget (spend
  is request-scoped, so a new Turn delegates against a fresh grant), or a host
  that restarted under the Turn. A structural depth limit is excluded, because
  the next attempt meets the same wall, and so is a Turn you stopped yourself.
  The button latches while it runs and reports a refusal in place rather than
  doing nothing quietly.

### Changed

- **A delegated subagent is one row, named like a person (PRs #498 + #500, cc)** —
  handing work to a Skill no longer renders a machine address
  (`skill_research_ab12cd34ef56`) and a separate delegation card below the
  transcript. The child's real name appears in one row inside the process
  timeline, exactly where the delegating call sat: running, the row shows the
  skill glyph, a spinner, elapsed time and a per-child Stop; settled, it shows
  the outcome and how long the child took (`Completed · 3m 12s`), read from the
  child's own Turn. Two runs of the same Skill are numbered apart so the rows —
  and their tooltips and accessible names — stay distinguishable. A settled
  Turn's timeline still folds, but never over a child that is still running:
  the fold waits until nothing inside it is live and stoppable. Old thread
  histories decode unchanged — the new delegation field is additive-tolerant,
  so no data wipe accompanies the upgrade.
- **What's New speaks to users, not to maintainers (PR #494, cc-2)** — Settings →
  About shows the running release's short user note rather than the engineering
  changelog's `Added`/`Fixed`/`Internal` ledger, and the release picker is gone:
  one card, headed with the version, ending in a "Full changelog" row that opens
  that section on GitHub. The GitHub Release body is the same note plus the same
  link, lifted by `scripts/release-notes.ts` through the parser the pane uses, so
  the two user surfaces cannot describe one release differently — and the entries
  stay one click away instead of being reprinted or, as before, buried under
  hundreds of lines. The note is everything a section writes above its first
  category heading, so no amount of category detail (`Internal` included) can
  reach a user surface by accident.
- **A release cannot publish notes that are missing or nonsense (PR #494, cc-2)** —
  `release-notes.ts` refuses four ways: no section for the version, a section with
  no note, a note that is still the `[Unreleased]` train line (the shape the
  natural freeze motion carries down into the released section), and `Unreleased`
  itself. `.github/workflows/release.yml` documents all four and directs the
  release-cutter to run the script as a pre-flight — the workflow runs it after
  the `v*` push, where a failure lands with the tag already public and recovery
  means deleting and re-pushing it.
- **Every node action now comes from one core registry (PR #504, cc-2)** — the
  context menu is no longer a place where the menu's own code decides what a node
  can do. It is a filtered, anchored view of a single action registry in
  `src/core/actions/`, and the renderer may *name* an action — action id,
  invocation ref, subject ref, typed arguments — but never construct the effect:
  main validates the naming against the latest projection, mints the objects, and
  runs the plan itself. Two user-visible changes ride along. *Move to* stops
  letting invalid descendants consume the candidate limit and hide a valid ranked
  destination, and a mixed selection's *Toggle done* becomes convergent *Mark
  done* / *Mark not done*, changing only the nodes not already in the requested
  state. Action copy is normalized in both locales, and the tag picker's *Create
  X* row is localized rather than hard-coded English. The branch carried a
  differential parity oracle — the shipped menu kept in the tree and compared
  against the registry over six real document states — and the review gate still
  found ten defects underneath it, every one in a state the oracle never entered:
  the anchored row had been replaced by "the first selection root", which could
  offer and then execute *permanent deletion* on a node the user had not
  right-clicked; a rejected or half-applied plan closed the menu with no error
  where the shipped `useCommandRunner` path had shown a banner; routing *Move to*
  through the search kernel silently dropped system containers from the
  destination set; the tag picker's Enter could commit a debounced candidate
  resolved for text the user had already moved past; an explicit `pin` degraded
  into a blind toggle; tag colours resolved by label text instead of node id; and
  a refused opening left the surface dead until the next right-click. All ten are
  fixed with regression tests before this landed.

- **A Subagent is read where it was delegated (PR #502, cc)** — opening a child
  used to swap the whole dock: the title became a Thread the user never chose and
  the composer silently changed conversations. The delegation row now opens the
  way every other process row opens — as a disclosure — and what it reveals is a
  bounded container with its own scroll, not a surface. The row that was opened
  does not move, because the container grows below it, so there is no reading
  position to lose and none to restore, and scrolling never chains into the
  transcript's. A grandchild replaces the container's contents rather than
  nesting a second scroll region, with the header naming the way back; depth is
  capped at two. Thread Details still opens a child and now carries the lineage
  of the one it meant, opening the process fold the row sits inside rather than
  writing a disclosure key nothing reads. A Turn started by a delegation renders
  its trigger as an origin-labelled block instead of the reader's own message
  bubble, with no edit affordance.

- **One place to look when something you just did did not work (PR #508, cc)** —
  an outliner command, a pane operation and an agent dock action all failed the
  same way from your side, but the message landed in the bottom-right corner,
  which is the agent dock's territory, so a failed *outline* edit read as the
  agent failing. Failures now report to one notice anchored to the window, top
  centre below the chrome band, and it leaves on its own instead of sitting there
  as clutter. The dock's own strip narrows to what it really owns — a provider
  that is not configured, a thread list that failed to load — the conditions that
  persist and cannot be dismissed. The card is click-through, so reporting a
  failure never swallows the click you make next on the rows underneath, and
  resting the pointer anywhere over it — or tabbing to its close button — waits
  until you are done reading, then restarts the full countdown rather than handing
  back the sliver that was left. Dismissing with the keyboard returns you to where
  you were in the outline. Repeating an action that fails identically now restarts
  the countdown instead of leaving the retry to inherit the tail of the first
  attempt, a failure you have not read yet is no longer erased by the next
  keystroke or by starting an unrelated dock action, and a failure while the app
  is still loading is reported as itself rather than as "failed to start".
- **The launcher becomes a command surface, not just a search box (PR #505,
  cc-2)** — every row is now an *object*, and ⌘K stops being a way to summon the
  launcher and becomes "show me what I can do with this one": a searchable,
  keyboard-driven action list built from the same core registry the right-click
  menu reads, so the two surfaces cannot drift into offering different things.
  Summoning over a focused row picks up that row; summoning over a browser page
  offers to capture it, send it to the agent, or file it — and the capture loop
  runs through the registry rather than its own private IPC handlers. Indent and
  Outdent join the searchable set. Permanent deletion now raises macOS's own
  confirmation sheet instead of an in-app dialog, and declining it is silent
  rather than reported as a failure. The in-app command palette is retired
  outright, along with every style, message and constant it left behind. The
  launcher's bridge is narrowed at the same time: the window that can be summoned
  over any application no longer holds the generic invoke surface, only the
  action seam, and main rejects anything else from that sender before dispatch.
  The `/code-review xhigh` gate found fifteen defects, led by one that would have
  shipped a completely dead app: splitting the preload into two bundles emitted a
  shared chunk that a sandboxed preload cannot load, so `window.lin` was
  undefined in every window — no document, no IPC, no agent — while typecheck,
  both unit suites and the entire Playwright suite stayed green, because none of
  them load an Electron preload. A guard now pins the preload to one bundle and
  checks the emitted artifact.

### Fixed

- **The agent can read the web again (PR #509, codex)** — `web_fetch` had gone
  blind. It hand-built a browser navigation's `Sec-Fetch-*` headers and sent them
  through Electron 42's `Session.fetch`, which Chromium 148 refuses on that path
  (`Sec-Fetch-Mode: navigate` → `net::ERR_INVALID_ARGUMENT`), so every fetch
  failed before it reached the network. Chromium now owns the whole Fetch
  Metadata set; the accepted user agent, client hints and content negotiation
  stay. Redirects were a second wall: Electron cancels `redirect: 'manual'`, so
  the hand-rolled per-hop loop could never run a single hop, and every
  redirecting URL — `http`→`https`, bare domain → `www`, link shorteners, most
  news fronts — died on `Redirect was cancelled`. Chromium follows the chain
  now, with a request-scoped observer on the dedicated session recording the
  landing URL that `Response.url` leaves empty, feeding the existing final-URL
  result and cross-host hint. `file_read` had the mirror problem: `pages` was
  offered for every file type, so a valid selector on a non-PDF read failed
  outright while a malformed one (a JSON number instead of a string) was
  silently dropped and could answer questions about "page 12" from text that was
  not page 12. A malformed value now fails loudly, a valid one is ignored only
  after the read route is known — with a warning that names what that route
  actually supports instead of pointing at `offset`/`limit` the notebook, slide
  and rich-document readers do not honor — and the catalog says again that a
  plain PDF read returns the whole document's extracted text.
- **The web-tools probe can no longer report a silent success (PR #509, codex)** —
  the probe that guards the above had three ways to look green while broken. Its
  fixture only ever answered 200, so it passed 7/7 on a build where every
  redirecting URL failed; it now serves a real 302 and rejects a contradictory
  Fetch Metadata triple with 409. Fixture setup and teardown ran outside the
  probe wrapper, so a failed loopback listen aborted the run with a bare stack
  trace and no verdicts; both are reported as probes now. And the process
  inherited Electron's default `window-all-closed`, so a tool-owned
  BrowserWindow closing mid-run killed it with exit code 0 before the summary —
  masked only by the window-using search probe happening to be last. The probe
  owns its lifetime, the search runs before the remaining fetches, stdout is
  flushed before an explicit exit, and a closing expected-name check turns a
  missing, duplicated or unplanned probe into a failure rather than a partial
  green run.
- **Coming back to a Thread lands where you were reading (PR #499, cc-2)** —
  opening a Subagent page, Automations, or another Thread and returning used to
  drop the reader somewhere else in the transcript: the snapshot recorded a
  pixel offset, but unrendered Turns rebuild at a 180px placeholder height, so
  the transcript came back shorter and the offset pointed past where the reader
  was. The snapshot now records the Turn being read plus its offset, measured
  Turns carry their real height through the rebuild, and the restore corrects
  itself against that anchor until the layout settles.
- **Chinese, Japanese and Korean input works in the launcher (PR #497, main)** —
  two separate defects made it unusable. Committing a candidate with Enter fired
  the highlighted row instead of the IME (capturing half-typed text, or opening
  the main window and dismissing the launcher); the launcher now leaves Enter,
  the arrows and Escape to an active composition, as the in-app palette already
  did. And the launcher covered the candidate window outright — it was pinned at
  the `pop-up-menu` window level, where macOS also presents candidates — so there
  was no list to choose from. It now floats below that level and still above
  ordinary windows.
- **The launcher footer reads as a hint bar, not a stray button (PR #497, main)** —
  the shared control styles were never loaded in the launcher bundle, so the
  action hint rendered with the browser's default button chrome. It now carries
  the app mark and summon hotkey on the left, and the action verb plus `↵` on the
  right; a command row no longer restates its own title there ("Open main window"
  appeared twice on screen). Save failures and progress moved out of the
  clickable control into a status zone, and the dev-only "restart the dev app"
  failure line no longer reaches packaged builds.

- **The agent process timeline reads as one compact sequence (PR #493, codex-3)** —
  reasoning rows now share the timeline's own spacing instead of adding their
  own, the structural bottom pin happens in the same paint so a followed
  transcript no longer jumps on the second frame, and a reasoning Item observed
  while its Turn is live stays folded when the Turn settles rather than
  expanding under the reader. A reasoning row carries a disclosure only when it
  actually hides something: a summary that fits its width is a plain row, and a
  truncated one wraps in place. Summaries are derived with the Markdown lexer
  rather than split at a physical newline, so a leading fence, table, or list
  expands from the complete canonical source and literal asterisks, globs, and
  inline code survive verbatim — the previous `*`-stripping split could destroy
  a leading code block and leave the mangled line as the only rendering. Empty
  provider commentary is dropped at the Turn process projection, not at the leaf
  renderer, so it can no longer open an empty timeline container, split one
  aggregated tool run into two, or defeat the lone-resultless-reasoning default.

- **`docs:check` no longer fails every branch that introduces a plan (main)** —
  the C2 orphan-plan guard exempts a plan not yet on `origin/main`, because
  boarding it is the integration gate's job at merge. That exemption never fired:
  it keyed off `git cat-file -e` exiting 1 for a missing path, but `cat-file`
  exits 128 for both a missing path and a missing ref, so every probe fell
  through to strict checking and reported a false orphan. The ref is now probed
  separately with `git rev-parse --verify --quiet`, and any `cat-file` failure
  under a present ref means the path is absent. A genuine orphan — a plan on
  `origin/main` with no board reference — still fails as before.

- **`test:core` is green again after the `plans/reference/` split (main)** — the
  legacy-residue guard exempts the standing authorities that describe the model
  the Agent Core replaced, by exact path. Moving `agent-program`,
  `agent-conversation-model`, `agent-data-model`, and `agent-memory-foundations`
  into `docs/plans/reference/` left those paths pointing at nothing, so the four
  documents were scanned and the guard failed on their own subject matter. The
  exemptions now name the real locations, the three archived `agent-codex-*`
  entries are dropped as redundant with the `plans/archive/` prefix rule, and a
  new assertion fails on any exemption path that no longer resolves — so the next
  move reports the stale entry instead of the residue it silently stopped
  covering. `plans/reference/` is still not exempt as a directory.
- **A blank tool argument no longer kills the Turn (PR #503, cc)** — asking for
  three parallel Subagents failed with `item.model: expected a string` and left
  **nothing on disk to explain it**: no collaboration Item, no child Thread, no
  diagnostics. The provider had filled an optional argument with `""` instead of
  omitting it, and the Item is decoded *before* it is recorded, so the run died
  without a trace. A blank optional argument is now recorded as "not specified",
  and the decode tolerates an empty value in every Item string a tool call can
  put one in. The whole class was closed rather than the one instance: a blank
  `bash` command, a blank file path (named `(unknown path)`, as an absent one
  already was), a web search with no query, and — the case that depended on no
  provider quirk at all — a search result whose *backend* sent an empty title or
  URL, which killed the Turn at completion. Tool input that the model can
  usefully be told to correct, such as a blank choice label, is still refused.
- **A Skill refusal no longer kills the Turn, and a delegated child is not
  starved by its own cap (PR #502, cc)** — three parallel Subagents all died with
  `Completed Skill tool result is missing invocation evidence.`: a refused
  `skill` result carries a message written for the model to act on, but the
  bookkeeping that records *which* Skill ran demanded evidence of an invocation
  that never happened, and threw. The refusal now reaches the model, and the
  remaining evidence gap logs instead of ending the Turn. Separately, a model
  naming a small `max_total_tokens` for a child was starving it mid-answer and
  handing the parent a refusal instead of the delegated work; a cap the child
  could not survive is now dropped rather than honoured — which also keeps that
  child inside the shared `subagentTokenBudget` the user configured, since any
  honoured cap moves a child into a private pool of its own. A programmatic
  caller naming a cap is still left alone.
- **A failed Turn no longer ends the conversation (PR #506, cc)** — a Turn that
  died on the launch path left the Thread in `systemError`, and nothing in the
  app ever cleared it. That status persists, and both rollback and Turn admission
  accept only an idle Thread, so a single crash locked the conversation out of
  retrying **and** out of receiving a new message — permanently, across restarts,
  with no way forward but abandoning it and starting another. #503 made that
  refusal visible; this is the state behind it. The failure is now recorded only
  where it belongs — on the Turn, `failed` and carrying its `TurnError` — and the
  Thread returns to idle, as the sibling failure path always did; a Thread
  already carrying the status from an earlier version is healed when it loads, so
  conversations bricked by the old behavior come back. Thread Details reads a
  child's failure from that child's latest Turn instead of its Thread status, so
  a Subagent whose Turn died is no longer listed as Idle. And a Turn that no
  longer owns its Thread writes no Thread status at all: completion releases the
  Thread before its tail of naming, usage accounting and extension hooks
  finishes, so a new Turn can already be running when a late failure arrives.
- **Editing or retrying a message keeps the image attached to it (PR #507, cc)** —
  both actions roll the Turn back and then re-send the very content that was
  removed, references and all, but the rollback reclaimed every payload the
  *surviving* history no longer pointed at. The attachment's only referent was the
  Turn that had just gone away, so its bytes were deleted one call ahead of their
  use and the re-sent message failed with `Managed attachment payload is
  unavailable or corrupt` — most likely on Retry, where the failure being retried
  is often about the image. A rollback now reclaims resources against the
  surviving history **plus the Turns it removed**: what those Turns referenced is
  what the re-send is about to reference again, and what neither set references is
  garbage no re-send can reach, so it still goes rather than lingering against the
  Thread's resource quota — which counts every byte on disk but can only ever
  offer surviving history as reclaim candidates, so leftover bytes would push a
  Thread toward tiering away live originals, or refuse the next attachment
  outright, until the app restarted.

### Internal

- **Re-anchored the `unified-command-surface` plan against the shipped tree
  (cc-2, PR #501)** — five PRs had merged since the plan was last refined, one of
  which (#497) rewrote the very launcher files it cites, so ten `file:line`
  references had drifted and three passages described a surface that no longer
  existed. Every citation in the plan now resolves, and `types.ts` is
  disambiguated to `core/types.ts` (two files share the basename). Three
  corrections were substantive: the plan claimed the shipped launcher had no IME
  guard (#497 shipped one) and told PR 2 to delete an interim empty-query Enter
  wait that was withdrawn at that gate rather than shipped, so PR 2 inherits no
  stopgap for the show→context race; and the one-sentence step retiring the
  in-app command palette became a derived table of every consumer, because
  deleting the component alone does not compile. At the gate the table was
  checked against its own `rg` query and was still missing the handler that
  actually opens the palette, the two renderer tests guarding it, the shortcut
  union member, and both locale entries — all now listed, with the query written
  into the plan at whole-tree scope. No design decision changed; the retargeted
  (not deleted) `/`-menu entry is recorded as PM-ratified.
- **Removed a stray agent test deliverable from the repo root (main-agent)** —
  `美国政府限制外国人使用Fable5事件分析.pptx`, a 26KB deck the in-app agent
  produced on 2026-06-15 while the inline-deliverable-preview feature was being
  exercised (its near-namesake lives on as a fixture path in
  `tests/renderer/inlineFilePreviewData.test.ts`). The deliverable landed in the
  clone root — this predates the agent local-root containment — and a blanket
  `git add` in a same-day bookkeeping commit (`36a7c72a`) swept it in unnoticed.
  Removed from HEAD; it remains reachable in git history and the `v0.1.0` tag
  tree unless a coordinated history rewrite is ever deemed worth it. The packaged
  app never shipped it (`build.files` packs only `out/**`).

- **One path-containment predicate for managed skill storage (main-agent)** —
  `safeChildPath` hand-rolled the `path.relative` / `startsWith('..')` /
  `isAbsolute` triple that `isPathInside` already exports, which #492 had just
  removed from its two copies in `browserPilotHost.ts`. It now calls the shared
  helper, with an explicit root-equality guard because `isPathInside` admits the
  root itself and a child path that resolves back to the root is not a child.
  Behaviour is unchanged; the point is that the next correction to a path-escape
  guard has one fewer place to be missed.

- **One implementation of the path-containment predicate (main-agent)** — the
  `path.relative` / `startsWith('..')` / `isAbsolute` triple that `isPathInside`
  exports had been copied into three more standalone helpers:
  `ToolPayloadStore`'s own `isPathInside`, `agentLocalTools`'
  `isResolvedPathInside`, and `agentSkills`' reversed-argument variant. The first
  two now call the shared helper directly; the third stays a named local because
  its callers treat the root itself as *outside*, but it is a one-line adapter
  over the shared predicate rather than a second copy of the logic. Behaviour is
  unchanged at all eight call sites. Four sites keep their inline check on
  purpose — `skillMatchesPath`, `isGitIgnored`, and
  `isSelfDefinitionContentPath` need the `relative` value they compute for glob
  matching, the `git check-ignore` argument, and segment counting, so routing
  them through a boolean helper would compute the relative path twice; the two
  remaining `agentLocalTools` sites are a different predicate (a normalized
  relative, and a glob pattern rather than a path).

- **Open the 0.2.0 train; seed user-register release notes (main-agent)** —
  `package.json` dials to `0.2.0` after the v0.1.0 publication. `[0.1.0]` gains
  a user-language welcome note as its opening block (its engineering provenance
  moved under that section's Internal category), `AGENTS.md` records the
  release-freeze rule — main drafts the user note from the section's entries,
  the PM ratifies — and the What's New renderer change is boarded as
  `whats-new-user-notes` (plan PM-ratified, unclaimed).

## [0.1.0] - 2026-08-06

**Welcome to Tenon 0.1 — the first public build.** Tenon is a local-first
outliner with a built-in AI agent.

- **Outline your thinking** — keyboard-first outlining with tags, fields,
  dates, and search.
- **Direct a local agent** — it works in a side dock, reads and edits your
  outline, runs tools, and asks before doing anything risky.
- **Extend it with Skills** — install Skills from the library, or author your
  own and let the agent use them.
- **Read anything** — PDF, EPUB, Office, and web previews, with bilingual
  translation.
- **Capture from anywhere** — a global launcher drops thoughts into Today
  without leaving what you were doing.

Your data stays on your machine. Future updates list what's new here.

### Added

- **Agent images are durable, inspectable artifacts (PR #490, codex-2)** —
  generated images, user image attachments, and image-producing tools now share
  one immutable artifact identity with separate source-quality and bounded model
  renditions. Chat models receive only a normalized observation (at most 2,000 px
  per edge and 4.5 MiB) plus exact source-to-observation geometry, while Preview,
  editing, copy, export, and file tools prefer the original and fall back to the
  observation through one stable materialized path. History, forks, and inherited
  context preserve the artifact while tolerating missing renditions, so one lost
  image no longer kills the surrounding Turn. Generated originals remain durable
  until storage pressure reclaims tiered originals before observations under the
  Thread's 5/6/8 GiB retention policy; external, user-owned, and ordinary Thread
  resources stay protected.

- **`/new` starts a Thread without leaving the composer (PR #486, codex-2)** —
  typing `/new` and pressing Enter creates an empty Thread and selects it, so
  starting a fresh conversation no longer means reaching for the Thread list.
  The completion is offered in the slash menu like any other command, but once
  the token is typed in full the menu gets out of the way: a slash command that
  takes no argument (`/new`, `/clear` — the ones whose `insertText` carries no
  trailing space) closes its own trigger on an exact match and submits on the
  first Enter, while argument-taking commands like `/compact` keep their menu
  open. Casing variants are treated as an unfinished token, so `/New` offers the
  completion rather than being sent to the model as a message. `/new` is gated on
  any usable provider rather than the current Thread's own send gate, and when no
  provider is configured it says so inline instead of doing nothing; a failed
  creation keeps both the draft and the Thread you were in, and returns focus to
  the composer once it is editable again. Runtime command names are reserved, so
  a user Skill named `new` no longer renders a duplicate, uninvocable row.
  Leaving for a new Thread never interrupts the one you left: a Thread whose own
  Turn is still running now carries the same background-work dot the Thread list
  already showed for working descendants — but a Thread merely parked on a
  question does not, because that state needs you to come back, not to be told it
  is busy.

- **A Subagent is a place you can go, and every delegated child says what it is
  doing (PR #471, cc-2)** — child Threads leave the conversation history
  entirely: `thread/list` pages root conversations only, and a child is reached
  where it belongs — from its parent's transcript, from a new Subagents section
  in Thread Details that browses the whole subtree with name, status, and last
  activity, or from a neutral dot on a root whose descendant is still working
  after the parent Turn ended. A child Thread's header carries a `← parent /
  child` breadcrumb without giving up the Thread list, so no view is a dead end.
  Bulk cleanup deletes only Threads whose entire subtree has stopped — deleting
  cascades, so "delete finished" never takes a running grandchild with it, and a
  child holding queued work counts as busy rather than finished. Both deletions
  confirm first and re-take the decision against a fresh read at the moment of
  confirmation, because a child that was idle when the dialog opened can be
  running again by the time the button is pressed. Isolated-Skill delegation
  gains the same per-child status row collaboration already had: previously one
  in-progress `skill` row stood for the whole child run, with no sign an agent
  was working, no elapsed, and no way in. The two roles behind that row are now
  separated — recording widens to any child Thread, while only collaboration
  children can end a `wait_agent`, appear in its outcomes, or count toward
  "Waiting on N subagents".
- **A delegation tree can no longer outspend its grant (PR #455, codex)** — the
  subagent token budget is now conserved across a whole tree instead of handed
  out per child: the root-most spawning thread holds ONE pool, every descendant
  draws from it, and total subtree spend is bounded by the original grant by
  construction — closing the path where each generation re-inherited a fresh
  budget. Two structural limits join it as fixed host constants rather than
  settings: a collaboration child may not go deeper than `/root/a/b`, and one
  thread may spawn at most sixteen collaboration children over its lifetime
  (isolated skill children are exempt from both). Concurrent siblings read a
  live pool view — persisted usage plus every active turn's in-flight tally —
  so they can overrun only by one provider call each rather than each spending
  the full pool independently, and the native kernel now consults an
  authoritative `remaining` instead of subtracting snapshots, so a mid-turn
  switch between the pool and a child's own cap can neither kill a healthy turn
  nor silently disable the tighter limit. Budget failures cross the process seam
  as typed error codes and reach the user as localized resource-limit copy
  stating that results were preserved; token counts stay system-internal.
- **Subagent transcript account layer (PR #460, cc)** — every subagent thread
  now keeps a faithful, human-readable transcript the delegating parent can
  verify claims against: one canonical turn→text renderer behind two ports —
  an append-only artifact at `<userData>/subagent-transcripts/<threadId>.md`
  (extended once per completed child turn, never written into the workspace,
  reported via `transcriptPath` in terminal outcomes and readable with the
  existing file tools) and a stateless `bun run agent:dump` stdout projection
  for forensics on any thread in any state. Deletion drains in-flight appends
  and removes the artifact; a startup sweep reclaims orphans; all account
  work is best-effort (A12) and deadline-bounded so it can never cost the
  delegator its result.

- **Agent thread scroll follow (PR #458, codex-2)** — sending a message anchors
  it at the top of the transcript with runway below for the response to stream
  into; the transcript auto-follows only while the reader is at the bottom,
  scrolling up hands over control, and a "Jump to latest" pill returns to the
  newest content. Reading positions survive thread switches, window resizes,
  failed sends, tool-output disclosure loads, and long-thread virtualization
  without visible jumps.

- **Terminal-style path links in agent tool output (PR #453, codex-4)** — file
  paths inside tool arguments and results now behave like paths in a modern
  terminal: the block keeps its plain code styling, holding ⌘ (Ctrl) while
  hovering reveals the link affordance, ⌘-click opens the file preview in a
  new pane, plain click still selects text, and keyboard focus + Enter opens
  in the current pane. Relative paths in declared path fields resolve against
  the thread's working directory; the existing hover preview, right-click
  file menu, and tooltip keep working on these paths.

- **Pane reorder by dragging breadcrumbs (PR #452, cc)** — with several panes
  open, a pane's breadcrumbs become its drag handle ("Drag to reorder panes"):
  dragging shows a live arrangement preview — panes and divider hairlines slide
  to the order the drop would produce — and releasing commits it. Cancelling
  (Escape / drop outside) slides the preview back. The commit reaches the
  screen as CSS `order` over a stable pane DOM order, so embedded file previews
  (PDF/EPUB/URL) keep their scroll position and in-page state across a reorder,
  and pane content is pointer-shielded during the drag so previews cannot
  swallow it. Sizes, per-pane history, and the active pane are untouched; the
  agent-visible pane `order` renumbers to match.

- **Agent Full Access (PR #410, codex-2)** — the Main Agent, delegated Runs,
  Dream, and Skills now use one host-account filesystem model: typed file tools
  and Agent-launched processes execute directly with the current OS account.
  Explicit user blocks, scoped tool catalogs, native OS/provider authorization,
  and typed-tool correctness remain; folder acquisition, access-mode switching,
  process sandboxing, control-plane path isolation, and their renderer recovery
  UI are removed. **Gate (main):** iterative review closed retained folder-grant
  settlement, incomplete prompt propagation, stale configured-root recovery and
  specs, and file-search permission handling that could return empty success or
  misclassify regex errors. The final pass found no reportable issues. Verified
  with typecheck, 77 Agent local-tool tests, 917 renderer tests, 41 focused
  Settings/security E2E cases, `docs:check`, and diff check; a real 10.1 MiB Tana
  export completed inspect through API preview with zero unaccounted coverage.
- **Table view (PR #409, codex-3)** — Outline owners and saved searches can now
  switch persistently to a compact Table projection over the same child nodes,
  with a fixed Title column, ordered and resizable field columns, lazy atomic
  field materialization, ordinary node editors and interactions, filtering and
  sorting, read-only search results, independent nested Outline/Table scopes,
  keyboard grid navigation, row selection, and bounded row windowing. **Gate
  (main):** three review passes closed seven findings covering rapid input,
  direct Title entry, menu focus/dismissal, width projection precedence, search
  refresh ownership, and nested ARIA structure; the final pass found no
  reportable issues. Verified with typecheck, 103 focused Core tests, 921
  renderer tests, 15 Table E2E tests, light/dark runtime and visual QA,
  `docs:check`, merge-tree, and diff check; the full Core suite retained only the
  known cross-file OAuth mock isolation failure after 1,642 passes, while that
  test passes alone.
- **Persistent preview translation cache (PR #408, codex-4)** — webpage blocks,
  finite prerecorded captions, and reflowable EPUB passages now restore saved
  translations from a private, bounded main-owned cache keyed by source,
  translation configuration, and resolved model. Partial hits settle before
  provider misses, same-language no-ops use a source-free durable sentinel,
  unreliable caption identities remain uncached, and General Settings can clear
  saved translations without changing currently visible content. **Gate
  (main):** two review passes closed plaintext no-op persistence and unstable
  caption-track identity findings; the final pass found no reportable issues.
  Verified with typecheck, 44 focused Core tests, 911 renderer tests, the
  50,000-entry capacity probe, a restart no-op persistence reproduction, the
  real-Electron URL/EPUB restart-and-clear smoke, light/dark Settings visual QA,
  docs check, and diff check.
- **Event-sourced Issue persistence (PR #407, codex)** — Issues, Recurring
  Issues, Agent Sessions, Activity, execution bindings, stop intents, terminal
  deliveries, and schedule state now persist as versioned atomic JSONL operation
  batches with deterministic projections. Strict codecs reject invalid generated
  state before append, serialized expected-revision checks preserve concurrent
  mutation semantics, entity tombstones prevent stale resurrection, and only a
  malformed physical EOF record is repaired as a torn tail. **Gate (main):**
  three review passes closed descendant tombstone, generated-batch validation,
  malformed-tail classification, and cadence schema/codec findings; the final
  pass found no reportable issues. Verified with typecheck, 128 focused Core
  tests, 901 renderer tests, docs check, and diff check; the full Core suite
  reached 1654 pass and retained only the existing `pi-ai` OAuth export baseline
  error.
- **GitHub-managed skills (PR #406, codex-2)** — Settings now provides the
  complete lifecycle for Linlab catalog recommendations and compatible skills
  discovered from public GitHub repositories or tree URLs: review, install
  disabled, enable, update preview/apply, rollback, disable, and uninstall.
  Managed versions are validated, pinned to an immutable Git commit and
  whole-subtree hash, executed from an offline local copy, and constrained by
  the existing capability and control-plane boundaries. English/Chinese states
  cover discovery, compatibility, integrity, updates, and failures; optional
  Linlab skills are no longer bundled. **Gate (main):** four review passes
  closed index-restoration content deletion, typed/localized lifecycle error
  handling, path-depth GitHub request amplification, and longest-ref ambiguity.
  Verified with typecheck, 139 focused Core/renderer tests, docs check, and diff
  check.
- **Agent ledger portability (PR #405, codex)** — private Agent conversation and
  Run history now exposes deterministic versioned portable catalogs and stream
  reads with an explicit event and payload allow-list. A workspace deletion
  ledger records conversation and Run tombstones before physical cleanup, and
  tombstone precedence now covers reads, appends, payload/checkpoint/meta writes,
  catalogs, retention, reset, and derived-index rebuilds. Retention resumes after
  partial failures, while conversation/search indexes bind content to the exact
  deletion-ledger watermark captured before scanning. **Gate (main):** three
  review passes closed capability-notification path leakage, top-level Run
  resurrection, non-retryable retention, stale restored indexes, and a concurrent
  rebuild race that could label pre-tombstone content with the latest watermark.
  Verified with typecheck, 104 focused Core tests, docs check, and diff check.
- **Agent capability permissions (PR #401, codex-3)** — replaced action-risk
  confirmations and safety modes with an ownership-based contract: existing
  resources execute immediately, missing external folders acquire persistent
  capabilities, and explicit blocks or Tenon control-plane access are terminal
  unavailable results. File tools and every Agent-launched process now share an
  immutable capability snapshot; macOS keeps private `userData` inaccessible
  even under Home or filesystem-root grants, while revocation rejects stale
  starts and terminates affected processes. Scoped Runs remove tools before the
  model starts, web fetches use credential-free sessions, and Security Settings
  expose folder access, user blocks, and the system boundary. **Gate (main):**
  two review passes closed stale-checkpoint restore, snapshot-less helper probe,
  and high-offset `file_grep` pagination defects. Verified on the latest-`main`
  merge with typecheck, 212 focused Core tests, 895 renderer tests, docs check,
  and diff check.
- **EPUB bilingual translation (PR #403, codex-4)** — reflowable EPUB file
  panels and dedicated readers now use the shared target language, translation
  model, status control, shortcut, paragraph-local retry, viewport-first
  scheduling, and bounded predictive prefetch. Local-book automatic translation
  remains a separate opt-in from website consent; valid translations survive
  lazy section remounts while stale, removed, or target-language records are
  rejected. Asset and trusted-local EPUB packages now load through opaque,
  range-capable preview tokens up to a 128 MiB compressed-package limit.
  **Gate (main):** two review rounds closed configuration-latch and completion
  reconciliation defects. Verified with typecheck, 66 focused and 891 full
  renderer tests, focused Core and asset/preview suites, four EPUB E2E cases,
  the real-Electron stream smoke, docs check, and diff check.
- **Asset content integrity (PR #404, codex)** — every Outliner asset sidecar is
  now schema-versioned with exact byte length and lowercase SHA-256 across
  buffer ingest, path ingest, and generated PDF thumbnails. Stable logical
  asset ids remain separate from content hashes; `readVerified()` rejects
  malformed metadata and byte corruption while local range serving remains
  streaming. Path assets hash the final stored file as a stream, and in-memory
  hashing yields between bounded 1 MiB turns to keep Electron main responsive.
  An Electron-run latency probe records throughput and maximum event-loop stall.
  **Gate (main):** four review passes closed synchronous main-thread hashing, the
  probe's initial Bun runtime mismatch, and a swallowed probe failure exit code;
  the final pass found no reportable issues. Verified with typecheck, focused
  asset/hash and Agent local-tool tests, 838 renderer tests, Electron probe
  success/failure paths, docs check, and diff check.
- **Replica-safe workspace persistence (PR #402, codex)** — Tenon now stores a
  stable private installation identity alongside an atomic v3 workspace
  envelope that separates portable shared document state from local replica
  state. Every Core session uses a fresh Loro peer, causally pending updates
  survive reload, and provider-neutral snapshot, version-vector, incremental
  export, batch import, and committed-local-update primitives distinguish
  accepted operations, persistence changes, and visible revision changes.
  Replication APIs reject explicit transactions and yielded standalone async
  mutations so a later rollback cannot publish abandoned data. **Gate (main):**
  the first review found and codex fixed the rollback export leak; the final pass
  found no reportable issues. Verified with typecheck, 241 focused Core tests,
  838 renderer tests, docs check, and diff check; the full Core suite reached
  1558 pass and retained only the existing external Presentation skill failures.
- **URL video bilingual subtitles (PR #399, codex-4)** — URL Preview translation
  now includes prerecorded standards-based and YouTube captions in the existing
  language, model, shortcut, automatic-translation, and three-request session.
  Original captions stay visible while bounded playback-window batches add
  translated lines; seeking, track changes, ads, disable/re-enable, stale loads,
  and inaccessible or same-target captions preserve page and player state.
  Timed-text origins and response sizes remain bounded inside the sandboxed guest,
  and model output is inserted only as text. **Gate (main):** two review rounds
  closed all reported lifecycle, cue-layout, design-system, and specification
  consistency findings; the final pass found no reportable issues. Verified with
  typecheck, 45 focused guest tests, 829 renderer tests, 27 focused Core/security
  tests, raw-colour and diff guards, and a latest-`main` synthetic merge with 838
  renderer tests.
- **Semantic ingest parity (PR #397, codex-2)** — agent-created normal nodes and
  plain, Markdown, and HTML paste now share one bounded semantic scanner for
  tags, fields, references, bare URLs, canonical escapes, and rich-text offset
  remapping. Code spans, links, saved-search operands, and grammar-shaped literal
  text remain protected, while reversible serialization preserves nested,
  overlapping, and crossing marks through read/edit round trips. Structured
  paste now also stays unchanged while pending and after a rejected Core command.
  **Gate (main):** iterative full-diff review closed all reported correctness,
  round-trip, and parser-complexity findings; the final pass found no reportable
  issues. Verified with typecheck, 757 renderer tests, 11 paste E2E tests,
  linear-time stress probes, and a latest-`main` synthetic merge running 283
  focused Core and 28 renderer tests. Full Core reached 1488 pass / 3 fail, all
  from external Presentation skill resource drift.
- **Persistent URL preview sessions (PR #400, codex-3)** — URL Preview panes now
  share one Tenon-owned persistent website profile across panes and relaunches,
  while remote guests remain sandboxed, Node-free, preload-free, HTTP(S)-only,
  and pinned to the same partition. Safe GET new-window requests stay in the
  requesting Preview without creating a child window; Settings can clear only
  Preview cookies, cache, auth, and site storage through a native confirmation,
  and quit now flushes DOM storage and cookies inside the bounded drain. Future
  Browser Control plans now attach to visible Tenon Preview guests instead of an
  external browser profile. **Gate (main):** deep review covering the session,
  permission, navigation, and IPC boundaries found no reportable issues.
  Verified with typecheck, focused Core/security tests, 795 renderer tests,
  production build, real Electron smoke, light/dark visual QA, docs check, and
  diff check.
- **URL preview bilingual translation (PR #396, codex-4)** — URL previews now
  support opt-in bilingual reading with target/model preferences, automatic
  activation from valid page-language metadata, a scoped shortcut, and
  viewport-prioritized concurrent translation batches. Paragraph-local loading,
  retry, and in-memory cache state preserve reading flow, while isolated-world
  collection, main-side request bounds, sensitive-region exclusion, inert text
  insertion, stale-source ids, and user-scroll-aware anchor correction preserve
  the URL preview's privacy and sandbox boundaries. **Gate (main):** three review
  rounds closed all five initial findings and the native-scrollbar follow-up.
  Verified with typecheck, 18 focused Core/security tests, 15 guest tests, 786
  renderer tests, production build, real Electron smoke, docs check, and diff
  check.
- **Agent Issue execution preflight (PR #398, codex)** — active Issue
  definitions now validate their node inputs and outputs before execution,
  Session starts resolve dynamic inputs and symbolic Daily Note destinations
  into revision-bound snapshots, and creation outputs grant only exact
  direct-child insertion authority. Invalid or broadened prepared scopes now
  create one visible terminal error Session instead of retrying indefinitely;
  node tools also reject stale Trash destinations and implicit Schema writes
  before partial mutation. **Gate (main):** two review rounds found and fixed
  all reported preparation-boundary issues, including the dynamic tag-query
  preview-gate follow-up. Verified with typecheck, 87 focused Core tests, docs
  check, and diff check; the full Core suite reached 1452 pass / 3 fail, with
  all three failures coming from external Presentation skill resource drift.
- **Field value nodes support ordinary children (PR #394, codex-3)** — stored
  field values now disclose and contain ordinary child rows while their direct
  values remain bounded by the owning field entry. Direct values retain
  field-aware cleanup, deeper descendants use ordinary node commands, reference
  values preserve target projection and cycle guards, and stored checkbox values
  retain native activation plus the shared row keyboard contract. Arrow and Tab
  navigation now follows the panel's visible selectable order without revealing
  hidden value drafts. **Gate (main):** review found four correctness issues;
  codex-3 fixed all four before merge. Verified with typecheck, 747 renderer
  tests, focused Playwright coverage, docs check, and diff check; one unrelated
  background-command timing assertion in the broader outliner run reproduces on
  the merge-base.
- **Node tool context compression (PR #392, codex-2)** — successful
  model-visible `node_*` projections now omit redundant input echoes, static
  instructions, and uninformative envelope fields while retaining the complete
  runtime result in `details`; reads and searches use annotated outlines as the
  single id/title projection instead of parallel references. `node_search` also
  supports 1-20 named count queries with an optional shared condition, validates
  every query's grammar and
  semantic operands before acquiring execution hooks, applies run-scope
  filtering, and returns one compact count map. **Gate (main):** review found
  and codex-2 fixed three issues covering runtime pagination guidance,
  self-contained `node_create` output guidance under strict `allowedTools`, and
  semantic batch preflight. Verified with typecheck, 154 focused tests, 746
  renderer tests, docs check, and diff check; the full Core suite's three
  failures reproduce on the pre-PR baseline and come from external Presentation
  skill resource drift.
- **Agent Issue Manager (PR #386, codex-4)** — replaced scheduled command-node
  and Run-centered work with durable Issues, Recurring Issues, Agent Sessions,
  and Activity. The implementation adds recurring materialization, scoped
  input/output snapshots, verification Sessions, crash-safe hierarchical result
  delivery, eight model-facing Issue/Session tools, Issue-first Work views, and
  linked terminal status rows in chat; direct Run tools and command-node
  scheduling are retired. **Gate (main):** deep review found and codex-4 fixed
  17 authorization, recovery, validation, continuation, UI race, accessibility,
  transcript, and rebase-integration issues before merge, including writable
  scope enforcement for definition mutations. Verified with typecheck, full
  renderer tests, targeted Core and Playwright suites, light/dark visual QA,
  docs check, diff check, and a clean merge-tree.
- **CC Switch provider registry (PR #389, codex-3)** — replaced the CC Switch
  Codex-file mirror with read-only discovery from `~/.cc-switch/cc-switch.db`.
  Tenon now exposes direct-runnable Codex Responses sources as source-scoped
  models under one CC Switch provider group, resolves the matching registry API
  key at request time without storing or revealing it, and reports proxy-required,
  unsupported, and not-detected CC Switch states in Settings.
- **Definition node edit parity (PR #388, codex-3)** — agent `node_read` now
  projects editable tag and field definition config from parent definition
  nodes; `node_create.definition` creates tag and field definitions with typed
  initial config; and `node_edit` supports `configure_definition`,
  `reuse_field_definition`, and `merge_definition`. Field type changes validate
  existing values and report incompatible value ids, definition merge rewrites
  field/tag uses plus saved-search, view, config, reference-node, and rich-text
  inline references, and ordinary content merge is no longer used for definition
  nodes.
- **Agent image generation tool (PR #383, codex-2)** — added the
  `generate_image` agent tool for provider-backed raster image generation and
  edits. The tool supports OpenAI and Gemini image models through the existing
  provider credential path, validates provider-specific options before dispatch,
  stores generated images as app-owned scratch artifacts, renders image previews
  in the transcript, and persists only slim render metadata for replay. Settings
  now exposes a default image model selector and provider capability summaries
  include image-generation models.
- **Feed-processing built-in skill (PR #387, codex-3)** — enabled the
  `feed-processing` skill from `linlab-skills` as a default resource-backed
  built-in. Development runs now load it from the sibling linlab checkout, and
  packaged builds stage it into `Resources/built-in-skills` alongside the other
  linlab artifact skills. The agent skills spec documents `/feed-processing` as
  a sink-neutral feed-content pack workflow.
- **Agent Issue Manager plan (PR #384, codex-4)** — added the active P1
  implementation plan for replacing scheduled command / Run-centered work with
  the Agent Issue Manager model: Issues and sub-issues for durable work,
  Recurring Issues for cadence, Agent Sessions for execution, Activity for
  progress/audit, and UI Views as filters over those objects. The ratified build
  shape is one complete implementation PR by PM decision, with no migration or
  back-compat reader because the product is pre-release. The plan also pins the
  runtime-owned authorization boundary, protected Dream compatibility boundary,
  due-time recurring materialization rule, Neva-only run profile `AgentRef`, and
  eight-tool model-facing surface.
- **Channel create and inline rename (PR #382, codex-3)** — New Channel now
  creates an untitled Channel immediately, selects it, and focuses the composer.
  Runtime creation no longer accepts a seed/opening message, ordinary Channel
  rows expose a direct inline rename edit icon instead of a More menu, protected
  General/Dream Channels hide rename controls, and blank create/rename stores
  the existing Untitled sentinel. Specs, i18n, runtime tests, renderer tests,
  and E2E coverage now match the inline create/rename contract. **Gate (main):**
  codex-3 fixed the Channel config e2e/stale seed CSS and design-system spec
  review items; main added the board entry needed for `docs:check`. Verified
  with typecheck, targeted core/renderer tests, docs check, diff check, and
  targeted agent-composer, agent-settings, design-system runtime, and typography
  E2E coverage.
- **Agent tool naming clarity (PR #381, codex-3)** — renamed the model-visible
  bash background stop tool from `task_stop` to `bash_stop`, renamed the
  outliner undo/redo/list tool from `operation_history` to
  `outline_undo_stack`, and renamed the permission action kind from `task.stop`
  to `shell.stop`. Specs, permission descriptors, schemas, renderer summaries
  and icons, i18n strings, and tests now use the clearer names, and the agent
  tool spec tables now include the implemented `file_delete` tool. **Gate
  (main):** review found one stale cc-2.1 source-anchor path; codex-3 restored
  the real `TaskStopTool` path before merge. Verified with typecheck,
  docs check, diff check, targeted local-tool/node-tool/permission/renderer
  tests, and the full renderer suite. Full `test:core` remains red on the
  current `main` baseline for unrelated external `data-analysis` skill text
  assertions.
- **Reference summary hot-path cleanup (PR #380, codex-3)** — precomputes Trash
  descendant sets for renderer/system-field reference summaries and carries a
  deleted-node id set in the search index, so full reference-summary/search
  scans use set membership instead of repeated parent-chain walks. Node and File
  preview panels also skip building recursive fallback row models on the default
  flat outliner path. **Gate (main):** code review found no reportable findings.
  Verified with typecheck, targeted search/reference/system-field/row tests,
  renderer tests, docs check, focused outliner/backlinks E2E coverage, and
  light/dark NodePanel smoke. Full `test:core` was run but remains red on the
  current `main` baseline for unrelated `agentSkills.test.ts` assertions against
  external `linlab-skills/data-analysis` wording.
- **Design-system calibration audit and guards (PR #377, codex)** — calibrated
  the layered design-system contract into executable metrics and runtime guard
  rails: calibration audit rows, component/source-map drift checks, raw-colour
  ownership, retired legacy alias detection, cursor/typography token scans,
  runtime surface E2E coverage, and shared keyboard ownership for every JSX
  `role="menu"` surface. Renderer CSS drift was tightened around neutral
  states, materials, cursors, text tiers, and token ownership; dark
  `--text-tertiary` now lifts centrally; and rejected tag-colour config patches
  no longer dirty serialized document state. **Gate (main):** code review found
  two issues around invalid config writes and an over-escaped alias regex; codex
  fixed both before merge. Verified with typecheck, core/renderer suites,
  targeted menu/alias/config regressions, design-system runtime/cursor/
  typography E2E coverage, docs check, design-system metrics, and
  `git diff --check`.
- **Ask user question stepper (PR #376, codex-4)** — multi-question
  `ask_user_question` requests now render as a one-question-at-a-time composer
  stepper instead of a stacked form. Back/Next navigation preserves rich answer
  drafts, validation is scoped to the active question, final submission keeps the
  existing structured result shape, and `Discuss first` remains a whole-request
  escape hatch. **Gate (main):** code review found no reportable findings.
  Verified with typecheck, renderer tests, targeted stepper/discuss e2e coverage,
  docs check, and `git diff --check`.
- **Data import CLI/API boundary (PR #375, codex-4)** — moves bulk import from
  the default model-visible `data_import` tool to a Tenon-owned Import Pack
  CLI/API workflow. `/data-cleanup` now runs `tenon-import` for inspect,
  conversion, validation, preview, and commit; preview/commit use a local
  main-process import API backed by the shared import service, so final writes
  keep one undo/history entry, search-index refresh, verification, and
  single-use preview ids inside the app. Packaged builds now include the CLI
  wrapper and generated Node bundle, and ordinary agent runs no longer expose
  `data_import` by default. **Gate (main):** code review found no reportable
  findings. Verified with targeted import-service/API/permission/skill/CLI
  tests, typecheck, docs check, generated CLI smoke, `app:build`, packaged
  resource checks, packaged CLI runtime smoke, and `codesign --verify --deep
  --strict`.
- **Bundled ripgrep provider for local agent search (PR #374, codex-4)** —
  ships ripgrep 15.1.0 as a packaged Tenon resource so `file_grep`,
  `file_glob`'s fast path, main local filename search, and agent Bash `rg`
  discovery no longer depend on the user's shell `PATH`. The provider resolves
  `LIN_AGENT_RIPGREP_COMMAND`, bundled resources, then system `rg` as a dev
  fallback; Bash PATH appends the bundled binary after user/system paths so it
  does not shadow an installed `rg`. Recovery guidance now treats
  `ripgrep_unavailable` as a packaging/runtime issue instead of telling the
  agent to install ripgrep. **Gate (main):** code review found no reportable
  findings. Verified with targeted ripgrep/local-tool tests, typecheck,
  `docs:check`, full `test:core`, `app:build`, packaged resource/version
  inspection, and `codesign --verify --deep --strict`.
- **Local tool output responsiveness and process-tree cleanup (PR #373,
  codex-4)** — `file_grep` now streams ripgrep output and applies pagination
  while reading, so large result sets and high offsets no longer depend on a
  capped stdout buffer. `bash` now captures stdout/stderr through bounded
  file-first streams, persists large foreground output with compact previews,
  and enforces foreground/background output watchdogs. Timeout, cancellation,
  `task_stop`, and watchdog termination now stop the shell process tree, and
  bash completion waits for stdio `close` so no-wait descendants that inherit
  output remain blocked or stoppable instead of being misreported as completed.
  **Gate (main):** deep review found the first-round `exit`-based completion
  could leave descendants running while tasks were marked complete; codex-4
  fixed it before merge. Verified with manual foreground/background descendant
  reproductions, typecheck, `test:core`, targeted local-tool tests,
  `docs:check`, and `git diff --check`.
- **Data import performance and cooperative scheduling (PR #371, codex-4)** —
  materializes imported descriptions directly through `create_nodes_from_tree`,
  caches tag/field definition lookup during bulk tree writes, and adds
  yield-aware chunking for node creation, Loro commits, and search-index refresh.
  Large Import Pack writes now avoid one command per description while remaining
  one logical agent undo / operation-history entry. **Gate (main):** code review
  found one operation-history regression in chunked undo metadata; codex-4 fixed
  it before merge. Verified with focused operation-history reproduction, the
  chunked materialization core test, typecheck, targeted core suites,
  `docs:check`, and `git diff --check`.
- **Run graph cleanup implementation (PR #365, codex-3)** — completed the
  Run-centered execution cleanup: durable Run metadata/result submission now drive
  Work/Runs, detail drawers, verifier evidence, restored runtime state, and
  terminal notifications; legacy `agent_child_run_*` IPC and conversation
  `child_run.*` lifecycle events are gone from the active path; and the
  model-facing delegation tool is now `spawn_run`. The Work/Runs UI now uses one
  Run list plus read-only detail drawers with Run-index breadcrumbs, per-Run
  ledger transcripts, direct sub-run drill-in, stored drawer height, neutral row
  affordances, and shared status markers. **Gate (main):** adversarial review
  found a stale e2e selector and two spec drift issues; codex-3 fixed all before
  merge. Verified with typecheck, docs check, diff check, core/renderer suites,
  and focused Work/Runs e2e coverage.
- **Data cleanup import workflow (PR #370, codex-4)** — added `/data-cleanup`
  as a resource-backed built-in skill plus Import Pack v1 validation, preview,
  and `data_import` staging writes. Tana exports now have a deterministic
  cleanup route with coverage accounting, dry-run preview confirmation,
  staging-root materialization, and post-import verification; Roam EDN is
  profiled only in this release. **Gate (main):** code review found one
  permission-registration blocker for `data_import`; codex-4 fixed it before
  merge. Verified with targeted permission tests plus the PR's typecheck,
  docs-check, import-tool/script suites, real Tana-export import evidence, and
  `git diff --check`.
- **CC Switch Codex mirror provider (PR #369, codex-2)** — added CC
  Switch Local Gateway as an externally configured provider that mirrors Codex
  credentials and generated model catalog support from `~/.codex/config.toml` /
  `~/.codex/auth.json`, with Local Proxy fallback. Provider settings now use
  Configured / Add Providers grouping, explicit enable/disable state for
  configured and external rows, disabled-provider filtering from model pickers
  and runtime fallback, masked saved keys, and no show/copy path for externally
  managed secrets. The merge also preserves custom OpenAI-compatible model
  metadata so CC Switch/catalog-backed endpoints route through Responses or Chat
  Completions correctly. **Gate (main):** code review found two P2 issues around
  raw-key IPC exposure and runtime provider validation; codex-2 fixed both before
  merge. Verified with typecheck, targeted provider/runtime/renderer suites,
  provider settings E2E, `docs:check`, and `git diff --check`.
- **Design-system compression metrics (PR #368, codex)** — added
  `docs/spec/design-system/decision-audit.md` and
  `scripts/design-system-metrics.ts` so the layered design-system contract now
  has measurable checks for surface compression, decision derivation, component
  coverage, exception evidence, renderer-wide raw-hex discipline, and
  documented-component drift. The PR compresses `surfaces.md` into a thinner
  surface model, promotes reusable rules into components and patterns, tokenizes
  tag color presets through identity tint tokens, and pins the provider-ready
  agent blank state to executable onboarding E2E coverage. **Gate (main):**
  deep review found audit/spec and metrics false-negative issues; codex fixed
  all findings before merge. Verified with the metrics gate, docs check,
  typecheck, focused typography-token and agent-onboarding E2E specs, and
  `git diff --check`.
- **Layered design-system contract (PR #367, codex)** — refactored
  `docs/spec/design-system.md` into a kernel/index with layered contracts for
  foundations, components, patterns, surfaces, and implementation. `docs:check`
  now validates local spec Markdown links and heading anchors, and the typography
  guard scans CSS examples across the split design-system spec tree. The merge
  also tokenized related CSS drift around control-on state, link hover, danger
  solid hover, vertical resize cursors, shared material backdrop use, and the
  agent composer profile model shortcut. **Gate (main):** code review found no
  reportable issues; verified with docs/typecheck/design-system guard and focused
  composer E2E coverage.
- **Expanded packaged linlab artifact skills** — packaged builds now stage
  `/data-analysis`, `/document`, `/pdf`, `/presentation`, and `/spreadsheet`
  from the sibling `linlab-skills` checkout into `Resources/built-in-skills`.
  Development runs load the same enabled linlab roots directly, so spreadsheet
  workbook workflows and PDF-native inspection/render/OCR/form/redaction routes
  are available as immutable built-ins alongside the existing analysis,
  document, and presentation skills.
- **Agent run graph cleanup plan (PR #364, codex-3)** — adds an active design
  plan for moving agent execution to one event-sourced Run graph: sub-runs are
  Runs with `parentRunId`; verifier/background/task/delegation concepts become
  policies, metadata, or projections; specialization moves to `runProfile`
  rather than extra agent identities. The plan defines the RunMeta clean-cut,
  Run-profile registry, storage sentinel requirements, durable notification
  bookkeeping boundary, verifier evidence packs, Run detail API, renderer
  projection migration, and Run-centered tool/IPC vocabulary. **Gate (main):**
  deep document review found missing storage-layout bump requirements, dropped
  persisted Run-index contracts, and an over-broad conversation-ledger cleanup
  that would have removed restart-safe notification attention bookkeeping;
  codex-3 fixed all before merge. Verified with `docs:check`, `typecheck`, and
  `git diff --check`.
- **Browser and computer control implementation plans (PR #361, codex)** — adds
  active design plans for Tenon-native Browser Control and Computer Control
  agent tool families. Browser Control maps the useful `browser-pilot` surface
  into first-party CDP-backed tools, model-visible screenshot/payload handling,
  network inspection/interception, and a resource-backed `browser-control`
  built-in skill while keeping download management outside the parity track.
  Computer Control maps the useful `computer-pilot` / `cu` surface into
  main-process macOS desktop tools, strict `execFile` helper invocation,
  app-targeted method audit / verification semantics, payload-backed visual
  results, and a resource-backed `computer-control` built-in skill. **Gate
  (main):** deep document review against both reference projects found stale
  built-in-skill packaging wording, an incorrect `cu` paste method name, and
  missing `bp net --after` coverage; codex fixed all before merge. Main recorded
  the active plans on the board.
- **Shared linlab skills as packaged built-ins (PR #359, codex-3)** — `/presentation`, `/document`,
  and `/data-analysis` now come from enabled `linlab-skills` directories instead of being forked inside
  Tenon's `src/main/builtInSkills`. Development runs load the shared skill roots directly from the sibling
  `linlab-skills` checkout or `LINLAB_SKILLS_ROOT`; packaged builds run `bun run skills:sync` to stage
  Tenon-owned and enabled linlab skills into `build/generated/built-in-skills`, which Electron then ships
  as app resources. The sync path copies only git-tracked external files and excludes non-runtime folders
  such as `evals`, keeping ignored local outputs out of the bundle. Skill docs and prompts now keep
  explicit PPTX/DOCX/data-analysis dependency-backed routes on their intended tools instead of silently
  falling back to lower-fidelity approximations. **Gate (main):** code review found path-resolution,
  generated-resource hygiene, and test-portability issues; codex-3 fixed them before merge. The dependent
  `relixiaobo/linlab-skills#1` was merged first. Verified with typecheck, targeted core skill/prompt/helper
  suites using a clean `LINLAB_SKILLS_ROOT`, and `docs:check`.
- **Agent outline edits behave more like user outline edits (PR #353, codex-3)** — agent node tools
  now steer ordinary structure into child bullets rather than overusing descriptions, fields, tags,
  checkboxes, or saved searches. `node_edit` has an explicit operation discriminator, guards against
  whole-outline replacement attempts, and returns fresh revision information for model-visible retries.
  Agent-created and agent-edited outline markdown preserves rich-text marks and fenced `codeBlock` rows
  through shared core parsers, and user-view context includes selected rows so the agent can act on the
  same visible selection users rely on. **Gate (main):** deep review found two issues; codex-3 resolved
  both before merge. Verified with targeted parser/node-tool/user-context/runtime tests, typecheck,
  `docs:check`, and `git diff --check`.
- **Clear model context with `/clear` (PR #352, codex-4)** — `/clear` now appends a persisted
  `context.cleared` boundary in the current Channel, renders it as a dedicated `Context cleared.`
  transcript row, and starts subsequent automatic model context from that boundary without generating
  a compact summary. Pre-clear messages stay visible in transcript history and remain searchable/readable
  through explicit `past_chats` access, while `/compact` remains the summary-preserving continuation
  path. The runtime resets conversation-scoped model-context caches across the boundary, and checkpoint /
  recent-chat regression tests cover the new replay state and synthetic-root filtering. **Gate (main):**
  deep review found two integration bugs; both were fixed before merge. Verified with typecheck, targeted
  core/renderer suites, `docs:check`, and `git diff --check`.
- **Preview-first links and HTML renderer (PR #345, codex)** — ordinary `http(s)` links from the
  outliner, agent transcript, and local preview bodies now open in a Tenon split preview pane by default.
  URL previews render as a hardened `webview` with an http(s)-only source, fixed partition, denied
  popups/permissions, stripped preload/webpreferences, and an explicit "open original" escape hatch.
  Local-file, asset, and agent-payload previews gain Range-capable `preview-local://` streams for large
  media so audio/video can seek without whole-file reads; local `.html`/`.htm` files render as sandboxed
  static iframes with host-side link interception and no script execution. **Gate (main):** deep review
  found one P2 iframe-realm link-routing bug; round-2 fix resolved it with a cross-realm regression test.
  Verified with typecheck, relevant core/renderer targeted suites, full `test:renderer` before the final
  iframe fix, post-fix targeted regression, `docs:check`, and `git diff --check`.
- **Ask before reaching outside the handed file area (PR #349, codex-4)** — typed file tools
  (`file_read`/`file_glob`/`file_grep`/`file_edit`/`file_write`/`file_delete`) that target a **non-sensitive
  path outside the handed file area** now stop for an explicit approval (`ask`) **before** the tool runs,
  instead of being default-allowed by the permission layer and then rejected by the file-tool containment
  check (the old failure surfaced as a confusing `path_outside_local_root` tool interruption). **Allow once**
  projects that exact `Scope(read:/path)` / `Scope(write:/path)` into the **current run's** file-tool roots —
  run-scoped, so it covers later calls within the same run but never leaks across runs — and **Always allow**
  also persists the grant. Isolated read-only skill runs, including `/research`, inherit the flow and can
  continue external-folder analysis after the parent conversation approves the scope. Bash keeps its existing
  floor-blocklist posture (the gate uses the canonical `toolPathArgumentName()` predicate, which excludes
  bash), and outside **sensitive** credential reads still default-allow per the #279 silent-allow posture.
  **Gate (main):** `/code-review xhigh` — no correctness crash bugs; all six review findings resolved across
  two rounds, rebased onto current `main`; a post-merge fast-track deduped a local rule-value helper onto the
  shared `grantRuleValue`. typecheck + `test:core` (1102 pass) + `docs:check` green.
  scrolls as **one continuous vertical reader** that stacks every spine section (covers and `linear="no"`
  note pages included, so every table-of-contents and in-text anchor resolves) like PDF pages, replacing
  the wheel-driven section jumps from #339. Sections **mount lazily** as they near the viewport
  (IntersectionObserver, mount-once) so opening a long book never spins up every section's document at
  once. A **shared document outline rail** for both PDF and EPUB shows fixed-gap chapter markers with a
  hover/focus popover that jumps to the resolved scroll position, and **reader positions persist per
  preview identity** — PDFs restore page + page-relative offset, EPUBs restore spine section +
  section-relative offset. Preview geometry is aligned to the concentric radius chain with a soft
  inset-hairline edge in place of the heavier double border. **Gate (main):** code review across 8 finder
  angles → a round-2 fix resolved every correctness/efficiency finding (dropped non-linear sections,
  reading-position restore drift, content-height under-measurement, mount-everything-at-once, viewport-unit
  CSS keyed off the window, double document setup, fragile `offsetTop` scroll math, mislabeled outline
  entries); residual polish (bound `vh` to the reader viewport, dedupe the section scroll-top math) landed
  in the merge — typecheck clean + EPUB e2e (continuous scroll + lazy mounting) green on `811fc08b`.
- **Verified goal runs (PR #343, codex)** — Neva can take a long-running **objective** and pursue it
  **autonomously until independently verified**, modeled as a self-similar **tree of Runs** with no new
  stored objects: a persistent **controller Run** carries the durable intent, ephemeral **worker Runs** are
  re-spawned on failure, and completion is **sensed, never self-declared** — each child only terminates and
  its parent verifies the result with a fresh read-only `context:'none'` **verifier Run** against fixed
  acceptance criteria (the root verified by Neva). Runs gain `objective` / `criteria` / `scope` / `budget` /
  persistent `disposition` and a second `objectiveStatus` axis (`active` / `verifying` / `verified` /
  `blocked` / `budget_exhausted` / `stopped`) alongside the existing execution status; run `kind` is now
  **derived** from provenance/lineage rather than stored (agent storage layout **v5** — pre-release dev
  `userData` is wiped, no migration). The delegation tools become **`spawn`** + `run_status` /
  `run_steer` (soft steer) / `run_amend` (hard amend, invalidates prior verdicts) / `run_stop`, with the old
  `Agent`/`AgentStatus`/`AgentSend`/`AgentStop` names kept as aliases; `criteria` is required unless
  `verify:false`, capability scope reuses the `AgentToolActionKind` taxonomy (never widened in place), and
  each spawn passes local **budget admission** (token + wall-clock) with livelock and retry guards. The old
  task panel is replaced by a compact **Work/Runs** tree — parent runs show child-run progress, children
  expand inline, and run detail is a drill-in within the same dock. **Gate (main):** `/code-review xhigh`
  (10 finder angles) → a round-2 fix resolved **all 15 findings** (verifier wall-clock/scope admission,
  stuck-`verifying`, verifier-infra-error-as-fail, budget-ledger leaks on stop/amend/harness-throw,
  `setTimeout` overflow, misleading "completed" notification, sub-run Stop gating, blocked-run sort order,
  details-disclosure control, `listRuns` per-event I/O, working-set hashing) — re-verified resolved with
  typecheck clean and `agentRuntimeChildRuns` 29/0 on `af3e96db`.
- **EPUB file preview (PR #339, codex-3)** — `.epub` attachments and local files now render in an inline
  `foliate-js` reader instead of the metadata fallback. Summary previews the first section; the expanded
  reader advances through scrolled sections + spine items via wheel/trackpad. Book bytes load only through
  the capped `preview_read_bytes` API. EPUB sections render in `blob:` iframes, so the renderer CSP is
  widened to `frame-src blob:` while **packaged `script-src 'self'` stays strict** — the blob iframe
  inherits it, so scripted EPUB content is CSP-blocked (foliate renders via same-origin parent DOM
  manipulation, not in-iframe scripts), and the content iframe is additionally sandboxed without
  top-navigation/popups/forms. Dev CSP admits only Vite's hashed React-refresh preamble and widens
  `connect-src` for HMR. Remote in-book links route through the http(s)-only external-open gate. MIME
  sniffing keeps magic-byte precedence so a renamed PDF/PNG can't masquerade as EPUB, and a generic `.zip`
  stays metadata-only. Adds `foliate-js`. **Gate (main):** code + manual security review (CSP inheritance +
  iframe sandbox + external-link gate verified against foliate's iframe model); typecheck + build +
  `test:core` 1062 + `test:renderer` 617 + EPUB e2e (inline reader, capped bytes, wheel section-advance)
  green on `59c9afa5`. Packaged-CSP runtime smoke left as a confirmatory follow-up.

- **Dream date-window scheduling + derived cursor (PR #328, codex-2)** — the second PR of
  `dream-channel-and-memory-retire`. Memory Dream's scope moves from the opaque seq-watermark to
  user-legible **local-day date windows**. The "last dreamed through" cursor and `lastSuccessAt` are now
  **derived** from the protected Dream channel's clean completed `dream.finished.window` markers (no
  stored dream-state read), and a date window is translated to a **timestamp-clamped** source span — the
  seq lower bound is the stream floor and the `createdAt` clamp is the authority, so out-of-order or
  day-straddling seqs cannot pull an out-of-window message in. Dream writes memory to the **source-date**
  daily node, so a multi-day catch-up files each day's findings under that day's `#d-memory` container.
  Scheduled runs cover **complete days only** (`[cursor+1 .. yesterday]`) at the user-configurable
  `agent.runtime.dreamSchedule` fixed local time, with a **fixed-time + 3-retries-per-due** cap replacing
  the at-most-once gate; a clean manual run suppresses the scheduled Dream for already-covered days. The
  in-channel **structured Dream launcher** (start/end date pickers + guidance → serialized anchor)
  replaces the chat composer on the Dream channel; the `#319` incomplete-gate is preserved. Adds the
  `window?:{start,end}` field to `dream.finished` together with its first reader/writer (the PR1
  deviation), and a `fromCreatedAtInclusive`/`throughCreatedAtExclusive` clamp on chat-source references
  threaded through markup/loro/pmSchema/editor/tool layers. **Gate (main):** `/code-review xhigh` — 8
  findings fixed + re-verified (`274a5670`): scheduled window ends at *yesterday* (no same-day lockout
  permanently skipping the day still in progress), manual default window clamps instead of throwing (so
  Settings "Run Dream now" stays valid once the cursor reaches today), manual end date clamped to today
  (no future-cursor scheduler stall), redundant seq lower-bound dropped in favor of the timestamp clamp,
  symmetric clamp validation + tilde-escaping across all reference codecs, pmSchema clamp round-trip, and
  the manual-suppression test isolated from the retry-cap path. typecheck clean; affected `test:core` +
  `test:renderer` suites green. Specs synced: `agent-skills`, `agent-progress`,
  `agent-event-log-rendering`; plan updated.

- **Protected Dream channel — Memory Dream runs as a transparent top-level turn (PR #324, codex-2)** —
  the first PR of `dream-channel-and-memory-retire`. Memory Dream no longer runs as a hidden
  create→delete child conversation; it runs as a top-level **unattended reflective turn** inside a new
  persistent, protected **Dream** channel (`lin-agent-channel-dream`), so each run's full process is
  durable audit history. The Dream channel has an immutable title, cannot be renamed/deleted, and rejects
  ordinary chat messages; General and Dream now share one table-driven `PROTECTED_DEFAULT_CHANNELS`
  mechanism. Channels gain a `includeInDreamData` setting (Channel-config checkbox + the
  `agent_set_conversation_include_in_dream_data` command) controlling whether a channel feeds Dream
  evidence; the Dream channel is force-excluded from its own evidence and from `past_chats`. Dream run
  metadata is anchored to the channel (reflective run kind/fingerprint) so replay joins the run ledger,
  and the channel's run history is bounded to the most recent 512 runs (pruning re-roots retained anchors
  so replay stays consistent). Trigger + seq-watermark behavior are unchanged this PR (date→cursor
  derivation is PR2). **Gate (main):** `/code-review high` across two fix rounds — terminal
  `dream.finished`/run-meta consistency, truncation-signal accuracy, helper/channel-machinery dedup, and a
  caught-and-fixed retention-prune bricking bug (dangling parent after prune) were all fixed and
  regression-tested. `test:core` 1065/0, typecheck clean, `docs:check` OK on the integrated tree. Specs
  synced: `agent-architecture`, `agent-event-log-rendering`, `agent-tool-design`, `agent-skills`,
  `agent-progress`, `agent-pi-mono-implementation`.

- **Native PDF payloads for OpenAI Responses models (PR #322, codex-3)** — an ordinary `file_read` of a
  PDF (no `pages`) on an OpenAI Responses model now sends the PDF to the model as a native `input_file`
  document block instead of rasterizing pages through Poppler. The original bytes are stored as an
  event-log **source payload** and converted to `input_file` only at the request boundary, so no base64
  ever lands in tool-result JSON, persisted chat text, or debug snapshots. Explicit `pages` reads and
  non-Responses providers keep the existing Poppler page-render/text-extraction path. GUI-launched local
  tool subprocesses now prepend common Homebrew/system PATH segments (`buildAgentLocalToolProcessEnv`) so
  `pdfinfo`/`pdftoppm`/`soffice` resolve when the app is launched from Finder, and the missing-Poppler
  error now gives package-manager-neutral recovery guidance (brew/port/apt/dnf/pacman) instead of assuming
  Homebrew. Hardening: a 20 MB native-size cap (base64 expands ~⅓); a base64url marker body that is
  delimiter-collision-safe and never exposes payload metadata to the model; a cross-model gate plus an
  `onPayload` marker-strip backstop so a model that cannot read native PDFs receives a clean
  "call `file_read` with pages" fallback rather than raw marker text; native-attach failures surface a
  recoverable error envelope; agent tools are rebuilt on a mid-run model switch. **Gate (main):**
  `/code-review high` (10 findings folded + verified); the provider-contract question — does
  `function_call_output.output` accept `input_file`? — was confirmed against OpenAI's SDK types
  (`ResponseFunctionCallOutputItemListParam` includes `ResponseInputFileContentParam`, an exact shape
  match). `test:core` 1054/0, typecheck clean. Seeded the `file-ingestion-runtime-follow-up` plan
  (provider-neutral ingestion for PDFs/Office/notebooks/archives with universal text/image/metadata
  fallbacks). Spec synced: `agent-tool-design`, `agent-progress`.
- **File-only preview readers + transcript chips open in-app (PR #321, codex-2)** — a new
  `FilePreviewPresentation = 'reader'` mode renders a file on its own: a compact header (filename + a
  `⋯` actions menu + close) with **no** breadcrumb, title-hero, child outline, or resize handle, just the
  file body in one frame. Agent-transcript file chips now route to this **in-app reader** instead of
  handing the file to the OS default app, and a **"Open in split pane"** action opens the reader beside
  the current pane. `FilePreviewNavigationOptions { newPane, nodeId, presentation }` is plumbed through
  `openPreview` / `navigatePanelPreview` / `openPreviewPanel` / `previewEvents`, and the panel view key
  encodes `presentation` so a reader and a default preview of the same target don't collapse into one
  history entry. The reader header `⋯` (`FilePreviewHeaderMenu`) carries Open-with-default-app / Reveal /
  Copy, and suppresses "Add to outline" when the target is already an outline node. **Gate (main):**
  `/code-review high` (6 findings — panel-view-key collapse, reader sanitize, `canAdd` gating, e2e route
  assertion, +2) all folded and verified; light + dark visual pass on the reader pane and the `⋯` menu;
  `test:renderer` 599/0 · `file-attachments` e2e green (one reported "regression" was a worktree
  symlink/pdf.js-worker artifact, retracted — not a branch defect). Spec synced:
  `agent-event-log-rendering`, `ui-behavior`, `workspace-layout`; i18n en + zh-Hans (A6).
- **File-preview polish + file-node mentions (PR #318, codex-3)** — expanded PDF previews now render a
  selectable text layer over each page (drag-select extracts the real text, highlighted with a fixed
  neutral document-selection tint that survives dark mode over white pages), and the reader remembers its
  per-target scroll position (page + intra-page offset) across collapse/expand via a renderer-local
  `localStorage` keyed store (shared helper now also backing `outlineViewState`). Text-like previews
  (markdown / code / table) drop their inner card frames for a generalized page-like inset driven by a
  `data-preview-text` marker, matching PDF spacing. Reference search can surface **file nodes by their
  display filename** so agent-composer `@` mentions insert an existing attachment/image as a node
  reference — scoped to the composer only (the outliner `@` reference picker is unchanged). The file-name
  row's focus ring is now keyboard-only (`:focus-visible`-correct), and a failed PDF load again shows the
  metadata card plus a reason note instead of a bare message. **Gate (main):** `/code-review high` (10
  findings) all folded by the author in the review-response commit; typecheck ✓ · `test:renderer` 591/0 ·
  no design-system guard regressions · merge clean against current `main` (no file overlap with the
  in-flight agent-UI wave).
- **Dream consolidation + distinguishable inline references (PR #315, codex)** — Memory Dream becomes a
  runtime-only human-sleep-style consolidation skill: it consolidates member conversations into
  `#d-memory` / `#d-episode` / `#d-belief` plus optional `#d-question` (unresolved tension) and
  `#d-guidance` (future handling) nodes, reconciles prior `#d-*` memory and user-authored outline context
  via `node_search`/`node_read`, maintains one dated `#d-memory` container with a generated headline, and
  treats prior Dream output as a belief graph to update rather than self-confirming evidence. Scheduled
  runs are at-most-once per daily due (a failed attempt still consumes the slot); a new
  **`agent_run_dream_now`** command (Settings → Agent button) is the same-day recovery path and bypasses
  the due gate. **Security:** Dream is granted the unscoped **`node_delete`** capability so it can prune
  obsolete/forgotten/contradictory nodes — a deliberate **PM-authorized** product posture (the destructive
  grant on an unattended skill is guarded by the skill prompt, not a capability scope). Inline references
  are now visually distinguishable — chat-source = chat glyph + label, local-file = file glyph + filename,
  node = text-only — and a chat-source jump highlights only the cited message content body (empty-body
  fallback to the transcript row); the agent rail preflows before opening from a closed state to avoid a
  layout jump. Extends the shipped `agent-memory-on-timeline` work. **Gate (main):** rebased onto current
  `main` (#312/#313/#314) by the author; integration verified — typecheck ✓ · `test:core` 1045 ·
  `test:renderer` 590 · e2e `agent-process` + `agent-settings` 49/0 · `docs:check` ✓ · spec coherence
  checked · visual verification light+dark of the distinguishable refs. The earlier `/code-review xhigh`
  findings were folded by the author (315-1 node_delete authorized; 315-5/6 fixed).
- **Jump-to-source UI — `agent-memory-on-timeline` PR3 (PR #310, codex)** — the `[[chat:…]]` citations
  agent memory writes are now clickable navigation back into the transcript. Core projects a per-message
  **`sourceSeq` / `sourceSeqs[]`** (every event-log seq that represents a message as source evidence)
  through replay and the render projection, so a citation resolves by event-log coordinates rather than
  timestamp/text guessing — and because **every** evidence seq is kept, a citation still resolves after the
  cited message is edited or regenerated. Clicking a `conversation` chat-source reference opens the agent
  dock, selects that conversation, and scrolls to + briefly highlights the first transcript row whose
  `sourceSeq` falls inside the cited `(fromSeqExclusive, throughSeq]` range; clicking a `run` chat-source
  reference opens the owning child-run panel (resolved by child-run membership, so tool-spawned/parentless
  runs work, not only runs with a transcript boundary row). The pending reveal is conversation-scoped, so a
  non-matching citation clears cleanly instead of lingering or jumping in the wrong conversation. **Gate
  (main):** `/code-review xhigh` (9 finder angles → verify → sweep) caught a blocking cluster in the first
  cut — run-source citations silently no-op'd for tool-spawned runs, a stuck pending-target could cause a
  cross-conversation spurious jump, message rows double-painted the `--fill-1` highlight, and `sourceSeq`
  drifted past the cited range after an edit — all fixed in `1430f23a` with new tool-derived-run e2e,
  edit-survival + merged-row `sourceSeqs` unit tests, and a NaN-reject parse test. typecheck ✓ ·
  `test:core` 1037 pass / 2 skip / 0 fail · `test:renderer` 554 pass / 0 fail · `agent-process` e2e 15/15
  · `docs:check` ✓. Completes `agent-memory-on-timeline` (PR1 #305 + PR2 #308 + PR3 #310). A post-merge
  follow-up resolves a `run` chat-source reference's owning conversation in one read via a new read-only
  `agent_run_conversation_id` command, instead of probing every conversation's run ledger.
- **Node-based agent memory — `agent-memory-on-timeline` PR2 (PR #308, codex-2)** — durable agent
  memory moves onto the daily timeline as ordinary outline nodes. New **`chat-source`**
  `ReferenceTarget` variant (a `[[chat:…]]` inline reference into a conversation/run span, with
  parse/serialize/normalize and ProseMirror/renderer plumbing) that is **validated on write**: a
  node_create/node_edit carrying a chat citation must resolve to a readable `past_chats` source or the
  write is rejected. Foreground memory is now **pull-only** — the model-visible `recall` tool and the
  resident `<memory>` briefing are removed; the agent reads memory via `node_search`/`node_read` over
  the `#d-memory`/`#d-episode`/`#d-belief` tag family and reads raw spans via `past_chats`. The `dream`
  self-maintenance tool and manual `/dream` are replaced by a **private runtime-only `memory-dream`
  skill** that the scheduled Dream path launches as a restricted child agent (allowed tools:
  `past_chats`, `node_search`, `node_read`, `node_create`, `node_edit`), consolidating visible past
  chats into timeline memory nodes with `[[chat:…]]` provenance. Dream change counts are derived from
  the child run's real node writes; a **zero-write Dream does not record `dream.completed` or advance
  the watermark** (evidence is retried, not silently dropped), and the internal consolidation
  conversation is hidden from the channel list and deleted after each run. Removes the
  `agent.memory.dream` permission action kind. **Gate (main):** `/code-review` recall-mode over 3
  rounds (13 findings incl. two data-loss-class bugs — `node_edit` silently stripping marks/inline-ref
  metadata, and the Dream watermark advancing on a zero-write child — all fixed and verified, plus a
  follow-up preview-edit miscount fix); merge re-verified against `main` with typecheck + `test:core`
  (1036 pass) + `test:renderer` (552 pass). PR3 (jump-to-source UI) still to come.
- **Reference-authority ranking for node search — `node-search-access-ranking` PR B (PR #309, codex)** —
  default node-search relevance now folds in a capped, **document-derived reference-authority** boost: a
  node ranks higher the more **distinct linked inbound source nodes** point at it (tree references, inline
  node references, and reference-field values; trashed/internal metadata references excluded). The boost is
  `cappedMultiplier(log1p(distinctSources), 0.04, 0.25)` — at most +25%, so it reorders close/same-tier
  matches without overriding strong lexical relevance (exact-title still wins). A search node can also
  explicitly sort by the **References** system field (`sys:refCount`), which orders by the **same visible
  linked count** the References field and backlinks badge display. The authority count is computed in the
  search layer (`referenceAuthoritySourceCount`), leaving the shared `referenceCountKey` / `ReferenceCounts`
  untouched — backlinks-panel and `sys:refCount` displays are unchanged. Because the signal is pure document
  state it is reproducible, so it applies to **all** callers including saved-search materialization (unlike
  PR A's personal-access boost). The capped-multiplier shape is extracted to `src/core/ranking.ts`, now
  shared with PR A's personal-access multiplier. **Gate (main):** `/code-review high` caught a headline
  regression in the first cut — it collapsed the shared `referenceCountKey`, which would have silently
  changed `BacklinksSection` + `sys:refCount` counts and desynced the header badge from rendered rows —
  fixed in `c2483504` by reverting `references.ts` and deriving the authority count separately, with 6 new
  `searchEngine` tests. typecheck ✓ · `test:core` 1057 pass / 2 skip / 0 fail · `docs:check` ✓.
- **Personal access ranking for node search — `node-search-access-ranking` PR A (PR #307, codex)** —
  transient node retrieval (launcher / app search / agent `node_search`) now boosts nodes the user
  recently and frequently lands on. A per-`NodeId` **single weighted, time-decayed accumulator**
  `{s, tUpdate}` lives in an off-Loro flat-JSON userData side store (`nodeAccessStore.ts`) and folds
  into the single ranking chokepoint `sortSearchHits` **only** when a caller passes
  `personalAccess: true`; deliberate human landings carry weight 1 and a dampened `agentRecall` source
  0.15, sharing one half-life (so a weak agent recall nudges recency weakly instead of overwriting it).
  Saved-search materialization stays document-reproducible **structurally** — `personalAccess` exists
  only on `TransientSearchOptions`, never on the `SearchRunOptions` materialization uses — and any
  explicit sort rule (incl. custom fields) still overrides personalization. A new cross-process
  `recordNodeAccess` lane (IPC + preload + main handler + debounced deliberate-landing emit) records
  access, with projection-update pruning of deleted/trashed nodes + a 5000-entry cap. The file is
  written `0600`. Reference-authority ranking (`sys:referenceCount` + default boost) is PR B, still to
  build. **Gate (main):** `/code-review high` → 10 findings (0600 perms, custom-sort override,
  per-keystroke map clone, I/O-fault swallowing, convention-only opt-in, …) all resolved in `ba681049`
  (the opt-in fixed structurally via the `SearchRunOptions`/`TransientSearchOptions` split); one
  high-consensus finder candidate refuted at verify. typecheck ✓ · `test:core` 1051 pass / 2 skip /
  0 fail · `test:renderer` 548 pass / 0 fail · `docs:check` ✓.
- **Re-provide the `past_chats` agent tool — `agent-memory-on-timeline` PR1 (PR #305, codex-2)** —
  the first PR of the #302 set re-exposes the model-visible, **read-only** `past_chats` tool over the
  existing `AgentPastChatsService`: `recent` (recent visible user-message anchors), `search` (visible
  prior-conversation text search), `read` by `message_id` (bounded window around an anchor), and `read`
  by `source` (raw `{stream, stream_id, from_seq_exclusive, through_seq?}` conversation/run span).
  Every `recent`/`search` result and every read message now carries its **source coordinates**
  (`stream` / `streamId` / seq range / `eventId`) so a later writer can cite only spans it actually
  read — the §6 contract that PR2's `chat-source` inline reference + validate-on-write builds on.
  Raw-span reads reuse the same evidence-extraction path as memory evidence expansion (visible/runtime
  transcript), so they introduce no new transcript store and don't bypass compaction; the current
  conversation is excluded by default from `recent`/`search`/`message_id` (opt in via
  `include_current_conversation` to recover compacted current-conversation context). Wired into Neva
  and child/fork tool sets and classified `agent.memory.recall` (read-only, no approval, allowed in
  restricted mode). Spec synced: `agent-tool-design.md`, `agent-progress.md` (A6). **Gate (main):**
  typecheck + `test:core` (1038 pass / 0 fail) + `docs:check` green; manual correctness/security review
  (source-coordinate round-trip, single-principal, no compaction bypass) — no blocking findings.
- **Code-block floating toolbar + framed preview insets (PR #301, codex)** — editable outliner code
  blocks and read-only agent markdown code blocks gain a top-right floating toolbar: the language
  selector and copy button are separate hover/focus-revealed controls on the shared popover material
  (with the inherited reduced-transparency / high-contrast fallbacks), over an opaque code surface.
  The code text viewport is inset like file/PDF previews so long-line scrolling never places text on
  the frame edge, and horizontal scrollbars sit in a reserved bottom gutter; editable blocks grow to
  `min(42vh, 420px)` then scroll internally with the Shiki highlight layer synced to the textarea's
  scroll offsets. The same framed-inset + scroll-gutter treatment now covers markdown fenced code,
  plain/code previews, and CSV/TSV tables. File-preview action menus dismiss from capture-phase
  outside-pointer clicks even when the clicked row stops propagation, ignore their own trigger so
  repeat-click toggling works, and suppress the menu surface's default focus outline. Expanded
  childless file rows now keep the normal children outline with the standard trailing draft below the
  inline preview, so the first child note can be added inline (flat visual-row producer + row keyboard
  nav follow the same rule). Spec synced: `design-system.md`, `ui-behavior.md` (A6). **Gate (main):**
  `/code-review high` (8 finder angles + verify) → 2 confirmed findings — a Shiki highlight layer
  whose bottom inset (`content-inset`) exceeded the textarea's (`edge-inset`), blanking the last
  ~`space-4` of code when a tall block is scrolled to the bottom (transparent textarea text, no
  highlight behind it); and `useDismissibleOverlay`'s `ignoreRefs ?? []` default allocating a fresh
  array each render, churning the document listener subscription for the 4 consumers that don't pass
  it. Both fixed (highlight bottom inset aligned to `edge-inset`; empty default hoisted to a
  module-level constant) and re-verified: typecheck ✓ on the merged tree, `visualRows` renderer test
  10/10. Fast-track (no plan file).
- **File node preview interactions (PR #295, codex)** — a follow-up to `file-presentation-redesign`
  (#285). Non-image file rows become read-only but caret-focusable: the filename wraps like a
  locked/reference row, a caret can land in it for structural commands and `#` tags, but ordinary
  typing never renames it; image file rows now render their tags too. The file preview surfaces are
  redesigned — a PDF summary strip whose Expand opens the full scrollable reader (clicking a summary
  page jumps to it), a compact metadata card for unsupported types, a resizable preview viewport, and
  one consistent Open/Expand/`⋯` action location. Clipboard file paste and external file drop insert
  file nodes with drop-position insertion guides. Pane scroll position is preserved across node
  navigation. The expanded indent guide moved onto the shared flat overlay and is now measured from
  the real marker DOM (`.row-bullet-button` rects): the line sits on the parent marker column, starts
  just below it, and ends on the last visible descendant's marker centerline, in both the virtualized
  and flow renderers (replacing the drifting `layout.items` + hardcoded-`28px` model). Spec synced:
  `design-system.md`, `ui-behavior.md`, `workspace-layout.md` (A6). **Gate (main):** `/code-review
  xhigh` (10 finder angles + verify + sweep) surfaced a guide-geometry root-cause directive + 6
  confirmed correctness/design-system findings (image-node tags rendered nowhere; scroll-restore
  overwriting the saved position with a clamped value; the PDF reader re-jumping to the clicked
  summary page on resize; preview view-state leaking across in-pane file switches; the non-image file
  row's lost B8 focus ring; `--preview-action-*` missing the B5 reduced-transparency opaque fallback)
  + 3 secondary items, all addressed across three follow-up commits and re-verified: typecheck ✓,
  guide e2e 3/3, file-row e2e (image tags / focus ring / paste) ✓, new `workspaceLayoutHistory`
  renderer test 2/2. Two env-dependent e2e (`file-attachments` PDF-geometry, `outliner-navigation-title`
  day-node note-density) fail only in local headless and were confirmed pre-existing / non-regression
  (they fail identically on the base commit / `main`) — to be confirmed green in a real-render CI.
  Fast-track (no plan file).
- **Agent dock: channel header glyph + composer model/effort chip (PR #296, cc-2)** — post-collapse
  UI for the single agent. The dock header shows a `#` channel glyph + conversation name (no
  per-conversation avatar — every conversation is one of Neva's channels). The composer regains a
  quick model/effort chip (`AgentComposerModelControl`) that edits Neva's **standing** profile (model
  lives on the profile, not a per-conversation identity) through the normal
  `agent_update_agent_definition` path, mirroring the current definition so persona/tools/skills are
  preserved; the runtime hot-swaps the resolved model/effort on the next turn, gated on a real
  model/effort diff (`builtInModelEffortChanged`) so a persona-only edit never silently re-resolves a
  live conversation's model. A Codex/Claude-desktop-style portaled menu shows two result rows opening
  side-anchored flyouts — reasoning levels (`off` is a level; the inherited level is badged
  **Default**) and the model list grouped by provider with a per-provider **Show all**; an
  out-of-catalog saved model is surfaced as a synthetic entry so it stays visible and checked. The
  default-level math is extracted to a shared `core/agentReasoning`. `design-system.md` /
  `agent-pi-mono-implementation.md` / `workspace-layout.md` updated (A6). **Gate (main):**
  `/code-review max` (10 finder angles + sweep) → 4 correctness findings (a concurrent profile-write
  race dropping the effort reconciliation; a persona-only edit silently switching the live model; an
  out-of-catalog model hidden while offering unsupported reasoning levels; a `[real, '*']` tool list
  wiped to unrestricted) plus a11y / label-dedup / memoization fixes, all resolved in `6176886a`;
  re-verified typecheck + renderer 12/12 + core 21/21 green.
- **Native link blue for clickable text (PR #293, cc)** — links, file references, and node
  references no longer use the brand rose (which sat a hue from `--status-danger` and read as an
  error). `--link` is decoupled from `--accent` and set to the fixed native macOS link blue
  (`#0a66d6` light / `#4c9bff` dark) — the app's one coloured clickable affordance, theme-adapted
  by the dark override, with no JS theme bridge (B2). Rose stays the sparse brand accent (caret,
  workspace avatar, status badges); selection/focus stay neutral per B3, and `--status-info`
  (Sapphire) keeps its distinct status role. AA-compliant in both themes. `design-system.md`
  rewritten in the same change (A6).
- **Coordinator Channel organization — `channel_create` / `channel_update` (PR #289, codex)** — the
  user-facing coordinator can create and edit named local Channels from chat. `channel_create` opens
  a persistent multi-agent working group (required name, optional invited agents, optional opening
  message); `channel_update` renames a Channel and/or adds/removes invited members. Member references
  resolve by exact agent id, name, display name, or `@mention` (explicit `@`-mentions match the
  routing token only; bare names that collide with a token are reported as ambiguous), with
  recoverable errors for missing/ambiguous refs. Both tools are wired **only** on the coordinator run
  (`options.channelOrg`) — delegated/child runs never receive them — and reuse the existing runtime
  `createConversation` + member add/remove/rename path, mutating only local conversation
  metadata/membership (`#General` and canonical DMs stay immutable; the coordinator cannot be
  removed; removals still wait for an active Channel run to settle). New permission action kinds
  `agent.channel.create` / `agent.channel.update` are classified local, reversible, and free of
  external effect. The native Channel config window also gains removal of non-coordinator members.
  Single-step membership edits and the batch update now share one `applyConversationChannelUpdate`
  runtime core. Specs: `docs/spec/agent-architecture.md`, `agent-pi-mono-implementation.md`,
  `agent-progress.md`, `agent-tool-design.md`. **Gate (main):** `/code-review high` (8 finder angles,
  recall-biased) → 8 findings (ref-resolver vs `@mention` routing divergence; active-run guard on
  requested-not-actual removals; config-window coordinator inferred by name; duplicated membership
  invariants; redundant roster/conversation reloads; duplicated helpers; cold-path agent-dir rescan)
  all resolved in follow-up commit `12fba60a`; re-verified typecheck + channel/permission/catalog
  `test:core` 37 pass / 0 fail.
- **File presentation redesign — outliner file row · simplified preview · external-open chip (PR #285, cc)** —
  file nodes render as a dedicated outliner file row; the preview surface is simplified into a single
  preview widget; and agent transcript file chips (`file_write` / `file_edit`) open externally, support
  right-click + "Add to Today", and reveal the local file in Finder by path. (Backfilled: the #285 merge
  added the plan file but neither a board entry nor this changelog line; the board entry + plan archive
  were reconciled during the #290 gate sweep, and this entry closes the remaining changelog gap.)
- **Conversational agent authoring — `/create-agent` (PR #286, codex; plan re-planned by cc-2)** —
  the `agentify` twin of `/skillify`, **with no new tool**. A built-in, user- and model-invocable
  `/create-agent` skill interviews for missing identity/routing/tool details, drafts a complete
  `AGENT.md` (or a focused edit diff), previews + confirms in chat, then writes exactly one file with
  the existing `file_write` / `file_edit`. The file-tool **self-definition gateway** is extended to
  govern agent-definition writes alongside skill writes: a chat-authored agent may create or edit one
  `AGENT.md` under `<workspace>/.agents/agents/<name>/AGENT.md` (user-scope `~/.agents/agents` only
  when a write scope is handed), must declare `permission-mode: restricted`, and passes bounded
  frontmatter validation (reserved built-in names rejected; `background` disabled; `max-turns` capped
  1–50; `model`/`effort`/`tools`/`disallowed-tools`/`skills` shape-checked, no `tools: ["*"]`).
  Support files, deletes, trusted permission mode, secret-looking content, malformed frontmatter, and
  oversize bodies are refused; the agent registry **hot-reloads** (including child runtimes) on a
  successful write. Existing-file edits keep the normal freshness path (`file_read` before
  `file_edit`/replacing `file_write`). Specs: `docs/spec/agent-skills.md`,
  `agent-tool-design.md`, `agent-tool-permissions.md`, `agent-delegation-runtime.md`. **Gate (main):**
  `/code-review xhigh` (10 finder angles + verify + sweep) surfaced 15 findings — a **symlink
  write-escape** (a workspace `.agents/agents` symlink redirected a restricted write outside the
  workdir, empirically reproduced), built-in-name shadowing of the default `assistant`, unvalidated
  `background`/`max-turns`/`tools`, `file_convert` and `bash` gateway bypasses, and a `file_delete`
  lexical-guard bypass. codex's hardening commit closed them all (self-definition dirs no longer
  standalone write roots so writes must resolve inside the workdir; `RESERVED_AGENT_NAMES` gateway +
  registry guard; bounded frontmatter; `file_convert` self-definition refusal; a bash
  self-definition-write **redline**; realpath-aware delete guard), re-verified by probe (symlink write
  → `path_outside_local_root`, legit project writes intact); typecheck + affected `test:core` suites
  (218 pass / 2 skip / 0 fail) green.
- **`web_search` image kind (PR #282, cc-2)** — the existing `web_search` agent tool gains an
  optional `kind` parameter (`"web"` default, or `"image"`); no new tool. `kind: "image"` scrapes
  Bing Images (every result is an `a.iusc[m]` JSON blob carrying the full image, thumbnail, and source
  page) and returns results with `imageUrl` (the binary to download with `web_fetch`) and
  `thumbnailUrl` (a preview to pick by); `site` still applies via the `site:` operator. The default
  `"web"` path is byte-for-byte unchanged. The hidden-window lifecycle (rate-limit gate, off-screen
  window, abort wiring, teardown) is shared by both kinds via `withSearchWindow`, and a
  `SEARCH_PROVIDERS` descriptor keeps `execute()` kind-agnostic. The success envelope warns image
  results may be copyright-protected (treat as drafts, confirm reuse). Spec:
  `docs/spec/agent-tool-design.md`. **Gate (main):** two high-effort review rounds → 5 findings
  addressed (misleading Bing-block comment corrected, abort no longer mislabeled as `rate_limited`,
  non-string `record.t` title coercion guarded, dead `width`/`height` fields dropped, redundant
  per-kind `searchUrl` removed so each provider builds its own URL); re-verified, typecheck +
  `test:core` (1076 pass / 0 fail) green.
- **Document & data-analysis skill hardening (PR #283, codex-4)** — strengthens the `/document` and
  `/data-analysis` built-in skills (follow-up to #270), staying **stdlib-only** (no new dependencies;
  XLSX/DOCX parsed as zip+XML). `/document` gains archetype/form-factor routing, design presets, and
  table gates; `docx_tool.py` reports heading jumps, manual bullets, table-grid risks, comment
  references, sections, headers/footers, notes, styles, and numbering, and `markdown_tool.mjs` reports
  heading jumps, long paragraphs, wide tables, and word/paragraph counts. `/data-analysis` gains
  portable data contracts (`data-contract.schema.json`), a `data-validation-report` schema, and
  workbook-delivery guidance; `data_tool.py` adds `profile`/`validate` subcommands (duplicate-row,
  candidate-key, date, outlier, quality-flag, suggested-contract, and contract validation), and
  `xlsx_tool.py` reports hidden sheets, manual calculation mode, formula-error literals, defined names,
  tables, charts, pivots, merged cells, and hidden rows/columns. `validate` returns a structured
  `{ok,errors,warnings}` envelope (no raw tracebacks) on malformed contracts. Spec:
  `docs/spec/agent-skills.md`.
- **Presentation visual skill hardening (PR #281, codex-4)** — turns `/presentation` (follow-up to
  #270) from broad deck guidance into an opinionated visual deck system. The visual route now requires
  a design direction, theme, motif, and registered `data-layout` recipes (`references/layout-recipes.md`)
  before generation; the portable HTML template gains design tokens, chrome, and
  cover/split/metric/compare/gallery/timeline/quote component classes plus a Keynote-style stage
  direction for premium decks; and `html_tool.mjs` reports visual-quality risks (missing/unknown
  layouts, low layout variety, text-only slides, bullet dumps, tiny text) as warnings rather than
  structural failures. Spec: `docs/spec/agent-skills.md`.
- **Default `#General` agent Channel (PR #278, codex-2)** — the runtime reserves
  `lin-agent-channel-general` as a normal named Channel (`title/goal = General`, no stored
  conversation `kind` — its reserved id plus a runtime invariant make it special) that always
  exists, holding the user, the coordinator, and every current durable peer agent; fork, child,
  headless, and transient helper agents are excluded, and future durable peers auto-join when they
  appear. The invariant is ensured idempotently on runtime ready, conversation restore, list, and
  agent-registry reload (no duplicate `member.added` events; unavailable peers are pruned when no
  Channel run is in flight) and is protected — `#General` cannot be renamed, deleted, or manually
  membership-edited, and its channel-configuration affordance is hidden. The Agent Dock conversation
  menu now presents Channels before Direct Messages with `#General` pinned to the top of the Channels
  section, and the dock's default selection restores a remembered valid DM/Channel first, then
  `#General`, then falls back to the legacy coordinator DM. Routing is unchanged: an unaddressed
  `#General` turn still routes only to the coordinator, while `@agent` routes only to named peers.
  Specs: `docs/spec/agent-architecture.md`, `docs/spec/agent-event-log-rendering.md`,
  `docs/spec/commands.md`.
- **Keyboard & ARIA semantics for menus, tree, and calendar (PR #273, cc)** — Layer-3 behavioral
  accessibility for the renderer, no visual redesign. A shared `useMenuKeyboard` hook gives every
  anchored overlay (not on the modal `Dialog`) focus-in on open, focus-restore to the trigger on
  close, surface-scoped Escape, and either roving Arrow/Home/End (`menu`) or a Tab focus-trap
  (`dialog`) — IME-guarded, with split focus-in/restore effects and a `focusKey` so a surface that
  swaps its body in place (a menu's Back button, the view toolbar switching section) re-pulls focus
  in. Retrofitted onto NodeContextMenu, SettingsRowMenu, the agent conversation-row and history/
  session menus (the latter previously had no Escape), the view-toolbar popovers, and the date
  picker; the two `⋯` row menus now share one `AnchoredActionMenu`. The outliner is a `role="tree"`
  of `role="treeitem"` rows (`aria-level`, `aria-selected` tracking the *visible* selection,
  `aria-expanded` only on parents) nesting children in `role="group"`. The calendar month grid is a
  `role="grid"` of week `role="row"`/`role="gridcell"` cells with roving tabindex, Arrow/Home/End/
  Page day navigation that crosses months by the exact month delta, and range-aware
  `aria-multiselectable`. Role fixes: DoneCheckbox→`checkbox`, view-toolbar single-select→`radiogroup`,
  child-run tabs→`tablist`, Command Palette input→`combobox`. The roving index math is one shared
  `resolveMenuNavigation` reused by the menu, radiogroup, and tablist. Spec: `docs/spec/ui-behavior.md`.
- **Natural-language Skillify routing (PR #271, codex)** — explicit natural-language skill-authoring
  requests ("save this as a skill", "turn that workflow into a skill", "update the import skill",
  "fix the skill that failed") are now normalized to the same direct `/skillify` prompt path, so
  authoring works even when automatic skill listing is disabled — gated on slash skills being enabled.
  A conservative parser (`parseNaturalLanguageSkillifyRequest`) requires a skill-artifact anchor
  (singular `skill` for update/fix, with a negative lookahead on `tree`/`check`/`list`/`sheet`/…) and a
  question/explain guard, so ordinary outliner content ("update the skills list", "improve my coding
  skills", "make a skill tree") stays normal conversation; an NL match that cannot be invoked (e.g.
  Skillify disabled) degrades to normal chat rather than erroring. Reuses the existing slash-invocation
  path, so Skillify v2 preview/confirmation, `file_write`/`file_edit` writes, and the
  born-unratified-after-write semantics are unchanged. Spec: `docs/spec/agent-skills.md`.
- **Goal-oriented built-in skills: `/presentation`, `/document`, `/data-analysis` (PR #270, codex-4)** —
  three resource-backed `built-in` skills built on the bundled-resource loader (#269). Each ships its own
  `SKILL.md`, route-specific `references/`, **stdlib-only** portable inspection `scripts/` (Python
  `pptx_tool`/`docx_tool`/`xlsx_tool`/`data_tool`, Node `html_tool`/`markdown_tool`), JSON `schemas/`, and
  lightweight templates. They are **goal-oriented**: PPTX, DOCX, XLSX, Markdown, HTML, PDF, CSV, and JSON
  are treated as input/output routes rather than skill identities, and the body points the model at
  `${AGENT_SKILL_DIR}` so only task-relevant resources are loaded or executed. The OOXML inspectors resolve
  relationship targets with `posixpath.normpath` (correctly collapsing `..`-relative `../slideLayouts/`,
  `../drawings/`, `../customXml/` targets), and the Markdown/HTML inspectors separate structural `errors`
  (which set `ok:false`) from advisory `warnings`. Spec: `docs/spec/agent-skills.md`.
- **Bundled built-in skill resources (PR #269, codex)** — app-shipped `built-in` skills can now use the
  **standard Agent Skills folder shape** (`SKILL.md` plus adjacent `references/`/`scripts/`/`assets/`)
  instead of a single monolithic prompt string. Resource-backed built-in folders load from
  `src/main/builtInSkills` (copied to packaged `Resources/built-in-skills` via electron-builder
  `extraResources`, with the dev README excluded) **before** the inline code-registered built-ins and
  before mutable skill directories. They get a real base directory so `Base directory for this skill:`
  and `${AGENT_SKILL_DIR}` resolve and progressive disclosure works, while keeping the `built-in:<name>`
  compact/listing identity (a new `<skill-path>` loaded-message tag keeps post-compact restore on
  `built-in:<name>` rather than leaking the directory). Inline built-ins (`/skillify`, `/research`) are
  unchanged — no base directory, no pseudo editable path. Duplicate built-in names now **fail loudly**;
  bundled files stay out of the mutable skill write-target resolver (immutable even when also configured
  as an additional skill dir); `name:` aliases and `paths:`-gating are ignored for built-ins so they
  remain the always-on floor; and the registry shares a single in-flight load across concurrent callers.
  This is the structural loader/resource capability only — it ships no `/presentation`/`/document`
  content. Spec: `docs/spec/agent-skills.md`.
- **Agent folder handoff + typed `file_convert` tool (PR #266, codex-3)** — Settings → Security gains a
  **"hand Tenon a folder"** action: a native directory picker records a remembered `Scope(write:/folder)`
  grant, and the runtime **projects remembered scope grants into the local file-tool layer** so handed
  folders become real read/write roots enforced by the same realpath containment as the app-owned
  workdir/scratch (not UI state alone). A new typed **`file_convert`** tool replaces shell-driven
  conversions — office / presentation → PDF (`soffice`/`libreoffice`), PDF pages → PNG/JPEG (`pdftoppm`),
  and image → PDF/PNG/JPEG (`sips`) — run via `spawn(file, argv, { shell: false })` with a structured
  audit payload and overwrite-refusal; new `file.convert.*` audit kinds evaluate the conversion input as
  a read boundary and the output path/dir as a write boundary. Completes the `agent-permission-redesign`
  plan (after PR-1 #252). Spec: `docs/spec/agent-tool-design.md` + `docs/spec/agent-tool-permissions.md`
  + `docs/spec/agent-skills.md`.
- **Files become first-class outliner nodes — file-as-node (PR #241, cc)** — an `attachment` /
  `image` node is now a normal outliner node, not a special row. A non-image file renders as a
  click-to-open **file card** (file-type icon · display-only filename · `type · size · pages/duration`
  meta · `⋯` menu); an **image renders inline as the image itself** (no card, no filename); and the
  **bullet drills to the node's page**, whose body is the full-size preview "hero" above the node's
  children outline. The chevron expands the file node's **children** like any node (no inline preview
  block), so move / reference / pin / open-in-split all work for free. The standalone `file-preview`
  pane now serves only non-node sources (`agent-payload` / `local-file` / `url`), reuses the same
  preview body, and carries an **"add to outline"** action that copies the source into a file node. The
  filename is display-only in the row (renamed on the node page); a lightweight visually-hidden keyboard
  anchor keeps full row keyboard parity (arrow nav, Enter → sibling, Tab → indent, Backspace → remove).
  Audio / video previews and a shared object-URL hook landed alongside. Spec:
  `docs/spec/workspace-layout.md` + `docs/spec/ui-behavior.md`.
- **The built-in agent is named Neva; the system prompt slims to identity-only (PR #248, cc-2)** —
  the built-in agent now presents as **Neva**, a thinking-partner persona with a load-bearing
  anti-sycophancy stance (challenges weak reasoning, won't flatter, hard on the idea and reverent
  with the user's voice/work). The rename is **display-name-only** — the identity string
  `built-in:tenon:assistant` is unchanged, so there is no userData wipe. The stable system prompt is
  re-homed by how often each fact changes: it now carries only what holds on every turn — identity,
  perception (`<system-reminder>` handling), memory framing, and conduct/safety — and **drops the
  `outliner` / `local-tools` / `web` sections**. Tool-operating conventions (`%%node:id%%` edit
  handles, `[[node:Display^id]]` / `[[file:Display^/path]]` references, canonical date formats, the
  "create under today's journal when no `parent_id`" default, prefer-file-tools-over-`bash`, web tool
  usage) now ride with each tool's own description, present exactly when that tool is in hand. Result:
  the cached prompt prefix is identical across every conversation, DM, and Channel, and fresh child
  runs (the `shared` subset) inherit perception + conduct but not the user-facing persona/memory.
  Spec: `docs/spec/agent-pi-mono-implementation.md`, `docs/spec/agent-delegation-runtime.md`.
- **The agent surfaces a produced file inline — `[[file:…]]` marker emit (PR #246, cc)** —
  closes a scope gap in the agent-file-model: "output a file into the message flow" previously covered
  only **text** files written via `file_write`/`file_edit` (which render a tool-call file chip). A
  **binary** deliverable — e.g. a `.pptx`, which the text-only `file_write` cannot author — had to be
  produced via `bash`, and a bash-written file had no message-flow representation at all (nothing scans
  the workdir; chips come only from `file_write`/`file_edit` results), so it just landed on disk and the
  agent could only report a raw path. The fix is a one-line system-prompt instruction, because the rest
  of the pipeline already existed end to end: `[[file:Label^/path]]` shares the unified `referenceMarkup`
  parser with `[[node:…]]`; `AgentMarkdown` already turns a file marker into a `#lin-file:` link rendered
  as an inline `InlineFileReference` chip; and clicking it resolves through the trusted-local-file gate
  (`resolveTrustedLocalFileReference`) for preview / save / insert-into-outliner. The agent was simply
  never told to **emit** the marker for its own output — only to parse incoming user attachments; the
  marker convention is now **bidirectional**. Emit policy: **deliverables only** (a file the user asked
  for or should review, not an intermediate/scratch file). The trusted gate independently enforces the
  root boundary, so the prompt cannot widen file access. Spec: `docs/spec/agent-tool-design.md`.

- **Save a conversation file into the outliner — agent-file-model F4 ingest bridge (PR #238, cc)** —
  an "Insert into outliner" icon button on an agent file chip (`file_write`/`file_edit`) promotes the
  agent's working file into a first-class image/attachment node, identical to a user-added one — the
  `working → committed` inverse of F3's materialize bridge (copy + freeze). The chip fires
  `requestInsertFileIntoOutliner(path)` on a decoupled module channel (`agentFileInsert.ts`, mirroring
  `agentReveal`); App's registered bridge runs the new `ingest_local_file` asset command, which
  path-ingests into the asset store **only** when the path resolves inside the agent's trusted roots
  (workdir/scratch) via `resolveTrustedLocalFileReference` — the same gate that backs previewing these
  chips, so it does not reopen the arbitrary-local-file read that `ingest_asset`'s buffer-only-over-IPC
  rule guards (directories / gone / out-of-root → `null`). The node type is derived from the sniffed
  mimeType (`image/*` → `create_image_node`, else `create_attachment_node`) through the shared
  `createAssetNode` helper also used by paste/drop; placement mirrors the paste convention
  (`insertionTargetFor` — a sibling right after the focused row so it is never buried under a media/code
  leaf, else appended into the current outline root) without stealing focus from the agent panel
  (`applyFocus: false`). A stale chip (working file GC'd) or a create that fails mid-insert reports
  not-inserted, so the button never shows a false "inserted". Completes the `agent-file-model` set
  (F1 #224 + F2 #229 + F3 #237 + F4 #238). Spec: `docs/spec/agent-tool-design.md`, `docs/spec/commands.md`.

- **UI quality L2 — shared Button / Input / Field / FeedbackState primitives (PR #234, codex)** —
  the three Layer-2 lanes of the UI-quality suite (`button-primitive` + `input-primitive` +
  `feedback-states`). Adds a `<Button variant>` (primary/secondary/ghost/danger, sm/md, solid danger
  tone) consolidating ~20 hand-rolled text-button stylings; `<Input>/<Textarea>/<Field>` plus
  `SelectControl` `boxed`/`bare` variants as one tokenized control skin (`FormField` collapsed into
  `Field`); and `FeedbackState` (`<EmptyState>/<ErrorState>` with an explicit `loading` prop and
  reduced-motion spin) routing settings empty/loading states and new outliner whole-panel empty states
  (search no-results, empty Trash/Recents) through one quiet idiom. Aborted agent turns now show a
  "Stopped" marker. Editable empty outline pages keep the trailing editor (no centered empty block);
  empty node pages keep the standard title slot with visible breadcrumb context (workspace root no
  longer force-hidden); a pane whose root id no longer exists is repaired to a real fallback root
  instead of an orphan Untitled shell. Per-component focus rules retire onto the neutral
  `:focus-visible` ring; new `primitives/cx.ts` className helper. Spec: `docs/spec/design-system.md`,
  `docs/spec/ui-behavior.md`.

- **Built-in `/research` read-only isolated skill (PR #235, codex-3)** — adds a user- and
  model-invocable `/research` built-in that runs bounded investigation as a same-agent
  **isolated read-only child run**: it inherits the current agent's conversation context and
  DM/Channel identity (no `agent` override) but its child model request is narrowed to a
  read-only tool catalog, so mutating tools (`file_write`/`file_edit`, node mutations, `bash`,
  `skill`, `Agent`/`AgentSend`/`AgentStop`, config write, `dream`) are **absent** rather than
  merely denied at call time. The read-only set is the skill's declared `allowed-tools`
  (`node_search`/`node_read`, `file_read`/`file_glob`/`file_grep`, `web_search`/`web_fetch`,
  `recall`) filtered through the exhaustive `AgentToolActionKind` read-only partition
  (`readOnlyAgentToolNames`, `src/core/agentPermissionModel.ts`); the runtime-only
  `readOnlyIsolated` flag is built-in-only and not mutable `SKILL.md` frontmatter. As part of
  this, the skill execution DSL is renamed `context: 'inline' | 'fork'` →
  `execution: 'inline' | 'isolated'` on `SkillDefinition` (legacy `context: fork` still parses
  as `execution: isolated`; invalid values now throw and the loader skips the skill), and the
  live permission classifier is refactored to derive every tool's action kind from a single
  `AGENT_TOOL_ACTION_KIND_PROFILES` source — making `operation_history` action-sensitive
  (`list`→`outline.read`, `undo`/`redo`→`outline.edit`, no longer auto-allowed) and splitting
  `file_write` onto its own `file.write.allowed_file_area` action kind. Spec:
  `docs/spec/agent-skills.md`, `docs/spec/agent-delegation-runtime.md`,
  `docs/spec/agent-tool-permissions.md`.
- **Referenced outliner files become agent-readable (agent-file-model F3, PR #237, cc-2)** —
  closes the lossy input path: an outliner image / attachment node `@`-referenced into a
  conversation used to reach the agent as a node with **no readable bytes**. At send time each
  explicitly-referenced (`referencedNodes`) image / attachment node carrying an `assetId` now has
  its asset-store bytes **materialized** (handle→path) into the agent **scratch** root via the
  same `materializeAgentLocalPath` machinery as a composer attachment — a readable path the agent
  opens with `file_read`, plus a native inline `ImageContent` block for vision. The materialized
  read paths are listed in a hidden `<referenced-files>` reminder
  (`<file node_id title mime size_bytes path inline_image />`); the renderer keeps the `asset://`
  handle for its own display, so only the agent-facing side gains a path. Authorization is the
  explicit reference — an embedded-but-unreferenced asset is never copied. Bounded and
  best-effort: referenced and composer images share one inline-image cap, a `byteSize` pre-check
  skips reading an image that cannot fit the base64 budget, assets de-dupe by `assetId`, an image
  whose metadata yields no canonical mime is recovered by sniffing the materialized bytes, and a
  missing / oversized / unreadable asset (or a failed inline read) is skipped without failing the
  send or dropping the readable path. The input mirror of F1's `file_write` output side. Scope:
  composer send only — a `/slash`-skill or steer turn surfaces the reference marker but not the
  bytes (documented no-op). F3 of `docs/plans/agent-file-artifact-model.md` (F4 ingest bridge
  remains). Spec: `docs/spec/agent-tool-design.md`.
- **Skillify v2 — built-in skill-authoring workflow (PR #230, codex-3)** — the
  built-in `/skillify` skill body is reworked from a short 6-step note into a
  structured 7-step Tenon-native workflow: understand-before-asking (no
  over-interview), choose the skill path (`~/.agents/skills/<name>/SKILL.md` for
  personal or the workspace `.agents/skills` path for repo skills; directory-name
  identity, no `name:` frontmatter), draft the supported `SKILL.md` shape, keep
  create vs update distinct (read-first + focused `file_edit` on updates), treat
  `allowed-tools` as an authored runtime contract (the tools used to author a
  skill are not the future skill's preapproval; broad grants are flagged),
  preview and confirm via `ask_user_question`, then write and explain trust
  state. Reinforces — does not relax — the existing skill-write safety floor
  (ordinary `file_write`/`file_edit`, no model-facing CRUD tool; born unratified,
  so model-invocable only after exact-byte acceptance). Spec:
  `docs/spec/agent-skills.md`.
- **Async Channel message bus (PR #231, cc)** — multi-agent Channels now behave
  like an IM group instead of a special case of the single-run DM composer. An
  addressed `agent_send_message` **returns on acceptance** (the user message is
  persisted and the `@agent` turns are enqueued + projected) rather than blocking
  until the addressed runs finish; the runs drain asynchronously and one deduped
  per-conversation watcher emits the final idle state. The Channel composer stays a
  pure **Send** (Stop/Steer remain DM-only; per-run stop lives in the activity
  overlay), you can navigate away from or leave a Channel while its runs proceed,
  and a delivered in-Channel peer reply bumps the conversation's unread **badge
  only** (new `channel_reply` notification kind — a count, not an OS ding). Each
  running Channel agent's live composing text stays visible in a **per-run detail
  view**, retained off the shared log so concurrent runs never interleave and the
  transcript stays whole-utterance. Internally the overloaded projection
  `isStreaming`/`streaming` splits into mode-specific `dmRunActive`/`dmStreaming`
  (DM composer) vs `channelRunsActive`/`channelActivityEntries[].streamingText`
  (N concurrent Channel runs). No DM behavior change. Spec:
  `docs/spec/agent-architecture.md`, `agent-progress.md`,
  `agent-event-log-rendering.md`, `commands.md`.
- **Agent app-owned workdir + relocated scratch (PR #229, cc-2)** — the agent's
  single overloaded local-file root is split into two app-owned roots resolved at
  startup (`agentLocalRoot.ts`): a **workdir** (`<userData>/agent-workdir` in both
  dev and packaged — the agent's cwd, `file_*` root, and where its own outputs land)
  and a **scratch** sibling (`<userData>/agent-scratch` — materialized attachments,
  web-fetch binaries, bash overflow logs, PDF page images). The `process.cwd()`
  default is **dropped** (a dev clone is no longer the agent's file area, the source
  of stray repo files; a packaged Finder launch can no longer make `/` the area);
  `LIN_AGENT_LOCAL_ROOT` stays the explicit dogfooding opt-in. The allowed file area
  is now the two roots, **asymmetric by access** — the agent may **read** workdir ∪
  scratch but **write** only the workdir — enforced in both the file-tool resolver
  (`resolveWorkspacePath`, keyed by a `'read'`/`'write'` access) and the permission
  engine (a scratch read is `allowed_file_area`; a scratch write classifies outside).
  Scratch never appears in `file_glob`/`file_grep` default listings; it is reclaimed
  by a 7-day mtime TTL swept best-effort once per launch (`pruneAgentScratch`), not
  GC'd with the conversation. Preview/open trusted roots and the user-attachment
  staging dir include scratch. F2 of `docs/plans/agent-file-artifact-model.md`. Spec:
  `docs/spec/agent-tool-permissions.md` + `agent-tool-design.md`.
- **PDF file preview (PR #227, codex)** — the file-preview panel now renders PDFs
  to a canvas via `pdf.js`, for every byte-backed source (`local-file`, `asset`,
  `agent-payload`). The renderer lazy-loads `pdfjs-dist` only when a PDF is opened
  (a dynamic-import chunk, not in the main bundle), drives a **bundled same-origin**
  worker (`pdf.worker.mjs?url`, resolved against `import.meta.url` into the app's
  own `assets/` dir — so the packaged `file://` CSP permits it under
  `worker-src` ← `script-src 'self'` with no policy relaxation), and shows compact
  page-navigation + zoom (50–250 %) controls. Bytes are read only through the
  existing `preview_read_bytes` API; XFA is disabled and parse/render failures fall
  back to the metadata renderer. Adds the missing `--breadcrumb-height` design
  token (also fixing the preview header's `min-height`) so the sticky PDF toolbar
  offset resolves. Renderer + i18n (en/zh-Hans) + `pdfjs-dist` dependency; second
  PR of `docs/plans/file-preview.md`. Spec: `docs/spec/workspace-layout.md`.
- **Agent file outputs render as file chips, not raw JSON (PR #224, cc)** — a
  successful `file_write` / `file_edit` now shows an always-visible **local-file
  chip** (basename) below the tool summary — the same `InlineFileReference` the
  agent's prose file references use, so hover-preview and click-to-open into the
  `FilePreviewPanel` come for free from the app-wide `InlineFilePreviewLayer` (a
  produced file reads identically to a referenced one) — plus an **inspectable
  unified diff** in the expand panel, rendered through the shared Shiki `diff`
  grammar. Previously the raw model-visible envelope
  (`{ ok, data: { filePath, structuredPatch } }`) was dumped into the conversation.
  The chip path is read from the persisted model-visible content (not
  `result.details`, which the render projection drops), so it survives a reload.
  `file_write` gains an icon (`FilePlus2`) and verb; raw input/output JSON is hidden
  for successful file tools (error results keep it). Renderer + i18n (en/zh-Hans)
  only — no tool-protocol or permission change. Implements F1 of
  `docs/plans/agent-file-artifact-model.md`. Spec:
  `docs/spec/agent-event-log-rendering.md`.
- **Tana-style References experience (PR #208, codex-3)** — every `NodePanel`
  whose root node has at least one linked reference or unlinked textual mention
  now shows a bottom **References** footer (collapsed by default, hidden when
  there is no linked reference). One canonical derivation
  (`src/core/references.ts` `buildReferenceSummary` over `byId` →
  `byTarget` + `countsByTarget`) feeds the footer
  (`src/renderer/ui/BacklinksSection.tsx` via
  `src/renderer/state/referenceSummary.ts`), the `References` system field /
  `sys:refCount`, the agent `get_backlinks` projection, and search
  `LINKS_TO` / `WITH_REFS`, so those backlink paths stop drifting. Linked
  references cover tree reference nodes, inline node references, and
  reference-field values; **unlinked mentions** are exact, token-boundary,
  Unicode-aware title matches rendered as per-occurrence rows with a `Link`
  action that converts just that range into an inline reference through the
  normal command path (revalidated against current content before the write).
  The collapsed counter shows the linked count (matching `sys:refCount`); the
  expanded detail reads `N references · M unlinked mentions`. Performance: the
  linked summary is memoized per projection frame (`WeakMap` on `byId`) and the
  O(N×titles) unlinked scan is deferred to expand and scoped to the single
  focused target, so no per-frame or per-sort-comparison document scan. Spec:
  `docs/spec/ui-behavior.md`. *(Known trade-off: a node with only unlinked
  mentions and no linked references shows no footer.)*
- **File preview panel (PR #210, codex-4)** — workspace panes generalize to a
  `PanelView` union so the outliner and a new `file-preview` view share one pane
  host and Back/Forward history. A shared `PreviewTarget` /
  `PreviewSourceDescriptor` protocol (`src/core/preview.ts`) plus four
  main-process preview IPC commands (`preview_resolve_source` / `_read_text` /
  `_read_bytes` / `_list_directory`, capped at 1 MB text / 20 MB bytes / 200 dir
  entries) resolve sources for local files (reusing the trusted-root gate, with
  per-child re-validation on directory listing), Lin assets, and agent payload
  refs. Agent-payload reads go through replay-state-scoped, run-isolated APIs and
  never expose payload filesystem paths to the renderer. The panel renders
  directory / image / text+code (Shiki) / Markdown (`react-markdown` +
  `remark-gfm`) / CSV-TSV / fallback-metadata, wired from inline local-file refs,
  attachment rows, agent inline file refs, and persisted tool-output rows (the
  tool-output entry threads the payload's own run scope so run-scoped outputs
  preview correctly). Playwright's dev-server port is now
  `PLAYWRIGHT_PORT`-configurable so parallel clones don't reuse a sibling's
  renderer server. `workspace-layout` spec synced in-PR; the `file-preview` plan
  stays `in-progress` (PDF / media / Office / URL renderers remain open). Gate
  (main): typecheck + test:core (914 pass / 0 fail) + test:renderer (419 pass / 0
  fail) + modified e2e specs (8/8) green; visual verification (markdown +
  directory, light + dark) done.

- **Agent Channels: per-agent POV inspector (PR #212, M3-C)** — a read-only,
  derived view of *what a given agent member actually sees* in a Channel,
  reachable from the Channel members popover. It renders that member's §8 POV
  flatten (own turns verbatim, the user and other agents coalesced into
  identity-preambled user-role blocks) plus its read-only memory briefing
  (`<self>` + co-member `<principal>` zones). The runtime turn assembly and the
  inspector now consume **one shared derivation**
  (`deriveAgentPovProjection(state, agentId, …)` in `src/core/agentChannel.ts`),
  so the inspector can never drift from the real model input; runtime calls pass
  an explicit `addressedByMessageId` (incl. `null`) while the inspector falls
  back to the latest addressing boundary. The inspector **stores nothing, emits
  no events, and never records memory access** (a dedicated read-only briefing
  path with `recordAccess: false`, refreshed only on member/memory/dream changes
  and coalesced); cross-principal isolation reuses the existing membership gate.
  Specs synced in-PR (`agent-architecture` POV row ✅, `agent-data-model` §8
  "one derivation, two consumers"); the `agent-pov-projection` plan is archived
  `done`. Follow-up cleanup (direct to `main`): the streaming-preview
  `textFromContent` helper is restored to text-only and the inspector gets its
  own `inspectorTextFromContent` (thinking/tool-call/image/payload placeholders),
  and the inspect button is gated on `povInspectors[agentId]` so it no longer
  renders as a no-op in single-agent Channels. Gate (main): typecheck +
  test:core (917 pass / 2 skip / 0 fail) + test:renderer (418 pass / 0 fail) +
  POV inspector e2e (light + dark) green; visual verification done in both
  themes.

- **Agent memory: hybrid retrieval for `recall` + briefing co-citation (PR #211)** —
  the last unit of the `agent-memory-realignment` program (PR-4). The deliberate
  `recall` path graduates from the old private lexical top-N scorer to a
  rebuildable **hybrid ranker** in `src/core/agentMemoryRetrieval.ts`: BM25-class
  lexical relevance × D1 retrieval strength, plus query-time `sources[]`
  co-citation **association expansion** — entries that share an episode/stream
  source with a strong lexical hit surface even when they paraphrase the query
  (the spreading-activation-lite the plan called for, bounded by group size and
  seed score). The resident briefing routes through the same module's **cue-less**
  chronic-activation path: retrieval strength stays the base signal while
  co-citation lightly boosts facts that travel with already-accessible entries;
  it does not use the current turn as a cue, so **automatic association stays
  deferred**. The `recall` tool surface is unchanged (`query`, `limit`,
  `include_evidence`, `max_chars`). PM embedding gate closed as option (c): **no
  embeddings** — no local model, provider call, dependency, stored field, graph,
  or sidecar index; local/API embeddings remain separately ratifiable later.
  Latency (synthetic 1,000-entry probe): briefing chronic activation 0.631 ms avg
  (per-turn, stays sub-ms); deliberate `recall` hybrid query 11.85 ms avg. Specs
  synced in-PR (`agent-data-model` Retrieval row, `agent-architecture` § memory);
  the `agent-memory-retrieval-upgrade` plan is archived `done`. Covered by a
  regression eval fixture (hybrid strictly beats the old lexical baseline on
  co-cited paraphrase top-k hit-rate) and an `AgentEventStore.queryMemoryEntries`
  integration test pinning the production query path. Gate (main): typecheck +
  test:core (914 pass / 2 skip / 0 fail) green; contained core change, no
  protocol/UI/security surface.

- **Agent conversation UX: roster DMs + named Channels (PR #207)** — Feature A of
  the agent-conversation UX plan. Generalizes the canonical DM from the single
  built-in assistant to **one immutable find-or-create DM per configured agent**
  (keyed by `{user, agentId}`); the switcher splits into **Direct Messages** (the
  agent roster, including never-chatted agents) and **Channels** (named rooms with
  a member avatar stack + unread state). New Channel follows the Slack-shaped flow
  — name the room first; invited agents and the opening message are both optional,
  and the coordinator stays an implicit runtime participant rather than a locked
  invitee. DM → Channel escalation ("Create a Channel with <Agent>…") preselects
  the source agent, focuses the name field, writes a system provenance line, and
  never shares the private DM transcript. Each agent's DM **runs as that agent**
  (capability binds to the identity — its model, tools, skills, memory) under a
  DM-specific 1:1 system prompt distinct from the Channel-peer prompt; canonical
  DMs cannot be renamed, deleted, or membership-edited. Channel member management
  moved into a **Members popover** (coordinator + in-flight-run removal guards).
  The conversation index now carries list-projection fields (member roster, unread
  count, message count, latest visible snippet + timestamp) so opening the switcher
  stays index-only — no per-conversation log replay. The runtime command contract
  prefers `title` (legacy `goal` kept internally for existing event/index storage).
  Gate (main): typecheck + test:core (910) + test:renderer (418) + agent-composer
  e2e (DM roster / named-Channel create / DM escalation / anchored geometry) green,
  light + dark visual verification of the switcher and New Channel dialog. Review
  ran one fix round (DM-specific prompt, index-stored snippet, doc reconciliation);
  a post-merge cleanup dropped a redundant `tool_result.replaced` list-summary
  recompute (it can never change a user/assistant snippet).

- **File attachments (PR #206)** — completes the `file-attachments` feature on
  top of the #204 protocol slice. `create_attachment_node` is wired end-to-end
  (core command + Loro persistence → document service → renderer API → `/attachment`
  slash command and external file drop). Non-image files land as a compact
  attachment row showing a file-type icon (or PDF thumbnail), filename, and a
  metadata line (type · size · PDF page count / media duration), with hover
  actions to open, reveal in Finder, and copy the file. `AssetService` ingest now
  reads regular files by path under a `realpath` jail, sniffs MIME from magic
  bytes (audio/video/zip/text added), derives PDF page count + WAV/MP4 duration
  from the bytes, and renders PDF thumbnails via poppler's `pdftoppm` (optional;
  degrades to the file icon when absent). Asset serving and the open/reveal/copy
  system actions resolve the stored file with `realpath` and reject anything that
  escapes the asset root (covered by a symlink-escape test). Gate: typecheck +
  test:core (906) + test:renderer (418) + the `file-attachments` e2e green, plus
  light/dark visual verification; `/security-review`-class surface reviewed (no
  shell, escaped clipboard plist, jailed paths). Range/streaming media serving
  stays a noted follow-up (whole-file reads today).

- **Parallel Channel runtime (PR #202)** — Channel turns now run concurrently:
  each addressed agent executes as its own `Agent` instance held in
  `conversation.activeRuns`, scoped through an `AsyncLocalStorage` run context (a
  `scopedConversation` proxy resolves `activeRun`/`agent` per run) so per-run state
  never leaks across siblings. A concurrency cap (`CHANNEL_MAX_CONCURRENT_RUNS`)
  plus a pending-turn queue bound fan-out; co-addressee independence (context cut
  at the addressing message) and completion-order landing are preserved, and
  `agent_stop_run` cancels one run without touching its siblings. The conversation
  graph is now **one linear spine per run**: a run's first segment parents to its
  addressing message (so concurrent peers fan out as siblings under it) while every
  later segment parents to the run's own tail — never the shared, concurrently
  moving `selectedLeafMessageId` — so a multi-segment turn (any tool use: tool call
  → tool result → continuation) renders in full for each agent instead of
  collapsing to its last segment, and the same fix keeps runtime replay/next-turn
  context complete. The visible-transcript reconstruction surfaces a non-active
  peer's whole spine. typecheck + core/renderer green.

- **Channel activity area + reply anchors (PR #203)** — Feature D of the
  agent-conversation UX plan. A fixed-height Channel activity rail sits at the
  transcript/composer boundary: each addressed-but-unfinished agent shows its
  identity chip, name, and own true state (`received` / `thinking` /
  `using tools`), overflow collapses to a `+N` count with no layout shift, hover
  reveals a per-entry stop, and clicking opens that run's working-state panel
  keyed by its `messageId`/`runId` (no single global "active agent"). Out-of-order
  assistant replies carry a quiet `↩ "quote"` anchor back to their addressing
  message — rendered only when that message is not the nearest preceding visible
  user message — and clicking it scrolls to and briefly highlights the source.
  `addressedByMessageId` is now persisted on the `run.started` /
  `assistant_message.started` events (and surfaced through the render projection),
  so anchors survive reply finalization and app restart. Adds a run-scoped
  `agent_stop_run` command so an activity-item stop cancels only that addressed
  run while sibling Channel turns continue; the composer stop remains the global
  stop-all path. typecheck + core/renderer/e2e green; light + dark verified.

- **File-attachment protocol slice (PR #204)** — Shared-interface-first protocol
  surface for the `file-attachments` feature (no handlers yet). Adds the
  `attachment` `NodeType` and an `AttachmentNode` shape (`assetId`, `mimeType`,
  `originalFilename`, `fileSize`, `thumbnailAssetId`, `pdfPageCount`,
  `audioDurationMs`, `videoDurationMs` — all optional at the persisted/projection
  layer, mirroring `ImageNode`), extends `AssetMetadata` with the matching derived
  fields, and reserves three command names for the follow-up implementation:
  `create_attachment_node` (document), `pick_attachment_files` and `copy_asset_file`
  (asset). Purely additive; lets parallel agents rebase on the protocol before the
  complete feature lands. typecheck + test:core green.

- **Agent conversation identity, message metadata, and the model chip (PR #201)** —
  Channel assistant rows now carry a deterministic circular identity chip plus a
  speaker name + `@mention` for **every** speaker (including the coordinator),
  derived from the recorded message `actor` and member/definition metadata rather
  than the live roster — a departed member falls back to its saved id/mention. A DM
  header leads with that agent's chip and a quiet `@mention · provider/model`
  subtitle. The transcript inserts gap-based time separators, and right-clicking a
  message opens a native context menu whose **Details** action anchors a popover
  with speaker, timestamp, model/provider, and token usage. The composer model chip
  stops being an inline picker and becomes a stable **display + navigation** control:
  it shows the active provider/model + reasoning and opens the owning settings
  surface (agent profile for authored agents, provider config for the built-in /
  global provider) — the chat surface never mutates provider/model inline.
  Provider-config (its own native window) now owns model + reasoning selection for
  the global provider, including managed providers (Bedrock/Vertex), and settings
  gained deep-link navigation (`category` / `agent`). Specs synced in-PR
  (`agent-architecture`, `agent-event-log-rendering`, `design-system`). typecheck +
  test:core + test:renderer + the touched e2e specs green; design-system token
  guards green; light+dark visual verification at the gate.

- **Cross-agent memory sharing + the cross-principal isolation gate (PR #200)** —
  M3's one genuinely new primitive. In a Channel, each agent member's briefing and
  `recall` now read not just its own pool and the user's but **every co-member
  principal's** distilled self-model — visibility is conversation membership, with
  no publish ACL. The pool list generalizes from `[self, user]` to all co-members
  derived from `conversation.members`; foreign agent pools render as named
  `<principal name="…">` zones, the reader's own as `<self>`. A **hard architectural
  gate** guarantees no principal can dereference another's raw evidence: the single
  choke point is the evidence service (`readMemorySourceEvidence`), which refuses
  any `sources[]` dereference whose owning `principal` ≠ the reader with a typed
  `CROSS_PRINCIPAL_EVIDENCE` error — the distilled `fact` stays available, raw
  transcript never crosses. Cross-principal entries reach the model distilled-only:
  source pointers stripped and the fact secret-redacted at the injection boundary.
  Fresh child sidechains keep their isolation — they inherit user-pool visibility
  but never read the parent agent's pool unless they are actual conversation
  members. The N-pool briefing/recall budget uses a fair round-robin interleave so
  a full self-model can't starve co-member zones. The secret heuristic is now a
  shared helper split into a conservative header-only **detection** set
  (skill-write rejection) and a full-block **redaction** set (memory-fact
  injection), so the skill-authoring gate keeps its original strictness. Specs
  synced in-PR (`agent-data-model`, `agent-tool-design`, `agent-architecture`,
  `agent-progress`, `agent-program`); the `agent-cross-agent-memory` plan is
  archived `done`. Covered by core unit tests: service-level gate refusal, recall
  refusal projection, briefing redaction, Channel positive-share + non-member
  exclusion, end-to-end runtime gate, own-evidence regression + tamper, and the
  detection/redaction split.

- **Memory forgetting + schema activation: chronic activation (PR #199)** — the
  agent memory briefing graduates from "newest 12 facts" to a two-strength
  activation model (Bjork & Bjork's New Theory of Disuse). New `memory.accessed`
  events (`via: briefing | recall`, batched once per turn per principal) feed a
  **rebuildable** projection: **storage strength** never decays, **retrieval
  strength** decays with disuse and governs injection ranking — entries fall out
  of the working set, never get deleted (`invalidate` stays the only explicit
  exit). Deliberate `recall` hits strengthen retrieval far more than passive
  briefing re-exposure (the testing-effect asymmetry). The briefing now renders a
  derived **schema overview** (breadth: topic-cluster labels + counts) ahead of an
  activation-ranked fact budget (depth); calling `recall` with no `query` returns
  that overview as **metamemory** (what the read set knows before digging) instead
  of "recent 8". A hardened resident set cannot permanently starve newly
  consolidated facts: the briefing order reserves periodic **exploration slots**
  for newest/long-unbriefed entries, and briefing access is **throttled to one
  counted exposure per entry per 24h** (recall records every hit). The activation
  projection is memoized per pool version + day bucket on the hot path. Storage
  layout stays at v3 — the change is purely additive (old logs project to empty
  access stats); log compaction folds access stats into two events preserving
  counts and last-access time. Specs synced in-PR (`agent-data-model`,
  `agent-memory-foundations`, `agent-memory-realignment`, `agent-architecture`,
  `agent-progress`, `agent-tool-design`); the `agent-memory-forgetting` plan is
  archived `done`. Covered by core unit tests (rebuild oracle, access throttle,
  anti-starvation ordering, schema overview).

- **Full `ask_user_question` flow (PR #198)** — the structured user-elicitation
  tool grows from the v1 scaffold (PR #153) into its full shape. Answers now carry
  structured **node refs, local-file refs, and attachments** through durable
  pending-question resolution instead of being flattened into answer text, and the
  pending-question card swaps its plain `<textarea>` for a scoped rich answer editor
  (the agent composer editor, gated by per-question `allow_references` /
  `allow_attachments` flags: `@`-mentions, file references, attachments). Path-backed
  answer attachments are materialized through the **same realpath-based local-root
  jail** (`materializePathBackedAttachment`) as the main composer, so the tool cannot
  become a file-read bypass; text/image attachments persist as payload refs before the
  `user_question.answered` event is appended. A new **"Discuss first"** action resolves
  the card with a dedicated `discussed` outcome — it skips required-answer validation,
  returns `answers: []` plus a short `discuss.message`, and hands the model
  instructions to ask a brief clarification in normal conversation (calling
  `ask_user_question` again if structured input is still needed). Attachment management
  is extracted into a reusable `useAgentComposerAttachmentManager` hook shared by the
  main composer and the answer editor. Specs (`agent-tool-design.md` full contract,
  `agent-event-log-rendering.md`, `agent-pi-mono-implementation.md`) and i18n (en +
  zh-Hans) updated in-PR; covered by core, renderer, and e2e tests.

- **Sidebar pinned: drag-to-pin + reorderable list (PR #196)** — the Pinned
  section is now a real HTML5 drag target. Drag any node from the outliner onto
  it to pin it; the drop handler sets `dropEffect = 'move'` to match the outliner
  source's `effectAllowed = 'move'` (a `'copy'` mismatch makes the real browser
  silently cancel the drop on release — a class of bug `dispatchEvent`-based e2e
  can't catch). The empty Pinned section became a dashed drop zone reading "Drag
  to pin nodes" (en + zh-Hans) that deepens its border + shows a faint fill on
  dragover, replacing the flat right-click hint. Pins insert at a position, not
  just append: dragging over a pinned row shows a single neutral insertion line
  (reusing the outliner's `--drop-line` token) before/after the row by its
  vertical midpoint, and pinned rows are themselves drag-reorderable within the
  list via a dedicated `PINNED_NODE_REORDER_MIME` (distinct from the add-a-pin
  outliner MIME). `pinNodeAtIndex` handles both add-at-index and reorder-to-index
  (remove → re-insert with an index adjustment when the dragged item sat before
  the target, so the drop lands where the insertion line showed). Sidebar layout
  and the alignment guard are unchanged. Covered by a new renderer unit test
  (`workspacePinnedNodes.test.tsx`: insert / append / reorder up+down / no-op /
  unknown-node) plus an e2e drag-to-pin case. Known minor follow-ups (non-blocking,
  recorded on the PR): expanded-pin drop treats the whole block as the unit;
  hovering the section title appends; the 100-pin cap eviction differs from
  `togglePin`.

- **Local error observability (PR #194)** — a failure anywhere in the app now
  lands as a structured, deduplicated record in one local log, legible without
  reading the terminal. A single main-process `reportError({domain, severity,
  code?, message, context?, error?})` choke point backs a diagnostic log built on
  the shared `AppendOnlySeqLog` primitive — extracted verbatim from
  `agentEventStore.ts` into `src/main/appendOnlySeqLog.ts` so conversation/run/
  memory and diagnostics share one append-only mechanism (#152 spirit). Records
  are Sentry-event-shaped and upload-ready; the write boundary scrubs every report
  before it lands: an allow-list of structured context keys only, `source` paths
  reduced to non-identifying labels, a `stackHash` instead of raw stacks,
  message/context length caps, and fingerprint dedup that collapses a flood into
  one `count`ed record. The log is compacted to the most recent 200 fingerprints.
  Safety nets: main installs `uncaughtException` (fatal record + bounded flush,
  then exit) and `unhandledRejection` (fatal record, keep running); the renderer
  reports `error`/`unhandledrejection` from both the main world (renderer entry)
  and the preload isolated-world early net over a new `lin:report-renderer-error`
  IPC bridge, duplicates collapsed by fingerprint. Background paths that
  previously only `console.warn`-ed (Dream extraction, scheduled command failures,
  child-run ledger appends, memory reminder, storage sentinel/probe) now report
  through the same path, and `emitError` foreground sites report in addition to
  the existing in-conversation error event. The only user-facing surface is
  passive: Settings → General → Diagnostics exposes Reveal (open the log in
  Finder) and Export (a JSON artifact with minimal environment) — no dashboard,
  badge, or toast. Local-only, no egress; the hand-off to us is user-initiated. A
  real-Electron smoke test verifies renderer errors/rejections reach the log under
  `contextIsolation` + `sandbox`. Spec: `docs/spec/error-observability.md`.
- **Sidebar pinned nodes (PR #191)** — the sidebar's Pinned section is now real:
  pin/unpin any node from the outliner row context menu or from a new reduced
  sidebar row context menu (Open / Open in split pane / Pin–Unpin). Pins are
  renderer workspace chrome, not document state — persisted in localStorage
  (`lin-outliner:workspace-layout:v3:pinned`, insertion order, 100-pin cap, no
  undo/redo participation) and sanitized against the live document on restore so
  deleted ids and duplicates are dropped. A pinned node moved to Trash stays
  listed with a line-through label until the id disappears from the projection.
  Pinned entries render as regular workspace tree rows (expandable, including a
  pinned workspace root). Internals hardened at the review gate: pin state is
  compared explicitly in the `OutlinerItem` memo comparator (stale-closure
  Pin/Unpin inversion fixed), node liveness reads the incrementally-patched
  `index.byId` instead of rebuilding a full id Set per keystroke, and the menu
  dismissal effect + `isRecord` guard were extracted to shared modules
  (`useDismissibleOverlay`, `state/persistence.ts`) replacing three duplicated
  copies. Empty-state hint copy updated (en + zh-Hans).

- **Multi-agent Channels: membership, @-routing, and peer replies (PR #179, M3-A)** — a conversation
  can now hold multiple agent members and run them as an IM group chat. Membership is event-sourced
  (`member.added`/`member.removed`; the conversation-index/meta folds consume membership events only)
  and user-reachable via the header "+" member menu; adding an agent to a DM spawns a seeded Channel
  (the canonical DM is never mutated). Routing is one rule: an explicit user `@member` runs every
  addressed member; no `@` runs the coordinator (the default addressee); an agent reply's `@member`
  hands off — routed from the persisted final-segment `assistant_message.completed.addressedTo`, so
  the durable log and actual routing always agree. Peer turns execute under the member's own
  identity, system prompt, tools, and memory pool, reading a per-member POV flatten with an
  independence cut (context = the log up to the @-ing message + the run's own records; same-round
  co-addressees mutually invisible). **IM delivery semantics (PM-ratified mid-PR, superseding the
  relay budget):** user messages during an active round queue (persisted at routing time; a quit
  flushes leftovers into the log unrouted so nothing typed vanishes); Channel replies land whole
  behind a typing indicator (DM streaming + steer unchanged); hand-off chains are unbounded with
  user stop as the only circuit breaker (stop writes a thread trace). Renderer: member strip +
  typeahead, third-person actor badges that survive membership changes, queued bubbles, typing
  indicator. The gate ran four rounds (10 findings → 4 required on the re-ratified semantics → 1
  recovery-scoping defect → GO) with the DM path regression-verified seam-by-seam and visual
  light+dark verification; final suites typecheck · `test:core` 837/0 · `test:renderer` 405/0 ·
  e2e 294/294. Deferred follow-ups recorded on the PR (queued-bubble fidelity, add-member
  mid-round guard asymmetry).

- **Skill acceptance: one-click user trust closes the ratification loop (PR #175)** — implements the
  PM-ratified `agent-skill-acceptance` plan (PR A + slimmed PR B; plan archived `done` in the PR). #174
  left agent-authored skills permanently unratified unless the user hand-edited the file; the Skills tab
  now shows a "pending acceptance" chip with an always-visible **Accept** button (quiet neutral
  `.settings-row-button` recipe, shared with provider Configure per B9), a row-menu **Revoke acceptance**,
  and a row-menu **Undo last agent edit**. One trust record per skill —
  `{agentHash, acceptedHash, previousVersion}` in `agent-skill-provenance.json`, keyed by resolved file —
  and `ratified` stays a pure derivation (unratified iff `agentHash === currentHash` and not accepted), so
  accept / revoke / hand-edit / agent re-patch all fall out with no special cases; an agent re-patch of an
  accepted skill drops it back to unratified (byte-keyed). **Undo** restores the gateway-captured pre-write
  content through the same skill-write validator, strictly one-shot, and may only overwrite the agent's own
  bytes — the action re-reads the file and refuses if a user hand-edit followed the agent write. **Accept
  binds to the bytes the user saw**: `agent_accept_skill` carries the rendered `expectedHash` and refuses
  on mismatch (closes the render-to-click TOCTOU, the one path where agent bytes could have been ratified
  sight-unseen). Trust actions propagate to every live session's skill registry (the Settings panel runs
  sessionless over the same persisted store — previously a sessionless panel failed open to "all
  ratified"). `/skillify` output becomes model-invocable, still born unratified. Acceptance is a UX
  completion plus a positive trust fact, NOT a new security boundary: store loss (and a user rename/move,
  which orphans the path-keyed record) still fails open to ratified, documented in
  `docs/spec/agent-skills.md`. Gate ran 2 rounds (protocol + trust surface + UI): r1's 5 should-fix (undo
  hand-edit destruction, conditional-skill resolution, dead session-propagation branch, spec rename
  over-claim, accept TOCTOU) all fixed and independently re-verified on the merged tree — typecheck ·
  `test:core` 799/0 · `test:renderer` 389/0 · agent-settings e2e + design guards 33/33 · light+dark visual
  verification twice (pre and post CSS dedup).
  ([#175](https://github.com/relixiaobo/lin-outliner/pull/175))

- **Scheduled command nodes (PR #165)** — a new `command` NodeType whose content is a natural-language brief
  to the agent; arming its schedule field (one field carrying both *when to start* and *how to repeat*, an
  endpoint + optional `RRULE`) makes it run on an anacron-style schedule, with **Run now** for manual fires.
  A fire spawns a triggered subagent run (optionally a chosen `commandAgent`) that posts back into a per-command
  delivery conversation, rendered with a subagent boundary. The **user-only bright line** (only the user can
  arm a schedule) is enforced inline in `setCommandSchedule`, keyed to the `node.type === 'command'` invariant.
  Review-gate hardening landed with it: **at-most-once crash recovery** (a `sysLastAttemptAt` marker persisted
  before the run + a startup reconciliation skips an interrupted occurrence instead of re-firing its
  non-idempotent side effects), the fire watermark is **agent-barred** (`markCommandFired`/`markCommandAttempted`
  reject `agent` origin — symmetric with the arm gate), failure **backoff is measured from the failure moment**
  (not the sweep start, so the 30s→1h ladder can't collapse into a 60s retry loop), and **unattended runs have
  no interactive approval channel** — a tool needing approval is denied-and-surfaced rather than hanging the
  unwatched run, while globally always-allowed tools still run. The agent-tool-host origin stamp was flipped to
  `{ ...meta, origin: 'agent' }` so a caller can never override the forced origin. Verified on the merged tree:
  typecheck + `test:core` 766/0 + `test:renderer` 389/0; merged with two trivial import-union conflicts
  resolved at the gate (it predated #166/#167). ([#165](https://github.com/relixiaobo/lin-outliner/pull/165))

- **Agent authoring & management (PR #167)** — create, edit, duplicate, enable/disable, and locate your
  own **agent definitions** (`AGENT.md` persona files) from Settings → Agents, without hand-editing files
  or restarting. One **Form ⇄ Raw editor** serves every agent (built-ins are read-only with "Duplicate to
  my agents"); you choose global (`~/.agents/agents`) vs workspace (`<project>/.agents/agents`) storage, and
  changes **hot-reload** into the subagent picker and list. A new `AGENT.md` format module
  (`src/core/agentMarkdown.ts`) round-trips the serialize/parse pair, and `disabledAgents` is now keyed on
  the full agent identity so same-named agents from different sources disable independently. The **model
  never reaches the write surface** — authoring is user-driven only (mirrors the closed memory-write
  surface). Also unifies the **subagent system prompt**: a fresh subagent now reuses the shared core of the
  main system prompt (capabilities / tool conventions / safety) plus a headless directive, and built-in
  `general` collapses to a zero-persona default. *Note:* re-keying `disabledAgents` from name to identity is
  a stored-settings change with no migration — a pre-existing disabled agent re-enables once (wipe dev
  `userData`), per the pre-release no-back-compat policy.
- **Agent notifications + off-floor attention delivery (PR #166)** — long-running background tasks and
  subagents no longer go silent. Per-conversation unread is event-sourced (`notification.created` /
  `notification.read`) and folded incrementally onto the persisted conversation index, so a badge is **seeded
  on launch** for listed conversations before they are reopened. Optional **OS banners** fire only from the
  main process (`new Notification` — the A2/A3 seam is untouched) behind a **default-OFF** opt-in preference
  (consolidated in `appPreferences.ts`), are suppressed only when the user can actually see the conversation
  (main layers a window-focus check over the renderer-reported **viewed conversation**, which is dock-open and
  CSS-collapse aware), and deep-link to the conversation on click. Durable mark-read is renderer-driven on
  genuine opens only (never a config reload), and its `notification.read` cursor takes `throughSeq` **inside**
  the serialized append so the incremental unread fold can never drift from the replay reducer when a delivery
  races a read. *Needs-input is intentionally deferred* — a subagent surfaces a clarification through its
  terminal result, not a mid-run prompt.
- **Agent-owned subagent memory + `dream` trigger tool (PR #164)** — extends the Dream milestone to
  subagents. Run records, task projections, tool results, and persisted transcript envelopes now carry an
  explicit **execution + memory-owner identity**: a fresh typed subagent routes its `<agent-memory>` reminder,
  `recall`, and scheduled Dream through the **called agent** owner (its own durable memory line); a fork keeps
  the **parent** owner and Dream skips the copied parent-context prefix via a persisted boundary index (not a
  content scan). Two new shared modules — `agentSubagentIdentity.ts` (single owner-resolution seam) and
  `agentSubagentTranscript.ts` (transcript decode + `${runId}:message:N` addressing) — single-source the logic
  across reminders, recall, and Dream; Dream watermarks and recall evidence key on the content-addressed
  `payloadId` and the Dream-pinned `source.eventId`. Adds a model-visible **`dream` tool** — a *trigger-only*
  request for a runtime-owned Memory Dream (the model cannot specify facts; `reason` is not accepted; gated
  `agent.memory.dream`, in `ALLOW_FORBIDDEN_ACTIONS`, always asks) — and a **Dream chat-feedback** boundary
  (`AgentDreamBoundary`) emitted by both `/dream` and the tool path. The memory-write surface stays closed
  (no model-written facts). Also invalidates shape-stale agent checkpoints to prevent a `dream.finished`
  tail-replay crash. Gate (two high-effort review rounds): all prior findings + three confirmed
  isolation/UX findings fixed (fresh-subagent workspace scope, multi-workspace Dream partition, benign
  concurrent-Dream skip, zh-Hans 886/886, `dream` boundary symmetry, dead `reason` removed) + a latent
  stale-checkpoint crash; typecheck + `test:core` 686/0 + `test:renderer` 361/0. Residual low items tracked in
  `agent-dream-followups` (f)/(g). ([#164](https://github.com/relixiaobo/lin-outliner/pull/164))

- **Agent Dream — scheduled reflective memory consolidation (PR #163)** — Dream prerequisite ③, the thin
  assembly that makes Dream a real, visible capability. Memory write-back now happens in an agent-level
  **reflective run** triggered by a built-in **daily schedule** or a manual **`/dream`** (replacing #159's
  per-turn inline extraction); during waking hours the agent still only reads durable memory. `fire(agent,
  source)` gates the run: a per-agent in-flight **lock**, **provider/online** check, a **1,000-rendered-char**
  new-evidence minimum on the auto path (`/dream` bypasses → consolidate-only when nothing is new). Evidence
  is raw conversation events since a **per-conversation watermark cursor** (persisted in a new `dream.completed`
  memory event with processed ranges + change counts); `memory.*`/`dream.*` are excluded so a Dream's own
  writes never re-trigger it. The run reuses #159's no-tools `completeSimple` + `applyDreamMemoryActions`
  (isolation/provenance/dedup intact: `read-only-global` writes nothing, `isolated` stays scoped). Dream runs
  are agent-anchored (`{ type: 'agent' }`, PR #162) and indexed in a per-agent run index, kept out of every
  conversation index/replay/delete cascade. The task panel gains a shared render task projection (`taskIds` +
  `entities.tasks`) and renders Dream as a **read-only** row (trigger · processed count · memory-change count
  · time); subagent open/stop stays subagent-only. Protocol additions are additive (`reflective` run kind,
  `schedule` trigger, `dream.completed`). Gate: typecheck + `test:core` 680/0 + `test:renderer` 358/0; four
  finder passes (gating/watermark, agent-anchored persistence, task projection, security/isolation) clean;
  light/dark visual verification; one visual finding (Dream meta row truncation) fixed before merge.
  Follow-ups tracked: Settings schedule UI, large-backlog chunking, precise cross-conversation provenance.
  ([#163](https://github.com/relixiaobo/lin-outliner/pull/163))

- **Generalize the agent run anchor (PR #162)** — Dream prerequisite ②, an interface-first protocol change
  on the agent run-meta surface. `AgentRunMeta` replaces its flat mandatory `conversationId` with the
  PM-ratified `anchor: AgentRunAnchor` discriminated union (`{ type: 'conversation'; agentId; conversationId }`
  | `{ type: 'agent'; agentId }`), plus a `conversationIdOfRun(meta)` accessor; `RunStartedEvent` gains an
  optional `anchor`. This lets a future agent-level Dream run exist without a fake `conversationId`. Behavior
  is fully neutral for every current run (all conversation-anchored): the store projection extends the core
  type, `normalizeRunMeta` keeps a legacy-read shim (old flat `conversationId` reads as a conversation
  anchor), and BOTH the live-append and rebuild conversation-index paths filter agent-anchored runs via
  `conversationIdOfRun` (so an agent-anchored run never leaks into a conversation's index, replay, or
  `deleteConversation` cascade). No agent-anchored producer ships yet (that is Dream prerequisite ③). Gate:
  typecheck + `test:core` 676/0 (incl. agent-anchored representability + legacy-rebuild + live-append and
  rebuild exclusion tests); one review finding (the live-append path missed the agent-anchored filter the
  rebuild path had) fixed before merge. ([#162](https://github.com/relixiaobo/lin-outliner/pull/162))

- **Shared `date` schedule primitive (PR #161)** — `src/core/dateSchedule.ts`, the pure decision kernel
  for scheduled agent work (Dream prerequisite ①, shared with `agent-scheduled-routines`). Parses a
  canonical `<endpoint> RRULE:...` schedule over a bounded RRULE subset (`FREQ` daily/weekly/monthly/yearly,
  `INTERVAL`, weekly `BYDAY`, inclusive `UNTIL`); exposes parse/format, `mostRecentDateScheduleDue` (the most
  recent occurrence ≤ now, for anacron-style catch-up/coalescing) and `shouldFireDateSchedule` (fire-once
  decision against a `lastSuccessAt` watermark). DST-safe (occurrences reconstruct local wall-clock; invalid
  calendar days like the 31st / Feb 29 are skipped per RFC 5545). No runtime/heartbeat wiring, no generic
  date-field `RRULE` support, no `RunMeta` change yet — those stay in `agent-scheduled-routines` / later Dream
  steps. Gate: typecheck + `test:core` 672/0 (incl. a `TZ=America/New_York` DST spring-forward regression and
  strict-`INTERVAL` rejection tests); two review findings (a monthly/yearly DST-gap drop, lax `INTERVAL`
  parsing) fixed before merge. The plan also records the **PM-ratified `AgentRunAnchor` discriminated union**
  for the upcoming prerequisite-② (`RunMeta` anchor) interface PR. ([#161](https://github.com/relixiaobo/lin-outliner/pull/161))

- **Agent task panel for subagent runs (PR #160)** — a dedicated side panel listing the conversation's
  subagent runs, opened from a Tasks toggle in the agent composer chrome (mutually exclusive with the
  subagent-details pane). `buildAgentTaskEntries` derives the list from the projection
  (`subagentRunIds` + `entities.subagents`), titled by description→name→id, subtitled
  `contextMode · subagentType · N messages · time`, and totally/stably ordered by status rank
  (running→failed→stopped→completed) then `updatedAt` desc then id. Each row opens the subagent transcript
  or, for a running subagent, stops it through `agent_subagent_stop` (guarded; errors surface as a
  `role="alert"`). New `agent.task.*` i18n keys (en + zh-Hans). Gate: typecheck + `test:core` 661/0 +
  `test:renderer` 356/0 (incl. new `agentRuntimeStore`/`agentSubagentUi` coverage) + light/dark visual
  verification. Follow-up a11y polish landed on `main` after merge: the Tasks toggle's `aria-label` now
  carries the running count (the badge was visual-only) via a new `agent.task.openPanelActive` key, and the
  running/idle summary is an `aria-live="polite"` region so screen readers hear count changes.
  ([#160](https://github.com/relixiaobo/lin-outliner/pull/160))

- **Agent M1: canonical DM + Channels, ask_user_question, self-maintenance, skills self-authoring (PR #153)** —
  a clean-cut M1 build across the agent stack: a canonical single-agent DM plus a Channels vocabulary
  (restore finds/creates the built-in assistant DM; public list/rename/delete operate on Channels; default
  channel deletion falls back to the DM); a mixed-resolution compaction backbone (compaction events carry
  explicit source ranges; bounded mixed-resolution model context); `ask_user_question` v1 (main-agent-only
  structured-question tool with persisted requested/answered/cancelled events, runtime pause/resume, a
  renderer pending-question card, and restart-safe replay that now re-appends the tool result so the blocked
  call resumes); self-maintenance v1 (`runtime_status` / `config` / `doctor` tools with scoped permission
  defaults and audited `config.change` events); skills self-authoring v1 (built-in `/skillify`, governed
  `.agents/skills` writes through `file_write`/`file_edit`, validation against risky escalation, hot registry
  reload, and `skill.created/patched/replaced` audit events); and memory isolation modes (global / isolated /
  read-only-global) wired through runtime config and the memory recall/write/update/forget paths. Gate:
  typecheck + `test:core` 661/0 + `test:renderer` 356/0 + `test:e2e` 288/0 + 7-angle high-effort review.
  The review surfaced 10 findings — all fixed before merge (758c61d) with regression tests, the load-bearing
  one being that a runtime-settings refresh dropped the four M1 tools from the live tool set after the first
  turn; a follow-up on `main` routes the restart-replay tool result through the shared `agentToolResult`
  envelope so it renders identically to the live result the model sees.
  ([#153](https://github.com/relixiaobo/lin-outliner/pull/153))

- **Inline local-file references: hover preview + click-to-open (PR #132)** — agent chat messages can
  now carry `[[file:name^/abs/path]]` references that render as an inline chip (file icon + name); hovering
  shows a preview popover (native icon / image thumbnail, type, size, path, modified date) and clicking
  opens the file with the OS default app. The capability lives entirely in the native host: both new IPC
  handlers (`lin:preview-local-file-reference`, `lin:open-local-file`) re-validate the renderer-supplied
  path through `resolveTrustedLocalFileReference` — `realpath` on **both** the candidate and each allowed
  root (symlink-escape safe), confinement to the agent local root via `isPathInside`, filesystem-root
  rejected, and `\0`/relative/non-string rejected — so the renderer's DOM attributes are never trusted.
  Open is additionally gated by `isSafeLocalFileOpenTarget`: an executable-bit check plus a denylist of
  executables / installers / app + automation bundles **and** location/shortcut files
  (`.fileloc`/`.inetloc`/`.url`/`.webloc`/`.desktop`, `.scptd`/`.action`/`.wflow`/`.shortcut`) that would
  otherwise let a click escape the root by indirection. Opening requires a real user click (preview never
  opens; previews fire one-at-a-time on hover with a 450ms delay); references render as `#`-fragment
  anchors so they never trigger navigation. Gate: typecheck + `test:core` 609/0 + `test:renderer` 354/0 +
  3-angle review (security / renderer-correctness / cross-cutting) + light/dark visual verification; the
  initial path-confinement hardening shipped on the branch, and the location-file denylist gap found at
  the gate was fixed + regression-tested before merge. ([#132](https://github.com/relixiaobo/lin-outliner/pull/132))

- **Outliner expansion survives reload (renderer-local view state) (PR #124)** — each root-node page
  now remembers its expanded rows and revealed hidden-field keys across reload / reopen, instead of
  collapsing back on every reload. A new renderer-local store (`outlineViewState.ts`) persists, per root
  node id, the expanded node ids + hidden-field keys in `localStorage` (scoped to that root's structural
  subtree; references are **not** followed into other roots; pruned to the 500 most-recent roots). It is
  pure **view state** — not core commands, undo/redo, import/export, or agent-editable content. Because
  the renderer keeps one global `expanded` set shared by every split pane, restore is **additive**: it
  merges a root's saved expansion in and never clears rows another pane may be showing; persistence
  writes one entry per visible outliner pane root, and a same-day multi-pane layout (PR #123) replays
  expansion for every restored pane on boot. Gate: re-review after a first pass — all six split-pane /
  scope / spec findings fixed (cross-pane collapse, multi-pane boot restore, non-active-pane persist,
  reference-scope bleed, thin tests, spec drift) — + typecheck + `test:renderer` 350/0 + 3 unit
  (additive merge, reference-scope isolation, colon-id round-trip) + 2 e2e (per-root reload restore,
  multi-pane boot restore). ([#124](https://github.com/relixiaobo/lin-outliner/pull/124))

- **Multi-language (i18n): typed foundation + full en / 简体中文 migration (PR #110)** — the app now
  ships English and Simplified Chinese with a typed message layer. All UI strings live in
  `src/core/i18n/messages/<locale>.ts` keyed off a single `Messages` tree (`= typeof en`), read via
  `t.group.key` so a missing or mistyped key is a compile error; non-`en` locales are `DeepPartial`
  and fall through to English via `deepMerge`. The Settings → General language picker persists the
  choice, which the main process broadcasts to every window (`lin:set-language`) — panes re-render and
  the native menu bar + open-window titles rebuild from the same locale, consistent even on a silent
  save failure. Locale is seeded before first paint (no English flash), `effectiveLocale()` is memoized
  off the ~8-site hot path (no per-call `readFileSync`), and an `i18nCoverage` test asserts key **and
  array-length** parity between every locale and the English canon (828/828). The settings language /
  permission `<select>`s were restyled as design-system pop-up buttons (`SelectControl variant="popup"`:
  elevated thumb + overlaid chevron, no native OS box). Action identifiers (`Action(...)`) stay English
  by design; the textOf/displayName/date boundaries are documented in `docs/spec/i18n.md`. Gate: xhigh
  review (9 findings, all fixed) + typecheck + `test:core` + `test:renderer` 330/330 + light/dark × en/zh
  visual verification. ([#110](https://github.com/relixiaobo/lin-outliner/pull/110))

- **Outliner paste: nodex parity — `<br>` split, format routing, GFM checkboxes, `#tag` / `field::` (PR #113)** —
  brings clipboard paste up to nodex parity (`paste-nodex-parity.md`). `<br>`-separated HTML blocks
  (Gmail / Apple Notes / contenteditable) split into one row per line; list markers widened
  (`+`, `1)`, bullets `•◦▪‣·●`); Google-Docs inline wrappers unwrapped. GFM task lists `- [x]`/`- [ ]`
  become checkbox rows via a `completedAt` sentinel (`undefined` none / `0` unchecked / timestamp
  checked) — merging a task line into an existing **non-empty** row never silently checks it (only an
  empty target adopts the state). `#tag` and `name:: value` are harvested from Markdown/plain lines
  and materialized by core (find-or-create, auto-create unknowns; `options` fields smart-select);
  conservative guards keep code/URLs intact, and link/`code` spans are masked so
  `See [the #section](url)` keeps its label. Markdown-over-flat-HTML routing prefers the faithful
  `text/plain` outline when the HTML is lossy flat `<div>`, but trusts real `<ul>/<ol>/<li>` so a
  rich web-list keeps its marks. Protocol: `CreateNodeTree` gains `tags`/`fields`/`checkbox`/`done`
  (via `PasteRowMeta`); `paste_nodes_into_node` carries `firstMeta` for the merged row. Gate: review
  (6 findings fixed: link/code-safe harvest, non-empty-row checkbox suppression, list routing,
  empty-value-child reuse, comment/`firstMeta` cleanup; e2e de-flaked — 48 runs green) + `typecheck`
  + `pasteParser.test.ts` 19/19 + `core.test.ts` 78/78. Spec folded into `ui-behavior.md` (A6).
  ([#113](https://github.com/relixiaobo/lin-outliner/pull/113))

- **Search retrieval stack: shared analyzer + unified node/past-chat retrieval (PR #111)** —
  implements `search-retrieval-stack.md` Phases 1–4 in one PR (PM-ratified single-PR scope).
  Extracts the text-search primitives (normalization, query analysis, CJK + Latin tokenization,
  snippet building, label ranking) into a shared pure module `src/core/textSearchAnalyzer.ts`,
  leaving `textSearchIndex.ts` to consume them. Adds a main-side `NodeRetrievalService`
  (`src/main/nodeRetrievalService.ts`) around `runSearchExpr` + the live text index and routes
  document search and agent `node_search` through that single indexed path (the duplicate
  `agentNodeToolProjection.scoreTerm` is gone). Reworks `past_chats search` to use the shared
  analyzer semantics with active-branch visible-transcript verification and **relevance-first
  ordering** (relevance → session recency → message recency; `recent` mode stays recency-only).
  Reuses the shared label ranking for the renderer field/slash pickers
  (`fieldOptions`/`slashCommands`/`candidateRanking`) and local filename ordering. No protocol
  change, no new dependencies; heavier Phase 5 machinery (capture-payload, WAND/persisted-index/
  SQLite/embeddings) stays deferred behind measurement (A9), with 10k/50k-node and 200-session
  past-chat probes recorded in the plan. Also fixes the OAuth device-code callback typing that
  blocked `typecheck` on the branch. Gate: medium code review — two regressions found (CJK
  multi-term matching short-circuited to phrase-only; past-chat snippets lost original casing +
  `<mark>` highlight) and both fixed in #111 and re-verified — plus typecheck + `test:core`
  (584 pass; the 2 failures are the pre-existing ripgrep `agentLocalTools` cases). Specs updated
  in the same PR (`agent-tool-design.md`, `agent-event-log-rendering.md`; A6).
  ([#111](https://github.com/relixiaobo/lin-outliner/pull/111))

- **Agent panel: no-provider onboarding + empty-state cleanup (PR #109)** — implements
  `agent-empty-state-onboarding.md`. Removed the hardcoded suggested-prompt chips; an empty
  conversation with a usable provider now shows a single muted greeting line. When provider
  settings have **loaded** and no provider is usable, the panel shows a quiet onboarding line
  with a neutral CTA that opens Settings › Providers (the settings window already defaults to
  the Providers category), and the composer send button is disabled with an actionable tooltip
  (`Add a provider in Settings`) so a message can no longer fire and only fail at runtime. The
  guard is gated strictly on the loaded state, so a key-holding user never sees the onboarding
  flash or a disabled send during the async settings load. The usable-provider predicate is now
  one shared `isProviderUsable` / `resolveUsableActiveProvider` in `providerCatalog.tsx` (the
  duplicated copies in the chat panel + composer, and the ad-hoc copies in ProviderConfigWindow
  + AgentSettingsView, all route through it). Renderer-only; no protocol change. Empty-state
  design folded into `docs/spec/design-system.md` (A6).
  ([#109](https://github.com/relixiaobo/lin-outliner/pull/109))

- **Modeless global launcher + basic-info capture (PR #103)** — first slice of
  `lazy-like-global-launcher.md`. A prewarmed, always-focused global-hotkey launcher window
  (Raycast-style flat list: glyph · title · subtitle · right-aligned type label) whose single
  input is command filter + live node search + capture draft at once. Inline node search resolves
  `search_nodes` hits in main and opens the picked node in the main window
  (`navigateRoot + focusNode`); **Capture to Today** saves the active page/video/note with the
  typed text as the capture's comment. New protocol surface: a `create_capture` command and a
  provenance-only `NodeBase.capture` sidecar (`src/core/{commands,types}.ts`). The launcher
  renderer and offscreen capture stay A3-locked down (contextIsolation/sandbox, no preload on
  remote content, popups denied, navigation fenced to `^https?://`), source-guarded by
  `launcherSecurity.test.ts`; capture source metadata is main-authoritative (the renderer supplies
  only an optional note/intent, intent allow-list-validated). External context is read via a
  read-only AX native addon (`native/browser-tab`) with an `osascript` front-tab fallback. Capture
  nodes flow through the normal mutate path, so they are indexed by the #102 search layer.
  Unsupported features ship **removed, not greyed-out** (no coming-soon placeholders); deferred
  work is split into `launcher-ai-actions.md`, `launcher-capture-destinations.md`,
  `launcher-provider-expansion.md`, and `browser-extension-integration.md`. Gate: high code review
  (9 findings fixed), dedicated A3 security review, rebase/integration review, and light+dark
  visual verification — all green; spec `docs/spec/launcher.md` added (A6).
  ([#103](https://github.com/relixiaobo/lin-outliner/pull/103))

- **Text-search relevance layer (PR #102)** — implements `text-search-relevance-layer.md`.
  A shared in-memory text-search kernel (`src/core/textSearchIndex.ts`) — inverted postings,
  field-aware BM25, exact/prefix/phrase boosts, and CJK + Latin trigram candidate generation
  with strict normalized verification — now backs `search_nodes` (command palette) and the
  agent `node_search` tool, maintained **incrementally** off Core's revision deltas (a full
  rebuild only on load / undo / full-rewrite). No protocol change. Review-gate findings were
  fixed before merge: per-term candidates now **union** the trigram (interior-substring) matches
  instead of early-returning on a prefix hit, so a query like `nation` again recalls
  `internationalization` (pinned by a regression test); `normalizeSearchText` uses
  locale-insensitive `toLowerCase()`; the dead bounded top-k heap was removed and the probe
  retargeted to the real `candidateIds()` + `scoreRecord()` path; and an unrelated OAuth
  device-code callback type was split out of this PR. ([#102](https://github.com/relixiaobo/lin-outliner/pull/102))

- **Field value rows join panel selection (PR #97)** — implements
  `field-value-row-selection.md`. Field **value** rows can now be shift/cmd-selected into the
  global multi-selection (drag and keyboard) alongside content rows, keeping the append-only
  value model. A new `SelectableRow` action-policy layer (`state/selectableRows.ts` +
  `interactions/selectionBatchActions.ts`) is the single source for what each row supports:
  field values delete via `removeFieldValue` while structural ops (move/indent/duplicate) skip
  them, and computed `sysref:` system-reference rows are emitted into the shared model so mouse
  and keyboard selection agree. Review-gate findings were fixed before merge — focus-after-delete
  now carries the row's parentId, the global selectable path includes system-reference rows
  (no drag stall / mouse-keyboard divergence), a locked reference hard-deletes again, and
  shift+click on an inline-ref chip extends the range. Spec updated
  (`outliner-parity-matrix.md`, `ui-behavior.md`, A6).
  ([#97](https://github.com/relixiaobo/lin-outliner/pull/97))

- **Agent OAuth & managed-credential providers (PRs #92–#96)** — implements
  `agent-oauth-providers.md`. Providers that authenticate with a sign-in rather than a
  pasteable key (Anthropic Pro/Max, GitHub Copilot, OpenAI Codex) now have a real
  interactive sign-in flow, and managed providers (Amazon Bedrock, Google Vertex) are
  classified and surfaced correctly instead of showing a misleading key field. **#93** lands
  the protocol surface (`agent_oauth_*` commands + `OAuthLoginEvent` / `ProviderAuthView`
  types). **#94** adds the single credential resolver and a `safeStorage`-encrypted secret
  store: per-path write serialization (no lost cross-provider updates), unique atomic-write
  temp names, and a guard that refuses to overwrite an unreadable encrypted blob so a
  transiently-locked keychain never becomes permanent credential loss. **#95** is the
  main-process login orchestration + IPC — pure callback-bridging/cancellation with the
  composition root split out, a provider config row created on first sign-in (no orphaned
  credential), in-flight sign-ins cancelled on window close/re-target, and events routed to
  the initiating window. **#96** is the interactive sign-in UI (loopback + device-code, reply
  steps, connected / expiry / sign-out), token-only theming (B1–B4), verified light + dark.
  Review-gate findings across the stack (store data-loss races, orphaned-credential blocker,
  window-lifecycle leaks, renderer subscription/respond bugs) were fixed before merge. Design
  folded into `agent-pi-mono-implementation.md` (A6); plan archived.
  ([#92](https://github.com/relixiaobo/lin-outliner/pull/92),
  [#93](https://github.com/relixiaobo/lin-outliner/pull/93),
  [#94](https://github.com/relixiaobo/lin-outliner/pull/94),
  [#95](https://github.com/relixiaobo/lin-outliner/pull/95),
  [#96](https://github.com/relixiaobo/lin-outliner/pull/96))

- **Agent composer attachment path model (PR #86)** — implements
  `agent-composer-attachment-path-model.md`. Composer attachments are now **path-first**:
  pathless files are staged under the agent's local root and every attachment carries a
  readable `[[file:label^path]]` marker; images keep their inline image block **and** gain a
  normal file marker. Out-of-root file markers in user messages are materialized into the
  local root so `file_read` can reach them, and the new-turn `<user-attachments>` resource
  JSON is dropped (historical parsing/rendering preserved). Security hardening from the
  review gate keeps the agent confined to its file sandbox: `node_create`/`node_edit` reject
  `[[file:]]` markers resolving outside the local root, and `node_read`/`node_search` no
  longer materialize markers (no read-side copy sink); materialization canonicalizes paths
  with `realpath`, refuses out-of-root directories and non-regular files, caps size
  (`MAX_MATERIALIZED_ATTACHMENT_BYTES`, 50 MB), and prunes staged copies on a 7-day TTL; the
  `file_read`/`file_glob`/`file_grep` jail is `realpath`-based with nearest-existing-ancestor
  resolution, closing symlink traversal. Agent spec docs updated (A6).
  ([#86](https://github.com/relixiaobo/lin-outliner/pull/86))

- **macOS branding & chrome polish (PR #84)** — implements
  `macos-native-branding-polish.md` (T1–T6). The **app icon** is rebuilt to Apple's macOS
  icon grid: a squircle master (`assets/brand/tenon-icon-master.svg`, 824 / r≈185.4 / 100px
  transparent gutter on 1024) regenerated to `.icns`/`.png` by `scripts/gen-icon.mjs`. The
  Dock "white frame" (白边) is fixed by switching the rasterizer from `qlmanage` — which
  mattes the transparent gutter to opaque white — to headless Chromium with
  `omitBackground`; the gutter is `rgba(0,0,0,0)` (pixel-probed at 1024/512/32), replacing
  the old full-bleed square. The duplicate sidebar brand header (and its `sidebar-brand*`
  CSS) is removed so the **workspace-root row is the sole identity**. The **app menu** gains
  About/Hide/Quit, renames "Preferences…" → "Settings…", sets copyright `© 2026 Lin Lab`
  (About panel + electron-builder), and Help → "Tenon Help" + "Report an Issue…". (In a dev
  run the bold app title still reads "Electron" and ⌘, still reads "Preferences…" because
  those are OS-managed from the Electron dev bundle; a packaged `--dir` build was launched
  and verified to show "Tenon" + "Settings…" with the correct Info.plist and a
  sha256-identical bundled icon.) Design-system spec updated to the single workspace-root
  avatar (A6); no `src/core` protocol surface touched. The true Liquid-Glass `.icon`
  pipeline is deferred to `docs/plans/macos-liquid-glass-icon.md` (P2 draft).

- **Editable workspace root title (rename your workspace)** — the workspace root
  (`WORKSPACE_ID`, "Tenon") is now seeded with `locked=false`, so its title is editable
  rich text in the panel header and the sidebar workspace-root row. Structural protection
  is unchanged: `ensureNodeMovable` still blocks move/delete/reparent via the independent
  `isSystemId` check, so the root stays fixed in the tree while only its title becomes
  editable. The functional sections (Daily notes, Library, Schema, Saved searches, Trash,
  Settings) keep read-only titles. The sidebar brand wordmark (the logo + "Tenon" at
  top-left) is a hardcoded brand string and is unaffected. `ensureSystemNodeDirect`
  reconciles the flag on existing documents, so current data flips to editable on next
  launch with no migration or data wipe; the title-reconcile guard only resets empty/legacy
  titles, so a custom workspace name survives restarts. (Direct merge to `main`, no PR.)

- **Appearance theme toggle: System / Light / Dark (PR #82)** — a new **Settings ›
  General** pane exposes a `SegmentedControl` (System / Light / Dark). Selecting calls
  `lin:set-theme` → the main process sets `nativeTheme.themeSource`, which rewrites every
  renderer's `prefers-color-scheme` so the already-shipped `@media (prefers-color-scheme:
  dark)` rules flip all windows at once (no CSS dark rules changed, no `[data-theme]`
  bridge). The choice persists in `userData/app-preferences.json` and is reapplied in
  `app.whenReady()` before the first window paints (no flash); it applies instantly (no Save
  button). Preload exposes a narrow typed `getTheme`/`setTheme`; the handler validates the
  mode before touching `themeSource`. Closes the `#45` item of design-system-rollout.
  ([#82](https://github.com/relixiaobo/lin-outliner/pull/82))

- **macOS packaging + real-Electron smoke suite (native-feel stage 6) (PR #81)** — a
  real-Electron Playwright smoke suite (`tests/smoke/` + `playwright.smoke.config.ts`) that
  launches the built main process against a throwaway `ELECTRON_USER_DATA_DIR` (prod
  `file://` renderer) and asserts native behaviors the Chromium e2e suite never covered:
  first-frame (no launch flash), native menu shape + `Preferences ⌘,`, CSP enforcement
  (inline-script `securitypolicyviolation`), external-link routing (`shell.openExternal`,
  `file:` never routed), and userData isolation (a real `create_node` mutation persists into
  the isolated dir and survives before-quit). Adds `test:smoke` + `mac.category`. macOS-only
  scope; smokes the built bundle's prod path, not the signed `.dmg`. Completes
  `native-feel-remediation` (all six stages shipped).
  ([#81](https://github.com/relixiaobo/lin-outliner/pull/81))

- **Rebrand: Lin Outliner → Tenon (PR #83)** — full product-identity change. New Tenon
  logo + generated Electron app icons, favicon, sidebar brand mark, and app/window/About
  titles; agent-facing identity copy updated. electron-builder `appId`
  `com.linoutliner.desktop` → `dev.linlab.tenon` and `productName` → `Tenon`, so the
  packaged macOS userData dir is now `~/Library/Application Support/Tenon/`; the system
  workspace title migrates `Lin Outliner` → `Tenon` (display-only, idempotent). All
  internal `lin:*` IPC channels, command names, storage keys, and `provider: 'lin'` are
  preserved — protocol surface unchanged. Dev `$HOME/.lin-outliner-*` override dirs are
  intentionally kept. ([#83](https://github.com/relixiaobo/lin-outliner/pull/83))

- **Unified inline reference foundation: `ReferenceTarget` (node | local-file) (PR #80)** —
  the inline-reference model is unified under one `ReferenceTarget` union so node
  references and local-file/folder references share a single grammar and codec.
  `InlineRef` carries `{ offset, target, displayName?, mimeType?, sizeBytes? }`; the
  marker grammar is `[[node:label^id]]` / `[[file:label^path]]` (value percent-encoded)
  parsed by one `referenceMarkup.ts`; a pure `referenceTargetToResourceItem` serializer
  builds the agent context resource. Local-file references are inline-only with
  path-as-identity (no id/registry/bookmark); backlinks and search stay node-only via
  `inlineRefNodeId`. Foundation for `lazy-like-global-launcher` and
  `agent-composer-attachment-path-model`. Pre-release format break — no migration or
  bare-marker back-compat; dev userData reset.
  ([#80](https://github.com/relixiaobo/lin-outliner/pull/80))

- **Native master-detail Providers settings + own provider-config window (PR #69)** —
  the agent **Settings → Providers** surface reworked to the macOS System Settings
  *interaction* idiom in our own tokens/B-rules. A reusable inset grouped-list primitive
  (`SettingsInsetList`) with content-aligned hairlines, region-by-colour, neutral
  selection/focus, and no row hover fill; Providers grouped **Connected / Available**
  with a brand-avatar identity, neutral status dot, a per-row `⋯` menu (only when a row
  has >1 action) and a trailing **Configure** button otherwise; back/forward category
  history reusing the shared chrome control. The per-provider config opens as its **own
  native window** — a frameless modal child of the settings window
  (`lin:open-provider-config`, `?surface=provider-config`), the System Settings
  attached-dialog idiom — hosting the connection only (credential + base URL inline,
  async non-blocking validate with cancel); it is multi-mode so OAuth / managed
  credentials plug in later. The settings window itself becomes frameless with the main
  shell's geometry (inset traffic lights, 24pt corner). Also fixes dark-mode switch
  thumb / checkbox check / `==highlight==` text rendering near-black. Security defaults
  (A3) match every other window. ([#69](https://github.com/relixiaobo/lin-outliner/pull/69))

- **Reference field type: read-only system reference rows + editable node picker
  (PR #71)** — node-reference field values now follow one model: the reference node
  is always full-featured (double-click edits the target, expandable) and only the
  value *container* differs. Read-only **References / Owner / Day** project synthetic
  read-only `reference` rows (computed render-time over the global reverse index, not
  core's incremental projection) whose set is read-only — no add, no delete — but
  whose rows still edit/expand their target. A new editable **`reference` field type**
  (`FieldType += 'reference'`; protocol command `add_field_reference`, append-any-node
  + deduped, rejects a non-reference field) makes a value draft a node-search box
  (`TrailingReferencePopover`); the typed query is never persisted as free text — a
  value only ever comes from a picked existing node. Also: system-field derivation is
  consolidated into `core/systemFields.ts`, and a node carrying a **Done** field
  auto-shows a synced row checkbox that is read-only on a locked owner (fixing the
  locked-node toggle crash). Removes the now-dead `.field-value-link`. Touches the
  protocol surface (`types.ts`, `commands.ts`) per the plan.
  ([#71](https://github.com/relixiaobo/lin-outliner/pull/71))

- **Field-row UX: name reuse + read-only system fields + Tab relocate (PR #70)** —
  typing a field name (or `Space` on an empty one) now offers a popover of existing
  user fields + built-in system fields to relink to, instead of always minting a
  fresh definition. Adds the protocol command `reuse_field_definition` (`commands.ts`;
  `types.ts` untouched) that repoints the entry's `fieldDefId`, drops the orphaned
  draft def, and clears stored value children when relinking onto a read-only system
  field; a node can't carry the same field twice (renderer-enforced dedupe). Read-only
  system fields now render by their real type — Created / Last-edited / Done-time as a
  date with a calendar glyph, Tags as navigable badges, References / Owner / Day as
  links, and Done as a checkbox that goes **read-only when the owner is locked**
  (fixing the "operation is not allowed on locked node" crash on daily-note date
  pages). And `Tab` / `Shift+Tab` on an empty trailing draft now **relocate** it (pure
  focus + expand — no create, no indent IPC) instead of materializing then indenting,
  removing the flicker and the stray empty node.
  ([#70](https://github.com/relixiaobo/lin-outliner/pull/70))

- **Native shell behaviors (PR-D)** — a standard macOS application menu
  (App / Edit / View / Window / Help) with **Preferences on `Cmd+,`** opening the
  settings window, plus a native right-click context menu (editing roles + spelling
  suggestions on editable fields, Copy on a selection) that fires only for the bare
  right-clicks the renderer's own command menus leave un-`preventDefault`'d, so it
  never double-pops over a custom menu. Dev-only View items (reload / devtools) are
  gated to source runs. Also adds the macOS inactive-window convention: when the
  window loses OS focus the two floating rails desaturate (rails-only, via a
  `window-active` IPC channel — never content, selection, or the rose accent). D6:
  the pre-paint backing colour is aligned to `--bg-window` (`#ececec`); D7: a spec
  note that the 24pt window corner is packaged-build-only.
  ([#68](https://github.com/relixiaobo/lin-outliner/pull/68))

- **Field values create on Enter (node-based field-value editors)** — a field
  value is now a plain outliner node: Enter in a field value materializes the
  trailing draft and appends the next value through the same draft, so "everything
  is a node" holds for field values too. The legacy `TrailingInput` /
  `TypedFieldValueControl` / `DateFieldControl` / `TrailingInputLeading` fork is
  removed; field-value editing flows through the unified `OutlinerItem` draft row
  with additive layers — `CheckboxFieldControl` (the one whole-field control),
  `DateValuePicker` (summoned by Space on an empty draft or a calendar
  affordance), and `TrailingOptionsPopover` (type-to-filter + `Create "x"`).
  Adds id-aware field-value commands (the renderer proposes the draft row's stable
  id so React identity / IME survive materialization, validated in core against
  shape + collisions) and a new `remove_field_value` command whose backspace-an-
  empty-value cleanup promotes an externally-referenced auto-collected value into
  the option pool instead of orphaning the reference. Touches the protocol surface
  (`src/core/commands.ts`, `src/core/types.ts`) per the coordination policy.
  ([#64](https://github.com/relixiaobo/lin-outliner/pull/64))
- A central accessibility layer (`styles/a11y.css`) honoring `prefers-contrast`, `prefers-reduced-motion`, and `prefers-reduced-transparency`, with a reusable `--material-backdrop` opaque-fallback token (PR-B, #63).
- **Agent tool permissions (global runtime policy)** — implements
  `docs/plans/agent-tool-permissions.md`: one global, runtime-owned permission
  policy (allow/ask/deny by action kind) replacing the hidden one-off approval
  matrix. Adds action descriptors and a global JSON permission store
  (`permissions.allow`/`ask`/`deny`) with fail-closed load/save validation that
  rejects forbidden-allow shapes (wildcards, the arbitrary-code shell-prefix
  denylist — interpreters, `eval`/`exec`/`xargs`/`sudo`, package managers
  `npm`/`pnpm`/`yarn`/`bun`/`npx`/`bunx`/`tsx`, `ssh`, PowerShell — and the
  agent/sub-agent-spawn ban). Platform hard blocks are evaluated before any
  allow rule: sensitive-read-plus-network-write exfiltration, credential /
  shell-startup / `.git/hooks` / persistence writes, payment, permission
  self-modification, and unknown/obfuscated shell. The bash classifier handles
  known command families and evaluates compound commands by most-restrictive
  segment (`find -exec`/`-delete` and `sed -i` are treated as
  execution/edit/persistence, not read-only). A classifier-backed `ask` resolver
  is bounded by a `classifierAutoAllowEligible` gate (default `false`) that can
  never auto-allow high-consequence / outward / sensitive actions, and the
  classifier sub-call receives only a classification output contract, never the
  real tools. Ships the composer approval card (Approve once / Always allow this
  kind / Deny once), a permission center UI, structured `permission_denied`
  results, and `tool.permission.checked`/`tool.permission.resolved` event-log
  entries. Reviewed via a deep multi-agent pass that found and confirmed-fixed 1
  critical + 4 high fail-opens before merge; `typecheck` clean, permission tests
  30/0. Non-blocking follow-ups remain (sessionApproved ordering vs
  configured-ask, `parseGlobalToolPermissionSettings` pre-shaped early-return,
  interpreter-stdin exfil sinks, dual `approval.*`/`tool.permission.*` event
  vocabulary, denied-reason literal naming).
  ([#60](https://github.com/relixiaobo/lin-outliner/pull/60))
- **Agent tool permissions plan (authority)** — adds
  `docs/plans/agent-tool-permissions.md` as the single authoritative agent
  permission plan and shelves the two earlier P0 drafts
  (`agent-permissions.md`, `agent-reversible-execution.md`) with pointers to it.
  The plan defines one global runtime-owned policy (allow/ask/deny by action
  kind), platform hard blocks, a classifier-backed `ask` resolver bounded by a
  `classifierAutoAllowEligible` descriptor gate (a deliberate strengthening over
  cc-2.1, which lets its classifier model auto-allow high-consequence actions),
  fail-closed rule validation with an explicit arbitrary-code shell-prefix
  denylist and an agent/sub-agent-spawn allow ban, sensitive-data exfiltration
  redlines, and a defined interactive/unattended fail-safe. Plan refined on merge
  per a cc-2.1 source comparison (precedence wording, the two borrowed validation
  rules, and classifier-callable vs auto-allow-eligible terminology). A second
  pass pinned the concrete defaults cc-2.1 ships (per-action-kind
  `defaultDecision` table — outside-area read / web fetch / delete / publish /
  send-message default to `ask`; in-area read/edit and web search to `allow`),
  added a Classifier Prompt Contract (named block-category taxonomy mirroring
  the deterministic redlines + operational params) and a concrete safe
  auto-allow tool allowlist + outward-facing shell-command list, so the defaults
  are implementable rather than left as `Allow / Ask` placeholders.
  ([#59](https://github.com/relixiaobo/lin-outliner/pull/59))
- **macOS window corner radius (native)** — gives the standard macOS window a
  custom `24pt` continuous corner (matching Raycast) while keeping native traffic
  lights, the OS drop shadow, vibrancy, and live resize. A tiny zero-dependency
  Node-API addon (`native/window-corner/`) sets the corner via the private
  `_cornerRadius`/`_effectiveCornerRadius` selectors on macOS 26 Tahoe (where
  `_cornerMask` is ignored for frame/shadow shaping) and falls back to a
  `_cornerMask` override on older macOS; the vibrancy frost is rounded via the
  public `NSVisualEffectView.maskImage`. The loader degrades to a silent no-op
  off-darwin / when unbuilt, the radius is the `MAC_WINDOW_CORNER_RADIUS` JS
  const (restart-only to tune), and `app:build` runs `build:native` before
  packaging (the `.node` ships via `extraResources`, outside the asar).
  ([#58](https://github.com/relixiaobo/lin-outliner/pull/58))
- **Design system — spec, rollout plan, and Phase 1 token foundation** — adds
  `docs/spec/design-system.md` (the design language as a contract: two-theme
  alpha-on-ink tokens, material/overlay taxonomy, concentric radius chain,
  neutral-functional state with sparse rose brand) and `design-system-rollout.md`
  (4-phase staged plan). Phase 1 is CSS-only in `styles.css`: introduces the
  `--ink` semantic layer (text / fill / separator / surface / material / accent /
  status / selection / focus / elevation / outline) as the source of truth and
  re-points every legacy alias onto it, so components keep working and move to the
  designed light palette. The dark theme is fully defined but **gated behind
  `:root[data-theme="dark"]`** (not `prefers-color-scheme`) so it stays inert
  until the component layer is theme-aware — Phase 2 wires `nativeTheme.themeSource`
  → `data-theme`. ([#55](https://github.com/relixiaobo/lin-outliner/pull/55))
- **Native-feel stage 2 — startup polish, window-state, single-instance** — the
  window is created `show: false` and revealed on `ready-to-show` (no white
  launch flash); a new `windowState.ts` persists and restores normal bounds +
  the maximized flag (validated against connected displays so a now-disconnected
  monitor can't strand the window off-screen); and `requestSingleInstanceLock()`
  focuses the running window instead of spawning a duplicate.
  ([#45](https://github.com/relixiaobo/lin-outliner/pull/45))
- **Native-feel stage 3b — OS window material** — macOS draws `under-window`
  vibrancy and Windows draws `mica` behind the chrome, driven by a shared
  `core/windowMaterial.ts` mapping read by both the main process and preload; the
  renderer tags `<html>` with `data-window-material` on the first painted frame
  so there is no opaque→frosted flash. Other platforms keep the opaque deck.
  ([#47](https://github.com/relixiaobo/lin-outliner/pull/47))
- **Native-feel stage 4a — in-app dialogs (no `window.prompt`/`confirm`)** — the
  remaining blocking browser dialogs are gone: node icon/banner edits use an
  in-menu text-input sub-mode (consistent with the existing tag/move inputs), and
  destructive session-delete uses a reusable `ConfirmDialog` primitive (focus
  trap, Escape-to-cancel, Cancel takes initial focus so a stray Enter can't
  delete). ([#48](https://github.com/relixiaobo/lin-outliner/pull/48))
- **Native-feel stage 4b — settings in its own window** — settings moved from an
  in-app modal into a dedicated Preferences-style window with a native title bar,
  served from the single `index.html` via a `?surface=settings` marker (no second
  build entry) and going through the same stage-1 navigation hardening + CSP. New
  IPC: `lin:open-settings` / `lin:close-settings` / `lin:settings-changed`. The
  stage-4 native right-click `Menu` was intentionally dropped — the rich DOM
  context menu outweighs the native-feel gain.
  ([#49](https://github.com/relixiaobo/lin-outliner/pull/49))
- **Keyboard shortcut parity with nodex** — closes the audited gaps against the
  nodex reference. `Cmd/Ctrl+A` now selects every visible row in the current
  root even from an empty selection (focused editors still get native text
  select-all); `Cmd/Ctrl+Shift+D` goes to today's daily note when no row is
  selected while keeping batch-duplicate when a selection is active; panel
  navigation history gets dedicated `Cmd/Ctrl+[` / `Cmd/Ctrl+]` and
  `Alt+ArrowLeft` / `Alt+ArrowRight` bindings (document undo/redo stays on
  `Cmd/Ctrl+Z`, never overloaded); and a selected option-reference field value
  opens a keyboard-owned option menu where `ArrowUp`/`ArrowDown` move, `Enter`
  selects, and `Escape` closes the menu before clearing the row selection. The
  audit confirmed drag-select and click-away dismissal were already present.
  ([#53](https://github.com/relixiaobo/lin-outliner/pull/53))
- **Agent tool permissions — `allow | ask | deny` with an approval flow** — the
  runtime permission decision evolved from a boolean to a three-state behavior
  computed entirely in TypeScript policy (never from model prose). High-consequence
  actions now suspend the agent and request user approval instead of silently
  running or hard-failing: external GitHub mutations (`git push`, `gh pr/issue/
  release/repo/workflow`), package/deploy/publish changes, database migrations,
  background commands, sandbox overrides, sensitive local-path access
  (`~/.ssh`, `.env`, credential/keychain files), and unscoped recursive deletes
  ask; machine destruction, remote-code-execution pipes, shell obfuscation, and
  sensitive-data network exfiltration are redline `deny` that session rules and
  skills cannot approve. Approvals render in the agent composer (Allow once /
  this session / Deny + details popover), bubble up from subagents and skill-shell
  commands through one path, queue when multiple are pending, and are recorded as
  `approval.requested` / `approval.resolved` in the event log.
  ([#51](https://github.com/relixiaobo/lin-outliner/pull/51))
- **Inline Markdown formatting while typing** — typing the closing delimiter now
  converts low-ambiguity inline syntax in the row editor and agent composer into
  the matching mark and drops the delimiters: `` `code` ``, `**bold**`,
  `~~strike~~`, `==highlight==`, and `[text](url)`. `*italic*` and underscore
  variants are intentionally ignored to avoid accidental conversion. The `code`
  mark is non-inclusive and ArrowLeft/ArrowRight can move the caret out of an
  inline code mark even with no adjacent plain text.
  ([#51](https://github.com/relixiaobo/lin-outliner/pull/51))
- **Done-state mapping + free-typed options + color swatch picker** — three
  user-facing additions ride with the config-as-nodes refactor. A supertag with
  "Show as checkbox" on can map its done/undone state to one or more option-field
  values (Tana parity): checking the box sets each mapped field's checked value,
  and selecting a mapped checked/unchecked value toggles the box (two-way, single
  write each direction, loop-guarded). Number fields gain a non-blocking
  out-of-range warning (`minValue`/`maxValue`) that never rejects a write. Options
  fields now accept **free-typed** values decoupled from auto-collect (collect on
  ⇒ value becomes a reusable collected option; off ⇒ stored as a plain free-text
  value on that entry alone) and render as inline editable rows. The supertag
  display color is now a preset **swatch picker** (8 base colors + "no color")
  storing a theme-aware token instead of raw hex.
  ([#18](https://github.com/relixiaobo/lin-outliner/pull/18))
- **`` ``` `` / `~~~` shortcut converts a row to a code block** — typing a lone
  triple-backtick (or triple-tilde) fence that owns an empty, plain row now turns
  the row into an empty `codeBlock` and drops the fence text, a markdown-style
  shortcut alongside the `/code` slash command and pasting a fenced block. Fires
  the instant the row text equals the bare fence (mirroring the `>` field
  trigger), focuses the new code editor, and is gated to plain content rows so
  reference / image / existing-code rows opt out. The eager trailing draft
  materializes first, then converts. Language is left unset (pick it from the
  picker). ([#28](https://github.com/relixiaobo/lin-outliner/pull/28))
- **Local file mentions in the agent composer** — the `@` mention menu now
  combines recent nodes, local files, folders, and live file-search results
  (Spotlight `mdfind` on macOS, `rg` fallback elsewhere); selected entries
  render as inline tokens with native icons, image thumbnails, and hover
  previews. The model-facing prompt preserves positional intent with
  `[[file:<ref>]]` markers while a hidden `<user-attachments>` table maps each
  `ref` to its local path, kind, MIME type, and size, so files, folders, inline
  text, and images share one resolution path. Folders are exposed to the agent
  via a symlink into the local root for `file_glob`. Trashed nodes are excluded
  from both outliner and agent `@` suggestions.
  ([#21](https://github.com/relixiaobo/lin-outliner/pull/21))
- **Eager-materialized trailing draft row** — the Tana-style blank line at the
  bottom of the outline is now a real draft row: typing the first committed
  character materializes an actual node in place (IME-seamless, no editor
  remount) via a client-proposed node id, and drops a fresh empty draft below.
  Create + the first text edits collapse into one undo step. Structural keys
  work on the draft (Enter / Tab indent-under-previous-sibling / Shift+Tab /
  Backspace), plus fixes for leading-inline-ref backspace and merging a row
  into a reference node (converts it to a leading inline reference). Main
  outliner only; `FieldValueOutliner` keeps its typed-control trailing input.
  ([#16](https://github.com/relixiaobo/lin-outliner/pull/16))
- **Agent composer with inline references** — replaced the agent composer
  textarea with a ProseMirror editor supporting slash commands, inline node
  references (rendered consistently across user / assistant / tool output and
  clickable, with Cmd/Ctrl-click opening a new tab), inline file references,
  and paste/drop + native-picker file attachments sent inline to the model.
  ([#15](https://github.com/relixiaobo/lin-outliner/pull/15))
- **Inline images and a local asset subsystem** — paste an image or pick one
  via `/image`; images render inline on a reusable, focusable block-node shell.
  A content-addressed asset store (MIME sniffing, intrinsic-dimension probe,
  path-traversal-safe ids) is served through the privileged `asset://` protocol.
  Each image has a hover toolbar (caption / fullscreen lightbox / open original);
  the caption is the node's description.
  ([#8](https://github.com/relixiaobo/lin-outliner/pull/8))
- **Remote image sources** — image nodes accept a remote `mediaUrl` (validated
  http/https) alongside local assets; pasting a lone image URL creates a remote
  image, while pasting a URL over a selection links the text instead.
  ([#10](https://github.com/relixiaobo/lin-outliner/pull/10))
- **Dedicated code block editor** — `codeBlock` nodes with Shiki syntax
  highlighting, a language picker, horizontal scroll, and cross-row selection.
  ([#2](https://github.com/relixiaobo/lin-outliner/pull/2))
- **`past_chats` agent recall tool** — recent / search / read access over prior
  agent conversations, backed by the event store; tool-call JSON is
  Shiki-highlighted in the UI and renders identically live versus reloaded.
  ([#1](https://github.com/relixiaobo/lin-outliner/pull/1),
  [#4](https://github.com/relixiaobo/lin-outliner/pull/4),
  [#7](https://github.com/relixiaobo/lin-outliner/pull/7))

### Changed

- **Settings, reorganized around what you are actually setting (PR #488, cc-2)** —
  Settings is now General, Agent, and Reading, with About, the Skill Library, and
  Add Service as their own routed pages instead of one long scroll. Changes apply
  the moment you make them: there is no Save button to forget, a write that fails
  says so in place and puts the old value back, and a slow response can no longer
  land on top of a newer choice you already made. A connection's status now
  reflects a real, bounded check rather than a guess — and it stays put, so a
  connection you verified still reads as verified after its sign-in quietly
  refreshes in the background or you flip its switch off and on. Managed Skills
  install, enable, and roll back truthfully, and a Skill whose files are broken
  no longer takes the rest of your Skills down with it. Reading preferences —
  page translation, URL translation, and language — stay consistent with each
  other, and a failed write is visible and retryable. What's New starts collapsed,
  scrolls within itself, and shows the section matching the version you are
  running, with a version picker for the rest.
  runtime moved to pi-ai 0.83, which brings the current model catalog and the
  provider-owned sign-in flow. Signing in is now the provider's own flow rather
  than one shared script, so device codes, pasted codes, and account pickers all
  behave the way that provider actually works — and a connection you configured
  with an API key still opens on its key, not on a sign-in sheet that hides it.
  Providers whose model list is only known after you connect (Radius, and any
  future one like it) now fill in: their models load at launch from what was
  saved last time, refresh when you add a key or sign in, and can be refreshed
  on demand from the connection's ⋯ menu. Refreshing one connection refreshes
  only that one. Testing a connection no longer writes anything down — a key you
  typed but never saved leaves no trace in your model list. Enterprise GitHub
  Copilot reaches its own host again, on Threads and on page translation.

- **Pick a model, not a provider (PR #478, cc-2)** — the Thread's model control
  is now one flat list of models across your connections. The model name leads
  each row; the connection it comes from appears only as a small secondary
  label, and only when more than one is listed. Connections still bound how many
  models each contributes, so a long catalog stays collapsed behind its own
  "show all" (which now says whose models it expands) and a model you have
  pinned stays visible even when it falls outside that window. The list leads
  with **Always newest**, which follows your connection's newest model instead
  of pinning one — choosing it never moves the Thread to a different connection,
  and it names the model it would switch you to. A pinned model is shown exactly
  as stored: the pill and the check mark always name the model that will
  actually run, so you can no longer be shown one model while another answers
  the turn.

- **You can see what your agents are doing, and stop them (PR #472, cc-2)** — a
  delegating Turn now carries a live card in its process block: one line per
  child agent with a readable name, its status, and elapsed time, so a
  delegation is something you watch rather than something you wait out. Each
  running line has its own Stop, a child Thread's header has one, and the
  composer's Stop now closes the whole request — the Turn plus every piece of
  delegated work it owns, including a child that was only holding queued work
  and had not started yet. Stopping is scoped to the request you made, so
  background work from an earlier request keeps running: it stays visible on
  its own Turn's card, with its own Stop, rather than being swept up by a
  decision you did not make. Work you stop stays stopped — queued content does
  not resurface in a later request — and re-delegating to a stopped child is how
  you resume it. Stop reaches only your own conversations, at any depth.
- **One Skill library, and a way to add your own (PR #470, cc)** — Skill
  settings were organised by where a Skill came from: a managed panel, then a
  separate list of everything else, with catalog browse and a GitHub URL field
  standing open as permanent page furniture. Provenance is an implementation
  detail — you think "my Skills" — so it is now **one list over every source**,
  sorted by the name you read, with the source as a chip on the row and
  everything that adds a Skill collected behind a `+`. A managed Skill and a
  local one are turned off the same way now, by one predicate rather than two
  mechanisms, and the cap on how many Skills you could disable rose from 20 to
  1000 — past 20 the 21st was silently dropped and the Skill stayed available
  to the model. You can point Tenon at **a folder of your own Skills** from the
  app for the first time; Tenon reads the Skills *inside* the folder you
  choose, so picking a folder that is itself a Skill asks before adding its
  container and says plainly that every other Skill in there comes along.
  Managed update checks no longer run on every glance — at most once every six
  hours per Skill, once shortly after launch — and when an update is waiting,
  the Skills row in the settings sidebar says how many. A folder whose name
  cannot be a Skill's name (a space, non-ASCII) is refused when it is read
  rather than when it is written to, so a Skill can no longer load, list and
  run while edits to its own definition go ungoverned.
- **The Plan says which step the agent is on (PR #467, cc-2)** — the progress
  pill above the composer showed a bare `Step 3 / 5`, so following along meant
  opening the checklist to find out what step 3 was. It now carries the current
  step's text — `2/5 · Draft the summary` — ellipsized to one line at a fixed
  height so it never reflows the composer, and a Plan whose every step is
  complete reads as complete rather than as its last step. The current step is
  marked by weight and colour rather than by a spinner alone, whose cue
  disappears entirely under reduced motion; step rows carry their status as
  text for assistive technology, and the live announcement includes the step's
  text rather than only a counter. The pill also appears on a Thread with **no
  composer** — a watched child or automation Thread — where closing the
  checklist returns focus to the pill instead of dropping it to the document
  body.
- **A Plan update is recorded like any other tool call (PR #468, cc-2)** — the
  model would emit a dozen visible `Thought` rows deliberating about calling
  `update_plan` and nothing would ever appear, because the Plan's tool-call Item
  was deliberately excluded from the persisted Turn (PR #438). The reasoning
  leaked the action while the action stayed hidden, so the agent read as
  thinking about a tool it never called. `update_plan` is now an ordinary
  recorded call: it reaches the transcript, counted activity groups, Turn
  Diagnostics, reload history, and Turn copy through the paths every other tool
  already uses. It is worded as the act — "Updated the plan", collapsing to
  "Updated the plan 3 times" when consecutive — never as `Used update_plan`, and
  carries its own glyph. The pill is unchanged and complementary: it remains the
  ephemeral fast path for *which step* the agent is on, while the recorded call
  is the account that it updated the Plan at all.
- **The agent stops imitating its own thinking, and starts thinking again (PR
  #465, codex-4)** — Tenon rebuilt canonical context before every provider call
  and wrote reasoning Items back into the provider's own assistant channel as
  `[Reasoning]`-prefixed text. That channel is a few-shot demonstration, so
  after six Tenon-authored examples the model imitated the format: it emitted
  `[Reasoning]` prose as a visible commentary message and spent zero reasoning
  tokens on that call. Canonical reasoning now contributes no assistant prose to
  reconstructed history, and signed native reasoning survives the tool loop
  within a Turn, retained in memory under strict `(turnId, provider, api,
  model)` identity. The retention can only re-attach reasoning parts to messages
  canonical projection already produced — never a message, tool call, tool
  result, or ordering — and an identity mismatch drops the part and continues
  instead of failing the Turn. If a matching provider cannot prepare a payload
  from an unrecognised signature, the gateway strips signed thinking and retries
  preparation once; other provider, network, and service errors are unchanged.
  No renderer filter was added, because hiding `[Reasoning]` would leave the
  model still being taught to write it. A real OpenAI Responses run restored 134
  native reasoning tokens across a three-call tool loop with no markers left in
  the transcript.
- **A subagent gets one row in the parent transcript, and that row tells the
  truth (PR #466, codex-2)** — a delegated child used to append a fresh row for
  every lifecycle event, so one subagent read as several and the parent's
  transcript grew a row for work the reader had already seen finish. Each child
  now occupies exactly one live presentation row: terminal parent Items are
  authoritative, and the latest canonical child Turn is used only as the live
  fallback, retained per Thread even when child history is unloaded — reload
  omissions, rollback, and subtree deletion clear that cache rather than letting
  it go stale. The row shows live elapsed time and distinct
  idle/completed/interrupted/failed/unavailable states, and the process divider
  says `Waiting on N subagents · elapsed` only when `wait_agent` is the sole
  in-progress tool, so the parent never claims to be waiting on a child that
  already finished. Collaboration identity (`status`, `taskPath`, `nickname`,
  `role`) and the child's exact terminal `TurnError` are persisted as typed
  records instead of a bare status string. Budget failures are classified only
  by `Turn.error.code` and rendered as resource-limit copy with no token
  quantities anywhere the reader can see, and raw collaboration output stays out
  of user surfaces. Child Threads remain composer-less; navigation and
  per-child interrupt are still to come. **This is a pre-release protocol clean
  cut** — the codec rejects the old `subAgentActivity` and `agentsStates`
  shapes, so wipe clone-local `~/.lin-outliner-*` dev userData before running.
- **The run's status line stops claiming more than the run is doing (PR #463,
  cc-2)** — a settled Turn is now always described in the past instead of
  falling through to the live "Working" label, and exactly one element owns a
  Turn's terminal status — with something always owning it, including the case
  where a Turn was interrupted before it produced anything at all and no
  process divider exists to state it. A Turn blocked on the user says so and
  stops its spinner, because a spinner claims work is happening; the elapsed
  time is deliberately left as wall-clock since the Turn started — the same
  span the server records — so the live label and the settled one cannot
  contradict each other, and the wait is named rather than subtracted. Counted
  activity reports finished and in-flight work separately ("Read 5 files ·
  reading 1") instead of one present-tense count covering work already done. A
  reasoning disclosure that opened by default now latches open for the rest of
  the Thread session, so an arriving Item can no longer snap it shut and shift
  the layout under the reader — an explicit collapse still wins, and a reloaded
  transcript rests at the settled default rather than permanently expanding
  every reasoning Item a reader once watched live. The reconnect banner honors
  `prefers-reduced-motion` and can no longer outlive the attempt it describes.
- **Tool rows say what the agent did, and show status without a mystery glyph
  (PR #461, cc-2)** — a tool row in the transcript now keeps its own icon and
  reads as a sentence about the work: "Read \"Chapter Three\"" rather than
  "Used node_read", with single rows and grouped rows speaking one vocabulary.
  Status is carried by colour on that same glyph plus a word — a failed row
  tints `--status-danger` and says so, and a collapsed group appends per-status
  tallies where only the tally is tinted, so one failure out of six no longer
  paints the whole line red. The generic red pill is gone. A command row
  renders the caller's own bash `description` when there is one, while its
  tooltip always keeps the real shell text, so a description can never mask
  what actually ran; when there is none, the label strips heredoc bodies,
  `cd X &&` scaffolding, and the thread's own working-directory prefix. Four
  icons were re-picked (file delete, `web_fetch`, MCP vs unknown tool, skill).

- **pi-ai / pi-agent-core upgraded `0.80.3 -> 0.80.6` (PR #390, codex)** —
  adopts the refreshed upstream model catalog and exposes `max` as a distinct
  canonical reasoning level after `xhigh` across provider projection, agent
  profiles, skills, Settings, the composer picker, persistence, and runtime
  dispatch. Tool calls from `stopReason: "length"` assistant messages are now
  rejected before execution and returned as failed tool results for safe retry.
  The upgrade also brings request-level cost tiers plus upstream context-budget,
  retry, OAuth, transport, reasoning-replay, and provider-normalization fixes.
  **Gate (main):** code review found no reportable findings. Verified with
  typecheck, production build, focused core/runtime/renderer suites, full
  renderer tests, light/dark reasoning-menu E2E, docs check, and diff check.

- **Model-specific reasoning effort labels (PR #379, codex-4)** — agent model
  options now carry optional display-only effort labels derived from each
  provider model's thinking map while keeping persisted profile effort values
  canonical. The composer model menu and Settings agent profile selector now
  show only the selected model's supported reasoning levels and render labels
  such as `XHigh`, `Max`, `LOW`, or `HIGH` without saving provider-specific
  strings. **Gate (main):** code review found no reportable findings. Verified
  with typecheck, core tests, renderer tests, docs check, and `git diff
  --check`.

- **Ask user question stepper polish (PR #378, codex-4)** — the
  multi-question `ask_user_question` composer stepper now uses compact
  `Input needed · 1/2` title-row progress, moves Back into an icon-only header
  control from step 2 onward, and lowers `Discuss first` into a left-side escape
  hatch while keeping primary navigation on the right. Styling stays token-based,
  and the spec/e2e coverage now pin the compact heading and icon Back behavior.
  **Gate (main):** code review found no reportable findings. Verified with
  typecheck, renderer tests, targeted stepper/discuss e2e coverage, docs check,
  and `git diff --check`.

- **Tana-style view toolbar polish (PR #350, codex-2)** — node and saved-search result toolbars now use a
  field-first interaction model: a real leading name-filter chip writes `sys:name contains` filter rules;
  Display/Group/Sort/Filter menus open as contextual popovers; filter summary chips target the exact saved
  rule id, including multiple filters on the same field; Sort shows priority metadata and blocks duplicate
  pending adds; and filtered-out rows use a clearer expandable disclosure. Nested toolbars align with their
  owner row column, portal tooltips replace duplicated native/CSS tips, and search-result summary bars route
  into the same toolbar path. `docs/spec/ui-behavior.md` synced. **Gate (main):** review found two race bugs
  (stale filter-chip input reuse and pending-sort duplicate creation); round-2 fix `d30c67f8` resolved both
  with regression E2E. Verified: `definition-config` E2E 15/0, `search-query-builder` E2E 2/0,
  `test:renderer` 633/0, `docs:check`, and `git diff --check`.

- **pi-ai / pi-agent-core upgraded `0.78.0 → 0.80.2` with a clean `Models` migration (PR #348, codex-3)** —
  the main-process agent runtime moves off the removed pi global helpers
  (`completeSimple`/`streamSimple`/`getModels`/`getProviders`/`getProviderApiKey`/`getOAuthApiKey`) onto the
  `Models` instance API. A new composition root (`src/main/piModels.ts`) wraps one
  `builtinModels({ credentials })`, wires the existing `agent-secrets.json` as pi's `CredentialStore`
  (OAuth refresh persists under the existing file lock), and routes custom OpenAI-compatible endpoints
  through internal `tenon-custom:<id>` providers while keeping the external provider id on renderer,
  event-log, and run-fingerprint surfaces. Provider auth — stored keys, ambient env, OAuth refresh,
  managed credentials, provider-specific headers/env, and the Cloudflare AI Gateway baseUrl shape — now
  resolves at request time via `Models.applyAuth()` instead of being flattened into an `apiKey` string.
  Keyless endpoints are allowed for localhost/loopback/`*.localhost` only (shared `isLocalBaseUrl`
  predicate in `src/core/localEndpoint.ts`); a local endpoint uses a deliberately-stored key when one
  exists (e.g. a local proxy fronted by a master key) and otherwise an inert client key — an **ambient**
  provider key (env / OAuth / managed) is never forwarded to localhost. Picks up upstream provider-metadata, billing-hazard, and vulnerable-dep
  fixes. Gated by `/code-review xhigh` (10 finder angles + sweep) with a round-2 pass that preserved real
  model context windows behind custom endpoints, kept `api_key` credential `env` across the store
  round-trip, and stopped pruning keyless-remote provider rows at startup.

- **`node_edit` is now single-node and non-pruning (plan PR #346 + impl PR #347, codex-4)** — the agent
  `node_edit` tool can no longer delete outline content by omission. The old whole-subtree reconcile is
  removed: `old_string:"*"` (which replaced the entire annotated outline) now returns `subtree_edit_removed`,
  and a multi-node outline fragment can no longer trash existing children that are absent from the desired
  outline. Outline edits are scoped to **one node** — its root line, fields, field values, and saved-search
  config — and apply **non-pruning upsert** semantics: omitted fields and field values are **preserved**;
  removals are an explicit by-id `node_delete`. New fields are inserted **before** a node's ordinary children
  (so they render in the field strip, not below the children); changing a field value's *kind* (text ↔
  reference) is rejected up front with `invalid_field_value_kind` and a `node_delete`-then-recreate
  instruction, **before** any mutation is applied (no partial commit). `node_create`, `move`, `merge`, and
  `replace_with_reference_to` are unchanged. **Gate (main):** `/code-review high` + round-2 fix landed all
  three findings (dead clear-warning / mis-reported `afterOutline`, field placement, kind-change partial
  commit), each with a regression test; `docs/spec/agent-tool-design.md` updated in the same change.
- **Search nodes excluded from references (PR #335, codex; follow-up PR #336, main)** — saved-search
  nodes and their query internals no longer count as reference sources in a target node's References
  footer or the relevance reference-authority graph. Excluded: materialized search-result references,
  direct references and plain-text mentions on `search` nodes, and query operand references/mentions
  inside `queryCondition` subtrees (e.g. a "field is [node]" operand, which is materialized as a
  default-role `reference` under the condition and previously polluted the operand's backlinks).
  Real user-authored references in ordinary child content — including manual children placed under a
  search node and their reference grandchildren — stay fully counted. Implemented via a cached
  `searchReferenceSourcePredicate` (node is `search`-typed, a result `reference` attached directly to a
  search node, or inside a `queryCondition` subtree) applied across the backlink, inline-ref, and
  unlinked-mention branches. #336 closed an asymmetry from the original review: the backlink branch
  excluded a reference via its parent while the inline-ref scan keyed off the node itself, so a result
  ref carrying inline content could leak — both branches are now symmetric. Spec synced in
  `ui-behavior.md` + `search-query-grammar.md`. **Gate (main):** manual review + full verification —
  typecheck clean, `references.test` 11/0, `test:core` 1056/0, `docs:check` OK.

- **Native focus rings + agent transcript polish (PR #332, codex-2)** — focus rings on text controls
  (`input` / `textarea` / `select`) are now **keyboard-only**: a renderer-level `:root[data-input-modality]`
  attribute (set by a capturing pointerdown/keydown tracker) gates the neutral ring so ordinary clicks no
  longer paint web-form boxes, while keyboard navigation (Tab, arrows, number-stepper ↑↓) still shows it.
  The agent rail slide is **sibling-stable** — opening the dock reflows only the agent rail (never resizes
  or repaints the sidebar), and a content-triggered chat-source reveal now **defers its scroll/highlight
  until the rail finishes opening** (transitionend or a motion-duration fallback), guarded against
  conversation switches mid-transition. Centered transcript **time separators are removed** (timestamps
  stay in the message Details popover). `will-change` dropped from both rails. **Gate (main):**
  `/code-review high` (8 findings) → codex-2 fix `c6076e89`: the global keyboard ring moved to a
  low-specificity `:where()` form so component `box-shadow: none` suppressions (`.input-bare`,
  `.code-block-textarea`, `.inset-card .settings-sheet-row-input`) win again instead of re-exposing
  clipped/boxed rings; `.definition-text-input` focus paint gated behind keyboard modality (with a CSS
  guard test); deferred reveal cleared on conversation change; `clampAgentRailForPanelFloor` de-duplicated
  onto a shared `allowSidebarRelief` mode; both-rails-change reflow no longer skips sidebar relief; dead
  launcher modality install removed. Verified: typecheck clean, `test:renderer` 615/0. Spec synced:
  `design-system`.
- **Response Run Details pane reworked + shared read-only code blocks (PR #325, codex)** — the assistant
  reply info button now opens a **run-scoped** Run Details pane (one concrete response run; an already-open
  pane retargets when another reply's info button is clicked, and falls back to the inline details popover
  when the workspace can't fit a pane). Run Details moves onto the **shared pane chrome** (same sticky
  breadcrumb / close alignment / content shell as node and file panes), drops the manual refresh button
  (still refreshes from runtime events), and reorganizes into **Summary / Model Input / Execution**. Model
  Input splits into system prompt, tools, history, and current request from the **captured provider
  payloads** (what was actually sent); Execution is a flat expandable call list in provider output order
  (thinking, assistant text, tool calls, tool results). Reply and call usage hovers now share one
  `AgentUsageBreakdown` (token rows + total cost + cached share), and a shared read-only `CodeBlockSurface`
  backs agent markdown, tool rows, Run Details, transcript messages, and outliner code rows. **Gate
  (main):** `/code-review high` (10 findings) → codex fix `f912835c`: disclosure no longer collapses on
  live count change (reset keyed on run id), debug snapshot stops re-emitting per provider round (messages
  captured once, excluded from the dedupe hash), narrow-window info button falls back to the inline
  popover, code blocks highlight lazily on expand, the no-`user`-row model-input split now labels the
  whole window as the current request, the `[tool_result …]` prefix contract moved to a shared
  `agentDebugProtocol` helper, and the usage-breakdown + `DebugMetric`/`truncate`/`formatDuration`
  duplication was removed. Verified: typecheck clean, `test:core` 1064/0, `docs:check` OK, e2e
  `agent-debug-panel` + `outliner-code-block` + `agent-process` 26/0. Spec synced:
  `agent-event-log-rendering`, `workspace-layout`, `commands`, `i18n`.
- **`file_read` is now a provider-neutral runtime ingestion boundary (PR #326, codex-3)** — reverses the
  native-PDF payload approach from PR #322 (above): `src/main/agentNativePdfPayloads.ts` and the
  `nativePdfRead` plumbing are removed, so no provider-native PDF blocks or raw PDF bytes/base64 are sent
  as the canonical path. The model still passes a local path; the runtime picks the representation. PDFs
  default to `pdfinfo` page count + `pdftotext -layout` full-document text (bounded to 60k chars);
  explicit `pages` renders bounded JPEG page images with `pdftoppm`; oversized scanned PDFs return
  metadata plus a hint to request a narrower range. Rich documents (`.docx`, `.pptx`, `.xlsx`, `.xls`,
  `.epub`) convert to Markdown through optional **MarkItDown**, probed locally via
  `LIN_AGENT_MARKITDOWN_COMMAND` (accepts an executable path **or** a command line like
  `python3 -m markitdown`), then `markitdown`, then `python3 -m markitdown` — no plugins/cloud/LLM
  backends, no self-install. Local extractors share one subprocess runner
  (`src/main/agentToolProcess.ts`: `LIN_AGENT_EXTRA_TOOL_PATH` + common GUI/system PATH segments,
  SIGTERM→SIGKILL escalation, bounded stdout/stderr capture). Missing Poppler or MarkItDown stays a
  recoverable tool error — the agent installs the dependency via `bash` under the normal permission/audit
  path and retries the same call. `.html`/`.htm` stay on the plain-text read path (no MarkItDown
  dependency, still editable). **Gate (main):** `/code-review xhigh` (8 findings fixed + regression-tested
  in `09939d1a`: pdftotext stderr false-positive, `pages` render-before-extract, restored `%PDF-`
  magic-byte check, bounded pdftotext capture, cached MarkItDown probes, accurate truncation char counts,
  env-command-with-args). `test:core` 1061/0, typecheck clean. Spec synced: `agent-tool-design`,
  `agent-progress`.
- **`file_read` derived-ingestion results are now cached in-process (PR #327, codex-3)** — a direct
  follow-up to PR #326. Successful expensive runtime extractions (MarkItDown rich-document → Markdown and
  PDF `pdfinfo`/`pdftotext` metadata+text) are memoized in a small bounded **LRU cache**
  (`src/main/agentFileIngestionCache.ts`), so re-reading unchanged content skips the subprocess. Entries
  key on **source SHA-256 + extractor identity + relevant options + local tool environment** (PATH /
  extra-tool path), so a changed file, a different extractor, or a different toolchain all miss correctly.
  Errors are **not** cached, and per-read PDF page-render output directories remain per-read scratch (not
  cached). Ordinary text-file freshness and `file_edit` guards are unchanged. The source hash is computed
  by **streaming** the file (`src/main/fileHashing.ts` `sha256File`), so hashing a near-limit document no
  longer buffers it whole in memory; the bounded-LRU eviction is now a single shared helper
  (`src/main/boundedMap.ts`), and cached values are `structuredClone`d on get/set so a caller can never
  mutate a cached entry. **Gate (main):** `/code-review xhigh` (7 findings) → codex-3 fix `c9119af6`:
  streaming hash (no 50 MB read-to-hash buffer), shared `setBoundedMapEntry`, `structuredClone` isolation,
  a dedicated cache unit test, and a `beforeEach` cache reset to remove cross-test pollution. Verified:
  typecheck clean, `agentFileIngestionCache` + `agentLocalTools` 68/0 (2 skip). Spec synced:
  `agent-tool-design`.
- **Dream channel launcher reworked into scheduled settings + a separate manual run (PR #330, codex-2)** —
  a fast-track follow-up to `dream-channel-and-memory-retire`. The bottom-of-channel surface no longer looks
  like a chat composer: it splits into **Scheduled Dream** (a "next run" readout + a recurrence picker reusing
  the shared `DateValuePicker`, with a Dream-specific empty placeholder and a Save action) and a separate
  **Manual run** popover (date-window + optional focus text). The shared date picker gains date-only,
  bounded (`maxDate`), top-anchored (`popoverPlacement`/`popoverGap`), and recurrence end-date ("Ends" switch)
  modes needed by Dream while preserving the command-node schedule behavior; `CalendarMonthGrid` gains an
  `isDateDisabled` predicate with keyboard-roving fallback to the nearest enabled date, and
  `nextDateScheduleDue` is added by refactoring the schedule math into one direction-parameterized core shared
  with `mostRecentDateScheduleDue`. Recurrence `until` is now guarded `>= anchor` at every layer
  (`buildScheduleString`, the picker commit path, and the calendar). **Gate (main):** `/code-review high`
  (9 findings fixed across 2 rounds) — including a **caught-and-fixed regression** where the schedule-math
  dedup broke `mostRecentDateScheduleDue` (the live firing path) for monthly/yearly schedules evaluated after
  their `UNTIL`; the `withinUntil` short-circuit was sound only for the forward search, fixed to `continue` in
  the past direction with a covering test. Verified: typecheck clean, `test:core` 1056/0, `test:renderer`
  606/0.

- **Agent transcript rebuilt to 1:1 Codex desktop-client message flow (PR #312, `message-flow-rebuild`)** —
  the agent process rendering is rebuilt as one typed-stream → render-group splitter → nested collapse model,
  matching the OpenAI Codex desktop client. The per-turn body is a **flat timeline** (no left rail/indent) under
  a **persistent divider** — the live "Working / Working for {t}" clock while active, "Worked for {t}" once
  sealed — that stays put through expand and auto-collapse. The turn fold **auto-expands while working and
  auto-collapses the moment the final answer starts** (Codex machine C), **reversing #306's default-collapsed
  live process** (PM-ratified). Consecutive tool calls fold into one **counted activity group** ("Ran 3
  commands · read 2 files", machine B) expandable to the individual rows; reasoning folds like a tool step with
  a fixed "Thinking"/"Thought" label + a dim one-line gist. A user expand/collapse is **sticky and persisted per
  conversation** (`agentDisclosureStore`, the renderer analog of Codex's `collapsedTurnsById`), surviving reload
  and conversation switch. New `agentRenderGroups` splitter + `AgentToolActivityGroup` + `formatRunDuration`
  with full unit/e2e coverage; supersedes the #311 4-gap design. **Gate (main):** reconciled with #314 — every
  un-settled tool spins while the turn is live (`isToolCallRowActive`) across the standalone row, the activity
  group (counts + member spinners), and the header summary, so a parallel batch never flashes red or miscounts
  as failed mid-turn; the live clock no longer runs away to ~20000d when the turn-start anchor is unknown.
  typecheck ✓ · `test:core` 1043 · `test:renderer` 587 · e2e `agent-process` 15/15 · `docs:check` ✓ ·
  adversarial reconciliation review clean · visual verification light+dark.
- **Stabilize disclosure scroll anchoring — live agent process + outliner collapse (PR #306, codex-3)** —
  live agent process rows now default **collapsed** (reversing the previous auto-expand-while-working /
  auto-collapse-on-settle): the collapsed header is the live status line — the pending tool, then the
  latest non-empty thinking preview, then `Working...` — and updates **in place** to
  `Worked for {duration}` once the turn seals, with no header jump. A user's expand/collapse choice is
  now **sticky across the live→sealed transition**: the assistant-turn React key is runId-first (with a
  same-render dedup backstop), so the row no longer remounts when the streaming placeholder id is
  replaced by the sealed id, and the spinner moves into the timeline only while the fold is expanded.
  On any disclosure toggle — agent process folds, and outliner chevron / indent-guide collapse on long
  flat lists — a shared scroll-anchor helper (`disclosureScrollAnchor.ts` + `usePendingDisclosureAnchor`)
  captures the clicked trigger's viewport top before the state change and restores it after the layout
  commit (re-resolving a detached trigger via `data-agent-process-id` / `data-node-id`), so removing or
  adding descendant rows never pulls the clicked row up or down; the correction is instantaneous, never
  smooth-scrolled. Native CSS `overflow-anchor` is retained as the floor for non-disclosure layout
  shifts, with the manual JS as the final authority for the clicked element. Spec synced:
  `agent-event-log-rendering.md`, `ui-behavior.md`. **Gate (main):** `/code-review high` → 10 findings,
  all addressed in `3efd82d2` and re-verified — typecheck, `test:renderer` 552/0,
  `agent-process.spec.ts` 13/13, `outliner-trailing-expand.spec.ts` 23/23 (incl. the `<1px`
  clicked-chevron anchor assertion).
- **Single-agent finish collapse — the one-Neva invariant is now code-enforced (PR #300, cc-2)** —
  removes every surface that could create, load, or delegate-to a *second* agent, completing the
  collapse begun in #294. Gone: agent-definition authoring (the `agent_create` / `delete` /
  `duplicate` command kinds + IPC / client / UI + the `/create-agent` skill), file-backed agent
  loading (the `.agents/agents/` registry scan, `additionalAgentDirectories`), the `Agent` tool's
  `agent_type` parameter (delegation is now structurally **fork-only** — a fork runs *as* Neva in an
  isolated context, never a different agent), the skill `agent` field, the dead cross-principal
  memory redaction, and `isMultiAgentConversation`. Neva stays editable in place; her same-agent
  fork sub-runs (research / dream / Task) are unchanged. The scheduled-command `commandAgent`
  selector is removed end-to-end (a command always forks the current agent), and
  `AgentChildRunActionResult.context_mode` is narrowed to `'fork'`. Net −3791/+546 across 61 files;
  design folded into the agent specs (A6). **Gate (main):** `/code-review high` (8 finder angles +
  verify) → 5 findings, all addressed in a follow-up commit (commandAgent removed end-to-end,
  `context_mode` narrowed, dead `resolveChildRunMemoryOwner` deleted); typecheck ✓, `test:core`
  1034 / `test:renderer` 547 / `docs:check` ✓. **Shape (a)** one PR.
- **Single-agent collapse — one customizable agent, channels only, one memory (PR #294, cc-2)** —
  the multi-agent surface collapses to a single directly-editable assistant (Neva). Conversations
  become inline channels: the DM primitive, member-roster surface, runtime POV assembly, dead
  channel-turn execution machinery, the message-addressing protocol, and the multi-agent channel-org
  tools (`channel_create` / `channel_update`, added in #289) are all removed. Memory collapses to one
  believer-keyed first-person pool and `memoryIsolation` is dropped — the single pool is always
  writable. Neva is directly editable (display name, persona, tools, skills, model, effort) via a
  settings overlay keyed by `agentId`, persisting only fields that differ from the code base so an
  unchanged persona never freezes; the stable `name` remains the memory anchor. Dream surfacing
  relocated into Settings → Memory & activity. Net −9929/+2012 across 66 files; design folded into the
  agent specs (A6). A prior review cycle closed 4 editable-Neva findings (`9940e1d8`).
- **Channel activity run details — one-agent Channels unified · live process stream · popover polish
  (PR #291, codex)** — Channel conversations now route ALL run state through the activity row + per-run
  detail flow, including a **coordinator-only (one-agent) Channel**, which previously fell back to the
  DM composer/streaming tail. A new `usesChannelActivitySurface(conversationId, members)` (Channel id
  prefix OR ≥2 agent members) replaces the old `isMultiAgentConversation`-only checks across the
  runtime, the render projection, the renderer, and the e2e mock, so "is this a Channel?" is decided by
  one shared helper. The per-run **detail view now renders the live process stream** — thinking, tool
  calls, and interim prose — through the same transcript UI as DM responses: each run retains its
  structured live blocks (`assistantContent`) and the projection surfaces them as
  `streamingContent`, while the main Channel transcript stays whole-utterance only. A coordinator-only
  Channel keeps its DM-equivalent single-reader turn context (memory briefing + skill/agent listings);
  only a multi-agent Channel suppresses them for the reader-neutral shared log. Activity popover
  geometry polish: centered in-flow working row, tokenized spacing (`--channel-activity-*`), neutral
  avatar/line layout (the semantic-color status dot removed), a compact per-run stop reusing the
  composer-action button, and a quiet underline-on-focus "Stop all". Specs: `docs/spec/
  agent-architecture.md`, `agent-event-log-rendering.md`, `agent-progress.md`, `commands.md`,
  `design-system.md`. **Gate (main):** `/code-review xhigh` (10 finder angles, recall-biased) → 10
  findings — runtime never emitted `streamingContent` (headline feature dead in production, masked by
  test fixtures); coordinator-only Channel silently dropped its memory/skill/agent reminders;
  cross-run tool-call-id collision in the live view; dropped child-run "View transcript" affordance;
  renderer/core Channel-detection divergence; `lin-agent-channel-` literal duplicated 4×; dead
  constants; duplicated label dispatch; shallow-copy isolation gap; e2e-mock suppression fidelity —
  ALL resolved in follow-up commit `27eab8ad` (incl. two new tests exercising the **real** runtime
  producing `streamingContent` and retaining the coordinator-only memory briefing). Re-verified:
  typecheck ✓ · `test:core` 1086 pass / 2 skip / 0 fail ✓ · `test:renderer` 526 pass / 0 fail ✓ ·
  targeted channel-activity `test:e2e` 4 passed ✓ · `docs:check` ✓.
- **`web_fetch` success rate — browser identity · cross-host redirects · transient retry · challenge
  precision (PR #288, cc-2)** — local, user-initiated `web_fetch` retuned purely for success rate (a
  deliberate local-only SSRF/privacy stance), **no new tool** and the result envelope unchanged. (1)
  Requests present a real Chrome desktop identity — User-Agent + `sec-ch-ua` client hints +
  `sec-fetch-*` — and across a redirect chain the headers track a real navigation: `Referer` follows
  Chrome's strict-origin-when-cross-origin default (full URL same-origin, origin-only cross-origin,
  dropped on an https→http downgrade) and `Sec-Fetch-Site` degrades monotonically once the chain
  crosses origin; the embedded-browser fallback renders with the same UA. (2) Redirects are followed
  transparently across hosts (shorteners/trackers/regional fronts), preserving the server's literal
  scheme (no http→https upgrade once redirecting, which would break an http-only target); a cross-host
  landing returns content plus a non-fatal `redirected_host` hint, and a redirect to a local/private
  host is the one case refused — on both the HTTP path (every hop validated by `isPublicWebFetchUrl`)
  and the browser fallback (`will-navigate`/`will-redirect` blocked + landing URL re-checked). (3) A
  raw transient transport throw earns one short-backoff retry, gated by a **denylist** of the
  deterministic faults (DNS/refused/TLS/unsafe-port/bad-scheme) that would fail identically — so the
  retry works whether the platform surfaces a Chromium `net::ERR_*` code or a generic fetch rejection;
  HTTP responses (403/429/5xx, Cloudflare) are never retried and route straight to the browser
  fallback. (4) Cloudflare-challenge detection narrowed to the `*cf_chl*` tokens + visible
  interstitial phrases, so a full article merely embedding a Cloudflare beacon / `challenge-platform`
  script / Turnstile widget is returned as-is rather than discarded for a wasted browser round-trip.
  Spec folded into `docs/spec/agent-tool-design.md`. **Gate (main):** `/code-review xhigh` over four
  review rounds → round 1 (15 findings: embedded-browser-fallback SSRF from dropped nav guards,
  Cloudflare beacon false-positives, 429/503 retry double-handling, dropped `application/json` Accept,
  http→https redirect upgrade, spec drift) → round 2 (6: re-added browser nav guards, narrowed
  markers, per-hop `Referer`/`Sec-Fetch-Site`, retry whitelist) → round 3 (3 SSRF host-classifier
  bypasses — IPv4-mapped IPv6, the `fc00::/7` ULA regex, trailing-dot `localhost.` — plus full-path
  cross-site `Referer` and chain-unaware `Sec-Fetch-Site`) → round 4 (IPv4-compatible `::a.b.c.d` and
  NAT64 `64:ff9b::/96` IPv6 decode) — all resolved and unit-tested. Merged via an integration merge
  resolving an `agentWebConstants.ts` conflict with #290 (both add a real Chrome UA; deduped onto a
  shared `CHROME_MAJOR`). typecheck ✓ · `test:core` 1113 pass / 2 skip / 0 fail ✓ · `docs:check` ✓.
- **`web_search` robustness — real UA · transient retry · DuckDuckGo fallback (PR #290, cc-2)** —
  three reliability improvements to the default `kind: "web"` path, **no new tool** and the result
  envelope unchanged. (1) The off-screen search window renders with a real Chrome desktop User-Agent
  (`setUserAgent`) instead of Electron's default (which advertised `Electron` + the app name), so
  engines serve the standard desktop SERP the scrapers target. (2) A transient navigation fault is
  retried once with a short backoff on both the primary and the fallback engine — and because the
  engines are fixed reputable hosts, `navigation_failed` (the dominant outcome of a mid-flight
  network/DNS blip, via `did-fail-load`), `network_error`, and nav `timeout` all count as transient;
  blocks, extraction misses, bad queries, and aborts do not. (3) When Google is blocked, fails
  recoverably, or returns zero results, `web_search` falls back to the DuckDuckGo HTML endpoint
  (`providerName: "duckduckgo_html"`); a parsed DuckDuckGo page is authoritative even when empty (so
  the agent hears "no results — broaden" rather than a misleading "retry / use a browser"), and if
  DuckDuckGo also fails to parse, the primary Google outcome (its hint/error + `google.com` finalUrl)
  is surfaced rather than discarded. The rate-limit gate moved from per-navigation (`withSearchWindow`)
  to **once per `web_search` call** (`execute()`), so the internal retry + fallback cascade no longer
  self-throttles or burns the cross-call burst budget mid-call; Bing Images and the DuckDuckGo
  fallback now share one `runServerRenderedSerp` skeleton so their block/abort/timeout handling cannot
  drift. The fallback warning no longer asserts "Google was unavailable" (the primary may have been
  reachable but empty/unparsed). Spec: `docs/spec/agent-tool-design.md`. **Gate (main):** `/code-review
  xhigh` (10 finder angles + verify + sweep) → 12 findings; cc-2's fix commit resolved them all (the
  headline being the retry that never fired because `isTransientSearchError` omitted `navigation_failed`,
  plus the false fallback warning, the rate-limit-slot multiplication, and Google-diagnostics loss on
  double failure); re-verified typecheck ✓ · `test:core` 1086 pass / 2 skip / 0 fail ✓ · `docs:check` ✓.
- **Unified agent transcript process UI (PR #284, codex-2)** — the assistant turn/process-fold
  renderer is extracted into one shared path (`AgentAssistantTurnContent` + `AgentTranscriptMessageList`)
  now used by the DM transcript, the child-run task-detail timeline, **and** the Channel live-run
  drill-in — delivering #280's deferred "full DM-style process reuse in the drill-in". A live turn
  shows a locked **"Working…"** row while active and default-collapses to **"Worked for …"** once it
  settles; the final answer always renders as top-level prose (never moves in/out of the fold, so it
  no longer remounts on seal), and live/sealed-resultless process groups auto-expand so interim
  thinking/tool work is never buried. Tool pending state is tightened: a tool row is pending only when
  its id is in `pendingToolCallIds` (or the single trailing in-flight tool when the runtime reports
  none), so a stale/resultless historical tool call no longer shows a perpetual spinner. The bespoke
  child-run transcript UI is removed — the task-detail panel adapts a raw child-run transcript into the
  shared rows (with real `Worked for`/`Interrupted` from `childRun.status`), and the Channel drill-in
  adapts the per-run `streamingText` into the same live assistant-turn UI while the canonical Channel
  transcript still receives only whole sealed utterances. Spec: `docs/spec/agent-event-log-rendering.md`.
  **Gate (main):** `/code-review max` (10 finder angles + verify + sweep) → 14 findings, all addressed
  by codex-2 (final-prose remount removed via `Math.max(0, lastProcessIndex+1)`; inner groups made
  live-aware `sealed={!turnActive}`; per-tool pending via a `fallbackActiveToolCall` instead of the
  whole-turn flag; orphan tool-result `compactText` + 280px `<pre>` cap restored; hidden-only
  `<system-reminder>` user messages dropped instead of rendering an empty bubble; dead
  `expandState`/`liveCollapsed` reachable-again or removed; shared `processSummaryFacts` + single
  `toolStatus` closure; live placeholder reuses `createAssistantPlaceholderFromModel` + a real
  `modelApi`; the `getComputedStyle` test stub now restores). A scope expansion (a Channel
  activity-area rewrite that collided head-on with the just-shipped #280 indicator) was caught at the
  gate and **dropped on rebase** — the PR keeps #280's indicator and only swaps the drill-in body.
  typecheck ✓ · `test:renderer` 525 ✓ · `test:core` 1081 pass / 2 skip ✓ · `docs:check` ✓ ·
  `agent-process` e2e 12 ✓ · `agent-composer` (Channel + child-run) e2e 2 ✓; light+dark visual not
  re-run this gate. ([#284](https://github.com/relixiaobo/lin-outliner/pull/284))
- **Channel "working" indicator rework (PR #280, cc)** — the multi-agent Channel "who's responding"
  surface changes from a corner-anchored floating activity pill (whose translucent list bled
  transcript text — 穿模) to an **in-flow status row** directly above the composer that occupies its
  own height, never overlaps the transcript, and is removed entirely when nothing is in flight.
  Collapsed, it is a quiet `menu` trigger: an avatar stack (`+n` overflow), a generic working summary
  (≤2 working → names, ≥3 → count), and reduced-motion-safe typing dots. Clicking it opens an
  **opaque level-1 menu** built on the shared overlay primitives (`MenuSurface` + `useAnchoredOverlay`
  for viewport flip/clamp + `useMenuKeyboard` for Escape / roving / focus-restore, portaled to
  `<body>`) — so it can never get stuck open or run off-screen, and the opaque `--overlay-bg` ends
  the bleed-through. Each row shows the per-agent state (thinking / using tools / received) with a
  semantic status dot, a per-run **Stop**, and a header **Stop all**; clicking a row drills into that
  run's live-text view. The producer already emits one entry per live run plus pending `received`
  turns, so this is a renderer + CSS + i18n change with no projection/main rewrite. DM / single-agent
  is unchanged; full DM-style process reuse in the drill-in is a tracked follow-up. Specs:
  `docs/spec/design-system.md`, `docs/spec/agent-event-log-rendering.md`.
  ([#280](https://github.com/relixiaobo/lin-outliner/pull/280))
- **Default-allow agent tool permissions (plan #277 → PR #279, codex)** — the agent tool permission
  model changes from the consequence model's COMMIT→`ask` tier to **default-allow + blocklist**.
  `decideAgentOperationEffect` returns `allow` for every effect except a non-overridable **hard
  redline** (`deny`): credential exfiltration, permission/provider/secret self-modification,
  payment, and root/home/whole-workdir host destruction. A small user-overridable **soft-block**
  tier (remote-code pipes, OS-persistence + git-internal writes, opaque/obfuscated execution,
  unparseable shell) raises an **allow-once / always-allow / block-now** approval card that defaults
  to block on a countdown; the auto-block now fires authoritatively in the main process. Tool
  permission settings gain a **user blocklist** and a **soft-block-allow exception** list alongside
  the grants ledger (`blocks` / `softBlockAllows`, persisted via
  `agent_append_tool_permission_block` and the Settings → Security panel), and the agent debug log
  can add a narrow `Command()` / `Action()` block after the fact. Static **heredoc redaction** stops
  `python3 - <<'PY' … PY` artifact generation from false-blocking as `hidden_exec`. Notice-only
  permission cards and the runtime auto skill-trust prompt are removed. **Pre-release: no
  migration** — the permission config gains `blocks` / `softBlockAllows` arrays; wipe
  `~/.lin-outliner-*` dev userData if needed. Spec: `docs/spec/agent-tool-permissions.md`,
  `docs/spec/agent-skills.md`.
  ([#279](https://github.com/relixiaobo/lin-outliner/pull/279))
- **Perf P2: default flat outliner, streaming projection patches, structural-save coalescing (PR #275, codex-3)** —
  three independent P2 optimizations from the performance program (`performance-optimization.md`).
  (1) The main outliner renders through the windowed/flat row producer by default; the recursive
  `OutlinerView → OutlinerItem → nested OutlinerView` path (which mounts every expanded node) is retained
  only as a reload-scoped diagnostic fallback behind `localStorage('lin:recursive-outliner') === '1'`.
  (2) Streamed direct-message turns no longer rebuild and clone the whole agent render projection per
  coalesced tick: main keeps the last emitted projection and emits a `projection_patch` for the single
  active assistant message (carrying a base revision; the renderer reloads the conversation if the patch
  cannot apply cleanly), folds it preserving unchanged entity references, reuses derived
  message/tool/pending-run objects, memoizes transcript rows, throttles the live markdown tail to an 80 ms
  parse cadence, and moves tail auto-scroll into one `requestAnimationFrame` without a per-revision forced
  `scrollHeight` read. Channel turns stay result-first/transcript-atomic and use the full-projection
  fallback. (3) Structural document mutations coalesce their `saveCore` into the existing 700 ms text-edit
  window instead of writing a whole workspace snapshot per edit, flushed before text materialization,
  transactions, undo/redo, and app `before-quit`. Gate: `/code-review xhigh` — every finding addressed and
  re-verified; merged result passes typecheck + `test:core` + `test:renderer` + `docs:check`. Specs:
  `docs/spec/architecture.md`, `docs/spec/ui-behavior.md`.
  ([#275](https://github.com/relixiaobo/lin-outliner/pull/275))
- **Run-grounded agent debug surface (PR #264, cc-2)** — the agent debug panel is rebuilt as a
  read-only **view of the execution tree** (conversation → runs per agent → rounds → request-window
  / response / tool-exchange), derived directly from the run ledgers the system already writes —
  no parallel snapshot representation, no provider-wire re-parsing, no cross-stream seq-matching.
  Each round is one provider call, bounded by `assistant_message.started`. The agent's outbound
  system prompt + tool schemas are captured once per run (hash-deduped) into the run's own stream;
  the triggering user message and any cross-run tool-result slimming are spliced into a run's
  derivation from a single `latestSeq`-cached read of the conversation segment (slimming matched
  to its producing run by globally-unique `toolCallId`). Every on-screen string passes one
  secret-redaction gate — key-name + value-pattern (`sk-`/`ghp_`/`github_pat`/JWT/`Bearer`/
  `password`/`api_key`…) + large-blob elision, consolidated in `agentSecretRedaction.ts`.
  Replaces the four `agent_debug_*` commands with `agent_debug_view` / `agent_debug_run`, and
  deletes the old snapshot/projection surface (`agentDebug.ts` + `agentDebugProjection.ts`,
  ~800 lines) with its IPC, types, and the `debug.snapshot.created` event (now
  `debug.run_snapshot.created`, run-stream-scoped and replay-neutral). Pre-release: no migration —
  old debug payloads are simply gone. Spec: `docs/spec/agent-event-log-rendering.md`.
- **Providers own the connection, the agent profile owns model + effort (PR #267, cc)** — a provider
  config is now a **connection record only** (`{ providerId; baseUrl?; enabled }`); `modelId` /
  `reasoningLevel` are dropped from the stored config and from the `AgentProviderConfigView` /
  `AgentProviderConfigInput` protocol surface. Which model/effort actually runs is owned by the agent
  that runs: user/project agents keep `AgentDefinition.model` / `effort`, and the read-only built-in
  assistant gets a **settings-owned overlay** keyed by `agentId` (`builtInAgentProfiles`, via
  `getBuiltInAgentProfile` / `setBuiltInAgentProfile`). The provider-config window becomes
  connection-only (credential/auth, optional Base URL, `Test connection`, Save/remove — no model or
  thinking-level picker), and `Test connection` validates **reachability** with an internally chosen
  probe (first-ranked catalog model → `GET {baseUrl}/models` discovery for custom endpoints →
  honest "endpoint reached but no usable model"). The composer footer **drops the model chip** — a DM
  talks to an agent identity and a channel to a roster, not to one model; model/provider/effort stay
  visible only in the Details popover, run/debug, ledger, and the profile editor. A new
  **capability-driven `AgentModelEffortSelector`** (Provider → Model → effort, effort options derived
  from the model's `supportedThinkingLevels`) saves the canonical provider-qualified id, parsed by one
  shared `core/agentModelId` helper so a colon-bearing model id (Bedrock `amazon.nova-lite-v1:0`,
  Ollama `qwen2:7b`) is never mis-split. Runtime resolution: request override → agent-owned model →
  catalog first-ranked fallback, coercing effort to the model's supported ladder (default `medium`).
  Two review rounds (xhigh + follow-up): round 2 fixed a custom-endpoint inherit-model DM/channel turn
  that threw instead of degrading to a configuration-error agent, a custom (no-catalog) provider that
  collapsed out of the selector, a stale-effort save divergence, a `/models`-only false "connection
  successful", and folded the reasoning ladder into a shared `AGENT_REASONING_LADDER`. Implements the
  `provider-connection-model-ownership` plan (#256, shape (a)). Spec:
  `docs/spec/agent-pi-mono-implementation.md` + `agent-event-log-rendering.md` +
  `agent-delegation-runtime.md` + `design-system.md`.
- **Unified file preview surface (PR #262, codex-2)** — file-node previews and loose
  agent/local-file previews collapse into one `nodeId`-keyed `FilePreviewPanel` with two lifecycle
  states (`loose` → `ingested`) over a single mounted frame: a **read-only filename title** (fixing
  the `Untitled` shown by title-less file nodes), a breadcrumb sourced from the filesystem/source
  when loose and from outliner ancestry when ingested, the shared `FilePreviewShell` hero, and the
  file node's children outline + backlinks when ingested. **Add to outline** copies the loose source
  into an asset, creates a file node under Today, and rebinds the same mounted surface to the new
  node **in place** (no remount/jump) — rewriting the bound view's target to the stored asset so the
  hero no longer depends on the volatile loose source. File nodes no longer open a `NodePanel` node
  page: every navigation entry routes them to the unified surface, which is also reported to the
  agent's user-view context and persists its children-outline expansion. Panel chrome
  (`usePanelTitleDock`, `PanelStickyBreadcrumb`, `PanelChildrenOutline`) is extracted to
  `PanelShared.tsx` and shared with `NodePanel`. Reviewed over **three `/code-review high` rounds**
  (round 1: 10 findings — assetId/UUID-as-title, file nodes missing from agent view-context +
  outline-expansion persistence, a scroll/breadcrumb reset-key mismatch, a post-bind loose-source
  hero divergence, a false "added" confirmation, an inert-but-clickable loose breadcrumb, scattered
  reroute, and chrome duplication; all fixed across rounds 2–3). typecheck + 482 renderer tests +
  file-attachments/agent-process e2e green. Specs: `docs/spec/ui-behavior.md` +
  `docs/spec/workspace-layout.md`.
- **Unified agent prompt composition + Anthropic L0 cache breakpoints (PR #263, codex)** — the four
  ad-hoc prompt assemblers (`LIN_AGENT_SYSTEM_PROMPT`, `LIN_CHILD_AGENT_CORE_PROMPT`,
  `buildFreshAgentSystemPrompt`, `buildAgentMemberSystemPrompt`) collapse into one
  `composeAgentPrompt(definition, context)` whose blocks are layered by **scope × volatility**
  (universal **L0 firmware** → capability modules → per-agent persona/skills). **Custom DM/Channel
  agents and fresh child runs now receive the same perception and conduct/safety firmware as the
  built-in assistant**; memory and child-run behavior become capability modules that follow effective
  tool capability (so an agent's recall/dream guidance tracks the tools it actually has). Adds
  **cross-agent prompt caching**: for multi-agent Channel member runs and fresh child runs,
  `applyAgentPromptCacheBreakpoints` rewrites the Anthropic provider payload in `onPayload` — it
  splits the stable system block into `L0 firmware` + `rest` (both cache-marked) so the identical
  firmware prefix is shared across agents, while preserving the provider's last-tool/last-user
  breakpoints inside Anthropic's 4-breakpoint budget (dropping the OAuth identity breakpoint first
  when over budget). Single-agent DMs, fork child runs (which still inherit the parent prompt), and
  non-Anthropic providers are unchanged; per-turn environment, memory briefings, and user-view
  reminders stay outside the stable prompt. Tool-rule matching and agent display-name derivation are
  extracted to shared `agentToolRules.ts` / `agentDefinitionDisplay.ts` so prompt capability gating
  cannot drift from the actually-injected tool roster. Specs:
  `docs/spec/agent-pi-mono-implementation.md` + `docs/spec/agent-delegation-runtime.md`.
- **Agent permission model — consequence-based `decide(effect)` core (PR #252, codex)** — the agent
  tool permission gate is rebuilt around an operation's **consequence** rather than a mode/action/
  classifier matrix. `decideAgentOperationEffect(effect)` yields three outcomes: local reversible
  **WORK → allow** silently, **COMMIT** (irreversible / external / credential / outside-scope)
  **→ ask** (approve once or remember as a narrow grant), and a **FORBIDDEN** safety **floor → deny**
  that trust settings cannot bypass. The old **3 safety modes, the LLM bash classifier, Full Access,
  the shell allowlist, and the renderer exception editor are removed**; shell inverts to a
  floor-blocklist (an unknown *static* command is WORK by construction). `file_delete` is a new
  reversible tool that moves content to `.agent-trash`. Grants are narrow and typed —
  `Scope(read|write:root)` (path-containment matched; a read grant never authorizes a write),
  `External(target)`, `Command(form)` — and revocable from Settings ▸ Security. Floors cover host
  destruction, disk format, raw-disk / persistence (incl. `crontab`) / git-internal / permission-config
  writes, credential exfiltration, and obfuscated remote-code execution, scanning the `bash -c` inner
  command and splitting on `\n` / lone `&` (redirections preserved). PR-1 of the
  `agent-permission-redesign` set; folder-handoff and `file_convert` follow. Specs:
  `docs/spec/agent-tool-permissions.md`, `agent-pi-mono-implementation.md`, `agent-skills.md`.
- **Colored identity avatars + icon-free "Worked for" header (PR #245, cc)** —
  an agent's avatar now carries a per-identity hue instead of one neutral fill: a dedicated
  `--identity-tint-0..7` palette — its own decorative category, kept distinct from functional state
  (B3) and status (B4) — deterministically assigned by an identity hash (`agentAvatarColor.ts`, a
  byte-identical murmur to `tagColors.ts`) and mixed toward `--surface` so the tint reads soft and
  theme-aware in both light and dark, never a baked box. A hairline same-hue ring gives the small pill
  definition; it ships as the tokenized `--avatar-tint-ring` (B11 — `box-shadow` stays a `var()`,
  mirroring `--inline-ref-focus-shadow`). Separately, the result-first process header drops its leading
  status glyph for a single **trailing** chevron slot (codex-style); the live spinner swaps into that
  same slot while the turn is working, so the title text never shifts across the loading→sealed
  transition ("labels don't move"). Renderer/CSS only — no protocol/shared surface. Visual gate verified
  light + dark; design-system token guards green. Spec: `docs/spec/design-system.md`.
- **Compact Channel attribution — avatar+name header over a full-width reply (PR #243, cc-2)** —
  a Channel assistant row no longer indents its body into an avatar gutter. The row is now a column:
  an **attribution header** (avatar + speaker name on one line) above a **full-width reply body** aligned
  to the avatar's left edge, so every Channel reply reclaims the horizontal space the per-message avatar
  column used to cost. The actor-name block moves from beneath the reply into the header (the old negative
  `margin-bottom` hack drops; the row gap owns that spacing). A DM assistant row carries no attribution
  header, so its content was already full-width and is unchanged. Renderer/CSS only — no protocol/shared
  surface. Visual gate verified light + dark. Spec: `docs/spec/design-system.md`.
- **Result-first turn fold for DM and Channel (PR #240, cc-2)** —
  every agent turn now renders **result-first**: the final answer is the message, while thinking,
  tool calls, and interim narration fold behind a collapsed `Worked for {duration}` disclosure. DM
  and Channel share one fold mechanism — the Channel text-only render path and the single-tool inline
  block are removed — and each Channel agent's final message gets its own copy/regenerate action bar
  (`isLastInTurn` is now actor-aware). `Worked for {duration}` is the producing run's wall-clock
  (`updatedAt − startedAt`, threaded as `runDurationMs` on the message entity), falling back to the
  descriptive "Thought · used N tools" summary when the run wall-clock is unknown — a still-`running`
  run reports unknown rather than a fake "<1s". A resultless turn that ends on a tool/thought
  auto-expands so its interim text stays visible instead of hiding behind the fold; a multi-run turn
  (reactive-compaction retry) sums each distinct run's wall-clock. The pure row-building logic is
  extracted into `agentConversationRows.ts` for unit testing. Pairs with #239 (the agent-side
  environment reminder) to complete `channel-group-chat-semantics`. Spec:
  `docs/spec/agent-event-log-rendering.md`, `docs/spec/agent-architecture.md`.

- **Channel/DM framing moves from the member system prompt to a per-turn environment reminder (PR #239, cc-2)** —
  a Channel/DM member's stable system prompt is now **identity only** (display name + mention,
  description, authored instructions, profile skills) via one `buildAgentMemberSystemPrompt` that
  replaces the split `buildChannelPeerSystemPrompt` / `buildDirectMessageAgentSystemPrompt`, so the
  same agent's prompt is byte-identical (and cacheable) across its DM and any Channel. DM-vs-Channel
  framing, the member roster, and the Channel communication norms are **environment**, so they ride a
  new per-turn `<conversation-environment>` `<system-reminder>` (`buildConversationEnvironmentReminder`,
  assembled in `deriveRuntimePiMessages` next to the memory reminder, POV-correct for the executing
  member). The Channel block adds the previously-missing norm — *only your final message is shared with
  the other members; intermediate thinking and tool steps stay private* — so members lead with the
  result instead of narrating their process into the thread. DM-vs-Channel is keyed off conversation
  **identity** (`isCanonicalDmConversationId`), not live agent headcount, so a coordinator-only Channel
  is still framed as a Channel. `escapeXml` moves to `src/core/reminderXml.ts` and the POV identity
  preamble + roster share one `agentMemberMentionLabel` (consistent escaping). PR 1 of 2 for Channel
  group-chat semantics (agent side); the human-side render fold + per-agent action bar follow. Gate
  (main): `/code-review` flagged a DM/Channel authority regression (decided by headcount, not identity)
  — fixed to `isCanonicalDmConversationId` with a coordinator-only-Channel runtime regression test;
  typecheck + `test:core` (1016) + `docs:check` green. Spec: `docs/spec/agent-pi-mono-implementation.md`.
- **Cross-agent contact is baseline-allow + consultee approval attribution (PR #236, cc)** —
  `DEFAULT_ACTION_DECISIONS['agent.delegate.spawn']` flips `'ask'` → `'allow'`, so consulting another
  agent is ungated in **every** safety mode (`ask_first` / `balanced` / `full_access`); safety stays on
  each consultee's **own** capability permissions plus the unchanged depth/cycle/concurrency guards
  (`agentDelegation.ts`), and the now-redundant `agent.delegate.spawn` entry is dropped from
  `FULL_ACCESS_ALLOW_ACTIONS`. A consultee's own gated (`'ask'`) **or** hard-denied
  (`permission_notice`) action that surfaces in the parent conversation is now **attributed to it** via
  `AgentApprovalRequestView.requestedByAgentId`, resolved to the consultee's canonical mention token on
  the approval card ("Requested by @researcher"); attribution is derived at the delegation layer from
  the authoritative `contextMode` (a fresh consult → the consultee; a fork → the spawner's inherited
  attribution, so a consultee's own fork stays the consultee's and the user's own fork stays
  unattributed), not an id heuristic. The contradictory "Spawn child agents" Security rule and the
  vestigial `allowable` mechanism (its only non-allowable rule) are removed. Spec:
  `docs/spec/agent-tool-permissions.md`, `docs/spec/design-system.md`,
  `docs/plans/agent-conversation-model.md` (Build note → shipped).
- **UI quality Layer 1 — composition rhythm + design-system consistency (PR #228, codex-2)** —
  a CSS-only sweep (plus spec sync) shipping the two Layer-1 lanes of the UI-quality suite as one
  pass. Composition tokens are centralised in `tokens.css`: the reading measure `--reading-max`
  (720px) is split from the `--settings-content-max-width` (920px) utility cap, with
  `--panel-content-max` aliased onto the reading measure; a `--title-display/-section/-group`
  heading scale and a `--row-h-dense/-comfortable` row-height tier alias the existing values, so
  these are tokenizations with no visual change. Visible alignments: the outliner / agent / panel
  context menus, the agent-composer image preview, and the date popovers now use the shared glass
  material (`--material-popover` + `--material-backdrop`, which carry the
  `prefers-reduced-transparency` / high-contrast opaque fallback for free) on the
  `--radius-overlay-sm` (10px) overlay radius rung; icon-only chrome controls (breadcrumb close,
  page-back, panel close, view-toolbar pill, panel more-button) drop their box for pill geometry and
  colour-only hover (B6); `:focus` becomes `:focus-visible` across fields and triggers with the
  neutral focus ring, retiring the `--agent-accent` focus leak in the subagent follow-up textarea
  (B3); chrome captions are `user-select: none` (B10); and the current agent conversation row uses
  `--selection-bg` so it reads distinctly from hover. Spec corrections folded in: the product icon
  library is documented as `lucide-react` (the prior "hand-curated inline-SVG set" description was
  stale), and the design-system B2 one-liner now reflects that in-app theming drives
  `nativeTheme.themeSource` with no renderer `[data-theme]` bridge. A post-merge cleanup dropped the
  unconsumed `--row-h-compact` rung the lane had declared (agent rows stay compact via line/padding
  geometry, not a fixed row height) and re-synced the spec. Design folded into
  `docs/spec/design-system.md`.
- **Responsive workspace robustness — rails, pane capacity, indentation, tag/breadcrumb overflow (PR #223, codex-2)** —
  at small window widths the floating sidebar and agent rail widths were independent and could
  reserve more horizontal space than the window could host; because the canvas hides horizontal
  overflow, the main reading pane would silently crush instead of exposing a rescue path. New
  shared `src/renderer/ui/workspaceResponsiveLayout.ts` holds the layout metrics + floor math.
  Rail widths now separate a **user preference** from a **rendered width**: drag / keyboard /
  reset update the preference; window resize, pane-count changes, and rail reopen recompute only
  the rendered width against the current pane floor (agent rail yields first, then sidebar,
  neither below its minimum). The key consequence is the preference is never destroyed — a
  transient narrow window no longer permanently ratchets a wider rail down. New pane creation is
  gated by available width: root/file-preview splits repurpose an existing workspace pane when too
  narrow, and an agent-debug open in a too-narrow window now reports "Window is too narrow to open
  another pane." (en + zh-Hans) instead of silently no-oping. Deep outline, sidebar-tree, and
  preview/backlink indentation all cap visual depth at one shared `MAX_OUTLINE_INDENT_DEPTH`
  (document depth/keyboard structure unchanged). Tag bars wrap chips with row gaps (inline
  plain-text-row slot expands the row instead of overflowing the next), and breadcrumb segments
  carry width shares that protect the final current-context segment in narrow panes. A CSS
  `min-width` backstop covers the single-pane canvas; multi-pane stays JS-gated by design (a hard
  per-pane CSS floor would turn impossible-narrow states into canvas-level horizontal scroll).
  `docs/spec/workspace-layout.md` updated. Gate (main): `/code-review high` (7 angles) surfaced 10
  findings (top: a rail-width ratchet that lost the user's chosen width on transient resize; an
  agent-first ordering violation on single-rail drag; a per-pointermove reflow on the drag hot
  path); all fixed in the follow-up commit — preference/rendered split, unified floor clamp,
  metrics snapshotted at drag start, pure capacity predicate split from the reflow side effect,
  dead exports removed — with new renderer + e2e coverage. Renderer-only, no protocol change.
- **Outline tag/checkbox syntax unified on one shared grammar (PR #222, codex)** —
  `src/core/textSyntax.ts` becomes the canonical home for the outline tag token,
  tag extraction/removal, canonical `formatTag` serialization, the live-`#`-trigger
  query, and checkbox-marker parsing. The agent outline parser, paste metadata
  harvest, live `#` trigger, agent projection, user-view context, and clipboard
  serialization all import the shared helpers instead of four drifting local
  regexes. User-visible changes: `formatTag` now bracket-escapes tag names
  containing `]`, backslash, or newline-style characters (`\]`/`\\`/`\n`/`\r`/`\t`)
  so such names round-trip, and emits bare `#中文` for Unicode names (one shared
  bare-name class for parse and format); checkbox markers are recognized when the
  marker is alone or whitespace-separated (`[x] body`, bare `[x]`/`[ ]`) while
  `[x]body` stays literal text; empty tag names fail fast. Bracket tag names accept
  raw backslashes. Pure refactor, no protocol change. Spec:
  `docs/spec/agent-tool-design.md`, `docs/spec/ui-behavior.md`.
- **Delegation run records + run-status converge onto one shape (C1+C2) (PR #225, cc-2)** —
  the three near-duplicate records describing a delegated (child) run now derive from one
  canonical `DelegationDetail` (`src/core/agentEventLog.ts`): the durable
  `AgentChildRunRecord` and the IPC `AgentChildRunSnapshot` ARE a `DelegationDetail`, and the
  in-memory runtime record (`AgentRunRecord` → `DelegationRunState`) `extends` it with
  live-execution state only. The shared id fields
  (`executingAgentId`/`parentAgentId`/`memoryOwnerAgentId`) became **required** — the spawn
  writer always sets them — so `restorePersistedRuns` carries the descriptive half verbatim
  and the defensive fallbacks drop out (C1). The dual run-status enums collapse:
  `AgentChildRunStatus` (`…|stopped`) is **deleted**; every data-layer surface (durable
  record, IPC snapshot, runtime record, `child_run.*` events, run ledger, and the
  model-facing `AgentChildRunActionResult`) now speaks the single `AgentRunStatus`
  (`…|cancelled`) vocabulary. `renderTaskStatusFromRunStatus` moves to core
  `agentRenderProjection.ts` as the **one** pure projection (`cancelled → stopped`) every
  task/child-run render entity flows through — the renderer keeps the user-facing word
  "stopped" while the data is uniform (render components unchanged). `unattended` is now
  **durable** — recorded on `child_run.started` and projected onto the record — so a
  cross-restart resume rebuilds the agent with the same approval policy (was in-memory
  only). The run ledger's terminal-status → lifecycle-event mapping is now an exhaustive
  `satisfies`-checked table instead of a nested ternary. C3 (run-context assembly) stays
  folded into the M-series context-assembly rewrite (A7). No `commands.ts`/`types.ts`
  change. Design folded into `docs/plans/agent-program.md` § Convergence.
- **Agent dock + channel configuration refinement (PR #217, codex)** — refines the
  agent dock header, conversation menu, DM/Channel rows, and unread/menu
  affordances to the current design-system rules, and moves agent and channel
  **create/edit** out of in-settings inline editors into dedicated native child
  windows. New `AgentConfigWindow` / `ChannelConfigWindow` renderer surfaces are the
  single authoring path (the Settings "Agent Profiles" pane is now a list of launch
  points only); main-process window construction is unified behind one
  `createConfigChildWindow` helper shared by the provider, agent, and channel
  windows, all with the same A3-hardened `webPreferences` and `isLiveWindow`-guarded
  parent/cleanup handling. The built-in **Tenon assistant** is now registered in the
  delegation registry, so selecting it as a command/child `agent_type` resolves and
  dispatches instead of throwing; and a persisted fresh child run whose agent
  definition was deleted/renamed after it started now **recovers** by continuing
  with the Tenon assistant rather than hard-erroring on resume (a durable recovery
  path, not a generic dispatch fallback). Settings deep-links are fixed: `agent=<id>`
  opens that agent's config window and creation uses a separate `agentMode=create`
  param, removing the reserved-value collision that made an agent literally named
  `create` un-editable. Creating a channel now navigates the main panel to the new
  conversation (`agentNavigateToConversation` IPC), and `refreshAfterSettingsChange`
  reloads agent definitions (concurrently) so a freshly authored agent's name/POV is
  no longer stale until a conversation switch. Restores the Channel member POV
  inspector entry from the Slack-style row menu. Removes the dead DM→Channel
  escalation affordance and the Channel-creation `systemNotice` plumbing
  (PM-ratified 2026-06-13: DM is strictly 1:1; any multi-party conversation is a
  first-class named Channel, so there is no in-DM "upgrade to Channel" entry point).
  Adds real Electron smoke coverage for the agent/channel config child-window
  lifecycle (`tests/smoke/config-windows.smoke.ts`) and a draft plan
  `docs/plans/channel-async-message-bus.md` for the next Channel-as-async-IM-bus
  change (captured separately, not implemented here). Specs:
  `docs/spec/agent-delegation-runtime.md`, `docs/spec/design-system.md`. Reviewed
  via `/code-review high` (10 findings — all fixed in the follow-up commit, verified
  by re-review with no new regressions).

- **Agent UI glyph refresh (main, fast-track)** — the thinking indicator (thinking
  rows + the thinking-only process-block header) now uses a dedicated `ThinkingIcon`
  (lucide `Dices`) instead of the brain, and the skill glyph (the loaded-skill
  affordance + the Settings → Skills category, which previously shared `BrainIcon`
  with Memory) uses `Notebook`. `BrainIcon` stays for the memory tools
  (recall / dream / Memory settings), so Memory and Skills are no longer drawn with
  the same icon.

- **Security Settings IA redesign — one honest trust model (PR #215, codex-3)** —
  fixes a security-surface correctness bug: the old Security page read only
  explicit overrides and otherwise showed the literal `Ask first`, so under Full
  Access it displayed "Fetch web / Delete files / Run scripts → Ask first" while
  the runtime would actually run them without asking. The page now mirrors the
  runtime precedence — **hard safety blocks → your exceptions → the selected mode
  default** — by sharing one pure decision model. A new `src/core/agentPermissionModel.ts`
  holds the per-action-kind default table, the `ask_first`/`full_access` adjustment
  sets, and `effectiveActionDecision(actionKind, mode, overrides, actionDefault?)`;
  both the runtime fallback (`agentPermissions.ts`) and the renderer
  (`permissionSettingsModel.ts`) compute from it, so display and runtime can no
  longer drift. **Behavior-preserving extraction**: the runtime decision and
  precedence are unchanged (the pre-existing `tests/core/agentPermissions.test.ts`
  is untouched and passes; a new parity + truth-table test pins it), hard blocks
  and the #214 `agent.skill.write` removal are preserved, and per-descriptor
  `defaultDecision` is now injected from the central table except where a context
  is intentionally stricter (outside-area/sensitive `deny`, inline shell edit
  `ask`). The page is rebuilt around **Default + Exceptions**: the three-way mode
  is the living default, explicit rules surface as visible deltas, deviation flips
  the header to a derived "Custom · based on `<mode>` · N changed" with Reset, and
  Granted Trust + Advanced collapse into one Exceptions list plus an "Add an
  exception" disclosure (`agent.delegate.spawn` stays non-allowable; accepted
  skill hashes are listed separately). Specs synced (`agent-tool-permissions.md`,
  `agent-skills.md`); i18n en + zh-Hans. Gate (main): typecheck + test:core
  (944 / 0 fail) + test:renderer (430 / 0 fail) + agent-settings e2e light/dark
  (27 / 0); deep manual security/behavior-preservation review in lieu of the
  billed `/security-review` (PM decision, mechanism byte-identical to review).

- **Compact loaded-skill tool calls (PR #216, codex-2 + main follow-up)** — when
  the model invokes an inline `skill` (status `loaded`), the agent transcript no
  longer renders a generic Input/Output disclosure card whose Output is just the
  `Launching skill: <name>` receipt. Instead it shows one compact line — a
  dedicated skill glyph, the slash-prefixed skill name, and dimmed invocation
  args — because the real payload is the steering message injected into the next
  model turn, not a user-inspectable tool output. `context: fork` skills keep the
  normal expandable disclosure (they carry a real child-run result). Detection
  branches on the existing `details.data.status` (`loaded` vs `forked`) with a
  `Launching skill:` text fallback; no backend/protocol change
  (`AgentToolCallBlock.tsx` + token-based `agent-tool-rows.css`). Main follow-up
  polish: the glyph is a dedicated `SkillIcon` (not the `BrainIcon` shared with
  recall/dream memory tools), and the ellipsis-truncated name/args carry `title`
  tooltips so the full value stays inspectable on hover. Spec: `docs/spec/agent-skills.md`.
  Gate (main): typecheck + test:renderer (427 pass / 0 fail) + agent-process e2e
  light/dark (`renders loaded skill calls`, 1 pass).

- **Agent authoring cleanups (PR #213, codex-4)** — closes the #167-review-gate
  residue. Agents loaded from `additionalAgentDirectories` now render **read-only**
  in the editor (Duplicate only, no Save/Delete) since every write to them is
  rejected by the main-layer containment guard anyway — `isAgentDefinitionWritable`
  (`not built-in AND contained in a writable agents dir`) drives the view's
  `readOnly`. An out-of-catalog `effort` value now coerces to "Inherit" in the Form
  `<select>` instead of a browser-auto-selected catalog option. A new core guard
  test runs the real `filterAgentTools` over the renderer `TOOL_CATALOG` so the two
  can't silently drift. (The fourth cleanup, AGENT.md parser consolidation, already
  shipped in #184.) Gate (main): typecheck + test:core (923 pass / 0 fail) +
  test:renderer (421 pass / 0 fail) green; no styling change (B-series N/A); spec
  `agent-delegation-runtime.md` synced in-PR.

- **Agent permission safety modes (PR #193)** — the app-level
  `permissionMode: trusted|restricted` is replaced by a global three-level
  `AgentSafetyMode` (`ask_first` / `balanced` (default) / `full_access`) that
  supplies descriptor default decisions as a first-class policy layer inside
  `evaluateAgentToolPermission`, ordered after configured deny / the restricted
  delegation sandbox / configured allow-ask and before the descriptor default. The
  profile never materializes as broad allow rules and can never weaken a hard
  floor: `full_access` only promotes classified non-redline routine automation
  (allowed-root file/outliner edits + deletes, web fetch, local/project/dependency
  execution, network writes, git/GitHub mutation, subagent spawn, Dream, skill
  content writes, background processes) and still asks for deploy/publish, sandbox
  override, config writes, sensitive local reads, and outside-root access — unknown
  shell, sensitive writes, exfiltration, host destruction, permission modification,
  and payment stay denied; `ask_first` additionally asks for ordinary local
  file/outliner edits and skill invocation. Legacy stored `permissionMode`
  normalizes at read/write (`restricted→ask_first`, `trusted→balanced`); agent
  definitions keep `permission-mode: restricted` only as a narrow delegation
  sandbox and legacy `permission-mode: trusted` frontmatter is ignored on parse so
  a definition can never widen above the global mode. The composer approval card
  grew from one form to three kinds (`tool_permission` / `skill_trust` /
  `permission_notice`): tool approvals add a *Hand everything to Lin, stop asking*
  action that switches the global mode to `full_access` and approves the current
  call; the in-flow `skill_trust` card accepts an unratified mutable skill's exact
  current content hash (refused on mismatch) so automatic use no longer needs a
  Settings detour; tell-only `permission_notice` cards make hard/configured denials
  visible and dismissible (single-slot per conversation — a newer notice resolves
  and replaces the older). All three card kinds listen to the active run's abort
  signal and resolve as declined (`run_aborted` for blocking waiters) on stop. The
  Settings → Permissions page becomes **Security**: a global trust-level control, a
  revocable **Granted Trust** projection over action allow rules (revoked
  immediately, also merged into any unsaved draft) and accepted skill hashes, plus
  the prior action-kind rows demoted to **Advanced**. New permission event sources
  (`safety_mode_profile`; reserved `trust_ledger`) distinguish default from
  explicit resolution paths. Gate review (this main agent), two rounds: round 1
  flagged missing abort handling on the two new card kinds, unbounded
  permission-notice accumulation, and a save-vs-immediate inconsistency between the
  two Granted Trust revoke buttons; round 2 resolved all — a shared
  `denyPendingApprovalForRuntime` helper + abort-signal threading through skill
  tool / skill-shell / notice paths, single-slot notice dedup, and immediate action-
  grant revocation. Gates green: typecheck, core 866/0-fail (+5 new edge-case
  tests), renderer 410/0-fail, e2e (composer + settings) 61/61 with the new
  skill-trust / notice / Security specs (unrelated composer-geometry timing flakes
  only). Specs synced (agent-tool-permissions / agent-skills / agent-tool-design /
  agent-program F6); plan archived `done`.
- **Agent memory: episodic sources + discriminated-union provenance (PR #195)** —
  memory realignment PR-2 (D-4 episodic layer + D-5 sources reshape). A
  `MemoryEntry.source` is now a discriminated union: a raw stream span
  `{stream: 'conversation' | 'run', streamId, range: {fromSeqExclusive, throughSeq,
  throughEventId}}` addressed in that stream's own seq space, or `{episodeId}`. Dream
  consolidation now writes a memory-owned episode gist (new `memory.episode_recorded`
  event projecting `AgentMemoryEpisode`) and the semantic facts it commits cite that
  episode; the store maintains a principal-gated reverse index (episode → citing
  facts). `recall(include_evidence)` zooms fact → episode gist → raw span, resolving
  conversation and run evidence through one shared seq-window reader; the durable gist
  is returned even when every raw span is gone (it is the memory-owned artifact), and
  the gist reserves its share of `max_chars` before raw spans (and is itself clamped to
  the remaining budget). The legacy `messageRange` evidence resolver and the dead
  `buildDreamMemoryExtractionSpan` path were removed. Storage layout bumped to **v3**
  with no legacy source reader — pre-release clean-cut wipe of old agent data, no
  migration. Specs synced (agent architecture / data-model / delegation-runtime /
  event-log-rendering / tool-design); the superseded `agent-memory-episodic-index`
  draft is archived.
- **Run unification: the subagent entity is dissolved (PR #184)** — the concept
  model's 7 primitives now hold in code: a delegation is just a Run whose
  `parentRunId` points at another run. A delegated (child) run is an ordinary
  Run with its own `runs/<runId>/` append-only ledger; the parent stores only
  the `parentToolCallId ↔ childRunId` join — `state.subagents` and transcript
  payload snapshots are gone. ONE evidence addressing scheme everywhere (stable
  `{seq, eventId}`; the `runId:message:N` codec and payload pinning deleted),
  ONE watermark shape (`{seq, eventId}` per stream; the positional
  `{messageCount, payloadId}` cursor deleted), ONE compaction semantics
  (event-sourced; the snapshot-rewrite path deleted — the #178
  evidence-preserving invariant now holds structurally). The word `Subagent`
  left the type system (`agent_child_run_*` commands, `child_run.*` events,
  delegation/child-run vocabulary); AGENT.md frontmatter parsing exists exactly
  once (`core/agentMarkdown.ts`); a `layout.json {v}` generation sentinel
  replaces the #180 detector pile (fail-open invariants carried over;
  pre-release wipe, no migration). Fork-vs-fresh semantics (#164), memory
  ownership, permission flow (verified byte-equivalent at the gate), sidechain
  rendering, and task-panel visibility are preserved. Hardened across two gate
  rounds: a `runs.json` read-modify-write race that could silently drop a
  finished turn's messages from replay is serialized onto the index queue
  (red-verified regression test); the child-run reducer now accepts
  terminal→running as resume semantics; the e2e layer genuinely migrated to the
  new transcript command; quit-path settling covers per-run ledger queues; the
  new `agent_child_run_transcript` IPC fail-closes on cross-conversation reads;
  Dream skips delegation ledgers missing their `run.started` boundary. E2E
  316/316 green; visual verification light + dark passed.

- **Outliner focus and selection shortcut polish (PR #186)** — entering a regular
  node page now places edit focus at the start of the first visible body row (the
  trailing draft when the page is empty; search pages such as Recents stay
  result-views and take no edit focus). `Cmd+A` escalates from fully selected
  editor/field text to visible-row selection on a second consecutive press (an
  empty control escalates immediately). `Backspace` at the start of a field name
  deletes the field row through the selection-delete path; that and empty-content-row
  deletion keep focus on the previous visible row, the next surviving row, or the
  panel trailing draft when it was the only body row. Reopening the collapsed agent
  dock focuses the composer as a true one-shot (an approval/question card consumes
  the reopen without a later focus steal). `Cmd+[` / `Cmd+]` page history now works
  while text is focused; `Option+Arrow` stays platform word-navigation inside
  editors. Spec synced in-PR (`ui-behavior.md`, `outliner-parity-matrix.md`,
  `workspace-layout.md`).

- **Workspace skills require explicit acceptance (PR #185)** — `project`-source skills
  (anything under the workspace's `.agents/skills`, including nested discovery and
  in-root additional directories) now fail **closed**: they stay out of the automatic
  model skill listing and refuse model-triggered invocation until the user accepts the
  exact current `SKILL.md` content hash in Settings → Skills. Slash invocation still
  works immediately (the user's command is per-run consent). Hand-edit
  self-ratification is now `user`-source only; a repo update changes the hash and
  drops an accepted workspace skill back to pending. Trust derivation is a single
  pure function (`deriveSkillTrust`) feeding both model gates; the Skills tab marks
  unaccepted project rows with a workspace-specific chip. Spec folded into
  `docs/spec/agent-skills.md`; plan `agent-skill-workspace-trust` archived `done`.
  Follow-up copy fix on `main`: the pending chip separator now uses the codebase's
  `·` convention in both locales.

- **Memory realignment Step 0 + PR-1: one person rule, bullet briefing, recall subject (PR #183)** —
  first unit of the PM-ratified `agent-memory-realignment` program (charter decisions D-1…D-9; the
  program one-pager + R1–R6 trio reconciliation ratified and recorded in the charter in-PR).
  **Authority docs rewritten** (`agent-memory-foundations`, `agent-data-model` canonical table +
  Extension §reframe, `agent-architecture` §memory): raw ledgers are ground truth *below* memory;
  the episodic layer (episodes + memory-owned gist) is the acknowledged gap PR-2 fills; the index is
  pure pointers (gist is episodic content, not index); `MemoryEntry.principal` is documented as the
  pool's **owner/believer** (whose self-model), matching what the write paths always did; the
  raw-first Dream-evidence rule is restated to bind context-management artifacts (compaction
  summaries stay locators, never evidence; memory-owned episode gist becomes the post-supersede
  carrier in PR-2). **One person rule** (D-2): both Dream pools now write third-person-singular,
  subject-elided facts — the subject stays normalized in the pool key (rename-safe) — and the
  `<memory>` briefing renders zone-tagged **bullet lists** (`<self>` / `<principal name="…">`, no
  subject prepending, no conjugation; the old prose render baked today's single reader into storage
  as a verb form and misrendered for any other reader). **`recall` grounds against the briefing**
  (D-3): visible entries carry a reader-relative `subject` ("self" or the same display name the
  briefing zone uses, single shared name source); raw internal principal keys never reach the model.
  Cross-pool duplication is now prompt-guided (D-9, with a run-log-only-evidence escape hatch).
  No schema change (one protocol-surface doc comment). Gate: one fix round; local integration
  test-merge against post-#179 main (typecheck · core 844/0 incl. all M3-A tests · renderer 409/0)
  before merge. **Post-merge: wipe `~/.lin-outliner-*` dev userData in every clone** — legacy
  base-form facts are off-contract under the new render.
  ([#183](https://github.com/relixiaobo/lin-outliner/pull/183))

- **Memory language surfaces speak the academic model (PR #181)** — `agent-memory-academic-alignment`
  shipped (plan archived `done` in-PR; subsumed the former D2 `agent-memory-encoding-signal`). Language
  surfaces only, zero storage/schema/tool-contract change. The Dream prompt is rewritten as a
  **consolidation** pass — selection stated as an **encoding policy** (durable, context-free knowledge;
  novelty/prediction-error weighted: corrections, surprising tool results, failed-then-replaced
  approaches are the strongest signal) with **reconsolidation** framing for update/invalidate; the
  anti-injection evidence fence stays verbatim, and the new fence-containment test anchors the tags'
  own lines so the prompt's prose mention of the fence cannot satisfy it. The `<memory>` briefing opens
  with a fixed self-introduction as the working-memory slice of the semantic store (exported constant,
  single source for tests); `recall` is described as **cued retrieval** over the semantic store with
  `include_evidence` as **source access** into the episodic record (parameter names/shapes unchanged),
  and its empty-result instruction keeps the active-entries-only qualifier. Forgetting copy follows
  foundations §5.4 — never "delete": Settings chips read `Inactive/已失效`, the Dream boundary row
  counts `invalidated/失效`; permission descriptors and the spec set (`agent-tool-design`,
  `agent-skills`, `agent-data-model`, plus straggler sweep over `agent-pi-mono-implementation`,
  `agent-progress`, `agent-event-log-rendering`) use the same vocabulary (A6). Gate: medium
  `/code-review` (7 finder angles + per-finding verifiers), one fix round; typecheck · `test:core`
  809/0 · renderer 405/0 · agent-settings e2e 20/20 (CI=1) · Settings memory pane light+dark visual.
  Accepted trade-off noted on the PR: the briefing intro persists in each turn's reminder (~24
  tokens/turn) as the only memory framing subagents see.
  ([#181](https://github.com/relixiaobo/lin-outliner/pull/181))

- **Principal-keyed memory: the user is an ordinary principal (PR #173)** — Phase 3 of
  [[agent-memory-model]], implementing the PM-ratified (2026-06-09) `agent-data-model` §4 contract.
  `MemoryEntry` (+ `AgentMemoryEntryView` / `AgentMemoryEventBase`) is re-keyed by **`principal`** — the
  subject a fact is *about* — replacing `agentId`; a pool is one principal's undivided self-model. Agent
  pools stay in `agents/<id>/memory/`, the user pool lives at `principals/user-<id>/memory/`; both ride the
  same `AppendOnlySeqLog` primitive, no new event types, pre-release clean cut (no migration — wipe
  `~/.lin-outliner-*` dev userData; stale `agentId`-keyed lines are dropped on read). **Per-principal Dream
  (one writer per pool):** agent-Dream consolidates an agent's run log → its pool; user-Dream consolidates
  the user's member-conversations → the user pool (executed by the main agent, principal-anchored run-meta,
  single-writer, watermark-serialized; manual `/dream` fires it on demand). Extraction prompts are
  subject-aware ("You …" vs "The user …"). **Membership read:** briefing/recall surface the reader's own
  pool (`<self>`, second person) plus each co-member principal's pool (`<principal name="The user">`, third
  person) under a fair round-robin resident cap; the user is always a co-member, so the user's self-model is
  shared into every agent — subagents inherit visibility from the parent session by design. **Read-path
  security gate:** cross-principal recall returns the distilled fact only; raw `sources` evidence
  dereferences only for the reader's own pool. The former `isolated` retrieval tier is removed
  (`originWorkspace` is provenance only); `read-only-global` (pause writes) remains. Gate (3 rounds,
  protocol surface): r1 — an e2e mock regression (memory pane crash), a hollow subagent membership gate
  (resolved as inheritance-by-design, honestly documented), and a Dream prompt-injection surface fixed with
  a per-request randomized evidence fence; r2 — the torn-tail read fix was found to lose-then-brick on the
  *write* side (append welds onto the torn fragment), fixed in r3 by a pre-append tail repair (newline-only
  tears preserve the final event; mid-file corruption still fails loudly for reads and writes). Verified on
  the merged tree: typecheck + `test:core` 789/0 + `test:renderer` 389/0 + agent-settings e2e 20/20; spec
  updated in the same change (A6). GitHub flagged the merge CONFLICTING (modify/rename vs #174's plan
  archive move) while ort merged clean — resolved by merging `main` into the branch at the gate.
  ([#173](https://github.com/relixiaobo/lin-outliner/pull/173))

- **Skill governance convergence: single-source identity + ratification gate (PR #174)** — one
  convergence pass over the shipped M1 skill-authoring subsystem, design in
  `docs/spec/agent-skills.md` + `docs/plans/agent-skills-authoring.md`. **(1) Protocol:**
  `SkillDefinition.source` collapses `'built-in' | 'user' | 'project' | 'dynamic'` → `AgentSourceKind`
  (`'built-in' | 'user' | 'project'`), symmetric with agents — `dynamic` was a discovery mode, not a
  source; nested-discovered dirs now tag `project`. `SkillDefinition` gains `ratified` + `contentHash`.
  **(2) Closed governance hole:** one `resolveSkillContentTarget` resolver powers the loader, the
  file-tool write gateway, and the `agent.skill.write` permission classifier, so "what is a skill" can
  no longer disagree across layers — a skill in an additional configured dir outside the root (e.g.
  `~/team-skills/`) was loaded as model-invocable yet bypassed skill-write governance entirely; now every
  recognized skill write is uniformly ask-gated. **(3) Ratification gate replaces write-time policy:** the
  gateway records each agent-written `SKILL.md` canonical content hash (registry in-memory +
  `agent-skill-provenance.json` in userData, shared by subagents); a skill whose current hash matches its
  record is **unratified** — excluded from the model listing and `trigger: 'agent'` invocation refused
  (`skill_not_ratified`), while slash invocation always works with `allowed-tools` honored (the user's
  command is per-run consent). A user hand-edit changes the hash and self-ratifies. Deleted: the
  `RISKY_ALLOWED_TOOL_NAMES` string heuristic and the forced `disable-model-invocation` file rewrite —
  lin never writes policy into an authored file. Validity/safety checks (size, frontmatter, hidden/exec
  support files, secret scan) stay at the write boundary as model feedback. Gate: `/code-review` (1
  finding — a CRLF/BOM hash-domain mismatch that fail-opened the ratification gate when an agent edited a
  CRLF/BOM-authored skill) fixed in `33ae703` via a canonical `skillContentHash` shared by record + load
  sides, with an independent re-check confirming the gate now holds; typecheck + `test:core` 780/0 +
  `test:renderer` 389/0; spec updated in the same change (A6).
  ([#174](https://github.com/relixiaobo/lin-outliner/pull/174))

- **Distilled-memory `<memory>` briefing + subject-elided Dream writer (PR #172)** — Phase 1+2 of
  [[agent-memory-model]] as one complete PR, **zero protocol change** (`MemoryEntry`, the `recall` tool,
  and the `memory.*` / `dream.completed` events are consumed as-is). **Render:** the old
  `<agent-memory>` `id=…/fact=…` reminder is replaced by a new pure module `agentMemoryBriefing.ts`
  that projects selected entries into a `<memory>` briefing with reader-relative zones — the reading
  agent's own pool renders second-person `<self>` ("You verify…"), any other principal's pool renders
  third-person `<principal name>` (a Phase-3 affordance, unit-tested but unreachable until §4 sharing
  ships). Storage stays person-neutral; render hides scaffolding (`id`/`status`), XML-escapes, and
  returns null when empty. Selection is now **resident** (newest active, capped at 12) — the stable
  distilled prefix — with query-specific retrieval left to the `recall` tool (the volatile tail); the
  now-dead `query` arg was dropped from `buildMemoryReminder` and the subagent host interface/cache key.
  **Dream:** the extraction prompt gains the subject-elided base-form writer contract (no leading
  subject; name third parties; authority-as-phrasing) plus merge/conditionalize/invalidate consolidation
  heuristics; the `{added,updated,forgotten,skipped}` `dream.completed.changes` shape is unchanged.
  Gate: `/code-review high` (7 findings) → fixes verified — fragile leading-subject strip regex removed
  in favor of faithful subject-prepend (Dream is the single enforcement point), shared `escapeXml`
  extracted to `agentReminderXml.ts`, constant de-duplicated; typecheck + `test:core` 774/0.
  ([#172](https://github.com/relixiaobo/lin-outliner/pull/172))

- **Auto-initialize field config is one multi-select picker (PR #169)** — a `date` field's Auto-initialize
  strategies previously rendered as several identical-looking "No" switches (the strategy name lived only in an
  invisible `aria-label`); they now collapse into a single multi-select picker (closed: the chosen strategies
  inline; open: a checklist that toggles membership without closing). Implemented as an additive, gated
  `multiple` mode on the shared `NodeValuePicker` — the single-select callers pass no new props and are
  unchanged. Also fixes a **silent data-loss bug** found at the gate: changing a field's type left stored
  strategies the new type doesn't offer lingering invisibly, to be dropped on the next unrelated edit — now
  `setFieldConfig` prunes auto-init strategies to the new type's valid set at the core seam (the deep fix), not
  just in the picker. The on-disk value contract (comma-joined strategy string) is unchanged.
  ([#169](https://github.com/relixiaobo/lin-outliner/pull/169))

- **Runtime-owned Dream memory extraction, per-turn slice (PR #159)** — the automatic half of the #157 M2
  write authority. After each completed foreground run, a runtime-owned worker (`agentDreamExtraction.ts` +
  `AgentRuntime` wiring) sends the raw current-turn evidence (user/assistant/tool messages, not summaries)
  plus the currently visible memory through a bounded no-tools model completion, then applies the proposed
  add/update/forget actions to the durable memory event store with `conversationId`/`messageRange`/`runId`/
  `eventId` provenance. It is fire-and-forget after the turn emits idle (a Dream failure can never break the
  foreground turn), serialized on one runtime queue, and bounded (≤5 actions, fact-length clamp, transcript
  char budgets). Isolation is enforced on the write path: `read-only-global` runs no extraction (facts learned
  in a workspace don't enter the global pool), `isolated` only reads/updates/forgets memory scoped to the
  session's `originWorkspace`, and `add` tags the originWorkspace while `update` preserves the entry's own.
  Injected `<agent-memory>` reminders are filtered out of the evidence (no self-feedback loop). The secret/
  credential capture surface is guarded only by the extractor prompt — a PM-accepted, prompt-level decision
  (2026-06-07) matching the runtime-owned write design, with a defense-in-depth code guard backlogged as
  `agent-dream-secret-redaction` (P3). This is the per-turn slice only; time/activity/lock-gated offline
  consolidation (`autoDream`) and the task panel remain later P2/P3 work. Gate: typecheck + `test:core` 661/0
  (incl. runtime isolation/`read-only-global`/no-op-update regression tests + a new `agentDreamExtraction`
  unit suite); two high-effort finder passes (security + correctness) cleared, two low correctness findings
  (provenance run-boundary, no-op update churn) fixed before merge. ([#159](https://github.com/relixiaobo/lin-outliner/pull/159))

- **Agent memory recall clean cut: one read-only `recall` tool (PR #158)** — implements the #157 M2 decision.
  Removed the two model-visible memory tools from the foreground agent pool — the `memory` CRUD tool
  (`agentMemoryTool.ts`, deleted) and the `past_chats` tool (`agentPastChatsTool.ts`, deleted) — and replaced
  them with a single read-only `recall` tool (`agentRecallTool.ts`) over active durable memory entries.
  `recall` reads only `status:'active'` entries, enforces the agent's `memoryIsolation` tier (`isolated`
  retrieves only entries whose `originWorkspace` matches the session — unscoped and other-workspace entries
  are excluded), bounds results by `limit` (default 8 / max 20), and optionally expands raw evidence only
  when `include_evidence:true` — nested under the matching entry and resolved solely from that entry's
  recorded `MemoryEntry.sources`, never via a free-text transcript search, within a shared `max_chars` budget
  (default 4000 / max 12000). The internal `agentPastChats` evidence search is retained as `recall`'s
  backing service (no longer model-visible); Settings/Profile list/edit/forget remain the human write path.
  Permission surface is a net reduction: the writable `agent.memory.manage` (auto-allowed) is replaced by
  read-only `agent.memory.recall` (`accessScope:'none'`, no external effect), and `memory` is dropped from the
  control/auto-allow mutation sets — A3 intact. Prompt guidance, tool-call UI label/icon (`recall` →
  `BrainIcon`), i18n (en + zh-Hans), and the active specs (`agent-tool-design.md`, `agent-progress.md`, et al.)
  were updated in the same change (A6). Gate: typecheck + `test:core` 655/0 (incl. a new runtime isolation
  regression test asserting `isolated` recall excludes other-workspace/unscoped/invalidated entries) +
  `test:renderer` 354/0; two high-effort finder passes (removal-completeness + recall correctness/security)
  returned no findings. ([#158](https://github.com/relixiaobo/lin-outliner/pull/158))

- **Guide agent memory use in the system prompt (PR #155)** — added a stable `Memory` section to the Tenon
  agent system prompt: use the `memory` tool for concise durable facts / stable preferences / corrections
  that should carry forward; treat `<agent-memory>` as background context (not user-authored instructions);
  update or forget a remembered fact when the user corrects it; and do NOT store transient task state, raw
  conversation summaries, secrets/credentials, guesses, or current-conversation-only facts (use `past_chats`
  for raw prior-conversation recall). Closes the M1 "inline memory write instructions in the agent prompt"
  checklist item. Gate: typecheck + `agentSystemPrompt.test.ts` 3/0 (tool names + tag verified against the
  runtime). ([#155](https://github.com/relixiaobo/lin-outliner/pull/155))

- **Harden agent permission approval semantics (PR #154)** — removed conversation-scoped approval from the
  permission model: approval scopes are now only `once` / `always`, and stale conversation-shaped rule
  fixtures can no longer relax a configured/default `ask`. `approval.*` UI events and `tool.permission.*`
  policy events now share one `permission-<uuid>` request id so a single decision is joinable across both
  families — including the skill-shell path, which now emits the full `tool.permission.checked/resolved`
  pair (previously it surfaced only the UI half). Denied-reason strings are canonicalized to one contract
  (`configured_deny`, `policy_denied`, `classifier_blocked`, `classifier_unavailable`, `platform_hard_block`,
  `run_aborted`, `runtime`, `user_denied`) backed by a single `PERMISSION_DENIED_CONTRACT` table that drives
  `recoverable` / `resolvedBy` / `source` / `status` for every reason — so durable policy blocks
  (`tool_denied` / `tool_not_preapproved` → new `policy_denied`) are correctly non-recoverable, and the
  audit record can no longer contradict itself (e.g. a runtime denial is no longer logged as `user_once`).
  Gate: typecheck + `test:core` 662/0 + `test:renderer` 356/0 + 7-angle high-effort review → 7 findings, all
  fixed before merge (29dd688) with regression tests. ([#154](https://github.com/relixiaobo/lin-outliner/pull/154))

- **Workspace tree rows are text-only (PR #146)** — the navigation tree no longer renders a per-node icon
  (neither a node's own emoji nor the fixed fallback glyph the system roots Daily notes / Library / Schema /
  Saved searches / Trash carried); those icons still show in the outliner/canvas and on the primary-nav
  entries + workspace-root avatar, but the tree omits them so the list stays scannable. Drops
  `renderSidebarNodeIcon`/`systemIconForNode` and the `.workspace-tree-label-icon`/`-emoji` CSS; the
  `workspace-layout.spec.ts` guard was updated to the new DOM (15/15). Gate: typecheck + that e2e guard.
  ([#146](https://github.com/relixiaobo/lin-outliner/pull/146))

- **Agent: "Used N tools" summary glyph → chart-no-axes-gantt (PR #139)** — the collapsed process summary
  that lists tool usage swapped its `ListChecks` glyph (generic "options list") for lucide
  `ChartNoAxesGantt` (staggered bars, a "steps / process" feel), via a new `UsedToolsIcon` alias used only
  there. `OptionsIcon` keeps mapping to `ListChecks` for the field-type "options" usages (definition config,
  view toolbar, field presentation), so this is not a global remap. Gate: typecheck + `test:renderer` 354/0
  + light/dark in-context visual. ([#139](https://github.com/relixiaobo/lin-outliner/pull/139))

- **Agent: morphing geometric "still generating" mark (PR #138)** — the flat rose streaming pulse is
  replaced by a richer brand mark: an SVG whose path morphs **triangle → square → circle** and back while
  rotating a full turn. All three shapes are 4-corner rounded polygons sharing one command structure
  (`M, (L Q)×4, Z`) so the `d` interpolates continuously with rounded corners throughout (no sharp points,
  incl. the triangle apex); they carry equal **optical area** (centroid-centered) so the triangle no longer
  reads smaller than the square and the apparent size "breathes" while visual weight stays constant.
  Rotation runs in lock-step with the morph. Adds material depth — a top-lit rose gradient
  (`--accent` → `--accent-strong`) plus a soft rose `drop-shadow` on the non-rotating wrapper. Sized to
  20px (~0.77 of the 26px body line) and centered on the **same 14px icon column** as the tool / thinking
  status icons (measured: icon center == mark center). Also restores `--caret` to brand rose. Gate:
  typecheck + `test:renderer` 354/0 + token guard 8/8 + light/dark visual & alignment; all values tokenized
  (B11). ([#138](https://github.com/relixiaobo/lin-outliner/pull/138))

- **Agent: strip model-visible redundancy across all tools (PR #128)** — the model-visible tool result
  (`content[0].text`) now carries only what the model cannot cheaply derive; the full runtime envelope
  stays on `details` unchanged. A shared `modelVisibleEnvelope` projector backs every tool: it drops
  `tool` (known via tool-call correlation), emits `status` only when informative
  (`partial`/`unchanged`/`denied`, never `success`/`error`), and projects errors to `{ code, message }`.
  Node tools drop `kind`/`action` (always the tool name) and select guidance from a single-source
  `NodeInstructionContext { count?, outcome? }` computed beside the visible result — never re-derived from
  the payload shape, never duplicated at the call site — so a real no-op edit reports "No change was
  needed" instead of "Edit applied". `file_read` text/notebook/pdf paths route through a typed
  `visibleFileRead` (exhaustiveness-guarded) that strips derivable counts / internal paths / base64 /
  duplicated cells, and a partial read now sets `status: "partial"` as a structured truncation signal.
  `data` is omitted from the visible envelope whenever `modelData` is `undefined` (the safe default — the
  prior `NO_MODEL_DATA` sentinel and its undefined-fallback leak are gone). `past_chats`, `file_edit`,
  `task_stop`, `file_grep` shed echoed args / constants / cross-field duplicates. Design folded into
  `docs/spec/agent-tool-design.md`. Gate: re-reviewed (high) after a revision that addressed all nine
  findings; typecheck + `test:core` 602/0 (2 ripgrep-env skips). A follow-up commit fixed the
  `nodeInstructions` exhaustiveness guard, which was cosmetic as merged (it switched on a cast expression
  and assigned `envelope.tool as never`, so adding a `NodeToolName` member did not fail to compile) — now
  it switches on a typed local and the `never` default genuinely enforces coverage (verified: a sixth
  member raises TS2322). ([#128](https://github.com/relixiaobo/lin-outliner/pull/128))

- **Settings: macOS System Settings clarity pass (PR #118)** — the standalone Settings window now reads
  closer to macOS System Settings while keeping Tenon's neutral design system. A fixed toolbar pairs the
  back/forward history controls as one neutral pill capsule (with a hairline divider) and a right-pane
  page title; the content scrollport sits below it via `margin-top` (not scrollable padding) so dense rows
  never pass behind the chrome. The category rail gains a compact neutral icon slot + single-line label
  per row, the content column is constrained to a stable reading width (`--settings-content-max-width`),
  and grouped inset cards drop their heavy border for a 0.5px inset hairline (`--inset-hairline`). Pop-up
  selects are now transparent-at-rest text chrome that gain a neutral fill only on hover/focus/press
  (macOS pop-up rhythm); permission decision pop-ups keep a stable width through the non-allowable last
  row, and raw `Action(...)` rule strings + redundant inline chips are gone from the first visual level.
  **Agent Profiles is now hierarchical:** the category page is a pure drill-down list (chevron only, no
  switch), and clicking a profile pushes an `agent-detail` route — reached through the same back/forward
  capsule — that carries the enable/disable switch as its own row above the persona card. The runtime/
  permission Save footer now appears only when the draft is actually dirty. Gate: typecheck + renderer
  340/0 + agent-settings e2e 19/19 (incl. 5 new drill-down/pop-up/alignment cases) + light/dark visual
  verification; review fixed 3 issues (a `box-shadow` token-guard regression, a dead `data-window-material`
  rail rule + over-claiming spec sentence, and orphaned i18n strings). Design folded into
  `docs/spec/design-system.md`. ([#118](https://github.com/relixiaobo/lin-outliner/pull/118))

- **Perf P1 (PR-A): incremental projection delta over the core↔renderer seam (PR #119)** — the
  keystone of the performance program (`incremental-projection.md`). Instead of shipping the entire
  `DocumentProjection` across IPC on every mutation and having the renderer re-`JSON.stringify` every
  node to rediscover the change set, core's existing change set is delivered as a `ProjectionUpdate`
  discriminated union (`full | delta`). `documentService.buildProjectionUpdate` emits a `delta`
  (changed/removed nodes only) when the revision advances by exactly one, and a `full` on whole-tree
  rewrites / discontinuity; the renderer's `reduceProjection` folds it into the held index,
  **preserving object identity for every unchanged node** (the stable-reference foundation later memo
  work builds on) and deleting the whole-document `nodeSignatures` pass. Measured single-keystroke
  cost at 6k nodes: IPC payload ~1984 kB → 362 B, renderer index pass 7.0 ms → 1.2 ms. A
  `ProjectionSnapshot` resync valve covers any delta gap (belt-and-suspenders; never fires on the one
  ordered channel). Gate: xhigh review — 2 correctness + 1 perf regression caught and fixed
  (merge-node grandchild survival via delete-exact-`removedIds`, idempotent date-ref fallback, no-op
  reseed short-circuit), verified by a new real-core delta integration test (`byId` == full rebuild
  under `LIN_VERIFY_CACHE=1`) + typecheck + renderer 340/0 + core. PR-B (incremental reverse-edge
  maps) tracked separately. ([#119](https://github.com/relixiaobo/lin-outliner/pull/119))

- **Perf P1 (PR-B): incremental reverse-edge index — retire the last O(N) per-keystroke pass (PR #121)** —
  follow-up to #119. `propagateDirty` used to rebuild the reverse-edge index (reference / tag / inline-ref
  target → referrers) from *every node* on every edit. The index (`ReverseEdges`, now `Set`-valued for O(1)
  add/remove) is held in the renderer's `ProjectionState` and patched per delta by `patchReverseEdges`
  (copy-on-write at both the category-map and member-set level, leaving `prev` untouched; a node whose edge
  keys are unchanged is skipped, so a plain text edit allocates nothing). `propagateDirty` now takes the
  held index instead of building it. Bench (edge-build + propagate, single keystroke, ~20% nodes tagged):
  6041 nodes 1.22 ms → 0.29 ms; the patched index is asserted equal to a full rebuild after **every**
  command in `projectionDeltaIntegration.test.ts` (tag/reference/inline-ref churn added). Gate:
  `/code-review` (3 finders + 1.5k-case fuzz, 0 bugs) + typecheck + renderer 345/0; a follow-up dropped a
  redundant `node.tags.slice()` on the hot path (alias the read-only array). Residual per-keystroke O(N)
  (`new Map(prev.byId)`, `nextRevisions`) is the P3 cleanup.
  ([#121](https://github.com/relixiaobo/lin-outliner/pull/121))

- **Perf P0: stop per-token agent index rewrites + drop pretty-print write amplification (PR #117)** —
  first quick-win of the performance-optimization program (`performance-optimization.md`, #116).
  `AgentEventStore.appendEvents` rewrote both `session-index.json` and `search-index.json` (read +
  parse + serialize + atomic write of the **whole** file) on every `assistant_message.delta`, i.e.
  per streamed token batch, scaling O(all messages ever). Delta-only batches now skip the index
  rewrite — content-preserving, since the indexes derive assistant text from
  `assistant_message.completed` and a delta only nudges cosmetic `latestSeq`/`updatedAt` (self-healed
  by the events that follow); `events.jsonl` is still appended per delta (source of truth). Separately,
  `JSON.stringify(_, null, 2)` was dropped from the Loro document snapshot and the two agent index
  writes (~half the bytes per write); readers use `JSON.parse`, so existing on-disk files still load
  (no migration). Human-edited config/permission/debug writes keep pretty-printing. Gate: verified
  content-preserving (index fields are write-only; mixed batches still index) + typecheck + renderer
  330/0 + agent event-store/large-session/past-chats suites green.
  ([#117](https://github.com/relixiaobo/lin-outliner/pull/117))

- **Settings panes unified onto one design language (PRs #105 + #106)** — implements
  `settings-design-consistency.md`. The Settings window no longer reads as two visual
  generations. **#105 (WI-1, conformance):** danger hover → neutral `--control-hover` (B3);
  unified text-control `:focus-visible` rings, with a row-level inset ring for borderless inputs
  inside inset cards so the ring isn't clipped (B8); sheet body-block radius unified to
  `--radius-md`; and deletion of the dead `.settings-provider-sheet` rule + the unwired
  `settings-connection.css`. **#106 (WI-2, migration):** General / Permissions / Skills /
  Agent Profiles moved onto the `InsetGroup`/`InsetRow` idiom (Providers is the reference) —
  no panel titles (rail naming + a one-line muted intro), flat bottoms, filled `--fill-2`
  secondary buttons, text-only empty states, a unified `.settings-chip` + neutral banners, and
  switches/selects relocated to a trailing slot (a new `InsetRow` `wrap` variant), netting −134
  lines of bespoke CSS. Gate: typecheck clean, renderer 293/0, token guards 8/8, agent-settings
  + oauth e2e 21/21; light + dark visual verification passed all five panes; spec synced (A6).
  ([#105](https://github.com/relixiaobo/lin-outliner/pull/105),
  [#106](https://github.com/relixiaobo/lin-outliner/pull/106))

- **Provider settings polish — list tile, auth-sheet hierarchy, OAuth clarity (PR #101)** —
  Parts B/C/D of `provider-config-cleanup.md` (Part A, the core fix, is still in rework after
  the review gate — see TASKS). **B:** every provider mark — vendored brand logo or monogram —
  now sits on one neutral `--fill-2` tile (a bare logo previously read as a "missing
  background"), and provider-row separators are inset on **both** edges via a new tunable
  `--inset-separator-inset-right` on the inset-list primitive (left aligns to the icon tile, a
  matching right inset keeps the hairline within the card). **C:** the auth-sheet primary button
  (`.settings-sheet-primary`) becomes a genuinely strong **neutral** fill — `--surface-inverse`
  + `--panel-bg` text, the same "filled default button" language as `.agent-settings-primary`
  and the composer send button — instead of the faint `--fill-3` tint that read weaker than the
  bordered secondary (status colour stays reserved for status; danger for destructive actions).
  **D:** the Anthropic OAuth hint now names it as the same Claude account Claude Code / claude.ai
  use (pi-ai ships no separate "Claude Code" provider — the Anthropic OAuth flow *is* the Claude
  subscription login), with a new `oauthProviderCoverage` guard test so a future pi-ai OAuth
  provider can't silently surface without sign-in copy. Also adds display names for all 32 pi-ai
  providers and a Xiaomi MiMo brand icon (with `ICON_ALIASES` so the regional token-plan variants
  reuse the one mark). Renderer/CSS/copy only; B1/B11 token guards green; spec updated
  (`design-system.md`, A6). ([#101](https://github.com/relixiaobo/lin-outliner/pull/101))

- **Unified inline mention language (PR #89)** — implements `unify-mention-language.md`.
  One inline-mention language across the outliner, agent composer, and agent message: a
  **node reference is plain accent text with no icon**, and a **local-file / directory / image
  reference is a leading monochrome icon + name** — same rule, same mechanism in all three
  render sites. The icon is a shared `mask-image` glyph (`inline-ref.css`, keyed by
  `data-file-icon-kind`) painted with `currentColor`, so it themes automatically in dark mode
  (B1/B8) — replacing the composer's full-color macOS folder raster that clashed with the
  monochrome/rose surroundings and didn't theme. The kind classifier and `toDOM` children move
  into a shared `src/renderer/ui/editor/inlineFileIcon.ts` (one source of truth), the
  `inline-flex`+`translateY` baseline hack is dropped, and the divergent
  `.agent-composer-inline-file*` / `.agent-message-inline-file*` chip species are deleted.
  Outliner file refs gain the same icon so it is truly one language, not two. Renderer-only;
  no core/protocol surface; spec updated (`design-system.md`, `agent-progress.md`, A6).
  ([#89](https://github.com/relixiaobo/lin-outliner/pull/89))

- **Workspace shell: tabs removed, split panes kept (PR #85)** — implements
  `workspace-tabs-to-single-pane.md`. The multi-**tab** concept is gone; the multi-**pane**
  split view stays and panes become the single top-level canvas primitive. `tabs[] +
  activeTabId` flattens to one `WorkspaceLayout { activePanelId, panels[] }`; tile `size`
  moves onto each panel (the parallel `panelSizes` map is deleted); localStorage bumps
  `:v1`→`:v2` (v1 dropped on load, pre-release). Hooks/flags renamed to tell the truth
  (`useWorkspaceTabs`→`useWorkspaceLayout`, `wantsNewTabFromClick`→`wantsNewPaneFromClick`,
  `NavigateRootOptions.newTab`→`newPane`). Default layout is a **single Today pane**;
  Cmd/Ctrl+click a reference opens a new split pane (replaces the rightmost root at the
  4-pane cap). The sidebar tree shows all root sections (Schema/Settings no longer hidden);
  right-click "Open" → "Open in split pane"; the node **Appearance** (icon/banner)
  context-menu item + submenu are removed (T4 — no UI entry point to set/clear a node
  icon/banner remains, by design). Review-gate hardening: debug-only canvas states no longer
  wipe the canvas (`navigateRoot`), silently drop an agent-debug session (`openPanel` at the
  cap now reverse-finds an outliner pane), boot into a rootless canvas (`sanitizeLayout`
  rejects an all-debug persisted layout), or mis-target page-history / Cmd+M (`activeOutlinerPanel`
  is strict; the ambient fallback drives only sidebar/drag). Net ~−990 lines; no `src/core`
  protocol change. Spec rewritten for the no-tabs model (`docs/spec/workspace-layout.md`, A6).

- **Sidebar / agent rail toggles use static `PanelLeft` / `PanelRight` icons (main)** —
  the two window-chrome rail toggles drop the open/close chevron-swap glyphs
  (`PanelLeftClose/Open`, `PanelRightClose/Open`) for one clean static icon per side;
  open/collapsed state reads from the deepened glyph colour alone (B6), not a glyph swap.
  The workspace-layout guard updated to assert the static glyph + colour-carried state.
  (main)

- **Agent composer is a flush input region, not a floating card (main)** — the
  composer surface drops its `--layout-gap` inset and `--agent-composer-radius`
  card: it is now full-bleed to the rail's side and bottom edges with a neutral
  `--fill-1` background, rounded TOP corners at the rail's own `--panel-radius`
  (the dock's `overflow:hidden` rounds the flush bottom to match), and uniform
  padding. Focus and drag deepen one neutral step to `--fill-2` — no border, no
  brand ring (B3). `design-system.md` (concentric chain + Agent component) and the
  composer geometry guard test updated to match. (main)

- **Provider model dropdowns rank by recency, not a static preferred list** —
  replaces the hand-maintained `PREFERRED_MODEL_IDS` allowlist (which sorted any
  unlisted model to the bottom via `MAX_SAFE_INTEGER`, silently burying Claude Opus
  4.8 / Sonnet 4.6 and keeping them out of the `models[0]` default) with a
  recency-first comparator in a new pure module `src/main/modelRanking.ts`. Ordering:
  product line (version-independent, only so a side line like `gemma-4` can't outrank
  the `gemini-3.x` flagship line) → numeric version desc (the recency signal —
  `gemini-3.5-flash` over `gemini-2.5-pro`, and `4-10` > `4-9`) → `reasoning` → clean
  alias before its dated snapshot → id. Price is deliberately unused (newer Anthropic
  models are cheaper + regional skew, so cost is anti-correlated with recency). The
  default now tracks the current flagship automatically and new model versions need
  zero code changes; the only human-maintained input is `MODEL_LINES`, whose staleness
  is caught by `findUnknownLineModels` + live-catalog guard tests
  (`tests/core/modelRanking.test.ts`).
  ([#67](https://github.com/relixiaobo/lin-outliner/pull/67))
- **Native-feel component pass (CSS-only, PR-C)** — tightens the chrome to the
  strict-native cursor/affordance policy across components. Field-value
  affordances and rail toggles now signal hover/active by deepening color
  (`background: transparent`, `transition: color`) instead of a `--fill-*` box
  (B6); the row bullet deepens its dot color on hover instead of `transform:
  scale` (B7, no layout shift); non-link controls (approval toggle/button, tag
  label) drop `cursor: pointer` so the pointing-hand cursor is reserved for
  content hyperlinks (A5/B10), pinned by a new `cursor-affordances` e2e guard;
  overlays move onto the tiered elevation tokens (menus level-1, dialogs/palette
  level-2, D3); agent chrome text is `user-select: none` (A8); and agent surfaces
  use the semantic `--text-secondary` token (D5). No DOM/behavior changes.
  ([#65](https://github.com/relixiaobo/lin-outliner/pull/65))
- **Upgraded the agent core (`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`) 0.75.4 → 0.78.0.** Brings Claude Opus 4.8 model metadata + Opus adaptive-thinking (0.77.0), a provider retry/timeout overhaul (0.76.0: `maxRetries` reliably honored, SDK retries default to 0, billing-429s no longer retried), `isContextOverflow` detection fixes, Anthropic-compatible replay fixes, and session-disposal abort of in-flight agent/compaction/retry/bash work (0.77.0). Underlying provider SDKs unchanged; only new transitive dep is `@smithy/node-http-handler@4.7.3`. Type-compatible (typecheck clean); no Lin call-site changes needed (we pass `SimpleStreamOptions.maxRetries` explicitly only when configured). ([#66](https://github.com/relixiaobo/lin-outliner/pull/66))
- **Field values no longer have a cardinality** — the single/list `FieldType`
  cardinality concept is removed end to end (`FieldCardinality`,
  `SCHEMA_CARDINALITIES_ID`, the `cardinality` config key/schema/projection, and
  the definition-config Cardinality control). Every value is a node and always
  appends; selecting an option appends a (deduped) reference rather than replacing.
  The done-state checkbox mechanism keeps its binary replace semantics explicitly:
  the forward mapping clears-then-selects, and the reverse mapping now drops the
  opposite-mapped option so a mapped field never holds both checked and unchecked
  at once (#64).
- Dark mode now follows the OS via `@media (prefers-color-scheme)` with `color-scheme: light dark` (native scrollbars/controls theme correctly; the `[data-theme]`+JS bridge and `theme.ts` were removed) (PR-B, #63).
- **Design system — floating-rails shell, neutral token migration,
  dark-follows-OS** — dissolves `TopBar` into a persistent `WindowChrome` (a top
  drag strip that reserves the traffic-light inset plus two centreline rail
  toggles) and per-pane breadcrumb headers; the global tab strip, `WorkspaceTab`,
  and global Back/Forward are gone — the sidebar is now the tab switcher (select /
  create / close), per-pane Back lives in the breadcrumb, and page-nav is on
  `Cmd+[` / `Cmd+]`. The sidebar and agent rails **float** (inset, rounded
  `--radius-panel`, `--shadow-rail`, material + `backdrop-filter` + `--rail-edge`)
  over a full-bleed opaque canvas; the agent rail unfurls from a collapsed seed
  to the open panel without ever remounting `AgentChatPanel` (chat scroll +
  composer draft survive). Components move onto the alpha-on-ink token layer:
  `rgba` → alpha-on-ink tokens, the deprecated rose `--primary*` family →
  neutral `--fill-*` / `--focus-ring` / `--outline-focus` (the family is now
  deleted, zero references), inline-ref blue → rose centralized at the token
  layer, `--danger` → `--status-danger`, new `--text-on-accent`. `theme.ts`
  mirrors the OS colour scheme onto `[data-theme]` so **dark follows the OS**
  (a persisted in-app light/dark/system toggle via `nativeTheme.themeSource` is
  deferred to #45). Resize handles gain double-click-to-reset; the pre-paint
  window background follows `nativeTheme` so a dark-OS launch never flashes a
  light frame. ([#57](https://github.com/relixiaobo/lin-outliner/pull/57))
- **Native-feel stage 3 — strict-native cursor + system font** — removed
  `cursor: pointer` from every chrome control (buttons, toggles, bullets, rows,
  tabs, `summary` disclosures); the pointing-hand cursor is now reserved for
  genuine content hyperlinks (inline references, clickable tag chips, external
  doc links). `--font-family-sans` now leads with `-apple-system` /
  `Segoe UI Variable` so text renders in the platform UI font, keeping `Inter`
  only as a late fallback.
  ([#46](https://github.com/relixiaobo/lin-outliner/pull/46))
- **Inline/code styling on design tokens + simplified agent wording** — inline
  code and code blocks now use shared `--font-code-inline` / `--font-code-block`,
  `--line-code-*`, `--inline-code-bg`, and `--primary-muted-text` tokens (inline
  code reads as a compact badge with `box-decoration-break: clone`) instead of
  ad-hoc font stacks and rgba backgrounds. Product-facing agent/tool wording was
  simplified so the agent keeps the `Lin Agent` identity without over-describing
  itself as a separately branded outliner: "Lin Outline Format" → "outline
  format", "local file root" → "default file area"/"allowed file area", and the
  system-prompt identity line is trimmed. The `dangerouslyDisableSandbox` bash
  parameter is removed from the tool schema (still checked in the policy layer as
  defense-in-depth). ([#51](https://github.com/relixiaobo/lin-outliner/pull/51))
- **Config-as-nodes — definition config lives in the node tree** — definition
  (tag/field) configuration no longer lives as flat typed `Node` fields. Each
  knob is a `defConfig` child node (stable id, locked structure) whose value is
  held as its own child node(s) — the same mechanism field values use: scalars as
  a value node (codec-validated text), refs/enums as a `reference` to a target or
  a derived `systemOption` node. Reads go through typed accessors over
  `buildConfigIndex`; writes go through one registry-governed `setConfigValue`
  chokepoint. Config nodes stay in the projection (so reference labels resolve)
  but are excluded per-consumer via a shared `isInternalConfigNode` predicate. The
  cutover migrated `color`, `extends`, `childSupertag`, `fieldType`, `cardinality`,
  `nullable`, `hideField`, `autocollectOptions`, `autoInitialize`,
  `minValue`/`maxValue`, `sourceSupertag`, `showCheckbox`, and `doneStateEnabled`.
  `FieldType` is slimmed 13 → 8 (`plain`, `options`, `options_from_supertag`,
  `date`, `number`, `url`, `email`, `checkbox`); retired types fall back to `plain`
  instead of crashing. ([#18](https://github.com/relixiaobo/lin-outliner/pull/18))
- **Settings panel info architecture & style normalization** — the agent
  Settings dialog is reorganized from two categories into three: **Providers**,
  **Skills**, and **Agent Profiles**. Providers now infer credential state
  automatically — the "Enabled" toggle (introduced in #38) is replaced by a
  "Set as Active" action with `Active` / `Configured` badges and a list status
  dot (green = active, filled-soft = configured-but-inactive); the API key field
  gains a reveal mask plus a remove (trash) action, Base URL collapses into an
  "Advanced Settings" disclosure, and a "Test Connection" button reports a
  one-shot diagnostic (401 / 404 / 403 / timeout classified). The **Skills** tab
  adds global behavior switches (Automatic Skills, Slash Skills, Compact) and a
  per-skill enable/disable list; the **Agent Profiles** tab pairs a list with a
  read-only detail card (persona prompt, model / reasoning / permission / max-turns,
  tools) and per-agent enable/disable. Disabled skills and agents are filtered
  from model/slash listings and rejected at invocation and spawn. Backed by new
  IPC: `agent_list_all_skills`, `agent_list_all_definitions`, and
  `agent_test_provider_connection`. Supersedes parts of #38 (enablement toggle)
  and #39 (inline Base URL). ([#42](https://github.com/relixiaobo/lin-outliner/pull/42))
- **Custom-provider add button at the top; in-place model search** — the pinned
  "Custom provider" row at the bottom of the provider list is replaced by a
  compact "+" button beside the search box (active fill while the custom draft is
  open). The model search no longer opens as a separate row below the "Models N"
  heading — the search icon expands in place into an inline field (icon + input +
  close) that fills the header row; closing clears the query.
  ([#40](https://github.com/relixiaobo/lin-outliner/pull/40))
- **Provider detail layout polish + brand icons** — the single-field "Advanced"
  disclosure is gone; Base URL shows inline (optional override, default-endpoint
  placeholder) for every non-managed provider. The read-only model catalog is no
  longer collapsed — it renders inline, with the search field tucked behind a
  search icon beside the "Models N" heading that expands a small input (only when
  a provider has more than one model). Provider list rows and the detail header
  now render real brand logos (color variant where one exists, monochrome mark
  for inherently single-color brands like OpenAI / Vercel / Grok), resolved at
  build time from vendored SVGs; providers without a logo keep the monogram
  fallback. Icons are MIT, vendored from `@lobehub/icons-static-svg` with no
  dependency added. ([#39](https://github.com/relixiaobo/lin-outliner/pull/39))
- **Provider enablement gated on a credential; list status + control polish** —
  "Enabled" now means set up and usable: the toggle is disabled until the
  provider has a credential (key / env key / non-key auth), pasting a key
  auto-enables, and save persists the effective state (never enabled without a
  credential). The provider list shows an enablement dot (green = on, hollow =
  configured-but-off). The search box now uses the design-system field idiom
  (icon + soft border) instead of the bare global input, and selecting a provider
  uses a background fill rather than an outline.
  ([#38](https://github.com/relixiaobo/lin-outliner/pull/38))
- **Correct auth class for OAuth / managed-credential providers** — pi-ai
  authenticates providers three ways, but settings modeled every one as a
  pasteable API key. OAuth providers (GitHub Copilot, OpenAI Codex) and
  managed-credential providers (Amazon Bedrock via AWS, Google Vertex via gcloud
  ADC) now show a credential note explaining the real auth method (+ docs link)
  instead of a misleading key field; the Models disclosure stays. API-key
  providers are unchanged. Full OAuth sign-in is specced in
  `docs/plans/agent-oauth-providers.md`.
  ([#37](https://github.com/relixiaobo/lin-outliner/pull/37))
- **Declutter provider detail (progressive disclosure)** — the provider detail
  had buried its primary task (paste an API key) under repeated status and two
  long lists. The API key is now the hero; Base URL moves into a collapsed
  **Advanced** disclosure (known providers) and the read-only model list into a
  collapsed **Models (N)** disclosure. Dropped the dialog subtitle, the duplicate
  middle "Providers" heading + its disconnected right-floating caption, and the
  "ADD KEY" badge (the empty key field conveys it); the badge now shows only
  Active / Disabled / New. Custom providers keep Provider ID + Base URL visible.
  ([#36](https://github.com/relixiaobo/lin-outliner/pull/36))
- **Provider detail: toggle, key-first order, read-only model list** — the
  Enabled control is now the shared switch toggle (was a checkbox); the API key
  is the first field with Base URL ("Optional") below it (was reversed);
  "Remove key" appears only when a key is actually saved, as a subtle danger link
  in the key's meta row (was a permanently-disabled button); and each provider
  shows a read-only list of its catalog models (name, id, reasoning, context)
  with a count and a search box for large catalogs (OpenRouter exposes 266). No
  per-model enable/disable or fetch — that needs backend work.
  ([#35](https://github.com/relixiaobo/lin-outliner/pull/35))
- **Searchable provider list with pinned Custom + correct names** — follow-up to
  the three-pane Providers settings for the real ~32-provider catalog: a
  "Search providers…" box filters the list, the "Custom provider" entry is pinned
  below the scroll area (no longer buried after every known provider), display
  names get acronym-aware casing (Azure OpenAI, Cloudflare AI Gateway, GitHub
  Copilot, …) via an explicit map + token overrides, and the status dot renders
  only for providers with a meaningful state instead of a hollow dot on every
  row. ([#34](https://github.com/relixiaobo/lin-outliner/pull/34))
- **Three-pane Providers settings with metadata** — the Settings dialog's
  Providers category becomes a three-pane layout: category nav, an always-visible
  scrollable provider list (a monogram avatar + name + a status dot), and the
  selected provider's detail. The textual status moves to a badge in the detail
  header next to the Enabled toggle and a data-driven description
  (`Includes <top models>`). The API key field gains a show/hide reveal toggle
  and a "Get your <provider> API key" docs link (for providers we can link), and
  Base URL is now offered as an optional override for every provider — placeheld
  with the provider's default endpoint — not just custom ones (Provider ID stays
  custom-only). Backed by a new optional `AgentProviderOption.defaultBaseUrl`
  sourced from the catalog. ([#33](https://github.com/relixiaobo/lin-outliner/pull/33))
- **Settings window with provider / agent categories** — the cramped "Agent
  settings" dialog (which stacked provider connection, model + reasoning, and
  global behavior in one scroll, with a duplicate "Provider ID" field, a doubled
  "No key", and a pink "SETUP" box) is now a "Settings" window with a left
  category nav. **Providers** is connection-only: a clean provider row list
  (known providers + a `Custom` OpenAI-compatible entry), one API key with a
  single status line, and Enabled — Provider ID / Base URL surface only for a
  custom provider. **Agent** holds model + reasoning (active-provider defaults,
  key-gated) and behavior (permission mode, skills, directories). The composer
  model menu and the backend commands are unchanged.
  ([#31](https://github.com/relixiaobo/lin-outliner/pull/31))
- **Sidebar tree shows only a node's own icon** — the workspace tree no longer
  paints hardcoded fallback glyphs on system nodes (the calendar on Daily notes,
  plus the library / search / trash glyphs), since those nodes carry no icon of
  their own. The top primary-nav shortcuts (Today / Library / Recents / Schema)
  keep their icons. ([#30](https://github.com/relixiaobo/lin-outliner/pull/30))
- **Humanized day-note titles, no date header icon** — a daily-note panel titled
  with its raw ISO date (`2026-05-13`) above a calendar icon now shows a humanized
  read-only label instead: the weekday/month/day (`Wed, May 27`), prefixed with
  `Today` / `Tomorrow` / `Yesterday` for the adjacent days (`Today, Wed, May 27`),
  matching nodex. The docked breadcrumb's current-page label uses the same string,
  and the today panel's calendar header icon is removed so date nodes carry no
  header icon. Day nodes are locked, so this is display-only — the `YYYY-MM-DD`
  content is untouched. ([#29](https://github.com/relixiaobo/lin-outliner/pull/29))
- **Tool output shows the model-visible payload** — the agent tool-call Output
  region now renders exactly the slimmed `content` the model received (a
  syntax-highlighted JSON envelope) instead of reconstructing the fuller
  `details` envelope. This makes "what you see" match "what the model got" and
  removes the prior live-vs-reload inconsistency (`details` is not persisted).
  ([#19](https://github.com/relixiaobo/lin-outliner/pull/19))
- **View toolbar redesign** — per-node Display / Group by / Sort by / Filter by
  moved from inline panels to anchored popovers that no longer shift the row
  list; progressive, field-type-aware filter editors (boolean / options / date /
  number / text); date-aware filter matching; humanized group labels and
  field-semantic sort directions; an active-state summary line; and removal of
  the non-functional "View as" switcher.
  ([#9](https://github.com/relixiaobo/lin-outliner/pull/9))
- **Structure-aware clipboard paste** — inline marks, fenced code into code
  blocks, rich-HTML routing, and single-line URL linking; later extracted into a
  shared `classifyMediaPaste` classifier used by both the inline editor and the
  trailing input (Phase 1 of the node-line editor unification).
  ([#5](https://github.com/relixiaobo/lin-outliner/pull/5),
  [#11](https://github.com/relixiaobo/lin-outliner/pull/11))

### Removed

- **Agent self-maintenance tools `runtime_status` / `config` / `doctor` (PR #333, cc-2)** —
  removed all three M1 self-maintenance tools (originally shipped in #153) as over-built for
  their current value: `runtime_status` and `doctor` are self-*observation* (and `doctor`'s
  strongest check — "provider not configured" — is unreachable, since the agent can't run a
  tool without a configured provider), while `config`'s write whitelist was mostly network
  tuning the agent never changes mid-task. Deleted the `agentSelfMaintenanceTools.ts` module
  + its test, `createSelfMaintenanceRuntime` and both wiring sites in `agentRuntime.ts`, the
  `selfMaintenance` option/mount in `agentTools.ts`, and the four
  `agent.{runtime.status,config.read,config.write,doctor.run}` permission action kinds with
  their descriptor / alias / tool-profile / restricted-base / control-classifier entries.
  **Default agent tool count 26 → 23** (sub-agents never mounted these and are unchanged).
  Self-configuration **stays a goal** — its implementation paradigm (dedicated tool vs. an
  `file_edit` + validated config-write pipeline with last-known-good recovery) is being
  re-evaluated and returns in a follow-up PR; runtime settings stay user-managed via
  Settings → Agent meanwhile. Pre-release, no migration: a remembered grant keyed on a
  removed `agent.*` kind becomes inert (acceptable per the no-back-compat rule). **Gate
  (main):** `/code-review high` → one comment-only finding (a stale "self-maintenance"
  mention in the tool-filter doc comment) fixed in `21ca8bf5`. Verified: typecheck clean,
  `test:core` 1054/0, `test:renderer` 607/0, `docs:check` OK. Specs synced: `agent-tool-design`,
  `agent-progress`, `agent-pi-mono-implementation`, `agent-event-log-rendering`; plan
  `agent-self-modification` updated to record M1 shipped-then-removed.

- **`file_convert` tool removed — redundant with `bash` (PR #331, cc-2)** — the typed `file_convert`
  local tool added no capability over `bash`: both spawned the same converter binaries
  (`soffice`/`libreoffice`, `pdftoppm`, macOS `sips`) through the **same process environment**
  (`buildAgentLocalToolProcessEnv` PATH/env, workdir `cwd`) and under the **same permission floor** —
  the only difference was `shell:false` vs `shell:true`. Its "highest-frequency workflow" rationale
  (from #266) was never measured (A9), and hardcoding `sips` made it **less** portable than `bash`'s
  fallback. Removes `createFileConvertTool` + the converters/helpers, the three `file.convert.*` action
  kinds (`deriveFileConvertActionDescriptors` / path-descriptor copy), `'file_convert'` from
  `LOCAL_FILE_TOOL_NAMES`, the `file_convert` tests, and the spec sections. Default agent tool count
  **27 → 26** (local tools 9 → 8). **Kept** (shared with `file_read` PDF/document ingestion):
  `IMAGE_MEDIA_TYPES`, `getPdfPageCount`, `POPPLER_RECOVERY_INSTRUCTIONS`, `runProcess`; the `bash`
  description now points the agent at `soffice`/`pdftoppm`/`sips` for conversion. **Gate (main):**
  `/code-review high` (2 dead-code findings) → cleanup commit `c242cc97` drops the orphaned
  `selectPdfConversionPageRange` (its only caller was the removed `convertPdfToImages`; `file_read`'s
  PDF path uses the distinct `selectPdfPageRange`) and the now-unused `copyFile`/`unlink` imports.
  Verified at gate on the merge commit: `typecheck` clean, `test:core` 1061 ran / 0 fail (2 skip);
  `docs:check` OK. Specs synced:
  `agent-tool-design`, `agent-skills`. Pre-release: no migration — a remembered grant keyed on a
  `file.convert.*` kind becomes inert (acceptable per the no-back-compat rule).
- **Legacy believer-pool memory projection retired (PR #329, codex-2)** — the third and final PR of
  `dream-channel-and-memory-retire`, finishing the #302 teardown now that PR #328 derives the Dream cursor
  and `lastSuccessAt` from the channel. Deletes the per-principal believer-pool **memory projection + its
  memory API inside `AgentEventStore`** (`recordMemoryEpisode` / `listMemoryEntries` / `updateMemoryEntry` /
  `removeMemoryEntry` / `readDreamState` / `appendDreamCompleted`), the now-dead
  `agentMemoryActivation` / `agentMemoryRetrieval` modules, the
  `AgentMemoryEntry` / `AgentMemoryEvent` / `AgentDreamWatermark` / `dream.completed` types, the
  `agent_list_memory` (+ `agent_update_memory` / `agent_forget_memory`) commands and their renderer/main
  plumbing, and the **Settings → Memory** entry-management UI. The `AgentEventStore` **class stays** — it
  still stores every conversation's events, run streams, payloads, run-meta, and index. Durable
  model-readable memory is now solely the `#d-*` outline timeline nodes; Dream run history is the protected
  Dream channel's `dream.finished` audit log. Pool-only core tests removed with the code. **Gate (main):**
  `/code-review xhigh` (clean) + rebased-stack re-verification — no dangling references, typecheck clean,
  `test:core` 1051/0, `test:renderer` 601/0, e2e `agent-settings` 33/33. Specs synced: `agent-architecture`,
  `agent-delegation-runtime`, `agent-event-log-rendering`, `agent-progress`. Pre-release: no migration (wipe
  `~/.lin-outliner-*`).

### Fixed

- **Agent tool history now replays what actually ran (PR #483, codex-3)** — the
  model no longer learns schema-invalid calls from UI records that invented a
  `cwd`, omitted valid arguments, or guessed file-operation shapes. Every admitted
  call now freezes its exact canonical arguments and identity before execution;
  later requests, context compaction, forks, transcripts, diagnostics, and tool
  details all read that same record. Large arguments remain exact through
  Thread-owned payloads, while missing or corrupt inspection data becomes bounded
  evidence instead of breaking the Turn. Calls containing recognized credentials
  still execute once with their original values in the active Turn, but only a
  marked, structure-preserving redacted call and its real result survive into
  durable history. Rejected and truncated calls produce typed correction evidence,
  and stopping a Turn prevents the rest of either sequential, parallel, or
  truncated batches from being admitted.

- **The reading column is centered again when scrollbars take space (PR #479,
  codex)** — the outliner panel reserved its scrollbar gutter with
  `scrollbar-gutter: stable`, which reserves the inline-end edge only. With
  overlay scrollbars (the macOS default) that costs nothing, but with
  Appearance → "Show scroll bars: Always", on Windows, or on a CI runner, the
  gutter is permanently reserved and the 720px reading column sat ~5–6px left of
  the pane's visual center in every wide single-pane window. It is now
  `stable both-edges`, so the gutters are symmetric and the column centers against
  the panel's visible border box. The four e2e guards that had failed every CI
  macOS sample while never failing locally are fixed with it: three of them
  measured material and HUD colors while GitHub's macOS images forced
  `prefers-reduced-transparency: reduce`, flipping the `a11y.css` override block
  underneath them, so the suite gained `tests/e2e/emulatedMedia.ts` — Playwright's
  own `emulateMedia` cannot set that preference, so the helper pins all five
  visual preferences over CDP and verifies they applied. The guards now assert
  against the visible border box and pin the computed `scrollbar-gutter`, and the
  token probe throws when a token is missing instead of silently inheriting a
  false match.

- **Preview header actions stay beside Close in split layouts (PR #484, codex)** —
  with more than one pane open, an EPUB or URL preview pulled its Translate and
  More controls up next to the filename while the `×` sat alone at the far right.
  The pane-reorder work had narrowed the breadcrumb's drag-to-reorder handle to the
  crumb content, and the preview actions — rendered as breadcrumb children — went
  inside that fit-content wrapper with it. The shared pane breadcrumb now has a
  trailing-actions slot outside the reorder handle, so pane actions and Close share
  the right-hand column while the empty header space between the crumbs and that
  group stays window-drag. One drag detail the fix also closes: the 4px gap between
  the two icon buttons belonged to the window drag region even though both buttons
  opted out, so a press landing a couple of pixels off started a window drag instead
  of hitting the button — a control opting out of the drag region is not enough, its
  group's gaps have to as well. The regression test reads that gap from the layout
  token rather than a hardcoded tolerance.

- **The agent toggle collapses the dock again (PR #481, codex-2)** — clicking the
  fixed top-right toggle did nothing in the real macOS window, though it worked in
  every browser-based test. `.thread-dock-header` declared
  `-webkit-app-region: drag` from a sibling DOM subtree whose box extends under the
  toggle, and macOS consumed the press as title-bar drag before React ever saw a
  click. Electron only carves a `no-drag` control out of a drag region reliably when
  that control is a DOM *descendant* of the region — a rule `shell.css` already
  documented and this file was quietly contradicting. Dragging goes back to the right
  window-chrome zone, which owns it. One deliberate trade: with the dock open, the
  ~290px of header band to the left of that zone no longer drags the window or
  double-click-zooms; restoring it needs an inner spacer bounded to the header's
  content box, recorded in the plan as a follow-up. The Thread-list trigger also drops
  its redundant leading agent glyph and now shows its chevron at rest instead of only
  on hover, so it reads as a list trigger without being pointed at. The regression
  guard is geometric rather than selector-pinned: no element carrying
  `app-region: drag` outside the window-chrome subtrees may intersect the toggle's
  box, so the next overlapping element gets caught too. Native macOS click
  verification remains outstanding — Chromium ignores app regions, so no
  browser-based test can prove this class of bug fixed.

- **Closing a menu in the agent panel no longer bounces your focus to the
  composer (PR #475, cc-2)** — opening the model-and-reasoning menu and pressing
  Escape put focus back on the trigger, as it should, and then a frame later the
  composer took it away, so the next Tab started from the top of the document
  instead of the control you had just used. The panel's click hand-back decides a
  frame after the click whether anything claimed it, and for a control that opens
  a popup that question has no good answer that late: the menu deliberately puts
  focus back on its trigger, which is indistinguishable from the browser simply
  leaving it there. A control that opens a popup now keeps focus for the whole
  open-and-close cycle, decided at click time. One consequence: clicking a trigger
  to close its own open menu leaves focus on the trigger, which is what native
  menus do and what keyboard users need.

- **A long conversation no longer loses the ability to delegate (PR #471,
  cc-2)** — the descendant token pool was keyed on the parent Thread, so spend
  accumulated across every Turn of that Thread's life against the 1.5M default.
  Once it crossed, every later spawn was refused forever; the only reset was
  subtree deletion, and `/clear` never touched the ledger. Because the user is
  never shown a token number by design, this arrived as delegation silently
  going dead with no cause and no way out. Spend is now request-scoped: a pool
  belongs to the delegating Turn that opened it and is shared by everything
  spawned inside that Turn's subtree, and the next Turn opens its own. A
  fire-and-forget child keeps charging the request that asked for it until it
  settles, and re-delegating to an idle child whose pool was already reclaimed
  binds it to the pool of the Turn delegating now, so no descendant Turn runs
  uncovered. Structure is deliberately not rescoped — depth 2 and the durable
  sixteen-direct-children count stay Thread-lifetime.
- **Expanding a transcript disclosure no longer moves the row you clicked (PR
  #469, codex)** — opening a Thought, a tool output, or a long user message in
  the agent transcript could shove that row up or down the screen, because
  bottom-follow and the virtualized-row measurement compensation both
  re-scrolled inside the same layout transaction as the toggle. An explicit
  toggle now owns its transaction: the control's viewport position is captured
  before the update and held while delayed measurements settle, and every
  programmatic scroll — bottom pin, send anchoring, virtual compensation —
  yields to it instead of competing with it. Work that arrives while the anchor
  holds is replayed after it releases rather than dropped, so a streaming
  response keeps following the bottom and a message sent mid-expansion still
  lands at the top of the viewport. When the expansion needs more scroll range
  than the transcript has, a transient renderer-only tail runway supplies
  exactly the missing amount and is reclaimed by later content or by scrolling.
  Sending or choosing Jump to latest supersedes a pending anchor outright, an
  asynchronous tool-output read holds it only until the read lands (bounded at
  three seconds, so a lost reply cannot latch scrolling), and wheel, pointer,
  touch, or keyboard input still cancels it immediately.

- **Agent panel focus hand-back (PR #449, cc, fast-track)** — a mouse click in
  the thread view that nothing claims now returns focus to the composer
  ("terminal model"), so transcript blank space and one-shot actions (copy,
  fork, disclosure toggles, details) no longer strand focus outside the input.
  A click keeps focus where the browser put it when it targets a typing
  surface, a link or node reference, or a text selection kept for copying, and
  defers to any surface that installs its own focus target within a frame of
  the click (self-focusing popovers, dialogs, the inline message editor).
  Keyboard-activated clicks are never intercepted, and an active
  `request_user_input` suspends the hand-back. **Gate (main):** review verified
  the decision module's fail-safe failure direction (unlisted focusables read
  as claimed → no refocus, never focus theft), the rAF ordering against the
  plan popover's self-focus, and the menu focus-restore claim; clean test-merge
  with `main`, typecheck, and 793 renderer tests (12 new) on the merged state.
- **Thread completion layout stability (PR #448, codex-3)** — an Agent Turn no
  longer shifts when its response moves from streaming to completed. The
  user-message action slot and the response footer are reserved at one height
  for the whole Turn lifecycle, so the generating indicator swaps to the
  terminal Copy, Continue in new chat, and Details controls without moving the
  answer. Empty process timelines no longer render, the process divider keeps
  the same tokenized spacing above and below with or without visible process
  Items, every Markdown block keeps its memoized component identity as the
  final streaming block seals, and `content-visibility` containment applies
  from a Turn's first render instead of arriving at terminalization.
  **Gate (main):** review independently verified the spacing arithmetic and the
  slot/footer heights against the token ladder; three findings (indicator
  vertical centering, live-state context-menu gating, spec line wrap) were
  fixed in `958a3e0d` with regression assertions. Verified with typecheck, the
  focused Thread E2E suite (46 pass) on the PR head, and light/dark visual
  verification of the live and completed states.
- **Tag selector active-tag index (PR #427, codex)** — active tag
  definitions, normalized labels, hexadecimal-color penalties, exact-label
  lookup, and empty-query ordering are now cached once per renderer projection
  snapshot. Repeated selector opens and query changes reuse that snapshot, while
  empty-query menus skip already-applied tags and stop at the visible limit
  without rescanning or reranking the full tag set. **Gate (main):** review found
  no reportable issues. Verified with typecheck, 74 focused renderer tests, the
  full renderer suite (962 pass), docs check, diff check, and a 60,000-call
  randomized old-versus-new differential check.
- **Field-name reuse candidate index (PR #426, codex)** — active field
  definitions and Trash ancestry are now indexed once per renderer projection
  snapshot, so focused field-name queries avoid rescanning the complete document
  on every keystroke while preserving complete prefix-first matches and localized
  display sorting. **Gate (main):** the first review found that localized index
  ordering could hide real ASCII prefixes and that a 24-result bound changed the
  picker contract; Codex switched the search index to lowercase code-unit ordering
  and restored complete results before merge. Verified with typecheck, 87 focused
  renderer tests, the full renderer suite (961 pass), focused light/dark E2E,
  docs check, and diff check.
- **System reference values overlay (PR #424, codex)** — read-only References,
  Owner, and Day field rows now layer their synthetic projections over the
  renderer document index instead of copying the full `byId` map for every
  visible field. The overlay preserves Map lookup and iteration semantics while
  rejecting mutation. **Gate (main):** review found no reportable issues.
  Verified with typecheck, 16 focused system-field tests, the full renderer suite
  (955 pass), docs check, and diff check.
- **Panel date navigation index (PR #422, codex)** — renderer document state now
  maintains day-note tag membership and per-date direct-child counts from
  projection deltas, and the panel calendar reads only its visible date window
  instead of rescanning the full document. Fallback Day tags, renames, duplicate
  dates, and sparse updates preserve existing behavior. **Gate (main):** the
  first review found that ordinary incremental updates still cloned complete
  backing maps; the second found that every tag-member set eagerly allocated
  1,024 empty buckets. Codex replaced those paths with sparse occupied-bucket
  maps and native sets below 64 members before merge. Verified with typecheck,
  full renderer tests, focused light/dark date-navigation E2E, docs check, diff
  check, and a 5,000-operation incremental-versus-rebuild differential check.
- **Search query complexity budget (PR #421, codex)** — canonical and saved
  search queries now pass through bounded iterative compilation before
  evaluation, with explicit depth, node, operand, and group-child limits.
  Agent search outlines, renderer query summaries, and reference-cycle checks
  avoid recursive traversal; truncated summaries disclose omitted rules instead
  of silently hiding them. **Gate (main):** the first review found four boundary
  regressions covering pre-mutation admission, ordinary outline validation,
  large acyclic references, and summary truncation; codex fixed all four before
  merge. Verified with typecheck, full Core and renderer tests, focused search /
  outline / reference tests, docs check, and diff check. The two related search
  builder E2E cases remain blocked by the existing `main` Recents-click timeout.
- **Renderer delta reducer surface (PR #420, codex)** — renderer projection
  delta folding now keeps `byId` and per-node render revisions in bucketed
  copy-on-write sparse maps, with delta `projection.nodes` exposed through a
  lazy array-shaped view. Ordinary deltas patch only changed/removed ids,
  preserve unchanged node object identity, and avoid materializing the previous
  map or full node array on the hot reducer path. **Gate (main):** review found
  no reportable issues. Verified with typecheck, full renderer tests, focused
  sparse projection / reducer / real-Core delta integration tests, docs check,
  and diff check.
- **Diagnostic log coalescing (PR #419, codex)** — diagnostic errors now
  aggregate in memory by fingerprint and flush through a bounded compact JSONL
  writer, reducing write amplification during repeated renderer/runtime error
  storms while preserving reveal, export, fatal-error, and before-quit durability
  paths. Renderer global diagnostics now install once in the main world through
  the preload IPC bridge. **Gate
  (main):** first review found a reveal path that could report success after a
  failed explicit flush; codex fixed it before merge. Verified with typecheck,
  focused diagnostics / JSON file-store / renderer capture tests, docs check,
  and diff check.
- **Renderer formatting cache (PR #418, codex)** — renderer date/time and
  number formatting call sites now share bounded `Intl.DateTimeFormat` and
  `Intl.NumberFormat` caches, preserving the existing visible strings while
  avoiding repeated formatter construction in Agent panels, file previews, and
  calendar chrome. **Gate (main):** review found no reportable issues. Verified
  with typecheck, full renderer tests, focused formatting/cache and migrated
  call-site tests, docs check, and diff check.
- **Agent definition-create read-model routing (PR #417, codex)** — definition
  `node_create` now uses the maintained document read model for initial Schema
  validation and a mutation-local projection view fed by command deltas for
  create/config writes, so field/tag definition creation avoids public
  full-projection fanout on `DocumentService` hosts. **Gate (main):** review
  found no reportable issues. Verified with typecheck, focused DocumentService /
  Agent node-tool tests, docs check, and diff check.
- **Agent node_create read-model routing (PR #416, codex)** — ordinary Agent
  `node_create` now uses the maintained document read model for initial
  validation and a mutation-local projection view updated from command deltas
  for target-reference and outline create paths. The collector is threaded
  through fields, recursive nodes, search nodes, code blocks, tags, checkboxes,
  nested fields, and visible result assembly so `DocumentService`-backed creates
  avoid repeated public full-projection reads while fallback hosts keep
  correctness. **Gate (main):** review found no reportable issues. Verified with
  typecheck, full Core tests, focused DocumentService / DocumentReadModel /
  Agent node-tool coverage, docs check, and diff check.
- **Rich-text editor patch runtime (PR #415, codex)** — ordinary focused
  rich-text edits now emit bounded patches from ProseMirror transactions, update
  renderer row/title mirrors through refs instead of whole-snapshot React state,
  and reserve full snapshots for explicit slow boundaries. Core/Loro patch
  application reuses caller rich-text metadata for ordinary replace/mark
  patches, keeping sparse state-cache snapshots while avoiding full rich-text
  decode on the hot path. **Gate (main):** first review found an inline-reference
  boundary deletion regression; codex fixed it before merge. Verified with
  typecheck, Core tests, focused renderer rich-text/trigger/paste/shortcut
  suites, docs check, diff check, manual inline-reference boundary repros, and
  cache-verification tests.
- **Document read model for Agent node tools (PR #414, codex)** — the main
  process now keeps a `DocumentReadModel` fresh from projection deltas, letting
  Agent `node_read` and `node_search` reuse a maintained `ProjectionIndex`
  instead of rebuilding one from a full projection per call. `node_edit
  replace_outline` also uses transaction-local sparse projection facts on
  `DocumentService` hosts, avoiding repeated full projection reads while
  preserving annotated-outline results. **Gate (main):** review found no
  reportable issues. Verified with typecheck, full Core tests, focused
  read-model/DocumentService/Agent node-tool coverage, docs check, diff check,
  and cache-verification tests.
- **Core sparse transactions (PR #413, codex)** — Core mutations now finalize
  from explicit touched-node ids instead of whole-state materialization on the
  hot path. Operation history stores bounded affected-id summaries, journal and
  undo retention are capped, deep shared-state export avoids stack failures,
  replication import uses sparse event candidates when safe, and field/tag-heavy
  tree imports cache resolution while committing responsive chunks. **Gate
  (main):** review found no reportable issues. Verified with typecheck, full
  Core/renderer tests, focused sparse replication/import/cache coverage, docs
  check, and diff check.
- **Single-delivery projection routing (PR #412, codex)** — local renderer
  document commands now apply their returned projection update once, while the
  main process suppresses the duplicate `projection_changed` event back to the
  invoking `webContents`. Main-owned mutations remain broadcastable, and live
  search refreshes route through the command runner so sender suppression cannot
  leave search rows stale. **Gate (main):** review found one swallowed
  live-search refresh path; codex fixed it before merge. Verified with
  typecheck, focused Core/renderer tests, full renderer tests, docs check, and
  diff check.
- **Renderer no-op command outcomes (PR #411, codex)** — blocked, empty, or
  local-UI-only renderer command paths now return a renderer-local no-op instead
  of fetching and reseeding the full projection. The command runner skips
  projection application, focus commits, and `flushSync` for those no-ops, while
  nested slash-file cleanup failures abort without clearing the user-visible
  error. **Gate (main):** review found one nested command failure swallowing
  issue; codex fixed it before merge. Verified with typecheck, focused renderer
  tests, diff check, and a renderer scan proving no `api.getProjection()`
  sentinels remain.
- **Provider transient request retries (PR #395, codex)** — OpenAI and Azure
  Responses requests now retry pre-stream `5xx` and bounded transport failures
  four times with abortable jittered backoff, while retaining the independent
  one-time replay for prematurely terminated streams before material output.
  Retry progress is runtime-only, concurrent Runs preserve independent status,
  and exhausted provider errors render after generated content and before reply
  actions. **Gate (main):** ultra review found one concurrent-Run status-loss
  issue; codex fixed it before merge. Verified with typecheck, 23 focused Core
  tests, 751 renderer tests, focused Playwright coverage, light/dark visual QA,
  docs check, and diff check; the full Core suite's five failures reproduce on
  `main` and come from external Presentation skill resource drift.
- **References as field values (PR #393, codex-4)** — removed the Tenon-only
  `reference` field type and its dedicated picker/command. Plain fields now store
  text, inline references, and whole-row reference children through the generic
  reference path, while options constraints, backlinks, reference counts,
  search, and computed system reference rows remain intact. Agent field
  inference and definition schemas now use `plain` for reference-valued and
  mixed fields. **Gate (main):** ultra review found no reportable issues.
  Verified with typecheck, affected Core suites, 742 renderer tests, 55 focused
  Playwright tests, docs check, and diff check; the full Core suite's five
  failures come from external Presentation skill resource drift.
- **Queued steer consumption (PR #391, codex)** — the Agent composer now removes
  its editable queued-steer preview as soon as the runtime persists that steer as
  the next visible user message, even while the same Run continues. Conversation
  identity plus the prior visible-user-message baseline prevent an older matching
  message from clearing a new queue item; append, edit, cancel, rejection, Run
  settlement, and conversation-switch cleanup remain intact.
- **Structured field resolution (PR #385, codex)** — semantic `Field:: value`
  writes now reuse an existing owner field or unique field definition before
  creating a new definition, preserve existing typed field configs, infer new
  field types conservatively, and fail closed on duplicate active field matches.
  Agent `node_create` / `node_edit` and paste metadata now share the resolver,
  `Done:: true/false` writes through the synced system Done field, and core
  guards prevent manual field creation, field-definition rename, and definition
  reuse from creating duplicate active field names on one owner.
- **Native-feel loading surfaces** — Settings now paints its toolbar, rail, and
  active pane before provider settings finish loading, and the main window
  startup path paints persistent window chrome instead of a generic centered
  loading page. Provider, Agent, and Channel config child windows now also paint
  their header, field structure, and footer actions before their data IPC
  resolves, with only local busy/disabled state while loading. The empty Agent
  panel stays blank while provider settings load instead of showing a loading card
  or flashing no-provider onboarding.
- **Channel deletion affordance** — ordinary Channel rows now expose a confirmed
  delete action beside inline rename in the conversation menu, while protected
  General/Dream Channels keep both mutation controls hidden.
- **Agent skill turn coalescing** — loaded skill steering no longer splits the
  conversation transcript into a standalone assistant turn when the follow-up
  assistant segment belongs to the same run. The skill/tool call and continuation
  now render as one assistant reply, while hidden notifications that separate
  different runs remain invisible turn boundaries. Verified with targeted
  renderer coverage, full renderer tests, typecheck, docs check, and diff check.

- **Outliner row-start Enter insertion (direct main, fast-track)** — pressing
  `Enter` at the start of a non-empty row now creates and focuses a previous
  sibling instead of splitting the row or moving the row text under an expanded
  parent. The editor split payload carries row-start state, the row handler
  preserves the current subtree, and E2E coverage locks the expanded-parent
  regression. Verified with typecheck, docs check, diff check, full outliner
  row-editing E2E coverage, and targeted renderer keymap tests.
- **Run Details transcript turn coalescing (PR #372, codex-3)** — Run Details
  now adapts raw `assistant(toolCall) -> toolResult -> assistant(text)`
  transcripts into one assistant turn instead of visually splitting the final
  answer away from its tool/skill process. Matching tool results remain process
  data, hidden-only user notifications still split turns invisibly, and orphan
  tool results continue to render as capped plain text. **Gate (main):** code
  review found no reportable findings. Verified with typecheck, docs check, diff
  check, targeted transcript/row tests, and the full renderer suite.
- **Disclosure anchor scroll-release spec synced (PR #366, codex-4)** —
  `docs/spec/ui-behavior.md` now explicitly records that immediate user scroll
  input releases the temporary disclosure scroll anchor, so delayed virtual-row
  measurement corrections must not pull the viewport back after the user has
  moved it. This documents the #358 shipped behavior. **Gate (main):** code
  review found no reportable findings. Verified with `docs:check`, targeted
  disclosure-anchor renderer tests, and `git diff --check`.
- **Agent tool rows use semantic icons and readable activity summaries (PR #363, codex-2)** —
  agent tool-call rows now share one renderer presentation registry for lucide icons and activity
  buckets, so local file tools, outliner node tools, child-run controls, web, memory, skill,
  question, history, restore, and unknown tools render with neutral purpose-specific glyphs instead
  of overloaded warning or file icons. Tool-row summaries now use localized readable copy for
  canonical tools, and folded activity groups distinguish file/node read-search-create-edit-delete
  and node restore buckets while keeping pending/error as the only status overrides. The event-log
  rendering spec records the registry contract and child-run folding behavior. **Gate (main):**
  code review found restore activity and spec-sync issues; codex-2 fixed both before merge.
  Verified with typecheck, targeted renderer suites, i18n coverage, `docs:check`, and
  `git diff --check`.
- **Retired the obsolete outliner Settings root (PR #362, codex)** — the
  document-level `Settings` system root is no longer seeded, projected, searched,
  protected, or shown in the workspace tree; the standalone product Settings
  window is now the only Settings surface. Empty default legacy `settings` roots
  are removed on restore, while any retired root with user content or live
  references is unlocked and moved into Library to avoid data loss. Specs and
  projection fixtures were updated with the new root shape. **Gate (main):**
  code review found one data-preservation bug; codex fixed it before merge.
  Verified with typecheck, focused core/renderer suites, `docs:check`, and a
  legacy Settings-child restore reproduction.
- **Hidden Dream system prompt context no longer appears in transcript system lines (PR #360,
  codex-2)** — Dream channel manual/scheduled anchors may carry model-only
  `<system-reminder>` prompt context next to their human-readable summary; the renderer now filters
  those hidden blocks from system actor lines while preserving the visible `Manual Dream` /
  `Scheduled Dream` anchor text. The text extraction path is covered by renderer tests for mixed
  hidden-context + visible-anchor rows and hidden-only suppression, and
  `docs/spec/agent-event-log-rendering.md` records the intended Dream anchor behavior.
  **Gate (main):** code review found no reportable findings. Verified with targeted renderer tests,
  typecheck, `docs:check`, and `git diff --check`.
- **Disclosure scroll anchoring stays stable through delayed measurements (PR #358, codex-4)** —
  expanding or collapsing long virtualized outliner rows now keeps the clicked chevron visually
  anchored across multiple row-measurement frames, while releasing that temporary anchor as soon as
  the user scrolls or signals scroll intent so the helper does not pull the viewport back. The shared
  disclosure anchor helper updates its expected scroll position after its own restorations and cleans
  up frame/listener state when the anchor expires. `docs/spec/ui-behavior.md` records the outliner
  behavior. **Gate (main):** code review found one P1 user-scroll override regression; codex-4 fixed
  it with renderer coverage. Merge verified with typecheck, targeted renderer tests, targeted
  outliner E2E, and `git diff --check`.
- **Agent work divider timing and folding (PR #357, codex-2)** — agent turns now keep one
  persistent `Working / Working for ...` divider timed from run start while active, then collapse
  to `Worked for ...` after sealing without an extra top-level disclosure. Nested thinking/tool
  rows remain available inside the divider, repeated tool calls summarize as grouped activity, and
  answered lone-reasoning turns stay folded by default while resultless lone-reasoning turns still
  open for readability. **Gate (main):** code review found one answered-turn disclosure regression;
  codex-2 fixed it with E2E coverage. Merge verified with typecheck, targeted renderer tests,
  `docs:check`, and `git diff --check`; local `agent-process` E2E could not start because this
  sandbox denied the Vite dev-server port bind.
- **Custom Responses stability and compaction accounting (PR #356, codex)** —
  custom OpenAI-compatible Responses endpoints now use a compatibility request profile that promotes
  leading system/developer input to top-level `instructions`, keeps low verbosity, and enables automatic
  parallel tool calls when tools are present. Custom Responses prompt-cache affinity is restored so
  cache-capable gateways can return provider usage, while auto compact now follows Codex-style
  provider-usage-led accounting across providers: it triggers near 90% of the model context window,
  prefers latest provider-reported total tokens plus locally-added tail, and falls back to local
  estimation before provider usage exists. Terminated custom Responses streams are salvaged only after
  a complete tool call reaches `toolcall_end`, avoiding execution of partial streamed arguments.
  **Gate (main):** code review found one P1 partial-tool-call salvage bug; codex fixed it with a
  regression. Verified with targeted stream/compat tests, typecheck, and `git diff --check`.
- **Custom Responses gateways disable prompt-cache affinity (PR #355, codex)** —
  custom OpenAI-compatible endpoints that preserve the `openai-responses` request shape now force
  provider stream `cacheRetention: "none"` for non-official base URLs across normal agent turns,
  compact summary requests, and provider connection probes. This stops Tenon from sending
  `prompt_cache_key` / session-affinity headers to gateways whose Responses cache implementation may
  differ, while official `https://api.openai.com/v1` Responses requests keep the configured cache
  retention. `docs/spec/agent-pi-mono-implementation.md` records the intended custom endpoint behavior.
  **Gate (main):** code review found no reportable findings. Verified with targeted provider/runtime
  tests, typecheck, and `docs:check`.
- **Custom OpenAI endpoints keep the Responses API for catalog models (PR #354, codex)** —
  custom OpenAI-compatible provider rows now preserve the catalog model's API adapter when the selected
  model is known, so Responses models such as `gpt-5.5` keep `openai-responses` instead of being routed
  through the Chat Completions compatibility shape. Unknown proxy-only models still default to
  `openai-completions`, and the connection-test `/models` discovery probe now applies the same catalog
  lookup before sending its bounded ping. Provider stream failures render inline only when the terminal
  assistant message has `stopReason: "error"`, preserving partial output while leaving user aborts as
  completed aborted turns. **Gate (main):** code review found one missed connection-test path; codex fixed
  it with a regression. Verified with typecheck, full `test:core`, `docs:check`, and `git diff --check`.
- **Active-run tail re-anchored after compact (PR #351, codex-2)** — auto compact during an
  in-flight provider run no longer leaves the run's in-memory tail pointing at the pre-compact
  assistant/tool branch. Later assistant or tool-result segments from that same run now append after
  the post-compact leaf, so the next model-context build does not re-enter the oversized
  summarized-away path and loop through compaction again. Stale transient tool payload/call state is
  cleared at the same boundary. `docs/spec/agent-skills.md` records the invariant. **Gate (main):**
  deep review found no blocking findings; typecheck, `docs:check`, targeted runtime/event-log tests,
  full `test:core` (1116 pass), and `git diff --check` green.
- **Runs-panel title robustness + verifier double-serialization (main, direct-to-`main`, 2026-06-28)** —
  follow-up polish on the agent-goal feature (#343): the Work/Runs row title (also used as the row's
  `aria-label`) now collapses a free-form `objective` to a single whitespace-normalized line capped at 120
  chars, so a long or multi-line objective no longer ships a wall of text to the screen reader; and the
  verifier objective (which serializes node/file changes plus up to 40 tool-trace entries) is built once
  instead of twice per verification. No behavior change to verification outcomes. Typecheck clean;
  `agentRuntimeChildRuns` + `agentRenderProjection` 48/0.
- **Trashed schema definitions treated as inactive + Trash permanent-delete actions (PR #338, codex)** —
  deleting a tag/field definition moved it to Trash, but the app still let it be reused for new tags,
  fields, and `options_from_supertag` derivation. Core commands and renderer pickers now reject trashed
  `tagDef`/`fieldDef` nodes everywhere (apply tag, create tagged node, reuse field def, configure
  `extends` / `childSupertag` / `sourceSupertag`, option-from-supertag selection, template/extends
  chains, name-based lookup) while existing on-row "deleted" badges stay visible; typing the same name
  creates a fresh active definition under Schema. Trash also gains **Delete forever** (per trashed
  subtree) and **Empty Trash** (root) context actions, both behind the shared confirmation dialog and
  the `permanentDeleteCandidateIds` locked/in-trash filter. Specs (`commands.md`, `ui-behavior.md`)
  synced. **Gate (main):** two review rounds (3 findings fixed — DefinitionConfigPanel supertag picker
  now excludes trashed, shared `isNodeInSubtree` extracted, Empty Trash shares the locked filter);
  typecheck + `test:core` 1060 + `test:renderer` 621 + `docs:check` green; the only new visual is the
  `--status-danger` menu-item color + the existing `ConfirmDialog` (token-level light/dark review).
- **Packaged `userData` directory pinned to `…/Tenon` (main, infra)** — the packaged app now resolves
  its `userData` directory **explicitly** to `<appData>/Tenon` instead of relying on Electron's
  `app.getName()` default. Electron derives that default from the bundled package.json `name`
  (`lin-outliner`), NOT electron-builder's `build.productName` (`Tenon`), so a rebuild whose asar
  package.json lacked `productName` could silently move the data directory from `…/Tenon` to
  `…/lin-outliner` and look like data loss. Extracted the resolution into a pure, unit-tested
  `resolveUserDataDir` (`src/main/userDataPath.ts`), moved `app.setName(APP_NAME)` ahead of the first
  `userData` read, and boot-log the resolved directory for future diagnosis. Precedence is unchanged
  (`ELECTRON_USER_DATA_DIR` verbatim → `$HOME/.lin-outliner-dev` from source → packaged `…/Tenon`).
  AGENTS.md "Dev environment" synced. **Gate (main):** typecheck clean, `test:core` 1060/0 (incl. 4 new
  `resolveUserDataDir` cases). Note: a pre-existing `…/lin-outliner` (756M, from older builds) is
  intentionally left in place pending a separate cleanup decision (PM-ratified 2026-06-25: Tenon is
  authoritative).

- **Manual "Dream now" pre-checks for new evidence and advises when there is nothing new (PR #320, cc-2)** —
  a manual Dream over too little new evidence used to be a wasted model round-trip that just no-ops. A new
  read-only **`agent_dream_readiness`** command (`AgentRuntime.previewDreamReadiness()`, mirroring the
  scheduled volume calc via an extracted `collectDreamEvidence`) now runs first; below the volume bar,
  Settings → Agent → Memory surfaces a thin-data advisory plus a **"Dream anyway"** override instead of
  running. The manual Dream flow gets its **own** `'dream'` request scope (not the shared `'mutation'` one)
  so an unrelated settings mutation in flight can't invalidate the readiness request and leave
  "Dreaming…" stuck forever. **Gate (main):** `/code-review high` (3 findings — independent request scope,
  advisory copy, `collectDreamEvidence` extraction — all folded by the author); re-verified on the rebased
  head: typecheck ✓ · dream/readiness/backoff `test:core` 20/0 · `agent-settings` e2e **33/33** (the gate
  caught and the author fixed an `outlinerMock` regression where `agent_dream_readiness` fell through to the
  `agent_*` `undefined` stub, breaking the pre-check pass-through). Spec (`agent-skills`, `agent-tool-design`)
  and both i18n locales synced (A6).
- **Dream remembers nothing instead of recording low-value memory (PR #319, cc-2)** — a Dream over a
  trivial chat used to be forced to write *something* (e.g. a `#d-episode` that only narrated "Neva
  answered a Chengdu weather follow-up") because two forces required output: the runtime threw
  `"… completed without creating or editing memory nodes"` on a successful zero-write child (→ failure
  backoff + re-fire, training the model to always write ≥1 node), and the SKILL/prompt framed a
  `#d-memory` container as mandatory. Now **"remembering nothing" is a first-class, common outcome**: the
  zero-write throw is removed, the one-container rule is conditional on actually writing, and
  transcript-narration / assistant-action episodes are explicitly banned (with the Chengdu-weather line as
  a negative example). **Reverses a prior #302/#308 decision** — a *clean* zero-write completion now
  records `dream.completed` with zero change counts **and advances the watermark**, so a
  considered-but-empty span is not re-read. **But truncation is not a no-op:** the main review gate caught
  that a child reaching `completed` via a maxTurns abort or an unresolved context overflow also returns
  zero writes — advancing the watermark there would silently drop that span's evidence forever. The
  delegation runtime now flags such runs `incomplete` (set before the maxTurns abort, guarded by
  `isStreaming`; and on overflow at completion), surfaced through `runToToolData`; a truncated **zero-write**
  Dream is treated as a **failure to retry** (watermark held), while a truncated run that *did* write keeps
  its work. **Gate (main):** `/code-review high` (8 finder angles → verify) surfaced the truncation
  data-loss path as Finding 1; the author's fix gates the watermark advance on a clean terminal state.
  Re-verified by main on the real head: typecheck ✓ · `test:core` **1046/0** (incl. a new deterministic
  context-overflow test proving the truncated span is retried, not dropped) · `docs:check` ✓. Six
  `docs/spec/*` synced (A6).
- **Live process header stays on the `Working` divider + stable disclosure scroll (PR #317, codex-2)** —
  two live-process presentation defects from the Codex-style transcript. (1) **Header:** an active turn
  without a run clock used to replace the persistent header with a summary of the work below — the
  running-tool / latest-thought line while collapsed, and the descriptive group summary while expanded. The
  active header is now persistent: `Working for {t}` once the run clock is known, and bare `Working` when it
  is not, whether the body is collapsed or expanded (the expanded timeline already carries the
  thought/tool detail). The dead clock-less fallback in `summarizeProcess` (and its `lastThinkingText` /
  `liveCollapsed` / `thinkingLabel` inputs + the orphaned `lastNonEmptyThinking` helper) is removed. (2)
  **Disclosure scroll:** a user expand/collapse changes transcript row height, and the chat panel's
  stick-to-bottom could then pull the scroller after the disclosure anchor had restored, so the clicked row
  felt like it jumped. A user disclosure toggle now pauses stick-to-bottom, and every agent disclosure
  (process row, folded tool-activity group, individual tool row) exposes a stable `data-agent-disclosure-id`
  so the same row is re-anchored after render. **Gate (main):** `/code-review high` (8 finder angles →
  verify) — the substantive candidates (anchor restore re-arming stick near the bottom; the pause being
  "permanent"; clock-less `Working` losing detail) were each traced to design-intended or non-reachable on
  the real path; the one surviving finding (dead `summarizeProcess` params) was folded by the author before
  merge. typecheck ✓ · `agentProcess` test 10/0 (re-run by main) · author suite `test:renderer` 593/0 ·
  `docs:check` ✓.
- **Tool-output context slimming de-coupled from the canonical transcript (PR #313, cc-2)** — the
  per-batch budget offload and the time-based microcompact used to overwrite a tool result's `content`
  with a slim preview/`payload_ref` to shrink the model's per-request copy. That mutated the *canonical*
  record, so on reload an old `web_search`/`web_fetch` decayed into an input-only / no-output row. A
  `tool_result.replaced` now writes a separate **`modelSlimmedContent`** field and leaves `content` full
  forever (the Claude Code 2.1 stance: slim the model's copy, keep the persisted transcript whole).
  Model-context derivation substitutes **`modelFacingContent`** (`modelSlimmedContent ?? content`) — the
  consumers are runtime pi-message derivation, the per-batch sizing in `collectToolResultBatches`, and
  Dream memory extraction — while the UI transcript and search index keep reading the full `content`. The
  replaced event is the durable, monotonic slim-decision journal: replay never shrinks the canonical
  content (so a result is never un-slimmed → cache-stable) and slim-decision logic reads the model-facing
  copy so an already-offloaded/cleared result is never re-emitted (no prompt-cache churn). The search
  index's `tool_result.replaced` branch preserves the full creation-entry text, advances the seq, and
  merges the offload payload id — it never indexes the slim bytes. **Behavior note:** Dream now digests
  what the agent actually saw (the slim copy), matching pre-decouple behavior, rather than the
  re-expanded full output. **Gate (main):** the merge folded the `/code-review xhigh` findings (model-facing
  sizing, search-index never-index-slim, Dream model-facing, reducer `updatedAt`) with regression tests
  and an adversarial verify of the fix delta (all four CONFIRMED-CORRECT, no new bug, no layering
  violation). Spec synced (`agent-pi-mono-implementation.md`). typecheck ✓ · `test:core` 1043 / 0 fail ·
  `test:renderer` 560 / 0 fail · `docs:check` ✓.
- **Parallel tool calls render every result, no mid-turn red flash (PR #314, main)** — one assistant
  turn that fans out parallel tool calls (e.g. several `web_search`/`web_fetch`) had two rendering
  defects. (1) **Persistence:** each tool result's `parentMessageId` was the assistant message, so N
  parallel results were stored as *siblings*; the transcript's single-leaf active path keeps one child per
  node, so N-1 results fell off-path → invisible → rendered as resultless "Failed" rows (≈half of all
  parallel-tool results). Results now chain onto the run's tail `lastMessageId` (`assistant → result₁ →
  result₂ → …`), honoring the documented "run is a linear spine" contract, so every result stays on the
  active path. (2) **Live status:** the per-row spinner was granted to only the single most-recent
  un-settled tool (and only while `pendingToolCallIds` was empty), so in the frame after a parallel batch
  is emitted but before the runtime marks the calls in-flight, every tool but the last flashed red
  ("red → running → success"). A new pure `isToolCallRowActive` predicate treats every un-settled tool
  (no result, no `outcome`, no child run) as pending while the turn is live. Extends the
  `fix/tool-call-spinner-stuck` `outcome` work below. Both regression tests mutation-verified; two
  independent adversarial reviews clean. Spec synced (`agent-event-log-rendering.md`). typecheck ✓ ·
  `test:core` 1041 / 0 fail · `test:renderer` 560 / 0 fail · `docs:check` ✓.
- **Completed tool steps no longer spin forever (main, `fix/tool-call-spinner-stuck`)** — a finished
  step (e.g. a `web_search` that returned) kept showing a spinner for the rest of the run. The
  authoritative `tool_call.completed` / `tool_call.failed` events were replay no-ops, so the renderer
  inferred "done" only from a later `tool_result.created` message; when that result never lands in the
  projection (some built-in SDK tools complete without one) the row fell through to the active-turn
  fallback and spun indefinitely. Replay now stamps a per-call **`outcome`** (`completed`/`failed`) onto
  the toolCall content, the render entry carries it (the pi `AssistantMessage` drops it), and
  `getToolCallStatus` resolves a settled call to done/error even with no result message — the active-turn
  fallback now only bridges genuinely un-settled, resultless calls. Render-only (model context never sees
  `outcome`) and survives reload via replay. Spec synced (`agent-event-log-rendering.md`); new core replay
  test + renderer `getToolCallStatus` cases. typecheck ✓ · `test:core` 1040 pass / 2 skip / 0 fail ·
  `test:renderer` 555 pass / 0 fail · `docs:check` ✓.
- **Editing Neva's tool allow/deny list hot-swaps the live conversation (PR #299, main)** — a tools
  edit through the settings editor persisted to the built-in overlay but never re-resolved the open
  conversation's `agentToolFilter`, so a just-removed tool stayed callable until the conversation was
  reopened. The `updateAgentDefinition` hot-swap loop (which already re-applied persona/model/effort)
  now also recomputes `agentToolFilter` from the freshly-materialized built-in overlay and rebuilds
  the live tool set via `applyRuntimeToolSettings`. Adds an integration regression test (verified red
  without the fix). This was finding #2 of the #294 post-merge `/code-review max`; finding #3
  (`tools:[]` → all-on) was a verified false positive — the editor maps "uncheck all" to
  `tools: undefined` (inherit all) by design and never stores an empty allow-list for the built-in.
- **Invoked skills can read their own reference files; web_fetch verification pages route to the
  browser without flagging real articles (PR #292, codex)** — three corrections. (1) **Skill reference
  reads:** a resource-backed inline skill exposes `${AGENT_SKILL_DIR}` and points `file_read` at support
  files such as `references/*.md`, but the permission audit and the file-tool execution roots had
  diverged, so those reads could still be rejected after permissions were loosened. The runtime now
  projects the *exact* invoked-skill directory into the typed file boundary as a **read-only** root —
  a source-tree `src/main/builtInSkills/<skill>` path in dev, the copied `built-in-skills/<skill>`
  directory in packaged builds. `getActiveSkillReadRoots` re-validates every restored skill against the
  live registry (`skill.skillRoot === expectedRoot`), so transcript text cannot grant arbitrary reads,
  and it never grants write access or exposes sibling/parent skill dirs; the read still passes the
  normal sensitive-path block (the `isSensitivePath` check precedes the inside-area check). (2)
  **web_fetch verification detection:** Reddit/DataDome-style "please wait while we verify" interstitials
  (including ones served with HTTP 200/401) now route to the browser fallback, but the markers are kept
  narrow — explicit interstitial phrases, and DataDome markers only when a `verify`/`verification`/
  `captcha` word co-occurs — so a full article that merely embeds a bot-protection asset (e.g. a
  `js.datadome.co` tag) is **not** misrouted and discarded. (3) **Live Channel tool status:** a tool
  that fails mid-turn in the live Channel working-detail now renders as an **error** instead of a green
  "done" — a dedicated `failedToolCallIds` channel carries error state alongside `pendingToolCallIds`,
  and the per-run tool-result index is built once per projection (one O(messages) pass, not one per run).
  Specs: `docs/spec/agent-skills.md`, `docs/spec/agent-tool-permissions.md`. **Gate (main):**
  `/code-review high` (8 finder angles, recall-biased) → blocking findings (over-broad fetch markers
  re-introducing the documented false-positive class; errored live tool rendering green) fixed in
  follow-up `05854c28`, plus the per-run scan collapsed to a single pass and a skills early-out;
  re-verified typecheck ✓ · `agentWebFetchFallback` 17/17 · `agentChannelRuntime` 32/32 ·
  `agentRenderProjection` 25/25.
- **The agent dock reopens the conversation you last selected, not always the latest (PR #261, codex-4)** —
  opening the agent dock after a renderer remount/reload restored the *latest* conversation rather than the
  DM or Channel the user last had open: the selected conversation only lived in memory, and the initial
  restore path always picked latest. The renderer runtime store now **persists the last-selected conversation
  id** (`AgentRuntimeStore` gains an injectable `AgentConversationPreferenceStore`; the browser impl is
  localStorage-backed under `lin-outliner:agent-last-conversation:v1`, best-effort so a failed write never
  blocks chat) and **restores it before falling back to latest** — startup tries the remembered DM/Channel via
  `restoreConversation(id)`, and on failure clears the remembered id and falls back to `restoreLatestConversation`
  (the `requestVersion` guard blocks stale writes from a superseded restore). The preference is written at the
  single choke point `hydrateConversation` (select / new / reload / restore all funnel through it) and cleared
  when the active conversation is closed; the injectable store keeps tests independent of browser localStorage.
- **A DM child run folds into its spawning turn's process — no orphan boundary, no broken style (PR #247, cc)** —
  a child run spawned by an `agent` tool call inside a **DM** (a non-multi-agent conversation) used to render
  as a conversation-level **child-run boundary row** (a centered divider between two rules), which surfaced
  two bugs from the reported screenshot: (1) the row **persisted after re-editing** the message that started
  the turn — child runs carry no message/branch anchor, so `insertChildRunRows` appended the orphan at the
  transcript end once the parent tool call left the active branch; and (2) **broken style** — the "Agent task"
  label wrapped to a second line and the description overflowed the panel's right edge. The reframe: in a DM a
  child run is the agent's own **implicit** behavior — it quietly delegated a slice of the current turn — so it
  now **folds into that turn's process** instead of standing as a first-class divider. The in-process `agent`
  tool-call block already renders full parity (summary "Agent task · {description}", expand-to-result, open
  full transcript) via `childRunsByParentToolCallId`; the fix is two coordinated gates on the **same**
  multi-agent flag — the projection **skips** the boundary row (`!multiAgent && parentToolCallId`) and the
  renderer **keeps** (does not suppress) the tool-call block in a non-multi-agent conversation. Same-flag
  lockstep is load-bearing: it makes the "child run vanishes" failure (no boundary AND no fold) provably
  impossible, including for a single-agent channel. Because the folded run lives inside the turn's own message,
  it is turn-anchored and branch-pruned with that message — an edit removes it cleanly, no orphan. The
  **multi-agent Channel** boundary row and the **parentless command-fire** row are unchanged; the surviving
  boundary's CSS shrink chain (`min-width: 0` + ellipsis) is hardened so it single-lines and ellipsizes instead
  of wrapping/overflowing. Spec: `docs/spec/agent-event-log-rendering.md`.

- **Channel "Interrupted" verdict tied to the run's real status — the root fix (PR #244, cc)** —
  the recurring multi-agent Channel mislabel (a coordinator turn shown red **"Interrupted after thinking"**
  while it looked unfinished) that #240 and #242 both only patched. Root cause: the "interrupted" verdict
  was a pure RENDER heuristic — `turnFailedWithoutProse = turnEnded && !finalIsProse` — that never consulted
  the run's real outcome. Because a multi-agent Channel hardcodes `turnPhase: idle` (every Channel row's
  `turnEnded` is always true), it collapsed to "ends on a thinking/tool block → red Interrupted" for **any**
  result-less turn, whether it completed cleanly, was mid-flight in a projection gap, or genuinely failed.
  The fix decouples the two concerns the heuristic conflated, both off the run's authoritative status:
  (1) the core projection stamps `turnInterrupted` on each assistant message from the producing run's REAL
  status (`failed`/`cancelled`, or a crash-orphaned `running` run absent from the live `activeRunIds`), so
  the red label + error styling fire ONLY on a genuine interruption — a cleanly `completed` turn is never
  red, in either mode; (2) surfacing a resultless turn's process is now mode-aware
  (`surfaceResultlessProcess`) — a genuine interruption surfaces in either mode, and a sealed resultless DM
  turn still surfaces its work (#240 preserved unchanged), but a cleanly-completed resultless **Channel**
  turn folds to the neutral **"Worked for …"** header (atomic delivery — its process lives in the activity
  detail view, not inline). The dead `turnEnded` plumbing is removed; the e2e mock now carries
  `turnInterrupted` to mirror the real entity. The four #240 DM e2e tests pass unchanged; visual verified
  light + dark (a completed Channel `web_fetch` turn now reads "Worked for 5s", a cancelled one stays red
  "Interrupted"). Spec: `docs/spec/agent-event-log-rendering.md`.

- **Channel turns deliver atomically — suppress in-progress turns from the transcript (PR #242, cc-2)** —
  a running Channel agent's turn no longer appears in the transcript until it completes, realizing the
  spec's atomic-delivery rule and fixing the false **"Interrupted after thinking"** label that #240's
  result-first fold surfaced on actively-working turns. `buildTranscriptRows` now suppresses every
  message whose producing run is **live** in a multi-agent Channel — keyed off the in-memory active-run
  set the runtime passes in (`options.activeRuns`), NOT the persisted `status === 'running'`: a run left
  `running` by a crash/quit is absent from the live set, so its **interrupted** turn still renders rather
  than silently vanishing (regression-guarded). The in-flight turn's progress stays in
  `channelActivityEntries`; the whole turn appears once its run seals, rendered result-first. A spawned
  child run is held back the same way, so its boundary row never orphans to the transcript end while the
  parent is hidden, then reappears anchored once the parent lands. Gated on `isMultiAgentConversation`,
  so a DM still streams its active turn live. A shared `isRunRunning` predicate replaces the scattered
  inline status checks (and fixes a latent `activeRun` undefined-deref in the activity-entry gate).
  Addresses the `/code-review max` findings on the first cut (live-set keying, child-run symmetry, the
  shared helper, and the test). Spec: `docs/spec/agent-event-log-rendering.md`.
- **Delegation runtime hygiene — stop-salvage + shared child-agent harness (PR
  #221, cc-2)** — a `stop()`ped child run now keeps the last partial assistant
  text it produced (surfaced in the synchronous tool result and terminal
  notification) instead of reporting an empty result; spawn (`startAgent`) and
  resume (`ensureLiveAgent`) build the child agent through one
  `buildChildAgentHarness`, so a resumed run honors the **current**
  disabled-skill/agent settings (the resume path previously skipped those gates)
  and carries its `unattended` flag in-memory. The salvage is scoped to the
  current live span via a `salvageFromIndex` floor (set at resume, reset at
  compaction), so a run resumed after completing and then stopped before new
  output no longer resurrects the prior round's result; `send()` rebuilds the
  agent before mutating run state so a failed rebuild can't strand the run or
  wipe its prior result. No protocol/`commands.ts`/`types.ts` change.
- **Built-in skill path handling + skill-write permission simplification (PR
  #214, codex-2)** — code-registered built-in skills (currently `/skillify`) no
  longer render a fake `Base directory for this skill: built-in/<name>` header or
  claim a readable `built-in/<name>/SKILL.md`, so the model stops attempting an
  out-of-workspace `file_read` that hit a hard permission block; built-ins render
  body-only and post-compact bookkeeping records them as `built-in:<name>`.
  Restore bookkeeping hardened: `parseLoadedSkillFromText` skips forked-skill
  result messages (guarded on `<skill-result>`) so one-shot child-run output is
  never re-injected as persistent skill guidance, the skill-listing-state identity
  uses `built-in:<name>` instead of the pseudo path, and `addLoadedSkill` no longer
  stats the non-existent built-in file. Permission model: the dedicated
  `agent.skill.write` action is **removed** — writes into recognized skill
  directories now use the ordinary `file_write` / `file_edit` permission decision
  (PM-ratified 2026-06-12); recognition still drives validation, provenance,
  rollback metadata, audit events, and hot-reload, and the safety floor remains
  invocation-time ratification (agent-written skills are born unratified and need
  exact-byte user acceptance to become model-invocable). Specs synced:
  `docs/spec/agent-skills.md`, `agent-tool-design.md`, `agent-tool-permissions.md`,
  `agent-progress.md`. Gate (main): typecheck + test:core (936 pass / 2 skip /
  0 fail).

- **Packaged agent local-file root no longer defaults to `/` (PR #192)** — the
  launch-time fallback was `LIN_AGENT_LOCAL_ROOT ?? process.cwd()`; in a packaged
  app launched from Finder, `process.cwd()` can be `/`, which made the whole disk
  the agent's allowed file area (ordinary non-sensitive reads/writes outside any
  intended project boundary defaulting to in-root behavior). Root resolution is
  now a pure resolver (`src/main/agentLocalRoot.ts`): a non-empty
  `LIN_AGENT_LOCAL_ROOT` (trimmed) is an explicit override; source/dev runs keep
  `process.cwd()` (the `dev:*` scripts run from the repo clone, so dev stays
  repo-bound); packaged runs with no override use the dedicated
  `<userData>/agent-local-root` directory — a sibling of the app's own
  persistence, never `/` and never the full `userData` — created at startup so
  bash/file-tool cwd exists. This only narrows the default-allow area; the
  sensitive-path redlines and out-of-root deny/ask rules are unchanged. Boundary
  semantics documented in `docs/spec/agent-tool-permissions.md`. Hard prerequisite
  for Full Access in `agent-permission-safety-modes`, now cleared.

- **Dream backoff hygiene + manual-bypass coverage (PR #190)** — follow-up to #189
  closing its two accepted gate notes: `fireDream` now prunes `dreamFailureBackoff`
  entries for pools that are no longer dream principals (e.g. a deleted agent) at the
  start of each scheduled pass, bounding the in-memory map to live pools (a live pool
  with an armed window is always in the principal set, so it is never pruned); and a
  new integration test asserts a manual `/dream` ignores an open backoff window and
  records a `completed` run, covering the manual-bypass gate and the completed branch
  of `recordDreamFailureBackoff`.

- **A failing scheduled Dream backs off instead of re-firing every tick (PR #189)** —
  the Dream scheduler ticks every 60s and its gate only consults the pool's last
  *success* (`shouldFireDateSchedule(…, lastSuccessAt)`); a failed Dream advances
  neither `lastSuccessAt` nor the watermark, so a persistently failing Dream
  (provider down, quota, …) re-created a fresh `failed` run record every minute,
  per pool — up to 1440/day/pool. Added a per-pool, in-memory failure backoff
  (sibling to the `dreamingPools` guard): after a *scheduled* Dream fails, the pool
  is held off for an exponentially growing, capped window (5 min → 10 → 20 → … →
  6 h cap), cleared on the first success. A manual `/dream` ignores the window (the
  user asked for it now) and its outcome still resets the backoff, so a manual run
  can un-stick the schedule; `skipped` outcomes leave the window untouched. The
  curve is a pure helper (`dreamBackoff.ts`). In-memory by design — transient
  scheduler control state, not durable self-model — so a restart costs one extra
  attempt, never a flood. Does not retroactively clean already-piled records.

- **Dream sessionId stays within the provider `prompt_cache_key` cap (PR #188)** —
  the Dream batch stream `sessionId` was `${principalKey}:dream:${runId}:${n}` =
  79 chars; pi-ai clamps the request body's `prompt_cache_key` to 64 but still
  writes the untruncated id into the `session-id` request header, so the
  `openai-codex` backend rejected every packaged-app Dream with HTTP 400
  (`Invalid 'prompt_cache_key': … length 79`). Dropped the `principalKey` prefix
  (`runId` = `dream-run-<uuid>` is already globally unique and the prefix bought no
  cache affinity) → new form `dream:<runId>:<n>` = 54 chars. The format now lives
  in one `buildDreamSessionId(runId, batchIndex)` builder so no caller can
  re-prepend a principal; a unit test guards the 64-char cap. Normal chat was
  unaffected (its `conversationId` is 29 chars).

- **Outliner indent and trailing-draft placement (PR #182)** — closes the boarded
  fast-track `outliner-indent-draft-fixes`. Batch Tab no longer force-expands the
  selected siblings themselves, and the skip-batch-members run rule now lives in core
  `batchIndentNodes` so agent-driven batch indents are covered too, not just the
  keyboard path. Single indent expands the target in the same paint as the projection
  move instead of one frame early. A trailing draft outdented with Shift+Tab now lands
  in the parent scope directly after its old parent — a `{parentId, afterId}` placement
  with one shared resolver (`src/renderer/state/trailingDraftPlacement.ts`) drives
  rendering, the materialize index, Tab inversion, and ArrowUp/Backspace, and Enter
  materializes in place on both the text and empty paths. Structural row moves gained a
  reduced-motion-aware FLIP animation (duration derived from the motion token ladder),
  outdent is blocked at the panel root, and outdenting a parent's last child collapses
  the emptied parent. Two gate rounds; five low-severity residuals recorded on the PR.

- **IME composition survives the split echo and empty rows (PR #177)** — fixes #176, the
  P1 `skill` → `sk ill` mid-word tearing, with two independent root causes closed: (1) a
  split echo's focusRequest landing ~60–80 ms into a live composition force-committed the
  partial word — a global composition gate now parks focusRequest application while any
  composition is live, and at compositionend the composing editor relays the (never-flushed)
  composed text through the existing pendingInput rail to the echo's focus target, so the
  word lands whole at the head of the new row; (2) an empty textblock has no #text node to
  host the IME's marked range, so ProseMirror's first non-append composition rewrite redrew
  the paragraph and killed the OS IME session — compositionstart now seeds empty blocks with
  the existing zero-width sentinel anchor (stripped by the codec, never persisted). Renderer-
  only; leg 1 pinned by a real-app CDP probe (`scripts/probe-ime-split.ts`), leg 2 verified
  with a real Pinyin IME (CDP cannot emulate it — caveat recorded in `ui-behavior.md`).

- **Agent memory evidence survives transcript compaction (PR #178)** — closes M3 Phase 1
  (`agent-memory-source-binding`, plan archived `done`). Both Dream evidence renderers dropped the
  post-compact reminder along with all hidden boilerplate — but after a subagent fork auto-compacts
  (transcript payload superseded) or a conversation `/compact`s (active path re-anchored at the
  post-compact root), that reminder is the only remaining carrier of the pre-compaction content, so
  the content was silently never distilled while the Dream watermark advanced past it; additionally a
  fork-prefix boundary recorded against a longer, superseded transcript clamped into a permanent
  silent skip of the whole run. Dream evidence now surfaces the compaction summary (anchored
  extraction, the inverse of the reminder producer and co-located with it in `agentCompaction.ts`),
  reads the fork boundary envelope-first (written atomically with the messages it indexes), and
  treats a boundary beyond the payload length as "fresh evidence, Dream from 0". The review round
  hardened the extractor anchoring (a hidden block merely quoting the preamble can no longer leak
  hidden context into evidence), pinned the reminder strings as persisted-format surface, and deduped
  the renderer exception + test fixtures. Invariant recorded in `agent-data-model` §13.17. Gate:
  RED-on-main verification + multi-agent `/code-review`; typecheck; `test:core` 801/0.
  ([#178](https://github.com/relixiaobo/lin-outliner/pull/178))
- **Launcher keeps the dock icon + first ⌘Q quits promptly, at the root (PR #171)** — supersedes PR #170's
  show/hide toggle and the dock-icon fast-track with the actual root causes, found to be **two independent
  bugs**. (1) *Dock icon vanished when the launcher was summoned:* the launcher's all-Spaces collection
  behavior (`setVisibleOnAllWorkspaces`) transforms the app's process type to `UIElementApplication`
  (accessory), dropping the dock icon + ⌘Tab entry (electron#26350); the native `collectionBehavior` attempt
  (commit cea2998) did **not** avoid the transform and is reverted (addon byte-identical to `main`). Fixed by
  adding Electron's purpose-built **`skipTransformProcessType: true`** to `setVisibleOnAllWorkspaces` on
  show/hide, so it joins all Spaces without the transform. (2) *First ⌘Q needed two presses* (reproduced on a
  fresh launch with the launcher never summoned — unrelated to all-Spaces): the `before-quit` handler
  `preventDefault()`s the OS ⌘Q to flush, and the prior re-issued `app.quit()` lingered for seconds before the
  process actually exited. Now the handler drains in-flight writes then **`app.exit(0)`**s — review-hardened to
  first `AgentRuntime.drainPendingWrites()` (session event-log appends + the crash-safe Dream/command-sweep
  tails) under a 2.5s hard timeout so a slow in-flight Dream LLM call can't block the quit, with the global-
  hotkey unregister inlined into `before-quit` (since `app.exit` skips `will-quit`). Gate: high-effort
  `/code-review` (3 findings — runtime-write durability, `app.exit` over `process.exit`, the `will-quit` trap —
  all fixed and verified on the merged tree) + typecheck + `test:core` 774/0; the packaged ⌘Tab / over-
  fullscreen-float / no-focus-steal / dock-icon checks remain a one-time manual eyeball on the `.dmg`.
  ([#171](https://github.com/relixiaobo/lin-outliner/pull/171))

- **Tenon shows its dock icon again (fast-track)** — the packaged app ran in macOS "accessory" activation
  policy (window + menu bar present, but no dock icon and no ⌘Tab entry) — a side effect of the always-present
  non-activating launcher NSPanel. The prior `app.dock.show()` re-assert did not restore it (that API only
  un-does an explicit `dock.hide()`); replaced with `app.setActivationPolicy('regular')` right after the
  launcher is created, which forces the app back to a regular foreground app. Verified by typecheck; the dock
  icon itself needs a one-time packaged-build eyeball (same as the ⌘Q fix).
- **First ⌘Q quits the packaged app (PR #170)** — the prewarmed global launcher window called
  `setVisibleOnAllWorkspaces(true)` at creation and kept it forever, even while hidden; a window that
  permanently joins all Spaces makes AppKit skip `applicationShouldTerminate:` on the first ⌘Q, so the
  `before-quit` flush never fired and the app needed two presses. The all-Spaces (incl. other apps'
  full-screen) collection behavior is now toggled **only while the launcher is visible** — set in
  `showLauncherWindow`, cleared in `hideLauncherWindow` (every dismissal routes through it) — so the common
  quit path (launcher hidden) is free of the bug, while cross-Space float is unchanged while it is open.
  Gate: `/code-review` + hide/show path audit (sole `.hide()` / `setVisibleOnAllWorkspaces` callers) +
  typecheck + `test:core` 766/0; the packaged first-⌘Q outcome still needs a one-time manual eyeball on the
  `.dmg`. ([#170](https://github.com/relixiaobo/lin-outliner/pull/170))

- **Page-header icon stays visible in dark mode (PR #148)** — the neutral system-page header icons
  (Library / Schema / Trash / Saved searches), rendered in a `.panel-header-icon` chip styled with
  `mix-blend-mode: multiply` (tuned for a light backdrop), crushed to near-black on the dark content base
  and read as missing (user-reported on Library). A `@media (prefers-color-scheme: dark)` override now
  drops the blend to `normal` so the glyph renders at its intended `--muted-2` tone — the same blend-normal
  the tagDef header icon already used. One isolated override in `panel.css`; the tag `:has()` case (higher
  specificity, already normal) is unaffected. Gate: typecheck + CSS-specificity verification.
  ([#148](https://github.com/relixiaobo/lin-outliner/pull/148))

- **Agent stop button + streaming indicators look right (PR #137)** — the composer **stop button**
  rendered a 10px filled square inside the 28px inverse-fill disc — undersized, and near-white-on-dark
  felt off; the StopIcon is now 14px so the rounded square sits proportionally in the disc (light + dark).
  Separately the **streaming "still generating" signals** (inline `.agent-stream-caret` via `--caret`, and
  the standalone `.agent-streaming-capsule` pulse) painted in brand rose `--accent`, reading as a loud rose
  bar competing with rose links / inline references in the same panel. These are functional state
  indicators, not brand marks (B3/B4): the caret is now neutral via `--text-primary` (inverts with `--ink`)
  and the capsule via `--text-secondary`; the pulse animation carries the liveness. Gate: typecheck +
  token-guard e2e (`typography-tokens.spec.ts`) 8/8 + light/dark visual verification; no raw hex /
  non-token values added (B11). ([#137](https://github.com/relixiaobo/lin-outliner/pull/137))

- **Nested rows now reflect drag / cmd-click multi-selection (PR #136)** — dragging or modifier-clicking to
  multi-select the children **inside an expanded node** did nothing visible — the rows never got the
  `selected` highlight until an unrelated render woke them up ("re-enter a node to fix it"); direct children
  of the view root were fine. Not a focus race: the selection *state* was correct, the `.selected` *class*
  was stale. A row computes that class during its own render from the prop-drilled `ui`; a nested row
  receives `ui` only through its owning expanded ancestor, and the `outlinerItemPropsEqual` memo comparator
  let that ancestor bail out (freezing the forwarded `ui`) when its own memo state was unchanged — it forced
  an ancestor re-render for `expanded` changes but not for selection/focus. (Supertag correlation was
  incidental: tagged nodes routinely carry an expanded child list.) Fix: generalize the expanded-only
  forward to the full set of `ui` slices a descendant's `deriveRowMemoState` reads (focus + selection +
  pending-reference), gated on the row being expanded so only ancestors that own a nested view re-render;
  `focusRequest`/`pendingInputChar` keep their precise `focusAncestorToken` detection. Gate: typecheck +
  `test:renderer` 354/0 + `outliner-selection`(+keyboard) 34/34 incl. new nested drag-select / cmd-click
  regressions + light/dark visual; clean cross-PR merge with #134's `OutlinerItem.tsx` edit.
  ([#136](https://github.com/relixiaobo/lin-outliner/pull/136))

- **Checkbox-row long text wraps beside the checkbox, not under it (PR #131)** — on a checkbox row (a node
  with a Done field / `completedAt`), long content wrapped onto its own line **underneath** the 16px+5px
  done checkbox instead of beside it, breaking the hanging indent. Root cause: `.row-editor` is an
  `inline-block` capped at `max-width:100%`, so it could not share the first line with the 21px checkbox
  gutter and the whole block dropped to the next line. Fix: one CSS rule reserves the gutter, scoped with
  `:has()` so only checkbox rows are touched — `.row-content-line:has(> .done-checkbox) > .row-editor {
  max-width: calc(100% - 21px); }`. The editor now stays beside the checkbox and wraps in a column aligned
  to the text start. Gate: typecheck + new `outliner-checkbox-wrap.spec.ts` guard (editor sits right of +
  shares the checkbox's first line + wraps >1 line; fails pre-fix) + light/dark visual; cross-PR merge with
  #133's outliner.css edit verified conflict-free. ([#131](https://github.com/relixiaobo/lin-outliner/pull/131))

- **Definition template/options blocks invite content via an empty-state placeholder (PR #134)** — a
  tagDef's *Default content* and an options fieldDef's *Pre-determined options* block used to read as an
  orphaned ALL-CAPS label over a near-invisible ghost bullet when empty (the PM's "looks weird"). The
  geometry was never different from a populated field (label left 261px, outliner left 240px in both) —
  the gap was purely content state. The block's trailing draft now carries an "add here" call-to-action
  (`Add default content…` / `Add an option…`) via the existing empty-row placeholder mechanism
  (`.row-editor.is-empty::before`, hidden on focus); the generic body trailing draft stays unlabeled.
  `definitionOutlinerPlaceholder()` mirrors `definitionOutlinerLabel()` one-to-one and threads through
  `NodePanel` → `OutlinerView`/`OutlinerFlatView` to the root-level trailing draft only. The companion
  modelling question (a dedicated option node type) was shelved — Tana/nodex already model options &
  template items as plain id-referenced nodes, so a new type would be more machinery, not less. Gate:
  typecheck + `test:renderer` 353/0 + `definition-config.spec.ts` 3/3 + i18n 832/832 + light/dark visual;
  verified the cross-PR auto-merge with #132's `filePreview` i18n keys is conflict-free and preserves both.
  ([#134](https://github.com/relixiaobo/lin-outliner/pull/134))

- **Sidebar system-node icons restored; tagDef header + colour-picker selection (PR #133)** — three
  sidebar/tag visual fixes. (1) The workspace-tree system rows under Root regained their per-type icons
  (Daily Notes → calendar, Library → library, Schema → supertag, Saved searches → search, Trash → trash)
  via a new `systemIconForNode` mapping in `Sidebar.tsx`, reversing the icon removal from #30 (PM-ratified);
  the `workspace-layout` guard now asserts exactly one icon per system row. (2) The tagDef NodePanel header
  accent chip was being crushed in dark mode by the wrapper's `mix-blend-mode: multiply` — `panel.css` now
  resets `background: transparent; mix-blend-mode: normal` on `.panel-header-icon:has(> .panel-header-tag-icon)`
  so the solid accent fill + white hash reads cleanly in both themes. (3) The selected colour swatch swapped
  the too-faint `--border-emphasis` border for a strong ink ring with a surface-coloured gap; the multi-layer
  shadow lives in a new `--swatch-selected-ring` token (matching `--view-radio-checked-shadow`) so it satisfies
  the box-shadow token guard. Gate: typecheck + `test:renderer` 353/0 + `typography-tokens` 8/8 +
  light/dark visual verification (sidebar icons, tagDef header chip, selected-swatch ring).
  ([#133](https://github.com/relixiaobo/lin-outliner/pull/133))

- **Agent: process block collapses by default; one spinner; never auto-collapses (PR #129)** — the
  thinking/tool process block had three flaws while live: it auto-expanded during a run (instead of a
  compact status), the header *and* the running tool both span (two spinners), and once prose arrived the
  default flipped expanded→collapsed and snapped shut on a user mid-read. New model: the block is
  **collapsed by default in every steady state**. While live + collapsed the header doubles as a status
  line (currently running tool → latest streaming thought, 80-char first-line preview → `Thinking...` →
  `Working...`) and carries the **single** activity spinner; expanding moves the spinner to the running
  tool row inside the timeline and reverts the header to the static group summary. `defaultExpanded` is
  now `turnFailedWithoutProse` only — it never flips on seal, so a user-expanded block keeps its sticky
  override and **never auto-collapses**; only a turn that failed without any prose auto-expands to surface
  the error. Renderer-only (`AgentProcessBlock.tsx`); no new i18n strings. Gate: typecheck +
  `test:renderer` 353/0 (added live-collapsed running-tool / thought-preview / fallback + live-expanded
  static-summary cases) + light/dark visual verification of a live streaming turn (collapsed status line
  with one header spinner; expanded shows zero header spinners and exactly one tool-row spinner).
  ([#129](https://github.com/relixiaobo/lin-outliner/pull/129))

- **Agent: inline node references render as `<a>`, not `<button>` (PR #127)** — in an agent response an
  inline node reference (the rose link) dropped onto its own line with an empty gap before it instead of
  flowing with the sentence. Root cause (corrected from the closed #126, which had wrongly blamed a stray
  model `\n`): interactive references rendered as a `<button>`, an **atomic inline box that cannot break
  across lines** — when it didn't fit the remaining line width it jumped to the next line as a whole, and
  sat ~3.5px off the text baseline. References now render as **`<a href>`**: inline, breakable across
  lines (honoring `.inline-ref { box-decoration-break: clone }`), baseline-aligned, natively
  focusable/clickable/keyboard-activatable. The synthetic `#lin-node:<id>` href (always `#`-prefixed and
  `encodeURIComponent`-escaped) is intercepted (`preventDefault` + `stopPropagation`) and never
  navigated; both render sites (`AgentMarkdown`, `AgentInlineReferenceText`) updated and the scheme prefix
  centralized. Two coordinated CSS keys so anchors don't change the look: `.agent-markdown a` →
  `a:not(.inline-ref)` (the generic rose-link underline must not override inline-ref styling now that refs
  are anchors), and `.agent-message-inline-ref:not(button)` → `:not([href])` (interactive vs
  non-interactive now keys on `href`, both being non-`<button>`). `white-space: pre-wrap` is left
  untouched, so the model's genuine line breaks are preserved (no #126 tradeoff). Supersedes the closed
  #126. Gate: typecheck + `test:renderer` 347/0 + `agent-composer` e2e 34/34 (inline-ref click + cmd+click)
  + light/dark visual (`display:inline`, baseline delta 0px, rose color, no rest underline) + A3 confirmed
  (same-document hash, click intercepted, cmd/middle-click → window-open deny). ([#127](https://github.com/relixiaobo/lin-outliner/pull/127))

- **Agent: code blocks readable in dark mode (PR #125)** — agent (and outliner) code blocks were
  highlighted with a single `github-light` Shiki theme, so syntax tokens were near-invisible on the dark
  surface. Shiki now loads both `github-light` + `github-dark` and emits per-token `--shiki-light` /
  `--shiki-dark` CSS variables (`codeToHtml` with `defaultColor: false`), resolved via
  `@media (prefers-color-scheme: dark)` — pure CSS, no JS theme bridge (design-system **B2**). Also
  flattened `.agent-tool-code` (dropped the redundant border / background / overflow box) and corrected
  chevron-center alignment. App-wide: the outliner and agent code blocks share the same highlighter. Gate:
  typecheck + `test:renderer` 347/0 + outliner-code-block / agent-process e2e + light/dark visual (tokens
  adapt to github-dark, readable in both themes). A pre-existing `typography-tokens` guard failure on
  `shell.css:59` (`transition: background-color 0ms`) is unrelated to this PR. ([#125](https://github.com/relixiaobo/lin-outliner/pull/125))

- **Startup: no more per-launch macOS keychain password prompt** — the unsigned local build
  (`mac.identity: null`) can't present a stable code signature to the macOS Keychain, so Chromium's
  `os_crypt` (cookie / network-state encryption) re-prompted for the keychain password on *every*
  launch — independent of the app's own secret storage (that keychain use was already removed in #115).
  `main.ts` now sets `app.commandLine.appendSwitch('use-mock-keychain')` before `ready`, so `os_crypt`
  never touches the real Keychain. Trade-off: cookie/network-state encryption uses a static key instead
  of a keychain-derived one — acceptable for a local single-user app whose agent keys are already local
  `0600` JSON (the deliberate #115 posture). Revisit when a Developer ID-signed build ships. Fast-track,
  PM-ratified.

- **Outliner: Today navigation, same-day pane restore, and batch drag/drop (PR #123)** — a cluster of
  navigation and drag fixes found in local use. **Today** now resolves/creates the current *local-date*
  node before opening, instead of trusting a possibly-stale renderer `projection.todayId`, so crossing
  midnight with the app open no longer opens yesterday; all entry points (App / command palette / `go to
  today`) route through the same ensure-first helper. **Workspace-layout persistence** gained a local-day
  guard: saved panes restore only on the same calendar day, so a launch on a later day starts at Today
  rather than reopening a stale day's panes. **Drag/drop** now supports dragging a whole block selection
  of structural roots to one target (and dropping onto a trailing draft row to append), clears stale drop
  guide lines on invalid drop / drag end / nested-hover transitions (only the nearest hovered row owns the
  guide, including nested rows), and preserves block selection/focus through a drag. A block drag is now
  **one undoable operation**: a new atomic `batch_move_nodes` core command (validate-the-whole-batch on a
  clone, then apply in one `mutate`) replaces the per-row `move_node` loop, so a multi-row drag is a single
  undo step and a single projection delta — the dedicated command keeps the protocol surface
  (`commands.ts`/`types.ts`) the move's source of truth via the shared `BatchMoveNodeInput`. Finally,
  indent-guide clicks toggle direct-child expansion again — `OutlinerItem`'s memo no longer skips an
  expanded ancestor when only a descendant's expanded state changes. Gate: `/code-review` (re-review after
  the atomic fix) + typecheck + `test:core` 79/0 (incl. a batch-move atomicity/undo test) + `test:renderer`
  342/0 + new e2e (`outliner-drag-drop`, `outliner-trailing-expand`, navigation/workspace-layout specs);
  spec synced (`commands.md`, `ui-behavior.md`, `outliner-parity-matrix.md`).
  ([#123](https://github.com/relixiaobo/lin-outliner/pull/123))

- **Agent secrets: removed the keychain prompt; secrets now stored as local 0600 JSON (PR #115)** —
  Electron `safeStorage`/macOS Keychain backing triggered a macOS password prompt during
  startup/settings reads, a poor first-run experience. Agent provider credentials (API keys / OAuth
  tokens) are now persisted as plaintext `agent-secrets.json` under `userData` with `chmod 0600` on
  the file and `0700` on its parent dir — a deliberate trade of some at-rest security for UX,
  accepted pre-broad-ship (PM-ratified). The atomic temp file is created `0600` from the start (not
  only chmod'd after the rename) so the secret is never even briefly world-readable and a crash
  mid-write can't leave a `0644` file behind; the post-rename chmod stays as a belt-and-suspenders
  guard. Old encrypted `{enc:…}` files read as empty, so a stored api-key row with no `baseUrl` is
  pruned at first launch and the user re-enters the key once. Secrets stay out of the document,
  renderer state, IPC payloads, tool results, and logs. POSIX-only; Windows ACL hardening tracked as
  a follow-up. Gate: security review (one finding fixed, two accepted/scoped) + `typecheck` +
  `test:core` (`agentProviderCredentials`/`agentProviderReconcile` 16/16).
  ([#115](https://github.com/relixiaobo/lin-outliner/pull/115))

- **Agent composer: multi-line paste keeps every line (PR #112)** — pasting multi-line text into
  the agent composer dropped everything after the first line: the composer's ProseMirror schema is
  a single paragraph and its paste handler only intercepted files, so a multi-line `text/plain`
  paste fell through to a default that can't add paragraph breaks. The paste handler now reads
  `text/plain`, normalizes newlines, and inserts each line as inline text separated by `hardBreak`
  nodes (the shape Shift+Enter already produces). Extracted a shared `linesToInlineNodes` helper so
  paste and `editorStateFromText` map text→nodes identically (also fixes a CRLF-normalization drift
  where only the paste path stripped `\r\n`). Renderer-only; gate: medium review (one cleanup, C10,
  applied) + `typecheck` + `agent-composer.spec.ts` 34/34.
  ([#112](https://github.com/relixiaobo/lin-outliner/pull/112))

- **Agent collapse: corner chrome backing no longer flashes a dark square over the rail (PR #114)** —
  collapsing the agent dock briefly painted the opaque corner chrome zone (`--bg-content`) while
  the agent rail was still sliding/fading out, so in dark mode the darker `#1e1e1e` rectangular
  backing cut across the lighter `#2e2e30` rounded rail corner for ~100ms (white-on-white in light,
  so the artifact was dark-mode-only). The collapsed zone's `background-color` now waits a
  `--chrome-zone-backing-delay` (split out of `--motion-layout` as `--motion-layout-duration`,
  160ms) before painting, so the rail finishes sliding away first; a `prefers-reduced-motion`
  override drops the delay to 0. Symmetric delay applied to the sidebar corner zone. Verified with
  a per-frame headless probe (dark): 16 "square over visible rail" frames on `main` → 0 on the fix
  (backing paints ~24ms after the rail clears). Gate: `/code-review` (medium) + dark/light visual;
  test-timing race and reduced-motion coverage hardened pre-merge. Spec updated in the same PR
  (`design-system.md` Motion; A6). ([#114](https://github.com/relixiaobo/lin-outliner/pull/114))

- **Launcher capture: escape the browser app name in the front-tab AppleScript (PR #103 follow-up)** —
  `activeTabScript` interpolated the active app's name into `tell application "…"`. It was safe in
  practice (the name is always an allow-listed browser, gated by `detectBrowserFamily`), but it was
  defense-by-allow-list rather than defense-by-escaping. The app name is now escaped for the
  AppleScript string literal (`\` and `"`), so a future caller that widens the input cannot break
  out of the literal and inject script. A `/code-review` security-gate nit on #103, hardened
  pre-emptively; no behavior change for allow-listed names.

- **OAuth sheet: Done is the primary action once connected** — in the provider OAuth
  sheet the strong-neutral primary button sat on **Re-authenticate** even after a
  successful sign-in (Connected / Active), so the loud default action read as "you must
  sign in again" when the natural next step is to finish. The connected footer now puts
  the primary on **Done** (rightmost, macOS default-button position) and steps
  Re-authenticate back to the bordered secondary; the disconnected footer is unchanged
  (Cancel secondary, Sign in primary). Exactly one primary per footer is preserved (B4).
  Renderer-only (`ProviderOAuthForm.tsx`); surfaced after #101 strengthened the primary
  fill. ([#104](https://github.com/relixiaobo/lin-outliner/pull/104))

- **Provider rows are deliberate; junk rows reconciled safely on load (PR #100)** —
  Part A of `provider-config-cleanup.md`. Fixes the "shows *Add key* yet offers *Remove
  provider*" contradiction, where the main Settings Save unconditionally minted a keyless
  provider row (for whatever provider the draft defaulted to) and `upsertProviderConfig`
  then auto-activated it. Now row creation lives in **one** place — the per-provider config
  window and OAuth login, each storing the credential *before* the row — and the main pane's
  Save persists only runtime settings; an upsert never auto-activates. A one-time **startup**
  reconcile (`reconcileProviderConfig`, `main.ts`) prunes the literal bug shape (a keyless
  api-key catalog row with no stored credential and no `baseUrl`) and repoints a dangling
  active pointer. Crucially the reconcile is **off the read path** (`getProviderSettings` is a
  pure read again) and honors two hard safety rules so a transient/ambient signal can never
  cause permanent loss: it does nothing when the secrets file is unreadable (keychain locked /
  key rotated — the `SecretsUnreadableError` invariant), and it judges rows only by durable
  signals (stored secret-file credential, `baseUrl`, provider kind), never ambient env, with
  managed (Bedrock/Vertex) and oauth kinds exempt. `ProviderConfigForm.canSave` now requires a
  real connection so a keyless no-op row can't be created from the UI. These three gate findings
  (🔴 keychain-lock mass-prune, 🟠 managed/env prune on a shell-less launch, 🟡 composer
  `provider not found`) were fixed before merge. New `agentProviderReconcile` tests (8, incl.
  unreadable-secrets + managed-exempt); spec updated (`agent-pi-mono-implementation.md`, A6).
  ([#100](https://github.com/relixiaobo/lin-outliner/pull/100))

- **Agent composer can @-mention the focused context node (PR #91)** — in the agent
  composer, `@` returned "No mentions" even when a matching node existed, and node search
  died entirely when nothing was focused. The composer reused the outliner's node-candidate
  logic, which excludes `currentNodeId` (a node can't reference itself) and returns `[]` when
  there is no current node — but the composer is not a node, and its `currentNodeId` resolves
  to the *focused/context* node, so that very node was filtered out. `buildReferenceCandidates`/
  `referenceItems`/`nodeCandidates` gain an `excludeCurrentNode?: boolean` (default `true`, so
  the outliner is byte-for-byte unchanged) and `currentNodeId` is widened to `NodeId | null`
  end-to-end; the composer passes `excludeCurrentNode: false` and drops its two `!currentNodeId`
  early returns. Renderer-only; no protocol/core surface; new guard test in
  `rowInteractions.test.ts`. ([#91](https://github.com/relixiaobo/lin-outliner/pull/91))

- **OpenAI provider error handling: schema 400 + inline failed-message render (PR #90)** —
  two fixes for a user-reported OpenAI 400. (1) `node_search`/`node_create`/`node_delete`/
  `node_edit` declared a top-level `oneOf`, which OpenAI's function-schema validation rejects
  (`schema must have type 'object' and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'not' at the
  top level`); the top-level `oneOf` is removed from the four node tool schemas
  (`agentNodeToolSchemas.ts`). The mutually-exclusive argument groups are still enforced at
  runtime (the `normalize*` helpers) and documented in the descriptions, and nested
  `anyOf`/`enum` in property subschemas is untouched, so Anthropic is unaffected. (2) A
  provider/run failure now renders **inline as a failed assistant turn with a retry action**
  instead of a red banner pinned to the top of the conversation: the runtime marks the
  terminal assistant message `assistant_message.failed` (error stop reason + `errorMessage`)
  on non-aborted, non-context-overflow failures, and the top-level projection `errorMessage`
  is reserved for transient operational errors (`agentRuntime.ts`). Spec updated (A6).
  ([#90](https://github.com/relixiaobo/lin-outliner/pull/90))

- **System-node protection: `isSystemId` now covers Library and Recents** —
  `isSystemId()` (`src/core/core.ts`) omitted `LIBRARY_ID` and `RECENTS_ID`, so
  the Library section and the Recents saved-search were not treated as the
  authoritative system nodes the other sections are. Library was protected only by
  its `locked` flag, leaving `removeSubtreeDirect` (whose sole guard is
  `isSystemId`) able to hard-delete it, and `isSearchCandidate` wrongly surfaced
  Library/Recents as search results (unlike Daily notes / Schema / Trash /
  Settings). Both ids are now in the list, so they get the same structural
  protection (no move / delete / reparent) and search-exclusion as every other
  seeded section. (Fast-track, direct merge to `main`, no PR.)

- **Security: agent exfiltration redline + skill-shell ask path hardened (PR #79)** —
  the sensitive-data exfiltration hard block now recognizes opaque sinks (inline
  interpreter execution `python -c` / `node -e` / `perl -e` / `ruby -e` / `php -r`
  / `osascript -e`, and `ssh host '<cmd>'`) in addition to network-write verbs, so
  `cat ~/.ssh/id_rsa | python3 -c '...'` is a `platform_hard_block` instead of a
  downgrade to `ask`; `id_dsa`/`id_ecdsa` added to the sensitive-command patterns.
  Separately, the skill-shell permission path now routes `ask` decisions through
  the shared `resolveAgentPermissionAsk` (safe-allowlist + classifier-eligibility
  veto + unattended fail-safe) instead of jumping straight to the approval handler.
  Both changes only tighten policy. Resolves hardening item #3.
  ([#79](https://github.com/relixiaobo/lin-outliner/pull/79))

- **Agent dock header icons (＋ / bug) no longer read as blurry (main)** — they used
  `--text-faint` (ink/0.30), too low-contrast for their thin SVG strokes to resolve as
  crisp edges on the dark rail, while the 0.55 title text beside them looked sharp. They
  now share the window-chrome rail toggles' ink (`--text-secondary`, 0.55) at rest →
  `--text-strong` on hover. Not a glass/vibrancy rendering bug — a contrast one; no
  material change. The composer header guard updated to match. (main)

- **Agent dock header action icons drop the hover fill box + sit on a uniform pitch
  (main)** — ＋/bug hover/focus now only deepen the glyph colour (no `--control-hover`
  rounded-square fill), matching the rail toggles' colour-only chrome idiom (B6; focus
  ring unchanged). The right chrome zone's trailing gap is now `--space-2` (was
  `--space-4`), sliding the buttons one step toward the corner-anchored agent toggle so
  ＋→bug and bug→toggle land on the same 30px icon pitch. (main)

- **Agent composer attachment errors auto-dismiss (main)** — the inline attachment error
  is now a transient hint (`role="status"`, cleared after 5s) instead of a persistent
  banner, so the composer never carries a stale error. (main)

- **Agent dock collapse no longer janks (main)** — the rail collapsed by
  animating `width`/`top`/`right`/`bottom` (layout properties), so the transcript
  and composer re-wrapped every frame. It now slides off the right window edge via
  `transform: translateX` + `opacity` like the sidebar — a rigid GPU-composited
  layer move with no panel reflow. Glass material is applied unconditionally so it
  persists through the collapse fade instead of popping. (main)

- **Toggling Thinking no longer flickers the dock or jumps the model menu (main)**
  — two issues: (1) every model/reasoning change called `reloadSession`, which set
  the projection to empty and published it before re-fetching, flashing the whole
  transcript blank for a frame; a same-session reload now keeps the current
  projection on screen and swaps it atomically. (2) The model menu's reasoning row
  unmounted the 28px level button when Thinking was off, collapsing the row and
  jumping the menu height; the row now reserves the level-button height. (main)

- **Composer overflow scrollbar hugs the panel edge (main)** — the editor's scroll
  viewport was nested inside the surface's padding, so its native scrollbar floated
  ~12px inside the panel with empty padding to its right. The editor now breaks out
  of the horizontal padding (re-insetting its text to `--agent-content-x`) so the
  scrollbar sits at the panel edge like the transcript scroll (B10). (main)

- **Agent model menu uses the canonical menu radius (main)** — the model popover
  and its thinking-level submenu used `--radius-lg` (12) / `--radius-md` (8); they
  now use `--radius-overlay-sm` (10) like every other menu (session, context,
  settings). (main)

- **Agent composer footer controls are capsules, not rounded squares (B6)** — the
  send, attach, and model-selector controls were carrying the composer's 2px
  concentric-inset radius, so the filled send button read as a tiny rounded square
  and the model button's hover fill clashed with it. They now use `--radius-pill`:
  the 28px square icon buttons render as circles, the wide model button as a
  stadium, so every footer control shows the same corner arc (= half its height)
  and they line up. Codifies the systematic rule that interactive icon/pill
  controls are fully-rounded capsules, off the concentric *surface* radius chain
  (design-system.md + the composer layout guard test updated to match). (main)
- **Code-block language picker redesign** — replaced the native `<select>` (which
  opened an OS-styled, uncoordinated dropdown) with the shared menu primitives: a
  compact trigger whose chevron sits next to the label, opening a portaled
  `MenuSurface` popover that matches the design system. Hover now deepens text /
  icon color instead of adding a background fill, for both the language trigger
  and the copy button. ([#27](https://github.com/relixiaobo/lin-outliner/pull/27))
- **Unknown code-block languages fall back to Plain text** — a pasted fence with
  a non-language info string (e.g. `tool` / `tool-error` from an agent
  transcript) no longer shows a bogus language in the picker. A Shiki-backed
  `isKnownCodeLanguage` check coerces any language Shiki cannot highlight to
  Plain text for the label, selected value, and highlighting, while preserving
  real grammars outside the picker list (e.g. `kotlin`). The code block's
  language picker now uses the `SelectControl` primitive and `--control-size-*`
  tokens. ([#26](https://github.com/relixiaobo/lin-outliner/pull/26))
- **Pasting into the trailing draft row** — pasting structured content into the
  blank line at the bottom of the outline threw `CoreError: node not found`,
  because the eager draft row has no core node until its first character
  materializes it. The paste path now appends the pasted trees under the parent
  (via `create_nodes_from_tree`) for a pristine draft, and waits for an in-flight
  materialize otherwise. ([#25](https://github.com/relixiaobo/lin-outliner/pull/25))
- **Pasting fenced code blocks with multi-word info strings** — the paste
  parser only recognized a fence whose info string was a single token, so a
  CommonMark-valid fence like ` ```tool node_create ` leaked as plain text and
  desynced every later open/close pairing (prose swallowed into empty "Plain
  text" code blocks, real code split into one row per line). Any info string is
  now accepted, with its first token used as the language.
  ([#24](https://github.com/relixiaobo/lin-outliner/pull/24))

### Internal

- **How this section was assembled** — everything under `[0.1.0]` shipped to
  `main` before the first tag and had been accumulating under `[Unreleased]`
  across 21 duplicate category sections, which made "what changed in this
  release" unanswerable; the sections were merged by category,
  multiset-verified, no entry edited.

- **Publish releases from the changelog (PR #480, main-agent)** — pushing a `v*`
  tag builds the unsigned Apple-silicon `.dmg` and creates the GitHub Release
  with that version's `CHANGELOG.md` section as its body (`scripts/release-notes.ts`
  exits non-zero when the section is missing or empty; a body over GitHub's
  125k-character limit degrades to a counted summary linking the changelog at the
  tag). The 21 duplicate category sections that had accumulated under
  `[Unreleased]` are folded into this `[0.1.0]` section — merged by category,
  multiset-verified, no entry edited. A `workflow_dispatch` input rehearses the
  build without publishing. The rehearsal caught electron-builder's
  implicit CI publish demanding a token after the `.dmg` was already built;
  `build.publish: null` pins publishing to the workflow's `gh release create`.

- **Document-system overhaul (main-agent, direct on `main`, fast-track)** — the
  board (`docs/TASKS.md`) drops from ~6300 lines to ~700 so agents can actually
  load it at plan time: completion records become one-liners pointing at the
  CHANGELOG and PRs, the hand-maintained agent-status table is retired in favor
  of `gh pr list`, and carry-forward engineering lessons move to the new
  `docs/lessons.md`. `docs/plans/` gains a `reference/` tier for standing
  authorities (`agent-program`, data/conversation/memory contracts,
  `nodex-parity-decisions`, record-only decisions); `ui-quality-roadmap` is
  archived (its layers all shipped) and `macos-liquid-glass-icon` shelved by PM
  decision. `docs:check` grows real-reference orphan matching scoped to
  `origin/main` (the substring rule had greenlit three never-boarded plans and
  contradicted the dev-agents-never-edit-the-board flow), file-relative board
  link checking that matches how GitHub renders, and C4 link integrity for
  `README.md`/`AGENTS.md` (both had dangling references).


- **Unified command surface contract refinement (PR #491, codex, plan-only)** —
  makes the plan's noun/verb boundary structural: result rows, chips, and parameter
  candidates are objects, while the active subject resolves separately typed action
  variants. Subject results and object-valued arguments now use distinct main-owned
  admission generations, with each argument generation scoped to its exact action,
  subject, and parameter slot so a renderer cannot substitute a same-identity ref
  from another membership domain. The launcher now opens before ambient context
  resolves; a main-owned transition bound to the current `openSeq` and monotonic
  revision installs late context without clearing input/results or stealing an
  explicit selection. Three review passes closed seven lifecycle and admission
  findings before merge at final head `7fe07d70`. This changes the design contract
  only; product behaviour is unchanged and both implementation PRs remain unclaimed.

- **The unified command surface now starts from one action registry (PR #485, cc,
  plan-only)** — replaces the former `Target × Verb`, habit-learning, and
  reversibility-tier design with two independently complete implementation PRs
  split where the compiler and a differential test can judge the contract. PR 1
  moves the full node context menu onto compiling core invocation/evaluation/
  presentation/request/effect contracts, preserves its behaviour against the old
  path as an oracle, and fixes the *Move to* picker that currently limits unranked
  document-order matches. PR 2 renders the registry as the searchable command
  surface, adds capture and agent handoff, and retires the old global `Cmd+K`
  palette. Main owns action admission, confirmation/execution phases, replay and
  delivery outcomes; renderers may name an action but cannot author its effects.
  Capture lands in Today, there is no browser extension or screenshot tier, and a
  future rich-page reader is an explicit post-choice main API rather than a network
  implementation on the ambient hotkey path. Fifteen review rounds closed the
  cross-renderer lifecycle, confirmation, result-delivery, retrieval-order, and
  runtime-binding contradictions before implementation; both feature PRs remain
  unclaimed. The source edits in this plan are comment-only and do not change
  behaviour.

- **Generated images as durable Thread resources plan (PR #489, cc-2, plan-only)**
  — boards the tool-agnostic artifact work `agent-browser-control` left behind
  when it closed as `superseded`, with generated images as the first complete
  consumer. `generate_image` writes bytes into the agent scratch root and returns
  a path relative to a root the model is never told about, which produces three
  defects from one cause: the model **never sees its own output** (the tool
  passes no tool-result `extraContent`, so no image content item is ever created
  — and `toolImagePath`'s `generate_image` branch, which only runs inside the
  branch that image would have triggered, is therefore unreachable dead code);
  the model **cannot act on that output**, because `file_write` is text-only
  while `file_read` and `bash` resolve relative paths against the workdir, so
  "generate an image and put it in Downloads" fails — and worse, sometimes
  half-works by stumbling into `../agent-scratch/…` until `LIN_AGENT_LOCAL_ROOT`
  moves the workdir; and history holds a durable reference into a directory the
  code itself declares ephemeral, which is why `pruneAgentScratch` carries a
  `generated-images` exemption. The plan has the producer persist → resolve a
  turn-scoped observation path → emit the bytes as `extraContent`, exactly as
  `file_read` does, with the executor's second write a content-addressed no-op.
  Dependency tracking already flows through `contentItems`, so **no
  `protocol.ts` / `codec.ts` change**; `markdownImage` is retired rather than
  re-schemed, keeping `referenceMarkup.ts` out entirely. Its one piece of real
  plumbing moves all five image gates — count, per-image 10 MB, per-call 20 MB,
  mime shape, thread quota — behind a single call-scoped admission call both
  sides consult, so an image cannot be admitted producer-side, published to the
  model, and then dropped executor-side into an orphaned resource with a dead
  path. Caps degrade (persist what fits, report the rest) rather than fail
  closed. Four gate rounds, every claim traced to the call that actually runs:
  the first version routed through a `resourceRefs` field tool items do not
  have, and the gate's own counter — that the bytes were already persisted —
  was equally wrong, because the executor branch holding that write never fires
  for this tool. Success signal at implementation: the `pruneAgentScratch`
  special case disappears. Lands after PR #483.

- **Canonical tool-call history plan (PR #482, codex-3, plan-only)** — boards the
  fix for a defect that made the agent teach itself to fail. Tool history is
  currently reverse-engineered from the presentation Item rather than recorded:
  `ContextProjector.historyToolArguments()` turns a `commandExecution` into
  `{ command, cwd }`, inventing a `cwd` the strict `bash` schema rejects and
  dropping the valid `description`, and turns a `fileChange` into a fabricated
  `{ changes }` no file schema accepts. Because `tool_execution_start` fires
  before `prepareToolCall` validates, and `startedToolItem` lets a raw
  `input.cwd` outrank the Thread's own working directory, the model's rejected
  argument was persisted as the audit record and replayed to it as a worked
  example — one packaged-task run spent 64 pre-execution rejections and ~$2.17
  going around that loop. The plan makes the admitted call the sole authority:
  an immutable `modelCall` envelope per tool Item with three dispositions
  (`replayable` / `redactedReplay` / `evidenceOnly`), a kernel admission event
  ahead of execution-start, validation against the live registry before every
  submission, and pair-level preflight that degrades to typed evidence instead
  of throwing on the user path. Secret-bearing arguments replay redacted behind
  an atomic marker, which closes an existing leak — commands are persisted with
  bounding only today — without the model concluding that a command it actually
  ran never happened. Gate review ran three rounds: the causal chain, the
  `cwd` precedence, a projector that degraded arguments while still throwing on
  result payloads, and a compaction rule that could strip a redaction marker off
  the call it qualified. Implementation ships as one complete PR.

- **Collaboration tool handlers live in their own domain (PR #456, codex-2)** —
  `ToolRuntime` carried the implementation of the collaboration tools as well as
  the dispatch for every tool; the handlers moved verbatim into
  `thread/SubagentCollaboration.ts` through the extension contribution seam,
  leaving `ToolRuntime` as dispatch and assembly only (572 → 488 lines) and
  retiring the subagent-budget plan's spawn-handler carve-out. A catalog
  byte-stability judge landed before the move rather than after, so the tool
  catalog is provably byte-unchanged across it and every future contribution
  migration is guarded the same way.
  *(Recorded 2026-08-03: this shipped 2026-07-30 with no changelog entry, found
  by auditing merged pull requests against this file.)*

- **The repository has CI (PR #477 + direct commits, main-agent)** — `main` had no automated test signal at
  all, so a red baseline was only ever discovered when a PR gate happened to run
  the full e2e suite; that had happened three rounds running, each time costing
  the gating PR the work of proving the failures were not its own. Every push to
  `main` now runs five independent whole-suite Playwright samples in parallel and
  publishes a frequency table to one tracking issue. Five, because a single run
  cannot tell a red baseline from a flake — a test was called deterministic here
  on four consecutive failures and then passed twice. Whole-suite samples rather
  than sharding or repeating individual tests, because the failures worth catching
  only appear in a full run. It does not gate pull requests, and retries stay at
  zero: making an unstable suite report green would hide the thing being measured.
  It runs on macOS, because the suite encodes the platform the product ships on —
  the first version ran on Linux, where a different keyboard modifier and font
  stack produced ten stable failures that pass on macOS, which is the kind of
  false red people learn to ignore. A pull request gets the same five samples on
  the same runner image and a comment subtracting `main`'s numbers from its own,
  because headless CI turned out to disagree with a developer's machine too —
  attribution needs both measurements taken in one environment, not two
  environments made to agree. Also fixed `trace: 'on-first-retry'` sitting
  alongside an unset `retries`, which meant Playwright traces had never once been
  captured.

- **The built-in import Skill is named for what it is (PR #474, codex)** — the
  Skill was called `data-cleanup`, after a category, while everything it
  actually exposes — the wrapper on `PATH`, the CLI, the packaged resource
  directory — was already `tenon-import`. It is `tenon-import` throughout now.
  The packaged wrapper's executable bit is no longer set from a path written
  out by hand in the packaging hook: one shared constant feeds both the runtime
  and the hook, and a wrong path now fails the build loudly instead of skipping
  the `chmod` in silence — the mode of failure that would otherwise ship an app
  where the import CLI is present but cannot run.
- **A core test no longer goes red because the machine is busy (PR #473,
  codex-2)** — the deep shared-state export test builds a chain past the
  snapshot-depth threshold, which costs about a second and a half on an idle
  machine and eight times that when the CPU is contended. It inherited the
  default five-second budget, so `test:core` failed for anyone running it
  alongside other work. It now carries its own budget, chosen from measured
  timings and written down next to it, and builds only as deep as the threshold
  it is testing actually requires.
- **The e2e suite is a clean gate signal again (PR #464, codex)** — the two
  deterministic B5 guard failures that had been red on `main` since
  `51d7cab8` were one real omission, not two: the "Jump to latest" pill paints
  `--material-popover` with a backdrop filter but was never registered as a
  chrome/overlay surface. It is registered now, by exact selector and with a
  comment stating why it qualifies — transient level-1 navigation chrome
  floating above the transcript viewport, which is what the Thread rendering
  spec already calls it — rather than stripping glass off a surface the design
  intends to have it; the guard's parsing and matching are unchanged. The
  third spec filed as red, the `/attachment` file-name row, no longer
  reproduces anywhere and was deliberately left alone instead of being
  "fixed" by invention.

- **Browser Control plan refresh (PR #459, codex-3, plan-only)** — the
  `agent-browser-control` plan now matches the shipped runtime
  (#444/#445/#451/#456) and the PM's pre-implementation rulings: prepared
  execution rides the kernel runner port via a four-operation
  `ToolExecutionContract`, capability intent and the allow/deny decision
  travel in a durable start-event envelope, `ToolExecutionAdapter` supersedes
  `ToolRuntime.instrumentTool` as the lifecycle/hook owner, and a new
  non-user-configurable `decide(effect)` safety floor (host `ToolSafetyEffect`
  vocabulary with `filesystem.write` first, plus fail-closed admission of
  unrecognized output flags) backs worst-case containment for unclassified
  commands. Gate review confirmed 7 findings; all addressed same-day.

- **E2E guard debt paid down (main)** — cleared every deterministic guard
  failure that had accumulated on `main` from merges whose gates ran unit
  tests only: named the automation-settings and time-picker focus-ring
  transfers plus the read-only `ProviderParameterList` tooltip component in
  the cursor-affordances exception maps, tokenized the automation unread-dot
  margin (`--space-3`), registered `canvas.css`'s pane-drag reduced-motion
  rule, and rewrote the composer attachment-error probe around the Office
  ownership-file rejection (the 10 MB limit it relied on was removed by
  bounded large-file observations). Full e2e suite is deterministically
  green; remaining one-off failures are parallel-load flakiness only.

- **Agent thread UX plans (PR #454, cc-2, plan-only)** — three gate-reviewed
  plans landed: `agent-subagent-interaction` (status truth for delegated work,
  children leave the Thread list, live delegation card, cascading user Stop —
  the task-contract Layer 1 opening), `agent-run-presentation-consistency`
  (truthful tool-row/process states, plan-progress pill), and
  `agent-thread-scroll-follow` (send anchoring + visible follow state). Gate
  review contributed three corrections (bright-line-as-admission-invariant
  ruling, collision refresh, #160 panel lineage citation); board entries carry
  status.

- **ThreadService decomposition (PR #451, codex-2)** — the 4,502-line god
  object split into four owned modules over one shared coordination core:
  `ThreadCore` (single `KeyedMutex` by construction, notification bus, stores,
  canonical reads), `TurnLifecycle` (admission→acceptance→execution→steering),
  `SubagentCollaboration` (spawn/mailbox/wait/activities),
  `ThreadCatalogOps` (start/fork/rollback/archive/naming),
  `ThreadResourceOps` (attachments/resources/pruning), behind a byte-compatible
  850-line facade. Zero behavior change, proven mechanically: facade API frozen
  (64/64 public methods), test suites entirely untouched (1554 core / 793
  renderer, 0 fail), five-file line budget within +5% with 2 lines to spare,
  `src/core/` and `runtime/` diff-empty, four per-stage commits, real-run
  smoke. Zero review findings. **Gate (main):** six mechanical tripwires run
  independently on both the original and post-#450 rebase baselines.

- **Subagent token budgets, PR B: mid-Turn enforcement (PR #450, codex)** —
  the kernel now consults a live budget view before every model call on
  budgeted, non-user Turns (ThreadService supplies the committed ledger base;
  the executor composes the normalizer's in-flight usage; user-triggered Turns
  are never offered the port — the bright line holds mid-Turn). First crossing
  of 80% delivers one canonical steering notice with actual figures
  ("synthesize and conclude"), advisory under A12 (delivery failure logs and
  continues). Exhaustion before outstanding model work settles the Turn
  interrupted with ledger-total-of-budget figures; a terminal answer under
  racing steering settles completed (overshoot accrues per PR A), undrained
  steering is never falsely consumed, and the event cadence stays balanced.
  Golden parity fixtures untouched (non-budgeted runs byte-identical).
  **Gate (main):** high-effort review (7 verified defects, all fixed
  same-day), plan tripwires, typecheck, 1554 core / 793 renderer tests.

- **Subagent token budgets, PR A (PR #446, codex)** — spawn-time token budgets
  as a host-owned circuit breaker (PM-ratified sizing policy: breaker not
  allocation). Optional `max_total_tokens` on `spawn_agent`; global default
  1,500,000 tokens ON by default (`subagentTokenBudget` runtime setting, null
  disables); children of budgeted spawners default to min(default, spawner
  remaining) and exhausted senders cannot spawn. Budgets live in a host-owned
  `thread_budgets` ledger (`persistence/SubagentBudgetLedger.ts`, shared
  goals.sqlite connection) — deliberately NOT a ThreadGoal, so no
  auto-continuation enrollment, no Goal-slot collision, and the child cannot
  lift its breaker. Exhausted children refuse non-user Turn admission with a
  typed `SubagentBudgetExhaustedError` (goal continuation defers with the real
  reason; automations fail with the accurate message; parents read it verbatim
  from collaboration tools); steering an in-flight Turn is never gated; usage
  accrues inside the completion mutex including failure paths; the mailbox is
  snapshot-atomic across admission; `wait_agent`/`list_agents` report
  `tokensUsed`/`tokenBudget`; user-triggered Turns are never gated. **Gate
  (main):** three passes — two high-effort multi-agent reviews (18 verified
  findings, all fixed; the first round overturned the plan's own Goal-reuse
  design), tripwires, typecheck, 1544 core / 781 renderer tests, live
  dev-userData verification incl. idle-child no-restart and bright-line
  scenarios.

- **pi-ai import containment (PR #447, codex-2, fast-track)** — routed all
  `pi-ai` type imports in the context/policy layers through the two sanctioned
  chokepoints (`kernel/types` for the type vocabulary; `piModels` for the few
  runtime functions non-transport files need, e.g.
  `getSupportedThinkingLevels`). Import-lines-only diff across 12 files; the
  `pi-ai` importer list now equals the transport allowlist exactly, so a future
  transport swap touches only gateway/transport files. **Gate (main):**
  mechanical diff-shape check, completion-criterion command, typecheck,
  1528 core / 781 renderer tests.

- **Native turn kernel (PR #445, codex-2)** — replaced `@earendil-works/pi-agent-core`
  (dependency deleted) with a Tenon-owned turn kernel under
  `src/main/agent/runtime/kernel/`: a pure loop over four ports (`ModelGateway`
  transport port in front of `pi-ai`, `retryPolicy` as the sole owner of retry
  and overflow-recovery attempt hiding, `NativeAgentRuntime` behind the existing
  `PiAgentRuntime` seam, Tenon-owned kernel types incl. the re-exported
  transport vocabulary). Behavior is bug-for-bug pi parity per the plan's
  22-rule behavioral contract: identical normalized Item streams (golden
  fixture + four deliberate judge mutations), steering drain points, sequential
  batch downgrade, truncated-tool-call rejection, provider failures as data
  with full terminal messages, completed-tool-call salvage, overflow-failure
  prefixes, and internal-memory raw-transcript turns. The `maxRetries: 0`
  suppression hack and the 500-line `agentStreamAbort` wrapper are gone
  (absorbed as `kernel/retryPolicy.ts`, rename-tracked, assertions unchanged);
  error classification is typed and status-first with a dedicated regression
  test. **Gate (main):** plan tripwires, typecheck, 1528 core / 781 renderer
  tests, high-effort multi-agent review (10 verified findings — one retry
  classification-order regression plus nine cleanups — all fixed same-day),
  real-run smoke against cc-switch (mixed sequential/parallel tool batch,
  mid-stream steering, diagnostics parity).

- **Agent context runtime completion + Model Interactions (PR #444, codex-3)** —
  completed and closed the `agent-context-integrity` plan (PR 3 of 3): deterministic
  per-request context budgeting with indivisible tool exchanges; automatic
  preflight, provider-overflow, and manual compaction plus durable `/clear`
  epochs; recursive Skill/Role/view/observation checkpoint restoration across
  restart, compaction, fork, and inheritance; exact Subagent parent boundaries
  with dependency-complete child-owned copies; Turn-stable provider
  timeout/retry/cache policy; typed, versioned, Thread-owned Turn diagnostics
  (pre-adapter Model Context, post-adapter Provider Request, typed runtime
  activities) behind a rebuilt disclosure-only Model Interactions inspector.
  Includes two review-fix rounds (10 verified findings from the high-effort
  multi-agent gate review — among them inherited-context compaction loss, an
  unserialized prune race, stacked provider retries, and a custom-endpoint
  prompt-cache regression) and the live-incident fixes (pending subagent
  activities no longer poison the next user turn; 429 is retried; prompt cache
  verified live against cc-switch), plus subagent orchestration contracts:
  `wait_agent` is terminal-state-driven with batched terminal outcomes carrying
  child results, isolated Skills advertise their capability contract in the
  catalog and return `outcome`-tagged results with explicit
  synthesize-don't-repeat guidance, and Skill children use the `agent.skill`
  source. **Gate (main):** high-effort multi-agent review + live forensic
  report (PR comments), typecheck, 1521 core / 781 renderer tests, docs:check,
  real cc-switch runs with cache-hit evidence.

- **Unified Agent context composer (PR #441, codex-3)** — replaced parallel
  provider-message builders with one stable L0/L1/L2 composer, canonical replay,
  and atomic evidence admission for environment, bounded user view, resources,
  attachments/images, additional context, and user input. Added Skill catalog
  and invocation integrity across same-Turn refresh, restart, and publication
  retry while preserving provider bytes for cache reuse. This is a clean
  pre-release replacement with no migration, compatibility reader, fallback, or
  dual write. PRs 1–2 of the active six-PR `agent-context-integrity` plan are now
  shipped; global budgeting and compaction is next. **Gate (main):** iterative
  review caught missing expanded reference-target children and child counts in
  the user view, namespaced extension tools being misclassified as Core L1
  capabilities, and expanded table records duplicating visible column field
  entries. All were fixed before merge. Final head `35be64c8` had no reportable
  findings; merged-main verification covered typecheck, full `test:core` (1438
  pass, 6 environment-dependent skips), full `test:renderer` (775 pass), docs,
  and diff checks.
- **Browser Control 0.5 implementation plan (PR #443, codex)** — pinned the
  active design to Browser Pilot 0.5 and specified one complete feature PR built
  foundation-first: prepared tool execution, independent durable projections,
  deterministic CLI-and-Skill distribution, direct command routing, Thread
  identity, Turn files, conservative Browser capabilities, transient stdin,
  lifecycle cleanup, and per-Turn Skill availability. No product code shipped.
  **Gate (main):** ultra review closed the external-message block bypass,
  missing non-shell stdin transport, and restricted-Thread Skill visibility
  findings. Final head `830aaa12` had no reportable findings; `docs:check` and
  diff check passed against that exact head.
- **Browser Control and URL Preview planning boundaries (PR #442, codex)** —
  replaced the former Tenon-native browser-tool direction with a pinned Browser
  Pilot CLI-and-skill consumer contract through the classified `bash` path,
  including Thread client isolation, Turn scratch output, conservative external
  action and sensitive-read capabilities, and redacted durable command/result
  projections. Future URL Preview rich capture is now an independent explicit
  read-only internal-Preview feature; launcher providers retain classification
  ownership only. **Gate (main):** four review rounds closed seven architecture,
  persistence, permission, and failure-semantics findings. Final head `0fa8be0c`
  had no reportable findings; verification covered typecheck, docs, and diff
  checks.
- **Canonical Agent context evidence contract (PR #440, codex-3)** — added the
  shared interface for strict context evidence, reset, and compaction Items;
  exact cursors and payload references; verified quota-bound Thread payload
  storage; typed resource dependencies; and restart, rollback, and fork
  reconciliation. Managed tool images retain preview and Add-to-outline support
  without exposing canonical or scratch paths. This is PR 1 of the active
  six-PR `agent-context-integrity` plan; composer, Skill, context-budget,
  Subagent-inheritance, and provider/cache consumers remain follow-up units.
  **Gate (main):** iterative review caught payload kind confusion, persisted
  scratch observation paths, an attachment-sized allocation ceiling, cleanup
  errors misreporting durable rollback, source-owned inherited images, and the
  managed-image ingest regression; all were fixed before merge. Final head
  `b810a00a` had no reportable findings; verification covered typecheck, full
  `test:core` (1402 pass, 6 environment-dependent skips), full `test:renderer`
  (767 pass), focused ownership/ingest tests (57 pass), Agent Thread E2E (43
  pass), docs, and diff checks.
- **Office ingestion and ordered inline attachments (PR #439, codex-3)** —
  rejects Office ownership files before attachment or reading, adds a bounded
  in-process PPTX structural-text reader with Strict OOXML support, and renders
  files and image galleries at their canonical message positions without
  losing filename markers. **Gate (main):** iterative review caught incomplete
  PPTX package identity and exact relationship-type validation, split-text
  editing that could destroy attachment order, and galleries that omitted
  canonical image markers; all were fixed before merge. Final head `996f096a`
  had no reportable findings; verification covered typecheck, full `test:core`
  (1389 pass, 6 environment-dependent skips), full `test:renderer` (765 pass),
  focused Core/renderer tests (15 pass), relevant Agent E2E (3 pass), docs, and
  diff checks.
- **Unified Agent execution interactions (PR #438, codex-4)** — made Plan
  updates transient Turn-local progress, navigates Run Details in the current
  workspace pane with Back history, and gives ordinary tools and Skills one
  expandable argument/result disclosure with clickable local paths. **Gate
  (main):** review caught non-outliner root navigation replacing the wrong pane
  and an incomplete keyboard/scroll contract for long Plan checklists; both
  were fixed before the final rebase over #437. Final head `0f95e430` had no
  reportable findings; verification covered typecheck, full `test:core` (1373
  pass, 6 environment-dependent skips), full `test:renderer` (764 pass),
  relevant E2E (166 pass, with two unchanged guard failures reproduced on
  pre-merge `main`), docs and diff checks, and light/dark visual verification.
- **Large local resources (PR #437, codex-3)** — replaced the shared attachment
  source-size ceiling with reference-based path-backed and managed resources,
  chunked pathless uploads, bounded file and image observations, immutable image
  prompt snapshots, exact attachment authorization, and independent managed
  payload copies for Thread forks. **Gate (main):** review caught cleanup keys
  coupled to mutable metadata, fork copies sharing writable inodes, and model or
  Preview / Open / Reveal paths exposing canonical managed payloads; all three
  were fixed before merge. Final head `964fe3b2` had no reportable findings;
  verification across the final two heads covered typecheck, full `test:core`
  (1372 pass, 6 environment-dependent skips), focused Core tests (91 pass),
  full `test:renderer` (758 pass), Agent Thread E2E (40 pass), docs and diff
  checks, and light/dark visual verification.
- **Memory retrieval and inline Node citations (PR #436, codex-3)** — replaced
  eager Memory briefing injection with relevance-driven `node_search` /
  `node_read` routing and records usage only when a successfully read Memory Node
  is cited through the rendered inline Node-reference affordance. Thread history
  keeps the canonical tool process visible without a separate Memory disclosure.
  **Gate (main):** iterative review caught Markdown literals being attributed as
  citations, display/accounting parser drift for escapes and entities, and
  reference-style links losing definitions across renderer blocks; all were
  fixed before merge. Final head `3495305` passed the merged-main verification
  listed with PR #435 below.
- **Codex Automations (PR #435, codex-3)** — added host-owned durable scheduled
  Agent work with strict protocol and IPC boundaries, SQLite-backed RRULE/IANA
  scheduling, catch-up and overlap handling, canonical Thread/Turn execution,
  crash recovery, local-project and managed-worktree modes, structured schedule
  editing, unread Run state, and a complete light/dark Automation surface.
  **Gate (main):** iterative review caught cleanup paths that could discard
  ignored or embedded-repository content, stale worktree snapshots, the bounded
  renderer page leaking into bulk-read behavior, and stale/same-millisecond Run
  notification races; all were fixed before merge, including a durable monotonic
  Run event sequence. Final head `321f65c` passed merged-main typecheck, full
  `test:core` (1342 pass, 6 environment-dependent skips), full `test:renderer`
  (758 pass), focused Automation + Agent Thread E2E (40 pass), docs check, and
  diff check.
- **Codex Memory on daily timeline Nodes (PR #434, codex-3)** — added durable
  Codex-style Memory as ordinary editable Daily Notes Nodes under deterministic
  protected `#d-memory`, `#d-episode`, `#d-belief`, `#d-question`, and
  `#d-guidance` tags. The feature includes immutable Memory admission snapshots,
  private control/provenance storage, Phase 1 extraction, Phase 2 consolidation,
  generated-node lineage, rollback invalidation, confirmed Reset, derived
  briefings, citations, settings, Open Memory, and fail-closed foreground
  mutation/history authorization. **Gate (main):** four review rounds caught
  publication, visibility, rollback, Reset, and history-authorization bugs,
  including reserved tag-name redo and branched multi-step undo bypasses; all
  were fixed before merge. Final head `cc8220f` passed typecheck, full
  `test:core` (1299 pass, 6 environment-dependent skips), full `test:renderer`
  (741 pass), docs check, diff check, and focused old-bypass repros.
- **Canonical Thread Agent Core replacement (PR #429, codex-3)** — replaced the
  former Conversation / Channel / Run / Issue agent stack with one canonical
  TypeScript Thread / Turn / ThreadItem implementation across persistence,
  runtime execution, IPC/preload, renderer state, Goals, Subagent collaboration,
  tool output, and history controls. The clean pre-release replacement provides
  append-only audit history, same-Thread Edit rollback, explicit Continue in new
  chat forks, host-resolved admission, bounded Thread-owned payloads, automatic
  Thread naming, and the retained Full Access capability boundary without
  migration or compatibility readers. **Gate (main):** two review rounds caught
  source-owned fork payload loss, forbidden `agent-debug` residue, dropped
  catalog metadata for unloaded Threads, and transient renderer Threads after a
  failed fork; all four were fixed before merge. Final head `c4ff101` passed
  typecheck, the full Core suite (1250 pass, 6 environment-dependent skips), the
  full renderer suite (734 pass), Agent Thread E2E (36 pass), docs check, diff
  check, and the PR-recorded light/dark visual probe (3 pass).
- **Codex Agent Core Thread-name notification interface (PR #433, codex-3)** —
  added the Codex-aligned `thread/name/updated` contract for the complete
  replacement in #429, carrying `threadId` plus an optional non-empty
  `threadName`. The codec accepts the upstream omitted or null no-name forms and
  normalizes both to an omitted field, while rejecting empty names, legacy
  aliases, and unknown fields. **Gate (main):** review caught that the initial
  contract required explicit null even though Codex omits `None`; the optional
  shape and regression coverage were fixed before merge. Verified with
  typecheck, 17 focused protocol tests, the full Core suite (1726 pass), docs
  check, and diff check.
- **Codex Agent Core rollback interface (PR #432, codex-3)** — defined
  append-only audit plus same-Thread `thread/rollback`, exact omitted-Turn
  extension hooks, current-history projection semantics, cumulative side-effect
  and usage accounting, and the exhaustive Copy / Continue in new chat / Details
  response menu for the complete replacement in #429. Memory now invalidates
  generated context synchronously at rollback prepare, filters replacement-Turn
  briefings and implicit Node-tool reads until receipt-backed reconciliation, and
  retries failed terminal hooks in-process through one coalesced capped-backoff
  loop. **Gate (main):** iterative review caught the stale Retry/Regenerate shared
  contract, a replacement Turn that could observe rolled-back generated Memory,
  and commit-hook failure that could suppress Memory until restart; all three were
  fixed before merge. Verified with typecheck, 20 focused protocol/extension
  tests, the full Core suite (1725 pass), docs check, and diff check.
- **Codex Agent Core renderer interface (PR #431, codex-3)** — defined canonical
  Thread configuration get/set, immutable Turn execution and token/cost details,
  content-addressed bounded tool-output reads, provider-retry notifications, and
  native response context-menu actions for the complete replacement in #429.
  **Gate (main):** review caught rejection of bare model IDs and incomplete cached
  token accounting; both were fixed before merge. The runtime-only legacy-colon
  provider ownership check remains a merge gate for #429. Verified with typecheck,
  14 focused protocol tests, the full Core suite (1721 pass), docs check, and diff
  check.
- **Codex Agent Core renderer admission defaults (PR #430, codex-3)** — split
  the renderer-facing `thread/start` request from the fully resolved privileged
  request so the host can supply the configured model provider and working
  directory. This interface-only addendum unblocks the complete Agent Core
  replacement without weakening privileged admission. **Gate (main):** review
  found no reportable issues. Verified with typecheck, 12 focused protocol
  tests, docs check, and diff check.
- **Codex Agent Core interfaces (PR #428, codex-3)** — defined the canonical
  Thread / Turn / ThreadItem protocol and codecs, Goal and extension contracts,
  parent-bounded child configuration, collision-free provider tool identities,
  and host-only document receipts and protected system-tag definitions. This is
  the ordered interface unit; the complete runtime, persistence, transport,
  renderer, and old-model replacement remains next. **Gate (main):** the first
  review found four contract gaps covering protected-tag command classification,
  child capability ceilings, flat provider-name ambiguity, and executable Item
  lifecycle consistency; all four were fixed before merge. Verified with
  typecheck, the full Core suite (1719 pass), docs check, and diff check.
- **Codex agent restructure plans (PR #423, codex)** — ratified three plan-only
  designs for a canonical Thread / Turn / ThreadItem core, Memory published as
  editable daily-timeline Nodes, and host-owned Automations. Core remains ordered
  as a human-led interface PR followed by the complete replacement; Memory and
  Automations remain draft consumers that may proceed independently only after
  Core lands. **Gate (main):** iterative review resolved all reportable findings,
  including the global Memory-disable privacy boundary; the final head had no
  reportable issues. Verified with typecheck, docs check, and diff check.
- **Legacy data import adapter removal (PR #425, codex-4)** — removed the
  unregistered `data_import` AgentTool compatibility adapter, its dead
  capability classification, and adapter-only negative assertions. Import
  remains exclusively on the `tenon-import` CLI/API path, with import-service
  coverage retained under its current name and audit identity. **Gate (main):**
  review found no reportable issues. Verified with typecheck, the full Core
  suite (1689 pass), docs check, current-`main` merge-tree, and diff check.

- **agent turn render projection — extract message-flow semantics (PR #316, codex-2)** —
  behavior-preserving refactor of the agent transcript renderer. A new pure `agentTurnProjection`
  module (`projectAssistantTurn` → `AgentTurnProcessProjection`) sits between the
  `AgentRenderProjection` message and the React components and owns the turn-level semantics that
  used to live inside `AgentAssistantTurnContent`: the result-first process-vs-final partition, the
  synthetic Working/Worked-for process item, default fold-state inputs, stable disclosure ids, and
  tool-activity grouping boundaries. `AgentProcessBlock` now consumes one `process` object instead of
  ~7 separate props, and the render-item union `AgentProcessSegmentBlock` (`kind: thinking|toolCall|
  narration`) becomes `AgentTurnProcessItem` (`type: reasoning|toolCall|agentMessage`). No functional
  or visual change — reasoning/tool detail rows are untouched; the partition heuristic (final answer =
  trailing text after the last thinking/tool block) is preserved exactly, and disclosure ids are now
  more stable across streaming (original content index vs the prior filtered index). **Gate (main):**
  `/code-review xhigh` — zero correctness findings (every formula traced byte-equivalent to the deleted
  inline version across line-by-line / removed-behavior / cross-file angles); three type-model cleanup
  findings (dead `phase` and `sourceIndex` fields, duplicate final-message shape) fixed by the author
  before merge. typecheck ✓ · `test:renderer` 597 pass / 0 fail · `docs:check` ✓. Design folded into
  `docs/spec/agent-event-log-rendering.md`; plan archived to `docs/plans/archive/`.
- **Composer model-control test: silence the act() warning (PR #298, main, fast-track)** — the
  `AgentComposerModelControl` test mounts the anchored-overlay flyout, which (lacking
  `requestAnimationFrame` under linkedom) deferred its reposition `setStyle` to a `setTimeout`
  that fired after the render's `act()` block ("An update … was not wrapped in act(...)"). The test
  harness now installs a synchronous `requestAnimationFrame` stub so the reposition runs inline
  inside `act` — deterministic and warning-free (no product-code change; the two remaining
  `CommandAgentPicker` / `DateValuePicker` warnings are pre-existing and unrelated).
- **self-definition write dedup in `agentLocalTools` (PR #287, main)** — behavior-preserving
  cleanup of the #286 self-definition gateway: `file_edit` and `file_write` shared a 4×-duplicated
  `selfDefinitionWrite?.kind === 'skill'/'agent'` ladder (data spread, registry-reload notify, success
  `instructions`). Extracted three helpers — `selfDefinitionWriteData`,
  `notifySelfDefinitionContentWrite`, `selfDefinitionWriteInstructions` — that own the skill/agent
  mapping once so the two tools stay in lockstep, and dropped the dead `agentDefinitionWrite` parameter
  `notifySuccessfulAgentDefinitionContentWrite` only `void`-ed. No functional change. typecheck ✓ ·
  `agentLocalTools` + `agentRuntimeSkillsIntegration` + `agentSkills` core suites 283 pass / 4 skip / 0
  fail.
- **agent-debug: correct stale slimming comment; pin light summary to its oracle (PR #274, cc-2)** —
  comments + tests only, no behavior change. (1) Fixed a stale comment in `agentDebugView.ts`:
  cross-run `tool_result.replaced` (output slimming) is matched to its producing run by the
  globally-unique `toolCallId` (spliced at derivation), **not** "stamped with its producing run's id"
  — the round-1 approach #264 reverted; the comment now matches the implementation and the spec
  (`agent-event-log-rendering.md`). (2) Added equivalence tests pinning the light `summarizeRunStream`
  path to the correct-by-construction `summarizeDebugRun` oracle (single-round + multi-round in-flight
  usage rollup), enforcing the "summary never disagrees with the detail" invariant both functions'
  comments promise. **Gate (main):** `/code-review xhigh` — no findings (comment correction verified
  against spec; equivalence verified by running the suite); `agentDebugView.test.ts` 13 pass.
  ([#274](https://github.com/relixiaobo/lin-outliner/pull/274))

- **Plan: default #General channel (PR #265, codex-4)** — docs-only. Adds
  `docs/plans/default-general-channel.md`: a Slack-like default **`#General`** Channel — a
  reserved-identity Conversation that exists by default (user + coordinator), **auto-includes every
  durable peer agent** as it appears (fork / child / headless runs excluded), and is the Agent Dock
  default when no conversation is remembered. Membership = presence + addressability, **not**
  participation; unaddressed turns still route to the coordinator, so auto-membership never becomes
  auto-noise. **No stored conversation `kind`** (reserved id + runtime invariant); `@all` deferred.
  **Gate (main):** squash-merged after a plan review, then folded in the two review fixes — removed
  the plan `status` frontmatter (plans are frontmatter-free; status lives only in `docs/TASKS.md`)
  and dropped the non-existent multi-"workspace" framing (there is one workspace; `localFileRoot` is
  env/cwd). Boarded as P2 (not started).

- **Plan: bundled built-in skill resources (PR #268, codex-4)** — docs-only. Adds
  `docs/plans/bundled-built-in-skill-resources.md`: give app-shipped `built-in`
  skills the standard Anthropic Agent Skills shape (a real `SKILL.md` +
  `references/`/`scripts/`/`assets/` base directory so `${AGENT_SKILL_DIR}`
  resolves and built-ins use progressive disclosure instead of a monolithic prompt
  body), preserving the immutable built-in floor. PM-ratified after confirming the
  folder shape against the official Agent Skills standard; the plan delivers
  **structural conformance only** — `name:` frontmatter conformance + third-party
  skill import is split out as a separate board item. Boarded as P1 (not started).

- **Sync the security-exceptions e2e count to the 9-rule catalog (main, fast-track)** —
  `agent-settings.spec.ts` asserted `toHaveCount(10)` select-popup rows, stale since #50f8e6e2 (ungate
  cross-agent contact) intentionally dropped the `spawnChildAgents` (`agent.delegate.spawn`) rule from
  `COMMON_PERMISSION_RULES`, taking it 10 → 9. Updated the assertion to 9; agent-settings e2e 33/33 green.

- **Unified main-process JSON persistence into one store primitive (PR #226, codex-3)**
  — the main process had three hand-rolled atomic-write implementations plus two
  synchronous `writeFileSync` outliers (`agentSettings.ts` / `documentService.ts`
  / `assetService.ts` / `appPreferences.ts` / `windowState.ts`), each re-deriving
  temp-file + rename, mode handling, and read-modify-write locking. They now share
  `src/main/jsonFileStore.ts`: `atomicWriteFile` (+ `writeJsonFileSync` for the two
  synchronous callers), `readJsonOrDefault`, `writeJsonFile`, and a serialized
  `updateJsonFile` read-modify-write under a per-path write lock. The lock map is
  self-pruning (compare-and-delete the settled tail, so unique-path callers like
  per-asset metadata don't accumulate entries), private-file mode is the single
  exported `PRIVATE_JSON_FILE_OPTIONS` preset (0600 file / 0700 dir, no-op on
  Windows), and a same-path nested write throws (`AsyncLocalStorage` guard) instead
  of deadlocking. Preserves every on-disk format (file names, pretty vs compact,
  trailing-newline, the plaintext-0600 secret/permission/provenance files) and the
  secret data-loss guard (a corrupt blob still aborts the mutation rather than
  overwriting). The asset sidecar write is now awaited before ingest resolves.
  Zero on-disk format change. Gate (main): high-effort `/code-review` (6 findings,
  all addressed in the fixup commit), typecheck + `test:core` (963/0) clean. Design
  folded to `docs/plans/archive/main-json-store-unification.md`.
- **TASKS.md is the single source of plan status (main, direct merge)** — plan
  status + priority previously lived in both plan-file frontmatter and
  `docs/TASKS.md`, and the two drifted whenever a plan shipped (e.g.
  `security-settings-ia-redesign` sat in the Backlog as "awaiting ratification"
  after shipping as #215). Status is project-management state, not a property of a
  design, so it now lives in exactly one place: `docs/TASKS.md` is the single
  source of plan todo/status/priority and links out to each plan, and plan files
  are pure design carrying **no frontmatter** (stripped from all 32 active plans;
  `archive/` kept as historical record). New `bun run docs:check` guard
  (`scripts/docs-check.ts`), wired into the "before marking ready" gate: C1 every
  `docs/plans/…` link in TASKS resolves, C2 no active plan is missing from the
  board — offline + deterministic; it caught 3 pre-existing dangling archive links
  + 2 orphan plans on first run. `AGENTS.md` reverses the "catalog = frontmatter"
  rule. Design: `docs/plans/plan-status-single-source.md`.
- **File preview plan refreshed (PR #209, docs-only)** — rewrites
  `docs/plans/file-preview.md` (status stays `draft`) around a source-owned
  `PreviewTarget` model: `local-file`, `asset`, `agent-payload`, and `url` are
  first-class preview sources feeding one panel shell + renderer registry, with
  per-source main-process authority (`local://` token minting, the existing
  `asset://` jail, conversation/run-scoped payload reads, URL reader
  extraction). Reconciles the plan with shipped reality (single-pane #85,
  file-attachments #204/#206, `AgentPayloadRef` storage) — the remaining
  structural prerequisite is generalizing per-panel history to a discriminated
  `PanelView`, optionally split out as a standalone PR 0 refactor. PR sequence:
  shell + web-native basics, then PDF, media streaming, Office, URL reader as
  independent complete PRs. Gate (main): plan claims fact-checked against
  `main` (panel state shape, protocols, payload surface, dependency table, PR
  numbers all verified); one review round folded in five notes (PanelView
  naming, agent-dock host-panel question, persisted-layout wipe note, PR 0
  split option, spec/plan reference fixes).
  ([#209](https://github.com/relixiaobo/lin-outliner/pull/209))

- **Agent ledger hygiene (PR #205)** — drops dead conversation-ledger event
  families that had no replay handler and no real reader (`task.created` /
  `task.completed`, `config.change`, `review_card.created`, `metric.recorded`),
  removes the now-empty render-projection compatibility fields `queuedMessages`
  and `activeRunAgentId` (and their renderer plumbing + e2e mocks), and stops the
  config tool from writing `config.change` audit records (writes still apply and
  return the refreshed setting). Successful `skill.created` / `skill.patched` /
  `skill.replaced` audit events now carry the active `runId` so they land in the
  run ledger instead of the conversation log. Also fixes visible-transcript
  grafting so an active run's multi-segment spine renders contiguously (a
  non-active peer reply can no longer split the active run's tool/result
  continuation), backed by a new oracle test over concurrent multi-segment
  Channel runs (uniqueness, contiguity, active-branch completeness, replay
  stability). Specs synced; no persisted shape changed (no `userData` wipe).
  Gate: typecheck + test:core (900) + test:renderer (418) green.
  ([#205](https://github.com/relixiaobo/lin-outliner/pull/205))

- **Post-merge cleanup for #205/#206 (main agent)** — removes the orphaned
  `.agent-channel-queued` CSS rule left dead by #205, documents the optional
  `pdftoppm` dependency for PDF thumbnails in the architecture spec, and drops an
  always-true `file.size >= 0` filter in `dataTransferFiles`. Typecheck +
  test:renderer green.

- **Agent conversation UX plan ratified (PR #197, docs-only)** — adds
  `docs/plans/agent-conversation-entry-identity-ux.md` (drafted by codex-2, then
  revised on `main` into the PM-ratified contract after the review conversation):
  five independent UX features over the ratified conversation semantics —
  roster-as-DM-list + New Channel flow with an explicit DM→Channel escalation verb
  (UI + arbitrary-agent-DM runtime in one PR) · speaker identity (DM header /
  grouped Channel rows; subsumes `agent-avatar-v1`) · composer model chip becomes
  display+navigate (the current menu mutates the global provider — fixed in one
  step) · a Channel activity area built to the parallel co-addressee semantics
  plus automatic reply anchors · time separators + native context-menu Details.
  Also adds `docs/plans/agent-channel-parallel-runtime.md` (draft): concurrent
  co-addressee execution + completion-order delivery as a pure execution-layer
  upgrade of the already-committed independence semantics. Design only; no
  runtime behavior change. ([#197](https://github.com/relixiaobo/lin-outliner/pull/197))

- **Agent permission safety-modes plan ratified (PR #187, docs-only)** — adds
  `docs/plans/agent-permission-safety-modes.md` (PM-ratified consumer trust model:
  safety floor / trust-grant ledger / Ask First·Balanced·Full Access ladder /
  internal delegation sandbox; one approval card with graduated exits; one Security
  settings page) and `docs/plans/agent-local-root-boundary.md` (build-ready precursor:
  the packaged-app `process.cwd()` file-root fallback may resolve to `/`, which would
  make the whole disk the allowed file area). Design only; no runtime behavior change.

- **Agent storage clean-cut: session vocabulary dies, pools unify under `principals/` (PR #180)** —
  the pre-release format clean-cut (`agent-storage-clean-cut`, PM-ratified full scope; plan archived
  `done` in-PR). Stored `session.*` event types and the persisted `sessionId` field become
  `conversation.*` / `conversationId` (the last format-level residue of the M0.5 rename, which had
  stopped at the public surface); ALL ~1000 code identifiers follow; memory pools unify under
  `principals/<principalKey>/memory/` (the agent-vs-user path asymmetry is gone); `${AGENT_SESSION_ID}`
  → `${AGENT_CONVERSATION_ID}`; checkpoint/search-index versions bumped (full replay / rebuild
  fallback). **No migration** (pre-release policy): the store detects any old-format artifact on first
  access and wipes the agent data root. The gate ran two rounds: round 1 (NO-GO) found the wipe
  detector was **content-triggerable** — a substring probe on the conversation head line could match
  user-controlled title/goal text and `rm -rf` all agent data — plus a sticky memoized rejection that
  bricked storage for the run on any non-ENOENT probe error; round 2 verified the fixes (`8fff92e`):
  structural field-level detection (parse the head, require a `sessionId` *key* or a `session.*`
  `type`; torn/corrupt heads are ambiguity, never proof) and fail-open-to-operation-never-to-wipe
  (probe errors log + continue, next launch re-probes), each with 1:1 regression tests. Verified
  independently at the pinned head: typecheck · `test:core` 808/0 · `test:renderer` 405/0. Non-blocking
  follow-ups recorded on the PR (per-launch probe cost, bounded-line-reader dedup, residue constants,
  user-pool-only false negative).
- **Delete the `MODEL_ID_REPLACEMENTS` silent migration layer (main, fast-track)** — from the
  2026-06-10 pre-release architecture sweep (PM-ratified disposition B): `agentSettings.ts` silently
  rewrote persisted legacy Haiku model ids to `claude-haiku-4-5` at read time — a back-compat
  migration layer the pre-release policy forbids. Deleted (`normalizeModelId` and the map); a stale
  persisted model id now surfaces in settings instead of silently transforming. typecheck ·
  `test:core` 808/0.

- **Redirect `agent-task-model` → fold post-#167 cleanup into the conversation model (PR #168)** — docs-only.
  A drafted standalone "dissolve subagent into Agent(profile)+Task(run)" plan was reviewed and found to
  reinvent the already-approved, in-progress agent program (`agent-program` M0–M3 / `agent-conversation-model`
  / `agent-data-model`) and to conflict with several ratified decisions. **Redirected:**
  `docs/plans/agent-task-model.md` archived as `status: superseded` (slimmed to the path-not-taken record +
  a verified conflict table), and only the sound post-#167 kernel folded into `agent-conversation-model.md`
  §Code mapping as a **bounded CLEAN-CUT** note — retire `general` (empty-body built-in post-#167, redundant
  with the primary identity run fresh), `fork` as a context *mode* (not a pseudo-`AgentDefinition`), and drop
  the `Agent` tool's per-call `model`/`effort` overrides (capability is profile-only). Bounds held at the
  gate: no stored conversation `kind` (F2), no redesign of the protected `agentSubagentIdentity.ts` /
  `agentSubagentTranscript.ts` seams, "Task" stays the off-floor `background` run (`RunMeta.kind`), the
  model-facing rename is contract + UX only (storage names may stay), and any identity-string change (e.g.
  retiring `general`'s owner key) is a dev-`userData` wipe — not a no-op rename. No code or spec change.
  ([#168](https://github.com/relixiaobo/lin-outliner/pull/168))

- **Revise agent memory planning toward the target write/read surface (PR #157)** — docs-only plan
  adjustment (PM-ratified 2026-06-07) across four `docs/plans/*.md`, no production or spec change. Pins two
  decisions for the M2 build. **Write authority — DECIDED:** the durable memory line is written by exactly
  two runtime-owned writers (Settings/Profile UI for explicit edits, Dream/extraction for automatic
  consolidation); there is no model-visible memory write tool and no synchronous foreground "remember this"
  path. **Read surface — DECIDED:** a single model-visible read-only `recall` tool over durable memory (no
  model-visible `past_chats` and no second chat-search tool); `include_evidence` defaults to false and, when
  true, returns raw conversation/run excerpts only as an `evidence[]` field nested under the matching
  `MemoryEntry` (never a sibling in the ranked list, expandable only through the entry's provenance), with
  `status:'invalidated'` filtering, isolation-tier enforcement, and a `max_chars` cap. States the accepted
  consequence explicitly: old conversations Dream never distilled into a `MemoryEntry` are not
  foreground-recallable by design. Spec left untouched on purpose (A6 — current code still ships the inline
  memory tool / `past_chats`; reconcile in the M2 implementation PR).
  ([#157](https://github.com/relixiaobo/lin-outliner/pull/157))

- **Close agent M1 tail verification + plan hygiene (PR #156)** — no production code: added e2e coverage for
  the pending `ask_user_question` card (light/dark `prefers-color-scheme`, real `user_question_request` event
  path + `agent_resolve_user_question` submit) and for the Settings Memory view/edit/forget pane
  (`agent_list/update/forget_memory` IPC + renderer-mock support); marked the M1 "Profile UI" and
  "visual verification" checklist items done; archived the completed `agent-tool-permissions-hardening` plan
  (`status: done`) and repointed its references. ([#156](https://github.com/relixiaobo/lin-outliner/pull/156))

- **Agent M1 memory v1 landed (PR #152)** — first M1 slice: an event-sourced, per-agent durable memory layer.
  Adds a `memory` agent tool (list/remember/update/forget), three IPC commands
  (`agent_list_memory`/`agent_update_memory`/`agent_forget_memory`), a bounded `<agent-memory>` reminder injected
  per turn (score-ranked relevant facts merged with the latest, deduped to 8), and a renderer Memory settings UI
  (edit/forget with provenance). `past_chats` stays raw-transcript recall; memory is the durable-fact layer. As
  part of landing it, the three agent event-log families (conversation, run, memory) were **unified onto one
  `AppendOnlySeqLog<TEvent>` primitive** — single-sourced JSONL serialize/read/tail (the #150
  `readLastNonEmptyLine` chunk-boundary bug class now lives in exactly one place), seq allocation + per-key write
  queue + seq cache, and offset-bounded reads — replacing the duplicated per-family scaffolding. Memory gets a
  projected-state cache (no whole-log re-read/re-sort on the per-turn prompt path), churn-based log compaction
  (`atomicWriteFile` rewrite, gated ≥64 events and ≥2× churn), and is brought under the store-owned clean-cut.
  Review: high-effort adversarial pass (7 finder angles) surfaced 7 correctness findings + the altitude call to
  generalize rather than ship a third parallel log; PM ratified generalizing in-cycle; codex fixed all and
  re-verified. Gate: typecheck + `test:core` 636/0 + `test:renderer` 355/0 + agent/workspace-layout e2e 78/0
  (runtime restore/chat path included since the generalization touched the conversation/run logs). **Next: the
  rest of M1** — canonical DM/Channels, mixed-resolution memory retrieval, ask_user_question, config tool, skill
  self-authoring.
- **Agent M0.5 clean cut landed (PR #151)** — removed the residual `session*` bridge debt now that M0 has
  shipped. The public protocol/IPC/renderer surface is renamed from `session*` to `conversation*` while the
  internal event-log key stays `sessionId` (same string value); the two are joined by an explicit, single
  translation seam — `sessionIdFromConversationId` / `conversationIdFromSessionId` at every public method
  boundary, one typed `emitConversationRuntimeEvent` translator for the closed/error/approval runtime
  events, `rendererProjectionEventFromDomain` for the projection lane, and `entryConversationId` /
  `conversationFieldsForEntry` in past-chats — so the public⇄internal boundary is named in one place instead
  of ~20 inline remaps. The UI-list shape `AgentConversationMeta` is renamed to `AgentConversationListMeta`
  to resolve the collision with the M0 data-model `AgentConversationMeta`; the `metricConversation` i18n
  label is corrected (`Session` → `Conversation`, `会话` → `对话`); the workspace-layout localStorage key is
  bumped (`:v2` → `:v3`) so pre-rename persisted panes are orphaned rather than half-read; and the
  store-owned clean-cut now also sweeps an orphaned legacy `indexes/session-index.json`. Review: 1-round
  high-effort adversarial pass surfaced 5 findings (1 shipped i18n defect, 2 latent altitude issues — the
  name collision and the missing translation seam, 2 cosmetic), all fixed by codex and re-verified. Gate:
  typecheck + `test:core` 629/0 + `test:renderer` 354/0 + agent/workspace-layout e2e 59/0. **Next: M1**
  (memory v1 + canonical DM/Channels + ask-user-question + config tool + skill self-authoring).
- **Agent M0 foundation landed; agent program PM-ratified (PR #150)** — the full M0 storage/runtime
  foundation shipped after a **5-round adversarial review**. Agent persistence is re-keyed from the flat
  `sessions/<id>/` log into split **`conversations/` + `runs/` + `agents/`** storage with joined replay,
  run-scoped payloads, `AgentRunMeta` (fingerprint + usage + retention), byte-offset-bounded seq
  checkpoints, stable identity records, an **internal domain event bus** (single publish; the renderer IPC
  send is just a lane subscriber, not a parallel dispatch), active-run state isolation, and the
  run-scoped-vs-conversation event split derived from run-scoping intent (events carrying a `runId` route
  to the run log). A **store-owned clean-cut** auto-deletes obsolete pre-M0 `agent/sessions/` + stale
  `indexes/` on first access and reconciles the session index against `conversations/` (no legacy reader,
  no migration — per the pre-release no-back-compat policy), so existing dev installs self-heal instead of
  needing a manual userData wipe. Review trail: the original 10 findings (3 perf regressions that had
  re-introduced the #116/#117 write-amplification, 3 correctness — failed/cancelled-run usage loss,
  checkpoint truncation guard, reactive-compaction prompt loss — 4 cleanup/altitude) all fixed; a
  tail-reader P0 (`readLastNonEmptyLine` truncating lines > 4 KB) introduced by the first fix, then fixed +
  regression-tested; and a runtime clean-cut session-restore failure (stale index pointing at unloadable
  ids) fixed with index reconciliation + scenario tests. Gate: typecheck + `test:core` 628/0 +
  `test:renderer` 354/0. **The agent program is now ratified — M0.5** (remove residual `session*` bridge
  debt) **then M1** (memory + DM/Channels + ask-user-question + config + skill authoring) follow.
  ([#150](https://github.com/relixiaobo/lin-outliner/pull/150))

- **Agent M0 F2a run-log join read seam (PR #149)** — replay now exposes two named read seams over the
  still-flat session log: `getAgentEventConversationPath()` returns communication only (user messages +
  final assistant replies, excluding run-scoped execution — tool-result messages and assistant turns whose
  completed content is a tool call / `stopReason: 'toolUse'`), while `getAgentEventRuntimeTranscriptPath()`
  returns the joined pi-agent-core transcript (today ≡ the active parent-linked path). The runtime
  transcript builder (`agentRuntime.ts`) and `deriveAgentPiMessages` route through the runtime seam — a
  behavioral no-op now, but the future physical `conversation`/`run` split can replace it without touching
  consumers. Runtime-emitted `tool_result.created`/`replaced` events now carry `runId` (the run-log join
  key); legacy flat events infer run ownership from the parent assistant message during replay. The
  conversation-path consumer is not wired into the renderer yet (the seam lands first), so the
  communication/execution distinction is currently latent. Gate: typecheck clean + `test:core` 611/0 (new
  run-ownership-inference + seam-split tests) + spec updated (`agent-event-log-rendering.md`).
  ([#149](https://github.com/relixiaobo/lin-outliner/pull/149))

- **Agent M0 data-model protocol types landed (interface-first, replay-neutral) (PR #147)** — the target
  conversation/run/memory contracts from `docs/plans/agent-data-model.md` are now declared in
  `src/core/agentEventLog.ts`: `AgentPrincipal`/`AgentId` (template-literal `sourceKind:instance:name`
  tuple), `AgentConversationEvent` + `AgentRunLogEvent` + `AgentMemoryEvent` discriminated unions (payloads
  per variant, incl. the full `tool.permission.checked/resolved` audit fields mirroring the real
  `ToolPermission*Event`), `AgentRunMeta` (fingerprint + retention + trigger), `AgentIdentityRecord`,
  `AgentMemoryEntry`. The **current flat session log** gains the `user_question.*` + `widget_state.updated`
  event types and an optional `actor` on `AgentEventMessageRecord`; the new events replay **neutrally**
  (bump `latestSeq`, no conversation/active-path effect) until consumers emit/project them.
  `SkillDefinition.source` gains `'built-in'`. Pure additive contract + minimal wiring; no behavior change.
  Gate (no `/code-review ultra` available to the agent): full manual protocol review + `typecheck` clean +
  `test:core` 610/0 (incl. a new replay-neutral test + actor assertions), verified spec-aligned with the
  round-4 data-model. ([#147](https://github.com/relixiaobo/lin-outliner/pull/147))

- **Agent design plans adversarially reviewed (codex + gemini) and the findings closed (docs-only)** —
  the agent plan set (`agent-data-model` / `agent-conversation-model` / `agent-program` + consumers)
  was reviewed by two independent agents; the valid findings were verified against the real code and
  applied. **Two PM-ratified decisions revised:** (1) memory writes go through a **runtime-owned,
  event-sourced append surface** (`memory.entry_added/...`), *not* the privileged `file_write` path —
  reversed because the file tools are realpath-jailed to `workspace.root` (`agentLocalTools.ts:2207`,
  can't reach `userData/agent/`) and whole-file rewrite risks lost-update; (2) memory adds
  **opt-in isolation tiers** (`isolated` / `read-only-global`) + `originWorkspace` over the global
  default, motivated by a cross-project NDA-leak case. **Data-model** also gained: a run-log **retention
  state machine** (`hot→cold-archived→summarized-only→deleted`), `RunMeta.fingerprint` (version boundary
  for "same-fingerprint replay"), a stable `agentId` tuple (`sourceKind:sourceInstanceId:name`, no
  cross-project collision), `meta.json` as a **projection** (+ `cursors` split out), `MessageEvent.forwarded`
  provenance, canonical `tool.permission.*` names, and `MemoryEntry` undo-invalidation (`status` +
  source `runId`/`eventId`). **Program** fixed M0/M1 sequencing (F2 ships the minimal run-log join in M0),
  reframed F4 (a real internal domain bus, not the renderer-IPC `emit`), and added a permission-event
  taxonomy row. **Consumer plans** de-session-ified (scheduled-routines / ask-user-question /
  generative-ui → run/conversation; self-modification consistency note). **A third round (#144) hardened the contract for the M0
interface-first PR:** the run-log event list became a real `RunEvent` **discriminated union
with per-variant payloads** (`RunEventBase` + `runId` anchor, symmetric with `MessageEvent` —
carries `requestId`/`toolCallId`/`request`/`result`/`usage`/`currentState`), and three
load-bearing invariants were pinned — the **event-log stream is the sole authority**
(`meta.json`/checkpoint/`index.json`/render projection are rebuildable projections), **replay
fidelity is gated on `RunMeta.retention`** (`summarized-only`/`deleted` can't claim verbatim
replay), and **memory invalidation has one owner** (the runtime reconciler, never the agent)
**and one trigger** (branch discard/undo, emitted as `memory.entry_updated(status:invalidated)`).
No code; plans only.

- **Agent data-structure design landed, then extracted into a dedicated `agent-data-model` plan** —
  a multi-pass design conversation converged the agent storage model and was written into the plans
  (docs-only; no code); the authoritative shape now lives in its own **`docs/plans/agent-data-model.md`**
  (single source for the persistence + context contract — F2/F3/F6 cut against it), with
  `agent-conversation-model` slimmed to the experience design + a pointer, and `agent-program` adding it as
  a member plan. The model: **three storage families** (linear event log · Loro CRDT · skills file
  tree), **one log engine with three instances** (conversation / run / memory, differing only by id /
  writer / retention / vocabulary), **`session` split into `{conversation, run}`** (messages vs execution
  — keeps the conversation log low-volume and `tool_call ↔ tool_result` off the shared channel stream),
  a **single `Principal` type** (member = actor = addressee) with conversations as **one primitive (no
  stored `kind`** — DM/group derived; spawn-don't-convert preserved as a product rule), **runs anchored
  to exactly one conversation** (trigger = provenance, no conversation-less runs), a **distillation
  ladder** (raw → segment summary → conversation summary → agent memory) generalizing `compaction.completed`
  into a **lossy-but-addressable** multi-consumer node (down-pointer to retained source; powers navigation,
  two-step `recall.overview/expand`, and the memory feedstock), and the **context volatility-ordering /
  cache-discipline invariant** (stable prefix → one volatile tail; distilled memory → prefix, query recall
  → tail; compact at segment boundaries, never slide). Validated against the real runtime: pi-agent-core is
  stateless transcript-replay driven by two seams (`deriveRuntimePiMessages` read / `handlePiAgentEvent`
  write), so the whole structure lives above the engine unchanged. `agent-program` F2/F3/F5/F6, the event
  taxonomy, and the consolidated protocol-surface list were updated to match. Four foundational decisions
  were then **PM-ratified (2026-06-05)**: **canonical DM + user-creatable Channels** (the session list
  becomes the Channel list; the DM is the always-on continuous thread); **split-now + mixed-resolution
  replay** (execution incl. `tool_result` lives only in the run log; recent turns join the run log, old
  segments render as compaction summaries — the agent stops re-seeing old tool outputs verbatim);
  **memory = one global pool with pure-relevance retrieval** (no per-workspace partition; visible/edit/forget
  is the bleed guard); **memory writes via a privileged, permission-exempt `agent-memory/` path** (serialized,
  not a dedicated tool).

- **Refresh stale workspace-layout e2e guards to floating-rails geometry (PR #135)** — three assertions in
  `workspace-layout.spec.ts` still encoded the pre-#57 sidebar/divider shape and failed on current main:
  (1) the panel-resize cursor moved from the 1px `.panel-resize-slot` (now `auto`) to a separate 10px-wide
  `.panel-resize-handle` hit strip, and the grab pill is gone (`::after` width `auto`); (2) sidebar chrome
  now aligns to the tree **chevron** control column (rail-pad 8 + content-start 6), not the label, which
  clears the chevron by a 6px gap; rows inset 8px from the floating rail; (3) a tree row's hover affordance
  is a neutral fill + chevron brighten, not a row-text colour shift. Guards re-pinned to the real shipped
  DOM/CSS (tight numeric checks, not relaxed) — `workspace-layout.spec.ts` 15/15. Resolves the pre-existing
  :61/:320 failures previously tracked as PR-C/PR-D residual. ([#135](https://github.com/relixiaobo/lin-outliner/pull/135))

- **Agent user-message UI cleanups (post-#130 review)** — two behavior-preserving tidies surfaced
  during the PR #130 gate: collapsed the nested empty-state ternary in `AgentChatPanel`
  (`!settingsLoaded ? null : hasUsableProvider ? null : X` → `!settingsLoaded || hasUsableProvider ? null : X`),
  and keyed the collapsible user-content measure on the full `text` rather than `text.length` so an edit
  to a different same-length message re-measures and resets the expand state. Fast-track; typecheck +
  `test:renderer` 353/0 + agent-onboarding/agent-process e2e 8/8.

- **Chrome-zone backing transition off a literal `0ms` (guard hygiene)** — `.window-chrome-zone`
  declared `transition: background-color 0ms`, whose literal `0ms` tripped the `typography-tokens`
  motion guard (durations must be tokenized; there is no zero-duration motion token). Rewritten as the
  longhand `transition-property: background-color` — behavior-identical (default 0s duration → instant
  paint) but with no literal `ms`, and still honoring the `transition-delay` the collapsed / agent-closed
  modifiers use to hold the opaque corner backing back until the rail finishes sliding (so `transition:
  none` was not an option). Pre-existing failure unrelated to any feature PR; fast-track, no user-visible
  change.

- **Agent permission authority folded into spec (PR #78)** — new
  `docs/spec/agent-tool-permissions.md` is the authority for the shipped
  allow/ask/deny policy (evaluation precedence, platform hard blocks, bash
  classifier, ask resolution, sensitive-data redlines, fail-closed store, events,
  UI), with a *Known divergences* section recording shipped-vs-plan gaps verified
  against the implementation. `agent-tool-design.md` Approval Policy slimmed to a
  pointer; the spec README index and the hardening plan re-pointed at the new
  spec. ([#78](https://github.com/relixiaobo/lin-outliner/pull/78))
- **AGENTS.md reorganized to best-practice structure + on-the-loop model (PR #77)** —
  restructured per Anthropic CLAUDE.md guidance (a Commands section up front,
  load-bearing first, `Stack Constraints` folded into A1, userData / packaging /
  `tmp` compressed into one Dev environment section) and folded in the
  collaboration refinements: the PM ratifies a dev-drafted one-pager (on-the-loop,
  not in-the-loop), a what-NOT-to-escalate rule, collision self-check as the dev
  agent's job, explicit cross-agent autonomy boundaries, and mechanical
  review-gate / `significant` triggers. `docs/TASKS.md` drops the hand-maintained
  plan index — the active-plan catalog is derived from `docs/plans/*.md`
  frontmatter. ([#77](https://github.com/relixiaobo/lin-outliner/pull/77))
- **Collaboration-method model folded into `AGENTS.md`; docs restructured (PR #76)** —
  the agreed PM-led parallel-planning model lands in `AGENTS.md`: the main agent
  is the end-stage gate (no up-front framing), with a review-gate table, a WIP
  cap (2 significant changes), a Draft-PR-as-claim collision radar, a
  document-system table, and the plan status legend. `docs/TASKS.md` becomes the
  single live board (folds the deleted `docs/plans/README.md` active-plan index;
  adds the `anti` clone). The 15 terminal plans move to `docs/plans/archive/`;
  the shipped status word is unified to `done`; test fixtures move under
  `tests/fixtures/`; stale references in the READMEs, active plans, and src
  comments are repointed. ([#76](https://github.com/relixiaobo/lin-outliner/pull/76))
- **Agent + launcher planning docs (PRs #72–#75)** — added the
  `agent-self-modification` controlled-self-maintenance plan plus cc-2.1-aligned
  spec guidance (#72), an OAuth agent self-configuration boundary in
  `agent-oauth-providers` (#73), the `lazy-like-global-launcher` plan (#74), and
  the `outliner-local-file-references` plan (#75). Docs-only.
  ([#72](https://github.com/relixiaobo/lin-outliner/pull/72),
  [#73](https://github.com/relixiaobo/lin-outliner/pull/73),
  [#74](https://github.com/relixiaobo/lin-outliner/pull/74),
  [#75](https://github.com/relixiaobo/lin-outliner/pull/75))
- Removed the ~1.3k-line legacy `TrailingInput` editor (plus `TrailingInputLeading`) — its trigger paths (`#`/`@`/`/`/`>`/code/checkbox/image) are re-implemented as atomic-create branches on the `OutlinerItem` trailing draft, collapsing the two-ProseMirror-editor fork to one. Removed the now-dead `resolveTrailingRow*` interaction resolvers. Fixed a focus-propagation bug where a command-outcome focus request (`panelId: null` wildcard) failed the row memo's `targetsRow` predicate and dropped focus to `<body>`; added `focusAncestorToken` so a memoized ancestor re-renders to pass a focus/pending-input request down to a nested target (#64).
- Re-armed the design-system guard e2e specs after the CSS split and floating-rails shell redesign: the typography-tokens guard now globs `src/renderer/styles/*.css` and the workspace-layout spec asserts the shipped DOM; page-title sizing corrected to 24px/32px (PR-A, #62).
- **Modularize `styles.css` into per-surface modules** — the 6851-line monolith
  is split into 30 cascade-ordered modules under `src/renderer/styles/` behind a
  `styles/index.css` barrel; concatenating the modules in barrel order reproduces
  the original byte-for-byte at the split commit. Also fixes two long-standing
  undefined-token references the split surfaced (`--font-mono` →
  `--font-family-mono`, `--control-bg` → `--fill-2`).
  ([#57](https://github.com/relixiaobo/lin-outliner/pull/57))
- **Renderer perf — per-node memo, focus memo, opt-in flat virtualization** —
  `OutlinerItem` is memoized on a per-node `renderRev` (a dev-only
  `LIN_RENDER_PROBE` measures per-command re-render cost), and the global
  `uiGen` re-render is replaced by `deriveRowMemoState` / `rowMemoStateEqual` so a
  row re-renders only when its own UI state moves (behavioural reads route
  through a live `uiRef`, so skipped rows stay correct). A windowed
  `OutlinerFlatView` is gated behind `localStorage 'lin:flat-outliner'`, so
  default behavior is unchanged. Resolved one positional merge conflict in
  `OutlinerItem.tsx` against the #53 keyboard work on the way in (both additions
  kept). ([#54](https://github.com/relixiaobo/lin-outliner/pull/54))
- **Native-feel stage 5b — incremental core state + projection caches** — the
  Core mutation/read path is now O(touched) instead of rematerializing the whole
  document and deep-cloning every node per command; the public IPC contract
  (`DocumentProjection`, `CommandOutcome`, `DocumentState`) is byte-for-byte
  unchanged. A single keystroke in a 1000-node doc dropped from ~770ms to
  ~0.27ms and the old ~2000-node loro crash is gone.
  ([#52](https://github.com/relixiaobo/lin-outliner/pull/52))
- **Native-feel stage 5a — opt-in IPC tracing (measure-first)** — `LIN_TRACE_IPC=1`
  logs one line per command (`[ipc] <command> <ms> <payload kB> nodes=<n>`) around
  the `lin:invoke` chokepoint, with zero overhead when off. The measurement proved
  serialization was a non-issue (<1ms at 1000 nodes), redirecting the stage-5b
  perf work to the Core layer.
  ([#50](https://github.com/relixiaobo/lin-outliner/pull/50))
- **Security shell — host owns navigation + capabilities (native-feel stage 1)**
  — the main process now closes the renderer's default-open Chromium surface.
  `setWindowOpenHandler` denies all child windows (http(s) `target="_blank"`
  links route to the OS browser via `shell.openExternal`); `will-navigate` /
  `will-redirect` block navigating the renderer away from its own document
  (`file://` in prod, the Vite origin in dev) and send external http(s) to the
  OS browser. Permission request/check handlers deny every capability except
  `clipboard-sanitized-write` (the only one the renderer uses). A strict
  `Content-Security-Policy` (`script-src 'self'`, no `unsafe-inline`/`eval`;
  `unsafe-inline` styles only; remote http(s) only as img/media sources;
  `connect-src 'self'`) is injected on the packaged renderer's own `file://`
  main-frame document — scoped so the agent's remote web-fetch windows are
  untouched. Verified against the built bundle and an `electron out/main` run
  (CSP applies, zero violations). The applied behavior remains scoped to the
  main window; agent web-fetch/search windows keep their own navigation
  lifecycle. ([#43](https://github.com/relixiaobo/lin-outliner/pull/43))
- **Discriminated `Node` union — god-record removed** — the ~57-field `Node`
  god-record is now a discriminated union of per-`NodeType` variant interfaces
  over a small uniform `NodeBase` (`ContentNode` = the `type?: undefined`
  variant). Content-type-specialized fields moved onto their owning variant
  (media → `CodeBlockNode`/`ImageNode`/`EmbedNode`; query params → a
  `QueryParams` mixin on `SearchNode`/`QueryConditionNode`; view rules →
  `ViewDefNode`/`SortRuleNode`/`FilterRuleNode`/`DisplayFieldNode`; `configKey` →
  `DefConfigNode`; `fieldDefId` → `FieldEntryNode`; `targetId`/`refRole` →
  `ReferenceNode`). The query-rule target that `search`/`queryCondition` shared
  with references was split out to `queryTargetId` so `targetId` is unambiguously
  the reference pointer. Persistence enumerates `NodeFieldKey = KeysOfUnion<Node>`
  to read/write the flat scalar map generically. References carry an explicit
  `refRole` (`link`/`fieldValue`/`config`/`enum`/`searchResult`/`autoInit`) and
  backlinks use an allowlist instead of parent inference.
  ([#18](https://github.com/relixiaobo/lin-outliner/pull/18))
- **Register the `anti` dev clone** — a fourth parallel dev clone
  (`lin-outliner-anti/`, Claude Code dev agent, branch prefix `anti/<topic>`) is
  documented in `AGENT.md` / `CLAUDE.md`, with a matching `dev:anti` script
  pointing `ELECTRON_USER_DATA_DIR` at `$HOME/.lin-outliner-anti` for userData
  isolation. ([#41](https://github.com/relixiaobo/lin-outliner/pull/41))
- **Drop dead `ProviderChoice` fields** — the Settings dialog's
  `buildProviderChoices` no longer populates `modelId` / `custom` on each
  provider choice; nothing read them (rendering, sort, and status label use only
  `providerId` / `configured` / `active` / `enabled` / `hasCredential`).
  Self-review follow-up to #31, behavior-preserving.
  ([#32](https://github.com/relixiaobo/lin-outliner/pull/32))
- **Prod install isolation + signing** — `userData` now resolves in three
  tiers (`ELECTRON_USER_DATA_DIR` → `$HOME/.lin-outliner-dev` for unpackaged
  source runs → the default path for installed builds), so a bare `bun run dev`
  can never touch the installed prod app's daily-use data. An `afterPack` hook
  deep ad-hoc signs the packaged macOS `.app` (electron-builder skips bundle
  signing under `mac.identity: null`), sealing it so the unsigned arm64 build
  launches on Apple Silicon. Docs cover the resolution order and the build /
  install flow. ([#23](https://github.com/relixiaobo/lin-outliner/pull/23))
- **Bounded local-file caches** — the local file search / icon / thumbnail
  caches now evict oldest-first via a shared bounded helper instead of clearing
  wholesale at 1000 entries. The wholesale clear could drop the `id -> path`
  mappings that prepare/preview rely on, making recently surfaced `@`-mention
  files unselectable mid-session. Follow-up to #21.
  ([#22](https://github.com/relixiaobo/lin-outliner/pull/22))
- **Subagent next-step guidance on the envelope** — the `Agent` / `AgentStatus`
  / `AgentSend` / `AgentStop` subagent tools now carry their next-step
  `instructions` via the envelope's top-level `instructions` field
  (`successEnvelope(tool, data, { instructions })`) instead of duplicating it on
  `data.instructions` in the model-visible projection. Follow-up to #17.
  ([#20](https://github.com/relixiaobo/lin-outliner/pull/20))
- **Slimmer model-visible tool output** — `web_search`, `web_fetch`,
  `file_glob`, `file_grep`, `bash`, `task_stop`, `operation_history`, and the
  `Agent`/`AgentStatus`/`AgentSend`/`AgentStop` subagent tools now project a
  trimmed view to the model via `agentToolResult(envelope, modelData)`, dropping
  echoed call arguments, constant provider metadata, and telemetry
  (`durationMs`, `byteLength`, `finalUrl`, the Loro cursor, etc.). The full data
  stays on the envelope (`details`); conditional fields (redirect `finalUrl`,
  non-200 `statusCode`, pagination) are emitted only when meaningful. Adds
  projection unit tests per tool.
  ([#17](https://github.com/relixiaobo/lin-outliner/pull/17))
- **Shared node-line view helpers** — extracted `nodeLineView.ts`
  (`caretAnchor`, `selectionTextOffsets`, and a unified inline-ref-aware
  `selectionForPlacement` / `applyCursorPlacement`) from `RichTextEditor` and
  `TrailingInput`, which both now delegate to it. Behavior-preserving (the
  trailing input's old `1 + offset` math reduces to the shared version for
  plain text, pinned by unit tests); Phase 2a of the node-line editor
  unification. ([#12](https://github.com/relixiaobo/lin-outliner/pull/12))
- **Node-line editor core build contract** — design doc
  (`docs/plans/node-line-editor-core-design.md`) pinning the Phase 2b
  approach: drop the monolithic `useNodeLineEditor` hook in favor of shared
  pure modules, and route trigger application through `resolveTargetId`.
  ([#13](https://github.com/relixiaobo/lin-outliner/pull/13))
- **Three-clone parallel-agent hub model** — `lin-outliner` (main: review /
  merge / integration) plus `lin-outliner-cc`, `lin-outliner-cc-2`, and
  `lin-outliner-codex` dev clones sharing one GitHub origin, integrating via PRs
  to `main`, with per-clone `userData` isolation (`dev:main` / `dev:cc` /
  `dev:cc-2` / `dev:codex`).
