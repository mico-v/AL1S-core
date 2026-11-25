/**
 * 联网：搜索 + 读网页正文。
 *
 * 搜索走 Bing 的 HTML 结果页：它在本机直连会被 302，经美国出口正常，
 * 而且必须显式指定 setmkt=en-US —— 默认市场会返回一堆无关的中文推广页。
 * 读正文同样是 curl + 正则抽文本，只保留可读内容（去脚本样式、按块断行）。
 *
 * 没有用任何付费 API，也没有用第三方抓取服务。
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AppLogger } from '../logger.js';

const execFileAsync = promisify(execFile);

/** 出口代理。没有它，Bing 会 302 到验证页。 */
const PROXY = process.env.WEB_PROXY ?? 'http://43.110.16.130:80';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';
const TIMEOUT_MS = 15_000;

export interface WebHit {
  title: string;
  url: string;
  snippet: string;
}

function decodeEntities(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bing 的外链包在 /ck/a 里，真正的地址在 u=a1<base64url>。 */
function unwrapBingUrl(href: string): string {
  if (!href.includes('bing.com/ck/a')) {
    return href;
  }
  const match = /[?&]u=a1([^&]+)/.exec(href);
  if (!match?.[1]) {
    return href;
  }
  try {
    const raw = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    return /^https?:\/\//.test(decoded) ? decoded : href;
  } catch {
    return href;
  }
}

export function parseBingHtml(html: string, limit: number): WebHit[] {
  const hits: WebHit[] = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?(?=<li class="b_algo"|<\/ol>)/g) ?? [];
  for (const block of blocks) {
    const titleMatch = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!titleMatch?.[1]) {
      continue;
    }
    const title = decodeEntities(titleMatch[2] ?? '');
    if (!title) {
      continue;
    }
    const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    hits.push({
      title,
      url: unwrapBingUrl(titleMatch[1]),
      snippet: decodeEntities(snippetMatch?.[1] ?? ''),
    });
    if (hits.length >= limit) {
      break;
    }
  }
  return hits;
}

/** Brave 的结果块：标题和链接最稳定，摘要有的条目没有。 */
export function parseBraveHtml(html: string, limit: number): WebHit[] {
  const hits: WebHit[] = [];
  const blocks =
    html.match(/<div class="snippet[^"]*"[^>]*data-type="web"[\s\S]*?(?=<div class="snippet|<\/main>|$)/g) ?? [];
  for (const block of blocks) {
    const href = /<a[^>]*href="(https?:\/\/[^"]+)"/.exec(block)?.[1];
    const title = /class="title[^"]*"[^>]*>([^<]+)</.exec(block)?.[1];
    if (!href || !title) {
      continue;
    }
    // Brave 的摘要容器叫 generic-snippet（不同版本可能换名，取不到就留空）
    const desc =
      /class="(?:generic-snippet|snippet-description)[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1] ?? '';
    hits.push({
      title: decodeEntities(title),
      url: href,
      snippet: decodeEntities(desc),
    });
    if (hits.length >= limit) {
      break;
    }
  }
  return hits;
}

async function fetchSearch(url: string): Promise<string> {
  const args = [
    '-sL',
    '-m', String(Math.floor(TIMEOUT_MS / 1000)),
    '-A', UA,
    '--compressed',
    ...(PROXY ? ['-x', PROXY] : []),
    url,
  ];
  const { stdout } = await execFileAsync('curl', args, {
    timeout: TIMEOUT_MS + 5000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/** 搜一次。失败返回空数组，调用方负责说「没搜到」。 */
export async function searchWeb(
  query: string,
  limit: number,
  log: AppLogger,
): Promise<WebHit[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  const want = Math.min(Math.max(limit, 1), 8);

  // Brave 的结果更接近“人搜到的样子”，Bing 的 HTML 经常只给实体首页当兜底
  try {
    const html = await fetchSearch(`https://search.brave.com/search?q=${encodeURIComponent(trimmed)}&source=web`);
    const hits = parseBraveHtml(html, want);
    if (hits.length > 0) {
      log.info('联网搜索', { query: trimmed, hits: hits.length, engine: 'brave' });
      return hits;
    }
  } catch (error) {
    log.warn('Brave 搜索失败，改用 Bing', { query: trimmed, error });
  }

  try {
    const html = await fetchSearch(
      `https://www.bing.com/search?q=${encodeURIComponent(trimmed)}&setmkt=en-US&count=10`,
    );
    const hits = parseBingHtml(html, want);
    log.info('联网搜索', { query: trimmed, hits: hits.length, engine: 'bing' });
    return hits;
  } catch (error) {
    log.warn('联网搜索失败', { query: trimmed, error });
    return [];
  }
}

/** 渲染成给模型看的紧凑文本。 */
export function renderHits(query: string, hits: WebHit[]): string {
  if (hits.length === 0) {
    return `「${query}」没有搜到结果。可能是网络不通，也可能是这个词太生僻 —— 如实说没搜到，别编。`;
  }
  return hits
    .map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`)
    .join('\n\n');
}

/* ------------------------------------------------------------------ *
 * 读网页正文
 * ------------------------------------------------------------------ */

const FETCH_TIMEOUT_MS = 20_000;
/** 单页字节上限：超过就当成「不是能读的网页」，别把 200MB 视频拖回来。 */
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_PAGE_CHARS = 8_000;
const MAX_PAGE_CHARS = 30_000;

/** 这些类型不是「文章」，抓下来也读不了。 */
const BINARY_TYPES = /^(image|video|audio|font)\//i;

/** 保留换行的实体解码（decodeEntities 会把换行压平，正文要分行）。 */
function decodeText(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => safeCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => safeCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
    return '';
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** HTML → 标题 + 正文纯文本。纯函数，自检里直接喂样本。 */
export function parseHtmlText(html: string): { title: string; text: string } {
  const title = decodeText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  // 先找正文容器；拿不到（或太短）就用整页
  let scope = html;
  const container = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html) ?? /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  if (container?.[1] && container[1].replace(/<[^>]+>/g, '').trim().length > 400) {
    scope = container[1];
  }

  const withBreaks = scope
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|object|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n· ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|dd|dt|ul|ol|table)>/gi, '\n')
    .replace(/<t[dh][^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  const lines = decodeText(withBreaks)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0\u3000]+/g, ' ').trim())
    .filter((line) => line.length > 0);

  // 导航栏常把同一句话重复好几遍，连着重复的不要
  const deduped: string[] = [];
  for (const line of lines) {
    if (deduped[deduped.length - 1] !== line) {
      deduped.push(line);
    }
  }

  return { title, text: deduped.join('\n') };
}

export interface PageResult {
  /** 请求的地址 */
  url: string;
  /** 跟随跳转后的真实地址 */
  finalUrl: string;
  title: string;
  text: string;
  truncated: boolean;
}

async function fetchRawPage(
  url: string,
  proxy: string,
): Promise<{ body: string; contentType: string; finalUrl: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kei-fetch-'));
  const file = path.join(dir, 'page');
  try {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        'curl',
        [
          '-sL',
          '-m', String(Math.floor(FETCH_TIMEOUT_MS / 1000)),
          '-A', UA,
          '--compressed',
          ...(proxy ? ['-x', proxy] : []),
          '--max-filesize', String(MAX_PAGE_BYTES),
          '-o', file,
          '-w', '%{http_code}\t%{content_type}\t%{url_effective}',
          url,
        ],
        { timeout: FETCH_TIMEOUT_MS + 5_000, maxBuffer: 1024 * 1024 },
      ));
    } catch (error) {
      const code = (error as { code?: number | string }).code;
      if (code === 63) {
        throw new Error(`页面超过 ${Math.floor(MAX_PAGE_BYTES / 1024 / 1024)}MB，放弃`);
      }
      const stderr =
        String((error as { stderr?: string }).stderr ?? '').trim().split('\n').pop()?.replace(/^curl: \(\d+\) /, '') ?? '';
      throw new Error(
        `${code === 28 ? '读超时' : '连不上'}${code ? `（curl ${code}）` : ''}${stderr ? `：${stderr}` : ''}`,
      );
    }

    const [statusText = '', contentType = '', finalUrl = url] = stdout.trim().split('\t');
    const status = Number(statusText);
    if (!statusText.startsWith('2')) {
      throw new Error(`目标站点返回 ${statusText || '无响应'}${status >= 400 ? '（可能被墙、要登录，或地址写错了）' : ''}`);
    }
    if (BINARY_TYPES.test(contentType) || /application\/(pdf|zip|octet-stream)/i.test(contentType)) {
      throw new Error(`不是网页正文（content-type=${contentType.split(';')[0]}），读不了`);
    }

    const raw = await readFile(file);
    const preview = raw.subarray(0, 2048).toString('latin1');
    const charset =
      /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
      /<meta[^>]+charset=["']?([\w-]+)/i.exec(preview)?.[1] ??
      'utf-8';
    let body: string;
    try {
      body = new TextDecoder(charset).decode(raw);
    } catch {
      body = raw.toString('utf-8');
    }
    return { body, contentType, finalUrl };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 打开一个网页读正文。失败一律抛出带人话的 Error，调用方负责转述给模型。
 *
 * 先走美国出口，不行再直连：外网站的常态是要过代理，国内站反过来。
 */
export async function fetchPage(
  url: string,
  log: AppLogger,
  maxChars = DEFAULT_PAGE_CHARS,
): Promise<PageResult> {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('只支持 http:// 或 https:// 开头的链接');
  }
  const cap = Math.min(Math.max(Math.floor(maxChars) || DEFAULT_PAGE_CHARS, 1_000), MAX_PAGE_CHARS);

  const routes = PROXY ? [PROXY, ''] : [''];
  let fetched: Awaited<ReturnType<typeof fetchRawPage>> | undefined;
  let firstError: Error | undefined;
  for (const route of routes) {
    try {
      fetched = await fetchRawPage(trimmed, route);
      break;
    } catch (error) {
      firstError ??= error as Error;
      log.warn('读网页失败，换出口再试', {
        url: trimmed,
        route: route || '直连',
        error: (error as Error).message,
      });
    }
  }
  if (!fetched) {
    throw firstError ?? new Error('抓不到这个地址');
  }

  const { body, contentType, finalUrl } = fetched;

  const isHtml = /html|xml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body.slice(0, 512));
  const parsed = isHtml ? parseHtmlText(body) : { title: '', text: body };
  const title = parsed.title;
  const text = parsed.text.replace(/\r\n/g, '\n').trim();
  const truncated = text.length > cap;
  log.info('读网页', { url: trimmed, finalUrl, chars: text.length, truncated });
  return {
    url: trimmed,
    finalUrl,
    title,
    text: truncated ? text.slice(0, cap) : text,
    truncated,
  };
}

/** 渲染成给模型看的文本。 */
export function renderPage(page: PageResult): string {
  const body = page.text.trim();
  if (!body) {
    return `「${page.url}」抓下来是空的（可能是纯前端渲染的页面，正文要跑 JS 才出得来）。`;
  }
  const head = page.title ? `「${page.title}」 ${page.finalUrl}` : page.finalUrl;
  const tail = page.truncated
    ? `\n\n（正文只给了前 ${body.length} 字。要更多把 max_chars 调到更大再读一次。）`
    : '';
  return `${head}\n\n${body}${tail}`;
}
