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
| [`agent-past-chats.md`](agent-past-chats.md) | in-progress | P1 | Single `past_chats` tool (recent + search + read modes) backed by the event store, user-message/search indexes, and visible transcript filtering. Foundational agent infrastructure. |
| [`node-line-editor-unification.md`](node-line-editor-unification.md) | in-progress | P1 | Unify the two node-line editors (inline `RichTextEditor` + `TrailingInput`). Phase 1 (shared paste classifier, #11) and Phase 2a (shared view helpers, #12) shipped; Phase 2b is the `resolveTargetId` trigger-application rewrite. |
| [`node-line-editor-core-design.md`](node-line-editor-core-design.md) | design | P1 | Build contract for Phase 2b of the unification: shared pure modules over a monolithic hook; trigger application routed through `resolveTargetId`. |
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
