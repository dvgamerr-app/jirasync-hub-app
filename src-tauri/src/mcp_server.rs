use std::{collections::HashMap, net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    Router,
    extract::State,
    http::{HeaderMap, Request, StatusCode, header::AUTHORIZATION},
    middleware::{self, Next},
    response::Response,
};
use rmcp::{
    ErrorData as McpError, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars, tool, tool_handler, tool_router,
    transport::{
        StreamableHttpServerConfig,
        streamable_http_server::{session::local::LocalSessionManager, tower::StreamableHttpService},
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex, oneshot};
use uuid::Uuid;

const BRIDGE_EVENT: &str = "mcp-bridge-request";
const BRIDGE_TIMEOUT: Duration = Duration::from_secs(15);
const MCP_PORT: u16 = 7317;
const TOKEN_FILE_NAME: &str = "kanban-mcp-token";

/// Bridges Rust-side MCP tool calls to the webview, where the Kanban Dexie/Zustand
/// store actually lives. Rust has no access to IndexedDB — every tool call is relayed
/// to the running window via an event and awaited on a oneshot channel keyed by request id.
pub struct McpBridgeState {
    app_handle: AppHandle,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
}

impl McpBridgeState {
    fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            pending: Mutex::new(HashMap::new()),
        }
    }

    async fn call(&self, tool: &str, params: Value) -> Result<Value, McpError> {
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(request_id.clone(), tx);

        let payload = serde_json::json!({ "requestId": request_id, "tool": tool, "params": params });
        if let Err(err) = self.app_handle.emit(BRIDGE_EVENT, payload) {
            self.pending.lock().await.remove(&request_id);
            return Err(McpError::internal_error(format!("failed to reach app: {err}"), None));
        }

        match tokio::time::timeout(BRIDGE_TIMEOUT, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(McpError::invalid_params(message, None)),
            Ok(Err(_)) => Err(McpError::internal_error("bridge channel closed unexpectedly", None)),
            Err(_) => {
                self.pending.lock().await.remove(&request_id);
                Err(McpError::internal_error(
                    "JiraSync Hub did not respond in time — is the app open?",
                    None,
                ))
            }
        }
    }

    async fn resolve(&self, request_id: String, result: Option<Value>, error: Option<String>) {
        if let Some(sender) = self.pending.lock().await.remove(&request_id) {
            let _ = sender.send(match error {
                Some(message) => Err(message),
                None => Ok(result.unwrap_or(Value::Null)),
            });
        }
    }
}

fn text_result(value: Value) -> Result<CallToolResult, McpError> {
    Ok(CallToolResult::success(vec![ContentBlock::text(value.to_string())]))
}

fn to_json(value: impl serde::Serialize) -> Result<Value, McpError> {
    serde_json::to_value(value).map_err(|err| McpError::internal_error(err.to_string(), None))
}

#[derive(Debug, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListCardsArgs {
    pub status: Option<String>,
    pub tag: Option<String>,
    pub jira_issue_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GetCardArgs {
    pub id: String,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateCardArgs {
    /// Markdown body of the card — the only required field.
    pub detail: String,
    /// If omitted, a title is derived from the first line of `detail`.
    pub title: Option<String>,
    /// A KanbanColumn id from list_columns. If omitted, the first column is used.
    pub status: Option<String>,
    pub jira_issue_key: Option<String>,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
    /// "low" | "medium" | "high"
    pub priority: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCardArgs {
    pub id: String,
    pub title: Option<String>,
    pub detail: Option<String>,
    pub jira_issue_key: Option<String>,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
    /// "low" | "medium" | "high"
    pub priority: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct MoveCardArgs {
    pub id: String,
    /// A KanbanColumn id from list_columns — not a fixed enum, columns are user-editable.
    pub status: String,
    pub order: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddCommentArgs {
    pub id: String,
    pub body: String,
    /// Set true when `body` is a clarifying question for the user — moves the card to
    /// the Waiting column. The card moves back to In Progress automatically once the
    /// user replies.
    pub awaiting_reply: Option<bool>,
}

#[derive(Clone)]
pub struct KanbanMcp {
    bridge: Arc<McpBridgeState>,
    // Read by the #[tool_handler]-generated dispatch, which rustc's dead-code
    // analysis can't see through the macro expansion.
    #[allow(dead_code)]
    tool_router: ToolRouter<KanbanMcp>,
}

#[tool_router]
impl KanbanMcp {
    fn new(bridge: Arc<McpBridgeState>) -> Self {
        Self {
            bridge,
            tool_router: Self::tool_router(),
        }
    }

    #[tool(
        description = "List all Kanban columns (id, label, order). Columns are user-editable — call this before trusting any status value, there is no fixed enum."
    )]
    async fn list_columns(&self) -> Result<CallToolResult, McpError> {
        let result = self.bridge.call("list_columns", serde_json::json!({})).await?;
        text_result(result)
    }

    #[tool(
        description = "List Kanban cards, optionally filtered by status/tag/jiraIssueKey. The response includes the current columns."
    )]
    async fn list_cards(
        &self,
        Parameters(args): Parameters<ListCardsArgs>,
    ) -> Result<CallToolResult, McpError> {
        let result = self.bridge.call("list_cards", to_json(args)?).await?;
        text_result(result)
    }

    #[tool(description = "Get a Kanban card's full markdown detail and all comments by id.")]
    async fn get_card(
        &self,
        Parameters(args): Parameters<GetCardArgs>,
    ) -> Result<CallToolResult, McpError> {
        let result = self.bridge.call("get_card", to_json(args)?).await?;
        text_result(result)
    }

    #[tool(
        description = "Create a new Kanban card. `detail` (markdown) is required; if `title` is omitted it is derived from the detail. `status` must be a column id from list_columns."
    )]
    async fn create_card(
        &self,
        Parameters(args): Parameters<CreateCardArgs>,
    ) -> Result<CallToolResult, McpError> {
        let result = self.bridge.call("create_card", to_json(args)?).await?;
        text_result(result)
    }

    #[tool(
        description = "Update fields on an existing Kanban card (title, detail, jiraIssueKey, startDate, dueDate, priority, tags). Automatically leaves a comment summarizing what changed."
    )]
    async fn update_card(
        &self,
        Parameters(args): Parameters<UpdateCardArgs>,
    ) -> Result<CallToolResult, McpError> {
        let result = self.bridge.call("update_card", to_json(args)?).await?;
        text_result(result)
    }

    #[tool(
        description = "Move a card to a different column. `status` must be a column id from list_columns. Cannot delete cards or columns."
    )]
    async fn move_card(
        &self,
        Parameters(args): Parameters<MoveCardArgs>,
    ) -> Result<CallToolResult, McpError> {
        let result = self.bridge.call("move_card", to_json(args)?).await?;
        text_result(result)
    }

    #[tool(
        description = "Add a comment to a card — use this to explain what you changed. Set `awaitingReply: true` when the comment is a clarifying question for the user: the card moves to the Waiting column automatically, and back to In Progress automatically once the user replies."
    )]
    async fn add_comment(
        &self,
        Parameters(args): Parameters<AddCommentArgs>,
    ) -> Result<CallToolResult, McpError> {
        let result = self.bridge.call("add_comment", to_json(args)?).await?;
        text_result(result)
    }
}

#[tool_handler]
impl ServerHandler for KanbanMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::from_build_env())
            .with_instructions(
                "Kanban board for JiraSync Hub, unrelated to Jira tasks. Always call list_columns \
                 first to learn the current valid status ids before creating or moving cards — \
                 columns are user-editable, there is no fixed enum. That said, four column ids are \
                 permanent and always present: 'todo', 'in_progress', 'waiting', 'done' — the user \
                 can rename or reorder them but never delete them, so you can treat these four as \
                 stable anchors for where a card is in its lifecycle even as custom columns come and \
                 go around them. Use add_comment to explain what you changed. When asking the user a \
                 clarifying question, pass awaitingReply: true — the card moves to Waiting \
                 automatically, and back to In Progress automatically once the user replies. You \
                 cannot delete cards or manage columns from here."
                    .to_string(),
            )
    }
}

async fn auth_middleware(
    State(token): State<Arc<str>>,
    headers: HeaderMap,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let provided = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));

    match provided {
        Some(candidate) if candidate == token.as_ref() => Ok(next.run(request).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

fn get_or_create_token(app: &AppHandle) -> String {
    let dir = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(TOKEN_FILE_NAME);

    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    let token = Uuid::new_v4().to_string();
    let _ = std::fs::write(&path, &token);
    token
}

#[derive(Clone, serde::Serialize)]
pub struct McpServerInfo {
    pub url: String,
    pub token: String,
}

/// Starts the Kanban MCP HTTP server bound to loopback only, and registers the bridge
/// state + server info as Tauri managed state for the `mcp_bridge_respond` /
/// `get_mcp_server_info` commands.
pub fn start(app: &tauri::App) {
    let app_handle = app.handle().clone();
    let token = get_or_create_token(&app_handle);
    let bridge = Arc::new(McpBridgeState::new(app_handle));

    app.manage(bridge.clone());
    app.manage(McpServerInfo {
        url: format!("http://127.0.0.1:{MCP_PORT}/mcp"),
        token: token.clone(),
    });

    tauri::async_runtime::spawn(async move {
        let bridge_for_factory = bridge.clone();
        let service = StreamableHttpService::new(
            move || Ok(KanbanMcp::new(bridge_for_factory.clone())),
            LocalSessionManager::default().into(),
            StreamableHttpServerConfig::default(),
        );

        let app_router = Router::new().nest_service("/mcp", service).layer(
            middleware::from_fn_with_state(Arc::<str>::from(token.as_str()), auth_middleware),
        );

        let addr = SocketAddr::from(([127, 0, 0, 1], MCP_PORT));
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => listener,
            Err(err) => {
                eprintln!("kanban MCP server failed to bind {addr}: {err}");
                return;
            }
        };

        if let Err(err) = axum::serve(listener, app_router).await {
            eprintln!("kanban MCP server stopped: {err}");
        }
    });
}

#[tauri::command]
pub async fn mcp_bridge_respond(
    bridge: tauri::State<'_, Arc<McpBridgeState>>,
    request_id: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), ()> {
    bridge.resolve(request_id, result, error).await;
    Ok(())
}

#[tauri::command]
pub fn get_mcp_server_info(info: tauri::State<'_, McpServerInfo>) -> McpServerInfo {
    info.inner().clone()
}
