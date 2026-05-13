use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("node not found: {0}")]
    NodeNotFound(String),
    #[error("parent not found: {0}")]
    ParentNotFound(String),
    #[error("operation is not allowed on locked node: {0}")]
    LockedNode(String),
    #[error("cannot move a node into itself or its descendant")]
    InvalidMove,
    #[error("cannot create a reference cycle")]
    ReferenceCycle,
    #[error("no previous sibling is available")]
    NoPreviousSibling,
    #[error("no parent is available")]
    NoParent,
    #[error("invalid operation: {0}")]
    InvalidOperation(String),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, CoreError>;
