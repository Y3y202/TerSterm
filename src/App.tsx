import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  Check,
  ChevronRight,
  Copy,
  FolderOpen,
  FolderPlus,
  Globe,
  LayoutGrid,
  Monitor,
  Moon,
  Minus,
  Play,
  Plus,
  RefreshCcw,
  Settings,
  Square,
  Sun,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import HostSystemIcon from './components/HostSystemIcon'
import TerminalPane, { type TerminalPaneHandle } from './components/TerminalPane'
import { SidebarToggleIcon } from './components/SidebarToggleIcon'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './components/ui/alert-dialog'
import { Button } from './components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from './components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog'
import { Input } from './components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select'
import { Textarea } from './components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from './components/ui/tooltip'
import {
  checkAppUpdate as fetchAppUpdate,
  downloadAppUpdate as fetchAppUpdatePackage,
  onAppUpdateDownloadProgress,
  onSshData,
  requestAiAssistantReply,
  setDesktopLocale as syncDesktopLocale,
  setWindowCloseBehavior as syncWindowCloseBehavior,
  sshConnect,
  sshDisconnect,
  sshGetSystemUsage,
  sshTestConnection,
  sshWrite,
} from './bridge'
import i18n, { getAppLocale, setAppLocale } from './i18n'
import {
  buildMultiHostSystemPrompt,
  parseMultiHostPlanReply,
  substituteMultiHostPlanVariables,
  type MultiHostPlan,
} from './lib/multi-host-ai'
import { useStateRef } from './lib/use-state-ref'
import { cn } from './lib/utils'
import type { AiAssistantPermission, AiAssistantSettings, AiProvider, AppUpdateDownloadProgress, ConnectionGroup, ConnectionProfile, SshPane, SystemUsage } from './types'

const CONNECTION_STORAGE_KEY = 'tersterm.connections'
const GROUP_STORAGE_KEY = 'tersterm.groups'
const SIDEBAR_WIDTH_STORAGE_KEY = 'tersterm.sidebarWidth'
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'tersterm.sidebarCollapsed'
const WINDOW_CLOSE_BEHAVIOR_STORAGE_KEY = 'tersterm.windowCloseBehavior'
const UPDATE_CHANNEL_STORAGE_KEY = 'tersterm.updateChannel'
const THEME_STORAGE_KEY = 'tersterm.theme'
const THEME_MODE_STORAGE_KEY = 'tersterm.themeMode'
const ANALYSIS_THEME_STORAGE_KEY = 'tersterm.analysisTheme'
const AI_ASSISTANT_SETTINGS_STORAGE_KEY = 'tersterm.aiAssistantSettings'
const DEFAULT_GROUP_ID = 'default'
const DEFAULT_GROUP_NAME = '默认'
const DEFAULT_GROUP_ALIASES = new Set(['默认', 'Default'])
const MAX_PANES = 4
const MIN_SIDEBAR_WIDTH = 152
const MAX_SIDEBAR_WIDTH = 340
const DEFAULT_SIDEBAR_WIDTH = 160
const LEGACY_SIDEBAR_WIDTHS = new Set([195, 210, 228, 240, 270, 300])

type ConnectionDraft = Omit<ConnectionProfile, 'id'> & { id?: string }
type DeepLinkUnlisten = () => void
type PendingPaneCredential = 'private_key_passphrase'
type UpdateChannel = 'stable' | 'prerelease'
type AppThemeId = 'sage' | 'ocean' | 'dawn' | 'violet' | 'slate'
type ThemeMode = 'light' | 'dark' | 'system'
type ResolvedThemeMode = Exclude<ThemeMode, 'system'>
type AnalysisThemeId = 'mint' | 'sky' | 'amber' | 'rose' | 'violet' | 'orange'
type WindowCloseBehavior = 'tray' | 'exit'
type SavedSettingsSnapshot = {
  appTheme: AppThemeId
  themeMode: ThemeMode
  analysisTheme: AnalysisThemeId
  updateChannel: UpdateChannel
  windowCloseBehavior: WindowCloseBehavior
  locale: ReturnType<typeof getAppLocale>
  aiProvider: AiProvider
  aiBaseUrl: string
  aiApiKey: string
  aiModel: string
  aiSystemPrompt: string
  aiTerminalPermission: AiAssistantPermission
}

type MultiHostExecutionStepStatus = 'pending' | 'running' | 'success' | 'error'

type MultiHostExecutionState = {
  status: 'idle' | 'running' | 'success' | 'error'
  message?: string
  activeStepId?: string
  stepStatuses: Record<string, { status: MultiHostExecutionStepStatus; message?: string }>
  variables: Record<string, string>
}

type MultiHostTarget = {
  paneId: string
  sessionId: string
  title: string
  host?: string
  username?: string
  hostPlatform?: string
  linuxDistro?: string
  role?: string
}

const appThemes = [
  {
    id: 'ocean',
    titleKey: 'themeOceanTitle',
    color: '#2563eb',
  },
  {
    id: 'sage',
    titleKey: 'themeSageTitle',
    color: '#16a34a',
  },
  {
    id: 'dawn',
    titleKey: 'themeDawnTitle',
    color: '#ea580c',
  },
  {
    id: 'violet',
    titleKey: 'themeVioletTitle',
    color: '#7c3aed',
  },
  {
    id: 'slate',
    titleKey: 'themeSlateTitle',
    color: '#64748b',
  },
] as const

const analysisThemes = [
  { id: 'mint', labelKey: 'analysisThemeMint', color: '#34d399' },
  { id: 'sky', labelKey: 'analysisThemeSky', color: '#38bdf8' },
  { id: 'amber', labelKey: 'analysisThemeAmber', color: '#fbbf24' },
  { id: 'rose', labelKey: 'analysisThemeRose', color: '#fb7185' },
  { id: 'violet', labelKey: 'analysisThemeViolet', color: '#a78bfa' },
  { id: 'orange', labelKey: 'analysisThemeOrange', color: '#fb923c' },
] as const

const splitLayouts = [
  { count: 1, titleKey: 'layoutSingle' },
  { count: 2, titleKey: 'layoutDual' },
  { count: 3, titleKey: 'layoutTriple' },
  { count: 4, titleKey: 'layoutQuad' },
] as const

const DEFAULT_THEME_ID: AppThemeId = 'sage'
const DEFAULT_THEME_MODE: ThemeMode = 'light'
const DEFAULT_ANALYSIS_THEME_ID: AnalysisThemeId = 'rose'
const DEFAULT_AI_PROVIDER: AiProvider = 'openai-compatible'
const DEFAULT_AI_TERMINAL_PERMISSION: AiAssistantPermission = 'type-only'
const DEFAULT_AI_SYSTEM_PROMPT = 'You are the TerSterm AI assistant. Help with Linux and Windows server operations, SSH troubleshooting, deployment, logs, file management, permissions, networking, and shell usage. Keep answers concise, practical, and accurate.'
const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

const isAppThemeId = (value: string | null): value is AppThemeId =>
  Boolean(value && appThemes.some((theme) => theme.id === value))

const isThemeMode = (value: string | null): value is ThemeMode =>
  value === 'light' || value === 'dark' || value === 'system'

const isAnalysisThemeId = (value: string | null): value is AnalysisThemeId =>
  Boolean(value && analysisThemes.some((theme) => theme.id === value))

const createId = (prefix: string) => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const getDefaultPaneTitle = (index: number) => i18n.t('terminalIndexedTitle', { index: index + 1 })
const getBasePaneTitle = () => i18n.t('terminalBaseTitle')

const groupIdFromName = (name: string) => {
  const normalized = name.trim()
  if (!normalized || DEFAULT_GROUP_ALIASES.has(normalized)) return DEFAULT_GROUP_ID
  return `group-${normalized.toLowerCase().replace(/\s+/g, '-')}`
}

const readStoredTheme = (): AppThemeId => {
  const storedTheme = localStorage.getItem(THEME_STORAGE_KEY)
  return isAppThemeId(storedTheme) ? storedTheme : DEFAULT_THEME_ID
}

const readStoredThemeMode = (): ThemeMode => {
  const storedMode = localStorage.getItem(THEME_MODE_STORAGE_KEY)
  return isThemeMode(storedMode) ? storedMode : DEFAULT_THEME_MODE
}

const readStoredAnalysisTheme = (): AnalysisThemeId => {
  const storedTheme = localStorage.getItem(ANALYSIS_THEME_STORAGE_KEY)
  return isAnalysisThemeId(storedTheme) ? storedTheme : DEFAULT_ANALYSIS_THEME_ID
}

const readStoredSidebarCollapsed = () => localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true'
const clampSidebarWidthValue = (width: number) => Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width))

const isValidPort = (value: number) => Number.isInteger(value) && value >= 1 && value <= 65_535

const parsePort = (value: number | string | null | undefined, fallbackOnEmpty = false) => {
  if (value == null) return fallbackOnEmpty ? 22 : undefined

  const normalizedValue = typeof value === 'string' ? value.trim() : value
  if (normalizedValue === '') return fallbackOnEmpty ? 22 : undefined

  const port = Number(normalizedValue)
  return isValidPort(port) ? port : undefined
}

const readStoredSidebarWidth = () => {
  const storedWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
  if (!Number.isFinite(storedWidth) || storedWidth <= 0) return DEFAULT_SIDEBAR_WIDTH

  const nextWidth = LEGACY_SIDEBAR_WIDTHS.has(storedWidth) ? DEFAULT_SIDEBAR_WIDTH : storedWidth
  return clampSidebarWidthValue(nextWidth)
}

const isWindowCloseBehavior = (value: string | null): value is WindowCloseBehavior => value === 'tray' || value === 'exit'
const readStoredWindowCloseBehavior = (): WindowCloseBehavior => {
  const storedBehavior = localStorage.getItem(WINDOW_CLOSE_BEHAVIOR_STORAGE_KEY)
  return isWindowCloseBehavior(storedBehavior) ? storedBehavior : 'exit'
}

const isUpdateChannel = (value: string | null): value is UpdateChannel => value === 'stable' || value === 'prerelease'
const readStoredUpdateChannel = (): UpdateChannel => {
  const storedChannel = localStorage.getItem(UPDATE_CHANNEL_STORAGE_KEY)
  return isUpdateChannel(storedChannel) ? storedChannel : 'stable'
}

const normalizeAiProvider = (value: string | null | undefined): AiProvider | undefined => {
  if (value === 'openai-compatible' || value === 'open-ai-compatible') return 'openai-compatible'
  if (value === 'anthropic') return 'anthropic'
  return undefined
}

const isAiAssistantPermission = (value: string | null): value is AiAssistantPermission =>
  value === 'reply-only' || value === 'type-only' || value === 'execute'

const sanitizeAiAssistantSettings = (value?: Partial<AiAssistantSettings> | null): AiAssistantSettings => ({
  provider: normalizeAiProvider(value?.provider) ?? DEFAULT_AI_PROVIDER,
  base_url: typeof value?.base_url === 'string' ? value.base_url : '',
  api_key: typeof value?.api_key === 'string' ? value.api_key : '',
  model: typeof value?.model === 'string' ? value.model : '',
  system_prompt: typeof value?.system_prompt === 'string' && value.system_prompt.trim()
    ? value.system_prompt
    : DEFAULT_AI_SYSTEM_PROMPT,
  terminal_permission: isAiAssistantPermission(value?.terminal_permission ?? null) ? value!.terminal_permission! : DEFAULT_AI_TERMINAL_PERMISSION,
})

const areAiAssistantSettingsEqual = (left: AiAssistantSettings, right: AiAssistantSettings) =>
  left.provider === right.provider &&
  left.base_url === right.base_url &&
  left.api_key === right.api_key &&
  left.model === right.model &&
  left.system_prompt === right.system_prompt &&
  left.terminal_permission === right.terminal_permission

const readStoredAiAssistantSettings = (): AiAssistantSettings => {
  const raw = localStorage.getItem(AI_ASSISTANT_SETTINGS_STORAGE_KEY)
  if (!raw) return sanitizeAiAssistantSettings()

  try {
    return sanitizeAiAssistantSettings(JSON.parse(raw) as Partial<AiAssistantSettings>)
  } catch {
    return sanitizeAiAssistantSettings()
  }
}

const resolveThemeMode = (mode: ThemeMode, prefersDark: boolean): ResolvedThemeMode =>
  mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode

const applyAppTheme = (
  themeId: AppThemeId,
  themeMode: ResolvedThemeMode,
  analysisThemeId: AnalysisThemeId,
) => {
  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.themeMode = themeMode
  document.documentElement.dataset.themeAnalysis = analysisThemeId
}

const defaultGroup = (): ConnectionGroup => ({
  id: DEFAULT_GROUP_ID,
  name: DEFAULT_GROUP_NAME,
  expanded: true,
})

const getPreferredGroupId = (
  availableGroups: Pick<ConnectionGroup, 'id'>[],
  preferredGroupId = DEFAULT_GROUP_ID,
) => {
  if (availableGroups.some((group) => group.id === preferredGroupId)) return preferredGroupId
  return availableGroups[0]?.id || preferredGroupId
}

const resolveConnectionGroupId = (
  connection: Pick<ConnectionProfile, 'group_id' | 'group'>,
  availableGroups: Pick<ConnectionGroup, 'id'>[],
) => {
  const knownGroupIds = new Set(availableGroups.map((group) => group.id))

  if (connection.group_id && knownGroupIds.has(connection.group_id)) {
    return connection.group_id
  }

  const legacyGroupId = groupIdFromName(connection.group || '')
  if (knownGroupIds.has(legacyGroupId)) {
    return legacyGroupId
  }

  return getPreferredGroupId(availableGroups)
}

const createPane = (index: number): SshPane => ({
  id: createId('pane'),
  title: getDefaultPaneTitle(index),
  status: 'idle',
})

const readRawConnections = (): ConnectionProfile[] => {
  const raw = localStorage.getItem(CONNECTION_STORAGE_KEY)
  if (!raw) return []

  try {
    return JSON.parse(raw) as ConnectionProfile[]
  } catch {
    return []
  }
}

const readStoredGroups = (rawConnections: ConnectionProfile[]): ConnectionGroup[] => {
  const raw = localStorage.getItem(GROUP_STORAGE_KEY)
  let storedGroups: ConnectionGroup[] = []

  if (raw) {
    try {
      storedGroups = JSON.parse(raw) as ConnectionGroup[]
    } catch {
      storedGroups = []
    }
  }

  const byId = new Map<string, ConnectionGroup>()
  storedGroups.forEach((group) => {
    const id = group.id || groupIdFromName(group.name)
    const name = group.name?.trim() || DEFAULT_GROUP_NAME
    byId.set(id, {
      id,
      name,
      expanded: group.expanded !== false,
    })
  })

  rawConnections.forEach((connection) => {
    const legacyName = connection.group?.trim()
    if (!legacyName) return

    const id = connection.group_id || groupIdFromName(legacyName)
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        name: legacyName,
        expanded: true,
      })
    }
  })

  if (byId.size === 0) {
    const group = defaultGroup()
    byId.set(group.id, group)
  }

  return Array.from(byId.values())
}

const normalizeConnections = (rawConnections: ConnectionProfile[], availableGroups: ConnectionGroup[]): ConnectionProfile[] =>
  rawConnections.map((connection) => ({
    ...connection,
    port: parsePort(connection.port, true) ?? 22,
    group_id: resolveConnectionGroupId(connection, availableGroups),
    group: undefined,
  }))

const mergeDetectedHostInfo = (connection: ConnectionProfile, usage: Pick<SystemUsage, 'host_platform' | 'linux_distro'>) => {
  const nextHostPlatform = usage.host_platform || connection.host_platform
  const nextLinuxDistro = usage.linux_distro || connection.linux_distro

  if (nextHostPlatform === connection.host_platform && nextLinuxDistro === connection.linux_distro) {
    return connection
  }

  return {
    ...connection,
    host_platform: nextHostPlatform,
    linux_distro: nextLinuxDistro,
  }
}

const createInitialState = () => {
  const rawConnections = readRawConnections()
  const groups = readStoredGroups(rawConnections)
  const connections = normalizeConnections(rawConnections, groups)
  const pane = createPane(0)

  return {
    groups,
    connections,
    panes: [pane],
    visiblePaneIds: [pane.id],
    activePaneId: pane.id,
  }
}

const connectionUsesPrivateKey = (connection?: ConnectionProfile) =>
  Boolean(connection?.private_key?.trim() || connection?.private_key_path?.trim())

const stripTerminalControlSequences = (output: string) =>
  output.replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, '')

const stripConfiguredPassphrasePrompt = (output: string) =>
  output.replace(/Enter passphrase for key[^\r\n]*:\s*/gi, '')

const hasPrivateKeyPassphrasePrompt = (output: string) => {
  const value = stripTerminalControlSequences(output).toLowerCase()
  return value.includes('enter passphrase for key') || value.includes('passphrase for key')
}

const terminalOutputLines = (output: string) =>
  output
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean)

const OUTPUT_PROBE_LIMIT = 12_000

const lineLooksLikeShellPrompt = (line: string) =>
  /[@][^\s:]+(?::|[~/]|\s+)[^\r\n]*[#>$%]$/.test(line) ||
  /^\[[^\]]+\][#>$%]$/.test(line) ||
  /^[^\s]{1,80}[#>$%]$/.test(line)

const paneLooksAuthenticated = (pane: SshPane) => {
  const output = stripTerminalControlSequences(pane.terminal_output || '')
  const trailingLines = terminalOutputLines(output).slice(-5)

  return (
    output.includes('Welcome to ') ||
    output.includes('Last login:') ||
    trailingLines.some(lineLooksLikeShellPrompt)
  )
}

const formatUpdateBytes = (bytes?: number) => {
  if (!bytes || bytes <= 0) return '--'

  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }

  return `${size >= 100 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`
}

const formatReleaseDate = (value?: string) => {
  if (!value) return '--'

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString(getAppLocale() === 'zh-CN' ? 'zh-CN' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export default function App() {
  const { t } = useTranslation()
  const initialState = useRef(createInitialState()).current
  const initialAiAssistantSettingsRef = useRef(readStoredAiAssistantSettings())
  const [groups, setGroups, groupsRef] = useStateRef<ConnectionGroup[]>(initialState.groups)
  const [connections, setConnections, connectionsRef] = useStateRef<ConnectionProfile[]>(initialState.connections)
  const [panes, setPanes, panesRef] = useStateRef<SshPane[]>(initialState.panes)
  const [visiblePaneIds, setVisiblePaneIds, visiblePaneIdsRef] = useStateRef<string[]>(initialState.visiblePaneIds)
  const [activePaneId, setActivePaneId, activePaneIdRef] = useStateRef(initialState.activePaneId)
  const [searchText] = useState('')
  const deferredSearchText = useDeferredValue(searchText)
  const [connectionModalOpen, setConnectionModalOpen] = useState(false)
  const [connectPanePickerPaneId, setConnectPanePickerPaneId] = useState<string | null>(null)
  const [groupModalOpen, setGroupModalOpen] = useState(false)
  const [settingsModalOpen, setSettingsModalOpen] = useState(false)
  const [testingConnection, setTestingConnection] = useState(false)
  const [appUpdateProgress, setAppUpdateProgress] = useStateRef<AppUpdateDownloadProgress | undefined>(undefined)
  const [downloadingAppUpdate, setDownloadingAppUpdate] = useStateRef(false)
  const [appTheme, setAppTheme] = useStateRef<AppThemeId>(readStoredTheme())
  const [themeMode, setThemeMode] = useState<ThemeMode>(readStoredThemeMode())
  const [analysisTheme] = useState<AnalysisThemeId>(readStoredAnalysisTheme())
  const [aiAssistantSettings, setAiAssistantSettings, aiAssistantSettingsRef] = useStateRef<AiAssistantSettings>(initialAiAssistantSettingsRef.current)
  const [aiAssistantDraftSettings, setAiAssistantDraftSettings] = useState<AiAssistantSettings>(initialAiAssistantSettingsRef.current)
  const [multiHostAiOpen, setMultiHostAiOpen] = useState(false)
  const [multiHostSelectedPaneIds, setMultiHostSelectedPaneIds] = useState<string[]>([])
  const [multiHostRoles, setMultiHostRoles] = useState<Record<string, string>>({})
  const [multiHostMessages, setMultiHostMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const [multiHostDraft, setMultiHostDraft] = useState('')
  const [multiHostSending, setMultiHostSending] = useState(false)
  const [multiHostPlan, setMultiHostPlan] = useState<MultiHostPlan | null>(null)
  const [multiHostExecution, setMultiHostExecution] = useState<MultiHostExecutionState | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed, sidebarCollapsedRef] = useStateRef(readStoredSidebarCollapsed())
  const [updateChannel, setUpdateChannel, updateChannelRef] = useStateRef<UpdateChannel>(readStoredUpdateChannel())
  const [windowCloseBehavior, setWindowCloseBehavior, windowCloseBehaviorRef] = useStateRef<WindowCloseBehavior>(readStoredWindowCloseBehavior())
  const [desktopWindowReady, setDesktopWindowReady] = useState(false)
  const [desktopWindowMaximized, setDesktopWindowMaximized] = useState(false)
  const [sidebarWidth, setSidebarWidth, sidebarWidthRef] = useStateRef(readStoredSidebarWidth())
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const [selectedConnectionId, setSelectedConnectionId, selectedConnectionIdRef] = useStateRef<string | undefined>(undefined)
  const [syncInputEnabled, setSyncInputEnabled, syncInputEnabledRef] = useStateRef(false)
  const [syncedPaneIds, setSyncedPaneIds, syncedPaneIdsRef] = useStateRef<string[]>([])
  const [connectionForm, setConnectionForm] = useState<ConnectionDraft>(() => ({
    name: '',
    host: '',
    port: 22,
    username: '',
    password: '',
    private_key_path: '',
    private_key: '',
    private_key_passphrase: '',
    group_id: getPreferredGroupId(initialState.groups),
  }))
  const [groupForm, setGroupForm] = useState({ id: '', name: '' })
  const [groupPendingDelete, setGroupPendingDelete] = useState<ConnectionGroup | null>(null)
  const terminalRefs = useRef<Record<string, TerminalPaneHandle | null>>({})
  const pendingConnectPaneIdRef = useRef<string>()
  const unlistenDeepLinkRef = useRef<DeepLinkUnlisten>()
  const unlistenSshDataRef = useRef<DeepLinkUnlisten>()
  const unlistenAppUpdateProgressRef = useRef<DeepLinkUnlisten>()
  const systemUsageTimerRef = useRef<number>()
  const systemUsageRequestIdsRef = useRef(new Map<string, number>())
  const systemUsagePendingPaneIdsRef = useRef(new Map<string, number>())
  const pendingPaneCredentialsRef = useRef(new Map<string, PendingPaneCredential>())
  const pendingPaneCredentialBuffersRef = useRef(new Map<string, string>())
  const paneOutputProbeBuffersRef = useRef(new Map<string, string>())
  const [systemPrefersDark, setSystemPrefersDark] = useState(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const savedSettingsRef = useRef<SavedSettingsSnapshot>({
    appTheme,
    themeMode,
    analysisTheme,
    updateChannel,
    windowCloseBehavior,
    locale: getAppLocale(),
    aiProvider: aiAssistantSettings.provider,
    aiBaseUrl: aiAssistantSettings.base_url,
    aiApiKey: aiAssistantSettings.api_key,
    aiModel: aiAssistantSettings.model,
    aiSystemPrompt: aiAssistantSettings.system_prompt,
    aiTerminalPermission: aiAssistantSettings.terminal_permission,
  })
  const settingsSavedToastTimerRef = useRef<number>()
  const notifySettingsSaved = useCallback(() => {
    if (settingsSavedToastTimerRef.current) {
      window.clearTimeout(settingsSavedToastTimerRef.current)
    }

    settingsSavedToastTimerRef.current = window.setTimeout(() => {
      toast.success(i18n.t('settingsSaved'), { id: 'settings-saved' })
    }, 120)
  }, [])
  const recordSettingsSaved = useCallback((nextSettings: SavedSettingsSnapshot) => {
    const previousSettings = savedSettingsRef.current
    const changed =
      previousSettings.appTheme !== nextSettings.appTheme ||
      previousSettings.themeMode !== nextSettings.themeMode ||
      previousSettings.analysisTheme !== nextSettings.analysisTheme ||
      previousSettings.updateChannel !== nextSettings.updateChannel ||
      previousSettings.windowCloseBehavior !== nextSettings.windowCloseBehavior ||
      previousSettings.locale !== nextSettings.locale ||
      previousSettings.aiProvider !== nextSettings.aiProvider ||
      previousSettings.aiBaseUrl !== nextSettings.aiBaseUrl ||
      previousSettings.aiApiKey !== nextSettings.aiApiKey ||
      previousSettings.aiModel !== nextSettings.aiModel ||
      previousSettings.aiSystemPrompt !== nextSettings.aiSystemPrompt ||
      previousSettings.aiTerminalPermission !== nextSettings.aiTerminalPermission

    savedSettingsRef.current = nextSettings

    if (changed) {
      notifySettingsSaved()
    }
  }, [notifySettingsSaved])
  // Serialize async shell syncs so rapid setting toggles keep the latest value.
  const pendingWindowCloseBehaviorSyncRef = useRef<WindowCloseBehavior>()
  const syncingWindowCloseBehaviorRef = useRef(false)
  const flushWindowCloseBehaviorSync = useCallback(() => {
    if (syncingWindowCloseBehaviorRef.current) return

    syncingWindowCloseBehaviorRef.current = true
    void (async () => {
      try {
        while (pendingWindowCloseBehaviorSyncRef.current) {
          const nextBehavior = pendingWindowCloseBehaviorSyncRef.current
          pendingWindowCloseBehaviorSyncRef.current = undefined

          await syncWindowCloseBehavior(nextBehavior).catch(() => undefined)

          if (!pendingWindowCloseBehaviorSyncRef.current && windowCloseBehaviorRef.current !== nextBehavior) {
            pendingWindowCloseBehaviorSyncRef.current = windowCloseBehaviorRef.current
          }
        }
      } finally {
        syncingWindowCloseBehaviorRef.current = false
        if (pendingWindowCloseBehaviorSyncRef.current) {
          flushWindowCloseBehaviorSync()
        }
      }
    })()
  }, [windowCloseBehaviorRef])
  const pendingDesktopLocaleSyncRef = useRef<ReturnType<typeof getAppLocale>>()
  const syncingDesktopLocaleRef = useRef(false)
  const flushDesktopLocaleSync = useCallback(() => {
    if (syncingDesktopLocaleRef.current) return

    syncingDesktopLocaleRef.current = true
    void (async () => {
      try {
        while (pendingDesktopLocaleSyncRef.current) {
          const nextLocale = pendingDesktopLocaleSyncRef.current
          pendingDesktopLocaleSyncRef.current = undefined

          await syncDesktopLocale(nextLocale).catch(() => undefined)

          const latestLocale = getAppLocale()
          if (!pendingDesktopLocaleSyncRef.current && latestLocale !== nextLocale) {
            pendingDesktopLocaleSyncRef.current = latestLocale
          }
        }
      } finally {
        syncingDesktopLocaleRef.current = false
        if (pendingDesktopLocaleSyncRef.current) {
          flushDesktopLocaleSync()
        }
      }
    })()
  }, [])

  const updateInfoQuery = useQuery({
    queryKey: ['app-update', updateChannel],
    queryFn: () => fetchAppUpdate(updateChannelRef.current === 'prerelease'),
    enabled: false,
    staleTime: 60_000,
  })

  const appUpdateInfo = updateInfoQuery.data
  const checkingAppUpdate = updateInfoQuery.isFetching
  const appLocale = getAppLocale()
  const resolvedThemeMode = resolveThemeMode(themeMode, systemPrefersDark)
  const closeBehaviorOptions = [
    { value: 'tray' as const, label: t('windowCloseBehaviorTray') },
    { value: 'exit' as const, label: t('windowCloseBehaviorExit') },
  ]
  const updateChannelOptions = [
    { value: 'stable' as const, label: t('updateChannelStable') },
    { value: 'prerelease' as const, label: t('updateChannelPrerelease') },
  ]
  const languageOptions = [
    { value: 'zh-CN' as const, label: '中文' },
    { value: 'en-US' as const, label: 'English' },
  ]
  const currentWindowCloseBehaviorLabel =
    closeBehaviorOptions.find((option) => option.value === windowCloseBehavior)?.label ?? t('windowCloseBehaviorExit')
  const currentUpdateChannelLabel =
    updateChannelOptions.find((option) => option.value === updateChannel)?.label ?? t('updateChannelStable')
  const appUpdateProgressPercent = Math.round(appUpdateProgress?.percent || 0)
  const appUpdateStatusLabel = appUpdateProgress?.status === 'installing'
    ? t('updateInstalling')
    : downloadingAppUpdate
      ? t('updateDownloading')
      : checkingAppUpdate
        ? t('updateChecking')
        : !appUpdateInfo
          ? t('updateNotChecked')
          : appUpdateInfo.update_available
            ? appUpdateInfo.download_asset
              ? t('updateAvailable', { version: appUpdateInfo.latest_version })
              : t('updateAvailableNoPackage', { version: appUpdateInfo.latest_version })
            : t('updateAlreadyLatest')
  const appUpdateReleaseChannelLabel = appUpdateInfo?.prerelease ? t('updateChannelPrerelease') : t('updateChannelStable')
  const groupNameById = new Map(groups.map((group) => [group.id, group.id === DEFAULT_GROUP_ID ? t('defaultGroupName') : group.name]))
  const filteredConnections = (() => {
    const query = deferredSearchText.trim().toLowerCase()
    if (!query) return connections

    return connections.filter((connection) =>
      [connection.name, connection.host, connection.username, groupNameById.get(resolveConnectionGroupId(connection, groups))]
        .filter(Boolean)
        .some((part) => part!.toLowerCase().includes(query)),
    )
  })()
  const hasSearchQuery = deferredSearchText.trim().length > 0
  const groupedConnections = groups
    .map((group) => {
      const items = filteredConnections.filter(
        (connection) => resolveConnectionGroupId(connection, groups) === group.id,
      )

      return {
        ...group,
        items,
        visible: hasSearchQuery ? items.length > 0 : true,
        expanded: hasSearchQuery ? true : group.expanded,
      }
    })
    .filter((group) => group.visible)
  const visiblePanes = visiblePaneIds
    .map((paneId) => panes.find((pane) => pane.id === paneId))
    .filter((pane): pane is SshPane => Boolean(pane))
  const visibleConnectedPanes = visiblePanes.filter((pane) => pane.status === 'connected' && pane.session_id)
  const connectedPanes = panes.filter((pane) => pane.status === 'connected' && pane.session_id)
  const multiHostTargets: MultiHostTarget[] = connectedPanes.map((pane) => ({
    paneId: pane.id,
    sessionId: pane.session_id!,
    title: pane.title,
    host: pane.connection?.host,
    username: pane.connection?.username,
    hostPlatform: pane.connection?.host_platform,
    linuxDistro: pane.connection?.linux_distro,
    role: multiHostRoles[pane.id]?.trim() || undefined,
  }))
  const selectedMultiHostTargets = multiHostTargets.filter((target) => multiHostSelectedPaneIds.includes(target.paneId))
  const syncTargetPanes = visibleConnectedPanes.filter((pane) => syncedPaneIds.includes(pane.id))
  const canBroadcastInput = syncInputEnabled && syncTargetPanes.length >= 2
  const syncStatusSummary = visibleConnectedPanes.length < 2
    ? t('syncNeedTwoSessions')
    : syncInputEnabled
      ? t('syncSyncedCount', { count: syncedPaneIds.length })
      : syncedPaneIds.length >= 2
        ? t('syncSelectedCount', { count: syncedPaneIds.length })
        : t('syncNotEnabled')
  const groupOptions = groups.map((group) => ({
    value: group.id,
    label: group.id === DEFAULT_GROUP_ID ? t('defaultGroupName') : group.name,
  }))
  const themeModeOptions = [
    { value: 'light' as const, label: t('themeModeLight'), icon: Sun },
    { value: 'dark' as const, label: t('themeModeDark'), icon: Moon },
    { value: 'system' as const, label: t('themeModeSystem'), icon: Monitor },
  ]
  const aiProviderOptions = [
    { value: 'openai-compatible' as const, label: t('aiProviderOpenAICompatible') },
    { value: 'anthropic' as const, label: t('aiProviderAnthropic') },
  ]
  const aiTerminalPermissionOptions = [
    { value: 'reply-only' as const, label: t('aiPermissionReplyOnly'), hint: t('aiPermissionReplyOnlyHint') },
    { value: 'type-only' as const, label: t('aiPermissionTypeOnly'), hint: t('aiPermissionTypeOnlyHint') },
    { value: 'execute' as const, label: t('aiPermissionExecute'), hint: t('aiPermissionExecuteHint') },
  ]
  const aiDefaultEndpoint = aiAssistantDraftSettings.provider === 'anthropic'
    ? 'https://api.anthropic.com/v1/messages'
    : 'https://api.openai.com/v1/chat/completions'
  const hasPendingAiAssistantSettingsChanges = !areAiAssistantSettingsEqual(aiAssistantDraftSettings, aiAssistantSettings)
  const recordSettingsPatch = useCallback((patch: Partial<SavedSettingsSnapshot>) => {
    recordSettingsSaved({ ...savedSettingsRef.current, ...patch })
  }, [recordSettingsSaved])
  const handleSettingsModalOpenChange = useCallback((nextOpen: boolean) => {
    setSettingsModalOpen(nextOpen)
    setAiAssistantDraftSettings({ ...aiAssistantSettingsRef.current })
  }, [aiAssistantSettingsRef])
  const saveAiAssistantSettings = useCallback(() => {
    const nextSettings = sanitizeAiAssistantSettings(aiAssistantDraftSettings)
    localStorage.setItem(AI_ASSISTANT_SETTINGS_STORAGE_KEY, JSON.stringify(nextSettings))
    setAiAssistantSettings(nextSettings)
    setAiAssistantDraftSettings(nextSettings)
    recordSettingsSaved({
      ...savedSettingsRef.current,
      aiProvider: nextSettings.provider,
      aiBaseUrl: nextSettings.base_url,
      aiApiKey: nextSettings.api_key,
      aiModel: nextSettings.model,
      aiSystemPrompt: nextSettings.system_prompt,
      aiTerminalPermission: nextSettings.terminal_permission,
    })
  }, [aiAssistantDraftSettings, recordSettingsSaved, setAiAssistantSettings])
  const handleThemeModeChange = useCallback((nextThemeMode: ThemeMode) => {
    if (themeMode === nextThemeMode) return

    setThemeMode(nextThemeMode)
    localStorage.setItem(THEME_MODE_STORAGE_KEY, nextThemeMode)
    recordSettingsPatch({ themeMode: nextThemeMode })
  }, [recordSettingsPatch, themeMode])
  const handleAppThemeChange = useCallback((nextAppTheme: AppThemeId) => {
    if (appTheme === nextAppTheme) return

    setAppTheme(nextAppTheme)
    localStorage.setItem(THEME_STORAGE_KEY, nextAppTheme)
    recordSettingsPatch({ appTheme: nextAppTheme })
  }, [appTheme, recordSettingsPatch, setAppTheme])
  const handleUpdateChannelChange = useCallback((nextUpdateChannel: UpdateChannel) => {
    if (updateChannel === nextUpdateChannel) return

    setUpdateChannel(nextUpdateChannel)
    localStorage.setItem(UPDATE_CHANNEL_STORAGE_KEY, nextUpdateChannel)
    setAppUpdateProgress(undefined)
    recordSettingsPatch({ updateChannel: nextUpdateChannel })
  }, [recordSettingsPatch, setAppUpdateProgress, setUpdateChannel, updateChannel])
  const handleWindowCloseBehaviorChange = useCallback((nextBehavior: WindowCloseBehavior) => {
    if (windowCloseBehavior === nextBehavior) return

    setWindowCloseBehavior(nextBehavior)
    localStorage.setItem(WINDOW_CLOSE_BEHAVIOR_STORAGE_KEY, nextBehavior)
    recordSettingsPatch({ windowCloseBehavior: nextBehavior })
    pendingWindowCloseBehaviorSyncRef.current = nextBehavior
    flushWindowCloseBehaviorSync()
  }, [flushWindowCloseBehaviorSync, recordSettingsPatch, setWindowCloseBehavior, windowCloseBehavior])

  useEffect(() => {
    applyAppTheme(appTheme, resolvedThemeMode, analysisTheme)
    localStorage.setItem(THEME_STORAGE_KEY, appTheme)
    localStorage.setItem(THEME_MODE_STORAGE_KEY, themeMode)
    localStorage.setItem(ANALYSIS_THEME_STORAGE_KEY, analysisTheme)
    recordSettingsSaved({ ...savedSettingsRef.current, appTheme, themeMode, analysisTheme })
  }, [analysisTheme, appTheme, recordSettingsSaved, resolvedThemeMode, themeMode])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches)

    setSystemPrefersDark(mediaQuery.matches)
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    let disposed = false
    let unlistenResize: (() => void) | undefined

    void (async () => {
      try {
        const appWindow = getCurrentWindow()
        const maximized = await appWindow.isMaximized()
        if (disposed) return

        setDesktopWindowReady(true)
        setDesktopWindowMaximized(maximized)
        unlistenResize = await appWindow.onResized(async () => {
          try {
            const nextMaximized = await appWindow.isMaximized()
            if (!disposed) {
              setDesktopWindowMaximized(nextMaximized)
            }
          } catch {
            // Ignore non-Tauri runtimes.
          }
        })
      } catch {
        // Window controls are only available in the Tauri runtime.
      }
    })()

    return () => {
      disposed = true
      unlistenResize?.()
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    localStorage.setItem(UPDATE_CHANNEL_STORAGE_KEY, updateChannel)
    setAppUpdateProgress(undefined)
    recordSettingsSaved({ ...savedSettingsRef.current, updateChannel })
  }, [recordSettingsSaved, setAppUpdateProgress, updateChannel])

  useEffect(() => {
    localStorage.setItem(WINDOW_CLOSE_BEHAVIOR_STORAGE_KEY, windowCloseBehavior)
    recordSettingsSaved({ ...savedSettingsRef.current, windowCloseBehavior })
    pendingWindowCloseBehaviorSyncRef.current = windowCloseBehavior
    flushWindowCloseBehaviorSync()
  }, [flushWindowCloseBehaviorSync, recordSettingsSaved, windowCloseBehavior])

  useEffect(() => {
    localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(connections))
  }, [connections])

  useEffect(() => {
    localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(groups))
  }, [groups])

  useEffect(() => {
    recordSettingsSaved({ ...savedSettingsRef.current, locale: appLocale })
    pendingDesktopLocaleSyncRef.current = appLocale
    flushDesktopLocaleSync()
    setPanes((current) =>
      current.map((pane, index) => {
        if (pane.connection) return pane

        const nextTitle = getDefaultPaneTitle(index)
        return pane.title === nextTitle ? pane : { ...pane, title: nextTitle }
      }),
    )
  }, [appLocale, flushDesktopLocaleSync, recordSettingsSaved, setPanes])

  useEffect(() => () => {
    if (settingsSavedToastTimerRef.current) {
      window.clearTimeout(settingsSavedToastTimerRef.current)
    }
  }, [])

  useEffect(() => {
    pruneSyncTargets()
  }, [setSyncedPaneIds, setSyncInputEnabled, syncedPaneIdsRef, visibleConnectedPanes.map((pane) => `${pane.id}:${pane.session_id}`).join('|')])

  useEffect(() => {
    const availablePaneIds = new Set(connectedPanes.map((pane) => pane.id))
    setMultiHostSelectedPaneIds((current) => current.filter((paneId) => availablePaneIds.has(paneId)))
  }, [connectedPanes.map((pane) => `${pane.id}:${pane.session_id}`).join('|')])

  const scheduleFitAllTerminals = () => {
    requestAnimationFrame(() => {
      Object.values(terminalRefs.current).forEach((terminal) => terminal?.fitTerminal())
    })
  }

  const scheduleFitPane = (paneId: string) => {
    requestAnimationFrame(() => {
      terminalRefs.current[paneId]?.fitTerminal()
    })
  }

  const updatePaneById = (paneId: string, updater: (pane: SshPane) => SshPane) => {
    setPanes((current) => current.map((pane) => (pane.id === paneId ? updater(pane) : pane)))
  }

  const getPaneById = (paneId: string) => panesRef.current.find((pane) => pane.id === paneId)
  const getPaneBySessionId = (sessionId: string) => panesRef.current.find((pane) => pane.session_id === sessionId)

  const getPaneOutputProbe = (paneId: string) => paneOutputProbeBuffersRef.current.get(paneId) || ''

  const appendPaneOutputProbe = (paneId: string, chunk: string) => {
    const nextOutput = `${getPaneOutputProbe(paneId)}${chunk}`
    const trimmed = nextOutput.length > OUTPUT_PROBE_LIMIT ? nextOutput.slice(-OUTPUT_PROBE_LIMIT) : nextOutput
    paneOutputProbeBuffersRef.current.set(paneId, trimmed)
    return trimmed
  }

  const clearPaneOutputProbe = (paneId: string) => {
    paneOutputProbeBuffersRef.current.delete(paneId)
  }

  const clearPendingPaneCredential = (paneId: string) => {
    pendingPaneCredentialsRef.current.delete(paneId)
    pendingPaneCredentialBuffersRef.current.delete(paneId)
  }

  const shouldRefreshPaneSystemUsage = (pane: SshPane) => Boolean(pane.connection && pane.session_id && pane.remote_features_ready)

  const refreshPaneSystemUsage = async (pane: SshPane) => {
    if (!pane.connection || !pane.session_id || pane.status !== 'connected') return
    if (systemUsagePendingPaneIdsRef.current.has(pane.id)) return

    const sessionId = pane.session_id
    const requestId = (systemUsageRequestIdsRef.current.get(pane.id) || 0) + 1
    systemUsageRequestIdsRef.current.set(pane.id, requestId)
    systemUsagePendingPaneIdsRef.current.set(pane.id, requestId)
    updatePaneById(pane.id, (current) => ({ ...current, system_usage_loading: true, system_usage_error: undefined }))

    try {
      const usage = await sshGetSystemUsage(pane.connection, sessionId)
      const currentPane = getPaneById(pane.id)
      if (
        currentPane &&
        systemUsageRequestIdsRef.current.get(pane.id) === requestId &&
        currentPane.session_id === sessionId &&
        currentPane.status === 'connected'
      ) {
        const nextConnection = currentPane.connection
          ? mergeDetectedHostInfo(currentPane.connection, usage)
          : currentPane.connection

        updatePaneById(pane.id, (current) => ({
          ...current,
          connection: nextConnection,
          system_usage: usage,
          system_usage_error: undefined,
        }))

        if (nextConnection && currentPane.connection && nextConnection !== currentPane.connection) {
          setConnections((current) =>
            current.map((connection) => (connection.id === nextConnection.id ? nextConnection : connection)),
          )
        }
      }
    } catch (error) {
      const currentPane = getPaneById(pane.id)
      if (
        currentPane &&
        systemUsageRequestIdsRef.current.get(pane.id) === requestId &&
        currentPane.session_id === sessionId &&
        currentPane.status === 'connected'
      ) {
        updatePaneById(pane.id, (current) => ({
          ...current,
          system_usage_error: error instanceof Error ? error.message : String(error),
        }))
      }
    } finally {
      if (systemUsagePendingPaneIdsRef.current.get(pane.id) === requestId) {
        systemUsagePendingPaneIdsRef.current.delete(pane.id)
        updatePaneById(pane.id, (current) => ({ ...current, system_usage_loading: false }))
      }
    }
  }

  const markPaneRemoteFeaturesReady = (paneId: string) => {
    updatePaneById(paneId, (current) => ({
      ...current,
      remote_features_ready: true,
      status: current.status === 'connecting' ? 'connected' : current.status,
      system_usage_error: current.system_usage ? current.system_usage_error : undefined,
    }))

    const currentPane = getPaneById(paneId)
    if (currentPane && !currentPane.system_usage) {
      void refreshPaneSystemUsage({ ...currentPane, remote_features_ready: true, status: 'connected' })
    }
  }

  const stopPaneSession = async (pane: SshPane) => {
    const sessionId = pane.session_id
    if (!sessionId) return

    updatePaneById(pane.id, (current) => ({
      ...current,
      status: 'closed',
      private_key_passphrase_origin: undefined,
      remote_features_ready: false,
      error: undefined,
      zmodem_active: false,
      system_usage: undefined,
      system_usage_loading: false,
      system_usage_error: undefined,
    }))

    systemUsageRequestIdsRef.current.delete(pane.id)
    systemUsagePendingPaneIdsRef.current.delete(pane.id)
    clearPendingPaneCredential(pane.id)
    clearPaneOutputProbe(pane.id)

    try {
      await sshDisconnect(sessionId)
    } catch (error) {
      const currentPane = getPaneById(pane.id)
      if (currentPane?.session_id === sessionId) {
        updatePaneById(pane.id, (current) => ({
          ...current,
          error: error instanceof Error ? error.message : String(error),
        }))
      }
    }

    const currentPane = getPaneById(pane.id)
    if (currentPane?.session_id === sessionId) {
      updatePaneById(pane.id, (current) => ({ ...current, session_id: undefined }))
    }
  }

  const refreshAllSystemUsage = () => {
    panesRef.current.forEach((pane) => {
      if (pane.status === 'connected' && pane.session_id && shouldRefreshPaneSystemUsage(pane)) {
        void refreshPaneSystemUsage(pane)
      }
    })
  }

  const setTerminalRef = (paneId: string, terminal: TerminalPaneHandle | null) => {
    if (!terminal) {
      delete terminalRefs.current[paneId]
      return
    }

    terminalRefs.current[paneId] = terminal
  }

  const showPane = (paneId: string) => {
    const current = visiblePaneIdsRef.current.filter((id) => panesRef.current.some((pane) => pane.id === id))
    if (!current.includes(paneId)) {
      const nextVisible = current.length === 0 ? [paneId] : [...current]
      const replaceIndex = Math.max(0, nextVisible.indexOf(activePaneIdRef.current))
      nextVisible[replaceIndex] = paneId
      setVisiblePaneIds(nextVisible)
    }

    setActivePaneId(paneId)
    scheduleFitPane(paneId)
  }

  const switchToPane = (paneId: string) => {
    const current = visiblePaneIdsRef.current.filter((id) => panesRef.current.some((pane) => pane.id === id))
    if (!current.includes(paneId)) {
      const nextVisible = [...current]
      const replaceIndex = Math.max(0, nextVisible.indexOf(activePaneIdRef.current))
      nextVisible[replaceIndex] = paneId
      setVisiblePaneIds(nextVisible)
    }

    setActivePaneId(paneId)
    scheduleFitPane(paneId)
  }

  const getSelectableSyncPaneIds = () =>
    visiblePaneIdsRef.current
      .map((paneId) => panesRef.current.find((pane) => pane.id === paneId))
      .filter((pane): pane is SshPane => Boolean(pane?.session_id && pane.status === 'connected'))
      .map((pane) => pane.id)

  const pruneSyncTargets = () => {
    const selectableIds = new Set(getSelectableSyncPaneIds())
    const nextSelected = syncedPaneIdsRef.current.filter((paneId) => selectableIds.has(paneId))

    if (
      nextSelected.length !== syncedPaneIdsRef.current.length ||
      nextSelected.some((paneId, index) => paneId !== syncedPaneIdsRef.current[index])
    ) {
      setSyncedPaneIds(nextSelected)
    }

    if (nextSelected.length < 2) {
      setSyncInputEnabled(false)
    }

    return nextSelected
  }

  const toggleSyncInput = () => {
    const nextSelected = pruneSyncTargets()

    if (syncInputEnabledRef.current) {
      setSyncInputEnabled(false)
      return
    }

    let selectablePaneIds = nextSelected
    if (selectablePaneIds.length < 2) {
      selectablePaneIds = getSelectableSyncPaneIds().slice(0, MAX_PANES)
      setSyncedPaneIds(selectablePaneIds)
    }

    if (selectablePaneIds.length < 2) {
      toast.warning(t('syncNeedTwoVisiblePanes'))
      return
    }

    setSyncInputEnabled(true)
  }

  const toggleSyncPane = (paneId: string) => {
    const selectableIds = new Set(getSelectableSyncPaneIds())
    const current = syncedPaneIdsRef.current.filter((id) => selectableIds.has(id))
    let nextSelected = current

    if (current.includes(paneId)) {
      nextSelected = current.filter((id) => id !== paneId)
    } else if (selectableIds.has(paneId) && current.length < MAX_PANES) {
      nextSelected = [...current, paneId]
    }

    setSyncedPaneIds(nextSelected)
    setSyncInputEnabled(nextSelected.length >= 2)
  }

  const openMultiHostAiDialog = () => {
    if (connectedPanes.length === 0) {
      toast.warning(t('noConnectedSessions'))
      return
    }

    const preferredPaneIds = syncedPaneIdsRef.current.filter((paneId) =>
      connectedPanes.some((pane) => pane.id === paneId),
    )
    const nextSelectedPaneIds = preferredPaneIds.length > 0
      ? preferredPaneIds
      : connectedPanes.map((pane) => pane.id)

    setMultiHostSelectedPaneIds(nextSelectedPaneIds)
    setMultiHostRoles((current) => {
      const next = { ...current }
      nextSelectedPaneIds.forEach((paneId) => {
        if (!(paneId in next)) {
          next[paneId] = ''
        }
      })
      return next
    })
    setMultiHostAiOpen(true)
  }

  const toggleMultiHostTarget = (paneId: string) => {
    setMultiHostSelectedPaneIds((current) =>
      current.includes(paneId)
        ? current.filter((value) => value !== paneId)
        : [...current, paneId],
    )
  }

  const setMultiHostRole = (paneId: string, role: string) => {
    setMultiHostRoles((current) => ({ ...current, [paneId]: role }))
  }

  const waitForPaneOutputQuiet = async (
    paneId: string,
    startLength: number,
    idleMs = 1200,
    timeoutMs = 90000,
  ) => {
    let lastOutput = getPaneOutputProbe(paneId)
    let lastLength = lastOutput.length
    let lastChangeAt = Date.now()
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      await sleep(150)
      const currentOutput = getPaneOutputProbe(paneId)
      const currentLength = currentOutput.length

      if (currentLength !== lastLength) {
        lastLength = currentLength
        lastOutput = currentOutput
        lastChangeAt = Date.now()
        continue
      }

      if (currentLength > startLength && Date.now() - lastChangeAt >= idleMs) {
        return currentOutput.slice(startLength)
      }
    }

    return lastOutput.slice(startLength)
  }

  const submitMultiHostAiPrompt = async () => {
    const content = multiHostDraft.trim()
    if (!content || multiHostSending) return

    if (!aiAssistantSettings.api_key.trim() || !aiAssistantSettings.model.trim()) {
      toast.warning(t('aiAssistantMissingConfig'))
      handleSettingsModalOpenChange(true)
      return
    }

    if (selectedMultiHostTargets.length === 0) {
      toast.warning(t('multiHostAiNeedTarget'))
      return
    }

    const nextMessages = [...multiHostMessages, { role: 'user' as const, content }]
    setMultiHostMessages(nextMessages)
    setMultiHostDraft('')
    setMultiHostSending(true)

    try {
      const reply = await requestAiAssistantReply(
        {
          ...aiAssistantSettings,
          system_prompt: buildMultiHostSystemPrompt(
            aiAssistantSettings.system_prompt,
            selectedMultiHostTargets.map((target) => ({
              pane_id: target.paneId,
              title: target.title,
              host: target.host,
              username: target.username,
              host_platform: target.hostPlatform,
              linux_distro: target.linuxDistro,
              role: target.role,
            })),
            aiAssistantSettings.terminal_permission,
          ),
        },
        nextMessages,
      )

      const parsedReply = parseMultiHostPlanReply(reply)
      setMultiHostMessages((current) => [
        ...current,
        { role: 'assistant', content: parsedReply.content || parsedReply.plan?.summary || t('multiHostAiPlanReady') },
      ])
      setMultiHostPlan(parsedReply.plan || null)
      setMultiHostExecution(null)

      if (!parsedReply.plan) {
        toast.message(t('multiHostAiNoPlan'))
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      setMultiHostMessages((current) => [
        ...current,
        { role: 'assistant', content: t('aiAssistantErrorReply') },
      ])
    } finally {
      setMultiHostSending(false)
    }
  }

  const runMultiHostPlan = async () => {
    if (!multiHostPlan) return

    if (aiAssistantSettingsRef.current.terminal_permission === 'reply-only') {
      toast.warning(t('multiHostAiPermissionBlocked'))
      return
    }

    const selectedTargetMap = new Map(selectedMultiHostTargets.map((target) => [target.paneId, target]))
    if (selectedTargetMap.size === 0) {
      toast.warning(t('multiHostAiNeedTarget'))
      return
    }

    const initialStepStatuses = Object.fromEntries(
      multiHostPlan.steps.map((step) => [step.id, { status: 'pending' as MultiHostExecutionStepStatus }]),
    )
    const variables: Record<string, string> = {}

    const setStepStatus = (
      stepId: string,
      status: MultiHostExecutionStepStatus,
      message?: string,
      nextVariables?: Record<string, string>,
    ) => {
      setMultiHostExecution((current) => ({
        status: current?.status === 'error' ? 'error' : 'running',
        activeStepId: status === 'running' ? stepId : current?.activeStepId,
        stepStatuses: {
          ...(current?.stepStatuses || initialStepStatuses),
          [stepId]: { status, message },
        },
        variables: nextVariables || current?.variables || {},
      }))
    }

    setMultiHostExecution({
      status: 'running',
      activeStepId: undefined,
      stepStatuses: initialStepStatuses,
      variables: {},
    })

    try {
      for (const step of multiHostPlan.steps) {
        const resolvedTargetIds =
          step.targets.length === 1 && step.targets[0] === 'all'
            ? [...selectedTargetMap.keys()]
            : step.targets

        if (resolvedTargetIds.length === 0) {
          throw new Error(`Plan step has no runnable targets: ${step.title}`)
        }

        const resolvedTargets = resolvedTargetIds.map((paneId) => {
          const target = selectedTargetMap.get(paneId)
          if (!target) {
            throw new Error(`Plan step references an unavailable target: ${paneId}`)
          }
          return target
        })

        setStepStatus(step.id, 'running', t('multiHostAiStepRunning', { title: step.title }), { ...variables })

        const runStepOnTarget = async (target: MultiHostTarget) => {
          const pane = getPaneById(target.paneId)
          if (!pane?.session_id || pane.status !== 'connected') {
            throw new Error(`${target.title} is not connected`)
          }

          const command = substituteMultiHostPlanVariables(step.command, variables)
          const shouldExecute = step.execute && aiAssistantSettingsRef.current.terminal_permission === 'execute'
          const outputStartLength = getPaneOutputProbe(target.paneId).length

          await sshWrite(pane.session_id, command)
          if (shouldExecute) {
            await sshWrite(pane.session_id, '\r')
          }

          if (!step.capture) {
            return
          }

          if (!shouldExecute) {
            throw new Error(`Step "${step.title}" needs execute permission to capture output`)
          }

          const output = await waitForPaneOutputQuiet(target.paneId, outputStartLength)
          const pattern = new RegExp(step.capture.pattern, 'ms')
          const match = pattern.exec(output)

          if (!match) {
            throw new Error(`Step "${step.title}" did not produce capture "${step.capture.name}"`)
          }

          variables[step.capture.name] = (match[1] || match[0] || '').trim()
        }

        if (step.parallel) {
          await Promise.all(resolvedTargets.map(runStepOnTarget))
        } else {
          for (const target of resolvedTargets) {
            await runStepOnTarget(target)
          }
        }

        setStepStatus(
          step.id,
          'success',
          step.capture
            ? t('multiHostAiStepCaptured', { name: step.capture.name })
            : step.execute && aiAssistantSettingsRef.current.terminal_permission === 'execute'
              ? t('multiHostAiStepExecuted')
              : t('multiHostAiStepTyped'),
          { ...variables },
        )
      }

      setMultiHostExecution((current) => ({
        status: 'success',
        message: t('multiHostAiExecutionSuccess'),
        activeStepId: current?.activeStepId,
        stepStatuses: current?.stepStatuses || initialStepStatuses,
        variables: { ...variables },
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMultiHostExecution((current) => ({
        status: 'error',
        message,
        activeStepId: current?.activeStepId,
        stepStatuses: current?.stepStatuses || initialStepStatuses,
        variables: { ...variables },
      }))
      toast.error(message)
    }
  }

  const trackPendingPaneCredential = (pane: SshPane, output: string) => {
    if (
      connectionUsesPrivateKey(pane.connection) &&
      !pane.connection?.private_key_passphrase &&
      hasPrivateKeyPassphrasePrompt(output)
    ) {
      pendingPaneCredentialsRef.current.set(pane.id, 'private_key_passphrase')
      pendingPaneCredentialBuffersRef.current.set(pane.id, '')
      return
    }

    if (paneLooksAuthenticated(pane)) {
      clearPendingPaneCredential(pane.id)
    }
  }

  const capturePendingPaneCredentialInput = (pane: SshPane, data: string) => {
    const probeOutput = getPaneOutputProbe(pane.id)
    const probePane = { ...pane, terminal_output: probeOutput }
    const shouldCapture =
      pendingPaneCredentialsRef.current.get(pane.id) === 'private_key_passphrase' ||
      (connectionUsesPrivateKey(pane.connection) &&
        !pane.connection?.private_key_passphrase &&
        hasPrivateKeyPassphrasePrompt(probeOutput) &&
        !paneLooksAuthenticated(probePane))

    if (!shouldCapture) return

    let buffer = pendingPaneCredentialBuffersRef.current.get(pane.id) || ''
    for (const char of data) {
      if (char === '\u0003') {
        clearPendingPaneCredential(pane.id)
        return
      }

      if (char === '\u007f' || char === '\b') {
        buffer = buffer.slice(0, -1)
        continue
      }

      if (char === '\r' || char === '\n') {
        if (buffer && pane.connection) {
          updatePaneById(pane.id, (current) => ({
            ...current,
            connection: current.connection
              ? { ...current.connection, private_key_passphrase: buffer }
              : current.connection,
            private_key_passphrase_origin: 'session',
          }))

          window.setTimeout(() => {
            const currentPane = getPaneById(pane.id)
            if (
              currentPane?.session_id &&
              currentPane.status === 'connected' &&
              !currentPane.system_usage &&
              shouldRefreshPaneSystemUsage(currentPane)
            ) {
              void refreshPaneSystemUsage(currentPane)
            }
          }, 500)
        }

        clearPendingPaneCredential(pane.id)
        return
      }

      if (char >= ' ' && char !== '\u007f') {
        buffer += char
      }
    }

    pendingPaneCredentialBuffersRef.current.set(pane.id, buffer)
  }

  const handleTerminalInput = ({ pane_id, data }: { pane_id: string; data: string }) => {
    const sourcePane = panesRef.current.find((pane) => pane.id === pane_id)
    if (!sourcePane?.session_id || (sourcePane.status !== 'connecting' && sourcePane.status !== 'connected')) {
      return
    }

    capturePendingPaneCredentialInput(sourcePane, data)

    const targets = canBroadcastInput && syncedPaneIdsRef.current.includes(pane_id)
      ? syncTargetPanes
      : [sourcePane]

    targets.forEach((pane) => {
      if (pane.session_id && (pane.status === 'connecting' || pane.status === 'connected')) {
        void sshWrite(pane.session_id, data)
      }
    })
  }

  const handlePaneZmodemState = ({ pane_id, active }: { pane_id: string; active: boolean }) => {
    updatePaneById(pane_id, (current) => ({ ...current, zmodem_active: active }))
  }

  const startSidebarResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (sidebarCollapsedRef.current) return

    const startX = event.clientX
    const startWidth = sidebarWidthRef.current
    setResizingSidebar(true)

    const resize = (moveEvent: PointerEvent) => {
      setSidebarWidth(clampSidebarWidthValue(startWidth + moveEvent.clientX - startX))
      scheduleFitAllTerminals()
    }

    const stop = () => {
      setResizingSidebar(false)
      window.removeEventListener('pointermove', resize)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('blur', stop)
      scheduleFitAllTerminals()
    }

    window.addEventListener('pointermove', resize)
    window.addEventListener('pointerup', stop, { once: true })
    window.addEventListener('pointercancel', stop, { once: true })
    window.addEventListener('blur', stop, { once: true })
  }

  const setSidebarCollapsedState = (collapsed: boolean) => {
    if (sidebarCollapsedRef.current === collapsed) return

    setSidebarCollapsed(collapsed)
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed))
    setResizingSidebar(false)
    scheduleFitAllTerminals()
  }

  const setSplitCount = (count: number) => {
    const nextCount = Math.min(MAX_PANES, Math.max(1, count))
    if (nextCount === visiblePaneIdsRef.current.length) return

    if (nextCount < visiblePaneIdsRef.current.length) {
      const nextVisible = visiblePaneIdsRef.current.slice(0, nextCount)
      setVisiblePaneIds(nextVisible)
      if (!nextVisible.includes(activePaneIdRef.current)) {
        setActivePaneId(nextVisible[0])
      }
      return
    }

    const nextVisible = [...visiblePaneIdsRef.current]
    const hiddenPanes = panesRef.current.filter((pane) => !nextVisible.includes(pane.id))
    const nextPanes = [...panesRef.current]
    while (nextVisible.length < nextCount) {
      const hidden = hiddenPanes.shift()
      if (hidden) {
        nextVisible.push(hidden.id)
        continue
      }

      const pane = createPane(nextPanes.length)
      nextPanes.push(pane)
      nextVisible.push(pane.id)
    }

    setPanes(nextPanes)
    setVisiblePaneIds(nextVisible)
    scheduleFitAllTerminals()
  }

  const resetConnectionForm = (connection?: ConnectionProfile) => {
    setConnectionForm({
      id: connection?.id,
      name: connection?.name || '',
      host: connection?.host || '',
      port: connection?.port || 22,
      username: connection?.username || '',
      password: connection?.password || '',
      private_key_path: connection?.private_key_path || '',
      private_key: connection?.private_key || '',
      private_key_passphrase: connection?.private_key_passphrase || '',
      group_id: connection ? resolveConnectionGroupId(connection, groupsRef.current) : getPreferredGroupId(groupsRef.current),
    })
  }

  const openConnectionModal = (connection?: ConnectionProfile, groupId?: string, connectPaneId?: string) => {
    pendingConnectPaneIdRef.current = connectPaneId
    resetConnectionForm(connection)
    if (!connection && groupId) {
      setConnectionForm((current) => ({ ...current, group_id: groupId }))
    }
    setConnectionModalOpen(true)
  }

  const profileFromConnectionForm = (): ConnectionProfile | undefined => {
    if (!connectionForm.name.trim() || !connectionForm.host.trim() || !connectionForm.username.trim()) {
      toast.warning(t('fillConnectionRequired'))
      return undefined
    }

    const port = parsePort(connectionForm.port, true)
    if (!port) {
      toast.warning(t('fillValidPort'))
      return undefined
    }

    const existingConnection = connectionForm.id
      ? connectionsRef.current.find((connection) => connection.id === connectionForm.id)
      : undefined
    const keepDetectedHostInfo =
      existingConnection &&
      existingConnection.host.trim() === connectionForm.host.trim() &&
      Number(existingConnection.port || 22) === port &&
      existingConnection.username.trim() === connectionForm.username.trim()
    const group_id = getPreferredGroupId(groupsRef.current, connectionForm.group_id)
    return {
      id: connectionForm.id || createId('connection'),
      name: connectionForm.name.trim(),
      host: connectionForm.host.trim(),
      port,
      username: connectionForm.username.trim(),
      password: connectionForm.password || undefined,
      private_key_path: connectionForm.private_key_path?.trim() || undefined,
      private_key: connectionForm.private_key?.trim() || undefined,
      private_key_passphrase: connectionForm.private_key_passphrase || undefined,
      group_id,
      host_platform: keepDetectedHostInfo ? existingConnection.host_platform : undefined,
      linux_distro: keepDetectedHostInfo ? existingConnection.linux_distro : undefined,
    }
  }

  const saveConnection = () => {
    const profile = profileFromConnectionForm()
    if (!profile) return
    const pendingConnectPaneId = pendingConnectPaneIdRef.current
    pendingConnectPaneIdRef.current = undefined

    setConnections((current) => {
      const existingIndex = current.findIndex((connection) => connection.id === profile.id)
      if (existingIndex >= 0) {
        const next = [...current]
        next.splice(existingIndex, 1, profile)
        return next
      }
      return [profile, ...current]
    })

    setGroups((current) => current.map((group) => (group.id === profile.group_id ? { ...group, expanded: true } : group)))
    setSelectedConnectionId(profile.id)
    setConnectionModalOpen(false)
    toast.success(t('connectionSaved'))

    if (pendingConnectPaneId) {
      void openConnectionInPane(profile, pendingConnectPaneId)
    }
  }

  const readUrlValue = (url: URL, names: string[]) => {
    for (const name of names) {
      const value = url.searchParams.get(name)?.trim()
      if (value) return value
    }
    return ''
  }

  const readUrlFlag = (url: URL, names: string[], defaultValue: boolean) => {
    const value = readUrlValue(url, names).toLowerCase()
    if (!value) return defaultValue
    return !['0', 'false', 'no', 'off'].includes(value)
  }

  const isTerstermDeepLink = (url: URL) => url.protocol.toLowerCase() === 'tersterm:'

  const groupIdFromDeepLink = (value: string) => {
    const groupName = value.trim()
    if (!groupName) return getPreferredGroupId(groupsRef.current)
    if (DEFAULT_GROUP_ALIASES.has(groupName)) return getPreferredGroupId(groupsRef.current)

    const existing = groupsRef.current.find(
      (group) => group.id === groupName || group.name.toLowerCase() === groupName.toLowerCase(),
    )
    if (existing) {
      setGroups((current) => current.map((group) => (group.id === existing.id ? { ...group, expanded: true } : group)))
      return existing.id
    }

    const group: ConnectionGroup = {
      id: createId('group'),
      name: groupName,
      expanded: true,
    }
    setGroups((current) => [...current, group])
    return group.id
  }

  const profileFromDeepLink = (rawUrl: string): { profile: ConnectionProfile; save: boolean; connect: boolean } | undefined => {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return undefined
    }

    if (!isTerstermDeepLink(url)) return undefined

    const command = url.hostname.toLowerCase()
    const shorthandHost = command && command !== 'connect' ? url.hostname : ''
    const host = readUrlValue(url, ['host', 'hostname', 'ip']) || shorthandHost
    const username = readUrlValue(url, ['username', 'user', 'login']) || decodeURIComponent(url.username)

    if (!host || !username) {
      toast.warning(t('quickSessionLinkNeedsHostAndUsername'))
      return undefined
    }

    const port = parsePort(readUrlValue(url, ['port']) || url.port, true) ?? 22
    const name = readUrlValue(url, ['name', 'title']) || `${username}@${host}`
    const groupValue = readUrlValue(url, ['group', 'group_id', 'folder'])
    const group_id = groupValue ? groupIdFromDeepLink(groupValue) : getPreferredGroupId(groupsRef.current)
    const password = readUrlValue(url, ['password', 'pass']) || decodeURIComponent(url.password)
    const private_key_path = readUrlValue(url, ['private_key_path', 'key_path', 'identity'])
    const private_key = readUrlValue(url, ['private_key', 'key'])
    const private_key_passphrase = readUrlValue(url, ['private_key_passphrase', 'passphrase'])

    return {
      profile: {
        id: createId('connection'),
        name,
        host,
        port,
        username,
        password: password || undefined,
        private_key_path: private_key_path || undefined,
        private_key: private_key || undefined,
        private_key_passphrase: private_key_passphrase || undefined,
        group_id,
      },
      save: readUrlFlag(url, ['save'], true),
      connect: readUrlFlag(url, ['connect', 'open'], true),
    }
  }

  const saveOrUpdateQuickConnection = (profile: ConnectionProfile) => {
    setConnections((current) => {
      const existingIndex = current.findIndex(
        (connection) =>
          connection.host === profile.host &&
          Number(connection.port || 22) === profile.port &&
          connection.username === profile.username,
      )

      if (existingIndex >= 0) {
        const next = [...current]
        profile.id = next[existingIndex].id
        profile.host_platform = profile.host_platform || next[existingIndex].host_platform
        profile.linux_distro = profile.linux_distro || next[existingIndex].linux_distro
        next.splice(existingIndex, 1, profile)
        return next
      }

      return [profile, ...current]
    })

    setGroups((current) => current.map((group) => (group.id === profile.group_id ? { ...group, expanded: true } : group)))
    setSelectedConnectionId(profile.id)
  }

  const findPaneForSidebarConnection = () => {
    const active = panesRef.current.find((pane) => pane.id === activePaneIdRef.current)
    if (active && active.status !== 'connected' && active.status !== 'connecting') {
      return active
    }

    const available = visiblePaneIdsRef.current
      .map((paneId) => panesRef.current.find((pane) => pane.id === paneId))
      .find((pane) => pane && pane.status !== 'connected' && pane.status !== 'connecting')
    if (available) return available

    const pane = createPane(panesRef.current.length)
    setPanes((current) => [...current, pane])
    const nextVisible = [...visiblePaneIdsRef.current]
    const replaceIndex = Math.max(0, nextVisible.indexOf(activePaneIdRef.current))
    nextVisible[replaceIndex] = pane.id
    setVisiblePaneIds(nextVisible)
    return pane
  }

  const openConnectionInPane = async (
    connection: ConnectionProfile,
    paneId = activePaneIdRef.current,
    paneOverride?: SshPane,
  ) => {
    const pane = paneOverride || getPaneById(paneId) || panesRef.current[0]
    if (!pane) return

    showPane(pane.id)
    setActivePaneId(pane.id)
    setSelectedConnectionId(connection.id)

    await stopPaneSession(pane)

    const paneConnection = { ...connection }
    updatePaneById(pane.id, () => ({
      id: pane.id,
      title: connection.name,
      status: 'connecting',
      connection: paneConnection,
      private_key_passphrase_origin: connection.private_key_passphrase?.trim() ? 'configured' : undefined,
      remote_features_ready: false,
      session_id: undefined,
      error: undefined,
      terminal_output: '',
      zmodem_active: false,
      system_usage: undefined,
      system_usage_loading: false,
      system_usage_error: undefined,
    }))
    clearPendingPaneCredential(pane.id)
    clearPaneOutputProbe(pane.id)

    const session_id = createId('session')
    try {
      updatePaneById(pane.id, (current) => ({ ...current, session_id }))
      await sshConnect(paneConnection, session_id)
      const currentPane = getPaneById(pane.id)
      if (currentPane?.session_id === session_id && currentPane.status === 'connecting') {
        updatePaneById(pane.id, (current) => ({
          ...current,
          status: 'connecting',
          remote_features_ready: false,
          error: undefined,
          zmodem_active: false,
        }))
      }
      scheduleFitPane(pane.id)
    } catch (error) {
      const currentPane = getPaneById(pane.id)
      if (currentPane?.session_id !== session_id) return

      updatePaneById(pane.id, (current) => ({
        ...current,
        session_id: undefined,
        status: 'error',
        private_key_passphrase_origin: undefined,
        remote_features_ready: false,
        error: error instanceof Error ? error.message : String(error),
        zmodem_active: false,
      }))
    }
  }

  const openConnectionFromSidebar = async (connection: ConnectionProfile) => {
    const pane = findPaneForSidebarConnection()
    await openConnectionInPane(connection, pane.id, pane)
  }

  const openQuickSessionUrls = async (urls: string[]) => {
    for (const rawUrl of urls) {
      const quickSession = profileFromDeepLink(rawUrl)
      if (!quickSession) continue

      const profile = quickSession.profile
      if (quickSession.save) {
        saveOrUpdateQuickConnection(profile)
        toast.success(t('quickSessionSaved', { name: profile.name }))
      }

      if (quickSession.connect) {
        await openConnectionInPane(profile)
      } else {
        resetConnectionForm(profile)
        setConnectionModalOpen(true)
      }
    }
  }

  const testConnection = async () => {
    const profile = profileFromConnectionForm()
    if (!profile) return

    setTestingConnection(true)
    try {
      await sshTestConnection(profile)
      toast.success(t('testConnectionSuccess'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setTestingConnection(false)
    }
  }

  const openGroupModal = (group?: ConnectionGroup) => {
    setGroupForm({
      id: group?.id || '',
      name: group ? (group.id === DEFAULT_GROUP_ID ? t('defaultGroupName') : group.name) : '',
    })
    setGroupModalOpen(true)
  }

  const saveGroup = () => {
    const name = groupForm.name.trim()
    if (!name) {
      toast.warning(t('fillGroupName'))
      return
    }

    const duplicate = groupsRef.current.some(
      (group) => (group.id === DEFAULT_GROUP_ID ? t('defaultGroupName') : group.name).toLowerCase() === name.toLowerCase() && group.id !== groupForm.id,
    )
    if (duplicate) {
      toast.warning(t('duplicateGroupName'))
      return
    }

    if (groupForm.id) {
      setGroups((current) => current.map((group) => (group.id === groupForm.id ? { ...group, name } : group)))
    } else {
      setGroups((current) => [...current, { id: createId('group'), name, expanded: true }])
    }

    setGroupModalOpen(false)
    toast.success(t('groupSaved'))
  }

  const deleteGroup = (group: ConnectionGroup) => {
    const currentGroups = groupsRef.current
    const remainingGroups = currentGroups.filter((item) => item.id !== group.id)
    if (remainingGroups.length === 0) {
      toast.warning(t('keepOneGroup'))
      return
    }

    const fallbackGroupId = getPreferredGroupId(remainingGroups)
    setConnections((current) =>
      current.map((connection) =>
        resolveConnectionGroupId(connection, currentGroups) === group.id
          ? { ...connection, group_id: fallbackGroupId }
          : connection,
      ),
    )
    setPanes((current) =>
      current.map((pane) =>
        pane.connection && resolveConnectionGroupId(pane.connection, currentGroups) === group.id
          ? { ...pane, connection: { ...pane.connection, group_id: fallbackGroupId } }
          : pane,
      ),
    )
    setGroups(remainingGroups)
    toast.success(t('groupDeleted'))
  }

  const confirmDeleteGroup = (group: ConnectionGroup) => {
    setGroupPendingDelete(group)
  }

  const deleteConnection = async (connection: ConnectionProfile) => {
    setConnections((current) => current.filter((item) => item.id !== connection.id))
    if (selectedConnectionIdRef.current === connection.id) {
      setSelectedConnectionId(undefined)
    }

    for (const pane of panesRef.current) {
      if (pane.connection?.id !== connection.id) continue
      await stopPaneSession(pane)
      updatePaneById(pane.id, (current) => ({
        ...current,
        title: getBasePaneTitle(),
        status: 'idle',
        session_id: undefined,
        connection: undefined,
        private_key_passphrase_origin: undefined,
        remote_features_ready: false,
        error: undefined,
        zmodem_active: false,
        system_usage: undefined,
        system_usage_loading: false,
        system_usage_error: undefined,
      }))
    }
  }

  const disconnectPane = async (pane: SshPane) => {
    await stopPaneSession(pane)
    updatePaneById(pane.id, (current) => ({
      ...current,
      title: current.connection?.name || current.title,
      status: 'closed',
      session_id: undefined,
      private_key_passphrase_origin: undefined,
      remote_features_ready: false,
      error: undefined,
      zmodem_active: false,
      system_usage: undefined,
      system_usage_loading: false,
      system_usage_error: undefined,
    }))
  }

  const disconnectPaneById = async (paneId: string) => {
    const pane = getPaneById(paneId)
    if (pane) {
      await disconnectPane(pane)
    }
  }

  const closePane = async (paneId: string) => {
    const pane = getPaneById(paneId)
    if (!pane) return
    const visibleCount = visiblePaneIdsRef.current.length

    await disconnectPane(pane)

    const nextPanes = panesRef.current.filter((item) => item.id !== paneId)
    if (nextPanes.length === 0) {
      nextPanes.push(createPane(0))
    }

    delete terminalRefs.current[paneId]
    const nextVisible = visiblePaneIdsRef.current.filter((id) => id !== paneId)
    for (const candidate of nextPanes) {
      if (nextVisible.length >= Math.min(visibleCount, nextPanes.length, MAX_PANES)) break
      if (!nextVisible.includes(candidate.id)) {
        nextVisible.push(candidate.id)
      }
    }

    setPanes(nextPanes)
    setVisiblePaneIds(nextVisible.length ? nextVisible : [nextPanes[0].id])
    if (!nextVisible.includes(activePaneIdRef.current)) {
      setActivePaneId((nextVisible.length ? nextVisible : [nextPanes[0].id])[0])
    }
  }

  const connectPaneToConnection = async (connection: ConnectionProfile) => {
    const paneId = connectPanePickerPaneId
    setConnectPanePickerPaneId(null)
    if (!paneId) return

    await openConnectionInPane(connection, paneId)
  }

  const connectFromPane = async (paneId: string) => {
    if (connectionsRef.current.length === 0) {
      openConnectionModal(undefined, undefined, paneId)
      return
    }

    setConnectPanePickerPaneId(paneId)
  }

  const handleDisconnected = ({ pane_id, session_id, reason }: { pane_id: string; session_id: string; reason?: string }) => {
    const pane = getPaneById(pane_id)
    if (!pane || pane.session_id !== session_id) return

    updatePaneById(pane_id, (current) => ({
      ...current,
      status: reason ? 'error' : 'closed',
      session_id: undefined,
      private_key_passphrase_origin: undefined,
      remote_features_ready: false,
      error: reason,
      zmodem_active: false,
      system_usage: undefined,
      system_usage_loading: false,
      system_usage_error: undefined,
    }))
    clearPendingPaneCredential(pane_id)
    clearPaneOutputProbe(pane_id)
  }

  const appendTerminalOutput = (session_id: string, data: string) => {
    const pane = getPaneBySessionId(session_id)
    if (!pane || pane.zmodem_active) return

    const visibleData = pane.private_key_passphrase_origin === 'configured' ? stripConfiguredPassphrasePrompt(data) : data
    const nextPane = { ...pane, terminal_output: appendPaneOutputProbe(pane.id, visibleData) }
    trackPendingPaneCredential(nextPane, visibleData)

    if (!nextPane.remote_features_ready && paneLooksAuthenticated(nextPane)) {
      markPaneRemoteFeaturesReady(pane.id)
    }

    const currentPane = getPaneById(pane.id)
    if (currentPane && shouldRefreshPaneSystemUsage(currentPane) && !currentPane.system_usage) {
      updatePaneById(pane.id, (current) => ({ ...current, system_usage_error: undefined }))
      void refreshPaneSystemUsage(currentPane)
    }
  }

  const handlePaneAuthenticated = ({ pane_id, session_id }: { pane_id: string; session_id: string }) => {
    const pane = getPaneById(pane_id)
    if (!pane || pane.session_id !== session_id) return
    markPaneRemoteFeaturesReady(pane_id)
  }

  const checkForAppUpdate = async (silent = false) => {
    const result = await updateInfoQuery.refetch()
    if (result.error) {
      if (!silent) {
        toast.error(result.error instanceof Error ? result.error.message : String(result.error))
      }
      return
    }

    const info = result.data
    if (!info || silent) return

    if (info.update_available) {
      if (info.download_asset) {
        toast.success(t('updateFound', { version: info.latest_version }))
      } else {
        toast.warning(t('updateFoundNoPackage', { version: info.latest_version }))
      }
      return
    }

    toast.success(t('updateAlreadyLatest'))
  }

  const downloadLatestRelease = async () => {
    const asset = appUpdateInfo?.download_asset
    if (!asset) {
      toast.warning(t('updatePackageMissing'))
      return
    }

    setAppUpdateProgress({
      status: 'downloading',
      filename: asset.name,
      downloaded_bytes: 0,
      total_bytes: asset.size_bytes,
      percent: 0,
    })
    setDownloadingAppUpdate(true)
    try {
      const localPath = await fetchAppUpdatePackage(asset.download_url, asset.name)
      setAppUpdateProgress({
        status: 'installing',
        filename: asset.name,
        downloaded_bytes: asset.size_bytes,
        total_bytes: asset.size_bytes,
        percent: 100,
      })
      setDownloadingAppUpdate(false)
      toast.success(t('updateInstallerStarted', { path: localPath }))
    } catch (error) {
      setAppUpdateProgress(undefined)
      setDownloadingAppUpdate(false)
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    let disposed = false

    refreshAllSystemUsage()
    systemUsageTimerRef.current = window.setInterval(refreshAllSystemUsage, 15_000)

    void onSshData(({ session_id, data }) => {
      appendTerminalOutput(session_id, data)
    }).then((unlisten) => {
      if (disposed) {
        unlisten()
        return
      }
      unlistenSshDataRef.current = unlisten
    })

    void onAppUpdateDownloadProgress((progress) => {
      setAppUpdateProgress(progress)
      if (progress.status === 'installing') {
        setDownloadingAppUpdate(false)
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten()
        return
      }
      unlistenAppUpdateProgressRef.current = unlisten
    })

    void (async () => {
      try {
        const unlisten = await onOpenUrl((urls) => {
          void openQuickSessionUrls(urls)
        })
        if (disposed) {
          unlisten()
          return
        }

        unlistenDeepLinkRef.current = unlisten

        const currentUrls = await getCurrent()
        if (!disposed && currentUrls?.length) {
          void openQuickSessionUrls(currentUrls)
        }
      } catch {
        // Deep links are only available in the Tauri runtime.
      }
    })()

    return () => {
      disposed = true
      if (systemUsageTimerRef.current) {
        window.clearInterval(systemUsageTimerRef.current)
      }
      systemUsageRequestIdsRef.current.clear()
      systemUsagePendingPaneIdsRef.current.clear()
      paneOutputProbeBuffersRef.current.clear()
      unlistenSshDataRef.current?.()
      unlistenDeepLinkRef.current?.()
      unlistenAppUpdateProgressRef.current?.()
      void Promise.all(panesRef.current.map((pane) => (pane.session_id ? sshDisconnect(pane.session_id) : null)))
    }
  }, [])

  const appShellStyle = {
    gridTemplateColumns: sidebarCollapsed ? 'minmax(0, 1fr)' : `${sidebarWidth}px 8px minmax(0, 1fr)`,
  }

  const handleWindowMinimize = () => {
    void getCurrentWindow().minimize().catch(() => {})
  }

  const handleWindowToggleMaximize = () => {
    void getCurrentWindow().toggleMaximize().catch(() => {})
  }

  const handleWindowClose = () => {
    void getCurrentWindow().close().catch(() => {})
  }

  const handleWindowDragStart = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    void getCurrentWindow().startDragging().catch(() => {})
  }

  return (
    <div className="app-frame flex h-full min-h-0 flex-col gap-1 overflow-hidden bg-transparent px-2.5 pb-2.5 pt-0">
      <header className="app-titlebar flex h-9 items-center gap-3 bg-transparent px-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-transparent text-[var(--text-primary)] transition hover:text-[var(--accent)]"
              aria-label={sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')}
              onClick={() => setSidebarCollapsedState(!sidebarCollapsedRef.current)}
            >
              <SidebarToggleIcon collapsed={sidebarCollapsed} />
            </button>
          </TooltipTrigger>
          <TooltipContent>{sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-transparent text-[var(--text-primary)] transition hover:text-[var(--accent)]"
              aria-label={t('interfaceSettings')}
              onClick={() => handleSettingsModalOpenChange(true)}
            >
              <Settings className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('interfaceSettings')}</TooltipContent>
        </Tooltip>

        <div
          className="min-w-0 flex-1 self-stretch cursor-grab active:cursor-grabbing"
          onMouseDown={handleWindowDragStart}
          onDoubleClick={desktopWindowReady ? handleWindowToggleMaximize : undefined}
        />
        <div className={cn('flex items-center gap-1 transition-opacity', !desktopWindowReady && 'pointer-events-none opacity-0')}>
            <button
              type="button"
              aria-label="Minimize window"
              className="grid h-8 w-8 place-items-center bg-transparent text-[var(--text-muted)] transition hover:text-[var(--text-primary)]"
              disabled={!desktopWindowReady}
              onClick={handleWindowMinimize}
            >
              <Minus className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label={desktopWindowMaximized ? 'Restore window' : 'Maximize window'}
              className="grid h-8 w-8 place-items-center bg-transparent text-[var(--text-muted)] transition hover:text-[var(--text-primary)]"
              disabled={!desktopWindowReady}
              onClick={handleWindowToggleMaximize}
            >
              {desktopWindowMaximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              aria-label="Close window"
              className="grid h-8 w-8 place-items-center bg-transparent text-[var(--text-muted)] transition hover:text-[#d45b5b]"
              disabled={!desktopWindowReady}
              onClick={handleWindowClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
      </header>

      <main className={cn('grid min-h-0 flex-1 gap-0 overflow-hidden bg-transparent', resizingSidebar && 'select-none')} style={appShellStyle}>
      {!sidebarCollapsed && (
        <aside className="connection-sidebar flex min-h-0 min-w-0 flex-col gap-2.5 rounded-[12px] border border-[var(--border-subtle)] bg-[linear-gradient(180deg,var(--surface-panel-strong),var(--surface-panel))] p-3.5 shadow-[0_14px_32px_rgba(20,38,52,0.07)]">
          <div className="grid grid-cols-[minmax(0,1fr)_40px] gap-2 max-[640px]:grid-cols-1">
            <Button onClick={() => openConnectionModal()}>
              <Plus className="h-4 w-4" />
              {t('newConnection')}
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="secondary" size="icon" onClick={() => openGroupModal()}>
                  <FolderPlus className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('newGroup')}</TooltipContent>
            </Tooltip>
          </div>

          <div className="min-h-0 flex-1 overflow-auto pr-1">
            {filteredConnections.length === 0 && hasSearchQuery ? (
              <div className="flex min-h-[136px] flex-col items-center justify-center rounded-[10px] border border-dashed border-[var(--border-subtle)] bg-[var(--surface-chip)] px-4 py-8 text-center">
                <div className="mb-2 text-sm font-semibold text-[var(--text-primary)]">{t('noMatchingConnections')}</div>
                <p className="max-w-[180px] text-xs leading-5 text-[var(--text-muted)]">{t('searchConnectionsOrGroups')}</p>
              </div>
            ) : (
              <div className="flex min-h-0 flex-col gap-1.5">
                {groupedConnections.map((group) => (
                  <section key={group.id} className="rounded-lg px-1 py-1">
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <div className="flex min-h-6 items-center justify-between gap-2">
                          <button className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)] transition hover:bg-[var(--surface-chip)] hover:text-[var(--text-primary)]" onClick={() => {
                            setGroups((current) => current.map((item) => item.id === group.id ? { ...item, expanded: !item.expanded } : item))
                          }}>
                            <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition', group.expanded && 'rotate-90')} />
                            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">{group.id === DEFAULT_GROUP_ID ? t('defaultGroupName') : group.name}</span>
                            <small className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded bg-[var(--surface-tab-strip)] px-1 text-[10px] font-bold normal-case tracking-normal text-[var(--text-muted)]">{group.items.length}</small>
                          </button>
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem onSelect={() => openConnectionModal(undefined, group.id)}>{t('addConnection')}</ContextMenuItem>
                        <ContextMenuItem onSelect={() => openGroupModal(group)}>{t('renameGroup')}</ContextMenuItem>
                        <ContextMenuItem className="text-[#d45b5b] focus:text-[#d45b5b]" onSelect={() => confirmDeleteGroup(group)}>
                          {t('deleteGroup')}
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>

                    {group.expanded && (
                      <div className="relative mt-1.5 ml-2.5 flex flex-col gap-0.5 pl-3">
                        <span className="pointer-events-none absolute bottom-1 left-[3px] top-0 w-px bg-[var(--tree-line)]" />
                        {group.items.map((connection, index) => (
                          <ContextMenu key={connection.id}>
                            <ContextMenuTrigger asChild>
                              <div className="relative">
                                <span className="pointer-events-none absolute -left-3 top-1/2 h-px w-3 -translate-y-1/2 bg-[var(--tree-line)]" />
                                <span className="pointer-events-none absolute -left-[15px] top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-[var(--tree-line-strong)]" />
                                {index < group.items.length - 1 && (
                                  <span className="pointer-events-none absolute -left-[15px] top-1/2 h-[calc(100%+4px)] w-px bg-[var(--tree-line)]" />
                                )}
                                <button
                                  className={cn(
                                    'flex min-h-[38px] w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-[var(--surface-tab-active)]',
                                    selectedConnectionId === connection.id && 'bg-[var(--surface-tab-active)] shadow-[inset_0_0_0_1px_var(--border-strong)]',
                                  )}
                                  onClick={() => void openConnectionFromSidebar(connection)}
                                >
                                  <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-md', selectedConnectionId === connection.id && 'bg-[var(--surface-chip)]')}>
                                    <HostSystemIcon
                                      connection={connection}
                                      className={cn(
                                        'text-[var(--text-muted)]',
                                        selectedConnectionId === connection.id &&
                                          !connection.host_platform &&
                                          !connection.linux_distro &&
                                          'text-[var(--accent)]',
                                      )}
                                    />
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <strong className="block truncate text-[12px] font-medium text-[var(--text-strong)]">{connection.name}</strong>
                                    <small className="block truncate text-[10px] text-[var(--text-muted)]">{connection.username}@{connection.host}:{connection.port}</small>
                                  </span>
                                </button>
                              </div>
                            </ContextMenuTrigger>
                            <ContextMenuContent>
                              <ContextMenuItem onSelect={() => openConnectionModal(connection)}>{t('edit')}</ContextMenuItem>
                              <ContextMenuItem className="text-[#d45b5b] focus:text-[#d45b5b]" onSelect={() => void deleteConnection(connection)}>
                                {t('delete')}
                              </ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>
                        ))}

                      </div>
                    )}
                  </section>
                ))}
              </div>
            )}
          </div>

        </aside>
      )}

      {!sidebarCollapsed && (
        <div className="relative w-2 cursor-col-resize" role="separator" aria-label={t('resizeSidebar')} onPointerDown={startSidebarResize}>
          <span className="absolute left-1/2 top-3 bottom-3 w-px -translate-x-1/2 rounded-full bg-[var(--border-subtle)] transition-colors" />
        </div>
      )}

      <section className="workspace-shell flex min-h-0 min-w-0 flex-col gap-2.5 overflow-hidden rounded-[12px] border border-[rgba(255,255,255,0.18)] bg-[var(--surface-shell)] p-0.5">
        <header className="workspace-toolbar flex min-h-[42px] flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-panel-strong)] px-3.5 py-1 shadow-[0_12px_28px_rgba(20,38,52,0.07)]">
          <div className="min-w-0 flex-1 max-md:w-full">
            <div aria-label={t('sessionList')} className="relative flex min-w-0 items-end gap-1 overflow-x-auto pr-0.5 pb-0 pt-0.5">
              {panes.map((pane) => (
                <button
                  key={pane.id}
                  className={cn(
                    'relative z-[1] inline-flex h-8 max-w-[172px] items-center gap-2 bg-transparent px-2.5 pb-2 pt-1 text-left text-[12px] text-[var(--text-muted)] transition hover:text-[var(--text-primary)]',
                    pane.id === activePaneId &&
                      'text-[var(--text-primary)]',
                    pane.status === 'connecting' && 'text-amber-900',
                    pane.status === 'error' && 'text-rose-900',
                    pane.status === 'closed' && 'opacity-85',
                  )}
                  onClick={() => switchToPane(pane.id)}
                >
                  <span className={cn(
                    'pointer-events-none absolute left-2 right-2 top-0.5 h-[2px] rounded-full opacity-70',
                    pane.status === 'connected' && 'bg-[var(--accent)]',
                    pane.status === 'connecting' && 'bg-amber-400 animate-pulse',
                    pane.status === 'error' && 'bg-rose-400',
                    pane.status === 'closed' && 'bg-slate-400/80',
                    pane.status === 'idle' && 'bg-slate-300/90',
                    pane.id !== activePaneId && 'opacity-55',
                  )} />
                  <span className={cn('h-2.5 w-2.5 rounded-full bg-slate-300', {
                    'bg-[var(--accent)]': pane.status === 'connected',
                    'bg-amber-400': pane.status === 'connecting',
                    'bg-rose-400': pane.status === 'error',
                    'bg-slate-400': pane.status === 'closed',
                  })} />
                  <span className="min-w-0 flex-1 truncate font-medium">{pane.title}</span>
                  <span role="button" title={t('closeSession')} className="grid h-4 w-4 place-items-center rounded-sm text-[var(--text-muted)] opacity-70 transition hover:bg-[#d45b5b] hover:text-white hover:opacity-100" onClick={(event) => {
                    event.stopPropagation()
                    void closePane(pane.id)
                  }}>
                    <X className="h-3.5 w-3.5" />
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 max-md:w-full max-md:justify-end">
            <ContextMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <ContextMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="bg-transparent text-[var(--text-primary)] hover:bg-transparent hover:text-[var(--accent)]"
                      aria-label={t('workspaceLayoutContextHint')}
                    >
                      <LayoutGrid className="h-4 w-4" />
                    </Button>
                  </ContextMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>{t('workspaceLayoutContextHint')}</TooltipContent>
              </Tooltip>
              <ContextMenuContent>
                {splitLayouts.map((layout) => (
                  <ContextMenuItem
                    key={layout.count}
                    className={cn('justify-between gap-3', visiblePaneIds.length === layout.count && 'bg-[var(--surface-chip)] text-[var(--accent)]')}
                    onSelect={() => setSplitCount(layout.count)}
                  >
                    <span>{t(layout.titleKey)}</span>
                    <Check className={cn('h-4 w-4 shrink-0', visiblePaneIds.length === layout.count ? 'opacity-100' : 'opacity-0')} />
                  </ContextMenuItem>
                ))}
              </ContextMenuContent>
            </ContextMenu>

            <Popover>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        'bg-transparent hover:bg-transparent',
                        syncInputEnabled ? 'text-[var(--accent)]' : 'text-[var(--text-primary)] hover:text-[var(--accent)]',
                      )}
                      aria-label={t('syncInput')}
                      title={t('syncInput')}
                    >
                      <RefreshCcw className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>{t('syncInput')}</TooltipContent>
              </Tooltip>
              <PopoverContent align="end" className="w-[min(320px,calc(100vw-48px))] p-4">
                <div className="flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <strong className="block text-sm">{t('syncInput')}</strong>
                      <span className="text-xs text-[var(--text-muted)]">{syncStatusSummary}</span>
                    </div>
                    <Button variant={syncInputEnabled ? 'default' : 'secondary'} size="sm" disabled={visibleConnectedPanes.length < 2} onClick={toggleSyncInput}>
                      <RefreshCcw className="h-3.5 w-3.5" />
                      {syncInputEnabled ? t('syncDisable') : t('syncEnable')}
                    </Button>
                  </div>
                  <p className="text-xs text-[var(--text-muted)]">{t('syncHint')}</p>
                  {visibleConnectedPanes.length > 0 ? (
                    <div className="max-h-60 space-y-2 overflow-auto" aria-label={t('syncInput')}>
                      {visibleConnectedPanes.map((pane) => (
                        <button key={pane.id} className={cn('flex w-full items-center gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2 text-left text-sm transition hover:border-[var(--border-strong)]', syncedPaneIds.includes(pane.id) && 'border-[var(--border-strong)] bg-[var(--accent-soft)]/40')} onClick={() => toggleSyncPane(pane.id)}>
                          <span className={cn('grid h-5 w-5 place-items-center rounded-full border border-[var(--border-subtle)] text-[10px]', syncedPaneIds.includes(pane.id) && 'border-[var(--accent)] bg-[var(--accent)] text-white')}>{syncedPaneIds.includes(pane.id) ? 'on' : ''}</span>
                          <span className="min-w-0">
                            <strong className="block truncate text-sm text-[var(--text-strong)]">{pane.title}</strong>
                            <small className="block truncate text-xs text-[var(--text-muted)]">{pane.connection?.host}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--text-muted)]">{t('noConnectedSessions')}</p>
                  )}
                </div>
              </PopoverContent>
            </Popover>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="bg-transparent text-[var(--text-primary)] hover:bg-transparent hover:text-[var(--accent)]"
                  aria-label={t('multiHostAi')}
                  title={t('multiHostAi')}
                  disabled={connectedPanes.length === 0}
                  onClick={openMultiHostAiDialog}
                >
                  <Bot className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('multiHostAi')}</TooltipContent>
            </Tooltip>
          </div>
        </header>

        <div className={cn(
          'pane-grid grid min-h-0 flex-1 gap-2.5 overflow-hidden rounded-[10px]',
          visiblePanes.length === 1 && 'grid-cols-1',
          visiblePanes.length === 2 && 'grid-cols-1 xl:grid-cols-2',
          visiblePanes.length === 3 && 'grid-cols-1 xl:grid-cols-[1.25fr_.75fr] xl:grid-rows-2',
          visiblePanes.length === 4 && 'grid-cols-1 md:grid-cols-2 md:grid-rows-2',
        )}>
          {visiblePanes.map((pane, index) => (
            <div key={pane.id} className={cn('min-h-0 min-w-0', visiblePanes.length === 3 && index === 0 && 'xl:row-span-2')}>
              <TerminalPane
                ref={(instance) => setTerminalRef(pane.id, instance)}
                pane={pane}
                active={pane.id === activePaneId}
                appTheme={appTheme}
                aiAssistantSettings={aiAssistantSettings}
                onFocus={setActivePaneId}
                onDisconnect={(paneId) => void disconnectPaneById(paneId)}
                onClose={(paneId) => void closePane(paneId)}
                onConnect={(paneId) => void connectFromPane(paneId)}
                onOpenSettings={() => handleSettingsModalOpenChange(true)}
                onInput={handleTerminalInput}
                onZmodem={handlePaneZmodemState}
                onAuthenticated={handlePaneAuthenticated}
                onDisconnected={handleDisconnected}
              />
            </div>
          ))}
        </div>
      </section>

      <Dialog open={multiHostAiOpen} onOpenChange={setMultiHostAiOpen}>
        <DialogContent className="w-[min(94vw,960px)] max-h-[min(88vh,820px)] overflow-auto">
          <DialogHeader>
            <DialogTitle>{t('multiHostAi')}</DialogTitle>
            <DialogDescription>{t('multiHostAiHint')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <section className="rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <strong className="block text-sm text-[var(--text-strong)]">{t('multiHostAiTargets')}</strong>
                  <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">{t('multiHostAiTargetsHint')}</p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setMultiHostSelectedPaneIds(multiHostTargets.map((target) => target.paneId))}
                  disabled={multiHostTargets.length === 0}
                >
                  {t('multiHostAiSelectAll')}
                </Button>
              </div>

              {multiHostTargets.length > 0 ? (
                <div className="mt-3 grid gap-2">
                  {multiHostTargets.map((target) => {
                    const selected = multiHostSelectedPaneIds.includes(target.paneId)
                    return (
                      <div
                        key={target.paneId}
                        className={cn(
                          'grid gap-3 rounded-xl border px-3 py-3 transition sm:grid-cols-[minmax(0,1fr)_180px]',
                          selected
                            ? 'border-[var(--border-strong)] bg-[var(--accent-soft)]/30'
                            : 'border-[var(--border-subtle)] bg-[var(--surface-shell)]',
                        )}
                      >
                        <button
                          type="button"
                          className="flex min-w-0 items-center gap-3 text-left"
                          onClick={() => toggleMultiHostTarget(target.paneId)}
                        >
                          <span className={cn(
                            'grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px]',
                            selected
                              ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                              : 'border-[var(--border-subtle)] text-transparent',
                          )}>
                            on
                          </span>
                          <span className="min-w-0">
                            <strong className="block truncate text-sm text-[var(--text-strong)]">{target.title}</strong>
                            <small className="block truncate text-xs text-[var(--text-muted)]">
                              {(target.username && target.host) ? `${target.username}@${target.host}` : target.host || target.title}
                            </small>
                          </span>
                        </button>

                        <label className="grid gap-1 text-xs text-[var(--text-muted)]">
                          <span>{t('multiHostAiRole')}</span>
                          <Input
                            value={multiHostRoles[target.paneId] || ''}
                            placeholder={t('multiHostAiRolePlaceholder')}
                            onChange={(event) => setMultiHostRole(target.paneId, event.target.value)}
                          />
                        </label>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="mt-3 text-sm text-[var(--text-muted)]">{t('noConnectedSessions')}</p>
              )}
            </section>

            <section className="rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <strong className="block text-sm text-[var(--text-strong)]">{t('multiHostAiRunbook')}</strong>
                  <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">{t('multiHostAiPromptHint')}</p>
                </div>
                {multiHostPlan && (
                  <Button
                    size="sm"
                    onClick={() => void runMultiHostPlan()}
                    disabled={multiHostSending || multiHostExecution?.status === 'running'}
                  >
                    <Play className="h-3.5 w-3.5" />
                    {t('multiHostAiRunPlan')}
                  </Button>
                )}
              </div>

              <div className="mt-4 space-y-3">
                {multiHostMessages.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[var(--border-subtle)] bg-[var(--surface-shell)] px-3.5 py-3 text-sm text-[var(--text-muted)]">
                    {t('multiHostAiEmptyHint')}
                  </div>
                ) : (
                  multiHostMessages.map((message, index) => (
                    <div key={`${message.role}-${index}-${message.content.slice(0, 20)}`} className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
                      <div
                        className={cn(
                          'max-w-[92%] whitespace-pre-wrap rounded-2xl border px-3.5 py-3 text-sm leading-6',
                          message.role === 'user'
                            ? 'rounded-br-md border-[var(--accent)] bg-[var(--accent)] text-white'
                            : 'rounded-tl-md border-[var(--border-subtle)] bg-[var(--surface-shell)] text-[var(--text-primary)]',
                        )}
                      >
                        {message.content}
                      </div>
                    </div>
                  ))
                )}

                {multiHostSending && (
                  <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-shell)] px-3.5 py-3 text-sm text-[var(--text-muted)]">
                    {t('aiAssistantThinking')}
                  </div>
                )}
              </div>

              <div className="mt-4 rounded-[16px] border border-[var(--border-strong)] bg-[var(--surface-shell)] p-2">
                <div className="relative">
                  <Textarea
                    value={multiHostDraft}
                    rows={4}
                    disabled={multiHostSending}
                    placeholder={t('multiHostAiPromptPlaceholder')}
                    className="min-h-[108px] resize-none border-0 bg-transparent pr-12 text-sm shadow-none focus-visible:ring-0"
                    onChange={(event) => setMultiHostDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        void submitMultiHostAiPrompt()
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="absolute bottom-2 right-2 grid h-9 w-9 place-items-center rounded-xl bg-[var(--accent)] text-white shadow-[0_8px_18px_var(--accent-soft)] transition hover:brightness-[1.03] disabled:cursor-not-allowed disabled:opacity-55"
                    disabled={multiHostSending || !multiHostDraft.trim()}
                    onClick={() => void submitMultiHostAiPrompt()}
                  >
                    <Bot className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </section>

            {multiHostPlan && (
              <section className="rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <strong className="block text-sm text-[var(--text-strong)]">{t('multiHostAiPlan')}</strong>
                    <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                      {multiHostPlan.summary || t('multiHostAiPlanReady')}
                    </p>
                  </div>
                  {multiHostExecution?.message && (
                    <span className={cn(
                      'rounded-full px-2.5 py-1 text-xs',
                      multiHostExecution.status === 'error'
                        ? 'bg-[#ffe3e3] text-[#b42318]'
                        : multiHostExecution.status === 'success'
                          ? 'bg-[#dcfce7] text-[#166534]'
                          : 'bg-[var(--accent-soft)] text-[var(--text-primary)]',
                    )}>
                      {multiHostExecution.message}
                    </span>
                  )}
                </div>

                <div className="mt-4 space-y-2">
                  {multiHostPlan.steps.map((step, index) => {
                    const stepState = multiHostExecution?.stepStatuses[step.id]
                    return (
                      <div key={step.id} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-shell)] px-3.5 py-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <strong className="block text-sm text-[var(--text-strong)]">
                              {index + 1}. {step.title}
                            </strong>
                            <small className="mt-1 block text-xs text-[var(--text-muted)]">
                              {t('multiHostAiStepTargets', { targets: step.targets.join(', ') })}
                            </small>
                          </div>
                          <span className={cn(
                            'rounded-full px-2 py-0.5 text-[11px]',
                            stepState?.status === 'error'
                              ? 'bg-[#ffe3e3] text-[#b42318]'
                              : stepState?.status === 'success'
                                ? 'bg-[#dcfce7] text-[#166534]'
                                : stepState?.status === 'running'
                                  ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
                                  : 'bg-[var(--surface-chip)] text-[var(--text-muted)]',
                          )}>
                            {stepState?.status || 'pending'}
                          </span>
                        </div>

                        <div className="mt-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2 font-mono text-xs leading-5 text-[var(--text-primary)] whitespace-pre-wrap break-all">
                          {step.command}
                        </div>

                        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-[var(--text-muted)]">
                          <span>{step.execute ? t('multiHostAiExecuteMode') : t('multiHostAiTypeMode')}</span>
                          <span>{step.parallel ? t('multiHostAiParallel') : t('multiHostAiSequential')}</span>
                          {step.capture && <span>{t('multiHostAiCapture', { name: step.capture.name })}</span>}
                        </div>

                        {stepState?.message && (
                          <p className="mt-2 text-xs text-[var(--text-muted)]">{stepState.message}</p>
                        )}
                      </div>
                    )
                  })}
                </div>

                {multiHostExecution && Object.keys(multiHostExecution.variables).length > 0 && (
                  <div className="mt-4">
                    <strong className="block text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                      {t('multiHostAiVariables')}
                    </strong>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {Object.entries(multiHostExecution.variables).map(([name, value]) => (
                        <div key={name} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-shell)] px-2.5 py-2">
                          <strong className="block text-[11px] text-[var(--text-strong)]">{name}</strong>
                          <span className="mt-1 block max-w-[680px] truncate font-mono text-[11px] text-[var(--text-muted)]" title={value}>
                            {value}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )}
          </div>

          <DialogFooter>
            <Button variant="secondary" onClick={() => setMultiHostAiOpen(false)}>{t('cancel')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={settingsModalOpen} onOpenChange={handleSettingsModalOpenChange}>
        <DialogContent className="w-[min(92vw,620px)] max-h-[min(84vh,560px)] overflow-auto p-4">
          <DialogHeader className="gap-1">
            <DialogTitle>{t('settingsTitle')}</DialogTitle>
            <DialogDescription className="text-xs">{t('applyImmediatelyAndPersist')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-2.5">
            <section className="overflow-hidden rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-panel)]">
              <div className="border-b border-[var(--border-subtle)] px-3 py-2">
                <strong className="text-sm text-[var(--text-strong)]">{t('appearanceSettings')}</strong>
              </div>

              <div className="grid gap-0">
                <div className="grid gap-2 px-3 py-2.5 sm:grid-cols-[76px_minmax(0,1fr)] sm:items-center">
                  <strong className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">{t('themeSettings')}</strong>
                  <div className="flex flex-wrap items-center gap-1">
                    {themeModeOptions.map((option) => {
                      const Icon = option.icon
                      const active = themeMode === option.value
                      return (
                        <button
                          key={option.value}
                          type="button"
                          className={cn(
                            'inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs transition',
                            active
                              ? 'border-[var(--border-strong)] bg-[var(--surface-panel-strong)] text-[var(--text-strong)] shadow-[0_3px_8px_rgba(20,38,52,0.08)]'
                              : 'border-transparent bg-[var(--surface-chip)] text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                          )}
                          onClick={() => handleThemeModeChange(option.value)}
                        >
                          <Icon className="h-4 w-4" />
                          <span>{option.label}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="grid gap-2 border-t border-[var(--border-subtle)] px-3 py-2.5 sm:grid-cols-[76px_minmax(0,1fr)] sm:items-center">
                  <strong className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">{t('languageSettings')}</strong>
                  <div className="flex flex-wrap items-center gap-1">
                    {languageOptions.map((option) => {
                      const active = appLocale === option.value
                      return (
                        <button
                          key={option.value}
                          type="button"
                          className={cn(
                            'inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs transition',
                            active
                              ? 'border-[var(--border-strong)] bg-[var(--surface-panel-strong)] text-[var(--text-strong)] shadow-[0_3px_8px_rgba(20,38,52,0.08)]'
                              : 'border-transparent bg-[var(--surface-chip)] text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                          )}
                          onClick={() => void setAppLocale(option.value)}
                        >
                          <Globe className="h-4 w-4" />
                          <span>{option.label}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="grid gap-1.5 border-t border-[var(--border-subtle)] px-3 py-2.5 sm:grid-cols-[76px_minmax(0,1fr)] sm:items-start">
                  <strong className="pt-0.5 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">{t('themeAccentSettings')}</strong>
                  <div className="grid gap-1.5">
                    <p className="text-xs leading-4 text-[var(--text-muted)]">{t('themeAccentHint')}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      {appThemes.map((theme) => (
                        <button
                          key={theme.id}
                          type="button"
                          title={t(theme.titleKey)}
                          aria-label={t(theme.titleKey)}
                          aria-pressed={appTheme === theme.id}
                          className={cn(
                            'grid h-7 w-7 place-items-center rounded-full transition hover:scale-[1.02]',
                            appTheme === theme.id
                              ? 'ring-2 ring-[var(--text-strong)] ring-offset-1 ring-offset-[var(--surface-panel)]'
                              : 'hover:ring-2 hover:ring-[var(--border-subtle)] hover:ring-offset-1 hover:ring-offset-[var(--surface-panel)]',
                          )}
                          onClick={() => handleAppThemeChange(theme.id)}
                        >
                          <span
                            aria-hidden="true"
                            className="h-6 w-6 rounded-full border border-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]"
                            style={{ backgroundColor: theme.color }}
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className="overflow-hidden rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-panel)]">
              <div className="border-b border-[var(--border-subtle)] px-3 py-2">
                <strong className="text-sm text-[var(--text-strong)]">{t('windowCloseSettings')}</strong>
              </div>

              <div className="grid gap-2 px-3 py-2.5 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-start">
                <div>
                  <small className="block text-[11px] text-[var(--text-muted)]">{t('currentWindowCloseBehavior', { behavior: currentWindowCloseBehaviorLabel })}</small>
                </div>
                <div className="grid gap-2">
                  <div className="grid grid-cols-2 gap-1.5">
                    {closeBehaviorOptions.map((option) => (
                      <Button key={option.value} className="h-7 px-2.5 text-xs" variant={windowCloseBehavior === option.value ? 'default' : 'secondary'} onClick={() => handleWindowCloseBehaviorChange(option.value)}>
                        {option.label}
                      </Button>
                    ))}
                  </div>
                  <p className="text-[11px] leading-4 text-[var(--text-muted)]">{t('windowCloseBehaviorHint')}</p>
                </div>
              </div>
            </section>

            <section className="overflow-hidden rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-panel)]">
              <div className="border-b border-[var(--border-subtle)] px-3 py-2">
                <strong className="text-sm text-[var(--text-strong)]">{t('aiAssistantSettings')}</strong>
              </div>

              <div className="grid gap-3 px-3 py-2.5">
                <div className="grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-start">
                  <div>
                    <strong className="block pt-0.5 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">{t('aiProviderLabel')}</strong>
                    <small className="text-[11px] text-[var(--text-muted)]">{t('aiProviderHint')}</small>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {aiProviderOptions.map((option) => (
                      <Button
                        key={option.value}
                        className="h-7 px-2.5 text-xs"
                        size="sm"
                        variant={aiAssistantDraftSettings.provider === option.value ? 'default' : 'secondary'}
                        onClick={() => setAiAssistantDraftSettings((current) => ({ ...current, provider: option.value }))}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-start">
                  <div>
                    <strong className="block pt-0.5 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">{t('aiPermissionLabel')}</strong>
                    <small className="text-[11px] text-[var(--text-muted)]">{t('aiPermissionHint')}</small>
                  </div>
                  <div className="grid gap-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {aiTerminalPermissionOptions.map((option) => (
                        <Button
                          key={option.value}
                          className="h-7 px-2.5 text-xs"
                          size="sm"
                          variant={aiAssistantDraftSettings.terminal_permission === option.value ? 'default' : 'secondary'}
                          onClick={() => setAiAssistantDraftSettings((current) => ({ ...current, terminal_permission: option.value }))}
                        >
                          {option.label}
                        </Button>
                      ))}
                    </div>
                    <p className="text-[11px] leading-4 text-[var(--text-muted)]">
                      {aiTerminalPermissionOptions.find((option) => option.value === aiAssistantDraftSettings.terminal_permission)?.hint}
                    </p>
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-start">
                  <div>
                    <strong className="block pt-0.5 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">{t('aiBaseUrlLabel')}</strong>
                    <small className="text-[11px] text-[var(--text-muted)]">{t('aiBaseUrlHint', { endpoint: aiDefaultEndpoint })}</small>
                  </div>
                  <Input
                    value={aiAssistantDraftSettings.base_url}
                    placeholder={aiDefaultEndpoint}
                    onChange={(event) => setAiAssistantDraftSettings((current) => ({ ...current, base_url: event.target.value }))}
                  />
                </div>

                <div className="grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-start">
                  <div>
                    <strong className="block pt-0.5 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">{t('aiModelLabel')}</strong>
                    <small className="text-[11px] text-[var(--text-muted)]">{t('aiModelHint')}</small>
                  </div>
                  <Input
                    value={aiAssistantDraftSettings.model}
                    placeholder={aiAssistantDraftSettings.provider === 'anthropic' ? 'claude-3-5-sonnet-latest' : 'gpt-4.1-mini'}
                    onChange={(event) => setAiAssistantDraftSettings((current) => ({ ...current, model: event.target.value }))}
                  />
                </div>

                <div className="grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-start">
                  <div>
                    <strong className="block pt-0.5 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">{t('aiApiKeyLabel')}</strong>
                    <small className="text-[11px] text-[var(--text-muted)]">{t('aiApiKeyHint')}</small>
                  </div>
                  <Input
                    type="password"
                    value={aiAssistantDraftSettings.api_key}
                    placeholder={t('aiApiKeyPlaceholder')}
                    onChange={(event) => setAiAssistantDraftSettings((current) => ({ ...current, api_key: event.target.value }))}
                  />
                </div>

                <div className="grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-start">
                  <div>
                    <strong className="block pt-0.5 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">{t('aiSystemPromptLabel')}</strong>
                    <small className="text-[11px] leading-4 text-[var(--text-muted)]">{t('aiSystemPromptHint')}</small>
                  </div>
                  <Textarea
                    value={aiAssistantDraftSettings.system_prompt}
                    rows={4}
                    className="min-h-[108px] resize-y"
                    placeholder={DEFAULT_AI_SYSTEM_PROMPT}
                    onChange={(event) => setAiAssistantDraftSettings((current) => ({ ...current, system_prompt: event.target.value }))}
                  />
                </div>
              </div>
            </section>

            <section className="overflow-hidden rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-panel)]">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
                <strong className="text-sm text-[var(--text-strong)]">{t('updateSettings')}</strong>
                <Button className="h-7 px-2.5 text-xs" size="sm" variant="secondary" onClick={() => void checkForAppUpdate()} disabled={checkingAppUpdate}>
                  {t('checkUpdates')}
                </Button>
              </div>

              <div className="grid gap-2 px-3 py-2.5">
                <div className="grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-center">
                  <div>
                    <strong className="block text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">{t('updateChannelSettings')}</strong>
                    <small className="text-[11px] text-[var(--text-muted)]">{t('currentUpdateChannel', { channel: currentUpdateChannelLabel })}</small>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {updateChannelOptions.map((option) => (
                      <Button key={option.value} className="h-7 px-2.5 text-xs" size="sm" variant={updateChannel === option.value ? 'default' : 'secondary'} onClick={() => handleUpdateChannelChange(option.value)}>
                        {option.label}
                      </Button>
                    ))}
                  </div>
                </div>

                {appUpdateInfo ? (
                  <>
                    <div className="grid gap-1.5 grid-cols-2">
                      <div className="rounded-lg bg-[var(--surface-chip)] px-2.5 py-2">
                        <small className="block text-[11px] text-[var(--text-muted)]">{t('updateCurrentVersionLabel')}</small>
                        <strong className="text-[13px]">{appUpdateInfo.current_version || '--'}</strong>
                      </div>
                      <div className="rounded-lg bg-[var(--surface-chip)] px-2.5 py-2">
                        <small className="block text-[11px] text-[var(--text-muted)]">{t('updateLatestVersionLabel')}</small>
                        <strong className="text-[13px]">{appUpdateInfo.latest_version || '--'}</strong>
                      </div>
                    </div>

                    <div className="space-y-1 text-xs text-[var(--text-primary)]">
                      <div className="flex flex-wrap items-center justify-between gap-2"><span>{appUpdateInfo.release_name}</span><small className="text-[11px] text-[var(--text-muted)]">{appUpdateInfo.release_tag} · {appUpdateReleaseChannelLabel}</small></div>
                      {appUpdateInfo.published_at && <div className="text-[11px] text-[var(--text-muted)]">{t('updatePublishedAt', { date: formatReleaseDate(appUpdateInfo.published_at) })}</div>}
                      {appUpdateInfo.download_asset && <div className="text-[11px] text-[var(--text-muted)]">{t('updatePackageLabel', { name: appUpdateInfo.download_asset.name })} · {t('updatePackageSize', { size: Math.ceil(appUpdateInfo.download_asset.size_bytes / 1024 / 1024) })}</div>}
                    </div>

                    {appUpdateInfo.update_available && appUpdateInfo.download_asset && (
                      <div>
                        <Button className="h-7 px-2.5 text-xs" onClick={() => void downloadLatestRelease()} disabled={downloadingAppUpdate}>{t('downloadAndInstallUpdate')}</Button>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-[11px] leading-4 text-[var(--text-muted)]">{appUpdateStatusLabel}</p>
                )}

                {appUpdateProgress && (
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
                      <span>{appUpdateProgress.status === 'installing' ? t('updateInstallingProgress', { name: appUpdateProgress.filename || '' }) : t('updateDownloadingProgress', { name: appUpdateProgress.filename || '', percent: appUpdateProgressPercent })}</span>
                      <small>{t('updateProgressBytes', { downloaded: formatUpdateBytes(appUpdateProgress.downloaded_bytes), total: formatUpdateBytes(appUpdateProgress.total_bytes) })}</small>
                    </div>
                    <div className="h-2 rounded-full bg-[var(--surface-chip)]">
                      <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${appUpdateProgressPercent}%` }} />
                    </div>
                  </div>
                )}

                <p className="text-[11px] leading-4 text-[var(--text-muted)]">{t('updateHint')}</p>
              </div>
            </section>
          </div>

          <DialogFooter className="mt-3 border-t border-[var(--border-subtle)] pt-3">
            <div className="mr-auto text-[11px] leading-4 text-[var(--text-muted)]">
              {t('aiAssistantSaveHint')}
            </div>
            <Button className="h-8 px-3 text-xs" onClick={saveAiAssistantSettings} disabled={!hasPendingAiAssistantSettingsChanges}>
              {t('saveSettings')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(connectPanePickerPaneId)} onOpenChange={(open) => {
        if (!open) setConnectPanePickerPaneId(null)
      }}>
        <DialogContent className="w-[min(92vw,620px)] max-h-[min(84vh,720px)] overflow-auto">
          <DialogHeader>
            <DialogTitle>{t('connectHost')}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {groupedConnections.filter((group) => group.items.length > 0).map((group) => (
              <section key={group.id} className="space-y-2">
                <strong className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                  {group.id === DEFAULT_GROUP_ID ? t('defaultGroupName') : group.name}
                </strong>

                <div className="space-y-2">
                  {group.items.map((connection) => (
                    <button
                      key={connection.id}
                      type="button"
                      className="flex w-full items-center gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3.5 py-3 text-left transition hover:border-[var(--border-strong)] hover:bg-[var(--surface-tab-active)]"
                      onClick={() => void connectPaneToConnection(connection)}
                    >
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--surface-chip)]">
                        <HostSystemIcon connection={connection} className="text-[var(--text-muted)]" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-sm text-[var(--text-strong)]">{connection.name}</strong>
                        <small className="block truncate text-xs text-[var(--text-muted)]">{connection.username}@{connection.host}:{connection.port}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <DialogFooter>
            <Button variant="secondary" onClick={() => setConnectPanePickerPaneId(null)}>{t('cancel')}</Button>
            <Button onClick={() => {
              const paneId = connectPanePickerPaneId
              setConnectPanePickerPaneId(null)
              openConnectionModal(undefined, undefined, paneId || undefined)
            }}>{t('newConnection')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={connectionModalOpen} onOpenChange={(open) => {
        if (!open) {
          pendingConnectPaneIdRef.current = undefined
        }
        setConnectionModalOpen(open)
      }}>
        <DialogContent className="w-[min(92vw,720px)] max-h-[min(88vh,760px)] overflow-auto">
          <DialogHeader>
            <DialogTitle>{connectionForm.id ? t('connectionEditTitle') : t('connectionNewTitle')}</DialogTitle>
            <DialogDescription>{t('applyImmediatelyAndPersist')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="grid gap-2 text-sm">
                <span>{t('nameLabel')}</span>
                <Input value={connectionForm.name} placeholder={t('connectionNamePlaceholder')} onChange={(event) => setConnectionForm((current) => ({ ...current, name: event.target.value }))} />
              </label>
              <label className="grid gap-2 text-sm">
                <span>{t('hostLabel')}</span>
                <Input value={connectionForm.host} placeholder={t('hostPlaceholder')} onChange={(event) => setConnectionForm((current) => ({ ...current, host: event.target.value }))} />
              </label>
              <label className="grid gap-2 text-sm">
                <span>{t('portLabel')}</span>
                <Input type="number" min={1} max={65535} value={String(connectionForm.port ?? 22)} onChange={(event) => setConnectionForm((current) => ({ ...current, port: Number(event.target.value || 22) }))} />
              </label>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <label className="grid gap-2 text-sm">
                <span>{t('usernameLabel')}</span>
                <Input value={connectionForm.username} placeholder={t('usernamePlaceholder')} onChange={(event) => setConnectionForm((current) => ({ ...current, username: event.target.value }))} />
              </label>
              <label className="grid gap-2 text-sm">
                <span>{t('groupLabel')}</span>
                <Select value={connectionForm.group_id} onValueChange={(value) => setConnectionForm((current) => ({ ...current, group_id: value }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {groupOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="grid gap-2 text-sm">
                <span>{t('passwordLabel')}</span>
                <Input type="password" value={connectionForm.password || ''} onChange={(event) => setConnectionForm((current) => ({ ...current, password: event.target.value }))} autoComplete="current-password" />
              </label>
            </div>

            <div className="rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-4">
              <div className="mb-3 text-sm font-semibold">{t('keyAuthTitle')}</div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-2 text-sm">
                  <span>{t('privateKeyPathLabel')}</span>
                  <Input value={connectionForm.private_key_path || ''} placeholder={t('privateKeyPathPlaceholder')} onChange={(event) => setConnectionForm((current) => ({ ...current, private_key_path: event.target.value }))} />
                </label>
                <label className="grid gap-2 text-sm">
                  <span>{t('privateKeyPassphraseLabel')}</span>
                  <Input type="password" value={connectionForm.private_key_passphrase || ''} onChange={(event) => setConnectionForm((current) => ({ ...current, private_key_passphrase: event.target.value }))} autoComplete="current-password" />
                </label>
              </div>
              <label className="mt-4 grid gap-2 text-sm">
                <span>{t('pastePrivateKeyLabel')}</span>
                <Textarea value={connectionForm.private_key || ''} placeholder={t('privateKeyPlaceholder')} onChange={(event) => setConnectionForm((current) => ({ ...current, private_key: event.target.value }))} className="min-h-[100px]" />
              </label>
            </div>
          </div>

          <DialogFooter className="items-stretch sm:items-center sm:justify-between">
            <Button variant="secondary" onClick={() => void testConnection()} disabled={testingConnection}>{t('testConnection')}</Button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => {
                pendingConnectPaneIdRef.current = undefined
                setConnectionModalOpen(false)
              }}>{t('cancel')}</Button>
              <Button onClick={saveConnection}>{t('confirm')}</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={groupModalOpen} onOpenChange={setGroupModalOpen}>
        <DialogContent className="w-[min(92vw,460px)]">
          <DialogHeader>
            <DialogTitle>{groupForm.id ? t('groupRenameTitle') : t('groupNewTitle')}</DialogTitle>
          </DialogHeader>

          <label className="grid gap-2 text-sm">
            <span>{t('groupNameLabel')}</span>
            <Input value={groupForm.name} placeholder={t('groupNamePlaceholder')} onChange={(event) => setGroupForm((current) => ({ ...current, name: event.target.value }))} />
          </label>

          <DialogFooter>
            <Button variant="secondary" onClick={() => setGroupModalOpen(false)}>{t('cancel')}</Button>
            <Button onClick={saveGroup}>{t('confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(groupPendingDelete)} onOpenChange={(open) => {
        if (!open) setGroupPendingDelete(null)
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteGroup')}</AlertDialogTitle>
            <AlertDialogDescription>{t('deleteGroupMoveNotice')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              if (groupPendingDelete) {
                deleteGroup(groupPendingDelete)
                setGroupPendingDelete(null)
              }
            }}>{t('delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </main>
    </div>
  )
}
