# Command Protocol

All document mutations are Electron IPC commands backed by the TypeScript core
in `src/core`.

## MVP Commands

- `init_workspace`
- `get_projection`
- `create_node`
- `split_node`
- `update_node_text`
- `merge_node_into`
- `move_node`
- `indent_node`
- `outdent_node`
- `trash_node`
- `restore_node`
- `delete_node`
- `toggle_done`
- `cycle_done_state`
- `batch_cycle_done_state`
- `undo`
- `redo`

## Knowledge Model Commands

- `create_tag`
- `apply_tag`
- `remove_tag`
- `create_field_def`
- `set_tag_config`
- `set_field_config`
- `create_inline_field`
- `create_inline_field_after_node`
- `register_collected_option`
- `select_field_option`
- `add_reference`
- `replace_node_with_reference`
- `ensure_date_node`
- `ensure_tag_search`
- `search_nodes`
- `backlinks`

Every mutating command persists the workspace snapshot before returning.
