// 统一 fetch 封装：Bearer 鉴权 / {ok,data?,error?} 包裹 / 401 拦截跳登录
import type {
  ApiResponse,
  ConfigSaveResult,
  ConfigSchema,
  ConfigValues,
  LogsData,
  PluginConfig,
  PluginsData,
  SessionDetail,
  SessionsData,
  StatusData,
} from './types'

export const TOKEN_KEY = 'admin_token'
export const API_BASE = '/api'

/** 读取 localStorage 中的 admin token（失败返回 null） */
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

/** 401 时跳转到登录页（hash 路由） */
function redirectToLogin(): void {
  if (!window.location.hash.startsWith('#/login')) {
    window.location.hash = '#/login'
  }
}

interface RequestOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>
}

/**
 * 基础请求封装。所有 /api/* 接口都走这里：
 * - 自动带上 Authorization: Bearer <token>
 * - 统一返回 {ok,data?,error?}
 * - 401 清 token 并跳登录页
 * - 网络错误 / 非 JSON 响应都收敛为 ok=false + error
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers ?? {}),
  }
  if (token) headers.Authorization = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, { ...options, headers })
  } catch (err) {
    // 网络层失败（后端未就绪 / 断网）
    return { ok: false, error: `网络请求失败：${err instanceof Error ? err.message : String(err)}` }
  }

  if (res.status === 401) {
    clearToken()
    redirectToLogin()
    return { ok: false, error: '未授权，请重新登录' }
  }

  let body: ApiResponse<T>
  try {
    body = (await res.json()) as ApiResponse<T>
  } catch {
    return { ok: false, error: `HTTP ${res.status}：响应不是合法 JSON` }
  }

  if (!res.ok) {
    return { ok: false, error: body.error ?? `HTTP ${res.status}` }
  }
  return body
}

/** 把可选查询参数拼成 query string（undefined / 空值跳过） */
function toQuery(params?: Record<string, string | number | undefined>): string {
  if (!params) return ''
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') usp.set(k, String(v))
  }
  const s = usp.toString()
  return s ? `?${s}` : ''
}

const get = <T>(path: string): Promise<ApiResponse<T>> => request<T>(path)
const post = <T>(path: string, body?: unknown): Promise<ApiResponse<T>> =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
const put = <T>(path: string, body?: unknown): Promise<ApiResponse<T>> =>
  request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) })
const del = <T>(path: string): Promise<ApiResponse<T>> => request<T>(path, { method: 'DELETE' })

export interface PluginTogglePayload {
  kind: 'command' | 'skill'
  name: string
  enabled: boolean
}

/** 全部管理接口 —— 命名与路径严格对照 frontend/API.md */
export const api = {
  status: (): Promise<ApiResponse<StatusData>> => get('/status'),
  getConfig: (): Promise<ApiResponse<ConfigValues>> => get('/config'),
  updateConfig: (values: Record<string, unknown>): Promise<ApiResponse<ConfigSaveResult>> =>
    put('/config', { values }),
  getConfigSchema: (): Promise<ApiResponse<ConfigSchema>> => get('/config/schema'),
  getPlugins: (): Promise<ApiResponse<PluginsData>> => get('/plugins'),
  setPluginEnabled: (payload: PluginTogglePayload): Promise<ApiResponse<{ ok: boolean }>> =>
    put('/plugins/enabled', payload),
  getPluginConfig: (name: string): Promise<ApiResponse<PluginConfig>> =>
    get(`/plugins/${encodeURIComponent(name)}/config`),
  updatePluginConfig: (name: string, values: Record<string, unknown>): Promise<ApiResponse<ConfigSaveResult>> =>
    put(`/plugins/${encodeURIComponent(name)}/config`, { values }),
  getSessions: (): Promise<ApiResponse<SessionsData>> => get('/sessions'),
  getSessionMessages: (chatId: string): Promise<ApiResponse<SessionDetail>> =>
    get(`/sessions/${encodeURIComponent(chatId)}`),
  clearSession: (chatId: string): Promise<ApiResponse<{ ok: boolean }>> =>
    del(`/sessions/${encodeURIComponent(chatId)}`),
  getLogs: (params?: { level?: string; tag?: string; limit?: number }): Promise<ApiResponse<LogsData>> =>
    get(`/logs${toQuery(params)}`),
  restart: (): Promise<ApiResponse<{ ok: boolean; message: string }>> => post('/system/restart'),
}
