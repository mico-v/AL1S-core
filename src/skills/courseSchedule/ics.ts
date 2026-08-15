/**
 * .ics 课程表解析/序列化（移植自 astrbot_plugin_CourseSchedule/plugin/ics.py）。
 * 纯手写实现，零依赖：行折叠/展开、转义、RRULE 解析、VEVENT 结构化。
 */

import { combineLocalDate, nowLocal, SHANGHAI_OFFSET_MS } from './tz';

export const MAX_EVENTS_PER_FILE = 120;

/** 结构化课程事件（iCalendar VEVENT 关键字段） */
export interface ScheduleEvent {
  SUMMARY?: string;
  LOCATION?: string;
  DESCRIPTION?: string;
  DTSTART?: string;
  DTEND?: string;
  RRULE?: string;
  UID?: string;
  DTSTAMP?: string;
  DTSTART_TZID?: string;
  DTEND_TZID?: string;
}

/** 展开 .ics 的行折叠（续行以空格/制表符开头） */
function unfoldIcsLines(content: string): string[] {
  const lines: string[] = [];
  for (const raw of content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length) {
      lines[lines.length - 1]! += raw.slice(1);
    } else {
      lines.push(raw);
    }
  }
  return lines;
}

function decodeIcsText(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\N/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function encodeIcsText(value: string): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .trim();
}

/** 按 UTF-8 字节数（≤75）折叠长行 */
function foldIcsLine(line: string): string[] {
  if (Buffer.byteLength(line, 'utf-8') <= 75) return [line];
  const out: string[] = [];
  let current = '';
  let currentLen = 0;
  for (const ch of line) {
    const chLen = Buffer.byteLength(ch, 'utf-8');
    if (current && currentLen + chLen > 75) {
      out.push(current);
      current = ` ${ch}`;
      currentLen = 1 + chLen;
    } else {
      current += ch;
      currentLen += chLen;
    }
  }
  if (current) out.push(current);
  return out;
}

function serializeIcsProperty(name: string, value: string, params?: Record<string, string>): string[] {
  let paramText = '';
  if (params) {
    paramText = Object.entries(params)
      .filter(([, v]) => v)
      .map(([k, v]) => `;${k}=${v}`)
      .join('');
  }
  return foldIcsLine(`${name}${paramText}:${value}`);
}

/** 解析 iCalendar 时间文本为展示字符串（不换算时区，只重排字段） */
function parseIcsDatetime(value: string): string {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  const fmts: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
    [/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, (m) => `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]} UTC`],
    [/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/, (m) => `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`],
    [/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})$/, (m) => `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`],
    [/^(\d{4})(\d{2})(\d{2})$/, (m) => `${m[1]}-${m[2]}-${m[3]}`],
  ];
  for (const [re, fmt] of fmts) {
    const m = raw.match(re);
    if (m) return fmt(m);
  }
  return raw;
}

/** 解析 iCalendar 时间为本地 Date（UTC 字段 = 该时区墙上时钟）；tzid 按 Asia/Shanghai(+8) 处理 */
function parseIcsDatetimeObj(value: string, tzid?: string): Date | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const offsetMs = SHANGHAI_OFFSET_MS; // 只支持 +8（Asia/Shanghai），其余按 +8 处理

  // Z 结尾：UTC 时间 → 上海墙钟 = UTC + 8h
  const z = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (z) {
    return combineLocalDate(+z[1]!, +z[2]! - 1, +z[3]!, +z[4]!, +z[5]!);
  }
  // 本地浮动时间：直接按上海墙钟
  const local = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (local) {
    return combineLocalDate(+local[1]!, +local[2]! - 1, +local[3]!, +local[4]!, +local[5]!);
  }
  const localNoSec = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})$/);
  if (localNoSec) {
    return combineLocalDate(+localNoSec[1]!, +localNoSec[2]! - 1, +localNoSec[3]!, +localNoSec[4]!, +localNoSec[5]!);
  }
  // 全天日期
  const allDay = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (allDay) {
    return combineLocalDate(+allDay[1]!, +allDay[2]! - 1, +allDay[3]!);
  }
  // 兜底：如果带毫秒偏移的 ISO，转上海墙钟
  const iso = new Date(raw.includes('Z') ? raw : `${raw}Z`);
  if (!Number.isNaN(iso.getTime())) {
    const wall = iso.getTime() + offsetMs - (raw.includes('Z') ? 0 : offsetMs);
    void wall;
    return combineLocalDate(iso.getUTCFullYear(), iso.getUTCMonth(), iso.getUTCDate(), iso.getUTCHours(), iso.getUTCMinutes());
  }
  return null;
}

function parseRruleParts(value: string): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const item of String(value ?? '').split(';')) {
    const idx = item.indexOf('=');
    if (idx <= 0) continue;
    const key = item.slice(0, idx).toUpperCase();
    const val = item.slice(idx + 1);
    if (key && val) parts[key] = val;
  }
  return parts;
}

/** RRULE 展示文本 */
function parseRrule(value: string): string {
  if (!value) return '';
  const parts = parseRruleParts(value);
  const freqMap: Record<string, string> = { DAILY: '每天', WEEKLY: '每周', MONTHLY: '每月', YEARLY: '每年' };
  let text = freqMap[parts['FREQ'] ?? ''] ?? parts['FREQ'] ?? '';
  if (parts['BYDAY']) text += ` ${parts['BYDAY']}`;
  if (parts['COUNT']) text += ` 共 ${parts['COUNT']} 次`;
  if (parts['UNTIL']) text += ` 至 ${parseIcsDatetime(parts['UNTIL']!)}`;
  return text.trim();
}

function parseIcsKey(key: string): { name: string; params: Record<string, string> } {
  const seg = key.split(';');
  const name = seg[0]!.toUpperCase();
  const params: Record<string, string> = {};
  for (const item of seg.slice(1)) {
    const idx = item.indexOf('=');
    if (idx <= 0) continue;
    params[item.slice(0, idx).toUpperCase()] = item.slice(idx + 1);
  }
  return { name, params };
}

function parseIcsEvents(content: string): ScheduleEvent[] {
  const events: ScheduleEvent[] = [];
  let current: ScheduleEvent | null = null;
  for (const line of unfoldIcsLines(content)) {
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (upper === 'END:VEVENT') {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (current === null || !line.includes(':')) continue;
    const colon = line.indexOf(':');
    const key = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const { name, params } = parseIcsKey(key);
    if (name === 'SUMMARY' || name === 'LOCATION' || name === 'DESCRIPTION') {
      current[name] = decodeIcsText(value);
    } else if (name === 'DTSTART' || name === 'DTEND' || name === 'RRULE' || name === 'UID' || name === 'DTSTAMP') {
      current[name] = value.trim();
      if (params['TZID'] && (name === 'DTSTART' || name === 'DTEND')) {
        current[`${name}_TZID`] = params['TZID'];
      }
    }
  }
  events.sort((a, b) => (a['DTSTART'] ?? '').localeCompare(b['DTSTART'] ?? ''));
  return events.slice(0, MAX_EVENTS_PER_FILE);
}

/** 把结构化事件格式化为可读文本课程表 */
export function formatIcsSchedule(events: ScheduleEvent[]): string {
  if (events.length === 0) return '未解析到课程事件。';
  const lines: string[] = [];
  events.forEach((event, i) => {
    const summary = event.SUMMARY || '未命名课程';
    const start = parseIcsDatetime(event.DTSTART ?? '');
    const end = parseIcsDatetime(event.DTEND ?? '');
    const location = event.LOCATION;
    const rrule = parseRrule(event.RRULE ?? '');
    const timeText = start ? (end ? `${start} - ${end}` : start) : end;
    let line = `${i + 1}. ${summary}`;
    if (timeText) line += ` | ${timeText}`;
    if (rrule) line += ` | ${rrule}`;
    if (location) line += ` | ${location}`;
    lines.push(line);
  });
  return lines.join('\n');
}

/** 解析 .ics 内容：返回事件列表 + 可读文本 */
export function parseScheduleIcs(content: string): { events: ScheduleEvent[]; scheduleText: string } {
  const events = parseIcsEvents(content);
  return { events, scheduleText: formatIcsSchedule(events) };
}

/** 序列化事件为 .ics 文本 */
export function serializeScheduleIcs(events: ScheduleEvent[]): string {
  const d = nowLocal();
  const pad = (n: number) => String(n).padStart(2, '0');
  const now = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AstrBot CourseSchedule//CN',
    'CALSCALE:GREGORIAN',
  ];
  for (const event of events) {
    const uid = event.UID || `${randomHex()}@astrbot-course-schedule`;
    const dtstamp = event.DTSTAMP || now;
    lines.push('BEGIN:VEVENT');
    lines.push(...serializeIcsProperty('UID', uid));
    lines.push(...serializeIcsProperty('DTSTAMP', dtstamp));
    for (const key of ['DTSTART', 'DTEND'] as const) {
      const value = event[key];
      if (!value) continue;
      const params: Record<string, string> = {};
      const tzid = event[`${key}_TZID`];
      if (tzid) params['TZID'] = tzid;
      lines.push(...serializeIcsProperty(key, value, params));
    }
    if (event.RRULE) lines.push(...serializeIcsProperty('RRULE', event.RRULE));
    if (event.SUMMARY) lines.push(...serializeIcsProperty('SUMMARY', encodeIcsText(event.SUMMARY)));
    if (event.LOCATION) lines.push(...serializeIcsProperty('LOCATION', encodeIcsText(event.LOCATION)));
    if (event.DESCRIPTION) lines.push(...serializeIcsProperty('DESCRIPTION', encodeIcsText(event.DESCRIPTION)));
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

function randomHex(): string {
  let out = '';
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

export { parseIcsDatetimeObj };
