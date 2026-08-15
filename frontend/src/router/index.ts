import { createRouter, createWebHashHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import AppLayout from '@/components/AppLayout.vue'
import { getToken } from '@/api/client'

// hash 路由；受保护页放在 AppLayout 布局下，/login 单独成页
const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/pages/Login.vue'),
    meta: { public: true },
  },
  {
    path: '/',
    component: AppLayout,
    children: [
      { path: '', name: 'dashboard', component: () => import('@/pages/Dashboard.vue') },
      { path: 'settings', name: 'settings', component: () => import('@/pages/Settings.vue') },
      { path: 'plugins', name: 'plugins', component: () => import('@/pages/Plugins.vue') },
      { path: 'sessions', name: 'sessions', component: () => import('@/pages/Sessions.vue') },
      { path: 'logs', name: 'logs', component: () => import('@/pages/Logs.vue') },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

// 登录守卫：无 token 访问受保护页 → 登录页；已登录访问登录页 → 仪表盘
router.beforeEach((to) => {
  const hasToken = !!getToken()
  if (!to.meta.public && !hasToken) return { name: 'login' }
  if (to.name === 'login' && hasToken) return { name: 'dashboard' }
  return true
})

export default router
