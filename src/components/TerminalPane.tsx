import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type MouseEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import Zmodem from 'zmodem.js'
import {
  ArrowUp,
  Download,
  File as FileIcon,
  Folder,
  FolderOpen,
  Link2,
  Power,
  RefreshCw,
  SquareTerminal,
  Upload,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  onSshFileDownloadProgress,
  onSshDataRaw,
  onSshDisconnected,
  saveLocalFile,
  sshDownloadFile,
  sshListFiles,
  sshResize,
  sshUploadFile,
  sshWriteBinary,
} from '../bridge'
import i18n from '../i18n'
import { cn } from '../lib/utils'
import { useStateRef } from '../lib/use-state-ref'
import type { ConnectionProfile, RemoteFileEntry, SshPane } from '../types'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

type AppThemeId = 'sage' | 'ocean' | 'dawn' | 'violet' | 'slate'

export interface TerminalPaneHandle {
  fitTerminal: () => void
  focusTerminal: () => void
}

interface TerminalPaneProps {
  pane: SshPane
  active: boolean
  appTheme: AppThemeId
  onFocus: (paneId: string) => void
  onDisconnect: (paneId: string) => void
  onClose: (paneId: string) => void
  onConnect: (paneId: string) => void
  onInput: (payload: { pane_id: string; data: string }) => void
  onZmodem: (payload: { pane_id: string; active: boolean }) => void
  onAuthenticated: (payload: { pane_id: string; session_id: string }) => void
  onDisconnected: (payload: { pane_id: string; session_id: string; reason?: string }) => void
}

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
  violet: {
    background: '#17131f',
    foreground: '#ece6ff',
    cursor: '#b794ff',
    black: '#110d17',
    blue: '#93a4ff',
    cyan: '#7ad4ff',
    green: '#93d977',
    magenta: '#d2a8ff',
    red: '#ff8db5',
    white: '#ece6ff',
    yellow: '#ffd36e',
  },
  slate: {
    background: '#12171d',
    foreground: '#dde5ef',
    cursor: '#94a3b8',
    black: '#0f1318',
    blue: '#8fb4d9',
    cyan: '#7fd0d6',
    green: '#8ecf95',
    magenta: '#b7a7d9',
    red: '#e38c8c',
    white: '#dde5ef',
    yellow: '#e7c980',
  },
} as const

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

const formatBytes = (size?: number) => {
  if (!size) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

const DOWNLOAD_DIRECTORY_STORAGE_KEY = 'tersterm:download-directory'

const readStoredDownloadDirectory = () => {
  if (typeof localStorage === 'undefined') return ''
  return localStorage.getItem(DOWNLOAD_DIRECTORY_STORAGE_KEY) || ''
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

export const TerminalPane = forwardRef<TerminalPaneHandle, TerminalPaneProps>(function TerminalPane(
  props,
  ref,
) {
  const { t } = useTranslation()
  const terminalHostRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const zmodemInputRef = useRef<HTMLInputElement | null>(null)
  const pendingDropFilesRef = useRef<File[]>([])
  const terminalRef = useRef<Terminal>()
  const fitAddonRef = useRef<FitAddon>()
  const resizeObserverRef = useRef<ResizeObserver>()
  const unlistenDataRef = useRef<(() => void)>()
  const unlistenDisconnectedRef = useRef<(() => void)>()
  const unlistenDownloadProgressRef = useRef<(() => void)>()
  const inputBufferRef = useRef('')
  const refreshTimerRef = useRef<number>()
  const refreshRequestIdRef = useRef(0)
  const queuedRefreshPathRef = useRef<string>()
  const activeFileDownloadRef = useRef<{
    sessionId?: string
    remotePath: string
    fileName: string
    totalBytes: number
  } | null>(null)
  const authProbeBufferRef = useRef('')
  const authenticatedSessionIdRef = useRef<string>()
  const zmodemSentryRef = useRef<any>()
  const zmodemSessionRef = useRef<any>()
  const terminalTextDecoderRef = useRef(new TextDecoder())
  const terminalEventTextDecoderRef = useRef(new TextDecoder())
  const latestPropsRef = useRef(props)
  const [fileManagerOpen, setFileManagerOpen, fileManagerOpenRef] = useStateRef(false)
  const [remotePath, setRemotePath, remotePathRef] = useStateRef('~')
  const [remoteFiles, setRemoteFiles, remoteFilesRef] = useStateRef<RemoteFileEntry[]>([])
  const [fileError, setFileError, fileErrorRef] = useStateRef('')
  const [fileLoading, setFileLoading, fileLoadingRef] = useStateRef(false)
  const [downloadDirectory, setDownloadDirectory, downloadDirectoryRef] = useStateRef(readStoredDownloadDirectory())
  const [transferring, setTransferring] = useStateRef(false)
  const [dragActive, setDragActive] = useStateRef(false)
  const [, setZmodemActiveState, zmodemActiveRef] = useStateRef(false)
  const [
    zmodemProgress,
    setZmodemProgressState,
    zmodemProgressRef,
  ] = useStateRef<{
    source: 'zmodem' | 'file-manager'
    direction: 'upload' | 'download'
    fileName: string
    transferredBytes: number
    totalBytes: number
    fileIndex?: number
    fileCount?: number
    startedAt: number
    updatedAt: number
  } | null>(null)
  const [pendingDropUpload, setPendingDropUpload] = useState<{
    targetHost: string
    targetPath: string
    sessionId: string
    fileLabel: string
  } | null>(null)

  useEffect(() => {
    latestPropsRef.current = props
  }, [props])

  const getCurrentPane = () => latestPropsRef.current.pane

  const isConnected = props.pane.status === 'connected' && Boolean(props.pane.session_id)
  const remoteFeaturesReady = isConnected && Boolean(props.pane.remote_features_ready)
  const statusText =
    props.pane.status === 'connecting'
      ? t('statusConnecting')
      : props.pane.status === 'connected'
        ? t('statusConnected')
        : props.pane.status === 'error'
          ? t('statusError')
          : props.pane.status === 'closed'
            ? t('statusClosed')
            : t('statusDisconnected')

  const fileManagerStatusText = !remoteFeaturesReady
    ? t('waitAuthForFiles')
    : fileLoading
      ? t('loadingFiles')
      : fileError || t('emptyDirectory')

  const zmodemProgressPercent =
    zmodemProgress && zmodemProgress.totalBytes > 0
      ? Math.max(0, Math.min(100, Math.round((zmodemProgress.transferredBytes / zmodemProgress.totalBytes) * 100)))
      : 0

  const zmodemProgressSpeedValue = (() => {
    if (!zmodemProgress) return 0
    const elapsedSeconds = Math.max(0.1, (zmodemProgress.updatedAt - zmodemProgress.startedAt) / 1000)
    return zmodemProgress.transferredBytes / elapsedSeconds
  })()

  const zmodemProgressTransferredLabel = zmodemProgress
    ? zmodemProgress.totalBytes > 0
      ? `${formatTransferBytes(zmodemProgress.transferredBytes)} / ${formatTransferBytes(zmodemProgress.totalBytes)}`
      : formatTransferBytes(zmodemProgress.transferredBytes)
    : ''

  const zmodemProgressSpeedLabel = zmodemProgress ? `${formatTransferBytes(zmodemProgressSpeedValue)}/s` : ''
  const zmodemProgressRemainingLabel = !zmodemProgress
    ? ''
    : zmodemProgress.totalBytes <= 0 || zmodemProgress.transferredBytes >= zmodemProgress.totalBytes
      ? t('zmodemRemainingDone')
      : zmodemProgressSpeedValue <= 0
        ? t('zmodemRemainingUnknown')
        : formatDuration((zmodemProgress.totalBytes - zmodemProgress.transferredBytes) / zmodemProgressSpeedValue)
  const zmodemProgressTitle = !zmodemProgress
    ? ''
    : zmodemProgress.source === 'file-manager'
      ? zmodemProgress.direction === 'download'
        ? t('fileDownloading')
        : t('fileUploading')
      : zmodemProgress.direction === 'upload'
        ? t('zmodemUploading')
        : t('zmodemDownloading')

  const resolveTerminalTheme = () => terminalThemes[latestPropsRef.current.appTheme] ?? terminalThemes.sage

  const resetTerminalTextDecoder = () => {
    terminalTextDecoderRef.current = new TextDecoder()
    terminalEventTextDecoderRef.current = new TextDecoder()
  }

  const clearZmodemProgress = (source?: 'zmodem' | 'file-manager') => {
    if (source && zmodemProgressRef.current?.source !== source) return
    setZmodemProgressState(null)
  }

  const setZmodemProgress = (progress: {
    source: 'zmodem' | 'file-manager'
    direction: 'upload' | 'download'
    fileName: string
    transferredBytes: number
    totalBytes: number
    fileIndex?: number
    fileCount?: number
  }) => {
    const current = zmodemProgressRef.current
    const now = Date.now()
    const isSameTransfer =
      current?.source === progress.source &&
      current?.direction === progress.direction &&
      current.fileName === progress.fileName &&
      current.fileIndex === progress.fileIndex &&
      current.fileCount === progress.fileCount

    setZmodemProgressState({
      ...progress,
      startedAt: isSameTransfer && current ? current.startedAt : now,
      updatedAt: now,
    })
  }

  const setZmodemActive = (active: boolean) => {
    if (zmodemActiveRef.current === active) return
    setZmodemActiveState(active)
    latestPropsRef.current.onZmodem({ pane_id: getCurrentPane().id, active })
  }

  const finishZmodemSession = () => {
    zmodemSessionRef.current = undefined
    clearZmodemProgress('zmodem')
    setZmodemActive(false)
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

  const writeTerminalOctets = (octets: ArrayLike<number>) => {
    const bytes = octets instanceof Uint8Array ? octets : Uint8Array.from(octets)
    const text = terminalTextDecoderRef.current.decode(bytes, { stream: true })
    if (text) {
      terminalRef.current?.write(text)
    }
  }

  const createZmodemSentry = () =>
    new Zmodem.Sentry({
      to_terminal: (octets: ArrayLike<number>) => writeTerminalOctets(octets),
      sender: (octets: ArrayLike<number>) => {
        const currentPane = getCurrentPane()
        if (!currentPane.session_id) return
        void sshWriteBinary(currentPane.session_id, octetsToBase64(octets))
      },
      on_detect: (detection: any) => handleZmodemDetection(detection),
      on_retract: () => {},
    })

  const resetZmodemRuntime = () => {
    zmodemSessionRef.current = undefined
    clearZmodemProgress('zmodem')
    setZmodemActive(false)
    zmodemSentryRef.current = createZmodemSentry()
  }

  const fitTerminal = () => {
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (!terminal || !fitAddon || !terminalHostRef.current) return

    fitAddon.fit()
    const dimensions = fitAddon.proposeDimensions()
    const currentPane = getCurrentPane()
    if (dimensions && currentPane.session_id) {
      void sshResize(currentPane.session_id, dimensions.cols, dimensions.rows)
    }
  }

  const focusTerminal = () => terminalRef.current?.focus()

  useImperativeHandle(ref, () => ({
    fitTerminal,
    focusTerminal,
  }))

  const resetTerminal = (notice?: string) => {
    resetTerminalTextDecoder()
    terminalRef.current?.reset()
    if (notice) {
      terminalRef.current?.writeln(notice)
    }
  }

  const resetFileManagerState = () => {
    refreshRequestIdRef.current += 1
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = undefined
    }
    queuedRefreshPathRef.current = undefined
    activeFileDownloadRef.current = null
    clearZmodemProgress('file-manager')
    setRemotePath('~')
    setRemoteFiles([])
    setFileError('')
    setFileLoading(false)
    setTransferring(false)
    setDragActive(false)
    setFileManagerOpen(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const normalizePath = (path: string) => {
    const basePath = remotePathRef.current
    const combined = path.startsWith('/') || path.startsWith('~') ? path : `${basePath}/${path}`
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

  const applyRemotePath = (path: string) => {
    const nextPath = normalizePath(path)
    if (nextPath === remotePathRef.current) return

    setRemotePath(nextPath)
    if (fileManagerOpenRef.current) {
      scheduleRefreshFiles(nextPath)
    }
  }

  const normalizeTypedCdTarget = (target: string) => {
    const trimmed = target.trim()
    if (!trimmed || trimmed === '~') return '~'
    if (trimmed === '-') return remotePathRef.current

    const unquoted = trimmed.replace(/^(['"])(.*)\1$/, '$2')
    return normalizePath(unquoted)
  }

  const applyTrackedCommand = (command: string) => {
    const cdMatch = command.trim().match(/^cd(?:\s+(.+))?$/)
    if (!cdMatch) return

    applyRemotePath(normalizeTypedCdTarget(cdMatch[1] || '~'))
  }

  const trackShellInput = (data: string) => {
    for (const char of data) {
      if (char === '\u0003') {
        inputBufferRef.current = ''
        continue
      }

      if (char === '\u007f' || char === '\b') {
        inputBufferRef.current = inputBufferRef.current.slice(0, -1)
        continue
      }

      if (char === '\r' || char === '\n') {
        const command = inputBufferRef.current
        inputBufferRef.current = ''
        applyTrackedCommand(command)
        continue
      }

      if (char >= ' ' && char !== '\u007f') {
        inputBufferRef.current += char
      }
    }
  }

  const trackOscCurrentDirectory = (data: string) => {
    const osc7Pattern = /\u001b\]7;file:\/\/[^\u0007/]*(\/[^^\u0007]*)\u0007/g
    let match = osc7Pattern.exec(data)
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
    const promptPattern = /(?:^|\r|\n)[^\s@]+@[^:\r\n]+:(\/[^^\r\n#$]*|~(?:\/[^^\r\n#$]*)?)[#$]\s*/g
    let match = promptPattern.exec(text)
    let lastPath: string | undefined

    while (match) {
      lastPath = match[1].trim()
      match = promptPattern.exec(text)
    }

    if (lastPath) {
      applyRemotePath(lastPath)
    }
  }

  const fileToBase64 = (file: File, onProgress?: (loaded: number, total: number) => void) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onprogress = (event) => {
        if (!event.lengthComputable) return
        onProgress?.(event.loaded, event.total || file.size)
      }
      reader.onload = () => {
        onProgress?.(file.size, file.size)
        const result = String(reader.result || '')
        resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result)
      }
      reader.onerror = () => reject(reader.error || new Error(i18n.t('readFileFailed')))
      reader.readAsDataURL(file)
    })

  const describeUploadFiles = (files: File[]) => {
    if (files.length === 1) return files[0].name

    return i18n.t('fileCount', { count: files.length })
  }

  const paneRemoteFeaturesReady = () => {
    const currentPane = getCurrentPane()
    return currentPane.status === 'connected' && Boolean(currentPane.session_id && currentPane.remote_features_ready)
  }

  const resolveDownloadDirectory = () => {
    const trimmed = downloadDirectoryRef.current.trim()
    return trimmed || undefined
  }

  const refreshFiles = async (path = remotePathRef.current) => {
    const currentPane = getCurrentPane()
    const sessionId = currentPane.session_id
    if (!currentPane.connection || !sessionId) return
    if (!paneRemoteFeaturesReady()) {
      queuedRefreshPathRef.current = path
      return
    }

    const requestId = ++refreshRequestIdRef.current
    setFileLoading(true)
    setFileError('')

    try {
      const result = await sshListFiles(currentPane.connection, path, sessionId)
      if (requestId !== refreshRequestIdRef.current || getCurrentPane().session_id !== sessionId) return
      setRemotePath(result.path)
      setRemoteFiles(result.entries)
      setFileError('')
    } catch (error) {
      if (requestId !== refreshRequestIdRef.current || getCurrentPane().session_id !== sessionId) return
      const message = error instanceof Error ? error.message : String(error)
      setFileError(message)
      toast.error(message)
    } finally {
      if (requestId === refreshRequestIdRef.current) {
        setFileLoading(false)
        const nextPath = queuedRefreshPathRef.current
        queuedRefreshPathRef.current = undefined
        if (nextPath && nextPath !== path) {
          scheduleRefreshFiles(nextPath)
        }
      }
    }
  }

  const scheduleRefreshFiles = (path = remotePathRef.current) => {
    queuedRefreshPathRef.current = path
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current)
    }

    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = undefined
      if (fileLoadingRef.current) return
      const nextPath = queuedRefreshPathRef.current
      queuedRefreshPathRef.current = undefined
      void refreshFiles(nextPath || remotePathRef.current)
    }, 350)
  }

  const openFileManager = async () => {
    const currentPane = getCurrentPane()
    if (!(currentPane.status === 'connected' && currentPane.session_id)) {
      toast.warning(i18n.t('connectHostFirst'))
      return
    }

    const nextOpen = !fileManagerOpenRef.current
    setFileManagerOpen(nextOpen)
    if (!nextOpen) return

    if (!paneRemoteFeaturesReady()) {
      queuedRefreshPathRef.current = remotePathRef.current
      return
    }

    if (remoteFilesRef.current.length === 0) {
      await refreshFiles()
    }
  }

  const enterDirectory = async (entry: RemoteFileEntry) => {
    if (entry.kind !== 'directory') return
    await refreshFiles(entry.path)
  }

  const uploadFiles = async (
    files: File[],
    targetPath = remotePathRef.current,
    expectedSessionId = getCurrentPane().session_id,
  ) => {
    const currentPane = getCurrentPane()
    if (!currentPane.connection || !paneRemoteFeaturesReady() || !expectedSessionId || files.length === 0) return

    const getActiveUploadPane = (): SshPane & {
      connection: ConnectionProfile
      remote_features_ready: true
      session_id: string
      status: 'connected'
    } => {
      const pane = getCurrentPane()
      if (
        !(pane.status === 'connected' && pane.session_id === expectedSessionId && pane.connection && pane.remote_features_ready)
      ) {
        throw new Error(i18n.t('uploadInterrupted'))
      }

      return pane as SshPane & {
        connection: ConnectionProfile
        remote_features_ready: true
        session_id: string
        status: 'connected'
      }
    }

    const totalUploadBytes = files.reduce((sum, file) => sum + file.size, 0)
    let completedBytes = 0
    const setFileUploadProgress = (file: File, fileIndex: number, transferredBytes: number) => {
      setZmodemProgress({
        source: 'file-manager',
        direction: 'upload',
        fileName: file.name,
        transferredBytes,
        totalBytes: totalUploadBytes,
        fileIndex,
        fileCount: files.length,
      })
    }

    setTransferring(true)
    try {
      getActiveUploadPane()

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]
        const fileIndex = index + 1
        const uploadWeight = file.size * 0.95

        getActiveUploadPane()
        setFileUploadProgress(file, fileIndex, completedBytes)
        const content = await fileToBase64(file, (loaded, total) => {
          const safeTotal = total > 0 ? total : file.size
          const weightedProgress =
            safeTotal > 0 ? Math.min(uploadWeight, (Math.min(loaded, safeTotal) / safeTotal) * uploadWeight) : 0
          setFileUploadProgress(file, fileIndex, completedBytes + weightedProgress)
        })

        // Keep a small tail so the bar remains visible while the backend writes remotely.
        if (uploadWeight > 0) {
          setFileUploadProgress(file, fileIndex, completedBytes + uploadWeight)
        }

        const activePane = getActiveUploadPane()
        await sshUploadFile(activePane.connection, targetPath, file.name, content, activePane.session_id)
        completedBytes += file.size
        setFileUploadProgress(file, fileIndex, completedBytes)
      }

      clearZmodemProgress('file-manager')
      toast.success(files.length === 1 ? i18n.t('filesUploaded') : i18n.t('filesUploadedCount', { count: files.length }))
      if (fileManagerOpenRef.current && remotePathRef.current === targetPath) {
        await refreshFiles(targetPath)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      clearZmodemProgress('file-manager')
      setTransferring(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const chooseUploadFiles = () => {
    if (!paneRemoteFeaturesReady()) {
      toast.warning(i18n.t('finishAuthBeforeUpload'))
      return
    }

    fileInputRef.current?.click()
  }

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    void uploadFiles(Array.from(event.target.files || []))
  }

  const downloadFile = async (entry: RemoteFileEntry) => {
    const currentPane = getCurrentPane()
    if (!currentPane.connection || !paneRemoteFeaturesReady() || entry.kind === 'directory') return

    setTransferring(true)
    activeFileDownloadRef.current = {
      sessionId: currentPane.session_id,
      remotePath: entry.path,
      fileName: entry.name,
      totalBytes: entry.size || 0,
    }
    setZmodemProgress({
      source: 'file-manager',
      direction: 'download',
      fileName: entry.name,
      transferredBytes: 0,
      totalBytes: entry.size || 0,
    })

    try {
      const localPath = await sshDownloadFile(
        currentPane.connection,
        entry.path,
        currentPane.session_id,
        resolveDownloadDirectory(),
        entry.size,
      )
      toast.success(i18n.t('downloadedTo', { path: localPath }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      activeFileDownloadRef.current = null
      clearZmodemProgress('file-manager')
      setTransferring(false)
    }
  }

  const handleDragOver = () => {
    if (!paneRemoteFeaturesReady()) return
    setDragActive(true)
  }

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!terminalHostRef.current?.contains(event.relatedTarget as Node | null)) {
      setDragActive(false)
    }
  }

  const handleDrop = async (event: DragEvent<HTMLElement>) => {
    setDragActive(false)
    const currentPane = getCurrentPane()
    if (!currentPane.connection || !(currentPane.status === 'connected' && currentPane.session_id)) {
      toast.warning(i18n.t('connectHostFirst'))
      return
    }

    if (!paneRemoteFeaturesReady()) {
      toast.warning(i18n.t('finishAuthBeforeTransfer'))
      return
    }

    const files = Array.from(event.dataTransfer?.files || [])
    if (files.length === 0) return

    const targetHost = currentPane.connection.name || currentPane.connection.host
    const targetPath = remotePathRef.current
    pendingDropFilesRef.current = files
    setPendingDropUpload({
      targetHost,
      targetPath,
      sessionId: currentPane.session_id,
      fileLabel: describeUploadFiles(files),
    })
  }

  const sendZmodemFiles = async (session: any, files: File[]) => {
    let bytesRemaining = files.reduce((sum, file) => sum + file.size, 0)

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      setZmodemProgress({
        source: 'zmodem',
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
      if (!transfer) continue

      const bytes = new Uint8Array(await file.arrayBuffer())
      if (bytes.length === 0) {
        setZmodemProgress({
          source: 'zmodem',
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
          source: 'zmodem',
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
        source: 'zmodem',
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

  const handleZmodemSendSelection = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    const session = zmodemSessionRef.current

    if (!session) {
      event.target.value = ''
      return
    }

    if (files.length === 0) {
      session.abort?.()
      finishZmodemSession()
      return
    }

    try {
      await sendZmodemFiles(session, files)
      toast.success(i18n.t('filesUploadedCount', { count: files.length }))
    } catch (error) {
      session.abort?.()
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      event.target.value = ''
      finishZmodemSession()
    }
  }

  const handleZmodemDetection = (detection: any) => {
    const currentPane = getCurrentPane()
    if (!currentPane.session_id) {
      detection.deny()
      return
    }

    const session = detection.confirm()
    zmodemSessionRef.current = session
    setZmodemActive(true)

    session.on('session_end', () => {
      finishZmodemSession()
    })

    if (session.get_role?.() === 'send') {
      zmodemInputRef.current?.click()
      return
    }

    session.on('offer', (offer: any) => {
      const details = offer.get_details()
      setZmodemProgress({
        source: 'zmodem',
        direction: 'download',
        fileName: details.name,
        transferredBytes: 0,
        totalBytes: details.size || 0,
      })

      offer
        .accept({
          on_input: (payload: Uint8Array) => {
            const currentProgress = zmodemProgressRef.current
            const transferredBefore =
              currentProgress && currentProgress.fileName === details.name ? currentProgress.transferredBytes : 0
            setZmodemProgress({
              source: 'zmodem',
              direction: 'download',
              fileName: details.name,
              transferredBytes: Math.min(details.size || Number.MAX_SAFE_INTEGER, transferredBefore + payload.length),
              totalBytes: details.size || 0,
            })
          },
        })
        .then(async (payloads: Uint8Array[]) => {
          setZmodemProgress({
            source: 'zmodem',
            direction: 'download',
            fileName: details.name,
            transferredBytes: details.size || zmodemProgressRef.current?.transferredBytes || 0,
            totalBytes: details.size || zmodemProgressRef.current?.totalBytes || 0,
          })
          const localPath = await saveLocalFile(details.name, payloadsToBase64(payloads), resolveDownloadDirectory())
          toast.success(i18n.t('downloadedTo', { path: localPath }))
        })
        .catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : String(error))
        })
    })

    Promise.resolve(session.start()).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error))
      session.abort?.()
      finishZmodemSession()
    })
  }

  const trackAuthenticatedOutput = (session_id: string, data: string) => {
    if (authenticatedSessionIdRef.current === session_id) return

    authProbeBufferRef.current = `${authProbeBufferRef.current}${data}`.slice(-12000)
    if (!outputLooksAuthenticated(authProbeBufferRef.current)) return

    authenticatedSessionIdRef.current = session_id
    latestPropsRef.current.onAuthenticated({ pane_id: getCurrentPane().id, session_id })
  }

  useEffect(() => {
    if (typeof localStorage === 'undefined') return

    const trimmed = downloadDirectory.trim()
    if (trimmed) {
      localStorage.setItem(DOWNLOAD_DIRECTORY_STORAGE_KEY, trimmed)
      return
    }

    localStorage.removeItem(DOWNLOAD_DIRECTORY_STORAGE_KEY)
  }, [downloadDirectory])

  useEffect(() => {
    if (
      remoteFeaturesReady &&
      fileManagerOpenRef.current &&
      !fileLoadingRef.current &&
      (remoteFilesRef.current.length === 0 || queuedRefreshPathRef.current)
    ) {
      const nextPath = queuedRefreshPathRef.current || remotePathRef.current
      queuedRefreshPathRef.current = undefined
      void refreshFiles(nextPath)
    }
  }, [remoteFeaturesReady])

  useEffect(() => {
    if (!terminalRef.current) return

    if (props.pane.status === 'connecting' && props.pane.connection) {
      resetTerminal(i18n.t('connectingTo', { name: props.pane.connection.name, host: props.pane.connection.host }))
      resetZmodemRuntime()
    }

    if (props.pane.status === 'idle') {
      resetTerminal()
      resetFileManagerState()
      resetZmodemRuntime()
    }

    if (props.pane.status === 'closed' || props.pane.status === 'error') {
      resetFileManagerState()
      resetZmodemRuntime()
    }

    if (props.pane.status === 'error' && props.pane.error) {
      terminalRef.current.writeln(`\r\n${props.pane.error}`)
    }
  }, [props.pane.status, props.pane.connection, props.pane.error])

  useEffect(() => {
    authProbeBufferRef.current = ''
    authenticatedSessionIdRef.current = undefined
    resetFileManagerState()
    resetTerminalTextDecoder()
    resetZmodemRuntime()
    if (!props.pane.session_id) return

    requestAnimationFrame(() => {
      fitTerminal()
      terminalRef.current?.focus()
    })
  }, [props.pane.session_id])

  useEffect(() => {
    if (!terminalRef.current) return
    terminalRef.current.options.theme = resolveTerminalTheme()
  }, [props.appTheme])

  useEffect(() => {
    let disposed = false

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'Cascadia Mono, JetBrains Mono, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.08,
      scrollback: 5000,
      theme: resolveTerminalTheme(),
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(terminalHostRef.current!)

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    resetZmodemRuntime()

    if (props.pane.terminal_output) {
      terminal.write(props.pane.terminal_output)
    }

    terminal.onData((data) => {
      const currentPane = getCurrentPane()
      if (!currentPane.session_id || (currentPane.status !== 'connecting' && currentPane.status !== 'connected')) {
        return
      }

      trackShellInput(data)
      latestPropsRef.current.onInput({ pane_id: currentPane.id, data })
    })

    resizeObserverRef.current = new ResizeObserver(() => fitTerminal())
    resizeObserverRef.current.observe(terminalHostRef.current!)

    void onSshDataRaw(({ session_id, data_base64 }) => {
      if (session_id !== getCurrentPane().session_id) return
      const bytes = base64ToOctets(data_base64)
      zmodemSentryRef.current?.consume(bytes)
      if (zmodemActiveRef.current) return

      const decodedData = terminalEventTextDecoderRef.current.decode(bytes, { stream: true })
      const visibleData = getCurrentPane().private_key_passphrase_origin === 'configured'
        ? stripConfiguredPassphrasePrompt(decodedData)
        : decodedData

      trackAuthenticatedOutput(session_id, visibleData)
      trackOscCurrentDirectory(visibleData)
      trackPromptCurrentDirectory(visibleData)
    }).then((unlisten) => {
      if (disposed) {
        unlisten()
        return
      }
      unlistenDataRef.current = unlisten
    })

    void onSshDisconnected(({ session_id, reason }) => {
      if (session_id !== getCurrentPane().session_id) return

      latestPropsRef.current.onDisconnected({
        pane_id: getCurrentPane().id,
        session_id,
        reason,
      })
    }).then((unlisten) => {
      if (disposed) {
        unlisten()
        return
      }
      unlistenDisconnectedRef.current = unlisten
    })

    void onSshFileDownloadProgress((progress) => {
      const activeDownload = activeFileDownloadRef.current
      if (!activeDownload) return
      if (progress.remote_path !== activeDownload.remotePath) return
      if (activeDownload.sessionId && progress.session_id && progress.session_id !== activeDownload.sessionId) return

      setZmodemProgress({
        source: 'file-manager',
        direction: 'download',
        fileName: progress.filename || activeDownload.fileName,
        transferredBytes: progress.downloaded_bytes,
        totalBytes: progress.total_bytes || activeDownload.totalBytes,
      })
    }).then((unlisten) => {
      if (disposed) {
        unlisten()
        return
      }
      unlistenDownloadProgressRef.current = unlisten
    })

    window.setTimeout(fitTerminal, 80)

    return () => {
      disposed = true
      zmodemSessionRef.current?.abort?.()
      finishZmodemSession()
      resetFileManagerState()
      resizeObserverRef.current?.disconnect()
      unlistenDataRef.current?.()
      unlistenDisconnectedRef.current?.()
      unlistenDownloadProgressRef.current?.()
      terminal.dispose()
    }
  }, [])

  const handleFocus = () => {
    props.onFocus(props.pane.id)
    terminalRef.current?.focus()
  }

  const formatPercent = (value: number) => `${Math.max(0, value).toFixed(1)}%`

  const formatGbPair = (used: number, total: number) => {
    if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return '--/--G'

    return `${Math.max(0, used).toFixed(1)}/${Math.max(0, total).toFixed(1)}G`
  }

  const actionButtonClass = 'h-7 w-7 rounded-md text-[var(--text-primary)] opacity-80 transition hover:bg-[var(--surface-panel-strong)] hover:text-[var(--accent)] hover:opacity-100 disabled:text-[var(--text-muted)] disabled:opacity-70'
  const resourceBadgeClass = 'rounded-full border border-[var(--accent-soft)] bg-[var(--accent-soft)] px-2 py-0.5 text-[var(--accent)]'

  return (
    <section
      className={cn(
        'relative flex h-full min-h-0 flex-col overflow-hidden rounded-[12px] border border-[var(--border-subtle)] bg-[linear-gradient(180deg,var(--surface-card-start),var(--surface-card-end))] shadow-[0_12px_28px_rgba(20,38,52,0.07)] transition',
        props.active && 'border-[var(--border-strong)] shadow-[0_16px_34px_rgba(20,38,52,0.11)]',
        dragActive && 'ring-2 ring-[var(--ring)]',
      )}
      onMouseDown={handleFocus}
      onDragEnterCapture={(event) => {
        event.preventDefault()
        handleDragOver()
      }}
      onDragOverCapture={(event) => {
        event.preventDefault()
        handleDragOver()
      }}
      onDragLeaveCapture={handleDragLeave}
      onDropCapture={(event) => {
        event.preventDefault()
        void handleDrop(event)
      }}
    >
      <header className="flex min-h-[42px] items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={cn('mt-0.5 h-2.5 w-2.5 rounded-full bg-slate-300', {
            'bg-[var(--accent)]': props.pane.status === 'connected',
            'bg-amber-400': props.pane.status === 'connecting',
            'bg-rose-400': props.pane.status === 'error',
            'bg-slate-400': props.pane.status === 'closed',
          })} />
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-[13px] font-medium text-[var(--text-strong)]">{props.pane.title}</div>
            {props.pane.status !== 'connected' && (
              <span className="rounded bg-[var(--surface-tab-strip)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
                {statusText}
              </span>
            )}
          </div>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          {isConnected && (
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 font-mono text-[10px] uppercase tracking-[0.04em] text-[var(--text-muted)] max-sm:hidden">
              {props.pane.system_usage ? (
                <>
                  <span className={resourceBadgeClass}>CPU {formatPercent(props.pane.system_usage.cpu_percent)}</span>
                  <span className={resourceBadgeClass}>{t('resourceMemory')} {formatGbPair(props.pane.system_usage.memory_used_gb, props.pane.system_usage.memory_total_gb)}</span>
                  <span className={resourceBadgeClass}>{t('resourceStorage')} {formatGbPair(props.pane.system_usage.storage_used_gb, props.pane.system_usage.storage_total_gb)}</span>
                </>
              ) : props.pane.system_usage_loading ? (
                <span className={resourceBadgeClass} title={t('resourceLoadingTitle')}>{t('resourceLoading')}</span>
              ) : props.pane.system_usage_error ? (
                <span className={resourceBadgeClass} title={props.pane.system_usage_error}>{t('resourceError')}</span>
              ) : (
                <span className={resourceBadgeClass}>{t('resourceUnknown')}</span>
              )}
            </div>
          )}

          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="iconSm" className={actionButtonClass} disabled={!isConnected} onClick={(event) => {
                  event.stopPropagation()
                  void openFileManager()
                }}>
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('fileManager')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="iconSm" className={actionButtonClass} disabled={!isConnected} onClick={(event) => {
                  event.stopPropagation()
                  props.onDisconnect(props.pane.id)
                }}>
                  <Power className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('disconnect')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="iconSm" className={actionButtonClass} onClick={(event) => {
                  event.stopPropagation()
                  props.onClose(props.pane.id)
                }}>
                  <X className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('close')}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </header>

      {zmodemProgress && (
        <div className="border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-4 py-2.5">
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0">
              <strong className="block truncate text-sm text-[var(--text-strong)]">
                {zmodemProgressTitle}
              </strong>
              <small className="block truncate text-xs text-[var(--text-muted)]">{zmodemProgress.fileName}</small>
            </span>
            <span className="text-right text-xs text-[var(--text-muted)]">
              {zmodemProgress.fileCount ? (
                <small className="block">{t('zmodemProgressCount', { current: zmodemProgress.fileIndex || 1, total: zmodemProgress.fileCount })}</small>
              ) : null}
              <strong className="text-sm text-[var(--text-strong)]">{zmodemProgressPercent}%</strong>
            </span>
          </div>
          <div className="mt-3 h-2 rounded-full bg-slate-200/70">
            <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-150" style={{ width: `${zmodemProgressPercent}%` }} />
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-[var(--text-muted)]">
            <small>{zmodemProgressTransferredLabel}</small>
            <small>{t('zmodemSpeedLabel')} {zmodemProgressSpeedLabel}</small>
            <small>{t('zmodemRemainingLabel')} {zmodemProgressRemainingLabel}</small>
          </div>
        </div>
      )}

      {fileManagerOpen && (
        <div className="border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3.5 py-2.5" onMouseDown={(event) => event.stopPropagation()}>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={remotePath}
              disabled={fileLoading || transferring}
              onChange={(event) => setRemotePath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void refreshFiles()
                }
              }}
              className="h-8 flex-1 rounded-lg px-2.5 text-xs"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="secondary" size="iconSm" disabled={fileLoading || transferring} onClick={() => void refreshFiles(`${remotePath}/..`)}>
                  <ArrowUp className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('parentDirectory')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="secondary" size="iconSm" disabled={transferring} onClick={() => void refreshFiles()}>
                  <RefreshCw className={cn('h-4 w-4', fileLoading && 'animate-spin')} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('refresh')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="secondary" size="iconSm" disabled={transferring} onClick={chooseUploadFiles}>
                  <Upload className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('uploadFile')}</TooltipContent>
            </Tooltip>
            <input ref={fileInputRef} type="file" multiple hidden onChange={handleFileInput} />
            <input ref={zmodemInputRef} type="file" multiple hidden onChange={handleZmodemSendSelection} />
          </div>

          <div className="mt-2 grid gap-1.5">
            <small className="text-[11px] text-[var(--text-muted)]">{t('downloadDirectoryHint')}</small>
            <Input
              value={downloadDirectory}
              disabled={transferring}
              onChange={(event) => setDownloadDirectory(event.target.value)}
              placeholder={t('downloadDirectoryPlaceholder')}
              className="h-8 rounded-lg px-2.5 text-xs"
            />
          </div>

          <div className={cn('mt-2.5 max-h-56 overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-tab-strip)]', fileLoading && 'opacity-90')}>
            {remoteFiles.map((entry) => (
              <button
                key={`${entry.path}-${entry.name}`}
                type="button"
                className="grid w-full grid-cols-[20px_minmax(0,1fr)_auto_auto_auto] items-center gap-3 border-b border-[var(--border-subtle)] px-3 py-2 text-left text-xs last:border-b-0 hover:bg-[var(--surface-tab-active)] max-md:grid-cols-[20px_minmax(0,1fr)_auto]"
                onDoubleClick={() => void enterDirectory(entry)}
              >
                <span className="text-[var(--text-muted)]">{entry.kind === 'directory' ? <Folder className="h-4 w-4" /> : <FileIcon className="h-4 w-4" />}</span>
                <span className="truncate text-[var(--text-primary)]">{entry.name}</span>
                <span className="text-[var(--text-muted)] max-md:hidden">{entry.kind === 'directory' ? '' : formatBytes(entry.size)}</span>
                <span className="text-[var(--text-muted)] max-md:hidden">{entry.modified}</span>
                <span>
                  {entry.kind !== 'directory' ? (
                    <Button variant="ghost" size="iconSm" disabled={transferring} onClick={(event) => {
                      event.stopPropagation()
                      void downloadFile(entry)
                    }}>
                      <Download className="h-4 w-4" />
                    </Button>
                  ) : null}
                </span>
              </button>
            ))}

            {(fileLoading && remoteFiles.length === 0) || (!fileLoading && fileErrorRef.current) || (!fileLoading && remoteFiles.length === 0) ? (
              <div className="px-4 py-6 text-center text-xs text-[var(--text-muted)]">{fileManagerStatusText}</div>
            ) : null}
          </div>
        </div>
      )}

      <div ref={terminalHostRef} className="terminal-host min-h-0 flex-1 bg-[#0f1418]" />

      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-[12px] bg-slate-950/56 text-white">
          <Upload className="h-7 w-7" />
          <span className="text-sm">{t('dropToUpload', { path: remotePath })}</span>
        </div>
      )}

      {props.pane.status === 'idle' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[linear-gradient(180deg,rgba(227,233,236,0.72),rgba(222,229,233,0.58))] p-5 backdrop-blur-[1px]">
          <div className="flex w-full max-w-sm flex-col items-center rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-panel-strong)] px-6 py-8 text-center shadow-[0_14px_32px_rgba(20,38,52,0.07)]">
            <div className="mb-3 grid h-12 w-12 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] shadow-[inset_0_1px_0_var(--surface-highlight)]">
              <SquareTerminal className="h-6 w-6" />
            </div>
            <strong className="text-base text-[var(--text-strong)]">{t('emptyWorkspaceTitle')}</strong>
            <p className="mt-2 max-w-[260px] text-sm leading-6 text-[var(--text-muted)]">{t('emptyWorkspaceHint')}</p>
            <Button className="mt-5" onClick={(event: MouseEvent<HTMLButtonElement>) => {
              event.stopPropagation()
              props.onConnect(props.pane.id)
            }}>
              <Link2 className="h-4 w-4" />
              {t('connectHost')}
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={Boolean(pendingDropUpload)} onOpenChange={(open) => {
        if (!open) {
          pendingDropFilesRef.current = []
          setPendingDropUpload(null)
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDropUpload ? i18n.t('uploadToTarget', { target: pendingDropUpload.targetHost }) : ''}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDropUpload
                ? i18n.t('confirmUploadFiles', {
                    files: pendingDropUpload.fileLabel,
                    path: pendingDropUpload.targetPath,
                  })
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              const files = pendingDropFilesRef.current
              const targetPath = pendingDropUpload?.targetPath || remotePathRef.current
              const sessionId = pendingDropUpload?.sessionId
              pendingDropFilesRef.current = []
              setPendingDropUpload(null)
              void uploadFiles(files, targetPath, sessionId)
            }}>{t('upload')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
})

export default TerminalPane
