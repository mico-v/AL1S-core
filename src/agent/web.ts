/**
 * 联网搜索。
 *
 * 走 Bing 的 HTML 结果页：它在本机直连会被 302，经美国出口正常，
 * 而且必须显式指定 setmkt=en-US —— 默认市场会返回一堆无关的中文推广页。
 *
 * 没有用任何付费 API，也没有用第三方抓取服务：一次 curl + 正则解析。
 */

import { execFile } from 'node:child_process';
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
