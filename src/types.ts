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
  system_usage?: SystemUsage
  system_usage_loading?: boolean
  system_usage_error?: string
}

export interface SshDataEvent {
  session_id: string
  data: string
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
