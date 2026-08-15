/**
 * 可开关的 LLM 输出格式化层（对应 astrbot_plugin_al1s_core 的 on_llm_response + on_decorating_result）。
 * 由 bot.ts 依据配置构造并注入 pipeline；未开启时 pipeline 走原有分条逻辑。
 */
import type { Al1sFormatConfig } from '../config';
import { buildSegments, calcDelay, cleanText, renderSegment, type Segment } from './output-spec';

/** 格式化层对外契约（pipeline 依赖此接口，方便替换/禁用） */
export interface OutputFormatter {
  readonly enabled: boolean;
  readonly globalMarkdownKiller: boolean;
  readonly lineSplit: boolean;
  /** 去除 Markdown 语法（作用于 LLM 输出原文，分段之前） */
  cleanText(text: string): string;
  /** 按空行/结构切段 */
  buildSegments(text: string): Segment[];
  /** 单段发送延时（秒）；disabled 或无需延时时为 0 */
  segmentDelay(seg: Segment): number;
  /** 把某段渲染为最终发送文本（表格对齐、框线清洗） */
  renderSegment(seg: Segment): string;
}

/** 依据 Al1sFormatConfig 实现的格式化层。
 *  持有的是 ConfigStore 中同一个可变 al1sFormat 对象引用，各开关用 getter 现读 → 运行时热切换。 */
export class Al1sFormatter implements OutputFormatter {
  private readonly cfg: Al1sFormatConfig;

  constructor(cfg: Al1sFormatConfig) {
    this.cfg = cfg;
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  get globalMarkdownKiller(): boolean {
    return this.cfg.globalMarkdownKiller;
  }

  get lineSplit(): boolean {
    return this.cfg.lineSplit;
  }

  cleanText(text: string): string {
    return cleanText(text);
  }

  buildSegments(text: string): Segment[] {
    return buildSegments(text);
  }

  segmentDelay(seg: Segment): number {
    return calcDelay(seg.text, {
      charsPerSecond: this.cfg.charsPerSecond,
      minDelay: this.cfg.minDelay,
      maxDelay: this.cfg.maxDelay,
    });
  }

  renderSegment(seg: Segment): string {
    return renderSegment(seg);
  }
}
