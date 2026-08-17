<template>
  <v-main class="login-page d-flex align-center justify-center">
    <div class="login-glow login-glow-one" />
    <div class="login-glow login-glow-two" />
    <v-sheet class="login-card pa-6 pa-sm-8" width="420" rounded="xl" elevation="0">
      <div class="text-center mb-6">
        <v-avatar color="primary" variant="tonal" size="64" class="mb-3"><v-icon size="34">mdi-robot-happy-outline</v-icon></v-avatar>
        <h1 class="text-h5 font-weight-bold">{{ t('login.title') }}</h1>
        <p class="text-body-2 text-medium-emphasis mt-2">{{ t('login.subtitle') }}</p>
      </div>
      <v-form @submit.prevent="submit">
        <v-text-field v-model="token" :label="t('login.tokenLabel')" :placeholder="t('login.tokenPlaceholder')" :type="showToken ? 'text' : 'password'" :append-inner-icon="showToken ? 'mdi-eye-off-outline' : 'mdi-eye-outline'" :disabled="loading" autocomplete="off" class="mb-2" @click:append-inner="showToken = !showToken" />
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{ error }}</v-alert>
        <v-btn type="submit" color="primary" block size="large" :loading="loading" class="login-submit">{{ t('login.submit') }}</v-btn>
        <p class="text-caption text-medium-emphasis mt-4 mb-0 text-center">{{ t('login.hint') }}</p>
      </v-form>
    </v-sheet>
  </v-main>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()
const token = ref('')
const showToken = ref(false)
const loading = ref(false)
const error = ref('')
async function submit(): Promise<void> {
  if (!token.value.trim()) { error.value = t('login.errorRequired'); return }
  loading.value = true; error.value = ''
  const ok = await auth.login(token.value)
  loading.value = false
  if (ok) void router.push({ name: 'dashboard' })
  else error.value = t('login.errorInvalid')
}
</script>

<style scoped>
.login-page { position: relative; min-height: 100vh; overflow: hidden; background: radial-gradient(circle at 15% 15%, rgba(var(--v-theme-primary), 0.16), transparent 35%), rgb(var(--v-theme-containerBg)); }
.login-card { position: relative; z-index: 1; width: min(420px, calc(100vw - 32px)); border: 1px solid rgba(var(--v-theme-on-surface), 0.12); background: rgba(var(--v-theme-surface), 0.88); box-shadow: 0 24px 70px rgba(25, 60, 90, 0.14); backdrop-filter: blur(18px); }
.login-submit { box-shadow: 0 8px 18px rgba(var(--v-theme-primary), 0.22); }
.login-glow { position: absolute; width: 280px; height: 280px; border-radius: 50%; background: rgba(var(--v-theme-primary), 0.1); filter: blur(8px); }
.login-glow-one { top: -110px; right: -70px; }
.login-glow-two { bottom: -140px; left: -90px; opacity: 0.7; }
</style>
