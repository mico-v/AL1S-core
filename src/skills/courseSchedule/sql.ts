/**
 * 课程表 SQL 工具（移植自 astrbot_plugin_CourseSchedule/plugin/sql_query.py + sql_edit.py）。
 *
 * 查询：把成员的课程事件按时间范围展开进**新建的临时内存库**，执行一条只读 SELECT 后丢弃。
 * 即使模型传了恶意/破坏性 SQL，也只会影响临时库，不会碰持久数据（等价原实现的只读 authorizer 兜底）。
 * 修改：仅允许单条 UPDATE/INSERT/DELETE 作用于 local_courses，改后重建本地 .ics。
 *
 * sql.js 用 createRequire 读取 wasm 二进制，离线可用。
 */

import type { Database, SqlJsStatic } from 'sql.js';
import { combineLocalDate, localDateParts, nowLocal } from './tz';
import { parseIcsDatetimeObj, serializeScheduleIcs, type ScheduleEvent } from './ics';
import { expandMemberOccurrences } from './occurrences';
import type { MemberInfo } from './store';

export const MAX_SQL_RESULT_ROWS = 100;
export const MAX_CELL_CHARS = 120;
export const MAX_SQL_EDIT_CHANGES = 50;
const MAX_EVENTS_PER_FILE = 120;

const FORBIDDEN_SQL_RE = /\b(attach|alter|create|delete|detach|drop|insert|pragma|replace|update|vacuum)\b/i;
const RANGE_SPLIT_RE = /\s*(?:\.\.|~|至|到|—|-{2,}|\bto\b)\s*/i;
const FORBIDDEN_EDIT_SQL_RE = /\b(attach|alter|create|detach|drop|pragma|replace|select|vacuum)\b/i;
const ALLOWED_EDIT_SQL_RE = /^(update|insert|delete)\b/i;

let sqlPromise: Promise<SqlJsStatic> | null = null;

/** 懒加载 sql.js（wasm 从 node_modules 读取，离线可用） */
async function getSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      const { readFileSync } = await import('node:fs');
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
      const wasmBinary = readFileSync(wasmPath) as unknown as ArrayBuffer;
      const initSqlJs = (await import('sql.js')).default;
      return initSqlJs({ wasmBinary });
    })();
  }
  return sqlPromise;
}

// --- 时间范围解析 ---

/** 只有年月日的日期（上海本地墙钟语义） */
interface Ymd {
  y: number;
  m: number; // 0-based
  day: number;
}

function addDays(p: Ymd, days: number): Ymd {
  return localDateParts(combineLocalDate(p.y, p.m, p.day + days));
}

function monthBounds(p: Ymd, offset: number): Ymd {
  const monthIndex = p.m + offset;
  const year = p.y + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const endDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return { y: year, m: month, day: endDay };
}

function parseDateToken(token: string, today: Ymd): Ymd {
  const normalized = String(token ?? '').trim().toLowerCase();
  if (['', 'today', '今天', '今日'].includes(normalized)) return today;
  if (['tomorrow', '明天', '明日'].includes(normalized)) return addDays(today, 1);
  if (['yesterday', '昨天', '昨日'].includes(normalized)) return addDays(today, -1);
  const m = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`无法识别的日期：${token}`);
  return { y: +m[1]!, m: +m[2]! - 1, day: +m[3]! };
}

/** 解析 time_range 为 [开始, 结束) 边界与展示标签 */
function parseSqlTimeRange(value: string): { startBound: Date; endBound: Date; label: string } {
  const today = localDateParts(nowLocal());
  const normalized = String(value ?? 'today').trim().toLowerCase();
  const compact = normalized.replace(/\s+/g, '');

  let start: Ymd;
  let end: Ymd;
  if (['', 'today', '今天', '今日'].includes(compact)) {
    start = end = today;
  } else if (['tomorrow', '明天', '明日'].includes(compact)) {
    start = end = addDays(today, 1);
  } else if (['yesterday', '昨天', '昨日'].includes(compact)) {
    start = end = addDays(today, -1);
  } else if (['thisweek', 'currentweek', 'week', '本周', '这周', '这一周'].includes(compact)) {
    start = addDays(today, -today.weekday);
    end = addDays(start, 6);
  } else if (['nextweek', '下周', '下一周'].includes(compact)) {
    start = addDays(addDays(today, -today.weekday), 7);
    end = addDays(start, 6);
  } else if (['thismonth', 'currentmonth', 'month', '本月', '这个月'].includes(compact)) {
    start = { y: today.y, m: today.m, day: 1 };
    end = monthBounds({ ...today, day: 1 }, 0);
  } else if (['nextmonth', '下月', '下个月'].includes(compact)) {
    start = { y: today.y, m: today.m, day: 1 };
    end = monthBounds({ ...today, day: 1 }, 1);
  } else {
    const parts = normalized.split(RANGE_SPLIT_RE).filter((s) => s.trim() !== '');
    if (parts.length === 2) {
      start = parseDateToken(parts[0]!, today);
      end = parseDateToken(parts[1]!, today);
    } else {
      start = end = parseDateToken(normalized, today);
    }
  }

  if (combineLocalDate(end.y, end.m, end.day).getTime() < combineLocalDate(start.y, start.m, start.day).getTime()) {
    throw new Error('time_range 的结束日期不能早于开始日期。');
  }

  const startBound = combineLocalDate(start.y, start.m, start.day);
  const endBound = combineLocalDate(end.y, end.m, end.day + 1);
  const label =
    start.y === end.y && start.m === end.m && start.day === end.day
      ? `${start.y}-${String(start.m + 1).padStart(2, '0')}-${String(start.day).padStart(2, '0')}`
      : `${start.y}-${String(start.m + 1).padStart(2, '0')}-${String(start.day).padStart(2, '0')}..${end.y}-${String(end.m + 1).padStart(2, '0')}-${String(end.day).padStart(2, '0')}`;
  return { startBound, endBound, label };
}

// --- 查询工具 ---

function schemaHelp(): string {
  return [
    '请传入只读 SELECT 查询。可用表：',
    'members(user_id, name, source, updated_at, schedule_updated_at, source_file, event_count, schedule_text)',
    'courses(user_id, name, course, location, description, start_time, end_time, date, weekday, weekday_name, start_clock, end_clock, duration_minutes, status, source_file, rrule)',
    '',
    '时间字段均为 Asia/Shanghai 本地时间文本。status 可取 past、current、future。',
    '示例：',
    "SELECT name, start_clock, end_clock, course, location FROM courses WHERE date='2026-05-26' ORDER BY start_time",
    'SELECT name, COUNT(*) AS course_count, ROUND(SUM(duration_minutes)/60.0, 1) AS hours FROM courses GROUP BY user_id, name ORDER BY hours DESC',
  ].join('\n');
}

function validateSql(sql: string): string {
  const query = String(sql ?? '').trim();
  if (!query) throw new Error(schemaHelp());
  if (!/^select\b/i.test(query)) throw new Error(`只支持 SELECT 查询。\n\n${schemaHelp()}`);
  if (query.includes(';')) throw new Error('一次只能执行一条 SELECT 查询，不要包含分号。');
  if (FORBIDDEN_SQL_RE.test(query)) throw new Error('只支持只读查询，不能包含写入、DDL、PRAGMA 或附件数据库语句。');
  return query;
}

const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 在临时内存库建 members + courses 表并展开事件 */
async function createQueryDb(
  members: Record<string, MemberInfo>,
  names: Record<string, string>,
  startBound: Date,
  endBound: Date,
  now: Date,
): Promise<Database> {
  const SQL = await getSql();
  const db = new SQL.Database();

  db.run(
    'CREATE TABLE members (user_id TEXT, name TEXT, source TEXT, updated_at TEXT, schedule_updated_at TEXT, source_file TEXT, event_count INTEGER, schedule_text TEXT)',
  );
  db.run(
    'CREATE TABLE courses (user_id TEXT, name TEXT, course TEXT, location TEXT, description TEXT, start_time TEXT, end_time TEXT, date TEXT, weekday INTEGER, weekday_name TEXT, start_clock TEXT, end_clock TEXT, duration_minutes INTEGER, status TEXT, source_file TEXT, rrule TEXT)',
  );

  for (const [userId, info] of Object.entries(members)) {
    const name = names[userId] ?? String(info.name || userId);
    db.run('INSERT INTO members VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      userId,
      name,
      String(info.source ?? ''),
      String(info.updated_at ?? ''),
      String(info.schedule_updated_at ?? info.content_updated_at ?? ''),
      String(info.source_file ?? ''),
      Number(info.event_count ?? 0),
      String(info.schedule ?? ''),
    ]);

    const occurrences = expandMemberOccurrences(info as unknown as Record<string, unknown>, startBound, endBound);
    for (const occ of occurrences) {
      const start = occ._start;
      const end = occ._end;
      const sp = localDateParts(start);
      const status = start.getTime() <= now.getTime() && now.getTime() < end.getTime() ? 'current' : start.getTime() > now.getTime() ? 'future' : 'past';
      db.run('INSERT INTO courses VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        userId,
        name,
        occ.SUMMARY || '未命名课程',
        occ.LOCATION || '',
        occ.DESCRIPTION || '',
        formatDateTime(start),
        formatDateTime(end),
        formatDateOnly(start),
        sp.weekday + 1,
        WEEKDAY_NAMES[sp.weekday] ?? '',
        formatHm2(start),
        formatHm2(end),
        Math.round((end.getTime() - start.getTime()) / 60_000),
        status,
        String(info.source_file ?? ''),
        occ.RRULE ?? '',
      ]);
    }
  }
  return db;
}

function formatDateOnly(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function formatDateTime(d: Date): string {
  return `${formatDateOnly(d)} ${formatHm2(d)}`;
}
function formatHm2(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\n/g, ' ').trim();
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS - 3)}...` : text;
}

function formatRows(columns: string[], rows: Array<Record<string, unknown>>, truncated: boolean): string {
  if (rows.length === 0) return 'SQL 查询完成，结果为空。';
  const lines = [`SQL 查询完成，返回 ${rows.length} 行${truncated ? '（已截断）' : ''}：`];
  lines.push(columns.join(' | '));
  lines.push(columns.map(() => '---').join(' | '));
  for (const row of rows) {
    lines.push(columns.map((c) => formatCell(row[c])).join(' | '));
  }
  if (truncated) lines.push(`结果超过 ${MAX_SQL_RESULT_ROWS} 行，请在 SQL 中增加 WHERE 或 LIMIT。`);
  return lines.join('\n');
}

/** 执行只读 SQL 查询并返回文本结果（不抛错，错误转成可读中文） */
export async function executeCourseScheduleSql(
  members: Record<string, MemberInfo>,
  names: Record<string, string>,
  sql: string,
  timeRange = 'today',
): Promise<string> {
  let query: string;
  let range;
  try {
    query = validateSql(sql);
    range = parseSqlTimeRange(timeRange);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  const now = nowLocal();
  const db = await createQueryDb(members, names, range.startBound, range.endBound, now);
  try {
    const stmt = db.prepare(query);
    const columns = stmt.getColumnNames();
    const rows: Array<Record<string, unknown>> = [];
    while (rows.length <= MAX_SQL_RESULT_ROWS && stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    const truncated = rows.length > MAX_SQL_RESULT_ROWS;
    rows.length = Math.min(rows.length, MAX_SQL_RESULT_ROWS);
    const body = formatRows(columns, rows, truncated);
    return `查询展开时间范围：${range.label}\n${body}`;
  } catch (e) {
    return `SQL 查询失败：${e instanceof Error ? e.message : e}\n\n${schemaHelp()}`;
  } finally {
    db.close();
  }
}

// --- 修改工具 ---

function editSchemaHelp(): string {
  return [
    '请传入一条修改 local_courses 的 SQL，只支持 UPDATE、INSERT 或 DELETE。',
    '表结构：',
    'local_courses(id, course, location, description, dtstart, dtend, dtstart_tzid, dtend_tzid, rrule)',
    '',
    '字段说明：',
    'id 是课程事件序号，从 1 开始；修改或删除已有课程时必须用 WHERE id=... 精确指定。',
    'dtstart/dtend 使用 iCalendar 时间格式，例如 20260526T090000 或 20260526T090000Z。',
    'dtstart_tzid/dtend_tzid 可留空或填 Asia/Shanghai。',
    '',
    "示例：",
    "UPDATE local_courses SET course='高等数学', location='A101' WHERE id=2",
    "INSERT INTO local_courses(course, location, dtstart, dtend) VALUES ('高等数学', 'A101', '20260526T090000', '20260526T103000')",
    'DELETE FROM local_courses WHERE id=3',
  ].join('\n');
}

function validateEditSql(sql: string): string {
  const query = String(sql ?? '').trim();
  if (!query) throw new Error(editSchemaHelp());
  if (query.includes(';')) throw new Error('一次只能执行一条 SQL，不要包含分号。');
  if (!ALLOWED_EDIT_SQL_RE.test(query)) throw new Error(`只支持 UPDATE、INSERT 或 DELETE。\n\n${editSchemaHelp()}`);
  if (FORBIDDEN_EDIT_SQL_RE.test(query)) throw new Error(`SQL 中包含不允许的语句或关键字。\n\n${editSchemaHelp()}`);
  if (!/\blocal_courses\b/i.test(query)) throw new Error(`只能修改 local_courses 表。\n\n${editSchemaHelp()}`);
  return query;
}

interface EditRow {
  id: number;
  uid: string;
  course: string;
  location: string;
  description: string;
  dtstart: string;
  dtend: string;
  dtstart_tzid: string;
  dtend_tzid: string;
  rrule: string;
  dtstamp: string;
}

function eventToRow(index: number, event: ScheduleEvent): EditRow {
  return {
    id: index,
    uid: event.UID ?? '',
    course: event.SUMMARY ?? '',
    location: event.LOCATION ?? '',
    description: event.DESCRIPTION ?? '',
    dtstart: event.DTSTART ?? '',
    dtend: event.DTEND ?? '',
    dtstart_tzid: event.DTSTART_TZID ?? '',
    dtend_tzid: event.DTEND_TZID ?? '',
    rrule: event.RRULE ?? '',
    dtstamp: event.DTSTAMP ?? '',
  };
}

function rowToEvent(row: Record<string, unknown>): ScheduleEvent {
  const event: ScheduleEvent = {};
  const map: Array<[string, keyof ScheduleEvent]> = [
    ['uid', 'UID'],
    ['course', 'SUMMARY'],
    ['location', 'LOCATION'],
    ['description', 'DESCRIPTION'],
    ['dtstart', 'DTSTART'],
    ['dtend', 'DTEND'],
    ['dtstart_tzid', 'DTSTART_TZID'],
    ['dtend_tzid', 'DTEND_TZID'],
    ['rrule', 'RRULE'],
    ['dtstamp', 'DTSTAMP'],
  ];
  for (const [column, key] of map) {
    const value = String(row[column] ?? '').trim();
    if (value) event[key] = value;
  }
  return event;
}

/** 在临时内存库建 local_courses 表并预填现有事件 */
async function createEditDb(events: ScheduleEvent[]): Promise<{ db: Database }> {
  const SQL = await getSql();
  const db = new SQL.Database();
  db.run(
    'CREATE TABLE local_courses (id INTEGER PRIMARY KEY, uid TEXT, course TEXT NOT NULL, location TEXT, description TEXT, dtstart TEXT NOT NULL, dtend TEXT NOT NULL, dtstart_tzid TEXT, dtend_tzid TEXT, rrule TEXT, dtstamp TEXT)',
  );
  const stmt = db.prepare(
    'INSERT INTO local_courses (id, uid, course, location, description, dtstart, dtend, dtstart_tzid, dtend_tzid, rrule, dtstamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  events.forEach((event, i) => {
    const row = eventToRow(i + 1, event);
    stmt.run([row.id, row.uid, row.course, row.location, row.description, row.dtstart, row.dtend, row.dtstart_tzid, row.dtend_tzid, row.rrule, row.dtstamp]);
  });
  stmt.free();
  return { db };
}

/** 校验修改后的课程事件 */
function validateEvents(rows: Array<Record<string, unknown>>): ScheduleEvent[] {
  if (rows.length > MAX_EVENTS_PER_FILE) throw new Error(`修改后课程数量超过上限 ${MAX_EVENTS_PER_FILE}。`);
  const events = rows.map(rowToEvent);
  events.forEach((event, i) => {
    const id = i + 1;
    if (!event.SUMMARY) throw new Error(`id=${id} 缺少 course。`);
    if (!event.DTSTART) throw new Error(`id=${id} 缺少 dtstart。`);
    if (!event.DTEND) throw new Error(`id=${id} 缺少 dtend。`);
    const start = parseIcsDatetimeObj(event.DTSTART, event.DTSTART_TZID);
    const end = parseIcsDatetimeObj(event.DTEND, event.DTEND_TZID);
    if (!start) throw new Error(`id=${id} 的 dtstart 无法解析。`);
    if (!end) throw new Error(`id=${id} 的 dtend 无法解析。`);
    if (end.getTime() <= start.getTime()) throw new Error(`id=${id} 的 dtend 必须晚于 dtstart。`);
  });
  events.sort((a, b) => (a.DTSTART ?? '').localeCompare(b.DTSTART ?? ''));
  return events;
}

/** 对本地课程表执行一条修改 SQL，返回 [新事件, 新 .ics 内容, 影响条数] */
export async function applyLocalCourseSqlEdit(
  memberInfo: MemberInfo,
  sql: string,
): Promise<{ events: ScheduleEvent[]; icsContent: string; changes: number }> {
  const query = validateEditSql(sql);
  const rawEvents = memberInfo.events;
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    throw new Error('当前课程表没有可编辑的 .ics 事件。');
  }
  const events = rawEvents.filter((e): e is ScheduleEvent => Boolean(e && typeof e === 'object'));

  const { db } = await createEditDb(events);
  try {
    db.run(query);
    const changes = db.getRowsModified();
    if (changes <= 0) throw new Error('SQL 没有修改任何课程。');
    if (changes > MAX_SQL_EDIT_CHANGES) throw new Error(`一次最多允许修改 ${MAX_SQL_EDIT_CHANGES} 条课程。`);
    const stmt = db.prepare('SELECT * FROM local_courses ORDER BY dtstart, dtend, id');
    const rows: Array<Record<string, unknown>> = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    const editedEvents = validateEvents(rows);
    const now = nowLocal();
    const pad = (n: number) => String(n).padStart(2, '0');
    const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
    for (const event of editedEvents) {
      if (!event.DTSTAMP) event.DTSTAMP = dtstamp;
    }
    const icsContent = serializeScheduleIcs(editedEvents);
    return { events: editedEvents, icsContent, changes };
  } catch (e) {
    if (e instanceof Error && /缺少|无法解析|晚于|没有修改|最多允许/.test(e.message)) throw e;
    throw new Error(`SQL 修改失败：${e instanceof Error ? e.message : e}\n\n${editSchemaHelp()}`);
  } finally {
    db.close();
  }
}

/** 修改某成员课程表并更新本地字段 */
export async function applySqlEditToMember(memberInfo: MemberInfo, sql: string): Promise<MemberInfo & { _sql_edit_changes: number }> {
  const { events, icsContent, changes } = await applyLocalCourseSqlEdit(memberInfo, sql);
  const now = new Date().toISOString();
  return {
    ...memberInfo,
    events,
    ics: icsContent,
    event_count: events.length,
    source: 'ics',
    updated_at: now,
    schedule_updated_at: now,
    content_updated_at: now,
    last_modified_at: now,
    _sql_edit_changes: changes,
  };
}
