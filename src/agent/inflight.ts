/**
 * 回合留痕：进程被重启或杀掉时，靠一个标记文件知道「上一轮没跑完」。
 *
 * 2026-11-22 实测：群里说「继续」触发的回合跑到第 24 轮，gateway 因为发版被 SIGTERM，
 * 回复没发出去、续跑也没排上；目标状态恰好是 done，续跑巡检每 2 分钟静默跳过 ——
 * 群里安静了三小时，主人只能来问「好像又卡住了」。
 *
 * 所以：回合开始落一个标记，正常结束删掉；启动后巡检看到残留就知道被打断过，
 * 该续的续、该说的说，不再静默。
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface InflightMark {
  chatId: string;
  /** 回合开始时间（ISO）。 */
  startedAt: string;
  /** 谁触发的这一轮。 */
  kind: 'goal' | 'chat';
}

export function inflightDir(dataRoot: string): string {
  return path.join(dataRoot, 'inflight');
}

function inflightPath(dataRoot: string, chatId: string): string {
  return path.join(inflightDir(dataRoot), `${chatId.replace(/[^0-9A-Za-z_-]/g, '_')}.json`);
}

export async function markInflight(dataRoot: string, mark: InflightMark): Promise<void> {
  try {
    await mkdir(inflightDir(dataRoot), { recursive: true });
    await writeFile(inflightPath(dataRoot, mark.chatId), JSON.stringify(mark));
  } catch {
    // 留痕失败不能拖累正常对话
  }
}

export async function clearInflight(dataRoot: string, chatId: string): Promise<void> {
  await rm(inflightPath(dataRoot, chatId), { force: true }).catch(() => undefined);
}

/** 列出残留标记；读不动的坏文件顺手清掉。 */
export async function listInflight(dataRoot: string): Promise<InflightMark[]> {
  const dir = inflightDir(dataRoot);
  const files = await readdir(dir).catch(() => [] as string[]);
  const marks: InflightMark[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }
    const full = path.join(dir, file);
    try {
      const parsed = JSON.parse(await readFile(full, 'utf8')) as InflightMark;
      if (parsed?.chatId && parsed.startedAt) {
        marks.push(parsed);
      } else {
        await rm(full, { force: true }).catch(() => undefined);
      }
    } catch {
      await rm(full, { force: true }).catch(() => undefined);
    }
  }
  return marks;
}

/** 给人看的时间：11-22 08:06。 */
export function describeInterrupted(mark: InflightMark): string {
  const at = new Date(mark.startedAt);
  if (Number.isNaN(at.getTime())) {
    return '上一轮';
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
