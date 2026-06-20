import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  AiAssistantContext,
  AiAssistantMessage,
  AiAssistantSettings,
  AppUpdateDownloadProgress,
  AppUpdateInfo,
  ConnectionProfile,
  RemoteFileList,
  RemoteFilePermissions,
  SshDataEvent,
  SshDataRawEvent,
  SshDisconnectedEvent,
  SshFileDownloadProgress,
  SystemUsage,
} from './types'

type UnlistenFn = () => void

const mockBus = new EventTarget()
const mockSessions = new Map<string, { prompt: string; connected: boolean }>()

const isTauriRuntime = () =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

const buildMockLocalPath = (filename: string, local_dir?: string) => {
  const safeName = filename || 'download'
  const trimmedDir = local_dir?.trim()
  if (!trimmedDir) return `Downloads/${safeName}`

  const baseDir = trimmedDir.replace(/[\\/]+$/, '')
  const separator = baseDir.includes('\\') && !baseDir.includes('/') ? '\\' : '/'
  return `${baseDir}${separator}${safeName}`
}

const emitMock = <T>(eventName: string, payload: T) => {
  mockBus.dispatchEvent(new CustomEvent(eventName, { detail: payload }))
}

const emitMockSshOutput = (session_id: string, data: string) => {
  emitMock<SshDataEvent>('ssh-data', { session_id, data })
  const bytes = new TextEncoder().encode(data)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  emitMock<SshDataRawEvent>('ssh-data-raw', {
    session_id,
    data_base64: btoa(binary),
  })
}

const createId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `mock-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export async function sshConnect(config: ConnectionProfile, session_id = createId()) {
  if (isTauriRuntime()) {
    return invoke<string>('ssh_connect', { sessionId: session_id, config })
  }

  const prompt = `${config.username}@${config.host}:~$ `
  mockSessions.set(session_id, { prompt, connected: true })

  window.setTimeout(() => {
    emitMockSshOutput(session_id, `Connected to ${config.name} (${config.host})\r\n${prompt}`)
  }, 260)

  return session_id
}

export async function sshTestConnection(config: ConnectionProfile) {
  if (isTauriRuntime()) {
    return invoke<string>('ssh_test_connection', { config })
  }

  return new Promise<string>((resolve) => {
    window.setTimeout(() => resolve('Connection test succeeded'), 360)
  })
}

export async function sshWrite(session_id: string, data: string) {
  if (isTauriRuntime()) {
    return invoke<void>('ssh_write', { sessionId: session_id, data })
  }

  const session = mockSessions.get(session_id)
  if (!session?.connected) return

  if (data === '\u007f') {
    emitMockSshOutput(session_id, '\b \b')
    return
  }

  if (data === '\r') {
    emitMockSshOutput(session_id, `\r\n${session.prompt}`)
    return
  }

  emitMockSshOutput(session_id, data)
}

export async function sshWriteBinary(session_id: string, data_base64: string) {
  if (isTauriRuntime()) {
    return invoke<void>('ssh_write_binary', { sessionId: session_id, dataBase64: data_base64 })
  }

  const bytes = Uint8Array.from(atob(data_base64), (char) => char.charCodeAt(0))
  const data = new TextDecoder().decode(bytes)
  return sshWrite(session_id, data)
}

export async function sshResize(session_id: string, cols: number, rows: number) {
  if (isTauriRuntime()) {
    return invoke<void>('ssh_resize', { sessionId: session_id, cols, rows })
  }
}

export async function sshDisconnect(session_id: string) {
  if (isTauriRuntime()) {
    return invoke<void>('ssh_disconnect', { sessionId: session_id })
  }

  const session = mockSessions.get(session_id)
  if (!session) return

  session.connected = false
  mockSessions.delete(session_id)
  emitMock<SshDisconnectedEvent>('ssh-disconnected', {
    session_id,
    reason: 'Session closed',
  })
}

export async function sshGetSystemUsage(
  config: ConnectionProfile,
  session_id?: string,
): Promise<SystemUsage> {
  if (isTauriRuntime()) {
    return invoke<SystemUsage>('ssh_get_system_usage', { config, sessionId: session_id })
  }

  return {
    cpu_percent: 18.6,
    memory_used_gb: 3.42,
    memory_total_gb: 16,
    storage_used_gb: 84,
    storage_total_gb: 256,
    latency_ms: 42,
    host_platform: 'linux',
    linux_distro: 'ubuntu',
  }
}

export async function sshPing(config: ConnectionProfile): Promise<number> {
  if (isTauriRuntime()) {
    return invoke<number>('ssh_ping', { config })
  }

  return 28
}

export async function sshListFiles(
  config: ConnectionProfile,
  remote_path: string,
  session_id?: string,
): Promise<RemoteFileList> {
  if (isTauriRuntime()) {
    return invoke<RemoteFileList>('ssh_list_files', { config, remotePath: remote_path, sessionId: session_id })
  }

  return {
    path: remote_path || '~',
    entries: [
      {
        name: '..',
        path: '..',
        kind: 'directory',
        modified: '',
      },
      {
        name: 'release.log',
        path: `${remote_path || '~'}/release.log`,
        kind: 'file',
        size: 18432,
        modified: 'May 09 22:10',
      },
      {
        name: 'uploads',
        path: `${remote_path || '~'}/uploads`,
        kind: 'directory',
        modified: 'May 09 21:42',
      },
    ],
  }
}

export async function sshUploadFile(
  config: ConnectionProfile,
  remote_path: string,
  filename: string,
  content_base64: string,
  session_id?: string,
) {
  if (isTauriRuntime()) {
    return invoke<string>('ssh_upload_file', {
      config,
      remotePath: remote_path,
      filename,
      contentBase64: content_base64,
      sessionId: session_id,
    })
  }

  return `${remote_path || '~'}/${filename}`
}

export async function sshCreateDirectory(
  config: ConnectionProfile,
  remote_path: string,
  name: string,
  session_id?: string,
) {
  if (isTauriRuntime()) {
    return invoke<string>('ssh_create_directory', {
      config,
      remotePath: remote_path,
      name,
      sessionId: session_id,
    })
  }

  return `${remote_path || '~'}/${name}`
}

export async function sshDeletePath(
  config: ConnectionProfile,
  remote_path: string,
  recursive = true,
  session_id?: string,
) {
  if (isTauriRuntime()) {
    return invoke<void>('ssh_delete_path', {
      config,
      remotePath: remote_path,
      recursive,
      sessionId: session_id,
    })
  }
}

export async function sshRemoveKnownHost(host: string, port?: number) {
  if (isTauriRuntime()) {
    return invoke<void>('ssh_remove_known_host', { host, port })
  }
}

export async function sshDownloadFile(
  config: ConnectionProfile,
  remote_path: string,
  session_id?: string,
  local_dir?: string,
  expected_size?: number,
) {
  if (isTauriRuntime()) {
    return invoke<string>('ssh_download_file', {
      config,
      remotePath: remote_path,
      sessionId: session_id,
      localDir: local_dir,
      expectedSize: expected_size,
    })
  }

  return buildMockLocalPath(remote_path.split('/').pop() || 'download', local_dir)
}

export async function sshGetFilePermissions(
  config: ConnectionProfile,
  remote_path: string,
  session_id?: string,
): Promise<RemoteFilePermissions> {
  if (isTauriRuntime()) {
    return invoke<RemoteFilePermissions>('ssh_get_file_permissions', {
      config,
      remotePath: remote_path,
      sessionId: session_id,
    })
  }

  return {
    path: remote_path,
    name: remote_path.split('/').pop() || remote_path,
    kind: remote_path.endsWith('/') ? 'directory' : 'file',
    mode: '755',
    owner: 'root',
  }
}

export async function sshSetFilePermissions(
  config: ConnectionProfile,
  remote_path: string,
  mode: string,
  owner?: string,
  recursive = false,
  session_id?: string,
) {
  if (isTauriRuntime()) {
    return invoke<void>('ssh_set_file_permissions', {
      config,
      remotePath: remote_path,
      mode,
      owner,
      recursive,
      sessionId: session_id,
    })
  }
}

export async function saveLocalFile(filename: string, content_base64: string, local_dir?: string) {
  if (isTauriRuntime()) {
    return invoke<string>('save_local_file', { filename, contentBase64: content_base64, localDir: local_dir })
  }

  return buildMockLocalPath(filename || 'download', local_dir)
}

export async function pickLocalDirectory(initial_dir?: string) {
  if (isTauriRuntime()) {
    return invoke<string | null>('pick_local_directory', { initialDir: initial_dir })
  }

  return initial_dir || 'Downloads'
}

export async function setWindowCloseBehavior(behavior: 'tray' | 'exit') {
  if (isTauriRuntime()) {
    return invoke<void>('set_window_close_behavior', { behavior })
  }
}

export async function setDesktopLocale(locale: 'zh-CN' | 'en-US') {
  if (isTauriRuntime()) {
    return invoke<void>('set_app_locale', { locale })
  }
}

export async function requestAiAssistantReply(
  settings: AiAssistantSettings,
  messages: AiAssistantMessage[],
  context?: AiAssistantContext,
) {
  if (isTauriRuntime()) {
    return invoke<string>('ai_chat', { settings, messages, context })
  }

  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content || ''
  const target = context?.connection_name || (context?.username && context?.host ? `${context.username}@${context.host}` : context?.host) || 'current host'
  return `Mock ${settings.provider} reply for ${target}: ${latestUserMessage}`
}

export async function checkAppUpdate(allow_prerelease = false): Promise<AppUpdateInfo> {
  if (isTauriRuntime()) {
    return invoke<AppUpdateInfo>('check_app_update', { allowPrerelease: allow_prerelease })
  }

  return {
    current_version: '0.1.11',
    latest_version: '0.1.11',
    release_name: 'TerSterm 0.1.11',
    release_tag: 'v0.1.11',
    release_url: 'https://github.com/Y3y202/TerSterm/releases/latest',
    prerelease: false,
    update_available: false,
  }
}

export async function downloadAppUpdate(download_url: string, filename: string) {
  if (isTauriRuntime()) {
    return invoke<string>('download_app_update', { downloadUrl: download_url, filename })
  }

  return `Downloads/${filename || 'tersterm-update'}`
}

export async function onAppUpdateDownloadProgress(
  callback: (payload: AppUpdateDownloadProgress) => void,
): Promise<UnlistenFn> {
  if (isTauriRuntime()) {
    return listen<AppUpdateDownloadProgress>('app-update-download-progress', (event) => callback(event.payload))
  }

  return () => undefined
}

export async function onSshFileDownloadProgress(
  callback: (payload: SshFileDownloadProgress) => void,
): Promise<UnlistenFn> {
  if (isTauriRuntime()) {
    return listen<SshFileDownloadProgress>('ssh-file-download-progress', (event) => callback(event.payload))
  }

  return () => undefined
}

export async function onSshData(callback: (payload: SshDataEvent) => void): Promise<UnlistenFn> {
  if (isTauriRuntime()) {
    return listen<SshDataEvent>('ssh-data', (event) => callback(event.payload))
  }

  const handler = (event: Event) => callback((event as CustomEvent<SshDataEvent>).detail)
  mockBus.addEventListener('ssh-data', handler)
  return () => mockBus.removeEventListener('ssh-data', handler)
}

export async function onSshDisconnected(
  callback: (payload: SshDisconnectedEvent) => void,
): Promise<UnlistenFn> {
  if (isTauriRuntime()) {
    return listen<SshDisconnectedEvent>('ssh-disconnected', (event) => callback(event.payload))
  }

  const handler = (event: Event) => callback((event as CustomEvent<SshDisconnectedEvent>).detail)
  mockBus.addEventListener('ssh-disconnected', handler)
  return () => mockBus.removeEventListener('ssh-disconnected', handler)
}

export async function onSshDataRaw(callback: (payload: SshDataRawEvent) => void): Promise<UnlistenFn> {
  if (isTauriRuntime()) {
    return listen<SshDataRawEvent>('ssh-data-raw', (event) => callback(event.payload))
  }

  const handler = (event: Event) => callback((event as CustomEvent<SshDataRawEvent>).detail)
  mockBus.addEventListener('ssh-data-raw', handler)
  return () => mockBus.removeEventListener('ssh-data-raw', handler)
}
