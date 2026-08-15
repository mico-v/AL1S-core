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
npm run typecheck      # tsc --noEmit
```

There is no test suite. `npm run typecheck` + `npm run llm:check` are the only verification steps.

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
  bot.ts                  # Bot: owns SDK client, SessionManager, SkillRegistry, provider; binds events
  logging/
    logger.ts             # zero-dep logger: levels (LOG_LEVEL), child tags, colored terminal, optional file (LOG_FILE) with rotation
  llm/
    types.ts              # LLMProvider contract (never throws; errors → done.error event), LLMMessage, estimateTokens (chars/4)
    openai.ts             # OpenAI-compatible client: fetch + SSE streaming, function-calling, graceful tools-fallback retry
  session/
    session.ts            # ChatSession: per-chat bounded log; buildContext() = token-budget window with "since bot's last reply" guarantee
    manager.ts            # SessionManager: Map keyed by chatId (`g:<group>` / `p:<user>`), LRU eviction
  pipeline/
    normalize.ts          # OneBot segments ↔ text (@昵称, [图片], [DIRECTED AT YOU], reply/face/video…), detects atBot
    trigger.ts            # evaluateTrigger: @bot || keyword-in-text
    pipeline.ts           # orchestration: whitelist → normalize → command dispatch → log → trigger → cooldown → isGenerating guard → generate → reply
  agent/
    loop.ts               # runAgentLoop: stream LLM; if tool-calls, execute skills, feed results back; ≤ MAX_TOOL_ITERATIONS rounds
  skills/
    registry.ts           # SkillRegistry (registerSkill/registerCommand/find*), validateArgs (minimal JSON-Schema validator)
    plugins.ts            # registerPlugins(): imports & registers every plugin — ADD A PLUGIN HERE
    builtin/help.ts, reset.ts, persona.ts   # /help /reset /persona commands
    example/dice.ts       # example tool skill (roll_dice) demonstrating the full function-calling path
  scripts/http-check.ts, llm-check.ts
```

### Logging

Each module uses a child logger (`logger.child('pipeline')` etc.). Record format is one physical line:
`[YYYY-MM-DD HH:mm:ss.mmm] [INFO ] [tag] message key=value`. Colorized when the terminal is a TTY (respects `NO_COLOR` / `FORCE_COLOR`); files are always plain. `error` records append the Error stack. Field values are escaped (newlines → `\n`) and truncated at 300 chars to keep lines greppable.

Debug workflow: run with `LOG_LEVEL=debug` (and optionally `LOG_FILE=/path/to/bot.log` when running under systemd/background — auto-rotated at `LOG_MAX_SIZE_MB`, default 10 MB, keeps one `.1`). Key trace for one reply: `pipeline 收到群消息` → `未触发`/`冷却跳过`/`生成中，忽略` → `开始生成` → `agent 调用工具` (if any) → `llm LLM 完成` → `回复完成 ms=… toolCalls=…`. The logger never throws and degrades silently if file writes fail.

### Key design decisions

- **Triggering**: group replies only to @-mentions (at segment targeting `self_id`) or `TRIGGER_KEYWORDS`; `REPLY_COOLDOWN_SECONDS` prevents spam; `ENABLED_GROUPS` whitelist (empty = all groups). Private messages always reply. **Not** triggered by bot nickname substring — deliberate (avoids short-name false positives).
- **Group-level shared context**: every message (including bot's own replies) is logged to that group's `ChatSession`. `buildContext()` walks newest→oldest within a token budget (`chars/4` heuristic, no tokenizer), **unconditionally including everything after the bot's last reply** (AstrBot continuity guarantee). Speaker-tagged as `昵称: 内容` (MaiBot style).
- **Concurrency**: `ChatSession.isGenerating` — one in-flight generation per chat; messages arriving mid-generation are logged but don't trigger. No queue.
- **Extension**: two extension kinds — **tool skills** (LLM function-calling, natural-language triggered) and **slash commands** (`/`-prefixed, explicit). A plugin bundles either/both as `{ name, description, register(registry) }`; wire it in `skills/plugins.ts`. Skills need no pipeline changes.
- **LLM provider**: contract is "never throws" — all failures surface as `{ type:'done', error }`. `openai.ts` aggregates tool_calls (arguments may be delta-chunked by index), and auto-retries once without `tools` if the server rejects function-calling.
- **Memory**: in-memory only (LRU-capped sessions); `/reset` clears a chat. No disk persistence.

### Config (`.env`)

`SNOWLUMA_WS_URL`, `SNOWLUMA_TOKEN`, `LLM_BASE_URL` (default `https://api.deepseek.com/v1`), `LLM_API_KEY`, `LLM_MODEL`, `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`, `BOT_PERSONA`, `TRIGGER_KEYWORDS`, `REPLY_COOLDOWN_SECONDS`, `CONTEXT_TOKEN_BUDGET`, `MAX_TOOL_ITERATIONS`, `ENABLED_GROUPS`, `MAX_SESSIONS`, `LOG_LEVEL`, `LOG_FILE`, `LOG_MAX_SIZE_MB`.

## Code style constraints (tsconfig)

Strict settings in `tsconfig.json` that shape how code must be written:

- `verbatimModuleSyntax: true` — type-only imports must use `import type`.
- `erasableSyntaxOnly: true` — no enums, namespaces, or parameter properties (only TS that erases cleanly).
- `noUncheckedIndexedAccess: true` — indexing returns `T | undefined`; guard or handle accordingly.

## Misc

- `ref/` contains zipped reference implementations of other bot frameworks (pi, MaiBot, AstrBot). Reference material only — not part of the build or runtime.
- `.env` is gitignored; `.env.example` is the template. Don't commit real tokens.
- SDK types worth knowing: `SnowLumaWebSocketClient` (`onGroupMessage`, `onPrivateMessage`, `command`, `use` middleware, `when` predicate, `onEvent`); `ctx.reply()` takes `OutgoingMessage`; message building via `text()`, `at()`, `chain()` (all return chainable `MessageChain`); `event.self_id`, `event.sender.nickname`, `event.raw_message`.
