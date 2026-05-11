<script setup lang="ts">
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
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
  onSshData,
  onSshDisconnected,
  sshDownloadFile,
  sshListFiles,
  sshResize,
  sshUploadFile,
} from '../bridge'
import type { RemoteFileEntry, SshPane } from '../types'

const props = defineProps<{
  pane: SshPane
  active: boolean
}>()

const emit = defineEmits<{
  focus: [paneId: string]
  disconnect: [paneId: string]
  close: [paneId: string]
  connect: [paneId: string]
  input: [payload: { pane_id: string; data: string }]
  authenticated: [payload: { pane_id: string; session_id: string }]
  disconnected: [payload: { pane_id: string; session_id: string; reason?: string }]
}>()

const terminalHost = ref<HTMLDivElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const fileManagerOpen = ref(false)
const remotePath = ref('~')
const remoteFiles = ref<RemoteFileEntry[]>([])
const fileError = ref('')
const fileLoading = ref(false)
const transferring = ref(false)
const dragActive = ref(false)

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

const isConnected = computed(() => props.pane.status === 'connected' && !!props.pane.session_id)
const shouldSuppressConfiguredPassphrasePrompt = computed(
  () => props.pane.private_key_passphrase_origin === 'configured',
)

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
  if (!remoteFeaturesReady.value) return '等待认证完成后加载文件列表'
  if (fileLoading.value) return '正在加载文件列表...'
  if (fileError.value) return fileError.value
  return '目录为空'
})
const statusText = computed(() => {
  if (props.pane.status === 'connecting') return '连接中'
  if (props.pane.status === 'connected') return '已连接'
  if (props.pane.status === 'error') return '错误'
  if (props.pane.status === 'closed') return '已关闭'
  return '未连接'
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
    reader.onerror = () => reject(reader.error || new Error('Read file failed'))
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

  return `${files.length} 个文件`
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
    message.warning('请先连接主机')
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
    message.success(files.length === 1 ? '文件已上传' : `已上传 ${files.length} 个文件`)
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
    message.warning('请先完成认证后再上传文件')
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
    message.success(`已下载到 ${localPath}`)
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
    message.warning('请先连接主机')
    return
  }

  if (!remoteFeaturesReady.value) {
    message.warning('请先完成认证后再传输文件')
    return
  }

  const files = Array.from(event.dataTransfer?.files || [])
  if (files.length === 0) return

  const targetHost = props.pane.connection.name || props.pane.connection.host
  const targetPath = remotePath.value

  Modal.confirm({
    title: `上传到 ${targetHost}`,
    content: `是否将 ${describeUploadFiles(files)} 上传到 ${targetPath}？`,
    okText: '上传',
    cancelText: '取消',
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
      resetTerminal(`Connecting to ${props.pane.connection.name} (${props.pane.connection.host}) ...`)
    }

    if (status === 'idle') {
      resetTerminal()
      resetFileManagerState()
    }

    if (status === 'closed' || status === 'error') {
      resetFileManagerState()
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
    if (!session_id) return
    await nextTick()
    fitTerminal()
    terminal?.focus()
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
    theme: {
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
  })
  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(terminalHost.value!)
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

  unlistenData = await onSshData(({ session_id, data }) => {
    if (session_id !== props.pane.session_id) return
    const visibleData = shouldSuppressConfiguredPassphrasePrompt.value
      ? stripConfiguredPassphrasePrompt(data)
      : data
    trackAuthenticatedOutput(session_id, visibleData)
    trackOscCurrentDirectory(visibleData)
    trackPromptCurrentDirectory(visibleData)
    if (visibleData) {
      terminal?.write(visibleData)
    }
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
          内存 {{ formatGbPair(pane.system_usage.memory_used_gb, pane.system_usage.memory_total_gb) }}
        </span>
        <span v-if="pane.system_usage">
          存储 {{ formatGbPair(pane.system_usage.storage_used_gb, pane.system_usage.storage_total_gb) }}
        </span>
        <span
          v-if="!pane.system_usage && pane.system_usage_loading"
          title="正在读取远程资源占用"
        >
          资源加载中
        </span>
        <span v-else-if="!pane.system_usage && pane.system_usage_error" :title="pane.system_usage_error">
          资源错误
        </span>
        <span v-else-if="!pane.system_usage">资源 --</span>
      </div>
      <div class="pane-actions">
        <a-tooltip title="文件管理">
          <a-button
            type="text"
            size="small"
            :icon="h(FolderOpenOutlined)"
            :disabled="!isConnected"
            @click.stop="openFileManager"
          />
        </a-tooltip>
        <a-tooltip title="连接">
          <a-button
            type="text"
            size="small"
            :icon="h(LinkOutlined)"
            :disabled="pane.status === 'connecting'"
            @click.stop="emit('connect', pane.id)"
          />
        </a-tooltip>
        <a-tooltip title="断开">
          <a-button
            type="text"
            size="small"
            :icon="h(PoweroffOutlined)"
            :disabled="!isConnected"
            @click.stop="disconnectPane"
          />
        </a-tooltip>
        <a-tooltip title="关闭">
          <a-button
            type="text"
            size="small"
            :icon="h(CloseOutlined)"
            @click.stop="closePane"
          />
        </a-tooltip>
      </div>
    </header>

    <div v-if="fileManagerOpen" class="file-manager" @mousedown.stop>
      <div class="file-manager-toolbar">
        <a-input
          v-model:value="remotePath"
          size="small"
          :disabled="fileLoading || transferring"
          @press-enter="refreshFiles()"
        />
        <a-tooltip title="上一级">
          <a-button
            size="small"
            :icon="h(ArrowUpOutlined)"
            :disabled="fileLoading || transferring"
            @click="refreshFiles(`${remotePath}/..`)"
          />
        </a-tooltip>
        <a-tooltip title="刷新">
          <a-button
            size="small"
            :icon="h(ReloadOutlined)"
            :loading="fileLoading"
            @click="refreshFiles()"
          />
        </a-tooltip>
        <a-tooltip title="上传文件">
          <a-button
            size="small"
            :icon="h(UploadOutlined)"
            :loading="transferring"
            @click="chooseUploadFiles"
          />
        </a-tooltip>
        <input ref="fileInput" type="file" multiple hidden @change="handleFileInput" />
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
            <a-tooltip v-if="entry.kind !== 'directory'" title="下载">
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
      <span>拖放到 {{ remotePath }} 上传</span>
    </div>

    <div v-if="pane.status === 'idle'" class="pane-empty">
      <a-button type="primary" :icon="h(LinkOutlined)" @click.stop="emit('connect', pane.id)">
        连接主机
      </a-button>
    </div>
  </section>
</template>
