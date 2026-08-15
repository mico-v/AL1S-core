<template>
  <v-snackbar v-model="snackbar.visible" :color="snackbar.color" :timeout="-1" location="top" class="mt-4">
    {{ snackbar.text }}
  </v-snackbar>
</template>

<script setup lang="ts">
import { useSnackbarStore } from '@/stores/snackbar'

// 全局 snackbar：由 AppLayout 挂载，页面通过 useSnackbarStore().show() 触发
const snackbar = useSnackbarStore()
</script>
