/**
 * 给模型用的工具。
 *
 * 设计原则：只读、快、返回紧凑文本。模型看不到文件系统，这里就是它的眼睛。
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppLogger } from '../logger.js';
import type { ChatMessage, LlmOptions } from './llm.js';
import { MessageIndex, renderHits } from './search.js';
import { renderHits as renderWebHits, searchWeb } from './web.js';
import { heavyLocalHint, renderRunResult, runCommand, type HeavyMode } from './exec.js';
import type { Capabilities, Tier } from './policy.js';
import { isKind, isStatus, type RecordStore } from './records.js';
import { isSliceStatus, renderGoal, type Goal, type GoalSlice, type GoalStore } from './goals.js';
import { filterToolsForKind, isGoalKind, type GoalKind } from './kinds.js';
import { renderIssue, renderIssues, renderPulls, type CnbClient } from './cnb.js';
import {
  checkCnbArgs,
  ensureBuddyMention,
  listCnbGuide,
  readCnbGuide,
  renderCnbRun,
  routeIssueComment,
  searchCnbGuide,
  type CnbCli,
} from './cnbcli.js';
import type { Workspace } from './workspace.js';
import { MAX_CHOICE_OPTIONS, MAX_LABEL_CHARS, type ChoiceOption } from './choices.js';
import { MAX_CARD_DESC_CHARS, MAX_CARD_TITLE_CHARS, buildCard, type CardInput } from './cards.js';

export interface ToolContext {
  dataRoot: string;
  /** 当前会话（群 openid）；搜历史时默认只看这个群 */
  groupId?: string;
  log: AppLogger;
  /** 用来做同义扩展；没有就退回纯子串匹配 */
  complete?: (messages: ChatMessage[], opts: LlmOptions) => Promise<string>;
  llm?: LlmOptions;
  /** 当前说话人的权限档位与能力集，决定能调哪些工具。 */
  tier?: Tier;
  capabilities?: Capabilities;
  /** 命令黑名单（正则源）；空 = 全放行。 */
  cmdBlacklist?: string[];
  /** 全量测试/构建本地还跑不跑：block（默认）/ warn / allow。 */
  localHeavy?: HeavyMode;
  /** 代码工作区；没配就没有代码类工具。 */
  workspace?: Workspace;
  /** 这个群的记录本。 */
  records?: RecordStore;
  /** 这个群的持续目标（长活的切片账本）。 */
  goals?: GoalStore;
  /** CNB 接口：issue 协作通道。 */
  cnb?: CnbClient;
  /** CNB 官方 CLI：全模块命令 + 官方 skill 文档。 */
  cnbCli?: CnbCli;
  /** 说话人昵称，记条目时当 by。 */
  speaker?: string;
  /**
   * 独立复核：标 done 之前过一道。返回 pass=false 就把切片退回 review。
   * 由 index.ts 接上（空上下文 + 只喂判据与证据）。
   */
  reviewSlice?: (input: {
    goal: Goal;
    slice: GoalSlice;
    evidence?: string;
  }) => Promise<{ pass: boolean; note: string }>;
  /**
   * 发一张选项卡片（按钮）。只在主人那一档注入；没有它就等于没这个工具。
   * 返回给模型看的回执（已发出 / 为什么没发）。
   */
  askChoice?: (input: { question: string; options: ChoiceOption[] }) => Promise<string>;
  /**
   * 发一张图文卡片（标题 + 说明 + 链接 + 配图）。只在开发档以上注入；
   * 没有它就等于没这个工具。返回给模型看的回执。
   */
  sendCard?: (input: CardInput) => Promise<string>;
}

/** 聊天类工具：任何身份都能用。 */
const CHAT_TOOLS: unknown[] = [
  {
    type: 'function',
    function: {
      name: 'search_messages',
      description:
        '在群聊历史记录里检索消息。当群友提到过去发生的事、某句话、某个梗，或者你记不清时，用它查证，不要凭印象猜。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，多个词用空格分隔（需同时出现）' },
          sender: { type: 'string', description: '只看某个人说的，填昵称' },
          days: { type: 'number', description: '只搜最近多少天，不填表示全部历史' },
          limit: { type: 'number', description: '返回条数，默认 8，最大 20' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '联网搜索。问到今天的事、新闻、版本号、价格、比赛结果、某个人最近的动态这类你不可能知道的信息时，先搜再答，不要凭记忆编。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词，像人一样写，别堆关键词' },
          limit: { type: 'number', description: '返回条数，默认 5，最多 8' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'member_profile',
      description: '查某个群友的长期档案：性格、口癖、常聊话题。当你需要确认「他是谁」「之前记过什么」时用它。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '群友昵称，可以是部分匹配' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_topics',
      description:
        '在「话题索引」里检索：每轮群聊归档时生成的话题条目（标题+关键词+一句话）。问「之前聊过什么」「有没有聊过 X」时先查这里，比逐条翻消息快。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '话题关键词，留空则返回最近所有话题' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recent_digests',
      description: '读最近的对话摘要：每一段群聊聊了什么、气氛如何。适合回答「昨天群里聊了啥」。',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '最近几天，默认 7' },
          limit: { type: 'number', description: '最多几条，默认 5' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'chat_stats',
      description: '群聊整体统计：消息总数、时间跨度、谁说话最多。适合回答「群里最近活跃吗」这类问题。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

/** 记录本：查。任何身份都能查本群的条目。 */
const RECORD_QUERY_TOOLS: unknown[] = [
  {
    type: 'function',
    function: {
      name: 'memory_query',
      description:
        '查这个群的记录本：决策、任务、里程碑、风险。问「之前定了什么」「还有哪些没做」先查这里，不要凭印象答。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '关键词，留空就是列最近的条目' },
          kind: { type: 'string', enum: ['decision', 'task', 'milestone', 'risk', 'note'] },
          status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked', 'dropped'] },
          limit: { type: 'number', description: '默认 12 条' },
        },
        required: [],
      },
    },
  },
];

/** 记录本：写。开发成员与主人才有。 */
const RECORD_WRITE_TOOLS: unknown[] = [
  {
    type: 'function',
    function: {
      name: 'memory_note',
      description:
        '把一个结论落进记录本：定下的事用 decision，要做的事用 task，卡住的用 risk，完成了的用 milestone。只追加不改写，不要记流水账。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['decision', 'task', 'milestone', 'risk', 'note'] },
          title: { type: 'string', description: '一句话说清是什么事' },
          body: { type: 'string', description: '补充：范围、依据、验收标准' },
          status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked', 'dropped'] },
          owner: { type: 'string', description: '谁负责（昵称或角色）' },
          tags: { type: 'array', items: { type: 'string' } },
          refs: { type: 'array', items: { type: 'string' }, description: '出处：PR、issue、commit 链接' },
        },
        required: ['kind', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_status',
      description: '改一条记录的状态（todo / doing / done / blocked / dropped）。id 用 memory_query 看到的编号。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '条目编号，如 3f2a 或完整 id' },
          status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked', 'dropped'] },
        },
        required: ['id', 'status'],
      },
    },
  },
];

/** 持续目标：开发成员与主人。长活写成 JSON，每轮推一片。 */
const GOAL_TOOLS: unknown[] = [
  {
    type: 'function',
    function: {
      name: 'goal_create',
      description:
        '把一件跨多轮的长活立成目标：一句正文 + 可判定的完成判据 + 3~5 个切片。立完就能自动续跑，每轮推一片。写不出判据就别立 —— 那说明还没想清楚。',
      parameters: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: '一句话说清要交付什么（不超过 4000 字）' },
          criteria: {
            type: 'array',
            items: { type: 'string' },
            description:
              '完成判据，要能验证：`npx vitest run` 全绿 / PR 合并 / 页面能打开。每片自己能被验：别写「所有 PR 都合了」这种把切片锁死的条件，否则单片的复核永远过不了。',
          },
          slices: {
            type: 'array',
            items: { type: 'string' },
            description: '切片（一片一个 PR），按依赖顺序，最多 12 片；互不碰目录的片标成可并行，立完一次派 2~3 个',
          },
          kind: {
            type: 'string',
            enum: ['code', 'research', 'ops', 'review'],
            description: '活儿的类型：code 写代码 / research 调研 / ops 运维巡检 / review 评审（只读），默认 code',
          },
        },
        required: ['objective', 'criteria', 'slices'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'goal_status',
      description: '看当前目标：正文、判据、各片状态、下一片、自动续跑用了几轮。回答「做到哪了」先看它。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'goal_step',
      description:
        '改一片的进度（todo / doing / review / done / blocked / dropped），顺手记一句结论和出处。做完一片就在同一轮里标 done，别攒着。',
      parameters: {
        type: 'object',
        properties: {
          slice: { type: 'string', description: '切片编号（s1）或标题片段；留空 = 当前该推的那片' },
          status: { type: 'string', enum: ['todo', 'doing', 'review', 'done', 'blocked', 'dropped'] },
          note: { type: 'string', description: '一句话：改了什么、验了什么' },
          ref: { type: 'string', description: '出处：issue 号、PR 链接、commit' },
          evidence: {
            type: 'string',
            description: '标 done 时的证据：测试输出、CI 结论、页面 hash、PR 链接（复核只认这个）',
          },
        },
        required: ['status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'goal_watch',
      description:
        '派工之后挂探针：盯这个 issue，NPC 有新评论 / 开了 PR / 关了 issue 就叫醒你继续；没变化就不开口，也不烧回合。盯到一个变化就自动解除，要接着等就再挂一次。等够 30 分钟（AGENT_GOAL_PROBE_IDLE_MS）还没动静会自动叫醒自查：核实派工有没有真叫醒 NPC，顺便看别的片能不能先起。',
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'number', description: 'CNB issue 号' },
          note: { type: 'string', description: '在等它交付什么（一句话）' },
        },
        required: ['issue'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'goal_finish',
      description: '目标收尾：所有切片都验过了才调。recap 写清最终交付了什么、判据怎么验的。',
      parameters: {
        type: 'object',
        properties: { recap: { type: 'string', description: '交付结论与验证方式' } },
        required: ['recap'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'goal_block',
      description: '卡住了就明说：缺权限、等主人拍板、等 NPC 回话。写清卡在谁身上，自动续跑会停。',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: '卡点 + 卡在谁身上' } },
        required: ['reason'],
      },
    },
  },
];

/** CNB issue 协作通道：能写仓库的角色才看得到。 */
const CNB_TOOLS: unknown[] = [
  {
    type: 'function',
    function: {
      name: 'cnb_issue_list',
      description: '列 CNB 仓库的 issue（默认 open）。开工前先看有没有现成的切片，别重复开。',
      parameters: {
        type: 'object',
        properties: { state: { type: 'string', enum: ['open', 'closed'] } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cnb_issue_get',
      description: '读一条 issue 的正文（切片的目标 / 范围 / 验收 / 风险四段）。',
      parameters: {
        type: 'object',
        properties: { number: { type: 'number' } },
        required: ['number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cnb_issue_create',
      description:
        '按切片模板开 issue：正文四段 —— 目标（一句话）、范围（可改目录 + 明确不动什么）、验收（可粘贴的命令与期望）、风险（回滚与依赖）。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '切片编号 + 一句话' },
          body: { type: 'string', description: '四段正文' },
        },
        required: ['title', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cnb_issue_dispatch',
      description:
        '在 issue 里发派工评论并带 work_mode + @CodeBuddy，让 NPC/CodeBuddy 下场写代码、推分支、开 PR。评论要写清分支名、可改目录、自测命令、PR 标题前缀。复核不通过要它重交，也走这个工具（别用 cnb 裸发评论）。能并行的片一次派 2~3 个，别串着等。',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number' },
          comment: { type: 'string', description: '派工说明（不包含 @，会自动带上 @CodeBuddy）' },
        },
        required: ['number', 'comment'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cnb_issue_close',
      description: '关 issue（复核通过、PR 合并之后）。可以顺手贴一句结论。',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number' },
          comment: { type: 'string', description: '收尾结论，可留空' },
        },
        required: ['number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cnb_pull_list',
      description: '列 CNB 的 PR。派工后看 PR 出来没有、合没合。',
      parameters: {
        type: 'object',
        properties: { state: { type: 'string', enum: ['open', 'closed', 'all'] } },
      },
    },
  },
];

/** CNB 官方 skill 文档：只读，任何能读仓库的身份都能查。 */
const CNB_GUIDE_TOOLS: unknown[] = [
  {
    type: 'function',
    function: {
      name: 'cnb_guide',
      description:
        '查 CNB 官方 skill 文档（cnb-api / cnb-pipeline / cnb-code-review / cnb-upload-attachment / cnb-docs / cnb-repo-knowledge-base / cnb-tapd-resource-fetcher / cnb-version 等）。命令名、参数、流水线字段、评审口径都先查这里，别靠猜。不带参数列技能；给 name 读正文；name + path 读参考文件；query 关键词全库检索。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '技能名，例如 cnb-api、cnb-pipeline' },
          path: { type: 'string', description: '技能目录下的参考文件，例如 references/syntax-reference.md' },
          query: { type: 'string', description: '关键词，全库检索用' },
        },
      },
    },
  },
];

/** CNB 官方 CLI：全模块命令（写仓库的身份才给）。 */
const CNB_CLI_TOOLS: unknown[] = [
  {
    type: 'function',
    function: {
      name: 'cnb',
      description: [
        '跑 CNB 官方 CLI（`cnb <module> <tool>`，argv 数组、不经 shell）。仓库固定为当前项目，不用传 --repo。',
        '常用：["issues","list-issues","--state","open"]、["issues","get","--number","24"]、["pulls","get","--number","37"]、["pulls","list-files","--number","37"]、["pulls","check-status","--number","37"]、["pulls","get-ci-logs","--number","37"]、["pulls","submit-review","--number","37","--event","approve","--body","…"]、["build","…"]、["assets","…"]、["knowledge-base","…"]。',
        '发评论注意：["issues","comment"] 会按派工口径自动补 @CodeBuddy + work_mode（裸评论叫不醒 NPC）；只要普通记录就在 body 前写 note: 前缀。',
        '不确定命令或参数就先 cnb_guide（name=cnb-api / cnb-pipeline / cnb-code-review）查官方口径。',
        '注意：CLI 对 HTTP 404 也退出 0，结论看输出里的 status / errcode。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'argv 数组，例如 ["issues","get","--number","24"]',
          },
          timeout_ms: { type: 'number', description: '超时，默认 60000，上限 180000' },
        },
        required: ['args'],
      },
    },
  },
];

/** 读仓库：开发成员与主人。 */
const REPO_READ_TOOLS: unknown[] = [
  {
    type: 'function',
    function: {
      name: 'repo_status',
      description: '看主仓库现在什么状态：分支、未提交改动、最近几次提交。回答「改到哪了」「有没有脏文件」先跑它。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ci_status',
      description: '看 GitHub Actions 最近几次运行结果（分支、结论、提交信息）。回答「CI 过了吗」用它。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: '看几次，默认 3' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列工作区里的目录。路径都是相对工作区的，比如 `campus-nav-3d/src`。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径，默认仓库根目录' },
          depth: { type: 'number', description: '展开几层，默认 2' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读工作区里的一个文本文件。大文件会截断，需要定位就用 grep_files。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对路径' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_files',
      description: '在工作区里按正则搜文本，返回文件名、行号、那一行。找函数、找配置、找关键词都用它。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: '搜哪个子目录，默认整个工作区' },
          limit: { type: 'number', description: '最多多少条，默认 40' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        '在工作区里跑一条命令。黑名单模式：npm / git / gh / node 等常规开发命令都放行，cwd 锁在工作区内，超时默认 120 秒。' +
        '**全量测试与构建（npx vitest run、npm run build、tsc --noEmit）默认被拦**：那是 CI 和 NPC 的活，本机跑一次几分钟、输出还吃 token。' +
        '验收看 PR 里 NPC 贴的输出 + ci_status / cnb pulls check-status；要复现只跑定向用例（npx vitest run tests/xxx.test.ts）。确实必须本地跑就带 force。',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: '命令，一句一条，可以带管道' },
          cwd: { type: 'string', description: '相对工作区的目录，默认主仓库' },
          timeout_ms: { type: 'number', description: '超时，默认 120000，最大 300000' },
          force: {
            type: 'boolean',
            description: '确认要在本地跑全量测试/构建（比如 CI 挂了要复现），默认 false',
          },
        },
        required: ['cmd'],
      },
    },
  },
];

/** 写仓库：只有主人。 */
const REPO_WRITE_TOOLS: unknown[] = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '在工作区里写一个文本文件（整个覆盖）。改完代码要自己跑测试，再说明改了什么。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
];

/** 选项卡片：只给主人档（要不要让人拍板，本来也只有主人这一层有意义）。 */
const CHOICE_TOOLS: unknown[] = [
  {
    type: 'function',
    function: {
      name: 'ask_choice',
      description:
        '要主人拍板时发一张选项卡片（按钮），2~5 个选项。用在「方案 A 还是 B」「先做哪一块」这类必须有人定的事；能自己判断的别问。发完本轮只回一句很短的话，不要重复选项内容。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '一句话问题，不超过 40 字' },
          options: {
            type: 'array',
            description: `2~${MAX_CHOICE_OPTIONS} 个选项`,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: `按钮上的字，不超过 ${MAX_LABEL_CHARS} 字` },
                detail: { type: 'string', description: '补充说明，写进正文，选填' },
              },
              required: ['label'],
            },
          },
        },
        required: ['question', 'options'],
      },
    },
  },
];

/** 图文卡片：开发档以上才注入（内容类输出，guest 用不上）。 */
const CARD_TOOLS: unknown[] = [
  {
    type: 'function',
    function: {
      name: 'send_card',
      description:
        '把一件成组的信息发成图文卡片（标题 + 一句说明 + 链接 + 配图）：PR / issue 交付、构建结果、方案对比这类内容，卡片比一长串文字好读。配图必须是平台能转存的 https 图片：国内可达的 CDN（如 q1.qlogo.cn）行，GitHub 头像 / raw 链接会报「图片转存失败」。发完本轮补一句结论就行，不要把卡片内容再贴一遍。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: `标题，1~${MAX_CARD_TITLE_CHARS} 字` },
          description: { type: 'string', description: `一句说明，1~${MAX_CARD_DESC_CHARS} 字` },
          url: { type: 'string', description: '点击跳转的 https 链接（PR / issue / 文档）' },
          pic_url: { type: 'string', description: '配图的 https 链接' },
        },
        required: ['title', 'description', 'url', 'pic_url'],
      },
    },
  },
];

/** 按能力集挑工具：模型看不到它用不了的工具，就不会去试。 */
export function toolDefinitionsFor(
  caps: Capabilities,
  kind?: GoalKind,
  extra: { canAskChoice?: boolean; canSendCard?: boolean } = {},
): unknown[] {
  const tools: unknown[] = [...CHAT_TOOLS, ...RECORD_QUERY_TOOLS];
  if (extra.canAskChoice) {
    tools.push(...CHOICE_TOOLS);
  }
  if (extra.canSendCard) {
    tools.push(...CARD_TOOLS);
  }
  if (caps.repoRead) {
    tools.push(...REPO_READ_TOOLS, ...CNB_GUIDE_TOOLS);
  }
  if (caps.memoryWrite) {
    tools.push(...RECORD_WRITE_TOOLS, ...GOAL_TOOLS);
  }
  if (caps.repoWrite) {
    tools.push(...REPO_WRITE_TOOLS, ...CNB_TOOLS, ...CNB_CLI_TOOLS);
  }
  // 目标类型的能力包：code 不设白名单（全部给），调研/运维/评审按需收窄
  return filterToolsForKind(tools, kind);
}

/** 兼容旧引用：没给能力集时就是聊天工具。 */
export const TOOL_DEFINITIONS: unknown[] = toolDefinitionsFor({
  chat: true,
  repoRead: false,
  exec: false,
  repoWrite: false,
  memoryWrite: false,
});

/** 索引按 dataRoot 复用，避免每次检索都重新解析 JSONL。 */
const indexes = new Map<string, MessageIndex>();

function indexFor(dataRoot: string): MessageIndex {
  let index = indexes.get(dataRoot);
  if (!index) {
    index = new MessageIndex(dataRoot);
    indexes.set(dataRoot, index);
  }
  return index;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 选项宽容解析：模型有时给字符串数组，有时给 {label, detail}。
 * 缺 label 的直接丢，超过上限的截断 —— 按钮上写不下第 6 个。
 */
function parseChoiceOptions(raw: unknown): ChoiceOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ChoiceOption[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const label = item.trim();
      if (label) {
        out.push({ label });
      }
      continue;
    }
    if (!item || typeof item !== 'object') {
      continue;
    }
    const rec = item as Record<string, unknown>;
    const label = asString(rec.label ?? rec.text ?? rec.title).trim();
    if (!label) {
      continue;
    }
    const detail = asString(rec.detail ?? rec.description ?? rec.note).trim();
    out.push(detail ? { label, detail } : { label });
  }
  return out.slice(0, MAX_CHOICE_OPTIONS);
}

/** 字符串数组参数：模型偶尔会塞一个字符串进来，统一成数组。 */
function arrayOf(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value
      .split(/[,，、\s]+/)
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return undefined;
}

async function memberProfile(ctx: ToolContext, name: string): Promise<string> {
  const groups = existsSync(path.join(ctx.dataRoot, 'memory'))
    ? await readdir(path.join(ctx.dataRoot, 'memory'))
    : [];
  const wanted = name.trim().toLowerCase();
  if (!wanted) {
    return '需要提供昵称。';
  }

  const matches: Array<{ name: string; body: string }> = [];
  for (const group of groups) {
    const dir = path.join(ctx.dataRoot, 'memory', group, 'members');
    if (!existsSync(dir)) {
      continue;
    }
    for (const file of await readdir(dir)) {
      if (!file.endsWith('.md')) {
        continue;
      }
      const body = await readFile(path.join(dir, file), 'utf8');
      const title = body.split('\n')[0]?.replace(/^#\s*/, '').trim() ?? '';
      if (title.toLowerCase().includes(wanted) || wanted.includes(title.toLowerCase())) {
        matches.push({ name: title, body });
      }
    }
  }

  if (matches.length === 0) {
    return `没有找到「${name}」的档案 —— 你可能还没记住这个人，直接说不熟就行，别编。`;
  }
  return matches
    .slice(0, 2)
    .map((m) => m.body.trim().slice(0, 900))
    .join('\n\n---\n\n');
}

async function chatStats(ctx: ToolContext): Promise<string> {
  const index = indexFor(ctx.dataRoot);
  const total = await index.size();
  if (total === 0) {
    return '还没有聊天记录。';
  }
  // 借 search 的空关键词走一遍全量太贵，这里只给规模和最近活跃度
  const recent = await index.search({ query: '', days: 7, limit: 20 });
  return [
    `消息总数：${total} 条`,
    `最近 7 天抽样：${recent.length > 0 ? '有活动' : '很安静'}`,
    recent.length > 0 ? `最近的活跃发言者：${[...new Set(recent.map((r) => r.sender))].slice(0, 5).join('、')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}


interface TopicEntry {
  title: string;
  keywords: string[];
  summary?: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

interface DigestEntry {
  day: string;
  from: string;
  to: string;
  count: number;
  participants: string[];
  summary: string;
  topics?: Array<{ title: string }>;
}

/** 列出可用的摘要目录（指定群，或全部群）。 */
async function digestDirs(ctx: ToolContext): Promise<string[]> {
  const memory = path.join(ctx.dataRoot, 'memory');
  if (!existsSync(memory)) {
    return [];
  }
  const groups = ctx.groupId ? [ctx.groupId] : await readdir(memory);
  const dirs: string[] = [];
  for (const group of groups) {
    const dir = path.join(memory, group, 'digest');
    if (existsSync(dir)) {
      dirs.push(dir);
    }
  }
  return dirs;
}

async function searchTopics(ctx: ToolContext, query: string): Promise<string> {
  const dirs = await digestDirs(ctx);
  const wanted = query.trim().toLowerCase();
  const hits: TopicEntry[] = [];

  for (const dir of dirs) {
    const file = path.join(dir, 'topics.json');
    if (!existsSync(file)) {
      continue;
    }
    let list: TopicEntry[] = [];
    try {
      list = JSON.parse(await readFile(file, 'utf8')) as TopicEntry[];
    } catch {
      continue;
    }
    for (const topic of list) {
      if (!wanted) {
        hits.push(topic);
        continue;
      }
      const haystack = `${topic.title} ${topic.keywords.join(' ')} ${topic.summary ?? ''}`.toLowerCase();
      if (haystack.includes(wanted)) {
        hits.push(topic);
      }
    }
  }

  if (hits.length === 0) {
    return wanted ? '话题索引里没有匹配的条目。' : '还没有任何话题归档。';
  }
  hits.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return hits
    .slice(0, 10)
    .map((t) => {
      const span = `${t.firstAt.slice(5, 10)}~${t.lastAt.slice(5, 10)}`;
      const kw = t.keywords.length > 0 ? ` · 关键词 ${t.keywords.join('、')}` : '';
      return `「${t.title}」${t.count} 次 · ${span}${kw}${t.summary ? ` · ${t.summary}` : ''}`;
    })
    .join('\n');
}

async function recentDigests(ctx: ToolContext, days: number, limit: number): Promise<string> {
  const dirs = await digestDirs(ctx);
  const since = Date.now() - Math.max(1, days) * 86_400_000;
  const rows: DigestEntry[] = [];

  for (const dir of dirs) {
    const file = path.join(dir, 'records.jsonl');
    if (!existsSync(file)) {
      continue;
    }
    const raw = await readFile(file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = JSON.parse(line) as DigestEntry;
        if (Date.parse(record.to) >= since) {
          rows.push(record);
        }
      } catch {
        // 坏行跳过
      }
    }
  }

  if (rows.length === 0) {
    return `最近 ${days} 天没有对话归档。`;
  }
  rows.sort((a, b) => b.to.localeCompare(a.to));
  return rows
    .slice(0, Math.max(1, limit))
    .map((r) => {
      const span = `${r.from.slice(5, 16).replace('T', ' ')} → ${r.to.slice(11, 16)}`;
      const who = r.participants.slice(0, 4).join('、');
      const topics = (r.topics ?? []).map((t) => t.title).join(' / ');
      return `[${span}] ${r.summary}${topics ? `\n  话题：${topics}` : ''}${who ? `\n  在场：${who}` : ''}`;
    })
    .join('\n\n');
}

/** 同义扩展缓存：同一个查询只问一次模型。 */
const expansionCache = new Map<string, string[]>();

const EXPAND_PROMPT = `把用户给的中文关键词扩展成群里可能用的其他说法（同义词、别称、口语、黑话）。
只输出词组，用顿号分隔，2~4 个，不要解释，不要重复原词。
例：退坑 → 不玩了、弃游、afk`;

/**
 * 中文同义扩展：子串匹配搜不到「不玩了」，但人问的是「退坑」。
 * 只在第一次没命中时才调用，控制成本。
 */
export async function expandQuery(ctx: ToolContext, query: string): Promise<string[]> {
  const cached = expansionCache.get(query);
  if (cached) {
    return cached;
  }
  if (!ctx.complete || !ctx.llm) {
    return [];
  }
  try {
    const raw = await ctx.complete(
      [
        { role: 'system', content: EXPAND_PROMPT },
        { role: 'user', content: query },
      ],
      { ...ctx.llm, temperature: 0.2, maxTokens: 60, disableThinking: true, purpose: 'expand' },
    );
    const list = raw
      .split(/[、,，\n/]/)
      .map((s) => s.trim().replace(/^[-*\d.\s]+/, ''))
      .filter((s) => s.length > 0 && s !== query && s.length <= 12)
      .slice(0, 4);
    expansionCache.set(query, list);
    return list;
  } catch (error) {
    ctx.log.warn('同义扩展失败', { query, error });
    return [];
  }
}

export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  const startedAt = Date.now();
  const output = await executeToolInner(name, rawArgs, ctx);
  ctx.log.info('工具耗时', { name, ms: Date.now() - startedAt, chars: output.length });
  return output;
}

async function executeToolInner(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  const args = safeParse(rawArgs);
  try {
    if (name === 'ask_choice') {
      if (!ctx.askChoice) {
        return '当前身份发不了选项卡片：直接问一句就行。';
      }
      const question = asString(args.question).trim();
      if (!question) {
        return '需要 question（一句话问题）。';
      }
      const options = parseChoiceOptions(args.options);
      if (options.length < 2) {
        return '至少给两个选项；只有一个的话直接说结论，不用出卡片。';
      }
      return await ctx.askChoice({ question, options });
    }
    if (name === 'send_card') {
      if (!ctx.sendCard) {
        return '当前身份发不了图文卡片：把结论写成文字就行。';
      }
      const built = buildCard({
        title: asString(args.title),
        description: asString(args.description),
        url: asString(args.url),
        picUrl: asString(args.pic_url ?? args.picUrl),
      });
      if ('error' in built) {
        return built.error;
      }
      return await ctx.sendCard({
        title: built.card.content.title,
        description: built.card.content.description,
        url: built.card.content.url,
        picUrl: built.card.content.pic_url,
      });
    }
    if (name === 'search_messages') {
      const query = asString(args.query).trim();
      if (!query) {
        return '需要提供关键词 query。';
      }
      const sender = asString(args.sender) || undefined;
      const days = asNumber(args.days);
      const limit = asNumber(args.limit);
      const index = indexFor(ctx.dataRoot);
      const hits = await index.search({ query, sender, days, limit, chatId: ctx.groupId });

      if (hits.length > 0) {
        ctx.log.info('检索历史', { query, hits: hits.length });
        return renderHits(hits);
      }

      // 没命中：中文同义改写很常见（退坑 ↔ 不玩了），扩展一次再搜
      const alternatives = await expandQuery(ctx, query);
      if (alternatives.length === 0) {
        ctx.log.info('检索历史', { query, hits: 0 });
        return renderHits(hits);
      }

      const merged = new Map<string, (typeof hits)[number]>();
      for (const alt of alternatives) {
        const found = await index.search({ query: alt, sender, days, limit, chatId: ctx.groupId });
        for (const hit of found) {
          merged.set(`${hit.at}|${hit.senderId}|${hit.content.slice(0, 40)}`, hit);
        }
        if (merged.size >= (limit ?? 8)) {
          break;
        }
      }
      const expanded = [...merged.values()].slice(0, limit ?? 8);
      ctx.log.info('检索历史（同义扩展）', {
        query,
        alternatives,
        hits: expanded.length,
      });
      if (expanded.length === 0) {
        return `「${query}」和它的近义说法（${alternatives.join('、')}）都没有命中。可能是真没聊过，别编。`;
      }
      return `（原词没命中，按近义说法 ${alternatives.join('、')} 搜到这些）\n${renderHits(expanded)}`;
    }
    if (name === 'web_search') {
      const query = asString(args.query).trim();
      if (!query) {
        return '需要提供搜索词。';
      }
      const hits = await searchWeb(query, asNumber(args.limit) ?? 5, ctx.log);
      return renderWebHits(query, hits);
    }
    if (name === 'member_profile') {
      return await memberProfile(ctx, asString(args.name));
    }
    if (name === 'search_topics') {
      return await searchTopics(ctx, asString(args.query));
    }
    if (name === 'recent_digests') {
      return await recentDigests(ctx, asNumber(args.days) ?? 7, asNumber(args.limit) ?? 5);
    }
    if (name === 'chat_stats') {
      return await chatStats(ctx);
    }
    if (name === 'memory_query') {
      if (!ctx.records) {
        return '这个群没有记录本。';
      }
      return await ctx.records.query({
        text: asString(args.text),
        kind: isKind(args.kind) ? args.kind : undefined,
        status: isStatus(args.status) ? args.status : undefined,
        limit: asNumber(args.limit),
      });
    }
    if (name === 'memory_note') {
      if (!ctx.records || !ctx.capabilities?.memoryWrite) {
        return '当前身份不能写记录，只能查。';
      }
      return await ctx.records.note({
        kind: asString(args.kind),
        title: asString(args.title),
        body: asString(args.body) || undefined,
        status: asString(args.status) || undefined,
        owner: asString(args.owner) || undefined,
        tags: arrayOf(args.tags),
        refs: arrayOf(args.refs),
        by: ctx.speaker,
      });
    }
    if (name === 'memory_status') {
      if (!ctx.records || !ctx.capabilities?.memoryWrite) {
        return '当前身份不能改记录状态。';
      }
      return await ctx.records.setStatus(asString(args.id), asString(args.status), ctx.speaker);
    }
    if (name === 'goal_create') {
      if (!ctx.goals || !ctx.capabilities?.memoryWrite) {
        return '当前身份不能立目标。';
      }
      return await ctx.goals.create(
        {
          objective: asString(args.objective),
          criteria: arrayOf(args.criteria) ?? [],
          slices: arrayOf(args.slices) ?? [],
          ...(isGoalKind(args.kind) ? { kind: args.kind } : {}),
          ...(ctx.speaker ? { by: ctx.speaker } : {}),
        },
        { maxRounds: 12, maxWallMs: 4 * 60 * 60 * 1000 },
      );
    }
    if (name === 'goal_status') {
      if (!ctx.goals) {
        return '这个会话没有目标账本。';
      }
      const goal = await ctx.goals.read();
      return goal ? renderGoal(goal) : '还没有目标。要开工就用 goal_create 立一个。';
    }
    if (name === 'goal_step') {
      if (!ctx.goals || !ctx.capabilities?.memoryWrite) {
        return '当前身份不能改目标。';
      }
      const status = args.status;
      if (!isSliceStatus(status)) {
        return 'status 只能是 todo / doing / review / done / blocked / dropped。';
      }
      // 标 done 前先过独立复核：同一条会话里自评自判等于没审
      if (status === 'done' && ctx.reviewSlice) {
        const goal = await ctx.goals.read();
        const slice = goal ? await ctx.goals.sliceByKey(asString(args.slice) || (goal.slices.find((s) => s.status === 'doing')?.id ?? '')) : undefined;
        if (goal && slice) {
          const review = await ctx.reviewSlice({
            goal,
            slice,
            ...(asString(args.evidence) ? { evidence: asString(args.evidence) } : {}),
          });
          await ctx.goals.saveReview(slice.id, review);
          if (!review.pass) {
            const back = await ctx.goals.step(slice.id, 'review', {
              note: `复核未过：${review.note}`.slice(0, 400),
              ...(ctx.speaker ? { by: ctx.speaker } : {}),
            });
            return `复核没过：${review.note}\n已退回 review，改完把证据写进 evidence 再标 done。\n${back}`;
          }
        }
      }
      return await ctx.goals.step(asString(args.slice), status, {
        ...(asString(args.note) ? { note: asString(args.note) } : {}),
        ...(asString(args.ref) ? { ref: asString(args.ref) } : {}),
        ...(ctx.speaker ? { by: ctx.speaker } : {}),
      });
    }
    if (name === 'goal_watch') {
      if (!ctx.goals || !ctx.capabilities?.memoryWrite) {
        return '当前身份不能改目标。';
      }
      const issue = asNumber(args.issue);
      if (!issue) {
        return '需要 issue 号。';
      }
      if (!ctx.cnb) {
        return '没配 CNB 令牌，挂不了探针；只能自己按轮次看 cnb_issue_get。';
      }
      const probe = await ctx.cnb.probeIssue(issue);
      ctx.log.info('挂上 CNB 探针', { issue, sig: probe.sig.slice(0, 60) });
      return await ctx.goals.watch(issue, probe.sig, asString(args.note) || undefined);
    }
    if (name === 'goal_finish') {
      if (!ctx.goals || !ctx.capabilities?.memoryWrite) {
        return '当前身份不能收尾目标。';
      }
      return await ctx.goals.finish(asString(args.recap), ctx.speaker);
    }
    if (name === 'goal_block') {
      if (!ctx.goals || !ctx.capabilities?.memoryWrite) {
        return '当前身份不能改目标。';
      }
      return await ctx.goals.block(asString(args.reason), ctx.speaker);
    }
    if (name === 'cnb_issue_list' || name === 'cnb_pull_list' || name === 'cnb_issue_get') {
      if (!ctx.cnb || !ctx.capabilities?.repoRead) {
        return '当前身份不能用 CNB 通道。';
      }
      if (name === 'cnb_issue_list') {
        const state = asString(args.state) === 'closed' ? 'closed' : 'open';
        return renderIssues(await ctx.cnb.listIssues(state), ctx.cnb.repo);
      }
      if (name === 'cnb_issue_get') {
        const number = asNumber(args.number);
        if (!number) {
          return '需要 issue 号。';
        }
        return renderIssue(await ctx.cnb.getIssue(number), ctx.cnb.repo);
      }
      const state = asString(args.state);
      const normalized = state === 'closed' || state === 'all' ? state : 'open';
      return renderPulls(await ctx.cnb.listPulls(normalized), ctx.cnb.repo);
    }
    if (name === 'cnb_issue_create') {
      if (!ctx.cnb || !ctx.capabilities?.repoWrite) {
        return '当前身份不能开 issue。';
      }
      const title = asString(args.title).trim();
      const body = asString(args.body).trim();
      if (!title || !body) {
        return '开 issue 需要 title 和 body（body 走四段模板）。';
      }
      const issue = await ctx.cnb.createIssue({ title, body });
      ctx.log.info('开了 CNB issue', { repo: ctx.cnb.repo, number: issue.number });
      return `已开 issue #${issue.number}：${title}`;
    }
    if (name === 'cnb_issue_dispatch') {
      if (!ctx.cnb || !ctx.capabilities?.repoWrite) {
        return '当前身份不能派工。';
      }
      const number = asNumber(args.number);
      const comment = asString(args.comment).trim();
      if (!number || !comment) {
        return '派工需要 issue 号和说明。';
      }
      await ctx.cnb.commentIssue(number, ensureBuddyMention(comment), true);
      ctx.log.info('CNB 派工', { repo: ctx.cnb.repo, number });
      return (
        `已派工 #${number}（@CodeBuddy + work_mode）。等它推分支开 PR，回来用 cnb_pull_list 看。\n` +
        `接着 goal_step 把切片标 doing，再 goal_watch(#${number}) 挂探针；` +
        '等了 30 分钟还没动静我会自己醒一次，核实派工有没有生效。'
      );
    }
    if (name === 'cnb_issue_close') {
      if (!ctx.cnb || !ctx.capabilities?.repoWrite) {
        return '当前身份不能关 issue。';
      }
      const number = asNumber(args.number);
      if (!number) {
        return '需要 issue 号。';
      }
      await ctx.cnb.closeIssue(number, asString(args.comment) || undefined);
      ctx.log.info('关了 CNB issue', { repo: ctx.cnb.repo, number });
      return `已关闭 #${number}。`;
    }
    if (name === 'cnb_guide') {
      if (!ctx.cnbCli) {
        return '这台机器没装 CNB 官方 skill 文档。';
      }
      const dir = ctx.cnbCli.config.guideDir;
      const query = asString(args.query).trim();
      const skillName = asString(args.name).trim();
      if (query) {
        return await searchCnbGuide(dir, query);
      }
      if (skillName) {
        return await readCnbGuide(dir, skillName, asString(args.path) || undefined);
      }
      return await listCnbGuide(dir);
    }
    if (name === 'cnb') {
      if (!ctx.cnbCli || !ctx.capabilities?.repoWrite) {
        return '当前身份不能跑 CNB 命令。';
      }
      const checked = checkCnbArgs(args.args);
      if (!checked.ok) {
        return checked.reason;
      }
      // 走 CLI 发评论默认按派工算：裸评论叫不醒 NPC（2026-11-21 干等 2.5 小时的坑）
      const route = routeIssueComment(checked.args);
      if (route.kind !== 'none') {
        if (!ctx.cnb) {
          return '没配 CNB 令牌，发不了评论；要用派工通道得先有 AGENT_CNB_TOKEN_FILE。';
        }
        if (route.kind === 'plain') {
          await ctx.cnb.commentIssue(route.number, route.body);
          ctx.log.info('CNB 普通评论', { repo: ctx.cnb.repo, number: route.number });
          return `已在 #${route.number} 留了一条普通评论（note: 前缀 = 不带 work_mode，不会叫醒 NPC）。`;
        }
        await ctx.cnb.commentIssue(route.number, ensureBuddyMention(route.body), true);
        ctx.log.info('CNB 重派工（CLI 评论自动升级）', { repo: ctx.cnb.repo, number: route.number });
        return (
          `已按派工口径发到 #${route.number}（自动补 @CodeBuddy + work_mode）—— 裸评论叫不醒 NPC，这条带上了。\n` +
          `接着 goal_step 把切片标 doing，再 goal_watch(#${route.number}) 挂探针；只想要一条普通记录就写 note: 前缀。`
        );
      }
      const result = await ctx.cnbCli.run(checked.args, {
        ...(asNumber(args.timeout_ms) ? { timeoutMs: asNumber(args.timeout_ms) } : {}),
      });
      ctx.log.info('跑了 cnb 命令', { args: checked.args.join(' ').slice(0, 160), code: result.code });
      return renderCnbRun(result, checked.args);
    }
    if (name === 'repo_status') {
      if (!ctx.workspace || !ctx.capabilities?.repoRead) {
        return '当前身份不能看仓库。';
      }
      return await ctx.workspace.gitSummary();
    }
    if (name === 'ci_status') {
      if (!ctx.workspace || !ctx.capabilities?.repoRead) {
        return '当前身份不能看 CI。';
      }
      return await ctx.workspace.ciStatus(asNumber(args.limit) ?? 3);
    }
    if (name === 'list_dir') {
      if (!ctx.workspace || !ctx.capabilities?.repoRead) {
        return '当前身份不能看仓库。';
      }
      const rel = asString(args.path) || ctx.workspace.repoDir;
      return await ctx.workspace.list(rel, Math.min(asNumber(args.depth) ?? 2, 4));
    }
    if (name === 'read_file') {
      if (!ctx.workspace || !ctx.capabilities?.repoRead) {
        return '当前身份不能读代码。';
      }
      const rel = asString(args.path);
      if (!rel) {
        return '需要提供 path。';
      }
      return await ctx.workspace.read(rel);
    }
    if (name === 'grep_files') {
      if (!ctx.workspace || !ctx.capabilities?.repoRead) {
        return '当前身份不能搜代码。';
      }
      const pattern = asString(args.pattern);
      if (!pattern) {
        return '需要提供 pattern。';
      }
      return await ctx.workspace.grep(pattern, asString(args.path) || '.', Math.min(asNumber(args.limit) ?? 40, 100));
    }
    if (name === 'write_file') {
      if (!ctx.workspace || !ctx.capabilities?.repoWrite) {
        return '当前身份不能改仓库；需要改就把想要的改动说清楚，等主人执行。';
      }
      const rel = asString(args.path);
      if (!rel) {
        return '需要提供 path。';
      }
      return await ctx.workspace.write(rel, asString(args.content));
    }
    if (name === 'run_command') {
      if (!ctx.workspace || !ctx.capabilities?.exec) {
        return '当前身份不能跑命令。';
      }
      const cmd = asString(args.cmd).trim();
      if (!cmd) {
        return '需要提供 cmd。';
      }
      // 全量测试/构建是 CI 和 NPC 的活：本地跑一次几分钟，输出还吃几千 token
      const heavy = heavyLocalHint(cmd);
      const heavyMode = ctx.localHeavy ?? 'block';
      if (heavy && heavyMode !== 'allow') {
        const tip =
          `「${heavy}」不在本地跑：验收看 PR 里 NPC 贴的输出 + ci_status / cnb pulls check-status；` +
          '要复现只跑定向用例（`npx vitest run tests/xxx.test.ts`，几秒）。';
        if (heavyMode === 'block' && args.force !== true) {
          ctx.log.info('拦下本地重活', { cmd: cmd.slice(0, 120), heavy });
          return `${tip}\n确实必须本地跑（比如 CI 挂了要复现），把 force 设成 true。`;
        }
        ctx.log.warn('本地跑了重活', { cmd: cmd.slice(0, 100), mode: heavyMode });
      }
      const timeout = Math.min(Math.max(asNumber(args.timeout_ms) ?? 120_000, 5_000), 300_000);
      const result = await runCommand({
        cmd,
        cwd: asString(args.cwd) || ctx.workspace.repoDir,
        workspace: ctx.workspace.root,
        tier: ctx.tier ?? 'guest',
        home: ctx.workspace.home,
        blacklist: ctx.cmdBlacklist,
        limits: { timeoutMs: timeout, maxBytes: 6_000 },
      });
      ctx.log.info('跑了命令', { cmd: cmd.slice(0, 120), code: result.code, denied: result.denied });
      return renderRunResult(result, cmd);
    }
    return `未知工具：${name}`;
  } catch (error) {
    ctx.log.warn('工具执行失败', { name, error });
    return `工具执行失败：${error instanceof Error ? error.message : String(error)}`;
  }
}
