/**
 * DeepSeek 原生工具调用格式（DSML）解析。
 *
 * 背景：DeepSeek 系模型在 prompt 里用一套自带标记表达工具调用 ——
 *
 *   <｜DSML｜tool_calls>
 *   <｜DSML｜invoke name="run_command">
 *   <｜DSML｜parameter name="cmd" string="true">ls -la</｜DSML｜parameter>
 *   </｜DSML｜invoke>
 *   </｜DSML｜tool_calls>
 *
 * 正常的 OpenAI 兼容网关会把它解析成 `tool_calls` 字段再返回。但 opencode-go 上
 * `deepseek-v4.1-flash` 会间歇漏掉这一步，把标记原样塞进 `content`（2026-11-19 在
 * 大创项目群出现过一次），于是这堆标记会被当成正文发出去。
 *
 * 放在客户端解析是这一层该干的事：响应边界只认一种形状（标准 tool_calls），
 * 别的形状在进业务代码之前就归一掉。vLLM / LiteLLM 对 DeepSeek 同样这么做。
 * 这里只用一次顺序扫描，不用正则套正则 —— 标记里可能嵌正文、可能一次多个调用、
 * 可能被截断，正则嵌套在最后一种情况下会退化。
 */

import type { ToolCall } from './llm.js';

export interface NativeParse {
  /** 去掉标记后的正文（标记之外的内容原样保留）。 */
  content: string;
  /** 解析出来的调用；被截断/格式坏的调用不产出。 */
  toolCalls: ToolCall[];
  /** 正文里有没有 DSML 标记。有标记但解析不出调用时，调用方应当视为空回复重试。 */
  found: boolean;
}

/** 标记里的竖线有全角 `｜` 与半角 `|` 两种写法；闭合标记形如 `</｜DSML｜invoke>`。 */
const TAG_START = /<\/?[｜|]\s*DSML\s*[｜|]/;
const TAG_BODY_NAME = /^[a-z_]+/i;
const ATTR = /([a-z_]+)\s*=\s*"([^"]*)"/gi;

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of raw.matchAll(ATTR)) {
    const key = (match[1] ?? '').toLowerCase();
    if (key) {
      out[key] = match[2] ?? '';
    }
  }
  return out;
}

/** `string="false"` 表示参数是 JSON 而不是字符串，按手册还原成对象。 */
function coerce(raw: string, asString: boolean): unknown {
  const text = raw.trim();
  if (asString) {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

interface Invoke {
  name: string;
  params: Record<string, unknown>;
  param?: { name: string; asString: boolean; chunks: string[] };
}

export function parseNativeToolCalls(text: string): NativeParse {
  if (!text || !text.includes('DSML')) {
    return { content: text, toolCalls: [], found: false };
  }

  const toolCalls: ToolCall[] = [];
  const body: string[] = [];
  let invoke: Invoke | undefined;
  let cursor = 0;

  const appendText = (chunk: string): void => {
    if (!chunk) {
      return;
    }
    if (invoke?.param) {
      invoke.param.chunks.push(chunk);
    } else if (invoke) {
      // invoke 与 parameter 之间的空白不关心
      if (chunk.trim()) {
        body.push(chunk);
      }
    } else {
      body.push(chunk);
    }
  };

  while (cursor < text.length) {
    const start = text.slice(cursor).search(TAG_START);
    if (start < 0) {
      appendText(text.slice(cursor));
      break;
    }
    const tagStart = cursor + start;
    const tagEnd = text.indexOf('>', tagStart);
    if (tagEnd < 0) {
      // 标记被截断：剩下的都算正文，解析到此为止
      appendText(text.slice(cursor, tagStart));
      break;
    }
    appendText(text.slice(cursor, tagStart));

    const tag = text.slice(tagStart, tagEnd + 1);
    const closing = tag.startsWith('</') || tag.startsWith('< /');
    const inner = tag.slice(closing ? tag.indexOf('/', 1) + 1 : 1).replace(/^[｜|]\s*DSML\s*[｜|]\s*/, '');
    const name = (inner.match(TAG_BODY_NAME)?.[0] ?? '').toLowerCase();
    const parsedAttrs = attrs(tag);

    if (name === 'invoke') {
      if (!closing) {
        invoke = { name: parsedAttrs.name ?? '', params: {} };
      } else if (invoke) {
        if (invoke.name) {
          toolCalls.push({
            id: `dsml_${toolCalls.length + 1}`,
            type: 'function',
            function: { name: invoke.name, arguments: JSON.stringify(invoke.params) },
          });
        }
        invoke = undefined;
      }
    } else if (name === 'parameter') {
      if (!closing) {
        if (invoke) {
          invoke.param = {
            name: parsedAttrs.name ?? '',
            asString: (parsedAttrs.string ?? 'true') !== 'false',
            chunks: [],
          };
        }
      } else if (invoke?.param) {
        const { name: key, asString, chunks } = invoke.param;
        if (key) {
          invoke.params[key] = coerce(chunks.join(''), asString);
        }
        invoke.param = undefined;
      }
    } else if (closing && name === 'calls') {
      // 包装标签，没有语义
    }

    cursor = tagEnd + 1;
  }

  const content = body.join('').replace(/\n{3,}/g, '\n\n').trim();
  return { content, toolCalls, found: true };
}
