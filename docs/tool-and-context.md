# 工具编排与上下文压缩：参考 Codex 的对照

2026-11-22。M1（状态源合并）之后，把另外两块容易出问题的部分也对着 Codex 源码核了一遍：
工具调用的并发与中止、上下文压缩。下面只写「参考怎么做 / Kei 现在怎么做 / 差在哪 / 怎么改」。

## 一、工具调用编排

### 参考（openai/codex）

- **并发由工具自己声明**：`tools/registry.rs` 里每个工具带 `supports_parallel`，
  `tools/parallel.rs` 据此决定取读锁还是写锁 —— 只读工具并发跑，写类工具串行，
  而不是靠一张全局白名单猜。
- **中止要有产物**：工具被取消/被打断时产出 `AbortedToolOutput`（`tools/context.rs`）
  并走 `lifecycle::notify_tool_aborted`，模型拿到的是「这条被中止了」，不是空字符串。
  上下文层还有专门的 `<turn_aborted>` 片段（`context/turn_aborted.rs`）交代整轮被打断。
- **调用有准入与超时**：`codex_direct_tool_timing::ToolAdmission` / `ToolBatchTiming` /
  `ToolGateTiming` 分层计时，慢在哪一段可观测，不靠日志猜。
- **来源区分**：`ToolCallSource` 区分「模型直接调用」与 code-mode 内的调用，行为与计时都分开。

### Kei 现状

- `runToolCalls()`（`src/agent/index.ts`）已经做了分批并发：命中 `PARALLEL_SAFE_TOOLS`
  的一批用 `Promise.all`，其余串行 —— 方向和 Codex 一致，但白名单写在 index.ts 里，
  新增工具容易漏登记。
- 工具抛错被 `executeTool` 吃掉转成字符串（可接受），但**被打断时结果为空串**：
  超预算收尾、进程被杀，模型下一轮看到的都是「什么都没发生」。
- 有重复调用检测（`repeats`）与工具输出裁剪（`pruneToolResults`），这块比 Codex 更省。

### 改法（M5）

1. `PARALLEL_SAFE_TOOLS` 从 index.ts 挪进 `tools.ts` 的工具定义（`parallel: true`），
   注册表是唯一真相；新增工具忘了声明就默认串行，不会误并发。
2. 中止产出显式结果：`executeTool` 返回 `{ ok: false, aborted: true, text: '已中止（可能部分执行）' }`
   这类结构，回合被打断时在下一轮上下文里补一段 `<turn_aborted>`。
3. 保持现有重复检测与裁剪，不引入 Codex 那套多层计时（单进程、日志已经够）。

## 二、上下文压缩

### 参考（openai/codex）

- **触发按 token 水位**，不是按轮数：模型带 `auto_compact_token_limit`，
  上下文窗口用 `effective_context_window_percent`（默认 95%）兜底，
  另有 `model_post_turn_compact_threshold_percent`（回合结束后的水位检查）与
  `auto_compact_fallback_buffer_tokens`（提前一点压，留出摘要本身的空间）。
- **压缩 = 摘要替换，不是丢弃**：`compact.rs` 用 `SUMMARIZATION_PROMPT`
  （`templates/compact/prompt.md`，口径是「CONTEXT CHECKPOINT COMPACTION：给下一个 LLM 写交接摘要」）
  生成摘要，前缀 `SUMMARY_PREFIX`（「另一个模型已经开始解决这个问题…」），
  再**保留**最近的真实用户消息与标了 `retain_across_windows` 的工具输出
  （`compact_retained_tool_outputs.rs`），插在最后一条真实用户消息之前。
- **压缩边界可识别**：摘要消息有固定前缀，`is_summary_message()` 能认出来，
  后续再压缩不会把摘要当原始对话再摘一遍。
- 每个窗口还会补一次「预算提醒」（`claim_token_budget_reminder`），只提醒一次。

### Kei 现状

- 链内减重只有 `pruneToolResults`：工具输出超过阈值就清掉旧的，保留最近 N 条。
  这只减「工具输出」，不减对话本身。
- 真正的减重靠**换链**（`thread.ts`：3 小时 / 30 轮换一条新链 + 写交接单 `data/handoffs/`），
  换链等于把之前的决策全部丢掉，下一轮只看到交接单。
- 没有 token 水位判断：现在按轮数与时间，不看上下文占用（`/status` 里能看到 3.9% 这种数）。

### 改法（M6）

1. 用已有的 `approxTokens()` 估算当前链占用，超过窗口的 75% 触发压缩（留 20% 给摘要与后续回合）。
2. 压缩动作对齐 Codex：`SUMMARIZATION_PROMPT` 口径写摘要 → 保留最近 2 条真实用户消息 +
   最近 3 条工具输出 → 摘要插在最后一条真实用户消息之前 → 摘要带固定前缀可识别。
3. 与换链并存：**先压缩，压不动再换链**（压缩失败/摘要为空 → 走现有 handoff 换链）。
4. 摘要提示词放 `src/agent/prompts/compaction.md`，和续跑提示一样从代码里拿出来。

## 三、顺序

状态（2026-11-22）：M5（工具声明化）与 M6（摘要压缩）已落地，M2–M4 同批完成。

- M2（恢复唯一入口 reconcile + `<turn_aborted>` 注入）先做：它和 M5 的第 2 条共用「中止要留痕」。
- M3（状态机语义对齐）、M4（观测）随后。
- M5 工具声明化、M6 压缩，各自独立，可单独回滚。

不做：多层计时埋点（Codex 为多客户端与远程压缩做的，Kei 单进程不需要）、
按 token 计预算（额度在 provider 侧，本地估不准）。
