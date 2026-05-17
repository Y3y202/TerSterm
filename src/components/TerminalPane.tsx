import {
  type CSSProperties,
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
  Bot,
  File as FileIcon,
  Folder,
  FolderOpen,
  History,
  Link2,
  MessageSquarePlus,
  RefreshCw,
  SendHorizontal,
  Sparkles,
  SquareTerminal,
  Upload,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  requestAiAssistantReply,
  onSshFileDownloadProgress,
  onSshDataRaw,
  onSshDisconnected,
  pickLocalDirectory,
  saveLocalFile,
  sshCreateDirectory,
  sshDeletePath,
  sshDownloadFile,
  sshGetFilePermissions,
  sshSetFilePermissions,
  sshListFiles,
  sshResize,
  sshUploadFile,
  sshWrite,
  sshWriteBinary,
} from '../bridge'
import i18n from '../i18n'
import { cn } from '../lib/utils'
import { useStateRef } from '../lib/use-state-ref'
import type { AiAssistantMessage, AiAssistantPermission, AiAssistantSettings, ConnectionProfile, RemoteFileEntry, RemoteFilePermissions, SshPane } from '../types'
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
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

type AppThemeId = 'sage' | 'ocean' | 'dawn' | 'violet' | 'slate'

export interface TerminalPaneHandle {
  fitTerminal: () => void
  focusTerminal: () => void
}

interface ParsedTerminalCommandAction {
  text: string
  execute: boolean
  delayMs: number
}

interface TerminalPaneProps {
  pane: SshPane
  active: boolean
  appTheme: AppThemeId
  aiAssistantSettings: AiAssistantSettings
  onFocus: (paneId: string) => void
  onDisconnect: (paneId: string) => void
  onClose: (paneId: string) => void
  onConnect: (paneId: string) => void
  onOpenSettings: () => void
  onInput: (payload: { pane_id: string; data: string }) => void
  onZmodem: (payload: { pane_id: string; active: boolean }) => void
  onAuthenticated: (payload: { pane_id: string; session_id: string }) => void
  onDisconnected: (payload: { pane_id: string; session_id: string; reason?: string }) => void
}

interface AiConversation {
  id: string
  title: string
  messages: AiAssistantMessage[]
  createdAt: number
  updatedAt: number
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
const AI_CONVERSATION_STORAGE_KEY_PREFIX = 'tersterm:ai-conversations:'
const AI_TERMINAL_COMMAND_TAG_PATTERN = /<tersterm-command\b([^>]*)>([\s\S]*?)<\/tersterm-command>/gi
const AI_TERMINAL_COMMAND_DELAY_MS = 35
const AI_TERMINAL_COMMAND_DELAY_MIN_MS = 10
const AI_TERMINAL_COMMAND_DELAY_MAX_MS = 250

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

const buildAiTargetLabel = (connection?: ConnectionProfile) =>
  connection?.name || (connection?.username && connection?.host ? `${connection.username}@${connection.host}` : connection?.host) || i18n.t('aiAssistantGenericTarget')

const createAiConversationId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `ai-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const createAiConversation = (): AiConversation => {
  const now = Date.now()
  return {
    id: createAiConversationId(),
    title: '',
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}

interface StoredAiConversationState {
  conversations: AiConversation[]
  activeConversationId: string
}

const createDefaultAiConversationState = (): StoredAiConversationState => {
  const conversation = createAiConversation()
  return {
    conversations: [conversation],
    activeConversationId: conversation.id,
  }
}

const buildAiConversationStorageKey = (connection?: ConnectionProfile) => {
  const host = connection?.host?.trim().toLowerCase()
  const username = connection?.username?.trim().toLowerCase()
  const port = Number(connection?.port || 22)

  if (!host || !username || !Number.isFinite(port) || port <= 0) return undefined
  return `${AI_CONVERSATION_STORAGE_KEY_PREFIX}${username}@${host}:${port}`
}

const sanitizeAiConversationMessage = (value: unknown): AiAssistantMessage | null => {
  if (!value || typeof value !== 'object') return null

  const role = 'role' in value ? value.role : undefined
  const content = 'content' in value ? value.content : undefined
  if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return null

  const normalizedContent = content.trim()
  if (!normalizedContent) return null

  return {
    role,
    content: normalizedContent,
  }
}

const sanitizeAiConversationState = (value: unknown): StoredAiConversationState => {
  if (!value || typeof value !== 'object') return createDefaultAiConversationState()

  const record = value as Record<string, unknown>
  const rawConversations = Array.isArray(record.conversations)
    ? record.conversations
    : []
  const conversations = rawConversations.flatMap((conversation: unknown) => {
    if (!conversation || typeof conversation !== 'object') return []
    const conversationRecord = conversation as Record<string, unknown>

    const id = typeof conversationRecord.id === 'string' && conversationRecord.id.trim()
      ? conversationRecord.id.trim()
      : createAiConversationId()
    const title = typeof conversationRecord.title === 'string'
      ? conversationRecord.title
      : ''
    const createdAt = Number.isFinite(conversationRecord.createdAt)
      ? Number(conversationRecord.createdAt)
      : Date.now()
    const updatedAt = Number.isFinite(conversationRecord.updatedAt)
      ? Number(conversationRecord.updatedAt)
      : createdAt
    const messages = Array.isArray(conversationRecord.messages)
      ? conversationRecord.messages
        .map(sanitizeAiConversationMessage)
        .filter((message: AiAssistantMessage | null): message is AiAssistantMessage => Boolean(message))
      : []

    return [{
      id,
      title,
      messages,
      createdAt,
      updatedAt,
    }]
  })

  if (conversations.length === 0) {
    return createDefaultAiConversationState()
  }

  const requestedActiveId =
    typeof record.activeConversationId === 'string'
      ? record.activeConversationId
      : ''
  const activeConversationId = conversations.some((conversation) => conversation.id === requestedActiveId)
    ? requestedActiveId
    : conversations[0].id

  return {
    conversations,
    activeConversationId,
  }
}

const readStoredAiConversationState = (storageKey?: string): StoredAiConversationState => {
  if (typeof localStorage === 'undefined' || !storageKey) {
    return createDefaultAiConversationState()
  }

  const raw = localStorage.getItem(storageKey)
  if (!raw) return createDefaultAiConversationState()

  try {
    return sanitizeAiConversationState(JSON.parse(raw))
  } catch {
    return createDefaultAiConversationState()
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

const normalizeAiTerminalCommandDelay = (value?: number) => {
  if (!Number.isFinite(value)) return AI_TERMINAL_COMMAND_DELAY_MS
  return Math.min(
    AI_TERMINAL_COMMAND_DELAY_MAX_MS,
    Math.max(AI_TERMINAL_COMMAND_DELAY_MIN_MS, Math.round(value as number)),
  )
}

const parseAiTerminalCommandActions = (reply: string) => {
  const actions: ParsedTerminalCommandAction[] = []

  const content = reply.replace(AI_TERMINAL_COMMAND_TAG_PATTERN, (_, rawAttributes = '', rawBody = '') => {
    const text = String(rawBody).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
    if (!text) return ''

    const executeMatch = /execute\s*=\s*"([^"]+)"/i.exec(String(rawAttributes))
    const delayMatch = /delay_ms\s*=\s*"(\d+)"/i.exec(String(rawAttributes))
    const execute = executeMatch ? executeMatch[1].trim().toLowerCase() === 'true' : false
    const delayMs = normalizeAiTerminalCommandDelay(delayMatch ? Number(delayMatch[1]) : undefined)

    actions.push({
      text,
      execute,
      delayMs,
    })

    return text
  })

  const normalizedContent = content.replace(/\n{3,}/g, '\n\n').trim()
  return {
    actions,
    content: normalizedContent || actions.map((action) => action.text).join('\n\n'),
  }
}

const normalizeAiTerminalActionsForPermission = (
  actions: ParsedTerminalCommandAction[],
  permission: AiAssistantPermission,
) => {
  if (permission === 'reply-only') return { actions: [], mode: 'blocked' as const }
  if (permission === 'type-only') return { actions, mode: 'type-only' as const }

  return { actions, mode: 'execute' as const }
}

const shouldRequestApprovalBeforeExecute = (
  permission: AiAssistantPermission,
  action: ParsedTerminalCommandAction,
) => permission === 'type-only' && action.execute

const summarizeAiConversationTitle = (content: string, fallback: string) => {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (!normalized) return fallback
  return normalized.length > 24 ? `${normalized.slice(0, 24)}...` : normalized
}

const summarizeAiConversationPreview = (content: string) => {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > 56 ? `${normalized.slice(0, 56)}...` : normalized
}

const formatAiConversationTime = (timestamp: number) =>
  new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)

const normalizePermissionMode = (mode: string) => {
  const digits = mode.replace(/[^0-7]/g, '')
  if (!digits) return '755'
  return digits.slice(-4)
}

const modeToTriples = (mode: string) => {
  const normalized = normalizePermissionMode(mode)
  const subjectDigits = normalized.padStart(3, '0').slice(-3).split('').map((digit) => Number.parseInt(digit, 10) || 0)
  return subjectDigits.map((digit) => ({
    read: Boolean(digit & 4),
    write: Boolean(digit & 2),
    execute: Boolean(digit & 1),
  }))
}

const triplesToMode = (
  triples: Array<{ read: boolean; write: boolean; execute: boolean }>,
  prefix = '',
) => `${prefix}${triples.map((triple) => (triple.read ? 4 : 0) + (triple.write ? 2 : 0) + (triple.execute ? 1 : 0)).join('')}`

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
  const initialAiConversationStorageKeyRef = useRef(buildAiConversationStorageKey(props.pane.connection))
  const initialAiConversationStateRef = useRef(readStoredAiConversationState(initialAiConversationStorageKeyRef.current))
  const skipNextAiConversationPersistKeyRef = useRef<string>()
  const [fileManagerOpen, setFileManagerOpen, fileManagerOpenRef] = useStateRef(false)
  const [aiAssistantOpen, setAiAssistantOpen, aiAssistantOpenRef] = useStateRef(false)
  const [aiHistoryOpen, setAiHistoryOpen] = useState(false)
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
  const [aiConversations, setAiConversations] = useStateRef<AiConversation[]>(initialAiConversationStateRef.current.conversations)
  const [activeAiConversationId, setActiveAiConversationId, activeAiConversationIdRef] = useStateRef(initialAiConversationStateRef.current.activeConversationId)
  const [aiAssistantDraft, setAiAssistantDraft] = useState('')
  const [aiAssistantSending, setAiAssistantSending] = useState(false)
  const [pendingAiCommandApproval, setPendingAiCommandApproval] = useState<{ text: string } | null>(null)
  const aiMessagesViewportRef = useRef<HTMLDivElement | null>(null)
  const pendingAiCommandApprovalResolverRef = useRef<((approved: boolean) => void) | null>(null)
  const uploadTargetPathRef = useRef<string>()
  const [newFolderDraft, setNewFolderDraft] = useState<{ parentPath: string; name: string } | null>(null)
  const [deleteEntry, setDeleteEntry] = useState<RemoteFileEntry | null>(null)
  const [permissionEntry, setPermissionEntry] = useState<RemoteFilePermissions | null>(null)
  const [permissionDialogOpen, setPermissionDialogOpen] = useState(false)
  const [permissionLoading, setPermissionLoading] = useState(false)
  const [permissionSubmitting, setPermissionSubmitting] = useState(false)
  const [permissionDraft, setPermissionDraft] = useState({
    mode: '755',
    owner: '',
    recursive: false,
  })

  useEffect(() => {
    latestPropsRef.current = props
  }, [props])

  const aiConversationStorageKey = buildAiConversationStorageKey(props.pane.connection)

  useEffect(() => {
    const nextState = readStoredAiConversationState(aiConversationStorageKey)
    skipNextAiConversationPersistKeyRef.current = aiConversationStorageKey
    setAiConversations(nextState.conversations)
    setActiveAiConversationId(nextState.activeConversationId)
    setAiAssistantDraft('')
    setAiHistoryOpen(false)
  }, [aiConversationStorageKey, setActiveAiConversationId, setAiConversations])

  useEffect(() => {
    if (typeof localStorage === 'undefined' || !aiConversationStorageKey) return
    if (skipNextAiConversationPersistKeyRef.current === aiConversationStorageKey) {
      skipNextAiConversationPersistKeyRef.current = undefined
      return
    }

    const activeConversationId = aiConversations.some((conversation) => conversation.id === activeAiConversationId)
      ? activeAiConversationId
      : aiConversations[0]?.id || createAiConversation().id

    localStorage.setItem(aiConversationStorageKey, JSON.stringify({
      conversations: aiConversations,
      activeConversationId,
    }))
  }, [activeAiConversationId, aiConversationStorageKey, aiConversations])

  useEffect(() => () => {
    pendingAiCommandApprovalResolverRef.current?.(false)
    pendingAiCommandApprovalResolverRef.current = null
  }, [])

  const getCurrentPane = () => latestPropsRef.current.pane
  const resolvePendingAiCommandApproval = (approved: boolean) => {
    pendingAiCommandApprovalResolverRef.current?.(approved)
    pendingAiCommandApprovalResolverRef.current = null
    setPendingAiCommandApproval(null)
  }

  const isConnected = props.pane.status === 'connected' && Boolean(props.pane.session_id)
  const remoteFeaturesReady = isConnected && Boolean(props.pane.remote_features_ready)
  const fileManagerStatusText = !remoteFeaturesReady
    ? t('waitAuthForFiles')
    : fileLoading
      ? t('loadingFiles')
      : fileError || t('emptyDirectory')
  const activeAiConversation =
    aiConversations.find((conversation) => conversation.id === activeAiConversationId) ||
    aiConversations[0] ||
    initialAiConversationStateRef.current.conversations[0]
  const aiAssistantMessages = activeAiConversation.messages
  const aiConversationHistory = [...aiConversations]
    .filter((conversation) => conversation.messages.length > 0 || conversation.id === activeAiConversation.id)
    .sort((left, right) => right.updatedAt - left.updatedAt)

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

  const getVisibleTerminalOutput = () => {
    const terminal = terminalRef.current
    if (!terminal) return ''

    const buffer = terminal.buffer.active
    const start = buffer.viewportY
    const end = Math.min(buffer.length, start + terminal.rows)
    const lines: string[] = []

    for (let index = start; index < end; index += 1) {
      const line = buffer.getLine(index)
      if (!line) continue
      lines.push(line.translateToString(true))
    }

    return lines.join('\n').trim()
  }

  const progressivelyTypeTerminalCommand = async (action: ParsedTerminalCommandAction) => {
    const initialPane = getCurrentPane()
    const initialSessionId = initialPane.session_id
    if (!initialSessionId || initialPane.status !== 'connected') {
      toast.error(t('statusDisconnected'))
      return false
    }

    focusTerminal()

    const normalizedText = action.execute ? action.text.replace(/[\r\n]+$/, '') : action.text
    for (const char of normalizedText) {
      const currentPane = getCurrentPane()
      if (currentPane.session_id !== initialSessionId || currentPane.status !== 'connected') {
        toast.error(t('statusDisconnected'))
        return false
      }

      const nextChunk = char === '\n' ? '\r' : char
      trackShellInput(nextChunk)
      await sshWrite(initialSessionId, nextChunk)
      await wait(action.delayMs)
    }

    if (!action.execute) return true

    const currentPane = getCurrentPane()
    if (currentPane.session_id !== initialSessionId || currentPane.status !== 'connected') {
      toast.error(t('statusDisconnected'))
      return false
    }

    trackShellInput('\r')
    await sshWrite(initialSessionId, '\r')
    return true
  }

  const requestAiCommandExecutionApproval = (action: ParsedTerminalCommandAction) =>
    new Promise<boolean>((resolve) => {
      pendingAiCommandApprovalResolverRef.current = resolve
      setPendingAiCommandApproval({ text: action.text })
    })

  const runAiTerminalCommandActions = async (
    actions: ParsedTerminalCommandAction[],
    permission: AiAssistantPermission,
  ) => {
    for (const action of actions) {
      if (!action.text) continue
      const requiresApproval = shouldRequestApprovalBeforeExecute(permission, action)
      const nextAction = requiresApproval ? { ...action, execute: false } : action
      const completed = await progressivelyTypeTerminalCommand(nextAction)
      if (!completed) break

      if (requiresApproval) {
        const approved = await requestAiCommandExecutionApproval(action)
        if (!approved) continue

        const executed = await progressivelyTypeTerminalCommand({ ...action, text: '', execute: true })
        if (!executed) break
      }
    }
  }

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
    uploadTargetPathRef.current = undefined
    setNewFolderDraft(null)
    setDeleteEntry(null)
    setPermissionEntry(null)
    setPermissionDialogOpen(false)
    setPermissionLoading(false)
    setPermissionSubmitting(false)
    setPermissionDraft({ mode: '755', owner: '', recursive: false })
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const resetAiAssistantState = () => {
    setAiAssistantOpen(false)
    setAiHistoryOpen(false)
    setAiAssistantDraft('')
    setAiAssistantSending(false)
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
    if (nextOpen) {
      setAiAssistantOpen(false)
    }
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

  const openAiAssistant = () => {
    const nextOpen = !aiAssistantOpenRef.current
    if (nextOpen) {
      setFileManagerOpen(false)
    }
    setAiAssistantOpen(nextOpen)
  }

  const toggleAiHistory = () => {
    setAiHistoryOpen((current) => !current)
  }

  const openAiConversation = (conversationId: string) => {
    setActiveAiConversationId(conversationId)
    setAiHistoryOpen(false)
    setAiAssistantDraft('')
  }

  const startNewAiConversation = () => {
    if (activeAiConversation.messages.length === 0) {
      setAiHistoryOpen(false)
      setAiAssistantDraft('')
      return
    }

    const nextConversation = createAiConversation()
    setAiConversations((current) => [nextConversation, ...current])
    setActiveAiConversationId(nextConversation.id)
    setAiHistoryOpen(false)
    setAiAssistantDraft('')
  }

  const submitAiAssistantPrompt = async () => {
    const content = aiAssistantDraft.trim()
    if (!content || aiAssistantSending) return

    const { aiAssistantSettings } = latestPropsRef.current
    if (!aiAssistantSettings.api_key.trim() || !aiAssistantSettings.model.trim()) {
      toast.warning(t('aiAssistantMissingConfig'))
      latestPropsRef.current.onOpenSettings()
      return
    }

    const activeConversationId = activeAiConversationIdRef.current
    const nextMessages: AiAssistantMessage[] = [...aiAssistantMessages, { role: 'user', content }]
    setAiConversations((current) => current.map((conversation) => (
      conversation.id === activeConversationId
        ? {
            ...conversation,
            title: conversation.title || summarizeAiConversationTitle(content, t('aiAssistantUntitledConversation')),
            messages: nextMessages,
            updatedAt: Date.now(),
          }
        : conversation
    )))
    setAiAssistantDraft('')
    setAiHistoryOpen(false)
    setAiAssistantSending(true)

    try {
      const reply = await requestAiAssistantReply(
        aiAssistantSettings,
        nextMessages,
        {
          connection_name: props.pane.connection?.name,
          host: props.pane.connection?.host,
          username: props.pane.connection?.username,
          host_platform: props.pane.connection?.host_platform,
          linux_distro: props.pane.connection?.linux_distro,
          current_directory: remotePathRef.current,
          visible_terminal_output: getVisibleTerminalOutput(),
          recent_terminal_output: props.pane.terminal_output?.slice(-4000),
          pending_terminal_input: inputBufferRef.current,
        },
      )
      const parsedReply = parseAiTerminalCommandActions(reply)

      setAiConversations((current) => current.map((conversation) => (
        conversation.id === activeConversationId
          ? {
              ...conversation,
              messages: [...conversation.messages, { role: 'assistant', content: parsedReply.content }],
              updatedAt: Date.now(),
            }
          : conversation
      )))

      if (parsedReply.actions.length > 0) {
        const permissionResult = normalizeAiTerminalActionsForPermission(
          parsedReply.actions,
          aiAssistantSettings.terminal_permission,
        )

        if (permissionResult.mode === 'blocked') {
          toast.warning(t('aiAssistantPermissionBlocked'))
        } else {
          await runAiTerminalCommandActions(permissionResult.actions, aiAssistantSettings.terminal_permission)
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      setAiConversations((current) => current.map((conversation) => (
        conversation.id === activeConversationId
          ? {
              ...conversation,
              messages: [...conversation.messages, { role: 'assistant', content: t('aiAssistantErrorReply') }],
              updatedAt: Date.now(),
            }
          : conversation
      )))
    } finally {
      setAiAssistantSending(false)
    }
  }

  const openNewFolderDialog = (parentPath = remotePathRef.current) => {
    if (!paneRemoteFeaturesReady()) {
      toast.warning(i18n.t('finishAuthBeforeTransfer'))
      return
    }

    setNewFolderDraft({ parentPath, name: '' })
  }

  const createDirectory = async () => {
    const currentPane = getCurrentPane()
    const draft = newFolderDraft
    if (!draft?.name.trim() || !currentPane.connection || !paneRemoteFeaturesReady()) return

    setTransferring(true)
    try {
      await sshCreateDirectory(currentPane.connection, draft.parentPath, draft.name.trim(), currentPane.session_id)
      toast.success(i18n.t('folderCreated'))
      setNewFolderDraft(null)
      await refreshFiles(draft.parentPath)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setTransferring(false)
    }
  }

  const openDownloadDialog = async (entry: RemoteFileEntry) => {
    if (entry.kind === 'directory') return
    try {
      const selectedPath = await pickLocalDirectory(resolveDownloadDirectory())
      if (!selectedPath) return
      setDownloadDirectory(selectedPath)
      await downloadFile(entry, selectedPath)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  const openPermissionsDialog = async (entry: RemoteFileEntry) => {
    const currentPane = getCurrentPane()
    if (!currentPane.connection || !paneRemoteFeaturesReady()) return

    setPermissionDialogOpen(true)
    setPermissionLoading(true)
    setPermissionEntry(null)

    try {
      const details = await sshGetFilePermissions(currentPane.connection, entry.path, currentPane.session_id)
      setPermissionEntry(details)
      setPermissionDraft({
        mode: normalizePermissionMode(details.mode),
        owner: details.owner || '',
        recursive: false,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setPermissionDialogOpen(false)
      toast.error(message)
    } finally {
      setPermissionLoading(false)
    }
  }

  const applyPermissions = async () => {
    const currentPane = getCurrentPane()
    if (!currentPane.connection || !permissionEntry) return

    setPermissionSubmitting(true)
    try {
      await sshSetFilePermissions(
        currentPane.connection,
        permissionEntry.path,
        normalizePermissionMode(permissionDraft.mode),
        permissionDraft.owner.trim() || undefined,
        permissionDraft.recursive,
        currentPane.session_id,
      )
      toast.success(i18n.t('permissionsSaved'))
      setPermissionDialogOpen(false)
      const refreshed = await sshGetFilePermissions(currentPane.connection, permissionEntry.path, currentPane.session_id)
      setPermissionEntry(refreshed)
      setPermissionDraft({
        mode: normalizePermissionMode(refreshed.mode),
        owner: refreshed.owner || '',
        recursive: false,
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPermissionSubmitting(false)
    }
  }

  const confirmDeleteEntry = (entry: RemoteFileEntry) => {
    setDeleteEntry(entry)
  }

  const deleteRemoteEntry = async () => {
    const currentPane = getCurrentPane()
    const entry = deleteEntry
    if (!entry || !currentPane.connection || !paneRemoteFeaturesReady()) return

    setTransferring(true)
    try {
      await sshDeletePath(currentPane.connection, entry.path, true, currentPane.session_id)
      toast.success(i18n.t('deleted'))
      setDeleteEntry(null)
      await refreshFiles(remotePathRef.current)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setTransferring(false)
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

  const chooseUploadFiles = (targetPath = remotePathRef.current) => {
    if (!paneRemoteFeaturesReady()) {
      toast.warning(i18n.t('finishAuthBeforeUpload'))
      return
    }

    uploadTargetPathRef.current = targetPath
    fileInputRef.current?.click()
  }

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const targetPath = uploadTargetPathRef.current || remotePathRef.current
    uploadTargetPathRef.current = undefined
    void uploadFiles(Array.from(event.target.files || []), targetPath)
  }

  const downloadFile = async (entry: RemoteFileEntry, localDirectory = resolveDownloadDirectory()) => {
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
        localDirectory,
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
    if (!aiAssistantOpen) return

    requestAnimationFrame(() => {
      aiMessagesViewportRef.current?.scrollTo({
        top: aiMessagesViewportRef.current.scrollHeight,
        behavior: 'smooth',
      })
    })
  }, [aiAssistantMessages, aiAssistantOpen, aiAssistantSending])

  useEffect(() => {
    if (!terminalRef.current) return

    if (props.pane.status === 'connecting' && props.pane.connection) {
      resetTerminal(i18n.t('connectingTo', { name: props.pane.connection.name, host: props.pane.connection.host }))
      resetZmodemRuntime()
    }

    if (props.pane.status === 'idle') {
      resetTerminal()
      resetFileManagerState()
      resetAiAssistantState()
      resetZmodemRuntime()
    }

    if (props.pane.status === 'closed' || props.pane.status === 'error') {
      resetFileManagerState()
      setAiAssistantOpen(false)
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
    resetAiAssistantState()
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
      resetAiAssistantState()
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

  const actionButtonClass = 'h-7 w-7 rounded-md border border-white/10 text-slate-300 opacity-90 transition hover:bg-white/10 hover:text-white hover:opacity-100 disabled:border-white/5 disabled:text-slate-500 disabled:opacity-60'
  const resourceBadgeClass = 'rounded-full border border-white/10 bg-white/[0.06] px-2 py-0.5 text-[rgba(232,240,246,0.88)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
  const resourceStatusContent = props.pane.system_usage ? (
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
  )
  const permissionTriples = modeToTriples(permissionDraft.mode)
  const setPermissionTriple = (
    subjectIndex: number,
    field: 'read' | 'write' | 'execute',
    checked: boolean,
  ) => {
    const nextTriples = modeToTriples(permissionDraft.mode)
    nextTriples[subjectIndex] = {
      ...nextTriples[subjectIndex],
      [field]: checked,
    }
    setPermissionDraft((current) => ({
      ...current,
      mode: triplesToMode(nextTriples),
    }))
  }

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

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={terminalHostRef}
          className="terminal-host h-full min-h-0"
          style={{ '--terminal-bg': resolveTerminalTheme().background } as CSSProperties}
        />

        <div className="pointer-events-none absolute inset-0 z-[12]">
          <aside
            className={cn(
              'absolute inset-y-0 right-0 z-[13] flex h-full w-[clamp(200px,23%,253px)] max-w-[92%] flex-col border-l border-[var(--border-subtle)] bg-[var(--surface-panel)] shadow-[-16px_0_32px_rgba(15,23,42,0.18)] transition-transform duration-220 ease-out',
              fileManagerOpen ? 'pointer-events-auto' : 'pointer-events-none',
              fileManagerOpen ? 'translate-x-0' : 'translate-x-full',
            )}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="border-b border-[var(--border-subtle)] px-3.5 py-2.5">
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
                    <Button variant="secondary" size="iconSm" disabled={transferring} onClick={() => chooseUploadFiles()}>
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
            </div>

            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div className={cn('min-h-0 flex-1 overflow-auto bg-[var(--surface-tab-strip)]', fileLoading && 'opacity-90')}>
                  {remoteFiles.map((entry) => (
                    <ContextMenu key={`${entry.path}-${entry.name}`}>
                      <ContextMenuTrigger asChild>
                        <button
                          type="button"
                          className="grid w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--border-subtle)] px-3 py-2 text-left text-xs last:border-b-0 hover:bg-[var(--surface-tab-active)]"
                          onDoubleClick={() => void enterDirectory(entry)}
                        >
                          <span className="text-[var(--text-muted)]">{entry.kind === 'directory' ? <Folder className="h-4 w-4" /> : <FileIcon className="h-4 w-4" />}</span>
                          <span className="truncate text-[var(--text-primary)]">{entry.name}</span>
                          <span className="text-[var(--text-muted)] max-md:hidden">{entry.kind === 'directory' ? '' : formatBytes(entry.size)}</span>
                        </button>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        {entry.kind === 'directory' && entry.name !== '..' && (
                          <ContextMenuItem onSelect={() => openNewFolderDialog(entry.path)}>{t('newFolder')}</ContextMenuItem>
                        )}
                        {entry.kind === 'directory' && entry.name !== '..' && (
                          <ContextMenuItem onSelect={() => chooseUploadFiles(entry.kind === 'directory' ? entry.path : remotePathRef.current)}>
                            {t('uploadFile')}
                          </ContextMenuItem>
                        )}
                        {entry.kind !== 'directory' && (
                          <ContextMenuItem onSelect={() => void openDownloadDialog(entry)}>{t('download')}</ContextMenuItem>
                        )}
                        {entry.name !== '..' && (
                          <ContextMenuItem onSelect={() => void openPermissionsDialog(entry)}>{t('permissions')}</ContextMenuItem>
                        )}
                        {entry.name !== '..' && (
                          <ContextMenuItem className="text-[#d45b5b] focus:text-[#d45b5b]" onSelect={() => confirmDeleteEntry(entry)}>
                            {t('delete')}
                          </ContextMenuItem>
                        )}
                      </ContextMenuContent>
                    </ContextMenu>
                  ))}

                  {(fileLoading && remoteFiles.length === 0) || (!fileLoading && fileErrorRef.current) || (!fileLoading && remoteFiles.length === 0) ? (
                    <div className="px-4 py-6 text-center text-xs text-[var(--text-muted)]">{fileManagerStatusText}</div>
                  ) : null}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => chooseUploadFiles(remotePathRef.current)}>{t('uploadFile')}</ContextMenuItem>
                <ContextMenuItem onSelect={() => openNewFolderDialog(remotePathRef.current)}>{t('newFolder')}</ContextMenuItem>
                <ContextMenuItem onSelect={() => void refreshFiles()}>{t('refresh')}</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </aside>

          <aside
            className={cn(
              'absolute inset-y-0 right-0 z-[13] flex h-full w-[clamp(260px,28%,360px)] max-w-[94%] flex-col border-l border-[var(--border-subtle)] bg-[linear-gradient(180deg,var(--surface-card-start),var(--surface-card-end))] text-[var(--text-primary)] shadow-[-16px_0_32px_rgba(15,23,42,0.18)] transition-transform duration-220 ease-out',
              aiAssistantOpen ? 'pointer-events-auto' : 'pointer-events-none',
              aiAssistantOpen ? 'translate-x-0' : 'translate-x-full',
            )}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="border-b border-[var(--border-subtle)] bg-[linear-gradient(180deg,var(--surface-panel-strong),var(--surface-panel))] px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <strong className="block truncate text-[26px] font-semibold leading-none text-[var(--text-strong)]">{t('aiAssistant')}</strong>
                  <span className="mt-2 block truncate text-xs text-[var(--text-muted)]">{buildAiTargetLabel(props.pane.connection)}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="iconSm"
                    className="h-8 w-8 rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-chip)] hover:text-[var(--accent)]"
                    onClick={toggleAiHistory}
                    aria-label={t('aiAssistantHistory')}
                  >
                    <History className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="iconSm"
                    className="h-8 w-8 rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-chip)] hover:text-[var(--accent)]"
                    onClick={startNewAiConversation}
                    aria-label={t('aiAssistantNewChat')}
                  >
                    <MessageSquarePlus className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="iconSm"
                    className="h-8 w-8 rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-chip)] hover:text-[var(--text-strong)]"
                    onClick={() => setAiAssistantOpen(false)}
                    aria-label={t('close')}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            {aiHistoryOpen ? (
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <strong className="block text-sm text-[var(--text-strong)]">{t('aiAssistantHistory')}</strong>
                    <span className="text-xs text-[var(--text-muted)]">{t('aiAssistantHistoryHint')}</span>
                  </div>
                  <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
                    {t('aiAssistantConversationCount', { count: aiConversationHistory.length })}
                  </span>
                </div>

                {aiConversationHistory.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-[var(--border-subtle)] bg-[var(--surface-panel)]/40 px-3.5 py-3 text-sm text-[var(--text-muted)]">
                    {t('aiAssistantHistoryEmpty')}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {aiConversationHistory.map((conversation) => {
                      const lastMessage = conversation.messages[conversation.messages.length - 1]
                      const active = conversation.id === activeAiConversation.id

                      return (
                        <button
                          key={conversation.id}
                          type="button"
                          className={cn(
                            'block w-full rounded-2xl border px-3.5 py-3 text-left transition',
                            active
                              ? 'border-[var(--border-strong)] bg-[var(--accent-soft)] text-[var(--text-strong)] shadow-[0_10px_24px_var(--accent-soft)]'
                              : 'border-[var(--border-subtle)] bg-[var(--surface-panel)]/50 text-[var(--text-primary)] hover:bg-[var(--surface-chip)]',
                          )}
                          onClick={() => openAiConversation(conversation.id)}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <strong className="block truncate text-sm">
                                {conversation.title || t('aiAssistantUntitledConversation')}
                              </strong>
                              <span className="mt-1 block truncate text-xs text-[var(--text-muted)]">
                                {lastMessage ? summarizeAiConversationPreview(lastMessage.content) : t('aiAssistantEmptyConversation')}
                              </span>
                            </div>
                            <div className="shrink-0 text-right">
                              <span className="block text-[11px] text-[var(--text-muted)]">{formatAiConversationTime(conversation.updatedAt)}</span>
                              {active && (
                                <span className="mt-1 inline-flex rounded-full bg-[var(--accent)] px-2 py-0.5 text-[10px] text-white">
                                  {t('aiAssistantCurrentConversation')}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            ) : (
              <>
                <div ref={aiMessagesViewportRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                  <div className="flex items-start gap-3">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[radial-gradient(circle_at_30%_30%,var(--surface-panel-strong),var(--accent-soft)_38%,var(--accent)_100%)] shadow-[0_0_0_1px_var(--border-strong)]">
                      <Bot className="h-4 w-4 text-[var(--text-strong)]" />
                    </div>
                    <div className="min-w-0">
                      <strong className="block text-sm text-[var(--text-strong)]">{t('aiAssistant')}</strong>
                      <div className="mt-2 rounded-2xl rounded-tl-md border border-[var(--border-subtle)] bg-[var(--surface-panel-strong)] px-3.5 py-3 text-sm leading-6 text-[var(--text-primary)] shadow-[0_6px_18px_rgba(15,23,42,0.08)]">
                        {t('aiAssistantGreeting', { target: buildAiTargetLabel(props.pane.connection) })}
                      </div>
                    </div>
                  </div>

                  {(!props.aiAssistantSettings.api_key.trim() || !props.aiAssistantSettings.model.trim()) && (
                    <div className="mt-4 rounded-2xl border border-[var(--border-strong)] bg-[var(--accent-soft)] px-3.5 py-3 text-sm text-[var(--text-primary)]">
                      <p>{t('aiAssistantSetupHint')}</p>
                      <Button className="mt-3 h-8 px-3 text-xs" variant="secondary" onClick={props.onOpenSettings}>
                        {t('aiAssistantOpenSettings')}
                      </Button>
                    </div>
                  )}

                  {aiAssistantMessages.length === 0 && (
                    <div className="mt-4 rounded-2xl border border-dashed border-[var(--border-subtle)] bg-[var(--surface-panel)]/40 px-3.5 py-3 text-sm text-[var(--text-muted)]">
                      {t('aiAssistantEmptyHint')}
                    </div>
                  )}

                  <div className="mt-4 space-y-4">
                    {aiAssistantMessages.map((message, index) => (
                      <div key={`${activeAiConversation.id}-${message.role}-${index}-${message.content.slice(0, 24)}`} className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
                        <div
                          className={cn(
                            'max-w-[92%] whitespace-pre-wrap rounded-2xl border px-3.5 py-3 text-sm leading-6',
                            message.role === 'user'
                              ? 'rounded-br-md border-[var(--accent)] bg-[var(--accent)] text-white shadow-[0_8px_22px_var(--accent-soft)]'
                              : 'rounded-tl-md border-[var(--border-subtle)] bg-[var(--surface-panel-strong)] text-[var(--text-primary)]',
                          )}
                        >
                          {message.content}
                        </div>
                      </div>
                    ))}

                    {aiAssistantSending && (
                      <div className="flex justify-start">
                        <div className="rounded-2xl rounded-tl-md border border-[var(--border-subtle)] bg-[var(--surface-panel-strong)] px-3.5 py-3 text-sm text-[var(--text-muted)]">
                          {t('aiAssistantThinking')}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="border-t border-[var(--border-subtle)] bg-[linear-gradient(180deg,var(--surface-panel),var(--surface-card-end))] px-4 py-4">
                  <div className="rounded-[16px] border border-[var(--border-strong)] bg-[var(--surface-shell)] p-2 shadow-[0_0_0_1px_var(--accent-soft)]">
                    <div className="relative">
                      <Textarea
                        value={aiAssistantDraft}
                        rows={4}
                        disabled={aiAssistantSending}
                        placeholder={t('aiAssistantInputPlaceholder')}
                        className="min-h-[116px] resize-none border-0 bg-transparent pr-12 text-sm text-[var(--text-primary)] shadow-none placeholder:text-[var(--text-muted)] focus-visible:ring-0"
                        onChange={(event) => setAiAssistantDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault()
                            void submitAiAssistantPrompt()
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="absolute bottom-2 right-2 grid h-9 w-9 place-items-center rounded-xl bg-[var(--accent)] text-white shadow-[0_8px_18px_var(--accent-soft)] transition hover:scale-[1.02] hover:brightness-[1.03] disabled:cursor-not-allowed disabled:opacity-55"
                        disabled={aiAssistantSending || !aiAssistantDraft.trim()}
                        onClick={() => void submitAiAssistantPrompt()}
                      >
                        <SendHorizontal className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </aside>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[11] flex justify-start px-3 pb-2 pt-3">
          <div className="pointer-events-auto flex items-center gap-2">
            {isConnected && (
              <div className="flex min-w-0 flex-wrap items-center justify-start gap-1.5 font-mono text-[10px] uppercase tracking-[0.04em] text-slate-400 max-sm:hidden">
                {resourceStatusContent}
              </div>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="iconSm" className={actionButtonClass} disabled={!isConnected} onClick={(event) => {
                  event.stopPropagation()
                  void openFileManager()
                }} aria-label={t('fileManager')}>
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('fileManager')}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="iconSm" className={actionButtonClass} onClick={(event) => {
                  event.stopPropagation()
                  openAiAssistant()
                }} aria-label={t('aiAssistant')}>
                  <Sparkles className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('aiAssistant')}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

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

      <Dialog open={Boolean(newFolderDraft)} onOpenChange={(open) => {
        if (!open) setNewFolderDraft(null)
      }}>
        <DialogContent className="w-[min(92vw,420px)]">
          <DialogHeader>
            <DialogTitle>{t('newFolder')}</DialogTitle>
            <DialogDescription>{newFolderDraft?.parentPath || remotePath}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <span className="text-sm text-[var(--text-muted)]">{t('folderName')}</span>
            <Input
              value={newFolderDraft?.name || ''}
              disabled={transferring}
              placeholder={t('folderNamePlaceholder')}
              onChange={(event) => setNewFolderDraft((current) => current ? { ...current, name: event.target.value } : current)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void createDirectory()
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setNewFolderDraft(null)}>{t('cancel')}</Button>
            <Button onClick={() => void createDirectory()} disabled={transferring || !newFolderDraft?.name.trim()}>{t('confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={permissionDialogOpen} onOpenChange={(open) => {
        setPermissionDialogOpen(open)
        if (!open) {
          setPermissionEntry(null)
          setPermissionLoading(false)
        }
      }}>
        <DialogContent className="w-[min(92vw,680px)]">
          <DialogHeader>
            <DialogTitle>{t('permissions')}</DialogTitle>
            <DialogDescription>{permissionEntry?.path || ''}</DialogDescription>
          </DialogHeader>

          {permissionLoading ? (
            <div className="py-8 text-center text-sm text-[var(--text-muted)]">{t('loadingFiles')}</div>
          ) : permissionEntry ? (
            <div className="space-y-5">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Folder className="h-4 w-4 text-[var(--text-muted)]" />
                <span className="truncate">{permissionEntry.name}</span>
              </div>

              <div className="space-y-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-4">
                {[
                  { label: t('permissionOwner'), index: 0 },
                  { label: t('permissionGroup'), index: 1 },
                  { label: t('permissionPublic'), index: 2 },
                ].map((subject) => (
                  <div key={subject.label} className="grid grid-cols-[88px_repeat(3,minmax(0,1fr))] items-center gap-3 max-sm:grid-cols-[76px_repeat(3,minmax(0,1fr))]">
                    <span className="text-sm text-[var(--text-muted)]">{subject.label}</span>
                    {([
                      ['read', t('permissionRead')],
                      ['write', t('permissionWrite')],
                      ['execute', t('permissionExecute')],
                    ] as const).map(([field, label]) => (
                      <label key={field} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border border-[var(--border-subtle)] accent-[var(--accent)]"
                          checked={permissionTriples[subject.index]?.[field] || false}
                          onChange={(event) => setPermissionTriple(subject.index, field, event.target.checked)}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-sm text-[var(--text-muted)]">{t('permissionMode')}</span>
                  <Input
                    value={permissionDraft.mode}
                    maxLength={4}
                    onChange={(event) => {
                      const nextValue = event.target.value.replace(/[^0-7]/g, '').slice(0, 4)
                      setPermissionDraft((current) => ({
                        ...current,
                        mode: nextValue || current.mode,
                      }))
                    }}
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm text-[var(--text-muted)]">{t('permissionOwnerField')}</span>
                  <Input
                    value={permissionDraft.owner}
                    placeholder={t('permissionOwnerPlaceholder')}
                    onChange={(event) => setPermissionDraft((current) => ({ ...current, owner: event.target.value }))}
                  />
                </label>
              </div>

              {permissionEntry.kind === 'directory' && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border border-[var(--border-subtle)] accent-[var(--accent)]"
                    checked={permissionDraft.recursive}
                    onChange={(event) => setPermissionDraft((current) => ({ ...current, recursive: event.target.checked }))}
                  />
                  <span>{t('applyToSubdirectories')}</span>
                </label>
              )}
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="secondary" onClick={() => setPermissionDialogOpen(false)}>{t('cancel')}</Button>
            <Button
              onClick={() => void applyPermissions()}
              disabled={permissionLoading || permissionSubmitting || !/^[0-7]{3,4}$/.test(permissionDraft.mode)}
            >
              {t('confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(pendingAiCommandApproval)} onOpenChange={(open) => {
        if (!open) resolvePendingAiCommandApproval(false)
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('aiAssistantApproveExecutionTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('aiAssistantApproveExecutionDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2 font-mono text-xs leading-5 text-[var(--text-primary)] whitespace-pre-wrap break-all">
            {pendingAiCommandApproval?.text || ''}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => resolvePendingAiCommandApproval(false)}>
              {t('aiAssistantApproveExecutionCancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => resolvePendingAiCommandApproval(true)}>
              {t('aiAssistantApproveExecutionConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(deleteEntry)} onOpenChange={(open) => {
        if (!open) setDeleteEntry(null)
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('delete')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteEntry ? t('deleteRemoteEntryConfirm', { name: deleteEntry.name }) : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void deleteRemoteEntry()}>{t('delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
