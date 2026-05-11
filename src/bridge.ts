import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  ConnectionProfile,
  RemoteFileList,
  SshDataEvent,
  SshDisconnectedEvent,
  SystemUsage,
} from './types'

type UnlistenFn = () => void

const mockBus = new EventTarget()
const mockSessions = new Map<string, { prompt: string; connected: boolean }>()

const isTauriRuntime = () =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

const emitMock = <T>(eventName: string, payload: T) => {
  mockBus.dispatchEvent(new CustomEvent(eventName, { detail: payload }))
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
    emitMock<SshDataEvent>('ssh-data', {
      session_id,
      data: `Connected to ${config.name} (${config.host})\r\n${prompt}`,
    })
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
    emitMock<SshDataEvent>('ssh-data', { session_id, data: '\b \b' })
    return
  }

  if (data === '\r') {
    emitMock<SshDataEvent>('ssh-data', { session_id, data: `\r\n${session.prompt}` })
    return
  }

  emitMock<SshDataEvent>('ssh-data', { session_id, data })
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
  }
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

export async function sshDownloadFile(
  config: ConnectionProfile,
  remote_path: string,
  session_id?: string,
) {
  if (isTauriRuntime()) {
    return invoke<string>('ssh_download_file', { config, remotePath: remote_path, sessionId: session_id })
  }

  return `Downloads/${remote_path.split('/').pop() || 'download'}`
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
