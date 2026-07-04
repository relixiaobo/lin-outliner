# Changelog

All notable changes to Lin Outliner are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries reference the pull request that introduced them.

## [Unreleased]

Tracks `main`; not yet tagged for release. `package.json` is at `0.1.0`.

### Added

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

### Fixed

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

### Changed

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

### Removed

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

### Added

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

### Changed

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

### Fixed

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

### Internal

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

### Changed

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

### Added

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

### Fixed

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
