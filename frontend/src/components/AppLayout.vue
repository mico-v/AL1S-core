<template>
  <v-navigation-drawer v-model="drawer" app>
    <v-list nav density="compact" class="pa-2">
      <v-list-item title="AL1S 管理后台" prepend-icon="mdi-robot-happy-outline" />
      <v-divider />

      <!-- 主菜单 -->
      <div class="text-caption text-medium-emphasis px-3 pt-2">{{ t('nav.main') }}</div>
      <v-list-item
        v-for="item in staticItems"
        :key="item.to"
        :to="item.to"
        :title="item.label"
        :prepend-icon="item.icon"
        :active="isActive(item.to)"
      />

      <v-divider class="my-2" />

      <!-- 插件目录：全部插件 + 各插件子项（动态来自 API） -->
      <v-list-group value="plugins" v-model="openedGroups" no-action>
        <template #activator="{ props }">
          <v-list-item
            v-bind="props"
            prepend-icon="mdi-puzzle-outline"
            :title="t('nav.plugins')"
            :active="isPluginAreaActive"
          />
        </template>
        <v-list-item
          :to="{ name: 'plugins' }"
          :title="t('plugins.all')"
          prepend-icon="mdi-view-grid-outline"
          :active="route.path === '/plugins'"
        />
        <v-list-item
          v-for="p in pluginItems"
          :key="p.to"
          :to="p.to"
          :title="p.label"
          :prepend-icon="p.icon"
          :active="isActive(p.to)"
        />
      </v-list-group>
    </v-list>

    <template #append>
      <v-divider />
      <v-list-item prepend-icon="mdi-logout" title="退出登录" @click="logout" />
    </template>
  </v-navigation-drawer>

  <v-app-bar app>
    <v-app-bar-nav-icon @click="drawer = !drawer" />
    <v-app-bar-title>{{ currentTitle }}</v-app-bar-title>
    <v-spacer />
    <v-btn variant="text" icon @click="themeStore.toggle()" :aria-label="t('common.theme')">
      <v-icon>{{ themeStore.isDark ? 'mdi-weather-night' : 'mdi-weather-sunny' }}</v-icon>
    </v-btn>
    <v-btn variant="text" prepend-icon="mdi-logout" @click="logout">
      {{ t('common.logout') }}
    </v-btn>
  </v-app-bar>

  <v-main>
    <v-container fluid class="pa-4">
      <router-view />
    </v-container>
  </v-main>

  <GlobalSnackbar />
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useTheme } from 'vuetify'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'
import { api } from '@/api/client'
import type { PluginItem } from '@/api/types'
import GlobalSnackbar from '@/components/GlobalSnackbar.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const themeStore = useThemeStore()
const vuetifyTheme = useTheme()

const drawer = ref(true)

// 固定导航项（插件有独立目录）
const staticItems = computed(() => [
  { to: '/', label: t('nav.dashboard'), icon: 'mdi-view-dashboard-outline' },
  { to: '/settings', label: t('nav.settings'), icon: 'mdi-cog-outline' },
  { to: '/sessions', label: t('nav.sessions'), icon: 'mdi-chat-processing-outline' },
  { to: '/logs', label: t('nav.logs'), icon: 'mdi-text-box-outline' },
])

// 动态插件目录
const plugins = ref<PluginItem[]>([])
const pluginItems = computed(() =>
  plugins.value.map((p) => ({
    to: `/plugins/${encodeURIComponent(p.name)}`,
    label: p.displayName,
    icon: 'mdi-puzzle-outline',
  })),
)

// 插件目录展开状态持久化
const openedGroups = ref<string[]>(readOpened())
function readOpened(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem('nav.opened') ?? '["plugins"]') as unknown
    return Array.isArray(raw) ? (raw as string[]) : ['plugins']
  } catch {
    return ['plugins']
  }
}
watch(openedGroups, (v) => {
  try {
    localStorage.setItem('nav.opened', JSON.stringify(v))
  } catch {
    // 忽略
  }
}, { deep: true })

/** 路由高亮：精确路径或前缀匹配（/plugins/:name 也要高亮） */
function isActive(to: string): boolean {
  return to === '/' ? route.path === '/' : route.path === to || route.path.startsWith(to + '/')
}
const isPluginAreaActive = computed(
  () => route.path === '/plugins' || route.path.startsWith('/plugins/'),
)

const currentTitle = computed(() => {
  if (route.name === 'plugin-detail') {
    const p = plugins.value.find((x) => x.name === String(route.params.name ?? ''))
    return p ? p.displayName : t('nav.plugins')
  }
  const labels: Record<string, string> = {
    dashboard: t('nav.dashboard'),
    settings: t('nav.settings'),
    plugins: t('nav.plugins'),
    sessions: t('nav.sessions'),
    logs: t('nav.logs'),
  }
  return route.name ? labels[String(route.name)] ?? '' : ''
})

// 浅/深主题：store 模式 → Vuetify 全局主题名
watch(
  () => themeStore.mode,
  (m) => {
    vuetifyTheme.global.name.value = m
  },
  { immediate: true },
)

// 拉插件列表填充目录
onMounted(async () => {
  const res = await api.getPlugins()
  if (res.ok && res.data) plugins.value = res.data.plugins
})

function logout(): void {
  auth.logout()
  void router.push({ name: 'login' })
}
</script>