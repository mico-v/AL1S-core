<template>
  <div class="dashboard-page">
    <div class="dashboard-shell">
      <header class="dashboard-header">
        <div class="dashboard-header-main">
          <h1 class="dashboard-title">{{ t('dashboard.title') }}</h1>
          <p class="dashboard-subtitle">实时查看机器人连接状态、运行指标和最近活动。</p>
        </div>
        <div class="dashboard-header-actions">
          <span v-if="status?.restartRequired" class="dashboard-pill text-warning">
            <v-icon size="16">mdi-restart-alert</v-icon>{{ t('dashboard.restartRequired') }}
          </span>
          <v-btn variant="tonal" color="primary" prepend-icon="mdi-refresh" :loading="loading" @click="load">
            刷新
          </v-btn>
        </div>
      </header>

      <section class="dashboard-split-grid">
        <article class="dashboard-card dashboard-card--padded">
          <div class="dashboard-section-head mb-0">
            <div>
              <div class="dashboard-section-title">{{ t('dashboard.status') }}</div>
              <div class="dashboard-section-subtitle">当前连接与会话概览</div>
            </div>
            <v-icon :color="status?.connected ? 'success' : 'error'" size="30">
              {{ status?.connected ? 'mdi-cloud-check-outline' : 'mdi-cloud-alert-outline' }}
            </v-icon>
          </div>
          <div class="d-flex align-center mt-4">
            <span class="status-dot mr-2" :class="status?.connected ? 'is-online' : 'is-offline'" />
            <span :class="status?.connected ? 'text-success' : 'text-error'">
              {{ status?.connected ? t('dashboard.connected') : t('dashboard.disconnected') }}
            </span>
          </div>
          <div class="dashboard-meta-list">
            <div class="dashboard-meta-row"><span>{{ t('dashboard.loginName') }}</span><strong>{{ loginNameText }}</strong></div>
            <div class="dashboard-meta-row"><span>{{ t('dashboard.uptime') }}</span><strong>{{ uptimeText }}</strong></div>
            <div class="dashboard-meta-row"><span>{{ t('dashboard.sessions') }}</span><strong>{{ status?.sessionCount ?? '—' }}</strong></div>
            <div class="dashboard-meta-row"><span>{{ t('dashboard.version') }}</span><strong class="font-mono">{{ status?.version ?? '—' }}</strong></div>
          </div>
        </article>

        <div class="dashboard-overview-grid dashboard-overview-grid--metrics">
          <article v-for="m in metricCards" :key="m.key" class="dashboard-card dashboard-overview-card">
            <div class="dashboard-card-icon"><v-icon size="20">{{ m.icon }}</v-icon></div>
            <div class="dashboard-card-value">{{ metricValue(m.key) }}</div>
            <div class="dashboard-card-label">{{ m.label }}</div>
          </article>
        </div>
      </section>

      <section class="dashboard-card dashboard-card--padded mt-5">
        <div class="dashboard-section-head">
          <div>
            <div class="dashboard-section-title">{{ t('dashboard.recentLogs') }}</div>
            <div class="dashboard-section-subtitle">最近 50 条系统日志</div>
          </div>
          <v-btn to="/logs" variant="text" color="primary" append-icon="mdi-arrow-top-right">
            查看全部
          </v-btn>
        </div>
        <div v-if="recentLogs.length" class="dashboard-scrollable log-preview font-mono">
          <div v-for="(log, i) in recentLogs" :key="i" class="log-preview-row">
            <span class="text-medium-emphasis">{{ log.time }}</span>
            <span class="log-level" :class="`log-level--${log.level}`">{{ log.level }}</span>
            <span class="log-tag">[{{ log.tag }}]</span>
            <span class="log-message">{{ log.msg }}</span>
          </div>
        </div>
        <div v-else class="dashboard-empty">{{ t('dashboard.empty') }}</div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/api/client'
import type { LogRecord, StatusData } from '@/api/types'

const { t } = useI18n()
const status = ref<StatusData | null>(null)
const recentLogs = ref<LogRecord[]>([])
const loading = ref(false)
let pollTimer: ReturnType<typeof setInterval> | undefined

const loginNameText = computed(() => status.value?.login?.nickname ?? status.value?.botNickname ?? '—')
const uptimeText = computed(() => formatUptime(status.value?.uptimeSeconds ?? 0))

function formatUptime(totalSeconds: number): string {
  const d = Math.floor(totalSeconds / 86400)
  const h = Math.floor((totalSeconds % 86400) / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = Math.floor(totalSeconds % 60)
  const parts: string[] = []
  if (d) parts.push(`${d}天`)
  if (h || parts.length) parts.push(`${h}小时`)
  if (m || parts.length) parts.push(`${m}分`)
  parts.push(`${s}秒`)
  return parts.join(' ')
}

const metricCards = computed(() => [
  { key: 'messagesReceived', label: t('dashboard.msgReceived'), icon: 'mdi-message-arrow-left-outline' },
  { key: 'messagesSent', label: t('dashboard.msgSent'), icon: 'mdi-message-arrow-right-outline' },
  { key: 'toolCalls', label: t('dashboard.toolCalls'), icon: 'mdi-toolbox-outline' },
  { key: 'errors', label: t('dashboard.errors'), icon: 'mdi-alert-circle-outline' },
])

function metricValue(key: string): number {
  const m = status.value?.metrics
  if (!m) return 0
  if (key === 'messagesReceived') return m.messagesReceived
  if (key === 'messagesSent') return m.messagesSent
  if (key === 'toolCalls') return m.toolCalls
  if (key === 'errors') return m.errors
  return 0
}

async function load(): Promise<void> {
  loading.value = true
  const [statusRes, logsRes] = await Promise.all([api.status(), api.getLogs({ limit: 50 })])
  loading.value = false
  if (statusRes.ok && statusRes.data) status.value = statusRes.data
  if (logsRes.ok && logsRes.data) recentLogs.value = logsRes.data.logs
}

onMounted(() => {
  void load()
  pollTimer = setInterval(() => { void load() }, 5000)
})

onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })
</script>

<style scoped>
.dashboard-split-grid { grid-template-columns: minmax(280px, 0.9fr) minmax(0, 1.6fr); }
.dashboard-overview-grid--metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-bottom: 0; }
.status-dot { width: 9px; height: 9px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 4px rgba(var(--v-theme-error), 0.12); }
.status-dot.is-online { color: rgb(var(--v-theme-success)); box-shadow: 0 0 0 4px rgba(var(--v-theme-success), 0.12); }
.status-dot.is-offline { color: rgb(var(--v-theme-error)); }
.log-preview-row { display: grid; grid-template-columns: auto 50px 110px minmax(0, 1fr); gap: 8px; padding: 9px 0; border-bottom: 1px solid var(--dashboard-border); font-size: 0.78rem; line-height: 1.45; }
.log-preview-row:last-child { border-bottom: 0; }
.log-level { font-weight: 700; text-transform: uppercase; }
.log-level--debug { color: rgb(var(--v-theme-secondary)); }
.log-level--info { color: rgb(var(--v-theme-info)); }
.log-level--warn { color: rgb(var(--v-theme-warning)); }
.log-level--error { color: rgb(var(--v-theme-error)); }
.log-tag { color: rgb(var(--v-theme-primary)); }
.log-message { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 960px) { .dashboard-overview-grid--metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (max-width: 640px) { .dashboard-overview-grid--metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .log-preview-row { grid-template-columns: auto 50px minmax(0, 1fr); } .log-tag { display: none; } }
</style>
