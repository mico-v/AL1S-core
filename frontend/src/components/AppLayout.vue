<template>
  <v-navigation-drawer v-model="drawer" app>
    <v-list>
      <v-list-item title="AL1S 管理后台" prepend-icon="mdi-robot-happy-outline" />
      <v-divider />
      <v-list-item
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        :title="item.label"
        :prepend-icon="item.icon"
      />
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
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import GlobalSnackbar from '@/components/GlobalSnackbar.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const drawer = ref(true)

const navItems = computed(() => [
  { to: '/', label: t('nav.dashboard'), icon: 'mdi-view-dashboard-outline' },
  { to: '/settings', label: t('nav.settings'), icon: 'mdi-cog-outline' },
  { to: '/plugins', label: t('nav.plugins'), icon: 'mdi-puzzle-outline' },
  { to: '/sessions', label: t('nav.sessions'), icon: 'mdi-chat-processing-outline' },
  { to: '/logs', label: t('nav.logs'), icon: 'mdi-text-box-outline' },
])

const currentTitle = computed(() => {
  const labels: Record<string, string> = {
    dashboard: t('nav.dashboard'),
    settings: t('nav.settings'),
    plugins: t('nav.plugins'),
    sessions: t('nav.sessions'),
    logs: t('nav.logs'),
  }
  return route.name ? labels[String(route.name)] ?? '' : ''
})

function logout(): void {
  auth.logout()
  void router.push({ name: 'login' })
}
</script>
