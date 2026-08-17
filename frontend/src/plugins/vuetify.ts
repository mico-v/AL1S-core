import { createVuetify } from 'vuetify'
import type { ThemeDefinition } from 'vuetify'
import 'vuetify/styles'
import { zhHans } from 'vuetify/locale'
import { readInitialTheme } from '@/stores/theme'

// Vuetify 双主题：浅色/深色（AstrBot 风格色板 + containerBg 等自定义 token，
// 供 global.css 通过 rgb(var(--v-theme-*)) 引用）。默认主题读取本地存储/系统偏好。
const lightTheme: ThemeDefinition = {
  dark: false,
  colors: {
    primary: '#3c96ca',
    secondary: '#2f86bd',
    accent: '#FFB74D',
    error: '#f44336',
    warning: '#ffc107',
    info: '#03c9d7',
    success: '#00c853',
    // 自定义 token：软色块 / 文字 / 边框 / 内容区底色
    lightprimary: '#eef2f6',
    lightsecondary: '#e8f3fa',
    lightsuccess: '#b9f6ca',
    lighterror: '#f9d8d8',
    lightwarning: '#fff8e1',
    primaryText: '#1b1c1d',
    secondaryText: '#000000aa',
    darkprimary: '#1565c0',
    darksecondary: '#236b99',
    borderLight: '#d0d0d0',
    border: '#d0d0d0',
    inputBorder: '#787878',
    containerBg: '#fffffff4',
    overlay: '#ffffffaa',
    codeBg: '#ececec',
    preBg: '#f9f9f9',
    code: '#0d0d0d',
    chatMessageBubble: '#e7ebf4',
    mcpCardBg: '#ecf2fa',
  },
}

const darkTheme: ThemeDefinition = {
  dark: true,
  colors: {
    primary: '#5ba4d4',
    secondary: '#4a95c4',
    accent: '#FFB74D',
    error: '#ff4d4f',
    warning: '#faad14',
    info: '#03c9d7',
    success: '#52c41a',
    lightprimary: '#1a2e3d',
    lightsecondary: '#1a2e3d',
    lightsuccess: '#1a3a1a',
    lighterror: '#3d1a1a',
    lightwarning: '#3d351a',
    primaryText: '#e8eaed',
    secondaryText: '#ffffffdd',
    darkprimary: '#3a8ab8',
    darksecondary: '#3a8ab8',
    borderLight: '#3a3a3a',
    border: '#333333ee',
    inputBorder: '#787878',
    containerBg: '#1a1a1a',
    overlay: '#111111aa',
    surface: '#242424',
    background: '#1a1a1a',
    codeBg: '#282833',
    preBg: '#171717',
    code: '#ffffffdd',
    chatMessageBubble: '#2d2e30',
    mcpCardBg: '#2a2a2a',
  },
}

export const vuetify = createVuetify({
  theme: {
    defaultTheme: readInitialTheme(),
    themes: { light: lightTheme, dark: darkTheme },
  },
  locale: {
    locale: 'zhHans',
    fallback: 'en',
    messages: { zhHans },
  },
})