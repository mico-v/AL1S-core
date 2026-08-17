<template>
  <div>
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
                  v-model="formValues[field.key]"
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
                  v-model="formValues[field.key]"
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
                  v-model="formValues[field.key]"
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
                  v-model="formValues[field.key]"
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
                  v-model="formValues[field.key]"
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
                  v-model="formValues[field.key] as string[]"
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
    <v-alert v-else-if="!loading" type="info">{{ t('settings.noGroups') }}</v-alert>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ConfigField, ConfigGroup } from '@/api/types'
import { useSnackbarStore } from '@/stores/snackbar'

const props = defineProps<{
  /** 按分组的字段 schema（自动展开第一个分组） */
  groups: ConfigGroup[]
  /** 当前生效值快照（父组件 re-GET 后整体替换） */
  values: Record<string, unknown>
  loading?: boolean
  /** 提交保存，返回已即时生效/需重启的字段 key（抛错则显示为失败） */
  saveValues: (payload: Record<string, unknown>) => Promise<{ applied: string[]; pendingRestart: string[] }>
  /** 保存后拉取最新值用于对账 */
  refreshValues: () => Promise<Record<string, unknown>>
}>()

const { t } = useI18n()
const snackbar = useSnackbarStore()

// 本地表单模型：props.values 的副本，编辑期间由本地持有，保存后与后端对账
const formValues = reactive<Record<string, unknown>>({})
const revealed = reactive<Record<string, boolean>>({})
const openPanels = ref<string[]>([])
const saving = ref(false)

const density = 'compact' as const

let saveTimer: ReturnType<typeof setTimeout> | undefined
const editedSinceSave = new Set<string>()
let disposed = false

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
  for (const group of props.groups) {
    for (const field of group.fields) {
      if (field.key === key) return field
    }
  }
  return undefined
}

/** 把最新值（re-GET）合并进表单模型，跳过编辑中的字段 */
function mergeValues(v: Record<string, unknown>): void {
  for (const [key, raw] of Object.entries(v)) {
    if (editedSinceSave.has(key)) continue
    const field = findField(key)
    formValues[key] = field ? displayValue(field, raw) : raw
  }
}

/** 从 props.values 初始化/对账（props 整体替换时触发） */
function syncFromProps(): void {
  mergeValues(props.values)
  if (props.groups.length && !openPanels.value.length) {
    openPanels.value = [props.groups[0]!.key]
  }
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
  for (const group of props.groups) {
    for (const field of group.fields) {
      payload[field.key] = toSaveValue(field, formValues[field.key])
    }
  }

  let result: { applied: string[]; pendingRestart: string[] }
  try {
    result = await props.saveValues(payload)
  } catch (err) {
    saving.value = false
    snackbar.show(err instanceof Error ? err.message : '保存失败', 'error')
    return
  }
  saving.value = false

  const applied = result.applied ?? []
  const pendingRestart = result.pendingRestart ?? []
  const msgParts: string[] = []
  if (applied.length) msgParts.push(`${t('settings.applied')}：${applied.join('、')}`)
  if (pendingRestart.length) msgParts.push(`${t('settings.pendingRestart')}：${pendingRestart.join('、')}`)
  snackbar.show(msgParts.join('；') || t('settings.saveDone'), pendingRestart.length ? 'warning' : 'success')

  // 保存成功后重新拉取最新值对账（跳过保存期间又被改动的字段，避免覆盖用户输入）
  if (!disposed) {
    try {
      const fresh = await props.refreshValues()
      mergeValues(fresh)
    } catch {
      // 对账失败不影响已保存值
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

watch(
  () => props.values,
  () => {
    if (!disposed) syncFromProps()
  },
  { deep: true },
)

onMounted(() => {
  syncFromProps()
})

onBeforeUnmount(() => {
  disposed = true
  if (saveTimer) clearTimeout(saveTimer)
})
</script>