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
  error?: string
}

export interface SshDataEvent {
  session_id: string
  data: string
}

export interface SshDisconnectedEvent {
  session_id: string
  reason?: string
}
