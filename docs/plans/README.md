# Lin Plans

This directory holds forward-looking implementation plans. Each plan is a
single Markdown file with a YAML frontmatter status. `spec/` describes what
the code already does; `plans/` describes what it should do next.

## Status Conventions

Every plan starts with frontmatter:

```yaml
---
status: draft | in-progress | done | shelved
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
- `shelved` — explicitly decided not to do for now. Keep the rationale.

## Active Plans

Ordered by dependency, not priority. Items lower in the list may depend on
items above.

| File | Status | Priority | Summary |
| --- | --- | --- | --- |
| [`asset-subsystem.md`](asset-subsystem.md) | draft | P0 | Local content-addressed asset store + `asset://` protocol. Blocks image/attachment/embed work. |
| [`image-rendering.md`](image-rendering.md) | draft | P1 | Render `image` nodes inline using the asset subsystem. Paste/drag/clipboard ingestion. |
| [`file-attachments.md`](file-attachments.md) | draft | P1 | New `attachment` node type for arbitrary local files (PDF, audio, video, generic). Goes beyond nodex parity. |
| [`code-block-editor.md`](code-block-editor.md) | done | P2 | Dedicated `codeBlock` editor with language selection and syntax highlighting. |
| [`paste-handling.md`](paste-handling.md) | done | P2 | Structure-aware clipboard paste: inline marks, fenced code → `codeBlock`, rich HTML routing, single-line URL linking. |
| [`floating-toolbar-polish.md`](floating-toolbar-polish.md) | draft | P3 | Add heading-mark toggle and `#` selection-extract to the floating editor toolbar. |
| [`embed-strategy.md`](embed-strategy.md) | draft | P3 | Decide between live iframe embeds, locally-cached metadata embeds, or removing the embed schema fields. |
| [`agent-oauth-providers.md`](agent-oauth-providers.md) | draft | P2 | OAuth sign-in (Anthropic Pro/Max, GitHub Copilot, OpenAI Codex) + managed credentials (Bedrock AWS, Vertex ADC) for provider settings; today everything is modeled as a pasteable API key. |
| [`agent-past-chats.md`](agent-past-chats.md) | in-progress | P1 | Single `past_chats` tool (recent + search + read modes) backed by the event store, user-message/search indexes, and visible transcript filtering. Foundational agent infrastructure. |
| [`node-line-editor-unification.md`](node-line-editor-unification.md) | in-progress | P1 | Unify the two node-line editors (inline `RichTextEditor` + `TrailingInput`). Phase 1 (shared paste classifier, #11) and Phase 2a (shared view helpers, #12) shipped; Phase 2b is the `resolveTargetId` trigger-application rewrite. |
| [`node-line-editor-core-design.md`](node-line-editor-core-design.md) | design | P1 | Build contract for Phase 2b of the unification: shared pure modules over a monolithic hook; trigger application routed through `resolveTargetId`. |
| [`node-line-editor-step1-extraction.md`](node-line-editor-step1-extraction.md) | done | P1 | Step 1: extract shared node-line trigger detection + structural keymap resolvers as pure modules (#16). |
| [`node-line-editor-step2-eager-materialization.md`](node-line-editor-step2-eager-materialization.md) | done | P1 | Step 2: eager-materialize the trailing draft row — client-proposed node id + materialize undo grouping; type-to-create with no editor remount (#16). |
| [`keyboard-shortcut-parity.md`](keyboard-shortcut-parity.md) | done | P2 | Nodex shortcut audit completed; remaining gaps shipped for empty-selection Cmd+A, go-to-today, nav-history keys, and selected option-reference menu navigation. |
| [`agent-tool-permissions.md`](agent-tool-permissions.md) | implemented | P0 | **Authority for agent permissions.** One global runtime-owned policy (allow/ask/deny by action kind), platform hard blocks, a classifier-backed `ask` resolver with a strict auto-allow eligibility bound, fail-closed rule validation, sensitive-data exfiltration redlines, and a defined interactive/unattended fail-safe. Supersedes the two plans below. Shipped in #60. |
| [`agent-tool-permissions-hardening.md`](agent-tool-permissions-hardening.md) | draft | P2 | Non-blocking follow-ups after #60: move the `sessionApproved` short-circuit below configured-ask, re-validate pre-shaped configs, extend the exfil redline to interpreter/ssh sinks + bare `id_ecdsa`/`id_dsa`, collapse the dual `approval.*`/`tool.permission.*` event vocabulary, and align denied-reason literals with the plan contract. None is a live fail-open. |
| [`agent-scheduled-routines.md`](agent-scheduled-routines.md) | draft | P2 | Proactive agent **`command` NodeType**: node content is an NL brief; setting its user-only-writable `date` (anchor + optional `RRULE` recurrence — decision **B1**, recurrence lives on the generic date field) arms an offline anacron scheduler. The user-only `date` write is the entire safety surface. |
| [`agent-permissions.md`](agent-permissions.md) | shelved | P0 | Superseded by `agent-tool-permissions.md`. Earlier per-area allow/ask/deny matrix + sensitive-path catalog + once/session/always rules; kept as background. |
| [`agent-reversible-execution.md`](agent-reversible-execution.md) | shelved | P0 | Superseded by `agent-tool-permissions.md`. Reversibility-first foundation (checkpoint/undo engine + `reversible ⇒ allow, else ask`); reversibility is now a descriptor/policy input, not the primary gate. |
| [`native-feel-remediation.md`](native-feel-remediation.md) | in-progress | P1 | Make the Electron app feel native (macOS + Windows) without leaving Electron. 6 stages: security shell (#43), startup/window (#45), cursor/font + material (#46, #47), native interactions — dialogs + settings window (#48, #49), IPC tracing + incremental core (#50, #52) and renderer perf (#54) shipped; packaging/smoke (stage 6) remains. |
| [`design-system-rollout.md`](design-system-rollout.md) | draft | P1 | Stage the design-system.md target into code: two-theme alpha-on-ink tokens + dark mode, Electron material/vibrancy + nativeTheme toggle, neutral-functional component migration, and the floating-rails shell redesign (full-height sidebar, per-pane headers, no global tabs, right-side agent toggle). |
| [`native-feel-ui-audit.md`](native-feel-ui-audit.md) | draft | P1 | Verified native-feel + UI audit (Claude + Codex, at `d9f1fa8`) turned into 9 dev-agent work packages. Closes real gaps the remediation index over-claims as shipped (focus rings, native menus, cursor pass) plus a11y media queries, inactive-window state, overlay materials/elevation, dark-mode `@media` migration, design-system guard-test rot, and spec reconciliation. Records the D4/D1/X1-X2 decisions. |
| [`nodex-parity-decisions.md`](nodex-parity-decisions.md) | meta | — | Catalog of nodex features we explicitly will not port and why. |

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
