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
- `cnb_issue_dispatch` —— 评论带 `work_mode: true` + @CodeBuddy，派工给 NPC
- `cnb_issue_close` —— 复核通过、PR 合并后关
- `cnb_pull_list` —— 等 PR、看合没合

工具对 `repoWrite` 开放。没配令牌就整个通道不挂（模型看不到工具，不会瞎试）。

## 配置（`.env`）

```
AGENT_GOAL_ENABLED=true
AGENT_GOAL_AUTO=true
AGENT_GOAL_GAP_MS=90000
AGENT_GOAL_MAX_ROUNDS=12
AGENT_GOAL_MAX_WALL_MS=14400000
AGENT_CNB_REPO=mico-v/campus-nav-3d
AGENT_CNB_TOKEN_FILE=/srv/kei/.config/cnb/token
AGENT_CNB_API_BASE=https://api.cnb.cool
```

## 自检

`pnpm agent:check` 的 `[21] 持续目标` 与 `[22] CNB issue 协作通道` 两段覆盖：
判据缺失、并发目标、切片状态流转、轮数/墙钟闸门、收尾警告、令牌缺失、渲染与工具可见性。
