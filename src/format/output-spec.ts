/**
 * LLM 输出格式化核心（移植自 astrbot_plugin_al1s_core/output_spec.py）。
 *
 * 两路能力：
 * - cleanText：去除常见 Markdown 语法，保留可读文本（纯正则）。
 * - buildSegments：把长文本按「文章结构」或「空行」切成若干段，识别并保留
 *   Unicode 边框表格（box_table）与 Markdown 管道表格（table），支持后续分条发送。
 * 零运行时依赖：宽度计算用 Unicodedata east_asian_width 的 W/F 近似正则。
 */

// --- 段类型与配置 ---

/** 分段结果的段类型 */
export type SegmentKind = 'text' | 'heading' | 'table' | 'box_table';

/** 一段可发送的内容 */
export interface Segment {
  type: SegmentKind;
  text: string;
}

/** 分段延时配置（calcDelay 使用） */
export interface SplitConfig {
  charsPerSecond: number;
  minDelay: number;
  maxDelay: number;
}

// --- Markdown 清理 ---

/** 去除常见 Markdown 语法，保留内容文本 */
export function cleanText(text: string): string {
  // 代码块（保留内容）
  let out = text.replace(/```(?:[a-zA-Z0-9+\-]*\s+)?([\s\S]*?)```/g, '$1');
  // 行内代码 `code` -> code
  out = out.replace(/`([^`]+)`/g, '$1');
  // 图片 ![alt](url) -> alt（避免残留 !）
  out = out.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  // 普通链接 [text](url) -> text
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // 粗体
  out = out.replace(/\*\*(.*?)\*\*/g, '$1');
  out = out.replace(/__(.*?)__/g, '$1');
  // 斜体（保守处理，减少误伤）
  out = out.replace(/(?<!\*)\*(?!\s)(.*?)(?<!\s)\*(?!\*)/g, '$1');
  out = out.replace(/(?<!\w)_(?!\s)(.*?)(?<!\s)_(?!\w)/g, '$1');
  // 删除线
  out = out.replace(/~~(.*?)~~/g, '$1');
  // 标题
  out = out.replace(/^(#{1,6})\s+(.*)/gm, '$2');
  // 引用（处理嵌套）
  out = out.replace(/^(?:>\s*)+(.*)/gm, '$1');
  // 列表标记（行首 -、*、+）
  out = out.replace(/^\s*[-*+]\s+(.*)/gm, '$1');
  // 有序列表标记（行首 1. 2.）
  out = out.replace(/^\s*\d+[.)]\s+(.*)/gm, '$1');
  // 任务列表标记（- [x]）
  out = out.replace(/^\s*[-*+]\s+\[[xX ]\]\s+(.*)/gm, '$1');
  return out;
}

// --- 行/块识别 ---

/** 识别只包含分隔符的行（可作为段落边界） */
function isBlockDivider(line: string): boolean {
  if (!line) return false;
  const s = line.trim();
  return /^[-*`_=]{3,}$/.test(s) || /^\|(?:\s*[-:]{3,}\s*\|?)+\s*$/.test(s);
}

/** 中文编号/项目符号风格标题识别（移植自 output_spec 的 pattern 列表） */
const HEADING_PATTERNS: RegExp[] = [
  /^\s*[✦•·*]+\s*[第]?(?:[0-9]+|[一二三四五六七八九十百千万零〇两壹贰叁肆伍陆柒捌玖拾佰仟]+|[IVXLCDM]+)\s*[、。·•]\s*\S+$/,
  /^\s*[第]?(?:[0-9]+|[一二三四五六七八九十百千万零〇两壹贰叁肆伍陆柒捌玖拾佰仟]+|[IVXLCDM]+)\s*[、。·•]\s*\S+$/,
  /^\s*[✦•·*]+\s*[一二三四五六七八九十百千万零〇两壹贰叁肆伍陆柒捌玖拾佰仟]+\s*[章节回卷篇卷]\s*[：:、。·•]?\s*\S+$/,
  /^\s*[一二三四五六七八九十百千万零〇两壹贰叁肆伍陆柒捌玖拾佰仟]+\s*[章节回卷篇卷]\s*[：:、。·•]?\s*\S+$/,
  /^\s*[✦•*]?\s*[一-鿿]{1,10}\s*[·•]\s*\S+$/,
  /^[💖💗💘💙💚💛💜🤍🖤🤎❤️🧡💝💌✦]\s*[一-鿿A-Za-z0-9].*?[一-鿿A-Za-z0-9💖💗💘💙💚💛💜🤍🖤🤎❤️🧡💝💌]$/,
  /^\s*[✦•*]+\s*\S{2,40}\s*[：:]\s*$/,
];

/** 判断是否为标题行 */
function isMarkdownHeadingLine(line: string): boolean {
  if (!line) return false;
  const cleaned = line.trim();
  if (!cleaned) return false;
  if (/^\s*#{1,6}\s+\S+/.test(cleaned)) return true;
  return HEADING_PATTERNS.some((p) => p.test(cleaned));
}

/** 判断是否为列表行 */
function isListLine(line: string): boolean {
  return /^\s*(?:\d{1,3}[.)、]\s+|[-+*]\s+|[-+*]\s+\[[xX ]\]\s+|[-+*]\s*\|\s*|[•·]\s+)/.test(line);
}

/** 去掉列表行标记，保留内容 */
function normalizeListLine(line: string): string {
  if (!line) return '';
  let out = line;
  out = out.replace(/^\s*[-+*]\s+\[[xX ]\]\s+/, '');
  out = out.replace(/^\s*\d{1,3}[.)、]\s+/, '');
  out = out.replace(/^\s*[-+*]\s*\|\s*/, '');
  out = out.replace(/^\s*[-+*]\s+/, '');
  out = out.replace(/^\s*[•·]\s+/, '');
  return out.trim();
}

// --- Unicode 边框表格 ---

const BOX_CHARS = '┌┐└┘├┤┬┴┼─━│╭╮╯╰╏╎╵╷╔╗╚╝╠╣╦╩╬║═┏┓┗┛';
const BOX_CHAR_SET = new Set(BOX_CHARS);
const BORDER_ONLY_CHARS = '┌┐└┘├┤┬┴┼─━╭╮╯╰╏╎╵╷╔╗╚╝╠╣╦╩╬║═┏┓┗┛';
const BORDER_ONLY_SET = new Set(BORDER_ONLY_CHARS);

/** 判断某行是否属于 Unicode 边框表格（只含框线/空白/可打印字符） */
function isBoxTableLine(line: string): boolean {
  if (!line) return false;
  if (![...line].some((ch) => BOX_CHAR_SET.has(ch))) return false;
  for (const ch of line) {
    if (ch === '\r' || ch === '\n') return false;
    if (/\s/.test(ch)) continue; // 空白
    if (BOX_CHAR_SET.has(ch)) continue;
    if (/[\p{C}]/u.test(ch)) return false; // 控制/格式字符 → 不可打印
  }
  return true;
}

/** 从 lines 的 startIndex 起连续收集边框表格行 */
function extractBoxTableLines(lines: string[], startIndex: number): [string[], number] | null {
  let index = startIndex;
  if (index >= lines.length) return null;
  const tableLines: string[] = [];
  while (index < lines.length) {
    const line = lines[index]!.replace(/\r$/, '');
    if (!line) break;
    if (isBlockDivider(line)) break;
    if (!isBoxTableLine(line)) break;
    tableLines.push(line);
    index++;
  }
  if (tableLines.length < 2) return null;
  return [tableLines, index];
}

/** 判断某行是否纯框线（不含内容，可跳过） */
function isBoxBorderOnlyLine(line: string): boolean {
  const stripped = line.trim();
  if (!stripped) return false;
  for (const ch of stripped) {
    if (BORDER_ONLY_SET.has(ch) || /\s/.test(ch)) continue;
    return false;
  }
  return true;
}

/** 把 Unicode 边框表格转成纯文本（去框线、│→|、按 | 分隔） */
function normalizeBoxTable(tableText: string): string {
  const rawRows = tableText
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() !== '');
  if (rawRows.length === 0) return tableText.trim();

  const normalizedRows: string[] = [];
  for (const line of rawRows) {
    if (isBoxBorderOnlyLine(line)) continue;
    const hasVertical = /[│║╎╏]/.test(line);
    const pieces: string[] = [];
    for (const ch of line) {
      if (/[│║╎╏]/.test(ch)) {
        pieces.push('|');
        continue;
      }
      if (BOX_CHAR_SET.has(ch)) continue;
      pieces.push(ch);
    }
    let text = pieces.join('').trim();
    if (!text) continue;
    if (hasVertical) {
      text = text.replace(/^\|+/, '').replace(/\|+$/, '').trim();
      text = text.replace(/\s*\|\s*/g, ' | ').trim();
    }
    normalizedRows.push(text);
  }
  return normalizedRows.join('\n');
}

/** 在普通文本中扫描边框表格块并逐块清洗（send 前兜底） */
function normalizeBoxTableFromText(text: string): string {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines.length === 0) return text.trim();

  const outputLines: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const rawLine = lines[index]!;
    if (!rawLine.trim() || !isBoxTableLine(rawLine)) {
      outputLines.push(rawLine.replace(/\s+$/, ''));
      index++;
      continue;
    }
    const block: string[] = [];
    while (index < lines.length && isBoxTableLine(lines[index]!)) {
      block.push(lines[index]!.replace(/\s+$/, ''));
      index++;
    }
    if (block.length >= 2) {
      const normalized = normalizeBoxTable(block.join('\n'));
      if (normalized) outputLines.push(normalized);
    } else {
      outputLines.push(...block);
    }
  }
  return outputLines.join('\n');
}

// --- Markdown 管道表格 ---

/** 判断是否表格数据行（含至少 2 个 | 且首尾 | 包裹） */
function isTableRow(rawLine: string): boolean {
  const line = rawLine.trim();
  if (!line) return false;
  if ((line.match(/\|/g) ?? []).length < 2) return false;
  return /^\s*\|(?:[^|\r\n]*\|)+\s*$/.test(line);
}

/** 判断是否表格分隔行（|---| 或 |:---:|） */
function isTableDividerRow(rawLine: string): boolean {
  const line = rawLine.trim();
  if (!line) return false;
  return /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line);
}

/** 从 lines 的 startIndex 起连续收集 Markdown 表格行 */
function extractTableLines(lines: string[], startIndex: number): [string[], number] | null {
  let index = startIndex;
  if (index >= lines.length) return null;
  const tableLines: string[] = [];
  let dataRowCount = 0;
  while (index < lines.length) {
    const line = lines[index]!.trim();
    if (isTableDividerRow(line)) {
      if (dataRowCount > 0) {
        index++;
        continue;
      }
      break;
    }
    if (!line || isBlockDivider(line)) break;
    if (!isTableRow(line)) break;
    tableLines.push(lines[index]!.replace(/\r$/, ''));
    dataRowCount++;
    index++;
  }
  if (dataRowCount < 2) return null;
  return [tableLines, index];
}

/** 解析表格文本为单元格数组 */
function parseTableRows(text: string): string[][] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length < 2) return [];
  const tableRows: string[][] = [];
  for (const line of lines) {
    if (isTableDividerRow(line)) continue;
    if (!isTableRow(line)) return [];
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    if (cells.length) tableRows.push(cells);
  }
  if (tableRows.length < 2) return [];
  return tableRows;
}

// --- 宽度计算与表格对齐 ---

/** east_asian_width 的 W/F 近似（Unicode 宽字符常见区间） */
const WIDE_CHAR_RE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/;

/** 展示宽度：全角/宽字符计 2，其余计 1，制表符计 4 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (ch === '\t') {
      width += 4;
      continue;
    }
    width += WIDE_CHAR_RE.test(ch) ? 2 : 1;
  }
  return width;
}

/** 按列宽格式化单行表格 */
function formatTableRow(cells: string[], widthList: number[]): string {
  const pieces: string[] = [];
  for (let idx = 0; idx < cells.length; idx++) {
    const text = (cells[idx] ?? '').trim();
    const pad = Math.max(0, widthList[idx]! - displayWidth(text));
    pieces.push(` ${text}${' '.repeat(pad)} `);
  }
  return `|${pieces.join('|')}|`;
}

/** 把 Markdown 表格重排为对齐的 | a | b | 文本，并在表头后补 --- 分隔行 */
export function formatMarkdownTable(tableText: string): string {
  const rows = parseTableRows(tableText);
  if (rows.length === 0) return tableText.trim();

  const maxCols = Math.max(...rows.map((r) => r.length));
  const normalizedRows = rows.map((r) => [...r, ...Array<string>(maxCols - r.length).fill('')]);
  const colWidths: number[] = Array(maxCols).fill(0);
  for (const row of normalizedRows) {
    for (let idx = 0; idx < row.length; idx++) {
      const width = displayWidth((row[idx] ?? '').trim());
      if (width > colWidths[idx]!) colWidths[idx] = width;
    }
  }

  const outputRows: string[] = [];
  for (let idx = 0; idx < normalizedRows.length; idx++) {
    outputRows.push(formatTableRow(normalizedRows[idx]!, colWidths));
    if (idx === 0 && normalizedRows.length > 1) {
      outputRows.push(`|${colWidths.map((c) => ` ${'-'.repeat(Math.max(3, c))} `).join('|')}|`);
    }
  }
  return outputRows.join('\n');
}

// --- 分段（buildSegments） ---

/**
 * 把长文本切成若干段：有标题按「文章结构」切，无标题按「空行」切。
 * 边框表格/管道表格各自成段；列表项聚合；标题与其后同节文本合并。
 */
export function buildSegments(text: string): Segment[] {
  const rawLines = (text ?? '').replace(/\r\n/g, '\n').split('\n');
  const hasHeading = rawLines.some((l) => l.trim() !== '' && isMarkdownHeadingLine(l));
  const parsedBlocks: Array<[SegmentKind, string]> = [];
  let i = 0;

  const addTextBlock = (lines: string[]): void => {
    const block = lines
      .map((ln) => ln.trim())
      .filter((ln) => ln !== '')
      .join('\n');
    if (block) parsedBlocks.push(['text', block]);
  };

  while (i < rawLines.length) {
    const rawLine = rawLines[i]!;
    const line = rawLine.replace(/\r$/, '');

    // 空行/分隔线 → 段落边界
    if (line.trim() === '' || isBlockDivider(line)) {
      i++;
      continue;
    }

    // Unicode 边框表格整体成段
    const boxResult = extractBoxTableLines(rawLines, i);
    if (boxResult) {
      parsedBlocks.push(['box_table', boxResult[0].join('\n')]);
      i = boxResult[1]!;
      continue;
    }

    // Markdown 管道表格整体成段
    const tableResult = extractTableLines(rawLines, i);
    if (tableResult) {
      parsedBlocks.push(['table', tableResult[0].join('\n').trim()]);
      i = tableResult[1]!;
      continue;
    }

    // 标题行
    if (isMarkdownHeadingLine(line)) {
      parsedBlocks.push(['heading', line.trim()]);
      i++;
      continue;
    }

    // 连续列表项聚合
    if (isListLine(line)) {
      const listLines: string[] = [];
      while (i < rawLines.length) {
        const current = rawLines[i]!.replace(/\r$/, '');
        if (isListLine(current)) {
          const normalized = normalizeListLine(current);
          if (normalized) listLines.push(normalized);
          i++;
        } else {
          break;
        }
      }
      if (listLines.length) parsedBlocks.push(['text', listLines.join('\n')]);
      continue;
    }

    // 普通段落按空行聚合
    const paragraphLines: string[] = [];
    while (i < rawLines.length) {
      const current = rawLines[i]!.replace(/\r$/, '');
      if (current.trim() === '' || isBlockDivider(current)) {
        if (hasHeading) {
          i++;
          continue;
        }
        break;
      }
      if (extractTableLines(rawLines, i)) break;
      if (isMarkdownHeadingLine(current)) {
        if (hasHeading) break;
      }
      if (isListLine(current)) break;
      if (extractBoxTableLines(rawLines, i)) break;
      paragraphLines.push(current);
      i++;
    }

    if (paragraphLines.length) {
      addTextBlock(paragraphLines);
    } else {
      i++;
    }
  }

  // 后处理合并：标题与其后同节文本合并；表格单独成段
  const merged: Segment[] = [];
  let index = 0;
  while (index < parsedBlocks.length) {
    const [blockType, blockText] = parsedBlocks[index]!;

    if (hasHeading && blockType === 'heading') {
      const heading = blockText.trim();
      let sectionChunks: string[] = [heading];
      index++;
      while (index < parsedBlocks.length) {
        const [nextType, nextText] = parsedBlocks[index]!;
        if (nextType === 'heading') break;
        if (nextType === 'table' || nextType === 'box_table') {
          if (sectionChunks.length) {
            merged.push({ type: 'text', text: sectionChunks.join('\n') });
            sectionChunks = [];
          }
          merged.push({ type: nextType, text: nextText });
        } else if (nextType === 'text' && nextText.trim() !== '') {
          sectionChunks.push(nextText.trim());
        }
        index++;
      }
      if (sectionChunks.length) merged.push({ type: 'text', text: sectionChunks.join('\n') });
      continue;
    }

    if (!hasHeading && blockType === 'text' && index + 1 < parsedBlocks.length) {
      const [nextType, nextText] = parsedBlocks[index + 1]!;
      if (nextType === 'box_table') {
        merged.push({ type: 'text', text: `${blockText}\n${nextText}` });
        index += 2;
        continue;
      }
    }

    if (blockType === 'heading' && index + 1 < parsedBlocks.length) {
      const [nextType, nextText] = parsedBlocks[index + 1]!;
      if (nextType !== 'heading' && nextType !== 'table' && nextType !== 'box_table') {
        merged.push({ type: 'text', text: `${blockText}\n${nextText}` });
        index += 2;
        continue;
      }
    }

    if (blockType === 'table' || blockType === 'box_table') {
      merged.push({ type: blockType, text: blockText });
    } else {
      merged.push({ type: 'text', text: blockText });
    }
    index++;
  }

  return merged.filter((s) => s.text.trim() !== '');
}

// --- 延时 ---

/** 按字数估算发送延时（秒），夹在 [minDelay, maxDelay] */
export function calcDelay(text: string, cfg: SplitConfig): number {
  if (!text) return 0;
  const charsPerSec = cfg.charsPerSecond > 0 ? cfg.charsPerSecond : 1;
  const minDelay = cfg.minDelay;
  let maxDelay = cfg.maxDelay;
  if (maxDelay < minDelay) maxDelay = minDelay;
  let delay = text.length / charsPerSec;
  if (delay < minDelay) delay = minDelay;
  if (delay > maxDelay) delay = maxDelay;
  return delay;
}

/** 把某段渲染为最终发送文本（表格做对齐/框线清洗） */
export function renderSegment(seg: Segment): string {
  if (seg.type === 'table') return formatMarkdownTable(seg.text);
  if (seg.type === 'box_table') return normalizeBoxTable(seg.text);
  const t = seg.text.trim();
  if (t && /[┌┐└┘├┤┬┴┼─━│╭╮╯╰╏╎╵╷╔╗╚╝╠╣╦╩╬║═┏┓┗┛]/.test(t)) {
    const normalized = normalizeBoxTableFromText(t);
    if (normalized) return normalized;
  }
  return t;
}
