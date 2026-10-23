/**
 * QQ 消息正文清洗。
 *
 * QQ 的群消息正文里塞着一堆协议标记：`<@openid>`、`<faceType=...>`。
 * 直接喂给模型会污染上下文（而且 `ext="***"` 这类字段长得像密钥）。
 */

/** `<@010356...>` → `@某人`；`<faceType=6,...>` → `[表情]`。 */
export function cleanQQText(raw: string): string {
  return raw
    .replace(/<@!?([0-9A-Fa-f]{16,})>/g, '@某人')
    .replace(/<faceType=[^>]*>/gi, '[表情]')
    .replace(/<img[^>]*>/gi, '[图片]')
    .replace(/\[CQ:[^\]]+\]/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
