#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use base64::{engine::general_purpose, Engine as _};
use portable_pty::{
    native_pty_system, Child as PtyChild, CommandBuilder, MasterPty as PtyMasterPty, PtySize,
};
use serde::{Deserialize, Serialize};
use ssh2::{ExtendedData, FileStat, Session, Sftp};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::{
    menu::{MenuBuilder, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_deep_link::DeepLinkExt;
use uuid::Uuid;
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        Threading::{
            OpenProcess, TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW,
            PROCESS_TERMINATE,
        },
    },
};

#[cfg(windows)]
const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;

const MAIN_TRAY_ID: &str = "main-tray";
const TRAY_SHOW_MENU_ID: &str = "tray-show";
const TRAY_QUIT_MENU_ID: &str = "tray-quit";

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
struct SshRawDataEvent {
    session_id: String,
    data_base64: String,
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
    WriteBinary(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Disconnect,
}

struct SessionEntry {
    sender: Sender<SshCommand>,
    done: Receiver<()>,
}

#[derive(Default)]
struct SshSessions(Mutex<HashMap<String, SessionEntry>>);

struct OpenSshProcessEntry {
    session_id: Option<String>,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
struct OpenSshProcesses {
    entries: Mutex<HashMap<String, OpenSshProcessEntry>>,
    cancelled_sessions: Mutex<HashSet<String>>,
}

#[derive(Default)]
struct SshSessionSecrets(Mutex<HashMap<String, SessionAuthSecrets>>);

#[derive(Default, Clone)]
struct SessionAuthSecrets {
    password: Option<String>,
    private_key_passphrase: Option<String>,
}

#[derive(Default)]
struct AppClosing(AtomicBool);

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum WindowCloseBehavior {
    Tray,
    #[default]
    Exit,
}

impl WindowCloseBehavior {
    fn from_value(value: &str) -> Self {
        if value.eq_ignore_ascii_case("tray") {
            Self::Tray
        } else {
            Self::Exit
        }
    }

    fn as_u8(self) -> u8 {
        match self {
            Self::Tray => 1,
            Self::Exit => 0,
        }
    }

    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Tray,
            _ => Self::Exit,
        }
    }
}

struct WindowCloseBehaviorState(AtomicU8);

impl Default for WindowCloseBehaviorState {
    fn default() -> Self {
        Self(AtomicU8::new(WindowCloseBehavior::default().as_u8()))
    }
}

impl WindowCloseBehaviorState {
    fn get(&self) -> WindowCloseBehavior {
        WindowCloseBehavior::from_u8(self.0.load(Ordering::Relaxed))
    }

    fn set(&self, behavior: WindowCloseBehavior) {
        self.0.store(behavior.as_u8(), Ordering::Relaxed);
    }
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum AppLocale {
    #[default]
    ZhCn,
    EnUs,
}

impl AppLocale {
    fn from_value(value: &str) -> Self {
        if value.eq_ignore_ascii_case("en-US") || value.eq_ignore_ascii_case("en") {
            Self::EnUs
        } else {
            Self::ZhCn
        }
    }

    fn as_u8(self) -> u8 {
        match self {
            Self::ZhCn => 0,
            Self::EnUs => 1,
        }
    }

    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::EnUs,
            _ => Self::ZhCn,
        }
    }
}

struct AppLocaleState(AtomicU8);

impl Default for AppLocaleState {
    fn default() -> Self {
        Self(AtomicU8::new(AppLocale::default().as_u8()))
    }
}

impl AppLocaleState {
    fn get(&self) -> AppLocale {
        AppLocale::from_u8(self.0.load(Ordering::Relaxed))
    }

    fn set(&self, locale: AppLocale) {
        self.0.store(locale.as_u8(), Ordering::Relaxed);
    }
}

#[derive(Default)]
struct TrayMenuState {
    show_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    quit_item: Mutex<Option<MenuItem<tauri::Wry>>>,
}

impl Drop for SshSessions {
    fn drop(&mut self) {
        disconnect_all_sessions(self);
    }
}

impl Drop for OpenSshProcesses {
    fn drop(&mut self) {
        cancel_all_openssh_processes(self);
    }
}

fn configure_subprocess(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn disconnect_all_sessions(sessions: &SshSessions) {
    let entries = sessions
        .0
        .lock()
        .map(|mut store| store.drain().map(|(_, entry)| entry).collect::<Vec<_>>())
        .unwrap_or_default();

    for entry in &entries {
        entry.sender.send(SshCommand::Disconnect).ok();
    }

    for entry in entries {
        entry.done.recv_timeout(Duration::from_secs(2)).ok();
    }
}

fn cancel_all_openssh_processes(processes: &OpenSshProcesses) {
    let entries = processes
        .entries
        .lock()
        .map(|mut store| store.drain().map(|(_, entry)| entry).collect::<Vec<_>>())
        .unwrap_or_default();

    if let Ok(mut cancelled_sessions) = processes.cancelled_sessions.lock() {
        cancelled_sessions.extend(entries.iter().filter_map(|entry| entry.session_id.clone()));
    }

    for entry in entries {
        entry.cancel.store(true, Ordering::Relaxed);
    }
}

fn cancel_session_openssh_processes(processes: &OpenSshProcesses, session_id: &str) {
    if let Ok(mut cancelled_sessions) = processes.cancelled_sessions.lock() {
        cancelled_sessions.insert(session_id.to_string());
    }

    let entries = processes
        .entries
        .lock()
        .map(|mut store| {
            let keys = store
                .iter()
                .filter_map(|(key, entry)| {
                    (entry.session_id.as_deref() == Some(session_id)).then_some(key.clone())
                })
                .collect::<Vec<_>>();

            keys.into_iter()
                .filter_map(|key| store.remove(&key))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    for entry in entries {
        entry.cancel.store(true, Ordering::Relaxed);
    }
}

fn clear_session_openssh_cancellation(processes: &OpenSshProcesses, session_id: &str) {
    if let Ok(mut cancelled_sessions) = processes.cancelled_sessions.lock() {
        cancelled_sessions.remove(session_id);
    }
}

fn is_session_openssh_cancelled(processes: &OpenSshProcesses, session_id: &str) -> bool {
    processes
        .cancelled_sessions
        .lock()
        .map(|cancelled_sessions| cancelled_sessions.contains(session_id))
        .unwrap_or(false)
}

fn remember_session_private_key_passphrase(
    secrets: &SshSessionSecrets,
    session_id: &str,
    passphrase: String,
) {
    if passphrase.trim().is_empty() {
        return;
    }

    if let Ok(mut store) = secrets.0.lock() {
        store
            .entry(session_id.to_string())
            .or_default()
            .private_key_passphrase = Some(passphrase);
    }
}

fn remember_session_password(secrets: &SshSessionSecrets, session_id: &str, password: String) {
    if password.trim().is_empty() {
        return;
    }

    if let Ok(mut store) = secrets.0.lock() {
        store.entry(session_id.to_string()).or_default().password = Some(password);
    }
}

fn forget_session_auth_secrets(secrets: &SshSessionSecrets, session_id: &str) {
    if let Ok(mut store) = secrets.0.lock() {
        store.remove(session_id);
    }
}

fn get_session_auth_secrets(
    secrets: &SshSessionSecrets,
    session_id: Option<&str>,
) -> Option<SessionAuthSecrets> {
    session_id.and_then(|id| {
        secrets
            .0
            .lock()
            .ok()
            .and_then(|store| store.get(id).cloned())
    })
}

fn apply_session_auth_secrets(config: &mut ConnectionConfig, secrets: Option<SessionAuthSecrets>) {
    let Some(secrets) = secrets else {
        return;
    };

    if config.password.as_deref().is_none_or(|value| value.trim().is_empty()) {
        if let Some(password) = secrets.password.filter(|value| !value.trim().is_empty()) {
            config.password = Some(password);
        }
    }

    if config
        .private_key_passphrase
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return;
    }

    if let Some(passphrase) = secrets
        .private_key_passphrase
        .filter(|value| !value.trim().is_empty())
    {
        config.private_key_passphrase = Some(passphrase);
    }
}

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

    clear_session_openssh_cancellation(&app.state::<OpenSshProcesses>(), &session_id);
    forget_session_auth_secrets(&app.state::<SshSessionSecrets>(), &session_id);

    let (tx, rx) = mpsc::channel::<SshCommand>();
    let (done_tx, done_rx) = mpsc::channel::<()>();
    sessions
        .0
        .lock()
        .map_err(|_| "SSH session store is unavailable".to_string())?
        .insert(
            session_id.clone(),
            SessionEntry {
                sender: tx,
                done: done_rx,
            },
        );

    let thread_session_id = session_id.clone();
    thread::spawn(move || {
        let disconnect_reason = run_ssh_session(app.clone(), thread_session_id.clone(), config, rx)
            .err()
            .map(|error| error.to_string());

        if let Ok(mut store) = app.state::<SshSessions>().0.lock() {
            store.remove(&thread_session_id);
        }

        forget_session_auth_secrets(
            &app.state::<SshSessionSecrets>(),
            &thread_session_id,
        );
        clear_session_openssh_cancellation(&app.state::<OpenSshProcesses>(), &thread_session_id);

        app.emit(
            "ssh-disconnected",
            SshDisconnectedEvent {
                session_id: thread_session_id,
                reason: disconnect_reason,
            },
        )
        .ok();

        done_tx.send(()).ok();
    });

    Ok(session_id)
}

#[tauri::command]
fn set_window_close_behavior(
    close_behavior: State<'_, WindowCloseBehaviorState>,
    behavior: String,
) {
    close_behavior.set(WindowCloseBehavior::from_value(&behavior));
}

#[tauri::command]
fn set_app_locale(app: AppHandle, locale_state: State<'_, AppLocaleState>, locale: String) {
    let locale = AppLocale::from_value(&locale);
    locale_state.set(locale);
    update_tray_menu_locale(&app, locale);
}

#[tauri::command]
async fn ssh_test_connection(app: AppHandle, config: ConnectionConfig) -> Result<String, String> {
    validate_connection_config(&config)?;
    tauri::async_runtime::spawn_blocking(move || {
        let processes = app.state::<OpenSshProcesses>();
        run_ssh_test_connection(&processes, config)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
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
fn ssh_write_binary(
    sessions: State<'_, SshSessions>,
    session_id: String,
    data_base64: String,
) -> Result<(), String> {
    let bytes = general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|error| error.to_string())?;

    send_command(&sessions, &session_id, SshCommand::WriteBinary(bytes))
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
fn ssh_disconnect(
    sessions: State<'_, SshSessions>,
    processes: State<'_, OpenSshProcesses>,
    secrets: State<'_, SshSessionSecrets>,
    session_id: String,
) -> Result<(), String> {
    cancel_session_openssh_processes(&processes, &session_id);
    forget_session_auth_secrets(&secrets, &session_id);
    send_disconnect_command(&sessions, &session_id)
}

#[tauri::command]
async fn ssh_list_files(
    app: AppHandle,
    mut config: ConnectionConfig,
    remote_path: String,
    session_id: Option<String>,
) -> Result<RemoteFileList, String> {
    validate_connection_config(&config)?;
    let session_auth_secrets = get_session_auth_secrets(&app.state::<SshSessionSecrets>(), session_id.as_deref());
    apply_session_auth_secrets(&mut config, session_auth_secrets);

    tauri::async_runtime::spawn_blocking(move || {
        let processes = app.state::<OpenSshProcesses>();
        run_remote_file_list(&processes, session_id.as_deref(), config, remote_path)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn ssh_upload_file(
    app: AppHandle,
    mut config: ConnectionConfig,
    remote_path: String,
    filename: String,
    content_base64: String,
    session_id: Option<String>,
) -> Result<String, String> {
    validate_connection_config(&config)?;
    let session_auth_secrets = get_session_auth_secrets(&app.state::<SshSessionSecrets>(), session_id.as_deref());
    apply_session_auth_secrets(&mut config, session_auth_secrets);

    tauri::async_runtime::spawn_blocking(move || {
        let processes = app.state::<OpenSshProcesses>();
        run_remote_file_upload(
            &processes,
            session_id.as_deref(),
            config,
            remote_path,
            filename,
            content_base64,
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn ssh_download_file(
    app: AppHandle,
    mut config: ConnectionConfig,
    remote_path: String,
    session_id: Option<String>,
) -> Result<String, String> {
    validate_connection_config(&config)?;
    let session_auth_secrets = get_session_auth_secrets(&app.state::<SshSessionSecrets>(), session_id.as_deref());
    apply_session_auth_secrets(&mut config, session_auth_secrets);

    tauri::async_runtime::spawn_blocking(move || {
        let processes = app.state::<OpenSshProcesses>();
        run_remote_file_download(&app, &processes, session_id.as_deref(), config, remote_path)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn ssh_get_system_usage(
    app: AppHandle,
    mut config: ConnectionConfig,
    session_id: Option<String>,
) -> Result<SystemUsage, String> {
    validate_connection_config(&config)?;
    let session_auth_secrets = get_session_auth_secrets(&app.state::<SshSessionSecrets>(), session_id.as_deref());
    apply_session_auth_secrets(&mut config, session_auth_secrets);

    tauri::async_runtime::spawn_blocking(move || {
        let processes = app.state::<OpenSshProcesses>();
        run_remote_system_usage(&processes, session_id.as_deref(), config)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_local_file(
    app: AppHandle,
    filename: String,
    content_base64: String,
) -> Result<String, String> {
    let bytes = general_purpose::STANDARD
        .decode(content_base64)
        .map_err(|error| error.to_string())?;
    let downloads = app.path().download_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&downloads).map_err(|error| error.to_string())?;
    let local_path = unique_local_path(&downloads, &filename);
    fs::write(&local_path, bytes).map_err(|error| error.to_string())?;
    Ok(local_path.to_string_lossy().to_string())
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
        .map(|entry| entry.sender.clone())
        .ok_or_else(|| "SSH session not found".to_string())?;

    sender
        .send(command)
        .map_err(|_| "SSH session is already closed".to_string())
}

fn send_disconnect_command(
    sessions: &State<'_, SshSessions>,
    session_id: &str,
) -> Result<(), String> {
    let sender = sessions
        .0
        .lock()
        .map_err(|_| "SSH session store is unavailable".to_string())?
        .get(session_id)
        .map(|entry| entry.sender.clone());

    let Some(sender) = sender else {
        return Ok(());
    };

    sender
        .send(SshCommand::Disconnect)
        .map_err(|_| "SSH session is already closed".to_string())
}

fn emit_ssh_output(app: &AppHandle, session_id: &str, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }

    app.emit(
        "ssh-data-raw",
        SshRawDataEvent {
            session_id: session_id.to_string(),
            data_base64: general_purpose::STANDARD.encode(bytes),
        },
    )
    .ok();

    app.emit(
        "ssh-data",
        SshDataEvent {
            session_id: session_id.to_string(),
            data: String::from_utf8_lossy(bytes).to_string(),
        },
    )
    .ok();
}

struct OpenSshProcessGuard<'a> {
    processes: &'a OpenSshProcesses,
    token: String,
    cancel: Arc<AtomicBool>,
}

impl OpenSshProcessGuard<'_> {
    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

impl Drop for OpenSshProcessGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut store) = self.processes.entries.lock() {
            store.remove(&self.token);
        }
    }
}

fn register_openssh_process<'a>(
    processes: &'a OpenSshProcesses,
    session_id: Option<&str>,
) -> OpenSshProcessGuard<'a> {
    let token = Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));

    if session_id.is_some_and(|value| is_session_openssh_cancelled(processes, value)) {
        cancel.store(true, Ordering::Relaxed);
    }

    if let Ok(mut store) = processes.entries.lock() {
        store.insert(
            token.clone(),
            OpenSshProcessEntry {
                session_id: session_id.map(|value| value.to_string()),
                cancel: cancel.clone(),
            },
        );
    }

    OpenSshProcessGuard {
        processes,
        token,
        cancel,
    }
}

#[cfg(windows)]
fn snapshot_process_entries() -> Option<Vec<(u32, u32)>> {
    let snapshot: HANDLE = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return None;
    }

    let mut entries = Vec::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..unsafe { std::mem::zeroed() }
    };

    if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
        loop {
            entries.push((entry.th32ProcessID, entry.th32ParentProcessID));
            if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                break;
            }
        }
    }

    unsafe {
        CloseHandle(snapshot);
    }

    Some(entries)
}

#[cfg(windows)]
fn collect_descendants_from_entries(root_process_id: u32, entries: &[(u32, u32)]) -> Vec<u32> {
    fn collect_descendants(process_id: u32, entries: &[(u32, u32)], descendants: &mut Vec<u32>) {
        for &(child_id, parent_id) in entries {
            if parent_id == process_id && child_id != process_id {
                collect_descendants(child_id, entries, descendants);
                descendants.push(child_id);
            }
        }
    }

    let mut process_ids = Vec::new();
    collect_descendants(root_process_id, entries, &mut process_ids);
    process_ids
}

#[cfg(windows)]
fn collect_descendant_process_ids(root_process_id: u32) -> Vec<u32> {
    let Some(entries) = snapshot_process_entries() else {
        return Vec::new();
    };

    collect_descendants_from_entries(root_process_id, &entries)
}

#[cfg(windows)]
fn terminate_process_ids(process_ids: &[u32]) -> bool {
    let mut terminated_any = false;

    for &pid in process_ids {
        let handle = unsafe { OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE_ACCESS, 0, pid) };
        if handle.is_null() {
            continue;
        }

        unsafe {
            if TerminateProcess(handle, 1) != 0 {
                terminated_any = true;
                WaitForSingleObject(handle, 2_000);
            }
            CloseHandle(handle);
        }
    }

    terminated_any
}

#[cfg(windows)]
fn terminate_descendant_processes(root_process_id: u32) -> bool {
    let process_ids = collect_descendant_process_ids(root_process_id);
    terminate_process_ids(&process_ids)
}

#[cfg(windows)]
fn terminate_process_tree(process_id: u32) -> bool {
    let mut process_ids = collect_descendant_process_ids(process_id);
    process_ids.push(process_id);

    terminate_process_ids(&process_ids)
}

fn terminate_pty_child(child: &mut (dyn PtyChild + Send + Sync)) {
    #[cfg(windows)]
    if let Some(process_id) = child.process_id() {
        if terminate_process_tree(process_id) {
            return;
        }
    }

    child.kill().ok();
}

fn wait_for_pty_child_exit(child: &mut (dyn PtyChild + Send + Sync), timeout: Duration) {
    let deadline = Instant::now() + timeout;

    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => {
                if Instant::now() >= deadline {
                    return;
                }

                thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

fn shutdown_pty_process(
    child: &mut (dyn PtyChild + Send + Sync),
    master: &mut Option<Box<dyn PtyMasterPty + Send>>,
    writer: &mut Option<Box<dyn Write + Send>>,
    reader_done: Option<&Receiver<()>>,
) {
    drop(writer.take());
    drop(master.take());

    if let Some(reader_done) = reader_done {
        reader_done.recv_timeout(Duration::from_millis(200)).ok();
    }

    terminate_pty_child(child);
    wait_for_pty_child_exit(child, Duration::from_secs(2));

    if let Some(reader_done) = reader_done {
        reader_done.recv_timeout(Duration::from_millis(200)).ok();
    }
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

fn clone_private_key_to_temp(
    private_key: PreparedPrivateKey,
) -> Result<PreparedPrivateKey, Box<dyn std::error::Error + Send + Sync>> {
    if private_key.remove_on_drop {
        return Ok(private_key);
    }

    let copy_path = env::temp_dir().join(format!("tersterm-key-{}.pem", Uuid::new_v4()));
    fs::copy(&private_key.path, &copy_path)?;
    Ok(PreparedPrivateKey {
        path: copy_path,
        remove_on_drop: true,
    })
}

fn private_key_needs_pem_conversion(path: &Path) -> bool {
    fs::read_to_string(path)
        .map(|content| content.contains("BEGIN OPENSSH PRIVATE KEY"))
        .unwrap_or(false)
}

fn convert_private_key_to_pem(
    path: &Path,
    passphrase: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut command = std::process::Command::new("ssh-keygen");
    configure_subprocess(&mut command);
    let status = command
        .arg("-p")
        .arg("-m")
        .arg("PEM")
        .arg("-P")
        .arg(passphrase)
        .arg("-N")
        .arg(passphrase)
        .arg("-f")
        .arg(path)
        .arg("-q")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;

    if status.success() {
        return Ok(());
    }

    Err("Failed to convert private key to PEM for SSH operations".into())
}

fn remove_private_key_passphrase(
    path: &Path,
    passphrase: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut command = std::process::Command::new("ssh-keygen");
    configure_subprocess(&mut command);
    let status = command
        .arg("-p")
        .arg("-P")
        .arg(passphrase)
        .arg("-N")
        .arg("")
        .arg("-f")
        .arg(path)
        .arg("-q")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;

    if status.success() {
        return Ok(());
    }

    Err("Failed to remove private key passphrase for OpenSSH operations".into())
}

fn prepare_private_key_for_ssh2(
    config: &ConnectionConfig,
) -> Result<Option<PreparedPrivateKey>, Box<dyn std::error::Error + Send + Sync>> {
    let Some(private_key) = prepare_private_key(config)? else {
        return Ok(None);
    };

    if !private_key_needs_pem_conversion(&private_key.path) {
        return Ok(Some(private_key));
    }

    let converted_key = clone_private_key_to_temp(private_key)?;

    let passphrase = config.private_key_passphrase.as_deref().unwrap_or("");
    let _ = convert_private_key_to_pem(&converted_key.path, passphrase);
    Ok(Some(converted_key))
}

fn prepare_private_key_for_noninteractive_openssh(
    config: &ConnectionConfig,
) -> Result<Option<PreparedPrivateKey>, Box<dyn std::error::Error + Send + Sync>> {
    let Some(private_key) = prepare_private_key(config)? else {
        return Ok(None);
    };

    let Some(passphrase) = config
        .private_key_passphrase
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(Some(private_key));
    };

    let key_copy = clone_private_key_to_temp(private_key)?;
    remove_private_key_passphrase(&key_copy.path, passphrase)?;
    Ok(Some(key_copy))
}

fn build_ssh_command(
    config: &ConnectionConfig,
    private_key: Option<&PreparedPrivateKey>,
    remote_command: Option<&str>,
) -> CommandBuilder {
    let mut command = CommandBuilder::new("ssh");
    command.arg(if remote_command.is_some() {
        "-T"
    } else {
        "-tt"
    });
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

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r#"'\''"#))
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
    session.set_timeout(20_000);
    session.set_tcp_stream(tcp);
    session.handshake()?;

    let passphrase = config
        .private_key_passphrase
        .as_deref()
        .filter(|value| !value.trim().is_empty());

    let private_key = prepare_private_key_for_ssh2(config)?;

    if let Some(private_key) = private_key.as_ref() {
        session
            .userauth_pubkey_file(&config.username, None, &private_key.path, passphrase)
            .map_err(|error| format!("SSH private key authentication failed: {error}"))?;
    } else if let Some(password) = config.password.as_deref().filter(|value| !value.is_empty()) {
        session
            .userauth_password(&config.username, password)
            .map_err(|error| format!("SSH password authentication failed: {error}"))?;
    } else {
        session
            .userauth_agent(&config.username)
            .map_err(|error| format!("SSH agent authentication failed: {error}"))?;
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

fn file_list_shell_fragment(remote_path: &str) -> String {
    let requested_path = sftp_path(remote_path);
    format!(
        r#"path={}; real=$(cd -- "$path" 2>/dev/null && pwd -P) || exit 1; printf "\nPATH\t%s\n" "$real"; if [ "$real" != "/" ]; then printf "ENTRY\td\t..\t\t\n"; fi; find "$real" -maxdepth 1 -mindepth 1 -printf "ENTRY\t%y\t%f\t%s\t%TY-%Tm-%Td %TH:%TM\n""#,
        shell_quote(&requested_path)
    )
}

fn should_fallback_to_openssh(
    config: &ConnectionConfig,
    error: &(dyn std::error::Error + Send + Sync),
) -> bool {
    let has_password = config
        .password
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());

    if !connection_uses_private_key(config) && !has_password {
        return false;
    }

    let message = error.to_string().to_lowercase();
    [
        "auth",
        "authentication",
        "password",
        "keyboard-interactive",
        "agent",
        "key",
        "pem",
        "public key",
        "private key",
        "unsupported",
        "invalid",
        "libssh2",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

fn strip_terminal_control_sequences(output: &str) -> String {
    let mut clean = String::with_capacity(output.len());
    let mut chars = output.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            clean.push(ch);
            continue;
        }

        match chars.peek().copied() {
            Some('[') => {
                chars.next();
                while let Some(next) = chars.next() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                while let Some(next) = chars.next() {
                    if next == '\u{7}' {
                        break;
                    }

                    if next == '\u{1b}' && matches!(chars.peek(), Some('\\')) {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }

    clean
}

fn line_looks_like_shell_prompt(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }

    let Some(last) = trimmed.chars().last() else {
        return false;
    };

    if !matches!(last, '#' | '$' | '>' | '%') {
        return false;
    }

    if trimmed.starts_with('[') && trimmed.len() <= 160 {
        return true;
    }

    trimmed.len() <= 160 && (trimmed.contains('@') || trimmed.contains(':'))
}

fn output_looks_authenticated(output: &str) -> bool {
    let normalized = strip_terminal_control_sequences(output);
    if normalized.contains("Welcome to ") || normalized.contains("Last login:") {
        return true;
    }

    normalized
        .lines()
        .rev()
        .filter_map(|line| {
            let trimmed = line.trim();
            (!trimmed.is_empty()).then_some(trimmed)
        })
        .take(8)
        .any(line_looks_like_shell_prompt)
}

fn parse_openssh_file_list(
    output: &str,
) -> Result<RemoteFileList, Box<dyn std::error::Error + Send + Sync>> {
    let mut display_path = None;
    let mut entries = Vec::new();

    for line in output.lines() {
        let Some(line) = line
            .find("PATH\t")
            .or_else(|| line.find("ENTRY\t"))
            .map(|index| &line[index..])
        else {
            continue;
        };

        let mut parts = line.splitn(5, '\t');
        match parts.next() {
            Some("PATH") => {
                display_path = parts.next().map(|value| value.replace('\\', "/"));
            }
            Some("ENTRY") => {
                let kind = match parts.next() {
                    Some("d") => "directory",
                    Some("l") => "symlink",
                    Some("f") | Some("-") => "file",
                    Some(_) | None => "file",
                }
                .to_string();
                let name = parts.next().unwrap_or_default().to_string();
                if name.is_empty() {
                    continue;
                }

                let size = parts.next().and_then(|value| value.parse::<u64>().ok());
                let modified = parts.next().unwrap_or_default().to_string();
                entries.push(RemoteFileEntry {
                    name,
                    path: String::new(),
                    kind,
                    size,
                    modified,
                });
            }
            _ => {}
        }
    }

    let display_path = display_path.ok_or("Unable to read remote directory")?;
    for entry in &mut entries {
        entry.path = remote_join(&display_path, &entry.name);
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

fn run_remote_file_list_openssh(
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: &ConnectionConfig,
    remote_path: &str,
) -> Result<RemoteFileList, Box<dyn std::error::Error + Send + Sync>> {
    let fragment = file_list_shell_fragment(remote_path);
    let command = format!("sh -lc {}", shell_quote(&fragment));
    let output = run_openssh_exec_command(processes, session_id, config, &command)?;
    parse_openssh_file_list(&output)
}

fn run_remote_file_list(
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: ConnectionConfig,
    remote_path: String,
) -> Result<RemoteFileList, Box<dyn std::error::Error + Send + Sync>> {
    if connection_uses_private_key(&config) {
        return run_remote_file_list_openssh(processes, session_id, &config, &remote_path);
    }

    match run_remote_file_list_ssh2(config.clone(), remote_path.clone()) {
        Ok(result) => Ok(result),
        Err(error) if should_fallback_to_openssh(&config, &*error) => {
            run_remote_file_list_openssh(processes, session_id, &config, &remote_path)
        }
        Err(error) => Err(error),
    }
}

fn run_remote_file_list_ssh2(
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
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: ConnectionConfig,
    remote_path: String,
    filename: String,
    content_base64: String,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let safe_name = sanitize_filename(&filename);
    if safe_name.is_empty() {
        return Err("File name is required".into());
    }

    match run_remote_file_upload_ssh2(&config, &remote_path, &safe_name, &content_base64) {
        Ok(result) => Ok(result),
        Err(error) if should_fallback_to_openssh(&config, &*error) => {
            run_remote_file_upload_openssh(
                processes,
                session_id,
                &config,
                remote_path,
                safe_name,
                content_base64,
            )
        }
        Err(error) => Err(error),
    }
}

fn run_remote_file_upload_ssh2(
    config: &ConnectionConfig,
    remote_path: &str,
    safe_name: &str,
    content_base64: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let (_session, sftp) = connect_sftp(config)?;
    let bytes = general_purpose::STANDARD.decode(content_base64)?;
    let target = remote_join(&normalize_remote_path(remote_path), safe_name);
    let mut remote_file = sftp.create(Path::new(&sftp_path(&target)))?;
    remote_file.write_all(&bytes)?;
    remote_file.flush()?;

    Ok(target)
}

fn run_remote_file_upload_openssh(
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: &ConnectionConfig,
    remote_path: String,
    safe_name: String,
    content_base64: String,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let target = remote_join(&normalize_remote_path(&remote_path), &safe_name);
    let remote_target = sftp_path(&target);
    let marker = format!("TERSTERM_UPLOAD_{}", Uuid::new_v4().simple());
    let fragment = format!(
        r#"target={}; parent=$(dirname -- "$target") || exit 1; mkdir -p -- "$parent" || exit 1; base64 -d > "$target" <<'{}'
{}
{}
"#,
        shell_quote(&remote_target),
        marker,
        content_base64,
        marker
    );
    let command = format!("sh -lc {}", shell_quote(&fragment));
    run_openssh_exec_command(processes, session_id, config, &command)?;

    Ok(target)
}

fn run_remote_file_download(
    app: &AppHandle,
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
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

    if connection_uses_private_key(&config) {
        run_remote_file_download_openssh(
            processes,
            session_id,
            &config,
            &remote_path,
            &local_path,
        )?;
        return Ok(local_path.to_string_lossy().to_string());
    }

    match run_remote_file_download_ssh2(&config, &remote_path, &local_path) {
        Ok(()) => Ok(local_path.to_string_lossy().to_string()),
        Err(error) if should_fallback_to_openssh(&config, &*error) => {
            run_remote_file_download_openssh(
                processes,
                session_id,
                &config,
                &remote_path,
                &local_path,
            )?;
            Ok(local_path.to_string_lossy().to_string())
        }
        Err(error) => Err(error),
    }
}

fn run_remote_file_download_ssh2(
    config: &ConnectionConfig,
    remote_path: &str,
    local_path: &Path,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (_session, sftp) = connect_sftp(config)?;
    let mut remote_file = sftp.open(Path::new(&sftp_path(remote_path)))?;
    let mut local_file = fs::File::create(local_path)?;
    std::io::copy(&mut remote_file, &mut local_file)?;
    Ok(())
}

fn run_remote_file_download_openssh(
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: &ConnectionConfig,
    remote_path: &str,
    local_path: &Path,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let start_marker = format!("TERSTERM_DOWNLOAD_BEGIN_{}", Uuid::new_v4().simple());
    let end_marker = format!("TERSTERM_DOWNLOAD_END_{}", Uuid::new_v4().simple());
    let fragment = format!(
        "printf '%s\\n' {start}; base64 < {path}; printf '\\n%s\\n' {end}",
        start = shell_quote(&start_marker),
        end = shell_quote(&end_marker),
        path = shell_quote(&sftp_path(remote_path)),
    );
    let command = format!("sh -lc {}", shell_quote(&fragment));
    let output = run_openssh_exec_command(processes, session_id, config, &command)?;
    let start = output
        .find(&start_marker)
        .ok_or("Unable to find download start marker")?;
    let end = output
        .find(&end_marker)
        .ok_or("Unable to find download end marker")?;
    let encoded = output[start + start_marker.len()..end]
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>();
    let bytes = general_purpose::STANDARD.decode(encoded)?;
    fs::write(local_path, bytes)?;
    Ok(())
}

fn parse_system_usage_output(
    output: &str,
) -> Result<SystemUsage, Box<dyn std::error::Error + Send + Sync>> {
    let mut cpu_percent = None;
    let mut memory = None;
    let mut storage = None;

    for line in output.lines() {
        let line = line
            .find("CPU ")
            .or_else(|| line.find("MEM "))
            .or_else(|| line.find("DISK "))
            .map(|index| &line[index..])
            .unwrap_or(line);
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

    let (memory_used_gb, memory_total_gb) = memory.ok_or("Unable to read remote memory usage")?;
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
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: ConnectionConfig,
) -> Result<SystemUsage, Box<dyn std::error::Error + Send + Sync>> {
    let command = format!("sh -lc {}", shell_quote(system_usage_shell_fragment()));

    if connection_uses_private_key(&config) {
        let output = run_openssh_exec_command(processes, session_id, &config, &command)?;
        return parse_system_usage_output(&output);
    }

    match run_ssh2_exec_command(&config, &command) {
        Ok(output) => parse_system_usage_output(&output),
        Err(error) if should_fallback_to_openssh(&config, &*error) => {
            let output = run_openssh_exec_command(processes, session_id, &config, &command)?;
            parse_system_usage_output(&output)
        }
        Err(error) => Err(error),
    }
}

fn system_usage_shell_fragment() -> &'static str {
    r#"printf "\n"; read cpu user nice system idle iowait irq softirq steal guest guest_nice < /proc/stat; total1=$((user+nice+system+idle+iowait+irq+softirq+steal)); idle1=$((idle+iowait)); sleep 1; read cpu user nice system idle iowait irq softirq steal guest guest_nice < /proc/stat; total2=$((user+nice+system+idle+iowait+irq+softirq+steal)); idle2=$((idle+iowait)); total=$((total2-total1)); idle_delta=$((idle2-idle1)); awk -v total="$total" -v idle="$idle_delta" "BEGIN { if (total > 0) printf \"CPU %.1f\n\", (total-idle)*100/total; else print \"CPU 0.0\" }"; awk "/MemTotal:/ { total=\$2 } /MemAvailable:/ { available=\$2 } END { printf \"MEM %.2f %.2f\n\", (total-available)/1048576, total/1048576 }" /proc/meminfo; df -B1 / | awk "NR==2 { printf \"DISK %.2f %.2f\n\", \$3/1073741824, \$2/1073741824 }""#
}

fn run_ssh2_exec_command(
    config: &ConnectionConfig,
    remote_command: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let session = connect_ssh_session(config)?;
    let mut channel = session.channel_session()?;
    channel.handle_extended_data(ExtendedData::Merge)?;
    channel.exec(remote_command)?;

    let mut output = String::new();
    channel.read_to_string(&mut output)?;
    channel.wait_close()?;

    let exit_status = channel.exit_status()?;
    if exit_status == 0 {
        return Ok(output);
    }

    let message = output.trim();
    if message.is_empty() {
        return Err(format!("Remote command failed with exit code {exit_status}").into());
    }

    Err(message.to_string().into())
}

fn connection_uses_private_key(config: &ConnectionConfig) -> bool {
    config
        .private_key
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        || config
            .private_key_path
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
}

fn run_openssh_exec_command(
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: &ConnectionConfig,
    remote_command: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let debug_enabled = env::var("TERSTERM_DEBUG_OPENSSH")
        .map(|value| value == "1")
        .unwrap_or(false);
    let has_interactive_secret = config
        .password
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());

    if !has_interactive_secret {
        return run_openssh_exec_command_noninteractive(
            processes,
            session_id,
            config,
            remote_command,
        );
    }

    let process_guard = register_openssh_process(processes, session_id);
    if process_guard.is_cancelled() {
        return Err("OpenSSH command cancelled".into());
    }

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 32,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let private_key = prepare_private_key(config)?;
    let command = build_ssh_command(config, private_key.as_ref(), Some(remote_command));
    if process_guard.is_cancelled() {
        return Err("OpenSSH command cancelled".into());
    }

    let master = pair.master;
    let slave = pair.slave;
    let mut child = slave.spawn_command(command)?;
    drop(slave);
    if process_guard.is_cancelled() {
        terminate_pty_child(&mut *child);
        return Err("OpenSSH command cancelled".into());
    }

    let mut reader = master.try_clone_reader()?;
    let mut writer = Some(master.take_writer()?);
    let mut master = Some(master);
    let (output_tx, output_rx) = mpsc::channel::<Option<String>>();
    let (reader_done_tx, reader_done_rx) = mpsc::channel::<()>();
    let private_key_passphrase = config
        .private_key_passphrase
        .clone()
        .filter(|value| !value.trim().is_empty());
    let password = config
        .password
        .clone()
        .filter(|value| !value.trim().is_empty());

    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    if output_tx
                        .send(Some(String::from_utf8_lossy(&buffer[..size]).to_string()))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(_) => break,
            }
        }

        output_tx.send(None).ok();
        reader_done_tx.send(()).ok();
    });

    let started_at = Instant::now();
    let mut output = String::new();
    let mut prompt_buffer = String::new();
    let requires_passphrase = private_key_passphrase.is_some();
    let requires_password = password.is_some();
    let mut password_sent = false;
    let mut passphrase_sent = false;
    let mut exit_status = None;

    loop {
        if process_guard.is_cancelled() {
            shutdown_pty_process(&mut *child, &mut master, &mut writer, Some(&reader_done_rx));
            return Err("OpenSSH command cancelled".into());
        }

        if let Some(status) = child.try_wait()? {
            exit_status = Some(status);
            break;
        }

        match output_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Some(data)) => {
                if debug_enabled {
                    eprintln!(
                        "run_openssh_exec_command output chunk: {}",
                        data.replace('\r', "\\r").replace('\n', "\\n")
                    );
                }

                if data.contains("\u{1b}[6n") {
                    if debug_enabled {
                        eprintln!("run_openssh_exec_command responding to cursor position request");
                    }
                    if let Some(writer) = writer.as_mut() {
                        writer.write_all(b"\x1b[1;1R")?;
                        writer.flush()?;
                    }
                }

                output.push_str(&data);
                prompt_buffer.push_str(&data);
                if prompt_buffer.len() > 4096 {
                    prompt_buffer = prompt_buffer
                        .chars()
                        .rev()
                        .take(4096)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect();
                }

                let prompt = prompt_buffer.to_lowercase();
                if !passphrase_sent && prompt.contains("passphrase") {
                    if let Some(passphrase) = &private_key_passphrase {
                        passphrase_sent = true;
                        if debug_enabled {
                            eprintln!("run_openssh_exec_command sending private key passphrase");
                        }
                        if let Some(writer) = writer.as_mut() {
                            writer.write_all(format!("{passphrase}\n").as_bytes())?;
                            writer.flush()?;
                        }
                    }
                }

                if !password_sent && prompt.contains("password:") {
                    if let Some(password) = &password {
                        password_sent = true;
                        if debug_enabled {
                            eprintln!("run_openssh_exec_command sending password");
                        }
                        if let Some(writer) = writer.as_mut() {
                            writer.write_all(format!("{password}\n").as_bytes())?;
                            writer.flush()?;
                        }
                    }
                }

                // Remote exec probes never need stdin after credentials are supplied.
                if writer.is_some()
                    && (!requires_passphrase || passphrase_sent)
                    && (!requires_password || password_sent)
                {
                    if debug_enabled {
                        eprintln!("run_openssh_exec_command closing stdin after credentials");
                    }
                    drop(writer.take());
                }
            }
            Ok(None) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if debug_enabled && started_at.elapsed().as_secs() % 5 == 0 {
                    eprintln!(
                        "run_openssh_exec_command timeout tick: {}s",
                        started_at.elapsed().as_secs()
                    );
                }
                if started_at.elapsed() > Duration::from_secs(20) {
                    shutdown_pty_process(
                        &mut *child,
                        &mut master,
                        &mut writer,
                        Some(&reader_done_rx),
                    );
                    return Err("OpenSSH command timed out".into());
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    if exit_status.is_some() {
        drop(writer.take());
        drop(master.take());
        reader_done_rx.recv_timeout(Duration::from_millis(500)).ok();

        loop {
            match output_rx.try_recv() {
                Ok(Some(data)) => output.push_str(&data),
                Ok(None) | Err(mpsc::TryRecvError::Empty) | Err(mpsc::TryRecvError::Disconnected) => {
                    break;
                }
            }
        }
    }

    if process_guard.is_cancelled() {
        shutdown_pty_process(&mut *child, &mut master, &mut writer, Some(&reader_done_rx));
        return Err("OpenSSH command cancelled".into());
    }

    let status = match exit_status {
        Some(status) => status,
        None => child.wait()?,
    };
    if status.success() {
        return Ok(output);
    }

    let message = output.trim();
    if message.is_empty() {
        return Err(format!("OpenSSH command failed with code {}", status.exit_code()).into());
    }

    Err(message.to_string().into())
}

fn run_openssh_exec_command_noninteractive(
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: &ConnectionConfig,
    remote_command: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let process_guard = register_openssh_process(processes, session_id);
    if process_guard.is_cancelled() {
        return Err("OpenSSH command cancelled".into());
    }

    let private_key = prepare_private_key_for_noninteractive_openssh(config)?;
    let mut command = std::process::Command::new("ssh");
    configure_subprocess(&mut command);
    command
        .arg("-T")
        .arg("-p")
        .arg(config.port.to_string())
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ServerAliveInterval=30")
        .arg("-o")
        .arg("ConnectTimeout=15")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("NumberOfPasswordPrompts=0");

    if let Some(private_key) = private_key.as_ref() {
        command.arg("-i").arg(&private_key.path);
    }

    command
        .arg(format!("{}@{}", config.username, config.host))
        .arg(remote_command)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = command.spawn()?;
    let mut stdout = child.stdout.take().ok_or("Unable to read OpenSSH stdout")?;
    let mut stderr = child.stderr.take().ok_or("Unable to read OpenSSH stderr")?;
    let stdout_reader = thread::spawn(move || {
        let mut output = String::new();
        stdout.read_to_string(&mut output).ok();
        output
    });
    let stderr_reader = thread::spawn(move || {
        let mut output = String::new();
        stderr.read_to_string(&mut output).ok();
        output
    });
    let started_at = Instant::now();
    let status;

    loop {
        if process_guard.is_cancelled() {
            child.kill().ok();
            child.wait().ok();
            stdout_reader.join().ok();
            stderr_reader.join().ok();
            return Err("OpenSSH command cancelled".into());
        }

        if let Some(exit_status) = child.try_wait()? {
            status = exit_status;
            break;
        }

        if started_at.elapsed() > Duration::from_secs(20) {
            child.kill().ok();
            child.wait().ok();
            stdout_reader.join().ok();
            stderr_reader.join().ok();
            return Err("OpenSSH command timed out".into());
        }

        thread::sleep(Duration::from_millis(50));
    }

    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    let combined = format!("{stdout}{stderr}");

    if status.success() {
        return Ok(combined);
    }

    let message = combined.trim();
    if message.is_empty() {
        return Err(format!("OpenSSH command failed with code {:?}", status.code()).into());
    }

    Err(message.to_string().into())
}

fn run_ssh_session(
    app: AppHandle,
    session_id: String,
    config: ConnectionConfig,
    rx: mpsc::Receiver<SshCommand>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    emit_ssh_output(
        &app,
        &session_id,
        format!("Opening {} ({})...\r\n", config.name, config.host).as_bytes(),
    );

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 32,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let private_key = prepare_private_key(&config)?;
    let command = build_ssh_command(&config, private_key.as_ref(), None);
    let master = pair.master;
    let slave = pair.slave;
    let mut child = slave.spawn_command(command)?;
    drop(slave);

    let mut reader = master.try_clone_reader()?;
    let mut writer = Some(master.take_writer()?);
    let mut master = Some(master);
    let (reader_done_tx, reader_done_rx) = mpsc::channel::<()>();
    let private_key_passphrase = config
        .private_key_passphrase
        .clone()
        .filter(|value| !value.trim().is_empty());
    let password = config
        .password
        .clone()
        .filter(|value| !value.trim().is_empty());
    let should_capture_private_key_passphrase =
        connection_uses_private_key(&config) && private_key_passphrase.is_none();
    let private_key_passphrase_prompted = Arc::new(AtomicBool::new(false));
    let should_capture_password = password.is_none();
    let password_prompted = Arc::new(AtomicBool::new(false));
    let authenticated = Arc::new(AtomicBool::new(false));
    let writer_tx = app
        .state::<SshSessions>()
        .0
        .lock()
        .ok()
        .and_then(|store| store.get(&session_id).map(|entry| entry.sender.clone()));

    thread::spawn({
        let app = app.clone();
        let session_id = session_id.clone();
        let private_key_passphrase_prompted = private_key_passphrase_prompted.clone();
        let password_prompted = password_prompted.clone();
        let authenticated = authenticated.clone();
        move || {
            let mut buffer = [0_u8; 8192];
            let mut password_sent = false;
            let mut passphrase_sent = false;
            let mut auth_prompt_buffer = String::new();

            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => {
                        let data = String::from_utf8_lossy(&buffer[..size]).to_string();
                        auth_prompt_buffer.push_str(&data);
                        if auth_prompt_buffer.len() > 4096 {
                            auth_prompt_buffer = auth_prompt_buffer
                                .chars()
                                .rev()
                                .take(4096)
                                .collect::<String>()
                                .chars()
                                .rev()
                                .collect();
                        }
                        if !authenticated.load(Ordering::Relaxed)
                            && output_looks_authenticated(&auth_prompt_buffer)
                        {
                            authenticated.store(true, Ordering::Relaxed);
                            private_key_passphrase_prompted.store(false, Ordering::Relaxed);
                            password_prompted.store(false, Ordering::Relaxed);
                        }

                        let prompt = auth_prompt_buffer.to_lowercase();
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
                        if !authenticated.load(Ordering::Relaxed)
                            && should_capture_private_key_passphrase
                            && prompt.contains("passphrase")
                        {
                            private_key_passphrase_prompted.store(true, Ordering::Relaxed);
                        }

                        if !password_sent && prompt.contains("password:") && password.is_some() {
                            password_sent = true;
                            if let (Some(sender), Some(password)) = (&writer_tx, &password) {
                                sender.send(SshCommand::Write(format!("{password}\n"))).ok();
                            }
                        }
                        if !authenticated.load(Ordering::Relaxed)
                            && should_capture_password
                            && prompt.contains("password:")
                        {
                            password_prompted.store(true, Ordering::Relaxed);
                        }

                        emit_ssh_output(&app, &session_id, &buffer[..size]);
                    }
                    Err(_) => break,
                }
            }

            reader_done_tx.send(()).ok();
        }
    });

    let mut captured_private_key_passphrase = String::new();
    let mut captured_password = String::new();

    loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(SshCommand::Write(data)) => {
                if !authenticated.load(Ordering::Relaxed)
                    && should_capture_private_key_passphrase
                    && private_key_passphrase_prompted.load(Ordering::Relaxed)
                {
                    for ch in data.chars() {
                        if ch == '\u{3}' {
                            captured_private_key_passphrase.clear();
                            private_key_passphrase_prompted.store(false, Ordering::Relaxed);
                            break;
                        }

                        if ch == '\u{7f}' || ch == '\u{8}' {
                            captured_private_key_passphrase.pop();
                            continue;
                        }

                        if ch == '\r' || ch == '\n' {
                            if !captured_private_key_passphrase.is_empty() {
                                remember_session_private_key_passphrase(
                                    &app.state::<SshSessionSecrets>(),
                                    &session_id,
                                    captured_private_key_passphrase.clone(),
                                );
                            }
                            captured_private_key_passphrase.clear();
                            private_key_passphrase_prompted.store(false, Ordering::Relaxed);
                            break;
                        }

                        if !ch.is_control() {
                            captured_private_key_passphrase.push(ch);
                        }
                    }
                }

                if !authenticated.load(Ordering::Relaxed)
                    && should_capture_password
                    && password_prompted.load(Ordering::Relaxed)
                {
                    for ch in data.chars() {
                        if ch == '\u{3}' {
                            captured_password.clear();
                            password_prompted.store(false, Ordering::Relaxed);
                            break;
                        }

                        if ch == '\u{7f}' || ch == '\u{8}' {
                            captured_password.pop();
                            continue;
                        }

                        if ch == '\r' || ch == '\n' {
                            if !captured_password.is_empty() {
                                remember_session_password(
                                    &app.state::<SshSessionSecrets>(),
                                    &session_id,
                                    captured_password.clone(),
                                );
                            }
                            captured_password.clear();
                            password_prompted.store(false, Ordering::Relaxed);
                            break;
                        }

                        if !ch.is_control() {
                            captured_password.push(ch);
                        }
                    }
                }

                if let Some(writer) = writer.as_mut() {
                    writer.write_all(data.as_bytes())?;
                    writer.flush()?;
                }
            }
            Ok(SshCommand::WriteBinary(data)) => {
                if let Some(writer) = writer.as_mut() {
                    writer.write_all(&data)?;
                    writer.flush()?;
                }
            }
            Ok(SshCommand::Resize { cols, rows }) => {
                if let Some(master) = master.as_ref() {
                    master.resize(PtySize {
                        rows: rows as u16,
                        cols: cols as u16,
                        pixel_width: 0,
                        pixel_height: 0,
                    })?;
                }
            }
            Ok(SshCommand::Disconnect) => {
                shutdown_pty_process(&mut *child, &mut master, &mut writer, Some(&reader_done_rx));
                return Ok(());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                shutdown_pty_process(&mut *child, &mut master, &mut writer, Some(&reader_done_rx));
                return Ok(());
            }
        }

        if reader_done_rx.try_recv().is_ok() {
            let status = child.wait()?;
            if status.success() {
                return Ok(());
            }

            return Err(format!("SSH process exited with code {}", status.exit_code()).into());
        }
    }
}

fn run_ssh_test_connection(
    processes: &OpenSshProcesses,
    config: ConnectionConfig,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    if connection_uses_private_key(&config) {
        run_openssh_exec_command(processes, None, &config, "true")?;
        return Ok("Connection test succeeded".to_string());
    }

    match run_ssh2_exec_command(&config, "true") {
        Ok(_) => Ok("Connection test succeeded".to_string()),
        Err(error) if should_fallback_to_openssh(&config, &*error) => {
            run_openssh_exec_command(processes, None, &config, "true")?;
            Ok("Connection test succeeded".to_string())
        }
        Err(error) => Err(error),
    }
}

fn tray_menu_text(locale: AppLocale) -> (&'static str, &'static str) {
    match locale {
        AppLocale::ZhCn => ("显示 TerSterm", "退出"),
        AppLocale::EnUs => ("Show TerSterm", "Exit"),
    }
}

fn update_tray_menu_locale(app: &AppHandle, locale: AppLocale) {
    let (show_text, quit_text) = tray_menu_text(locale);
    let tray_menu = app.state::<TrayMenuState>();
    let show_item = tray_menu
        .show_item
        .lock()
        .ok()
        .and_then(|item| item.as_ref().cloned());
    let quit_item = tray_menu
        .quit_item
        .lock()
        .ok()
        .and_then(|item| item.as_ref().cloned());

    if let Some(show_item) = show_item {
        show_item.set_text(show_text).ok();
    }

    if let Some(quit_item) = quit_item {
        quit_item.set_text(quit_text).ok();
    }
}

fn set_tray_visibility(app: &AppHandle, visible: bool) {
    if let Some(tray) = app.tray_by_id(MAIN_TRAY_ID) {
        tray.set_visible(visible).ok();
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        window.show().ok();
        window.unminimize().ok();
        window.set_focus().ok();
        set_tray_visibility(app, false);
    }
}

fn exit_application(app: AppHandle) {
    let closing = app.state::<AppClosing>();
    if closing.0.swap(true, Ordering::Relaxed) {
        return;
    }

    if let Some(window) = app.get_webview_window("main") {
        window.hide().ok();
    }

    thread::spawn(move || {
        let sessions = app.state::<SshSessions>();
        let processes = app.state::<OpenSshProcesses>();
        cancel_all_openssh_processes(&processes);
        disconnect_all_sessions(&sessions);
        #[cfg(windows)]
        terminate_descendant_processes(std::process::id());
        app.exit(0);
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .manage(SshSessions::default())
        .manage(OpenSshProcesses::default())
        .manage(SshSessionSecrets::default())
        .manage(AppClosing::default())
        .manage(WindowCloseBehaviorState::default())
        .manage(AppLocaleState::default())
        .manage(TrayMenuState::default())
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_test_connection,
            ssh_write,
            ssh_write_binary,
            ssh_resize,
            ssh_disconnect,
            ssh_list_files,
            ssh_upload_file,
            ssh_download_file,
            save_local_file,
            ssh_get_system_usage,
            set_window_close_behavior,
            set_app_locale
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle().clone();
                if app.state::<AppClosing>().0.load(Ordering::Relaxed) {
                    return;
                }

                api.prevent_close();

                if app.state::<WindowCloseBehaviorState>().get() == WindowCloseBehavior::Tray {
                    set_tray_visibility(&app, true);
                    window.hide().ok();
                    return;
                }

                exit_application(app);
            }
        })
        .setup(|app| {
            let locale = app.state::<AppLocaleState>().get();
            let (show_text, quit_text) = tray_menu_text(locale);
            let show_item = MenuItem::with_id(app, TRAY_SHOW_MENU_ID, show_text, true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, TRAY_QUIT_MENU_ID, quit_text, true, None::<&str>)?;

            let tray_menu = MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&quit_item)
                .build()?;

            let tray_menu_state = app.state::<TrayMenuState>();
            if let Ok(mut item) = tray_menu_state.show_item.lock() {
                *item = Some(show_item.clone());
            }
            if let Ok(mut item) = tray_menu_state.quit_item.lock() {
                *item = Some(quit_item.clone());
            }

            let mut tray_builder = TrayIconBuilder::with_id(MAIN_TRAY_ID)
                .menu(&tray_menu)
                .tooltip("TerSterm")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    TRAY_SHOW_MENU_ID => show_main_window(app),
                    TRAY_QUIT_MENU_ID => exit_application(app.clone()),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            ..
                        }
                    ) {
                        show_main_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }

            let tray = tray_builder.build(app)?;
            tray.set_visible(false).ok();

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

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use super::collect_descendants_from_entries;
    use super::{
        output_looks_authenticated, parse_openssh_file_list, parse_system_usage_output,
        run_openssh_exec_command, run_remote_file_list, run_remote_system_usage,
        should_fallback_to_openssh, ConnectionConfig, OpenSshProcesses,
    };
    use std::{env, io};

    #[cfg(windows)]
    #[test]
    fn collects_nested_descendants_without_including_root() {
        let entries = vec![(10, 1), (11, 10), (12, 11), (20, 1), (21, 20), (99, 0)];

        assert_eq!(
            collect_descendants_from_entries(1, &entries),
            vec![12, 11, 10, 21, 20]
        );
    }

    #[cfg(windows)]
    #[test]
    fn ignores_self_parent_and_unrelated_processes() {
        let entries = vec![(7, 7), (8, 42), (9, 8), (10, 9), (11, 99)];

        assert_eq!(
            collect_descendants_from_entries(42, &entries),
            vec![10, 9, 8]
        );
    }

    #[test]
    fn parses_noisy_openssh_file_list_output() {
        let output = concat!(
            "Welcome to Ubuntu\r\n",
            "PATH\t/root\r\n",
            "ENTRY\td\t..\t\t\r\n",
            "ENTRY\tf\trelease.log\t18432\t2026-05-11 15:09\r\n",
            "ENTRY\td\tuploads\t\t2026-05-11 15:10\r\n",
            "root@host:~# "
        );

        let list = parse_openssh_file_list(output).expect("file list should parse");

        assert_eq!(list.path, "/root");
        assert_eq!(list.entries[0].name, "..");
        assert_eq!(list.entries[0].path, "/root/..");
        assert_eq!(list.entries[1].name, "uploads");
        assert_eq!(list.entries[1].kind, "directory");
        assert_eq!(list.entries[2].name, "release.log");
        assert_eq!(list.entries[2].size, Some(18432));
    }

    #[test]
    fn parses_system_usage_output_with_login_noise() {
        let output = concat!(
            "Last login: Mon May 11 15:00:53 CST 2026\r\n",
            "CPU 12.5\r\n",
            "MEM 3.25 16.00\r\n",
            "DISK 84.00 256.00\r\n"
        );

        let usage = parse_system_usage_output(output).expect("system usage should parse");

        assert_eq!(usage.cpu_percent, 12.5);
        assert_eq!(usage.memory_used_gb, 3.25);
        assert_eq!(usage.memory_total_gb, 16.0);
        assert_eq!(usage.storage_used_gb, 84.0);
        assert_eq!(usage.storage_total_gb, 256.0);
    }

    #[test]
    fn falls_back_to_openssh_for_private_key_compatibility_errors() {
        let config = ConnectionConfig {
            name: "test".to_string(),
            host: "127.0.0.1".to_string(),
            port: 22,
            username: "root".to_string(),
            password: None,
            private_key_path: Some("C:\\Users\\me\\.ssh\\id_ed25519".to_string()),
            private_key: None,
            private_key_passphrase: None,
        };
        let error = io::Error::other("SSH private key authentication failed: invalid key format");

        assert!(should_fallback_to_openssh(&config, &error));
    }

    #[test]
    fn falls_back_to_openssh_for_password_auth_errors() {
        let config = ConnectionConfig {
            name: "test".to_string(),
            host: "127.0.0.1".to_string(),
            port: 22,
            username: "root".to_string(),
            password: Some("secret".to_string()),
            private_key_path: None,
            private_key: None,
            private_key_passphrase: None,
        };
        let error = io::Error::other("SSH password authentication failed: keyboard-interactive auth required");

        assert!(should_fallback_to_openssh(&config, &error));
    }

    #[test]
    fn detects_authenticated_output_from_shell_prompt() {
        let output = concat!(
            "\u{1b}[?2004hroot@hk-ser01:~# ",
            "\u{1b}[?2004l"
        );

        assert!(output_looks_authenticated(output));
    }

    #[test]
    #[ignore = "Requires real SSH host credentials via TERSTERM_REAL_* env vars"]
    fn probes_real_host_file_list_and_system_usage() {
        let host = env::var("TERSTERM_REAL_HOST").expect("TERSTERM_REAL_HOST is required");
        let port = env::var("TERSTERM_REAL_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(22);
        let username = env::var("TERSTERM_REAL_USERNAME").expect("TERSTERM_REAL_USERNAME is required");
        let private_key_path = env::var("TERSTERM_REAL_PRIVATE_KEY_PATH").ok();
        let private_key = env::var("TERSTERM_REAL_PRIVATE_KEY").ok();
        let private_key_passphrase = env::var("TERSTERM_REAL_PRIVATE_KEY_PASSPHRASE").ok();
        let password = env::var("TERSTERM_REAL_PASSWORD").ok();
        let config = ConnectionConfig {
            name: "real-host".to_string(),
            host,
            port,
            username,
            password,
            private_key_path,
            private_key,
            private_key_passphrase,
        };
        let processes = OpenSshProcesses::default();

        eprintln!("starting real host pwd probe");
        let pwd = run_openssh_exec_command(&processes, None, &config, "pwd")
            .expect("real host pwd probe should succeed");
        eprintln!("real host pwd probe finished: {}", pwd.trim());

        eprintln!("starting real host file list probe");
        let files = run_remote_file_list(&processes, None, config.clone(), "~".to_string())
            .expect("real host file list probe should succeed");
        eprintln!("real host file list probe finished: {} entries", files.entries.len());
        assert!(!files.path.trim().is_empty(), "real host file list path should not be empty");
        assert!(
            !files.entries.is_empty(),
            "real host file list should include at least one entry"
        );

        eprintln!("starting real host system usage probe");
        let usage = run_remote_system_usage(&processes, None, config)
            .expect("real host system usage probe should succeed");
        eprintln!("real host system usage probe finished: cpu={}", usage.cpu_percent);
        assert!(usage.cpu_percent >= 0.0, "real host cpu usage should be non-negative");
        assert!(
            usage.memory_total_gb > 0.0 && usage.storage_total_gb > 0.0,
            "real host total resource values should be positive"
        );
    }

    #[test]
    fn does_not_fallback_to_openssh_for_remote_sftp_errors() {
        let config = ConnectionConfig {
            name: "test".to_string(),
            host: "127.0.0.1".to_string(),
            port: 22,
            username: "root".to_string(),
            password: None,
            private_key_path: Some("C:\\Users\\me\\.ssh\\id_ed25519".to_string()),
            private_key: None,
            private_key_passphrase: None,
        };
        let error = io::Error::new(io::ErrorKind::PermissionDenied, "Permission denied");

        assert!(!should_fallback_to_openssh(&config, &error));
    }
}
