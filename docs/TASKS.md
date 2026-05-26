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
| Claude Code 2 | `lin-outliner-cc-2/` | — | idle |
| Codex | `lin-outliner-codex/` | — | idle |

## In progress

- **agent-past-chats** (P1, Codex) — `past_chats` recall tool (recent + search
  + read) backed by the event store. Recall tool and tool-UI polish landed
  (PRs #1, #4); see `docs/plans/agent-past-chats.md` for remaining scope.

## Backlog

Ordered by priority; lower items may depend on higher ones.

- **file-attachments** (P1) — `attachment` node type for arbitrary local files
  (plugs into `BlockNodeRow` via `renderBlockBody` + `isBlockNodeType`).
- **media-types** (P2) — audio/video players + PDF thumbnail on the
  `BlockNodeRow` shell; `serve()` needs a streaming/range response for large
  media (current whole-file read is image-only).
- **asset-gc** (P2) — asset `index.json` rebuild + garbage collection for
  orphaned assets; drag-from-Finder ingest; inline alt-text editing.
- **agent-image-awareness** (P2) — surface `image` nodes in the agent
  projection so the agent can read/insert them.
- **floating-toolbar-polish** (P3) — heading-mark toggle + `#` selection
  extract in the floating editor toolbar.
- **view-toolbar-name-filter** (P3) — quick incremental name filter as the
  view toolbar's first control (Tana-style); needs backend/data-model support.
  Optional follow-ons: `is_not` for options filters; relative-date operands.
- **node-line-editor-unification Phase 2b** (P1) — route trigger application
  through `resolveTargetId` so `#`/`@`/`/` behave identically across the inline
  editor and the trailing line, unify the trigger popover on `NodePanel`, and
  delete the trailing input's bespoke `onApply*Trigger` props. High-risk
  reconciliation of the hot node-creation path; verify with the app running
  against the `outliner-*` Playwright e2e specs. Build contract:
  `docs/plans/node-line-editor-core-design.md` (PR #13). Phase 1 (#11) and
  Phase 2a view helpers (#12) shipped; eager-materialized trailing draft is
  in flight on `cc/node-line-editor-core-impl` (PR #14, pending rebase).
- **embed-strategy** (P3) — decide live iframe vs cached-metadata embeds.
- **past-chats-output-polish** (P3) — minor cleanups deferred from PR #7:
  (1) drop the now-redundant `returned_items` / `returned_hits` / `message_count`
  counts in `visiblePastChatsResult` (derivable from the inline arrays);
  (2) avoid `isJsonText` re-parsing on every render in `AgentToolCallBlock`
  (compute once in the memoized `resultParts`); (3) give `visiblePastChatsResult`
  a named return type instead of `unknown`. None affect behavior.

## Recently completed

- **node-line-editor-unification Phase 2a** (P1, cc) — shared `nodeLineView.ts`
  view helpers (`caretAnchor`, `selectionTextOffsets`, unified inline-ref-aware
  `selectionForPlacement` / `applyCursorPlacement`); `RichTextEditor` and
  `TrailingInput` both delegate. Behavior-preserving, unit-test-pinned (PR #12).
- **node-line-editor-core-design** (P1, cc) — Phase 2b build contract doc:
  drop the monolithic `useNodeLineEditor` hook in favor of shared pure modules,
  route trigger application through `resolveTargetId` (PR #13).
- **agent-composer-inline-references** (P1, Codex) — replace the agent composer
  textarea with a ProseMirror editor: slash commands, inline node references
  (rendered consistently in user/assistant/tool output with Cmd/Ctrl-click
  open-in-new-tab), inline file references, paste/drop + native-picker file
  attachments (sent inline as base64 to the model via `lin:pick-local-files`;
  distinct from the persisted asset store). Adds `core/nodeReferenceMarkup`
  and tightens agent node-tool visibility/guidance (PR #15).
- **node-line-editor-unification Phase 1** (P2) — shared `classifyMediaPaste`
  classifier for the image / media-URL / link-URL paste front-matter; both
  `RichTextEditor` and `TrailingInput` call it, deleting duplicated paste
  routing. Behavior-preserving (PR #11).
- **media-url-sources** (P1) — `image` nodes now take exactly one of a local
  `assetId` or a remote `mediaUrl`; `mediaSource()` resolves either for the
  view. Pasting a lone http(s) image URL makes a remote image node (with a
  selection it links the text instead). Renamed the protocol `lin-asset://` →
  `asset://` (centralized in `core/assets.ts`; no data migration — only the
  bare id persists). `mediaUrl` is validated http(s) at the core boundary and
  `open_external_url` (PR #10).
- **asset-subsystem + image-rendering** (P0/P1) — local asset store
  (`assetService`: ingest/lookup/serve/delete, MIME sniff, dimension probe,
  path-traversal-safe ids) behind a privileged `asset://` protocol, plus
  inline `image` nodes on a reusable focusable `BlockNodeRow` shell (the
  foundation future media types plug into via `renderBlockBody` +
  `isBlockNodeType`). Clipboard paste + `/image` picker ingest; hover toolbar
  (caption / lightbox / open-original); caption = node description (PR #8).
- **view-toolbar-redesign** (P2) — per-node view toolbar reworked against
  Tana: inline panels → anchored popovers (no row-list shift), removed the
  fake Table/Cards/Calendar "View as" switcher, progressive type-aware filter
  editors (boolean/options/date/number/text), date-aware `rowMatchesFilter`,
  field-semantic group labels / sort directions / active-state summary, plus
  token-correct controls (PR #9).
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
