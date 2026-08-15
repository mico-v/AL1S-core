<template>
  <v-main class="d-flex align-center justify-center fill-height">
    <v-sheet class="pa-8 rounded-lg" width="420">
      <div class="text-center mb-6">
        <v-icon size="48" color="primary" class="mb-2">mdi-robot-happy-outline</v-icon>
        <h1 class="text-h5">{{ t('login.title') }}</h1>
        <p class="text-caption text-medium-emphasis mt-1">{{ t('login.subtitle') }}</p>
      </div>

      <v-form @submit.prevent="submit">
        <v-text-field
          v-model="token"
          :label="t('login.tokenLabel')"
          :placeholder="t('login.tokenPlaceholder')"
          :type="showToken ? 'text' : 'password'"
          :append-inner-icon="showToken ? 'mdi-eye-off-outline' : 'mdi-eye-outline'"
          :disabled="loading"
          autocomplete="off"
          @click:append-inner="showToken = !showToken"
        />

        <v-alert v-if="error" type="error" density="compact" class="mb-3">
          {{ error }}
        </v-alert>

        <v-btn type="submit" color="primary" block :loading="loading" class="mt-2">
          {{ t('login.submit') }}
        </v-btn>

        <p class="text-caption text-medium-emphasis mt-3 text-center">{{ t('login.hint') }}</p>
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

// 输入 token → 存 localStorage → GET /api/status 验证 → 进入仪表盘
async function submit(): Promise<void> {
  if (!token.value.trim()) {
    error.value = t('login.errorRequired')
    return
  }
  loading.value = true
  error.value = ''
  const ok = await auth.login(token.value)
  loading.value = false
  if (ok) {
    void router.push({ name: 'dashboard' })
  } else {
    error.value = t('login.errorInvalid')
  }
}
</script>
