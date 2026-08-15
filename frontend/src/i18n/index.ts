import { createI18n } from 'vue-i18n'
import zh from './zh'

// 全局 i18n：目前仅中文，使用 Composition 模式（legacy: false）
export const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages: {
    'zh-CN': zh,
  },
})
