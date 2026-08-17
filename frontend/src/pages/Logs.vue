<template>
  <div class="dashboard-page">
    <div class="dashboard-shell">
      <header class="dashboard-header">
        <div><h1 class="dashboard-title">{{ t('logs.title') }}</h1><p class="dashboard-subtitle">实时查看系统运行日志，支持级别和标签过滤。</p></div>
        <div class="dashboard-header-actions">
          <span class="dashboard-pill" :class="`connection-${connState}`"><span class="status-dot" />{{ connText }}</span>
          <v-btn variant="tonal" icon="mdi-close-box-outline" :aria-label="t('logs.clear')" :title="t('logs.clear')" @click="clearView" />
        </div>
      </header>

      <section class="dashboard-card log-toolbar mb-4">
        <div class="log-toolbar-inner">
          <div class="log-filters">
            <v-chip size="small" :variant="activeLevels.size === levels.length ? 'flat' : 'tonal'" @click="setAllLevels">{{ t('logs.all') }}</v-chip>
            <v-chip v-for="lv in levels" :key="lv.value" size="small" :color="activeLevels.has(lv.value) ? lv.color : undefined" :variant="activeLevels.has(lv.value) ? 'flat' : 'outlined'" @click="toggleLevel(lv.value)">{{ lv.label }}</v-chip>
          </div>
          <div class="log-actions">
            <v-text-field v-model="tagFilter" :label="t('logs.tagFilter')" density="compact" hide-details clearable prepend-inner-icon="mdi-magnify" class="log-search" />
            <v-btn variant="tonal" :color="paused ? 'success' : 'warning'" size="small" @click="paused = !paused">{{ paused ? t('logs.resume') : t('logs.pause') }}</v-btn>
            <v-switch v-model="autoScroll" :label="t('logs.autoScroll')" density="compact" hide-details />
          </div>
        </div>
      </section>

      <section class="dashboard-card log-card">
        <div ref="listEl" class="dashboard-scrollable log-list">
          <div v-for="(log, i) in filteredLogs" :key="i" class="log-row font-mono">
            <span class="text-medium-emphasis">{{ log.time }}</span>
            <span class="log-level" :class="`log-level--${log.level}`">{{ log.level }}</span>
            <span class="log-tag">[{{ log.tag }}]</span>
            <span class="log-message">{{ log.msg }}<template v-if="log.fields"><span v-for="(fv, fk) in log.fields" :key="fk" class="text-medium-emphasis">&nbsp;{{ fk }}={{ fv }}</span></template></span>
          </div>
          <div v-if="!filteredLogs.length" class="dashboard-empty">{{ t('logs.empty') }}</div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { LogStream } from '@/api/logs'
import type { LogLevel, LogRecord } from '@/api/types'

const { t } = useI18n()

const logs = ref<LogRecord[]>([])
const pending = ref<LogRecord[]>([])
const paused = ref(false)
const autoScroll = ref(true)
const tagFilter = ref('')
const activeLevels = ref<Set<LogLevel>>(new Set(['debug', 'info', 'warn', 'error']))
const connState = ref<'connecting' | 'open' | 'closed'>('connecting')
const listEl = ref<HTMLElement | null>(null)

const MAX_LOGS = 1000

const levels: { value: LogLevel; label: string; color: string }[] = [
  { value: 'debug', label: 'debug', color: 'blue-grey' },
  { value: 'info', label: 'info', color: 'info' },
  { value: 'warn', label: 'warn', color: 'warning' },
  { value: 'error', label: 'error', color: 'error' },
]

const connText = computed(() => {
  switch (connState.value) {
    case 'open':
      return t('logs.connected')
    case 'connecting':
      return t('logs.connecting')
    default:
      return t('logs.disconnected')
  }
})

// 客户端侧过滤：级别 + tag 子串（同时匹配 tag 与 msg）
const filteredLogs = computed(() => {
  const tag = tagFilter.value.trim().toLowerCase()
  return logs.value.filter((log) => {
    if (!activeLevels.value.has(log.level)) return false
    if (tag) {
      const hay = `${log.tag} ${log.msg}`.toLowerCase()
      if (!hay.includes(tag)) return false
    }
    return true
  })
})

function toggleLevel(level: LogLevel): void {
  const set = new Set(activeLevels.value)
  if (set.has(level)) set.delete(level)
  else set.add(level)
  activeLevels.value = set
}

function setAllLevels(): void {
  activeLevels.value = new Set(['debug', 'info', 'warn', 'error'])
}

function appendRecords(records: LogRecord[]): void {
  if (paused.value) {
    pending.value.push(...records)
  } else {
    logs.value.push(...records)
    if (logs.value.length > MAX_LOGS) {
      logs.value.splice(0, logs.value.length - MAX_LOGS)
    }
  }
  scrollToBottom()
}

function onLog(record: LogRecord): void {
  appendRecords([record])
}

function clearView(): void {
  logs.value = []
  pending.value = []
}

function scrollToBottom(): void {
  if (autoScroll.value) {
    requestAnimationFrame(() => {
      if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
    })
  }
}

// 从暂停恢复时，把积压的日志补进视图
watch(paused, (val) => {
  if (!val && pending.value.length) {
    appendRecords(pending.value.splice(0))
  }
})

let stream: LogStream | null = null

onMounted(() => {
  stream = new LogStream()
  stream.onSnapshot = (records) => {
    logs.value = records
    scrollToBottom()
  }
  stream.onLog = onLog
  stream.onStateChange = (s) => {
    connState.value = s
  }
  stream.connect()
})

onBeforeUnmount(() => {
  stream?.close()
  stream = null
})
</script>

<style scoped>
.log-toolbar { padding: 14px 18px; }
.log-toolbar-inner, .log-filters, .log-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.log-toolbar-inner { justify-content: space-between; }
.log-search { width: 220px; }
.log-card { overflow: hidden; }
.log-list { max-height: calc(100vh - 300px); padding: 8px 18px; }
.log-row { display: grid; grid-template-columns: 155px 52px 120px minmax(0, 1fr); gap: 8px; padding: 9px 0; border-bottom: 1px solid var(--dashboard-border); font-size: 0.78rem; line-height: 1.5; }
.log-row:last-child { border-bottom: 0; }
.log-level { font-weight: 700; text-transform: uppercase; }
.log-level--debug { color: rgb(var(--v-theme-secondary)); }
.log-level--info { color: rgb(var(--v-theme-info)); }
.log-level--warn { color: rgb(var(--v-theme-warning)); }
.log-level--error { color: rgb(var(--v-theme-error)); }
.log-tag { color: rgb(var(--v-theme-primary)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-message { min-width: 0; overflow-wrap: anywhere; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.connection-open { color: rgb(var(--v-theme-success)); }
.connection-connecting { color: rgb(var(--v-theme-warning)); }
.connection-closed { color: rgb(var(--v-theme-error)); }
@media (max-width: 760px) {
  .log-search { width: 100%; }
  .log-actions { width: 100%; }
  .log-row { grid-template-columns: auto 52px minmax(0, 1fr); }
  .log-tag { display: none; }
}
</style>
