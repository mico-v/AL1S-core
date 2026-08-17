<template>
  <div>
    <template v-if="groups.length">
      <div class="config-groups">
        <section v-for="group in groups" :key="group.key" class="dashboard-card config-group">
          <div class="config-group-head">
            <div>
              <div class="dashboard-section-title">{{ group.label }}</div>
              <div v-if="group.description" class="dashboard-section-subtitle">{{ group.description }}</div>
            </div>
            <v-icon color="primary" size="22">mdi-tune-variant</v-icon>
          </div>
          <div class="dashboard-form-grid config-fields">
            <div v-for="field in group.fields" :key="field.key" :class="{ 'config-field-wide': field.type === 'textarea' }">
              <!-- string：单行文本 -->
              <v-text-field v-if="field.type === 'string'" v-model="formValues[field.key]" :placeholder="field.placeholder" :hint="field.hint" :persistent-hint="!!field.hint" :density="density" @update:model-value="scheduleSave(field)">
                <template #label><span>{{ field.label }}</span><v-chip v-if="field.applyMode === 'restart' || field.requiresRestart" size="x-small" color="warning" class="ml-2">{{ t('settings.restartBadge') }}</v-chip></template>
              </v-text-field>
              <!-- password：密码（可切换明文） -->
              <v-text-field v-else-if="field.type === 'password'" v-model="formValues[field.key]" :placeholder="field.placeholder" :hint="field.hint" :persistent-hint="!!field.hint" :type="revealed[field.key] === true ? 'text' : 'password'" :density="density" autocomplete="new-password" @update:model-value="scheduleSave(field)">
                <template #append-inner>
                  <button type="button" class="secret-toggle" :aria-label="revealed[field.key] === true ? '隐藏密钥' : '显示密钥'" @mousedown.prevent @click.prevent.stop="toggleReveal(field)">
                    <v-icon size="18">{{ revealed[field.key] === true ? 'mdi-eye-off-outline' : 'mdi-eye-outline' }}</v-icon>
                  </button>
                </template>
                <template #label><span>{{ field.label }}</span><v-chip v-if="field.applyMode === 'restart' || field.requiresRestart" size="x-small" color="warning" class="ml-2">{{ t('settings.restartBadge') }}</v-chip></template>
              </v-text-field>
              <!-- textarea：多行文本 -->
              <v-textarea v-else-if="field.type === 'textarea'" v-model="formValues[field.key]" :placeholder="field.placeholder" :hint="field.hint" :persistent-hint="!!field.hint" :density="density" auto-grow rows="3" @update:model-value="scheduleSave(field)">
                <template #label><span>{{ field.label }}</span><v-chip v-if="field.applyMode === 'restart' || field.requiresRestart" size="x-small" color="warning" class="ml-2">{{ t('settings.restartBadge') }}</v-chip></template>
              </v-textarea>
              <!-- number：数字 -->
              <v-text-field v-else-if="field.type === 'number'" v-model="formValues[field.key]" :hint="field.hint" :persistent-hint="!!field.hint" type="number" :min="field.min" :max="field.max" :step="field.step" :density="density" @update:model-value="scheduleSave(field)">
                <template #label><span>{{ field.label }}</span><v-chip v-if="field.applyMode === 'restart' || field.requiresRestart" size="x-small" color="warning" class="ml-2">{{ t('settings.restartBadge') }}</v-chip></template>
              </v-text-field>
              <!-- boolean：开关 -->
              <v-switch v-else-if="field.type === 'boolean'" v-model="formValues[field.key]" :hint="field.hint" :persistent-hint="!!field.hint" color="primary" @update:model-value="scheduleSave(field)">
                <template #label><span>{{ field.label }}</span><v-chip v-if="field.applyMode === 'restart' || field.requiresRestart" size="x-small" color="warning" class="ml-2">{{ t('settings.restartBadge') }}</v-chip></template>
              </v-switch>
              <!-- string-list / number-list：多选 chips 自由输入 -->
              <v-combobox v-else v-model="formValues[field.key] as string[]" :hint="field.hint" :persistent-hint="!!field.hint" :density="density" multiple chips closable-chips @update:model-value="scheduleSave(field)">
                <template #label><span>{{ field.label }}</span><v-chip v-if="field.applyMode === 'restart' || field.requiresRestart" size="x-small" color="warning" class="ml-2">{{ t('settings.restartBadge') }}</v-chip></template>
              </v-combobox>
            </div>
          </div>
        </section>
      </div>
    </template>
    <v-alert v-else-if="!loading" type="info" variant="tonal">{{ t('settings.noGroups') }}</v-alert>
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
  /** 显式点击显示密码时从后端读取原值 */
  revealValue?: (key: string) => Promise<string>
}>()

const { t } = useI18n()
const snackbar = useSnackbarStore()
const formValues = reactive<Record<string, unknown>>({})
const revealed = reactive<Record<string, boolean>>({})
const revealedValues = reactive<Record<string, string>>({})
function isSecretField(field: ConfigField): boolean {
  return field.type === 'password'
}
function displayFormValue(field: ConfigField): string {
  const value = formValues[field.key]
  return value === null || value === undefined ? '' : String(value)
}
function toggleReveal(field: ConfigField): void {
  revealed[field.key] = !revealed[field.key]
  if (revealed[field.key] && isSecretField(field)) {
    revealedValues[field.key] = displayFormValue(field)
    if (props.revealValue) void props.revealValue(field.key).then((value) => {
      if (revealed[field.key]) {
        formValues[field.key] = value
        revealedValues[field.key] = value
      }
    }).catch(() => { /* 后端已脱敏时保留当前值 */ })
  }
}
const openPanels = ref<string[]>([])
const saving = ref(false)
const density = 'compact' as const
let saveTimer: ReturnType<typeof setTimeout> | undefined
const editedSinceSave = new Set<string>()
let disposed = false

function displayValue(field: ConfigField, raw: unknown): unknown {
  if (field.type === 'string-list' || field.type === 'number-list') return Array.isArray(raw) ? raw.map(String) : []
  return raw
}

function toSaveValue(field: ConfigField, raw: unknown): unknown {
  if (field.type === 'number') {
    if (raw === '' || raw === null || raw === undefined) return raw
    const n = Number(raw)
    return Number.isNaN(n) ? raw : n
  }
  if (field.type === 'number-list') return Array.isArray(raw) ? raw.map(Number) : raw
  return raw
}

function findField(key: string): ConfigField | undefined {
  for (const group of props.groups) for (const field of group.fields) if (field.key === key) return field
  return undefined
}

function mergeValues(v: Record<string, unknown>): void {
  for (const [key, raw] of Object.entries(v)) {
    if (editedSinceSave.has(key)) continue
    const field = findField(key)
    formValues[key] = field ? displayValue(field, raw) : raw
  }
}

function syncFromProps(): void {
  mergeValues(props.values)
  if (props.groups.length && !openPanels.value.length) openPanels.value = [props.groups[0]!.key]
}

function scheduleSave(field: ConfigField): void {
  editedSinceSave.add(field.key)
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { saveTimer = undefined; void save() }, 500)
}

async function save(): Promise<void> {
  if (saving.value) {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveTimer = undefined; void save() }, 200)
    return
  }
  saving.value = true
  const payload: Record<string, unknown> = {}
  for (const key of editedSinceSave) {
    const field = findField(key)
    if (field) payload[field.key] = toSaveValue(field, formValues[field.key])
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
  if (!disposed) {
    try { mergeValues(await props.refreshValues()) } catch { /* 对账失败不影响已保存值 */ }
  }
  editedSinceSave.clear()
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveTimer = undefined; void save() }, 100)
  }
}

watch(() => props.values, () => { if (!disposed) syncFromProps() }, { deep: true })
onMounted(() => { syncFromProps() })
onBeforeUnmount(() => { disposed = true; if (saveTimer) clearTimeout(saveTimer) })
</script>

<style scoped>
.config-groups { display: grid; gap: 18px; }
.config-group { overflow: hidden; }
.config-group-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 20px 22px 4px; }
.config-fields { padding: 16px 22px 22px; }
.config-field-wide { grid-column: 1 / -1; }
.secret-toggle { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: currentColor; cursor: pointer; }
.secret-toggle:hover, .secret-toggle:focus-visible { background: rgba(var(--v-theme-primary), 0.12); }
@media (max-width: 640px) {
  .config-group-head, .config-fields { padding-inline: 16px; }
  .config-field-wide { grid-column: auto; }
}
</style>
