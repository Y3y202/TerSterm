<script setup lang="ts">
import { computed, h, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import {
  AppstoreOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  RightOutlined,
  SaveOutlined,
  SearchOutlined,
} from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import TerminalPane from './components/TerminalPane.vue'
import { sshConnect, sshDisconnect, sshTestConnection } from './bridge'
import type { ConnectionGroup, ConnectionProfile, SshPane } from './types'

const CONNECTION_STORAGE_KEY = 'tersterm.connections'
const GROUP_STORAGE_KEY = 'tersterm.groups'
const SIDEBAR_WIDTH_STORAGE_KEY = 'tersterm.sidebarWidth'
const DEFAULT_GROUP_ID = 'default'
const DEFAULT_GROUP_NAME = '默认'
const MAX_PANES = 4
const MIN_SIDEBAR_WIDTH = 240
const MAX_SIDEBAR_WIDTH = 520

type ConnectionDraft = Omit<ConnectionProfile, 'id'> & { id?: string }
type DeepLinkUnlisten = () => void

const createId = (prefix: string) => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const groupIdFromName = (name: string) => {
  const normalized = name.trim()
  if (!normalized || normalized === DEFAULT_GROUP_NAME) return DEFAULT_GROUP_ID
  return `group-${normalized.toLowerCase().replace(/\s+/g, '-')}`
}

const defaultGroup = (): ConnectionGroup => ({
  id: DEFAULT_GROUP_ID,
  name: DEFAULT_GROUP_NAME,
  expanded: true,
})

const createPane = (index: number): SshPane => ({
  id: createId('pane'),
  title: `终端 ${index + 1}`,
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
  ;[defaultGroup(), ...storedGroups].forEach((group) => {
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

  return Array.from(byId.values())
}

const normalizeConnections = (
  rawConnections: ConnectionProfile[],
  availableGroups: ConnectionGroup[],
): ConnectionProfile[] => {
  const knownGroupIds = new Set(availableGroups.map((group) => group.id))

  return rawConnections.map((connection) => {
    const legacyGroupId = groupIdFromName(connection.group || '')
    const group_id = knownGroupIds.has(connection.group_id || '')
      ? connection.group_id
      : knownGroupIds.has(legacyGroupId)
        ? legacyGroupId
        : DEFAULT_GROUP_ID

    return {
      ...connection,
      port: Number(connection.port || 22),
      group_id,
      group: undefined,
    }
  })
}

const rawConnections = readRawConnections()
const groups = ref<ConnectionGroup[]>(readStoredGroups(rawConnections))
const connections = ref<ConnectionProfile[]>(normalizeConnections(rawConnections, groups.value))
const panes = ref<SshPane[]>([createPane(0)])
const activePaneId = ref(panes.value[0].id)
const searchText = ref('')
const connectionModalOpen = ref(false)
const groupModalOpen = ref(false)
const testingConnection = ref(false)
const sidebarWidth = ref(
  Math.min(
    MAX_SIDEBAR_WIDTH,
    Math.max(MIN_SIDEBAR_WIDTH, Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)) || 292),
  ),
)
const resizingSidebar = ref(false)
const selectedConnectionId = ref<string>()
const terminalRefs = ref<Record<string, InstanceType<typeof TerminalPane>>>({})
let unlistenDeepLink: DeepLinkUnlisten | undefined

const connectionForm = reactive<ConnectionDraft>({
  name: '',
  host: '',
  port: 22,
  username: '',
  password: '',
  private_key_path: '',
  private_key: '',
  private_key_passphrase: '',
  group_id: DEFAULT_GROUP_ID,
})

const groupForm = reactive({
  id: '',
  name: '',
})

const splitLayouts = [
  { count: 1, title: '单屏', icon: 'single' },
  { count: 2, title: '双屏', icon: 'dual' },
  { count: 3, title: '主副三屏', icon: 'triple' },
  { count: 4, title: '四分屏', icon: 'quad' },
]

const activePane = computed(() => panes.value.find((pane) => pane.id === activePaneId.value))

const groupOptions = computed(() =>
  groups.value.map((group) => ({
    label: group.name,
    value: group.id,
  })),
)

const groupNameById = computed(() => {
  const names = new Map<string, string>()
  groups.value.forEach((group) => names.set(group.id, group.name))
  return names
})

const filteredConnections = computed(() => {
  const query = searchText.value.trim().toLowerCase()
  if (!query) return connections.value

  return connections.value.filter((connection) =>
    [
      connection.name,
      connection.host,
      connection.username,
      groupNameById.value.get(connection.group_id || DEFAULT_GROUP_ID),
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
        (connection) => (connection.group_id || DEFAULT_GROUP_ID) === group.id,
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

const setTerminalRef = (paneId: string, component: InstanceType<typeof TerminalPane> | null) => {
  if (!component) {
    delete terminalRefs.value[paneId]
    return
  }

  terminalRefs.value[paneId] = component
}

const clampSidebarWidth = (width: number) =>
  Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width))

const fitAllTerminals = () => {
  requestAnimationFrame(() => {
    Object.values(terminalRefs.value).forEach((terminal) => terminal?.fitTerminal())
  })
}

const startSidebarResize = (event: PointerEvent) => {
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
  if (nextCount === panes.value.length) return

  if (nextCount < panes.value.length) {
    const removed = panes.value.slice(nextCount)
    await Promise.all(
      removed.map((pane) => (pane.session_id ? sshDisconnect(pane.session_id) : null)),
    )
    panes.value = panes.value.slice(0, nextCount)
    if (!panes.value.some((pane) => pane.id === activePaneId.value)) {
      activePaneId.value = panes.value[0].id
    }
    return
  }

  const start = panes.value.length
  panes.value = [
    ...panes.value,
    ...Array.from({ length: nextCount - panes.value.length }, (_, index) =>
      createPane(start + index),
    ),
  ]

  await nextTick()
  panes.value.forEach((pane) => terminalRefs.value[pane.id]?.fitTerminal())
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
  connectionForm.group_id = connection?.group_id || DEFAULT_GROUP_ID
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
    message.warning('请填写名称、主机和用户名')
    return undefined
  }

  const group_id = groups.value.some((group) => group.id === connectionForm.group_id)
    ? connectionForm.group_id
    : DEFAULT_GROUP_ID

  return {
    id: connectionForm.id || createId('connection'),
    name: connectionForm.name.trim(),
    host: connectionForm.host.trim(),
    port: Number(connectionForm.port || 22),
    username: connectionForm.username.trim(),
    password: connectionForm.password?.trim() || undefined,
    private_key_path: connectionForm.private_key_path?.trim() || undefined,
    private_key: connectionForm.private_key?.trim() || undefined,
    private_key_passphrase: connectionForm.private_key_passphrase?.trim() || undefined,
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
  message.success('已保存连接')
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
  if (!groupName) return DEFAULT_GROUP_ID

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
    message.warning('Quick session link needs host and username')
    return undefined
  }

  const port = Number(readUrlValue(url, ['port']) || url.port || 22)
  const name = readUrlValue(url, ['name', 'title']) || `${username}@${host}`
  const groupValue = readUrlValue(url, ['group', 'group_id', 'folder'])
  const group_id = groupValue ? groupIdFromDeepLink(groupValue) : DEFAULT_GROUP_ID
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
      message.success(`Saved quick session: ${profile.name}`)
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
    message.success('测试连接成功')
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    testingConnection.value = false
  }
}

const openGroupModal = (group?: ConnectionGroup) => {
  groupForm.id = group?.id || ''
  groupForm.name = group?.name || ''
  groupModalOpen.value = true
}

const saveGroup = () => {
  const name = groupForm.name.trim()
  if (!name) {
    message.warning('请填写分组名称')
    return
  }

  const duplicate = groups.value.some(
    (group) => group.name === name && group.id !== groupForm.id,
  )
  if (duplicate) {
    message.warning('分组名称已存在')
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
  message.success('已保存分组')
}

const deleteGroup = (group: ConnectionGroup) => {
  if (group.id === DEFAULT_GROUP_ID) {
    message.warning('默认分组不能删除')
    return
  }

  connections.value = connections.value.map((connection) =>
    connection.group_id === group.id
      ? {
          ...connection,
          group_id: DEFAULT_GROUP_ID,
        }
      : connection,
  )
  groups.value = groups.value.filter((item) => item.id !== group.id)

  panes.value.forEach((pane) => {
    if (pane.connection?.group_id === group.id) {
      pane.connection = {
        ...pane.connection,
        group_id: DEFAULT_GROUP_ID,
      }
    }
  })

  message.success('已删除分组，连接已移到默认分组')
}

const deleteConnection = async (connection: ConnectionProfile) => {
  connections.value = connections.value.filter((item) => item.id !== connection.id)
  if (selectedConnectionId.value === connection.id) {
    selectedConnectionId.value = undefined
  }

  for (const pane of panes.value) {
    if (pane.connection?.id !== connection.id) continue
    if (pane.session_id) {
      await sshDisconnect(pane.session_id)
    }
    Object.assign(pane, {
      title: '终端',
      status: 'idle',
      session_id: undefined,
      connection: undefined,
      error: undefined,
    })
  }
}

const disconnectPane = async (pane: SshPane) => {
  if (pane.session_id) {
    await sshDisconnect(pane.session_id)
  }

  Object.assign(pane, {
    title: pane.connection?.name || pane.title,
    status: 'closed',
    session_id: undefined,
    error: undefined,
  })
}

const closePane = async (paneId: string) => {
  const pane = panes.value.find((item) => item.id === paneId)
  if (!pane) return

  await disconnectPane(pane)
  Object.assign(pane, {
    title: `终端 ${panes.value.findIndex((item) => item.id === paneId) + 1}`,
    status: 'idle',
    connection: undefined,
  })
}

const openConnectionInPane = async (connection: ConnectionProfile, paneId = activePaneId.value) => {
  const pane = panes.value.find((item) => item.id === paneId) || panes.value[0]
  activePaneId.value = pane.id
  selectedConnectionId.value = connection.id

  if (pane.session_id) {
    await sshDisconnect(pane.session_id)
  }

  Object.assign(pane, {
    title: connection.name,
    status: 'connecting',
    connection,
    session_id: undefined,
    error: undefined,
  })

  try {
    const session_id = createId('session')
    pane.session_id = session_id
    await sshConnect(connection, session_id)
    if (pane.session_id === session_id && pane.status === 'connecting') {
      Object.assign(pane, {
        status: 'connected',
        error: undefined,
      })
    }
    await nextTick()
    terminalRefs.value[pane.id]?.fitTerminal()
  } catch (error) {
    Object.assign(pane, {
      session_id: undefined,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
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
    status: 'closed',
    session_id: undefined,
    error: reason,
  })
}

onMounted(async () => {
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
  unlistenDeepLink?.()
  void Promise.all(panes.value.map((pane) => (pane.session_id ? sshDisconnect(pane.session_id) : null)))
})
</script>

<template>
  <main
    class="app-shell"
    :class="{ 'is-resizing-sidebar': resizingSidebar }"
    :style="{ '--sidebar-width': `${sidebarWidth}px` }"
  >
    <aside class="sidebar">
      <div class="brand-row">
        <div class="brand-mark">TS</div>
        <div>
          <h1>TerSterm</h1>
          <span>SSH Manager</span>
        </div>
      </div>

      <a-input v-model:value="searchText" placeholder="搜索连接或分组" allow-clear>
        <template #prefix>
          <SearchOutlined />
        </template>
      </a-input>

      <div class="sidebar-actions">
        <a-button type="primary" :icon="h(PlusOutlined)" @click="openConnectionModal()">
          新建连接
        </a-button>
        <a-tooltip title="新建分组">
          <a-button :icon="h(FolderAddOutlined)" @click="openGroupModal()" />
        </a-tooltip>
      </div>

      <div class="connection-list">
        <a-empty v-if="connections.length === 0" description="暂无连接" />
        <a-empty v-else-if="filteredConnections.length === 0" description="没有匹配连接" />

        <section v-for="group in groupedConnections" :key="group.id" class="connection-group">
          <div class="group-title">
            <button class="group-toggle" type="button" @click="toggleGroup(group.id)">
              <RightOutlined :class="{ expanded: group.expanded }" />
              <FolderOpenOutlined />
              <span>{{ group.name }}</span>
              <small>{{ group.items.length }}</small>
            </button>
            <span class="group-actions">
              <a-tooltip title="添加连接">
                <a-button
                  type="text"
                  size="small"
                  :icon="h(PlusOutlined)"
                  @click.stop="openConnectionModal(undefined, group.id)"
                />
              </a-tooltip>
              <a-tooltip title="重命名">
                <a-button
                  type="text"
                  size="small"
                  :icon="h(EditOutlined)"
                  @click.stop="openGroupModal(group)"
                />
              </a-tooltip>
              <a-popconfirm
                title="删除后连接会移到默认分组"
                ok-text="删除"
                cancel-text="取消"
                @confirm="deleteGroup(group)"
              >
                <a-tooltip title="删除分组">
                  <a-button
                    type="text"
                    size="small"
                    danger
                    :disabled="group.id === DEFAULT_GROUP_ID"
                    :icon="h(DeleteOutlined)"
                    @click.stop
                  />
                </a-tooltip>
              </a-popconfirm>
            </span>
          </div>

          <div v-show="group.expanded" class="group-items">
            <button
              v-for="connection in group.items"
              :key="connection.id"
              class="connection-item"
              :class="{ selected: selectedConnectionId === connection.id }"
              @click="openConnectionInPane(connection)"
            >
              <span class="connection-main">
                <strong>{{ connection.name }}</strong>
                <small>{{ connection.username }}@{{ connection.host }}:{{ connection.port }}</small>
              </span>
              <span class="connection-actions">
                <a-tooltip title="编辑">
                  <a-button
                    type="text"
                    size="small"
                    :icon="h(EditOutlined)"
                    @click.stop="openConnectionModal(connection)"
                  />
                </a-tooltip>
                <a-tooltip title="删除">
                  <a-button
                    type="text"
                    size="small"
                    danger
                    :icon="h(DeleteOutlined)"
                    @click.stop="deleteConnection(connection)"
                  />
                </a-tooltip>
              </span>
            </button>

            <button
              v-if="group.items.length === 0 && !searchText"
              class="empty-group-action"
              type="button"
              @click="openConnectionModal(undefined, group.id)"
            >
              <PlusOutlined />
              <span>添加连接</span>
            </button>
          </div>
        </section>
      </div>
    </aside>
    <div class="sidebar-resizer" role="separator" aria-label="调整侧边栏宽度" @pointerdown="startSidebarResize" />

    <section class="workspace">
      <header class="workspace-toolbar">
        <div class="toolbar-title">
          <AppstoreOutlined />
          <div>
            <strong>工作台</strong>
            <span>{{ activePane?.title || '终端' }}</span>
          </div>
        </div>

        <div class="toolbar-actions">
          <div class="split-layouts" aria-label="分屏布局">
            <a-tooltip v-for="layout in splitLayouts" :key="layout.count" :title="layout.title">
              <button
                class="split-layout-button"
                :class="{ active: panes.length === layout.count }"
                type="button"
                :aria-label="layout.title"
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
          <a-button :icon="h(SaveOutlined)" @click="openConnectionModal()">
            保存连接
          </a-button>
        </div>
      </header>

      <div class="terminal-grid" :class="`grid-${panes.length}`">
        <TerminalPane
          v-for="pane in panes"
          :key="pane.id"
          :ref="(component) => setTerminalRef(pane.id, component as InstanceType<typeof TerminalPane> | null)"
          :pane="pane"
          :active="pane.id === activePaneId"
          @focus="activePaneId = $event"
          @close="closePane"
          @connect="connectFromPane"
          @disconnected="handleDisconnected"
        />
      </div>
    </section>

    <a-modal
      v-model:open="connectionModalOpen"
      :title="connectionForm.id ? '编辑连接' : '新建连接'"
      width="640px"
      class="connection-modal"
      :destroy-on-close="false"
      @ok="saveConnection"
    >
      <template #footer>
        <div class="connection-modal-footer">
          <a-button :loading="testingConnection" @click="testConnection">测试连接</a-button>
          <span>
            <a-button @click="connectionModalOpen = false">取消</a-button>
            <a-button type="primary" @click="saveConnection">确定</a-button>
          </span>
        </div>
      </template>
      <a-form layout="vertical" class="connection-form">
        <div class="connection-form-grid primary">
          <a-form-item label="名称" required>
            <a-input v-model:value="connectionForm.name" placeholder="Production" />
          </a-form-item>
          <a-form-item label="主机" required>
            <a-input v-model:value="connectionForm.host" placeholder="192.168.1.10" />
          </a-form-item>
          <a-form-item label="端口">
            <a-input-number v-model:value="connectionForm.port" :min="1" :max="65535" />
          </a-form-item>
        </div>
        <div class="connection-form-grid secondary">
          <a-form-item label="用户名" required>
            <a-input v-model:value="connectionForm.username" placeholder="root" />
          </a-form-item>
          <a-form-item label="分组">
            <a-select v-model:value="connectionForm.group_id" :options="groupOptions" />
          </a-form-item>
          <a-form-item label="密码">
            <a-input-password v-model:value="connectionForm.password" autocomplete="current-password" />
          </a-form-item>
        </div>

        <div class="auth-panel">
          <div class="auth-panel-title">密钥认证</div>
          <div class="connection-form-grid key-fields">
            <a-form-item label="私钥路径">
              <a-input v-model:value="connectionForm.private_key_path" placeholder="C:\\Users\\me\\.ssh\\id_rsa" />
            </a-form-item>
            <a-form-item label="证书密码">
              <a-input-password
                v-model:value="connectionForm.private_key_passphrase"
                autocomplete="current-password"
              />
            </a-form-item>
          </div>
          <a-form-item label="粘贴私钥" class="private-key-field">
            <a-textarea
              v-model:value="connectionForm.private_key"
              :auto-size="{ minRows: 3, maxRows: 5 }"
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            />
          </a-form-item>
        </div>
      </a-form>
    </a-modal>

    <a-modal
      v-model:open="groupModalOpen"
      :title="groupForm.id ? '重命名分组' : '新建分组'"
      width="420px"
      :destroy-on-close="false"
      @ok="saveGroup"
    >
      <a-form layout="vertical" class="connection-form">
        <a-form-item label="分组名称" required>
          <a-input v-model:value="groupForm.name" placeholder="生产环境" />
        </a-form-item>
      </a-form>
    </a-modal>
  </main>
</template>
