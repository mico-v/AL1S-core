/**
 * 图片 / 语音 / 文件的「看懂」。
 *
 * deepseek-v4.1-flash 本身是多模态的，但它是推理模型：
 * 小 max_tokens 会把预算全烧在 reasoning 上，content 直接是空的。
 * 所以看图单独发一次请求、给足 2000 token，只取一句描述，
 * 再把描述当成文本注入主对话 —— 主对话因此始终保持纯文本、便宜、快。
 */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AppLogger } from '../logger.js';
import { chatComplete, type ContentPart, type LlmOptions } from './llm.js';

const execFileAsync = promisify(execFile);

/** 原图下载上限。QQ 截图动辄几 MB，压缩交给 prepareImage。 */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** 压缩后的目标：长边 1400、JPEG 质量 4，一般落到 150–300KB。 */
const MAX_EDGE = 1400;
/** 低于这个大小且不是 GIF 就直接用原图，省一次转码。 */
const PASSTHROUGH_BYTES = 900_000;
/** 一条消息最多看几张，防刷。 */
const MAX_IMAGES_PER_MESSAGE = 3;
/** 看图的 token 预算。关掉推理后 600 足够，留点余量防止截断。 */
const CAPTION_MAX_TOKENS = 600;
/** 看图最多等这么久：超过就认「没看清」，别让人干等。 */
const CAPTION_TIMEOUT_MS = 25_000;
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

/** ffmpeg 在哪。找不到就跳过压缩，宁可发原图也不丢内容。 */
async function findFfmpeg(): Promise<string | undefined> {
  const candidates = [
    process.env.FFMPEG_PATH,
    '/root/.hermes/tools/ffmpeg-9.0.1-linux-x64/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ].filter((x): x is string => Boolean(x));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 试下一个
    }
  }
  return undefined;
}

/**
 * 把图压到模型能痛快吃的尺寸。
 *
 * 原图动辄 1280x2774 / 9MB，base64 之后请求体十几 MB，又慢又容易被网关拒。
 * 长边 1400 + JPEG q4 对「看懂梗图/截图文字」绰绰有余。
 */
export async function prepareImage(
  bytes: Uint8Array,
  mime: string,
  log: AppLogger,
): Promise<{ data: Uint8Array; mime: string }> {
  if (bytes.byteLength <= PASSTHROUGH_BYTES && mime !== 'image/gif') {
    return { data: bytes, mime };
  }
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    log.warn('没有 ffmpeg，原图直传', { bytes: bytes.byteLength });
    return { data: bytes, mime };
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'al1s-img-'));
  const input = path.join(dir, 'in');
  const output = path.join(dir, 'out.jpg');
  try {
    await writeFile(input, bytes);
    await execFileAsync(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', input,
        // 长边压到 1400，短边按比例；已经是小图的就不放大
        '-vf', `scale='min(${MAX_EDGE},iw)':-2`,
        '-q:v', '4',
        '-frames:v', '1',
        output,
      ],
      { timeout: 20_000 },
    );
    const compressed = new Uint8Array(await readFile(output));
    if (compressed.byteLength === 0 || compressed.byteLength >= bytes.byteLength) {
      return { data: bytes, mime };
    }
    return { data: compressed, mime: 'image/jpeg' };
  } catch (error) {
    log.warn('图片压缩失败，用原图', { bytes: bytes.byteLength, error });
    return { data: bytes, mime };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface LoadedImages {
  /** 直接拼进用户消息的图片分段 */
  parts: ContentPart[];
  /** 插在文本里的位置标记，形如 `[图1]（附图）` */
  markers: string[];
  /** 加载失败的张数 */
  failed: number;
}

/**
 * 把消息里的图**原样**装进上下文（不是转述）。
 *
 * 之前只发一句描述，模型看到的永远是二手信息；截图里的文字、梗图的细节、
 * 表格里的数字，全靠那次转写过一遍就没了。
 */
export async function loadImageParts(
  attachments: AttachmentLike[] | undefined,
  log: AppLogger,
): Promise<LoadedImages> {
  const result: LoadedImages = { parts: [], markers: [], failed: 0 };
  const images = (attachments ?? [])
    .filter((item) => (item.content_type ?? '').startsWith('image/') || item.url?.includes('multimedia'))
    .slice(0, MAX_IMAGES_PER_MESSAGE);

  for (let index = 0; index < images.length; index += 1) {
    const item = images[index] as AttachmentLike;
    const label = index + 1;
    if (!item.url) {
      continue;
    }
    try {
      const raw = await download(item.url);
      const prepared = await prepareImage(raw, mimeOf(item.content_type, raw), log);
      result.parts.push({
        type: 'image_url',
        image_url: { url: `data:${prepared.mime};base64,${Buffer.from(prepared.data).toString('base64')}` },
      });
      log.info('图片进入上下文', {
        label,
        raw: raw.byteLength,
        sent: prepared.data.byteLength,
        mime: prepared.mime,
      });
      result.markers.push(`[图${label}]（附图${prepared.mime === 'image/jpeg' ? '，已压缩' : ''}）`);
    } catch (error) {
      result.failed += 1;
      log.warn('图片加载失败', { url: item.url.slice(0, 60), error });
      result.markers.push(`[图${label}]（没加载出来）`);
    }
  }
  return result;
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
        purpose: 'caption',
      }, 0),
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
  options: { skipImages?: boolean } = {},
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

  const images = options.skipImages
    ? []
    : attachments
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
