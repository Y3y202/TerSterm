<script setup lang="ts">
import { computed, h, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import {
  CloseOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  LeftOutlined,
  PlusOutlined,
  RightOutlined,
  SearchOutlined,
  SettingOutlined,
  SyncOutlined,
} from '@ant-design/icons-vue'
import { message, Modal } from 'ant-design-vue'
import TerminalPane from './components/TerminalPane.vue'
import {
  onSshData,
  setDesktopLocale as syncDesktopLocale,
  setWindowCloseBehavior as syncWindowCloseBehavior,
  sshConnect,
  sshDisconnect,
  sshGetSystemUsage,
  sshTestConnection,
  sshWrite,
} from './bridge'
import { locale as appLocale, setLocale, supportedLocales, t, type AppLocale } from './i18n'
import type { ConnectionGroup, ConnectionProfile, SshPane } from './types'

const CONNECTION_STORAGE_KEY = 'tersterm.connections'
const GROUP_STORAGE_KEY = 'tersterm.groups'
const SIDEBAR_WIDTH_STORAGE_KEY = 'tersterm.sidebarWidth'
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'tersterm.sidebarCollapsed'
const WINDOW_CLOSE_BEHAVIOR_STORAGE_KEY = 'tersterm.windowCloseBehavior'
const THEME_STORAGE_KEY = 'tersterm.theme'
const DEFAULT_GROUP_ID = 'default'
const DEFAULT_GROUP_NAME = '默认'
const DEFAULT_GROUP_ALIASES = new Set(['默认', 'Default'])
const MAX_PANES = 4
const MIN_SIDEBAR_WIDTH = 176
const MAX_SIDEBAR_WIDTH = 340
const DEFAULT_SIDEBAR_WIDTH = 184
const LEGACY_SIDEBAR_WIDTHS = new Set([195, 210, 228, 240, 270, 300])

type ConnectionDraft = Omit<ConnectionProfile, 'id'> & { id?: string }
type DeepLinkUnlisten = () => void
type PendingPaneCredential = 'private_key_passphrase'

const appThemes = [
  {
    id: 'sage',
    titleKey: 'themeSageTitle',
    descriptionKey: 'themeSageDescription',
    preview: ['#2f8d7d', '#dcf2eb', '#eef4f6'],
  },
  {
    id: 'ocean',
    titleKey: 'themeOceanTitle',
    descriptionKey: 'themeOceanDescription',
    preview: ['#387ad6', '#dceafb', '#eef4fb'],
  },
  {
    id: 'dawn',
    titleKey: 'themeDawnTitle',
    descriptionKey: 'themeDawnDescription',
    preview: ['#d9835f', '#fde5d9', '#fcf4ee'],
  },
] as const

type AppThemeId = (typeof appThemes)[number]['id']
type WindowCloseBehavior = 'tray' | 'exit'

const DEFAULT_THEME_ID: AppThemeId = appThemes[0].id

const isAppThemeId = (value: string | null): value is AppThemeId =>
  Boolean(value && appThemes.some((theme) => theme.id === value))

const createId = (prefix: string) => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const getDefaultPaneTitle = (index: number) => t('terminalIndexedTitle', index + 1)

const getBasePaneTitle = () => t('terminalBaseTitle')

const groupIdFromName = (name: string) => {
  const normalized = name.trim()
  if (!normalized || DEFAULT_GROUP_ALIASES.has(normalized)) return DEFAULT_GROUP_ID
  return `group-${normalized.toLowerCase().replace(/\s+/g, '-')}`
}

const readStoredTheme = (): AppThemeId => {
  const storedTheme = localStorage.getItem(THEME_STORAGE_KEY)
  return isAppThemeId(storedTheme) ? storedTheme : DEFAULT_THEME_ID
}

const readStoredSidebarCollapsed = () => localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true'

const clampSidebarWidthValue = (width: number) => Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width))

const readStoredSidebarWidth = () => {
  const storedWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
  if (!Number.isFinite(storedWidth) || storedWidth <= 0) return DEFAULT_SIDEBAR_WIDTH

  const nextWidth = LEGACY_SIDEBAR_WIDTHS.has(storedWidth) ? DEFAULT_SIDEBAR_WIDTH : storedWidth
  return clampSidebarWidthValue(nextWidth)
}

const isWindowCloseBehavior = (value: string | null): value is WindowCloseBehavior =>
  value === 'tray' || value === 'exit'

const readStoredWindowCloseBehavior = (): WindowCloseBehavior => {
  const storedBehavior = localStorage.getItem(WINDOW_CLOSE_BEHAVIOR_STORAGE_KEY)
  return isWindowCloseBehavior(storedBehavior) ? storedBehavior : 'exit'
}

const applyAppTheme = (themeId: AppThemeId) => {
  document.documentElement.dataset.theme = themeId
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

const normalizeConnections = (
  rawConnections: ConnectionProfile[],
  availableGroups: ConnectionGroup[],
): ConnectionProfile[] =>
  rawConnections.map((connection) => ({
    ...connection,
    port: Number(connection.port || 22),
    group_id: resolveConnectionGroupId(connection, availableGroups),
    group: undefined,
  }))

const rawConnections = readRawConnections()
const groups = ref<ConnectionGroup[]>(readStoredGroups(rawConnections))
const connections = ref<ConnectionProfile[]>(normalizeConnections(rawConnections, groups.value))
const panes = ref<SshPane[]>([createPane(0)])
const visiblePaneIds = ref<string[]>([panes.value[0].id])
const activePaneId = ref(panes.value[0].id)
const searchText = ref('')
const connectionModalOpen = ref(false)
const groupModalOpen = ref(false)
const settingsModalOpen = ref(false)
const testingConnection = ref(false)
const appTheme = ref<AppThemeId>(readStoredTheme())
const sidebarCollapsed = ref(readStoredSidebarCollapsed())
const windowCloseBehavior = ref<WindowCloseBehavior>(readStoredWindowCloseBehavior())
const sidebarWidth = ref(readStoredSidebarWidth())
const resizingSidebar = ref(false)
const selectedConnectionId = ref<string>()
const syncInputEnabled = ref(false)
const syncedPaneIds = ref<string[]>([])
const terminalRefs = ref<Record<string, InstanceType<typeof TerminalPane>>>({})
let unlistenDeepLink: DeepLinkUnlisten | undefined
let unlistenSshData: DeepLinkUnlisten | undefined
let systemUsageTimer: number | undefined
const systemUsageRequestIds = new Map<string, number>()
const systemUsagePendingPaneIds = new Map<string, number>()
const pendingPaneCredentials = new Map<string, PendingPaneCredential>()
const pendingPaneCredentialBuffers = new Map<string, string>()

const connectionForm = reactive<ConnectionDraft>({
  name: '',
  host: '',
  port: 22,
  username: '',
  password: '',
  private_key_path: '',
  private_key: '',
  private_key_passphrase: '',
  group_id: getPreferredGroupId(groups.value),
})

const groupForm = reactive({
  id: '',
  name: '',
})

const languageOptions = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en-US', label: 'English' },
] as const

const splitLayouts = [
  { count: 1, titleKey: 'layoutSingle', icon: 'single' },
  { count: 2, titleKey: 'layoutDual', icon: 'dual' },
  { count: 3, titleKey: 'layoutTriple', icon: 'triple' },
  { count: 4, titleKey: 'layoutQuad', icon: 'quad' },
] as const

const visiblePanes = computed(() =>
  visiblePaneIds.value
    .map((paneId) => panes.value.find((pane) => pane.id === paneId))
    .filter((pane): pane is SshPane => Boolean(pane)),
)
const activePane = computed(() => panes.value.find((pane) => pane.id === activePaneId.value))
const visibleConnectedPanes = computed(() =>
  visiblePanes.value.filter((pane) => pane.status === 'connected' && pane.session_id),
)
const syncTargetPanes = computed(() =>
  visibleConnectedPanes.value.filter((pane) => syncedPaneIds.value.includes(pane.id)),
)
const canBroadcastInput = computed(() => syncInputEnabled.value && syncTargetPanes.value.length >= 2)
const activeAppTheme = computed(() => appThemes.find((theme) => theme.id === appTheme.value) ?? appThemes[0])
const closeBehaviorOptions = computed(() => [
  { value: 'tray', label: t('windowCloseBehaviorTray') },
  { value: 'exit', label: t('windowCloseBehaviorExit') },
] as const)
const currentLanguageLabel = computed(
  () => languageOptions.find((option) => option.value === appLocale.value)?.label ?? '中文',
)
const currentWindowCloseBehaviorLabel = computed(
  () =>
    closeBehaviorOptions.value.find((option) => option.value === windowCloseBehavior.value)?.label ??
    t('windowCloseBehaviorExit'),
)
const getThemeTitle = (theme: (typeof appThemes)[number]) => t(theme.titleKey)
const getThemeDescription = (theme: (typeof appThemes)[number]) => t(theme.descriptionKey)
const getSplitLayoutTitle = (layout: (typeof splitLayouts)[number]) => t(layout.titleKey)
const getGroupDisplayName = (group: Pick<ConnectionGroup, 'id' | 'name'>) =>
  group.id === DEFAULT_GROUP_ID ? t('defaultGroupName') : group.name
const syncStatusSummary = computed(() => {
  if (visibleConnectedPanes.value.length < 2) {
    return t('syncNeedTwoSessions')
  }

  if (syncInputEnabled.value) {
    return t('syncSyncedCount', syncedPaneIds.value.length)
  }

  if (syncedPaneIds.value.length >= 2) {
    return t('syncSelectedCount', syncedPaneIds.value.length)
  }

  return t('syncNotEnabled')
})

const groupOptions = computed(() =>
  groups.value.map((group) => ({
    label: getGroupDisplayName(group),
    value: group.id,
  })),
)

const groupNameById = computed(() => {
  const names = new Map<string, string>()
  groups.value.forEach((group) => names.set(group.id, getGroupDisplayName(group)))
  return names
})

watch(
  appTheme,
  (themeId) => {
    applyAppTheme(themeId)
    localStorage.setItem(THEME_STORAGE_KEY, themeId)
  },
  { immediate: true },
)

watch(
  sidebarCollapsed,
  (value) => localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(value)),
  { immediate: true },
)

watch(
  windowCloseBehavior,
  (value) => {
    localStorage.setItem(WINDOW_CLOSE_BEHAVIOR_STORAGE_KEY, value)
    void syncWindowCloseBehavior(value)
  },
  { immediate: true },
)

watch(
  appLocale,
  (value) => {
    void syncDesktopLocale(value)
  },
  { immediate: true },
)

watch(appLocale, () => {
  panes.value.forEach((pane, index) => {
    if (!pane.connection) {
      pane.title = getDefaultPaneTitle(index)
    }
  })
})

const setAppLocale = (value: string | number) => {
  if (supportedLocales.includes(value as AppLocale)) {
    setLocale(value as AppLocale)
  }
}

const setWindowCloseBehaviorValue = (value: string | number) => {
  if (value === 'tray' || value === 'exit') {
    windowCloseBehavior.value = value
  }
}

const filteredConnections = computed(() => {
  const query = searchText.value.trim().toLowerCase()
  if (!query) return connections.value

  return connections.value.filter((connection) =>
    [
      connection.name,
      connection.host,
      connection.username,
      groupNameById.value.get(resolveConnectionGroupId(connection, groups.value)),
    ]
      .filter(Boolean)
      .some((part) => part!.toLowerCase().includes(query)),
  )
})

const groupedConnections = computed(() => {
  const query = searchText.value.trim()

  return groups.value
    .map((group) => {
      const items = filteredConnections.value.filter(
        (connection) => resolveConnectionGroupId(connection, groups.value) === group.id,
      )

      return {
        ...group,
        items,
        visible: query ? items.length > 0 : true,
        expanded: query ? true : group.expanded,
      }
    })
    .filter((group) => group.visible)
})

watch(
  connections,
  (value) => localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(value)),
  { deep: true },
)

watch(
  groups,
  (value) => localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(value)),
  { deep: true },
)

watch(
  () => visibleConnectedPanes.value.map((pane) => `${pane.id}:${pane.session_id}`).join('|'),
  () => pruneSyncTargets(),
)

const setTerminalRef = (paneId: string, component: InstanceType<typeof TerminalPane> | null) => {
  if (!component) {
    delete terminalRefs.value[paneId]
    return
  }

  terminalRefs.value[paneId] = component
}

const clampSidebarWidth = clampSidebarWidthValue

const fitAllTerminals = () => {
  requestAnimationFrame(() => {
    Object.values(terminalRefs.value).forEach((terminal) => terminal?.fitTerminal())
  })
}

const setSidebarCollapsed = (collapsed: boolean) => {
  if (sidebarCollapsed.value === collapsed) return

  sidebarCollapsed.value = collapsed
  resizingSidebar.value = false
  fitAllTerminals()
}

const toggleSidebarCollapsed = () => {
  setSidebarCollapsed(!sidebarCollapsed.value)
}

const showPane = async (paneId: string) => {
  const current = visiblePaneIds.value.filter((id) => panes.value.some((pane) => pane.id === id))
  if (!current.includes(paneId)) {
    if (current.length < MAX_PANES) {
      current.push(paneId)
    } else {
      const replaceIndex = Math.max(0, current.indexOf(activePaneId.value))
      current[replaceIndex] = paneId
    }
    visiblePaneIds.value = current
  }

  activePaneId.value = paneId
  await nextTick()
  terminalRefs.value[paneId]?.fitTerminal()
}

const switchToPane = async (paneId: string) => {
  const current = visiblePaneIds.value.filter((id) => panes.value.some((pane) => pane.id === id))
  if (!current.includes(paneId)) {
    const replaceIndex = Math.max(0, current.indexOf(activePaneId.value))
    current[replaceIndex] = paneId
    visiblePaneIds.value = current
  }

  activePaneId.value = paneId
  await nextTick()
  terminalRefs.value[paneId]?.fitTerminal()
}

const pruneSyncTargets = () => {
  const selectableIds = new Set(visibleConnectedPanes.value.map((pane) => pane.id))
  syncedPaneIds.value = syncedPaneIds.value.filter((paneId) => selectableIds.has(paneId))
  if (syncedPaneIds.value.length < 2) {
    syncInputEnabled.value = false
  }
}

const toggleSyncInput = () => {
  pruneSyncTargets()

  if (syncInputEnabled.value) {
    syncInputEnabled.value = false
    return
  }

  if (syncedPaneIds.value.length < 2) {
    syncedPaneIds.value = visibleConnectedPanes.value.slice(0, MAX_PANES).map((pane) => pane.id)
  }

  if (!syncInputEnabled.value && syncedPaneIds.value.length < 2) {
    message.warning(t('syncNeedTwoVisiblePanes'))
    return
  }

  syncInputEnabled.value = true
}

const toggleSyncPane = (paneId: string) => {
  if (syncedPaneIds.value.includes(paneId)) {
    syncedPaneIds.value = syncedPaneIds.value.filter((id) => id !== paneId)
  } else if (syncedPaneIds.value.length < MAX_PANES) {
    syncedPaneIds.value = [...syncedPaneIds.value, paneId]
  }

  pruneSyncTargets()
  if (syncedPaneIds.value.length >= 2) {
    syncInputEnabled.value = true
  }
}

const setAppTheme = (themeId: AppThemeId) => {
  appTheme.value = themeId
}

const handleTerminalInput = ({ pane_id, data }: { pane_id: string; data: string }) => {
  const sourcePane = panes.value.find((pane) => pane.id === pane_id)
  if (
    !sourcePane?.session_id ||
    (sourcePane.status !== 'connecting' && sourcePane.status !== 'connected')
  ) {
    return
  }

  capturePendingPaneCredentialInput(sourcePane, data)

  const targets =
    canBroadcastInput.value && syncedPaneIds.value.includes(pane_id)
      ? syncTargetPanes.value
      : [sourcePane]

  targets.forEach((pane) => {
    if (
      pane.session_id &&
      (pane.status === 'connecting' || pane.status === 'connected')
    ) {
      void sshWrite(pane.session_id, data)
    }
  })
}

const handlePaneZmodemState = ({ pane_id, active }: { pane_id: string; active: boolean }) => {
  const pane = panes.value.find((item) => item.id === pane_id)
  if (!pane) return
  pane.zmodem_active = active
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

const clearPendingPaneCredential = (paneId: string) => {
  pendingPaneCredentials.delete(paneId)
  pendingPaneCredentialBuffers.delete(paneId)
}

const trackPendingPaneCredential = (pane: SshPane, data: string) => {
  if (
    connectionUsesPrivateKey(pane.connection) &&
    !pane.connection?.private_key_passphrase &&
    hasPrivateKeyPassphrasePrompt(pane.terminal_output || data)
  ) {
    pendingPaneCredentials.set(pane.id, 'private_key_passphrase')
    pendingPaneCredentialBuffers.set(pane.id, '')
    return
  }

  if (paneLooksAuthenticated(pane)) {
    clearPendingPaneCredential(pane.id)
  }
}

const capturePendingPaneCredentialInput = (pane: SshPane, data: string) => {
  const shouldCapture =
    pendingPaneCredentials.get(pane.id) === 'private_key_passphrase' ||
    (connectionUsesPrivateKey(pane.connection) &&
      !pane.connection?.private_key_passphrase &&
      hasPrivateKeyPassphrasePrompt(pane.terminal_output || '') &&
      !paneLooksAuthenticated(pane))

  if (!shouldCapture) return

  let buffer = pendingPaneCredentialBuffers.get(pane.id) || ''
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
        pane.connection = {
          ...pane.connection,
          private_key_passphrase: buffer,
        }
        pane.private_key_passphrase_origin = 'session'
        window.setTimeout(() => {
          if (
            pane.session_id &&
            pane.status === 'connected' &&
            !pane.system_usage &&
            shouldRefreshPaneSystemUsage(pane)
          ) {
            void refreshPaneSystemUsage(pane)
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

  pendingPaneCredentialBuffers.set(pane.id, buffer)
}

const terminalOutputLines = (output: string) =>
  output
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean)

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

const shouldRefreshPaneSystemUsage = (pane: SshPane) =>
  Boolean(pane.connection && pane.session_id && pane.remote_features_ready)

const refreshPaneSystemUsage = async (pane: SshPane) => {
  if (!pane.connection || !pane.session_id || pane.status !== 'connected') return
  if (systemUsagePendingPaneIds.has(pane.id)) return

  const sessionId = pane.session_id
  const requestId = (systemUsageRequestIds.get(pane.id) || 0) + 1
  systemUsageRequestIds.set(pane.id, requestId)
  systemUsagePendingPaneIds.set(pane.id, requestId)
  pane.system_usage_loading = true
  pane.system_usage_error = undefined

  try {
    const usage = await sshGetSystemUsage(pane.connection, sessionId)
    if (
      systemUsageRequestIds.get(pane.id) === requestId &&
      pane.session_id === sessionId &&
      pane.status === 'connected'
    ) {
      pane.system_usage = usage
      pane.system_usage_error = undefined
    }
  } catch (error) {
    if (
      systemUsageRequestIds.get(pane.id) === requestId &&
      pane.session_id === sessionId &&
      pane.status === 'connected'
    ) {
      pane.system_usage_error = error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (systemUsagePendingPaneIds.get(pane.id) === requestId) {
      systemUsagePendingPaneIds.delete(pane.id)
      pane.system_usage_loading = false
    }
  }
}

const markPaneRemoteFeaturesReady = (pane: SshPane) => {
  if (!pane.connection || !pane.session_id) return

  pane.remote_features_ready = true
  if (pane.status === 'connecting') {
    pane.status = 'connected'
  }

  if (!pane.system_usage) {
    pane.system_usage_error = undefined
    void refreshPaneSystemUsage(pane)
  }
}

const stopPaneSession = async (pane: SshPane) => {
  const session_id = pane.session_id
  if (!session_id) return

  Object.assign(pane, {
    status: 'closed' as const,
    private_key_passphrase_origin: undefined,
    remote_features_ready: false,
    error: undefined,
    zmodem_active: false,
    system_usage: undefined,
    system_usage_loading: false,
    system_usage_error: undefined,
  })
  systemUsageRequestIds.delete(pane.id)
  systemUsagePendingPaneIds.delete(pane.id)
  clearPendingPaneCredential(pane.id)
  try {
    await sshDisconnect(session_id)
  } catch (error) {
    if (pane.session_id === session_id) {
      pane.error = error instanceof Error ? error.message : String(error)
    }
  }
  if (pane.session_id === session_id) {
    pane.session_id = undefined
  }
}

const refreshAllSystemUsage = () => {
  panes.value.forEach((pane) => {
    if (pane.status === 'connected' && pane.session_id && shouldRefreshPaneSystemUsage(pane)) {
      void refreshPaneSystemUsage(pane)
    }
  })
}

const startSystemUsagePolling = () => {
  if (systemUsageTimer) {
    window.clearInterval(systemUsageTimer)
  }

  refreshAllSystemUsage()
  systemUsageTimer = window.setInterval(refreshAllSystemUsage, 15000)
}

const stopSystemUsagePolling = () => {
  if (systemUsageTimer) {
    window.clearInterval(systemUsageTimer)
    systemUsageTimer = undefined
  }
  systemUsageRequestIds.clear()
  systemUsagePendingPaneIds.clear()
}

const startSidebarResize = (event: PointerEvent) => {
  if (sidebarCollapsed.value) return

  const startX = event.clientX
  const startWidth = sidebarWidth.value
  resizingSidebar.value = true

  const resize = (moveEvent: PointerEvent) => {
    sidebarWidth.value = clampSidebarWidth(startWidth + moveEvent.clientX - startX)
    fitAllTerminals()
  }

  const stop = () => {
    resizingSidebar.value = false
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth.value))
    window.removeEventListener('pointermove', resize)
    window.removeEventListener('pointerup', stop)
    fitAllTerminals()
  }

  window.addEventListener('pointermove', resize)
  window.addEventListener('pointerup', stop, { once: true })
}

const setSplitCount = async (count: number) => {
  const nextCount = Math.min(MAX_PANES, Math.max(1, count))
  if (nextCount === visiblePaneIds.value.length) return

  if (nextCount < visiblePaneIds.value.length) {
    visiblePaneIds.value = visiblePaneIds.value.slice(0, nextCount)
    if (!visiblePaneIds.value.includes(activePaneId.value)) {
      activePaneId.value = visiblePaneIds.value[0]
    }
    return
  }

  const nextVisible = [...visiblePaneIds.value]
  const hiddenPanes = panes.value.filter((pane) => !nextVisible.includes(pane.id))
  while (nextVisible.length < nextCount) {
    const hidden = hiddenPanes.shift()
    if (hidden) {
      nextVisible.push(hidden.id)
      continue
    }

    const pane = createPane(panes.value.length)
    panes.value.push(pane)
    nextVisible.push(pane.id)
  }
  visiblePaneIds.value = nextVisible

  await nextTick()
  visiblePanes.value.forEach((pane) => terminalRefs.value[pane.id]?.fitTerminal())
}

const toggleGroup = (groupId: string) => {
  const group = groups.value.find((item) => item.id === groupId)
  if (!group) return
  group.expanded = !group.expanded
}

const resetConnectionForm = (connection?: ConnectionProfile) => {
  connectionForm.id = connection?.id
  connectionForm.name = connection?.name || ''
  connectionForm.host = connection?.host || ''
  connectionForm.port = connection?.port || 22
  connectionForm.username = connection?.username || ''
  connectionForm.password = connection?.password || ''
  connectionForm.private_key_path = connection?.private_key_path || ''
  connectionForm.private_key = connection?.private_key || ''
  connectionForm.private_key_passphrase = connection?.private_key_passphrase || ''
  connectionForm.group_id = connection
    ? resolveConnectionGroupId(connection, groups.value)
    : getPreferredGroupId(groups.value)
}

const openConnectionModal = (connection?: ConnectionProfile, groupId?: string) => {
  resetConnectionForm(connection)
  if (!connection && groupId) {
    connectionForm.group_id = groupId
  }
  connectionModalOpen.value = true
}

const profileFromConnectionForm = (): ConnectionProfile | undefined => {
  if (!connectionForm.name.trim() || !connectionForm.host.trim() || !connectionForm.username.trim()) {
    message.warning(t('fillConnectionRequired'))
    return undefined
  }

  const group_id = getPreferredGroupId(groups.value, connectionForm.group_id)

  return {
    id: connectionForm.id || createId('connection'),
    name: connectionForm.name.trim(),
    host: connectionForm.host.trim(),
    port: Number(connectionForm.port || 22),
    username: connectionForm.username.trim(),
    password: connectionForm.password || undefined,
    private_key_path: connectionForm.private_key_path?.trim() || undefined,
    private_key: connectionForm.private_key?.trim() || undefined,
    private_key_passphrase: connectionForm.private_key_passphrase || undefined,
    group_id,
  }
}

const saveConnection = () => {
  const profile = profileFromConnectionForm()
  if (!profile) return

  const existingIndex = connections.value.findIndex((connection) => connection.id === profile.id)
  if (existingIndex >= 0) {
    connections.value.splice(existingIndex, 1, profile)
  } else {
    connections.value.unshift(profile)
  }

  const group = groups.value.find((item) => item.id === profile.group_id)
  if (group) group.expanded = true

  selectedConnectionId.value = profile.id
  connectionModalOpen.value = false
  message.success(t('connectionSaved'))
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
  if (!groupName) return getPreferredGroupId(groups.value)
  if (DEFAULT_GROUP_ALIASES.has(groupName)) return getPreferredGroupId(groups.value)

  const existing = groups.value.find(
    (group) => group.id === groupName || group.name.toLowerCase() === groupName.toLowerCase(),
  )
  if (existing) {
    existing.expanded = true
    return existing.id
  }

  const group: ConnectionGroup = {
    id: createId('group'),
    name: groupName,
    expanded: true,
  }
  groups.value.push(group)
  return group.id
}

const profileFromDeepLink = (
  rawUrl: string,
): { profile: ConnectionProfile; save: boolean; connect: boolean } | undefined => {
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
  const username =
    readUrlValue(url, ['username', 'user', 'login']) || decodeURIComponent(url.username)

  if (!host || !username) {
    message.warning(t('quickSessionLinkNeedsHostAndUsername'))
    return undefined
  }

  const port = Number(readUrlValue(url, ['port']) || url.port || 22)
  const name = readUrlValue(url, ['name', 'title']) || `${username}@${host}`
  const groupValue = readUrlValue(url, ['group', 'group_id', 'folder'])
  const group_id = groupValue ? groupIdFromDeepLink(groupValue) : getPreferredGroupId(groups.value)
  const password = readUrlValue(url, ['password', 'pass']) || decodeURIComponent(url.password)
  const private_key_path = readUrlValue(url, ['private_key_path', 'key_path', 'identity'])
  const private_key = readUrlValue(url, ['private_key', 'key'])
  const private_key_passphrase = readUrlValue(url, [
    'private_key_passphrase',
    'passphrase',
  ])

  return {
    profile: {
      id: createId('connection'),
      name,
      host,
      port: Number.isFinite(port) && port > 0 ? port : 22,
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
  const existingIndex = connections.value.findIndex(
    (connection) =>
      connection.host === profile.host &&
      Number(connection.port || 22) === profile.port &&
      connection.username === profile.username,
  )

  if (existingIndex >= 0) {
    profile.id = connections.value[existingIndex].id
    connections.value.splice(existingIndex, 1, profile)
  } else {
    connections.value.unshift(profile)
  }

  const group = groups.value.find((item) => item.id === profile.group_id)
  if (group) group.expanded = true
  selectedConnectionId.value = profile.id
}

const openQuickSessionUrls = async (urls: string[]) => {
  for (const rawUrl of urls) {
    const quickSession = profileFromDeepLink(rawUrl)
    if (!quickSession) continue

    const profile = quickSession.profile
    if (quickSession.save) {
      saveOrUpdateQuickConnection(profile)
      message.success(t('quickSessionSaved', profile.name))
    }

    if (quickSession.connect) {
      await openConnectionInPane(profile)
    } else {
      resetConnectionForm(profile)
      connectionModalOpen.value = true
    }
  }
}

const testConnection = async () => {
  const profile = profileFromConnectionForm()
  if (!profile) return

  testingConnection.value = true
  try {
    await sshTestConnection(profile)
    message.success(t('testConnectionSuccess'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    testingConnection.value = false
  }
}

const openGroupModal = (group?: ConnectionGroup) => {
  groupForm.id = group?.id || ''
  groupForm.name = group ? getGroupDisplayName(group) : ''
  groupModalOpen.value = true
}

const saveGroup = () => {
  const name = groupForm.name.trim()
  if (!name) {
    message.warning(t('fillGroupName'))
    return
  }

  const duplicate = groups.value.some(
    (group) => getGroupDisplayName(group).toLowerCase() === name.toLowerCase() && group.id !== groupForm.id,
  )
  if (duplicate) {
    message.warning(t('duplicateGroupName'))
    return
  }

  if (groupForm.id) {
    const group = groups.value.find((item) => item.id === groupForm.id)
    if (group) {
      group.name = name
    }
  } else {
    groups.value.push({
      id: createId('group'),
      name,
      expanded: true,
    })
  }

  groupModalOpen.value = false
  message.success(t('groupSaved'))
}

const deleteGroup = (group: ConnectionGroup) => {
  const currentGroups = groups.value
  const remainingGroups = currentGroups.filter((item) => item.id !== group.id)
  if (remainingGroups.length === 0) {
    message.warning(t('keepOneGroup'))
    return
  }

  const fallbackGroupId = getPreferredGroupId(remainingGroups)

  connections.value = connections.value.map((connection) =>
    resolveConnectionGroupId(connection, currentGroups) === group.id
      ? {
          ...connection,
          group_id: fallbackGroupId,
        }
      : connection,
  )

  panes.value.forEach((pane) => {
    if (pane.connection && resolveConnectionGroupId(pane.connection, currentGroups) === group.id) {
      pane.connection = {
        ...pane.connection,
        group_id: fallbackGroupId,
      }
    }
  })

  groups.value = remainingGroups
  message.success(t('groupDeleted'))
}

const confirmDeleteGroup = (group: ConnectionGroup) => {
  Modal.confirm({
    title: t('deleteGroup'),
    content: t('deleteGroupMoveNotice'),
    okText: t('delete'),
    cancelText: t('cancel'),
    okButtonProps: { danger: true },
    onOk: () => deleteGroup(group),
  })
}

const deleteConnection = async (connection: ConnectionProfile) => {
  connections.value = connections.value.filter((item) => item.id !== connection.id)
  if (selectedConnectionId.value === connection.id) {
    selectedConnectionId.value = undefined
  }

  for (const pane of panes.value) {
    if (pane.connection?.id !== connection.id) continue
    await stopPaneSession(pane)
    Object.assign(pane, {
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
    })
  }
}

const disconnectPane = async (pane: SshPane) => {
  await stopPaneSession(pane)

  Object.assign(pane, {
    title: pane.connection?.name || pane.title,
    status: 'closed',
    session_id: undefined,
    private_key_passphrase_origin: undefined,
    remote_features_ready: false,
    error: undefined,
    zmodem_active: false,
    system_usage: undefined,
    system_usage_loading: false,
    system_usage_error: undefined,
  })
}

const disconnectPaneById = async (paneId: string) => {
  const pane = panes.value.find((item) => item.id === paneId)
  if (pane) {
    await disconnectPane(pane)
  }
}

const closePane = async (paneId: string) => {
  const pane = panes.value.find((item) => item.id === paneId)
  if (!pane) return
  const visibleCount = visiblePaneIds.value.length

  await disconnectPane(pane)
  panes.value = panes.value.filter((item) => item.id !== paneId)
  delete terminalRefs.value[paneId]

  if (panes.value.length === 0) {
    panes.value.push(createPane(0))
  }

  const nextVisible = visiblePaneIds.value.filter((id) => id !== paneId)
  for (const candidate of panes.value) {
    if (nextVisible.length >= Math.min(visibleCount, panes.value.length, MAX_PANES)) break
    if (!nextVisible.includes(candidate.id)) {
      nextVisible.push(candidate.id)
    }
  }

  visiblePaneIds.value = nextVisible.length ? nextVisible : [panes.value[0].id]
  if (!visiblePaneIds.value.includes(activePaneId.value)) {
    activePaneId.value = visiblePaneIds.value[0]
  }
}

const findPaneForSidebarConnection = async () => {
  const active = activePane.value
  if (active && active.status !== 'connected' && active.status !== 'connecting') {
    return active.id
  }

  const available = visiblePanes.value.find(
    (pane) => pane.status !== 'connected' && pane.status !== 'connecting',
  )
  if (available) return available.id

  const pane = createPane(panes.value.length)
  panes.value.push(pane)

  const nextVisible = [...visiblePaneIds.value]
  const replaceIndex = Math.max(0, nextVisible.indexOf(activePaneId.value))
  nextVisible[replaceIndex] = pane.id
  visiblePaneIds.value = nextVisible
  await nextTick()
  return pane.id
}

const openConnectionInPane = async (connection: ConnectionProfile, paneId = activePaneId.value) => {
  const pane = panes.value.find((item) => item.id === paneId) || panes.value[0]
  await showPane(pane.id)
  activePaneId.value = pane.id
  selectedConnectionId.value = connection.id

  await stopPaneSession(pane)

  const paneConnection = { ...connection }

  Object.assign(pane, {
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
  })
  clearPendingPaneCredential(pane.id)

  try {
    const session_id = createId('session')
    pane.session_id = session_id
    await sshConnect(paneConnection, session_id)
    if (pane.session_id === session_id && pane.status === 'connecting') {
      Object.assign(pane, {
        status: 'connecting',
        remote_features_ready: false,
        error: undefined,
        zmodem_active: false,
      })
    }
    await nextTick()
    terminalRefs.value[pane.id]?.fitTerminal()
  } catch (error) {
    Object.assign(pane, {
      session_id: undefined,
      status: 'error',
      private_key_passphrase_origin: undefined,
      remote_features_ready: false,
      error: error instanceof Error ? error.message : String(error),
      zmodem_active: false,
    })
  }
}

const openConnectionFromSidebar = async (connection: ConnectionProfile) => {
  const paneId = await findPaneForSidebarConnection()
  if (paneId) {
    await openConnectionInPane(connection, paneId)
  }
}

const connectFromPane = async (paneId: string) => {
  const selected = connections.value.find((connection) => connection.id === selectedConnectionId.value)
  if (selected) {
    await openConnectionInPane(selected, paneId)
    return
  }

  openConnectionModal()
}

const handleDisconnected = ({
  pane_id,
  session_id,
  reason,
}: {
  pane_id: string
  session_id: string
  reason?: string
}) => {
  const pane = panes.value.find((item) => item.id === pane_id)
  if (!pane || pane.session_id !== session_id) return

  Object.assign(pane, {
    status: reason ? 'error' : 'closed',
    session_id: undefined,
    private_key_passphrase_origin: undefined,
    remote_features_ready: false,
    error: reason,
    zmodem_active: false,
    system_usage: undefined,
    system_usage_loading: false,
    system_usage_error: undefined,
  })
  clearPendingPaneCredential(pane.id)
}

const appendTerminalOutput = (session_id: string, data: string) => {
  const pane = panes.value.find((item) => item.session_id === session_id)
  if (!pane) return
  if (pane.zmodem_active) return

  const visibleData = pane.private_key_passphrase_origin === 'configured'
    ? stripConfiguredPassphrasePrompt(data)
    : data
  const nextOutput = `${pane.terminal_output || ''}${visibleData}`
  pane.terminal_output = nextOutput.length > 200_000 ? nextOutput.slice(-200_000) : nextOutput
  trackPendingPaneCredential(pane, visibleData)

  if (!pane.remote_features_ready && paneLooksAuthenticated(pane)) {
    markPaneRemoteFeaturesReady(pane)
  }

  if (shouldRefreshPaneSystemUsage(pane) && !pane.system_usage) {
    pane.system_usage_error = undefined
    void refreshPaneSystemUsage(pane)
  }
}

const handlePaneAuthenticated = ({
  pane_id,
  session_id,
}: {
  pane_id: string
  session_id: string
}) => {
  const pane = panes.value.find((item) => item.id === pane_id)
  if (!pane || pane.session_id !== session_id) return

  markPaneRemoteFeaturesReady(pane)
}

onMounted(async () => {
  startSystemUsagePolling()
  unlistenSshData = await onSshData(({ session_id, data }) => {
    appendTerminalOutput(session_id, data)
  })
  try {
    unlistenDeepLink = await onOpenUrl((urls) => {
      void openQuickSessionUrls(urls)
    })

    const currentUrls = await getCurrent()
    if (currentUrls?.length) {
      void openQuickSessionUrls(currentUrls)
    }
  } catch {
    // Deep links are only available in the Tauri runtime.
  }
})

onBeforeUnmount(() => {
  stopSystemUsagePolling()
  unlistenSshData?.()
  unlistenDeepLink?.()
  void Promise.all(panes.value.map((pane) => (pane.session_id ? sshDisconnect(pane.session_id) : null)))
})
</script>

<template>
  <main
    class="app-shell"
    :class="{ 'is-resizing-sidebar': resizingSidebar, 'is-sidebar-collapsed': sidebarCollapsed }"
    :style="{
      '--sidebar-width': sidebarCollapsed ? '0px' : `${sidebarWidth}px`,
      '--sidebar-resizer-width': sidebarCollapsed ? '0px' : '8px',
    }"
  >
    <aside v-if="!sidebarCollapsed" class="sidebar">
      <div class="brand-panel">
        <div class="brand-row">
          <div class="brand-mark">TS</div>
          <div>
            <h1>TerSterm</h1>
            <span>{{ t('brandSubtitle') }}</span>
          </div>
        </div>
      </div>

      <a-input v-model:value="searchText" :placeholder="t('searchConnectionsOrGroups')" allow-clear>
        <template #prefix>
          <SearchOutlined />
        </template>
      </a-input>

      <div class="sidebar-actions">
        <a-button type="primary" :icon="h(PlusOutlined)" @click="openConnectionModal()">
          {{ t('newConnection') }}
        </a-button>
        <a-tooltip :title="t('newGroup')">
          <a-button :icon="h(FolderAddOutlined)" @click="openGroupModal()" />
        </a-tooltip>
      </div>

      <div class="connection-list">
        <a-empty v-if="connections.length === 0" :description="t('noConnections')" />
        <a-empty v-else-if="filteredConnections.length === 0" :description="t('noMatchingConnections')" />

        <section v-for="group in groupedConnections" :key="group.id" class="connection-group">
          <a-dropdown class="group-context-menu" :trigger="['contextmenu']">
            <div class="group-title">
              <button class="group-toggle" type="button" @click="toggleGroup(group.id)">
                <RightOutlined :class="{ expanded: group.expanded }" />
                <FolderOpenOutlined />
                <span>{{ getGroupDisplayName(group) }}</span>
                <small>{{ group.items.length }}</small>
              </button>
            </div>
            <template #overlay>
              <a-menu>
                <a-menu-item key="add" @click="openConnectionModal(undefined, group.id)">
                  {{ t('addConnection') }}
                </a-menu-item>
                <a-menu-item key="rename" @click="openGroupModal(group)">
                  {{ t('renameGroup') }}
                </a-menu-item>
                <a-menu-item key="delete" danger @click="confirmDeleteGroup(group)">
                  {{ t('deleteGroup') }}
                </a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>

          <div v-show="group.expanded" class="group-items">
            <a-dropdown
              v-for="connection in group.items"
              :key="connection.id"
              class="connection-context-menu"
              :trigger="['contextmenu']"
            >
              <button
                class="connection-item"
                :class="{ selected: selectedConnectionId === connection.id }"
                type="button"
                @click="openConnectionFromSidebar(connection)"
              >
                <span class="connection-main">
                  <strong>{{ connection.name }}</strong>
                  <small>{{ connection.username }}@{{ connection.host }}:{{ connection.port }}</small>
                </span>
              </button>
              <template #overlay>
                <a-menu>
                  <a-menu-item key="edit" @click="openConnectionModal(connection)">
                    {{ t('edit') }}
                  </a-menu-item>
                  <a-menu-item key="delete" danger @click="deleteConnection(connection)">
                    {{ t('delete') }}
                  </a-menu-item>
                </a-menu>
              </template>
            </a-dropdown>

            <button
              v-if="group.items.length === 0 && !searchText"
              class="empty-group-action"
              type="button"
              @click="openConnectionModal(undefined, group.id)"
            >
              <PlusOutlined />
              <span>{{ t('addConnection') }}</span>
            </button>
          </div>
        </section>
      </div>

      <div class="sidebar-footer">
        <a-tooltip :title="t('interfaceSettings')">
          <a-button class="sidebar-settings-button" :icon="h(SettingOutlined)" @click="settingsModalOpen = true">
            {{ t('interfaceSettings') }}
          </a-button>
        </a-tooltip>
        <a-tooltip :title="t('collapseSidebar')">
          <a-button
            class="sidebar-collapse-button"
            :icon="h(LeftOutlined)"
            :aria-label="t('collapseSidebar')"
            @click="toggleSidebarCollapsed"
          />
        </a-tooltip>
      </div>
    </aside>
    <div
      v-if="!sidebarCollapsed"
      class="sidebar-resizer"
      role="separator"
      :aria-label="t('resizeSidebar')"
      @pointerdown="startSidebarResize"
    />

    <section class="workspace">
      <header class="workspace-strip">
        <div class="workspace-context">
          <a-tooltip v-if="sidebarCollapsed" :title="t('expandSidebar')">
            <button
              class="workspace-sidebar-toggle"
              type="button"
              :aria-label="t('expandSidebar')"
              @click="toggleSidebarCollapsed"
            >
              <RightOutlined />
            </button>
          </a-tooltip>
          <div class="session-strip" :aria-label="t('sessionList')">
            <button
              v-for="pane in panes"
              :key="pane.id"
              class="session-chip"
              :class="{ active: pane.id === activePaneId, visible: visiblePaneIds.includes(pane.id) }"
              type="button"
              @click="switchToPane(pane.id)"
            >
              <span class="status-dot" :class="pane.status" />
              <span class="session-chip-text">
                <strong>{{ pane.title }}</strong>
              </span>
              <span class="session-chip-close" role="button" :title="t('closeSession')" @click.stop="closePane(pane.id)">
                <CloseOutlined />
              </span>
            </button>
          </div>
        </div>

        <div class="toolbar-actions">
          <div class="split-layouts toolbar-layouts" :aria-label="t('workspaceLayout')">
            <a-tooltip v-for="layout in splitLayouts" :key="layout.count" :title="getSplitLayoutTitle(layout)">
              <button
                class="split-layout-button"
                :class="{ active: visiblePaneIds.length === layout.count }"
                type="button"
                :aria-label="getSplitLayoutTitle(layout)"
                @click="setSplitCount(layout.count)"
              >
                <span class="layout-icon" :class="`layout-${layout.icon}`">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              </button>
            </a-tooltip>
          </div>

          <a-tooltip :title="t('syncInput')">
            <a-popover placement="bottomRight" trigger="click">
              <template #content>
                <div class="sync-popover-panel">
                  <div class="settings-card-header sync-popover-header">
                    <div>
                      <strong>{{ t('syncInput') }}</strong>
                      <span>{{ syncStatusSummary }}</span>
                    </div>
                    <a-button
                      :type="syncInputEnabled ? 'primary' : 'default'"
                      :disabled="visibleConnectedPanes.length < 2"
                      :icon="h(SyncOutlined)"
                      @click="toggleSyncInput"
                    >
                      {{ syncInputEnabled ? t('syncDisable') : t('syncEnable') }}
                    </a-button>
                  </div>
                  <p class="settings-note">{{ t('syncHint') }}</p>
                  <div v-if="visibleConnectedPanes.length > 0" class="settings-sync-list" :aria-label="t('syncInput')">
                    <button
                      v-for="pane in visibleConnectedPanes"
                      :key="pane.id"
                      class="sync-chip"
                      :class="{ selected: syncedPaneIds.includes(pane.id) }"
                      type="button"
                      @click="toggleSyncPane(pane.id)"
                    >
                      <span class="sync-check">{{ syncedPaneIds.includes(pane.id) ? 'on' : '' }}</span>
                      <span class="sync-chip-text">
                        <strong>{{ pane.title }}</strong>
                        <small>{{ pane.connection?.host }}</small>
                      </span>
                    </button>
                  </div>
                  <p v-else class="settings-note">{{ t('noConnectedSessions') }}</p>
                </div>
              </template>
              <a-button
                class="toolbar-sync-trigger"
                :type="syncInputEnabled ? 'primary' : 'default'"
                :icon="h(SyncOutlined)"
                :aria-label="t('syncInput')"
                :title="t('syncInput')"
              />
            </a-popover>
          </a-tooltip>
        </div>

      </header>

      <div class="terminal-grid" :class="`grid-${visiblePanes.length}`">
        <TerminalPane
          v-for="pane in visiblePanes"
          :key="pane.id"
          :ref="(component) => setTerminalRef(pane.id, component as InstanceType<typeof TerminalPane> | null)"
          :pane="pane"
          :active="pane.id === activePaneId"
          :app-theme="appTheme"
          @focus="activePaneId = $event"
          @disconnect="disconnectPaneById"
          @close="closePane"
          @connect="connectFromPane"
          @input="handleTerminalInput"
          @zmodem="handlePaneZmodemState"
          @authenticated="handlePaneAuthenticated"
          @disconnected="handleDisconnected"
        />
      </div>
    </section>

    <a-modal
      v-model:open="settingsModalOpen"
      :title="t('settingsTitle')"
      width="560px"
      class="settings-modal"
      :footer="null"
    >
      <div class="settings-panel">
        <section class="settings-card">
          <div class="settings-card-header">
            <div>
              <strong>{{ t('themeSettings') }}</strong>
              <span>{{ t('currentTheme', getThemeTitle(activeAppTheme)) }}</span>
            </div>
            <small>{{ t('applyImmediatelyAndPersist') }}</small>
          </div>

          <div class="theme-grid" :aria-label="t('themeSettings')">
            <button
              v-for="theme in appThemes"
              :key="theme.id"
              class="theme-card"
              :class="{ active: appTheme === theme.id }"
              type="button"
              :aria-pressed="appTheme === theme.id"
              @click="setAppTheme(theme.id)"
            >
              <span class="theme-preview" aria-hidden="true">
                <i v-for="(color, index) in theme.preview" :key="`${theme.id}-${index}`" :style="{ background: color }" />
              </span>
              <strong>{{ getThemeTitle(theme) }}</strong>
              <small>{{ getThemeDescription(theme) }}</small>
            </button>
          </div>

          <p class="settings-note">{{ t('themeHint') }}</p>
        </section>

        <section class="settings-card">
          <div class="settings-card-header">
            <div>
              <strong>{{ t('languageSettings') }}</strong>
              <span>{{ t('currentLanguage', currentLanguageLabel) }}</span>
            </div>
            <small>{{ t('applyImmediatelyAndPersist') }}</small>
          </div>

          <a-segmented :value="appLocale" :options="languageOptions" block @change="setAppLocale" />

          <p class="settings-note">{{ t('languageHint') }}</p>
        </section>

        <section class="settings-card">
          <div class="settings-card-header">
            <div>
              <strong>{{ t('windowCloseSettings') }}</strong>
              <span>{{ t('currentWindowCloseBehavior', currentWindowCloseBehaviorLabel) }}</span>
            </div>
            <small>{{ t('applyImmediatelyAndPersist') }}</small>
          </div>

          <a-segmented
            :value="windowCloseBehavior"
            :options="closeBehaviorOptions"
            block
            @change="setWindowCloseBehaviorValue"
          />

          <p class="settings-note">{{ t('windowCloseBehaviorHint') }}</p>
        </section>
      </div>
    </a-modal>

    <a-modal
      v-model:open="connectionModalOpen"
      :title="connectionForm.id ? t('connectionEditTitle') : t('connectionNewTitle')"
      width="640px"
      class="connection-modal"
      :destroy-on-close="false"
      @ok="saveConnection"
    >
      <template #footer>
        <div class="connection-modal-footer">
          <a-button :loading="testingConnection" @click="testConnection">{{ t('testConnection') }}</a-button>
          <span>
            <a-button @click="connectionModalOpen = false">{{ t('cancel') }}</a-button>
            <a-button type="primary" @click="saveConnection">{{ t('confirm') }}</a-button>
          </span>
        </div>
      </template>
      <a-form layout="vertical" class="connection-form">
        <div class="connection-form-grid primary">
          <a-form-item :label="t('nameLabel')" required>
            <a-input v-model:value="connectionForm.name" :placeholder="t('connectionNamePlaceholder')" />
          </a-form-item>
          <a-form-item :label="t('hostLabel')" required>
            <a-input v-model:value="connectionForm.host" :placeholder="t('hostPlaceholder')" />
          </a-form-item>
          <a-form-item :label="t('portLabel')">
            <a-input-number v-model:value="connectionForm.port" :min="1" :max="65535" />
          </a-form-item>
        </div>
        <div class="connection-form-grid secondary">
          <a-form-item :label="t('usernameLabel')" required>
            <a-input v-model:value="connectionForm.username" :placeholder="t('usernamePlaceholder')" />
          </a-form-item>
          <a-form-item :label="t('groupLabel')">
            <a-select v-model:value="connectionForm.group_id" :options="groupOptions" />
          </a-form-item>
          <a-form-item :label="t('passwordLabel')">
            <a-input-password v-model:value="connectionForm.password" autocomplete="current-password" />
          </a-form-item>
        </div>

        <div class="auth-panel">
          <div class="auth-panel-title">{{ t('keyAuthTitle') }}</div>
          <div class="connection-form-grid key-fields">
            <a-form-item :label="t('privateKeyPathLabel')">
              <a-input v-model:value="connectionForm.private_key_path" :placeholder="t('privateKeyPathPlaceholder')" />
            </a-form-item>
            <a-form-item :label="t('privateKeyPassphraseLabel')">
              <a-input-password
                v-model:value="connectionForm.private_key_passphrase"
                autocomplete="current-password"
              />
            </a-form-item>
          </div>
          <a-form-item :label="t('pastePrivateKeyLabel')" class="private-key-field">
            <a-textarea
              v-model:value="connectionForm.private_key"
              :auto-size="{ minRows: 3, maxRows: 5 }"
              :placeholder="t('privateKeyPlaceholder')"
            />
          </a-form-item>
        </div>
      </a-form>
    </a-modal>

    <a-modal
      v-model:open="groupModalOpen"
      :title="groupForm.id ? t('groupRenameTitle') : t('groupNewTitle')"
      width="420px"
      class="group-modal"
      :destroy-on-close="false"
      :ok-text="t('confirm')"
      :cancel-text="t('cancel')"
      @ok="saveGroup"
    >
      <a-form layout="vertical" class="connection-form">
        <a-form-item :label="t('groupNameLabel')" required>
          <a-input v-model:value="groupForm.name" :placeholder="t('groupNamePlaceholder')" />
        </a-form-item>
      </a-form>
    </a-modal>
  </main>
</template>
