use lin_core::{
    Backlink, CommandOutcome, Core, CreateNodeTree, DocumentProjection, DocumentState,
    FieldConfigPatch, FieldType, FilterOp, RichText, SearchHit, SortDirection, TagConfigPatch,
};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, State};
use thiserror::Error;

const WORKSPACE_FILE: &str = "workspace.json";

struct AppCore {
    core: Mutex<Core>,
}

#[derive(Debug, Error)]
enum AppError {
    #[error(transparent)]
    Core(#[from] lin_core::CoreError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("failed to resolve app data directory")]
    AppDataDir,
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

type AppResult<T> = Result<T, AppError>;

#[tauri::command]
fn init_workspace(app: AppHandle, state: State<'_, AppCore>) -> AppResult<DocumentProjection> {
    let loaded = load_core(&app)?;
    let mut core = state.core.lock().expect("core mutex poisoned");
    *core = loaded;
    Ok(core.projection())
}

#[tauri::command]
fn get_projection(state: State<'_, AppCore>) -> AppResult<DocumentProjection> {
    let mut core = state.core.lock().expect("core mutex poisoned");
    Ok(core.projection())
}

#[tauri::command]
fn create_node(
    app: AppHandle,
    state: State<'_, AppCore>,
    parent_id: String,
    index: Option<usize>,
    text: String,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.create_node(&parent_id, index, text))
}

#[tauri::command]
fn create_nodes_from_tree(
    app: AppHandle,
    state: State<'_, AppCore>,
    parent_id: String,
    nodes: Vec<CreateNodeTree>,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| {
        core.create_nodes_from_tree(&parent_id, nodes)
    })
}

#[tauri::command]
fn paste_nodes_into_node(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_id: String,
    content: RichText,
    children: Vec<CreateNodeTree>,
    siblings_after: Vec<CreateNodeTree>,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| {
        core.paste_nodes_into_node(&node_id, content, children, siblings_after)
    })
}

#[tauri::command]
fn split_node(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_id: String,
    before: RichText,
    after: RichText,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.split_node(&node_id, before, after))
}

#[tauri::command]
fn update_node_text(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_id: String,
    content: RichText,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.update_node_text(&node_id, content))
}

#[tauri::command]
fn update_node_description(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_id: String,
    description: Option<String>,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| {
        core.update_node_description(&node_id, description)
    })
}

#[tauri::command]
fn set_node_toolbar_visible(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_id: String,
    visible: bool,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| {
        core.set_node_toolbar_visible(&node_id, visible)
    })
}

#[tauri::command]
fn set_node_sort(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_id: String,
    field: Option<String>,
    direction: Option<SortDirection>,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| {
        core.set_node_sort(&node_id, field, direction)
    })
}

#[tauri::command]
fn set_node_filter(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_id: String,
    field: Option<String>,
    op: Option<FilterOp>,
    values: Vec<String>,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| {
        core.set_node_filter(&node_id, field, op, values)
    })
}

#[tauri::command]
fn set_node_group(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_id: String,
    field: Option<String>,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.set_node_group(&node_id, field))
}

#[tauri::command]
fn merge_node_into(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_id: String,
    target_id: String,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| {
        core.merge_node_into(&node_id, &target_id)
    })
}

#[tauri::command]
fn move_node(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_id: String,
    parent_id: String,
    index: Option<usize>,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| {
        core.move_node(&node_id, &parent_id, index)
    })
}

#[tauri::command]
fn indent_node(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_id: String,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.indent_node(&node_id))
}

#[tauri::command]
fn outdent_node(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_id: String,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.outdent_node(&node_id))
}

#[tauri::command]
fn trash_node(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_id: String,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.trash_node(&node_id))
}

#[tauri::command]
fn batch_trash_nodes(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_ids: Vec<String>,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.batch_trash_nodes(node_ids))
}

#[tauri::command]
fn batch_indent_nodes(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_ids: Vec<String>,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.batch_indent_nodes(node_ids))
}

#[tauri::command]
fn batch_outdent_nodes(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_ids: Vec<String>,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.batch_outdent_nodes(node_ids))
}

#[tauri::command]
fn batch_toggle_done(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_ids: Vec<String>,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.batch_toggle_done(node_ids))
}

#[tauri::command]
fn batch_duplicate_nodes(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_ids: Vec<String>,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.batch_duplicate_nodes(node_ids))
}

#[tauri::command]
fn batch_move_nodes_up(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_ids: Vec<String>,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.batch_move_nodes_up(node_ids))
}

#[tauri::command]
fn batch_move_nodes_down(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_ids: Vec<String>,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.batch_move_nodes_down(node_ids))
}

#[tauri::command]
fn batch_apply_tag(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_ids: Vec<String>,
    tag_id: String,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.batch_apply_tag(node_ids, &tag_id))
}

#[tauri::command]
fn restore_node(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_id: String,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.restore_node(&node_id))
}

#[tauri::command]
fn delete_node(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_id: String,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.delete_node(&node_id))
}

#[tauri::command]
fn toggle_done(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_id: String,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.toggle_done(&node_id))
}

#[tauri::command]
fn create_tag(
    app: AppHandle,
    state: State<'_, AppCore>,
    name: String,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.create_tag(&name))
}

#[tauri::command]
fn apply_tag(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_id: String,
    tag_id: String,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.apply_tag(&node_id, &tag_id))
}

#[tauri::command]
fn remove_tag(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_id: String,
    tag_id: String,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.remove_tag(&node_id, &tag_id))
}

#[tauri::command]
fn set_tag_config(
    app: AppHandle,
    state: State<'_, AppCore>,
    tag_id: String,
    patch: TagConfigPatch,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.set_tag_config(&tag_id, patch))
}

#[tauri::command]
fn set_field_config(
    app: AppHandle,
    state: State<'_, AppCore>,
    field_id: String,
    patch: FieldConfigPatch,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.set_field_config(&field_id, patch))
}

#[tauri::command]
fn create_field_def(
    app: AppHandle,
    state: State<'_, AppCore>,
    tag_id: String,
    name: String,
    field_type: FieldType,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| {
        core.create_field_def(&tag_id, &name, field_type)
    })
}

#[tauri::command]
fn create_inline_field_after_node(
    app: AppHandle,
    state: State<'_, AppCore>,
    after_node_id: String,
    name: String,
    field_type: FieldType,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| {
        core.create_inline_field_after_node(&after_node_id, &name, field_type)
    })
}

#[tauri::command]
fn create_inline_field(
    app: AppHandle,
    state: State<'_, AppCore>,
    parent_id: String,
    index: Option<usize>,
    name: String,
    field_type: FieldType,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| {
        core.create_inline_field(&parent_id, index, &name, field_type)
    })
}

#[tauri::command]
fn register_collected_option(
    app: AppHandle,
    state: State<'_, AppCore>,
    field_def_id: String,
    name: String,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| {
        core.register_collected_option(&field_def_id, &name)
    })
}

#[tauri::command]
fn select_field_option(
    app: AppHandle,
    state: State<'_, AppCore>,
    field_entry_id: String,
    option_node_id: String,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| {
        core.select_field_option(&field_entry_id, &option_node_id)
    })
}

#[tauri::command]
fn add_reference(
    app: AppHandle,
    state: State<'_, AppCore>,
    parent_id: String,
    target_id: String,
    index: Option<usize>,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| {
        core.add_reference(&parent_id, &target_id, index)
    })
}

#[tauri::command]
fn replace_node_with_reference(
    app: AppHandle,
    state: State<'_, AppCore>,
    node_id: String,
    target_id: String,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| {
        core.replace_node_with_reference(&node_id, &target_id)
    })
}

#[tauri::command]
fn ensure_date_node(
    app: AppHandle,
    state: State<'_, AppCore>,
    year: i32,
    month: u32,
    day: u32,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.ensure_date_node(year, month, day))
}

#[tauri::command]
fn search_nodes(state: State<'_, AppCore>, query: String) -> AppResult<Vec<SearchHit>> {
    let core = state.core.lock().expect("core mutex poisoned");
    Ok(core.search_nodes(&query))
}

#[tauri::command]
fn ensure_tag_search(
    app: AppHandle,
    state: State<'_, AppCore>,
    tag_id: String,
) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.ensure_tag_search(&tag_id))
}

#[tauri::command]
fn backlinks(state: State<'_, AppCore>, target_id: String) -> AppResult<Vec<Backlink>> {
    let core = state.core.lock().expect("core mutex poisoned");
    Ok(core.backlinks(&target_id))
}

#[tauri::command]
fn undo(app: AppHandle, state: State<'_, AppCore>) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.undo())
}

#[tauri::command]
fn redo(app: AppHandle, state: State<'_, AppCore>) -> AppResult<CommandOutcome> {
    mutate_and_save(app, state, |core| core.redo())
}

fn mutate_and_save<F>(app: AppHandle, state: State<'_, AppCore>, f: F) -> AppResult<CommandOutcome>
where
    F: FnOnce(&mut Core) -> lin_core::Result<CommandOutcome>,
{
    let mut core = state.core.lock().expect("core mutex poisoned");
    let outcome = f(&mut core)?;
    save_core(&app, &core)?;
    Ok(outcome)
}

fn workspace_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::AppDataDir)?;
    Ok(dir.join(WORKSPACE_FILE))
}

fn load_core(app: &AppHandle) -> AppResult<Core> {
    let path = workspace_path(app)?;
    if !path.exists() {
        return Ok(Core::new());
    }
    let raw = fs::read_to_string(path)?;
    let state: DocumentState = Core::deserialize_state(&raw)?;
    Ok(Core::from_state(state))
}

fn save_core(app: &AppHandle, core: &Core) -> AppResult<()> {
    let path = workspace_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    atomic_write(&path, core.serialize_state()?.as_bytes())?;
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppCore {
            core: Mutex::new(Core::new()),
        })
        .invoke_handler(tauri::generate_handler![
            init_workspace,
            get_projection,
            create_node,
            create_nodes_from_tree,
            paste_nodes_into_node,
            split_node,
            update_node_text,
            update_node_description,
            set_node_toolbar_visible,
            set_node_sort,
            set_node_filter,
            set_node_group,
            merge_node_into,
            move_node,
            indent_node,
            outdent_node,
            trash_node,
            batch_trash_nodes,
            batch_indent_nodes,
            batch_outdent_nodes,
            batch_toggle_done,
            batch_duplicate_nodes,
            batch_move_nodes_up,
            batch_move_nodes_down,
            batch_apply_tag,
            restore_node,
            delete_node,
            toggle_done,
            create_tag,
            apply_tag,
            remove_tag,
            set_tag_config,
            set_field_config,
            create_field_def,
            create_inline_field_after_node,
            create_inline_field,
            register_collected_option,
            select_field_option,
            add_reference,
            replace_node_with_reference,
            ensure_date_node,
            search_nodes,
            ensure_tag_search,
            backlinks,
            undo,
            redo
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lin Outliner");
}
