// 主题模式 store：浅色/深色切换，localStorage 记忆，缺省跟随系统
// 注意：本 store 不调 useTheme()（setup store 运行在组件外，无法注入 Vuetify 主题），
// 主题应用由组件内 watch 本 store 的模式 + useTheme() 完成（见 AppLayout）。
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

export type ThemeMode = 'light' | 'dark'

const STORAGE_KEY = 'al1s-admin-theme'

/** 读取初始主题：localStorage 优先，其次跟随系统 */
export function readInitialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // localStorage 不可用（隐私模式等）→ 跟随系统
  }
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'dark'
  }
}

export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>(readInitialTheme())
  const isDark = computed(() => mode.value === 'dark')

  // 模式变化即持久化
  watch(mode, (m) => {
    try {
      localStorage.setItem(STORAGE_KEY, m)
    } catch {
      // 忽略
    }
  })

  function toggle(): void {
    mode.value = isDark.value ? 'light' : 'dark'
  }

  function setMode(m: ThemeMode): void {
    mode.value = m
  }

  return { mode, isDark, toggle, setMode }
})