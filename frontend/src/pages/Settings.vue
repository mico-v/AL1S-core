<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ t('settings.title') }}</h1>
      <v-spacer />
      <v-progress-circular v-if="saving" size="20" indeterminate class="mr-2" />
      <v-btn variant="text" icon="mdi-refresh" :loading="loading" @click="load" />
    </div>

    <v-alert v-if="loadError" type="error" class="mb-4">{{ loadError }}</v-alert>

    <template v-if="groups.length">
      <v-expansion-panels v-model="openPanels" multiple>
        <v-expansion-panel v-for="group in groups" :key="group.key" :value="group.key">
          <v-expansion-panel-title>
            <div>
              <span class="text-subtitle-1">{{ group.label }}</span>
              <div v-if="group.description" class="text-caption text-medium-emphasis">
                {{ group.description }}
              </div>
            </div>
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <v-row>
              <v-col v-for="field in group.fields" :key="field.key" cols="12" sm="6">
                <!-- string：单行文本 -->
                <v-text-field
                  v-if="field.type === 'string'"
                  v-model="values[field.key]"
                  :placeholder="field.placeholder"
                  :hint="field.hint"
                  :persistent-hint="!!field.hint"
                  :density="density"
                  @update:model-value="scheduleSave(field)"
                >
                  <template #label>
                    <span>{{ field.label }}</span>
                    <v-chip v-if="field.requiresRestart" size="x-small" color="warning" class="ml-2">
                      {{ t('settings.restartBadge') }}
                    </v-chip>
                  </template>
                </v-text-field>

                <!-- password：密码（可切换明文） -->
                <v-text-field
                  v-else-if="field.type === 'password'"
                  v-model="values[field.key]"
                  :placeholder="field.placeholder"
                  :hint="field.hint"
                  :persistent-hint="!!field.hint"
                  :type="revealed[field.key] ? 'text' : 'password'"
                  :append-inner-icon="revealed[field.key] ? 'mdi-eye-off-outline' : 'mdi-eye-outline'"
                  :density="density"
                  @click:append-inner="revealed[field.key] = !revealed[field.key]"
                  @update:model-value="scheduleSave(field)"
                >
                  <template #label>
                    <span>{{ field.label }}</span>
                    <v-chip v-if="field.requiresRestart" size="x-small" color="warning" class="ml-2">
                      {{ t('settings.restartBadge') }}
                    </v-chip>
                  </template>
                </v-text-field>

                <!-- textarea：多行文本 -->
                <v-textarea
                  v-else-if="field.type === 'textarea'"
                  v-model="values[field.key]"
                  :placeholder="field.placeholder"
                  :hint="field.hint"
                  :persistent-hint="!!field.hint"
                  :density="density"
                  auto-grow
                  rows="3"
                  @update:model-value="scheduleSave(field)"
                >
                  <template #label>
                    <span>{{ field.label }}</span>
                    <v-chip v-if="field.requiresRestart" size="x-small" color="warning" class="ml-2">
                      {{ t('settings.restartBadge') }}
                    </v-chip>
                  </template>
                </v-textarea>

                <!-- number：数字 -->
                <v-text-field
                  v-else-if="field.type === 'number'"
                  v-model="values[field.key]"
                  :hint="field.hint"
                  :persistent-hint="!!field.hint"
                  type="number"
                  :min="field.min"
                  :max="field.max"
                  :step="field.step"
                  :density="density"
                  @update:model-value="scheduleSave(field)"
                >
                  <template #label>
                    <span>{{ field.label }}</span>
                    <v-chip v-if="field.requiresRestart" size="x-small" color="warning" class="ml-2">
                      {{ t('settings.restartBadge') }}
                    </v-chip>
                  </template>
                </v-text-field>

                <!-- boolean：开关 -->
                <v-switch
                  v-else-if="field.type === 'boolean'"
                  v-model="values[field.key]"
                  :hint="field.hint"
                  :persistent-hint="!!field.hint"
                  color="primary"
                  @update:model-value="scheduleSave(field)"
                >
                  <template #label>
                    <span>{{ field.label }}</span>
                    <v-chip v-if="field.requiresRestart" size="x-small" color="warning" class="ml-2">
                      {{ t('settings.restartBadge') }}
                    </v-chip>
                  </template>
                </v-switch>

                <!-- string-list / number-list：多选 chips 自由输入 -->
                <v-combobox
                  v-else
                  v-model="values[field.key] as string[]"
                  :hint="field.hint"
                  :persistent-hint="!!field.hint"
                  :density="density"
                  multiple
                  chips
                  closable-chips
                  @update:model-value="scheduleSave(field)"
                >
                  <template #label>
                    <span>{{ field.label }}</span>
                    <v-chip v-if="field.requiresRestart" size="x-small" color="warning" class="ml-2">
                      {{ t('settings.restartBadge') }}
                    </v-chip>
                  </template>
                </v-combobox>
              </v-col>
            </v-row>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
    </template>
    <v-alert v-else-if="!loading && !loadError" type="info">{{ t('settings.noGroups') }}</v-alert>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/api/client'
import type { ConfigField, ConfigGroup } from '@/api/types'
import { useSnackbarStore } from '@/stores/snackbar'

const { t } = useI18n()
const snackbar = useSnackbarStore()

const groups = ref<ConfigGroup[]>([])
const values = reactive<Record<string, unknown>>({})
const revealed = reactive<Record<string, boolean>>({})
const openPanels = ref<string[]>([])
const loading = ref(false)
const saving = ref(false)
const loadError = ref('')

const density = 'compact' as const

let saveTimer: ReturnType<typeof setTimeout> | undefined
const editedSinceSave = new Set<string>()
let disposed = false

/** 加载 schema 与当前值，并初始化表单模型 */
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

  const g = schemaRes.data.groups
  groups.value = g
  const fieldMap = new Map<string, ConfigField>(g.flatMap((group) => group.fields).map((f) => [f.key, f]))
  for (const [key, raw] of Object.entries(configRes.data.values)) {
    const field = fieldMap.get(key)
    values[key] = field ? displayValue(field, raw) : raw
  }
  // 默认展开第一个分组
  if (!openPanels.value.length && g[0]) openPanels.value = [g[0].key]
}

/** 数组字段（列表类型）在表单中以字符串数组展示，便于 chips 编辑 */
function displayValue(field: ConfigField, raw: unknown): unknown {
  if (field.type === 'string-list' || field.type === 'number-list') {
    return Array.isArray(raw) ? raw.map(String) : []
  }
  return raw
}

/** 提交前把表单值转回服务端期望的类型（number/number-list） */
function toSaveValue(field: ConfigField, raw: unknown): unknown {
  if (field.type === 'number') {
    if (raw === '' || raw === null || raw === undefined) return raw
    const n = Number(raw)
    return Number.isNaN(n) ? raw : n
  }
  if (field.type === 'number-list') {
    return Array.isArray(raw) ? raw.map(Number) : raw
  }
  return raw
}

function findField(key: string): ConfigField | undefined {
  for (const group of groups.value) {
    for (const field of group.fields) {
      if (field.key === key) return field
    }
  }
  return undefined
}

/** 字段改动 → 500ms 防抖后自动保存 */
function scheduleSave(field: ConfigField): void {
  editedSinceSave.add(field.key)
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    void save()
  }, 500)
}

async function save(): Promise<void> {
  if (saving.value) {
    // 已有保存请求在途：稍后重试，避免把用户新改动丢在防抖间隙里
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      void save()
    }, 200)
    return
  }
  saving.value = true

  // 组装 payload：仅包含已知字段；undefined 值会被 JSON.stringify 丢弃 → 天然部分提交
  const payload: Record<string, unknown> = {}
  for (const group of groups.value) {
    for (const field of group.fields) {
      payload[field.key] = toSaveValue(field, values[field.key])
    }
  }

  const res = await api.updateConfig(payload)
  saving.value = false

  if (!res.ok) {
    snackbar.show(res.error ?? '保存失败', 'error')
    return
  }

  const applied = res.data?.applied ?? []
  const pendingRestart = res.data?.pendingRestart ?? []
  const msgParts: string[] = []
  if (applied.length) msgParts.push(`${t('settings.applied')}：${applied.join('、')}`)
  if (pendingRestart.length) msgParts.push(`${t('settings.pendingRestart')}：${pendingRestart.join('、')}`)
  snackbar.show(msgParts.join('；') || t('settings.saveDone'), pendingRestart.length ? 'warning' : 'success')

  // 保存成功后重新 GET /api/config 对账（跳过保存期间又被改动的字段，避免覆盖用户输入）
  if (!disposed) {
    const fresh = await api.getConfig()
    if (fresh.ok && fresh.data) {
      for (const [key, raw] of Object.entries(fresh.data.values)) {
        if (!editedSinceSave.has(key)) {
          const field = findField(key)
          values[key] = field ? displayValue(field, raw) : raw
        }
      }
    }
  }
  editedSinceSave.clear()

  // 保存期间若又有新的防抖请求排队，则再触发一次
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      void save()
    }, 100)
  }
}

onMounted(() => {
  void load()
})

onBeforeUnmount(() => {
  disposed = true
  if (saveTimer) clearTimeout(saveTimer)
})
</script>
