/**
 * Matrix bridge 的进程内 Prometheus 指标。
 *
 * 只接受固定标签集合，避免把用户、房间或消息标识带入指标基数。
 */

export type AppserviceRoute = 'health' | 'ping' | 'transactions' | 'metrics' | 'unknown';
export type AppserviceResult = 'success' | 'unauthorized' | 'invalid' | 'error';
export type TransactionResult = 'success' | 'duplicate' | 'error';
export type MatrixEventResult = 'processed' | 'duplicate' | 'error';
export type QqMessageKind = 'group' | 'c2c' | 'guild' | 'dm' | 'other';
export type QqMessageResult = 'forwarded' | 'duplicate' | 'ignored' | 'error';
export type QqSendResult = 'success' | 'error';
export type QqRecoveryReason = 'passive_unavailable' | 'rate_limited';
export type MediaDirection = 'qq_to_matrix' | 'matrix_to_qq';
export type StateWriteResult = 'success' | 'error';

interface MetricDefinition {
  name: string;
  type: 'counter' | 'gauge';
  help: string;
}

interface MetricSeries {
  labels: Record<string, string>;
  value: number;
}

const DEFINITIONS: MetricDefinition[] = [
  {
    name: 'al1s_matrix_bridge_appservice_requests_total',
    type: 'counter',
    help: 'Appservice HTTP requests by route and result.',
  },
  {
    name: 'al1s_matrix_bridge_appservice_transactions_total',
    type: 'counter',
    help: 'Matrix appservice transactions by result.',
  },
  {
    name: 'al1s_matrix_bridge_matrix_events_total',
    type: 'counter',
    help: 'Matrix events processed from appservice transactions.',
  },
  {
    name: 'al1s_matrix_bridge_qq_messages_total',
    type: 'counter',
    help: 'Inbound QQ messages by conversation kind and result.',
  },
  {
    name: 'al1s_matrix_bridge_qq_send_total',
    type: 'counter',
    help: 'Outbound QQ send operations by conversation kind and result.',
  },
  {
    name: 'al1s_matrix_bridge_qq_recovery_total',
    type: 'counter',
    help: 'QQ send recovery actions by conversation kind and reason.',
  },
  {
    name: 'al1s_matrix_bridge_media_bytes_total',
    type: 'counter',
    help: 'Media bytes forwarded by direction.',
  },
  {
    name: 'al1s_matrix_bridge_state_writes_total',
    type: 'counter',
    help: 'Bridge state persistence attempts by result.',
  },
  {
    name: 'al1s_matrix_bridge_last_error_timestamp_seconds',
    type: 'gauge',
    help: 'Unix timestamp of the most recent bridge error.',
  },
  {
    name: 'al1s_matrix_bridge_last_successful_transaction_timestamp_seconds',
    type: 'gauge',
    help: 'Unix timestamp of the most recent successful Matrix transaction.',
  },
  {
    name: 'al1s_matrix_bridge_last_successful_state_write_timestamp_seconds',
    type: 'gauge',
    help: 'Unix timestamp of the most recent successful bridge state write.',
  },
];

const DEFINITION_BY_NAME = new Map(DEFINITIONS.map((definition) => [definition.name, definition]));

function labelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}\0${value}`)
    .join('\0');
}

function seriesKey(name: string, labels: Record<string, string>): string {
  return `${name}\0${labelKey(labels)}`;
}

function renderLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return '';
  }
  const rendered = entries
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(',');
  return `{${rendered}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function renderNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return String(value);
}

export class BridgeMetrics {
  private readonly counters = new Map<string, MetricSeries>();
  private readonly gauges = new Map<string, MetricSeries>();
  private readonly startedAtSeconds: number;
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.startedAtSeconds = this.now() / 1000;
    this.setGauge('al1s_matrix_bridge_last_error_timestamp_seconds', 0);
    this.setGauge(
      'al1s_matrix_bridge_last_successful_transaction_timestamp_seconds',
      0,
    );
    this.setGauge(
      'al1s_matrix_bridge_last_successful_state_write_timestamp_seconds',
      0,
    );
  }

  recordAppserviceRequest(route: AppserviceRoute, result: AppserviceResult): void {
    this.increment('al1s_matrix_bridge_appservice_requests_total', { route, result });
  }

  recordTransaction(result: TransactionResult): void {
    this.increment('al1s_matrix_bridge_appservice_transactions_total', { result });
    if (result === 'success') {
      this.setGauge(
        'al1s_matrix_bridge_last_successful_transaction_timestamp_seconds',
        this.now() / 1000,
      );
    }
  }

  recordMatrixEvent(result: MatrixEventResult): void {
    this.increment('al1s_matrix_bridge_matrix_events_total', { result });
  }

  recordQqMessage(kind: QqMessageKind, result: QqMessageResult): void {
    this.increment('al1s_matrix_bridge_qq_messages_total', { kind, result });
  }

  recordQqSend(kind: QqMessageKind, result: QqSendResult): void {
    this.increment('al1s_matrix_bridge_qq_send_total', { kind, result });
  }

  recordQqRecovery(kind: QqMessageKind, reason: QqRecoveryReason): void {
    this.increment('al1s_matrix_bridge_qq_recovery_total', { kind, reason });
  }

  addMediaBytes(direction: MediaDirection, bytes: number): void {
    if (bytes > 0) {
      this.increment('al1s_matrix_bridge_media_bytes_total', { direction }, bytes);
    }
  }

  recordStateWrite(result: StateWriteResult): void {
    this.increment('al1s_matrix_bridge_state_writes_total', { result });
    if (result === 'success') {
      this.setGauge(
        'al1s_matrix_bridge_last_successful_state_write_timestamp_seconds',
        this.now() / 1000,
      );
    }
  }

  recordError(): void {
    this.setGauge('al1s_matrix_bridge_last_error_timestamp_seconds', this.now() / 1000);
  }

  render(): string {
    const lines: string[] = [
      '# HELP al1s_matrix_bridge_up Whether the bridge process is serving metrics.',
      '# TYPE al1s_matrix_bridge_up gauge',
      'al1s_matrix_bridge_up 1',
      '# HELP al1s_matrix_bridge_uptime_seconds Bridge process uptime in seconds.',
      '# TYPE al1s_matrix_bridge_uptime_seconds gauge',
      `al1s_matrix_bridge_uptime_seconds ${renderNumber(
        Math.max(0, this.now() / 1000 - this.startedAtSeconds),
      )}`,
    ];

    for (const definition of DEFINITIONS) {
      lines.push(`# HELP ${definition.name} ${definition.help}`);
      lines.push(`# TYPE ${definition.name} ${definition.type}`);
      const values = definition.type === 'counter' ? this.counters : this.gauges;
      const prefix = `${definition.name}\0`;
      const series = [...values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, value]) => value)
        .sort((left, right) => labelKey(left.labels).localeCompare(labelKey(right.labels)));
      for (const value of series) {
        lines.push(
          `${definition.name}${renderLabels(value.labels)} ${renderNumber(value.value)}`,
        );
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private increment(
    name: string,
    labels: Record<string, string>,
    amount = 1,
  ): void {
    if (!DEFINITION_BY_NAME.has(name)) {
      throw new Error(`未定义的 bridge 指标：${name}`);
    }
    const key = seriesKey(name, labels);
    const current = this.counters.get(key);
    if (current === undefined) {
      this.counters.set(key, { labels, value: amount });
    } else {
      current.value += amount;
    }
  }

  private setGauge(name: string, value: number): void {
    if (!DEFINITION_BY_NAME.has(name)) {
      throw new Error(`未定义的 bridge 指标：${name}`);
    }
    const labels = {};
    this.gauges.set(seriesKey(name, labels), { labels, value });
  }
}
