/**
 * 聊天 agent 离线自检：不连 QQ、不调真实模型。
 *
 *   pnpm agent:check
 *
 * 覆盖：@ 判定、群聊缓冲、记忆读写、以及「@ 才调模型」这条主链路。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatAgent, isBotMentioned, readAgentConfig, splitReply } from '../agent/index.js';
import type { ChatMessage } from '../agent/llm.js';
import { GroupBuffer } from '../agent/context.js';
import { GroupMemory } from '../agent/memory.js';
import { PERSONA } from '../agent/persona.js';
import { cleanQQText } from '../agent/text.js';
import { buildRecord, summarize } from '../agent/telemetry.js';
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
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\n全部通过\n' : `\n${failures} 项失败\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
