<template>
  <v-navigation-drawer
    v-model="drawer"
    app
    :permanent="!mobile"
    :temporary="mobile"
    :rail="rail && !mobile"
    :width="272"
    rail-width="76"
    class="app-drawer"
  >
    <div class="app-brand px-4 py-4">
      <v-avatar color="primary" variant="tonal" size="40">
        <v-icon>mdi-robot-happy-outline</v-icon>
      </v-avatar>
      <div v-if="!rail || mobile" class="ml-3 overflow-hidden">
        <div class="text-subtitle-1 font-weight-bold text-truncate">AL1S 管理后台</div>
        <div class="text-caption text-medium-emphasis">Group AI Console</div>
      </div>
    </div>
    <v-divider />

    <v-list nav density="comfortable" class="app-nav pa-2">
      <div v-if="!rail || mobile" class="app-nav-label text-caption text-medium-emphasis px-3 pt-2 pb-1">
        {{ t('nav.main') }}
      </div>
      <v-tooltip v-for="item in staticItems" :key="item.to" location="right" :disabled="!rail || mobile">
        <template #activator="{ props }">
          <v-list-item
            v-bind="props"
            :to="item.to"
            :title="item.label"
            :prepend-icon="item.icon"
            :active="isActive(item.to)"
            :aria-label="item.label"
            @click="closeMobileDrawer"
          />
        </template>
        {{ item.label }}
      </v-tooltip>

      <v-divider class="my-3" />
      <v-list-group value="plugins" :model-value="rail && !mobile ? [] : openedGroups" no-action>
        <template #activator="{ props }">
          <v-tooltip location="right" :disabled="!rail || mobile">
            <template #activator="{ props: tooltipProps }">
              <v-list-item
                v-bind="{ ...props, ...tooltipProps }"
                prepend-icon="mdi-puzzle-outline"
                :title="t('nav.plugins')"
                :active="isPluginAreaActive"
                :aria-label="t('nav.plugins')"
              />
            </template>
            {{ t('nav.plugins') }}
          </v-tooltip>
        </template>
        <template v-if="!rail || mobile">
          <v-list-item
            :to="{ name: 'plugins' }"
            :title="t('plugins.all')"
            prepend-icon="mdi-view-grid-outline"
            :active="route.path === '/plugins'"
            @click="closeMobileDrawer"
          />
          <v-list-item
            v-for="p in pluginItems"
            :key="p.to"
            :to="p.to"
            :title="p.label"
            :prepend-icon="p.icon"
            :active="isActive(p.to)"
            @click="closeMobileDrawer"
          />
        </template>
      </v-list-group>

      <v-alert v-if="pluginLoadError && (!rail || mobile)" type="warning" variant="tonal" density="compact" class="mt-3 mx-2">
        插件导航加载失败
        <template #append>
          <v-btn icon="mdi-refresh" size="x-small" variant="text" aria-label="重新加载插件导航" @click="loadPlugins" />
        </template>
      </v-alert>
    </v-list>

    <template #append>
      <v-divider />
      <v-list nav density="comfortable" class="pa-2">
        <v-tooltip location="right" :disabled="!rail || mobile">
          <template #activator="{ props }">
            <v-list-item v-bind="props" prepend-icon="mdi-logout" :title="t('common.logout')" aria-label="退出登录" @click="logout" />
          </template>
          {{ t('common.logout') }}
        </v-tooltip>
      </v-list>
    </template>
  </v-navigation-drawer>

  <v-app-bar app flat class="app-bar px-1 px-sm-3">
    <v-app-bar-nav-icon aria-label="展开或收起导航" @click="toggleNavigation" />
    <v-btn v-if="!mobile" icon="mdi-chevron-left" variant="text" size="small" :aria-label="rail ? '展开侧栏' : '收起侧栏'" @click="rail = !rail" />
    <v-app-bar-title class="font-weight-bold text-truncate">{{ currentTitle }}</v-app-bar-title>
    <v-spacer />
    <v-btn icon variant="text" :aria-label="t('common.theme')" @click="themeStore.toggle()">
      <v-icon>{{ themeStore.isDark ? 'mdi-weather-night' : 'mdi-weather-sunny' }}</v-icon>
      <v-tooltip activator="parent" location="bottom">{{ t('common.theme') }}</v-tooltip>
    </v-btn>
    <v-btn v-if="!mobile" variant="tonal" color="primary" prepend-icon="mdi-logout" @click="logout">
      {{ t('common.logout') }}
    </v-btn>
  </v-app-bar>

  <v-main class="app-main">
    <v-container fluid class="app-content pa-3 pa-sm-5">
      <router-view />
    </v-container>
  </v-main>

  <GlobalSnackbar />
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useTheme, useDisplay } from 'vuetify'
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
const { mobile } = useDisplay()

const drawer = ref(true)
const rail = ref(false)
const pluginLoadError = ref(false)

const staticItems = computed(() => [
  { to: '/', label: t('nav.dashboard'), icon: 'mdi-view-dashboard-outline' },
  { to: '/settings', label: t('nav.settings'), icon: 'mdi-cog-outline' },
  { to: '/sessions', label: t('nav.sessions'), icon: 'mdi-chat-processing-outline' },
  { to: '/logs', label: t('nav.logs'), icon: 'mdi-text-box-outline' },
])

const plugins = ref<PluginItem[]>([])
const pluginItems = computed(() => plugins.value.map((p) => ({
  to: `/plugins/${encodeURIComponent(p.name)}`,
  label: p.displayName,
  icon: 'mdi-puzzle-outline',
})))

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
  try { localStorage.setItem('nav.opened', JSON.stringify(v)) } catch { /* 忽略 */ }
}, { deep: true })

function isActive(to: string): boolean {
  return to === '/' ? route.path === '/' : route.path === to || route.path.startsWith(to + '/')
}
const isPluginAreaActive = computed(() => route.path === '/plugins' || route.path.startsWith('/plugins/'))

const currentTitle = computed(() => {
  if (route.name === 'plugin-detail') {
    const p = plugins.value.find((x) => x.name === String(route.params.name ?? ''))
    return p ? p.displayName : t('nav.plugins')
  }
  const labels: Record<string, string> = {
    dashboard: t('nav.dashboard'), settings: t('nav.settings'), plugins: t('nav.plugins'), sessions: t('nav.sessions'), logs: t('nav.logs'),
  }
  return route.name ? labels[String(route.name)] ?? '' : ''
})

watch(() => themeStore.mode, (m) => { vuetifyTheme.global.name.value = m }, { immediate: true })
watch(mobile, (isMobile) => {
  if (isMobile) { drawer.value = false; rail.value = false }
  else drawer.value = true
})

async function loadPlugins(): Promise<void> {
  pluginLoadError.value = false
  const res = await api.getPlugins()
  if (res.ok && res.data) plugins.value = res.data.plugins
  else pluginLoadError.value = true
}

function closeMobileDrawer(): void {
  if (mobile.value) drawer.value = false
}
function toggleNavigation(): void {
  if (mobile.value) drawer.value = !drawer.value
  else rail.value = !rail.value
}
function logout(): void {
  auth.logout()
  void router.push({ name: 'login' })
}

onMounted(() => { void loadPlugins() })
</script>

<style scoped>
.app-brand { display: flex; align-items: center; min-height: 76px; }
.app-nav-label { letter-spacing: 0.04em; text-transform: uppercase; }
.app-drawer :deep(.v-navigation-drawer__content) { overflow-x: hidden; }
.app-bar { border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.1); background: rgba(var(--v-theme-surface), 0.92) !important; backdrop-filter: blur(14px); }
.app-main { background: rgb(var(--v-theme-containerBg)); }
.app-content { min-height: calc(100vh - 64px); max-width: 1600px; margin: 0 auto; }
</style>
