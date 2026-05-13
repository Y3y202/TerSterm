<script setup lang="ts">
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import Zmodem from 'zmodem.js'
import {
  ArrowUpOutlined,
  CloseOutlined,
  DownloadOutlined,
  FileOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  LinkOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  UploadOutlined,
} from '@ant-design/icons-vue'
import { Modal, message } from 'ant-design-vue'
import {
  onSshDataRaw,
  onSshDisconnected,
  saveLocalFile,
  sshDownloadFile,
  sshListFiles,
  sshResize,
  sshUploadFile,
  sshWriteBinary,
} from '../bridge'
import { t } from '../i18n'
import type { RemoteFileEntry, SshPane } from '../types'

const props = defineProps<{
  pane: SshPane
  active: boolean
  appTheme: 'sage' | 'ocean' | 'dawn'
}>()

const emit = defineEmits<{
  focus: [paneId: string]
  disconnect: [paneId: string]
  close: [paneId: string]
  connect: [paneId: string]
  input: [payload: { pane_id: string; data: string }]
  zmodem: [payload: { pane_id: string; active: boolean }]
  authenticated: [payload: { pane_id: string; session_id: string }]
  disconnected: [payload: { pane_id: string; session_id: string; reason?: string }]
}>()

const terminalHost = ref<HTMLDivElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const zmodemInput = ref<HTMLInputElement | null>(null)
const fileManagerOpen = ref(false)
const remotePath = ref('~')
const remoteFiles = ref<RemoteFileEntry[]>([])
const fileError = ref('')
const fileLoading = ref(false)
const transferring = ref(false)
const dragActive = ref(false)
const zmodemActive = ref(false)
const zmodemProgress = ref<{
  direction: 'upload' | 'download'
  fileName: string
  transferredBytes: number
  totalBytes: number
  fileIndex?: number
  fileCount?: number
  startedAt: number
  updatedAt: number
} | null>(null)

let terminal: Terminal | undefined
let fitAddon: FitAddon | undefined
let resizeObserver: ResizeObserver | undefined
let unlistenData: (() => void) | undefined
let unlistenDisconnected: (() => void) | undefined
let inputBuffer = ''
let refreshTimer: number | undefined
let refreshRequestId = 0
let queuedRefreshPath: string | undefined
let authProbeBuffer = ''
let authenticatedSessionId: string | undefined
let zmodemSentry: any
let zmodemSession: any
let terminalTextDecoder = new TextDecoder()

const isConnected = computed(() => props.pane.status === 'connected' && !!props.pane.session_id)
const shouldSuppressConfiguredPassphrasePrompt = computed(
  () => props.pane.private_key_passphrase_origin === 'configured',
)

const terminalThemes = {
  sage: {
    background: '#101417',
    foreground: '#d6dde4',
    cursor: '#58c4a6',
    black: '#111418',
    blue: '#70a5ff',
    cyan: '#65d6d4',
    green: '#71d27b',
    magenta: '#c792ea',
    red: '#ff736a',
    white: '#d6dde4',
    yellow: '#ffd166',
  },
  ocean: {
    background: '#0f1722',
    foreground: '#d7e2f4',
    cursor: '#6bb7ff',
    black: '#10161f',
    blue: '#7bb3ff',
    cyan: '#68d6df',
    green: '#7ad3b5',
    magenta: '#b7a4ff',
    red: '#ff7d7d',
    white: '#d7e2f4',
    yellow: '#ffd27a',
  },
  dawn: {
    background: '#17110c',
    foreground: '#f0ddd0',
    cursor: '#f3a65d',
    black: '#130f0b',
    blue: '#8cb6ff',
    cyan: '#7dd6cf',
    green: '#95d27c',
    magenta: '#d6a4e7',
    red: '#ff8d78',
    white: '#f0ddd0',
    yellow: '#ffcf70',
  },
} as const

const resolveTerminalTheme = () => terminalThemes[props.appTheme] ?? terminalThemes.sage
const zmodemProgressPercent = computed(() => {
  const progress = zmodemProgress.value
  if (!progress || progress.totalBytes <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((progress.transferredBytes / progress.totalBytes) * 100)))
})
const zmodemProgressTitle = computed(() => {
  const progress = zmodemProgress.value
  if (!progress) return ''
  return progress.direction === 'upload' ? t('zmodemUploading') : t('zmodemDownloading')
})

const formatTransferBytes = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
}

const formatDuration = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s'

  const totalSeconds = Math.ceil(seconds)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const secs = totalSeconds % 60

  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

const zmodemProgressSpeedValue = computed(() => {
  const progress = zmodemProgress.value
  if (!progress) return 0

  const elapsedSeconds = Math.max(0.1, (progress.updatedAt - progress.startedAt) / 1000)
  return progress.transferredBytes / elapsedSeconds
})

const zmodemProgressTransferredLabel = computed(() => {
  const progress = zmodemProgress.value
  if (!progress) return ''
  if (progress.totalBytes > 0) {
    return `${formatTransferBytes(progress.transferredBytes)} / ${formatTransferBytes(progress.totalBytes)}`
  }
  return formatTransferBytes(progress.transferredBytes)
})

const zmodemProgressSpeedLabel = computed(() => {
  if (!zmodemProgress.value) return ''
  return `${formatTransferBytes(zmodemProgressSpeedValue.value)}/s`
})

const zmodemProgressRemainingLabel = computed(() => {
  const progress = zmodemProgress.value
  if (!progress) return ''
  if (progress.totalBytes <= 0 || progress.transferredBytes >= progress.totalBytes) return t('zmodemRemainingDone')
  if (zmodemProgressSpeedValue.value <= 0) return t('zmodemRemainingUnknown')

  const remainingSeconds = (progress.totalBytes - progress.transferredBytes) / zmodemProgressSpeedValue.value
  return formatDuration(remainingSeconds)
})

const setZmodemProgress = (progress: {
  direction: 'upload' | 'download'
  fileName: string
  transferredBytes: number
  totalBytes: number
  fileIndex?: number
  fileCount?: number
}) => {
  const current = zmodemProgress.value
  const now = Date.now()
  const isSameTransfer =
    current?.direction === progress.direction &&
    current.fileName === progress.fileName &&
    current.fileIndex === progress.fileIndex &&
    current.fileCount === progress.fileCount

  zmodemProgress.value = {
    ...progress,
    startedAt: isSameTransfer ? current.startedAt : now,
    updatedAt: now,
  }
}

const clearZmodemProgress = () => {
  zmodemProgress.value = null
}

const resetTerminalTextDecoder = () => {
  terminalTextDecoder = new TextDecoder()
}

const octetsToBase64 = (octets: ArrayLike<number>) => {
  let binary = ''
  for (let index = 0; index < octets.length; index += 1) {
    binary += String.fromCharCode(octets[index] || 0)
  }
  return btoa(binary)
}

const base64ToOctets = (data_base64: string) => Uint8Array.from(atob(data_base64), (char) => char.charCodeAt(0))

const payloadsToBase64 = (payloads: Uint8Array[]) => {
  const totalLength = payloads.reduce((sum, payload) => sum + payload.length, 0)
  const merged = new Uint8Array(totalLength)
  let offset = 0

  payloads.forEach((payload) => {
    merged.set(payload, offset)
    offset += payload.length
  })

  return octetsToBase64(merged)
}

const setZmodemActive = (active: boolean) => {
  if (zmodemActive.value === active) return
  zmodemActive.value = active
  emit('zmodem', { pane_id: props.pane.id, active })
}

const finishZmodemSession = () => {
  zmodemSession = undefined
  clearZmodemProgress()
  setZmodemActive(false)
}

const writeTerminalOctets = (octets: ArrayLike<number>) => {
  const bytes = octets instanceof Uint8Array ? octets : Uint8Array.from(octets)
  const text = terminalTextDecoder.decode(bytes, { stream: true })
  if (text) {
    terminal?.write(text)
  }
}

const sendZmodemFiles = async (session: any, files: File[]) => {
  let bytesRemaining = files.reduce((sum, file) => sum + file.size, 0)

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]
    setZmodemProgress({
      direction: 'upload',
      fileName: file.name,
      transferredBytes: 0,
      totalBytes: file.size,
      fileIndex: index + 1,
      fileCount: files.length,
    })

    const transfer = await session.send_offer({
      name: file.name,
      size: file.size,
      mtime: new Date(file.lastModified),
      files_remaining: files.length - index,
      bytes_remaining: bytesRemaining,
    })

    bytesRemaining -= file.size
    if (!transfer) {
      continue
    }

    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.length === 0) {
      setZmodemProgress({
        direction: 'upload',
        fileName: file.name,
        transferredBytes: 0,
        totalBytes: 0,
        fileIndex: index + 1,
        fileCount: files.length,
      })
      await transfer.end(new Uint8Array())
      continue
    }

    const chunkSize = 8192
    const finalChunkOffset = Math.max(0, bytes.length - chunkSize)
    for (let offset = 0; offset < finalChunkOffset; offset += chunkSize) {
      const chunk = bytes.slice(offset, offset + chunkSize)
      transfer.send(chunk)
      setZmodemProgress({
        direction: 'upload',
        fileName: file.name,
        transferredBytes: Math.min(bytes.length, offset + chunk.length),
        totalBytes: bytes.length,
        fileIndex: index + 1,
        fileCount: files.length,
      })
    }

    const finalChunk = bytes.slice(finalChunkOffset)
    await transfer.end(finalChunk)
    setZmodemProgress({
      direction: 'upload',
      fileName: file.name,
      transferredBytes: bytes.length,
      totalBytes: bytes.length,
      fileIndex: index + 1,
      fileCount: files.length,
    })
  }

  await session.close()
}

const handleZmodemSendSelection = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || [])
  const session = zmodemSession

  if (!session) {
    input.value = ''
    return
  }

  if (files.length === 0) {
    session.abort?.()
    finishZmodemSession()
    return
  }

  try {
    await sendZmodemFiles(session, files)
    message.success(t('filesUploadedCount', files.length))
  } catch (error) {
    session.abort?.()
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    input.value = ''
    finishZmodemSession()
  }
}

const handleZmodemDetection = (detection: any) => {
  if (!props.pane.session_id) {
    detection.deny()
    return
  }

  const session = detection.confirm()
  zmodemSession = session
  setZmodemActive(true)

  session.on('session_end', () => {
    finishZmodemSession()
  })

  if (session.get_role?.() === 'send') {
    zmodemInput.value?.click()
    return
  }

  session.on('offer', (offer: any) => {
    const details = offer.get_details()
    setZmodemProgress({
      direction: 'download',
      fileName: details.name,
      transferredBytes: 0,
      totalBytes: details.size || 0,
    })
    offer
      .accept({
        on_input: (payload: Uint8Array) => {
          const currentProgress = zmodemProgress.value
          const transferredBefore =
            currentProgress && currentProgress.fileName === details.name ? currentProgress.transferredBytes : 0
          setZmodemProgress({
            direction: 'download',
            fileName: details.name,
            transferredBytes: Math.min(
              details.size || Number.MAX_SAFE_INTEGER,
              transferredBefore + payload.length,
            ),
            totalBytes: details.size || 0,
          })
        },
      })
      .then(async (payloads: Uint8Array[]) => {
        setZmodemProgress({
          direction: 'download',
          fileName: details.name,
          transferredBytes: details.size || zmodemProgress.value?.transferredBytes || 0,
          totalBytes: details.size || zmodemProgress.value?.totalBytes || 0,
        })
        const localPath = await saveLocalFile(details.name, payloadsToBase64(payloads))
        message.success(t('downloadedTo', localPath))
      })
      .catch((error: unknown) => {
        message.error(error instanceof Error ? error.message : String(error))
      })
  })

  Promise.resolve(session.start()).catch((error: unknown) => {
    message.error(error instanceof Error ? error.message : String(error))
    session.abort?.()
    finishZmodemSession()
  })
}

const createZmodemSentry = () =>
  new Zmodem.Sentry({
    to_terminal: (octets: ArrayLike<number>) => writeTerminalOctets(octets),
    sender: (octets: ArrayLike<number>) => {
      if (!props.pane.session_id) return
      void sshWriteBinary(props.pane.session_id, octetsToBase64(octets))
    },
    on_detect: (detection: any) => handleZmodemDetection(detection),
    on_retract: () => {},
  })

const resetZmodemRuntime = () => {
  zmodemSession = undefined
  clearZmodemProgress()
  setZmodemActive(false)
  zmodemSentry = createZmodemSentry()
}

const stripConfiguredPassphrasePrompt = (data: string) =>
  data.replace(/Enter passphrase for key[^\r\n]*:\s*/gi, '')

const stripTerminalControlSequences = (output: string) =>
  output.replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, '')

const outputLines = (output: string) =>
  output
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean)

const lineLooksLikeShellPrompt = (line: string) =>
  /[@][^\s:]+(?::|[~/]|\s+)[^\r\n]*[#>$%]$/.test(line) ||
  /^\[[^\]]+\][#>$%]$/.test(line) ||
  /^[^\s]{1,80}[#>$%]$/.test(line)

const outputLooksAuthenticated = (output: string) => {
  const normalized = stripTerminalControlSequences(output)
  const trailingLines = outputLines(normalized).slice(-8)

  return (
    normalized.includes('Welcome to ') ||
    normalized.includes('Last login:') ||
    trailingLines.some(lineLooksLikeShellPrompt)
  )
}

const trackAuthenticatedOutput = (session_id: string, data: string) => {
  if (authenticatedSessionId === session_id) return

  authProbeBuffer = `${authProbeBuffer}${data}`.slice(-12000)
  if (!outputLooksAuthenticated(authProbeBuffer)) return

  authenticatedSessionId = session_id
  emit('authenticated', { pane_id: props.pane.id, session_id })
}

const remoteFeaturesReady = computed(() => isConnected.value && props.pane.remote_features_ready)
const fileManagerStatusText = computed(() => {
  if (!remoteFeaturesReady.value) return t('waitAuthForFiles')
  if (fileLoading.value) return t('loadingFiles')
  if (fileError.value) return fileError.value
  return t('emptyDirectory')
})
const statusText = computed(() => {
  if (props.pane.status === 'connecting') return t('statusConnecting')
  if (props.pane.status === 'connected') return t('statusConnected')
  if (props.pane.status === 'error') return t('statusError')
  if (props.pane.status === 'closed') return t('statusClosed')
  return t('statusDisconnected')
})

const formatPercent = (value: number) => `${Math.max(0, value).toFixed(1)}%`

const formatGbPair = (used: number, total: number) => {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return '--/--G'

  return `${Math.max(0, used).toFixed(1)}/${Math.max(0, total).toFixed(1)}G`
}

const fitTerminal = () => {
  if (!terminal || !fitAddon || !terminalHost.value) return

  fitAddon.fit()
  const dimensions = fitAddon.proposeDimensions()
  if (dimensions && props.pane.session_id) {
    void sshResize(props.pane.session_id, dimensions.cols, dimensions.rows)
  }
}

const focusPane = () => {
  emit('focus', props.pane.id)
  terminal?.focus()
}

const resetTerminal = (notice?: string) => {
  resetTerminalTextDecoder()
  terminal?.reset()
  if (notice) {
    terminal?.writeln(notice)
  }
}

const disconnectPane = () => emit('disconnect', props.pane.id)

const closePane = () => emit('close', props.pane.id)

const resetFileManagerState = () => {
  refreshRequestId += 1
  if (refreshTimer) {
    window.clearTimeout(refreshTimer)
    refreshTimer = undefined
  }
  queuedRefreshPath = undefined
  remotePath.value = '~'
  remoteFiles.value = []
  fileError.value = ''
  fileLoading.value = false
  transferring.value = false
  dragActive.value = false
  fileManagerOpen.value = false
  if (fileInput.value) fileInput.value.value = ''
}

const normalizePath = (path: string) => {
  const combined = path.startsWith('/') || path.startsWith('~') ? path : `${remotePath.value}/${path}`
  const segments: string[] = []
  const home = combined === '~' || combined.startsWith('~/')
  const value = home ? combined.slice(1) : combined

  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }

  if (home) return segments.length ? `~/${segments.join('/')}` : '~'
  return `/${segments.join('/')}`.replace(/\/+$/, '') || '/'
}

const normalizeTypedCdTarget = (target: string) => {
  const trimmed = target.trim()
  if (!trimmed || trimmed === '~') return '~'
  if (trimmed === '-') return remotePath.value

  const unquoted = trimmed.replace(/^(['"])(.*)\1$/, '$2')
  return normalizePath(unquoted)
}

const applyTrackedCommand = (command: string) => {
  const cdMatch = command.trim().match(/^cd(?:\s+(.+))?$/)
  if (!cdMatch) return

  applyRemotePath(normalizeTypedCdTarget(cdMatch[1] || '~'))
}

const applyRemotePath = (path: string) => {
  const nextPath = normalizePath(path)
  if (nextPath === remotePath.value) return

  remotePath.value = nextPath
  if (fileManagerOpen.value) {
    scheduleRefreshFiles(nextPath)
  }
}

const trackShellInput = (data: string) => {
  for (const char of data) {
    if (char === '\u0003') {
      inputBuffer = ''
      continue
    }

    if (char === '\u007f' || char === '\b') {
      inputBuffer = inputBuffer.slice(0, -1)
      continue
    }

    if (char === '\r' || char === '\n') {
      const command = inputBuffer
      inputBuffer = ''
      applyTrackedCommand(command)
      continue
    }

    if (char >= ' ' && char !== '\u007f') {
      inputBuffer += char
    }
  }
}

const trackOscCurrentDirectory = (data: string) => {
  const osc7Pattern = /\u001b\]7;file:\/\/[^\u0007/]*(\/[^\u0007]*)\u0007/g
  let match: RegExpExecArray | null = osc7Pattern.exec(data)
  let lastPath: string | undefined

  while (match) {
    lastPath = decodeURIComponent(match[1])
    match = osc7Pattern.exec(data)
  }

  if (lastPath) {
    applyRemotePath(lastPath)
  }
}

const trackPromptCurrentDirectory = (data: string) => {
  const text = data.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
  const promptPattern = /(?:^|\r|\n)[^\s@]+@[^:\r\n]+:(\/[^\r\n#$]*|~(?:\/[^\r\n#$]*)?)[#$]\s*/g
  let match: RegExpExecArray | null = promptPattern.exec(text)
  let lastPath: string | undefined

  while (match) {
    lastPath = match[1].trim()
    match = promptPattern.exec(text)
  }

  if (lastPath) {
    applyRemotePath(lastPath)
  }
}

const fileToBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result)
    }
    reader.onerror = () => reject(reader.error || new Error(t('readFileFailed')))
    reader.readAsDataURL(file)
  })

const formatBytes = (size?: number) => {
  if (!size) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

const describeUploadFiles = (files: File[]) => {
  if (files.length === 1) return files[0].name

  return t('fileCount', files.length)
}

const refreshFiles = async (path = remotePath.value) => {
  const sessionId = props.pane.session_id
  if (!props.pane.connection || !sessionId) return
  if (!remoteFeaturesReady.value) {
    queuedRefreshPath = path
    return
  }
  const requestId = ++refreshRequestId

  fileLoading.value = true
  fileError.value = ''
  try {
    const result = await sshListFiles(props.pane.connection, path, sessionId)
    if (requestId !== refreshRequestId || props.pane.session_id !== sessionId) return
    remotePath.value = result.path
    remoteFiles.value = result.entries
    fileError.value = ''
  } catch (error) {
    if (requestId !== refreshRequestId || props.pane.session_id !== sessionId) return
    fileError.value = error instanceof Error ? error.message : String(error)
    message.error(fileError.value)
  } finally {
    if (requestId === refreshRequestId) {
      fileLoading.value = false
      const nextPath = queuedRefreshPath
      queuedRefreshPath = undefined
      if (nextPath && nextPath !== path) {
        scheduleRefreshFiles(nextPath)
      }
    }
  }
}

const scheduleRefreshFiles = (path = remotePath.value) => {
  queuedRefreshPath = path
  if (refreshTimer) {
    window.clearTimeout(refreshTimer)
  }

  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined
    if (fileLoading.value) return
    const nextPath = queuedRefreshPath
    queuedRefreshPath = undefined
    void refreshFiles(nextPath || remotePath.value)
  }, 350)
}

const openFileManager = async () => {
  if (!isConnected.value) {
    message.warning(t('connectHostFirst'))
    return
  }

  fileManagerOpen.value = !fileManagerOpen.value
  if (!fileManagerOpen.value) return

  if (!remoteFeaturesReady.value) {
    queuedRefreshPath = remotePath.value
    return
  }

  if (fileManagerOpen.value && remoteFiles.value.length === 0) {
    await refreshFiles()
  }
}

const enterDirectory = async (entry: RemoteFileEntry) => {
  if (entry.kind !== 'directory') return
  await refreshFiles(entry.path)
}

const uploadFiles = async (files: File[]) => {
  if (!props.pane.connection || !remoteFeaturesReady.value || files.length === 0) return

  transferring.value = true
  try {
    for (const file of files) {
      const content = await fileToBase64(file)
      await sshUploadFile(props.pane.connection, remotePath.value, file.name, content, props.pane.session_id)
    }
    message.success(files.length === 1 ? t('filesUploaded') : t('filesUploadedCount', files.length))
    await refreshFiles()
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    transferring.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

const chooseUploadFiles = () => {
  if (!remoteFeaturesReady.value) {
    message.warning(t('finishAuthBeforeUpload'))
    return
  }

  fileInput.value?.click()
}

const handleFileInput = (event: Event) => {
  const input = event.target as HTMLInputElement
  void uploadFiles(Array.from(input.files || []))
}

const downloadFile = async (entry: RemoteFileEntry) => {
  if (!props.pane.connection || !remoteFeaturesReady.value || entry.kind === 'directory') return

  transferring.value = true
  try {
    const localPath = await sshDownloadFile(props.pane.connection, entry.path, props.pane.session_id)
    message.success(t('downloadedTo', localPath))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    transferring.value = false
  }
}

const handleDragOver = () => {
  if (!remoteFeaturesReady.value) return
  dragActive.value = true
}

const handleDragLeave = (event: DragEvent) => {
  if (!terminalHost.value?.contains(event.relatedTarget as Node | null)) {
    dragActive.value = false
  }
}

const handleDrop = async (event: DragEvent) => {
  dragActive.value = false
  if (!props.pane.connection || !isConnected.value) {
    message.warning(t('connectHostFirst'))
    return
  }

  if (!remoteFeaturesReady.value) {
    message.warning(t('finishAuthBeforeTransfer'))
    return
  }

  const files = Array.from(event.dataTransfer?.files || [])
  if (files.length === 0) return

  const targetHost = props.pane.connection.name || props.pane.connection.host
  const targetPath = remotePath.value

  Modal.confirm({
    title: t('uploadToTarget', targetHost),
    content: t('confirmUploadFiles', describeUploadFiles(files), targetPath),
    okText: t('upload'),
    cancelText: t('cancel'),
    async onOk() {
      fileManagerOpen.value = true
      await uploadFiles(files)
    },
  })
}

watch(
  remoteFeaturesReady,
  (ready) => {
    if (
      ready &&
      fileManagerOpen.value &&
      !fileLoading.value &&
      (remoteFiles.value.length === 0 || queuedRefreshPath)
    ) {
      const nextPath = queuedRefreshPath || remotePath.value
      queuedRefreshPath = undefined
      void refreshFiles(nextPath)
    }
  },
)

watch(
  () => props.pane.status,
  (status) => {
    if (!terminal) return

    if (status === 'connecting' && props.pane.connection) {
      resetTerminal(t('connectingTo', props.pane.connection.name, props.pane.connection.host))
      resetZmodemRuntime()
    }

    if (status === 'idle') {
      resetTerminal()
      resetFileManagerState()
      resetZmodemRuntime()
    }

    if (status === 'closed' || status === 'error') {
      resetFileManagerState()
      resetZmodemRuntime()
    }

    if (status === 'error' && props.pane.error) {
      terminal.writeln(`\r\n${props.pane.error}`)
    }
  },
)

watch(
  () => props.pane.session_id,
  async (session_id) => {
    authProbeBuffer = ''
    authenticatedSessionId = undefined
    resetFileManagerState()
     resetTerminalTextDecoder()
     resetZmodemRuntime()
    if (!session_id) return
    await nextTick()
    fitTerminal()
    terminal?.focus()
  },
)

watch(
  () => props.appTheme,
  () => {
    if (!terminal) return
    terminal.options.theme = resolveTerminalTheme()
  },
)

onMounted(async () => {
  terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'Cascadia Mono, JetBrains Mono, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.08,
    scrollback: 5000,
    theme: resolveTerminalTheme(),
  })
  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(terminalHost.value!)
  zmodemSentry = createZmodemSentry()
  if (props.pane.terminal_output) {
    terminal.write(props.pane.terminal_output)
  }

  terminal.onData((data) => {
    if (
      !props.pane.session_id ||
      (props.pane.status !== 'connecting' && props.pane.status !== 'connected')
    ) {
      return
    }
    trackShellInput(data)
    emit('input', { pane_id: props.pane.id, data })
  })

  resizeObserver = new ResizeObserver(() => fitTerminal())
  resizeObserver.observe(terminalHost.value!)

  unlistenData = await onSshDataRaw(({ session_id, data_base64 }) => {
    if (session_id !== props.pane.session_id) return
    const bytes = base64ToOctets(data_base64)
    zmodemSentry?.consume(bytes)
    if (zmodemActive.value) return

    const decodedData = new TextDecoder().decode(bytes)
    const visibleData = shouldSuppressConfiguredPassphrasePrompt.value
      ? stripConfiguredPassphrasePrompt(decodedData)
      : decodedData
    trackAuthenticatedOutput(session_id, visibleData)
    trackOscCurrentDirectory(visibleData)
    trackPromptCurrentDirectory(visibleData)
  })

  unlistenDisconnected = await onSshDisconnected(({ session_id, reason }) => {
    if (session_id !== props.pane.session_id) return
    emit('disconnected', {
      pane_id: props.pane.id,
      session_id,
      reason,
    })
  })

  window.setTimeout(fitTerminal, 80)
})

onBeforeUnmount(() => {
  zmodemSession?.abort?.()
  finishZmodemSession()
  resetFileManagerState()
  resizeObserver?.disconnect()
  unlistenData?.()
  unlistenDisconnected?.()
  terminal?.dispose()
})

defineExpose({
  fitTerminal,
  focusTerminal: () => terminal?.focus(),
})
</script>

<template>
  <section
    class="terminal-pane"
    :class="{ active, empty: pane.status === 'idle', dragging: dragActive }"
    @mousedown="focusPane"
    @dragenter.capture.prevent="handleDragOver"
    @dragover.capture.prevent="handleDragOver"
    @dragleave.capture="handleDragLeave"
    @drop.capture.prevent="handleDrop"
  >
    <header class="pane-header">
      <div class="pane-title">
        <span class="status-dot" :class="pane.status" />
        <div>
          <strong>{{ pane.title }}</strong>
          <span>{{ statusText }}</span>
        </div>
      </div>
      <div v-if="isConnected" class="pane-metrics">
        <span v-if="pane.system_usage">CPU {{ formatPercent(pane.system_usage.cpu_percent) }}</span>
        <span v-if="pane.system_usage">
          {{ t('resourceMemory') }} {{ formatGbPair(pane.system_usage.memory_used_gb, pane.system_usage.memory_total_gb) }}
        </span>
        <span v-if="pane.system_usage">
          {{ t('resourceStorage') }} {{ formatGbPair(pane.system_usage.storage_used_gb, pane.system_usage.storage_total_gb) }}
        </span>
        <span
          v-if="!pane.system_usage && pane.system_usage_loading"
          :title="t('resourceLoadingTitle')"
        >
          {{ t('resourceLoading') }}
        </span>
        <span v-else-if="!pane.system_usage && pane.system_usage_error" :title="pane.system_usage_error">
          {{ t('resourceError') }}
        </span>
        <span v-else-if="!pane.system_usage">{{ t('resourceUnknown') }}</span>
      </div>
      <div class="pane-actions">
        <a-tooltip :title="t('fileManager')">
          <a-button
            type="text"
            size="small"
            :icon="h(FolderOpenOutlined)"
            :disabled="!isConnected"
            @click.stop="openFileManager"
          />
        </a-tooltip>
        <a-tooltip :title="t('disconnect')">
          <a-button
            type="text"
            size="small"
            :icon="h(PoweroffOutlined)"
            :disabled="!isConnected"
            @click.stop="disconnectPane"
          />
        </a-tooltip>
        <a-tooltip :title="t('close')">
          <a-button
            type="text"
            size="small"
            :icon="h(CloseOutlined)"
            @click.stop="closePane"
          />
        </a-tooltip>
      </div>
    </header>

    <div v-if="zmodemProgress" class="zmodem-progress">
      <div class="zmodem-progress-row">
        <span class="zmodem-progress-meta">
          <strong>{{ zmodemProgressTitle }}</strong>
          <small>{{ zmodemProgress.fileName }}</small>
        </span>
        <span class="zmodem-progress-side">
          <small v-if="zmodemProgress.fileCount">{{ t('zmodemProgressCount', zmodemProgress.fileIndex || 1, zmodemProgress.fileCount) }}</small>
          <strong>{{ zmodemProgressPercent }}%</strong>
        </span>
      </div>
      <span class="zmodem-progress-track"><i :style="{ width: `${zmodemProgressPercent}%` }" /></span>
      <div class="zmodem-progress-stats">
        <small>{{ zmodemProgressTransferredLabel }}</small>
        <small>{{ t('zmodemSpeedLabel') }} {{ zmodemProgressSpeedLabel }}</small>
        <small>{{ t('zmodemRemainingLabel') }} {{ zmodemProgressRemainingLabel }}</small>
      </div>
    </div>

    <div v-if="fileManagerOpen" class="file-manager" @mousedown.stop>
      <div class="file-manager-toolbar">
        <a-input
          v-model:value="remotePath"
          size="small"
          :disabled="fileLoading || transferring"
          @press-enter="refreshFiles()"
        />
        <a-tooltip :title="t('parentDirectory')">
          <a-button
            size="small"
            :icon="h(ArrowUpOutlined)"
            :disabled="fileLoading || transferring"
            @click="refreshFiles(`${remotePath}/..`)"
          />
        </a-tooltip>
        <a-tooltip :title="t('refresh')">
          <a-button
            size="small"
            :icon="h(ReloadOutlined)"
            :loading="fileLoading"
            @click="refreshFiles()"
          />
        </a-tooltip>
        <a-tooltip :title="t('uploadFile')">
          <a-button
            size="small"
            :icon="h(UploadOutlined)"
            :loading="transferring"
            @click="chooseUploadFiles"
          />
        </a-tooltip>
        <input ref="fileInput" type="file" multiple hidden @change="handleFileInput" />
        <input ref="zmodemInput" type="file" multiple hidden @change="handleZmodemSendSelection" />
      </div>

      <div class="file-list" :class="{ loading: fileLoading }">
        <button
          v-for="entry in remoteFiles"
          :key="`${entry.path}-${entry.name}`"
          class="file-row"
          type="button"
          @dblclick="enterDirectory(entry)"
        >
          <span class="file-icon">
            <FolderOutlined v-if="entry.kind === 'directory'" />
            <FileOutlined v-else />
          </span>
          <span class="file-name">{{ entry.name }}</span>
          <span class="file-meta">{{ entry.kind === 'directory' ? '' : formatBytes(entry.size) }}</span>
          <span class="file-meta">{{ entry.modified }}</span>
          <span class="file-actions">
            <a-tooltip v-if="entry.kind !== 'directory'" :title="t('download')">
              <a-button
                type="text"
                size="small"
                :icon="h(DownloadOutlined)"
                :loading="transferring"
                @click.stop="downloadFile(entry)"
              />
            </a-tooltip>
          </span>
        </button>
        <div v-if="fileLoading && remoteFiles.length === 0" class="file-empty">
          {{ fileManagerStatusText }}
        </div>
        <div v-else-if="!fileLoading && fileError" class="file-empty">{{ fileManagerStatusText }}</div>
        <div v-else-if="!fileLoading && remoteFiles.length === 0" class="file-empty">
          {{ fileManagerStatusText }}
        </div>
      </div>
    </div>

    <div ref="terminalHost" class="terminal-host" />

    <div v-if="dragActive" class="drop-overlay">
      <UploadOutlined />
      <span>{{ t('dropToUpload', remotePath) }}</span>
    </div>

    <div v-if="pane.status === 'idle'" class="pane-empty">
      <a-button type="primary" :icon="h(LinkOutlined)" @click.stop="emit('connect', pane.id)">
        {{ t('connectHost') }}
      </a-button>
    </div>
  </section>
</template>
