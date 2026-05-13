# Command Protocol

All document mutations are Tauri commands backed by `lin-core`.

## MVP Commands

- `init_workspace`
- `get_projection`
- `create_node`
- `split_node`
- `update_node_text`
- `merge_node_into_previous`
- `move_node`
- `indent_node`
- `outdent_node`
- `trash_node`
- `restore_node`
- `delete_node`
- `toggle_done`
- `undo`
- `redo`

## Knowledge Model Commands

- `create_tag`
- `apply_tag`
- `remove_tag`
- `create_field_def`
- `set_field_value`
- `add_reference`
- `ensure_date_node`
- `search_nodes`
- `backlinks`

Every mutating command persists the workspace snapshot before returning.
