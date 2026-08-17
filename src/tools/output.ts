const encoder = new TextEncoder();

/** 按 UTF-8 字节上限截断，避免把不完整字节直接拼到审计输出。 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return { text, truncated: false, bytes: bytes.byteLength };
  const cut = bytes.subarray(0, Math.max(0, maxBytes));
  let result = new TextDecoder('utf-8', { fatal: false }).decode(cut);
  // TextDecoder 对截断的尾部会产生替换字符，不把替换字符暴露给调用方。
  result = result.replace(/�$/, '');
  return { text: `${result}\n[输出已截断]`, truncated: true, bytes: bytes.byteLength };
}
