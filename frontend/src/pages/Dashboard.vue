<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ t('dashboard.title') }}</h1>
      <v-spacer />
      <v-chip v-if="status?.restartRequired" color="warning" size="small" class="mr-2">
        {{ t('dashboard.restartRequired') }}
      </v-chip>
      <v-btn variant="text" icon="mdi-refresh" :loading="loading" @click="load" />
    </div>

    <v-row>
      <!-- 状态卡 -->
      <v-col cols="12" md="3">
        <v-card>
          <v-card-title class="text-subtitle-2">{{ t('dashboard.status') }}</v-card-title>
          <v-card-text>
            <div class="d-flex align-center">
              <v-icon :color="status?.connected ? 'success' : 'error'" class="mr-2">
                {{ status?.connected ? 'mdi-cloud-check-outline' : 'mdi-cloud-alert-outline' }}
              </v-icon>
              <span :class="status?.connected ? 'text-success' : 'text-error'">
                {{ status?.connected ? t('dashboard.connected') : t('dashboard.disconnected') }}
              </span>
            </div>
            <v-divider class="my-2" />
            <div class="text-subtitle-2 text-medium-emphasis">{{ t('dashboard.loginName') }}</div>
            <div>{{ loginNameText }}</div>
            <v-divider class="my-2" />
            <div class="text-subtitle-2 text-medium-emphasis">{{ t('dashboard.uptime') }}</div>
            <div>{{ uptimeText }}</div>
            <v-divider class="my-2" />
            <div class="text-subtitle-2 text-medium-emphasis">{{ t('dashboard.sessions') }}</div>
            <div>{{ status?.sessionCount ?? '—' }}</div>
            <v-divider class="my-2" />
            <div class="text-subtitle-2 text-medium-emphasis">{{ t('dashboard.version') }}</div>
            <div class="font-mono">{{ status?.version ?? '—' }}</div>
          </v-card-text>
        </v-card>
      </v-col>

      <!-- 指标卡 + 最近日志 -->
      <v-col cols="12" md="9">
        <v-row>
          <v-col v-for="m in metricCards" :key="m.key" cols="12" sm="6" lg="3">
            <v-card>
              <v-card-text class="d-flex align-center">
                <v-avatar :color="m.color" class="mr-3" size="42">
                  <v-icon color="white">{{ m.icon }}</v-icon>
                </v-avatar>
                <div>
                  <div class="text-h6">{{ metricValue(m.key) }}</div>
                  <div class="text-caption text-medium-emphasis">{{ m.label }}</div>
                </div>
              </v-card-text>
            </v-card>
          </v-col>
        </v-row>

        <v-card class="mt-4">
          <v-card-title class="text-subtitle-2">{{ t('dashboard.recentLogs') }}</v-card-title>
          <v-card-text>
            <v-list v-if="recentLogs.length" density="compact" max-height="320" class="overflow-y-auto">
              <v-list-item v-for="(log, i) in recentLogs" :key="i" density="compact" class="px-0">
                <v-list-item-title class="text-body-2 font-mono">
                  <span class="text-medium-emphasis">{{ log.time }}</span>
                  <span class="mx-1" :style="{ color: levelColor(log.level) }">{{ log.level }}</span>
                  <span class="mx-1 text-info">[{{ log.tag }}]</span>
                  {{ log.msg }}
                </v-list-item-title>
              </v-list-item>
            </v-list>
            <div v-else class="text-caption text-medium-emphasis py-4 text-center">
              {{ t('dashboard.empty') }}
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
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

const levelColors: Record<LogRecord['level'], string> = {
  debug: '#78909C',
  info: '#42A5F5',
  warn: '#FFA726',
  error: '#EF5350',
}

function levelColor(level: LogRecord['level']): string {
  return levelColors[level]
}

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
  { key: 'messagesReceived', label: t('dashboard.msgReceived'), icon: 'mdi-message-arrow-left-outline', color: 'primary' },
  { key: 'messagesSent', label: t('dashboard.msgSent'), icon: 'mdi-message-arrow-right-outline', color: 'info' },
  { key: 'toolCalls', label: t('dashboard.toolCalls'), icon: 'mdi-toolbox-outline', color: 'warning' },
  { key: 'errors', label: t('dashboard.errors'), icon: 'mdi-alert-circle-outline', color: 'error' },
])

function metricValue(key: string): number {
  const m = status.value?.metrics
  if (!m) return 0
  switch (key) {
    case 'messagesReceived':
      return m.messagesReceived
    case 'messagesSent':
      return m.messagesSent
    case 'toolCalls':
      return m.toolCalls
    case 'errors':
      return m.errors
    default:
      return 0
  }
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
  // 每 5s 轮询 status（与最近日志一起刷新）
  pollTimer = setInterval(() => {
    void load()
  }, 5000)
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>
