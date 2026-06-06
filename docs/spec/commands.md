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
  follow-ups, steering, provider settings, debug snapshots, subagent control.

The renderer calls them through `window.lin.invoke(...)` via
[`src/renderer/api/client.ts`](../../src/renderer/api/client.ts).

## Categories

### Document — tree and editing
`init_workspace`, `get_projection`, `create_node`, `create_rich_text_node`,
`create_tagged_node`, `create_tag_and_tagged_node`, `create_nodes_from_tree`,
`create_capture`, `paste_nodes_into_node`, `split_node`, `apply_node_text_patch`,
`update_node_description`, `merge_node_into`, `move_node`, `batch_move_nodes`,
`indent_node`, `outdent_node`.

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

### Document — node presentation
`set_node_checkbox_visible`, `set_node_icon`, `set_node_banner`.

### Document — view configuration
`set_view_toolbar_visible`, `set_view_mode`, `add_sort_rule`, `update_sort_rule`,
`remove_sort_rule`, `clear_sort_rules`, `add_filter_rule`, `update_filter_rule`,
`remove_filter_rule`, `clear_filter_rules`, `set_group_field`,
`add_display_field`, `update_display_field`, `remove_display_field`.

### Document — knowledge model (tags and fields)
`create_tag`, `apply_tag`, `remove_tag`, `set_tag_config`, `set_field_config`,
`create_field_def`, `create_inline_field`, `create_inline_field_after_node`,
`reuse_field_definition`, `register_collected_option`,
`create_collected_field_option`, `select_field_option`, `clear_field_value`.

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

### Document — search and dates
`search_nodes`, `backlinks`, `ensure_date_node`, `ensure_tag_search`,
`create_search_node`, `set_search_node`, `set_search_query_outline`,
`refresh_search_node_results`.

### Document — history
`undo`, `redo`.

### Agent — conversations and persistence
`agent_restore_latest_conversation`, `agent_restore_conversation`,
`agent_create_conversation`, `agent_list_conversations`,
`agent_rename_conversation`, `agent_delete_conversation`,
`agent_close_conversation`, `agent_reset_conversation`.

### Agent — messaging
`agent_send_message`, `agent_edit_message`, `agent_regenerate_message`,
`agent_retry_message`, `agent_switch_branch`, `agent_queue_follow_up`,
`agent_clear_follow_up`, `agent_steer_conversation`, `agent_clear_steer`,
`agent_stop_conversation`.

### Agent — subagents
`agent_subagent_status`, `agent_subagent_send`, `agent_subagent_stop`.

### Agent — debug
`agent_debug_snapshot`, `agent_debug_history`, `agent_debug_totals`,
`agent_debug_payload`, `agent_payload_text`.

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
- `NodeType` reserves `command` plus `CommandNode.command`,
  `CommandNode.commandSchedule`, `CommandNode.sysLastRunAt`, and
  `NodeBase.protectedFields` for scheduled-routines work. They are protocol
  surface only until the scheduler ships.
- When adding or renaming a command, update `DOCUMENT_COMMANDS` or
  `AGENT_COMMANDS` and the matching dispatcher in `src/main/documentService.ts`
  (and `src/main/agentRuntime.ts` for agent commands). Update this category
  list when adding a whole new category, not for individual additions.
