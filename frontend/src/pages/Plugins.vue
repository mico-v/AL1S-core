<template>
  <div class="dashboard-page">
    <div class="dashboard-shell">
      <header class="dashboard-header">
        <div><h1 class="dashboard-title">{{ t('plugins.title') }}</h1><p class="dashboard-subtitle">管理已加载的插件、命令和工具。</p></div>
        <v-btn variant="tonal" color="primary" prepend-icon="mdi-refresh" :loading="loading" @click="load">刷新</v-btn>
      </header>
      <v-alert v-if="loadError" type="error" variant="tonal" class="mb-5">{{ loadError }}</v-alert>
      <div v-if="plugins.length" class="plugin-grid">
        <v-card v-for="p in plugins" :key="p.name" :to="{ name: 'plugin-detail', params: { name: p.name } }" hover class="plugin-card">
          <v-card-item class="pb-1">
            <template #prepend><div class="plugin-icon"><v-icon>mdi-puzzle-outline</v-icon></div></template>
            <template #title><div class="d-flex align-center flex-wrap ga-2"><span>{{ p.displayName }}</span><v-chip v-if="p.hasSettings" size="x-small" color="primary" variant="tonal">{{ t('plugins.hasSettings') }}</v-chip></div></template>
            <template #subtitle><span class="font-mono">{{ p.name }}</span></template>
          </v-card-item>
          <v-card-text class="plugin-description">{{ p.description || '暂无插件描述' }}</v-card-text>
          <v-divider />
          <v-card-actions class="px-4 py-3">
            <span class="dashboard-pill"><v-icon size="15">mdi-console-line</v-icon>命令 {{ p.commands.length }}</span>
            <v-spacer />
            <v-btn variant="text" color="primary" size="small" append-icon="mdi-chevron-right">{{ t('plugins.open') }}</v-btn>
          </v-card-actions>
        </v-card>
      </div>
      <div v-else-if="!loading && !loadError" class="dashboard-card dashboard-empty"><v-icon size="32" class="mb-2">mdi-puzzle-remove-outline</v-icon><div>{{ t('plugins.empty') }}</div></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/api/client'
import type { PluginItem } from '@/api/types'
const { t } = useI18n()
const plugins = ref<PluginItem[]>([])
const loading = ref(false)
const loadError = ref('')
async function load(): Promise<void> {
  loading.value = true; loadError.value = ''
  const res = await api.getPlugins(); loading.value = false
  if (res.ok && res.data) plugins.value = res.data.plugins
  else loadError.value = res.error ?? '加载插件列表失败'
}
onMounted(() => { void load() })
</script>

<style scoped>
.plugin-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
.plugin-card { height: 100%; overflow: hidden; transition: transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease; }
.plugin-card:hover { border-color: rgba(var(--v-theme-primary), 0.35); box-shadow: 0 12px 30px rgba(30, 70, 100, 0.1); transform: translateY(-3px); }
.plugin-icon { display: inline-flex; align-items: center; justify-content: center; width: 42px; height: 42px; margin-right: 12px; border-radius: 13px; background: rgba(var(--v-theme-primary), 0.11); color: rgb(var(--v-theme-primary)); }
.plugin-description { min-height: 76px; color: rgba(var(--v-theme-primaryText), 0.7); line-height: 1.6; }
@media (max-width: 1100px) { .plugin-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) { .plugin-grid { grid-template-columns: 1fr; } }
</style>
