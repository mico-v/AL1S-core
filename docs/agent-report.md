# AL1S 群聊机器人改造报告

> 把 QQ 群里的「Kei」从一个靠 Hermes 网关 + 源码补丁硬撑的 agent，
> 换成仓库里自带的、能记住人、看得懂图、说话像人的独立服务。

- 仓库：`mico-v/AL1S-core`
- 分支：`feat/chat-agent`（6 个提交）
- 运行方式：`al1s-kei.service`（systemd，开机自启）
- 模型：`deepseek-v4.1-flash`（opencode-go，OpenAI 兼容接口）

---

## 一、为什么要换

原来的 Kei 跑在 Hermes 网关里，能不能好好说话取决于三个外部条件：

1. **适配器要补丁**。Hermes 的 QQ 适配器只注册 `GROUP_AT_MESSAGE_CREATE`；
   QQ 开「接收所有消息」后推的是 `GROUP_MESSAGE_CREATE`，消息直接落到
   `Unhandled dispatch` 被丢掉。为了让它能听见群里说话，在 `adapter.py`
   里叠了五处补丁（全量消息、群聊缓冲、命令前缀、@ 判定、自身 openid）。
2. **补丁随时会被覆盖**。`hermes update` 一跑就没了，而且这些修改没法进版本库。
3. **人格和行为改不动**。群聊节奏、记忆、语气都埋在网关的策略层里，
   每次调整都要跟网关的通用逻辑打架。

结论：不要在一个通用网关里做垂直场景，把业务层拆出来。

`AL1S-core` 本来就是 QQ 官方协议的纯封装（`src/index.ts` 里写着「后续业务在
`bot.onMessage` 之上叠加」），`chat-log.ts` 也已经在把每条消息落成 JSONL ——
记忆层的原料是现成的，适合做增量。

---

## 二、最终形态

```
QQ 官方 API v2
   │  WebSocket（GROUP_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE / C2C）
   ▼
@tencent-connect/qqbot-nodejs     ← 协议层，原样保留（含仓库自带的 pnpm patch）
   │  bot.onMessage(message)
   ▼
src/agent/index.ts  ChatAgent     ← 编排：谁该回、回什么、怎么回
   ├── text.ts       清 QQ 协议标记（<@openid>、<faceType=…>）
   ├── context.ts    群聊滚动缓冲（非 @ 不进模型）
   ├── vision.ts     图 / 语音 / 文件 → 可读文本
   ├── memory.ts     成员档案 + 群日记（从 chat-log 派生）
   ├── updater.ts    定时把新消息归纳进档案
   ├── persona.ts    人格提示词
   ├── llm.ts        OpenAI 兼容客户端（唯一出口）
   └── telemetry.ts  调用审计（唯一埋点）
   ▼
src/bot.ts  replyText → QQ
```

关键：**业务层不碰协议，协议层不碰业务**。整个 `src/` 没有一处重新实现 QQ 的
鉴权、分片、重连 —— 那些继续用 SDK。

---

## 三、核心设计

### 1. 群聊只有被 @ 才调模型

群里 40 条闲聊，一条都不进模型；只有被 @ 时，把「上次说话之后群里发生了什么」
拼成背景块一次性注入。

- 省钱：一条消息一个模型调用的成本是零 vs 有
- 不刷屏：不会对着群友互聊插嘴
- 等价于 AstrBot 的 `group_icl`，但不消耗模型

### 2. @ 判定只认自己

踩过的坑：`mentions` 里只要有 `bot: true` 就回，导致 **@ 课表 Bot 也会触发 Kei**。
现在只认三种证据之一：

- openid 命中 `AGENT_BOT_OPENIDS`
- 用户名命中 `AGENT_BOT_USERNAMES` **且** `bot === true`
- 私聊（`c2c` / `dm`）不需要 @

### 3. 看图 = 两次调用

`deepseek-v4.1-flash` 是多模态的，但它是**推理模型**：`max_tokens` 给小了，
预算全烧在 `reasoning_content` 上，`content` 直接返回空 —— 表现就是「看不见图还硬聊」。

实测同一张图：

| 设置 | 耗时 | reasoning | content |
|---|---|---|---|
| max_tokens 600 | 11s | 600 | **空** |
| max_tokens 2000 | 6.7s | 325 | 正常 |
| `thinking: disabled` | 3.9s | 0 | 正常 |

所以拆成两次：看图单独发一次（关推理、600 token）拿一句描述，描述以 `[图1] …`
注入主对话。主对话始终是纯文本，便宜、快、不担心 token 被推理吃光。

### 4. 看不到就说看不到

下载失败 / 超时 / 识别不出来，一律写成 `（没看清）`、`（没加载出来）`，
人格里写死：**绝对不许猜图里是什么**，只能直说让对方重发。

这是被用户点名要求的 —— 之前它对着一张读不出来的图编了一整段。

### 5. 记忆和对话分离

- `data/chats/<群>/messages.jsonl`：原始消息（chat-log 层写的，去重、媒体缓存）
- `data/memory/<群>/members/*.md`：成员档案，由 `updater.ts` 定时归纳
- 归纳用的提示词明确禁止写真实姓名、电话、住址、学校班级、财务、隐私

归纳是后台任务，不进实时回复路径，所以慢一点无所谓。

### 6. 每次调用都记账

`chatComplete` 是唯一出口，在那里埋点。每次调用落一行 JSON：
token 三段、缓存命中、耗时、tok/s、上下文占用、调用栈、用途、群、说话人。

---

## 四、实施中遇到的问题

| # | 现象 | 根因 | 处理 |
|---|---|---|---|
| 1 | `pnpm install` 报 `ERR_PNPM_IGNORED_BUILDS` | pnpm 12 把 `onlyBuiltDependencies` 挪到 `pnpm-workspace.yaml` | 移到该文件 |
| 2 | API 403 Cloudflare 1010 | Python/默认 UA 被拦 | 客户端固定 UA |
| 3 | API 400 | 缺 `x-opencode-session` 头 | 客户端进程级 UUID 注入 |
| 4 | 回复内容为空 | 推理模型把 token 预算全用于思考 | `thinking: disabled` |
| 5 | 群里每条消息回两遍 | 旧进程没杀干净，两个进程抢同一个 AppID | 清进程，改 systemd 单实例 |
| 6 | `💾 Self-improvement review` 出现在群里 | Hermes 的 Kei 适配器没真正停：配置改了但网关 2 天没重启 | 重启网关；kei 的 `platforms.qqbot.enabled=false` 生效 |
| 7 | 看图卡 42 秒 | 超时 120s + 重试 2 次，最坏 135s | 收紧到 25s、不重试 |
| 8 | 线上仍收到成对回复 | 同 #5/#6：两个 bot 同时在线 | 见「运维」一节的唯一实例原则 |

第 5、6 条是同一个教训的两面：**同一个 AppID 只能有一个进程在连**。
判断「停了没有」不能看配置文件，要看进程和日志。

---

## 五、实测数据

来自 `pnpm agent:stats`（2026-10-23 当天，真实群流量）：

```
调用 29 次   成功 27   失败 2
token  prompt 24,347   completion 3,157   cached 8,448
缓存命中 34.7%   平均 7.6s   p50 6.0s   p95 17.0s   速度 16.48 tok/s
最大上下文占用 4.5%

按用途
  caption  22 次   prompt 10,141   cached 27.8%   平均 8.7s
  chat      6 次   prompt  8,456   cached 66.6%   平均 2.4s
  learn     1 次   prompt  5,750   cached  0.0%   平均 14.2s
```

几个可以直接读出来的结论：

- **闲聊很便宜**：缓存命中 66.6%，因为人格提示词那段前缀被稳定复用；平均 2.4 秒
- **看图是主要开销**：22 次调用、平均 8.7 秒，因为群里的表情包多
- **上下文占用极低**：最大 4.5%，离 128k 很远，不存在截断风险

---

## 六、运维

### 唯一实例原则

同一个 AppID **只能有一个进程**连 WebSocket。占用的包括：

- `al1s-kei.service`（当前）
- 任何还开着的 Hermes profile 适配器

部署前必须确认后者已停：

```bash
# 配置层面
hermes -p kei config get platforms.qqbot.enabled     # 应为 false
# 事实层面（配置改了不等于进程改了）
ps -eo pid,lstart,cmd | grep 'gateway run'           # 看启动时间
```

### 日常命令

```bash
systemctl status al1s-kei          # 状态
systemctl restart al1s-kei         # 改代码后重启
tail -f logs/service.log           # 运行日志
pnpm agent:stats                   # 调用账本
pnpm agent:check                   # 离线自检（39 项，不联网）
pnpm agent:try "今天好累啊"          # 用真实模型试跑一句，调人格用
pnpm agent:try --image 图.jpg "这啥" # 连看图一起验
pnpm agent:learn                   # 手动归纳一次档案
```

### 目录

```
data/chats/      原始消息 JSONL + 媒体缓存
data/memory/     成员档案、群日记
data/calls/      调用审计（按天滚动）
logs/            服务日志
```

---

## 七、遗留与后续

| 项 | 状态 | 说明 |
|---|---|---|
| 成员档案首次归纳 | 待观察 | 需要累积几轮真实对话才有意义 |
| 看图延迟 | 可接受 | p95 17s，主要是 API 端推理耗时，本地无法再压 |
| 群日记 | 未启用 | `memory.ts` 支持，但目前只写成员档案 |
| Hermes 侧补丁 | 已废弃 | `adapter.py` 的五处补丁不再被调用，等下次 `hermes update` 自然覆盖 |
| 多群支持 | 已具备 | `AGENT_GROUPS` 留空即对所有群生效 |

---

## 八、文件清单

| 文件 | 行数 | 职责 |
|---|---:|---|
| `src/agent/index.ts` | 360 | 编排：@ 判定、私聊、串行、分片 |
| `src/agent/telemetry.ts` | 290 | 调用审计与统计 |
| `src/agent/vision.ts` | 216 | 图片 / 语音 / 文件转文本 |
| `src/agent/llm.ts` | 189 | OpenAI 兼容客户端 |
| `src/agent/updater.ts` | 171 | 档案归纳 |
| `src/agent/memory.ts` | 165 | 成员档案读写 |
| `src/agent/persona.ts` | 107 | 人格提示词 |
| `src/agent/context.ts` | 62 | 群聊滚动缓冲 |
| `src/agent/text.ts` | 18 | QQ 协议标记清洗 |
| `src/scripts/agent-check.ts` | 217 | 离线自检（39 项） |
| `src/scripts/agent-try.ts` | 98 | 真实模型试跑 |
| `src/scripts/agent-stats.ts` | 100 | 调用统计 |
| `src/scripts/agent-learn.ts` | 56 | 手动归纳 |
| `deploy/al1s-bot.service` | — | systemd 单元 |

合计约 2000 行，全部是新增，没有改动协议层。
