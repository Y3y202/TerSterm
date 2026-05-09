#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose, Engine as _};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use ssh2::{FileStat, Session, Sftp};
use std::{
    collections::HashMap,
    env, fs,
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::{
        mpsc::{self, Sender},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use uuid::Uuid;

#[derive(Debug, Deserialize, Clone)]
struct ConnectionConfig {
    name: String,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    private_key_path: Option<String>,
    private_key: Option<String>,
    private_key_passphrase: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
struct SshDataEvent {
    session_id: String,
    data: String,
}

#[derive(Debug, Serialize, Clone)]
struct SshDisconnectedEvent {
    session_id: String,
    reason: Option<String>,
}

#[derive(Debug, Serialize)]
struct RemoteFileEntry {
    name: String,
    path: String,
    kind: String,
    size: Option<u64>,
    modified: String,
}

#[derive(Debug, Serialize)]
struct RemoteFileList {
    path: String,
    entries: Vec<RemoteFileEntry>,
}

#[derive(Debug, Serialize)]
struct SystemUsage {
    cpu_percent: f32,
    memory_used_gb: f32,
    memory_total_gb: f32,
    storage_used_gb: f32,
    storage_total_gb: f32,
}

enum SshCommand {
    Write(String),
    Resize { cols: u32, rows: u32 },
    Disconnect,
}

#[derive(Default)]
struct SshSessions(Mutex<HashMap<String, Sender<SshCommand>>>);

#[tauri::command]
fn ssh_connect(
    app: AppHandle,
    sessions: State<'_, SshSessions>,
    session_id: String,
    config: ConnectionConfig,
) -> Result<String, String> {
    if config.host.trim().is_empty() {
        return Err("Host is required".into());
    }

    if config.username.trim().is_empty() {
        return Err("Username is required".into());
    }

    if session_id.trim().is_empty() {
        return Err("Session id is required".into());
    }

    let (tx, rx) = mpsc::channel::<SshCommand>();
    sessions
        .0
        .lock()
        .map_err(|_| "SSH session store is unavailable".to_string())?
        .insert(session_id.clone(), tx);

    let thread_session_id = session_id.clone();
    thread::spawn(move || {
        let disconnect_reason = run_ssh_session(app.clone(), thread_session_id.clone(), config, rx)
            .err()
            .map(|error| error.to_string());

        if let Ok(mut store) = app.state::<SshSessions>().0.lock() {
            store.remove(&thread_session_id);
        }

        app.emit(
            "ssh-disconnected",
            SshDisconnectedEvent {
                session_id: thread_session_id,
                reason: disconnect_reason,
            },
        )
        .ok();
    });

    Ok(session_id)
}

#[tauri::command]
fn ssh_test_connection(config: ConnectionConfig) -> Result<String, String> {
    validate_connection_config(&config)?;
    run_ssh_test_connection(config).map_err(|error| error.to_string())
}

#[tauri::command]
fn ssh_write(
    sessions: State<'_, SshSessions>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    send_command(&sessions, &session_id, SshCommand::Write(data))
}

#[tauri::command]
fn ssh_resize(
    sessions: State<'_, SshSessions>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    send_command(&sessions, &session_id, SshCommand::Resize { cols, rows })
}

#[tauri::command]
fn ssh_disconnect(sessions: State<'_, SshSessions>, session_id: String) -> Result<(), String> {
    send_command(&sessions, &session_id, SshCommand::Disconnect)
}

#[tauri::command]
async fn ssh_list_files(
    config: ConnectionConfig,
    remote_path: String,
) -> Result<RemoteFileList, String> {
    validate_connection_config(&config)?;
    tauri::async_runtime::spawn_blocking(move || run_remote_file_list(config, remote_path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn ssh_upload_file(
    app: AppHandle,
    config: ConnectionConfig,
    remote_path: String,
    filename: String,
    content_base64: String,
) -> Result<String, String> {
    validate_connection_config(&config)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_remote_file_upload(app, config, remote_path, filename, content_base64)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn ssh_download_file(
    app: AppHandle,
    config: ConnectionConfig,
    remote_path: String,
) -> Result<String, String> {
    validate_connection_config(&config)?;
    tauri::async_runtime::spawn_blocking(move || run_remote_file_download(app, config, remote_path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn ssh_get_system_usage(config: ConnectionConfig) -> Result<SystemUsage, String> {
    validate_connection_config(&config)?;
    tauri::async_runtime::spawn_blocking(move || run_remote_system_usage(config))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

fn send_command(
    sessions: &State<'_, SshSessions>,
    session_id: &str,
    command: SshCommand,
) -> Result<(), String> {
    let sender = sessions
        .0
        .lock()
        .map_err(|_| "SSH session store is unavailable".to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| "SSH session not found".to_string())?;

    sender
        .send(command)
        .map_err(|_| "SSH session is already closed".to_string())
}

fn validate_connection_config(config: &ConnectionConfig) -> Result<(), String> {
    if config.host.trim().is_empty() {
        return Err("Host is required".into());
    }

    if config.username.trim().is_empty() {
        return Err("Username is required".into());
    }

    Ok(())
}

struct PreparedPrivateKey {
    path: PathBuf,
    remove_on_drop: bool,
}

impl Drop for PreparedPrivateKey {
    fn drop(&mut self) {
        if self.remove_on_drop {
            fs::remove_file(&self.path).ok();
        }
    }
}

fn prepare_private_key(
    config: &ConnectionConfig,
) -> Result<Option<PreparedPrivateKey>, Box<dyn std::error::Error + Send + Sync>> {
    if let Some(private_key) = config
        .private_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let path = env::temp_dir().join(format!("tersterm-key-{}.pem", Uuid::new_v4()));
        let normalized = private_key.replace("\r\n", "\n").trim().to_string() + "\n";
        fs::write(&path, normalized)?;

        return Ok(Some(PreparedPrivateKey {
            path,
            remove_on_drop: true,
        }));
    }

    if let Some(private_key_path) = config
        .private_key_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(Some(PreparedPrivateKey {
            path: PathBuf::from(private_key_path),
            remove_on_drop: false,
        }));
    }

    Ok(None)
}

fn build_ssh_command(
    config: &ConnectionConfig,
    private_key: Option<&PreparedPrivateKey>,
    remote_command: Option<&str>,
) -> CommandBuilder {
    let mut command = CommandBuilder::new("ssh");
    command.arg("-tt");
    command.arg("-p");
    command.arg(config.port.to_string());
    command.arg("-o");
    command.arg("ServerAliveInterval=30");
    command.arg("-o");
    command.arg("ConnectTimeout=15");
    command.arg("-o");
    command.arg("StrictHostKeyChecking=accept-new");
    command.arg("-o");
    command.arg("NumberOfPasswordPrompts=1");

    if let Some(private_key) = private_key {
        command.arg("-i");
        command.arg(private_key.path.to_string_lossy().as_ref());
    }

    command.arg(format!("{}@{}", config.username, config.host));

    if let Some(remote_command) = remote_command {
        command.arg(remote_command);
    }

    command
}

fn normalize_remote_path(remote_path: &str) -> String {
    let trimmed = remote_path.trim();
    if trimmed.is_empty() {
        "~".to_string()
    } else {
        trimmed.to_string()
    }
}

fn sftp_path(remote_path: &str) -> String {
    let normalized = normalize_remote_path(remote_path);
    if normalized == "~" {
        ".".to_string()
    } else if let Some(rest) = normalized.strip_prefix("~/") {
        rest.to_string()
    } else {
        normalized
    }
}

fn remote_join(parent: &str, name: &str) -> String {
    let parent = normalize_remote_path(parent);
    if parent == "/" {
        format!("/{name}")
    } else if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    }
}

fn sanitize_filename(filename: &str) -> String {
    filename
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            _ => ch,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string()
}

fn unique_local_path(directory: &Path, filename: &str) -> PathBuf {
    let safe_name = sanitize_filename(filename);
    let safe_name = if safe_name.is_empty() {
        "download".to_string()
    } else {
        safe_name
    };
    let candidate = directory.join(&safe_name);
    if !candidate.exists() {
        return candidate;
    }

    let stem = Path::new(&safe_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let extension = Path::new(&safe_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();

    for index in 1..1000 {
        let candidate = directory.join(format!("{stem} ({index}){extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }

    directory.join(format!("{stem}-{}{extension}", Uuid::new_v4()))
}

fn connect_sftp(
    config: &ConnectionConfig,
) -> Result<(Session, Sftp), Box<dyn std::error::Error + Send + Sync>> {
    let session = connect_ssh_session(config)?;
    let sftp = session.sftp()?;
    Ok((session, sftp))
}

fn connect_ssh_session(
    config: &ConnectionConfig,
) -> Result<Session, Box<dyn std::error::Error + Send + Sync>> {
    let address = (config.host.as_str(), config.port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| format!("Unable to resolve {}", config.host))?;
    let tcp = TcpStream::connect_timeout(&address, Duration::from_secs(15))?;
    tcp.set_read_timeout(Some(Duration::from_secs(30))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(30))).ok();

    let mut session = Session::new()?;
    session.set_tcp_stream(tcp);
    session.handshake()?;

    let private_key = prepare_private_key(&config)?;
    let passphrase = config
        .private_key_passphrase
        .as_deref()
        .filter(|value| !value.trim().is_empty());

    if let Some(private_key) = private_key.as_ref() {
        session.userauth_pubkey_file(&config.username, None, &private_key.path, passphrase)?;
    } else if let Some(password) = config.password.as_deref().filter(|value| !value.is_empty()) {
        session.userauth_password(&config.username, password)?;
    } else {
        session.userauth_agent(&config.username)?;
    }

    if !session.authenticated() {
        return Err("SSH authentication failed".into());
    }

    Ok(session)
}

fn kind_from_stat(stat: &FileStat) -> String {
    match stat.perm.map(|perm| perm & 0o170000) {
        Some(0o040000) => "directory",
        Some(0o120000) => "symlink",
        _ => "file",
    }
    .to_string()
}

fn name_from_path(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string()
}

fn run_remote_file_list(
    config: ConnectionConfig,
    remote_path: String,
) -> Result<RemoteFileList, Box<dyn std::error::Error + Send + Sync>> {
    let (_session, sftp) = connect_sftp(&config)?;
    let requested_path = sftp_path(&remote_path);
    let real_path = sftp
        .realpath(Path::new(&requested_path))
        .unwrap_or_else(|_| PathBuf::from(&requested_path));
    let display_path = real_path.to_string_lossy().replace('\\', "/");
    let mut entries = Vec::new();

    if display_path != "/" {
        entries.push(RemoteFileEntry {
            name: "..".to_string(),
            path: remote_join(&display_path, ".."),
            kind: "directory".to_string(),
            size: None,
            modified: String::new(),
        });
    }

    for (path, stat) in sftp.readdir(Path::new(&requested_path))? {
        let name = name_from_path(&path);
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }

        let kind = kind_from_stat(&stat);
        entries.push(RemoteFileEntry {
            path: remote_join(&display_path, &name),
            name,
            kind,
            size: stat.size,
            modified: stat
                .mtime
                .map(|value| value.to_string())
                .unwrap_or_default(),
        });
    }

    entries.sort_by(|left, right| {
        match (
            left.kind.as_str() == "directory",
            right.kind.as_str() == "directory",
        ) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
        }
    });

    Ok(RemoteFileList {
        path: display_path,
        entries,
    })
}

fn run_remote_file_upload(
    _app: AppHandle,
    config: ConnectionConfig,
    remote_path: String,
    filename: String,
    content_base64: String,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let safe_name = sanitize_filename(&filename);
    if safe_name.is_empty() {
        return Err("File name is required".into());
    }

    let (_session, sftp) = connect_sftp(&config)?;
    let bytes = general_purpose::STANDARD.decode(content_base64)?;
    let target = remote_join(&normalize_remote_path(&remote_path), &safe_name);
    let mut remote_file = sftp.create(Path::new(&sftp_path(&target)))?;
    remote_file.write_all(&bytes)?;
    remote_file.flush()?;

    Ok(target)
}

fn run_remote_file_download(
    app: AppHandle,
    config: ConnectionConfig,
    remote_path: String,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let remote_path = normalize_remote_path(&remote_path);
    let filename = Path::new(&remote_path)
        .file_name()
        .and_then(|value| value.to_str())
        .map(sanitize_filename)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "download".to_string());
    let downloads = app.path().download_dir()?;
    fs::create_dir_all(&downloads)?;
    let local_path = unique_local_path(&downloads, &filename);

    let (_session, sftp) = connect_sftp(&config)?;
    let mut remote_file = sftp.open(Path::new(&sftp_path(&remote_path)))?;
    let mut local_file = fs::File::create(&local_path)?;
    std::io::copy(&mut remote_file, &mut local_file)?;

    Ok(local_path.to_string_lossy().to_string())
}

fn parse_system_usage_output(
    output: &str,
) -> Result<SystemUsage, Box<dyn std::error::Error + Send + Sync>> {
    let mut cpu_percent = None;
    let mut memory = None;
    let mut storage = None;

    for line in output.lines() {
        let mut parts = line.split_whitespace();
        match parts.next() {
            Some("CPU") => {
                cpu_percent = parts.next().and_then(|value| value.parse::<f32>().ok());
            }
            Some("MEM") => {
                let used = parts.next().and_then(|value| value.parse::<f32>().ok());
                let total = parts.next().and_then(|value| value.parse::<f32>().ok());
                if let (Some(used), Some(total)) = (used, total) {
                    memory = Some((used, total));
                }
            }
            Some("DISK") => {
                let used = parts.next().and_then(|value| value.parse::<f32>().ok());
                let total = parts.next().and_then(|value| value.parse::<f32>().ok());
                if let (Some(used), Some(total)) = (used, total) {
                    storage = Some((used, total));
                }
            }
            _ => {}
        }
    }

    let (memory_used_gb, memory_total_gb) =
        memory.ok_or("Unable to read remote memory usage")?;
    let (storage_used_gb, storage_total_gb) =
        storage.ok_or("Unable to read remote storage usage")?;

    Ok(SystemUsage {
        cpu_percent: cpu_percent.ok_or("Unable to read remote CPU usage")?,
        memory_used_gb,
        memory_total_gb,
        storage_used_gb,
        storage_total_gb,
    })
}

fn run_remote_system_usage(
    config: ConnectionConfig,
) -> Result<SystemUsage, Box<dyn std::error::Error + Send + Sync>> {
    let session = connect_ssh_session(&config)?;
    let mut channel = session.channel_session()?;
    let command = r##"sh -lc 'read cpu user nice system idle iowait irq softirq steal guest guest_nice < /proc/stat; total1=$((user+nice+system+idle+iowait+irq+softirq+steal)); idle1=$((idle+iowait)); sleep 1; read cpu user nice system idle iowait irq softirq steal guest guest_nice < /proc/stat; total2=$((user+nice+system+idle+iowait+irq+softirq+steal)); idle2=$((idle+iowait)); total=$((total2-total1)); idle_delta=$((idle2-idle1)); awk -v total="$total" -v idle="$idle_delta" "BEGIN { if (total > 0) printf \"CPU %.1f\n\", (total-idle)*100/total; else print \"CPU 0.0\" }"; awk "/MemTotal:/ { total=\$2 } /MemAvailable:/ { available=\$2 } END { printf \"MEM %.2f %.2f\n\", (total-available)/1048576, total/1048576 }" /proc/meminfo; df -BG / | awk "NR==2 { gsub(/G/, \"\", \$2); gsub(/G/, \"\", \$3); printf \"DISK %.2f %.2f\n\", \$3, \$2 }"'"##;
    channel.exec(command)?;

    let mut output = String::new();
    channel.read_to_string(&mut output)?;

    let mut stderr = String::new();
    channel.stderr().read_to_string(&mut stderr).ok();
    channel.wait_close()?;

    if channel.exit_status()? != 0 {
        let message = stderr.trim();
        if message.is_empty() {
            return Err("Unable to read remote system usage".into());
        }
        return Err(message.to_string().into());
    }

    parse_system_usage_output(&output)
}

fn run_ssh_session(
    app: AppHandle,
    session_id: String,
    config: ConnectionConfig,
    rx: mpsc::Receiver<SshCommand>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    app.emit(
        "ssh-data",
        SshDataEvent {
            session_id: session_id.clone(),
            data: format!("Opening {} ({})...\r\n", config.name, config.host),
        },
    )
    .ok();

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 32,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let private_key = prepare_private_key(&config)?;
    let command = build_ssh_command(&config, private_key.as_ref(), None);
    let mut child = pair.slave.spawn_command(command)?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    let (reader_done_tx, reader_done_rx) = mpsc::channel::<()>();
    let password = config
        .password
        .clone()
        .filter(|value| !value.trim().is_empty());
    let private_key_passphrase = config
        .private_key_passphrase
        .clone()
        .filter(|value| !value.trim().is_empty());
    let writer_tx = app
        .state::<SshSessions>()
        .0
        .lock()
        .ok()
        .and_then(|store| store.get(&session_id).cloned());

    thread::spawn({
        let app = app.clone();
        let session_id = session_id.clone();
        move || {
            let mut buffer = [0_u8; 8192];
            let mut password_sent = false;
            let mut passphrase_sent = false;

            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => {
                        let data = String::from_utf8_lossy(&buffer[..size]).to_string();
                        let prompt = data.to_lowercase();
                        if !passphrase_sent
                            && prompt.contains("passphrase")
                            && private_key_passphrase.is_some()
                        {
                            passphrase_sent = true;
                            if let (Some(sender), Some(passphrase)) =
                                (&writer_tx, &private_key_passphrase)
                            {
                                sender
                                    .send(SshCommand::Write(format!("{passphrase}\n")))
                                    .ok();
                            }
                        }

                        if !password_sent && prompt.contains("password:") && password.is_some() {
                            password_sent = true;
                            if let (Some(sender), Some(password)) = (&writer_tx, &password) {
                                sender.send(SshCommand::Write(format!("{password}\n"))).ok();
                            }
                        }

                        app.emit(
                            "ssh-data",
                            SshDataEvent {
                                session_id: session_id.clone(),
                                data,
                            },
                        )
                        .ok();
                    }
                    Err(_) => break,
                }
            }

            reader_done_tx.send(()).ok();
        }
    });

    loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(SshCommand::Write(data)) => {
                writer.write_all(data.as_bytes())?;
                writer.flush()?;
            }
            Ok(SshCommand::Resize { cols, rows }) => {
                pair.master.resize(PtySize {
                    rows: rows as u16,
                    cols: cols as u16,
                    pixel_width: 0,
                    pixel_height: 0,
                })?;
            }
            Ok(SshCommand::Disconnect) => {
                child.kill().ok();
                child.wait().ok();
                return Ok(());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                child.kill().ok();
                child.wait().ok();
                return Ok(());
            }
        }

        if reader_done_rx.try_recv().is_ok() {
            child.wait().ok();
            return Ok(());
        }
    }
}

fn run_ssh_test_connection(
    config: ConnectionConfig,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let private_key = prepare_private_key(&config)?;
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 100,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let command = build_ssh_command(&config, private_key.as_ref(), Some("exit"));
    let mut child = pair.slave.spawn_command(command)?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    let (output_tx, output_rx) = mpsc::channel::<String>();

    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    output_tx
                        .send(String::from_utf8_lossy(&buffer[..size]).to_string())
                        .ok();
                }
                Err(_) => break,
            }
        }
    });

    let password = config
        .password
        .clone()
        .filter(|value| !value.trim().is_empty());
    let private_key_passphrase = config
        .private_key_passphrase
        .clone()
        .filter(|value| !value.trim().is_empty());
    let mut password_sent = false;
    let mut passphrase_sent = false;
    let mut output = String::new();
    let started_at = Instant::now();

    loop {
        while let Ok(chunk) = output_rx.try_recv() {
            let prompt = chunk.to_lowercase();
            output.push_str(&chunk);

            if !passphrase_sent && prompt.contains("passphrase") {
                passphrase_sent = true;
                if let Some(passphrase) = &private_key_passphrase {
                    writer.write_all(format!("{passphrase}\n").as_bytes())?;
                    writer.flush()?;
                }
            }

            if !password_sent && prompt.contains("password:") {
                password_sent = true;
                if let Some(password) = &password {
                    writer.write_all(format!("{password}\n").as_bytes())?;
                    writer.flush()?;
                }
            }
        }

        if let Some(status) = child.try_wait()? {
            while let Ok(chunk) = output_rx.try_recv() {
                output.push_str(&chunk);
            }

            if status.success() {
                return Ok("Connection test succeeded".to_string());
            }

            let message = output.trim();
            if message.is_empty() {
                return Err(format!(
                    "Connection test failed with exit code {}",
                    status.exit_code()
                )
                .into());
            }

            return Err(message.to_string().into());
        }

        if started_at.elapsed() > Duration::from_secs(30) {
            child.kill().ok();
            child.wait().ok();
            return Err("Connection test timed out after 30 seconds".into());
        }

        thread::sleep(Duration::from_millis(50));
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                window.show().ok();
                window.unminimize().ok();
                window.set_focus().ok();
            }
        }))
        .manage(SshSessions::default())
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_test_connection,
            ssh_write,
            ssh_resize,
            ssh_disconnect,
            ssh_list_files,
            ssh_upload_file,
            ssh_download_file,
            ssh_get_system_usage
        ])
        .setup(|app| {
            app.deep_link().register_all().ok();
            let window = app
                .get_webview_window("main")
                .expect("main window not found");
            window.set_title("TerSterm").ok();
            window.center().ok();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TerSterm");
}
