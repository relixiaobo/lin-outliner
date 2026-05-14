use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    thread,
};
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager};
use thiserror::Error;

pub const AGENT_EVENT: &str = "lin-agent-event";

#[derive(Debug, Error)]
pub enum AgentHostError {
    #[error("failed to resolve agent worker path")]
    WorkerPath,
    #[error("agent worker is missing at {0}")]
    WorkerMissing(PathBuf),
    #[error("failed to start agent worker: {0}")]
    Start(std::io::Error),
    #[error("agent worker stdin is unavailable")]
    StdinUnavailable,
    #[error("agent worker stdout is unavailable")]
    StdoutUnavailable,
    #[error("agent worker command failed: {0}")]
    Command(std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl Serialize for AgentHostError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AgentHostResult<T> = Result<T, AgentHostError>;

pub struct AgentHost {
    worker: Mutex<Option<AgentWorkerProcess>>,
    next_session_id: AtomicU64,
}

struct AgentWorkerProcess {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Serialize)]
pub struct AgentSession {
    #[serde(rename = "sessionId")]
    pub session_id: String,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AgentWorkerCommand {
    CreateSession {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    SendMessage {
        #[serde(rename = "sessionId")]
        session_id: String,
        message: String,
    },
    StopSession {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    ResetSession {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    CloseSession {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentWorkerEvent {
    Ready {
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
        timestamp: u64,
    },
    Snapshot {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "lastEventType")]
        last_event_type: Option<String>,
        revision: u64,
        state: Value,
        timestamp: u64,
    },
    Error {
        #[serde(rename = "sessionId")]
        session_id: String,
        error: String,
        timestamp: u64,
    },
    Closed {
        #[serde(rename = "sessionId")]
        session_id: String,
        timestamp: u64,
    },
    ToolCall {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(default)]
        args: Value,
        timestamp: u64,
    },
    ToolResult {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(default)]
        result: Value,
        timestamp: u64,
    },
    ApprovalRequest {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(default)]
        payload: Value,
        timestamp: u64,
    },
}

impl AgentHost {
    pub fn new() -> Self {
        Self {
            worker: Mutex::new(None),
            next_session_id: AtomicU64::new(1),
        }
    }

    pub fn create_session(&self, app: &AppHandle) -> AgentHostResult<AgentSession> {
        let id = format!(
            "lin-agent-{}",
            self.next_session_id.fetch_add(1, Ordering::Relaxed)
        );
        self.send(
            app,
            AgentWorkerCommand::CreateSession {
                session_id: id.clone(),
            },
        )?;
        Ok(AgentSession { session_id: id })
    }

    pub fn send_message(
        &self,
        app: &AppHandle,
        session_id: String,
        message: String,
    ) -> AgentHostResult<()> {
        self.send(
            app,
            AgentWorkerCommand::SendMessage {
                session_id,
                message,
            },
        )
    }

    pub fn stop_session(&self, app: &AppHandle, session_id: String) -> AgentHostResult<()> {
        self.send(app, AgentWorkerCommand::StopSession { session_id })
    }

    pub fn reset_session(&self, app: &AppHandle, session_id: String) -> AgentHostResult<()> {
        self.send(app, AgentWorkerCommand::ResetSession { session_id })
    }

    pub fn close_session(&self, app: &AppHandle, session_id: String) -> AgentHostResult<()> {
        self.send(app, AgentWorkerCommand::CloseSession { session_id })
    }

    fn send(&self, app: &AppHandle, command: AgentWorkerCommand) -> AgentHostResult<()> {
        let mut worker = self.worker.lock().expect("agent worker mutex poisoned");
        if worker
            .as_mut()
            .and_then(|process| process.child.try_wait().ok().flatten())
            .is_some()
        {
            *worker = None;
        }

        if worker.is_none() {
            *worker = Some(spawn_worker(app)?);
        }

        let process = worker.as_mut().expect("agent worker initialized");
        serde_json::to_writer(&mut process.stdin, &command)?;
        process
            .stdin
            .write_all(b"\n")
            .map_err(AgentHostError::Command)?;
        process.stdin.flush().map_err(AgentHostError::Command)?;
        Ok(())
    }
}

fn spawn_worker(app: &AppHandle) -> AgentHostResult<AgentWorkerProcess> {
    let worker_path = resolve_worker_path(app)?;
    let mut child = Command::new(resolve_node_binary())
        .arg(&worker_path)
        .current_dir(resolve_project_root())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(AgentHostError::Start)?;

    let stdin = child.stdin.take().ok_or(AgentHostError::StdinUnavailable)?;
    let stdout = child
        .stdout
        .take()
        .ok_or(AgentHostError::StdoutUnavailable)?;
    let stderr = child.stderr.take();

    spawn_stdout_forwarder(app.clone(), stdout);
    if let Some(stderr) = stderr {
        spawn_stderr_forwarder(stderr);
    }

    Ok(AgentWorkerProcess { child, stdin })
}

fn resolve_worker_path(app: &AppHandle) -> AgentHostResult<PathBuf> {
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("agent-worker")
        .join("pi-mono-worker.mjs");
    if dev_path.exists() {
        return Ok(dev_path);
    }

    let resource_path = app
        .path()
        .resolve("agent-worker/pi-mono-worker.mjs", BaseDirectory::Resource)
        .map_err(|_| AgentHostError::WorkerPath)?;
    if resource_path.exists() {
        return Ok(resource_path);
    }

    Err(AgentHostError::WorkerMissing(resource_path))
}

fn resolve_project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn resolve_node_binary() -> String {
    std::env::var("LIN_AGENT_NODE").unwrap_or_else(|_| "node".to_string())
}

fn spawn_stdout_forwarder(app: AppHandle, stdout: impl std::io::Read + Send + 'static) {
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<AgentWorkerEvent>(&line) {
                Ok(payload) => {
                    let _ = app.emit(AGENT_EVENT, payload);
                }
                Err(error) => {
                    eprintln!("agent worker emitted invalid json: {error}: {line}");
                }
            }
        }
    });
}

fn spawn_stderr_forwarder(stderr: impl std::io::Read + Send + 'static) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            eprintln!("agent worker: {line}");
        }
    });
}
