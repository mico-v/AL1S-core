import { createVuetify } from 'vuetify'
import type { ThemeDefinition } from 'vuetify'
import 'vuetify/styles'
import { zhHans } from 'vuetify/locale'

// Vuetify 实例：暗色主题 + Material Design Icons + 中文语言包
// （组件/指令由 vite-plugin-vuetify 的 autoImport 自动注入）
const darkTheme: ThemeDefinition = {
  dark: true,
  colors: {
    primary: '#26A69A',
    secondary: '#546E7A',
    accent: '#FFB74D',
    error: '#EF5350',
    warning: '#FFA726',
    info: '#42A5F5',
    success: '#66BB6A',
    background: '#121212',
    surface: '#1E1E1E',
  },
}

export const vuetify = createVuetify({
  theme: {
    defaultTheme: 'dark',
    themes: { dark: darkTheme },
  },
  locale: {
    locale: 'zhHans',
    fallback: 'en',
    messages: { zhHans },
  },
})
