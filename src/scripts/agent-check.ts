/**
 * 聊天 agent 离线自检：不连 QQ、不调真实模型。
 *
 *   pnpm agent:check
 *
 * 覆盖：@ 判定、群聊缓冲、记忆读写、以及「@ 才调模型」这条主链路。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatAgent, isBotMentioned, readAgentConfig, splitReply } from '../agent/index.js';
import type { ChatMessage } from '../agent/llm.js';
import { GroupBuffer, renderBuffer } from '../agent/context.js';
import { GroupMemory } from '../agent/memory.js';
import { PERSONA } from '../agent/persona.js';
import { cleanQQText } from '../agent/text.js';
import { matchCommand, renderStatus } from '../agent/commands.js';
import { DigestEngine, DRIFT_THRESHOLD, topicDrift } from '../agent/digest.js';
import { MessageIndex, renderHits } from '../agent/search.js';
import { executeTool, expandQuery } from '../agent/tools.js';
import { digestAttachments, loadImageParts, prepareImage } from '../agent/vision.js';
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

  console.log('\n[1.5] 主人模式');
  {
    const ownerConfig = readAgentConfig({
      AGENT_BOT_OPENIDS: BOT_OPENID,
      AGENT_BOT_USERNAMES: 'Kei',
      AGENT_GROUPS: GROUP,
      AGENT_TOOLS: 'false',
      AGENT_OWNER_OPENIDS: MEMBER_OPENID,
    } as NodeJS.ProcessEnv);

    let captured: { system: string; opts: Record<string, unknown> } | undefined;
    const agent = new ChatAgent(ownerConfig, quietLogger, async (messages, opts) => {
      captured = {
        system: typeof messages[0]?.content === 'string' ? messages[0].content : '',
        opts: opts as unknown as Record<string, unknown>,
      };
      return '第一点…\n第二点…';
    });
    await agent.handle(
      makeMessage({ mentions: [{ member_openid: BOT_OPENID }] }),
      { replyText: async () => {} } as unknown as Bot,
    );
    check('主人模式注入了「完整回答」', captured?.system.includes('回答要完整') === true);
    check('主人模式覆盖长度硬规则', captured?.system.includes('覆盖上面「硬规则」') === true);
    check('主人模式打开思考', captured?.opts.disableThinking === false);
    check('主人模式放宽超时', (captured?.opts.timeoutMs as number) >= 60_000);

    let normalSystem = '';
    const normalAgent = new ChatAgent(ownerConfig, quietLogger, async (messages) => {
      normalSystem = typeof messages[0]?.content === 'string' ? messages[0].content : '';
      return '嗯';
    });
    await normalAgent.handle(
      makeMessage({ senderId: 'someone-else', senderName: '路人', mentions: [{ member_openid: BOT_OPENID }] }),
      { replyText: async () => {} } as unknown as Bot,
    );
    check('非主人不注入主人模式', !normalSystem.includes('回答要完整'));

    const long = ['第一段'.repeat(60), '第二段'.repeat(60), '第三段'.repeat(60)].join('\n\n');
    const ownerChunks = splitReply(long, 3000, 4, true);
    check('主人长回复不按空行炸成多条', ownerChunks.length <= 2, `实际 ${ownerChunks.length} 条`);
    check('主人单条不超长', ownerChunks.every((c) => c.length <= 3000), ownerChunks.map((c) => c.length).join(','));
    check('群聊仍按空行分条', splitReply(long).length >= 2);
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
    check('背景用完后被清空', !second.includes('没人叫你的话1'));

    console.log('\n[5] 长回复分片');
    check('短回复不切', splitReply('诶 累就早点歇').length === 1);
    check('空行切成两条', splitReply('第一段\n\n第二段').length === 2);
    check('单换行不切', splitReply('第一行\n第二行').length === 1);
    check('多个空行只切一次', splitReply('甲\n\n\n\n乙').length === 2);
    check('空行分段内容正确', splitReply('甲\n\n乙')[1] === '乙', JSON.stringify(splitReply('甲\n\n乙')));
    check('超过上限会合并', splitReply('一\n\n二\n\n三\n\n四\n\n五').length === 3);
    const long = '第一段内容'.repeat(200) + '\n\n' + '第二段内容'.repeat(200);
    const parts = splitReply(long);
    check('长回复被切开', parts.length >= 2, `实际 ${parts.length}`);
    check('每片不超限', parts.every((p) => p.length <= 700), `最长 ${Math.max(...parts.map((p) => p.length))}`);
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
    const base = Date.parse('2026-10-20T20:00:00+08:00');
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

  console.log(failures === 0 ? '\n全部通过\n' : `\n${failures} 项失败\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
