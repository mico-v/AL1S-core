# 多人群聊 Agent 架构研究：给 Kei 的升级方案

> 调研时间：2026-10。来源包括学术论文（arXiv / ACL / ACM IUI）、平台官方文档（Slack）、
> 开源框架（AutoGen）、以及 Hermes 自身的相关设计讨论。文末附完整出处。

## 一句话结论

现在的 Kei 是「一个会看缓冲的对话者」；要变成「一个理解群内关系、记得住来龙去脉的参与者」，
缺的不是更大的上下文窗口，而是**三层结构**：把"听/说"拆开的处理门（gate）、带说话关系的
上下文表示、以及按话题而非按条数切分的记忆。

---

## 一、研究现状

### 1.1 多人对话 agent 的三个能力维度

2025 年的综述把多人群聊 agent（MPCA）拆成三个问题：

1. **State of Mind Modeling** —— 能否建模每个参与者此刻的状态（情绪、立场、意图）；
2. **Semantic Understanding** —— 能否理解对话内容本身；
3. **Agent Action Modeling** —— 能否推理并预测对话走向（谁在跟谁说话、下一句该谁说）。

综述明确指出 **Theory of Mind 是构建可用 MPCA 的关键**，而多模态理解仍是空白。

对我们的意义：Kei 现在只做了第 2 项的一部分（读文本），第 1 项完全没有（只有静态档案，
没有"此刻谁在生气/谁在敷衍"），第 3 项只有最粗暴的版本（@ 了才回）。

### 1.2 LLM 在多人对话里会「退化」

《Do LLMs suffer from Multi-Party Hangover?》(2024) 用两个任务做诊断：

- **Addressee Recognition（AR）**：这句话是说给谁的；
- **Response Selection（RS）**：该回哪一句。

结论有两条对工程直接有用：

1. **多人场景下 LLM 的 AR/RS 准确率明显低于双人场景** —— 所以不能指望模型自己从一堆
   `张三: …` 里搞清谁在跟谁说话，**结构信息必须由系统提供**。
2. **把对话换成「摘要 + 用户画像」反而让准确率下降** —— 原始转写比模型生成的摘要更可靠。

这直接否掉了"为了省 token 先把群聊摘要一遍再喂给模型"的思路。摘要适合做长期记忆，
不适合做**当轮判断**的输入。

### 1.3 什么时候该说话，是设计问题不是模型问题

ACM IUI'25 的《Controlling AI Agent Participation in Group Conversations》做了两组实验，
核心发现：

- 参与者在群组脑暴里**确实希望有 AI**，但**反感 agent 主导对话**；
- 用户想要的是**对"何时说、说什么、说多少"的控制权**，而不是全自动。

他们用的系统提示词里有一条值得抄：**"behaves as a participant, not a moderator"**。

ProACT (2026) 更进一步，把"该不该插话"形式化为 **breakdown detection**：
观察带说话人的对话历史，判断当前这轮是否出现协作断裂（分歧、目标含糊、约束被遗忘、
讨论打转、发言严重不均），只有出现断裂才考虑介入。它的评测显示，相比直接聊天，
这种"先判断断裂、再决定说不说"的框架在**恰当性、不打断性、简洁度**上都更好。

对我们的意义：Kei 目前是"被 @ 才说"，安全但被动。往主动走必须有 breakdown 判据，
不能退化成"看到关键词就插嘴"。

### 1.4 记忆：从「覆盖写」到「带时间的事实」

Zep / Graphiti (arXiv 2501.13956) 的核心是**时序知识图谱**：每条事实带生效区间，
新信息不是覆盖旧信息，而是关闭旧区间、开启新区间。它在 DMR 基准上略胜 MemGPT
（94.8% vs 93.4%），在更贴近真实场景的 LongMemEval 上准确率提升最多 18.5%，
同时延迟降低 90%。

对我们的意义：现在 `updater.ts` 是**整份档案覆盖写** —— 「他最近在准备比赛」变成
「他在考研」时，前一条就没了。丢失的不是文字，是**时间**。

### 1.5 上下文工程：要的是「最小高信号 token 集」

Anthropic 的 context engineering 文章给了三条可直接落地的原则：

- 上下文变长会 **context rot**（召回能力下降），不是越多越好；
- **compaction**：压缩前先保留决策与未决项；
- 目标是"找到能让模型产生期望行为的最小 token 集合"。

Slack 的 agent 文档给了具体的状态对象形态：

```
{ goal, constraints, decisions, artifacts, sources }
```

并强调 **不要每轮重新拉整段线程**，而是维护结构化状态 + 渐进摘要。

### 1.6 编排：群聊 = 共享线程 + 选人

AutoGen 的 Group Chat 模式把多人协作抽象成：所有 agent 订阅同一个 topic，
由 `GroupChatManager` 决定下一个发言人（轮询或 LLM 选择），**同一时刻只有一个在说**。

对我们的意义：这是"多 agent 协作"的编排，不是"一个 agent 参与人类群聊"。
但它的**选人器（selector）**思想可以借用：把"这条消息该不该我接"也做成一个显式的选择步骤，
而不是散落在 if 里的硬编码。

### 1.7 一个来自 Hermes 自身的印证

Hermes 仓库 issue #15621 提了同一个问题：群聊适配器的 `require_mention` 把两件事混为一谈 ——
**"要不要存进历史"** 和 **"要不要调用模型"**。它建议三态：

| 模式 | 含义 |
|---|---|
| `DROP` | 直接丢弃（自己被 echo、白名单外） |
| `STORE_ONLY` | 只入历史，不调模型 |
| `PROCESS` | 入历史 + 调模型 |

Kei 现在的行为本质上已经是 `STORE_ONLY`，但它是**隐含**在 `if (!called)` 里的，
没有命名、没有统一出口，也没法单独统计"存了多少、丢了多少"。

---

## 二、对 Kei 现状的诊断

| 维度 | 现状 | 问题 |
|---|---|---|
| 处理门 | `@` 命中才 PROCESS，否则 push 缓冲 | 隐含三态；没有 DROP 的可观测性；`/` 命令靠字符串前缀特判 |
| 上下文表示 | `昵称: 内容` 一行一条 | **没有时间、没有"对谁说"**，模型无法判断谁在接谁的话 |
| 缓冲策略 | 固定 40 条，@ 后清空 | 40 条可能横跨三个话题；也可能一个话题被切两半 |
| 归档 | 每 40 条摘要一次 | 按条数切，不按话题切，摘要容易"这段聊了好几件事" |
| 成员记忆 | LLM 覆盖写 markdown | 丢时间；新事实与旧事实冲突时无法区分"变了"和"记错了" |
| 主动性 | 无 | 安全，但群里卡住时也帮不上 |
| 检索 | 子串匹配 + 话题索引 | 无向量召回；中文同义改写搜不到 |

---

## 三、升级方案（按优先级）

### P0 — 上下文表示：补上「时间」和「对谁说」

**依据**：Multi-Party Hangover 证明结构信息必须由系统提供；原始转写优于摘要。

改动：缓冲行从

```
小明: 今天吃什么
```

变成

```
[20:14] 小明 → 小红: 今天吃什么
[20:15] 小红: 随便 你定
[20:16] 小明 → Kei: Kei 你说呢
```

`→` 从 `mentions` 和 `message_reference` 推出来。最后一行标 `→ Kei` 时，
模型能明确"这句是冲我来的"，而不是靠内容猜。

**不改**：仍然只用原始消息，不做中间摘要。

### P1 — 处理门显式三态

把 `handle()` 里的隐式分支提成 `classify(message) → 'drop' | 'store' | 'process'`，
并计数打点（每类各多少条）。好处：

- 可观测：「今天存了 400 条、处理 12 条、丢了 3 条」是个有用的指标；
- 可扩展：以后加"被点名但不是 @"（P2）只改分类器，不动主流程；
- 与 Hermes #15621 的抽象对齐，将来迁移平台不用重写。

### P2 — 话题切分替代条数切分

**依据**：CODI 2024 的多人群聊话题切分工作用 TextTiling（相邻文本块的相似度下降处切）；
Anthropic 强调按语义单元压缩而不是按长度硬切。

做法（轻量，不引入 embedding 服务）：对候选批次做**中文双字组 Jaccard 相似度**滑窗，
在相似度最低的边界处切开；同时把「空闲超过 30 分钟」也当作边界。

触发条件从「攒够 40 条」变成「攒够 15 条 **且**（话题漂移超阈值 或 空闲超时）」。

### P3 — 记忆带时间（已完成）

成员档案从

```
- 常聊话题: 在准备比赛
```

改成

```
- 常聊话题: 准备比赛（2026-09-12 ~ 2026-10-03）→ 考研（2026-10-20 ~ ）
```

实现方式：`updater.ts` 的提示词要求模型对「会变的事实」标注时间区间，事实变化时
**不删旧条目**，只给旧的补结束日期再新增一条。旧档案不需要迁移 —— 下一次归纳时
模型会按新格式重写；没有时间的历史条目保持原样，不强行编造日期。

### P4 — 主动性（已完成，默认关闭）

`proactive.ts`：一次结构化判断，输出 `{speak, reason, text}`。
判据写死在提示词里（问题没人接、说岔了、打转、有人求助、冷场），
并且要求「不说话也要写原因」—— 不给理由就当成不说话。

有三道闸：冷却时间（默认 30 分钟）、最少条数（8 条）、话题新鲜度（最后一条 15 分钟内）。
判断失败、理由为空、正文为空，一律沉默 —— 宁可漏说，不能乱说。

**当前线上仍是关闭状态**（`AGENT_PROACTIVE` 未设置）。

### P5 — 召回升级（已完成，零依赖版）

`search_messages` 先按原词搜；**没命中才**让模型扩展 2~4 个近义说法再搜一遍，
结果按「时间+发送人+正文前缀」去重，并在结果前注明用了哪些近义词。
扩展结果按查询缓存，同一个词不会反复问模型。

先做同义词而不是 embedding：不引入索引服务、不影响冷启动，
中文群聊里「退坑 / 不玩了 / afk」这类改写是主要失配来源。
向量召回仍是后续选项。

---

## 四、已实施

| 项 | 落点 | 状态 |
|---|---|---|
| P0 上下文带时间与收件人 | `context.ts` | 已上线 |
| P1 处理门三态 | `index.ts` + `/status` | 已上线 |
| P2 冷场 / 话题漂移归档 | `digest.ts` | 已上线 |
| P3 记忆带时间 | `updater.ts` | 已上线 |
| P4 主动参与 | `proactive.ts` | 已完成，**线上关闭** |
| P5 检索同义扩展 | `tools.ts` | 已上线 |

测试：`pnpm agent:check` 覆盖 107 项，含主动判断解析、同义扩展、时间区间提示词。

（实现细节见提交记录。）

---

## 五、出处

**学术**

1. Sapkota et al., *Multi-Party Conversational Agents: A Survey*, arXiv:2505.18845 (2025).
   https://arxiv.org/abs/2505.18845
2. Penzo et al., *Do LLMs suffer from Multi-Party Hangover? A Diagnostic Approach to Addressee
   Recognition and Response Selection in Conversations*, arXiv:2409.18602 (2024).
   https://arxiv.org/abs/2409.18602
3. Wang et al., *Multi-Party Supervised Fine-tuning of Language Models for Multi-Party Dialogue
   Generation*, arXiv:2412.05342 (2024). https://arxiv.org/abs/2412.05342
4. Rasmussen et al., *Zep: A Temporal Knowledge Graph Architecture for Agent Memory*,
   arXiv:2501.13956 (2025). https://arxiv.org/abs/2501.13956
5. Wang et al., *ProACT: Towards Breakdown-Aware Proactive Agent in Multi-User Collaboration*,
   arXiv:2607.03730. https://arxiv.org/abs/2607.03730
6. Decker & Amblard, *With a Little Help from my (Linguistic) Friends: Topic Segmentation of
   Multi-party Casual Conversations*, CODI 2024. https://aclanthology.org/2024.codi-1.16.pdf

**工程与平台**

7. Li et al., *Controlling AI Agent Participation in Group Conversations: A Human-Centered
   Approach*, IUI '25. https://doi.org/10.1145/3708359.3712089
8. Microsoft AutoGen, *Group Chat* design pattern.
   https://microsoft.github.io/autogen/dev/user-guide/core-user-guide/design-patterns/group-chat.html
9. Slack Developer Docs, *Managing context*.
   https://docs.slack.dev/ai/agent-context-management/
10. Anthropic, *Effective context engineering for AI agents*.
    https://www.anthropic.com/research/effective-context-engineering-for-ai-agents
11. Hermes Agent issue #15621, *platforms: split storage from LLM-invocation gate
    (group-chat 'observe but don't invoke' mode)*.
    https://github.com/NousResearch/hermes-agent/issues/15621
