/**
 * 课程表插件主逻辑（移植自 astrbot_plugin_CourseSchedule/plugin/course_schedule.py + main.py）。
 *
 * - 命令：/今日课表（canvas 渲染图片，失败降级文本）、/同步课表（群文件 .ics 双向时间戳同步）
 * - 工具：query_course_schedule_sql（只读 SQL）、edit_local_course_schedule_sql（受限修改 + 重建 .ics）
 * - 数据：本地 JSON 文件（ScheduleStore），scope 按 group:<gid> / private:<uid> 分区
 * - 群文件依赖 OneBot v11 扩展 API（get_group_root_files / upload_group_file 等），不可用时命令报错降级
 */

import { image } from '@snowluma/sdk';
import type { SnowLumaApiClient } from '@snowluma/sdk';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareTimestamps, formatDate, formatHm, nowIso, nowLocal, parseTimestamp, timestampIso } from './tz';
import { formatIcsSchedule, parseScheduleIcs } from './ics';
import { dayBounds, expandMemberOccurrences } from './occurrences';
import {
  ensureScopeMembers,
  scopeFromChatId,
  scopeMembers,
  type MemberInfo,
  type ScheduleStore,
} from './store';
import { applySqlEditToMember, executeCourseScheduleSql } from './sql';
import { drawRowsImage, type RenderRow } from './render';
import type { CommandContext } from '../registry';

const SCHEDULE_FOLDER_NAME = (process.env.COURSE_ICS_FOLDER || 'schedule').toLowerCase();
const MAX_ICS_BYTES = 2 * 1024 * 1024;
const ROOT_SCHEDULE_FILE_RE = /^schedule(\d+)\.ics$/i;
const FOLDER_SCHEDULE_FILE_RE = /^(\d+)\.ics$/i;
const PLUGIN_TMP_DIR = 'astrbot_plugin_course_schedule';

type FileInfo = Record<string, unknown>;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- 群文件信息辅助 ---

function fileName(fileInfo: FileInfo): string {
  return String(fileInfo['file_name'] || fileInfo['name'] || '');
}
function folderName(folderInfo: FileInfo): string {
  return String(folderInfo['folder_name'] || folderInfo['name'] || '');
}
function extractFileId(fileInfo: FileInfo): string {
  return String(fileInfo['file_id'] || fileInfo['id'] || '');
}
function extractFolderId(folderInfo: FileInfo): string {
  return String(folderInfo['folder_id'] || folderInfo['id'] || '');
}
function extractBusid(fileInfo: FileInfo): number {
  return Number(fileInfo['busid'] || fileInfo['bus_id'] || 0);
}
function joinFolderPath(parent: string, name: string): string {
  return parent ? `${parent.replace(/\/+$/, '')}/${name}` : name;
}
function displayGroupFilePath(fileInfo: FileInfo): string {
  const folderPath = String(fileInfo['_folder_path'] ?? '').replace(/^\/+|\/+$/g, '');
  const name = fileName(fileInfo);
  return folderPath ? `${folderPath}/${name}` : name;
}
function normalizedScheduleFilename(userId: string): string {
  return `${userId}.ics`;
}
function normalizedSchedulePath(userId: string): string {
  return `${SCHEDULE_FOLDER_NAME}/${normalizedScheduleFilename(userId)}`;
}
function isNormalizedScheduleFile(fileInfo: FileInfo, userId: string): boolean {
  const folderPath = String(fileInfo['_folder_path'] ?? '').replace(/^\/+|\/+$/g, '').toLowerCase();
  return folderPath === SCHEDULE_FOLDER_NAME && fileName(fileInfo).toLowerCase() === normalizedScheduleFilename(userId).toLowerCase();
}
function extractScheduleUserId(filename: string, folderPath: string): string | null {
  const name = filename.trim();
  const normalized = folderPath.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  if (normalized.split('/').at(-1) === SCHEDULE_FOLDER_NAME) {
    const m = name.match(FOLDER_SCHEDULE_FILE_RE);
    if (m) return m[1]!;
  }
  const m = name.match(ROOT_SCHEDULE_FILE_RE);
  if (m) return m[1]!;
  return null;
}
function groupFileUpdatedAt(fileInfo: FileInfo): Date | null {
  const keys = ['modify_time', 'modified_time', 'update_time', 'updated_at', 'mtime', 'upload_time', 'created_at', 'create_time', 'ctime', 'time'];
  for (const key of keys) {
    const d = parseTimestamp(fileInfo[key]);
    if (d) return d;
  }
  return null;
}
function localScheduleUpdatedAt(info: MemberInfo): Date | null {
  return parseTimestamp(info.schedule_updated_at) || parseTimestamp(info.content_updated_at) || parseTimestamp(info.updated_at);
}

async function downloadText(url: string, maxBytes = MAX_ICS_BYTES): Promise<string> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!resp.ok) throw new Error(`下载失败：HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('文件过大');
  return buf.toString('utf-8').replace(/^﻿/, '');
}

async function writeTempIcs(filename: string, content: string): Promise<string> {
  const dir = join(tmpdir(), PLUGIN_TMP_DIR);
  await mkdir(dir, { recursive: true });
  const target = join(dir, filename);
  await writeFile(target, content, 'utf-8');
  return target;
}

function sanitizeUploadError(e: unknown): string {
  let msg = errMsg(e);
  msg = msg.replace(/base64:\/\/[A-Za-z0-9+/=_-]+/g, 'base64://<redacted>');
  msg = msg.replace(/data:[^,\s]+;base64,[A-Za-z0-9+/=_-]+/g, 'data:<redacted>;base64,<redacted>');
  return msg;
}

function isOwnQuery(query: string): boolean {
  return ['', '我', '自己', '本人', 'me', 'self'].includes(String(query ?? '').trim().toLowerCase());
}

// --- 主类 ---

export class CourseSchedulePlugin {
  private api?: SnowLumaApiClient;
  private readonly store: ScheduleStore;

  constructor(store: ScheduleStore) {
    this.store = store;
  }

  setApi(api: SnowLumaApiClient | undefined): void {
    this.api = api;
  }

  private scopeOfCommand(ctx: CommandContext): string {
    return ctx.groupId ? `group:${ctx.groupId}` : `private:${ctx.senderId ?? ''}`;
  }

  private getScopeMembers(scope: string): Promise<Record<string, MemberInfo>> {
    return this.store.readStore((store) => scopeMembers(store, scope));
  }

  // --- 命令 ---

  /** /今日课表：渲染当前会话今日课程表图片，失败降级文本 */
  async cmdToday(ctx: CommandContext): Promise<void> {
    const scope = this.scopeOfCommand(ctx);
    const members = await this.getScopeMembers(scope);
    if (Object.keys(members).length === 0) {
      await ctx.reply('当前会话还没有可展示的今日课程表。');
      return;
    }

    const now = nowLocal();
    const [startBound, endBound] = dayBounds(now);
    const names = await this.getGroupMemberNames(scope, members);
    const rows: RenderRow[] = [];
    for (const [userId, info] of Object.entries(members)) {
      for (const occ of expandMemberOccurrences(info, startBound, endBound)) {
        const course = occ.SUMMARY || '未命名课程';
        const courseLabel = occ.LOCATION ? `${course} @ ${occ.LOCATION}` : course;
        let status = '今天';
        if (occ._start.getTime() <= now.getTime() && now.getTime() < occ._end.getTime()) status = '正在上';
        else if (occ._end.getTime() <= now.getTime()) status = '已结束';
        rows.push({
          user_id: userId,
          name: names[userId] ?? String(info.name || userId),
          subtitle: userId,
          status,
          course: courseLabel,
          time: `${formatHm(occ._start)}-${formatHm(occ._end)}`,
        });
      }
    }
    rows.sort((a, b) => a.time.localeCompare(b.time) || a.name.localeCompare(b.name) || a.course.localeCompare(b.course));

    const title = `今日课程表 ${formatDate(now)}`;
    try {
      const buf = await drawRowsImage(title, rows);
      await ctx.send(image(`base64://${buf.toString('base64')}`));
    } catch {
      // 渲染失败（无字体/无 canvas 等）→ 降级为文本
      const lines = [title];
      for (const r of rows) lines.push(`${r.name} [${r.status}] ${r.time} ${r.course}`);
      await ctx.reply(lines.length > 1 ? lines.join('\n') : '当前会话还没有可展示的今日课程表。');
    }
  }

  /** /同步课表：按时间戳双向同步当前群 .ics 文件 */
  async cmdSync(ctx: CommandContext): Promise<void> {
    if (!ctx.groupId) {
      await ctx.reply('只能在群聊中同步群文件。');
      return;
    }
    const api = this.api;
    if (!api) {
      await ctx.reply('当前环境没有可用的 OneBot API，无法同步群文件。');
      return;
    }
    const result = await this.syncGroupFilesText(api, String(ctx.groupId), `group:${ctx.groupId}`);
    await ctx.reply(result);
  }

  // --- LLM 工具 ---

  /** query_course_schedule_sql */
  async skillQuerySql(chatId: string, sql: string, timeRange: string): Promise<string> {
    const scope = scopeFromChatId(chatId);
    const members = await this.getScopeMembers(scope);
    if (Object.keys(members).length === 0) return '当前会话还没有保存任何课程表。';
    const names = await this.getGroupMemberNames(scope, members);
    return executeCourseScheduleSql(members, names, sql, timeRange);
  }

  /** edit_local_course_schedule_sql */
  async skillEditSql(chatId: string, senderId: number | undefined, sql: string, query: string): Promise<string> {
    const scope = scopeFromChatId(chatId);
    const members = await this.getScopeMembers(scope);
    if (Object.keys(members).length === 0) return '当前会话还没有保存任何课程表。';

    const resolved = await this.resolveMemberInfo(scope, members, query, senderId);
    if (resolved.error) return resolved.error;
    const info = resolved.info!;
    if (!info.ics) return '当前课程表不是 .ics 导入的数据，不能用 SQL 修改。';

    let updated: Awaited<ReturnType<typeof applySqlEditToMember>>;
    try {
      updated = await applySqlEditToMember(info, sql);
    } catch (e) {
      return errMsg(e);
    }
    const changes = updated._sql_edit_changes;
    const clean: MemberInfo = { ...updated };
    clean.schedule = formatIcsSchedule(clean.events);
    clean.last_modified_by = senderId !== undefined ? String(senderId) : undefined;

    const targetId = resolved.targetId!;
    await this.store.withStore((store) => {
      ensureScopeMembers(store, scope)[targetId] = clean;
    });

    const name = clean.name || targetId;
    return (
      `已用 SQL 修改 ${name}(${targetId}) 的本地课程表，影响 ${changes} 条，` +
      `当前共有 ${clean.event_count} 个事件。远端群文件尚未同步；请使用 /同步课表 按时间戳上传本地较新版本。`
    );
  }

  // --- 成员解析 ---

  async resolveMemberInfo(
    scope: string,
    members: Record<string, MemberInfo>,
    query: string,
    senderId?: number,
  ): Promise<{ targetId?: string; info?: MemberInfo; error?: string }> {
    const normalizedQuery = String(query ?? '').trim();
    let targetId = senderId !== undefined ? String(senderId) : '';

    if (!isOwnQuery(normalizedQuery)) {
      const matchedIds = Object.entries(members)
        .filter(([userId, info]) => normalizedQuery === userId || normalizedQuery.includes(String(info.name)))
        .map(([userId]) => userId);
      if (matchedIds.length === 0) return { error: `没有找到“${normalizedQuery}”的课程表。` };
      if (matchedIds.length > 1) {
        const names = matchedIds.slice(0, 10).map((uid) => `${members[uid]!.name || uid}(${uid})`);
        return { error: `找到多个匹配成员，请用 QQ 号精确查询：\n${names.join('\n')}` };
      }
      targetId = matchedIds[0]!;
    }

    const info = members[targetId];
    if (!info) {
      if (normalizedQuery && !isOwnQuery(normalizedQuery)) return { error: `没有找到“${normalizedQuery}”的课程表。` };
      return { error: '你还没有保存课程表，请先上传 .ics 并使用 /同步课表 同步群文件。' };
    }
    return { targetId, info };
  }

  // --- 群成员名 ---

  async getGroupMemberName(groupId: string, userId: string): Promise<string> {
    const api = this.api;
    if (!api) return userId;
    try {
      const data = (await api.call('get_group_member_info', {
        group_id: Number(groupId),
        user_id: Number(userId),
        no_cache: true,
      })) as Record<string, unknown> | null;
      if (data) return String(data['card'] || data['nickname'] || userId);
    } catch {
      // 失败用存的名字
    }
    return userId;
  }

  async getGroupMemberNames(scope: string, members: Record<string, MemberInfo>): Promise<Record<string, string>> {
    const fallback: Record<string, string> = {};
    for (const [uid, info] of Object.entries(members)) fallback[uid] = String(info.name || uid);
    const groupId = scope.startsWith('group:') ? scope.slice(6) : '';
    if (!groupId || !this.api) return fallback;

    const results = await Promise.allSettled(
      Object.keys(members).map(async (uid) => [uid, await this.getGroupMemberName(groupId, uid)] as const),
    );
    const out: Record<string, string> = {};
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const [uid, fetched] = r.value;
        out[uid] = fetched && fetched !== uid ? fetched : fallback[uid]!;
      }
    }
    return out;
  }

  // --- 存储写入 ---

  async upsertIcsSchedule(
    scope: string,
    userId: string,
    filename: string,
    icsContent: string,
    uploaderId: string,
    name: string,
    remoteUpdatedAt: unknown,
  ): Promise<void> {
    const { events, scheduleText } = parseScheduleIcs(icsContent);
    const now = nowIso();
    const scheduleUpdatedAt = timestampIso(remoteUpdatedAt);
    await this.store.withStore((store) => {
      const members = ensureScopeMembers(store, scope);
      const prev: MemberInfo | undefined = members[userId];
      members[userId] = {
        name: name || (prev ? prev.name : '') || userId,
        schedule: scheduleText,
        updated_at: now,
        schedule_updated_at: scheduleUpdatedAt,
        remote_updated_at: scheduleUpdatedAt,
        last_synced_at: now,
        source: 'ics',
        source_file: filename,
        uploader_id: uploaderId || '',
        event_count: events.length,
        events,
        ics: icsContent,
      };
    });
  }

  async markScheduleSynced(scope: string, userId: string, sourceFile: string, remoteUpdatedAt: unknown): Promise<void> {
    await this.store.withStore((store) => {
      const info = scopeMembers(store, scope)[userId];
      if (!info) return;
      const now = nowIso();
      const syncedAt = timestampIso(remoteUpdatedAt);
      info.source_file = sourceFile;
      info.schedule_updated_at = syncedAt;
      info.remote_updated_at = syncedAt;
      info.last_synced_at = now;
      info.updated_at = now;
    });
  }

  // --- 群文件 API 封装 ---

  private async listGroupFilesAndFolders(api: SnowLumaApiClient, groupId: string): Promise<{ files: FileInfo[]; folders: FileInfo[] }> {
    const gid = Number(groupId);
    const root = (await api.call('get_group_root_files', { group_id: gid })) as Record<string, unknown>;
    const files: FileInfo[] = [];
    const folders: FileInfo[] = [];
    for (const f of (root['files'] ?? []) as FileInfo[]) files.push({ ...f, _folder_path: '' });

    const queue: Array<{ folder: FileInfo; path: string }> = [];
    for (const folder of (root['folders'] ?? []) as FileInfo[]) {
      const path = folderName(folder);
      const copied = { ...folder, _folder_path: path, _parent_folder_id: '' };
      folders.push(copied);
      queue.push({ folder: copied, path });
    }
    const seen = new Set<string>();
    while (queue.length) {
      const { folder, path } = queue.shift()!;
      const folderId = extractFolderId(folder);
      if (!folderId || seen.has(folderId)) continue;
      seen.add(folderId);
      const child = (await api.call('get_group_files_by_folder', { group_id: gid, folder_id: folderId })) as Record<string, unknown>;
      for (const f of (child['files'] ?? []) as FileInfo[]) files.push({ ...f, _folder_path: path, _folder_id: folderId });
      for (const cf of (child['folders'] ?? []) as FileInfo[]) {
        const childPath = joinFolderPath(path, folderName(cf));
        const copied = { ...cf, _folder_path: childPath, _parent_folder_id: folderId };
        folders.push(copied);
        queue.push({ folder: copied, path: childPath });
      }
    }
    return { files, folders };
  }

  private async ensureScheduleFolder(api: SnowLumaApiClient, groupId: string, folders?: FileInfo[]): Promise<string> {
    if (!folders) {
      folders = (await this.listGroupFilesAndFolders(api, groupId)).folders;
    }
    for (const folder of folders) {
      const path = String(folder['_folder_path'] ?? '').replace(/^\/+|\/+$/g, '').toLowerCase();
      if (path === SCHEDULE_FOLDER_NAME) {
        const fid = extractFolderId(folder);
        if (fid) return fid;
      }
    }
    try {
      const resp = (await api.call('create_group_file_folder', {
        group_id: Number(groupId),
        name: SCHEDULE_FOLDER_NAME,
        parent_id: '/',
      })) as Record<string, unknown> | null;
      if (resp) {
        const fid = String(resp['folder_id'] || resp['id'] || resp['folder'] || '');
        if (fid) return fid;
      }
    } catch (e) {
      throw new Error(`创建群文件 ${SCHEDULE_FOLDER_NAME} 文件夹失败：${errMsg(e)}`);
    }
    const relisted = await this.listGroupFilesAndFolders(api, groupId);
    for (const folder of relisted.folders) {
      const path = String(folder['_folder_path'] ?? '').replace(/^\/+|\/+$/g, '').toLowerCase();
      if (path === SCHEDULE_FOLDER_NAME) {
        const fid = extractFolderId(folder);
        if (fid) return fid;
      }
    }
    throw new Error(`创建群文件 ${SCHEDULE_FOLDER_NAME} 文件夹后未找到 folder_id`);
  }

  private async getGroupFileUrl(api: SnowLumaApiClient, groupId: string, fileInfo: FileInfo): Promise<string> {
    const fileId = extractFileId(fileInfo);
    if (!fileId) throw new Error('群文件缺少 file_id/id');
    const resp = (await api.call('get_group_file_url', {
      group_id: Number(groupId),
      file_id: fileId,
      busid: extractBusid(fileInfo),
    })) as unknown as Record<string, unknown>;
    const url = resp ? String(resp['url'] ?? '') : '';
    if (!url) throw new Error('协议端没有返回群文件下载链接');
    return url;
  }

  private async uploadScheduleFile(
    api: SnowLumaApiClient,
    groupId: string,
    userId: string,
    icsContent: string,
    folderId: string,
  ): Promise<string> {
    const filename = normalizedScheduleFilename(userId);
    const folder = folderId || (await this.ensureScheduleFolder(api, groupId));
    const base = { group_id: Number(groupId), name: filename, folder };
    const tempPath = await writeTempIcs(filename, icsContent);
    const encoded = Buffer.from(icsContent, 'utf-8').toString('base64');
    const attempts = [
      { file: tempPath },
      { file: pathToFileURL(tempPath).href },
      { file: `base64://${encoded}` },
      { file: `data:text/calendar;charset=utf-8;base64,${encoded}` },
    ];
    let lastErr: unknown = null;
    for (const attempt of attempts) {
      try {
        await api.call('upload_group_file', { ...base, ...attempt });
        return normalizedSchedulePath(userId);
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`upload_group_file 上传失败（本地路径/URI/base64/data URI 均失败）：${sanitizeUploadError(lastErr)}`);
  }

  private async downloadGroupSchedule(
    api: SnowLumaApiClient,
    groupId: string,
    userId: string,
    fileInfo: FileInfo,
    remoteUpdatedAt: Date | null,
    scope: string,
  ): Promise<string> {
    const url = await this.getGroupFileUrl(api, groupId, fileInfo);
    const icsContent = await downloadText(url);
    const memberName = await this.getGroupMemberName(groupId, userId);
    await this.upsertIcsSchedule(
      scope,
      userId,
      displayGroupFilePath(fileInfo),
      icsContent,
      String(fileInfo['uploader'] || fileInfo['user_id'] || ''),
      memberName,
      remoteUpdatedAt,
    );
    return icsContent;
  }

  private async deleteOldScheduleFiles(api: SnowLumaApiClient, groupId: string, userId: string): Promise<[string[], string[]]> {
    let files: FileInfo[];
    try {
      files = (await this.listGroupFilesAndFolders(api, groupId)).files;
    } catch (e) {
      return [[], [`${userId}: 读取群文件以删除旧文件失败：${errMsg(e)}`]];
    }
    const matched = files.filter((f) => extractScheduleUserId(fileName(f), String(f['_folder_path'] ?? '')) === userId);
    if (matched.length === 0) return [[], []];
    const normalized = matched.filter((f) => isNormalizedScheduleFile(f, userId));
    if (normalized.length === 0) {
      return [[], [`${userId}: 上传后未找到 ${normalizedSchedulePath(userId)}，已跳过删除旧文件`]];
    }
    let keep: FileInfo | null = null;
    for (const f of normalized) {
      if (!keep) {
        keep = f;
        continue;
      }
      const ft = groupFileUpdatedAt(f);
      const kt = groupFileUpdatedAt(keep);
      if (compareTimestamps(ft, kt) === 1 || (ft && !kt)) keep = f;
    }
    const keepTime = keep ? groupFileUpdatedAt(keep) : null;
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const f of matched) {
      if (f === keep) continue;
      if (isNormalizedScheduleFile(f, userId)) {
        const ft = groupFileUpdatedAt(f);
        if (!ft || !keepTime) continue;
      }
      const path = displayGroupFilePath(f);
      try {
        await api.call('delete_group_file', { group_id: Number(groupId), file_id: extractFileId(f) });
        deleted.push(path);
      } catch (e) {
        failed.push(`${path}: ${errMsg(e)}`);
      }
    }
    return [deleted, failed];
  }

  // --- 双向同步主流程 ---

  async syncGroupFilesText(api: SnowLumaApiClient, groupId: string, scope: string): Promise<string> {
    let files: FileInfo[];
    let folders: FileInfo[];
    try {
      ({ files, folders } = await this.listGroupFilesAndFolders(api, groupId));
    } catch (e) {
      return `读取群文件失败：${errMsg(e)}`;
    }

    const members = await this.getScopeMembers(scope);
    const remoteByUser: Record<string, FileInfo> = {};
    for (const fileInfo of files) {
      const userId = extractScheduleUserId(fileName(fileInfo), String(fileInfo['_folder_path'] ?? ''));
      if (!userId) continue;
      const current = remoteByUser[userId];
      if (!current) {
        remoteByUser[userId] = fileInfo;
        continue;
      }
      const curTime = groupFileUpdatedAt(current);
      const nextTime = groupFileUpdatedAt(fileInfo);
      const cmp = compareTimestamps(nextTime, curTime);
      if (cmp === 1 || (nextTime && !curTime)) {
        remoteByUser[userId] = fileInfo;
      } else if (cmp === 0 && isNormalizedScheduleFile(fileInfo, userId) && !isNormalizedScheduleFile(current, userId)) {
        remoteByUser[userId] = fileInfo;
      }
    }

    const downloaded: string[] = [];
    const uploaded: string[] = [];
    const skipped: string[] = [];
    const deletedOld: string[] = [];
    const failed: string[] = [];
    const processed = new Set<string>();
    let scheduleFolderId: string | null = null;

    for (const [userId, fileInfo] of Object.entries(remoteByUser)) {
      const displayPath = displayGroupFilePath(fileInfo);
      processed.add(userId);
      const remoteUpdatedAt = groupFileUpdatedAt(fileInfo);
      const localInfo = members[userId];
      const localUpdatedAt = localInfo ? localScheduleUpdatedAt(localInfo) : null;
      const cmp = compareTimestamps(localUpdatedAt, remoteUpdatedAt);

      try {
        if (cmp === 1 && localInfo && localInfo.ics) {
          if (!scheduleFolderId) scheduleFolderId = await this.ensureScheduleFolder(api, groupId, folders);
          const up = await this.uploadScheduleFile(api, groupId, userId, localInfo.ics, scheduleFolderId);
          await this.markScheduleSynced(scope, userId, up, new Date());
          uploaded.push(`${userId} -> ${up}`);
          const [del, fail] = await this.deleteOldScheduleFiles(api, groupId, userId);
          deletedOld.push(...del);
          failed.push(...fail);
        } else if (cmp === 0 && localInfo) {
          if (isNormalizedScheduleFile(fileInfo, userId)) {
            await this.markScheduleSynced(scope, userId, displayPath, remoteUpdatedAt);
            skipped.push(`${displayPath} 已是最新`);
            const [del, fail] = await this.deleteOldScheduleFiles(api, groupId, userId);
            deletedOld.push(...del);
            failed.push(...fail);
          } else {
            let ics = localInfo.ics;
            if (!ics) {
              ics = await this.downloadGroupSchedule(api, groupId, userId, fileInfo, remoteUpdatedAt, scope);
              downloaded.push(`${displayPath} -> ${userId}`);
            }
            if (!scheduleFolderId) scheduleFolderId = await this.ensureScheduleFolder(api, groupId, folders);
            const up = await this.uploadScheduleFile(api, groupId, userId, ics, scheduleFolderId);
            await this.markScheduleSynced(scope, userId, up, new Date());
            uploaded.push(`${userId} -> ${up}`);
            const [del, fail] = await this.deleteOldScheduleFiles(api, groupId, userId);
            deletedOld.push(...del);
            failed.push(...fail);
          }
        } else {
          const ics = await this.downloadGroupSchedule(api, groupId, userId, fileInfo, remoteUpdatedAt, scope);
          downloaded.push(`${displayPath} -> ${userId}`);
          if (!isNormalizedScheduleFile(fileInfo, userId)) {
            if (!scheduleFolderId) scheduleFolderId = await this.ensureScheduleFolder(api, groupId, folders);
            const up = await this.uploadScheduleFile(api, groupId, userId, ics, scheduleFolderId);
            await this.markScheduleSynced(scope, userId, up, new Date());
            uploaded.push(`${userId} -> ${up}`);
          }
          const [del, fail] = await this.deleteOldScheduleFiles(api, groupId, userId);
          deletedOld.push(...del);
          failed.push(...fail);
        }
      } catch (e) {
        failed.push(`${displayPath}: ${errMsg(e)}`);
      }
    }

    for (const [userId, localInfo] of Object.entries(members)) {
      if (processed.has(userId) || !localInfo.ics) continue;
      try {
        if (!scheduleFolderId) scheduleFolderId = await this.ensureScheduleFolder(api, groupId, folders);
        const up = await this.uploadScheduleFile(api, groupId, userId, localInfo.ics, scheduleFolderId);
        await this.markScheduleSynced(scope, userId, up, new Date());
        uploaded.push(`${userId} -> ${up}`);
        const [del, fail] = await this.deleteOldScheduleFiles(api, groupId, userId);
        deletedOld.push(...del);
        failed.push(...fail);
      } catch (e) {
        failed.push(`${userId}: ${errMsg(e)}`);
      }
    }

    const lines = [
      `群文件双向同步完成：下载 ${downloaded.length} 个，上传 ${uploaded.length} 个，删除旧文件 ${deletedOld.length} 个，跳过 ${skipped.length} 个，失败 ${failed.length} 个。`,
    ];
    if (downloaded.length) {
      lines.push('已下载：');
      lines.push(...downloaded.slice(0, 20));
    }
    if (uploaded.length) {
      lines.push('已上传：');
      lines.push(...uploaded.slice(0, 20));
    }
    if (deletedOld.length) {
      lines.push('已删除旧文件：');
      lines.push(...deletedOld.slice(0, 20));
    }
    if (skipped.length) {
      lines.push('已跳过：');
      lines.push(...skipped.slice(0, 10));
    }
    if (failed.length) {
      lines.push('失败：');
      lines.push(...failed.slice(0, 10));
    }
    return lines.join('\n');
  }
}
