<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ t('settings.title') }}</h1>
      <v-spacer />
      <v-btn variant="text" icon="mdi-refresh" :loading="loading" @click="load" />
    </div>

    <v-alert v-if="loadError" type="error" class="mb-4">{{ loadError }}</v-alert>

    <!-- schema 驱动表单：字段渲染 + 防抖自动保存统一由 ConfigForm 提供 -->
    <ConfigForm
      :groups="groups"
      :values="values"
      :loading="loading"
      :save-values="saveValues"
      :refresh-values="refreshValues"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/api/client'
import type { ConfigGroup } from '@/api/types'
import ConfigForm from '@/components/ConfigForm.vue'

const { t } = useI18n()

const groups = ref<ConfigGroup[]>([])
const values = ref<Record<string, unknown>>({})
const loading = ref(false)
const loadError = ref('')

/** 提交保存：调 PUT /api/config；失败抛错由 ConfigForm 统一提示 */
async function saveValues(payload: Record<string, unknown>): Promise<{ applied: string[]; pendingRestart: string[] }> {
  const res = await api.updateConfig(payload)
  if (!res.ok) throw new Error(res.error ?? '保存失败')
  return res.data ?? { applied: [], pendingRestart: [] }
}

/** 保存后拉取最新值用于对账 */
async function refreshValues(): Promise<Record<string, unknown>> {
  const res = await api.getConfig()
  if (!res.ok || !res.data) throw new Error(res.error ?? '刷新失败')
  return res.data.values
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  const [schemaRes, configRes] = await Promise.all([api.getConfigSchema(), api.getConfig()])
  loading.value = false

  if (!schemaRes.ok || !schemaRes.data) {
    loadError.value = schemaRes.error ?? '加载配置结构失败'
    return
  }
  if (!configRes.ok || !configRes.data) {
    loadError.value = configRes.error ?? '加载配置值失败'
    return
  }

  groups.value = schemaRes.data.groups
  values.value = configRes.data.values
}

onMounted(() => {
  void load()
})
</script>