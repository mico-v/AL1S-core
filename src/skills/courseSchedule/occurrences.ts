/**
 * 课程事件按时间范围展开（移植自 astrbot_plugin_CourseSchedule/plugin/occurrences.py）。
 * 支持无 RRULE 的单次事件与 WEEKLY 重复（BYDAY/INTERVAL/UNTIL/COUNT）。
 * 内部时间均为「上海本地墙钟」表示的 Date（见 tz.ts）。
 */

import { addLocalDays, combineLocalDate, formatHm, localDateParts, type LocalDateParts } from './tz';
import { parseIcsDatetimeObj, type ScheduleEvent } from './ics';

const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** 展开后的一次上课事件 */
export interface Occurrence extends ScheduleEvent {
  _start: Date;
  _end: Date;
}

function copyOccurrence(event: ScheduleEvent, start: Date, end: Date): Occurrence {
  return { ...event, _start: start, _end: end };
}

/** 事件起止时间：缺 DTEND 或 end<=start 时按 1.5 小时补足 */
function eventDatetimes(event: ScheduleEvent): { start: Date | null; end: Date | null } {
  const start = parseIcsDatetimeObj(event.DTSTART ?? '', event.DTSTART_TZID);
  let end = parseIcsDatetimeObj(event.DTEND ?? '', event.DTEND_TZID);
  if (start && (!end || end.getTime() <= start.getTime())) {
    end = new Date(start.getTime() + 90 * 60_000);
  }
  return { start, end };
}

/** 展开单个事件的重复 */
export function expandEventOccurrences(event: ScheduleEvent, startBound: Date, endBound: Date): Occurrence[] {
  const { start, end } = eventDatetimes(event);
  if (!start || !end) return [];
  const duration = end.getTime() - start.getTime();
  const rrule = event.RRULE ?? '';

  const singleOrEmpty = (): Occurrence[] =>
    start.getTime() < endBound.getTime() && end.getTime() > startBound.getTime()
      ? [copyOccurrence(event, start, end)]
      : [];

  if (!rrule) return singleOrEmpty();

  const parts: Record<string, string> = {};
  for (const item of rrule.split(';')) {
    const idx = item.indexOf('=');
    if (idx <= 0) continue;
    parts[item.slice(0, idx).toUpperCase()] = item.slice(idx + 1);
  }
  if (parts['FREQ'] !== 'WEEKLY') return singleOrEmpty();

  const startParts: LocalDateParts = localDateParts(start);
  let weekdays = [startParts.weekday];
  if (parts['BYDAY']) {
    const mapped = parts['BYDAY']
      .split(',')
      .map((c) => WEEKDAY_CODES.indexOf(c))
      .filter((i) => i >= 0);
    if (mapped.length) weekdays = mapped;
  }

  const until = parseIcsDatetimeObj(parts['UNTIL'] ?? '', event.DTSTART_TZID);
  const count = parseInt(parts['COUNT'] ?? '0', 10) || 0;
  const interval = Math.max(parseInt(parts['INTERVAL'] ?? '1', 10) || 1, 1);

  const startBoundParts = localDateParts(startBound);
  const endBoundParts = localDateParts(endBound);
  const cursorStart = combineLocalDate(startBoundParts.y, startBoundParts.m, startBoundParts.day - 7 * interval);
  const lastDate = combineLocalDate(endBoundParts.y, endBoundParts.m, endBoundParts.day + 7);
  const startWall = combineLocalDate(startParts.y, startParts.m, startParts.day, startParts.hour, startParts.minute);

  const occurrences: Occurrence[] = [];
  let generated = 0;
  let cursor = cursorStart;
  while (cursor.getTime() <= lastDate.getTime()) {
    const cp = localDateParts(cursor);
    if (weekdays.includes(cp.weekday)) {
      const occStart = combineLocalDate(cp.y, cp.m, cp.day, startParts.hour, startParts.minute);
      const weeksFromStart = Math.round((occStart.getTime() - startWall.getTime()) / (7 * 86_400_000));
      if (occStart.getTime() >= start.getTime() && weeksFromStart % interval === 0) {
        generated++;
        const occEnd = new Date(occStart.getTime() + duration);
        if (count && generated > count) break;
        if (until && occStart.getTime() > until.getTime()) break;
        if (occStart.getTime() < endBound.getTime() && occEnd.getTime() > startBound.getTime()) {
          occurrences.push(copyOccurrence(event, occStart, occEnd));
        }
      }
    }
    cursor = addLocalDays(cursor, 1);
  }

  occurrences.sort((a, b) => a._start.getTime() - b._start.getTime());
  return occurrences;
}

/** 展开某成员的全部事件 */
export function expandMemberOccurrences(memberInfo: object, startBound: Date, endBound: Date): Occurrence[] {
  const info = memberInfo as Record<string, unknown>;
  const events = info['events'];
  if (!Array.isArray(events)) return [];
  const occurrences: Occurrence[] = [];
  for (const event of events) {
    if (event && typeof event === 'object') {
      occurrences.push(...expandEventOccurrences(event as ScheduleEvent, startBound, endBound));
    }
  }
  occurrences.sort((a, b) => a._start.getTime() - b._start.getTime());
  return occurrences;
}

/** 某上海本地日期的当日 [开始, 结束] 边界 */
export function dayBounds(targetDate: Date): [Date, Date] {
  const p = localDateParts(targetDate);
  const start = combineLocalDate(p.y, p.m, p.day);
  return [start, new Date(start.getTime() + 86_400_000)];
}

/** 某上海本地日期所在周（周一起）的 [开始, 结束] 边界 */
export function weekBounds(today: Date): [Date, Date] {
  const p = localDateParts(today);
  const start = combineLocalDate(p.y, p.m, p.day - p.weekday);
  return [start, new Date(start.getTime() + 7 * 86_400_000)];
}

/** 单次上课的文本行：HH:MM-HH:MM 课程名 @ 地点 */
export function formatOccurrenceLine(occ: Occurrence): string {
  const text = `${formatHm(occ._start)}-${formatHm(occ._end)} ${occ.SUMMARY || '未命名课程'}`;
  return occ.LOCATION ? `${text} @ ${occ.LOCATION}` : text;
}

/** 判定当前/下一节 */
export function currentOrNext(occurrences: Occurrence[], now: Date): [string, Occurrence | null] {
  for (const occ of occurrences) {
    if (occ._start.getTime() <= now.getTime() && now.getTime() < occ._end.getTime()) return ['正在上', occ];
    if (occ._start.getTime() > now.getTime()) return ['下一节', occ];
  }
  return ['无课', null];
}

/** 总上课时长（小时） */
export function durationHours(occurrences: Occurrence[]): number {
  const seconds = occurrences.reduce((sum, o) => sum + (o._end.getTime() - o._start.getTime()) / 1000, 0);
  return seconds / 3600;
}
