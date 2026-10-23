/**
 * 图片 / 语音 / 文件的「看懂」。
 *
 * deepseek-v4.1-flash 本身是多模态的，但它是推理模型：
 * 小 max_tokens 会把预算全烧在 reasoning 上，content 直接是空的。
 * 所以看图单独发一次请求、给足 2000 token，只取一句描述，
 * 再把描述当成文本注入主对话 —— 主对话因此始终保持纯文本、便宜、快。
 */

import type { AppLogger } from '../logger.js';
import { chatComplete, type ContentPart, type LlmOptions } from './llm.js';

/** 超过这个大小的图不看了（QQ 表情包一般 20–300KB）。 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** 一条消息最多看几张，防刷。 */
const MAX_IMAGES_PER_MESSAGE = 3;
/** 看图的 token 预算。关掉推理后 600 足够，留点余量防止截断。 */
const CAPTION_MAX_TOKENS = 600;
const CAPTION_TIMEOUT_MS = 120_000;
/** 同时在跑的看图请求数。 */
const CAPTION_CONCURRENCY = 2;

const CAPTION_PROMPT = `看一眼这张图，说清楚它是什么。

规则：
- 有文字就原样读出来，一个字别改。
- 是表情包/梗图，就点明笑点和情绪。
- 是截图，说清界面在讲什么事。
- 是照片，说清画面主体在干什么。
- 2-3 句，不客套，不评价画风，不说「这张图展示了」。`;

export interface AttachmentLike {
  content_type?: string;
  url?: string;
  filename?: string;
  size?: number;
  asr_refer_text?: string;
  voice_wav_url?: string;
}

/** url → 描述。同一个表情包被反复发时不再重复花钱。 */
const captionCache = new Map<string, string>();
const CACHE_LIMIT = 300;

let active = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= CAPTION_CONCURRENCY) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active += 1;
  try {
    return await task();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

function mimeOf(contentType: string | undefined, bytes: Uint8Array): string {
  if (contentType && contentType.startsWith('image/')) {
    return contentType;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'image/jpeg';
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    return 'image/png';
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49) {
    return 'image/gif';
  }
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

async function download(url: string, timeoutMs = 30_000): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_IMAGE_BYTES) {
      throw new Error(`图片太大（${Math.round(length / 1024)}KB）`);
    }
    const buffer = new Uint8Array(await res.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`图片太大（${Math.round(buffer.byteLength / 1024)}KB）`);
    }
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

/** 让模型看一眼图，返回一句描述；失败返回 undefined（调用方不许瞎猜）。 */
export async function describeImage(
  bytes: Uint8Array,
  mime: string,
  llm: LlmOptions,
  log: AppLogger,
): Promise<string | undefined> {
  const parts: ContentPart[] = [
    { type: 'text', text: CAPTION_PROMPT },
    { type: 'image_url', image_url: { url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` } },
  ];
  try {
    const text = await withSlot(() =>
      chatComplete([{ role: 'user', content: parts }], {
        ...llm,
        maxTokens: CAPTION_MAX_TOKENS,
        temperature: 0.2,
        timeoutMs: CAPTION_TIMEOUT_MS,
        disableThinking: true,
      }),
    );
    return text.trim() || undefined;
  } catch (error) {
    log.warn('看图失败', { mime, bytes: bytes.byteLength, error });
    return undefined;
  }
}

export interface DigestedAttachments {
  /** 注入对话的文本，形如 `[图] 一个戴黑帽的女孩…`。 */
  text: string;
  /** 有几张图真的看成了。 */
  imagesSeen: number;
  imagesFailed: number;
}

/**
 * 把一条消息的附件转成文本。
 *
 * 处理顺序：语音优先用 QQ 自带的转写（免费）→ 图片交给模型 → 其它只记文件名。
 */
export async function digestAttachments(
  attachments: AttachmentLike[] | undefined,
  llm: LlmOptions,
  log: AppLogger,
): Promise<DigestedAttachments> {
  const lines: string[] = [];
  let imagesSeen = 0;
  let imagesFailed = 0;

  if (!attachments || attachments.length === 0) {
    return { text: '', imagesSeen, imagesFailed };
  }

  // 语音：QQ 已经转好文字就直接用
  for (const item of attachments) {
    const asr = item.asr_refer_text?.trim();
    if (asr) {
      lines.push(`[语音] ${asr}`);
    } else if (item.content_type?.startsWith('audio/') || item.voice_wav_url) {
      lines.push('[语音] （没转成文字，听不出来）');
    }
  }

  const images = attachments
    .filter((item) => (item.content_type ?? '').startsWith('image/') || item.url?.includes('multimedia'))
    .slice(0, MAX_IMAGES_PER_MESSAGE);

  for (let index = 0; index < images.length; index += 1) {
    const item = images[index] as AttachmentLike;
    if (!item.url) {
      continue;
    }
    const cached = captionCache.get(item.url);
    if (cached) {
      lines.push(`[图${index + 1}] ${cached}`);
      imagesSeen += 1;
      continue;
    }
    try {
      const bytes = await download(item.url);
      const desc = await describeImage(bytes, mimeOf(item.content_type, bytes), llm, log);
      if (!desc) {
        imagesFailed += 1;
        lines.push(`[图${index + 1}] （没看清）`);
        continue;
      }
      if (captionCache.size >= CACHE_LIMIT) {
        const oldest = captionCache.keys().next().value;
        if (oldest !== undefined) {
          captionCache.delete(oldest);
        }
      }
      captionCache.set(item.url, desc);
      imagesSeen += 1;
      lines.push(`[图${index + 1}] ${desc}`);
    } catch (error) {
      imagesFailed += 1;
      log.warn('图片下载失败', { url: item.url.slice(0, 60), error });
      lines.push(`[图${index + 1}] （没加载出来）`);
    }
  }

  for (const item of attachments) {
    const type = item.content_type ?? '';
    if (type.startsWith('image/') || type.startsWith('audio/') || item.voice_wav_url) {
      continue;
    }
    lines.push(`[文件] ${item.filename ?? '未命名'}${type ? `（${type}）` : ''}`);
  }

  return { text: lines.join('\n'), imagesSeen, imagesFailed };
}
