# lumabot

一个通过 [@snowluma/sdk](https://snowluma.github.io/sdk/) 连接 SnowLuma OneBot 端口的**群聊 AI 机器人**（TypeScript）。

机器人像群里的一员：被 @ 或命中关键词时，用 OpenAI 兼容的 LLM 结合群聊上下文回复；支持工具调用（skill）与斜杠命令，可轻量扩展。

## 要求

- Node.js ≥ 22（推荐 24 LTS），本项目用 **fnm** 管理：

  ```bash
  fnm use   # 按 .node-version 自动切换到 v24.13.0（可在 fnm 配置中开启 use-on-cd 实现进目录自动切换）
  ```

- 一个正在运行的 SnowLuma 实例，且已启用 OneBot HTTP / WebSocket 网络适配器
  - HTTP 默认 `http://127.0.0.1:3000/`
  - WebSocket 默认 `ws://127.0.0.1:3001/`
- 一个 OpenAI 兼容的 LLM 端点（DeepSeek / Kimi / GLM / Qwen / 本地 Ollama 均可），配置 `LLM_BASE_URL` + `LLM_API_KEY` + `LLM_MODEL`

## 安装

```bash
npm install
cp .env.example .env   # 填入 SNOWLUMA_TOKEN 与 LLM_API_KEY 等
```

## 运行

```bash
npm run dev         # 开发模式（文件变更自动重启）
npm start           # 正常运行
npm run http:check  # 用 HTTP 传输做一次连接自检（getLoginInfo / get_status）
npm run llm:check   # 冒烟测试 LLM provider（无需 QQ；未配 LLM_API_KEY 时自动跳过）
npm run typecheck   # 类型检查
```

## 调试

日志模块提供分级日志（零依赖）。查看完整链路：

```bash
LOG_LEVEL=debug npm run dev                 # 终端彩色详细日志
LOG_LEVEL=debug LOG_FILE=/var/log/lumabot.log npm run dev   # 同时落盘（自动按大小轮转）
```

- 级别：`debug` / `info`（默认） / `warn` / `error`，见 `LOG_LEVEL`
- 文件输出：`LOG_FILE` 填路径即追加写文件，`LOG_MAX_SIZE_MB` 控制轮转阈值（默认 10MB，保留一份 `.1`）
- 一条回复的完整链路：`收到群消息 → 未触发/冷却跳过/生成中忽略 → 开始生成 → 调用工具(如有) → LLM 完成 → 回复完成(耗时/工具次数)`

## 使用

- **触发**：群聊中 @ 机器人，或消息包含 `TRIGGER_KEYWORDS`（如「机器人」「小助手」）；机器人回复后 `REPLY_COOLDOWN_SECONDS` 秒内不重复回复。私聊消息恒回复。
- **命令**：
  - `/help` —— 查看可用命令与工具
  - `/reset` —— 清空本群上下文
  - `/persona` —— 查看人设；`/persona 新的人设` 覆盖本会话人设
- **工具**：模型通过 function calling 调用注册的工具，例如对机器人说「帮我掷个骰子」会调用 `roll_dice`。

## 目录结构

```
src/
  index.ts            # 入口：加载配置 → 启动 Bot
  bot.ts              # Bot：持有 SDK 客户端 / 会话管理 / skill 注册中心 / LLM provider
  config.ts           # 环境变量解析与校验
  logging/            # 日志器：分级过滤 / 彩色终端 / 可选文件轮转
  llm/                # LLM 层：极简 OpenAI 兼容客户端（SSE 流式 + 工具调用）
  session/            # 会话层：每群有界上下文日志 + token 预算窗口 + LRU
  pipeline/           # 消息管道：归一化 → 触发判定 → 冷却 → 生成 → 回复
  agent/              # agent loop：LLM 流式 + 工具调用循环
  skills/             # 扩展层：skill / 命令注册中心 + 内置插件
  scripts/            # http:check / llm:check 冒烟脚本
.env.example          # 环境变量模板
```

## 扩展

新增一个工具 skill 或命令：

1. 在 `src/skills/` 下新建一个插件文件，导出 `{ name, description, register(registry) }`，在 `register` 里调用 `registry.registerSkill({ name, description, inputSchema, run })`（工具，供模型调用）或 `registry.registerCommand({ name, description, handler })`（斜杠命令）。
2. 在 `src/skills/plugins.ts` 里 import 并调用 `plugin.register(registry)`（新增一行）。

参考 `src/skills/example/dice.ts`（工具）与 `src/skills/builtin/help.ts`（命令）。

## 说明

- SDK 为纯 ESM 包（`"type": "module"`），项目同样使用 ESM。
- 运行时使用 `tsx`：`@snowluma/sdk` 当前发布的 dist 包含无扩展名的相对导入，
  Node 原生 ESM 解析会失败，tsx 可正常加载。
- `accessToken` 来自 SnowLuma 的 OneBot 配置，未设置时留空即可。
- 会话上下文保存在内存中（LRU 上限 `MAX_SESSIONS`），重启即失；`/reset` 手动清空。
