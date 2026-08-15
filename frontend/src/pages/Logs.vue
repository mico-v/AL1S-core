<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ t('logs.title') }}</h1>
      <v-spacer />
      <v-chip :color="connColor" size="small" class="mr-2">
        {{ connText }}
      </v-chip>
      <v-btn variant="text" icon="mdi-close-box-outline" :title="t('logs.clear')" @click="clearView" />
    </div>

    <!-- 工具栏：级别 chips / tag 过滤 / 暂停 / 自动滚动 -->
    <v-card class="mb-3">
      <v-card-text class="d-flex flex-wrap align-center py-2">
        <v-chip size="small" class="mr-1" variant="flat" @click="setAllLevels">
          {{ t('logs.all') }}
        </v-chip>
        <v-chip
          v-for="lv in levels"
          :key="lv.value"
          size="small"
          class="mr-1"
          :color="activeLevels.has(lv.value) ? lv.color : undefined"
          variant="flat"
          @click="toggleLevel(lv.value)"
        >
          {{ lv.label }}
        </v-chip>

        <v-spacer />

        <v-text-field
          v-model="tagFilter"
          label="Tag 过滤"
          density="compact"
          hide-details
          clearable
          prepend-inner-icon="mdi-magnify"
          class="mr-2"
          style="max-width: 220px"
        />

        <v-btn
          variant="tonal"
          :color="paused ? 'success' : 'warning'"
          size="small"
          class="mr-2"
          @click="paused = !paused"
        >
          {{ paused ? t('logs.resume') : t('logs.pause') }}
        </v-btn>

        <v-switch
          v-model="autoScroll"
          :label="t('logs.autoScroll')"
          density="compact"
          hide-details
        />
      </v-card-text>
    </v-card>

    <!-- 日志列表（SSE 实时流） -->
    <v-card>
      <div
        ref="listEl"
        class="overflow-y-auto"
        :style="{ maxHeight: 'calc(100vh - 300px)' }"
      >
        <v-list density="compact" class="font-mono">
          <v-list-item v-for="(log, i) in filteredLogs" :key="i" class="px-3">
            <v-list-item-title class="text-body-2">
              <span class="text-medium-emphasis">{{ log.time }}</span>
              <span class="mx-1" :style="{ color: levelColor(log.level) }">{{ log.level }}</span>
              <span class="mx-1 text-info">[{{ log.tag }}]</span>
              {{ log.msg }}
              <template v-if="log.fields">
                <span v-for="(fv, fk) in log.fields" :key="fk" class="text-medium-emphasis">
                  &nbsp;{{ fk }}={{ fv }}
                </span>
              </template>
            </v-list-item-title>
          </v-list-item>
          <v-list-item v-if="!filteredLogs.length" class="text-center text-medium-emphasis">
            {{ t('logs.empty') }}
          </v-list-item>
        </v-list>
      </div>
    </v-card>
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

const levelColorMap: Record<LogLevel, string> = {
  debug: '#78909C',
  info: '#42A5F5',
  warn: '#FFA726',
  error: '#EF5350',
}

function levelColor(level: LogLevel): string {
  return levelColorMap[level]
}

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

const connColor = computed(() => {
  switch (connState.value) {
    case 'open':
      return 'success'
    case 'connecting':
      return 'warning'
    default:
      return 'error'
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
