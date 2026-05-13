mod error;
mod model;

use chrono::{Datelike, Local};
pub use error::{CoreError, Result};
pub use model::*;
use std::collections::{BTreeMap, HashSet};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct Core {
    state: DocumentState,
    undo_stack: Vec<DocumentState>,
    redo_stack: Vec<DocumentState>,
}

impl Default for Core {
    fn default() -> Self {
        Self::new()
    }
}

impl Core {
    pub fn new() -> Self {
        let mut core = Self {
            state: DocumentState {
                schema_version: 1,
                workspace_id: WORKSPACE_ID.to_string(),
                root_id: WORKSPACE_ID.to_string(),
                nodes: BTreeMap::new(),
            },
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
        };
        core.bootstrap();
        core
    }

    pub fn from_state(mut state: DocumentState) -> Self {
        ensure_system_nodes(&mut state);
        Self {
            state,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
        }
    }

    pub fn state(&self) -> &DocumentState {
        &self.state
    }

    pub fn into_state(self) -> DocumentState {
        self.state
    }

    pub fn serialize_state(&self) -> Result<String> {
        Ok(serde_json::to_string_pretty(&self.state)?)
    }

    pub fn deserialize_state(raw: &str) -> Result<DocumentState> {
        Ok(serde_json::from_str(raw)?)
    }

    pub fn projection(&mut self) -> DocumentProjection {
        let today_id = self.ensure_today_node_no_history();
        self.build_projection(today_id)
    }

    pub fn create_node(
        &mut self,
        parent_id: &str,
        index: Option<usize>,
        text: impl Into<String>,
    ) -> Result<CommandOutcome> {
        let text = text.into();
        self.mutate_with_focus(|state| {
            ensure_parent_mutable(state, parent_id)?;
            let id = fresh_id("node");
            insert_node(
                state,
                id.clone(),
                parent_id.to_string(),
                index,
                None,
                |node| {
                    node.content = RichText::plain(text);
                },
            )?;
            apply_child_tags(state, parent_id, &id)?;
            Ok(Some(FocusHint {
                node_id: id,
                select_all: false,
            }))
        })
    }

    pub fn create_nodes_from_tree(
        &mut self,
        parent_id: &str,
        nodes: Vec<CreateNodeTree>,
    ) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_parent_mutable(state, parent_id)?;
            let mut first_created_id: Option<NodeId> = None;
            for node in nodes {
                let created_id = insert_node_tree(state, parent_id, node)?;
                if first_created_id.is_none() {
                    first_created_id = Some(created_id);
                }
            }
            Ok(first_created_id.map(|node_id| FocusHint {
                node_id,
                select_all: false,
            }))
        })
    }

    pub fn paste_nodes_into_node(
        &mut self,
        node_id: &str,
        content: RichText,
        children: Vec<CreateNodeTree>,
        siblings_after: Vec<CreateNodeTree>,
    ) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_editable(state, node_id)?;
            let parent_id = state
                .nodes
                .get(node_id)
                .and_then(|node| node.parent_id.clone())
                .ok_or(CoreError::NoParent)?;
            let sibling_index = child_index(state, &parent_id, node_id).unwrap_or(0) + 1;
            let now = now_ms();
            {
                let node = state
                    .nodes
                    .get_mut(node_id)
                    .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
                node.content = content;
                node.updated_at = now;
            }

            for child in children {
                insert_node_tree(state, node_id, child)?;
            }

            let mut focus_id = node_id.to_string();
            for (offset, sibling) in siblings_after.into_iter().enumerate() {
                focus_id = insert_node_tree_at(state, &parent_id, Some(sibling_index + offset), sibling)?;
            }

            Ok(Some(FocusHint {
                node_id: focus_id,
                select_all: false,
            }))
        })
    }

    pub fn split_node(
        &mut self,
        node_id: &str,
        before: RichText,
        after: RichText,
    ) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_editable(state, node_id)?;
            let parent_id = state
                .nodes
                .get(node_id)
                .and_then(|node| node.parent_id.clone())
                .ok_or(CoreError::NoParent)?;
            let index = child_index(state, &parent_id, node_id).unwrap_or(0) + 1;
            let now = now_ms();
            {
                let node = state
                    .nodes
                    .get_mut(node_id)
                    .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
                node.content = before;
                node.updated_at = now;
            }
            let new_id = fresh_id("node");
            let tags = state
                .nodes
                .get(node_id)
                .map(|node| node.tags.clone())
                .unwrap_or_default();
            insert_node(
                state,
                new_id.clone(),
                parent_id,
                Some(index),
                None,
                |node| {
                    node.content = after;
                    node.tags = tags;
                },
            )?;
            let tag_ids = state
                .nodes
                .get(&new_id)
                .map(|node| node.tags.clone())
                .unwrap_or_default();
            for tag_id in tag_ids {
                instantiate_tag_template(state, &new_id, &tag_id)?;
            }
            Ok(Some(FocusHint {
                node_id: new_id,
                select_all: false,
            }))
        })
    }

    pub fn update_node_text(&mut self, node_id: &str, content: RichText) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_editable(state, node_id)?;
            let node = state
                .nodes
                .get_mut(node_id)
                .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
            node.content = content;
            node.updated_at = now_ms();
            Ok(Some(FocusHint {
                node_id: node_id.to_string(),
                select_all: false,
            }))
        })
    }

    pub fn update_node_description(
        &mut self,
        node_id: &str,
        description: Option<String>,
    ) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_editable(state, node_id)?;
            let node = state
                .nodes
                .get_mut(node_id)
                .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
            node.description = normalize_optional_text(description);
            node.updated_at = now_ms();
            Ok(Some(FocusHint {
                node_id: node_id.to_string(),
                select_all: false,
            }))
        })
    }

    pub fn set_node_toolbar_visible(
        &mut self,
        node_id: &str,
        visible: bool,
    ) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_editable(state, node_id)?;
            let node = state
                .nodes
                .get_mut(node_id)
                .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
            node.toolbar_visible = visible;
            node.updated_at = now_ms();
            Ok(Some(FocusHint {
                node_id: node_id.to_string(),
                select_all: false,
            }))
        })
    }

    pub fn set_node_sort(
        &mut self,
        node_id: &str,
        field: Option<String>,
        direction: Option<SortDirection>,
    ) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_editable(state, node_id)?;
            let node = state
                .nodes
                .get_mut(node_id)
                .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
            let field = normalize_optional_text(field);
            node.sort_field = field;
            node.sort_direction = if node.sort_field.is_some() {
                Some(direction.unwrap_or(SortDirection::Asc))
            } else {
                None
            };
            node.updated_at = now_ms();
            Ok(Some(FocusHint {
                node_id: node_id.to_string(),
                select_all: false,
            }))
        })
    }

    pub fn set_node_filter(
        &mut self,
        node_id: &str,
        field: Option<String>,
        op: Option<FilterOp>,
        values: Vec<String>,
    ) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_editable(state, node_id)?;
            let node = state
                .nodes
                .get_mut(node_id)
                .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
            let field = normalize_optional_text(field);
            node.filter_field = field;
            node.filter_op = if node.filter_field.is_some() {
                Some(op.unwrap_or(FilterOp::All))
            } else {
                None
            };
            node.filter_values = if node.filter_field.is_some() {
                normalize_text_list(values)
            } else {
                Vec::new()
            };
            node.updated_at = now_ms();
            Ok(Some(FocusHint {
                node_id: node_id.to_string(),
                select_all: false,
            }))
        })
    }

    pub fn set_node_group(
        &mut self,
        node_id: &str,
        field: Option<String>,
    ) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_editable(state, node_id)?;
            let node = state
                .nodes
                .get_mut(node_id)
                .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
            node.group_field = normalize_optional_text(field);
            node.updated_at = now_ms();
            Ok(Some(FocusHint {
                node_id: node_id.to_string(),
                select_all: false,
            }))
        })
    }

    pub fn merge_node_into_previous(&mut self, node_id: &str) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_editable(state, node_id)?;
            let parent_id = state
                .nodes
                .get(node_id)
                .and_then(|node| node.parent_id.clone())
                .ok_or(CoreError::NoParent)?;
            let index =
                child_index(state, &parent_id, node_id).ok_or(CoreError::NoPreviousSibling)?;
            if index == 0 {
                return Err(CoreError::NoPreviousSibling);
            }
            let prev_id = state.nodes[&parent_id].children[index - 1].clone();
            ensure_node_editable(state, &prev_id)?;
            merge_node_into_target(state, node_id, &prev_id)?;
            Ok(Some(FocusHint {
                node_id: prev_id,
                select_all: false,
            }))
        })
    }

    pub fn merge_node_into(&mut self, node_id: &str, target_id: &str) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_editable(state, node_id)?;
            ensure_node_editable(state, target_id)?;
            merge_node_into_target(state, node_id, target_id)?;
            Ok(Some(FocusHint {
                node_id: target_id.to_string(),
                select_all: false,
            }))
        })
    }

    pub fn move_node(
        &mut self,
        node_id: &str,
        parent_id: &str,
        index: Option<usize>,
    ) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_movable(state, node_id)?;
            ensure_parent_mutable(state, parent_id)?;
            move_node_no_touch(state, node_id, parent_id, index)?;
            touch_node(state, node_id);
            Ok(Some(FocusHint {
                node_id: node_id.to_string(),
                select_all: false,
            }))
        })
    }

    pub fn indent_node(&mut self, node_id: &str) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_movable(state, node_id)?;
            let parent_id = state.nodes[node_id]
                .parent_id
                .clone()
                .ok_or(CoreError::NoParent)?;
            let index =
                child_index(state, &parent_id, node_id).ok_or(CoreError::NoPreviousSibling)?;
            if index == 0 {
                return Err(CoreError::NoPreviousSibling);
            }
            let new_parent_id = state.nodes[&parent_id].children[index - 1].clone();
            ensure_parent_mutable(state, &new_parent_id)?;
            move_node_no_touch(state, node_id, &new_parent_id, None)?;
            Ok(Some(FocusHint {
                node_id: node_id.to_string(),
                select_all: false,
            }))
        })
    }

    pub fn outdent_node(&mut self, node_id: &str) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_movable(state, node_id)?;
            let parent_id = state.nodes[node_id]
                .parent_id
                .clone()
                .ok_or(CoreError::NoParent)?;
            let grand_parent_id = state.nodes[&parent_id]
                .parent_id
                .clone()
                .ok_or(CoreError::NoParent)?;
            ensure_parent_mutable(state, &grand_parent_id)?;
            let parent_index = child_index(state, &grand_parent_id, &parent_id).unwrap_or(0);
            move_node_no_touch(state, node_id, &grand_parent_id, Some(parent_index + 1))?;
            Ok(Some(FocusHint {
                node_id: node_id.to_string(),
                select_all: false,
            }))
        })
    }

    pub fn trash_node(&mut self, node_id: &str) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_movable(state, node_id)?;
            if node_id == TRASH_ID {
                return Err(CoreError::InvalidOperation(
                    "cannot trash Trash".to_string(),
                ));
            }
            let parent_id = state.nodes[node_id]
                .parent_id
                .clone()
                .ok_or(CoreError::NoParent)?;
            let index = child_index(state, &parent_id, node_id).unwrap_or(0);
            {
                let node = state
                    .nodes
                    .get_mut(node_id)
                    .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
                node.trashed_from_parent_id = Some(parent_id);
                node.trashed_from_index = Some(index);
            }
            move_node_no_touch(state, node_id, TRASH_ID, None)?;
            Ok(None)
        })
    }

    pub fn restore_node(&mut self, node_id: &str) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_movable(state, node_id)?;
            let (parent_id, index) = {
                let node = state
                    .nodes
                    .get(node_id)
                    .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
                (
                    node.trashed_from_parent_id
                        .clone()
                        .unwrap_or_else(|| WORKSPACE_ID.to_string()),
                    node.trashed_from_index,
                )
            };
            let target_parent = if state.nodes.contains_key(&parent_id) {
                parent_id
            } else {
                WORKSPACE_ID.to_string()
            };
            {
                let node = state
                    .nodes
                    .get_mut(node_id)
                    .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
                node.trashed_from_parent_id = None;
                node.trashed_from_index = None;
            }
            move_node_no_touch(state, node_id, &target_parent, index)?;
            Ok(Some(FocusHint {
                node_id: node_id.to_string(),
                select_all: false,
            }))
        })
    }

    pub fn delete_node(&mut self, node_id: &str) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_movable(state, node_id)?;
            remove_subtree(state, node_id)?;
            Ok(None)
        })
    }

    pub fn toggle_done(&mut self, node_id: &str) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_editable(state, node_id)?;
            let node = state
                .nodes
                .get_mut(node_id)
                .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
            node.completed_at = if node.completed_at.is_some() {
                None
            } else {
                Some(now_ms())
            };
            node.updated_at = now_ms();
            Ok(Some(FocusHint {
                node_id: node_id.to_string(),
                select_all: false,
            }))
        })
    }

    pub fn batch_trash_nodes(&mut self, node_ids: Vec<NodeId>) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            for node_id in node_ids.iter().rev() {
                if !state.nodes.contains_key(node_id) {
                    continue;
                }
                ensure_node_movable(state, node_id)?;
                if node_id == TRASH_ID {
                    return Err(CoreError::InvalidOperation(
                        "cannot trash Trash".to_string(),
                    ));
                }
                let parent_id = state.nodes[node_id]
                    .parent_id
                    .clone()
                    .ok_or(CoreError::NoParent)?;
                let index = child_index(state, &parent_id, node_id).unwrap_or(0);
                {
                    let node = state
                        .nodes
                        .get_mut(node_id)
                        .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
                    node.trashed_from_parent_id = Some(parent_id);
                    node.trashed_from_index = Some(index);
                }
                move_node_no_touch(state, node_id, TRASH_ID, None)?;
            }
            Ok(None)
        })
    }

    pub fn batch_indent_nodes(&mut self, node_ids: Vec<NodeId>) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            for node_id in &node_ids {
                if !state.nodes.contains_key(node_id) {
                    continue;
                }
                ensure_node_movable(state, node_id)?;
                let Some(parent_id) = state.nodes[node_id].parent_id.clone() else {
                    continue;
                };
                let Some(index) = child_index(state, &parent_id, node_id) else {
                    continue;
                };
                if index == 0 {
                    continue;
                }
                let new_parent_id = state.nodes[&parent_id].children[index - 1].clone();
                ensure_parent_mutable(state, &new_parent_id)?;
                move_node_no_touch(state, node_id, &new_parent_id, None)?;
            }
            Ok(None)
        })
    }

    pub fn batch_outdent_nodes(&mut self, node_ids: Vec<NodeId>) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            for node_id in node_ids.iter().rev() {
                if !state.nodes.contains_key(node_id) {
                    continue;
                }
                ensure_node_movable(state, node_id)?;
                let Some(parent_id) = state.nodes[node_id].parent_id.clone() else {
                    continue;
                };
                let Some(grand_parent_id) = state.nodes[&parent_id].parent_id.clone() else {
                    continue;
                };
                ensure_parent_mutable(state, &grand_parent_id)?;
                let parent_index = child_index(state, &grand_parent_id, &parent_id).unwrap_or(0);
                move_node_no_touch(state, node_id, &grand_parent_id, Some(parent_index + 1))?;
            }
            Ok(None)
        })
    }

    pub fn batch_toggle_done(&mut self, node_ids: Vec<NodeId>) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            for node_id in &node_ids {
                if !state.nodes.contains_key(node_id) {
                    continue;
                }
                ensure_node_editable(state, node_id)?;
                let node = state
                    .nodes
                    .get_mut(node_id)
                    .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
                node.completed_at = if node.completed_at.is_some() {
                    None
                } else {
                    Some(now_ms())
                };
                node.updated_at = now_ms();
            }
            Ok(None)
        })
    }

    pub fn batch_duplicate_nodes(&mut self, node_ids: Vec<NodeId>) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            let top_level_ids = top_level_node_ids(state, &node_ids);
            let mut first_clone_id = None;
            for node_id in top_level_ids {
                if !state.nodes.contains_key(&node_id) {
                    continue;
                }
                ensure_node_movable(state, &node_id)?;
                let parent_id = state.nodes[&node_id]
                    .parent_id
                    .clone()
                    .ok_or(CoreError::NoParent)?;
                ensure_parent_mutable(state, &parent_id)?;
                let index = child_index(state, &parent_id, &node_id).unwrap_or(0);
                let clone_id = clone_subtree(state, &node_id, &parent_id, Some(index + 1))?;
                if first_clone_id.is_none() {
                    first_clone_id = Some(clone_id);
                }
            }
            Ok(first_clone_id.map(|node_id| FocusHint {
                node_id,
                select_all: false,
            }))
        })
    }

    pub fn batch_move_nodes_up(&mut self, node_ids: Vec<NodeId>) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            move_selected_siblings(state, &node_ids, MoveDirection::Up)?;
            Ok(None)
        })
    }

    pub fn batch_move_nodes_down(&mut self, node_ids: Vec<NodeId>) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            move_selected_siblings(state, &node_ids, MoveDirection::Down)?;
            Ok(None)
        })
    }

    pub fn batch_apply_tag(&mut self, node_ids: Vec<NodeId>, tag_id: &str) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            if !matches!(
                state.nodes.get(tag_id).and_then(|node| node.node_type.as_ref()),
                Some(NodeType::TagDef)
            ) {
                return Err(CoreError::NodeNotFound(tag_id.to_string()));
            }
            for node_id in &node_ids {
                if !state.nodes.contains_key(node_id) {
                    continue;
                }
                ensure_node_editable(state, node_id)?;
                apply_tag_no_history(state, node_id, tag_id)?;
            }
            Ok(None)
        })
    }

    pub fn create_tag(&mut self, name: &str) -> Result<CommandOutcome> {
        let normalized = name.trim().to_string();
        if normalized.is_empty() {
            return Err(CoreError::InvalidOperation(
                "tag name cannot be empty".to_string(),
            ));
        }
        self.mutate_with_focus(|state| {
            if let Some(existing) = find_tag_by_name(state, &normalized) {
                return Ok(Some(FocusHint {
                    node_id: existing,
                    select_all: false,
                }));
            }
            let id = fresh_id("tag");
            let color = next_tag_color(state);
            insert_node(
                state,
                id.clone(),
                SCHEMA_ID.to_string(),
                None,
                Some(NodeType::TagDef),
                |node| {
                    node.content = RichText::plain(normalized);
                    node.color = Some(color);
                },
            )?;
            Ok(Some(FocusHint {
                node_id: id,
                select_all: false,
            }))
        })
    }

    pub fn apply_tag(&mut self, node_id: &str, tag_id: &str) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_editable(state, node_id)?;
            if !matches!(
                state.nodes.get(tag_id).and_then(|n| n.node_type.as_ref()),
                Some(NodeType::TagDef)
            ) {
                return Err(CoreError::NodeNotFound(tag_id.to_string()));
            }
            apply_tag_no_history(state, node_id, tag_id)?;
            Ok(Some(FocusHint {
                node_id: node_id.to_string(),
                select_all: false,
            }))
        })
    }

    pub fn remove_tag(&mut self, node_id: &str, tag_id: &str) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_editable(state, node_id)?;
            let had_tag = {
                let node = state
                    .nodes
                    .get_mut(node_id)
                    .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
                let had_tag = node.tags.iter().any(|id| id == tag_id);
                node.tags.retain(|id| id != tag_id);
                node.updated_at = now_ms();
                had_tag
            };
            if had_tag {
                cleanup_fields_from_removed_tag(state, node_id, tag_id)?;
            }
            Ok(Some(FocusHint {
                node_id: node_id.to_string(),
                select_all: false,
            }))
        })
    }

    pub fn set_tag_config(
        &mut self,
        tag_id: &str,
        patch: TagConfigPatch,
    ) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_editable(state, tag_id)?;
            ensure_tag_definition(state, tag_id)?;

            if let Some(Some(parent_tag_id)) = patch.extends_tag.as_ref() {
                ensure_tag_definition(state, parent_tag_id)?;
                if parent_tag_id == tag_id || tag_extends_would_cycle(state, tag_id, parent_tag_id)
                {
                    return Err(CoreError::InvalidOperation(
                        "tag inheritance cannot create a cycle".to_string(),
                    ));
                }
            }
            if let Some(Some(child_tag_id)) = patch.child_supertag.as_ref() {
                ensure_tag_definition(state, child_tag_id)?;
            }

            let node = state
                .nodes
                .get_mut(tag_id)
                .ok_or_else(|| CoreError::NodeNotFound(tag_id.to_string()))?;
            if let Some(color) = patch.color {
                node.color = normalize_optional_text(color);
            }
            if let Some(parent_tag_id) = patch.extends_tag {
                node.extends = normalize_optional_text(parent_tag_id);
            }
            if let Some(child_tag_id) = patch.child_supertag {
                node.child_supertag = normalize_optional_text(child_tag_id);
            }
            if let Some(show_checkbox) = patch.show_checkbox {
                node.show_checkbox = show_checkbox;
            }
            if let Some(done_state_enabled) = patch.done_state_enabled {
                node.done_state_enabled = done_state_enabled;
            }
            node.updated_at = now_ms();

            Ok(Some(FocusHint {
                node_id: tag_id.to_string(),
                select_all: false,
            }))
        })
    }

    pub fn set_field_config(
        &mut self,
        field_id: &str,
        patch: FieldConfigPatch,
    ) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_editable(state, field_id)?;
            ensure_field_definition(state, field_id)?;

            let current = state
                .nodes
                .get(field_id)
                .ok_or_else(|| CoreError::NodeNotFound(field_id.to_string()))?;
            let next_field_type = patch
                .field_type
                .clone()
                .or_else(|| current.field_type.clone())
                .unwrap_or_default();
            let next_min = patch.min_value.unwrap_or(current.min_value);
            let next_max = patch.max_value.unwrap_or(current.max_value);

            if let Some(Some(source_tag_id)) = patch.source_supertag.as_ref() {
                ensure_tag_definition(state, source_tag_id)?;
                if next_field_type != FieldType::OptionsFromSupertag {
                    return Err(CoreError::InvalidOperation(
                        "source supertag is only valid for options-from-supertag fields"
                            .to_string(),
                    ));
                }
            }
            if patch.autocollect_options == Some(true) && next_field_type != FieldType::Options {
                return Err(CoreError::InvalidOperation(
                    "auto-collect options is only valid for options fields".to_string(),
                ));
            }
            if let Some(Some(mode)) = patch.hide_field.as_ref() {
                let normalized = mode.trim();
                if !normalized.is_empty() {
                    ensure_valid_hide_field_mode(normalized)?;
                }
            }
            if let (Some(min), Some(max)) = (next_min, next_max) {
                if min > max {
                    return Err(CoreError::InvalidOperation(
                        "minimum value cannot be greater than maximum value".to_string(),
                    ));
                }
            }

            let node = state
                .nodes
                .get_mut(field_id)
                .ok_or_else(|| CoreError::NodeNotFound(field_id.to_string()))?;
            if let Some(field_type) = patch.field_type {
                node.field_type = Some(field_type.clone());
                if field_type != FieldType::OptionsFromSupertag {
                    node.source_supertag = None;
                }
                if field_type != FieldType::Options {
                    node.autocollect_options = false;
                }
                if field_type != FieldType::Number {
                    node.min_value = None;
                    node.max_value = None;
                }
            }
            if let Some(source_tag_id) = patch.source_supertag {
                node.source_supertag = normalize_optional_text(source_tag_id);
            }
            if let Some(nullable) = patch.nullable {
                node.nullable = nullable;
            }
            if let Some(hide_field) = patch.hide_field {
                node.hide_field = normalize_optional_text(hide_field);
            }
            if let Some(auto_initialize) = patch.auto_initialize {
                node.auto_initialize = normalize_optional_text(auto_initialize);
            }
            if let Some(autocollect_options) = patch.autocollect_options {
                node.autocollect_options = autocollect_options;
            }
            if let Some(min_value) = patch.min_value {
                node.min_value = min_value;
            }
            if let Some(max_value) = patch.max_value {
                node.max_value = max_value;
            }
            node.updated_at = now_ms();

            Ok(Some(FocusHint {
                node_id: field_id.to_string(),
                select_all: false,
            }))
        })
    }

    pub fn create_field_def(
        &mut self,
        tag_id: &str,
        name: &str,
        field_type: FieldType,
    ) -> Result<CommandOutcome> {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err(CoreError::InvalidOperation(
                "field name cannot be empty".to_string(),
            ));
        }
        self.mutate_with_focus(|state| {
            ensure_parent_mutable(state, tag_id)?;
            if !matches!(
                state.nodes.get(tag_id).and_then(|n| n.node_type.as_ref()),
                Some(NodeType::TagDef)
            ) {
                return Err(CoreError::InvalidOperation(
                    "field templates belong under tags".to_string(),
                ));
            }
            let field_def_id =
                insert_field_def_node(state, SCHEMA_ID.to_string(), name, field_type)?;
            let template_entry_id =
                insert_field_entry_node(state, tag_id.to_string(), None, &field_def_id)?;
            for tagged_node_id in find_nodes_with_tag(state, tag_id) {
                ensure_field_entry_from_template(
                    state,
                    &tagged_node_id,
                    &field_def_id,
                    &template_entry_id,
                    false,
                )?;
            }
            Ok(Some(FocusHint {
                node_id: template_entry_id,
                select_all: false,
            }))
        })
    }

    pub fn create_inline_field_after_node(
        &mut self,
        after_node_id: &str,
        name: &str,
        field_type: FieldType,
    ) -> Result<CommandOutcome> {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err(CoreError::InvalidOperation(
                "field name cannot be empty".to_string(),
            ));
        }
        self.mutate_with_focus(|state| {
            ensure_node_movable(state, after_node_id)?;
            let parent_id = state
                .nodes
                .get(after_node_id)
                .and_then(|node| node.parent_id.clone())
                .ok_or(CoreError::NoParent)?;
            ensure_parent_mutable(state, &parent_id)?;

            let after_index = child_index(state, &parent_id, after_node_id).unwrap_or(0);
            let field_def_id =
                insert_field_def_node(state, SCHEMA_ID.to_string(), name, field_type)?;
            let field_entry_id = insert_field_entry_node(
                state,
                parent_id.clone(),
                Some(after_index + 1),
                &field_def_id,
            )?;

            {
                let node = state
                    .nodes
                    .get_mut(after_node_id)
                    .ok_or_else(|| CoreError::NodeNotFound(after_node_id.to_string()))?;
                node.trashed_from_parent_id = Some(parent_id);
                node.trashed_from_index = Some(after_index);
            }
            move_node_no_touch(state, after_node_id, TRASH_ID, None)?;

            Ok(Some(FocusHint {
                node_id: field_entry_id,
                select_all: false,
            }))
        })
    }

    pub fn create_inline_field(
        &mut self,
        parent_id: &str,
        index: Option<usize>,
        name: &str,
        field_type: FieldType,
    ) -> Result<CommandOutcome> {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err(CoreError::InvalidOperation(
                "field name cannot be empty".to_string(),
            ));
        }
        self.mutate_with_focus(|state| {
            ensure_parent_mutable(state, parent_id)?;
            let field_def_id =
                insert_field_def_node(state, SCHEMA_ID.to_string(), name, field_type)?;
            let field_entry_id =
                insert_field_entry_node(state, parent_id.to_string(), index, &field_def_id)?;

            Ok(Some(FocusHint {
                node_id: field_entry_id,
                select_all: false,
            }))
        })
    }

    pub fn register_collected_option(
        &mut self,
        field_def_id: &str,
        name: &str,
    ) -> Result<CommandOutcome> {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err(CoreError::InvalidOperation(
                "option name cannot be empty".to_string(),
            ));
        }
        self.mutate_with_focus(|state| {
            ensure_options_field_def(state, field_def_id)?;
            let option_id = ensure_option_node(state, field_def_id, &name)?;
            Ok(Some(FocusHint {
                node_id: option_id,
                select_all: false,
            }))
        })
    }

    pub fn select_field_option(
        &mut self,
        field_entry_id: &str,
        option_node_id: &str,
    ) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            let field_def_id = {
                let field_entry = state
                    .nodes
                    .get(field_entry_id)
                    .ok_or_else(|| CoreError::NodeNotFound(field_entry_id.to_string()))?;
                if field_entry.node_type.as_ref() != Some(&NodeType::FieldEntry) {
                    return Err(CoreError::InvalidOperation(
                        "options can only be selected on field entries".to_string(),
                    ));
                }
                field_entry.field_def_id.clone().ok_or_else(|| {
                    CoreError::InvalidOperation("field entry has no field definition".to_string())
                })?
            };

            ensure_options_field_def(state, &field_def_id)?;
            ensure_option_belongs_to_field(state, &field_def_id, option_node_id)?;

            let existing_children = state
                .nodes
                .get(field_entry_id)
                .map(|node| node.children.clone())
                .unwrap_or_default();
            for child_id in existing_children {
                remove_subtree(state, &child_id)?;
            }

            let value_id = fresh_id("option_value");
            insert_node(
                state,
                value_id,
                field_entry_id.to_string(),
                None,
                Some(NodeType::Reference),
                |node| {
                    node.target_id = Some(option_node_id.to_string());
                },
            )?;
            Ok(Some(FocusHint {
                node_id: field_entry_id.to_string(),
                select_all: false,
            }))
        })
    }

    pub fn add_reference(
        &mut self,
        parent_id: &str,
        target_id: &str,
        index: Option<usize>,
    ) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_parent_mutable(state, parent_id)?;
            if !state.nodes.contains_key(target_id) {
                return Err(CoreError::NodeNotFound(target_id.to_string()));
            }
            if would_create_reference_cycle(state, parent_id, target_id) {
                return Err(CoreError::ReferenceCycle);
            }
            let id = fresh_id("ref");
            insert_node(
                state,
                id.clone(),
                parent_id.to_string(),
                index,
                Some(NodeType::Reference),
                |node| {
                    node.target_id = Some(target_id.to_string());
                },
            )?;
            Ok(Some(FocusHint {
                node_id: id,
                select_all: false,
            }))
        })
    }

    pub fn replace_node_with_reference(
        &mut self,
        node_id: &str,
        target_id: &str,
    ) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            ensure_node_movable(state, node_id)?;
            if !state.nodes.contains_key(target_id) {
                return Err(CoreError::NodeNotFound(target_id.to_string()));
            }
            let parent_id = state
                .nodes
                .get(node_id)
                .and_then(|node| node.parent_id.clone())
                .ok_or(CoreError::NoParent)?;
            ensure_parent_mutable(state, &parent_id)?;
            if would_create_reference_cycle(state, &parent_id, target_id) {
                return Err(CoreError::ReferenceCycle);
            }

            let index = child_index(state, &parent_id, node_id).unwrap_or(0);
            let reference_id = fresh_id("ref");
            insert_node(
                state,
                reference_id.clone(),
                parent_id.clone(),
                Some(index),
                Some(NodeType::Reference),
                |node| {
                    node.target_id = Some(target_id.to_string());
                },
            )?;

            {
                let node = state
                    .nodes
                    .get_mut(node_id)
                    .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
                node.trashed_from_parent_id = Some(parent_id);
                node.trashed_from_index = Some(index);
            }
            move_node_no_touch(state, node_id, TRASH_ID, None)?;

            Ok(Some(FocusHint {
                node_id: reference_id,
                select_all: false,
            }))
        })
    }

    pub fn ensure_date_node(&mut self, year: i32, month: u32, day: u32) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            let day_id = ensure_date_node_in_state(state, year, month, day)?;
            Ok(Some(FocusHint {
                node_id: day_id,
                select_all: false,
            }))
        })
    }

    pub fn search_nodes(&self, query: &str) -> Vec<SearchHit> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return Vec::new();
        }
        let mut hits = Vec::new();
        for node in self.state.nodes.values() {
            if !is_search_candidate(&self.state, &node.id) {
                continue;
            }
            let mut score = 0;
            let text = node.content.text.to_lowercase();
            if text == q {
                score += 100;
            } else if text.starts_with(&q) {
                score += 60;
            } else if text.contains(&q) {
                score += 30;
            }
            for tag_id in &node.tags {
                if let Some(tag) = self.state.nodes.get(tag_id) {
                    if tag.content.text.to_lowercase().contains(&q) {
                        score += 15;
                    }
                }
            }
            if score > 0 {
                hits.push(SearchHit {
                    node_id: node.id.clone(),
                    score,
                });
            }
        }
        hits.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then_with(|| a.node_id.cmp(&b.node_id))
        });
        hits.truncate(50);
        hits
    }

    pub fn ensure_tag_search(&mut self, tag_id: &str) -> Result<CommandOutcome> {
        self.mutate_with_focus(|state| {
            let tag = state
                .nodes
                .get(tag_id)
                .ok_or_else(|| CoreError::NodeNotFound(tag_id.to_string()))?;
            if tag.node_type.as_ref() != Some(&NodeType::TagDef) {
                return Err(CoreError::InvalidOperation(
                    "tag search target must be a tag".to_string(),
                ));
            }
            let tag_name = tag.content.text.clone();
            let search_id = state
                .nodes
                .values()
                .find(|node| {
                    !is_in_trash(state, &node.id)
                        && node.node_type.as_ref() == Some(&NodeType::Search)
                        && node.query_op.as_ref() == Some(&QueryOp::HasTag)
                        && node.query_tag_def_id.as_deref() == Some(tag_id)
                })
                .map(|node| node.id.clone());

            let search_id = if let Some(search_id) = search_id {
                search_id
            } else {
                let id = fresh_id("search");
                insert_node(
                    state,
                    id.clone(),
                    SEARCHES_ID.to_string(),
                    None,
                    Some(NodeType::Search),
                    |node| {
                        node.content = RichText::plain(format!("Everything tagged #{}", tag_name));
                        node.query_logic = Some(QueryLogic::And);
                        node.query_op = Some(QueryOp::HasTag);
                        node.query_tag_def_id = Some(tag_id.to_string());
                    },
                )?;
                id
            };

            refresh_tag_search_children(state, &search_id, tag_id)?;
            Ok(Some(FocusHint {
                node_id: search_id,
                select_all: false,
            }))
        })
    }

    pub fn backlinks(&self, target_id: &str) -> Vec<Backlink> {
        let mut result = Vec::new();
        for node in self.state.nodes.values() {
            if is_in_trash(&self.state, &node.id) {
                continue;
            }
            if node.node_type.as_ref() == Some(&NodeType::Reference)
                && node.target_id.as_deref() == Some(target_id)
            {
                if let Some(parent_id) = &node.parent_id {
                    result.push(Backlink {
                        source_id: parent_id.clone(),
                        reference_id: node.id.clone(),
                        kind: "tree".to_string(),
                    });
                }
            }
            for inline_ref in &node.content.inline_refs {
                if inline_ref.target_id == target_id {
                    result.push(Backlink {
                        source_id: node.id.clone(),
                        reference_id: node.id.clone(),
                        kind: "inline".to_string(),
                    });
                }
            }
        }
        result
    }

    pub fn undo(&mut self) -> Result<CommandOutcome> {
        if let Some(previous) = self.undo_stack.pop() {
            let current = self.state.clone();
            self.redo_stack.push(current);
            self.state = previous;
        }
        Ok(CommandOutcome {
            projection: self.projection(),
            focus: None,
        })
    }

    pub fn redo(&mut self) -> Result<CommandOutcome> {
        if let Some(next) = self.redo_stack.pop() {
            let current = self.state.clone();
            self.undo_stack.push(current);
            self.state = next;
        }
        Ok(CommandOutcome {
            projection: self.projection(),
            focus: None,
        })
    }

    fn bootstrap(&mut self) {
        ensure_system_nodes(&mut self.state);
    }

    fn ensure_today_node_no_history(&mut self) -> NodeId {
        let today = Local::now().date_naive();
        ensure_date_node_in_state(&mut self.state, today.year(), today.month(), today.day())
            .unwrap_or_else(|_| DAILY_NOTES_ID.to_string())
    }

    fn build_projection(&self, today_id: NodeId) -> DocumentProjection {
        DocumentProjection {
            workspace_id: self.state.workspace_id.clone(),
            root_id: self.state.root_id.clone(),
            daily_notes_id: DAILY_NOTES_ID.to_string(),
            schema_id: SCHEMA_ID.to_string(),
            searches_id: SEARCHES_ID.to_string(),
            trash_id: TRASH_ID.to_string(),
            settings_id: SETTINGS_ID.to_string(),
            today_id,
            nodes: self
                .state
                .nodes
                .values()
                .map(NodeProjection::from)
                .collect(),
        }
    }

    fn mutate_with_focus<F>(&mut self, f: F) -> Result<CommandOutcome>
    where
        F: FnOnce(&mut DocumentState) -> Result<Option<FocusHint>>,
    {
        let before = self.state.clone();
        let focus = f(&mut self.state)?;
        if self.state != before {
            self.undo_stack.push(before);
            self.redo_stack.clear();
        }
        let projection = self.projection();
        Ok(CommandOutcome { projection, focus })
    }
}

fn ensure_system_nodes(state: &mut DocumentState) {
    let now = now_ms();
    state.workspace_id = WORKSPACE_ID.to_string();
    state.root_id = WORKSPACE_ID.to_string();

    ensure_node(state, WORKSPACE_ID, None, None, "Lin Outliner", true, now);
    ensure_node(
        state,
        DAILY_NOTES_ID,
        None,
        Some(WORKSPACE_ID),
        "Daily notes",
        true,
        now,
    );
    ensure_node(
        state,
        SCHEMA_ID,
        None,
        Some(WORKSPACE_ID),
        "Schema",
        true,
        now,
    );
    ensure_node(
        state,
        SEARCHES_ID,
        None,
        Some(WORKSPACE_ID),
        "Searches",
        true,
        now,
    );
    ensure_node(
        state,
        TRASH_ID,
        None,
        Some(WORKSPACE_ID),
        "Trash",
        true,
        now,
    );
    ensure_node(
        state,
        SETTINGS_ID,
        None,
        Some(WORKSPACE_ID),
        "Settings",
        true,
        now,
    );
    ensure_node(
        state,
        TAG_DAY_ID,
        Some(NodeType::TagDef),
        Some(SCHEMA_ID),
        "day",
        true,
        now,
    );
    ensure_node(
        state,
        TAG_WEEK_ID,
        Some(NodeType::TagDef),
        Some(SCHEMA_ID),
        "week",
        true,
        now,
    );
    ensure_node(
        state,
        TAG_YEAR_ID,
        Some(NodeType::TagDef),
        Some(SCHEMA_ID),
        "year",
        true,
        now,
    );

    for id in [
        DAILY_NOTES_ID,
        SCHEMA_ID,
        SEARCHES_ID,
        TRASH_ID,
        SETTINGS_ID,
    ] {
        attach_child_once(state, WORKSPACE_ID, id, None);
    }
    for id in [TAG_DAY_ID, TAG_WEEK_ID, TAG_YEAR_ID] {
        attach_child_once(state, SCHEMA_ID, id, None);
    }
}

fn ensure_node(
    state: &mut DocumentState,
    id: &str,
    node_type: Option<NodeType>,
    parent_id: Option<&str>,
    name: &str,
    locked: bool,
    now: i64,
) {
    let entry = state.nodes.entry(id.to_string()).or_insert_with(|| {
        let mut node = Node::new(
            id.to_string(),
            node_type.clone(),
            parent_id.map(ToString::to_string),
            now,
        );
        node.content = RichText::plain(name);
        node.locked = locked;
        node
    });
    entry.node_type = node_type;
    entry.parent_id = parent_id.map(ToString::to_string);
    if entry.content.text.is_empty() {
        entry.content = RichText::plain(name);
    }
    entry.locked = locked;
}

fn attach_child_once(
    state: &mut DocumentState,
    parent_id: &str,
    child_id: &str,
    index: Option<usize>,
) {
    if let Some(parent) = state.nodes.get_mut(parent_id) {
        parent.children.retain(|id| id != child_id);
        let pos = index
            .unwrap_or(parent.children.len())
            .min(parent.children.len());
        parent.children.insert(pos, child_id.to_string());
    }
    if let Some(child) = state.nodes.get_mut(child_id) {
        child.parent_id = Some(parent_id.to_string());
    }
}

fn insert_node<F>(
    state: &mut DocumentState,
    id: NodeId,
    parent_id: NodeId,
    index: Option<usize>,
    node_type: Option<NodeType>,
    configure: F,
) -> Result<()>
where
    F: FnOnce(&mut Node),
{
    if !state.nodes.contains_key(&parent_id) {
        return Err(CoreError::ParentNotFound(parent_id));
    }
    let now = now_ms();
    let mut node = Node::new(id.clone(), node_type, Some(parent_id.clone()), now);
    configure(&mut node);
    state.nodes.insert(id.clone(), node);
    attach_child_once(state, &parent_id, &id, index);
    Ok(())
}

fn insert_node_tree(
    state: &mut DocumentState,
    parent_id: &str,
    tree: CreateNodeTree,
) -> Result<NodeId> {
    insert_node_tree_at(state, parent_id, None, tree)
}

fn insert_node_tree_at(
    state: &mut DocumentState,
    parent_id: &str,
    index: Option<usize>,
    tree: CreateNodeTree,
) -> Result<NodeId> {
    let id = fresh_id("node");
    insert_node(
        state,
        id.clone(),
        parent_id.to_string(),
        index,
        None,
        |node| {
            node.content = tree.content;
        },
    )?;
    apply_child_tags(state, parent_id, &id)?;
    for child in tree.children {
        insert_node_tree(state, &id, child)?;
    }
    Ok(id)
}

fn insert_field_def_node(
    state: &mut DocumentState,
    parent_id: NodeId,
    name: String,
    field_type: FieldType,
) -> Result<NodeId> {
    let id = fresh_id("field");
    insert_node(
        state,
        id.clone(),
        parent_id,
        None,
        Some(NodeType::FieldDef),
        |node| {
            node.content = RichText::plain(name);
            node.field_type = Some(field_type);
            node.cardinality = Some("single".to_string());
            node.nullable = Some(true);
        },
    )?;
    Ok(id)
}

fn insert_field_entry_node(
    state: &mut DocumentState,
    parent_id: NodeId,
    index: Option<usize>,
    field_def_id: &str,
) -> Result<NodeId> {
    let id = fresh_id("field_entry");
    insert_node(
        state,
        id.clone(),
        parent_id,
        index,
        Some(NodeType::FieldEntry),
        |node| {
            node.field_def_id = Some(field_def_id.to_string());
            node.content = RichText::plain("");
        },
    )?;
    Ok(id)
}

fn ensure_options_field_def(state: &DocumentState, field_def_id: &str) -> Result<()> {
    let field_def = state
        .nodes
        .get(field_def_id)
        .ok_or_else(|| CoreError::NodeNotFound(field_def_id.to_string()))?;
    if field_def.node_type.as_ref() != Some(&NodeType::FieldDef) {
        return Err(CoreError::InvalidOperation(
            "options belong to field definitions".to_string(),
        ));
    }
    match field_def.field_type.as_ref() {
        Some(FieldType::Options) | Some(FieldType::OptionsFromSupertag) => Ok(()),
        _ => Err(CoreError::InvalidOperation(
            "field definition is not an options field".to_string(),
        )),
    }
}

fn find_option_by_name(state: &DocumentState, field_def_id: &str, name: &str) -> Option<NodeId> {
    let needle = name.trim().to_lowercase();
    state
        .nodes
        .get(field_def_id)?
        .children
        .iter()
        .find_map(|child_id| {
            let child = state.nodes.get(child_id)?;
            if child.content.text.trim().to_lowercase() == needle {
                Some(child.id.clone())
            } else {
                None
            }
        })
}

fn ensure_option_node(state: &mut DocumentState, field_def_id: &str, name: &str) -> Result<NodeId> {
    if let Some(existing_id) = find_option_by_name(state, field_def_id, name) {
        return Ok(existing_id);
    }
    let option_id = fresh_id("option");
    insert_node(
        state,
        option_id.clone(),
        field_def_id.to_string(),
        None,
        None,
        |node| {
            node.content = RichText::plain(name);
            node.auto_collected = true;
        },
    )?;
    Ok(option_id)
}

fn ensure_option_belongs_to_field(
    state: &DocumentState,
    field_def_id: &str,
    option_node_id: &str,
) -> Result<()> {
    let option = state
        .nodes
        .get(option_node_id)
        .ok_or_else(|| CoreError::NodeNotFound(option_node_id.to_string()))?;
    if option.parent_id.as_deref() == Some(field_def_id) {
        return Ok(());
    }
    Err(CoreError::InvalidOperation(
        "option does not belong to this field definition".to_string(),
    ))
}

fn remove_subtree(state: &mut DocumentState, node_id: &str) -> Result<()> {
    if is_system_id(node_id) {
        return Err(CoreError::LockedNode(node_id.to_string()));
    }
    let node = state
        .nodes
        .get(node_id)
        .cloned()
        .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
    if let Some(parent_id) = &node.parent_id {
        if let Some(parent) = state.nodes.get_mut(parent_id) {
            parent.children.retain(|id| id != node_id);
        }
    }
    for child_id in node.children {
        remove_subtree(state, &child_id)?;
    }
    state.nodes.remove(node_id);
    for other in state.nodes.values_mut() {
        other.tags.retain(|id| id != node_id);
        if other.target_id.as_deref() == Some(node_id) {
            other.target_id = None;
        }
        other
            .content
            .inline_refs
            .retain(|inline_ref| inline_ref.target_id != node_id);
    }
    Ok(())
}

fn move_node_no_touch(
    state: &mut DocumentState,
    node_id: &str,
    parent_id: &str,
    index: Option<usize>,
) -> Result<()> {
    if node_id == parent_id || is_descendant(state, parent_id, node_id) {
        return Err(CoreError::InvalidMove);
    }
    if !state.nodes.contains_key(node_id) {
        return Err(CoreError::NodeNotFound(node_id.to_string()));
    }
    if !state.nodes.contains_key(parent_id) {
        return Err(CoreError::ParentNotFound(parent_id.to_string()));
    }
    if let Some(old_parent_id) = state.nodes[node_id].parent_id.clone() {
        if let Some(old_parent) = state.nodes.get_mut(&old_parent_id) {
            old_parent.children.retain(|id| id != node_id);
        }
    }
    attach_child_once(state, parent_id, node_id, index);
    Ok(())
}

fn clone_subtree(
    state: &mut DocumentState,
    source_id: &str,
    parent_id: &str,
    index: Option<usize>,
) -> Result<NodeId> {
    let source = state
        .nodes
        .get(source_id)
        .cloned()
        .ok_or_else(|| CoreError::NodeNotFound(source_id.to_string()))?;
    let source_children = source.children.clone();
    let cloned_id = fresh_id("copy");
    insert_node(
        state,
        cloned_id.clone(),
        parent_id.to_string(),
        index,
        source.node_type.clone(),
        |node| {
            let created_at = node.created_at;
            *node = source.clone();
            node.id = cloned_id.clone();
            node.parent_id = Some(parent_id.to_string());
            node.children = Vec::new();
            node.created_at = created_at;
            node.updated_at = created_at;
            node.trashed_from_parent_id = None;
            node.trashed_from_index = None;
        },
    )?;
    for child_id in source_children {
        clone_subtree(state, &child_id, &cloned_id, None)?;
    }
    Ok(cloned_id)
}

fn ensure_parent_mutable(state: &DocumentState, parent_id: &str) -> Result<()> {
    state
        .nodes
        .get(parent_id)
        .ok_or_else(|| CoreError::ParentNotFound(parent_id.to_string()))?;
    Ok(())
}

fn ensure_node_editable(state: &DocumentState, node_id: &str) -> Result<()> {
    let node = state
        .nodes
        .get(node_id)
        .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
    if node.locked {
        return Err(CoreError::LockedNode(node_id.to_string()));
    }
    Ok(())
}

fn ensure_tag_definition(state: &DocumentState, tag_id: &str) -> Result<()> {
    let node = state
        .nodes
        .get(tag_id)
        .ok_or_else(|| CoreError::NodeNotFound(tag_id.to_string()))?;
    if node.node_type.as_ref() != Some(&NodeType::TagDef) {
        return Err(CoreError::InvalidOperation(
            "expected a tag definition".to_string(),
        ));
    }
    Ok(())
}

fn ensure_field_definition(state: &DocumentState, field_id: &str) -> Result<()> {
    let node = state
        .nodes
        .get(field_id)
        .ok_or_else(|| CoreError::NodeNotFound(field_id.to_string()))?;
    if node.node_type.as_ref() != Some(&NodeType::FieldDef) {
        return Err(CoreError::InvalidOperation(
            "expected a field definition".to_string(),
        ));
    }
    Ok(())
}

fn ensure_valid_hide_field_mode(mode: &str) -> Result<()> {
    match mode {
        "never" | "empty" | "not_empty" | "value_is_default" | "always" | "hidden" => Ok(()),
        _ => Err(CoreError::InvalidOperation(format!(
            "invalid hide field mode: {mode}"
        ))),
    }
}

fn tag_extends_would_cycle(state: &DocumentState, tag_id: &str, parent_tag_id: &str) -> bool {
    let mut visited = HashSet::new();
    let mut current = Some(parent_tag_id.to_string());
    while let Some(current_id) = current {
        if current_id == tag_id {
            return true;
        }
        if !visited.insert(current_id.clone()) {
            return true;
        }
        current = state
            .nodes
            .get(&current_id)
            .and_then(|node| node.extends.clone());
    }
    false
}

fn ensure_node_movable(state: &DocumentState, node_id: &str) -> Result<()> {
    let node = state
        .nodes
        .get(node_id)
        .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
    if node.locked || is_system_id(node_id) {
        return Err(CoreError::LockedNode(node_id.to_string()));
    }
    Ok(())
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn normalize_text_list(values: Vec<String>) -> Vec<String> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for value in values {
        let normalized = value.trim().to_string();
        if normalized.is_empty() || !seen.insert(normalized.to_lowercase()) {
            continue;
        }
        result.push(normalized);
    }
    result
}

fn child_index(state: &DocumentState, parent_id: &str, child_id: &str) -> Option<usize> {
    state
        .nodes
        .get(parent_id)?
        .children
        .iter()
        .position(|id| id == child_id)
}

#[derive(Debug, Clone, Copy)]
enum MoveDirection {
    Up,
    Down,
}

fn top_level_node_ids(state: &DocumentState, node_ids: &[NodeId]) -> Vec<NodeId> {
    let selected: HashSet<NodeId> = node_ids.iter().cloned().collect();
    let mut seen = HashSet::new();
    node_ids
        .iter()
        .filter_map(|node_id| {
            if !seen.insert(node_id.clone()) {
                return None;
            }
            if has_selected_ancestor(state, node_id, &selected) {
                return None;
            }
            Some(node_id.clone())
        })
        .collect()
}

fn has_selected_ancestor(state: &DocumentState, node_id: &str, selected: &HashSet<NodeId>) -> bool {
    let mut current = state
        .nodes
        .get(node_id)
        .and_then(|node| node.parent_id.clone());
    while let Some(id) = current {
        if selected.contains(&id) {
            return true;
        }
        current = state.nodes.get(&id).and_then(|node| node.parent_id.clone());
    }
    false
}

fn move_selected_siblings(
    state: &mut DocumentState,
    node_ids: &[NodeId],
    direction: MoveDirection,
) -> Result<()> {
    let top_level_ids = top_level_node_ids(state, node_ids);
    let selected: HashSet<NodeId> = top_level_ids.iter().cloned().collect();
    let mut parent_ids = Vec::new();
    for node_id in &top_level_ids {
        if !state.nodes.contains_key(node_id) {
            continue;
        }
        ensure_node_movable(state, node_id)?;
        let parent_id = state.nodes[node_id]
            .parent_id
            .clone()
            .ok_or(CoreError::NoParent)?;
        ensure_parent_mutable(state, &parent_id)?;
        if !parent_ids.iter().any(|id| id == &parent_id) {
            parent_ids.push(parent_id);
        }
    }

    for parent_id in parent_ids {
        let Some(parent) = state.nodes.get_mut(&parent_id) else {
            continue;
        };
        match direction {
            MoveDirection::Up => {
                for index in 1..parent.children.len() {
                    if selected.contains(&parent.children[index])
                        && !selected.contains(&parent.children[index - 1])
                    {
                        parent.children.swap(index, index - 1);
                    }
                }
            }
            MoveDirection::Down => {
                if parent.children.len() < 2 {
                    continue;
                }
                for index in (0..parent.children.len() - 1).rev() {
                    if selected.contains(&parent.children[index])
                        && !selected.contains(&parent.children[index + 1])
                    {
                        parent.children.swap(index, index + 1);
                    }
                }
            }
        }
    }
    for node_id in selected {
        touch_node(state, &node_id);
    }
    Ok(())
}

fn is_descendant(state: &DocumentState, node_id: &str, ancestor_id: &str) -> bool {
    let mut current = state
        .nodes
        .get(node_id)
        .and_then(|node| node.parent_id.clone());
    while let Some(id) = current {
        if id == ancestor_id {
            return true;
        }
        current = state.nodes.get(&id).and_then(|node| node.parent_id.clone());
    }
    false
}

fn is_in_trash(state: &DocumentState, node_id: &str) -> bool {
    node_id == TRASH_ID || is_descendant(state, node_id, TRASH_ID)
}

fn is_system_id(node_id: &str) -> bool {
    matches!(
        node_id,
        WORKSPACE_ID
            | DAILY_NOTES_ID
            | SCHEMA_ID
            | SEARCHES_ID
            | TRASH_ID
            | SETTINGS_ID
            | TAG_DAY_ID
            | TAG_WEEK_ID
            | TAG_YEAR_ID
    )
}

fn touch_node(state: &mut DocumentState, node_id: &str) {
    if let Some(node) = state.nodes.get_mut(node_id) {
        node.updated_at = now_ms();
    }
}

fn apply_child_tags(state: &mut DocumentState, parent_id: &str, child_id: &str) -> Result<()> {
    let tag_ids = state
        .nodes
        .get(parent_id)
        .map(|node| node.tags.clone())
        .unwrap_or_default();
    for tag_id in tag_ids {
        if let Some(child_supertag) = state
            .nodes
            .get(&tag_id)
            .and_then(|tag| tag.child_supertag.clone())
        {
            apply_tag_no_history(state, child_id, &child_supertag)?;
        }
    }
    Ok(())
}

fn apply_tag_no_history(state: &mut DocumentState, node_id: &str, tag_id: &str) -> Result<()> {
    {
        let node = state
            .nodes
            .get_mut(node_id)
            .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
        if !node.tags.iter().any(|id| id == tag_id) {
            node.tags.push(tag_id.to_string());
        }
        node.updated_at = now_ms();
    }
    instantiate_tag_template(state, node_id, tag_id)
}

#[derive(Debug, Clone)]
struct TemplateFieldRef {
    field_def_id: NodeId,
    template_origin_id: NodeId,
}

fn instantiate_tag_template(state: &mut DocumentState, node_id: &str, tag_id: &str) -> Result<()> {
    for chain_tag_id in get_extends_chain(state, tag_id) {
        for field_ref in get_template_field_defs(state, &chain_tag_id) {
            ensure_field_entry_from_template(
                state,
                node_id,
                &field_ref.field_def_id,
                &field_ref.template_origin_id,
                true,
            )?;
        }
    }

    for template_node_id in get_template_content_nodes(state, tag_id) {
        clone_template_content_node_shallow(state, node_id, &template_node_id)?;
    }
    Ok(())
}

fn ensure_field_entry_from_template(
    state: &mut DocumentState,
    node_id: &str,
    field_def_id: &str,
    template_origin_id: &str,
    clone_defaults: bool,
) -> Result<NodeId> {
    ensure_field_entry_with_template(
        state,
        node_id,
        field_def_id,
        Some(template_origin_id),
        clone_defaults,
    )
}

fn ensure_field_entry_with_template(
    state: &mut DocumentState,
    node_id: &str,
    field_def_id: &str,
    template_origin_id: Option<&str>,
    clone_defaults: bool,
) -> Result<NodeId> {
    let existing = state.nodes[node_id].children.iter().find_map(|child_id| {
        let child = state.nodes.get(child_id)?;
        if child.node_type.as_ref() == Some(&NodeType::FieldEntry)
            && child.field_def_id.as_deref() == Some(field_def_id)
        {
            Some(child_id.clone())
        } else {
            None
        }
    });
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = fresh_id("field_entry");
    insert_node(
        state,
        id.clone(),
        node_id.to_string(),
        Some(0),
        Some(NodeType::FieldEntry),
        |node| {
            node.field_def_id = Some(field_def_id.to_string());
            node.template_id = template_origin_id.map(ToString::to_string);
            node.content = RichText::plain("");
        },
    )?;
    if clone_defaults {
        if let Some(template_origin_id) = template_origin_id {
            clone_template_field_values(state, &id, template_origin_id)?;
        }
    }
    Ok(id)
}

fn get_extends_chain(state: &DocumentState, tag_id: &str) -> Vec<NodeId> {
    let mut chain = Vec::new();
    let mut visited = HashSet::new();
    let mut current = Some(tag_id.to_string());
    while let Some(id) = current {
        if !visited.insert(id.clone()) {
            break;
        }
        chain.push(id.clone());
        current = state.nodes.get(&id).and_then(|node| node.extends.clone());
    }
    chain
}

fn get_template_field_defs(state: &DocumentState, tag_id: &str) -> Vec<TemplateFieldRef> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    let child_ids = state
        .nodes
        .get(tag_id)
        .map(|node| node.children.clone())
        .unwrap_or_default();
    for child_id in child_ids {
        let Some(child) = state.nodes.get(&child_id) else {
            continue;
        };
        let field_ref = if child.node_type.as_ref() == Some(&NodeType::FieldEntry) {
            child
                .field_def_id
                .as_ref()
                .map(|field_def_id| TemplateFieldRef {
                    field_def_id: field_def_id.clone(),
                    template_origin_id: child_id,
                })
        } else {
            None
        };
        if let Some(field_ref) = field_ref {
            if seen.insert(field_ref.field_def_id.clone()) {
                result.push(field_ref);
            }
        }
    }
    result
}

fn get_template_content_nodes(state: &DocumentState, tag_id: &str) -> Vec<NodeId> {
    state
        .nodes
        .get(tag_id)
        .map(|tag| tag.children.clone())
        .unwrap_or_default()
        .into_iter()
        .filter(|id| {
            matches!(
                state.nodes.get(id).and_then(|node| node.node_type.as_ref()),
                None | Some(NodeType::CodeBlock)
            )
        })
        .collect()
}

fn clone_template_field_values(
    state: &mut DocumentState,
    field_entry_id: &str,
    template_origin_id: &str,
) -> Result<()> {
    if state
        .nodes
        .get(template_origin_id)
        .and_then(|node| node.node_type.as_ref())
        != Some(&NodeType::FieldEntry)
    {
        return Ok(());
    }
    let value_ids = state
        .nodes
        .get(template_origin_id)
        .map(|node| node.children.clone())
        .unwrap_or_default();
    for value_id in value_ids {
        let Some(value) = state.nodes.get(&value_id).cloned() else {
            continue;
        };
        let cloned_id = fresh_id("value");
        insert_node(
            state,
            cloned_id,
            field_entry_id.to_string(),
            None,
            value.node_type.clone(),
            |node| {
                node.content = value.content.clone();
                node.description = value.description.clone();
                node.field_def_id = value.field_def_id.clone();
                node.target_id = value.target_id.clone();
                node.code_language = value.code_language.clone();
            },
        )?;
    }
    Ok(())
}

fn clone_template_content_node_shallow(
    state: &mut DocumentState,
    parent_id: &str,
    template_node_id: &str,
) -> Result<()> {
    let already_cloned = state.nodes[parent_id].children.iter().any(|child_id| {
        state
            .nodes
            .get(child_id)
            .and_then(|node| node.template_id.as_deref())
            == Some(template_node_id)
    });
    if already_cloned {
        return Ok(());
    }
    let template = state
        .nodes
        .get(template_node_id)
        .cloned()
        .ok_or_else(|| CoreError::NodeNotFound(template_node_id.to_string()))?;
    let cloned_id = fresh_id("template");
    insert_node(
        state,
        cloned_id,
        parent_id.to_string(),
        None,
        template.node_type.clone(),
        |node| {
            node.template_id = Some(template_node_id.to_string());
            node.content = template.content.clone();
            node.description = template.description.clone();
            node.code_language = template.code_language.clone();
            node.media_url = template.media_url.clone();
            node.media_alt = template.media_alt.clone();
            node.image_width = template.image_width;
            node.image_height = template.image_height;
            node.embed_type = template.embed_type.clone();
            node.embed_id = template.embed_id.clone();
            node.source_url = template.source_url.clone();
            node.ai_summary = template.ai_summary.clone();
        },
    )?;
    Ok(())
}

fn find_nodes_with_tag(state: &DocumentState, tag_id: &str) -> Vec<NodeId> {
    state
        .nodes
        .values()
        .filter(|node| node.tags.iter().any(|id| id == tag_id))
        .map(|node| node.id.clone())
        .collect()
}

fn cleanup_fields_from_removed_tag(
    state: &mut DocumentState,
    node_id: &str,
    removed_tag_id: &str,
) -> Result<()> {
    let remaining_tags = state
        .nodes
        .get(node_id)
        .map(|node| node.tags.clone())
        .unwrap_or_default();
    let mut required_by_remaining = HashSet::new();
    for tag_id in remaining_tags {
        for chain_tag_id in get_extends_chain(state, &tag_id) {
            for field_ref in get_template_field_defs(state, &chain_tag_id) {
                required_by_remaining.insert(field_ref.field_def_id);
            }
        }
    }

    let mut removed_fields = HashSet::new();
    for chain_tag_id in get_extends_chain(state, removed_tag_id) {
        for field_ref in get_template_field_defs(state, &chain_tag_id) {
            removed_fields.insert(field_ref.field_def_id);
        }
    }

    let field_entries_to_remove: Vec<NodeId> = state
        .nodes
        .get(node_id)
        .map(|node| node.children.clone())
        .unwrap_or_default()
        .into_iter()
        .filter(|child_id| {
            let Some(child) = state.nodes.get(child_id) else {
                return false;
            };
            child.node_type.as_ref() == Some(&NodeType::FieldEntry)
                && child.field_def_id.as_ref().is_some_and(|field_def_id| {
                    removed_fields.contains(field_def_id)
                        && !required_by_remaining.contains(field_def_id)
                })
        })
        .collect();

    for field_entry_id in field_entries_to_remove {
        remove_subtree(state, &field_entry_id)?;
    }
    Ok(())
}

fn find_tag_by_name(state: &DocumentState, name: &str) -> Option<NodeId> {
    let needle = name.trim().to_lowercase();
    state.nodes.values().find_map(|node| {
        if node.node_type.as_ref() == Some(&NodeType::TagDef)
            && node.content.text.trim().to_lowercase() == needle
        {
            Some(node.id.clone())
        } else {
            None
        }
    })
}

fn next_tag_color(state: &DocumentState) -> String {
    const COLORS: &[&str] = &[
        "red", "orange", "amber", "yellow", "green", "teal", "blue", "indigo", "violet", "brown",
    ];
    let count = state
        .nodes
        .values()
        .filter(|node| node.node_type.as_ref() == Some(&NodeType::TagDef))
        .count();
    COLORS[count % COLORS.len()].to_string()
}

fn refresh_tag_search_children(
    state: &mut DocumentState,
    search_id: &str,
    tag_id: &str,
) -> Result<()> {
    let previous_children = state
        .nodes
        .get(search_id)
        .map(|node| node.children.clone())
        .unwrap_or_default();
    for child_id in previous_children {
        remove_subtree(state, &child_id)?;
    }

    let mut target_ids: Vec<NodeId> = state
        .nodes
        .values()
        .filter(|node| {
            node.id != search_id
                && node.id != tag_id
                && !is_system_id(&node.id)
                && !is_in_trash(state, &node.id)
                && node.node_type.as_ref() != Some(&NodeType::Search)
                && node.tags.iter().any(|id| id == tag_id)
        })
        .map(|node| node.id.clone())
        .collect();
    target_ids.sort_by(|left, right| {
        let left_text = state
            .nodes
            .get(left)
            .map(|node| node.content.text.as_str())
            .unwrap_or_default();
        let right_text = state
            .nodes
            .get(right)
            .map(|node| node.content.text.as_str())
            .unwrap_or_default();
        left_text.cmp(right_text).then_with(|| left.cmp(right))
    });

    for target_id in target_ids {
        let ref_id = fresh_id("ref");
        insert_node(
            state,
            ref_id,
            search_id.to_string(),
            None,
            Some(NodeType::Reference),
            |node| {
                node.target_id = Some(target_id);
            },
        )?;
    }
    Ok(())
}

fn ensure_date_node_in_state(
    state: &mut DocumentState,
    year: i32,
    month: u32,
    day: u32,
) -> Result<NodeId> {
    let year_name = year.to_string();
    let week = iso_week(year, month, day)?;
    let week_name = format!("W{:02}", week);
    let day_name = format!("{year:04}-{month:02}-{day:02}");

    let year_id = find_or_create_named_child(state, DAILY_NOTES_ID, &year_name, Some(TAG_YEAR_ID))?;
    let week_id = find_or_create_named_child(state, &year_id, &week_name, Some(TAG_WEEK_ID))?;
    find_or_create_named_child(state, &week_id, &day_name, Some(TAG_DAY_ID))
}

fn find_or_create_named_child(
    state: &mut DocumentState,
    parent_id: &str,
    name: &str,
    tag_id: Option<&str>,
) -> Result<NodeId> {
    if let Some(parent) = state.nodes.get(parent_id) {
        for child_id in &parent.children {
            if state
                .nodes
                .get(child_id)
                .map(|node| node.content.text.as_str())
                == Some(name)
            {
                return Ok(child_id.clone());
            }
        }
    }
    let id = fresh_id("date");
    insert_node(
        state,
        id.clone(),
        parent_id.to_string(),
        Some(0),
        None,
        |node| {
            node.content = RichText::plain(name);
            node.locked = true;
        },
    )?;
    if let Some(tag_id) = tag_id {
        apply_tag_no_history(state, &id, tag_id)?;
    }
    Ok(id)
}

fn iso_week(year: i32, month: u32, day: u32) -> Result<u32> {
    let date = chrono::NaiveDate::from_ymd_opt(year, month, day)
        .ok_or_else(|| CoreError::InvalidOperation("invalid date".to_string()))?;
    Ok(date.iso_week().week())
}

fn would_create_reference_cycle(state: &DocumentState, parent_id: &str, target_id: &str) -> bool {
    if parent_id == target_id {
        return true;
    }
    let mut stack = vec![target_id.to_string()];
    let mut visited = HashSet::new();
    while let Some(id) = stack.pop() {
        if !visited.insert(id.clone()) {
            continue;
        }
        if id == parent_id {
            return true;
        }
        if let Some(node) = state.nodes.get(&id) {
            for child_id in &node.children {
                if let Some(child) = state.nodes.get(child_id) {
                    if child.node_type.as_ref() == Some(&NodeType::Reference) {
                        if let Some(target) = &child.target_id {
                            stack.push(target.clone());
                        }
                    } else {
                        stack.push(child_id.clone());
                    }
                }
            }
        }
    }
    false
}

fn is_search_candidate(state: &DocumentState, node_id: &str) -> bool {
    if is_in_trash(state, node_id) || is_system_id(node_id) {
        return false;
    }
    matches!(
        state
            .nodes
            .get(node_id)
            .and_then(|node| node.node_type.as_ref()),
        None | Some(NodeType::TagDef | NodeType::FieldDef | NodeType::Search | NodeType::CodeBlock)
    )
}

fn fresh_id(prefix: &str) -> NodeId {
    format!("{prefix}:{}", Uuid::new_v4())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn merge_node_into_target(state: &mut DocumentState, node_id: &str, target_id: &str) -> Result<()> {
    if node_id == target_id || is_descendant(state, target_id, node_id) {
        return Err(CoreError::InvalidMove);
    }

    let current = state
        .nodes
        .get(node_id)
        .cloned()
        .ok_or_else(|| CoreError::NodeNotFound(node_id.to_string()))?;
    let source_parent_id = current.parent_id.clone();
    let source_index = source_parent_id
        .as_deref()
        .and_then(|parent_id| child_index(state, parent_id, node_id));
    let current_content = current.content;
    let current_children = current.children;
    let now = now_ms();

    {
        let target = state
            .nodes
            .get_mut(target_id)
            .ok_or_else(|| CoreError::NodeNotFound(target_id.to_string()))?;
        target.content = append_rich_text(&target.content, &current_content);
        target.updated_at = now;
    }

    for (offset, child_id) in current_children.into_iter().enumerate() {
        let insert_index = if source_parent_id.as_deref() == Some(target_id) {
            source_index.map(|index| index + 1 + offset)
        } else {
            None
        };
        move_node_no_touch(state, &child_id, target_id, insert_index)?;
    }

    remove_subtree(state, node_id)
}

fn rich_text_offset_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn append_rich_text(left: &RichText, right: &RichText) -> RichText {
    let offset = rich_text_offset_len(&left.text);
    let mut text = left.text.clone();
    text.push_str(&right.text);

    let mut marks = left.marks.clone();
    marks.extend(right.marks.iter().map(|mark| TextMark {
        start: mark.start + offset,
        end: mark.end + offset,
        mark_type: mark.mark_type.clone(),
        attrs: mark.attrs.clone(),
    }));

    let mut inline_refs = left.inline_refs.clone();
    inline_refs.extend(right.inline_refs.iter().map(|inline_ref| InlineRef {
        offset: inline_ref.offset + offset,
        target_id: inline_ref.target_id.clone(),
        display_name: inline_ref.display_name.clone(),
    }));

    RichText {
        text,
        marks,
        inline_refs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_moves_nodes() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let first = core
            .create_node(&today, None, "First")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let second = core
            .create_node(&today, None, "Second")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        core.indent_node(&second).unwrap();

        let state = core.state();
        assert_eq!(
            state.nodes[&second].parent_id.as_deref(),
            Some(first.as_str())
        );
        assert!(state.nodes[&first].children.contains(&second));
    }

    #[test]
    fn updates_node_description_and_view_settings() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let node_id = core
            .create_node(&today, None, "Node")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        core.update_node_description(&node_id, Some("  Description  ".to_string()))
            .unwrap();
        core.set_node_toolbar_visible(&node_id, true).unwrap();
        core.set_node_sort(&node_id, Some("__name".to_string()), Some(SortDirection::Desc))
            .unwrap();
        core.set_node_filter(
            &node_id,
            Some("__name".to_string()),
            Some(FilterOp::Any),
            vec![" alpha ".to_string(), "Alpha".to_string(), "".to_string()],
        )
        .unwrap();
        core.set_node_group(&node_id, Some("__name".to_string()))
            .unwrap();

        let node = &core.state().nodes[&node_id];
        assert_eq!(node.description.as_deref(), Some("Description"));
        assert!(node.toolbar_visible);
        assert_eq!(node.sort_field.as_deref(), Some("__name"));
        assert_eq!(node.sort_direction.as_ref(), Some(&SortDirection::Desc));
        assert_eq!(node.filter_field.as_deref(), Some("__name"));
        assert_eq!(node.filter_op.as_ref(), Some(&FilterOp::Any));
        assert_eq!(node.filter_values, vec!["alpha"]);
        assert_eq!(node.group_field.as_deref(), Some("__name"));
    }

    #[test]
    fn clears_empty_view_settings() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let node_id = core
            .create_node(&today, None, "Node")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        core.update_node_description(&node_id, Some("".to_string()))
            .unwrap();
        core.set_node_sort(&node_id, None, Some(SortDirection::Desc))
            .unwrap();
        core.set_node_filter(&node_id, None, Some(FilterOp::Any), vec!["x".to_string()])
            .unwrap();
        core.set_node_group(&node_id, Some(" ".to_string()))
            .unwrap();

        let node = &core.state().nodes[&node_id];
        assert_eq!(node.description.as_deref(), None);
        assert_eq!(node.sort_field.as_deref(), None);
        assert_eq!(node.sort_direction.as_ref(), None);
        assert_eq!(node.filter_field.as_deref(), None);
        assert_eq!(node.filter_op.as_ref(), None);
        assert!(node.filter_values.is_empty());
        assert_eq!(node.group_field, None);
    }

    #[test]
    fn merge_node_into_previous_preserves_rich_text_offsets() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let target = core
            .create_node(&today, None, "Target")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let first = core
            .create_node(&today, None, "\u{1F600}")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let second = core
            .create_node(&today, None, "Hi")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        core.update_node_text(
            &first,
            RichText {
                text: "\u{1F600}".to_string(),
                marks: vec![TextMark {
                    start: 0,
                    end: 2,
                    mark_type: TextMarkKind::Bold,
                    attrs: BTreeMap::new(),
                }],
                inline_refs: vec![InlineRef {
                    offset: 2,
                    target_id: target.clone(),
                    display_name: Some("Target".to_string()),
                }],
            },
        )
        .unwrap();
        core.update_node_text(
            &second,
            RichText {
                text: "Hi".to_string(),
                marks: vec![TextMark {
                    start: 0,
                    end: 2,
                    mark_type: TextMarkKind::Code,
                    attrs: BTreeMap::new(),
                }],
                inline_refs: vec![InlineRef {
                    offset: 1,
                    target_id: target.clone(),
                    display_name: Some("Target".to_string()),
                }],
            },
        )
        .unwrap();

        core.merge_node_into_previous(&second).unwrap();

        let merged = &core.state().nodes[&first].content;
        assert_eq!(merged.text, "\u{1F600}Hi");
        assert_eq!(merged.marks.len(), 2);
        assert_eq!(merged.marks[0].start, 0);
        assert_eq!(merged.marks[0].end, 2);
        assert_eq!(merged.marks[1].start, 2);
        assert_eq!(merged.marks[1].end, 4);
        assert_eq!(
            merged
                .inline_refs
                .iter()
                .map(|inline_ref| inline_ref.offset)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert!(!core.state().nodes.contains_key(&second));
    }

    #[test]
    fn merge_node_into_parent_promotes_children_in_place() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let parent = core
            .create_node(&today, None, "Parent")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let current = core
            .create_node(&parent, None, " current")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let sibling = core
            .create_node(&parent, None, "Sibling")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let child = core
            .create_node(&current, None, "Child")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        core.merge_node_into(&current, &parent).unwrap();

        let state = core.state();
        assert_eq!(state.nodes[&parent].content.text, "Parent current");
        assert_eq!(state.nodes[&parent].children, vec![child.clone(), sibling]);
        assert_eq!(
            state.nodes[&child].parent_id.as_deref(),
            Some(parent.as_str())
        );
        assert!(!state.nodes.contains_key(&current));
    }

    #[test]
    fn batch_duplicate_nodes_clones_subtrees_after_sources() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let first = core
            .create_node(&today, None, "First")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let child = core
            .create_node(&first, None, "Child")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let second = core
            .create_node(&today, None, "Second")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        let outcome = core.batch_duplicate_nodes(vec![first.clone()]).unwrap();
        let clone_id = outcome.focus.unwrap().node_id;
        let state = core.state();
        let siblings = &state.nodes[&today].children;
        let first_index = siblings.iter().position(|id| id == &first).unwrap();
        assert_eq!(siblings[first_index + 1], clone_id);
        assert_eq!(siblings[first_index + 2], second);
        assert_ne!(clone_id, first);
        assert_eq!(state.nodes[&clone_id].content.text, "First");
        assert_eq!(state.nodes[&clone_id].children.len(), 1);
        let cloned_child = &state.nodes[&clone_id].children[0];
        assert_ne!(cloned_child, &child);
        assert_eq!(
            state.nodes[cloned_child].parent_id.as_deref(),
            Some(clone_id.as_str())
        );
        assert_eq!(state.nodes[cloned_child].content.text, "Child");
    }

    #[test]
    fn batch_move_nodes_moves_selected_sibling_block() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let first = core
            .create_node(&today, None, "A")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let second = core
            .create_node(&today, None, "B")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let third = core
            .create_node(&today, None, "C")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let fourth = core
            .create_node(&today, None, "D")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        core.batch_move_nodes_down(vec![second.clone(), third.clone()])
            .unwrap();
        assert_eq!(
            core.state().nodes[&today].children,
            vec![first.clone(), fourth.clone(), second.clone(), third.clone()]
        );

        core.batch_move_nodes_up(vec![second.clone(), third.clone()])
            .unwrap();
        assert_eq!(
            core.state().nodes[&today].children,
            vec![first, second, third, fourth]
        );
    }

    #[test]
    fn projection_exposes_public_node_fields() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let tag_id = core.create_tag("project").unwrap().focus.unwrap().node_id;
        let child_tag_id = core.create_tag("task").unwrap().focus.unwrap().node_id;
        let node_id = core
            .create_node(&today, None, "Launch")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        {
            let node = core.state.nodes.get_mut(&node_id).unwrap();
            node.child_supertag = Some(child_tag_id.clone());
            node.extends = Some(tag_id.clone());
            node.done_state_enabled = true;
            node.auto_collected = true;
            node.min_value = Some(1.0);
            node.max_value = Some(3.0);
            node.view_mode = Some("list".to_string());
            node.image_width = Some(640.0);
            node.image_height = Some(480.0);
            node.embed_type = Some("youtube".to_string());
            node.embed_id = Some("video-1".to_string());
            node.ai_summary = Some("Summary".to_string());
        }

        let projection = core.projection();
        let projected = projection
            .nodes
            .iter()
            .find(|node| node.id == node_id)
            .unwrap();

        assert_eq!(
            projected.child_supertag.as_deref(),
            Some(child_tag_id.as_str())
        );
        assert_eq!(projected.extends.as_deref(), Some(tag_id.as_str()));
        assert!(projected.done_state_enabled);
        assert!(projected.auto_collected);
        assert_eq!(projected.min_value, Some(1.0));
        assert_eq!(projected.max_value, Some(3.0));
        assert_eq!(projected.view_mode.as_deref(), Some("list"));
        assert_eq!(projected.image_width, Some(640.0));
        assert_eq!(projected.image_height, Some(480.0));
        assert_eq!(projected.embed_type.as_deref(), Some("youtube"));
        assert_eq!(projected.embed_id.as_deref(), Some("video-1"));
        assert_eq!(projected.ai_summary.as_deref(), Some("Summary"));
    }

    #[test]
    fn set_tag_config_updates_definition_fields_and_rejects_cycles() {
        let mut core = Core::new();
        let parent_tag_id = core.create_tag("project").unwrap().focus.unwrap().node_id;
        let child_tag_id = core.create_tag("task").unwrap().focus.unwrap().node_id;
        let default_child_tag_id = core.create_tag("step").unwrap().focus.unwrap().node_id;

        core.set_tag_config(
            &child_tag_id,
            TagConfigPatch {
                color: Some(Some("#446655".to_string())),
                extends_tag: Some(Some(parent_tag_id.clone())),
                child_supertag: Some(Some(default_child_tag_id.clone())),
                show_checkbox: Some(true),
                done_state_enabled: Some(true),
            },
        )
        .unwrap();

        let child_tag = &core.state().nodes[&child_tag_id];
        assert_eq!(child_tag.color.as_deref(), Some("#446655"));
        assert_eq!(child_tag.extends.as_deref(), Some(parent_tag_id.as_str()));
        assert_eq!(
            child_tag.child_supertag.as_deref(),
            Some(default_child_tag_id.as_str())
        );
        assert!(child_tag.show_checkbox);
        assert!(child_tag.done_state_enabled);

        let result = core.set_tag_config(
            &parent_tag_id,
            TagConfigPatch {
                extends_tag: Some(Some(child_tag_id.clone())),
                ..Default::default()
            },
        );
        assert!(matches!(result, Err(CoreError::InvalidOperation(_))));
    }

    #[test]
    fn set_field_config_updates_typed_definition_fields() {
        let mut core = Core::new();
        let tag_id = core.create_tag("project").unwrap().focus.unwrap().node_id;
        let template_entry_id = core
            .create_field_def(&tag_id, "Status", FieldType::Plain)
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let field_id = core.state().nodes[&template_entry_id]
            .field_def_id
            .clone()
            .unwrap();

        core.set_field_config(
            &field_id,
            FieldConfigPatch {
                field_type: Some(FieldType::Number),
                nullable: Some(Some(false)),
                hide_field: Some(Some("empty".to_string())),
                min_value: Some(Some(1.0)),
                max_value: Some(Some(5.0)),
                ..Default::default()
            },
        )
        .unwrap();

        let field = &core.state().nodes[&field_id];
        assert_eq!(field.field_type.as_ref(), Some(&FieldType::Number));
        assert_eq!(field.nullable, Some(false));
        assert_eq!(field.hide_field.as_deref(), Some("empty"));
        assert_eq!(field.min_value, Some(1.0));
        assert_eq!(field.max_value, Some(5.0));

        core.set_field_config(
            &field_id,
            FieldConfigPatch {
                field_type: Some(FieldType::Options),
                autocollect_options: Some(true),
                ..Default::default()
            },
        )
        .unwrap();

        let field = &core.state().nodes[&field_id];
        assert_eq!(field.field_type.as_ref(), Some(&FieldType::Options));
        assert!(field.autocollect_options);
        assert_eq!(field.min_value, None);
        assert_eq!(field.max_value, None);

        let source_tag_id = core.create_tag("source").unwrap().focus.unwrap().node_id;
        core.set_field_config(
            &field_id,
            FieldConfigPatch {
                field_type: Some(FieldType::OptionsFromSupertag),
                source_supertag: Some(Some(source_tag_id.clone())),
                ..Default::default()
            },
        )
        .unwrap();

        let field = &core.state().nodes[&field_id];
        assert_eq!(
            field.field_type.as_ref(),
            Some(&FieldType::OptionsFromSupertag)
        );
        assert_eq!(field.source_supertag.as_deref(), Some(source_tag_id.as_str()));
        assert!(!field.autocollect_options);
    }

    #[test]
    fn rich_text_heading_mark_round_trips() {
        let content = RichText {
            text: "Heading".to_string(),
            marks: vec![TextMark {
                start: 0,
                end: 7,
                mark_type: TextMarkKind::HeadingMark,
                attrs: BTreeMap::new(),
            }],
            inline_refs: Vec::new(),
        };

        let raw = serde_json::to_string(&content).unwrap();
        assert!(raw.contains("headingMark"));
        let parsed: RichText = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed, content);
    }

    #[test]
    fn undo_restores_previous_tree() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let created = core
            .create_node(&today, None, "Task")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        assert!(core.state().nodes.contains_key(&created));

        core.undo().unwrap();
        assert!(!core.state().nodes.contains_key(&created));

        core.redo().unwrap();
        assert!(core.state().nodes.contains_key(&created));
    }

    #[test]
    fn batch_trash_is_one_undo_step() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let first = core
            .create_node(&today, None, "First")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let second = core
            .create_node(&today, None, "Second")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        core.batch_trash_nodes(vec![first.clone(), second.clone()])
            .unwrap();
        assert_eq!(
            core.state().nodes[&first].parent_id.as_deref(),
            Some(TRASH_ID)
        );
        assert_eq!(
            core.state().nodes[&second].parent_id.as_deref(),
            Some(TRASH_ID)
        );

        core.undo().unwrap();
        assert_eq!(
            core.state().nodes[&first].parent_id.as_deref(),
            Some(today.as_str())
        );
        assert_eq!(
            core.state().nodes[&second].parent_id.as_deref(),
            Some(today.as_str())
        );
    }

    #[test]
    fn batch_apply_tag_is_one_undo_step() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let tag_id = core.create_tag("project").unwrap().focus.unwrap().node_id;
        let first = core
            .create_node(&today, None, "First")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let second = core
            .create_node(&today, None, "Second")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        let outcome = core
            .batch_apply_tag(vec![first.clone(), second.clone()], &tag_id)
            .unwrap();
        assert!(outcome.focus.is_none());
        assert!(core.state().nodes[&first].tags.contains(&tag_id));
        assert!(core.state().nodes[&second].tags.contains(&tag_id));

        core.undo().unwrap();
        assert!(!core.state().nodes[&first].tags.contains(&tag_id));
        assert!(!core.state().nodes[&second].tags.contains(&tag_id));
    }

    #[test]
    fn batch_indent_and_outdent_preserve_sibling_order() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let first = core
            .create_node(&today, None, "First")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let second = core
            .create_node(&today, None, "Second")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let third = core
            .create_node(&today, None, "Third")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        core.batch_indent_nodes(vec![second.clone(), third.clone()])
            .unwrap();
        assert_eq!(
            core.state().nodes[&second].parent_id.as_deref(),
            Some(first.as_str())
        );
        assert_eq!(
            core.state().nodes[&third].parent_id.as_deref(),
            Some(first.as_str())
        );
        assert_eq!(
            core.state().nodes[&first].children,
            vec![second.clone(), third.clone()]
        );

        core.batch_outdent_nodes(vec![second.clone(), third.clone()])
            .unwrap();
        let children = &core.state().nodes[&today].children;
        let first_index = children.iter().position(|id| id == &first).unwrap();
        assert_eq!(&children[first_index + 1], &second);
        assert_eq!(&children[first_index + 2], &third);
    }

    #[test]
    fn tag_template_instantiates_field_entries() {
        let mut core = Core::new();
        let tag_id = core.create_tag("project").unwrap().focus.unwrap().node_id;
        let template_entry_id = core
            .create_field_def(&tag_id, "Status", FieldType::Plain)
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let field_id = core.state().nodes[&template_entry_id]
            .field_def_id
            .clone()
            .unwrap();
        assert_eq!(
            core.state().nodes[&field_id].parent_id.as_deref(),
            Some(SCHEMA_ID)
        );
        assert_eq!(
            core.state().nodes[&template_entry_id].parent_id.as_deref(),
            Some(tag_id.as_str())
        );
        let today = core.projection().today_id;
        let node_id = core
            .create_node(&today, None, "Launch")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        core.apply_tag(&node_id, &tag_id).unwrap();

        let node = &core.state().nodes[&node_id];
        let has_field_entry = node.children.iter().any(|child_id| {
            let child = &core.state().nodes[child_id];
            child.node_type.as_ref() == Some(&NodeType::FieldEntry)
                && child.field_def_id.as_deref() == Some(field_id.as_str())
        });
        assert!(has_field_entry);
    }

    #[test]
    fn create_inline_field_replaces_trigger_row_with_local_field_entry() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let before_id = core
            .create_node(&today, None, "Before")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let trigger_id = core
            .create_node(&today, None, ">Priority")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let after_id = core
            .create_node(&today, None, "After")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        let outcome = core
            .create_inline_field_after_node(&trigger_id, "Priority", FieldType::Plain)
            .unwrap();

        let field_entry_id = outcome.focus.unwrap().node_id;
        assert_eq!(
            core.state().nodes[&trigger_id].parent_id.as_deref(),
            Some(TRASH_ID)
        );
        assert_eq!(
            core.state().nodes[&today].children,
            vec![before_id.clone(), field_entry_id.clone(), after_id.clone()]
        );
        let field_def_id = core.state().nodes[&field_entry_id]
            .field_def_id
            .as_ref()
            .cloned()
            .unwrap();
        let field_def = &core.state().nodes[&field_def_id];
        assert_eq!(field_def.parent_id.as_deref(), Some(SCHEMA_ID));
        assert_eq!(field_def.node_type.as_ref(), Some(&NodeType::FieldDef));
        assert_eq!(field_def.content.text, "Priority");

        core.undo().unwrap();
        assert_eq!(
            core.state().nodes[&today].children,
            vec![before_id, trigger_id.clone(), after_id]
        );
        assert_eq!(
            core.state().nodes[&trigger_id].parent_id.as_deref(),
            Some(today.as_str())
        );
        assert!(!core.state().nodes.contains_key(&field_entry_id));
        assert!(!core.state().nodes.contains_key(&field_def_id));
    }

    #[test]
    fn create_inline_field_inserts_local_field_entry_without_trigger_row() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let before_id = core
            .create_node(&today, None, "Before")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let after_id = core
            .create_node(&today, None, "After")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        let outcome = core
            .create_inline_field(&today, Some(1), "Priority", FieldType::Plain)
            .unwrap();

        let field_entry_id = outcome.focus.unwrap().node_id;
        assert_eq!(
            core.state().nodes[&today].children,
            vec![before_id.clone(), field_entry_id.clone(), after_id.clone()]
        );
        let field_entry = &core.state().nodes[&field_entry_id];
        assert_eq!(field_entry.node_type.as_ref(), Some(&NodeType::FieldEntry));
        let field_def_id = field_entry.field_def_id.as_ref().cloned().unwrap();
        let field_def = &core.state().nodes[&field_def_id];
        assert_eq!(field_def.parent_id.as_deref(), Some(SCHEMA_ID));
        assert_eq!(field_def.node_type.as_ref(), Some(&NodeType::FieldDef));
        assert_eq!(field_def.content.text, "Priority");
        assert!(!core
            .state()
            .nodes
            .values()
            .any(|node| node.content.text == ">"));

        core.undo().unwrap();
        assert_eq!(
            core.state().nodes[&today].children,
            vec![before_id, after_id]
        );
        assert!(!core.state().nodes.contains_key(&field_entry_id));
        assert!(!core.state().nodes.contains_key(&field_def_id));
    }

    #[test]
    fn field_entry_accepts_regular_children() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let trigger_id = core
            .create_node(&today, None, ">Priority")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let field_entry_id = core
            .create_inline_field_after_node(&trigger_id, "Priority", FieldType::Plain)
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let content_id = core
            .create_node(&today, None, "Task")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        core.indent_node(&content_id).unwrap();

        assert_eq!(
            core.state().nodes[&content_id].parent_id.as_deref(),
            Some(field_entry_id.as_str())
        );
        assert_eq!(
            core.state().nodes[&field_entry_id].children,
            vec![content_id]
        );
        assert_eq!(core.state().nodes[&today].children, vec![field_entry_id]);
    }

    #[test]
    fn done_toggle_applies_to_field_entries() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let trigger_id = core
            .create_node(&today, None, ">Status")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let field_entry_id = core
            .create_inline_field_after_node(&trigger_id, "Status", FieldType::Plain)
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        core.toggle_done(&field_entry_id).unwrap();
        assert!(core.state().nodes[&field_entry_id].completed_at.is_some());
        core.batch_toggle_done(vec![field_entry_id.clone()])
            .unwrap();

        assert_eq!(core.state().nodes[&field_entry_id].completed_at, None);
    }

    #[test]
    fn options_field_registers_and_selects_reference_value() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let outcome = core
            .create_inline_field(&today, None, "Status", FieldType::Options)
            .unwrap();
        let field_entry_id = outcome.focus.unwrap().node_id;
        let field_def_id = core.state().nodes[&field_entry_id]
            .field_def_id
            .clone()
            .unwrap();

        let option_id = core
            .register_collected_option(&field_def_id, "Done")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        assert_eq!(
            core.state().nodes[&option_id].parent_id.as_deref(),
            Some(field_def_id.as_str())
        );
        assert!(core.state().nodes[&option_id].auto_collected);

        core.select_field_option(&field_entry_id, &option_id)
            .unwrap();

        let field_entry = &core.state().nodes[&field_entry_id];
        assert_eq!(field_entry.children.len(), 1);
        let value_id = &field_entry.children[0];
        let value_node = &core.state().nodes[value_id];
        assert_eq!(value_node.node_type.as_ref(), Some(&NodeType::Reference));
        assert_eq!(value_node.target_id.as_deref(), Some(option_id.as_str()));

        let same_option_id = core
            .register_collected_option(&field_def_id, "done")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        assert_eq!(same_option_id, option_id);

        core.undo().unwrap();
        assert!(core.state().nodes[&field_entry_id].children.is_empty());
        core.undo().unwrap();
        assert!(!core.state().nodes.contains_key(&option_id));
    }

    #[test]
    fn create_nodes_from_tree_is_one_rich_structural_operation() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let outcome = core
            .create_nodes_from_tree(
                &today,
                vec![CreateNodeTree {
                    content: RichText {
                        text: "Parent".to_string(),
                        marks: vec![TextMark {
                            start: 0,
                            end: 6,
                            mark_type: TextMarkKind::HeadingMark,
                            attrs: Default::default(),
                        }],
                        inline_refs: Vec::new(),
                    },
                    children: vec![CreateNodeTree {
                        content: RichText::plain("Child"),
                        children: Vec::new(),
                    }],
                }],
            )
            .unwrap();
        let parent_id = outcome.focus.unwrap().node_id;
        let child_id = core.state().nodes[&parent_id].children[0].clone();

        assert_eq!(core.state().nodes[&parent_id].content.text, "Parent");
        assert_eq!(core.state().nodes[&parent_id].content.marks.len(), 1);
        assert_eq!(
            core.state().nodes[&child_id].parent_id.as_deref(),
            Some(parent_id.as_str())
        );

        core.undo().unwrap();
        assert!(!core.state().nodes.contains_key(&parent_id));
        assert!(!core.state().nodes.contains_key(&child_id));
    }

    #[test]
    fn paste_nodes_into_node_updates_row_and_inserts_children_and_siblings_after_it() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let current = core
            .create_node(&today, None, "Current")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let next = core
            .create_node(&today, None, "Next")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        let outcome = core
            .paste_nodes_into_node(
                &current,
                RichText::plain("Pasted"),
                vec![CreateNodeTree {
                    content: RichText::plain("Child"),
                    children: Vec::new(),
                }],
                vec![
                    CreateNodeTree {
                        content: RichText::plain("Sibling A"),
                        children: Vec::new(),
                    },
                    CreateNodeTree {
                        content: RichText::plain("Sibling B"),
                        children: Vec::new(),
                    },
                ],
            )
            .unwrap();

        assert_eq!(core.state().nodes[&current].content.text, "Pasted");
        let child = core.state().nodes[&current].children[0].clone();
        assert_eq!(core.state().nodes[&child].content.text, "Child");

        let today_children = &core.state().nodes[&today].children;
        let current_index = today_children.iter().position(|id| id == &current).unwrap();
        assert_eq!(today_children[current_index + 3], next);
        let sibling_a = &today_children[current_index + 1];
        let sibling_b = &today_children[current_index + 2];
        assert_eq!(core.state().nodes[sibling_a].content.text, "Sibling A");
        assert_eq!(core.state().nodes[sibling_b].content.text, "Sibling B");
        assert_eq!(outcome.focus.unwrap().node_id, *sibling_b);

        core.undo().unwrap();
        assert_eq!(core.state().nodes[&current].content.text, "Current");
        assert!(core.state().nodes[&current].children.is_empty());
        assert_eq!(core.state().nodes[&today].children, vec![current, next]);
    }

    #[test]
    fn content_nodes_have_no_structural_type() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let node_id = core
            .create_node(&today, None, "Plain content")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        assert_eq!(core.state().nodes[&node_id].node_type, None);
    }

    #[test]
    fn tag_extends_instantiates_parent_template_fields() {
        let mut core = Core::new();
        let parent_tag_id = core.create_tag("entity").unwrap().focus.unwrap().node_id;
        let child_tag_id = core.create_tag("person").unwrap().focus.unwrap().node_id;
        core.state.nodes.get_mut(&child_tag_id).unwrap().extends = Some(parent_tag_id.clone());
        let template_entry_id = core
            .create_field_def(&parent_tag_id, "Owner", FieldType::Plain)
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let field_id = core.state().nodes[&template_entry_id]
            .field_def_id
            .clone()
            .unwrap();
        let today = core.projection().today_id;
        let node_id = core
            .create_node(&today, None, "Ada")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        core.apply_tag(&node_id, &child_tag_id).unwrap();

        let node = &core.state().nodes[&node_id];
        assert!(node.children.iter().any(|child_id| {
            let child = &core.state().nodes[child_id];
            child.node_type.as_ref() == Some(&NodeType::FieldEntry)
                && child.field_def_id.as_deref() == Some(field_id.as_str())
                && child.template_id.as_deref() == Some(template_entry_id.as_str())
        }));
    }

    #[test]
    fn tag_template_clones_default_content() {
        let mut core = Core::new();
        let tag_id = core.create_tag("meeting").unwrap().focus.unwrap().node_id;
        let template_id = fresh_id("template");
        insert_node(
            &mut core.state,
            template_id.clone(),
            tag_id.clone(),
            None,
            None,
            |node| {
                node.content = RichText::plain("Agenda");
            },
        )
        .unwrap();
        let today = core.projection().today_id;
        let node_id = core
            .create_node(&today, None, "Weekly sync")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        core.apply_tag(&node_id, &tag_id).unwrap();

        let node = &core.state().nodes[&node_id];
        assert!(node.children.iter().any(|child_id| {
            let child = &core.state().nodes[child_id];
            child.template_id.as_deref() == Some(template_id.as_str())
                && child.content.text == "Agenda"
        }));
    }

    #[test]
    fn remove_tag_removes_unshared_template_fields() {
        let mut core = Core::new();
        let tag_id = core.create_tag("project").unwrap().focus.unwrap().node_id;
        let template_entry_id = core
            .create_field_def(&tag_id, "Status", FieldType::Plain)
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let field_id = core.state().nodes[&template_entry_id]
            .field_def_id
            .clone()
            .unwrap();
        let today = core.projection().today_id;
        let node_id = core
            .create_node(&today, None, "Launch")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        core.apply_tag(&node_id, &tag_id).unwrap();
        core.remove_tag(&node_id, &tag_id).unwrap();

        let node = &core.state().nodes[&node_id];
        assert!(!node.children.iter().any(|child_id| {
            let child = &core.state().nodes[child_id];
            child.node_type.as_ref() == Some(&NodeType::FieldEntry)
                && child.field_def_id.as_deref() == Some(field_id.as_str())
        }));
    }

    #[test]
    fn blocks_reference_display_cycles() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let a = core
            .create_node(&today, None, "A")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let b = core
            .create_node(&a, None, "B")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let err = core.add_reference(&b, &a, None).unwrap_err();
        assert!(matches!(err, CoreError::ReferenceCycle));
    }

    #[test]
    fn replace_node_with_reference_is_one_structural_operation() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let target = core
            .create_node(&today, None, "Target")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let trigger = core
            .create_node(&today, None, "@Target")
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        let reference_id = core
            .replace_node_with_reference(&trigger, &target)
            .unwrap()
            .focus
            .unwrap()
            .node_id;

        let today_children = &core.state().nodes[&today].children;
        assert!(today_children.contains(&reference_id));
        assert!(!today_children.contains(&trigger));
        assert_eq!(
            core.state().nodes[&reference_id].node_type.as_ref(),
            Some(&NodeType::Reference)
        );
        assert_eq!(
            core.state().nodes[&reference_id].target_id.as_deref(),
            Some(target.as_str())
        );
        assert_eq!(
            core.state().nodes[&trigger].parent_id.as_deref(),
            Some(TRASH_ID)
        );

        core.undo().unwrap();
        let today_children = &core.state().nodes[&today].children;
        assert!(today_children.contains(&trigger));
        assert!(!today_children.contains(&reference_id));
    }

    #[test]
    fn ensure_tag_search_creates_reusable_search_with_references() {
        let mut core = Core::new();
        let today = core.projection().today_id;
        let node_id = core
            .create_node(&today, None, "Tagged")
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let tag_id = core.create_tag("project").unwrap().focus.unwrap().node_id;
        core.apply_tag(&node_id, &tag_id).unwrap();

        let search_id = core
            .ensure_tag_search(&tag_id)
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        let search = &core.state().nodes[&search_id];
        assert_eq!(search.node_type.as_ref(), Some(&NodeType::Search));
        assert_eq!(search.query_op.as_ref(), Some(&QueryOp::HasTag));
        assert_eq!(search.query_tag_def_id.as_deref(), Some(tag_id.as_str()));
        assert_eq!(search.children.len(), 1);
        let reference = &core.state().nodes[&search.children[0]];
        assert_eq!(reference.node_type.as_ref(), Some(&NodeType::Reference));
        assert_eq!(reference.target_id.as_deref(), Some(node_id.as_str()));

        let same_search_id = core
            .ensure_tag_search(&tag_id)
            .unwrap()
            .focus
            .unwrap()
            .node_id;
        assert_eq!(same_search_id, search_id);
        assert_eq!(core.state().nodes[&search_id].children.len(), 1);
    }
}
