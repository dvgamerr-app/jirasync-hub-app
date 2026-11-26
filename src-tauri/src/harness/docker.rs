// Databases and other services for a run, started through the Docker Engine API (no docker CLI
// at run time). Each run gets its own containers on random 127.0.0.1 ports, labelled with the
// run ID, so an agent never touches the owner's local database. Containers live only while the
// agent implements and the app checks; they are removed afterwards.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::time::{Duration, Instant};

const READY_TIMEOUT: Duration = Duration::from_secs(180);
pub const RUN_LABEL: &str = "jirasync.run";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

/// One service container a run needs (from the repo's compose file or set by the owner).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ServiceSpec {
    pub name: String,
    pub image: String,
    /// Port inside the container; published on a random 127.0.0.1 port.
    pub port: u16,
    pub env: Vec<EnvVar>,
    /// Docker healthcheck test, e.g. ["CMD", "pg_isready"]; empty = wait for the port.
    pub healthcheck: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningService {
    pub name: String,
    pub container_id: String,
    pub host_port: u16,
}

// ── Compose → proposed services ──────────────────────────────────────────────────────────────

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeDetection {
    pub services: Vec<ServiceSpec>,
    /// Services the app cannot start as-is (e.g. built from a Dockerfile).
    pub unsupported: Vec<String>,
}

fn yaml_str(value: &serde_yaml_ng::Value) -> Option<String> {
    match value {
        serde_yaml_ng::Value::String(text) => Some(text.clone()),
        serde_yaml_ng::Value::Number(number) => Some(number.to_string()),
        serde_yaml_ng::Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn container_port(entry: &serde_yaml_ng::Value) -> Option<u16> {
    if let Some(target) = entry.get("target") {
        return yaml_str(target)?.parse().ok();
    }
    let text = yaml_str(entry)?;
    let port = text.rsplit(':').next()?.split('/').next()?;
    port.split('-').next()?.parse().ok()
}

pub fn parse_compose(text: &str) -> Result<ComposeDetection, String> {
    let document: serde_yaml_ng::Value = serde_yaml_ng::from_str(text)
        .map_err(|e| format!("compose file is not valid YAML: {e}"))?;
    let mut detection = ComposeDetection::default();
    let Some(services) = document.get("services").and_then(|s| s.as_mapping()) else {
        return Ok(detection);
    };
    for (name, service) in services {
        let Some(name) = yaml_str(name) else { continue };
        let Some(image) = service.get("image").and_then(yaml_str) else {
            if service.get("build").is_some() {
                detection.unsupported.push(format!(
                    "{name} is built from a Dockerfile; choose an image for it"
                ));
            }
            continue;
        };
        let port = service
            .get("ports")
            .and_then(|ports| ports.as_sequence())
            .and_then(|ports| ports.iter().find_map(container_port))
            .or_else(|| {
                service
                    .get("expose")
                    .and_then(|expose| expose.as_sequence())
                    .and_then(|expose| expose.iter().find_map(container_port))
            })
            .unwrap_or(0);
        let env = match service.get("environment") {
            Some(serde_yaml_ng::Value::Mapping(map)) => map
                .iter()
                .filter_map(|(key, value)| {
                    Some(EnvVar {
                        key: yaml_str(key)?,
                        value: yaml_str(value).unwrap_or_default(),
                    })
                })
                .collect(),
            Some(serde_yaml_ng::Value::Sequence(items)) => items
                .iter()
                .filter_map(yaml_str)
                .filter_map(|item| {
                    let (key, value) = item.split_once('=')?;
                    Some(EnvVar {
                        key: key.into(),
                        value: value.into(),
                    })
                })
                .collect(),
            _ => Vec::new(),
        };
        // `${VAR}` interpolation would read the owner's environment; keep those out.
        let env = env
            .into_iter()
            .filter(|var| !var.value.contains("${"))
            .collect();
        let healthcheck = match service.get("healthcheck").and_then(|h| h.get("test")) {
            Some(serde_yaml_ng::Value::Sequence(items)) => {
                items.iter().filter_map(yaml_str).collect()
            }
            Some(value) => yaml_str(value)
                .map(|command| vec!["CMD-SHELL".to_string(), command])
                .unwrap_or_default(),
            None => Vec::new(),
        };
        if port == 0 {
            detection.unsupported.push(format!(
                "{name} publishes no port; set the port the app should wait for"
            ));
        }
        detection.services.push(ServiceSpec {
            name,
            image,
            port,
            env,
            healthcheck,
        });
    }
    Ok(detection)
}

/// Proposes per-run values for service env keys from the example file (never from `.env`):
/// a value pointing at a known service port or name gets `{services.<name>.host/port}`.
pub fn propose_overrides(example: &str, services: &[ServiceSpec]) -> Vec<EnvVar> {
    let mut proposals = Vec::new();
    for line in example.lines().map(str::trim) {
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if line.starts_with('#') {
            continue;
        }
        let key = key.trim();
        let value = value.trim().trim_matches('"').trim_matches('\'');
        for service in services.iter().filter(|service| service.port != 0) {
            let port = service.port.to_string();
            let hosts = ["localhost", "127.0.0.1", "0.0.0.0", service.name.as_str()];
            let template = format!(
                "{{services.{}.host}}:{{services.{}.port}}",
                service.name, service.name
            );
            let replaced = hosts.iter().find_map(|host| {
                let address = format!("{host}:{port}");
                value
                    .contains(&address)
                    .then(|| value.replace(&address, &template))
            });
            let replaced = replaced.or_else(|| {
                (key.to_ascii_uppercase().ends_with("_PORT") && value == port)
                    .then(|| format!("{{services.{}.port}}", service.name))
            });
            if let Some(value) = replaced {
                proposals.push(EnvVar {
                    key: key.into(),
                    value,
                });
                break;
            }
        }
    }
    if example.lines().any(|line| line.trim().starts_with("PORT=")) {
        proposals.push(EnvVar {
            key: "PORT".into(),
            value: "{run.port}".into(),
        });
    }
    proposals
}

/// Fills `{services.<name>.host}`, `{services.<name>.port}` and `{run.port}`.
pub fn render(template: &str, services: &[RunningService], run_port: u16) -> String {
    let mut value = template.replace("{run.port}", &run_port.to_string());
    for service in services {
        value = value
            .replace(&format!("{{services.{}.host}}", service.name), "127.0.0.1")
            .replace(
                &format!("{{services.{}.port}}", service.name),
                &service.host_port.to_string(),
            );
    }
    value
}

/// Sets keys in an env file: existing `KEY=` lines are replaced in place, others appended;
/// comments and unrelated keys stay as they were.
pub fn apply_env(file: &Path, values: &[EnvVar]) -> Result<(), String> {
    let current = std::fs::read_to_string(file).unwrap_or_default();
    let mut remaining: Vec<&EnvVar> = values.iter().collect();
    let mut lines: Vec<String> = current
        .lines()
        .map(|line| {
            let bare = line
                .trim_start()
                .strip_prefix("export ")
                .unwrap_or(line.trim_start());
            let key = bare.split_once('=').map(|(key, _)| key.trim());
            match key.and_then(|key| remaining.iter().position(|var| var.key == key)) {
                Some(index) => {
                    let var = remaining.remove(index);
                    format!("{}={}", var.key, var.value)
                }
                None => line.to_string(),
            }
        })
        .collect();
    if !remaining.is_empty() {
        lines.push("# set by JiraSync Hub for this run".into());
        lines.extend(
            remaining
                .iter()
                .map(|var| format!("{}={}", var.key, var.value)),
        );
    }
    std::fs::write(file, lines.join("\n") + "\n").map_err(|e| e.to_string())
}

// ── Docker Engine API client ────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DockerEndpoint {
    Tcp(String),
    #[cfg(windows)]
    Pipe(String),
    #[cfg(unix)]
    Unix(String),
}

impl DockerEndpoint {
    /// `tcp://127.0.0.1:2375`, `npipe:////./pipe/docker_engine`, `unix:///var/run/docker.sock`.
    pub fn parse(endpoint: &str) -> Result<Self, String> {
        if let Some(address) = endpoint.strip_prefix("tcp://") {
            let host = address.split(':').next().unwrap_or("");
            if !["127.0.0.1", "localhost", "::1", "[::1]"].contains(&host) {
                return Err(format!(
                    "Docker endpoint {endpoint} is not on this machine; only a local engine is used"
                ));
            }
            return Ok(Self::Tcp(address.trim_end_matches('/').into()));
        }
        #[cfg(windows)]
        if let Some(path) = endpoint.strip_prefix("npipe://") {
            return Ok(Self::Pipe(path.replace('/', "\\")));
        }
        #[cfg(unix)]
        if let Some(path) = endpoint.strip_prefix("unix://") {
            return Ok(Self::Unix(path.into()));
        }
        Err(format!("unsupported Docker endpoint {endpoint}"))
    }

    /// The endpoint of the current Docker context (its port can change between restarts).
    pub fn from_context() -> Result<Self, String> {
        let docker = super::exec::resolve_executable("docker")
            .ok_or("docker is not installed; it is needed to start this repository's services")?;
        let timeout = Duration::from_secs(15);
        let context = super::exec::run(&docker, &["context", "show"], None, timeout)?;
        let name = context.first_line().ok_or("no current Docker context")?;
        let args = [
            "context",
            "inspect",
            name.as_str(),
            "--format",
            "{{.Endpoints.docker.Host}}",
        ];
        let endpoint = super::exec::run(&docker, &args, None, timeout)?;
        Self::parse(
            &endpoint
                .first_line()
                .ok_or("the Docker context has no endpoint")?,
        )
    }

    fn connect(&self) -> Result<Box<dyn ReadWrite>, String> {
        let unreachable = |e: std::io::Error| format!("cannot reach the Docker engine: {e}");
        Ok(match self {
            Self::Tcp(address) => {
                let stream = TcpStream::connect(address).map_err(unreachable)?;
                stream.set_read_timeout(Some(Duration::from_secs(300))).ok();
                Box::new(stream)
            }
            #[cfg(windows)]
            Self::Pipe(path) => Box::new(
                std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(path)
                    .map_err(unreachable)?,
            ),
            #[cfg(unix)]
            Self::Unix(path) => {
                Box::new(std::os::unix::net::UnixStream::connect(path).map_err(unreachable)?)
            }
        })
    }

    pub fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<(u16, Vec<u8>), String> {
        let mut stream = self.connect()?;
        let payload = body.map(Value::to_string).unwrap_or_default();
        let head = format!(
            "{method} /v1.41{path} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            payload.len()
        );
        stream
            .write_all(head.as_bytes())
            .and_then(|_| stream.write_all(payload.as_bytes()))
            .map_err(|e| e.to_string())?;
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
        parse_response(&raw)
    }

    fn json(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
        let (status, bytes) = self.request(method, path, body)?;
        let text = String::from_utf8_lossy(&bytes);
        if !(200..300).contains(&status) {
            let message = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|value| value["message"].as_str().map(str::to_string))
                .unwrap_or_else(|| text.trim().to_string());
            return Err(format!(
                "Docker {method} {path} failed ({status}): {message}"
            ));
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    #[cfg(test)]
    pub fn version(&self) -> Result<String, String> {
        let version = self.json("GET", "/version", None)?;
        Ok(version["Version"].as_str().unwrap_or("unknown").to_string())
    }
}

trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

/// Status code and body of an HTTP/1.1 response (handles chunked transfer encoding).
pub fn parse_response(raw: &[u8]) -> Result<(u16, Vec<u8>), String> {
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or("incomplete HTTP response from Docker")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or("invalid HTTP status from Docker")?;
    let body = &raw[split + 4..];
    let chunked = head.lines().any(|line| {
        let line = line.to_ascii_lowercase();
        line.starts_with("transfer-encoding:") && line.contains("chunked")
    });
    if !chunked {
        return Ok((status, body.to_vec()));
    }
    let mut decoded = Vec::new();
    let mut rest = body;
    while let Some(end) = rest.windows(2).position(|window| window == b"\r\n") {
        let size_text = String::from_utf8_lossy(&rest[..end]);
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| "invalid chunk size from Docker")?;
        if size == 0 {
            break;
        }
        let start = end + 2;
        let stop = (start + size).min(rest.len());
        decoded.extend_from_slice(&rest[start..stop]);
        rest = rest.get(stop + 2..).unwrap_or(&[]);
    }
    Ok((status, decoded))
}

fn image_reference(image: &str) -> (String, String) {
    // "postgres:16", "ghcr.io/x/y:1.2", "redis" (latest), "a/b@sha256:..."
    if let Some((name, digest)) = image.split_once('@') {
        return (name.into(), digest.into());
    }
    match image.rsplit_once(':') {
        Some((name, tag)) if !tag.contains('/') => (name.into(), tag.into()),
        _ => (image.into(), "latest".into()),
    }
}

fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Removes every container a previous run left behind (only one run is busy at a time).
pub fn remove_leftovers(docker: &DockerEndpoint) -> Result<usize, String> {
    let filters = encode(&json!({ "label": [RUN_LABEL] }).to_string());
    let containers = docker.json(
        "GET",
        &format!("/containers/json?all=1&filters={filters}"),
        None,
    )?;
    let ids: Vec<String> = containers
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|c| c["Id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    for id in &ids {
        let _ = docker.json("DELETE", &format!("/containers/{id}?force=1&v=1"), None);
    }
    Ok(ids.len())
}

/// Pulls (if needed), creates and starts every service, then waits until each is healthy or
/// its port answers. On any failure the containers started so far are removed.
pub fn start_services(
    docker: &DockerEndpoint,
    run_id: &str,
    specs: &[ServiceSpec],
    log: &dyn Fn(String),
) -> Result<Vec<RunningService>, String> {
    let mut started = Vec::new();
    let result = (|| {
        let mut names = BTreeSet::new();
        for spec in specs {
            if !names.insert(spec.name.clone()) || spec.name.is_empty() || spec.image.is_empty() {
                return Err(format!(
                    "service \"{}\" needs a unique name and an image",
                    spec.name
                ));
            }
            let (name, tag) = image_reference(&spec.image);
            let present = docker
                .request(
                    "GET",
                    &format!("/images/{}/json", encode(&spec.image)),
                    None,
                )
                .map(|(status, _)| status == 200)
                .unwrap_or(false);
            if !present {
                log(format!("pulling {}", spec.image));
                docker.json(
                    "POST",
                    &format!(
                        "/images/create?fromImage={}&tag={}",
                        encode(&name),
                        encode(&tag)
                    ),
                    None,
                )?;
            }
            let port = format!("{}/tcp", spec.port);
            let mut body = json!({
                "Image": spec.image,
                "Env": spec.env.iter().map(|var| format!("{}={}", var.key, var.value)).collect::<Vec<_>>(),
                "Labels": { RUN_LABEL: run_id },
                "ExposedPorts": { &port: {} },
                "HostConfig": { "PortBindings": { &port: [{ "HostIp": "127.0.0.1", "HostPort": "" }] } }
            });
            if !spec.healthcheck.is_empty() {
                body["Healthcheck"] = json!({
                    "Test": spec.healthcheck,
                    "Interval": 1_000_000_000u64,
                    "Timeout": 5_000_000_000u64,
                    "Retries": 120
                });
            }
            let container = format!("jirasync-{run_id}-{}", spec.name);
            let created = docker.json(
                "POST",
                &format!("/containers/create?name={}", encode(&container)),
                Some(&body),
            )?;
            let id = created["Id"]
                .as_str()
                .ok_or("Docker did not return a container id")?
                .to_string();
            started.push(RunningService {
                name: spec.name.clone(),
                container_id: id.clone(),
                host_port: 0,
            });
            docker.json("POST", &format!("/containers/{id}/start"), None)?;
            let inspect = docker.json("GET", &format!("/containers/{id}/json"), None)?;
            let host_port: u16 = inspect["NetworkSettings"]["Ports"][&port][0]["HostPort"]
                .as_str()
                .and_then(|p| p.parse().ok())
                .ok_or_else(|| format!("{} did not publish port {}", spec.name, spec.port))?;
            started.last_mut().unwrap().host_port = host_port;
            wait_ready(docker, spec, &id, host_port)?;
            log(format!(
                "{} ({}) ready on 127.0.0.1:{host_port}",
                spec.name, spec.image
            ));
        }
        Ok(())
    })();
    match result {
        Ok(()) => Ok(started),
        Err(error) => {
            stop_services(docker, &started);
            Err(error)
        }
    }
}

fn wait_ready(
    docker: &DockerEndpoint,
    spec: &ServiceSpec,
    id: &str,
    host_port: u16,
) -> Result<(), String> {
    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        let state = docker.json("GET", &format!("/containers/{id}/json"), None)?;
        if state["State"]["Running"] == false {
            return Err(format!("{} stopped while starting", spec.name));
        }
        let ready = if spec.healthcheck.is_empty() {
            TcpStream::connect(("127.0.0.1", host_port)).is_ok()
        } else {
            match state["State"]["Health"]["Status"].as_str() {
                Some("healthy") => true,
                Some("unhealthy") => return Err(format!("{} reported unhealthy", spec.name)),
                _ => false,
            }
        };
        if ready {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err(format!(
        "{} was not ready within {}s",
        spec.name,
        READY_TIMEOUT.as_secs()
    ))
}

pub fn stop_services(docker: &DockerEndpoint, services: &[RunningService]) {
    for service in services {
        let _ = docker.json(
            "DELETE",
            &format!("/containers/{}?force=1&v=1", service.container_id),
            None,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::testutil::TempDir;

    #[test]
    fn compose_services_become_proposals() {
        let compose = r#"
services:
  db:
    image: postgres:16
    ports: ["5432:5432"]
    environment:
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
      SECRET: ${FROM_SHELL}
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
  cache:
    image: redis:7-alpine
    ports:
      - target: 6379
        published: 6379
    environment:
      - REDIS_ARGS=--save ""
  api:
    build: .
    ports: ["3000:3000"]
"#;
        let detection = parse_compose(compose).unwrap();
        assert_eq!(detection.services.len(), 2);
        let db = &detection.services[0];
        assert_eq!(
            (db.name.as_str(), db.image.as_str(), db.port),
            ("db", "postgres:16", 5432)
        );
        assert_eq!(
            db.env.len(),
            2,
            "${{...}} from the owner's shell is dropped"
        );
        assert_eq!(db.healthcheck, vec!["CMD", "pg_isready", "-U", "postgres"]);
        assert_eq!(detection.services[1].port, 6379);
        assert_eq!(detection.services[1].env[0].key, "REDIS_ARGS");
        assert!(detection.unsupported[0].contains("api is built from a Dockerfile"));
        assert!(parse_compose("services: [").is_err());
    }

    #[test]
    fn overrides_come_from_the_example_file_only() {
        let services = vec![
            ServiceSpec {
                name: "db".into(),
                image: "postgres:16".into(),
                port: 5432,
                ..Default::default()
            },
            ServiceSpec {
                name: "cache".into(),
                image: "redis".into(),
                port: 6379,
                ..Default::default()
            },
        ];
        let example = "DATABASE_URL=postgres://app:app@localhost:5432/app\nREDIS_URL=redis://cache:6379\nDB_PORT=5432\nPORT=3000\nAPI_KEY=changeme\n";
        let proposals = propose_overrides(example, &services);
        let get = |key: &str| {
            proposals
                .iter()
                .find(|var| var.key == key)
                .map(|var| var.value.clone())
        };
        assert_eq!(
            get("DATABASE_URL").as_deref(),
            Some("postgres://app:app@{services.db.host}:{services.db.port}/app")
        );
        assert_eq!(
            get("REDIS_URL").as_deref(),
            Some("redis://{services.cache.host}:{services.cache.port}")
        );
        assert_eq!(get("DB_PORT").as_deref(), Some("{services.db.port}"));
        assert_eq!(get("PORT").as_deref(), Some("{run.port}"));
        assert_eq!(get("API_KEY"), None, "unrelated keys are left alone");

        let running = vec![RunningService {
            name: "db".into(),
            container_id: "x".into(),
            host_port: 54011,
        }];
        assert_eq!(
            render(
                "postgres://app:app@{services.db.host}:{services.db.port}/app",
                &running,
                4100
            ),
            "postgres://app:app@127.0.0.1:54011/app"
        );
        assert_eq!(render("{run.port}", &running, 4100), "4100");
    }

    #[test]
    fn env_values_are_replaced_in_place_and_comments_kept() {
        let dir = TempDir::new("env-apply");
        let file = dir.path().join(".env");
        std::fs::write(
            &file,
            "# local\nDATABASE_URL=postgres://me@localhost/dev\nexport PORT=3000\nAPI_KEY=k\n",
        )
        .unwrap();
        apply_env(
            &file,
            &[
                EnvVar {
                    key: "DATABASE_URL".into(),
                    value: "postgres://app@127.0.0.1:54011/app".into(),
                },
                EnvVar {
                    key: "PORT".into(),
                    value: "4100".into(),
                },
                EnvVar {
                    key: "NEW_KEY".into(),
                    value: "1".into(),
                },
            ],
        )
        .unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(
            text,
            "# local\nDATABASE_URL=postgres://app@127.0.0.1:54011/app\nPORT=4100\nAPI_KEY=k\n# set by JiraSync Hub for this run\nNEW_KEY=1\n"
        );
    }

    #[test]
    fn endpoints_and_http_responses() {
        assert_eq!(
            DockerEndpoint::parse("tcp://127.0.0.1:49878").unwrap(),
            DockerEndpoint::Tcp("127.0.0.1:49878".into())
        );
        assert!(DockerEndpoint::parse("tcp://10.0.0.5:2375")
            .unwrap_err()
            .contains("not on this machine"));
        assert!(DockerEndpoint::parse("ssh://host").is_err());

        let plain =
            b"HTTP/1.1 201 Created\r\nContent-Type: application/json\r\n\r\n{\"Id\":\"abc\"}";
        assert_eq!(
            parse_response(plain).unwrap(),
            (201, b"{\"Id\":\"abc\"}".to_vec())
        );
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\n\r\n";
        assert_eq!(
            parse_response(chunked).unwrap(),
            (200, b"{\"a\":1}".to_vec())
        );
        assert!(parse_response(b"HTTP/1.1 200").is_err());
        assert_eq!(
            image_reference("postgres:16"),
            ("postgres".into(), "16".into())
        );
        assert_eq!(image_reference("redis"), ("redis".into(), "latest".into()));
        assert_eq!(
            image_reference("localhost:5000/app"),
            ("localhost:5000/app".into(), "latest".into())
        );
    }

    /// Needs a local Docker engine and pulls redis:7-alpine:
    /// `cargo test --lib real_docker_service_lifecycle -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_docker_service_lifecycle() {
        let docker = DockerEndpoint::from_context().unwrap();
        println!("engine {}", docker.version().unwrap());
        let spec = ServiceSpec {
            name: "cache".into(),
            image: "redis:7-alpine".into(),
            port: 6379,
            env: vec![],
            healthcheck: vec!["CMD".into(), "redis-cli".into(), "ping".into()],
        };
        let lines = std::sync::Mutex::new(Vec::new());
        let started = start_services(&docker, "abc123test", &[spec], &|line| {
            println!("{line}");
            lines.lock().unwrap().push(line);
        })
        .unwrap();
        let port = started[0].host_port;
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.write_all(b"PING\r\n").unwrap();
        let mut reply = [0u8; 7];
        stream.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"+PONG\r\n");
        stop_services(&docker, &started);
        let (status, _) = docker
            .request(
                "GET",
                &format!("/containers/{}/json", started[0].container_id),
                None,
            )
            .unwrap();
        assert_eq!(status, 404, "the container is removed with the run");
        assert_eq!(remove_leftovers(&docker).unwrap(), 0);
    }
}
