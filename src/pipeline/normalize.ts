/**
 * OneBot 消息段 → 纯文本归一化。
 *
 * 把事件中的 message（段数组或 CQ 字符串）渲染为适合喂给 LLM 的文本：
 * at → @昵称（命中自己时附加 [DIRECTED AT YOU] 标记）、image → [图片]、
 * reply → [引用]、face → [表情] 等，并识别是否 @ 了机器人（atBot）。
 */
import { parseSegments } from '@snowluma/sdk';
import type { JsonValue, OneBotGroupMessageEvent, OneBotPrivateMessageEvent } from '@snowluma/sdk';

export interface NormalizedMessage {
  text: string;
  atBot: boolean;
}

/** 统一的一段消息（容忍 data 缺失/非对象） */
interface RawSegment {
  type: string;
  data: Record<string, unknown>;
}

/** 判断是否为普通对象（排除 null 与数组） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 安全取字符串：null/undefined 视为缺失，其余转成字符串 */
function asString(value: unknown): string | undefined {
  if (value == null) return undefined;
  return typeof value === 'string' ? value : String(value);
}

/** 把 JsonValue 的 message 规整为段数组（兼容 array 与 CQ 字符串两种格式） */
function messageToSegments(message: JsonValue): RawSegment[] {
  // CQ 字符串格式：复用 SDK 的解析器
  if (typeof message === 'string') {
    return parseSegments(message).map((s) => ({ type: s.type, data: s.data }));
  }
  // array 格式：遍历段数组
  if (Array.isArray(message)) {
    const out: RawSegment[] = [];
    for (const item of message) {
      if (!isRecord(item)) continue;
      const type = item['type'];
      if (typeof type !== 'string') continue;
      const data = isRecord(item['data']) ? item['data'] : {};
      out.push({ type, data });
    }
    return out;
  }
  // 单个段对象的兼容分支
  if (isRecord(message)) {
    const type = message['type'];
    if (typeof type === 'string') {
      const data = isRecord(message['data']) ? message['data'] : {};
      return [{ type, data }];
    }
  }
  return [];
}

/** 渲染单个段；at 命中自己时返回 atBot=true */
function renderSegment(seg: RawSegment, selfId: string): { text: string; atBot: boolean } {
  const d = seg.data;
  switch (seg.type) {
    case 'text':
      return { text: asString(d['text']) ?? '', atBot: false };
    case 'at': {
      const qq = asString(d['qq']);
      if (qq === 'all') return { text: '@全体成员', atBot: false }; // @全体不算 @自己
      const name = asString(d['name']);
      const label = name ? `@${name}` : qq ? `@用户${qq}` : '@[未知用户]';
      if (qq && qq === selfId) return { text: `${label} [DIRECTED AT YOU]`, atBot: true };
      return { text: label, atBot: false };
    }
    case 'image': {
      const caption = asString(d['caption']);
      return { text: caption ? `[图片: ${caption}]` : '[图片]', atBot: false };
    }
    case 'face':
      return { text: '[表情]', atBot: false };
    case 'record':
      return { text: '[语音]', atBot: false };
    case 'video':
      return { text: '[视频]', atBot: false };
    case 'reply': {
      const repText = asString(d['text']);
      return { text: repText ? `[引用: ${repText}]` : '[引用]', atBot: false };
    }
    case 'forward':
      return { text: '[合并转发]', atBot: false };
    default:
      return { text: `[${seg.type}]`, atBot: false }; // 未知段兜底
  }
}

/** 把 OneBot 群/私聊消息事件归一化为纯文本 + 是否 @ 机器人 */
export function normalizeMessage(
  event: OneBotGroupMessageEvent | OneBotPrivateMessageEvent,
): NormalizedMessage {
  const segments = messageToSegments(event.message);
  const selfId = String(event.self_id); // qq 段可能是 number 或 string，统一转字符串比较
  let text = '';
  let atBot = false;
  for (const seg of segments) {
    const rendered = renderSegment(seg, selfId);
    if (rendered.atBot) atBot = true;
    text += rendered.text;
  }
  return { text, atBot };
}
