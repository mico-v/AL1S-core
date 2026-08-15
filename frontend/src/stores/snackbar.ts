import { defineStore } from 'pinia'
import { ref } from 'vue'

// 全局 snackbar 提示（在 AppLayout 中统一挂载，各页面通过 show 触发）
export const useSnackbarStore = defineStore('snackbar', () => {
  const visible = ref(false)
  const text = ref('')
  const color = ref<'success' | 'error' | 'info' | 'warning'>('success')
  let timer: ReturnType<typeof setTimeout> | undefined

  function show(
    message: string,
    c: 'success' | 'error' | 'info' | 'warning' = 'success',
    timeout = 3000,
  ): void {
    text.value = message
    color.value = c
    visible.value = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      visible.value = false
    }, timeout)
  }

  return { visible, text, color, show }
})
