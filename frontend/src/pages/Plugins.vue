<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ t('plugins.title') }}</h1>
      <v-spacer />
      <v-btn variant="text" icon="mdi-refresh" :loading="loading" @click="load" />
    </div>

    <v-card class="mb-4">
      <v-card-title class="text-subtitle-2">{{ t('plugins.commands') }}</v-card-title>
      <v-data-table
        :headers="headers"
        :items="commands"
        :loading="loading"
        items-per-page="-1"
        density="compact"
      >
        <template #item.enabled="{ item }">
          <v-switch
            :model-value="item.enabled"
            color="primary"
            density="compact"
            hide-details
            @update:model-value="(v: unknown) => toggle('command', item, !!v)"
          />
        </template>
      </v-data-table>
    </v-card>

    <v-card>
      <v-card-title class="text-subtitle-2">{{ t('plugins.skills') }}</v-card-title>
      <v-data-table
        :headers="headers"
        :items="skills"
        :loading="loading"
        items-per-page="-1"
        density="compact"
      >
        <template #item.enabled="{ item }">
          <v-switch
            :model-value="item.enabled"
            color="primary"
            density="compact"
            hide-details
            @update:model-value="(v: unknown) => toggle('skill', item, !!v)"
          />
        </template>
      </v-data-table>
    </v-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/api/client'
import type { CommandItem, SkillItem } from '@/api/types'
import { useSnackbarStore } from '@/stores/snackbar'

const { t } = useI18n()
const snackbar = useSnackbarStore()

const commands = ref<CommandItem[]>([])
const skills = ref<SkillItem[]>([])
const loading = ref(false)

interface Header {
  title: string
  key: string
  sortable?: boolean
}

const headers: Header[] = [
  { title: t('plugins.name'), key: 'name' },
  { title: t('plugins.description'), key: 'description' },
  { title: t('plugins.enabled'), key: 'enabled', sortable: false },
]

type ToggleItem = CommandItem | SkillItem

/** 切换启用状态：乐观更新，失败回滚 */
async function toggle(kind: 'command' | 'skill', item: ToggleItem, enabled: boolean): Promise<void> {
  const prev = item.enabled
  if (prev === enabled) return
  item.enabled = enabled // 乐观更新
  const res = await api.setPluginEnabled({ kind, name: item.name, enabled })
  if (!res.ok) {
    item.enabled = prev // 失败回滚
    snackbar.show(res.error ?? t('plugins.toggleFailed'), 'error')
  }
}

async function load(): Promise<void> {
  loading.value = true
  const res = await api.getPlugins()
  loading.value = false
  if (res.ok && res.data) {
    commands.value = res.data.commands
    skills.value = res.data.skills
  } else {
    snackbar.show(res.error ?? '加载插件列表失败', 'error')
  }
}

onMounted(() => {
  void load()
})
</script>
