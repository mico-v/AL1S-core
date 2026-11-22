# 目标模式（goal mode）与 CNB issue 通道

2026-11-19 落地。两件事：把开发动作收敛到 CNB issue 上，把跨多轮的长活交给目标账本
（每轮只推一片，预算到点就停）。

## 为什么这么做

长任务的失败模式不是「不会做」，是**换了一个上下文窗口就接不上**：

- 一口气想把整个阶段做完，中途上下文耗尽，下一轮看到的是半成品，只能猜；
- 做到一半回头看「已经有进展了」，就宣布完成 —— 其实功能是断的。

所以拆成两半：**账本**记状态（别靠记性），**切片**限范围（一轮只做一片）。

依据：

- Anthropic《Effective harnesses for long-running agents》：feature 列表用 JSON 存
  （模型不容易乱改）、每轮只做一个 feature、进度必须落盘并 commit、离开时环境要干净；
- nanobot 的 `/goal` 口径：目标由人显式发起、正文有上限（4000 字）、必须带完成判据、
  并且有轮数预算 —— 没有预算的自动续跑就是烧钱。

## 账本

`data/goals/<群 openid>.json`，一个群同时只允许一个 `active` 目标：

```json
{
  "id": "g20261119132751",
  "objective": "把 M2 室内示范楼做出来",
  "criteria": ["npx vitest run 全绿", "map.mioc.cc 上能进楼"],
  "slices": [
    { "id": "s1", "title": "室内数据规范", "status": "done", "ref": "#21" },
    { "id": "s2", "title": "楼层层渲染", "status": "todo" }
  ],
  "status": "active",
  "budget": { "rounds": 1, "maxRounds": 12, "startedAt": "…", "maxWallMs": 14400000 }
}
```

切片状态：`todo / doing / review / done / blocked / dropped`。
目标状态：`active / paused / done / blocked / cancelled`。

## 工具

- `goal_create` —— 立目标：正文 + 判据（至少一条）+ 3~5 片
- `goal_status` —— 看正文、判据、每片状态、下一片、续跑轮次
- `goal_step` —— 改一片状态，顺手记结论与出处（issue / PR / commit）
- `goal_finish` —— 收尾；还有片没标完成会警告
- `goal_block` —— 卡住：缺权限、等人拍板、等 NPC 回话

工具只对 `memoryWrite` 能力开放（dev / owner）。群友看不到，也就不会去试。

## 等 NPC 交货：探针（不烧回合）

派工之后如果拿模型回合去轮询，每隔 90 秒就是一次完整对话，纯浪费。所以分两步：

1. 派工完调 `goal_watch(issue)`：把 issue 号与当前状态指纹（状态 / 评论数 / 更新时间 / 开着的 PR）
   写进账本 `awaiting`。
2. 调度器每跳只跑 `CnbClient.probeIssue()` —— 读 `/-/issues/{n}` 与 `/-/pulls?state=open`，
   算指纹。相同就继续睡（零模型开销），不同就 `clearWatch()` 并把变化摘要当下一条消息喂给模型继续做。

探针是**一次性**的：醒来即解除，要接着等就再挂。这样「NPC 一完成就接着干」
既不用人叫，也不用拿额度去换。

代价：最坏情况晚一个 `AGENT_GOAL_GAP_MS`（默认 90s）才发现。要更快就把 gap 调小，
探针本身只多两个只读请求。

### 探针等太久要自查（2026-11-21 补）

指纹不变**不等于**对方在干活。11-21 实测：复核不通过后用裸 `cnb issues comment` 发
「请在这个分支上只补…」，没带 `@CodeBuddy` + `work_mode`，NPC 压根不会下场，
探针看着「没变化」就继续睡，两条 issue 干等 2 小时半。

所以 `awaiting.since` 超过 `AGENT_GOAL_PROBE_IDLE_MS`（默认 30 分钟）还没动静，
调度器会主动 `clearWatch()` 并开一轮自查：

1. 看最近那条派工评论有没有 `@CodeBuddy`、发的时候带没带 `work_mode`，没带就 `cnb_issue_dispatch` 重派；
2. 看对应 PR 是不是还挂在旧 base 上，是就直接推 `fix/` 分支并重派；
3. 顺手看别的 todo 切片能不能先起，能并行就一次派 2~3 片。

这条不是心跳播报：只在「等超时」这个状态变化时出声，且醒来即解除。

## 自动续跑的四道闸门

`index.ts` 的 `scheduleGoalTick`：

1. `AGENT_GOAL_ENABLED` 与 `AGENT_GOAL_AUTO` 都为真；
2. 会话是工程群（`AGENT_DEV_GROUPS` 里），私聊不续跑；
3. 目标 `active`、还有待推进的切片、轮数没到 `AGENT_GOAL_MAX_ROUNDS`、
   墙钟没超 `AGENT_GOAL_MAX_WALL_MS`；
4. 每群同时只排一个定时器，正在跑的群不重入。

任何人在群里说话 → 立刻取消排队中的那一轮（人优先）；这一轮答完再重新排。
续跑轮用主人身份跑（否则降成 guest 就没工具了），消息带「（自动续跑 N/M）」前缀，
模型知道自己在做第几轮。

停止条件：`goal_finish` / `goal_block` / `/goal stop` / 预算用满。
预算用满或状态变化都只记日志，不硬造一条群消息。

## 指令

- `/goal` —— 看目标（不走模型，立刻回）
- `/goal stop` —— 停（取消定时器 + 目标置 cancelled）
- `/goal resume` —— 恢复（预算重置）

## CNB issue 通道

`src/agent/cnb.ts`，令牌 `/srv/kei/.config/cnb/token`（kei 600），
Accept 必须 `application/vnd.cnb.api+json`。

- `cnb_issue_list` / `cnb_issue_get` —— 看已有切片，别重复开
- `cnb_issue_create` —— 四段模板开 issue
- `cnb_issue_dispatch` —— 评论带 `work_mode: true` + @CodeBuddy，派工给 NPC；**重派也走它**
- `cnb_issue_close` —— 复核通过、PR 合并后关
- `cnb_pull_list` —— 等 PR、看合没合

走 `cnb` 官方 CLI 发 `issues comment` 时，工具层会**自动升级成派工**（补 `@CodeBuddy` + `work_mode`），
不会落到 CLI；只想留一句记录就写 `note:` 前缀（去掉前缀后按普通评论发）。
这条是为了堵「评论看着像派了活、实际没叫醒 NPC」的坑。

工具对 `repoWrite` 开放。没配令牌就整个通道不挂（模型看不到工具，不会瞎试）。

## 配置（`.env`）

```
AGENT_GOAL_ENABLED=true
AGENT_GOAL_AUTO=true
AGENT_GOAL_GAP_MS=90000
AGENT_GOAL_MAX_ROUNDS=12
AGENT_GOAL_MAX_WALL_MS=14400000
AGENT_GOAL_PROBE_IDLE_MS=1800000   # 探针等 30 分钟没动静就自查；0 = 关
AGENT_LOCAL_HEAVY=block            # 全量测试/构建本地默认拦，交给 CI 与 NPC；warn / allow 可放
AGENT_CNB_REPO=mico-v/campus-nav-3d
AGENT_CNB_TOKEN_FILE=/srv/kei/.config/cnb/token
AGENT_CNB_API_BASE=https://api.cnb.cool
```

## 自检

`pnpm agent:check` 的 `[21] 持续目标`、`[22] CNB issue 协作通道` 与 `[28] 派发闭环` 三段覆盖：
判据缺失、并发目标、切片状态流转、轮数/墙钟闸门、收尾警告、令牌缺失、渲染与工具可见性、
裸评论升级成派工（不落 CLI）、`note:` 前缀走普通评论、探针等太久触发自查。

## 后续：重启恢复与状态机

2026-11-22 之后的设计（一个群一个 thread 文件、恢复只留一个 `reconcile()`、
状态机对齐 Codex 的 `complete / budget_limited` 终态）见 `docs/goal-durability.md`。
本文描述的是 M1 之前的账本形态；`data/inflight/` 标记是临时补丁，M1 会并进 thread 文件。
