/**
 * agent loop：pi 风格的最小循环。
 * 每一轮调用 provider 流式生成；若模型请求工具调用则依次执行对应 skill、
 * 把结果回填为 tool 消息后进入下一轮，直到无工具调用或达到轮数上限。
 */
import type { LLMProvider, LLMMessage, LLMToolCall } from '../llm/types';
import type { BotConfig } from '../config';
import { validateArgs, type Skill, type SkillRunContext } from '../skills/registry';
import { logger } from '../logging/logger';
import { getToolName, isValidToolName } from './tool-names';

const log = logger.child('agent');

/** agent loop 参数 */
export interface AgentLoopParams {
  provider: LLMProvider;
  skills: Skill[];
  messages: LLMMessage[];
  maxIterations: number;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  // 契约扩展：工具执行上下文（集成方传入，Skill.run 需要）
  chatId?: string;
  senderId?: number;
  senderName?: string;
  config?: BotConfig;
}

/** agent loop 结果 */
export interface AgentLoopResult {
  text: string;
  toolCallsUsed: number;
  error?: string;
}

/** 把任意异常转成可读的中文描述 */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 执行单个工具调用：找不到工具、参数错误或执行异常时返回失败文本 */
async function executeTool(call: LLMToolCall, skills: Skill[], ctx: SkillRunContext): Promise<string> {
  const skill = skills.find((s) => (s.toolName ?? getToolName(s.name)) === call.name || s.name === call.name);
  if (!skill) {
    log.warn('未找到工具', { module: 'src/agent/loop.ts', tool: call.name });
    return `工具执行失败：未找到工具 ${call.name}`;
  }
  log.info('调用工具', { module: 'src/agent/loop.ts', tool: call.name, canonicalTool: skill.name, args: call.arguments });
  const startedAt = Date.now();
  try {
    let args: Record<string, unknown>;
    try {
      args = validateArgs(skill.inputSchema, JSON.parse(call.arguments));
    } catch (e) {
      return `工具执行失败：参数错误（${errMsg(e)}）`;
    }
    const result = await skill.run(args, ctx);
    log.debug('工具结果', { name: call.name, ms: Date.now() - startedAt, result });
    return result;
  } catch (e) {
    log.error('工具执行失败', { module: 'src/agent/loop.ts', tool: call.name, reason: errMsg(e) });
    return '工具执行失败：内部错误';
  }
}

function isValidInputSchema(schema: Record<string, unknown> | undefined): boolean {
  if (schema === undefined) return true;
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return false;
  const type = schema.type;
  if (type !== undefined && type !== 'object') return false;
  if (schema.properties !== undefined && (typeof schema.properties !== 'object' || schema.properties === null || Array.isArray(schema.properties))) return false;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((item) => typeof item === 'string'))) return false;
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean' && (typeof schema.additionalProperties !== 'object' || schema.additionalProperties === null || Array.isArray(schema.additionalProperties))) return false;
  return true;
}

function describeTool(skill: Skill, generatedName: string, reason: string): string {
  return `工具 ${generatedName}（模块：${skill.module ?? 'unknown'}，canonical：${skill.name}）${reason}`;
}

/** 运行 agent loop：流式生成 + 工具调用循环 */
export async function runAgentLoop(params: AgentLoopParams): Promise<AgentLoopResult> {
  const { provider, skills, messages, maxIterations, temperature, maxTokens, signal, onDelta } = params;
  const tools = skills.flatMap((s) => {
    const name = s.toolName ?? getToolName(s.name);
    if (!isValidToolName(name)) {
      log.warn('跳过非法工具名', { module: s.module ?? 'unknown', tool: s.name, generatedTool: name, reason: '名称不符合 ^[a-zA-Z0-9_-]+$ 或超过 64 字符' });
      return [];
    }
    if (!isValidInputSchema(s.inputSchema)) {
      log.warn('跳过非法工具 schema', { module: s.module ?? 'unknown', tool: s.name, generatedTool: name, reason: '顶层 schema 必须为 object' });
      return [];
    }
    return [{ name, description: s.description, inputSchema: s.inputSchema ?? {}, module: s.module }];
  });
  const uniqueTools = tools.filter((tool, index) => {
    const duplicate = tools.findIndex((candidate) => candidate.name === tool.name) !== index;
    if (duplicate) log.warn('跳过重复工具名', { module: tool.module ?? 'unknown', tool: tool.name, reason: '同一请求中 function name 必须唯一' });
    return !duplicate;
  });
  if (skills.length > 0 && uniqueTools.length === 0) {
    const reason = '所有工具声明均非法或被过滤，已拒绝调用 LLM';
    log.error('工具清单无有效项', { module: 'src/agent/loop.ts', reason, tools: skills.map((skill) => ({ module: skill.module, canonical: skill.name, tool: skill.toolName ?? getToolName(skill.name) })) });
    return { text: '', toolCallsUsed: 0, error: reason };
  }
  const ctx: SkillRunContext = {
    chatId: params.chatId ?? '',
    senderId: params.senderId,
    senderName: params.senderName ?? '',
    signal: params.signal,
    config: params.config,
  };
  let toolCallsUsed = 0;
  const startedAt = Date.now();

  try {
    for (let i = 0; i < maxIterations; i++) {
      let text = '';
      const calls: LLMToolCall[] = [];
      let doneMsg: LLMMessage | undefined;
      let error: string | undefined;

      // 流式生成一轮；done 事件携带最终消息与错误
      // 先 await 一层，兼容 streamChat 直接返回 AsyncIterable 或返回其 Promise 两种写法
      for await (const ev of await provider.streamChat({ messages, tools: uniqueTools, temperature, maxTokens, signal })) {
        switch (ev.type) {
          case 'text':
            text += ev.delta;
            onDelta?.(ev.delta);
            break;
          case 'tool-call':
            calls.push(ev.call);
            break;
          case 'done':
            doneMsg = ev.message;
            error = ev.error;
            break;
        }
      }

      if (error) {
        log.error('生成失败', { module: 'src/agent/loop.ts', reason: error });
        return { text: '', toolCallsUsed, error: '生成失败，请稍后重试' };
      }

      // 无工具调用 → 生成完成，返回累计文本
      const assistantCalls = calls.length > 0 ? calls : (doneMsg?.toolCalls ?? []);
      if (assistantCalls.length === 0) {
        log.debug('生成完成', { ms: Date.now() - startedAt, textChars: text.length, toolCallsUsed });
        return { text, toolCallsUsed };
      }

      // 有工具调用：追加 assistant 消息与各工具结果，进入下一轮
      messages.push({ role: 'assistant', content: text || null, toolCalls: assistantCalls });
      for (const call of assistantCalls) {
        toolCallsUsed++;
        const result = await executeTool(call, skills, ctx);
        messages.push({ role: 'tool', content: result, toolCallId: call.id, name: call.name });
      }
    }

    // 达到轮数上限仍未结束
    log.warn('工具调用超过轮数上限', { module: 'src/agent/loop.ts', maxIterations });
    return { text: '', toolCallsUsed, error: `工具调用超过 ${maxIterations} 轮上限` };
  } catch (e) {
    // 全程兜底：任何未捕获异常都转成中文描述返回
    log.error('agent 出错', { module: 'src/agent/loop.ts', reason: errMsg(e) });
    return { text: '', toolCallsUsed, error: '执行出错，请稍后重试' };
  }
}
