<template>
  <div class="dashboard-page">
    <div class="dashboard-shell">
    <!-- 页头：返回 + 插件名 -->
    <header class="dashboard-header">
      <div class="d-flex align-center min-width-0">
        <v-btn variant="text" icon="mdi-arrow-left" :to="{ name: 'plugins' }" :aria-label="t('common.back')" class="mr-2" />
        <div class="min-width-0">
          <h1 class="dashboard-title text-truncate">{{ plugin?.displayName ?? name }}</h1>
          <div v-if="name" class="dashboard-subtitle font-mono text-truncate">{{ name }}</div>
        </div>
      </div>
      <div class="dashboard-header-actions">
        <v-progress-circular v-if="loading" size="20" indeterminate />
        <v-btn variant="tonal" color="primary" prepend-icon="mdi-refresh" :loading="loading" @click="load">刷新</v-btn>
      </div>
    </header>

    <v-alert v-if="loadError" type="error" variant="tonal" class="mb-5">{{ loadError }}</v-alert>

    <!-- 插件描述 -->
    <v-card v-if="plugin" class="dashboard-card mb-5 plugin-summary">
      <v-card-text>
        <v-row align="center">
          <v-avatar color="primary" variant="tonal" size="40" class="mr-3">
            <v-icon>mdi-puzzle-outline</v-icon>
          </v-avatar>
          <div>
            <div class="text-subtitle-1">{{ plugin.description }}</div>
            <div class="text-caption text-medium-emphasis">
              {{ commandCount }} {{ t('plugins.commands') }} · {{ skillCount }} {{ t('plugins.skills') }}
            </div>
          </div>
        </v-row>
      </v-card-text>
    </v-card>

    <!-- 设置：插件自己声明的 schema 表单（模块化渲染，与全局设置共用 ConfigForm） -->
    <v-card v-if="settings" class="dashboard-card mb-5">
      <v-card-title class="d-flex align-center dashboard-section-title">
        {{ t('plugins.settings') }}
        <v-chip v-if="settings.label" size="small" variant="tonal" color="primary" class="ml-2">
          {{ settings.label }}
        </v-chip>
      </v-card-title>
      <v-card-text>
        <ConfigForm
          :groups="[settings]"
          :values="values"
          :save-values="saveValues"
          :refresh-values="refreshValues"
          :reveal-value="revealValue"
        />
      </v-card-text>
    </v-card>
    <v-card v-else-if="!loading && plugin" class="dashboard-card mb-5"><v-card-text class="text-medium-emphasis">{{ t('plugins.noSettings') }}</v-card-text></v-card>

    <!-- 命令开关 -->
    <v-card v-if="commands.length" class="dashboard-card mb-5">
      <v-card-title class="dashboard-section-title">{{ t('plugins.commands') }}</v-card-title>
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

    <!-- 工具开关 -->
    <v-card v-if="skills.length" class="dashboard-card">
      <v-card-title class="dashboard-section-title">{{ t('plugins.skills') }}</v-card-title>
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
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { api } from '@/api/client'
import type { CommandItem, ConfigGroup, PluginItem, SkillItem } from '@/api/types'
import ConfigForm from '@/components/ConfigForm.vue'
import { useSnackbarStore } from '@/stores/snackbar'

const { t } = useI18n()
const route = useRoute()
const snackbar = useSnackbarStore()

const name = computed(() => String(route.params.name ?? ''))
const plugin = ref<PluginItem | null>(null)
const settings = ref<ConfigGroup | null>(null)
const values = ref<Record<string, unknown>>({})
const commands = ref<CommandItem[]>([])
const skills = ref<SkillItem[]>([])
const loading = ref(false)
const loadError = ref('')

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

const commandCount = computed(() => commands.value.length)
const skillCount = computed(() => skills.value.length)

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

async function saveValues(payload: Record<string, unknown>): Promise<{ applied: string[]; pendingRestart: string[] }> {
  const res = await api.updatePluginConfig(name.value, payload)
  if (!res.ok) throw new Error(res.error ?? '保存失败')
  return res.data ?? { applied: [], pendingRestart: [] }
}

async function refreshValues(): Promise<Record<string, unknown>> {
  const res = await api.getPluginConfig(name.value)
  if (!res.ok) throw new Error(res.error ?? '刷新失败')
  return res.data?.values ?? {}
}

async function revealValue(key: string): Promise<string> {
  const res = await api.getConfigSecret(key)
  if (!res.ok || !res.data) throw new Error(res.error ?? '读取密钥失败')
  return res.data.value
}
async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  const [listRes, cfgRes] = await Promise.all([api.getPlugins(), api.getPluginConfig(name.value)])
  loading.value = false
  if (listRes.ok && listRes.data) {
    plugin.value = listRes.data.plugins.find((p) => p.name === name.value) ?? null
    if (plugin.value) {
      commands.value = plugin.value.commands
      skills.value = plugin.value.skills
    }
  }
  if (!cfgRes.ok || !cfgRes.data) {
    loadError.value = cfgRes.error ?? '加载插件配置失败'
    return
  }
  settings.value = cfgRes.data.group
  values.value = cfgRes.data.values
}

// 直接从一个插件详情跳到另一个（路由参数变化，组件复用）时重新加载
watch(name, () => {
  void load()
})

onMounted(() => {
  void load()
})
</script>