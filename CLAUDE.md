# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

TypeScript **group-chat AI bot** connecting to a SnowLuma OneBot instance via `@snowluma/sdk`. The bot joins QQ groups, responds to @-mentions / trigger keywords via an OpenAI-compatible LLM, and is extended by registering **skills** (LLM tool-calls) and **slash commands**.

ESM throughout (`"type": "module"`). Requires Node ≥ 22 (`.node-version` pins 24.13.0, managed via fnm). **Zero runtime dependencies beyond `@snowluma/sdk`** — the LLM client is hand-rolled over `fetch`. Keeping it dependency-light is an explicit project goal.

The codebase (README, comments, log output) is written in **Chinese** — match that language in new comments and user-facing strings.

## Commands

```bash
npm install
cp .env.example .env   # fill in SNOWLUMA_TOKEN, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, BOT_PERSONA…

npm run dev            # dev mode: tsx watch, auto-restart on file change, loads .env
npm start              # normal run
npm run http:check     # one-shot HTTP transport self-check (getLoginInfo / get_status) — needs SnowLuma
npm run llm:check      # smoke-test the LLM provider directly (no QQ needed); skips if no LLM_API_KEY
npm run format:check   # smoke-test the AL1S formatter (cleanText/buildSegments) offline
npm run plugins:check  # dry-run register all plugins, assert command/skill presence
npm run admin:check    # offline self-check of the admin HTTP service (auth/config-hot/plugin-toggle)
npm run build:frontend # build the Vue3+Vuetify admin frontend (frontend/dist)
npm run typecheck      # tsc --noEmit
```

There is no test suite. `npm run typecheck` + the `*:check` scripts are the verification steps.

## Runtime gotchas

- **Always run through `tsx`, never plain `node`.** The published `@snowluma/sdk` dist has extensionless relative imports that Node's native ESM resolver rejects; `tsx` loads it fine. Every script uses `tsx` with `--env-file=.env`. Same reason the repo has no compiled output.
- `npm run dev` / `npm start` need a running SnowLuma instance; the bot just connects and waits (Ctrl+C to exit).
- When running one-off scripts with `tsx`, files in `/tmp` are treated as CommonJS — use a `.mts` extension there, or place scripts under `src/`.

## Architecture

Layered, each layer replaceable. Data flow for one group message:

`onGroupMessage → Pipeline → normalize → log to ChatSession → trigger check → agent loop (LLM + tool calls) → ctx.reply → log bot reply`

```
src/
  index.ts                # entry: loadConfig() → new Bot() → await bot.start()
  config.ts               # BotConfig + loadConfig(env); env vars, defaults, validation
  config/
    schema.ts             # 配置元数据（分组/字段类型/hint/requiresRestart）→ 驱动前端 schema 表单
    store.ts              # ConfigStore：env 默认 + data/settings.json 覆盖层；运行时可变 config，现读即热
  bot.ts                  # Bot: owns SDK client, SessionManager, SkillRegistry, provider; binds events; assembles admin
  admin/
    server.ts             # Node http 管理服务：静态托管 frontend/dist + /api + SSE，127.0.0.1
    router.ts             # /api 处理器（status/config/schema/plugins/sessions/logs/restart）+ 日志 SSE（Last-Event-ID 续传）
    auth.ts               # ADMIN_TOKEN Bearer 校验（未配置则不开服务）
  logging/
    logger.ts             # zero-dep logger: levels (LOG_LEVEL), child tags, colored terminal, optional file (LOG_FILE) with rotation
    buffer.ts             # 日志环形缓冲（最近 N 条）+ 订阅 → 供 /api/logs 与 SSE
  metrics.ts              # 消息收发/工具调用/错误计数（仪表盘）
  llm/
    types.ts              # LLMProvider contract (never throws; errors → done.error event), LLMMessage, estimateTokens (chars/4)
    openai.ts             # OpenAI-compatible client: fetch + SSE streaming, function-calling, graceful tools-fallback retry
  session/
    session.ts            # ChatSession: per-chat bounded log; buildContext() = token-budget window with "since bot's last reply" guarantee
    manager.ts            # SessionManager: Map keyed by chatId (`g:<group>` / `p:<user>`), LRU eviction, createSession 工厂
    persistence.ts        # 会话历史落盘 data/sessions/<chatId>.json（防抖写 + 启动恢复 + 退出 flush）——对话跨重启保留
  pipeline/
    normalize.ts          # OneBot segments ↔ text (@昵称, [图片], [DIRECTED AT YOU], reply/face/video…), detects atBot
    trigger.ts            # evaluateTrigger: @bot || keyword-in-text
    pipeline.ts           # orchestration: whitelist → normalize → command dispatch → log → trigger → cooldown → isGenerating guard → generate → reply
  agent/
    loop.ts               # runAgentLoop: stream LLM; if tool-calls, execute skills, feed results back; ≤ MAX_TOOL_ITERATIONS rounds
  format/
    output-spec.ts        # AL1S 格式化核心：cleanText（Markdown 清理）、buildSegments（结构分段）、表格对齐、calcDelay —— 纯逻辑零依赖
    formatter.ts          # OutputFormatter 接口 + Al1sFormatter（读 config.al1sFormat，开关用 getter 现读 → 热切换）
  skills/
    registry.ts           # SkillRegistry (registerSkill/registerCommand/find*, 命令/skill enabled 启停, message/notice hooks, setApi), validateArgs
    plugins.ts            # registerPlugins(): imports & registers every plugin — ADD A PLUGIN HERE
    builtin/help.ts, reset.ts, persona.ts   # /help /reset /persona commands
    example/dice.ts       # example tool skill (roll_dice) demonstrating the full function-calling path
    xxt/                  # 学习通模仿娱乐插件：/选人、防撤回(/查撤回 /重放 /清空撤回)、/课堂提醒（消息钩子+撤回钩子+定时器）
    courseSchedule/       # 课程表插件：/今日课表(canvas 图片)、/同步课表(群文件 .ics 双向同步) + 两个 SQL 工具（sql.js）
  plugins/control.ts      # 命令/skill 启停 + 持久化 data/plugin-toggles.json（热生效）
  scripts/http-check.ts, llm-check.ts, format-check.ts, plugins-check.ts, admin-check.ts
frontend/                 # Vue3 + Vuetify 管理前端（独立工程，构建到 frontend/dist）
  API.md                  # 前端实现依据的 API 契约
```

### Logging

Each module uses a child logger (`logger.child('pipeline')` etc.). Record format is one physical line:
`[YYYY-MM-DD HH:mm:ss.mmm] [INFO ] [tag] message key=value`. Colorized when the terminal is a TTY (respects `NO_COLOR` / `FORCE_COLOR`); files are always plain. `error` records append the Error stack. Field values are escaped (newlines → `\n`) and truncated at 300 chars to keep lines greppable.

Debug workflow: run with `LOG_LEVEL=debug` (and optionally `LOG_FILE=/path/to/bot.log` when running under systemd/background — auto-rotated at `LOG_MAX_SIZE_MB`, default 10 MB, keeps one `.1`). Key trace for one reply: `pipeline 收到群消息` → `未触发`/`冷却跳过`/`生成中，忽略` → `开始生成` → `agent 调用工具` (if any) → `llm LLM 完成` → `回复完成 ms=… toolCalls=…`. The logger never throws and degrades silently if file writes fail.

### Key design decisions

- **Triggering**: group replies only to @-mentions (at segment targeting `self_id`) or `TRIGGER_KEYWORDS`; `REPLY_COOLDOWN_SECONDS` prevents spam; `ENABLED_GROUPS` whitelist (empty = all groups). Private messages always reply. **Not** triggered by bot nickname substring — deliberate (avoids short-name false positives).
- **Group-level shared context**: every message (including bot's own replies) is logged to that group's `ChatSession`. `buildContext()` walks newest→oldest within a token budget (`chars/4` heuristic, no tokenizer), **unconditionally including everything after the bot's last reply** (AstrBot continuity guarantee). Speaker-tagged as `昵称: 内容` (MaiBot style).
- **Concurrency**: `ChatSession.isGenerating` — one in-flight generation per chat; messages arriving mid-generation are logged but don't trigger. No queue.
- **Extension**: two extension kinds — **tool skills** (LLM function-calling, natural-language triggered) and **slash commands** (`/`-prefixed, explicit). A plugin bundles either/both as `{ name, description, register(registry) }`; wire it in `skills/plugins.ts`. Skills need no pipeline changes. Plugins can also register **message/notice hooks** (`addMessageHook`/`addNoticeHook`) for background listening (防撤回、课堂提醒), and use `CommandContext.api` / `SkillRegistry.getApi()` to call arbitrary OneBot actions (`ctx.client` is the SDK `SnowLumaApiClient`).
- **CommandContext**: carries `groupId/senderId/senderName` (from the message event), `reply(text)`, `send(OutgoingMessage)` (rich segments incl. images), and `api` — commands can @ people, send images, upload group files, etc.
- **LLM output formatting**: optional, toggleable layer (`AL1S_FORMAT_ENABLED` + `AL1S_LLM_LINE_SPLIT` + `AL1S_GLOBAL_MARKDOWN_KILLER`). When on, `pipeline.generate()` runs the formatter (`src/format/`) after the agent loop: clean Markdown, split by structure, send with per-segment delay; the session log records the actual sent text. Off by default — existing behavior unchanged.
- **LLM provider**: contract is "never throws" — all failures surface as `{ type:'done', error }`. `openai.ts` aggregates tool_calls (arguments may be delta-chunked by index), and auto-retries once without `tools` if the server rejects function-calling.
- **Memory & persistence**: in-memory sessions (LRU-capped), `/reset` clears a chat — **but chat logs now persist to `data/sessions/<chatId>.json`**（防抖写 + 退出 flush + 启动恢复，跨重启保留对话）. The course-schedule plugin persists to `COURSE_DATA_FILE` and renders with `@napi-rs/canvas`; those two deps (`@napi-rs/canvas`, `sql.js`) plus the admin frontend are the user-approved additions beyond `@snowluma/sdk`.
- **Management backend** (`ADMIN_TOKEN`/`ADMIN_PORT`): bot 内嵌 Node http 服务（127.0.0.1），同一端口托管 `frontend/dist`（Vue3+Vuetify）+ `/api/*` REST + 日志 SSE。配置走运行时 `ConfigStore`（env 默认 + `data/settings.json` 覆盖层，**现读即热**：persona/触发词/格式化开关/日志级别/模型等即时生效；wsUrl/LLM apiKey 等标 `requiresRestart`）；命令/skill 启停热生效并持久化到 `data/plugin-toggles.json`；管理接口用 `ADMIN_TOKEN` Bearer 鉴权。`admin:check` 离线自检。

### Config (`.env`)

`SNOWLUMA_WS_URL`, `SNOWLUMA_TOKEN`, `LLM_BASE_URL` (default `https://api.deepseek.com/v1`), `LLM_API_KEY`, `LLM_MODEL`, `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`, `BOT_PERSONA`, `TRIGGER_KEYWORDS`, `REPLY_COOLDOWN_SECONDS`, `CONTEXT_TOKEN_BUDGET`, `MAX_TOOL_ITERATIONS`, `ENABLED_GROUPS`, `MAX_SESSIONS`, `LOG_LEVEL`, `LOG_FILE`, `LOG_MAX_SIZE_MB`, `ADMIN_TOKEN`（管理后台 token，不配置则不开）/ `ADMIN_PORT`（默认 6185）, `BOT_ADMINS`（逗号 QQ 号，空=不限制）, `AL1S_FORMAT_ENABLED` / `AL1S_GLOBAL_MARKDOWN_KILLER` / `AL1S_LLM_LINE_SPLIT` / `AL1S_SPLIT_CHARS_PER_SECOND` / `AL1S_SPLIT_MIN_SECONDS` / `AL1S_SPLIT_MAX_SECONDS`（AL1S 格式化）, `COURSE_DATA_FILE` / `COURSE_ICS_FOLDER` / `COURSE_FONT_PATH`（课程表）, `XXT_CLASS_PERIODS` / `XXT_CLASS_WARNING_COOLDOWN_SECONDS` / `XXT_CLASS_REPLY_TIMEOUT_SECONDS`（XXT 课堂提醒）。运行时改设置走管理后台（`data/settings.json` 覆盖层），不改 `.env`。

## Code style constraints (tsconfig)

Strict settings in `tsconfig.json` that shape how code must be written:

- `verbatimModuleSyntax: true` — type-only imports must use `import type`.
- `erasableSyntaxOnly: true` — no enums, namespaces, or parameter properties (only TS that erases cleanly).
- `noUncheckedIndexedAccess: true` — indexing returns `T | undefined`; guard or handle accordingly.

## Misc

- `ref/` contains zipped reference implementations of other bot frameworks (pi, MaiBot, AstrBot). Reference material only — not part of the build or runtime.
- `.env` is gitignored; `.env.example` is the template. Don't commit real tokens.
- SDK types worth knowing: `SnowLumaWebSocketClient` (`onGroupMessage`, `onPrivateMessage`, `command`, `use` middleware, `when` predicate, `onEvent`); `ctx.reply()` takes `OutgoingMessage`; message building via `text()`, `at()`, `chain()` (all return chainable `MessageChain`); `event.self_id`, `event.sender.nickname`, `event.raw_message`.
