<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ t('sessions.title') }}</h1>
      <v-spacer />
      <v-btn variant="text" icon="mdi-refresh" :loading="loading" @click="load" />
    </div>

    <v-card>
      <v-data-table
        :headers="headers"
        :items="sessions"
        :loading="loading"
        items-per-page="10"
        density="compact"
        @click:row="openSession"
      >
        <template #item.chatId="{ item }">
          <span class="font-mono">{{ item.chatId }}</span>
        </template>
        <template #item.isGenerating="{ item }">
          <v-progress-circular v-if="item.isGenerating" size="16" color="primary" indeterminate />
          <span v-else class="text-medium-emphasis">—</span>
        </template>
        <template #item.lastActivity="{ item }">
          {{ formatTime(item.lastActivity) }}
        </template>
      </v-data-table>
    </v-card>

    <!-- 会话日志抽屉：点行打开 -->
    <v-navigation-drawer v-model="drawer" location="right" temporary width="480">
      <template v-if="active">
        <v-card flat>
          <v-card-title class="d-flex align-center">
            <span class="font-mono text-subtitle-1">{{ active.chatId }}</span>
            <v-spacer />
            <v-btn variant="text" icon="mdi-close" @click="drawer = false" />
          </v-card-title>
          <v-card-text>
            <v-chip size="small" class="mr-2">消息数 {{ active.messageCount }}</v-chip>
            <v-chip v-if="active.isGenerating" size="small" color="primary">生成中</v-chip>
          </v-card-text>
          <v-divider />
          <v-card-actions>
            <v-btn
              color="error"
              variant="tonal"
              prepend-icon="mdi-delete-outline"
              :loading="clearing"
              @click="clearActive"
            >
              {{ t('sessions.clear') }}
            </v-btn>
          </v-card-actions>
        </v-card>
      </template>

      <v-divider />

      <div class="overflow-y-auto" style="max-height: calc(100vh - 240px)">
        <v-list v-if="messages.length" density="compact">
          <v-list-item v-for="(msg, i) in messages" :key="i" class="px-3">
            <div class="d-flex align-center mb-1 flex-wrap">
              <v-chip
                size="x-small"
                :color="msg.role === 'user' ? 'primary' : 'secondary'"
                class="mr-2"
              >
                {{ msg.role === 'user' ? '用户' : '机器人' }}
              </v-chip>
              <span v-if="msg.senderName" class="text-caption text-medium-emphasis mr-2">
                {{ msg.senderName }}
              </span>
              <v-chip v-if="msg.atBot" size="x-small" color="warning" class="mr-2">@机器人</v-chip>
              <span class="text-caption text-medium-emphasis">{{ formatTime(msg.time * 1000) }}</span>
            </div>
            <div class="text-body-2 text-pre-wrap">{{ msg.text }}</div>
          </v-list-item>
        </v-list>
        <div v-else class="text-caption text-medium-emphasis text-center py-8">
          {{ t('sessions.empty') }}
        </div>
      </div>
    </v-navigation-drawer>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/api/client'
import type { SessionMessage, SessionSummary } from '@/api/types'
import { useSnackbarStore } from '@/stores/snackbar'

const { t } = useI18n()
const snackbar = useSnackbarStore()

const sessions = ref<SessionSummary[]>([])
const messages = ref<SessionMessage[]>([])
const active = ref<SessionSummary | null>(null)
const drawer = ref(false)
const loading = ref(false)
const clearing = ref(false)

interface Header {
  title: string
  key: string
  sortable?: boolean
}

const headers: Header[] = [
  { title: t('sessions.chatId'), key: 'chatId' },
  { title: t('sessions.messages'), key: 'messageCount' },
  { title: t('sessions.lastActive'), key: 'lastActivity' },
  { title: t('sessions.generating'), key: 'isGenerating', sortable: false },
]

function formatTime(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

async function load(): Promise<void> {
  loading.value = true
  const res = await api.getSessions()
  loading.value = false
  if (res.ok && res.data) {
    sessions.value = res.data.sessions
  } else {
    snackbar.show(res.error ?? '加载会话列表失败', 'error')
  }
}

async function openSession(_event: MouseEvent, row: { item: SessionSummary }): Promise<void> {
  active.value = row.item
  drawer.value = true
  messages.value = []
  const res = await api.getSessionMessages(row.item.chatId)
  if (res.ok && res.data) {
    messages.value = res.data.messages
  } else {
    snackbar.show(res.error ?? '加载会话日志失败', 'error')
  }
}

async function clearActive(): Promise<void> {
  if (!active.value) return
  clearing.value = true
  const res = await api.clearSession(active.value.chatId)
  clearing.value = false
  if (res.ok) {
    messages.value = []
    snackbar.show(t('sessions.cleared'))
    await load()
  } else {
    snackbar.show(res.error ?? '清空失败', 'error')
  }
}

onMounted(() => {
  void load()
})
</script>
