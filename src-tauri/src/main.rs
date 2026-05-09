#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env, fs,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        mpsc::{self, Sender},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
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
        .manage(SshSessions::default())
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_test_connection,
            ssh_write,
            ssh_resize,
            ssh_disconnect
        ])
        .setup(|app| {
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
