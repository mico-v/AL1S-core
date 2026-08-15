// SSE 日志流封装：EventSource + snapshot/log 事件 + 自动重连（Last-Event-ID 续传）
import { API_BASE, getToken } from './client'
import type { LogRecord } from './types'

export type LogStreamState = 'connecting' | 'open' | 'closed'

/**
 * 日志实时流。
 *
 * 连接后服务端先推送 `snapshot`（历史缓冲 LogRecord[]），随后逐条推送 `log`。
 * 断线续传依赖 Last-Event-ID：
 *   - 服务端在每条事件上附带 `id: <日志 time>` 字段；
 *   - 浏览器原生 EventSource 在自动重连时会携带 `Last-Event-ID` 请求头；
 *   - 后端据此从断点继续推流。
 * `lastEventId` 属性在客户端侧记录最近一条日志的 time，便于调试与自定义续传。
 */
export class LogStream {
  private es: EventSource | null = null
  private currentState: LogStreamState = 'closed'

  /** 最近一条日志的 time，可作为 Last-Event-ID 断点值 */
  lastEventId = ''

  /** 当前连接状态 */
  get state(): LogStreamState {
    return this.currentState
  }

  /** 连接时的历史缓冲快照（整体替换视图） */
  onSnapshot?: (records: LogRecord[]) => void
  /** 每条新日志 */
  onLog?: (record: LogRecord) => void
  /** 连接状态变化 */
  onStateChange?: (state: LogStreamState) => void

  connect(): void {
    this.close()
    this.setState('connecting')

    const es = new EventSource(`${API_BASE}/logs/stream?token=${encodeURIComponent(getToken() ?? '')}`)
    this.es = es

    es.addEventListener('open', () => {
      this.setState('open')
    })

    es.addEventListener('error', () => {
      // 浏览器原生 EventSource 会自动重连；若原生已放弃（CLOSED），
      // 则手动重连兜底，保证"自动重连"不中断。
      this.setState('connecting')
      if (es.readyState === EventSource.CLOSED) {
        setTimeout(() => {
          if (this.es === es) this.connect()
        }, 3000)
      }
    })

    es.addEventListener('snapshot', (event) => {
      const records = JSON.parse((event as MessageEvent).data) as LogRecord[]
      this.onSnapshot?.(records)
    })

    es.addEventListener('log', (event) => {
      const record = JSON.parse((event as MessageEvent).data) as LogRecord
      this.lastEventId = record.time
      this.onLog?.(record)
    })
  }

  close(): void {
    this.es?.close()
    this.es = null
    this.setState('closed')
  }

  private setState(s: LogStreamState): void {
    this.currentState = s
    this.onStateChange?.(s)
  }
}
