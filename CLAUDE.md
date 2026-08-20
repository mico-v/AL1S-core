# CLAUDE.md

This file provides guidance to Claude Code (https://claude.ai/code) when working with code in this repository.

## 项目定位

这是一个 TypeScript/ESM QQ 群聊 AI Bot，通过 `@snowluma/sdk` 连接 SnowLuma OneBot，使用 OpenAI-compatible LLM，并通过插件 CLI、会话沙箱和管理后台扩展能力。

入口是：

```text
src/index.ts → loadConfig() → new Bot(config) → bot.start()
```

部署基线是 Node 24（`.node-version` 为 24.13.0，Docker 使用 `node:24-slim`）；`package.json` 的 Node >=22 是最低声明。代码和用户可见文本以中文为主，新注释和消息保持中文。

## 常用命令

根目录执行：

```bash
npm install
cp .env.example .env
npm run dev                 # tsx watch，加载 .env
npm start                   # tsx 启动 Bot
npm run typecheck           # 根目录 TypeScript 检查
npm run format:check        # AL1S formatter 离线检查
npm run plugins:check       # 插件注册/命令元数据检查
npm run admin:check         # Admin API 离线检查
npm run msp:check           # MSP 协议、workspace、session 检查
npm run plugin-cli:check    # CLI manifest/registry 检查
npm run plugin-cli:runtime-check
npm run command-broker:check
npm run session-cli:check   # 真实 bash + 插件 CLI 管道/重定向检查
npm run sandbox:check       # sandbox backend 可用性与 fail-closed 检查
npm run integration:check   # typecheck + MSP/CLI/broker/sandbox 集成检查
npm run shell:check         # Shell policy/executor 检查
npm run build:frontend      # frontend typecheck + Vite build
```

需要外部服务的检查：

```bash
npm run http:check           # 需要可访问的 SnowLuma HTTP/WS
npm run llm:check            # 需要有效的 LLM_API_KEY 和可用余额/服务
```

前端也可以单独执行：

```bash
cd frontend
npm install
npm run typecheck
npm run build
npm run dev
```

必须通过 `tsx` 运行根目录 TypeScript 脚本，不要用 plain `node` 直接启动源码；已发布的 SnowLuma SDK 含 Node 原生 ESM 无法解析的 extensionless import。`deploy/healthcheck.mjs` 是纯 Node 健康脚本，不适用这条规则。

## 高层架构

一次消息的主链路是：

```text
SnowLuma event
  → Bot 记录 receive 日志
  → SkillRegistry message/notice hooks
  → Pipeline 归一化和管理命令处理
  → SessionManager/ChatSession
  → 群触发、冷却、并发锁
  → Agent loop + LLM tools
  → formatter
  → 统一发送日志/OneBot reply
  → SessionPersistence
```

### Bot

`Bot` 是运行时装配根节点，连接 SnowLuma、ConfigStore、SessionManager、SkillRegistry、插件控制、Agent/LLM、MSP/sandbox、CommandBroker 和 AdminServer。修改启动顺序、连接重试或依赖注入时，应同时检查 `src/index.ts`、`src/bot.ts` 和对应的 `*:check`。

### Pipeline / Agent

`Pipeline` 负责消息归一化、`/` builtin 管理命令、群白名单、触发条件、冷却、生成锁、Agent 生成和回复记录。`runAgentLoop()` 负责流式 LLM、多轮 tool call、参数校验和 tool result 回填。

`/help`、`/reset`、`/persona`、`/llm ...` 是 builtin 管理命令，不要重新放入普通插件 CLI。普通插件功能应作为标准 CLI，通过统一会话 Bash 执行。

### Session

会话 ID 使用：

```text
g:<groupId>
p:<userId>
```

`ChatSession` 管理有界消息历史、上下文 token 窗口、persona override、生成锁和最近 Bot 回复时间。`SessionManager` 负责 LRU；`SessionPersistence` 将会话持久化到 `data/sessions/`，因此不要再假设“重启即丢失”。

### Plugin / Registry

`SkillRegistry` 管理插件元数据、兼容 skill/command 查询、插件启停和 message/notice hooks。插件显式注册于 `src/skills/plugins.ts`。

插件可有：

- 标准 CLI command；
- Agent skill 视图；
- message/notice hooks；
- 宿主状态和配置 reload/dispose。

xxt 的撤回缓存、课堂提醒 timer、course 的 ScheduleStore 和 OneBot API 状态必须留在 Bot 宿主；CLI 子进程通过受限 CommandBroker 使用它们，不要在 CLI 中重新创建空插件实例。

### 标准插件 CLI / Session Bash

消息和 Agent 的命令执行必须走同一个会话 runner：

```text
完整命令文本
  → SessionCommandRunner
  → 选择会话 sandbox
  → bash -c
  → PATH 中的插件 CLI wrapper 或系统命令
  → stdout/stderr/exitCode
```

宿主不要在 Bash 之前按空格拆分并执行插件。这样才能保留：

```bash
选人 1 | grep 123
选人 1 > result.txt
今日课表 | head -20
python - <<'PY' | tee result.txt
print("hello")
PY
```

插件 CLI 的 stdout 必须是可被 pipe/redirection 消费的业务数据；stderr 是诊断；OneBot 图片、@、群文件等 effects 通过 broker 独立处理，不能混入 stdout。

### MSP / sandbox

`SessionSandboxManager` 为会话选择 rootless Podman、rootless Docker 或明确允许的 local-bash fallback；`SessionCommandRunner` 是统一执行入口；`MspAgentBridge` 向 Agent 提供 `exec_command`/`write_stdin` 等协议能力；`CommandBroker` 是 CLI 到 Bot 宿主能力的受限边界。

生产不变量：

- MSP/sandbox 不可用时 fail-closed，不得伪装成隔离或静默回退宿主 shell；
- local-bash 仅在显式离线开发配置中允许；
- 禁止挂载 Docker/Podman socket；
- 禁止 `privileged`、host network、host PID/IPC、任意宿主路径挂载和设备映射；
- sandbox 使用非 root、网络隔离、能力收缩和 CPU/内存/PID/输出限制；
- 容器 root 只用于 entrypoint 修正 bind mount 权限，实际 Bot 使用 UID 10001；
- 只读根文件系统下只能写 `/app/data`、`/tmp`、运行时目录、缓存目录等明确可写位置；
- 容器内的 `127.0.0.1` 是容器自身。Compose 部署的 SnowLuma URL 必须是容器可访问的远端、服务名或 `host.docker.internal` 地址。

### Admin

配置 `ADMIN_TOKEN` 后启动内嵌 Node HTTP 管理服务，托管 `frontend/dist`、REST API 和日志 SSE。Compose 中通常让服务监听容器 `0.0.0.0`，但只向宿主发布 `127.0.0.1:6185`；不要直接公网开放。

健康检查只代表进程存活或管理端口可连通，不代表 SnowLuma 或 LLM 一定可用。

## 配置和部署陷阱

- 本地默认 SnowLuma 地址可使用 `127.0.0.1`；容器中不能把容器自身 localhost 当成宿主/远端服务。
- 生产推荐 `MSP_RUNTIME_MODE=podman`、`MSP_ALLOW_LOCAL_BASH_FALLBACK=false`；必须准备可用的 rootless runtime 和 `al1s-sandbox` 镜像。
- `MSP_SANDBOX_BOOTSTRAP=false` 可避免容器每次启动同步从 registry 构建 sandbox；生产镜像应在部署阶段预构建或导入。
- Docker 使用 `docker compose` v2；先运行 `docker compose config -q`，再构建/启动。不要把完整 `docker compose config` 输出到日志，因为它可能展开 `.env` 机密。
- 部署前确认 bind-mounted `data/` 对容器 entrypoint/UID 10001 可遍历；broker socket 应放在容器运行目录，不应写入受限的持久化数据根目录。
- Dockerfile 运行时包含 Python 3、`python`/`python3`/`pip3`、中文字体和 rootless Podman 相关工具；Python heredoc、管道和重定向应通过 MSP Bash 执行。
- `@napi-rs/canvas`、`sql.js` 是当前课程表功能使用的运行时依赖；`frontend/` 是独立 npm 工程，不要把前端检查误认为根目录 `typecheck` 已覆盖。

## 检查分层

- 只改普通 TypeScript 逻辑：`npm run typecheck` + 受影响的 `*:check`。
- 改 Agent/LLM tool schema：至少 `typecheck`、相关 Agent/LLM check 和 `integration:check`；工具名必须符合 provider 允许的 ASCII 约束。
- 改插件 CLI、MSP、Broker、Session sandbox 或命令路由：必须运行 `npm run integration:check`、`command-broker:check`、`session-cli:check` 和 `sandbox:check`。
- 改前端：必须运行 `npm run build:frontend`。
- 改 Docker、entrypoint、Compose 或部署：运行 `docker compose config -q`、shell 语法检查和镜像构建检查；若 Docker/Podman 后端不可用，明确记录，不能宣称生产隔离已验证。

## TypeScript 约束

`tsconfig.json` 开启严格检查，包括：

- `verbatimModuleSyntax`：类型导入使用 `import type`；
- `erasableSyntaxOnly`：不要使用 enum、namespace 或 parameter properties；
- `noUncheckedIndexedAccess`：数组/对象索引可能为 `undefined`，必须显式处理。

## 规则文件

未发现额外的 Cursor 或 Copilot 指令文件；本文件、`package.json`、TypeScript 配置、Docker/部署文档是项目操作依据。
