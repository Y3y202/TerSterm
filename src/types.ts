export type HostPlatform = 'linux' | 'windows' | 'unknown'
export type AiProvider = 'openai-compatible' | 'anthropic'
export type AiAssistantPermission = 'reply-only' | 'type-only' | 'execute'

export interface ConnectionProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  password?: string
  private_key_path?: string
  private_key?: string
  private_key_passphrase?: string
  group_id?: string
  group?: string
  host_platform?: HostPlatform
  linux_distro?: string
}

export interface ConnectionGroup {
  id: string
  name: string
  expanded: boolean
}

export type PaneStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error'

export interface SshPane {
  id: string
  title: string
  status: PaneStatus
  session_id?: string
  connection?: ConnectionProfile
  private_key_passphrase_origin?: 'configured' | 'session'
  remote_features_ready?: boolean
  error?: string
  terminal_output?: string
  zmodem_active?: boolean
  system_usage?: SystemUsage
  system_usage_loading?: boolean
  system_usage_error?: string
}

export interface SshDataEvent {
  session_id: string
  data: string
}

export interface SshDataRawEvent {
  session_id: string
  data_base64: string
}

export interface SshDisconnectedEvent {
  session_id: string
  reason?: string
}

export interface SystemUsage {
  cpu_percent: number
  memory_used_gb: number
  memory_total_gb: number
  storage_used_gb: number
  storage_total_gb: number
  latency_ms: number
  host_platform?: HostPlatform
  linux_distro?: string
}

export type RemoteFileKind = 'file' | 'directory' | 'symlink'

export interface RemoteFileEntry {
  name: string
  path: string
  kind: RemoteFileKind
  size?: number
  modified: string
}

export interface RemoteFileList {
  path: string
  entries: RemoteFileEntry[]
}

export interface RemoteFilePermissions {
  path: string
  name: string
  kind: RemoteFileKind
  mode: string
  owner: string
}

export interface AppUpdateAsset {
  name: string
  download_url: string
  size_bytes: number
}

export interface AppUpdateInfo {
  current_version: string
  latest_version: string
  release_name: string
  release_tag: string
  release_url: string
  published_at?: string
  prerelease: boolean
  download_asset?: AppUpdateAsset
  update_available: boolean
}

export interface AppUpdateDownloadProgress {
  status: 'downloading' | 'installing'
  filename?: string
  downloaded_bytes: number
  total_bytes?: number
  percent: number
}

export interface SshFileDownloadProgress {
  session_id?: string
  remote_path: string
  local_path: string
  filename: string
  downloaded_bytes: number
  total_bytes?: number
  percent: number
}

export interface AiAssistantSettings {
  provider: AiProvider
  base_url: string
  api_key: string
  model: string
  system_prompt: string
  terminal_permission: AiAssistantPermission
}

export interface AiAssistantMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AiAssistantContext {
  connection_name?: string
  host?: string
  username?: string
  host_platform?: HostPlatform
  linux_distro?: string
  current_directory?: string
  visible_terminal_output?: string
  recent_terminal_output?: string
  pending_terminal_input?: string
}
