#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use base64::{engine::general_purpose, Engine as _};
use portable_pty::{
    native_pty_system, Child as PtyChild, CommandBuilder, MasterPty as PtyMasterPty, PtySize,
};
use serde::{Deserialize, Serialize};
use ssh2::{ExtendedData, FileStat, Session, Sftp};
use std::cmp::Ordering as VersionOrdering;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
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
            OpenProcess, TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW, PROCESS_TERMINATE,
        },
    },
};

#[cfg(windows)]
const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;

const MAIN_TRAY_ID: &str = "main-tray";
const TRAY_SHOW_MENU_ID: &str = "tray-show";
const TRAY_QUIT_MENU_ID: &str = "tray-quit";
const APP_UPDATE_DOWNLOAD_PROGRESS_EVENT: &str = "app-update-download-progress";
const SSH_FILE_DOWNLOAD_PROGRESS_EVENT: &str = "ssh-file-download-progress";
const GITHUB_RELEASES_API: &str =
    "https://api.github.com/repos/Y3y202/TerSterm/releases?per_page=20";
const GITHUB_RELEASES_ATOM: &str = "https://github.com/Y3y202/TerSterm/releases.atom";
const GITHUB_RELEASE_DOWNLOAD_PREFIX: &str =
    "https://github.com/Y3y202/TerSterm/releases/download/";
const NO_MATCHING_RELEASE_ERROR: &str = "No matching release found";
const APP_SETTINGS_FILE_NAME: &str = "app-settings.json";
const WINDOW_STATE_FILE_NAME: &str = "window-state.json";
const LARGE_DEFAULT_WINDOW_WIDTH: f64 = 1665.0;
const LARGE_DEFAULT_WINDOW_HEIGHT: f64 = 1039.0;
const COMPACT_DEFAULT_WINDOW_WIDTH: f64 = 1440.0;
const COMPACT_DEFAULT_WINDOW_HEIGHT: f64 = 900.0;
const MIN_WINDOW_WIDTH: f64 = 960.0;
const MIN_WINDOW_HEIGHT: f64 = 600.0;
const WINDOW_WORK_AREA_MARGIN: f64 = 48.0;
const OPENSSH_COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const OPENSSH_FILE_TRANSFER_TIMEOUT: Duration = Duration::from_secs(600);

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
struct RemoteFilePermissions {
    path: String,
    name: String,
    kind: String,
    mode: String,
    owner: String,
}

#[derive(Debug, Serialize)]
struct SystemUsage {
    cpu_percent: f32,
    memory_used_gb: f32,
    memory_total_gb: f32,
    storage_used_gb: f32,
    storage_total_gb: f32,
    latency_ms: u64,
    host_platform: Option<String>,
    linux_distro: Option<String>,
}

#[derive(Debug, Serialize)]
struct AppUpdateAsset {
    name: String,
    download_url: String,
    size_bytes: u64,
}

#[derive(Debug, Serialize)]
struct AppUpdateInfo {
    current_version: String,
    latest_version: String,
    release_name: String,
    release_tag: String,
    release_url: String,
    published_at: Option<String>,
    prerelease: bool,
    download_asset: Option<AppUpdateAsset>,
    update_available: bool,
}

#[derive(Debug, Serialize, Clone)]
struct AppUpdateDownloadProgress {
    status: String,
    filename: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: f32,
}

#[derive(Debug, Deserialize, Clone)]
enum AiProvider {
    #[serde(rename = "openai-compatible", alias = "open-ai-compatible")]
    OpenAiCompatible,
    #[serde(rename = "anthropic")]
    Anthropic,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
enum AiAssistantTerminalPermission {
    ReplyOnly,
    TypeOnly,
    Execute,
}

#[derive(Debug, Deserialize, Clone)]
struct AiAssistantSettingsRequest {
    provider: AiProvider,
    base_url: String,
    api_key: String,
    model: String,
    system_prompt: String,
    terminal_permission: AiAssistantTerminalPermission,
}

#[derive(Debug, Deserialize, Clone)]
struct AiAssistantMessageInput {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize, Clone)]
struct AiAssistantContext {
    connection_name: Option<String>,
    host: Option<String>,
    username: Option<String>,
    host_platform: Option<String>,
    linux_distro: Option<String>,
    current_directory: Option<String>,
    visible_terminal_output: Option<String>,
    recent_terminal_output: Option<String>,
    pending_terminal_input: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
struct SshFileDownloadProgress {
    session_id: Option<String>,
    remote_path: String,
    local_path: String,
    filename: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: f32,
}

#[derive(Debug, Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    state: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    published_at: Option<String>,
    draft: bool,
    prerelease: bool,
    assets: Vec<GithubReleaseAsset>,
}

#[derive(Debug, Clone)]
struct GithubFeedRelease {
    tag_name: String,
    title: String,
    html_url: String,
    published_at: Option<String>,
    prerelease: bool,
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

#[derive(Default)]
struct MainWindowStateReady(AtomicBool);

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

    fn as_value(self) -> &'static str {
        match self {
            Self::Tray => "tray",
            Self::Exit => "exit",
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

    fn as_value(self) -> &'static str {
        match self {
            Self::ZhCn => "zh-CN",
            Self::EnUs => "en-US",
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedAppSettings {
    window_close_behavior: String,
    locale: String,
}

impl Default for PersistedAppSettings {
    fn default() -> Self {
        Self {
            window_close_behavior: WindowCloseBehavior::default().as_value().to_string(),
            locale: AppLocale::default().as_value().to_string(),
        }
    }
}

impl PersistedAppSettings {
    fn sanitized(self) -> Self {
        Self {
            window_close_behavior: WindowCloseBehavior::from_value(&self.window_close_behavior)
                .as_value()
                .to_string(),
            locale: AppLocale::from_value(&self.locale).as_value().to_string(),
        }
    }

    fn window_close_behavior(&self) -> WindowCloseBehavior {
        WindowCloseBehavior::from_value(&self.window_close_behavior)
    }

    fn locale(&self) -> AppLocale {
        AppLocale::from_value(&self.locale)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
struct PersistedWindowState {
    width: f64,
    height: f64,
    maximized: bool,
}

impl Default for PersistedWindowState {
    fn default() -> Self {
        Self {
            width: LARGE_DEFAULT_WINDOW_WIDTH,
            height: LARGE_DEFAULT_WINDOW_HEIGHT,
            maximized: false,
        }
    }
}

impl PersistedWindowState {
    fn sanitized(self, fallback: PersistedWindowState) -> Self {
        Self {
            width: sanitize_window_dimension(self.width, fallback.width),
            height: sanitize_window_dimension(self.height, fallback.height),
            maximized: self.maximized,
        }
    }
}

#[derive(Default)]
struct PersistedMainWindowState(Mutex<PersistedWindowState>);

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

fn sanitize_window_dimension(value: f64, fallback: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        fallback
    }
}

fn merge_window_state(
    current: PersistedWindowState,
    width: f64,
    height: f64,
    maximized: bool,
) -> PersistedWindowState {
    let mut next = current;
    if !maximized {
        next.width = sanitize_window_dimension(width, current.width);
        next.height = sanitize_window_dimension(height, current.height);
    }
    next.maximized = maximized;
    next.sanitized(current)
}

fn logical_monitor_sizes(window: &tauri::WebviewWindow) -> Option<(u32, u32, f64, f64)> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let monitor = monitor?;

    let scale_factor = monitor.scale_factor();
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return None;
    }

    let screen_size = monitor.size();
    let work_area = monitor.work_area();
    let work_width = f64::from(work_area.size.width) / scale_factor;
    let work_height = f64::from(work_area.size.height) / scale_factor;
    Some((screen_size.width, screen_size.height, work_width, work_height))
}

fn clamp_window_state_to_display(
    state: PersistedWindowState,
    window: &tauri::WebviewWindow,
) -> PersistedWindowState {
    let Some((_, _, work_width, work_height)) = logical_monitor_sizes(window) else {
        return state;
    };

    if work_width <= MIN_WINDOW_WIDTH || work_height <= MIN_WINDOW_HEIGHT {
        return state;
    }

    clamp_window_state_to_work_area(state, work_width, work_height)
}

fn clamp_window_state_to_work_area(
    state: PersistedWindowState,
    work_width: f64,
    work_height: f64,
) -> PersistedWindowState {
    if work_width <= MIN_WINDOW_WIDTH || work_height <= MIN_WINDOW_HEIGHT {
        return state;
    }

    let available_width = (work_width - WINDOW_WORK_AREA_MARGIN).max(MIN_WINDOW_WIDTH);
    let available_height = (work_height - WINDOW_WORK_AREA_MARGIN).max(MIN_WINDOW_HEIGHT);

    PersistedWindowState {
        width: state.width.min(available_width),
        height: state.height.min(available_height),
        maximized: state.maximized,
    }
}

fn responsive_default_window_state_for_display(
    screen_width: u32,
    screen_height: u32,
    work_width: f64,
    work_height: f64,
) -> PersistedWindowState {
    let has_large_physical_screen = screen_width >= 2_400 && screen_height >= 1_300;
    let preferred_width = if has_large_physical_screen {
        LARGE_DEFAULT_WINDOW_WIDTH
    } else {
        COMPACT_DEFAULT_WINDOW_WIDTH
    };
    let preferred_height = if has_large_physical_screen {
        LARGE_DEFAULT_WINDOW_HEIGHT
    } else {
        COMPACT_DEFAULT_WINDOW_HEIGHT
    };

    clamp_window_state_to_work_area(
        PersistedWindowState {
            width: preferred_width,
            height: preferred_height,
            maximized: false,
        },
        work_width,
        work_height,
    )
}

fn responsive_default_window_state(window: &tauri::WebviewWindow) -> PersistedWindowState {
    let fallback = PersistedWindowState::default();
    let Some((screen_width, screen_height, work_width, work_height)) = logical_monitor_sizes(window)
    else {
        return fallback;
    };

    if work_width <= MIN_WINDOW_WIDTH || work_height <= MIN_WINDOW_HEIGHT {
        return fallback;
    }

    responsive_default_window_state_for_display(
        screen_width,
        screen_height,
        work_width,
        work_height,
    )
}

fn window_state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(WINDOW_STATE_FILE_NAME))
}

fn app_settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(APP_SETTINGS_FILE_NAME))
}

fn read_persisted_app_settings(app: &AppHandle) -> Option<PersistedAppSettings> {
    let path = app_settings_path(app)?;
    let contents = fs::read_to_string(path).ok()?;
    let settings = serde_json::from_str::<PersistedAppSettings>(&contents).ok()?;
    Some(settings.sanitized())
}

fn write_persisted_app_settings(app: &AppHandle, settings: PersistedAppSettings) {
    let Some(path) = app_settings_path(app) else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    let Ok(contents) = serde_json::to_vec(&settings.sanitized()) else {
        return;
    };

    if fs::create_dir_all(parent).is_err() {
        return;
    }

    fs::write(path, contents).ok();
}

fn read_persisted_window_state(
    app: &AppHandle,
    fallback: PersistedWindowState,
) -> Option<PersistedWindowState> {
    let path = window_state_path(app)?;
    let contents = fs::read_to_string(path).ok()?;
    let state = serde_json::from_str::<PersistedWindowState>(&contents).ok()?;
    Some(state.sanitized(fallback))
}

fn write_persisted_window_state(app: &AppHandle, state: PersistedWindowState) {
    let Some(path) = window_state_path(app) else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    let Ok(contents) = serde_json::to_vec(&state.sanitized(PersistedWindowState::default()))
    else {
        return;
    };

    if fs::create_dir_all(parent).is_err() {
        return;
    }

    fs::write(path, contents).ok();
}

fn apply_persisted_window_state(window: &tauri::WebviewWindow, state: PersistedWindowState) {
    window
        .set_size(tauri::Size::Logical(tauri::LogicalSize::new(
            state.width,
            state.height,
        )))
        .ok();

    if state.maximized {
        window.maximize().ok();
    } else {
        window.center().ok();
    }
}

fn persist_main_window_state(window: &tauri::WebviewWindow) {
    let Ok(scale_factor) = window.scale_factor() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    let Ok(maximized) = window.is_maximized() else {
        return;
    };
    let logical_size = size.to_logical::<f64>(scale_factor);
    let app = window.app_handle();
    let next_state = {
        let state = app.state::<PersistedMainWindowState>();
        let Ok(mut store) = state.0.lock() else {
            return;
        };
        let next = merge_window_state(*store, logical_size.width, logical_size.height, maximized);
        if *store == next {
            return;
        }
        *store = next;
        next
    };

    write_persisted_window_state(&app, next_state);
}

fn initialize_main_window_state(window: &tauri::WebviewWindow) {
    let app = window.app_handle();
    let default_state = responsive_default_window_state(window);
    let state = clamp_window_state_to_display(
        read_persisted_window_state(&app, default_state).unwrap_or(default_state),
        window,
    );

    if let Ok(mut store) = app.state::<PersistedMainWindowState>().0.lock() {
        *store = state;
    }

    apply_persisted_window_state(window, state);

    if !state.maximized {
        persist_main_window_state(window);
    }
}

fn initialize_persisted_app_settings(app: &AppHandle) {
    let settings = read_persisted_app_settings(app).unwrap_or_default().sanitized();
    let close_behavior = settings.window_close_behavior();
    let locale = settings.locale();

    app.state::<WindowCloseBehaviorState>().set(close_behavior);
    app.state::<AppLocaleState>().set(locale);
    write_persisted_app_settings(app, settings);
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

    if config
        .password
        .as_deref()
        .is_none_or(|value| value.trim().is_empty())
    {
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

    let (tx, rx) = mpsc::channel::<SshCommand>();
    let (done_tx, done_rx) = mpsc::channel::<()>();
    {
        let mut store = sessions
            .0
            .lock()
            .map_err(|_| "SSH session store is unavailable".to_string())?;
        if store.contains_key(&session_id) {
            return Err("SSH session id is already active".into());
        }

        store.insert(
            session_id.clone(),
            SessionEntry {
                sender: tx,
                done: done_rx,
            },
        );
    }

    clear_session_openssh_cancellation(&app.state::<OpenSshProcesses>(), &session_id);
    forget_session_auth_secrets(&app.state::<SshSessionSecrets>(), &session_id);

    let thread_session_id = session_id.clone();
    thread::spawn(move || {
        let disconnect_reason = run_ssh_session(app.clone(), thread_session_id.clone(), config, rx)
            .err()
            .map(|error| error.to_string());

        if let Ok(mut store) = app.state::<SshSessions>().0.lock() {
            store.remove(&thread_session_id);
        }

        forget_session_auth_secrets(&app.state::<SshSessionSecrets>(), &thread_session_id);
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
    app: AppHandle,
    close_behavior: State<'_, WindowCloseBehaviorState>,
    locale_state: State<'_, AppLocaleState>,
    behavior: String,
) {
    let next_behavior = WindowCloseBehavior::from_value(&behavior);
    close_behavior.set(next_behavior);
    write_persisted_app_settings(
        &app,
        PersistedAppSettings {
            window_close_behavior: next_behavior.as_value().to_string(),
            locale: locale_state.get().as_value().to_string(),
        },
    );
}

#[tauri::command]
fn set_app_locale(
    app: AppHandle,
    locale_state: State<'_, AppLocaleState>,
    close_behavior: State<'_, WindowCloseBehaviorState>,
    locale: String,
) {
    let next_locale = AppLocale::from_value(&locale);
    locale_state.set(next_locale);
    update_tray_menu_locale(&app, next_locale);
    write_persisted_app_settings(
        &app,
        PersistedAppSettings {
            window_close_behavior: close_behavior.get().as_value().to_string(),
            locale: next_locale.as_value().to_string(),
        },
    );
}

#[tauri::command]
async fn ai_chat(
    settings: AiAssistantSettingsRequest,
    messages: Vec<AiAssistantMessageInput>,
    context: Option<AiAssistantContext>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_ai_chat(settings, messages, context))
        .await
        .map_err(|error| error.to_string())?
        .map_err(format_boxed_error)
}

#[tauri::command]
async fn check_app_update(allow_prerelease: bool) -> Result<AppUpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || run_check_app_update(allow_prerelease))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format_boxed_error(error))
}

#[tauri::command]
async fn download_app_update(
    app: AppHandle,
    download_url: String,
    filename: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_download_app_update(&app, &download_url, &filename)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| format_boxed_error(error))
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
    let session_auth_secrets =
        get_session_auth_secrets(&app.state::<SshSessionSecrets>(), session_id.as_deref());
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
async fn ssh_create_directory(
    app: AppHandle,
    mut config: ConnectionConfig,
    remote_path: String,
    name: String,
    session_id: Option<String>,
) -> Result<String, String> {
    validate_connection_config(&config)?;
    let session_auth_secrets =
        get_session_auth_secrets(&app.state::<SshSessionSecrets>(), session_id.as_deref());
    apply_session_auth_secrets(&mut config, session_auth_secrets);

    tauri::async_runtime::spawn_blocking(move || {
        let processes = app.state::<OpenSshProcesses>();
        run_remote_create_directory(&processes, session_id.as_deref(), config, remote_path, name)
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
    let session_auth_secrets =
        get_session_auth_secrets(&app.state::<SshSessionSecrets>(), session_id.as_deref());
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
async fn ssh_delete_path(
    app: AppHandle,
    mut config: ConnectionConfig,
    remote_path: String,
    recursive: Option<bool>,
    session_id: Option<String>,
) -> Result<(), String> {
    validate_connection_config(&config)?;
    let session_auth_secrets =
        get_session_auth_secrets(&app.state::<SshSessionSecrets>(), session_id.as_deref());
    apply_session_auth_secrets(&mut config, session_auth_secrets);

    tauri::async_runtime::spawn_blocking(move || {
        let processes = app.state::<OpenSshProcesses>();
        run_remote_delete_path(
            &processes,
            session_id.as_deref(),
            config,
            remote_path,
            recursive.unwrap_or(true),
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
    local_dir: Option<String>,
    expected_size: Option<u64>,
) -> Result<String, String> {
    validate_connection_config(&config)?;
    let session_auth_secrets =
        get_session_auth_secrets(&app.state::<SshSessionSecrets>(), session_id.as_deref());
    apply_session_auth_secrets(&mut config, session_auth_secrets);

    tauri::async_runtime::spawn_blocking(move || {
        let processes = app.state::<OpenSshProcesses>();
        run_remote_file_download(
            &app,
            &processes,
            session_id.as_deref(),
            config,
            remote_path,
            local_dir,
            expected_size,
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn ssh_get_file_permissions(
    app: AppHandle,
    mut config: ConnectionConfig,
    remote_path: String,
    session_id: Option<String>,
) -> Result<RemoteFilePermissions, String> {
    validate_connection_config(&config)?;
    let session_auth_secrets =
        get_session_auth_secrets(&app.state::<SshSessionSecrets>(), session_id.as_deref());
    apply_session_auth_secrets(&mut config, session_auth_secrets);

    tauri::async_runtime::spawn_blocking(move || {
        let processes = app.state::<OpenSshProcesses>();
        run_remote_get_file_permissions(&processes, session_id.as_deref(), config, remote_path)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn ssh_set_file_permissions(
    app: AppHandle,
    mut config: ConnectionConfig,
    remote_path: String,
    mode: String,
    owner: Option<String>,
    recursive: Option<bool>,
    session_id: Option<String>,
) -> Result<(), String> {
    validate_connection_config(&config)?;
    let session_auth_secrets =
        get_session_auth_secrets(&app.state::<SshSessionSecrets>(), session_id.as_deref());
    apply_session_auth_secrets(&mut config, session_auth_secrets);

    tauri::async_runtime::spawn_blocking(move || {
        let processes = app.state::<OpenSshProcesses>();
        run_remote_set_file_permissions(
            &processes,
            session_id.as_deref(),
            config,
            remote_path,
            mode,
            owner,
            recursive.unwrap_or(false),
        )
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
    let session_auth_secrets =
        get_session_auth_secrets(&app.state::<SshSessionSecrets>(), session_id.as_deref());
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
async fn ssh_ping(config: ConnectionConfig) -> Result<u64, String> {
    validate_connection_config(&config)?;

    tauri::async_runtime::spawn_blocking(move || Ok::<u64, String>(run_ssh_ping(&config)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn save_local_file(
    app: AppHandle,
    filename: String,
    content_base64: String,
    local_dir: Option<String>,
) -> Result<String, String> {
    let bytes = general_purpose::STANDARD
        .decode(content_base64)
        .map_err(|error| error.to_string())?;
    let downloads = resolve_local_download_directory(&app, local_dir.as_deref())
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&downloads).map_err(|error| error.to_string())?;
    let local_path = unique_local_path(&downloads, &filename);
    fs::write(&local_path, bytes).map_err(|error| error.to_string())?;
    Ok(local_path.to_string_lossy().to_string())
}

#[tauri::command]
fn pick_local_directory(initial_dir: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(path) = initial_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        dialog = dialog.set_directory(expand_local_directory_path(path));
    }

    Ok(dialog
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string()))
}

fn github_client(
    timeout: Option<Duration>,
) -> Result<reqwest::blocking::Client, Box<dyn std::error::Error + Send + Sync>> {
    let mut builder = reqwest::blocking::Client::builder()
        .user_agent(format!("TerSterm/{}", env!("CARGO_PKG_VERSION")));

    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }

    Ok(builder.build()?)
}

fn format_error_chain(error: &(dyn std::error::Error + 'static)) -> String {
    let mut message = error.to_string();
    let mut source = error.source();

    while let Some(next) = source {
        let source_message = next.to_string();
        if !source_message.is_empty() && !message.contains(&source_message) {
            message.push_str(": ");
            message.push_str(&source_message);
        }
        source = next.source();
    }

    message
}

fn format_boxed_error(error: Box<dyn std::error::Error + Send + Sync>) -> String {
    format_error_chain(error.as_ref())
}

fn normalize_openai_compatible_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return "https://api.openai.com/v1/chat/completions".to_string();
    }
    if trimmed.ends_with("/chat/completions") {
        return trimmed.to_string();
    }
    if trimmed.ends_with("/chat") {
        return format!("{trimmed}/completions");
    }
    format!("{trimmed}/chat/completions")
}

fn normalize_anthropic_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return "https://api.anthropic.com/v1/messages".to_string();
    }
    if let Ok(url) = reqwest::Url::parse(trimmed) {
        let path = url.path().trim_end_matches('/').to_string();
        if path.is_empty() || path == "/" {
            let mut normalized = url;
            normalized.set_path("/v1/messages");
            return normalized.to_string();
        }
        if path.ends_with("/anthropic") {
            let mut normalized = url;
            normalized.set_path(&format!("{path}/v1/messages"));
            return normalized.to_string();
        }
        if path == "/v1" {
            let mut normalized = url;
            normalized.set_path("/v1/messages");
            return normalized.to_string();
        }
    }
    if trimmed.ends_with("/messages") {
        return trimmed.to_string();
    }
    format!("{trimmed}/messages")
}

fn extract_api_error_message(body: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(body).ok()?;
    if let Some(message) = value.get("message").and_then(|value| value.as_str()) {
        return Some(message.to_string());
    }
    value
        .get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(|value| value.as_str())
                .or_else(|| error.as_str())
        })
        .map(str::to_string)
}

fn extract_openai_message_text(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
    {
        return Some(text.to_string());
    }

    let parts = value
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_array())?;

    let combined = parts
        .iter()
        .filter_map(|part| {
            part.get("text")
                .and_then(|text| text.as_str())
                .or_else(|| part.get("content").and_then(|text| text.as_str()))
        })
        .collect::<Vec<_>>()
        .join("");

    (!combined.trim().is_empty()).then_some(combined)
}

fn extract_anthropic_message_text(value: &serde_json::Value) -> Option<String> {
    let parts = value.get("content")?.as_array()?;
    let combined = parts
        .iter()
        .filter(|part| part.get("type").and_then(|kind| kind.as_str()) == Some("text"))
        .filter_map(|part| part.get("text").and_then(|text| text.as_str()))
        .collect::<Vec<_>>()
        .join("");

    (!combined.trim().is_empty()).then_some(combined)
}

fn sanitize_ai_messages(messages: Vec<AiAssistantMessageInput>) -> Vec<AiAssistantMessageInput> {
    messages
        .into_iter()
        .filter_map(|message| {
            let role = message.role.trim().to_lowercase();
            let content = message.content.trim().to_string();
            if content.is_empty() || (role != "user" && role != "assistant") {
                return None;
            }
            Some(AiAssistantMessageInput { role, content })
        })
        .collect()
}

fn build_ai_system_prompt(
    custom_prompt: &str,
    context: Option<&AiAssistantContext>,
    terminal_permission: AiAssistantTerminalPermission,
) -> String {
    let base_prompt = if custom_prompt.trim().is_empty() {
        "你是 TerSterm AI 助手。协助处理 Linux 和 Windows 服务器运维、SSH 故障排查、部署、日志分析、文件管理、权限配置、网络问题及 Shell 使用。回答应简洁、实用且准确。"
            .to_string()
    } else {
        custom_prompt.trim().to_string()
    };

    let mut lines = vec![base_prompt];

    match terminal_permission {
        AiAssistantTerminalPermission::ReplyOnly => {
            lines.push(String::new());
            lines.push("Terminal permission: reply only.".to_string());
            lines.push("Do not emit <tersterm-command> tags or any runnable terminal actions. If the user asks for commands, provide them as plain text for manual review.".to_string());
        }
        AiAssistantTerminalPermission::TypeOnly => {
            lines.push(String::new());
            lines.push("Terminal action format:".to_string());
            lines.push("When and only when the user explicitly asks you to type something into the current terminal, append one or more terminal action tags using this exact format:".to_string());
            lines.push(r#"<tersterm-command execute="false" delay_ms="35">"#.to_string());
            lines.push("command text here".to_string());
            lines.push("</tersterm-command>".to_string());
            lines.push("Rules: keep explanations outside the tag; prefer safe read-only commands unless the user clearly requests a mutating action; always use execute=\"false\" so the user can review the typed command before running it.".to_string());
        }
        AiAssistantTerminalPermission::Execute => {
            lines.push(String::new());
            lines.push("Terminal action format:".to_string());
            lines.push("When and only when the user explicitly asks you to type or run something in the current terminal, append one or more terminal action tags using this exact format:".to_string());
            lines.push(r#"<tersterm-command execute="true" delay_ms="35">"#.to_string());
            lines.push("command text here".to_string());
            lines.push("</tersterm-command>".to_string());
            lines.push("Rules: keep explanations outside the tag; prefer safe read-only commands unless the user clearly requests a mutating action; execute=\"true\" means TerSterm will progressively type the command into the current terminal and press Enter; execute=\"false\" means type without pressing Enter.".to_string());
        }
    }

    let Some(context) = context else {
        return lines.join("\n");
    };

    lines.push(String::new());
    lines.push("Current session context:".to_string());

    if let Some(value) = context.connection_name.as_deref().filter(|value| !value.trim().is_empty())
    {
        lines.push(format!("- Connection: {value}"));
    }
    if let Some(value) = context.host.as_deref().filter(|value| !value.trim().is_empty()) {
        lines.push(format!("- Host: {value}"));
    }
    if let Some(value) = context.username.as_deref().filter(|value| !value.trim().is_empty()) {
        lines.push(format!("- Username: {value}"));
    }
    if let Some(value) = context
        .host_platform
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        lines.push(format!("- Platform: {value}"));
    }
    if let Some(value) = context
        .linux_distro
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        lines.push(format!("- Distro: {value}"));
    }
    if let Some(value) = context
        .current_directory
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        lines.push(format!("- Current directory: {value}"));
    }
    if let Some(value) = context
        .visible_terminal_output
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        lines.push("- Current visible terminal content:".to_string());
        lines.push(value.to_string());
    }
    if let Some(value) = context
        .recent_terminal_output
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        lines.push("- Recent terminal output:".to_string());
        lines.push(value.to_string());
    }
    if let Some(value) = context
        .pending_terminal_input
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        lines.push(format!("- Current pending terminal input: {value}"));
    }

    lines.join("\n")
}

fn run_openai_compatible_ai_chat(
    client: &reqwest::blocking::Client,
    settings: &AiAssistantSettingsRequest,
    messages: &[AiAssistantMessageInput],
    context: Option<&AiAssistantContext>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let endpoint = normalize_openai_compatible_endpoint(&settings.base_url);
    let mut request_messages = vec![serde_json::json!({
        "role": "system",
        "content": build_ai_system_prompt(
            &settings.system_prompt,
            context,
            settings.terminal_permission,
        ),
    })];
    request_messages.extend(messages.iter().map(|message| {
        serde_json::json!({
            "role": message.role,
            "content": message.content,
        })
    }));

    let response = client
        .post(endpoint)
        .bearer_auth(settings.api_key.trim())
        .json(&serde_json::json!({
            "model": settings.model.trim(),
            "messages": request_messages,
            "temperature": 0.3
        }))
        .send()?;

    let status = response.status();
    let body = response.text()?;
    if !status.is_success() {
        let message = extract_api_error_message(&body).unwrap_or(body);
        return Err(format!("AI request failed ({status}): {message}").into());
    }

    let value = serde_json::from_str::<serde_json::Value>(&body)?;
    extract_openai_message_text(&value)
        .ok_or_else(|| "AI service returned an empty response".into())
}

fn run_anthropic_ai_chat(
    client: &reqwest::blocking::Client,
    settings: &AiAssistantSettingsRequest,
    messages: &[AiAssistantMessageInput],
    context: Option<&AiAssistantContext>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let endpoint = normalize_anthropic_endpoint(&settings.base_url);
    let request_messages = messages
        .iter()
        .map(|message| {
            serde_json::json!({
                "role": message.role,
                "content": message.content,
            })
        })
        .collect::<Vec<_>>();

    let response = client
        .post(endpoint)
        .header("x-api-key", settings.api_key.trim())
        .header("anthropic-version", "2023-06-01")
        .json(&serde_json::json!({
            "model": settings.model.trim(),
            "system": build_ai_system_prompt(
                &settings.system_prompt,
                context,
                settings.terminal_permission,
            ),
            "messages": request_messages,
            "max_tokens": 1024,
            "temperature": 0.3
        }))
        .send()?;

    let status = response.status();
    let body = response.text()?;
    if !status.is_success() {
        let message = extract_api_error_message(&body).unwrap_or(body);
        return Err(format!("AI request failed ({status}): {message}").into());
    }

    let value = serde_json::from_str::<serde_json::Value>(&body)?;
    extract_anthropic_message_text(&value)
        .ok_or_else(|| "AI service returned an empty response".into())
}

fn run_ai_chat(
    settings: AiAssistantSettingsRequest,
    messages: Vec<AiAssistantMessageInput>,
    context: Option<AiAssistantContext>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    if settings.api_key.trim().is_empty() {
        return Err("API key is required".into());
    }
    if settings.model.trim().is_empty() {
        return Err("Model is required".into());
    }

    let messages = sanitize_ai_messages(messages);
    if messages.is_empty() || messages.iter().all(|message| message.role != "user") {
        return Err("At least one user message is required".into());
    }

    let client = github_client(Some(Duration::from_secs(90)))?;

    match settings.provider {
        AiProvider::OpenAiCompatible => {
            run_openai_compatible_ai_chat(&client, &settings, &messages, context.as_ref())
        }
        AiProvider::Anthropic => {
            run_anthropic_ai_chat(&client, &settings, &messages, context.as_ref())
        }
    }
}

fn emit_app_update_download_progress(
    app: &AppHandle,
    status: &str,
    filename: Option<&str>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
) {
    let percent = total_bytes
        .filter(|value| *value > 0)
        .map(|value| (downloaded_bytes as f32 / value as f32 * 100.0).clamp(0.0, 100.0))
        .unwrap_or(0.0);

    app.emit(
        APP_UPDATE_DOWNLOAD_PROGRESS_EVENT,
        AppUpdateDownloadProgress {
            status: status.to_string(),
            filename: filename.map(|value| value.to_string()),
            downloaded_bytes,
            total_bytes,
            percent,
        },
    )
    .ok();
}

fn emit_ssh_file_download_progress(
    app: &AppHandle,
    session_id: Option<&str>,
    remote_path: &str,
    local_path: &Path,
    filename: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
) {
    let total_bytes = total_bytes.filter(|value| *value > 0);
    let percent = total_bytes
        .map(|value| (downloaded_bytes as f32 / value as f32 * 100.0).clamp(0.0, 100.0))
        .unwrap_or(0.0);

    app.emit(
        SSH_FILE_DOWNLOAD_PROGRESS_EVENT,
        SshFileDownloadProgress {
            session_id: session_id.map(|value| value.to_string()),
            remote_path: remote_path.to_string(),
            local_path: local_path.to_string_lossy().to_string(),
            filename: filename.to_string(),
            downloaded_bytes,
            total_bytes,
            percent,
        },
    )
    .ok();
}

fn normalize_release_version(value: &str) -> String {
    value
        .trim()
        .trim_start_matches(|ch| ch == 'v' || ch == 'V')
        .to_string()
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn extract_text_between<'a>(value: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let start_index = value.find(start)? + start.len();
    let remaining = &value[start_index..];
    let end_index = remaining.find(end)?;
    Some(&remaining[..end_index])
}

fn extract_entry_xml_text(entry: &str, tag: &str) -> Option<String> {
    let start = format!("<{tag}>");
    let end = format!("</{tag}>");
    extract_text_between(entry, &start, &end).map(xml_unescape)
}

fn extract_release_link(entry: &str) -> Option<String> {
    entry
        .split("<link")
        .find(|segment| segment.contains("/releases/tag/"))
        .and_then(|segment| extract_text_between(segment, "href=\"", "\""))
        .map(xml_unescape)
}

fn parse_github_releases_feed(feed: &str) -> Vec<GithubFeedRelease> {
    feed.split("<entry>")
        .skip(1)
        .filter_map(|entry| {
            let entry = entry.split("</entry>").next()?;
            let html_url = extract_release_link(entry)?;
            let tag_name = html_url.rsplit('/').next()?.trim().to_string();
            if tag_name.is_empty() {
                return None;
            }

            let title = extract_entry_xml_text(entry, "title").unwrap_or_else(|| tag_name.clone());
            let published_at = extract_entry_xml_text(entry, "updated");
            let prerelease = normalize_release_version(&tag_name).contains('-');

            Some(GithubFeedRelease {
                tag_name,
                title,
                html_url,
                published_at,
                prerelease,
            })
        })
        .collect()
}

fn select_feed_release(
    releases: Vec<GithubFeedRelease>,
    allow_prerelease: bool,
) -> Option<GithubFeedRelease> {
    releases
        .into_iter()
        .find(|release| allow_prerelease || !release.prerelease)
}

fn compare_release_versions(left: &str, right: &str) -> VersionOrdering {
    let left = normalize_release_version(left);
    let right = normalize_release_version(right);
    let left_prerelease = left.contains('-');
    let right_prerelease = right.contains('-');
    let left_parts = left
        .split(['-', '+'])
        .next()
        .unwrap_or(&left)
        .split('.')
        .map(|value| value.parse::<u32>().unwrap_or(0))
        .collect::<Vec<_>>();
    let right_parts = right
        .split(['-', '+'])
        .next()
        .unwrap_or(&right)
        .split('.')
        .map(|value| value.parse::<u32>().unwrap_or(0))
        .collect::<Vec<_>>();
    let part_count = left_parts.len().max(right_parts.len());

    for index in 0..part_count {
        let left_value = left_parts.get(index).copied().unwrap_or(0);
        let right_value = right_parts.get(index).copied().unwrap_or(0);
        match left_value.cmp(&right_value) {
            VersionOrdering::Equal => continue,
            ordering => return ordering,
        }
    }

    match (left_prerelease, right_prerelease) {
        (true, false) => VersionOrdering::Less,
        (false, true) => VersionOrdering::Greater,
        _ => VersionOrdering::Equal,
    }
}

fn release_asset_priority(name: &str) -> Option<u16> {
    let lower = name.to_ascii_lowercase();

    #[cfg(target_os = "windows")]
    let base = if lower.ends_with(".msi") {
        Some(400)
    } else if lower.ends_with(".exe") {
        Some(320)
    } else if lower.ends_with(".zip") {
        Some(240)
    } else {
        None
    };

    #[cfg(target_os = "macos")]
    let base = if lower.ends_with(".dmg") {
        Some(400)
    } else if lower.ends_with(".app.tar.gz") {
        Some(320)
    } else if lower.ends_with(".zip") {
        Some(240)
    } else {
        None
    };

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let base = if lower.ends_with(".appimage") {
        Some(400)
    } else if lower.ends_with(".deb") {
        Some(360)
    } else if lower.ends_with(".rpm") {
        Some(320)
    } else if lower.ends_with(".tar.gz") {
        Some(240)
    } else {
        None
    };

    base.map(|value| {
        let mut score = value;
        if lower.contains("tersterm") {
            score += 10;
        }
        if lower.contains("x64") || lower.contains("x86_64") || lower.contains("amd64") {
            score += 6;
        }
        if lower.contains("setup") || lower.contains("installer") {
            score += 4;
        }
        score
    })
}

fn preferred_release_asset(assets: &[GithubReleaseAsset]) -> Option<AppUpdateAsset> {
    assets
        .iter()
        .filter(|asset| asset.state.as_deref().unwrap_or("uploaded") == "uploaded")
        .filter_map(|asset| release_asset_priority(&asset.name).map(|priority| (priority, asset)))
        .max_by_key(|(priority, asset)| (*priority, asset.size))
        .map(|(_, asset)| AppUpdateAsset {
            name: asset.name.clone(),
            download_url: asset.browser_download_url.clone(),
            size_bytes: asset.size,
        })
}

fn select_release(releases: Vec<GithubRelease>, allow_prerelease: bool) -> Option<GithubRelease> {
    releases
        .into_iter()
        .find(|release| !release.draft && (allow_prerelease || !release.prerelease))
}

fn release_asset_download_url(tag_name: &str, file_name: &str) -> String {
    format!("{GITHUB_RELEASE_DOWNLOAD_PREFIX}{tag_name}/{file_name}")
}

#[cfg(target_arch = "x86_64")]
fn current_arch_aliases() -> &'static [&'static str] {
    &["x64", "x86_64", "amd64"]
}

#[cfg(target_arch = "aarch64")]
fn current_arch_aliases() -> &'static [&'static str] {
    &["aarch64", "arm64"]
}

#[cfg(target_arch = "x86")]
fn current_arch_aliases() -> &'static [&'static str] {
    &["x86", "i686", "ia32"]
}

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64", target_arch = "x86")))]
fn current_arch_aliases() -> &'static [&'static str] {
    &[std::env::consts::ARCH]
}

fn release_asset_name_candidates(version: &str) -> Vec<String> {
    let version = normalize_release_version(version);
    let mut candidates = Vec::new();

    #[cfg(target_os = "windows")]
    for arch in current_arch_aliases() {
        candidates.push(format!("TerSterm_{version}_{arch}-setup.exe"));
        candidates.push(format!("TerSterm_{version}_{arch}.msi"));
        candidates.push(format!("TerSterm_{version}_{arch}.zip"));
    }

    #[cfg(target_os = "macos")]
    for arch in current_arch_aliases() {
        candidates.push(format!("TerSterm_{version}_{arch}.dmg"));
        candidates.push(format!("TerSterm_{version}_{arch}.app.tar.gz"));
        candidates.push(format!("TerSterm_{version}_{arch}.zip"));
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    for arch in current_arch_aliases() {
        candidates.push(format!("TerSterm_{version}_{arch}.AppImage"));
        candidates.push(format!("tersterm_{version}_{arch}.deb"));
        candidates.push(format!("TerSterm_{version}_{arch}.rpm"));
        candidates.push(format!("TerSterm_{version}_{arch}.tar.gz"));
    }

    candidates
}

fn detect_release_asset_from_public_release(
    client: &reqwest::blocking::Client,
    tag_name: &str,
) -> Result<Option<AppUpdateAsset>, Box<dyn std::error::Error + Send + Sync>> {
    for candidate in release_asset_name_candidates(tag_name) {
        let download_url = release_asset_download_url(tag_name, &candidate);
        let response = client.head(&download_url).send()?;
        if response.status().is_success() {
            return Ok(Some(AppUpdateAsset {
                name: candidate,
                download_url,
                size_bytes: response.content_length().unwrap_or(0),
            }));
        }

        if response.status() == reqwest::StatusCode::NOT_FOUND {
            continue;
        }

        return Err(format!(
            "Unexpected status {} while probing release asset {}",
            response.status(),
            candidate
        )
        .into());
    }

    Ok(None)
}

fn run_check_app_update_via_feed(
    client: &reqwest::blocking::Client,
    allow_prerelease: bool,
) -> Result<AppUpdateInfo, Box<dyn std::error::Error + Send + Sync>> {
    let feed = client
        .get(GITHUB_RELEASES_ATOM)
        .send()?
        .error_for_status()?
        .text()?;
    let release = select_feed_release(parse_github_releases_feed(&feed), allow_prerelease)
        .ok_or(NO_MATCHING_RELEASE_ERROR)?;
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let latest_version = normalize_release_version(&release.tag_name);
    let update_available =
        compare_release_versions(&latest_version, &current_version) == VersionOrdering::Greater;
    let download_asset = if update_available {
        detect_release_asset_from_public_release(client, &release.tag_name)?
    } else {
        None
    };

    Ok(AppUpdateInfo {
        current_version,
        latest_version,
        release_name: release.title,
        release_tag: release.tag_name,
        release_url: release.html_url,
        published_at: release.published_at,
        prerelease: release.prerelease,
        download_asset,
        update_available,
    })
}

fn run_check_app_update_via_api(
    client: &reqwest::blocking::Client,
    allow_prerelease: bool,
) -> Result<AppUpdateInfo, Box<dyn std::error::Error + Send + Sync>> {
    let releases = client
        .get(GITHUB_RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()?
        .error_for_status()?
        .json::<Vec<GithubRelease>>()?;
    let release = select_release(releases, allow_prerelease).ok_or(NO_MATCHING_RELEASE_ERROR)?;
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let latest_version = normalize_release_version(&release.tag_name);
    let update_available =
        compare_release_versions(&latest_version, &current_version) == VersionOrdering::Greater;

    Ok(AppUpdateInfo {
        current_version,
        latest_version,
        release_name: release
            .name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&release.tag_name)
            .to_string(),
        release_tag: release.tag_name,
        release_url: release.html_url,
        published_at: release.published_at,
        prerelease: release.prerelease,
        download_asset: preferred_release_asset(&release.assets),
        update_available,
    })
}

fn run_check_app_update(
    allow_prerelease: bool,
) -> Result<AppUpdateInfo, Box<dyn std::error::Error + Send + Sync>> {
    let client = github_client(Some(Duration::from_secs(30)))?;
    match run_check_app_update_via_feed(&client, allow_prerelease) {
        Ok(result) => Ok(result),
        Err(error) if format_error_chain(error.as_ref()) == NO_MATCHING_RELEASE_ERROR => Err(error),
        Err(_) => run_check_app_update_via_api(&client, allow_prerelease),
    }
}

#[cfg(target_os = "windows")]
fn escape_powershell_single_quoted_string(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(target_os = "windows")]
fn build_windows_update_installer_wait_script(path: &Path, process_id: u32) -> String {
    let installer_path = escape_powershell_single_quoted_string(&path.to_string_lossy());
    let installer_extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    let mut script = format!(
        "$ErrorActionPreference = 'Stop'; $installerPath = '{installer_path}'; $installerExtension = '{installer_extension}'; $terstermProcessId = {process_id}; ",
        installer_path = installer_path,
        installer_extension = installer_extension,
        process_id = process_id,
    );
    script.push_str(
        "while (Get-Process -Id $terstermProcessId -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 400 }; ",
    );
    script.push_str("Start-Sleep -Milliseconds 250; ");
    script.push_str("for ($attempt = 0; $attempt -lt 12; $attempt++) { ");
    script.push_str("try { ");
    script.push_str("if (-not (Test-Path -LiteralPath $installerPath)) { throw \"Installer not found: $installerPath\" }; ");
    script.push_str("if ($installerExtension -eq 'msi') { Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', $installerPath) -WindowStyle Normal | Out-Null } ");
    script.push_str(
        "else { Start-Process -FilePath $installerPath -WindowStyle Normal | Out-Null }; exit 0 } ",
    );
    script.push_str("catch { Start-Sleep -Milliseconds 500 } ");
    script.push_str("}; exit 1");
    script
}

#[cfg(target_os = "windows")]
fn schedule_update_installer_after_exit(
    path: &Path,
    process_id: u32,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let script = build_windows_update_installer_wait_script(path, process_id);
    let mut command = std::process::Command::new("powershell");
    configure_subprocess(&mut command);
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script.as_str(),
        ])
        .spawn()?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn launch_update_installer(path: &Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    std::process::Command::new("open").arg(path).spawn()?;
    Ok(())
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn launch_update_installer(path: &Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    std::process::Command::new("xdg-open").arg(path).spawn()?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn schedule_update_installer_after_exit(
    path: &Path,
    _process_id: u32,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    launch_update_installer(path)
}

fn schedule_update_exit(app: AppHandle) {
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(900));
        exit_application_for_update(app);
    });
}

fn run_download_app_update(
    app: &AppHandle,
    download_url: &str,
    filename: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    if !download_url.starts_with(GITHUB_RELEASE_DOWNLOAD_PREFIX) {
        return Err("Unsupported release asset URL".into());
    }

    let fallback_name = download_url
        .rsplit('/')
        .next()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("tersterm-update");
    let filename = if filename.trim().is_empty() {
        fallback_name
    } else {
        filename
    };
    let downloads = app.path().download_dir()?;
    fs::create_dir_all(&downloads)?;
    let local_path = unique_local_path(&downloads, filename);
    let mut response = github_client(Some(Duration::from_secs(600)))?
        .get(download_url)
        .send()?
        .error_for_status()?;
    let total_bytes = response.content_length();
    let file_name = local_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(filename);
    let mut file = fs::File::create(&local_path)?;
    let mut downloaded_bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];

    loop {
        let read = response.read(&mut buffer)?;
        if read == 0 {
            break;
        }

        file.write_all(&buffer[..read])?;
        downloaded_bytes += read as u64;
        emit_app_update_download_progress(
            app,
            "downloading",
            Some(file_name),
            downloaded_bytes,
            total_bytes,
        );
    }

    file.flush()?;
    file.sync_all()?;
    drop(file);
    emit_app_update_download_progress(
        app,
        "installing",
        Some(file_name),
        downloaded_bytes,
        total_bytes.or(Some(downloaded_bytes)),
    );
    schedule_update_installer_after_exit(&local_path, std::process::id())?;
    schedule_update_exit(app.clone());

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
    command.arg(format!(
        "UserKnownHostsFile={}",
        ensure_terssh_known_hosts().to_string_lossy()
    ));
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

fn openssh_remote_target(config: &ConnectionConfig, remote_path: &str) -> String {
    format!(
        "{}@{}:{}",
        config.username,
        config.host,
        sftp_path(remote_path)
    )
}

fn build_scp_command(
    config: &ConnectionConfig,
    private_key: Option<&PreparedPrivateKey>,
    remote_path: &str,
    local_path: &Path,
) -> CommandBuilder {
    let mut command = CommandBuilder::new("scp");
    command.arg("-P");
    command.arg(config.port.to_string());
    command.arg("-o");
    command.arg("ServerAliveInterval=30");
    command.arg("-o");
    command.arg("ConnectTimeout=15");
    command.arg("-o");
    command.arg("StrictHostKeyChecking=accept-new");
    command.arg("-o");
    command.arg(format!(
        "UserKnownHostsFile={}",
        ensure_terssh_known_hosts().to_string_lossy()
    ));
    command.arg("-o");
    command.arg("NumberOfPasswordPrompts=1");

    if let Some(private_key) = private_key {
        command.arg("-i");
        command.arg(private_key.path.to_string_lossy().as_ref());
    }

    command.arg(openssh_remote_target(config, remote_path));
    command.arg(local_path.to_string_lossy().as_ref());
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

fn expand_local_directory_path(raw_path: &str) -> PathBuf {
    let trimmed = raw_path.trim();
    if trimmed == "~" || trimmed.starts_with("~/") || trimmed.starts_with("~\\") {
        if let Some(home) = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")) {
            let remainder = trimmed
                .strip_prefix('~')
                .unwrap_or_default()
                .trim_start_matches(['/', '\\']);
            return if remainder.is_empty() {
                PathBuf::from(home)
            } else {
                PathBuf::from(home).join(remainder)
            };
        }
    }

    PathBuf::from(trimmed)
}

fn terssh_dir() -> PathBuf {
    if let Some(home) = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")) {
        PathBuf::from(home).join(".terssh")
    } else {
        env::temp_dir().join("terssh")
    }
}

fn ensure_terssh_known_hosts() -> PathBuf {
    let dir = terssh_dir();
    fs::create_dir_all(&dir).ok();
    dir.join("known_hosts")
}

fn resolve_local_download_directory(
    app: &AppHandle,
    local_dir: Option<&str>,
) -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
    if let Some(local_dir) = local_dir.map(str::trim).filter(|value| !value.is_empty()) {
        return Ok(expand_local_directory_path(local_dir));
    }

    Ok(app.path().download_dir()?)
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

fn validate_remote_file_component(name: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Name is required".into());
    }

    if trimmed.contains('/') || trimmed.contains('\0') {
        return Err("Name contains invalid characters".into());
    }

    Ok(trimmed.to_string())
}

fn run_remote_shell_fragment(
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: ConnectionConfig,
    fragment: String,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let command = format!("sh -lc {}", shell_quote(&fragment));

    match run_ssh2_exec_command(&config, &command) {
        Ok(output) => Ok(output),
        Err(error) if should_fallback_to_openssh(&config, &*error) => {
            run_openssh_exec_command(processes, session_id, &config, &command)
        }
        Err(error) => Err(error),
    }
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

fn create_directory_shell_fragment(parent_path: &str, name: &str) -> String {
    let remote_target = sftp_path(&remote_join(parent_path, name));
    format!(
        r#"target={}; mkdir -- "$target"; real=$(cd -- "$target" 2>/dev/null && pwd -P) || real="$target"; printf "%s" "$real""#,
        shell_quote(&remote_target)
    )
}

fn run_remote_create_directory(
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: ConnectionConfig,
    remote_path: String,
    name: String,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let safe_name = validate_remote_file_component(&name)?;
    let output = run_remote_shell_fragment(
        processes,
        session_id,
        config,
        create_directory_shell_fragment(&remote_path, &safe_name),
    )?;
    Ok(output.trim().to_string())
}

fn delete_remote_path_shell_fragment(remote_path: &str, recursive: bool) -> String {
    let target = sftp_path(remote_path);
    let recursive_flag = if recursive { "1" } else { "0" };
    format!(
        r#"target={}; recursive={}; if [ -d "$target" ] && [ ! -L "$target" ]; then if [ "$recursive" = "1" ]; then rm -rf -- "$target"; else rmdir -- "$target"; fi; else rm -f -- "$target"; fi"#,
        shell_quote(&target),
        shell_quote(recursive_flag)
    )
}

fn run_remote_delete_path(
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: ConnectionConfig,
    remote_path: String,
    recursive: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    run_remote_shell_fragment(
        processes,
        session_id,
        config,
        delete_remote_path_shell_fragment(&remote_path, recursive),
    )?;
    Ok(())
}

fn file_permissions_shell_fragment(remote_path: &str) -> String {
    let target = sftp_path(remote_path);
    format!(
        r#"target={}; [ -e "$target" ] || exit 1; mode=$(stat -c %a -- "$target" 2>/dev/null || stat -f %Lp -- "$target"); owner=$(stat -c %U -- "$target" 2>/dev/null || stat -f %Su -- "$target"); if [ -d "$target" ] && [ ! -L "$target" ]; then kind=directory; elif [ -L "$target" ]; then kind=symlink; else kind=file; fi; name=$(basename -- "$target"); parent=$(dirname -- "$target"); if real_parent=$(cd -- "$parent" 2>/dev/null && pwd -P); then if [ "$real_parent" = "/" ]; then real="/$name"; else real="$real_parent/$name"; fi; else real="$target"; fi; printf "PATH\t%s\nNAME\t%s\nKIND\t%s\nMODE\t%s\nOWNER\t%s\n" "$real" "$name" "$kind" "$mode" "$owner""#,
        shell_quote(&target)
    )
}

fn parse_file_permissions_output(
    output: &str,
) -> Result<RemoteFilePermissions, Box<dyn std::error::Error + Send + Sync>> {
    let mut path = String::new();
    let mut name = String::new();
    let mut kind = "file".to_string();
    let mut mode = String::new();
    let mut owner = String::new();

    for line in output.lines() {
        let Some((key, value)) = line.split_once('\t') else {
            continue;
        };

        match key {
            "PATH" => path = value.to_string(),
            "NAME" => name = value.to_string(),
            "KIND" => kind = value.to_string(),
            "MODE" => mode = value.to_string(),
            "OWNER" => owner = value.to_string(),
            _ => {}
        }
    }

    if path.is_empty() || name.is_empty() || mode.is_empty() {
        return Err("Unable to read remote file permissions".into());
    }

    Ok(RemoteFilePermissions {
        path,
        name,
        kind,
        mode,
        owner,
    })
}

fn run_remote_get_file_permissions(
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: ConnectionConfig,
    remote_path: String,
) -> Result<RemoteFilePermissions, Box<dyn std::error::Error + Send + Sync>> {
    let output = run_remote_shell_fragment(
        processes,
        session_id,
        config,
        file_permissions_shell_fragment(&remote_path),
    )?;
    parse_file_permissions_output(&output)
}

fn validate_permission_mode(mode: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let trimmed = mode.trim();
    let valid = matches!(trimmed.len(), 3 | 4) && trimmed.chars().all(|char| ('0'..='7').contains(&char));
    if !valid {
        return Err("Mode must be a 3 or 4 digit octal value".into());
    }

    Ok(trimmed.to_string())
}

fn set_file_permissions_shell_fragment(
    remote_path: &str,
    mode: &str,
    owner: Option<&str>,
    recursive: bool,
) -> String {
    let target = sftp_path(remote_path);
    let recursive_flag = if recursive { "1" } else { "0" };
    let owner_value = owner.unwrap_or("").trim();
    format!(
        r#"target={}; mode={}; owner={}; recursive={}; if [ "$recursive" = "1" ] && [ -d "$target" ] && [ ! -L "$target" ]; then chmod -R -- "$mode" "$target"; if [ -n "$owner" ]; then chown -R -- "$owner" "$target"; fi; else chmod -- "$mode" "$target"; if [ -n "$owner" ]; then chown -- "$owner" "$target"; fi; fi"#,
        shell_quote(&target),
        shell_quote(mode),
        shell_quote(owner_value),
        shell_quote(recursive_flag)
    )
}

fn run_remote_set_file_permissions(
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: ConnectionConfig,
    remote_path: String,
    mode: String,
    owner: Option<String>,
    recursive: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let safe_mode = validate_permission_mode(&mode)?;
    let owner = owner
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    run_remote_shell_fragment(
        processes,
        session_id,
        config,
        set_file_permissions_shell_fragment(&remote_path, &safe_mode, owner.as_deref(), recursive),
    )?;
    Ok(())
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

fn remote_file_upload_shell_fragment(remote_target: &str) -> String {
    format!(
        r#"target={}; parent=$(dirname -- "$target") || exit 1; mkdir -p -- "$parent" || exit 1; base64 -d > "$target""#,
        shell_quote(remote_target),
    )
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
    let fragment = remote_file_upload_shell_fragment(&remote_target);
    let command = format!("sh -lc {}", shell_quote(&fragment));
    run_openssh_exec_command_with_stdin_and_timeout(
        processes,
        session_id,
        config,
        &command,
        Some(content_base64.as_bytes()),
        OPENSSH_FILE_TRANSFER_TIMEOUT,
    )?;

    Ok(target)
}

fn run_remote_file_download(
    app: &AppHandle,
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: ConnectionConfig,
    remote_path: String,
    local_dir: Option<String>,
    expected_size: Option<u64>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let remote_path = normalize_remote_path(&remote_path);
    let filename = Path::new(&remote_path)
        .file_name()
        .and_then(|value| value.to_str())
        .map(sanitize_filename)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "download".to_string());
    let downloads = resolve_local_download_directory(app, local_dir.as_deref())?;
    fs::create_dir_all(&downloads)?;
    let local_path = unique_local_path(&downloads, &filename);

    match run_remote_file_download_ssh2(
        app,
        session_id,
        &config,
        &remote_path,
        &local_path,
        expected_size,
    ) {
        Ok(()) => Ok(local_path.to_string_lossy().to_string()),
        Err(error) if should_fallback_to_openssh(&config, &*error) => {
            run_remote_file_download_openssh(
                app,
                processes,
                session_id,
                &config,
                &remote_path,
                &local_path,
                expected_size,
            )?;
            Ok(local_path.to_string_lossy().to_string())
        }
        Err(error) => Err(error),
    }
}

fn run_remote_file_download_ssh2(
    app: &AppHandle,
    session_id: Option<&str>,
    config: &ConnectionConfig,
    remote_path: &str,
    local_path: &Path,
    expected_size: Option<u64>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let filename = local_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let (_session, sftp) = connect_sftp(config)?;
    let sftp_path = sftp_path(remote_path);
    let total_bytes = expected_size.filter(|value| *value > 0).or_else(|| {
        sftp.stat(Path::new(&sftp_path))
            .ok()
            .and_then(|stat| stat.size)
    });
    let mut remote_file = sftp.open(Path::new(&sftp_path))?;
    let mut local_file = fs::File::create(local_path)?;
    let mut buffer = [0_u8; 65_536];
    let mut downloaded_bytes = 0_u64;

    emit_ssh_file_download_progress(
        app,
        session_id,
        remote_path,
        local_path,
        filename,
        downloaded_bytes,
        total_bytes,
    );

    loop {
        let read = remote_file.read(&mut buffer)?;
        if read == 0 {
            break;
        }

        local_file.write_all(&buffer[..read])?;
        downloaded_bytes += read as u64;
        emit_ssh_file_download_progress(
            app,
            session_id,
            remote_path,
            local_path,
            filename,
            downloaded_bytes,
            total_bytes,
        );
    }

    local_file.flush()?;
    emit_ssh_file_download_progress(
        app,
        session_id,
        remote_path,
        local_path,
        filename,
        downloaded_bytes,
        total_bytes.or(Some(downloaded_bytes)),
    );
    Ok(())
}

fn run_remote_file_download_openssh(
    app: &AppHandle,
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: &ConnectionConfig,
    remote_path: &str,
    local_path: &Path,
    expected_size: Option<u64>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let has_interactive_secret = config
        .password
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());

    if !has_interactive_secret {
        return run_openssh_scp_download_noninteractive(
            app,
            processes,
            session_id,
            config,
            remote_path,
            local_path,
            OPENSSH_FILE_TRANSFER_TIMEOUT,
            expected_size,
        );
    }

    run_openssh_scp_download_interactive(
        app,
        processes,
        session_id,
        config,
        remote_path,
        local_path,
        OPENSSH_FILE_TRANSFER_TIMEOUT,
        expected_size,
    )
}

fn run_openssh_scp_download_noninteractive(
    app: &AppHandle,
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: &ConnectionConfig,
    remote_path: &str,
    local_path: &Path,
    timeout: Duration,
    total_bytes: Option<u64>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let process_guard = register_openssh_process(processes, session_id);
    if process_guard.is_cancelled() {
        return Err("OpenSSH command cancelled".into());
    }

    let filename = local_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let total_bytes = total_bytes.filter(|value| *value > 0);

    let private_key = prepare_private_key_for_noninteractive_openssh(config)?;
    let mut command = std::process::Command::new("scp");
    configure_subprocess(&mut command);
    command
        .arg("-P")
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
        .arg(format!(
            "UserKnownHostsFile={}",
            ensure_terssh_known_hosts().to_string_lossy()
        ))
        .arg("-o")
        .arg("NumberOfPasswordPrompts=0");

    if let Some(private_key) = private_key.as_ref() {
        command.arg("-i").arg(&private_key.path);
    }

    command
        .arg(openssh_remote_target(config, remote_path))
        .arg(local_path)
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
    let mut last_reported_bytes = 0_u64;
    let status;

    emit_ssh_file_download_progress(
        app,
        session_id,
        remote_path,
        local_path,
        filename,
        last_reported_bytes,
        total_bytes,
    );

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

        if started_at.elapsed() > timeout {
            child.kill().ok();
            child.wait().ok();
            stdout_reader.join().ok();
            stderr_reader.join().ok();
            return Err("OpenSSH command timed out".into());
        }

        let downloaded_bytes = fs::metadata(local_path)
            .map(|metadata| metadata.len())
            .unwrap_or(last_reported_bytes);
        if downloaded_bytes != last_reported_bytes {
            last_reported_bytes = downloaded_bytes;
            emit_ssh_file_download_progress(
                app,
                session_id,
                remote_path,
                local_path,
                filename,
                downloaded_bytes,
                total_bytes,
            );
        }

        thread::sleep(Duration::from_millis(50));
    }

    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    let combined = format!("{stdout}{stderr}");

    if status.success() {
        let downloaded_bytes = fs::metadata(local_path)
            .map(|metadata| metadata.len())
            .unwrap_or(last_reported_bytes);
        emit_ssh_file_download_progress(
            app,
            session_id,
            remote_path,
            local_path,
            filename,
            downloaded_bytes,
            total_bytes.or(Some(downloaded_bytes)),
        );
        return Ok(());
    }

    let message = combined.trim();
    if message.is_empty() {
        return Err(format!("OpenSSH command failed with code {:?}", status.code()).into());
    }

    Err(message.to_string().into())
}

fn run_openssh_scp_download_interactive(
    app: &AppHandle,
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: &ConnectionConfig,
    remote_path: &str,
    local_path: &Path,
    timeout: Duration,
    total_bytes: Option<u64>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let process_guard = register_openssh_process(processes, session_id);
    if process_guard.is_cancelled() {
        return Err("OpenSSH command cancelled".into());
    }

    let filename = local_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let total_bytes = total_bytes.filter(|value| *value > 0);

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 32,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let private_key = prepare_private_key(config)?;
    let command = build_scp_command(config, private_key.as_ref(), remote_path, local_path);
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
    let mut password_sent = false;
    let mut passphrase_sent = false;
    let mut exit_status = None;
    let mut last_reported_bytes = 0_u64;

    emit_ssh_file_download_progress(
        app,
        session_id,
        remote_path,
        local_path,
        filename,
        last_reported_bytes,
        total_bytes,
    );

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
                        if let Some(writer) = writer.as_mut() {
                            writer.write_all(format!("{passphrase}\n").as_bytes())?;
                            writer.flush()?;
                        }
                    }
                }

                if !password_sent && prompt.contains("password:") {
                    if let Some(password) = &password {
                        password_sent = true;
                        if let Some(writer) = writer.as_mut() {
                            writer.write_all(format!("{password}\n").as_bytes())?;
                            writer.flush()?;
                        }
                    }
                }

                let downloaded_bytes = fs::metadata(local_path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(last_reported_bytes);
                if downloaded_bytes != last_reported_bytes {
                    last_reported_bytes = downloaded_bytes;
                    emit_ssh_file_download_progress(
                        app,
                        session_id,
                        remote_path,
                        local_path,
                        filename,
                        downloaded_bytes,
                        total_bytes,
                    );
                }
            }
            Ok(None) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if started_at.elapsed() > timeout {
                    shutdown_pty_process(
                        &mut *child,
                        &mut master,
                        &mut writer,
                        Some(&reader_done_rx),
                    );
                    return Err("OpenSSH command timed out".into());
                }

                let downloaded_bytes = fs::metadata(local_path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(last_reported_bytes);
                if downloaded_bytes != last_reported_bytes {
                    last_reported_bytes = downloaded_bytes;
                    emit_ssh_file_download_progress(
                        app,
                        session_id,
                        remote_path,
                        local_path,
                        filename,
                        downloaded_bytes,
                        total_bytes,
                    );
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
                Ok(None)
                | Err(mpsc::TryRecvError::Empty)
                | Err(mpsc::TryRecvError::Disconnected) => {
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
        let downloaded_bytes = fs::metadata(local_path)
            .map(|metadata| metadata.len())
            .unwrap_or(last_reported_bytes);
        emit_ssh_file_download_progress(
            app,
            session_id,
            remote_path,
            local_path,
            filename,
            downloaded_bytes,
            total_bytes.or(Some(downloaded_bytes)),
        );
        return Ok(());
    }

    let message = output.trim();
    if message.is_empty() {
        return Err(format!("OpenSSH command failed with code {}", status.exit_code()).into());
    }

    Err(message.to_string().into())
}

fn parse_system_usage_output(
    output: &str,
) -> Result<SystemUsage, Box<dyn std::error::Error + Send + Sync>> {
    let mut cpu_percent = None;
    let mut memory = None;
    let mut storage = None;
    let mut linux_distro = None;

    for line in output.lines() {
        let line = line
            .find("OS ")
            .or_else(|| line.find("CPU "))
            .or_else(|| line.find("MEM "))
            .or_else(|| line.find("DISK "))
            .map(|index| &line[index..])
            .unwrap_or(line);
        let mut parts = line.split_whitespace();
        match parts.next() {
            Some("OS") => {
                linux_distro = parts.next().map(|value| value.trim().to_ascii_lowercase());
            }
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
        latency_ms: 0,
        host_platform: Some("linux".to_string()),
        linux_distro,
    })
}

fn run_ssh_ping(config: &ConnectionConfig) -> u64 {
    let addr = format!("{}:{}", config.host, config.port);
    let start = Instant::now();
    let _ = TcpStream::connect_timeout(
        &addr.parse().expect("invalid SSH address"),
        std::time::Duration::from_secs(3),
    );
    start.elapsed().as_millis() as u64
}

fn run_remote_system_usage(
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: ConnectionConfig,
) -> Result<SystemUsage, Box<dyn std::error::Error + Send + Sync>> {
    let command = format!("sh -lc {}", shell_quote(system_usage_shell_fragment()));

    let result = match run_ssh2_exec_command(&config, &command) {
        Ok(output) => parse_system_usage_output(&output),
        Err(error) if should_fallback_to_openssh(&config, &*error) => {
            let output = run_openssh_exec_command(processes, session_id, &config, &command)?;
            parse_system_usage_output(&output)
        }
        Err(error) => Err(error),
    };

    result
}

fn system_usage_shell_fragment() -> &'static str {
    r#"printf "\n"; if [ -r /etc/os-release ]; then . /etc/os-release; printf "OS %s\n" "${ID:-linux}"; else printf "OS linux\n"; fi; read cpu user nice system idle iowait irq softirq steal guest guest_nice < /proc/stat; total1=$((user+nice+system+idle+iowait+irq+softirq+steal)); idle1=$((idle+iowait)); sleep 1; read cpu user nice system idle iowait irq softirq steal guest guest_nice < /proc/stat; total2=$((user+nice+system+idle+iowait+irq+softirq+steal)); idle2=$((idle+iowait)); total=$((total2-total1)); idle_delta=$((idle2-idle1)); awk -v total="$total" -v idle="$idle_delta" "BEGIN { if (total > 0) printf \"CPU %.1f\n\", (total-idle)*100/total; else print \"CPU 0.0\" }"; awk "/MemTotal:/ { total=\$2 } /MemAvailable:/ { available=\$2 } END { printf \"MEM %.2f %.2f\n\", (total-available)/1048576, total/1048576 }" /proc/meminfo; df -B1 / | awk "NR==2 { printf \"DISK %.2f %.2f\n\", \$3/1073741824, \$2/1073741824 }""#
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
    run_openssh_exec_command_with_stdin_and_timeout(
        processes,
        session_id,
        config,
        remote_command,
        None,
        OPENSSH_COMMAND_TIMEOUT,
    )
}

fn run_openssh_exec_command_with_stdin_and_timeout(
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: &ConnectionConfig,
    remote_command: &str,
    stdin_data: Option<&[u8]>,
    timeout: Duration,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let debug_enabled = env::var("TERSTERM_DEBUG_OPENSSH")
        .map(|value| value == "1")
        .unwrap_or(false);
    let has_interactive_secret = config
        .password
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());

    if !has_interactive_secret {
        return run_openssh_exec_command_noninteractive_with_stdin_and_timeout(
            processes,
            session_id,
            config,
            remote_command,
            stdin_data,
            timeout,
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
    let mut stdin_payload = stdin_data.map(|data| data.to_vec());
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

                // Once auth is done, forward any pending stdin payload and then close stdin.
                if writer.is_some()
                    && (!requires_passphrase || passphrase_sent)
                    && (!requires_password || password_sent)
                {
                    if let Some(data) = stdin_payload.take() {
                        if debug_enabled {
                            eprintln!(
                                "run_openssh_exec_command streaming {} stdin bytes",
                                data.len()
                            );
                        }
                        if let Some(writer) = writer.as_mut() {
                            writer.write_all(&data)?;
                            writer.flush()?;
                        }
                    }
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
                if started_at.elapsed() > timeout {
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
                Ok(None)
                | Err(mpsc::TryRecvError::Empty)
                | Err(mpsc::TryRecvError::Disconnected) => {
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

fn join_openssh_stdin_writer(
    writer: Option<thread::JoinHandle<std::io::Result<()>>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    match writer {
        Some(writer) => match writer.join() {
            Ok(result) => result.map_err(|error| error.into()),
            Err(_) => Err("OpenSSH stdin writer panicked".into()),
        },
        None => Ok(()),
    }
}

fn run_openssh_exec_command_noninteractive_with_stdin_and_timeout(
    processes: &OpenSshProcesses,
    session_id: Option<&str>,
    config: &ConnectionConfig,
    remote_command: &str,
    stdin_data: Option<&[u8]>,
    timeout: Duration,
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
        .arg(format!(
            "UserKnownHostsFile={}",
            ensure_terssh_known_hosts().to_string_lossy()
        ))
        .arg("-o")
        .arg("NumberOfPasswordPrompts=0");

    if let Some(private_key) = private_key.as_ref() {
        command.arg("-i").arg(&private_key.path);
    }

    command
        .arg(format!("{}@{}", config.username, config.host))
        .arg(remote_command)
        .stdin(if stdin_data.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = command.spawn()?;
    let stdin_writer = if let Some(data) = stdin_data {
        let mut stdin = child.stdin.take().ok_or("Unable to write OpenSSH stdin")?;
        let data = data.to_vec();
        Some(thread::spawn(move || -> std::io::Result<()> {
            stdin.write_all(&data)?;
            stdin.flush()?;
            Ok(())
        }))
    } else {
        None
    };
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
            join_openssh_stdin_writer(stdin_writer).ok();
            return Err("OpenSSH command cancelled".into());
        }

        if let Some(exit_status) = child.try_wait()? {
            status = exit_status;
            break;
        }

        if started_at.elapsed() > timeout {
            child.kill().ok();
            child.wait().ok();
            stdout_reader.join().ok();
            stderr_reader.join().ok();
            join_openssh_stdin_writer(stdin_writer).ok();
            return Err("OpenSSH command timed out".into());
        }

        thread::sleep(Duration::from_millis(50));
    }

    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    let stdin_result = join_openssh_stdin_writer(stdin_writer);
    let combined = format!("{stdout}{stderr}");

    if status.success() {
        stdin_result?;
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

fn exit_application_with_cleanup(app: AppHandle, terminate_descendants: bool) {
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
        {
            if terminate_descendants {
                terminate_descendant_processes(std::process::id());
            }

            // `tray-icon` always tries to remove the icon on drop.
            // If the icon is currently hidden, Windows reports a removal error.
            // Re-show it right before exit so shutdown removes a registered icon.
            set_tray_visibility(&app, true);
        }
        app.exit(0);
    });
}

fn exit_application(app: AppHandle) {
    exit_application_with_cleanup(app, true);
}

fn exit_application_for_update(app: AppHandle) {
    exit_application_with_cleanup(app, false);
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
        .manage(MainWindowStateReady::default())
        .manage(WindowCloseBehaviorState::default())
        .manage(AppLocaleState::default())
        .manage(PersistedMainWindowState::default())
        .manage(TrayMenuState::default())
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_test_connection,
            ssh_write,
            ssh_write_binary,
            ssh_resize,
            ssh_disconnect,
            ssh_list_files,
            ssh_create_directory,
            ssh_upload_file,
            ssh_delete_path,
            ssh_download_file,
            ssh_get_file_permissions,
            ssh_set_file_permissions,
            save_local_file,
            pick_local_directory,
            ssh_get_system_usage,
            ssh_ping,
            check_app_update,
            download_app_update,
            ai_chat,
            set_window_close_behavior,
            set_app_locale
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            if matches!(event, tauri::WindowEvent::Resized(_)) {
                if !window
                    .app_handle()
                    .state::<MainWindowStateReady>()
                    .0
                    .load(Ordering::Relaxed)
                {
                    return;
                }

                if let Some(main_window) = window.app_handle().get_webview_window(window.label()) {
                    persist_main_window_state(&main_window);
                }
                return;
            }

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
            initialize_persisted_app_settings(app.handle());

            let locale = app.state::<AppLocaleState>().get();
            let (show_text, quit_text) = tray_menu_text(locale);
            let show_item =
                MenuItem::with_id(app, TRAY_SHOW_MENU_ID, show_text, true, None::<&str>)?;
            let quit_item =
                MenuItem::with_id(app, TRAY_QUIT_MENU_ID, quit_text, true, None::<&str>)?;

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
            initialize_main_window_state(&window);
            app.state::<MainWindowStateReady>()
                .0
                .store(true, Ordering::Relaxed);
            window.show().ok();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TerSterm");
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use super::{build_windows_update_installer_wait_script, collect_descendants_from_entries};
    use super::{
        compare_release_versions, extract_api_error_message, format_error_chain,
        merge_window_state, normalize_anthropic_endpoint,
        output_looks_authenticated, parse_github_releases_feed, parse_openssh_file_list,
        parse_system_usage_output, release_asset_download_url, remote_file_upload_shell_fragment,
        responsive_default_window_state_for_display, run_openssh_exec_command,
        run_remote_file_list, run_remote_system_usage, select_feed_release,
        should_fallback_to_openssh, ConnectionConfig, OpenSshProcesses, PersistedWindowState,
    };
    use std::{cmp::Ordering as CmpOrdering, env, io};

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

    #[cfg(windows)]
    #[test]
    fn builds_update_wait_script_with_escaped_installer_path() {
        let script = build_windows_update_installer_wait_script(
            std::path::Path::new(r"C:\Users\O'Brien\Downloads\TerSterm Setup.exe"),
            4242,
        );

        assert!(script.contains("$terstermProcessId = 4242"));
        assert!(script.contains(r"C:\Users\O''Brien\Downloads\TerSterm Setup.exe"));
        assert!(script.contains("Start-Process -FilePath $installerPath -WindowStyle Normal"));
        assert!(!script.contains("Start-Process -LiteralPath"));
    }

    #[cfg(windows)]
    #[test]
    fn builds_update_wait_script_that_uses_msiexec_for_msi_packages() {
        let script = build_windows_update_installer_wait_script(
            std::path::Path::new(r"C:\Users\dev\Downloads\TerSterm_0.1.11_x64.msi"),
            4242,
        );

        assert!(script.contains("$installerExtension = 'msi'"));
        assert!(script.contains("Start-Process -FilePath 'msiexec.exe'"));
        assert!(script.contains("-ArgumentList @('/i', $installerPath)"));
    }

    #[test]
    fn normalize_anthropic_endpoint_defaults_to_v1_messages_for_origin_only() {
        assert_eq!(
            normalize_anthropic_endpoint("https://api.anthropic.com"),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn normalize_anthropic_endpoint_appends_messages_to_v1() {
        assert_eq!(
            normalize_anthropic_endpoint("https://api.anthropic.com/v1"),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn normalize_anthropic_endpoint_keeps_existing_messages_path() {
        assert_eq!(
            normalize_anthropic_endpoint("https://api.anthropic.com/v1/messages"),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn normalize_anthropic_endpoint_appends_v1_messages_to_xfyun_anthropic_base() {
        assert_eq!(
            normalize_anthropic_endpoint(
                "https://maas-coding-api.cn-huabei-1.xf-yun.com/anthropic"
            ),
            "https://maas-coding-api.cn-huabei-1.xf-yun.com/anthropic/v1/messages"
        );
    }

    #[test]
    fn extract_api_error_message_reads_top_level_message() {
        assert_eq!(
            extract_api_error_message(r#"{"message":"not found"}"#).as_deref(),
            Some("not found")
        );
    }

    #[test]
    fn compares_release_versions_with_numeric_segments() {
        assert_eq!(
            compare_release_versions("v0.1.10", "0.1.9"),
            CmpOrdering::Greater
        );
        assert_eq!(
            compare_release_versions("0.2.0", "v0.2.0"),
            CmpOrdering::Equal
        );
    }

    #[test]
    fn treats_prerelease_as_older_than_stable() {
        assert_eq!(
            compare_release_versions("1.0.0-beta.1", "1.0.0"),
            CmpOrdering::Less
        );
        assert_eq!(
            compare_release_versions("1.0.0", "1.0.0-beta.1"),
            CmpOrdering::Greater
        );
    }

    #[test]
    fn updates_saved_window_size_while_not_maximized() {
        let state = PersistedWindowState {
            width: 1665.0,
            height: 1039.0,
            maximized: false,
        };

        let next = merge_window_state(state, 1440.0, 900.0, false);

        assert_eq!(next.width, 1440.0);
        assert_eq!(next.height, 900.0);
        assert!(!next.maximized);
    }

    #[test]
    fn keeps_last_normal_window_size_when_maximized() {
        let state = PersistedWindowState {
            width: 1366.0,
            height: 860.0,
            maximized: false,
        };

        let next = merge_window_state(state, 1920.0, 1080.0, true);

        assert_eq!(next.width, 1366.0);
        assert_eq!(next.height, 860.0);
        assert!(next.maximized);
    }

    #[test]
    fn defaults_to_large_window_on_2k_displays() {
        let state = responsive_default_window_state_for_display(2560, 1440, 2560.0, 1392.0);

        assert_eq!(state.width, 1665.0);
        assert_eq!(state.height, 1039.0);
        assert!(!state.maximized);
    }

    #[test]
    fn defaults_to_compact_window_on_1080p_displays() {
        let state = responsive_default_window_state_for_display(1920, 1080, 1920.0, 1032.0);

        assert_eq!(state.width, 1440.0);
        assert_eq!(state.height, 900.0);
        assert!(!state.maximized);
    }

    #[test]
    fn formats_full_error_chain_for_update_failures() {
        #[derive(Debug)]
        struct WrappedError {
            message: &'static str,
            source: io::Error,
        }

        impl std::fmt::Display for WrappedError {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.message)
            }
        }

        impl std::error::Error for WrappedError {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.source)
            }
        }

        let error = WrappedError {
            message: "error sending request for url",
            source: io::Error::new(io::ErrorKind::TimedOut, "operation timed out"),
        };

        let message = format_error_chain(&error);

        assert!(message.contains("error sending request for url"));
        assert!(message.contains("operation timed out"));
    }

    #[test]
    fn parses_github_release_feed_entries() {
        let feed = concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
            "<feed>",
            "<entry>",
            "<updated>2026-05-14T05:00:00Z</updated>",
            "<link rel=\"alternate\" type=\"text/html\" href=\"https://github.com/Y3y202/TerSterm/releases/tag/v0.1.4-beta.1\"/>",
            "<title>TerSterm v0.1.4-beta.1</title>",
            "</entry>",
            "<entry>",
            "<updated>2026-05-13T05:00:00Z</updated>",
            "<link rel=\"alternate\" type=\"text/html\" href=\"https://github.com/Y3y202/TerSterm/releases/tag/v0.1.3\"/>",
            "<title>TerSterm v0.1.3</title>",
            "</entry>",
            "</feed>"
        );

        let releases = parse_github_releases_feed(feed);

        assert_eq!(releases.len(), 2);
        assert_eq!(releases[0].tag_name, "v0.1.4-beta.1");
        assert!(releases[0].prerelease);
        assert_eq!(releases[1].tag_name, "v0.1.3");
        assert!(!releases[1].prerelease);
    }

    #[test]
    fn selects_stable_or_prerelease_from_feed() {
        let feed = concat!(
            "<feed>",
            "<entry>",
            "<updated>2026-05-14T05:00:00Z</updated>",
            "<link rel=\"alternate\" type=\"text/html\" href=\"https://github.com/Y3y202/TerSterm/releases/tag/v0.1.4-beta.1\"/>",
            "<title>TerSterm v0.1.4-beta.1</title>",
            "</entry>",
            "<entry>",
            "<updated>2026-05-13T05:00:00Z</updated>",
            "<link rel=\"alternate\" type=\"text/html\" href=\"https://github.com/Y3y202/TerSterm/releases/tag/v0.1.3\"/>",
            "<title>TerSterm v0.1.3</title>",
            "</entry>",
            "</feed>"
        );

        let releases = parse_github_releases_feed(feed);
        let prerelease =
            select_feed_release(releases.clone(), true).expect("prerelease should exist");
        let stable = select_feed_release(releases, false).expect("stable should exist");

        assert_eq!(prerelease.tag_name, "v0.1.4-beta.1");
        assert_eq!(stable.tag_name, "v0.1.3");
    }

    #[test]
    fn builds_public_release_asset_download_url() {
        let url = release_asset_download_url("v0.1.3", "TerSterm_0.1.3_x64-setup.exe");

        assert_eq!(
            url,
            "https://github.com/Y3y202/TerSterm/releases/download/v0.1.3/TerSterm_0.1.3_x64-setup.exe"
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
    fn builds_upload_fragment_that_reads_content_from_stdin() {
        let fragment = remote_file_upload_shell_fragment("./uploads/release.log");

        assert!(fragment.contains("base64 -d > \"$target\""));
        assert!(!fragment.contains("<<'"));
    }

    #[test]
    fn parses_system_usage_output_with_login_noise() {
        let output = concat!(
            "Last login: Mon May 11 15:00:53 CST 2026\r\n",
            "OS ubuntu\r\n",
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
        assert_eq!(usage.host_platform.as_deref(), Some("linux"));
        assert_eq!(usage.linux_distro.as_deref(), Some("ubuntu"));
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
        let error = io::Error::other(
            "SSH password authentication failed: keyboard-interactive auth required",
        );

        assert!(should_fallback_to_openssh(&config, &error));
    }

    #[test]
    fn detects_authenticated_output_from_shell_prompt() {
        let output = concat!("\u{1b}[?2004hroot@hk-ser01:~# ", "\u{1b}[?2004l");

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
        let username =
            env::var("TERSTERM_REAL_USERNAME").expect("TERSTERM_REAL_USERNAME is required");
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
        eprintln!(
            "real host file list probe finished: {} entries",
            files.entries.len()
        );
        assert!(
            !files.path.trim().is_empty(),
            "real host file list path should not be empty"
        );
        assert!(
            !files.entries.is_empty(),
            "real host file list should include at least one entry"
        );

        eprintln!("starting real host system usage probe");
        let usage = run_remote_system_usage(&processes, None, config)
            .expect("real host system usage probe should succeed");
        eprintln!(
            "real host system usage probe finished: cpu={}",
            usage.cpu_percent
        );
        assert!(
            usage.cpu_percent >= 0.0,
            "real host cpu usage should be non-negative"
        );
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
