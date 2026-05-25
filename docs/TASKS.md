# Tasks

Single source of truth for in-flight and upcoming work across the three
clones. **Owned by the main agent** (`lin-outliner/`). Dev agents
(`lin-outliner-cc`, `lin-outliner-codex`) read this but do not edit it — the
main agent updates it on merge.

`docs/plans/` holds the detailed design for each item; this board is the
short, current view of who-is-doing-what. See `AGENT.md` / `CLAUDE.md` for the
workflow.

## Agent status

| Agent | Clone | Active branch | Current task |
|-------|-------|---------------|--------------|
| main | `lin-outliner/` | `main` | Review / merge / integration |
| Claude Code | `lin-outliner-cc/` | — | idle |
| Codex | `lin-outliner-codex/` | — | `agent-past-chats` |

## In progress

- **agent-past-chats** (P1, Codex) — `past_chats` recall tool (recent + search
  + read) backed by the event store. Recall tool and tool-UI polish landed
  (PRs #1, #4); see `docs/plans/agent-past-chats.md` for remaining scope.

## Backlog

Ordered by priority; lower items may depend on higher ones.

- **asset-subsystem** (P0) — local content-addressed asset store +
  `lin-asset://` protocol. Blocks image / attachment / embed work.
- **image-rendering** (P1) — render `image` nodes inline; paste/drag ingestion
  (depends on asset-subsystem).
- **file-attachments** (P1) — `attachment` node type for arbitrary local files.
- **floating-toolbar-polish** (P3) — heading-mark toggle + `#` selection
  extract in the floating editor toolbar.
- **embed-strategy** (P3) — decide live iframe vs cached-metadata embeds.
- **past-chats-output-polish** (P3) — minor cleanups deferred from PR #7:
  (1) drop the now-redundant `returned_items` / `returned_hits` / `message_count`
  counts in `visiblePastChatsResult` (derivable from the inline arrays);
  (2) avoid `isJsonText` re-parsing on every render in `AgentToolCallBlock`
  (compute once in the memoized `resultParts`); (3) give `visiblePastChatsResult`
  a named return type instead of `unknown`. None affect behavior.

## Recently completed

- **paste-handling** (P2) — structure-aware clipboard paste: inline marks,
  fenced code → `codeBlock`, rich HTML routing, single-line URL linking
  (PR #5).
- **code-block-editor** (P2) — dedicated `codeBlock` editor with Shiki
  highlighting, language picker, horizontal scroll, cross-row selection
  (PR #2).
- **agent-past-chats** groundwork — recall tool + transcript UI (PRs #1, #4).
  past_chats now returns one self-contained JSON; tool-call JSON is
  Shiki-highlighted and renders identically live vs. reloaded (PR #7).
- **dev-workflow** — three-clone hub model (main + cc + codex), merge gating,
  this board.
