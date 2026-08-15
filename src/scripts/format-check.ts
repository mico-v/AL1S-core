/**
 * 格式化核心冒烟脚本：不连 QQ/LLM，直接对样例文本跑 cleanText / buildSegments，
 * 断言 Markdown 清理与分段符合预期，离线自证格式化逻辑。
 *
 * 用法：npm run format:check
 */
import { cleanText, buildSegments, renderSegment } from '../format/output-spec';

let failed = false;

/** 断言：失败时打印原因并置 failed */
function assert(cond: boolean, label: string, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failed = true;
    console.error(`  ✗ ${label}${detail ? `（${detail}）` : ''}`);
  }
}

console.log('== cleanText：Markdown 清理 ==');
const md = [
  '# 标题',
  '**粗体** 和 *斜体* 还有 `代码`',
  '![图片](http://x/a.png) [链接](http://x/b)',
  '- 列表项',
  '> 引用',
].join('\n');
const cleaned = cleanText(md);
assert(!cleaned.includes('# 标题'), '标题被移除');
assert(cleaned.includes('标题'), '标题文字保留');
assert(!cleaned.includes('**粗体**') && cleaned.includes('粗体'), '粗体语法移除、文字保留');
assert(!cleaned.includes('*斜体*') && cleaned.includes('斜体'), '斜体语法移除、文字保留');
assert(!cleaned.includes('`代码`') && cleaned.includes('代码'), '行内代码语法移除');
assert(!cleaned.includes('![图片]') && cleaned.includes('图片'), '图片转 alt 文字');
assert(!cleaned.includes('[链接]') && cleaned.includes('链接'), '链接转文字');
assert(!cleaned.includes('- 列表项') && cleaned.includes('列表项'), '列表标记移除');
assert(!cleaned.includes('> 引用') && cleaned.includes('引用'), '引用标记移除');

console.log('== buildSegments：标题结构切段 ==');
const article = [
  '# 第一章 概览',
  '这是第一段正文内容。',
  '这是第二段正文内容。',
  '## 1.1 表格示例',
  '| 姓名 | 分数 |',
  '| --- | --- |',
  '| 张三 | 98 |',
  '| 李四 | 100 |',
  '结尾一段。',
].join('\n');
const segs = buildSegments(article);
for (const s of segs) console.log(`  [${s.type}] ${s.text.slice(0, 60)}${s.text.length > 60 ? '…' : ''}`);
// 有标题模式下，标题与其后正文合并为一段 text（对应原实现的合并逻辑）
assert(segs.some((s) => s.type === 'text' && s.text.includes('第一章 概览') && s.text.includes('第一段正文')), '标题与正文合并为一段');
assert(segs.some((s) => s.type === 'table'), '识别到 table 段');
assert(segs.some((s) => s.type === 'text' && s.text.includes('结尾一段')), '结尾文本段存在');

console.log('== renderSegment：表格对齐 ==');
const tableSeg = segs.find((s) => s.type === 'table');
if (tableSeg) {
  const rendered = renderSegment(tableSeg);
  console.log(rendered.split('\n').map((l) => `  | ${l}`).join('\n'));
  assert((rendered.split('\n')[1] ?? '').includes('-'.repeat(3)), '表头下补 --- 分隔行');
  assert(rendered.split('\n')[0]!.includes('| 姓名 | 分数 |'), '表头保留');
}

console.log('== buildSegments：框线表格 ==');
const box = [
  '┌────┬────┐',
  '│ 项目 │ 数值 │',
  '├────┼────┤',
  '│ A │ 1 │',
  '└────┴────┘',
].join('\n');
const boxSegs = buildSegments(box);
const boxSeg = boxSegs.find((s) => s.type === 'box_table');
assert(boxSeg !== undefined, '识别到 box_table 段');
if (boxSeg) {
  const rendered = renderSegment(boxSeg);
  console.log(rendered.split('\n').map((l) => `  | ${l}`).join('\n'));
  assert(!/┌|┐|└|┘|│|─|├|┤/.test(rendered), '框线被清洗为纯文本');
  assert(rendered.includes('项目') && rendered.includes('A'), '框线表格内容保留');
}

if (failed) {
  console.error('\nformat:check 失败');
  process.exit(1);
}
console.log('\nformat:check 通过');
process.exit(0);
