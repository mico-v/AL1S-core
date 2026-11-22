# 会话即真相：重启恢复与目标续跑的设计（参考 Codex CLI）

2026-11-22。起因：群里说「继续」触发的那一轮跑到第 24 轮被发版重启打断，回复没发出去、
续跑也没排上，而目标状态恰好是 `done`，巡检每 2 分钟静默跳过 —— 群里安静了三小时。

当时的修法是三处补丁（inflight 标记、`goal_finish` 拒绝、`done` 也能 `resume`）。
能救火，但把真相源从两个变成三个。这份文档先把参考方案看清楚，再给一个能把补丁吸收掉的整体设计。

## 一、参考：openai/codex 怎么做的（2025-11 源码实证）

| 机制 | 出处 | 要点 |
|---|---|---|
| 目标按 thread 持久化 | `codex-rs/state/src/model/thread_goal.rs` | `thread_id / goal_id / objective / status / token_budget / tokens_used / time_used_seconds` |
| 状态枚举 | 同上 | `active / paused / blocked / usage_limited / budget_limited / complete`；**终态只有 `complete` 与 `budget_limited`** |
| 目标每轮注入上下文 | `codex-rs/core/src/context/user_goal.rs` | 带标记的 user 片段 `<codex_internal_context source="user_goal">`，区分「用户设的」与「agent 改的」；目标超长**整段省略**而不是截断（截断可能把限制变成授权） |
| 被打断的回合 | `codex-rs/core/src/context/turn_aborted.rs` | 专门的 `<turn_aborted>` 片段：上一轮被打断、命令可能只执行了一半 —— 下一轮模型必须知道 |
| 续跑提示 | `codex-rs/ext/goal/templates/goals/continuation.md` | 独立模板文件，带预算余量占位；明确要求区分 progress / verified wait / no progress，完成前逐条对证据审计 |
| 恢复 | `app-server/.../thread_goal_processor.rs`、`ext/goal/src/runtime.rs` | `emit_resume_goal_snapshot` / `restore_inherited_goal_runtime` / `mark_idle_goal_active` / `record_resumed_if_status_changed`：**打开会话就把 active 目标重新挂上，状态变化记一条 resumed** |
| 计划与目标分离 | `update_plan` 工具 | 计划是 todo list，目标是 objective；计划更新不能当干活 |

三条可以直接搬的结论：

1. **状态是持久对象，进程内状态只是缓存。** 恢复不是「补一段逻辑」，而是重放状态。
2. **终态要显式**（`complete` / `budget_limited`），而不是靠「状态是 done 但还有没做完的活」这种含糊。
3. **被打断要留上下文**，否则模型下一轮会以为上一轮什么都没发生，重复劳动或漏验。

## 二、Kei 现状：问题都对得上今天的故障

1. **三个真相源**：`data/goals/<群>.json`（目标 + 切片 + 预算 + 探针）、内存里的 `ThreadState`、
   以及 11-22 新加的 `data/inflight/<群>.json`。重启后谁对谁错没有仲裁者。
2. **语义混**：`done` 表示「目标收尾」，却又允许切片没收口 —— 今天就是 `done` + s1/s6 还在 `review`，
   续跑闸门按 status 判定，于是静默。
3. **恢复路径分散**：`runGoalSweep`（只认 active）、`scheduleGoalTick`（四道闸门 + 续命 + pause + 提示）、
   `recoverInterrupted`（新补的），任一处漏判就是「干到一半人没了」。
4. **打断没有交代**：模型下一轮不知道上一轮工具可能执行了一半。
5. **语义偏离参考**：`blocked` 一次就停（Codex 要求连续 3 轮同一卡点）、预算用尽变成 `paused`（Codex 是
   `budget_limited` 终态）、续跑提示写死在 `index.ts` 字符串里和人格口径混在一起。

## 三、设计：一个群一个 thread 文件，恢复只有一个入口

### 3.1 数据

`data/threads/<群 openid>.json`（原子写：写临时文件 + rename），一个群一个：

```json
{
  "conversationId": "FD8B…",
  "goal": {
    "id": "g20261121152637",
    "objective": "…",
    "status": "active",
    "budget": { "rounds": 3, "maxRounds": 0, "maxWallMs": 43200000, "startedAt": "…", "roundsSinceProgress": 0 },
    "createdAt": "…", "updatedAt": "…"
  },
  "plan": [
    { "id": "s1", "title": "…", "status": "review", "note": "…", "ref": "PR #42" }
  ],
  "probe": { "issue": 51, "sig": "closed|5|…", "since": "…" },
  "turn": { "id": "t-…", "startedAt": "…", "kind": "goal" },
  "events": [ { "at": "…", "text": "重启后恢复：上一轮被打断" } ]
}
```

- `goal` 与 `plan` 分开（对齐 Codex 的 goal / update_plan）：目标是被追求的结果，计划是当前拆法。
- `turn` 就是今天的 `inflight` 标记，搬进同一个文件 —— **不再有第二个文件**。
- `events` 只留最近 80 条，供 `/status` 和健康日报取「上次恢复原因」。

### 3.2 状态机（对齐 Codex）

```
active ──主人要求──> paused
   │                 └─主人 /goal resume─> active
   ├──同一卡点连续 3 轮──> blocked
   ├──轮数/墙钟用尽─────> budget_limited（终态；/goal resume 重置预算并记 resumed）
   ├──额度熔断──────────> usage_limited
   └──plan 全收口且判据验过─> complete（终态）
```

- `complete` 的前置：`plan` 全部 `done`/`dropped`，否则拒绝（今天的补丁正式进状态机）。
- `budget_limited` 是终态而不是 `paused`：理由、可续性都在状态里，不用读日志猜。
- `blocked` 要连续 3 轮同一卡点，防止「难就先报卡住」。

### 3.3 恢复：一个 `reconcile()`，启动和巡检共用

```
读 thread
├ turn 非空 且 不是本进程正在跑的回合 → 判 interrupted：turn=null、记事件、下一轮注入 <turn_aborted>
├ goal.status = active 且 plan 有未收口        → 排续跑
├ goal.status = budget_limited 且主人刚 resume → 排续跑
└ 其它                                        → 不动，也不吵
只有「状态有变」才在群里说一句；没变不刷屏。
```

`runGoalSweep` 与 `recoverInterrupted` 合并成这一条路径；`scheduleGoalTick` 里散落的
续命 / pause / 探针孤儿告警，按状态机各归其位。

### 3.4 上下文注入

每轮 system 末尾带一段 `<goal>` 快照：objective、status、预算余量、下一片、probe、上一轮是否被打断。
目标正文超长**整段省略**并说明，不做截断（对齐 Codex 的做法）。

续跑提示搬到 `src/agent/prompts/continuation.md`，只放「怎么接着推」；
「指挥不是施工队」这类口径留在人格文件里，两边不再互相污染。

## 四、落地顺序（每步可单独回滚）

1. **M1 状态源合并**：`goals.ts` → `threads.ts`，goal / plan / probe / turn 一个文件；
   删掉 `inflight.ts`；自检 [21][31] 改断言。行为不变，纯搬家 —— 先让真相只有一个。
2. **M2 恢复唯一入口**：`reconcile()` 取代 `runGoalSweep` + `recoverInterrupted`；接入 `<turn_aborted>` 注入。
3. **M3 语义对齐**：状态枚举、blocked 三轮、budget_limited、complete 前置校验；`/goal` 命令、面板、日报文案跟着改。
4. **M4 观测**：`/status` 与 21:00 健康日报加「上次恢复原因 / 被打断次数 / 各状态计数」。

## 五、明确不做

- **不做 token 级预算**：Kei 的额度在 provider 侧，本地只有 calls 日志，硬算 token 预算会假精确。
  轮数与墙钟够用（主人已定：预算不是主线，别卡住才是）。
- **不引入 sqlite**：Codex 用它是因为要服务多客户端并发；Kei 单进程 + JSON 原子写足够，1.6G 机器上少一层依赖。
- **不改群聊人格与派工口径**：这次只动状态与恢复。
