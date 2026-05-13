use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type NodeId = String;

pub const WORKSPACE_ID: &str = "workspace";
pub const DAILY_NOTES_ID: &str = "daily-notes";
pub const SCHEMA_ID: &str = "schema";
pub const SEARCHES_ID: &str = "searches";
pub const TRASH_ID: &str = "trash";
pub const SETTINGS_ID: &str = "settings";
pub const TAG_DAY_ID: &str = "tag:day";
pub const TAG_WEEK_ID: &str = "tag:week";
pub const TAG_YEAR_ID: &str = "tag:year";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeType {
    FieldEntry,
    Reference,
    CodeBlock,
    Image,
    Embed,
    TagDef,
    FieldDef,
    ViewDef,
    SortRule,
    Search,
    QueryCondition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    Plain,
    Options,
    OptionsFromSupertag,
    Date,
    Number,
    Password,
    Formula,
    User,
    Url,
    Email,
    Checkbox,
    Boolean,
    Color,
}

impl Default for FieldType {
    fn default() -> Self {
        Self::Plain
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagConfigPatch {
    #[serde(default)]
    pub color: Option<Option<String>>,
    #[serde(default, rename = "extends")]
    pub extends_tag: Option<Option<NodeId>>,
    #[serde(default)]
    pub child_supertag: Option<Option<NodeId>>,
    #[serde(default)]
    pub show_checkbox: Option<bool>,
    #[serde(default)]
    pub done_state_enabled: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldConfigPatch {
    #[serde(default)]
    pub field_type: Option<FieldType>,
    #[serde(default)]
    pub source_supertag: Option<Option<NodeId>>,
    #[serde(default)]
    pub nullable: Option<Option<bool>>,
    #[serde(default)]
    pub hide_field: Option<Option<String>>,
    #[serde(default)]
    pub auto_initialize: Option<Option<String>>,
    #[serde(default)]
    pub autocollect_options: Option<bool>,
    #[serde(default)]
    pub min_value: Option<Option<f64>>,
    #[serde(default)]
    pub max_value: Option<Option<f64>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextMarkKind {
    Bold,
    Italic,
    Strike,
    Code,
    Highlight,
    HeadingMark,
    Link,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextMark {
    pub start: usize,
    pub end: usize,
    #[serde(rename = "type")]
    pub mark_type: TextMarkKind,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub attrs: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineRef {
    pub offset: usize,
    #[serde(rename = "targetNodeId")]
    pub target_id: NodeId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RichText {
    pub text: String,
    #[serde(default)]
    pub marks: Vec<TextMark>,
    #[serde(default)]
    pub inline_refs: Vec<InlineRef>,
}

impl RichText {
    pub fn plain(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            marks: Vec::new(),
            inline_refs: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterOp {
    All,
    Any,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum QueryLogic {
    And,
    Or,
    Not,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum QueryOp {
    HasTag,
    Todo,
    Done,
    NotDone,
    FieldIs,
    FieldIsNot,
    IsEmpty,
    IsNotEmpty,
    FieldContains,
    Lt,
    Gt,
    CreatedLastDays,
    EditedLastDays,
    DoneLastDays,
    HasField,
    LinksTo,
    StringMatch,
    RegexpMatch,
    ChildOf,
    IsType,
    ForDate,
    ForRelativeDate,
    ParentsDescendants,
    InLibrary,
    OnDayNode,
    EditedBy,
    OwnedBy,
    Overdue,
    HasMedia,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: NodeId,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub node_type: Option<NodeType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<NodeId>,
    #[serde(default)]
    pub children: Vec<NodeId>,
    #[serde(default)]
    pub content: RichText,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Vec<NodeId>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    #[serde(default)]
    pub locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default)]
    pub show_checkbox: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template_id: Option<NodeId>,
    #[serde(rename = "childSupertag", skip_serializing_if = "Option::is_none")]
    pub child_supertag: Option<NodeId>,
    #[serde(rename = "extends", skip_serializing_if = "Option::is_none")]
    pub extends: Option<NodeId>,
    #[serde(default)]
    pub done_state_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_def_id: Option<NodeId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_type: Option<FieldType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cardinality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nullable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hide_field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_initialize: Option<String>,
    #[serde(default)]
    pub autocollect_options: bool,
    #[serde(default)]
    pub auto_collected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_value: Option<f64>,
    #[serde(rename = "sourceSupertag", skip_serializing_if = "Option::is_none")]
    pub source_supertag: Option<NodeId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_id: Option<NodeId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_mode: Option<String>,
    #[serde(default)]
    pub toolbar_visible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_direction: Option<SortDirection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter_field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter_op: Option<FilterOp>,
    #[serde(default)]
    pub filter_values: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_logic: Option<QueryLogic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_op: Option<QueryOp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_tag_def_id: Option<NodeId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_field_def_id: Option<NodeId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_refreshed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_alt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embed_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embed_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trashed_from_parent_id: Option<NodeId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trashed_from_index: Option<usize>,
}

impl Node {
    pub fn new(
        id: NodeId,
        node_type: Option<NodeType>,
        parent_id: Option<NodeId>,
        now: i64,
    ) -> Self {
        Self {
            id,
            node_type,
            parent_id,
            children: Vec::new(),
            content: RichText::default(),
            description: None,
            tags: Vec::new(),
            created_at: now,
            updated_at: now,
            completed_at: None,
            locked: false,
            color: None,
            show_checkbox: false,
            template_id: None,
            child_supertag: None,
            extends: None,
            done_state_enabled: false,
            field_def_id: None,
            field_type: None,
            cardinality: None,
            nullable: None,
            hide_field: None,
            auto_initialize: None,
            autocollect_options: false,
            auto_collected: false,
            min_value: None,
            max_value: None,
            source_supertag: None,
            target_id: None,
            view_mode: None,
            toolbar_visible: false,
            sort_field: None,
            sort_direction: None,
            group_field: None,
            filter_field: None,
            filter_op: None,
            filter_values: Vec::new(),
            query_logic: None,
            query_op: None,
            query_tag_def_id: None,
            query_field_def_id: None,
            last_refreshed_at: None,
            code_language: None,
            media_url: None,
            media_alt: None,
            image_width: None,
            image_height: None,
            embed_type: None,
            embed_id: None,
            source_url: None,
            ai_summary: None,
            trashed_from_parent_id: None,
            trashed_from_index: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentState {
    pub schema_version: u32,
    pub workspace_id: NodeId,
    pub root_id: NodeId,
    #[serde(default)]
    pub nodes: BTreeMap<NodeId, Node>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeProjection {
    pub id: NodeId,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub node_type: Option<NodeType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<NodeId>,
    pub children: Vec<NodeId>,
    pub content: RichText,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub tags: Vec<NodeId>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    pub locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub show_checkbox: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template_id: Option<NodeId>,
    #[serde(rename = "childSupertag", skip_serializing_if = "Option::is_none")]
    pub child_supertag: Option<NodeId>,
    #[serde(rename = "extends", skip_serializing_if = "Option::is_none")]
    pub extends: Option<NodeId>,
    pub done_state_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_def_id: Option<NodeId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_type: Option<FieldType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cardinality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nullable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hide_field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_initialize: Option<String>,
    pub autocollect_options: bool,
    pub auto_collected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_value: Option<f64>,
    #[serde(rename = "sourceSupertag", skip_serializing_if = "Option::is_none")]
    pub source_supertag: Option<NodeId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_id: Option<NodeId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_mode: Option<String>,
    pub toolbar_visible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_direction: Option<SortDirection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter_field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter_op: Option<FilterOp>,
    pub filter_values: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_logic: Option<QueryLogic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_op: Option<QueryOp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_tag_def_id: Option<NodeId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_field_def_id: Option<NodeId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_refreshed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_alt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embed_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embed_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_summary: Option<String>,
}

impl From<&Node> for NodeProjection {
    fn from(node: &Node) -> Self {
        Self {
            id: node.id.clone(),
            node_type: node.node_type.clone(),
            parent_id: node.parent_id.clone(),
            children: node.children.clone(),
            content: node.content.clone(),
            description: node.description.clone(),
            tags: node.tags.clone(),
            created_at: node.created_at,
            updated_at: node.updated_at,
            completed_at: node.completed_at,
            locked: node.locked,
            color: node.color.clone(),
            show_checkbox: node.show_checkbox,
            template_id: node.template_id.clone(),
            child_supertag: node.child_supertag.clone(),
            extends: node.extends.clone(),
            done_state_enabled: node.done_state_enabled,
            field_def_id: node.field_def_id.clone(),
            field_type: node.field_type.clone(),
            cardinality: node.cardinality.clone(),
            nullable: node.nullable,
            hide_field: node.hide_field.clone(),
            auto_initialize: node.auto_initialize.clone(),
            autocollect_options: node.autocollect_options,
            auto_collected: node.auto_collected,
            min_value: node.min_value,
            max_value: node.max_value,
            source_supertag: node.source_supertag.clone(),
            target_id: node.target_id.clone(),
            view_mode: node.view_mode.clone(),
            toolbar_visible: node.toolbar_visible,
            sort_field: node.sort_field.clone(),
            sort_direction: node.sort_direction.clone(),
            group_field: node.group_field.clone(),
            filter_field: node.filter_field.clone(),
            filter_op: node.filter_op.clone(),
            filter_values: node.filter_values.clone(),
            query_logic: node.query_logic.clone(),
            query_op: node.query_op.clone(),
            query_tag_def_id: node.query_tag_def_id.clone(),
            query_field_def_id: node.query_field_def_id.clone(),
            last_refreshed_at: node.last_refreshed_at,
            code_language: node.code_language.clone(),
            media_url: node.media_url.clone(),
            media_alt: node.media_alt.clone(),
            image_width: node.image_width,
            image_height: node.image_height,
            embed_type: node.embed_type.clone(),
            embed_id: node.embed_id.clone(),
            source_url: node.source_url.clone(),
            ai_summary: node.ai_summary.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentProjection {
    pub workspace_id: NodeId,
    pub root_id: NodeId,
    pub daily_notes_id: NodeId,
    pub schema_id: NodeId,
    pub searches_id: NodeId,
    pub trash_id: NodeId,
    pub settings_id: NodeId,
    pub today_id: NodeId,
    pub nodes: Vec<NodeProjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusHint {
    pub node_id: NodeId,
    #[serde(default)]
    pub select_all: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutcome {
    pub projection: DocumentProjection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focus: Option<FocusHint>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNodeTree {
    pub content: RichText,
    #[serde(default)]
    pub children: Vec<CreateNodeTree>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    pub source_id: NodeId,
    pub reference_id: NodeId,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub node_id: NodeId,
    pub score: i32,
}
