<script setup lang="ts">
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { CloseOutlined, LinkOutlined, PoweroffOutlined } from '@ant-design/icons-vue'
import { onSshData, onSshDisconnected, sshResize, sshWrite } from '../bridge'
import type { SshPane } from '../types'

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
let terminal: Terminal | undefined
let fitAddon: FitAddon | undefined
let resizeObserver: ResizeObserver | undefined
let unlistenData: (() => void) | undefined
let unlistenDisconnected: (() => void) | undefined

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

const resetTerminal = (message?: string) => {
  terminal?.reset()
  if (message) {
    terminal?.writeln(message)
  }
}

const closePane = () => {
  emit('close', props.pane.id)
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
    void sshWrite(props.pane.session_id, data)
  })

  resizeObserver = new ResizeObserver(() => fitTerminal())
  resizeObserver.observe(terminalHost.value!)

  unlistenData = await onSshData(({ session_id, data }) => {
    if (session_id !== props.pane.session_id) return
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
    :class="{ active, empty: pane.status === 'idle' }"
    @mousedown="focusPane"
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

    <div ref="terminalHost" class="terminal-host" />

    <div v-if="pane.status === 'idle'" class="pane-empty">
      <a-button type="primary" :icon="h(LinkOutlined)" @click.stop="emit('connect', pane.id)">
        连接主机
      </a-button>
    </div>
  </section>
</template>
