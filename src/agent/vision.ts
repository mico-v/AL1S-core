/**
 * 图片 / 语音 / 文件的「看懂」。
 *
 * deepseek-v4.1-flash 本身是多模态的，但它是推理模型：
 * 小 max_tokens 会把预算全烧在 reasoning 上，content 直接是空的。
 * 所以看图单独发一次请求、给足 2000 token，只取一句描述，
 * 再把描述当成文本注入主对话 —— 主对话因此始终保持纯文本、便宜、快。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
const CAPTION_TIMEOUT_MS = 35_000;
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

/**
 * 描述缓存：key 是 `s:<内容哈希>` 或 `u:<url>`。
 *
 * 群里的图有一半是同一批表情包 —— 按 url 存没用，QQ 每次给的 rkey 都变，
 * 第二天重启内存也清空。所以按图片内容哈希存，并且落盘，跨重启、跨天都命中。
 */
const captionCache = new Map<string, string>();
const CACHE_LIMIT = 4000;
/** 落盘文件名（相对 dataRoot）。 */
const CAPTION_STORE_NAME = 'captions.json';

/** 缓存文件放在 dataRoot 下的固定位置。 */
export function captionStorePath(dataRoot: string): string {
  return path.join(dataRoot, CAPTION_STORE_NAME);
}

let storePath: string | undefined;
let storeLoaded = false;
let flushTimer: NodeJS.Timeout | undefined;

/** 明确指定缓存落盘位置；路径变了就重新加载。 */
export function useCaptionStore(file: string | undefined): void {
  if (file === storePath) {
    return;
  }
  storePath = file;
  storeLoaded = false;
  captionCache.clear();
  if (file) {
    loadCaptionStore();
  }
}

function loadCaptionStore(): void {
  if (storeLoaded || !storePath) {
    return;
  }
  storeLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, string>;
    for (const [sha, desc] of Object.entries(raw)) {
      if (typeof desc === 'string' && desc.trim()) {
        captionCache.set(`s:${sha}`, desc);
      }
    }
  } catch {
    // 第一次跑还没有文件；文件读坏也照常重新攒，不影响回复
  }
}

/** 按内容哈希取回描述（会触发一次懒加载）。 */
export function captionForSha(sha: string): string | undefined {
  loadCaptionStore();
  return captionCache.get(`s:${sha}`);
}

/** 记下一条描述：先更内存，落盘防抖。 */
export function rememberCaption(sha: string, desc: string): void {
  loadCaptionStore();
  trimCache();
  captionCache.set(`s:${sha}`, desc);
  scheduleFlush();
}

/** 立刻把缓存写盘（自检和退出时用）。 */
export async function flushCaptionStore(): Promise<void> {
  const file = storePath;
  if (!file) {
    return;
  }
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of captionCache) {
    if (key.startsWith('s:')) {
      out[key.slice(2)] = value;
      count += 1;
    }
  }
  if (count === 0) {
    return;
  }
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(out), 'utf8');
    await rename(tmp, file);
  } catch {
    // 落盘失败只影响下次命中率，不值得打扰对话
  }
}

function scheduleFlush(): void {
  if (!storePath || flushTimer) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flushCaptionStore();
  }, 2000);
  flushTimer.unref();
}

function trimCache(): void {
  while (captionCache.size >= CACHE_LIMIT) {
    const oldest = captionCache.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    captionCache.delete(oldest);
  }
}

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

/**
 * 按文件头判断真实类型。
 *
 * 只看 content_type 和 URL 是不够的：群里的语音（#!SILK_V3）和视频（ftypmp42）
 * 也会带 multimedia 链接，被当成图片塞进视觉链路，上游直接 400。
 * 返回 undefined 表示「这不是我认识的图片」。
 */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12) {
    return undefined;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif';
  }
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  // HEIC/HEIF：ftyp 在 offset 4，主品牌 heic/heix/mif1
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') {
      return 'image/heic';
    }
  }
  return undefined;
}

/** 是不是视频容器（mp4/mov），用来决定要不要抽帧。 */
export function sniffVideo(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
  );
}

function mimeOf(contentType: string | undefined, bytes: Uint8Array): string {
  const sniffed = sniffImageType(bytes);
  if (sniffed) {
    return sniffed;
  }
  if (contentType && contentType.startsWith('image/')) {
    return contentType;
  }
  return 'application/octet-stream';
}

/** 这个附件看起来像图吗。#!SILK_V3 / mp4 这类别再往视觉链路送。 */
export function looksLikeImage(item: AttachmentLike): boolean {
  const type = item.content_type ?? '';
  if (type.startsWith('video/') || type.startsWith('audio/')) {
    return false;
  }
  if (type.startsWith('image/')) {
    return true;
  }
  // 没有 content_type 时，凡是 multimedia 链接都先下下来验文件头
  return !type && Boolean(item.url?.includes('multimedia'));
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

/** 视频抽一帧当图看：群里的视频消息至少能知道画面是什么。 */
export async function extractVideoFrame(bytes: Uint8Array, log: AppLogger): Promise<Uint8Array | undefined> {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    return undefined;
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'al1s-vid-'));
  const input = path.join(dir, 'in.mp4');
  const output = path.join(dir, 'frame.jpg');
  try {
    await writeFile(input, bytes);
    await execFileAsync(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-frames:v', '1', '-q:v', '4', output],
      { timeout: 25_000 },
    );
    const frame = new Uint8Array(await readFile(output));
    return frame.byteLength > 0 ? frame : undefined;
  } catch (error) {
    log.warn('视频抽帧失败', { bytes: bytes.byteLength, error });
    return undefined;
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
  const images = (attachments ?? []).filter(looksLikeImage).slice(0, MAX_IMAGES_PER_MESSAGE);

  for (let index = 0; index < images.length; index += 1) {
    const item = images[index] as AttachmentLike;
    const label = index + 1;
    if (!item.url) {
      continue;
    }
    try {
      const raw = await download(item.url);
      // 下载后按文件头确认：语音/视频/未知格式不往视觉链路送
      const kind = sniffImageType(raw);
      let bytes = raw;
      if (!kind) {
        if (sniffVideo(raw)) {
          const frame = await extractVideoFrame(raw, log);
          if (!frame) {
            result.markers.push(`[图${label}]（是视频，没抽到画面）`);
            continue;
          }
          bytes = frame;
        } else {
          result.markers.push(`[图${label}]（不是图片，跳过了）`);
          continue;
        }
      }
      const prepared = await prepareImage(bytes, mimeOf(item.content_type, bytes), log);
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
  /** 其中几张是直接命中缓存、没花 token。 */
  imagesCached: number;
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
  options: { skipImages?: boolean; captionStore?: string } = {},
): Promise<DigestedAttachments> {
  const lines: string[] = [];
  let imagesSeen = 0;
  let imagesFailed = 0;
  let imagesCached = 0;

  if (options.captionStore) {
    useCaptionStore(options.captionStore);
  }

  if (!attachments || attachments.length === 0) {
    return { text: '', imagesSeen, imagesFailed, imagesCached };
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
    : attachments.filter(looksLikeImage).slice(0, MAX_IMAGES_PER_MESSAGE);

  for (let index = 0; index < images.length; index += 1) {
    const item = images[index] as AttachmentLike;
    if (!item.url) {
      continue;
    }
    const cached = captionCache.get(`u:${item.url}`);
    if (cached) {
      lines.push(`[图${index + 1}] ${cached}`);
      imagesSeen += 1;
      imagesCached += 1;
      continue;
    }
    try {
      const raw = await download(item.url);
      // 和直传路径一致：先验文件头，再缩放并转成标准 JPEG。
      // 大图 base64 会被上游判 400；语音/视频混进来更会直接失败。
      let bytes = raw;
      if (!sniffImageType(raw)) {
        if (sniffVideo(raw)) {
          const frame = await extractVideoFrame(raw, log);
          if (!frame) {
            imagesFailed += 1;
            lines.push(`[图${index + 1}]（是视频，没抽到画面）`);
            continue;
          }
          bytes = frame;
        } else {
          log.info('跳过非图片附件', { bytes: raw.byteLength });
          lines.push(`[文件] 不是图片（${raw.byteLength} 字节），没看`);
          continue;
        }
      }
      // 同一张图换个 rkey 再发一遍，url 变了但字节没变 —— 按内容哈希复用描述
      const sha = createHash('sha256').update(bytes).digest('hex');
      const known = captionForSha(sha);
      if (known) {
        captionCache.set(`u:${item.url}`, known);
        lines.push(`[图${index + 1}] ${known}`);
        imagesSeen += 1;
        imagesCached += 1;
        continue;
      }
      const prepared = await prepareImage(bytes, mimeOf(item.content_type, bytes), log);
      const desc = await describeImage(prepared.data, prepared.mime, llm, log);
      if (!desc) {
        imagesFailed += 1;
        lines.push(`[图${index + 1}] （没看清）`);
        continue;
      }
      rememberCaption(sha, desc);
      captionCache.set(`u:${item.url}`, desc);
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

  return { text: lines.join('\n'), imagesSeen, imagesFailed, imagesCached };
}
