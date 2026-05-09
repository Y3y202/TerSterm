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
import { message } from 'ant-design-vue'
import {
  onSshData,
  onSshDisconnected,
  sshDownloadFile,
  sshListFiles,
  sshResize,
  sshUploadFile,
  sshWrite,
} from '../bridge'
import type { RemoteFileEntry, SshPane } from '../types'

const props = defineProps<{
  pane: SshPane
  active: boolean
}>()

const emit = defineEmits<{
  focus: [paneId: string]
  close: [paneId: string]
  connect: [paneId: string]
  disconnected: [payload: { pane_id: string; session_id: string; reason?: string }]
}>()

const terminalHost = ref<HTMLDivElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const fileManagerOpen = ref(false)
const remotePath = ref('~')
const remoteFiles = ref<RemoteFileEntry[]>([])
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

const isConnected = computed(() => props.pane.status === 'connected' && !!props.pane.session_id)
const statusText = computed(() => {
  if (props.pane.status === 'connecting') return '连接中'
  if (props.pane.status === 'connected') return '已连接'
  if (props.pane.status === 'error') return '错误'
  if (props.pane.status === 'closed') return '已关闭'
  return '未连接'
})

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

const closePane = () => {
  emit('close', props.pane.id)
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

const refreshFiles = async (path = remotePath.value) => {
  if (!props.pane.connection || !isConnected.value) return
  const requestId = ++refreshRequestId

  fileLoading.value = true
  try {
    const result = await sshListFiles(props.pane.connection, path)
    if (requestId !== refreshRequestId) return
    remotePath.value = result.path
    remoteFiles.value = result.entries
  } catch (error) {
    if (requestId !== refreshRequestId) return
    message.error(error instanceof Error ? error.message : String(error))
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
  fileManagerOpen.value = !fileManagerOpen.value
  if (fileManagerOpen.value && remoteFiles.value.length === 0) {
    await refreshFiles()
  }
}

const enterDirectory = async (entry: RemoteFileEntry) => {
  if (entry.kind !== 'directory') return
  await refreshFiles(entry.path)
}

const uploadFiles = async (files: File[]) => {
  if (!props.pane.connection || !isConnected.value || files.length === 0) return

  transferring.value = true
  try {
    for (const file of files) {
      const content = await fileToBase64(file)
      await sshUploadFile(props.pane.connection, remotePath.value, file.name, content)
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
  fileInput.value?.click()
}

const handleFileInput = (event: Event) => {
  const input = event.target as HTMLInputElement
  void uploadFiles(Array.from(input.files || []))
}

const downloadFile = async (entry: RemoteFileEntry) => {
  if (!props.pane.connection || entry.kind === 'directory') return

  transferring.value = true
  try {
    const localPath = await sshDownloadFile(props.pane.connection, entry.path)
    message.success(`已下载到 ${localPath}`)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    transferring.value = false
  }
}

const handleDragOver = () => {
  if (!isConnected.value) return
  dragActive.value = true
}

const handleDragLeave = (event: DragEvent) => {
  if (!terminalHost.value?.contains(event.relatedTarget as Node | null)) {
    dragActive.value = false
  }
}

const handleDrop = async (event: DragEvent) => {
  dragActive.value = false
  const files = Array.from(event.dataTransfer?.files || [])
  if (files.length === 0) return
  fileManagerOpen.value = true
  await uploadFiles(files)
}

watch(
  () => props.pane.status,
  (status) => {
    if (!terminal) return

    if (status === 'connecting' && props.pane.connection) {
      resetTerminal(`Connecting to ${props.pane.connection.name} (${props.pane.connection.host}) ...`)
    }

    if (status === 'idle') {
      resetTerminal()
      remotePath.value = '~'
      remoteFiles.value = []
      fileManagerOpen.value = false
    }

    if (status === 'error' && props.pane.error) {
      terminal.writeln(`\r\n${props.pane.error}`)
    }
  },
)

watch(
  () => props.pane.session_id,
  async (session_id) => {
    if (!session_id) return
    remotePath.value = '~'
    remoteFiles.value = []
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
    fontSize: 13,
    lineHeight: 1.15,
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

  terminal.onData((data) => {
    if (!props.pane.session_id || props.pane.status !== 'connected') return
    trackShellInput(data)
    void sshWrite(props.pane.session_id, data)
  })

  resizeObserver = new ResizeObserver(() => fitTerminal())
  resizeObserver.observe(terminalHost.value!)

  unlistenData = await onSshData(({ session_id, data }) => {
    if (session_id !== props.pane.session_id) return
    trackOscCurrentDirectory(data)
    trackPromptCurrentDirectory(data)
    terminal?.write(data)
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
  if (refreshTimer) {
    window.clearTimeout(refreshTimer)
  }
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
    @dragover.prevent="handleDragOver"
    @dragleave="handleDragLeave"
    @drop.prevent="handleDrop"
  >
    <header class="pane-header">
      <div class="pane-title">
        <span class="status-dot" :class="pane.status" />
        <div>
          <strong>{{ pane.title }}</strong>
          <span>{{ statusText }}</span>
        </div>
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
            @click.stop="closePane"
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
        <div v-if="!fileLoading && remoteFiles.length === 0" class="file-empty">目录为空</div>
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
