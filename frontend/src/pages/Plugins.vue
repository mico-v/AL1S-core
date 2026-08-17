<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ t('plugins.title') }}</h1>
      <v-spacer />
      <v-btn variant="text" icon="mdi-refresh" :loading="loading" @click="load" />
    </div>

    <v-alert v-if="loadError" type="error" class="mb-4">{{ loadError }}</v-alert>

    <v-row v-if="plugins.length">
      <v-col v-for="p in plugins" :key="p.name" cols="12" sm="6" lg="4" class="plugin-col">
        <v-card :to="{ name: 'plugin-detail', params: { name: p.name } }" hover class="plugin-card">
          <v-card-item>
            <template #prepend>
              <v-avatar color="primary" variant="tonal" size="44">
                <v-icon>mdi-puzzle-outline</v-icon>
              </v-avatar>
            </template>
            <template #title>
              <div class="d-flex align-center flex-wrap">
                <span>{{ p.displayName }}</span>
                <v-chip v-if="p.hasSettings" size="x-small" color="primary" variant="tonal" class="ml-2">
                  {{ t('plugins.hasSettings') }}
                </v-chip>
              </div>
            </template>
            <template #subtitle>
              <span class="font-mono">{{ p.name }}</span>
            </template>
          </v-card-item>

          <v-card-text class="text-medium-emphasis">
            {{ p.description }}
          </v-card-text>

          <v-card-actions class="d-flex align-center px-4 pb-3">
            <v-chip size="small" variant="text" class="text-caption">
              {{ t('plugins.commandCount', { n: p.commands.length }) }}
            </v-chip>
            <v-chip size="small" variant="text" class="text-caption ml-1">
              {{ t('plugins.skillCount', { n: p.skills.length }) }}
            </v-chip>
            <v-spacer />
            <v-btn :to="{ name: 'plugin-detail', params: { name: p.name } }" variant="text" color="primary" size="small">
              {{ t('plugins.open') }}
              <v-icon end size="small">mdi-chevron-right</v-icon>
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-col>
    </v-row>

    <v-alert v-else-if="!loading && !loadError" type="info">{{ t('plugins.empty') }}</v-alert>
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
  loading.value = true
  loadError.value = ''
  const res = await api.getPlugins()
  loading.value = false
  if (res.ok && res.data) {
    plugins.value = res.data.plugins
  } else {
    loadError.value = res.error ?? '加载插件列表失败'
  }
}

onMounted(() => {
  void load()
})
</script>

<style scoped>
.plugin-card {
  height: 100%;
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;
}
.plugin-col {
  display: flex;
}
</style>