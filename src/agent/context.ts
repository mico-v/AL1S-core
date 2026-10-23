/**
 * 群聊滚动缓冲。
 *
 * 群里没人 @ 机器人时，消息不进模型（省钱也不刷屏），但留在这里；
 * 等下次有人 @，把「上次说话之后群里聊了什么」一起喂进去。
 */

export interface BufferedLine {
  senderName: string;
  text: string;
  timestamp: number;
}

export class GroupBuffer {
  private readonly byGroup = new Map<string, BufferedLine[]>();
  private readonly limit: number;

  constructor(limit = 40) {
    this.limit = Math.max(0, limit);
  }

  push(groupOpenid: string, line: BufferedLine): void {
    if (this.limit === 0) {
      return;
    }
    const list = this.byGroup.get(groupOpenid) ?? [];
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

  clear(groupOpenid?: string): void {
    if (groupOpenid) {
      this.byGroup.delete(groupOpenid);
    } else {
      this.byGroup.clear();
    }
  }
}

/** 把缓冲渲染成可注入的文本块。 */
export function renderBuffer(lines: BufferedLine[]): string {
  if (lines.length === 0) {
    return '';
  }
  return lines
    .map((line) => `${line.senderName}: ${line.text.replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}
