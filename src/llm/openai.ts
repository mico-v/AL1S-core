/**
 * 极简 OpenAI 兼容客户端：原生 fetch + SSE 流式解析，实现 LLMProvider 契约。
 * 支持 function calling（工具），永不 throw —— 一切错误编码为 done(error) 事件。
 */
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMStreamEvent,
  LLMToolCall,
  LLMToolSchema,
} from './types';
import { logger } from '../logging/logger';
import { isValidToolName } from '../agent/tool-names';

const log = logger.child('llm');

/** OpenAI 兼容客户端构造参数 */
export interface OpenAIProviderOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** 把错误对象转成可读文本（AbortError 单独提示） */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.name === 'AbortError' ? '请求已取消' : err.message;
  return String(err);
}

/** 校验工具声明，避免把服务端 schema 错误伪装成不支持 tools。 */
function invalidTool(tool: LLMToolSchema): string | undefined {
  if (!isValidToolName(tool.name)) return `工具 ${tool.name}（模块：${tool.module ?? 'unknown'}）名称不符合 ^[a-zA-Z0-9_-]+$ 且长度必须 ≤64`;
  if (typeof tool.description !== 'string' || tool.description.trim().length === 0 || typeof tool.inputSchema !== 'object' || tool.inputSchema === null || Array.isArray(tool.inputSchema)) return `工具 ${tool.name}（模块：${tool.module ?? 'unknown'}）schema 非法`;
  return undefined;
}

/** LLMMessage → OpenAI 消息（assistant 的 tool_calls 与 tool 的 tool_call_id） */
function toOpenAIMessage(msg: LLMMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: msg.role, content: msg.content };
  if (msg.role === 'assistant' && msg.toolCalls) {
    out.tool_calls = msg.toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.arguments },
    }));
  }
  if (msg.role === 'tool') out.tool_call_id = msg.toolCallId ?? '';
  return out;
}

/** LLMToolSchema → OpenAI function 工具声明 */
function toOpenAITool(tool: LLMToolSchema): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

export class OpenAIProvider implements LLMProvider {
  private baseUrl: string;
  private apiKey?: string;
  private model: string;

  constructor(options: OpenAIProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, ''); // 去掉末尾斜杠，避免拼接出双斜杠
    this.apiKey = options.apiKey || undefined;
    this.model = options.model;
  }

  /** 运行时更新连接参数；正在进行的请求继续使用当前请求快照 */
  updateConfig(options: Partial<OpenAIProviderOptions>): void {
    if (typeof options.baseUrl === 'string' && options.baseUrl.trim()) this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    if (options.apiKey !== undefined) this.apiKey = options.apiKey || undefined;
    if (typeof options.model === 'string' && options.model.trim()) this.model = options.model;
    log.info('更新 LLM 配置', { baseUrl: this.baseUrl, model: this.model, hasApiKey: Boolean(this.apiKey) });
  }

  /** 运行时切换模型（管理后台热更新） */
  setModel(model: string): void {
    if (model && model !== this.model) {
      this.model = model;
      log.info('切换 LLM 模型', { model });
    }
  }

  async *streamChat(options: LLMChatOptions): AsyncIterable<LLMStreamEvent> {
    const { messages, tools, temperature, maxTokens, signal } = options;
    const hasTools = tools !== undefined && tools.length > 0;
    if (hasTools) {
      const seen = new Set<string>();
      const invalid = tools.map((tool) => {
        const reason = invalidTool(tool);
        if (reason) return reason;
        if (seen.has(tool.name)) return `工具 ${tool.name}（模块：${tool.module ?? 'unknown'}）名称重复`;
        seen.add(tool.name);
        return undefined;
      }).find((item): item is string => item !== undefined);
      if (invalid) {
        log.error('拒绝非法 LLM 工具 schema', { module: 'src/llm/openai.ts', detail: invalid });
        yield { type: 'done', message: { role: 'assistant', content: null }, error: invalid };
        return;
      }
    }
    log.debug('LLM 请求', {
      model: this.model,
      msgCount: messages.length,
      tools: hasTools ? tools?.length : 0,
      temperature,
      maxTokens,
    });

    if (hasTools) yield* this.requestOnce({ messages, tools, temperature, maxTokens, signal });
    else yield* this.requestOnce({ messages, temperature, maxTokens, signal });
  }

  /** 发起一次 /chat/completions 流式请求并解析 SSE 事件 */
  private async *requestOnce(opts: {
    messages: LLMMessage[];
    tools?: LLMToolSchema[];
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  }): AsyncIterable<LLMStreamEvent> {
    const { messages, tools, temperature, maxTokens, signal } = opts;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(toOpenAIMessage),
      max_tokens: maxTokens ?? 4096,
      stream: true,
    };
    // 仅在显式配置时发送 temperature；推理模型和新兼容接口通常拒绝该参数。
    if (temperature !== undefined) body.temperature = temperature;
    if (tools && tools.length > 0) {
      body.tools = tools.map(toOpenAITool);
      body.tool_choice = 'auto';
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      log.error('LLM 请求异常', { err });
      yield { type: 'done', message: { role: 'assistant', content: null }, error: describeError(err) };
      return;
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      log.error('LLM HTTP 错误', { status: res.status, detail: detail.slice(0, 300) });
      yield { type: 'done', message: { role: 'assistant', content: null }, error: `HTTP ${res.status}: ${detail.slice(0, 300)}` };
      return;
    }
    if (!res.body) {
      log.error('LLM 响应体为空');
      yield { type: 'done', message: { role: 'assistant', content: null }, error: '响应体为空' };
      return;
    }

    const startedAt = Date.now();

    // 聚合状态：累计文本 + 按 index 分片聚合 tool_calls（arguments 是增量拼接）
    let text = '';
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    // 解析一行 SSE：返回要对外发出的事件；'end' 表示 [DONE] 结束流
    const handleLine = (raw: string): LLMStreamEvent | 'end' | null => {
      const line = raw.trim();
      if (!line.startsWith('data:')) return null;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return 'end';
      let data: any;
      try {
        data = JSON.parse(payload);
      } catch {
        return null; // 跳过解析失败的碎片行
      }
      const delta = data?.choices?.[0]?.delta;
      if (!delta) return null;
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        text += delta.content;
        return { type: 'text', delta: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls as any[]) {
          const index = typeof tc?.index === 'number' ? tc.index : 0;
          const acc = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
          if (typeof tc?.id === 'string' && tc.id) acc.id = tc.id;
          if (typeof tc?.function?.name === 'string') acc.name += tc.function.name;
          if (typeof tc?.function?.arguments === 'string') acc.arguments += tc.function.arguments;
          toolCalls.set(index, acc);
        }
      }
      return null;
    };

    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let ended = false;

      while (!ended) {
        const read = await reader.read();
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const result = handleLine(line);
          if (result === 'end') {
            ended = true;
            break;
          }
          if (result) yield result;
          nl = buffer.indexOf('\n');
        }
      }

      // 流结束：逐个发出聚合好的 tool calls，最后发 done
      const calls: LLMToolCall[] = [...toolCalls.values()].map((c) => ({
        id: c.id,
        name: c.name,
        arguments: c.arguments,
      }));
      for (const call of calls) yield { type: 'tool-call', call };
      const message: LLMMessage = { role: 'assistant', content: text.length > 0 ? text : null };
      if (calls.length > 0) message.toolCalls = calls;
      log.debug('LLM 完成', { textChars: text.length, toolCalls: calls.length, ms: Date.now() - startedAt });
      yield { type: 'done', message };
    } catch (err) {
      log.error('LLM 读取流异常', { err });
      yield { type: 'done', message: { role: 'assistant', content: null }, error: describeError(err) };
    }
  }
}
