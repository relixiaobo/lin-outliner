# Command Protocol

All document mutations and agent runtime calls are Electron IPC commands backed
by the TypeScript core in `src/core` and the main process in `src/main`.

## Source of Truth

The authoritative list lives in [`src/core/commands.ts`](../../src/core/commands.ts):

- `DOCUMENT_COMMANDS` — document tree, rich text, fields, tags, references,
  search nodes, view config, batch ops, undo/redo. Every mutating command
  persists the workspace snapshot and returns a `CommandOutcome` with the new
  `DocumentProjection` and optional `FocusHint`.
- `AGENT_COMMANDS` — agent session lifecycle, message send/edit/regenerate,
  follow-ups, steering, provider settings, debug snapshots, child-run control.
- `ASSET_COMMANDS` — asset ingest, lookup, native pickers, safe system file
  actions, and external URL opening. Asset commands never mutate document state;
  renderer flows pair them with document commands when a picked/dropped file
  should appear in the outline.

The renderer calls them through `window.lin.invoke(...)` via
[`src/renderer/api/client.ts`](../../src/renderer/api/client.ts).

## Categories

### Document — tree and editing
`init_workspace`, `get_projection`, `create_node`, `create_rich_text_node`,
`create_tagged_node`, `create_tag_and_tagged_node`, `create_nodes_from_tree`,
`create_capture`, `paste_nodes_into_node`, `split_node`, `apply_node_text_patch`,
`update_node_description`, `merge_node_into`, `move_node`, `batch_move_nodes`,
`indent_node`, `outdent_node`.

`create_nodes_from_tree` materializes a typed `CreateNodeTree` recursively,
including content, optional descriptions, code block language, tags, fields, and
task checkbox state. It is the bulk structural path for paste and import.

`create_capture` atomically creates one launcher-capture node: a plain node
carrying a hidden, typed `capture` provenance sidecar (`CaptureNodeMetadata` on
`NodeBase.capture`) plus the source projected into native outline shape — a
capture-kind tag (rolling up to `#capture`) and typed fields (URL / Author /
Published) — in a single transaction so undo/redo stays coherent. The sidecar is
system-owned JSON, hidden from outline rendering and default full-text search; the
outline projection is the readable/searchable surface. The launcher invokes this
through the `launcher:*` main-process IPC (not the renderer command client) so the
renderer can't supply the source metadata. See [`launcher.md`](launcher.md).

### Document — batch operations on a row selection
`batch_trash_nodes`, `batch_indent_nodes`, `batch_outdent_nodes`,
`batch_toggle_done`, `batch_cycle_done_state`, `batch_duplicate_nodes`,
`batch_move_nodes`, `batch_move_nodes_up`, `batch_move_nodes_down`,
`batch_apply_tag`.

### Document — done state and trash
`toggle_done`, `cycle_done_state`, `trash_node`, `restore_node`, `delete_node`.

`trash_node` / `batch_trash_nodes` move live nodes into Trash and preserve a
restore location. `restore_node` moves one trashed node back to that remembered
location when possible. `delete_node` is the permanent removal command: the UI
exposes it only from Trash affordances such as **Delete forever** and **Empty
Trash**, both guarded by confirmation.

### Document — node presentation
`set_node_checkbox_visible`, `set_node_icon`, `set_node_banner`,
`create_image_node`, `set_node_image`, `create_attachment_node`.

`create_image_node(parentId, index, source)` creates a block image row from
either a local `assetId` or an `http(s)` `mediaUrl` and persists optional image
dimensions. `set_node_image(nodeId, source)` converts an existing plain content
row into the same image node shape.

`create_attachment_node(parentId, index, metadata)` creates a block attachment
row. It requires a local `assetId`, MIME type, original filename, and byte size;
optional `thumbnailAssetId`, `pdfPageCount`, `audioDurationMs`, and
`videoDurationMs` are copied from asset metadata. Image MIME types are rejected
here because they use the image-node commands.

### Document — view configuration
`set_view_toolbar_visible`, `set_view_mode`, `add_sort_rule`, `update_sort_rule`,
`remove_sort_rule`, `clear_sort_rules`, `add_filter_rule`, `update_filter_rule`,
`remove_filter_rule`, `clear_filter_rules`, `set_group_field`,
`add_display_field`, `update_display_field`, `remove_display_field`.

`add_display_field` accepts either an existing field id or a new field name/type.
The latter creates the field definition and display-field node in one mutation.
Adding an already configured field reveals its existing display node rather than
creating a duplicate. New display fields receive the next finite display order.
`update_display_field` may move a column left or right; the move and sibling-order
normalization are one mutation.

### Document — knowledge model (tags and fields)
`create_tag`, `apply_tag`, `remove_tag`, `set_tag_config`, `set_field_config`,
`create_field_def`, `create_inline_field`, `create_inline_field_after_node`,
`reuse_field_definition`, `register_collected_option`,
`create_collected_field_option`, `select_field_option`,
`set_field_free_text_value`, `clear_field_value`, `remove_field_value`.

`create_inline_field` may receive an existing `targetDefId`. That form validates
the definition, rejects a duplicate field on the owner, and creates only the
field entry in one mutation. Table uses it to materialize an absent field cell
without minting a throwaway definition or issuing a second relink command.

User tag and field definitions are reusable only while they are active: the
definition node must exist, have the expected `tagDef` / `fieldDef` type, and not
live in the Trash subtree. Applying a tag, creating a tagged node, reusing a field
definition, configuring definitions, and selecting `options_from_supertag` values
all reject trashed definitions. Name-based creation ignores trashed same-name
definitions and creates a fresh active definition under Schema.

`reuse_field_definition(entryId, targetDefId)` repoints a field entry at an
existing definition instead of the throwaway draft `>` minted, dropping the now
-orphaned draft def. `targetDefId` is either a real `fieldDef` node (reuse a
user field) or a `sys:*` id (a built-in system field with no backing node — value
derived from the owner). When `targetDefId` is a system field, the entry's stored
value children are also dropped (the value is computed, not stored). Most system
fields render read-only; `sys:done` is the exception — a read-write checkbox that
toggles the owner node's done state.

### Document — references
`add_reference`, `add_reference_conversion`, `set_reference_target`,
`replace_node_with_reference`, `replace_node_with_reference_conversion`,
`replace_node_with_inline_reference`, `convert_reference_to_inline_node`,
`restore_inline_reference_node_to_reference`.

The generic reference commands also operate under a plain field entry. A
whole-row field value is therefore a normal `reference` child, not a separate
field type or command surface.

### Document — search and dates
`search_nodes`, `backlinks`, `ensure_date_node`, `ensure_tag_search`,
`create_search_node`, `set_search_node`, `set_search_query_outline`,
`refresh_search_node_results`.

### Document — composer references

Sending an outliner node to the agent composer is a renderer-only draft action.
It inserts the node as a structured composer reference, equivalent to an
`@node` mention, and does not mutate the document, create an Issue, or start
execution.

The composer remains the intent surface. If the user or agent wants work to
exist durably, the agent creates or updates an Issue or Recurring Issue through
the agent work tools. If execution should start, an Agent Session starts from the
Issue trigger or from an explicit `agent_session_start` call.

### Document — history
`undo`, `redo`.

### Assets
`ingest_asset`, `ingest_local_file`, `lookup_asset`, `delete_asset`,
`pick_image_files`, `pick_attachment_files`, `open_asset`, `reveal_asset`,
`copy_asset_file`, `open_external_url`.

`ingest_asset` stores bytes under the workspace asset directory and returns
`AssetMetadata`. It derives image dimensions, PDF page count, audio/video
duration when the format is locally parseable, and a best-effort first-page PDF
thumbnail when the platform thumbnail tool is available. MIME type is resolved
from file signatures or filename extension first, then from a renderer hint when
present, falling back to `application/octet-stream`.

`ingest_local_file` is the ingest bridge for agent-produced files (agent-file-model
F4): it path-ingests a file into the asset store and returns `AssetMetadata`, but
**only** when the path resolves inside the agent's trusted roots
(workdir/scratch) via `resolveTrustedLocalFileReference` — the same gate that backs
previewing those file chips. The renderer can thus only ingest a file it could
already preview, so this does not reopen the arbitrary-local-file read primitive
that `ingest_asset`'s buffer-only-over-IPC rule guards against. Directories and
gone/out-of-root paths return `null`.

`pick_image_files` and `pick_attachment_files` open native file pickers in the
main process and ingest selected regular files before returning metadata to the
renderer. The renderer decides whether each asset becomes an image node or an
attachment node.

`open_asset`, `reveal_asset`, and `copy_asset_file` operate only on files whose
resolved real path remains inside the asset directory. `open_asset` additionally
uses the local-file open policy before handing the file to the OS. `reveal_asset`
reveals the asset copy in Finder; `copy_asset_file` copies both a text path and,
where supported, a native file URL/file-list flavor to the clipboard.

### Agent — conversations and persistence
`agent_restore_latest_conversation`, `agent_restore_conversation`,
`agent_create_conversation`, `agent_list_conversations`,
`agent_rename_conversation`, `agent_delete_conversation`,
`agent_close_conversation`, `agent_reset_conversation`.

The conversation surface is product-shaped around one Channels list:
`agent_list_conversations` returns `#General`, protected `#Dream`, and
user-created named Channels. The reserved `#General` Channel
(`lin-agent-channel-general`, `title/goal = General`) is ensured by the runtime
and sorted first. It stores no conversation `kind` and cannot be renamed,
deleted, or manually membership-edited through ordinary conversation commands.
The protected `#Dream` Channel is likewise immutable and rejects ordinary chat.
The Agent Dock default selection restores a remembered valid Channel first, then
falls back to `#General`.
`agent_create_conversation` is the user-facing New Channel command: title is
optional, blank creation stores the untitled display sentinel, and creation does
not accept an opening message. `agent_rename_conversation` accepts a blank title
and restores the untitled display sentinel. Ordinary Channels can be renamed and
deleted when they have no active Run and are not referenced by active Issue
routing; protected default Channels cannot be deleted.

### Agent — messaging
`agent_send_message`, `agent_edit_message`, `agent_regenerate_message`,
`agent_retry_message`, `agent_switch_branch`, `agent_queue_follow_up`,
`agent_clear_follow_up`, `agent_steer_conversation`, `agent_clear_steer`,
`agent_stop_conversation`.

In a **DM**, `agent_send_message` resolves when the serial run settles (the
command spans the turn). In a **Channel** it **resolves on
acceptance**: it persists the user message and enqueues the addressed turns, then
returns without awaiting them — the runs drain asynchronously (`scheduleChannelIdleEmit`
emits the final idle projection on drain). `agent_edit_message`/`agent_regenerate_message`/
`agent_retry_message` follow the same DM-vs-Channel contract. `agent_steer_conversation`
is DM-only; Channels have no steer (a send while runs work dispatches a new addressed
turn). See `agent-architecture.md` (Channel runtime).

### Agent — Issue work
`agent_issue_search`, `agent_issue_read`, `agent_issue_complete_human_review`,
`agent_session_read`, `agent_session_transcript`.

These renderer IPC commands back the Issue-first Work surface.
`agent_issue_search` returns lightweight Issue and Recurring Issue rows;
`agent_issue_read` loads one durable work object and explicitly requested detail
slices; and `agent_session_read` returns bounded Agent Session state and
Activity. The renderer requests those commands through the ordinary preload
bridge and does not read the Issue store directly.

`agent_issue_complete_human_review` is the narrow renderer-to-main mutation for
the Work detail `Accept and complete` action. It accepts an Issue id plus expected
revision, records the local user actor, and succeeds only for a human-review Issue
with a completed execution Session. It is not a model-facing agent tool.

`agent_session_transcript` is a renderer-only drill-in command. It accepts an
Agent Session id, resolves the internal execution binding in the main process,
and returns the bound Run detail and transcript needed by the existing
conversation turn renderer. It is not an agent tool. The model-facing
`agent_session_read` tool cannot request or receive a transcript or Run id.

### Agent — delegated runs
`agent_run_detail`, `agent_run_transcript`, `agent_run_status`,
`agent_run_steer`, `agent_run_amend`, `agent_run_stop`.
`agent_run_transcript` replays the run's own ledger for the drill-in transcript.
`agent_run_detail` reads Run meta, ancestor breadcrumb metadata, the latest result
submission, and direct sub-run metadata from the Run index.
Runtime control surfaces use only the `agent_run_*` command names; the older
pre-release child-run command aliases are not accepted.

### Agent — debug
`agent_debug_view` (the conversation's run list + rollups), `agent_debug_run`
(one run's model-facing context, process, usage, and per-run snapshot),
`agent_payload_text`.

### Agent — providers and runtime settings
`agent_get_provider_settings`, `agent_update_runtime_settings`,
`agent_upsert_provider_config`, `agent_delete_provider_config`,
`agent_set_active_provider`, `agent_set_provider_api_key`,
`agent_delete_provider_api_key`, `agent_get_provider_secret_status`.

## Conventions

- A renderer module never mutates document state directly. UI changes that
  affect document content or tree structure must go through a command.
- Every mutating command persists the workspace snapshot before returning, and
  produces a `CommandOutcome` carrying the projection plus an optional
  `FocusHint` so the caller can restore focus deterministically.
- Origins are tagged on the underlying Loro transaction (`user:`, `agent:`,
  `system:`) so the scoped `UndoManager` can separate user undo from agent
  undo. See `src/core/loroDocument.ts`.
- `NodeType` is content-oriented. It does not include a work/execution node type;
  scheduling and execution are owned by Issue / Recurring Issue / Agent Session
  runtime state.
- When adding or renaming a command, update `DOCUMENT_COMMANDS` or
  `AGENT_COMMANDS` and the matching dispatcher in `src/main/documentService.ts`
  (and `src/main/agentRuntime.ts` for agent commands). Update this category
  list when adding a whole new category, not for individual additions.
