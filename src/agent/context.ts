/**
 * 群聊滚动缓冲。
 *
 * 群里没人 @ 机器人时，消息不进模型（省钱也不刷屏），但留在这里；
 * 等下次有人 @，把「上次说话之后群里聊了什么」一起喂进去。
 *
 * 每行都带时间与收件人：多人对话里「谁在跟谁说话」是模型最容易搞错的信息，
 * 必须由系统提供 —— 让模型从一堆「昵称: 内容」里自己推断是行不通的。
 */

export interface BufferedLine {
  senderName: string;
  text: string;
  timestamp: number;
  /** 这句话点名了谁（@ 或引用回复）；没有就是群发 */
  to?: string;
  /** 是否点名了机器人自己 */
  toBot?: boolean;
  /** 消息 ID，用来在渲染时排除「当前这条」 */
  messageId?: string;
  /** 是不是 Kei 自己说的话 */
  isSelf?: boolean;
  /** 这条消息在回复谁（QQ 的引用） */
  quote?: { sender: string; text: string };
  /**
   * 这行带的图片地址。不存字节：群里可能刷几十张图，存原图会把内存吃光；
   * 真被问到（有人 @）时再按需下载，这个时间差内 QQ 的 URL 还有效。
   */
  imageUrls?: string[];
}

export class GroupBuffer {
  private readonly byGroup = new Map<string, BufferedLine[]>();
  private readonly lastAt = new Map<string, number>();
  private readonly limit: number;

  constructor(limit = 40) {
    this.limit = Math.max(0, limit);
  }

  push(groupOpenid: string, line: BufferedLine): void {
    this.lastAt.set(groupOpenid, line.timestamp);
    if (this.limit === 0) {
      return;
    }
    const list = this.byGroup.get(groupOpenid) ?? [];
    if (line.messageId && list.some((item) => item.messageId === line.messageId)) {
      return;
    }
    // Kei 自己的话没有 messageId；万一哪天平台回投，按最近几条的文本去重
    if (line.isSelf && list.slice(-5).some((item) => item.isSelf && item.text === line.text)) {
      return;
    }
    list.push(line);
    if (list.length > this.limit) {
      list.splice(0, list.length - this.limit);
    }
    this.byGroup.set(groupOpenid, list);
  }

  /** 取出并清空（被 @ 之后调用）。 */
  drain(groupOpenid: string): BufferedLine[] {
    const list = this.byGroup.get(groupOpenid) ?? [];
    this.byGroup.delete(groupOpenid);
    return list;
  }

  peek(groupOpenid: string): BufferedLine[] {
    return [...(this.byGroup.get(groupOpenid) ?? [])];
  }

  /** 这个群最后一条消息的时间（判断是否已经冷场）。 */
  lastMessageAt(groupOpenid: string): number | undefined {
    return this.lastAt.get(groupOpenid);
  }

  /** 取最近几条消息里的图片 URL（新的在前），用于「刚才那张图」这种追问。 */
  recentImageUrls(groupOpenid: string, limit = 2): string[] {
    const list = this.byGroup.get(groupOpenid) ?? [];
    const urls: string[] = [];
    for (let i = list.length - 1; i >= 0 && urls.length < limit; i -= 1) {
      const line = list[i];
      if (!line?.imageUrls?.length) {
        continue;
      }
      for (const url of line.imageUrls) {
        if (urls.length < limit) {
          urls.push(url);
        }
      }
    }
    return urls;
  }

  clear(groupOpenid?: string): void {
    if (groupOpenid) {
      this.byGroup.delete(groupOpenid);
      this.lastAt.delete(groupOpenid);
    } else {
      this.byGroup.clear();
      this.lastAt.clear();
    }
  }
}

function hhmm(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 把缓冲渲染成可注入的文本块：`[20:14] 小明 → 小红: 内容`。 */
export function renderBuffer(lines: BufferedLine[]): string {
  if (lines.length === 0) {
    return '';
  }
  return lines
    .map((line) => {
      const text = line.text.replace(/\s+/g, ' ').trim();
      const arrow = line.toBot ? ' → Kei' : line.to ? ` → ${line.to}` : '';
      const quote = line.quote ? `（回 ${line.quote.sender}「${line.quote.text.slice(0, 60)}」）` : '';
      return `[${hhmm(line.timestamp)}] ${line.senderName}${arrow}: ${quote}${text}`;
    })
    .join('\n');
}
