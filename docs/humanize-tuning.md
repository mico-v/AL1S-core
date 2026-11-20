# Humanize 理念下的 Kei 架构调优（设计稿）

状态：设计稿，2026-11-20。P0 已落地，P1/P2 待主人拍板。

## 一、结论

Kei 现在的瓶颈不是模型能力，是**会话与目标的寿命管理**：一个目标烧完预算后仍停在 `active`，
巡检每两分钟把它「接上」一次却什么都没做；一个群的会话链只按 token 压缩，没有时间与轮数闸门。
按 Humanize 的五条实测结论改造，重点是把「长活」拆成可验收的片、让每片独立复核、让会话定期重置。

## 二、参照：Humanize 的五条结论

来源：张子健（清华人工智能学院博士生 / NVIDIA Research Singapore）的技术博客与其开源实现
`humanfia/humanize`（Apache-2.0，Flow 索引 `humanfia/flowverse`）。文中成绩多为作者自述，
此处只取其方法论，不引用未经复核的数字。

1. **没有万能 Flow**。不同问题类型要匹配不同的调度形态：约束满足类（RLCR）、最优化类
   （Flame-Chase，异构接力、以实测为判据）互不通用。
2. **模型多样性优于单模型自评**。同一模型写、同一模型审，等于没有审；关键结论要换模型独立复核。
3. **朴素并行无效**。并行只在可测指标与门控存在时才有意义，否则只是把错误放大。
4. **渐进式目标优于一次性大目标**。目标要小步推进、每步可验收，而不是一口气许一个大愿。
5. **长会话会退化**。作者实测连续 3–5 小时后单次回复 token 缩水约 30%–45%，做法是果断重置会话、
   把成果留在工作区（文件、提交、任务账本），而不是靠压缩上下文硬撑。

## 三、现状体检（2026-11-20 实测）

- 工程群目标 `g20261119102425`：33 轮、约 12 小时墙钟烧完，`status` 仍是 `active`。
- `runGoalSweep` 只判 `status === 'active'`，于是每 120s 打一行「目标续跑巡检：已接上 {groups:1}」，
  实际 `scheduleGoalTick` 在预算闸门处直接返回。日志看起来在干活，群里一条消息没有。
- 11-19 15:54 之后 `data/calls/*.jsonl` 里 **零次 `purpose=chat`**，只有 digest / caption / learn。
  即：进程活着、消息在收，但没有任何回合被触发 —— 群里「卡住」的观感由此而来。
- 会话链 `ThreadState` 只有 `AGENT_THREAD_MAX_TOKENS`（默认 60000）一个压缩闸门，
  没有时间上限、没有轮数上限；一个工程群可以连续几十轮不换会话。
- 切片的 `done` 由同一个模型在同一条会话里自评，没有独立复核通道。
- `data/calls/` 的轮数、token、缓存率、工具耗时都记了，但没有回流到决策（拆片、停手、降规模）。

## 四、设计：H1–H5

### H1 会话寿命闸门：按时间/轮数重置，而不是按 token 压缩

对应结论 5。

- `ThreadState` 增 `bornAt`，与 `turns` 一起构成两个闸门：`AGENT_THREAD_MAX_AGE_MS`（默认 3h）、
  `AGENT_THREAD_MAX_TURNS`（默认 30）。任一超限即**交接后重建**，不再走 `COMPACT_NOTE` 压缩。
- 交接：回合结束前把「当前目标与切片、本轮改动文件、验证结论、下一步」写成
  `data/handoffs/<chat>/<ISO>.md`；重建后的第一条 user 消息注入该摘要的前 800 字。
- 判定点放在 `remember()`：`tokens > maxTokens` 仍保留压缩作为最后兜底，
  但 `age`/`turns` 先触发重置。
- 验收：`agent:check` 新增断言——造 31 轮会话后 `threads` 被重建且 `data/handoffs` 多一份文件。

### H2 任务类型路由：按 kind 选 harness

对应结论 1。

- 目标增加 `kind`：`code` / `research` / `ops` / `review`，缺省 `code`。
- `toolDefinitionsFor(tier, kind)` 按 kind 收窄工具面：
  - `code`：CNB issue 派工 + 本机验证（现有链路），禁止 `goal_finish` 前跳过复核（见 H3）
  - `research`：多模型并行初稿 + 交叉审，禁止直接 `run_command` 改仓库
  - `ops`：单步执行 + 回滚点，工具面最小
  - `review`：只读（`read_file` / `grep_files` / `gh` / `cnb_pull_list`）
- 提示词按 kind 拼装，不再一份通用工作区说明套所有活。
- 验收：`agent:check` 断言四种 kind 的工具名集合互不相同且包含/排除正确。

### H3 独立复核通道：done 之前必须换会话审

对应结论 2。形式对齐 RLCR 的「必须换模型独立审」。

- `goal_step(status=done)` 前强制过复核：新会话、空上下文、只喂三样东西——
  切片判据、`git diff --stat` 与关键 diff、验证命令的真实输出。
- 复核模型取 `AGENT_REVIEW_MODEL`（默认与主模型不同的 preset；只有单一模型时退化为
  温度 0 + 空上下文，并在结果里标注「同模型复核，弱」）。
- 输出 `PASS` / `FAIL` + 一句理由，落 `data/reviews/<chat>/<slice>.json`；
  `FAIL` 时 `goal_step` 拒绝写 done，返回复核理由。
- 验收：`agent:check` 断言 FAIL 场景切片停在 `review`，PASS 场景才变 `done`。

### H4 指标门控：每片一份账，超阈值自动降规模

对应结论 3、4。

- 每片结束时从 `data/calls/*.jsonl` 聚合一份 `data/metrics/<chat>/<slice>.json`：
  轮数、墙钟、promptTokens 峰值、cacheRate、工具调用分布、失败重试次数。
- 阈值：单片 > 20 轮或 > 8 万 prompt token → 该片标 `blocked` 并在群里出声，要求拆片；
  不再允许「再跑一轮试试」。
- 并行只对 `PARALLEL_SAFE_TOOLS`（只读）开放，写操作与 goal_* 一律串行 —— 现状保持，
  写进提示词与文档，避免以后被当成性能优化点又改回去。
- 验收：`agent:check` 用一份人造 calls 账本断言聚合结果与降规模判定。

### H5 预算按片计，用尽即 paused

对应结论 4。**P0 已实现**。

- 预算从「目标级一次给满」改成「片级配额」：`AGENT_SLICE_MAX_ROUNDS`（默认 8）、
  `AGENT_SLICE_MAX_WALL_MS`（默认 1.5h）；片内超限 → 该片 `blocked` 并出声，目标继续。
- 目标级闸门保留作为总闸；触发时把 `status` 置 `paused`（不再留 `active` 空转），
  只通知一次，`/goal resume` 重置预算续命。
- `runGoalSweep` 只统计**真正排上定时器**的群，返回值与日志一致；
  已 `paused` 的目标不再被每 2 分钟捞起来。
- 目标创建时把 `.env` 默认值快照进 `budget`，`/goal` 显示的是**实际生效值**，
  不再出现「JSON 写 12 轮、日志报 720 分钟」这种对不上的情况。

## 五、明确不做

- 不重造工具调用循环：CodeBuddy / NPC 的 agent 循环当黑箱调度，Kei 只负责派活、探针、验收。
- 不引入向量库或第二套记忆：记录本 + 目标账本 + handoff 三段够用。
- 不在本机跑重活：构建、真浏览器验证继续丢 CNB / Codespaces。
- 不为了「看起来在动」加心跳式播报；只有状态真的变了才出声。

## 六、实施顺序与回滚

- **P0（已落地）**：预算用尽转 `paused`；`runGoalSweep` 只计真接上的群。
  回滚 = `git revert` 该提交 + 重启；行为退化只是回到「每 2 分钟一行假日志」。
- **P1**：H1 会话寿命闸门 + handoff（风险中等，影响回复质量，先在一周内观察 cacheRate 与首调 p50）。
- **P2**：H3 复核通道、H4 指标门控、H2 kind 路由（H2 最后做，它依赖前三者提供的接口）。
- 每一步都必须带 `agent:check` 断言，没有断言的改动不进 main。
