/**
 * 聊天 agent 离线自检：不连 QQ、不调真实模型。
 *
 *   pnpm agent:check
 *
 * 覆盖：@ 判定、群聊缓冲、记忆读写、以及「@ 才调模型」这条主链路。
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatAgent, approxTokens, clipToolOutput, describeProgress, digestOf, isBotMentioned, linesAfter, MAX_REPLY_CHARS, MAX_REPLY_CHUNKS, pruneToolResults, readAgentConfig, repeatedOpener, selfCheckNotice, splitReply } from '../agent/index.js';
import { pruneMediaCache } from '../chat-log.js';
import type { ChatMessage } from '../agent/llm.js';
import { GroupBuffer, renderBuffer } from '../agent/context.js';
import { GroupMemory, applyProfileChanges, readNewRecordsFrom } from '../agent/memory.js';
import { parseBraveHtml, renderHits as renderWebHits } from '../agent/web.js';
import { blockingWindow, renderQuota } from '../agent/quota.js';
import { QuoteResolver } from '../agent/quote.js';
import { buildRequestBody, quotaPauseFrom, reviewOptions } from '../agent/llm.js';
import { parseNativeToolCalls } from '../agent/dsml.js';
import { PERSONA, resolvePersona } from '../agent/persona.js';
import { capabilitiesFor, resolveTier, GUEST_CAPS, OWNER_CAPS } from '../agent/policy.js';
import { checkCommand, heavyLocalHint, parseBlacklist, parseHeavyMode, waitLocalHint } from '../agent/exec.js';
import { RecordStore } from '../agent/records.js';
import { GoalStore, canContinue, goalBrief, nextSlice, renderGoal, shouldSelfCheck } from '../agent/goals.js';
import { readCnbConfig, buildProbeSignature, renderIssues, renderPulls } from '../agent/cnb.js';
import { checkCnbArgs, ensureBuddyMention, listCnbGuide, readCnbCliConfig, readCnbGuide, renderCnbRun, routeIssueComment, searchCnbGuide } from '../agent/cnbcli.js';
import {
  CHOICE_TTL_MS,
  ChoiceStore,
  MAX_LABEL_CHARS,
  buildChoiceKeyboard,
  clipLabel,
  encodeChoiceData,
  parseChoiceData,
  renderChoiceMarkdown,
  type PendingChoice,
} from '../agent/choices.js';
import {
  PANEL_REMARK,
  buildPanel,
  ensurePanel,
  validatePanel,
  type PanelApi,
  type PanelRecord,
} from '../agent/panels.js';
import {
  MAX_CARD_DESC_CHARS,
  MAX_CARD_TITLE_CHARS,
  buildCard,
  renderCardLine,
} from '../agent/cards.js';
import { renderHandoff, shouldRotateThread, writeHandoff } from '../agent/thread.js';
import { clearInflight, describeInterrupted, inflightDir, listInflight, markInflight } from '../agent/inflight.js';
import { kindPack } from '../agent/kinds.js';
import { matchGoalCommand } from '../agent/commands.js';
import { cleanQQText } from '../agent/text.js';
import { matchCommand, renderStatus } from '../agent/commands.js';
import { DigestEngine, DRIFT_THRESHOLD, topicDrift } from '../agent/digest.js';
import { MessageIndex, renderHits } from '../agent/search.js';
import { executeTool, expandQuery, toolDefinitionsFor } from '../agent/tools.js';
import { captionForSha, captionStorePath, digestAttachments, flushCaptionStore, loadImageParts, looksLikeImage, prepareImage, rememberCaption, sniffImageType, sniffVideo, useCaptionStore } from '../agent/vision.js';
import { buildProactiveMessages, judgeProactive, parseProactive } from '../agent/proactive.js';
import { learnSystem } from '../agent/updater.js';
import { buildRecord, summarize } from '../agent/telemetry.js';
import type { ChatResponse } from '../agent/llm.js';
import type { Bot } from '../bot.js';
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { AppLogger } from '../logger.js';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failures += 1;
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

const quietLogger: AppLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as AppLogger;

const BOT_OPENID = '010356C972961F4612B45B858C77091A';
const OTHER_BOT_OPENID = '72F0DE0282804584100A30AD945BA61C';
const MEMBER_OPENID = 'B8312115BE2DD526518258E2A861F479';
const GROUP = '2735F7F55B6B1D1B0D47D8BD8F315E49';

function makeMessage(overrides: Partial<Record<string, unknown>> = {}): QQBotInboundMessage {
  return {
    kind: 'group',
    groupOpenid: GROUP,
    senderId: MEMBER_OPENID,
    senderName: '謎矢',
    senderIsBot: false,
    content: '今天上课好累啊',
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    replyTarget: { kind: 'group', groupOpenid: GROUP },
    mentions: [],
    ...overrides,
  } as unknown as QQBotInboundMessage;
}

async function main(): Promise<void> {
  process.env.AGENT_REPLY_LOG = 'false';
  const config = readAgentConfig({
    AGENT_BOT_OPENIDS: BOT_OPENID,
    AGENT_BOT_USERNAMES: 'Kei',
    AGENT_GROUP_OPENIDS: GROUP,
    AGENT_GROUPS: GROUP,
    AGENT_CONTEXT_SIZE: '40',
    // 主链路测试注入的是假 complete；关掉工具，避免走到真实网络。
    // 工具链路在 [11] 单独测。
    AGENT_TOOLS: 'false',
  } as NodeJS.ProcessEnv);

  console.log('\n[1] @ 判定');
  check('自己的 openid → true',
    isBotMentioned(makeMessage({ mentions: [{ member_openid: BOT_OPENID }] }), config));
  check('别的机器人的 openid → false',
    !isBotMentioned(makeMessage({ mentions: [{ member_openid: OTHER_BOT_OPENID, bot: true }] }), config));
  check('bot=true 但用户名不是自己 → false',
    !isBotMentioned(makeMessage({ mentions: [{ username: '课表Bot', bot: true }] }), config));
  check('bot=true 且用户名是自己 → true',
    isBotMentioned(makeMessage({ mentions: [{ username: 'Kei', bot: true }] }), config));
  check('没有 mentions → false', !isBotMentioned(makeMessage({ mentions: undefined }), config));

  console.log('\n[1.6] @ 专用事件（群主没开全量消息时）');
  {
    const cfg = readAgentConfig({
      AGENT_BOT_OPENIDS: BOT_OPENID,
      AGENT_BOT_USERNAMES: 'Kei',
      AGENT_GROUPS: GROUP,
      AGENT_TOOLS: 'false',
    } as NodeJS.ProcessEnv);

    const run = async (overrides: Record<string, unknown>) => {
      let calls = 0;
      const agent = new ChatAgent(cfg, quietLogger, async () => {
        calls += 1;
        return '在';
      });
      await agent.handle(makeMessage(overrides), { replyText: async () => {} } as unknown as Bot);
      return calls;
    };

    // QQ 在这种群里会剥掉 @，mentions 是空的，但事件类型说明是在叫她
    const viaAtEvent = await run({ content: '早上好', mentions: [], rawEventType: 'GROUP_AT_MESSAGE_CREATE' });
    check('@ 专用事件即使 mentions 为空也回', viaAtEvent === 1, `实际 ${viaAtEvent}`);

    const viaFullNoMention = await run({ content: '早上好', mentions: [], rawEventType: 'GROUP_MESSAGE_CREATE' });
    check('全量群里没 @ 仍然不回', viaFullNoMention === 0, `实际 ${viaFullNoMention}`);

    const viaFullMention = await run({
      content: '在吗',
      rawEventType: 'GROUP_MESSAGE_CREATE',
      mentions: [{ member_openid: BOT_OPENID }],
    });
    check('全量群里 @ 了才回', viaFullMention === 1, `实际 ${viaFullMention}`);
  }

  console.log('\n[2] 群聊缓冲');
  const buf = new GroupBuffer(3);
  for (let i = 0; i < 5; i += 1) {
    buf.push(GROUP, { senderName: `人${i}`, text: `话${i}`, timestamp: Date.now() });
  }
  const drained = buf.drain(GROUP);
  check('按上限截断', drained.length === 3, `实际 ${drained.length}`);
  check('保留最新的', drained[drained.length - 1]?.text === '话4');
  check('drain 后清空', buf.drain(GROUP).length === 0);

  console.log('\n[2.1] 缓冲带时间与收件人');
  const at = new Date(2026, 9, 26, 20, 14, 30).getTime();
  const rendered = renderBuffer([
    { senderName: '小明', text: '今天吃什么', timestamp: at, to: '小红' },
    { senderName: '小红', text: '随便', timestamp: at + 60_000 },
    { senderName: '小明', text: 'Kei 你说呢', timestamp: at + 120_000, toBot: true },
  ]);
  check('带时间戳', rendered.startsWith('[20:14] 小明 → 小红: 今天吃什么'), rendered.split('\n')[0]);
  check('群发不画箭头', rendered.split('\n')[1] === '[20:15] 小红: 随便');
  check('点名机器人标 → Kei', (rendered.split('\n')[2] ?? '').includes('小明 → Kei'));
  check('空缓冲渲染成空串', renderBuffer([]) === '');

  console.log('\n[1.5] 回答长短交给模型判断');
  {
    check('人格里写了「先判断该怎么答」', PERSONA.includes('先判断这一轮该怎么答'));
    check('人格里没有写死短句上限', !PERSONA.includes('一条通常 1–3 句'));
    check('人格允许正经问题展开', PERSONA.includes('把话说全'));
    check('人格允许分点和列表', PERSONA.includes('该分点就分点'));

    // 分片只负责不丢内容、不炸屏，不参与「说什么」
    const paragraphs = Array.from({ length: 24 }, (_, i) => `第${i + 1}段内容`.repeat(8));
    const many = splitReply(paragraphs.join('\n\n'));
    check('24 段不会发成 24 条', many.length <= 3, `实际 ${many.length} 条`);
    check('合并后内容不丢', many.join('').includes('第24段内容'));
    const normal = splitReply('诶 累成这样\n\n一天白过也没啥');
    check('两三句仍按原节奏分条', normal.length === 2, `实际 ${normal.length}`);
  }

  console.log('\n[1.7] 附件类型验证');
  {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    const silk = new Uint8Array([0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b, 0x5f, 0x56, 0x33, 0, 0, 0]);
    const mp4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

    check('识别 JPEG', sniffImageType(jpeg) === 'image/jpeg');
    check('识别 PNG', sniffImageType(png) === 'image/png');
    check('识别 GIF', sniffImageType(gif) === 'image/gif');
    check('识别 WEBP', sniffImageType(webp) === 'image/webp');
    check('语音不认成图', sniffImageType(silk) === undefined);
    check('认出视频容器', sniffVideo(mp4));
    check('语音不进视觉链路', !looksLikeImage({ content_type: 'audio/silk', url: 'https://x/multimedia?a' }));
    check('视频不进视觉链路', !looksLikeImage({ content_type: 'video/mp4', url: 'https://x/multimedia?a' }));
    check('真图放行', looksLikeImage({ content_type: 'image/png', url: 'https://x/multimedia?a' }));
    check('无类型但有 multimedia 链接才去验', looksLikeImage({ url: 'https://x/multimedia?a' }));
  }

  console.log('\n[1.8] 档案增量合并');
  {
    const base = '# 甲\n- 性格: 话痨\n- 近况: 准备 CSP（2026-09-01 ~ ）';
    const added = applyProfileChanges(base, '甲', [{ op: 'add', text: '- 常聊: 算法竞赛' }]);
    check('add 追加一行', added.includes('算法竞赛'));
    check('add 不动旧内容', added.includes('话痨'));

    const dup = applyProfileChanges(base, '甲', [{ op: 'add', text: '- 性格: 话痨' }]);
    check('add 不重复堆同样的行', dup.split('\n').filter((l) => l.includes('话痨')).length === 1);

    const replaced = applyProfileChanges(base, '甲', [
      { op: 'replace', match: '准备 CSP', text: '- 近况: 改准备考研（2026-11-01 ~ ）' },
    ]);
    check('replace 换掉旧行', replaced.includes('考研') && !replaced.includes('CSP'));

    const removed = applyProfileChanges(base, '甲', [{ op: 'remove', match: '话痨' }]);
    check('remove 删掉该行', !removed.includes('话痨'));

    const untouched = applyProfileChanges(base, '甲', [{ op: 'replace', match: '不存在的片段', text: '- 新' }]);
    check('match 不到就保持原样', untouched === base);
    check('标题始终保留', added.startsWith('# 甲'));
  }

  console.log('\n[1.82] 引用解析（磁盘索引）');
  {
    const root = await mkdtemp(path.join(tmpdir(), 'al1s-quote-'));
    try {
      const dir = path.join(root, 'chats', 'group', GROUP);
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, 'messages.jsonl');
      const rows = [
        { msgIdx: 'IDX_A', senderName: '甲', content: '第一句话', timestamp: '2026-11-01T10:00:00+08:00' },
        { msgIdx: 'IDX_B', senderName: '乙', content: '第二句话', timestamp: '2026-11-01T10:01:00+08:00' },
      ];
      await writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

      const resolver = new QuoteResolver(root);
      check('按 msgIdx 解析到原文', (await resolver.resolve(GROUP, 'IDX_A'))?.text === '第一句话');
      check('解析到发送者', (await resolver.resolve(GROUP, 'IDX_B'))?.sender === '乙');
      check('找不到返回 undefined', (await resolver.resolve(GROUP, 'IDX_ZZZ')) === undefined);
      check('没有引用就不查', (await resolver.resolve(GROUP, undefined)) === undefined);

      // 追加后应增量读到，且半行不报错
      await writeFile(file, `${JSON.stringify({ msgIdx: 'IDX_C', senderName: '丙', content: '第三句' })}\n`, { flag: 'a' });
      check('增量读到新消息', (await resolver.resolve(GROUP, 'IDX_C'))?.text === '第三句');
      await writeFile(file, '{"msgIdx":"IDX_D","senderName":"丁","content":"半', { flag: 'a' });
      check('半行不影响已有索引', (await resolver.resolve(GROUP, 'IDX_A'))?.text === '第一句话');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  console.log('\n[1.85] 配额熔断');
  {
    const weekly = quotaPauseFrom('{"code":"GoUsageLimitError","message":"weekly usage limit reached"}');
    check('识别周配额 429', weekly > Date.now());
    const resetAt = new Date(weekly);
    check('暂停到下个 UTC 零点', resetAt.getUTCHours() === 0 && resetAt.getUTCMinutes() === 0);
    check('非配额错误不暂停', quotaPauseFrom('HTTP 400: invalid request') === 0);

    const blocked = blockingWindow({
      weekly: { status: 'exceeded', percent: 100, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
      fetchedAt: Date.now(),
    });
    check('打满的窗口能被识别', blocked?.name === 'weekly');

    const healthy = blockingWindow({
      weekly: { status: 'ok', percent: 40, resetsAt: '2026-11-09T00:00:00Z' },
      monthly: { status: 'ok', percent: 65, resetsAt: '2026-11-12T00:00:00Z' },
      fetchedAt: Date.now(),
    });
    check('没打满就不拦', healthy === undefined);
    check('配额渲染成一行', renderQuota({
      rolling: { status: 'ok', percent: 12, resetsAt: '' },
      weekly: { status: 'ok', percent: 40, resetsAt: '' },
      monthly: { status: 'ok', percent: 65, resetsAt: '' },
      fetchedAt: Date.now(),
    }).includes('周 40%'));
  }

  console.log('\n[1.9] 联网搜索解析');
  {
    const html = `
      <div class="snippet x" data-type="web">
        <a href="https://example.com/a"><div class="title t">第一条标题</div></a>
        <div class="generic-snippet s">2 days ago - 第一条摘要</div>
      </div>
      <div class="snippet x" data-type="web">
        <a href="https://example.com/b"><div class="title t">第二条标题</div></a>
        <div class="generic-snippet s">第二条摘要</div>
      </div>`;
    const hits = parseBraveHtml(html, 5);
    check('解析出两条结果', hits.length === 2, `实际 ${hits.length}`);
    check('标题正确', hits[0]?.title === '第一条标题');
    check('链接正确', hits[0]?.url === 'https://example.com/a');
    check('摘要去掉时间前缀', hits[0]?.snippet.includes('第一条摘要') === true);
    check('空结果有兜底文案', renderWebHits('x', []).includes('没有搜到'));
  }

  console.log('\n[2.12] 自己的话与引用');
  {
    // 自己的消息会被 QQ 回投，必须进缓冲，且在再次被问到时看得到
    const selfAgent = new ChatAgent(config, quietLogger, async () => 'ok');
    await selfAgent.handle(
      makeMessage({ content: 'Kei 拒绝回答', senderIsBot: true, senderId: BOT_OPENID, senderName: 'Kei' }),
      { replyText: async () => {} } as unknown as Bot,
    );
    await selfAgent.handle(
      makeMessage({ content: '嗯', mentions: [{ member_openid: BOT_OPENID }] }),
      { replyText: async () => {} } as unknown as Bot,
    );
    const seenSelf = (selfAgent as unknown as { buffer: GroupBuffer })
      .buffer.peek(GROUP)
      .some((line) => line.isSelf && line.text.includes('拒绝回答'));
    check('自己说过的话留在缓冲里', seenSelf);

    // 同一条消息重复投递（QQ 会回投自己的消息）不应该进两次
    const b = new GroupBuffer(10);
    const dup = { senderName: '甲', text: '重复', timestamp: Date.now(), messageId: 'mid-1' };
    b.push(GROUP, dup);
    b.push(GROUP, dup);
    check('按 messageId 去重', b.peek(GROUP).length === 1);

    // 引用：渲染成「（回 谁「原文」）」，让模型知道这句在接什么
    const rendered = renderBuffer([
      {
        senderName: '謎矢',
        text: '是香味',
        timestamp: Date.now(),
        quote: { sender: 'Kei', text: 'Kei 拒绝回答，并把这个…' },
      },
    ]);
    check('引用带上原话', rendered.includes('回 Kei「Kei 拒绝回答'), rendered);
    check('引用不遮住正文', rendered.includes('是香味'));
  }

  console.log('\n[2.15] 缓冲里的图片引用');
  {
    const ib = new GroupBuffer(10);
    ib.push(GROUP, { senderName: '甲', text: '看图', timestamp: at, imageUrls: ['u1', 'u2'] });
    ib.push(GROUP, { senderName: '乙', text: '哦', timestamp: at + 1000 });
    ib.push(GROUP, { senderName: '丙', text: '又一张', timestamp: at + 2000, imageUrls: ['u3'] });
    const recent = ib.recentImageUrls(GROUP, 3);
    check('取最近的图，新的在前', recent[0] === 'u3', recent.join(','));
    check('按上限截断', ib.recentImageUrls(GROUP, 2).length === 2);
    check('没图返回空', new GroupBuffer(5).recentImageUrls('nope').length === 0);
  }

  console.log('\n[2.2] 话题漂移');
  const oneTopic = ['今天打本吗', '打本打本', '几点开打', '八点吧', '那我去准备药'];
  const shifted = [...oneTopic, '话说那个新显卡多少钱', '好像要五千多', '太贵了算了', '等等双十一'];
  check('同话题漂移低', topicDrift(oneTopic) < DRIFT_THRESHOLD, `drift=${topicDrift(oneTopic).toFixed(2)}`);
  check('换话题漂移高', topicDrift(shifted) >= DRIFT_THRESHOLD, `drift=${topicDrift(shifted).toFixed(2)}`);
  check('太短不判漂移', topicDrift(['在吗', '在']) === 0);

  console.log('\n[3] 记忆读写');
  const tmp = await mkdtemp(path.join(tmpdir(), 'al1s-agent-'));
  try {
    const mem = new GroupMemory(tmp, GROUP);
    await mem.saveMember(MEMBER_OPENID, '謎矢', '- 性格: 话痨');
    const got = await mem.getMember(MEMBER_OPENID);
    check('档案写入并读回', Boolean(got?.profile.includes('话痨')));
    const rendered = await mem.renderContext([MEMBER_OPENID]);
    check('渲染含昵称', rendered.includes('謎矢'));

    console.log('\n[3.1] chat-log 按字节偏移增量读');
    {
      const chatDir = path.join(tmp, 'chats', 'group', GROUP);
      await mkdir(chatDir, { recursive: true });
      const logFile = path.join(chatDir, 'messages.jsonl');
      const row = (id: string, text: string): string =>
        `${JSON.stringify({ messageId: id, timestamp: '2026-10-26T10:00:00+08:00', senderId: 'S', senderName: '甲', content: text })}\n`;
      await writeFile(logFile, row('M1', '第一条') + row('M2', '第二条'));
      const first = await readNewRecordsFrom(tmp, GROUP, 0);
      check('首次读全部', first.records.length === 2, `实际 ${first.records.length}`);
      const second = await readNewRecordsFrom(tmp, GROUP, first.offset);
      check('没新消息就读 0 条', second.records.length === 0);
      await appendFile(logFile, row('M3', '第三条'));
      const third = await readNewRecordsFrom(tmp, GROUP, second.offset);
      check('只返回新增那条', third.records.length === 1 && third.records[0]?.messageId === 'M3');
      await appendFile(logFile, '{"messageId":"HALF","content":"没写完');
      const half = await readNewRecordsFrom(tmp, GROUP, third.offset);
      check('半行不吞，留给下次', half.records.length === 0 && half.offset === third.offset);
      await appendFile(logFile, '"}\n');
      const completed = await readNewRecordsFrom(tmp, GROUP, half.offset);
      check('补齐后能读到', completed.records.length === 1 && completed.records[0]?.messageId === 'HALF');
      // 老状态：只有 lastMessageId、没有 offset
      const legacy = await readNewRecordsFrom(tmp, GROUP, undefined, 'M3');
      check(
        '老水位迁移：结果与按 id 扫描一致',
        legacy.records.length === 1 && legacy.records[0]?.messageId === 'HALF',
        `实际 ${legacy.records.map((r) => r.messageId).join(',')}`,
      );
      const afterMigrate = await readNewRecordsFrom(tmp, GROUP, legacy.offset);
      check('迁移后立刻可以增量读', afterMigrate.records.length === 0);
      // 文件被截断（换成了新文件）时不能卡死
      await writeFile(logFile, row('N1', '重新开始'));
      const truncated = await readNewRecordsFrom(tmp, GROUP, completed.offset);
      check('文件变短就从头读', truncated.records.length === 1 && truncated.records[0]?.messageId === 'N1');

      console.log('\n[3.2] 媒体缓存淘汰');
      const mediaDir = path.join(tmp, 'media-cache');
      await mkdir(mediaDir, { recursive: true });
      await writeFile(path.join(mediaDir, 'old'), 'x'.repeat(64));
      await writeFile(path.join(mediaDir, 'fresh'), 'y'.repeat(64));
      const past = new Date(Date.now() - 40 * 24 * 3600_000);
      await utimes(path.join(mediaDir, 'old'), past, past);
      const pruned = await pruneMediaCache(tmp, 30);
      check('超期文件被删', pruned.removed === 1 && !existsSync(path.join(mediaDir, 'old')));
      check('新文件保留', existsSync(path.join(mediaDir, 'fresh')));
    }

    console.log('\n[4] 主链路：非 @ 不调模型，@ 才调');
    const calls: ChatMessage[][] = [];
    const agent = new ChatAgent(config, quietLogger, async (messages) => {
      calls.push(messages);
      return '诶 累成这样啊';
    });
    const replies: string[] = [];
    const fakeBot = {
      replyText: async (_target: unknown, text: string) => {
        replies.push(text);
      },
    } as unknown as Bot;

    await agent.handle(makeMessage({ content: '没人叫你的话1' }), fakeBot);
    await agent.handle(makeMessage({ content: '没人叫你的话2' }), fakeBot);
    check('非 @ 不产生模型调用', calls.length === 0, `实际 ${calls.length}`);
    check('非 @ 不回复', replies.length === 0);

    await agent.handle(makeMessage({ content: '/课表 明天' }), fakeBot);
    check('/ 开头被忽略', calls.length === 0);

    await agent.handle(
      makeMessage({ content: 'Kei 在吗', mentions: [{ member_openid: BOT_OPENID }] }),
      fakeBot,
    );
    check('@ 触发一次模型调用', calls.length === 1, `实际 ${calls.length}`);
    check('回复已发出', replies.length === 1 && (replies[0] ?? '').includes('累成这样'));
    const prompt = calls[0]?.map((m) => m.content).join('\n') ?? '';
    check('提示含人格', prompt.includes('Kei（ケイ）'));
    check('提示含之前闲聊的背景', prompt.includes('没人叫你的话1') && prompt.includes('没人叫你的话2'));
    check('提示含当前这句', prompt.includes('Kei 在吗'));

    await agent.handle(
      makeMessage({ content: '再问一句', mentions: [{ member_openid: BOT_OPENID }] }),
      fakeBot,
    );
    const second = calls[1]?.map((m) => m.content).join('\n') ?? '';
    check('上下文是滚动的，不会用完就忘', second.includes('没人叫你的话1'));
    check('上一轮 @ 过的话也留在上下文里', second.includes('Kei 在吗'));

    // 假模型每次都回「诶 …」开头：第三轮必须点名这个字，而不是含糊地「换个说法」
    check('重复开头能识别', repeatedOpener(['诶', '诶', '哈哈'])?.word === '诶');
    check('只出现一次不算重复', repeatedOpener(['诶', '哈哈', '哦～']) === undefined);
    await agent.handle(
      makeMessage({ content: '第三句', mentions: [{ member_openid: BOT_OPENID }] }),
      fakeBot,
    );
    const third = calls[2]?.map((m) => m.content).join('\n') ?? '';
    check('提示点名禁用的起手式', third.includes('已经用了 2 次') && third.includes('不要用「诶」开头'));

    console.log('\n[5] 长回复分片');
    check('短回复不切', splitReply('诶 累就早点歇').length === 1);
    check('空行切成两条', splitReply('第一段\n\n第二段').length === 2);
    check('单换行不切', splitReply('第一行\n第二行').length === 1);
    check('多个空行只切一次', splitReply('甲\n\n\n\n乙').length === 2);
    check('空行分段内容正确', splitReply('甲\n\n乙')[1] === '乙', JSON.stringify(splitReply('甲\n\n乙')));
    check('超过条数会合并', splitReply('一\n\n二\n\n三\n\n四\n\n五').length <= MAX_REPLY_CHUNKS);
    const long = '第一段内容'.repeat(200) + '\n\n' + '第二段内容'.repeat(200);
    const parts = splitReply(long);
    check('长回复被切开', parts.length >= 2, `实际 ${parts.length}`);
    check('每片不超限', parts.every((p) => p.length <= MAX_REPLY_CHARS), `最长 ${Math.max(...parts.map((p) => p.length))}`);
    check('没有丢内容', parts.join('').replace(/\s/g, '').length === long.replace(/\s/g, '').length);

    console.log('\n[6] 私聊');
    const dmReplies: string[] = [];
    const dmBot = {
      replyText: async (_t: unknown, reply: string) => {
        dmReplies.push(reply);
      },
    } as unknown as Bot;
    await agent.handle(
      makeMessage({ kind: 'c2c', groupOpenid: undefined, content: '在不', mentions: [] }),
      dmBot,
    );
    check('私聊不需要 @ 也回', dmReplies.length === 1, `实际 ${dmReplies.length}`);

    console.log('\n[7] 正文清洗');
    check('去掉 @ 协议标记', !cleanQQText('<@010356C972961F4612B45B858C77091A> 在吗').includes('010356'));
    check('保留 @ 语义', cleanQQText('<@010356C972961F4612B45B858C77091A> 在吗').includes('@某人'));
    check('表情转成 [表情]', cleanQQText('<faceType=6,faceId="0",ext="xxx=">') === '[表情]');
    check('普通文字不受影响', cleanQQText('今天吃什么') === '今天吃什么');

    console.log('\n[8] 看不到图时的规矩');
    check('人格要求不许猜图', PERSONA.includes('绝对不许猜图里是什么'));
    check('人格要求直说没加载', PERSONA.includes('没加载出来'));

    console.log('\n[9] 调用记录');
    const rec = buildRecord({
      purpose: 'chat',
      model: 'deepseek-v4.1-flash',
      attempt: 0,
      ok: true,
      ms: 2000,
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        total_tokens: 1100,
        prompt_tokens_details: { cached_tokens: 400 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
      messages: 2,
      promptChars: 3000,
      images: 0,
      maxTokens: 400,
      temperature: 0.9,
      contextWindow: 100_000,
      stack: 'Error\n    at chatComplete (/x/src/agent/llm.ts:100:5)\n    at reply (/x/src/agent/index.ts:320:20)\n    at process (/x/node_modules/foo.js:1:1)',
    });
    check('缓存率算对', rec.cacheRate === 0.4, `实际 ${rec.cacheRate}`);
    check('速度算对', rec.tokensPerSecond === 50, `实际 ${rec.tokensPerSecond}`);
    check('上下文占用算对', rec.contextRate === 0.01, `实际 ${rec.contextRate}`);
    check('调用栈只留应用帧', rec.stack.length === 2 && !rec.stack.join(' ').includes('node_modules'), rec.stack.join(' | '));

    const sum = summarize([
      { ...rec, ms: 1000, ok: true },
      { ...rec, ms: 3000, ok: true },
      { ...rec, ms: 5000, ok: false },
      { ...rec, ms: 9000, ok: true },
    ]);
    check('统计: 调用数', sum.calls === 4);
    check('统计: 失败数', sum.failedCalls === 1);
    check('统计: p50', sum.p50Ms === 5000, `实际 ${sum.p50Ms}`);
    check('统计: 平均耗时', sum.avgMs === 4500, `实际 ${sum.avgMs}`);
    check('统计: 缓存率', sum.cacheRate === 0.4, `实际 ${sum.cacheRate}`);

    console.log('\n[10] 历史检索');
    const tmp2 = await mkdtemp(path.join(tmpdir(), 'al1s-search-'));
    const chatDir = path.join(tmp2, 'chats', 'group', GROUP);
    await mkdir(chatDir, { recursive: true });
    const rows = [
      { timestamp: new Date(Date.now() - 3600_000).toISOString(), senderId: 'A1', senderName: '小明', content: '我决定退坑了 实在打不动', groupOpenid: GROUP },
      { timestamp: new Date(Date.now() - 7200_000).toISOString(), senderId: 'A2', senderName: '小红', content: '今天晚饭吃什么', groupOpenid: GROUP },
      { timestamp: new Date(Date.now() - 40 * 86_400_000).toISOString(), senderId: 'A1', senderName: '小明', content: '远古时期的退坑宣言', groupOpenid: GROUP },
    ];
    await writeFile(
      path.join(chatDir, 'messages.jsonl'),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );

    const index = new MessageIndex(tmp2);
    const hits = await index.search({ query: '退坑' });
    check('检索命中全部', hits.length === 2, `实际 ${hits.length}`);
    check('按天数过滤', (await index.search({ query: '退坑', days: 7 })).length === 1);
    check('按人过滤命中 0', (await index.search({ query: '退坑', sender: '小红' })).length === 0);
    check('按人过滤命中 1', (await index.search({ query: '退坑', sender: '小明' })).length === 2);
    check('多词需同时命中', (await index.search({ query: '退坑 晚饭' })).length === 0);
    check('结果带时间与昵称', renderHits(hits).includes('小明') && renderHits(hits).includes('['));
    check('空结果有兜底文案', renderHits([]).includes('没有找到'));

    console.log('\n[11] 工具调用链路');
    let round = 0;
    const fakeRaw = async (): Promise<ChatResponse> => {
      round += 1;
      if (round === 1) {
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'search_messages', arguments: '{"query":"退坑"}' } },
          ],
        };
      }
      return { content: '查到了 小明说要退坑', toolCalls: [], finishReason: 'stop' };
    };
    const toolAgent = new ChatAgent(
      { ...config, dataRoot: tmp2, toolsEnabled: true },
      quietLogger,
      async () => {
        throw new Error('不该走纯文本路径');
      },
      fakeRaw,
    );
    const toolReplies: string[] = [];
    await toolAgent.handle(
      makeMessage({ content: '谁说要退坑啊', mentions: [{ member_openid: BOT_OPENID, bot: true }] }),
      {
        replyText: async (_t: unknown, reply: string) => {
          toolReplies.push(reply);
        },
      } as unknown as Bot,
    );
    check('工具轮次后仍回复', toolReplies.length === 1, `实际 ${toolReplies.length}`);
    check('回复内容正确', (toolReplies[0] ?? '').includes('退坑'));
    check('确实跑了两轮', round === 2, `实际 ${round}`);

    const noToolAgent = new ChatAgent(
      { ...config, dataRoot: tmp2, toolsEnabled: false },
      quietLogger,
      async () => '直接回',
    );
    const plain: string[] = [];
    await noToolAgent.handle(
      makeMessage({ content: '在吗', mentions: [{ member_openid: BOT_OPENID, bot: true }] }),
      { replyText: async (_t: unknown, reply: string) => { plain.push(reply); } } as unknown as Bot,
    );
    check('关掉工具走纯文本', plain[0] === '直接回');

    await rm(tmp2, { recursive: true, force: true });

    console.log('\n[12] 对话归档与话题索引');
    const tmp3 = await mkdtemp(path.join(tmpdir(), 'al1s-digest-'));
    const digestChat = path.join(tmp3, 'chats', 'group', GROUP);
    await mkdir(digestChat, { recursive: true });
    // 固定日期会过期：2026-11-19 这天刚好超了 recent_digests 的 30 天窗口。改成「十天前」相对时间。
    const base = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const conversation = Array.from({ length: 12 }, (_, i) =>
      JSON.stringify({
        messageId: `d${i}`,
        timestamp: new Date(base + i * 60_000).toISOString(),
        senderId: i % 2 === 0 ? 'A1' : 'A2',
        senderName: i % 2 === 0 ? '小明' : '小红',
        content: i === 3 ? '我们周末去爬泰山吧' : `闲聊第 ${i + 1} 句`,
        groupOpenid: GROUP,
      }),
    ).join('\n') + '\n';
    await writeFile(path.join(digestChat, 'messages.jsonl'), conversation, 'utf8');

    let digestCalls = 0;
    const fakeDigest = async (): Promise<string> => {
      digestCalls += 1;
      return JSON.stringify({
        summary: '一群人在闲聊，中途说起周末去爬泰山。',
        topics: [
          { title: '周末爬泰山', keywords: ['泰山', '周末'], summary: '定了周六出发' },
          { title: '日常闲聊', keywords: ['闲聊'], summary: '没什么正事' },
        ],
        note: '约好周六爬泰山',
      });
    };

    const notes: string[] = [];
    const engine = new DigestEngine({
      dataRoot: tmp3,
      llm: config.llm,
      log: quietLogger,
      threshold: 10,
      maxBatch: 120,
      complete: fakeDigest,
      onMemoryWorthy: (_chatId, note) => notes.push(note),
    });

    const due = await engine.dueCount(GROUP);
    check('水位线统计新消息', due === 12, `实际 ${due}`);

    const record = await engine.digest(GROUP);
    check('产出摘要', !!record && record.count === 12, `count=${record?.count}`);
    check('摘要非空', (record?.summary ?? '').includes('泰山'));
    check('话题数量正确', record?.topics.length === 2, `实际 ${record?.topics.length}`);
    check('值得记的事触发回调', notes.length === 1 && (notes[0] ?? '').includes('泰山'));
    check('只调用一次模型', digestCalls === 1, `实际 ${digestCalls}`);

    const again = await engine.dueCount(GROUP);
    check('归档后水位线推进', again === 0, `实际 ${again}`);
    check('重复触发无新摘要', (await engine.digest(GROUP)) === undefined);

    const topics = await engine.readTopics(GROUP);
    check('话题写入索引', topics.length === 2, `实际 ${topics.length}`);
    check('话题带次数与时间', topics[0]?.count === 1 && !!topics[0]?.lastAt);

    const recent = await engine.readDigests(GROUP, 5);
    check('摘要可回读', recent.length === 1 && (recent[0]?.summary ?? '').includes('泰山'));

    // 第二轮：同一话题应合并计数，而不是新增
    await writeFile(
      path.join(digestChat, 'messages.jsonl'),
      conversation +
        Array.from({ length: 10 }, (_, i) =>
          JSON.stringify({
            messageId: `e${i}`,
            timestamp: new Date(base + (20 + i) * 60_000).toISOString(),
            senderId: 'A1',
            senderName: '小明',
            content: `泰山装备第 ${i + 1} 条`,
            groupOpenid: GROUP,
          }),
        ).join('\n') + '\n',
      'utf8',
    );
    await engine.digest(GROUP);
    const merged = await engine.readTopics(GROUP);
    const taishan = merged.find((t) => t.title === '周末爬泰山');
    check('同话题合并计数', taishan?.count === 2, `实际 ${taishan?.count}`);
    check('索引不重复', merged.length === 2, `实际 ${merged.length}`);

    // 话题检索
    const topicTool = await executeTool('search_topics', '{"query":"泰山"}', {
      dataRoot: tmp3,
      groupId: GROUP,
      log: quietLogger,
    });
    check('工具能搜到话题', topicTool.includes('周末爬泰山'));
    const digestTool = await executeTool('recent_digests', '{"days":30}', {
      dataRoot: tmp3,
      groupId: GROUP,
      log: quietLogger,
    });
    check('工具能读摘要', digestTool.includes('泰山'));

    await rm(tmp3, { recursive: true, force: true });

    console.log('\n[13] 指令 /status');
    check('识别 /status', matchCommand('/status') === 'status');
    check('识别裸 status', matchCommand('status') === 'status');
    check('大小写不敏感', matchCommand(' /STATUS ') === 'status');
    check('不误伤别家命令', matchCommand('/课表') === undefined);
    check('不误伤聊天', matchCommand('今天状态不好') === undefined);

    const statusText = await renderStatus({
      chatId: GROUP,
      dataRoot: tmp3,
      bufferLines: 12,
      bufferLimit: 40,
      model: 'deepseek-v4.1-flash',
      contextWindow: 1000000,
      startedAt: Date.now() - 3660_000,
    });
    check('状态含模型名', statusText.includes('deepseek-v4.1-flash'));
    check('状态含缓冲用量', statusText.includes('12/40'));
    check('状态含消息数', /本群消息 [\d,]+ 条/.test(statusText));
    check('状态含运行时长', statusText.includes('小时'));
    check('状态含缓存命中', statusText.includes('缓存命中'));

    // 指令必须绕开模型
    const cmdAgent = new ChatAgent({ ...config, dataRoot: tmp3 }, quietLogger, async () => {
      throw new Error('指令不该调模型');
    });
    const cmdReplies: string[] = [];
    await cmdAgent.handle(
      makeMessage({ content: '/status' }),
      { replyText: async (_t: unknown, reply: string) => { cmdReplies.push(reply); } } as unknown as Bot,
    );
    check('指令有回复', cmdReplies.length === 1, `实际 ${cmdReplies.length}`);
    check('指令回复是状态', (cmdReplies[0] ?? '').includes('buff') === false && (cmdReplies[0] ?? '').includes('模型'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log('\n[14] 主动参与的判断');
  check('解析正常 JSON', parseProactive('{"speak":true,"reason":"有人提问没人接","text":"八点开吗"}').speak);
  const silent = parseProactive('{"speak":false,"reason":"聊得正热闹","text":""}');
  check('不说话时不带文本', !silent.speak && silent.reason.includes('热闹'));
  check('说话但没内容 → 沉默', !parseProactive('{"speak":true,"reason":"x","text":""}').speak);
  check('带围栏也能解析', parseProactive('```json\n{"speak":true,"reason":"r","text":"来看看"}\n```').speak);
  check('乱码 → 沉默', !parseProactive('我觉得可以说两句').speak);
  const proactivePrompt = JSON.stringify(buildProactiveMessages({
    groupId: GROUP,
    lines: [
      { senderName: '甲', text: '今晚打本吗', timestamp: Date.now() },
      { senderName: '乙', text: '谁有钥匙', timestamp: Date.now() },
      { senderName: '丙', text: '我没有', timestamp: Date.now() },
      { senderName: '甲', text: '那算了', timestamp: Date.now() },
    ],
  }));
  check('提示词含断裂判据', proactivePrompt.includes('没人回答'));
  check('提示词要求不当主持人', proactivePrompt.includes('主持人'));
  let proactiveCalls = 0;
  const quiet = await judgeProactive(
    { groupId: GROUP, lines: [{ senderName: '甲', text: '在', timestamp: Date.now() }] },
    {
      complete: async () => {
        proactiveCalls += 1;
        return '{"speak":true,"reason":"x","text":"我来了"}';
      },
      llm: config.llm,
      log: quietLogger,
    },
  );
  check('发言太少不调模型', !quiet.speak && proactiveCalls === 0);

  console.log('\n[14.5] 图片直接进上下文');
  {
    const tiny = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const kept = await prepareImage(tiny, 'image/jpeg', quietLogger);
    check('小图不压缩原样用', kept.data.byteLength === tiny.byteLength && kept.mime === 'image/jpeg');

    const ghost = await loadImageParts(
      [{ content_type: 'image/jpeg', url: 'http://127.0.0.1:1/none' }],
      quietLogger,
    );
    check('加载失败只记标记', ghost.parts.length === 0 && ghost.failed === 1);
    check('失败标记可读', ghost.markers[0]?.includes('没加载出来') === true);

    const voice = await digestAttachments(
      [{ content_type: 'image/jpeg', url: 'http://127.0.0.1:1/x' }, { content_type: 'audio/silk', asr_refer_text: '今天好累' }],
      config.llm,
      quietLogger,
      { skipImages: true },
    );
    check('跳图后不再写图描述', !voice.text.includes('[图'));
    check('跳图不影响语音转写', voice.text.includes('今天好累'));

    // 描述缓存按内容哈希落盘：同一个表情包换 rkey 再发、隔天重启，都不该再花钱
    const capTmp = await mkdtemp(path.join(tmpdir(), 'al1s-caption-'));
    try {
      const store = captionStorePath(capTmp);
      const sha = 'a'.repeat(64);
      useCaptionStore(store);
      rememberCaption(sha, '一只在笑的猫');
      check('刚识别完的图立刻命中', captionForSha(sha) === '一只在笑的猫');
      await flushCaptionStore();
      useCaptionStore(undefined);
      useCaptionStore(store);
      check('重启后同一张图仍命中', captionForSha(sha) === '一只在笑的猫');
      check('没见过的图不误命中', captionForSha('b'.repeat(64)) === undefined);
      await writeFile(store, '{坏掉的 json', 'utf8');
      useCaptionStore(undefined);
      useCaptionStore(store);
      check('缓存文件损坏不影响启动', captionForSha('c'.repeat(64)) === undefined);
    } finally {
      useCaptionStore(undefined);
      await rm(capTmp, { recursive: true, force: true });
    }
  }

  console.log('\n[15] 检索同义扩展');
  const expandTmp = await mkdtemp(path.join(tmpdir(), 'al1s-expand-'));
  try {
    const group = 'expand-group';
    const dir = path.join(expandTmp, 'chats', 'group', group);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'messages.jsonl'),
      [
        JSON.stringify({ messageId: 'h1', timestamp: '2026-10-20T10:00:00Z', senderId: 'u1', senderName: '星落夕', content: '我下周就不玩了，afk 一段时间' }),
        JSON.stringify({ messageId: 'h2', timestamp: '2026-10-20T10:01:00Z', senderId: 'u2', senderName: '落樱', content: '好的 等你回来' }),
      ].join('\n') + '\n',
      'utf8',
    );
    const ctx = {
      dataRoot: expandTmp,
      groupId: group,
      log: quietLogger,
      llm: config.llm,
      complete: async () => '不玩了、弃游、afk',
    };
    const miss = await executeTool('search_messages', '{"query":"退坑"}', ctx);
    check('原词没命中时走扩展', miss.includes('afk') && miss.includes('近义说法'));
    check('扩展后能捞到真消息', miss.includes('星落夕'));
    check('缓存后不再问模型', (await expandQuery(ctx, '退坑')).length > 0);
    const direct = await executeTool('search_messages', '{"query":"afk"}', {
      ...ctx,
      complete: async () => {
        throw new Error('命中就不该扩展');
      },
    });
    check('直接命中不扩展', direct.includes('星落夕') && !direct.includes('近义说法'));
    const nothing = await executeTool('search_messages', '{"query":"量子力学"}', {
      ...ctx,
      complete: async () => '量子物理、波函数',
    });
    check('扩展也没命中就如实说', nothing.includes('没有命中'));
  } finally {
    await rm(expandTmp, { recursive: true, force: true });
  }

  console.log('\n[16] 记忆带时间');
  const today = '2026-10-26';
  const learnPrompt = learnSystem(today);
  check('提示词带今天日期', learnPrompt.includes(today));
  check('要求标时间区间', learnPrompt.includes('~ )') || learnPrompt.includes('~ ）'));
  check('不删旧条目', learnPrompt.includes('不要删旧条目'));

  console.log('\n[17] 权限分档与代码工具');
  const policy = {
    ownerOpenids: ['OWNER'],
    devOpenids: ['DEV'],
    devGroups: ['G1'],
    codeTools: true,
    workspace: '/tmp/ws',
    repo: 'campus-nav-3d',
    repoSlug: 'mico-v/campus-nav-3d',
    cmdBlacklist: [] as string[],
    localHeavy: 'block' as const,
  };
  check('主人 → owner', resolveTier('OWNER', 'G1', policy) === 'owner');
  check('工程群里的开发成员 → dev', resolveTier('DEV', 'G1', policy) === 'dev');
  check('非工程群里同一个开发成员 → guest', resolveTier('DEV', 'G2', policy) === 'guest');
  check('陌生人 → guest', resolveTier('X', 'G1', policy) === 'guest');
  check('私聊不给 dev', resolveTier('DEV', undefined, policy) === 'guest');
  check('关掉代码工具后连主人也只剩聊天', capabilitiesFor('owner', { ...policy, codeTools: false }).exec === false);
  check('guest 没有仓库读权限', capabilitiesFor('guest', policy).repoRead === false);
  check('guest 没有写权限', capabilitiesFor('guest', policy).repoWrite === false);
  check('dev 与 owner 同权（2026-11-19 放宽）', capabilitiesFor('dev', policy).repoWrite === true);

  // 黑名单模式：黑名单为空时命令全放行，guest 除外；收紧只改 AGENT_CMD_BLACKLIST
  check('黑名单为空就全放行', parseBlacklist(undefined).length === 0 && parseBlacklist('').length === 0);
  check('黑名单按逗号换行切', parseBlacklist('sudo\nrm -rf /,systemctl').length === 3);
  check('guest 不能跑命令', !checkCommand('git status', 'guest', []).allowed);
  check('空命令拒', !checkCommand('   ', 'owner', []).allowed);
  check('dev 能跑测试', checkCommand('npm test', 'dev', []).allowed);
  check('dev 能提交', checkCommand('git commit -am x', 'dev', []).allowed);
  check('主人能推分支', checkCommand('git push -u origin feat/x', 'owner', []).allowed);
  check('黑名单为空时直推 main 也放行', checkCommand('git push origin main', 'owner', []).allowed);
  check('黑名单为空时 npm install / gh 可用', checkCommand('npm ci && gh pr list', 'owner', []).allowed);
  check('黑名单为空时绝对路径不再误伤', checkCommand('node /srv/kei/work/campus-nav-3d/scripts/x.mjs', 'owner', []).allowed);
  check('配了黑名单就拦', !checkCommand('sudo systemctl restart x', 'owner', ['sudo', 'systemctl']).allowed);
  check('黑名单写错正则不报错也不拦', checkCommand('ls', 'owner', ['([a-z']).allowed);

  const guestTools = JSON.stringify(toolDefinitionsFor(capabilitiesFor('guest', policy)));
  const ownerTools = JSON.stringify(toolDefinitionsFor(capabilitiesFor('owner', policy)));
  check('guest 看不到 run_command', !guestTools.includes('run_command'));
  check('guest 看不到 write_file', !guestTools.includes('write_file'));
  check('guest 能看到记忆查询', guestTools.includes('memory_query'));
  check('主人能看到 run_command', ownerTools.includes('run_command'));
  check('主人能看到 write_file', ownerTools.includes('write_file'));
  check('主人能看到 memory_note', ownerTools.includes('memory_note'));

  console.log('\n[18] 分群人格');
  const personaTmp = await mkdtemp(path.join(tmpdir(), 'persona-'));
  try {
    check('没配就退回默认人格', resolvePersona('NOPE', personaTmp) === PERSONA);
    check('私聊用默认人格', resolvePersona(undefined, personaTmp) === PERSONA);
    await mkdir(path.join(personaTmp, 'personas'), { recursive: true });
    await writeFile(path.join(personaTmp, 'personas', 'G1.md'), 'use: project-lead\n', 'utf8');
    const lead = resolvePersona('G1', personaTmp);
    check('use: 指向仓库里的人格', lead.includes('项目管家'), lead.slice(0, 30));
    check('掌家人格要求先看再答', lead.includes('repo_status'));
    await writeFile(path.join(personaTmp, 'personas', 'G2.md'), '# 别的人格\n\n就这一句。\n', 'utf8');
    check('整份人格原文也能用', resolvePersona('G2', personaTmp).includes('就这一句'));
  } finally {
    await rm(personaTmp, { recursive: true, force: true });
  }

  console.log('\n[19] 记录本');
  const recTmp = await mkdtemp(path.join(tmpdir(), 'records-'));
  try {
    const store = new RecordStore(recTmp, 'G1');
    check('空记录本没有简报', (await store.brief()) === '');
    const task = await store.note({ kind: 'task', title: '真机验证', status: 'todo', owner: '謎矢', by: '謎矢' });
    check('任务记下来了', task.includes('已记录'), task);
    check('简报里有未完成任务', (await store.brief()).includes('真机验证'));
    await store.note({ kind: 'decision', title: '先做通用化底座' });
    check('决策进了简报', (await store.brief()).includes('先做通用化底座'));
    const id = task.replace(/^已记录 #/, '').split('（')[0] ?? '';
    await store.setStatus(id, 'done');
    check('状态改成 done 后离开未完成列表', !(await store.brief()).includes('真机验证'));
    check('查得到历史条目', (await store.query({ text: '真机' })).includes('done'));
    check('不认识的 kind 被拒', (await store.note({ kind: '随便', title: 'x' })).includes('kind 只能是'));
    check('找不到的 id 不乱改', (await store.setStatus('zzzz', 'done')).includes('找不到'));
  } finally {
    await rm(recTmp, { recursive: true, force: true });
  }

  console.log('\n[20] LLM 请求体与原生工具调用格式');
  const llmBase = { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', temperature: 0.7, maxTokens: 0 };
  const msg: ChatMessage[] = [{ role: 'user', content: 'hi' }];
  const thinkOn = JSON.parse(buildRequestBody(msg, llmBase));
  check('思考模式显式声明开启', thinkOn.thinking?.type === 'enabled');
  check('思考模式不发 temperature（手册：不生效）', !('temperature' in thinkOn));
  const thinkOff = JSON.parse(buildRequestBody(msg, { ...llmBase, disableThinking: true }));
  check('关掉思考时显式声明且发 temperature', thinkOff.thinking?.type === 'disabled' && thinkOff.temperature === 0.7);
  const withTools = JSON.parse(buildRequestBody(msg, { ...llmBase, tools: [{ type: 'function' }] }));
  check('带 tools 时补 tool_choice', withTools.tool_choice === 'auto' && withTools.tools.length === 1);
  check('不带 tools 就不发', !('tools' in thinkOn));
  check('maxTokens 为 0 不设上限', !('max_tokens' in thinkOn));
  check('maxTokens 有值才发', JSON.parse(buildRequestBody(msg, { ...llmBase, maxTokens: 300 })).max_tokens === 300);
  check('工具轮数默认 40', readAgentConfig({} as NodeJS.ProcessEnv).toolRounds === 40);
  check('工具轮数可配', readAgentConfig({ AGENT_TOOL_ROUNDS: '80' } as NodeJS.ProcessEnv).toolRounds === 80);
  check('时间预算默认 8 分钟', readAgentConfig({} as NodeJS.ProcessEnv).turnBudgetMs === 480_000);
  check('时间预算可配', readAgentConfig({ AGENT_TURN_BUDGET_MS: '600000' } as NodeJS.ProcessEnv).turnBudgetMs === 600_000);

  console.log('\n[21] 长回合的进度播报与上下文瘦身');
  const prog = readAgentConfig({} as NodeJS.ProcessEnv).progress;
  check('进度播报默认开', prog.enabled && prog.max === 3 && prog.gapMs === 75_000);
  check('进度可关', readAgentConfig({ AGENT_PROGRESS: 'false' } as NodeJS.ProcessEnv).progress.enabled === false);
  const line = describeProgress(8, [{ id: '1', type: 'function', function: { name: 'run_command', arguments: '{"cmd":"npm test"}' } }]);
  check('进度带步数与命令', line.includes('第 8 步') && line.includes('npm test'), line);
  check('多个动作标出个数', describeProgress(3, [
    { id: '1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
    { id: '2', type: 'function', function: { name: 'run_command', arguments: '{"cmd":"ls"}' } },
  ]).includes('2 个动作'));
  check('没动作就不报', describeProgress(1, []) === '');

  const outPolicy = { maxChars: 40, keepRecent: 1, clearAtChars: 60 };
  const longOut = 'x'.repeat(80);
  const clipped = clipToolOutput(longOut, outPolicy.maxChars);
  check('单条输出超限就剪', clipped.length < longOut.length && clipped.includes('已截断'));
  const toolConvo: ChatMessage[] = [
    { role: 'user', content: 'go' },
    { role: 'tool', tool_call_id: 'a', content: longOut },
    { role: 'tool', tool_call_id: 'b', content: longOut },
    { role: 'tool', tool_call_id: 'c', content: longOut },
  ];
  const pruned = pruneToolResults(toolConvo, outPolicy);
  check('老的工具结果折成一行', String(pruned[1]?.content).startsWith('［已清理］'));
  check('最近一条原样保留', pruned[3]?.content === longOut);
  check(
    '不超阈值就不动',
    pruneToolResults(toolConvo, { ...outPolicy, clearAtChars: 10_000 }).every((m, i) => m.content === toolConvo[i]?.content),
  );

  console.log('\n[22] 追加式会话链（前缀缓存）');
  check('token 粗估按字符量算', approxTokens([{ role: 'user', content: '一'.repeat(300) }]) === 100);
  const seen: ChatMessage[][] = [];
  const threadTmp = await mkdtemp(path.join(tmpdir(), 'al1s-thread-'));
  const threadAgent = new ChatAgent(
    { ...config, dataRoot: threadTmp, toolsEnabled: false },
    quietLogger,
    async (msgs: ChatMessage[]) => {
      seen.push(msgs.map((m) => ({ ...m })));
      return '嗯';
    },
  );
  const sayOnce = async (body: string): Promise<void> => {
    await threadAgent.handle(
      makeMessage({ content: body, mentions: [{ member_openid: BOT_OPENID, bot: true }] }),
      { replyText: async () => undefined } as unknown as Bot,
    );
  };
  await sayOnce('第一句');
  await sayOnce('第二句');
  check('第二轮消息变多', seen[1]!.length > seen[0]!.length, `${seen[0]?.length} → ${seen[1]?.length}`);
  check('系统提示两轮一字不差', seen[0]![0]?.content === seen[1]![0]?.content);
  const prefixSame = seen[1]!.slice(0, seen[0]!.length).every(
    (m, i) => m.role === seen[0]![i]?.role && m.content === seen[0]![i]?.content,
  );
  check('前文只追加不改写（前缀可命中缓存）', prefixSame);
  await rm(threadTmp, { recursive: true, force: true });

  // 简报（记录本 / 目标 / 成员档案）没变就不重念：每轮重念一遍 = 每轮多一份未命中的新 token，
  // 首调命中率就是这么被拖下去的（2026-11-20 实测 2.2k 字符/轮）。
  check('指纹稳定', digestOf('abc') === digestOf('abc') && digestOf('abc') !== digestOf('abd'));
  const briefTmp = await mkdtemp(path.join(tmpdir(), 'al1s-brief-'));
  try {
    await new RecordStore(briefTmp, GROUP).append({
      kind: 'task',
      title: '把 M2 室内数据规范写完',
      status: 'doing',
      by: '謎矢',
    });
    const briefSeen: ChatMessage[][] = [];
    const briefAgent = new ChatAgent(
      { ...config, dataRoot: briefTmp, toolsEnabled: false },
      quietLogger,
      async (msgs: ChatMessage[]) => {
        briefSeen.push(msgs.map((m) => ({ ...m })));
        return '嗯';
      },
    );
    const sayBrief = async (body: string): Promise<void> => {
      await briefAgent.handle(
        makeMessage({ content: body, mentions: [{ member_openid: BOT_OPENID, bot: true }] }),
        { replyText: async () => undefined } as unknown as Bot,
      );
    };
    await sayBrief('第一句');
    await sayBrief('第二句');
    const firstBody = String(briefSeen[0]?.at(-1)?.content ?? '');
    const secondBody = String(briefSeen[1]?.at(-1)?.content ?? '');
    check('首轮把记录本念全', firstBody.includes('把 M2 室内数据规范写完'), firstBody.slice(0, 40));
    check('简报没变就不重念', secondBody.includes('自上一轮没变化') && !secondBody.includes('把 M2 室内数据规范写完'));
    check(
      '重念时不再贴整份简报',
      firstBody.includes('## 记录本摘要') && !secondBody.includes('## 记录本摘要'),
    );
    await new RecordStore(briefTmp, GROUP).append({ kind: 'task', title: '接着做楼层渲染', status: 'todo', by: '謎矢' });
    await sayBrief('第三句');
    const thirdBody = String(briefSeen[2]?.at(-1)?.content ?? '');
    check('记录本一变就重念', thirdBody.includes('接着做楼层渲染') && !thirdBody.includes('自上一轮没变化'));
  } finally {
    await rm(briefTmp, { recursive: true, force: true });
  }

  // 上游漏解析时，把 DeepSeek 原生标记归一成标准 tool_calls
  const dsmlText =
    '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="run_command">\n' +
    '<｜DSML｜parameter name="cmd" string="true">sed -n 1,80p docs/agent/pipeline.md</｜DSML｜parameter>\n' +
    '</｜DSML｜invoke>\n</｜DSML｜tool_calls>';
  const parsed = parseNativeToolCalls(dsmlText);
  check('认出原生标记', parsed.found);
  check('还原出调用名', parsed.toolCalls[0]?.function.name === 'run_command', parsed.toolCalls[0]?.function.name);
  check(
    '参数还原成 JSON',
    JSON.parse(parsed.toolCalls[0]?.function.arguments ?? '{}').cmd === 'sed -n 1,80p docs/agent/pipeline.md',
  );
  check('正文里不留标记', parsed.content === '');
  const two = parseNativeToolCalls(
    '<｜DSML｜tool_calls><｜DSML｜invoke name="read_file"><｜DSML｜parameter name="path" string="true">a.ts</｜DSML｜parameter></｜DSML｜invoke>' +
      '<｜DSML｜invoke name="run_command"><｜DSML｜parameter name="cmd" string="true">npm test</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>',
  );
  check('一次多个调用都拆得开', two.toolCalls.length === 2 && two.toolCalls[1]?.function.name === 'run_command');
  check('半角竖线也认', parseNativeToolCalls('<|DSML|invoke name="repo_status"></|DSML|invoke>').toolCalls.length === 1);
  const mixed = parseNativeToolCalls('先看看仓库\n<｜DSML｜invoke name="repo_status"></｜DSML｜invoke>\n然后再说');
  check('标记外的正文保留', mixed.content === '先看看仓库\n\n然后再说', JSON.stringify(mixed.content));
  const boolParam = parseNativeToolCalls(
    '<｜DSML｜invoke name="t"><｜DSML｜parameter name="limit" string="false">20</｜DSML｜parameter></｜DSML｜invoke>',
  );
  check('string=false 按 JSON 还原', JSON.parse(boolParam.toolCalls[0]?.function.arguments ?? '{}').limit === 20);
  const truncated = parseNativeToolCalls('<｜DSML｜invoke name="run_command"><｜DSML｜parameter name="cmd" string="true">ls');
  check('截断时不产出半截调用', truncated.found && truncated.toolCalls.length === 0);
  check('没标记不动正文', parseNativeToolCalls('普通回复').found === false);

  console.log('\n[21] 持续目标（goal 模式）');
  const goalTmp = await mkdtemp(path.join(tmpdir(), 'goals-'));
  try {
    const store = new GoalStore(goalTmp, 'G1');
    check('空账本没有目标', (await store.read()) === undefined);
    check(
      '没判据不许立目标',
      (await store.create({ objective: 'x', criteria: [], slices: ['a'] }, { maxRounds: 3, maxWallMs: 60_000 })).includes('完成判据'),
    );
    check(
      '没切片不许立目标',
      (await store.create({ objective: 'x', criteria: ['能跑'], slices: [] }, { maxRounds: 3, maxWallMs: 60_000 })).includes('至少切成一片'),
    );
    const created = await store.create(
      { objective: '把 M2 室内做出来', criteria: ['vitest 全绿', '页面能打开'], slices: ['室内数据规范', '楼层渲染', '真机验收'], by: '謎矢' },
      { maxRounds: 2, maxWallMs: 3_600_000 },
    );
    check('立起目标后指向第一片', created.includes('▶ s1'), created.slice(0, 40));
    check('目标写进账本', (await store.read())?.objective === '把 M2 室内做出来');
    const again = await store.create(
      { objective: '另一个目标', criteria: ['x'], slices: ['y'] },
      { maxRounds: 2, maxWallMs: 60_000 },
    );
    check('同时只允许一个进行中的目标', again.includes('已经有一个进行中的目标'));
    const stepped = await store.step('s1', 'done', { note: 'schema 落地', ref: '#21' });
    check('标进度带出处', stepped.includes('#21'), stepped.slice(0, 60));
    const afterStep = await store.read();
    check('下一片换成 s2', afterStep ? nextSlice(afterStep)?.id === 's2' : false);
    check('找不到的切片不乱改', (await store.step('zzz', 'done')).includes('找不到切片'));

    const round1 = await store.tick({ maxRounds: 2, maxWallMs: 3_600_000 });
    check('续跑记一轮', round1?.ok === true && round1.goal.budget.rounds === 1);
    await store.tick({ maxRounds: 2, maxWallMs: 3_600_000 });
    const overflow = await store.tick({ maxRounds: 2, maxWallMs: 3_600_000 });
    check('轮数用满就停', overflow?.ok === false && String(overflow.reason).includes('2'), String(overflow?.reason));

    const live = await store.read();
    check('预算耗尽时 canContinue 返回 false', live ? !canContinue(live, { maxRounds: 2, maxWallMs: 3_600_000 }).ok : false);
    check('简报含下一片', live ? goalBrief(live).includes('下一片') : false);
    check('视图列出每片状态', live ? renderGoal(live).includes('s2 楼层渲染') : false);

    // 收尾与切片不一致 = 之后续跑闸门永远不放行、也没人再叫醒它，所以直接拒
    const refused = await store.finish('做完两片');
    check('还有切片没收口就拒收尾', refused.includes('没收口'), refused.slice(0, 40));
    check('拒收尾时状态不动', (await store.read())?.status === 'active');
    const forced = await store.finish('做完两片', undefined, { force: true });
    check('force 收尾会提醒未完成切片', forced.includes('没标完成'), forced.slice(0, 40));
    check('收尾后状态是 done', (await store.read())?.status === 'done');
    check('done 后不再续跑', (await store.tick({ maxRounds: 5, maxWallMs: 3_600_000 }))?.ok === false);
    const doneGoal = await store.read();
    check(
      'done 且还有未收口切片时说明怎么续',
      doneGoal ? !canContinue(doneGoal).ok && String(canContinue(doneGoal).reason).includes('/goal resume') : false,
      String(doneGoal ? canContinue(doneGoal).reason : ''),
    );
    check('done 且还有未收口切片能 resume', (await store.resume()).includes('已恢复'));
    check('resume 后回到 active', (await store.read())?.status === 'active');

    const blockedStore = new GoalStore(goalTmp, 'G2');
    // 预算用尽要转 paused：留在 active 会被巡检每 2 分钟捞起来空转，日志看着像在干活
    const pauseStore = new GoalStore(goalTmp, 'G4');
    await pauseStore.create({ objective: '预算用尽测试', criteria: ['跑完'], slices: ['一片'] }, { maxRounds: 1, maxWallMs: 3_600_000 });
    await pauseStore.tick({ maxRounds: 1, maxWallMs: 3_600_000 });
    const exhausted = await pauseStore.read();
    check(
      '用满后 canContinue 拒续跑',
      exhausted ? !canContinue(exhausted, { maxRounds: 1, maxWallMs: 3_600_000 }).ok : false,
    );
    check(
      '预算用尽转 paused',
      (await pauseStore.pause('自动续跑轮数用满（1/1）')) === true &&
        (await pauseStore.read())?.status === 'paused',
    );
    check('paused 不重复转', (await pauseStore.pause('再来一次')) === false);
    check('paused 后不再续跑', (await pauseStore.tick({ maxRounds: 9, maxWallMs: 3_600_000 }))?.ok === false);

    // 有进展就续命：配额是异常保护，不是给 agent 上锁
    const renewStore = new GoalStore(goalTmp, 'G5');
    await renewStore.create({ objective: '续命测试', criteria: ['跑完'], slices: ['一片'] }, { maxRounds: 1, maxWallMs: 3_600_000 });
    await renewStore.tick({ maxRounds: 1, maxWallMs: 3_600_000 });
    check('没进展时计空转轮数', (await renewStore.read())?.budget.roundsSinceProgress === 1);
    await renewStore.step('s1', 'doing', { note: '开工' });
    check('切片一动手就算有进展', (await renewStore.read())?.budget.roundsSinceProgress === 0);
    const renews = await renewStore.renew('轮数用满，但上一段有进展');
    const renewed = await renewStore.read();
    check(
      '续命后预算重置',
      renews === 1 && renewed?.budget.rounds === 0 && renewed?.budget.renews === 1,
    );
    check(
      '续命后能继续跑',
      renewed ? canContinue(renewed, { maxRounds: 1, maxWallMs: 3_600_000 }).ok : false,
    );
    await blockedStore.create({ objective: '等主人拍板', criteria: ['确认'], slices: ['问主人'] }, { maxRounds: 3, maxWallMs: 60_000 });
    check(
      '卡住后自动续跑停',
      (await blockedStore.block('等主人拍板')).includes('卡住') && (await blockedStore.read())?.status === 'blocked',
    );
    check('blocked 不再续跑', (await blockedStore.tick({ maxRounds: 5, maxWallMs: 60_000 }))?.ok === false);

    // 等 NPC 交货：探针只在指纹变化时叫醒
    const watchStore = new GoalStore(goalTmp, 'G3');
    await watchStore.create(
      { objective: '等 NPC 交 M2-1', criteria: ['PR 合入'], slices: ['派工', '复核'] },
      { maxRounds: 5, maxWallMs: 3_600_000 },
    );
    check('挂上探针', (await watchStore.watch(21, 'sig-1', '等 M2-1')).includes('#21'));
    check('账本记住在等谁', (await watchStore.read())?.awaiting?.issue === 21);
    const watched = await watchStore.read();
    check('简报提示在等 NPC', watched ? goalBrief(watched).includes('在等 #21') : false);
    await watchStore.clearWatch('指纹变了');
    check('叫醒后探针自动解除', (await watchStore.read())?.awaiting === undefined);

    // 等 NPC 时切片全是 blocked，但探针还挂着：不能判「没活干」把线断掉
    const probeStore = new GoalStore(goalTmp, 'G6');
    await probeStore.create({ objective: '等 NPC 交货', criteria: ['PR 合入'], slices: ['派工', '复核'] }, { maxRounds: 0, maxWallMs: 3_600_000 });
    await probeStore.step('s1', 'blocked');
    await probeStore.step('s2', 'blocked');
    check('切片全 blocked 就不续跑', (await probeStore.read()) ? !canContinue((await probeStore.read())!, {}).ok : false);
    await probeStore.watch(20, 'sig-1', '等 PR');
    check('挂探针后允许续跑（只探针不烧回合）', (await probeStore.read()) ? canContinue((await probeStore.read())!, {}).ok : false);

    // 探针挂在 done 目标上 = 静默停摆（2026-11-20 实测：收尾后又挂 #25，一小时没人叫醒）
    const orphanStore = new GoalStore(goalTmp, 'G7');
    await orphanStore.create(
      { objective: '收尾后再挂探针', criteria: ['能跑'], slices: ['一片'] },
      { maxRounds: 5, maxWallMs: 3_600_000 },
    );
    await orphanStore.watch(25, 'sig-9', '等 NPC 交货');
    const closed = await orphanStore.finish('收尾', undefined, { force: true });
    check('收尾顺手拆探针', closed.includes('拆了 #25') && (await orphanStore.read())?.awaiting === undefined);
    const refusedWatch = await orphanStore.watch(26, 'sig-10', '再挂一个');
    check('done 目标挂探针被拒', refusedWatch.includes('不会叫醒'), refusedWatch.slice(0, 40));
    check('被拒时账本不落探针', (await orphanStore.read())?.awaiting === undefined);
  } finally {
    await rm(goalTmp, { recursive: true, force: true });
  }

  console.log('\n[22] CNB issue 协作通道');
  const noToken = readCnbConfig({ AGENT_CNB_TOKEN_FILE: '/nonexistent/cnb-token' } as NodeJS.ProcessEnv);
  check('没令牌就不挂通道', noToken === undefined);
  const inline = readCnbConfig({
    KEI_CNB_TOKEN: ' t0k ',
    AGENT_CNB_REPO: 'mico-v/demo',
    AGENT_CNB_API_BASE: 'https://api.cnb.cool/',
    AGENT_CNB_TOKEN_FILE: '/nonexistent/cnb-token',
  } as NodeJS.ProcessEnv);
  check('内联令牌优先且去空白', inline?.token === 't0k');
  check('仓库与端点可配、尾部斜杠去掉', inline?.repo === 'mico-v/demo' && inline?.apiBase === 'https://api.cnb.cool');
  check('issue 视图带编号与状态', renderIssues([{ number: 3, title: 'M2-1 室内数据', state: 'open' }], 'r').includes('#3 [open]'));
  check('空列表给下一步提示', renderIssues([], 'r').includes('四段'));
  check('PR 视图标 merged', renderPulls([{ number: 9, title: 'x', state: 'closed', merged: true }], 'r').includes('[merged]'));
  const baseIssue = { state: 'open', comment_count: 2, updated_at: '2026-11-19T05:00:00Z' };
  check('没变化时指纹相同', buildProbeSignature(baseIssue, []) === buildProbeSignature({ ...baseIssue }, []));
  check('多一条评论指纹变', buildProbeSignature(baseIssue, []) !== buildProbeSignature({ ...baseIssue, comment_count: 3 }, []));
  check(
    '开了 PR 指纹变',
    buildProbeSignature(baseIssue, []) !==
      buildProbeSignature(baseIssue, [{ number: 16, state: 'open', title: 'x', updated_at: 'u1' }]),
  );
  check(
    'PR 改标题不动指纹',
    buildProbeSignature(baseIssue, [{ number: 16, state: 'open', title: 'x', updated_at: 'u1' }]) ===
      buildProbeSignature(baseIssue, [{ number: 16, state: 'open', title: 'y', updated_at: 'u1' }]),
  );
  check('关 issue 也算变化', buildProbeSignature(baseIssue, []) !== buildProbeSignature({ ...baseIssue, state: 'closed' }, []));
  check('目标指令认 /goal', matchGoalCommand('/goal') === 'status');
  check('目标指令认 /goal stop', matchGoalCommand('/goal stop') === 'stop');
  check('别的斜杠命令不误判', matchGoalCommand('/status') === undefined);
  check('owner 看得到 cnb_issue_create', ownerTools.includes('cnb_issue_create'));
  check('owner 看得到 goal_create', ownerTools.includes('goal_create'));
  check('owner 看得到 goal_watch', ownerTools.includes('goal_watch'));
  check('guest 看不到 goal_create', !guestTools.includes('goal_create'));
  check('guest 看不到 cnb_issue_dispatch', !guestTools.includes('cnb_issue_dispatch'));
  check('目标自动续跑默认关', readAgentConfig({} as NodeJS.ProcessEnv).goals.auto === false);
  check('目标自动续跑可开', readAgentConfig({ AGENT_GOAL_AUTO: 'true' } as NodeJS.ProcessEnv).goals.auto === true);
  check('轮数预算可配', readAgentConfig({ AGENT_GOAL_MAX_ROUNDS: '6' } as NodeJS.ProcessEnv).goals.maxRounds === 6);

  console.log('\n[23] 能力包（kind）、独立复核与会话续航');
  const toolNames = (caps: typeof OWNER_CAPS, kind?: 'code' | 'research' | 'ops' | 'review'): string[] =>
    (toolDefinitionsFor(caps, kind) as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
  const codeTools = toolNames(OWNER_CAPS, 'code');
  check('code 拿全部工具', codeTools.includes('write_file') && codeTools.includes('run_command'));
  check('review 不能写仓库', !toolNames(OWNER_CAPS, 'review').includes('write_file'));
  check('research 能联网搜', toolNames(OWNER_CAPS, 'research').includes('web_search'));
  check('ops 能跑命令', toolNames(OWNER_CAPS, 'ops').includes('run_command'));
  check('guest 收窄后仍无写工具', !toolNames(GUEST_CAPS, 'code').includes('write_file'));
  check('四类活都有提示词', ['code', 'research', 'ops', 'review'].every((kind) => kindPack(kind as 'code').prompt.length > 10));

  const kindTmp = await mkdtemp(path.join(tmpdir(), 'kinds-'));
  try {
    const kindStore = new GoalStore(kindTmp, 'K1');
    await kindStore.create(
      { objective: '调研同类项目', criteria: ['每条结论有出处'], slices: ['查 GitHub'], kind: 'research' },
      { maxRounds: 3, maxWallMs: 60_000 },
    );
    const kindGoal = await kindStore.read();
    check('目标记住类型', kindGoal?.kind === 'research');
    check('视图标出类型', kindGoal ? renderGoal(kindGoal).includes('调研') : false);

    // 标 done 前过独立复核：FAIL 退回 review，PASS 才落地
    const reviewStore = new GoalStore(kindTmp, 'R1');
    await reviewStore.create({ objective: '写一片', criteria: ['测试全绿'], slices: ['改代码'] }, { maxRounds: 3, maxWallMs: 60_000 });
    const baseCtx = {
      dataRoot: kindTmp,
      log: quietLogger,
      goals: reviewStore,
      capabilities: OWNER_CAPS,
      tier: 'owner' as const,
    };
    const failOut = await executeTool('goal_step', '{"slice":"s1","status":"done"}', {
      ...baseCtx,
      reviewSlice: async () => ({ pass: false, note: '缺测试输出' }),
    });
    check('复核不过退回 review', failOut.includes('复核没过') && (await reviewStore.read())?.slices[0]?.status === 'review');
    check('退回时把理由写进切片', ((await reviewStore.read())?.slices[0]?.note ?? '').includes('缺测试输出'));
    const passOut = await executeTool('goal_step', '{"slice":"s1","status":"done"}', {
      ...baseCtx,
      reviewSlice: async () => ({ pass: true, note: '证据齐全' }),
    });
    check('复核通过才标 done', (await reviewStore.read())?.slices[0]?.status === 'done', passOut.slice(0, 60));
    check('复核结果落盘', existsSync(path.join(kindTmp, 'reviews', 'R1')));
  } finally {
    await rm(kindTmp, { recursive: true, force: true });
  }

  // 会话续航：到点交接换链，不是停工
  check('30 轮触发交接', shouldRotateThread({ turns: 30, maxAgeMs: 0, maxTurns: 30 }).rotate);
  check(
    '3 小时触发交接',
    shouldRotateThread({ bornAt: Date.now() - 3 * 3_600_000, turns: 1, maxAgeMs: 3 * 3_600_000, maxTurns: 30 }).rotate,
  );
  check(
    '短会话不交接',
    !shouldRotateThread({ bornAt: Date.now() - 60_000, turns: 2, maxAgeMs: 3 * 3_600_000, maxTurns: 30 }).rotate,
  );
  const handoffTmp = await mkdtemp(path.join(tmpdir(), 'handoff-'));
  try {
    const rel = await writeHandoff(
      handoffTmp,
      'G1',
      renderHandoff({ reason: '会话已 30 轮', turns: 30, goalBrief: '目标：X', tail: '- user: hi' }),
    );
    check('交接单落盘', rel.startsWith(path.join('handoffs', 'G1')) && existsSync(path.join(handoffTmp, rel)));
  } finally {
    await rm(handoffTmp, { recursive: true, force: true });
  }
  check('会话寿命默认 3 小时 / 30 轮', (() => {
    const cfg = readAgentConfig({} as NodeJS.ProcessEnv).thread;
    return cfg.maxAgeMs === 3 * 3_600_000 && cfg.maxTurns === 30;
  })());

  console.log('\n[24] CNB 官方 CLI 与官方 skill 文档');
  const cliCfg = readCnbCliConfig({
    KEI_CNB_TOKEN: 't0k',
    AGENT_CNB_REPO: 'mico-v/demo',
    AGENT_CNB_TOKEN_FILE: '/nonexistent/cnb-token',
    HOME: '/srv/kei',
  } as NodeJS.ProcessEnv);
  check('CLI 复用 issue 通道的令牌与仓库', cliCfg?.token === 't0k' && cliCfg?.repo === 'mico-v/demo');
  check('默认 bin 指向全局安装的 cnb', cliCfg?.bin === '/usr/local/bin/cnb', String(cliCfg?.bin));
  check('官方文档默认落在 HOME/cnb-skills', cliCfg?.guideDir === '/srv/kei/cnb-skills', String(cliCfg?.guideDir));
  check('没令牌就不挂 CLI', readCnbCliConfig({ AGENT_CNB_TOKEN_FILE: '/nonexistent/cnb-token' } as NodeJS.ProcessEnv) === undefined);
  check('正常命令放行', checkCnbArgs(['issues', 'get', '--number', '24']).ok);
  check('--help 放行（模型可以自己探索）', checkCnbArgs(['--help']).ok);
  check('交互式登录拦住', !checkCnbArgs(['login']).ok);
  check('git-credential 拦住', !checkCnbArgs(['git-credential', 'get']).ok);
  const unknownModule = checkCnbArgs(['foo']);
  check('不认识的模块回清单', !unknownModule.ok && unknownModule.reason.includes('issues'));
  check('不许参数里覆盖凭据', !checkCnbArgs(['issues', 'get', '--token', 'x']).ok);
  check('删仓库拦住', !checkCnbArgs(['repositories', 'delete-repo', '--repo', 'x/y']).ok);
  check('空 args 拒绝', !checkCnbArgs([]).ok);
  check('非字符串参数拒绝', !checkCnbArgs(['issues', 1]).ok);
  check('结果视图带状态与耗时', renderCnbRun({ code: 0, out: 'status: 200', err: '', ms: 1200 }, ['issues', 'get']).includes('→ ok（1.2s）'));
  check('超时单独标出', renderCnbRun({ code: -2, out: '', err: '', ms: 60_000 }, ['build', 'x']).includes('超时被杀'));

  const guideTmp = await mkdtemp(path.join(tmpdir(), 'cnbguide-'));
  try {
    await mkdir(path.join(guideTmp, 'cnb-api'), { recursive: true });
    await mkdir(path.join(guideTmp, 'cnb-pipeline', 'references'), { recursive: true });
    await writeFile(
      path.join(guideTmp, 'cnb-api', 'SKILL.md'),
      '---\nname: cnb-api\ndescription: CNB 平台交互命令\n---\n\n# cnb-api\n\ncnb issues get\n',
    );
    await writeFile(path.join(guideTmp, 'cnb-pipeline', 'SKILL.md'), '---\nname: cnb-pipeline\ndescription: 流水线\n---\n\n# cnb-pipeline\n');
    await writeFile(path.join(guideTmp, 'cnb-pipeline', 'references', 'syntax-reference.md'), 'branch: main\n');
    const listed = await listCnbGuide(guideTmp);
    check('列表带技能名与说明', listed.includes('cnb-api：CNB 平台交互命令'), listed.slice(0, 60));
    check('列表标出参考文件', listed.includes('references/syntax-reference.md'));
    check('能读正文', (await readCnbGuide(guideTmp, 'cnb-api')).includes('cnb issues get'));
    check('能读参考文件', (await readCnbGuide(guideTmp, 'cnb-pipeline', 'references/syntax-reference.md')).includes('branch: main'));
    check('检索命中带行号', (await searchCnbGuide(guideTmp, 'branch')).includes('syntax-reference.md:1:'));
    check('检索无果给下一步', (await searchCnbGuide(guideTmp, 'zzz')).includes('换个词'));
    check('技能名不许带路径', (await readCnbGuide(guideTmp, '../etc')).includes('不合法'));
  } finally {
    await rm(guideTmp, { recursive: true, force: true });
  }
  check('owner 有 cnb 与 cnb_guide', ownerTools.includes('"cnb"') && ownerTools.includes('cnb_guide'));
  check('guest 看不到 cnb', !guestTools.includes('"cnb"'));
  check('调研包只给 guide 不给写命令', toolNames(OWNER_CAPS, 'research').includes('cnb_guide') && !toolNames(OWNER_CAPS, 'research').includes('cnb'));

  console.log('\n[25] 选项卡片（按钮）');
  {
    const token = 'abc123';
    const parsed = parseChoiceData(encodeChoiceData(token, 2));
    check('按钮 data 能来回解', parsed?.token === token && parsed.index === 2, JSON.stringify(parsed));
    check('别的互动事件不误认', parseChoiceData('other:1:2') === undefined);
    check('坏 data 不报错', parseChoiceData('choice:x') === undefined && parseChoiceData(undefined) === undefined);
    check('按钮文字按上限截', clipLabel('一二三四五六七八九十十一').length <= MAX_LABEL_CHARS);
    check('短文字不截', clipLabel('先做 M2') === '先做 M2');

    const choice: PendingChoice = {
      token,
      chatId: 'G1',
      question: '先推哪块？',
      options: [
        { label: '先做 M2', detail: '室内与双模' },
        { label: '先补 UGC' },
      ],
      createdAt: Date.now(),
      by: '謎矢',
    };
    const keyboard = buildChoiceKeyboard(choice, { restrictTo: ['OWNER1'] }) as unknown as {
      content: { rows: Array<{ buttons: Array<Record<string, unknown>> }> };
    };
    check('一行一个按钮', keyboard.content.rows.length === 2);
    const first = keyboard.content.rows[0]?.buttons[0] as Record<string, any>;
    check('按钮是回调类型', first.action.type === 1);
    check('只给主人点', JSON.stringify(first.action.permission.specify_user_ids) === '["OWNER1"]');
    check('同组按钮互斥变灰', first.group_id === `choice-${token}`);
    const groupKeyboard = buildChoiceKeyboard(choice, { restrictTo: ['MEMBER1'], withGroupId: false }) as unknown as {
      content: { rows: Array<{ buttons: Array<Record<string, any>> }> };
    };
    check(
      '发群时摘掉 group_id（群聊接口不认，会 400）',
      groupKeyboard.content.rows[0]?.buttons[0]?.group_id === undefined,
    );
    check(
      '发群时仍带 data 与限制人',
      groupKeyboard.content.rows[0]?.buttons[0]?.action.data === encodeChoiceData(token, 0) &&
        JSON.stringify(groupKeyboard.content.rows[0]?.buttons[0]?.action.permission.specify_user_ids) ===
          '["MEMBER1"]',
    );
    check('data 带序号', first.action.data === encodeChoiceData(token, 0));
    check('有过低版本兜底文案', typeof first.action.unsupport_tips === 'string');
    const open = buildChoiceKeyboard(choice) as unknown as {
      content: { rows: Array<{ buttons: Array<Record<string, any>> }> };
    };
    check('不知道限谁时就不限（服务端再拦）', open.content.rows[0]?.buttons[0]?.action.permission.type === 2);
    const card = renderChoiceMarkdown(choice);
    check('正文带问题', card.includes('先推哪块'));
    check('正文带编号选项与细节', card.includes('1. 先做 M2：室内与双模') && card.includes('2. 先补 UGC'));

    const choiceTmp = await mkdtemp(path.join(tmpdir(), 'choice-'));
    try {
      const store = new ChoiceStore(choiceTmp, 'G1');
      check('空仓取不到', (await store.take(token)) === undefined);
      await store.add(choice);
      check('落盘后能读到', (await store.read()).length === 1);
      const taken = await store.take(token);
      check('取回原选项', taken?.question === '先推哪块？');
      check('一次性：再取就没了', (await store.take(token)) === undefined);
      await store.add({ ...choice, createdAt: Date.now() - CHOICE_TTL_MS - 1 });
      check('过期卡片自动作废', (await store.read()).length === 0);
      await store.add({ ...choice, token: 'dm1' });
      const dm = new ChoiceStore(choiceTmp, 'dm:OWNER1');
      await dm.add({ ...choice, token: 'dm1', chatId: 'dm:OWNER1' });
      check('会话之间不串', (await dm.read()).length === 1 && (await store.read()).length === 1);
    } finally {
      await rm(choiceTmp, { recursive: true, force: true });
    }

    const withChoice = JSON.stringify(toolDefinitionsFor(OWNER_CAPS, undefined, { canAskChoice: true }));
    const withoutChoice = JSON.stringify(toolDefinitionsFor(OWNER_CAPS));
    check('主人档看得到 ask_choice', withChoice.includes('ask_choice'));
    check('没注入就不露这个工具', !withoutChoice.includes('ask_choice'));
    const ctxBase = { dataRoot: '/tmp', log: quietLogger } as unknown as Parameters<typeof executeTool>[2];
    check('没能力时拒绝出卡片', (await executeTool('ask_choice', '{"question":"q","options":["a","b"]}', ctxBase)).includes('发不了'));
    let asked: { question: string; options: unknown[] } | undefined;
    const ctxWith = {
      ...ctxBase,
      askChoice: async (input: { question: string; options: unknown[] }) => {
        asked = input;
        return '已发出';
      },
    } as unknown as Parameters<typeof executeTool>[2];
    check('字符串选项也能收', (await executeTool('ask_choice', '{"question":"q","options":["a","b"]}', ctxWith)) === '已发出');
    check('选项转成对象', Array.isArray(asked?.options) && (asked?.options[0] as { label?: string })?.label === 'a');
    check('只有一个选项时拒绝', (await executeTool('ask_choice', '{"question":"q","options":["a"]}', ctxWith)).includes('两个选项'));
    check('缺问题拒绝', (await executeTool('ask_choice', '{"options":["a","b"]}', ctxWith)).includes('question'));
    check('人格里写了按钮口径', PERSONA.includes('ask_choice') && PERSONA.includes('≤10 字'));
    check('人格里写了 markdown 链接写法', PERSONA.includes('[看这里](https://'));
  }

  console.log('\n[26] 指令面板（/v2/panels）');
  {
    const groupSpec = buildPanel('group');
    const directSpec = buildPanel('c2c');
    const groupProblems = validatePanel(groupSpec);
    check('群聊面板合规', groupProblems.length === 0, groupProblems.join('；'));
    check('单聊面板合规', validatePanel(directSpec).length === 0);
    check('群聊面板带 goal 与续跑', groupSpec.items.some((item) => item.name === 'goal resume'));
    check(
      '单聊面板不放 goal（单聊没有目标指令）',
      !directSpec.items.some((item) => item.name.startsWith('goal')),
    );
    check(
      '指令名不带斜杠（平台会规范掉）',
      groupSpec.items
        .filter((item) => item.type === 'command')
        .every((item) => !item.name.startsWith('/')),
    );
    check('面板元素不超过 20 个', groupSpec.items.length <= 20);
    check(
      '面板里的指令都被解析器认',
      groupSpec.items
        .filter((item) => item.type === 'command')
        .every((item) => matchCommand(item.name) !== undefined || matchGoalCommand(item.name) !== undefined),
    );
    check(
      '去掉斜杠也认（面板 name 会被 QQ 规范化）',
      matchGoalCommand('goal resume') === 'resume' && matchGoalCommand('/goal resume') === 'resume',
    );
    check(
      '超长名字被拦下',
      validatePanel({ ...groupSpec, items: [{ type: 'command', name: '/status-and-more' }] }).some((item) =>
        item.includes('名字超过'),
      ),
    );
    check(
      '非 https 链接被拦下',
      validatePanel({
        scope: 'group',
        remark: 'x',
        items: [{ type: 'link', name: '控制台', link: 'http://kei.st.mioc.cc' }],
      }).some((item) => item.includes('https://')),
    );
    check(
      '没实现的指令被拦下',
      validatePanel({ scope: 'group', remark: 'x', items: [{ type: 'command', name: '/deploy' }] }).some((item) =>
        item.includes('不是已实现的指令'),
      ),
    );
    check(
      '单聊里 /goal 不算已实现',
      validatePanel({ scope: 'c2c', remark: 'x', items: [{ type: 'command', name: '/goal' }] }).length > 0,
    );
    check('空面板被拦下', validatePanel({ scope: 'c2c', remark: 'x', items: [] }).length > 0);

    const fakePanelApi = (
      records: PanelRecord[] = [],
    ): { api: PanelApi; calls: string[] } => {
      const calls: string[] = [];
      let seq = 0;
      return {
        calls,
        api: {
          get: async <T,>(path: string) => {
            calls.push(`GET ${path}`);
            return { records } as unknown as T;
          },
          post: async <T,>(path: string, body?: unknown) => {
            calls.push(`POST ${path} ${JSON.stringify(body)}`);
            seq += 1;
            return { panel_id: `p_new${seq}` } as unknown as T;
          },
          put: async <T,>(path: string, body?: unknown) => {
            calls.push(`PUT ${path} ${JSON.stringify(body)}`);
            return {} as unknown as T;
          },
          delete: async <T,>(path: string) => {
            calls.push(`DELETE ${path}`);
            return {} as unknown as T;
          },
        },
      };
    };

    const fresh = fakePanelApi();
    const created = await ensurePanel(fresh.api, groupSpec, { targetType: 'specific', openids: ['G1'] });
    check('首次对账新建', created.action === 'created' && created.panelId === 'p_new1');
    check(
      '群聊按 group_openids 生效',
      fresh.calls.some((call) => call.startsWith('POST /v2/panels') && call.includes('"group_openids":["G1"]')),
    );

    const same = fakePanelApi([
      { panel_id: 'p_1', scope: 'group', target_type: 'specific', panel: { items: groupSpec.items, remark: PANEL_REMARK } },
    ]);
    const unchanged = await ensurePanel(same.api, groupSpec, { targetType: 'specific', openids: ['G1'] });
    check(
      '内容一致就不动接口',
      unchanged.action === 'unchanged' && !same.calls.some((call) => call.startsWith('PUT') || call.startsWith('POST')),
    );

    const slashed = await ensurePanel(
      fakePanelApi([
        {
          panel_id: 'p_1',
          scope: 'group',
          target_type: 'specific',
          panel: {
            items: groupSpec.items.map((item) =>
              item.type === 'command' ? { ...item, name: `/${item.name}` } : item,
            ),
            remark: PANEL_REMARK,
          },
        },
      ]).api,
      groupSpec,
      { targetType: 'specific', openids: ['G1'] },
    );
    check('线上带斜杠也算一致（不会每次都对账成更新）', slashed.action === 'unchanged');

    const changed = fakePanelApi([
      {
        panel_id: 'p_1',
        scope: 'group',
        target_type: 'specific',
        panel: { items: [{ type: 'command', name: '/status' }], remark: PANEL_REMARK },
      },
    ]);
    const updated = await ensurePanel(changed.api, groupSpec, { targetType: 'specific', openids: ['G1'] });
    check(
      '内容变了就地更新',
      updated.action === 'updated' && changed.calls.some((call) => call.startsWith('PUT /v2/panels/p_1')),
    );

    const scopeChanged = fakePanelApi([
      { panel_id: 'p_1', scope: 'group', target_type: 'all', panel: { items: groupSpec.items, remark: PANEL_REMARK } },
    ]);
    const recreated = await ensurePanel(scopeChanged.api, groupSpec, { targetType: 'specific', openids: ['G1'] });
    check(
      '范围变了删掉重建',
      recreated.action === 'recreated' &&
        recreated.replaced === 'p_1' &&
        scopeChanged.calls.some((call) => call.startsWith('DELETE /v2/panels/p_1')),
    );

    const foreign = fakePanelApi([
      { panel_id: 'p_9', scope: 'group', target_type: 'specific', panel: { items: [], remark: 'someone-else' } },
    ]);
    const kept = await ensurePanel(foreign.api, groupSpec, { targetType: 'specific', openids: ['G1'] });
    check(
      '别人的面板不碰',
      kept.action === 'created' && !foreign.calls.some((call) => call.includes('p_9')),
    );

    const direct = fakePanelApi();
    await ensurePanel(direct.api, directSpec, { targetType: 'specific', openids: ['OWNER1'] });
    check('单聊按 user_openids 生效', direct.calls.some((call) => call.includes('"user_openids":["OWNER1"]')));

    const noTarget = await ensurePanel(fakePanelApi().api, groupSpec, { targetType: 'specific' }).then(
      () => false,
      () => true,
    );
    check('specific 却没给对象直接报错', noTarget);
  }

  console.log('\n[27] 图文卡片（msg_type=8）');
  {
    const built = buildCard({
      title: `${'标题'.repeat(30)}\n第二行`,
      description: '说明'.repeat(150),
      url: 'https://github.com/mico-v/campus-nav-3d/pull/38',
      picUrl: 'https://avatars.githubusercontent.com/u/232133607',
    });
    const card = 'card' in built ? built.card : undefined;
    check('造得出 tuwen 卡片', card?.type === 'tuwen');
    check(
      '标题裁到 50 字以内且不留换行',
      (card?.content.title.length ?? 999) <= MAX_CARD_TITLE_CHARS && !(card?.content.title ?? '').includes('\n'),
    );
    check('说明裁到 200 字以内', (card?.content.description.length ?? 999) <= MAX_CARD_DESC_CHARS);
    check(
      '字段名按平台口径（pic_url 不是 picUrl）',
      card !== undefined &&
        typeof card.content.pic_url === 'string' &&
        card.content.url === 'https://github.com/mico-v/campus-nav-3d/pull/38',
    );
    check(
      'http 链接被拦下',
      'error' in buildCard({ title: 't', description: 'd', url: 'http://x.y', picUrl: 'https://x.y/p.png' }),
    );
    check(
      '超长链接被拦下',
      'error' in
        buildCard({
          title: 't',
          description: 'd',
          url: `https://x.y/${'a'.repeat(1100)}`,
          picUrl: 'https://x.y/p.png',
        }),
    );
    check(
      '缺标题/说明就整张不发',
      'error' in buildCard({ title: '  ', description: 'd', url: 'https://x.y', picUrl: 'https://x.y/p.png' }),
    );
    check('配图必须是 https', 'error' in buildCard({ title: 't', description: 'd', url: 'https://x.y', picUrl: '' }));
    check('回执行带标题与链接', card !== undefined && renderCardLine(card).includes('pull/38'));

    const withCard = JSON.stringify(toolDefinitionsFor(OWNER_CAPS, undefined, { canSendCard: true }));
    const withoutCard = JSON.stringify(toolDefinitionsFor(OWNER_CAPS));
    check('开发档看得到 send_card', withCard.includes('send_card'));
    check('没注入就不露 send_card', !withoutCard.includes('send_card'));

    const ctxCardBase = { dataRoot: '/tmp', log: quietLogger } as unknown as Parameters<typeof executeTool>[2];
    check(
      '没能力时拒绝发卡片',
      (await executeTool(
        'send_card',
        '{"title":"t","description":"d","url":"https://x.y","pic_url":"https://x.y/p.png"}',
        ctxCardBase,
      )).includes('发不了'),
    );
    let sent: { title: string; url: string } | undefined;
    const ctxCard = {
      ...ctxCardBase,
      sendCard: async (input: { title: string; url: string }) => {
        sent = input;
        return '已发出';
      },
    } as unknown as Parameters<typeof executeTool>[2];
    check(
      '合法参数发得出去',
      (await executeTool(
        'send_card',
        '{"title":"PR #38","description":"双模入口","url":"https://github.com/mico-v/campus-nav-3d/pull/38","pic_url":"https://x.y/p.png"}',
        ctxCard,
      )) === '已发出',
    );
    check('卡片内容原样交给发送层', sent?.title === 'PR #38' && (sent?.url ?? '').includes('pull/38'));
    sent = undefined;
    check(
      '非法链接不发',
      (await executeTool(
        'send_card',
        '{"title":"t","description":"d","url":"http://x.y","pic_url":"https://x.y/p.png"}',
        ctxCard,
      )).includes('https'),
    );
    check('非法链接时没调发送层', sent === undefined);
    check('人格里写了卡片口径', PERSONA.includes('send_card') && PERSONA.includes('≤200 字'));
  }

  console.log('\n[28] 派发闭环（裸评论升级成派工 + 探针等太久自查）');
  {
    const dispatch = routeIssueComment(['issues', 'comment', '--number', '30', '--body', '复核不通过，请只补校验']);
    check('CLI 发评论默认按派工算', dispatch.kind === 'dispatch' && dispatch.number === 30);
    check('派工正文自动补 @CodeBuddy', ensureBuddyMention('复核不通过') === '@CodeBuddy\n\n复核不通过');
    check('已经 @ 过就不重复补', ensureBuddyMention('@CodeBuddy\n\n复核不通过') === '@CodeBuddy\n\n复核不通过');
    const plain = routeIssueComment(['issues', 'comment', '-n', '33', '-b', 'note: 只留记录']);
    check('note: 前缀走普通评论', plain.kind === 'plain' && plain.number === 33 && plain.body === '只留记录');
    check('别的子命令不接管', routeIssueComment(['issues', 'list-issues']).kind === 'none');
    check('缺 body 不接管', routeIssueComment(['issues', 'comment', '--number', '30']).kind === 'none');

    let ranCli = false;
    const posted: Array<{ number: number; body: string; workMode: boolean }> = [];
    const ctxDispatch = {
      dataRoot: '/tmp',
      log: quietLogger,
      capabilities: OWNER_CAPS,
      cnb: {
        repo: 'mico-v/campus-nav-3d',
        commentIssue: async (number: number, body: string, workMode = false) => {
          posted.push({ number, body, workMode });
        },
      },
      cnbCli: {
        run: async () => {
          ranCli = true;
          return { code: 0, stdout: '', stderr: '' };
        },
      },
    } as unknown as Parameters<typeof executeTool>[2];
    const out = await executeTool(
      'cnb',
      JSON.stringify({ args: ['issues', 'comment', '--number', '30', '--body', '请只补连接表校验'] }),
      ctxDispatch,
    );
    check(
      '工具层把裸评论升级成派工',
      posted.length === 1 && posted[0]?.workMode === true && posted[0]?.number === 30,
    );
    check('升级后正文带 @CodeBuddy', (posted[0]?.body ?? '').includes('@CodeBuddy'));
    check('不再落到 CLI', !ranCli);
    check('返回值点名下一步', out.includes('goal_watch'));

    const waited = { issue: 30, sig: 's', since: new Date(Date.now() - 31 * 60_000).toISOString() };
    check('等 31 分钟触发自查', shouldSelfCheck(waited, 30 * 60_000));
    check(
      '等 5 分钟不打扰',
      !shouldSelfCheck({ ...waited, since: new Date(Date.now() - 5 * 60_000).toISOString() }, 30 * 60_000),
    );
    check('没挂探针不自查', !shouldSelfCheck(undefined, 30 * 60_000));
    check('0 关掉自查', !shouldSelfCheck(waited, 0));
    check('probeIdleMs 默认 30 分钟', readAgentConfig({}).goals.probeIdleMs === 30 * 60_000);
    check(
      'probeIdleMs 可用环境变量调',
      readAgentConfig({ AGENT_GOAL_PROBE_IDLE_MS: '600000' }).goals.probeIdleMs === 600_000,
    );
    check('0 可关掉自查', readAgentConfig({ AGENT_GOAL_PROBE_IDLE_MS: '0' }).goals.probeIdleMs === 0);
    const notice = selfCheckNotice(30, 31);
    check('自查单点名 work_mode 与 issue 号', notice.includes('work_mode') && notice.includes('#30'));
    check('自查单要求并行派工', notice.includes('并行'));
    check('工具描述里写了 work_mode 口径', JSON.stringify(toolDefinitionsFor(OWNER_CAPS)).includes('work_mode'));

    const waitingGoal = {
      id: 'g1',
      objective: 'o',
      criteria: ['c'],
      slices: [{ id: 's1', title: 't', status: 'blocked' as const }],
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      awaiting: { issue: 30, sig: 's', since: new Date(Date.now() - 26 * 60_000).toISOString() },
      budget: { rounds: 1, maxRounds: 12, startedAt: new Date().toISOString(), maxWallMs: 1 },
      log: [],
    };
    check('目标视图会写「在等 #N」', renderGoal(waitingGoal).includes('在等 #30'));
    check('目标视图带已等时长', renderGoal(waitingGoal).includes('已等 26 分钟'));
    check('简报也带已等时长', goalBrief(waitingGoal).includes('已等 26 分钟'));
  }

  console.log('\n[29] 轻本地：全量测试/构建交给 CI');
  {
    check('全量单测认得出', heavyLocalHint('npx vitest run') === '全量单测');
    check('带管道也认得出', heavyLocalHint('cd x && npx vitest run 2>&1 | tail -20') === '全量单测');
    check('定向用例放行', heavyLocalHint('npx vitest run tests/landing.test.ts') === undefined);
    check('-t 过滤放行', heavyLocalHint('npx vitest run -t landing') === undefined);
    check('全量构建认得出', heavyLocalHint('npm run build') === '全量构建/测试');
    check('普通命令不误伤', heavyLocalHint('git status --short') === undefined);
    check('搜 vitest 不误伤', heavyLocalHint('grep -rn vitest tests/ | head') === undefined);
    check('读文件不误伤', heavyLocalHint('sed -n 1,80p src/main.ts') === undefined);

    // 11-22 按段判：这四条都是 11-21 真实误伤过的写法（拦下后模型改用 force 重跑，白烧 25 分钟）
    check('src 下定向用例放行', heavyLocalHint('npx vitest run src/data/adapter.test.ts') === undefined);
    check('多个用例文件放行', heavyLocalHint('npx vitest run a.test.ts b.spec.ts --reporter=dot') === undefined);
    check('类型检查放行', heavyLocalHint('npx tsc --noEmit') === undefined);
    check('复合命令里的定向段不误伤', heavyLocalHint('cd x && npx tsc --noEmit; npx vitest run tests/a.test.ts') === undefined);
    check('复合命令里的全量段仍拦', heavyLocalHint('git status --short; npx vitest run') === '全量单测');
    check('看版本不算跑测试', heavyLocalHint('npx vitest --version') === undefined);
    check('全量构建仍拦', heavyLocalHint('npx vite build') === '全量构建');

    // 11-22 实测误伤：命令里出现 vitest 字样（只是看配置/搜关键字）被当成全量单测拦下
    check('看测试配置不误伤', heavyLocalHint('git show HEAD:vitest.config.ts') === undefined);
    check('git log 提到 vitest 不误伤', heavyLocalHint('git log --oneline -5; git show HEAD:vitest.config.ts') === undefined);
    check('搜 vitest 关键字不误伤', heavyLocalHint('git status -sb; grep -n vitest vitest.config.ts') === undefined);
    check('裸跑 vitest 仍拦', heavyLocalHint('cd x && vitest') === '全量单测');
    check('npx 跑 jest 仍拦', heavyLocalHint('npx jest') === '全量单测');

    // 原地 sleep 等 CI：11-19 到 11-21 共 31 条，光 sleep 就 48 分钟
    check('认得出 sleep 等 CI', waitLocalHint('sleep 240; gh pr checks 31') === 240);
    check('分钟单位换算', waitLocalHint('sleep 3m && gh run list') === 180);
    check('短 sleep 放行', waitLocalHint('sleep 5; gh pr checks 31') === undefined);
    check('不误伤别的命令', waitLocalHint('grep -n sleep src/a.ts') === undefined);

    // 复核参数：只要两行 PASS/FAIL，关思考 + 压 maxTokens（实测结论不变、快 2–4 倍、省 10 倍 completion）
    const rv = reviewOptions({ model: 'm', apiKey: 'k', baseUrl: 'http://x' });
    check('复核关思考', rv.disableThinking === true);
    check('复核压 maxTokens', rv.maxTokens === 300);
    check('复核短超时', (rv.timeoutMs ?? 0) <= 30_000);
    check('复核温度 0', rv.temperature === 0);
    check('复核用途标 review', rv.purpose === 'review');

    check('模式默认 block', parseHeavyMode(undefined) === 'block');
    check('模式认 warn', parseHeavyMode('warn') === 'warn');
    check('模式认 allow', parseHeavyMode('allow') === 'allow');
    check('写错当默认', parseHeavyMode('yes') === 'block');
    check('配置默认 block', readAgentConfig({}).policy.localHeavy === 'block');
    check('配置可改 allow', readAgentConfig({ AGENT_LOCAL_HEAVY: 'allow' }).policy.localHeavy === 'allow');

    let ran = false;
    const ctxHeavy = {
      dataRoot: '/tmp',
      log: quietLogger,
      capabilities: OWNER_CAPS,
      localHeavy: 'block' as const,
      workspace: { root: '/tmp', repoDir: '/tmp', home: '/tmp' },
      runCommand: async () => {
        ran = true;
        return { ok: true, code: 0, stdout: '', stderr: '', timedOut: false, truncated: false };
      },
    } as unknown as Parameters<typeof executeTool>[2];
    const blocked = await executeTool('run_command', JSON.stringify({ cmd: 'npx vitest run' }), ctxHeavy);
    check('本地全量单测被拦下', blocked.includes('不在本地跑'));
    check('拦下时指向 CI', blocked.includes('ci_status'));
    check('拦下时给出定向用例写法', blocked.includes('tests/xxx.test.ts'));
    check('拦下时提示 force 逃生口', blocked.includes('force'));
    check('拦下时没真去跑', !ran);
    check('run_command 暴露 force', JSON.stringify(toolDefinitionsFor(OWNER_CAPS)).includes('"force"'));
    check('工具描述写了不在本地跑全量', JSON.stringify(toolDefinitionsFor(OWNER_CAPS)).includes('CI 和 NPC 的活'));
    const allowed = await executeTool(
      'run_command',
      JSON.stringify({ cmd: 'npx vitest run tests/landing.test.ts' }),
      ctxHeavy,
    );
    check('定向用例不被拦', !allowed.includes('不在本地跑'));
    const slept = await executeTool(
      'run_command',
      JSON.stringify({ cmd: 'sleep 240; gh pr checks 31' }),
      ctxHeavy,
    );
    check('原地等被拦下', slept.includes('不在工具里原地等'));
    check('拦下时指向 goal_watch', slept.includes('goal_watch'));
    check('原地等没真去跑', !ran);
  }

  console.log('\n[30] 会话链续接（锚点丢了不整条重建）');
  {
    const lines = [
      { messageId: 'm1', timestamp: 1000, text: 'a' },
      { messageId: 'm2', timestamp: 2000, text: 'b' },
      { messageId: 'm3', timestamp: 3000, text: 'c' },
    ];
    const ids = (picked: Array<{ messageId?: string }>): string => picked.map((line) => line.messageId).join(',');
    check('按 id 精确续', ids(linesAfter(lines, { lastMessageId: 'm1' })) === 'm2,m3');
    check('锚点是最后一条时没新行', linesAfter(lines, { lastMessageId: 'm3' }).length === 0);
    check('窗口挤掉锚点按时间戳续', ids(linesAfter(lines, { lastMessageId: 'gone', lastAt: 1500 })) === 'm2,m3');
    check('挤掉锚点也不返回 undefined', Array.isArray(linesAfter(lines, { lastMessageId: 'gone' })));
    check('两个锚点都没有当没新行', linesAfter(lines, {}).length === 0);
    check('私聊空缓冲不重建', linesAfter([], { lastMessageId: 'm3', lastAt: 3000 }).length === 0);
    check('折过一轮不重复折', linesAfter(lines, { lastAt: 3000 }).length === 0);
    check('时间戳相同的旧行不重折', ids(linesAfter(lines, { lastAt: 2000 })) === 'm3');
  }

  console.log('\n[31] 回合留痕（重启打断后不哑火）');
  {
    const inflightTmp = await mkdtemp(path.join(tmpdir(), 'inflight-'));
    try {
      const chatId = 'FD8B6A9A576D123B17C4489367C019CB';
      await markInflight(inflightTmp, { chatId, startedAt: '2026-11-22T00:06:36.000Z', kind: 'chat' });
      const marks = await listInflight(inflightTmp);
      check('标记落盘', marks.length === 1 && marks[0]?.chatId === chatId);
      check('标记带开始时间', marks[0]?.startedAt === '2026-11-22T00:06:36.000Z');
      check('标记带触发方', marks[0]?.kind === 'chat');
      check('残留能读出人看的时间', describeInterrupted(marks[0]!) !== '上一轮');
      await clearInflight(inflightTmp, chatId);
      check('正常收尾后标记清掉', (await listInflight(inflightTmp)).length === 0);
      await writeFile(path.join(inflightDir(inflightTmp), 'broken.json'), '{不是 json');
      check('坏标记不拖累巡检', (await listInflight(inflightTmp)).length === 0);
      check('坏标记顺手删掉', !existsSync(path.join(inflightDir(inflightTmp), 'broken.json')));
    } finally {
      await rm(inflightTmp, { recursive: true, force: true });
    }

    // done + 全部收口：resume 不再复活，避免把已经交付的目标重新拉起来烧额度
    const closedTmp = await mkdtemp(path.join(tmpdir(), 'goals-closed-'));
    try {
      const store = new GoalStore(closedTmp, 'G9');
      await store.create({ objective: '全收口', criteria: ['跑完'], slices: ['一片'] }, { maxRounds: 3, maxWallMs: 3_600_000 });
      await store.step('s1', 'done', { note: '验过' });
      await store.finish('全部交付');
      check('全收口后 resume 不复活', (await store.resume()).includes('已经收尾'));
      check('全收口后仍是 done', (await store.read())?.status === 'done');
    } finally {
      await rm(closedTmp, { recursive: true, force: true });
    }
  }

  console.log(failures === 0 ? '\n全部通过\n' : `\n${failures} 项失败\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
