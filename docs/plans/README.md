# Lin Plans

This directory holds forward-looking implementation plans. Each plan is a
single Markdown file with a YAML frontmatter status. `spec/` describes what
the code already does; `plans/` describes what it should do next.

## Status Conventions

Every plan starts with frontmatter:

```yaml
---
status: draft | in-progress | done | implemented | superseded | shelved | meta
priority: P0 | P1 | P2 | P3
owner: relixiaobo
created: 2026-05-25
updated: 2026-05-25
---
```

- `draft` — written down, not started.
- `in-progress` — work has begun; the plan should track open subtasks inline.
- `done` — shipped; the plan stays as historical context. When a plan is done,
  its substance should be reflected in `spec/`.
- `implemented` — shipped *and* still the authoritative plan governing the
  feature (e.g. it supersedes earlier exploratory plans); the live reference,
  not just history.
- `superseded` — replaced by a different approach that shipped; kept to record
  the path not taken.
- `shelved` — explicitly decided not to do for now. Keep the rationale.
- `meta` — a standing reference (e.g. a decision catalog), not a unit of work;
  has no priority.

## Active Plans

Forward-looking work: `draft` / `in-progress`, plus the `meta` reference.
Ordered by dependency, not priority — items lower in the list may depend on
items above.

| File | Status | Priority | Summary |
| --- | --- | --- | --- |
| [`asset-subsystem.md`](asset-subsystem.md) | draft | P0 | Local content-addressed asset store + `asset://` protocol. Blocks image/attachment/embed work. |
| [`agent-past-chats.md`](agent-past-chats.md) | in-progress | P1 | Single `past_chats` tool (recent + search + read modes) backed by the event store, user-message/search indexes, and visible transcript filtering. Foundational agent infrastructure. |
| [`native-feel-remediation.md`](native-feel-remediation.md) | in-progress | P1 | Make the Electron app feel native (macOS + Windows) without leaving Electron. 6 stages: security shell (#43), startup/window (#45), material + font (#46, #47) + cursor/focus-ring pass (#65), native interactions — dialogs + settings window (#48, #49) + native app/right-click menus + inactive-window (#68), IPC tracing + incremental core (#50, #52) and renderer perf (#54) all shipped; only packaging/smoke (stage 6) remains. |
| [`image-rendering.md`](image-rendering.md) | draft | P1 | Render `image` nodes inline using the asset subsystem. Paste/drag/clipboard ingestion. |
| [`file-attachments.md`](file-attachments.md) | draft | P1 | New `attachment` node type for arbitrary local files (PDF, audio, video, generic). Goes beyond nodex parity. |
| [`agent-composer-attachment-path-model.md`](agent-composer-attachment-path-model.md) | draft | P1 | Path-first **agent composer** attachments: only images stay inline (vision); every other file is a path reference (no size cap), and no-path inputs (paste/in-memory) are staged to disk via a new `lin:stage-attachment` IPC instead of being truncated/rejected. Image-only size guard + consistent inline error. |
| [`design-system-rollout.md`](design-system-rollout.md) | draft | P1 | Stage the design-system.md target into code: two-theme alpha-on-ink tokens + dark mode, Electron material/vibrancy + nativeTheme toggle, neutral-functional component migration, and the floating-rails shell redesign (full-height sidebar, per-pane headers, no global tabs, right-side agent toggle). |
| [`agent-oauth-providers.md`](agent-oauth-providers.md) | draft | P2 | OAuth sign-in (Anthropic Pro/Max, GitHub Copilot, OpenAI Codex) + managed credentials (Bedrock AWS, Vertex ADC) for provider settings; today everything is modeled as a pasteable API key. |
| [`agent-tool-permissions-hardening.md`](agent-tool-permissions-hardening.md) | draft | P2 | Non-blocking follow-ups after #60: move the `sessionApproved` short-circuit below configured-ask, re-validate pre-shaped configs, extend the exfil redline to interpreter/ssh sinks + bare `id_ecdsa`/`id_dsa`, collapse the dual `approval.*`/`tool.permission.*` event vocabulary, and align denied-reason literals with the plan contract. None is a live fail-open. |
| [`agent-scheduled-routines.md`](agent-scheduled-routines.md) | draft | P2 | Proactive agent **`command` NodeType**: node content is an NL brief; setting its user-only-writable `date` (anchor + optional `RRULE` recurrence — decision **B1**, recurrence lives on the generic date field) arms an offline anacron scheduler. The user-only `date` write is the entire safety surface. |
| [`floating-toolbar-polish.md`](floating-toolbar-polish.md) | draft | P3 | Add heading-mark toggle and `#` selection-extract to the floating editor toolbar. |
| [`embed-strategy.md`](embed-strategy.md) | draft | P3 | Decide between live iframe embeds, locally-cached metadata embeds, or removing the embed schema fields. |
| [`nodex-parity-decisions.md`](nodex-parity-decisions.md) | meta | — | Catalog of nodex features we explicitly will not port and why. |

## Shipped & Archived

Historical context: `done` / `implemented` / `superseded` / `shelved`. Their
substance lives in `spec/`; the plans stay (we don't delete plans — see Working
Rules). Newest first within each cluster.

| File | Status | Priority | Summary |
| --- | --- | --- | --- |
| [`native-settings-redesign.md`](native-settings-redesign.md) | done | P2 | Agent Settings → Providers reworked to the macOS System Settings *interaction* idiom (inset grouped list primitive, master-detail, on-row status) in our tokens/B-rules; per-provider config opens as its own native modal-child window (D-FORM evolved from sheet). Shipped in #69; design folded into `design-system.md`. Follow-ups: packaged-build presentation QA (D7), Permissions/Skills adopting the inset primitive. Coordinate with `agent-oauth-providers.md` (shared multi-mode credential form). |
| [`reference-field-type.md`](reference-field-type.md) | done | P2 | One reference-node model for node-reference field values: read-only computed fields (`References`/`Owner`/`Day`) project synthetic read-only reference rows (full reference behavior — double-click edits target, expandable — but no add/delete), and a new editable `reference` field type (`@`-pick any node, stored reference child). Deletes the bespoke `.field-value-link`. Shipped in #71. |
| [`field-name-reuse.md`](field-name-reuse.md) | done | P2 | Field-name reuse popover (`>` relinks to an existing user field instead of always minting a new def) + read-only computed system fields (Created / Last edited / Done / Tags / References / Owner / Day) + trailing-draft Tab relocate. Shipped in #70. |
| [`native-feel-ui-audit.md`](native-feel-ui-audit.md) | done | P1 | Verified native-feel + UI audit (Claude + Codex, at `d9f1fa8`) turned into dev-agent work packages — focus rings, native menus, cursor pass, a11y media queries, inactive-window state, overlay materials/elevation, dark-mode `@media` migration, design-system guard-test rot, spec reconciliation. Records the D4/D1/X1-X2 decisions. Shipped across #62 / #63 / #65 / #68; remaining stage-6 packaging lives in `native-feel-remediation.md`. |
| [`node-line-editor-unification.md`](node-line-editor-unification.md) | done | P1 | Unify the two node-line editors (inline `RichTextEditor` + `TrailingInput`). Phase 1 (shared paste classifier, #11), Phase 2a (shared view helpers, #12), and Phase 2b (delete `TrailingInput`; trailing line is the unified `OutlinerItem` draft, #64) all shipped. |
| [`node-line-editor-step2-eager-materialization.md`](node-line-editor-step2-eager-materialization.md) | done | P1 | Step 2: eager-materialize the trailing draft row — client-proposed node id + materialize undo grouping; type-to-create with no editor remount (#16). |
| [`node-line-editor-step1-extraction.md`](node-line-editor-step1-extraction.md) | done | P1 | Step 1: extract shared node-line trigger detection + structural keymap resolvers as pure modules (#16). |
| [`node-line-editor-core-design.md`](node-line-editor-core-design.md) | superseded | P1 | Build contract for the `resolveTargetId` command-path unification — that approach was dropped (the trailing slot keeps its atomic create-and-apply commands); Phase 2b instead shipped "one editor, not one command path" in #64. |
| [`config-as-nodes.md`](config-as-nodes.md) | done | P1 | Move definition + view configuration off Node's flat typed fields into the node tree, reusing the field-value mechanism (node-unification U1). Shipped in #18. |
| [`code-block-editor.md`](code-block-editor.md) | done | P2 | Dedicated `codeBlock` editor with language selection and syntax highlighting. |
| [`paste-handling.md`](paste-handling.md) | done | P2 | Structure-aware clipboard paste: inline marks, fenced code → `codeBlock`, rich HTML routing, single-line URL linking. |
| [`keyboard-shortcut-parity.md`](keyboard-shortcut-parity.md) | done | P2 | Nodex shortcut audit completed; remaining gaps shipped for empty-selection Cmd+A, go-to-today, nav-history keys, and selected option-reference menu navigation. |
| [`agent-tool-permissions.md`](agent-tool-permissions.md) | implemented | P0 | **Authority for agent permissions.** One global runtime-owned policy (allow/ask/deny by action kind), platform hard blocks, a classifier-backed `ask` resolver with a strict auto-allow eligibility bound, fail-closed rule validation, sensitive-data exfiltration redlines, and a defined interactive/unattended fail-safe. Supersedes the two shelved plans below. Shipped in #60. |
| [`agent-permissions.md`](agent-permissions.md) | shelved | P0 | Superseded by `agent-tool-permissions.md`. Earlier per-area allow/ask/deny matrix + sensitive-path catalog + once/session/always rules; kept as background. |
| [`agent-reversible-execution.md`](agent-reversible-execution.md) | shelved | P0 | Superseded by `agent-tool-permissions.md`. Reversibility-first foundation (checkpoint/undo engine + `reversible ⇒ allow, else ask`); reversibility is now a descriptor/policy input, not the primary gate. |

## Working Rules

- Keep each plan single-file. If a plan is splitting in two, that's a sign one
  of them is done enough to land in `spec/` and the other should become its
  own plan.
- Lead with **Goal** and **Non-goals**, then **Design**, then **Open
  questions**. Implementation sub-checklists go last.
- When a plan is implemented, move the **Design** section into the relevant
  `spec/` document and flip the plan's status to `done`. Do not delete the
  plan — it is historical context.
- Update `priority` when reordering. If two plans share a priority, expect to
  pick one to start.
- A plan is not a place for daily progress notes; keep those in commit
  messages or in `agent-progress.md` for agent work specifically.
