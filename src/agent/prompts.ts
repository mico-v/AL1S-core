/** 仓库 prompts/ 下的提示词文件。
 *
 * 和 personas/ 一个待遇：口径要能单独改、能 review，不埋在代码字符串里。
 * dist 里也能读到（从 dist/agent/ 往上两级就是仓库根）。
 */

import { readFileSync } from 'node:fs';

const PROMPT_DIR = new URL('../../prompts/', import.meta.url);

export function readPrompt(name: string, fallback = ''): string {
  try {
    return readFileSync(new URL(`${name}.md`, PROMPT_DIR), 'utf8').trim();
  } catch {
    return fallback;
  }
}

/** 简单 {{var}} 替换：缺的变量留空，不引模板引擎。 */
export function renderPrompt(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => String(vars[key] ?? ''));
}
