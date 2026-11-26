// MCP server inside the app (Streamable HTTP, JSON responses only). Claude Code connects to it
// with `--mcp-config` and calls the harness tools; the app executes everything itself.
// Bound to 127.0.0.1 only; every request needs the bearer token of a live run, and requests
// carrying an `Origin` header are refused so a web page cannot reach it (DNS rebinding).
use serde_json::{json, Value};
use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::Read;
use std::sync::{Arc, Mutex};
use tiny_http::{Header, Method, Request, Response, Server};

const MAX_BODY: u64 = 1024 * 1024;
const PROTOCOL_VERSION: &str = "2025-06-18";

/// The tools one run exposes. Text results go back to the agent as-is.
pub trait ToolHost: Send + Sync {
    fn tools(&self) -> Vec<Value>;
    fn call(&self, name: &str, arguments: Value) -> Result<String, String>;
}

type Hosts = Arc<Mutex<HashMap<String, Arc<dyn ToolHost>>>>;

#[derive(Clone)]
pub struct McpServer {
    port: u16,
    hosts: Hosts,
}

/// 256 random bits from the OS-seeded hasher keys (no extra crate needed).
fn random_token() -> String {
    (0..4)
        .map(|_| format!("{:016x}", RandomState::new().build_hasher().finish()))
        .collect()
}

impl McpServer {
    pub fn start() -> Result<Self, String> {
        let server = Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = server
            .server_addr()
            .to_ip()
            .ok_or("MCP server has no TCP address")?
            .port();
        let hosts: Hosts = Arc::default();
        let shared = hosts.clone();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let hosts = shared.clone();
                // Tool calls can run for minutes (tests, builds); never block other requests.
                std::thread::spawn(move || handle(&hosts, port, request));
            }
        });
        Ok(Self { port, hosts })
    }

    pub fn register(&self, host: Arc<dyn ToolHost>) -> String {
        let token = random_token();
        self.hosts.lock().unwrap().insert(token.clone(), host);
        token
    }

    pub fn unregister(&self, token: &str) {
        self.hosts.lock().unwrap().remove(token);
    }

    /// The `--mcp-config` content for a run.
    pub fn client_config(&self, token: &str) -> Value {
        json!({
            "mcpServers": {
                "harness": {
                    "type": "http",
                    "url": format!("http://127.0.0.1:{}/mcp", self.port),
                    "headers": { "Authorization": format!("Bearer {token}") }
                }
            }
        })
    }

    #[cfg(test)]
    pub fn port(&self) -> u16 {
        self.port
    }
}

fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str())
}

fn reply(request: Request, status: u16, body: Option<Value>) {
    let response = match body {
        Some(body) => Response::from_string(body.to_string())
            .with_status_code(status)
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap()),
        None => Response::from_string(String::new()).with_status_code(status),
    };
    let _ = request.respond(response);
}

fn handle(hosts: &Hosts, port: u16, mut request: Request) {
    if header(&request, "Origin").is_some() {
        return reply(request, 403, None);
    }
    let host_ok = header(&request, "Host").is_some_and(|host| {
        host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
    });
    if !host_ok || request.url() != "/mcp" {
        return reply(request, 404, None);
    }
    let token = header(&request, "Authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_string);
    let Some(tool_host) = token.and_then(|token| hosts.lock().unwrap().get(&token).cloned()) else {
        return reply(request, 401, None);
    };
    if *request.method() != Method::Post {
        // No server-initiated stream: this server only answers requests.
        return reply(request, 405, None);
    }
    let mut body = String::new();
    if request
        .as_reader()
        .take(MAX_BODY)
        .read_to_string(&mut body)
        .is_err()
    {
        return reply(request, 400, None);
    }
    let Ok(message) = serde_json::from_str::<Value>(&body) else {
        return reply(
            request,
            400,
            Some(
                json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "parse error"}}),
            ),
        );
    };
    let Some(id) = message.get("id").cloned() else {
        // Notifications and responses need no answer.
        return reply(request, 202, None);
    };
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL_VERSION),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "jirasync-harness", "version": env!("CARGO_PKG_VERSION") }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_host.tools() })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
            Ok(match tool_host.call(name, arguments) {
                Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
                Err(error) => {
                    json!({ "content": [{ "type": "text", "text": error }], "isError": true })
                }
            })
        }
        _ => Err(json!({ "code": -32601, "message": format!("method not found: {method}") })),
    };
    let body = match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    };
    reply(request, 200, Some(body));
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpStream;

    struct Echo;
    impl ToolHost for Echo {
        fn tools(&self) -> Vec<Value> {
            vec![json!({"name": "echo", "inputSchema": {"type": "object"}})]
        }
        fn call(&self, name: &str, arguments: Value) -> Result<String, String> {
            match name {
                "echo" => Ok(arguments["text"].as_str().unwrap_or("").to_string()),
                _ => Err(format!("unknown tool {name}")),
            }
        }
    }

    /// Minimal HTTP/1.1 client: returns (status, body).
    pub fn http(port: u16, method: &str, headers: &[(&str, &str)], body: &str) -> (u16, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut request = format!(
            "{method} /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: {}\r\n",
            body.len()
        );
        for (name, value) in headers {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        request.push_str("\r\n");
        request.push_str(body);
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        let status = response[9..12].parse().unwrap();
        let body = response
            .split_once("\r\n\r\n")
            .map(|(_, body)| body.to_string())
            .unwrap_or_default();
        (status, body)
    }

    pub fn rpc(port: u16, token: &str, method: &str, params: Value) -> Value {
        let auth = format!("Bearer {token}");
        let body =
            json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).to_string();
        let (status, body) = http(port, "POST", &[("Authorization", &auth)], &body);
        assert_eq!(status, 200, "{body}");
        serde_json::from_str(&body).unwrap()
    }

    #[test]
    fn speaks_mcp_for_a_registered_run() {
        let server = McpServer::start().unwrap();
        let token = server.register(Arc::new(Echo));
        let port = server.port();

        let init = rpc(
            port,
            &token,
            "initialize",
            json!({"protocolVersion": "2025-11-25"}),
        );
        assert_eq!(init["result"]["protocolVersion"], "2025-11-25");
        let list = rpc(port, &token, "tools/list", json!({}));
        assert_eq!(list["result"]["tools"][0]["name"], "echo");
        let call = rpc(
            port,
            &token,
            "tools/call",
            json!({"name": "echo", "arguments": {"text": "hi"}}),
        );
        assert_eq!(call["result"]["content"][0]["text"], "hi");
        let failed = rpc(
            port,
            &token,
            "tools/call",
            json!({"name": "nope", "arguments": {}}),
        );
        assert_eq!(failed["result"]["isError"], true);

        let auth = format!("Bearer {token}");
        let notification =
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}).to_string();
        assert_eq!(
            http(port, "POST", &[("Authorization", &auth)], &notification).0,
            202
        );

        let config = server.client_config(&token);
        assert_eq!(
            config["mcpServers"]["harness"]["url"],
            format!("http://127.0.0.1:{port}/mcp")
        );
    }

    /// Spends real tokens: `cargo test --lib claude_cli_uses_the_app_mcp_server -- --ignored`.
    #[test]
    #[ignore]
    fn claude_cli_uses_the_app_mcp_server() {
        let server = McpServer::start().unwrap();
        let token = server.register(Arc::new(Echo));
        let dir = crate::harness::testutil::TempDir::new("mcp-claude");
        let config = dir.path().join("mcp.json");
        std::fs::write(&config, server.client_config(&token).to_string()).unwrap();
        let claude = crate::harness::exec::resolve_executable("claude").expect("claude on PATH");
        let output = std::process::Command::new(claude)
            .current_dir(dir.path())
            .args([
                "-p",
                "Call the echo tool once with text \"pong-7\" and reply with exactly what it returned.",
                "--output-format",
                "json",
                "--restricted",
                "--tools",
                "",
                "--disable-slash-commands",
                "--strict-mcp-config",
                "--mcp-config",
                &config.display().to_string(),
                "--allowedTools",
                "mcp__harness__echo",
                "--model",
                "haiku",
                "--max-budget-usd",
                "0.1",
            ])
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "{stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_str(&stdout).unwrap();
        assert!(
            result["result"].as_str().unwrap().contains("pong-7"),
            "{result}"
        );
    }

    #[test]
    fn refuses_unknown_tokens_browsers_and_streams() {
        let server = McpServer::start().unwrap();
        let token = server.register(Arc::new(Echo));
        let port = server.port();
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).to_string();
        let auth = format!("Bearer {token}");

        assert_eq!(http(port, "POST", &[], &body).0, 401, "no token");
        assert_eq!(
            http(port, "POST", &[("Authorization", "Bearer nope")], &body).0,
            401
        );
        assert_eq!(
            http(
                port,
                "POST",
                &[("Authorization", &auth), ("Origin", "http://evil.test")],
                &body
            )
            .0,
            403,
            "browser origin"
        );
        assert_eq!(http(port, "GET", &[("Authorization", &auth)], "").0, 405);

        server.unregister(&token);
        assert_eq!(
            http(port, "POST", &[("Authorization", &auth)], &body).0,
            401,
            "run ended"
        );
    }
}
