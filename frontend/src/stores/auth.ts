import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, clearToken, getToken, setToken } from '@/api/client'

// 登录态：token 持久化在 localStorage['admin_token']，进入时用 GET /api/status 验证
export const useAuthStore = defineStore('auth', () => {
  const token = ref(getToken() ?? '')
  const validated = ref(false)
  const nickname = ref<string | null>(null)
  const connected = ref(false)

  const isLoggedIn = computed(() => token.value !== '')

  /** 保存 token 并调用 GET /api/status 验证；成功返回 true */
  async function login(newToken: string): Promise<boolean> {
    const t = newToken.trim()
    if (!t) return false
    setToken(t)
    token.value = t

    const res = await api.status()
    if (res.ok && res.data) {
      validated.value = true
      nickname.value = res.data.botNickname ?? res.data.login?.nickname ?? null
      connected.value = res.data.connected
      return true
    }
    // 验证失败：清掉 token，回登录页
    clearToken()
    token.value = ''
    validated.value = false
    nickname.value = null
    return false
  }

  function logout(): void {
    clearToken()
    token.value = ''
    validated.value = false
    nickname.value = null
    connected.value = false
  }

  return { token, validated, nickname, connected, isLoggedIn, login, logout }
})
