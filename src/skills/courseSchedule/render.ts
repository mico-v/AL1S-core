/**
 * 课程表图片渲染（移植自 astrbot_plugin_CourseSchedule/plugin/render.py，Pillow → @napi-rs/canvas）。
 * 1100px 宽、表头 + 行卡片 + QQ 头像（q1.qlogo.cn，失败用占位）。找不到中文字体时降级 sans-serif。
 * 渲染失败由调用方兜底为文本输出。
 */

import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';

/** 一行课表 */
export interface RenderRow {
  user_id: string;
  name: string;
  subtitle: string;
  status: string;
  course: string;
  time: string;
}

const FONT_CANDIDATES = [
  'COURSE_FONT_PATH',
  'astrbot_plugin_CourseSchedule/assets/fonts/NotoSansCJKsc-Regular.otf',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];

let cachedFontFamily: string | null | undefined;

/** 查找并注册一个中文字体，返回可用字体族名；找不到返回 null */
function resolveFontFamily(): string | null {
  if (cachedFontFamily !== undefined) return cachedFontFamily;
  for (const candidate of FONT_CANDIDATES) {
    const path = candidate === 'COURSE_FONT_PATH' ? process.env.COURSE_FONT_PATH : candidate;
    if (!path || !existsSync(path)) continue;
    const family = `course-font-${Buffer.from(path).toString('base64').slice(0, 12)}`;
    try {
      if (GlobalFonts.registerFromPath(path, family)) {
        cachedFontFamily = family;
        return family;
      }
    } catch {
      // 尝试下一个
    }
  }
  cachedFontFamily = null;
  return null;
}

function fontFamily(): string {
  return resolveFontFamily() ?? 'sans-serif';
}

/** 文本截断（按 canvas 测量宽度） */
function ellipsis(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const suffix = '...';
  let t = text;
  while (t && ctx.measureText(`${t}${suffix}`).width > maxWidth) t = t.slice(0, -1);
  return t ? `${t}${suffix}` : suffix;
}

/** 拉取 QQ 头像为圆角图像；失败画占位圆（后两位 QQ 号） */
async function drawAvatar(ctx: SKRSContext2D, x: number, y: number, size: number, userId: string): Promise<void> {
  let img: Awaited<ReturnType<typeof loadImage>> | null = null;
  try {
    const resp = await fetch(`https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(userId)}&s=100`, {
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      img = await loadImage(buf);
    }
  } catch {
    img = null;
  }

  const cx = x + size / 2;
  const cy = y + size / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (img) {
    ctx.drawImage(img, x, y, size, size);
  } else {
    ctx.fillStyle = '#d8dee9';
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = '#3b4252';
    ctx.font = `bold 20px ${fontFamily()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = userId.length >= 2 ? userId.slice(-2) : userId || '?';
    ctx.fillText(label, cx, cy);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 渲染课表图为 PNG buffer；失败抛错（由调用方降级为文本） */
export async function drawRowsImage(title: string, rows: RenderRow[]): Promise<Buffer> {
  const width = 1100;
  const rowHeight = 104;
  const headerHeight = 116;
  const footerHeight = 28;
  const height = Math.max(260, headerHeight + rowHeight * Math.max(rows.length, 1) + footerHeight);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const family = fontFamily();

  ctx.fillStyle = '#f5f7fb';
  ctx.fillRect(0, 0, width, height);

  // 顶栏标题
  ctx.fillStyle = '#263238';
  ctx.fillRect(0, 0, width, 92);
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 36px ${family}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(title, 36, 46);

  if (rows.length === 0) {
    ctx.fillStyle = '#607d8b';
    ctx.font = `22px ${family}`;
    ctx.textAlign = 'center';
    ctx.fillText('暂无课程数据', width / 2, height / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    return canvas.toBuffer('image/png');
  }

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const top = headerHeight + index * rowHeight;
    const left = 30;
    const right = width - 30;

    ctx.fillStyle = index % 2 === 0 ? '#ffffff' : '#eef3f8';
    roundRect(ctx, left, top, right - left, 86, 10);
    ctx.fill();

    await drawAvatar(ctx, left + 20, top + 14, 58, row.user_id);

    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#263238';
    ctx.font = `bold 24px ${family}`;
    ctx.fillText(ellipsis(ctx, row.name, 240), left + 92, top + 26);

    ctx.fillStyle = '#607d8b';
    ctx.font = `18px ${family}`;
    ctx.fillText(row.subtitle, left + 92, top + 58);

    ctx.fillStyle = row.status === '正在上' ? '#2e7d32' : '#1565c0';
    ctx.font = `bold 24px ${family}`;
    ctx.fillText(row.status, left + 365, top + 24);

    ctx.fillStyle = '#263238';
    ctx.font = `22px ${family}`;
    ctx.fillText(ellipsis(ctx, row.course, 510), left + 470, top + 24);

    ctx.fillStyle = '#455a64';
    ctx.font = `18px ${family}`;
    ctx.fillText(row.time, left + 470, top + 58);
  }
  ctx.textBaseline = 'alphabetic';
  return canvas.toBuffer('image/png');
}
