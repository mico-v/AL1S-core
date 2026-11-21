/**
 * 图文卡片（`msg_type=8`）：标题 + 一句说明 + 配图 + 可点的链接。
 *
 * 依据（2026-11-21 从官方文档正文核对，本地镜像 docs/qq-api/）：
 *   - 20261028 新增，群聊与单聊都能发；频道场景没有。
 *   - 请求体里挂 `card` 字段，`msg_type=8` 时必填；结构与 markdown / media 互斥。
 *   - `card.type` 目前只有 `tuwen` 一种取值。
 *   - 硬限制：`title` 1–50 字符、`description` 1–200 字符、`url` 与 `pic_url`
 *     必须是 https 且 ≤1024 字符。
 *   - SDK（`@tencent-connect/qqbot-nodejs`）的 `MsgType` 枚举还没收录 8，
 *     但 `send()` 支持 `extra` 透传，所以不用改依赖。
 *
 * 这里只做三件事：校验、按平台上限裁剪、渲染成回执行。
 * 发不发、发给谁，交给 index.ts；怎么组织内容，交给模型。
 *
 * 实测（2026-11-21）：配图由平台自己转存，**国内不可达的图会报「图片转存失败」**
 * （`avatars.githubusercontent.com` 实测 400），`q1.qlogo.cn` 这类腾讯 CDN 正常。
 */

/** 卡片标题上限（平台限制）。 */
export const MAX_CARD_TITLE_CHARS = 50;
/** 卡片说明上限（平台限制）。 */
export const MAX_CARD_DESC_CHARS = 200;
/** 链接上限（平台限制，url 与 pic_url 同一条）。 */
export const MAX_CARD_URL_CHARS = 1024;

export interface CardInput {
  /** 标题，1–50 字。 */
  title: string;
  /** 一句说明，1–200 字。 */
  description: string;
  /** 点击卡片跳转的 https 链接。 */
  url: string;
  /** 卡片配图的 https 链接。 */
  picUrl: string;
}

export interface MessageCard {
  type: 'tuwen';
  content: {
    title: string;
    description: string;
    url: string;
    pic_url: string;
  };
}

/** 按码点截到上限，超了补省略号（不切坏表情）。 */
export function clipText(value: string, max: number): string {
  const chars = [...value];
  if (chars.length <= max) {
    return chars.join('');
  }
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** 卡片里的文字都压成一行：换行在卡片上不生效，留着只会撑出怪空隙。 */
export function flattenText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** https + 长度上限，两条都是平台硬约束。 */
export function isCardUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_CARD_URL_CHARS) {
    return false;
  }
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 造卡片。文字类字段自动裁剪，链接不合规就整张不发 ——
 * 发出去一张点不动的卡片，比不发更糟。
 */
export function buildCard(input: CardInput): { card: MessageCard } | { error: string } {
  const title = clipText(flattenText(input.title), MAX_CARD_TITLE_CHARS);
  const description = clipText(flattenText(input.description), MAX_CARD_DESC_CHARS);
  const url = input.url.trim();
  const picUrl = input.picUrl.trim();

  if (!title) {
    return { error: '需要 title（一句话标题，≤50 字）。' };
  }
  if (!description) {
    return { error: '需要 description（一句说明，≤200 字）。' };
  }
  if (!isCardUrl(url)) {
    return { error: `url 必须是 https 链接且不超过 ${MAX_CARD_URL_CHARS} 字符。` };
  }
  if (!isCardUrl(picUrl)) {
    return { error: `pic_url 必须是 https 链接且不超过 ${MAX_CARD_URL_CHARS} 字符。` };
  }
  return {
    card: {
      type: 'tuwen',
      content: { title, description, url, pic_url: picUrl },
    },
  };
}

/** 回执与群聊历史里的一行摘要：卡片本身没正文，得留个可检索的痕迹。 */
export function renderCardLine(card: MessageCard): string {
  return `（发了图文卡片：${card.content.title} ${card.content.url}）`;
}
