# Agent Runtime / MSP-Rust 架构设计与开发计划

> **文档类型**：Architecture Design Document（ADD） / 开发路线图  
> **目标**：构建一个稳定、安全、可扩展、适合 Agent 驱动编程的执行运行时  
> **核心技术方向**：Rust Core + MSP Runtime + Sandbox Worker + TypeScript Product Layer + Docker  
> **适用阶段**：V0.x → V1.0  
> **文档状态**：初始架构基线，可作为后续开发、AI 编程和代码审查的共同约束

---

# 1. 项目愿景

本项目的目标不是单纯制作一个“能调用几个 Tool 的聊天机器人”，而是构建一个能够长期运行、可接入大量 CLI 工具、可安全执行程序、可横向扩容的 **Agent Runtime / Agent OS**。

系统最终应具备以下能力：

1. 接收 QQ / OneBot、WebUI、HTTP API，以及未来 Telegram、Discord 等来源的用户请求。
2. 调用 LLM 完成理解、规划、工具选择和多步骤任务执行。
3. 将 Agent 的工具调用统一映射为 **Command**。
4. 使用 MSP 风格的 Runtime 管理：
   - Command
   - Pipeline
   - WorkspaceFS
   - Policy
   - Audit
   - External Runner
5. 支持 npm CLI、Python CLI、Rust/C/C++ 二进制以及其他系统工具直接扩展 Agent 能力。
6. 不把 `/bin/bash`、宿主文件系统和系统权限直接交给 Agent。
7. 不让 npm 包、用户脚本、Python 包等不可信代码运行在 Agent Core 进程中。
8. 支持 Docker 化部署。
9. 支持一个 Agent Core 对接多个执行 Worker。
10. 支持未来向多节点、Kubernetes、gVisor 或 microVM 架构演进。
11. 将 MSP 的 Rust 实现发展为 Swift 实现之外的第二个实现，用 Conformance Tests 保持一致行为。

---

# 2. 最核心的设计原则

整个系统围绕以下原则设计。

## 2.1 控制面与执行面必须分离

系统应明确分为两个安全等级不同的部分：

```text
┌─────────────────────────────────────────────┐
│             Trusted Control Plane           │
│                                             │
│ Agent Core                                  │
│ MSP Runtime                                 │
│ Policy Engine                               │
│ Workspace Metadata                          │
│ Tool Registry                               │
│ Scheduler                                   │
│ Audit                                       │
│ Authentication / Authorization              │
│ Secrets Management                          │
└─────────────────────┬───────────────────────┘
                      │
                 Execution Job
                      │
                      ▼
┌─────────────────────────────────────────────┐
│            Untrusted Execution Plane        │
│                                             │
│ Sandbox Worker                              │
│ Node / npm CLI                              │
│ Python                                      │
│ git / ffmpeg / native binaries              │
│ 用户代码                                    │
│ 第三方工具                                  │
└─────────────────────────────────────────────┘
```

核心原则：

> **Agent Core 永远不直接执行不可信程序。Core 只决定“什么可以执行、以什么权限执行、在哪个 Workspace 中执行”。真正执行由隔离 Worker 完成。**

这是整个架构最重要的一条原则。

---

## 2.2 Rust 是安全边界的一部分，但 Rust 不等于沙箱

Rust 可以显著降低以下类型错误：

- use-after-free
- double free
- dangling pointer
- 非法可变引用
- 大量内存生命周期错误
- 部分线程数据竞争
- C/C++ 常见的内存破坏型漏洞

但 Rust **不会自动阻止**：

- OOM
- 无限任务创建
- 无限 stdout / stderr
- 无限递归
- 无界 Channel
- Path Traversal
- Command Injection
- 权限逻辑错误
- Secret 泄漏
- 恶意 npm 包
- fork bomb
- 网络滥用
- 业务层 DoS

因此系统安全模型必须是：

```text
Rust Memory Safety
        +
Policy / Capability
        +
Resource Budgets
        +
Sandbox Isolation
        +
Audit
        +
OS Hard Limits
```

任何一层都不能替代其他层。

---

## 2.3 MSP Core 是执行语义层，不是 `/bin/sh` Wrapper

禁止将如下方案作为核心执行机制：

```text
Agent
  ↓
bash -c "<model generated string>"
```

推荐：

```text
Agent Intent
     ↓
Command / Pipeline AST
     ↓
MSP Runtime
     ↓
Workspace Resolution
     ↓
Policy Evaluation
     ↓
Command Registry
     ↓
Executor
     ↓
Sandbox Worker
```

Agent 使用的是一个：

> **受控、可组合、可审计的 shell-like 计算环境**

而不是宿主机 Shell。

---

## 2.4 Command 是整个系统的统一工具抽象

无论底层能力是什么，对 Agent 都统一表现为 Command。

```text
                        Command
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
    Native Command    External CLI      RPC Command
          │                │                │
          ▼                ▼                ▼
     Rust function       Sandbox        Connector/API

     cat                 prettier        qq.send
     grep                ffmpeg          web.search
     find                git             mail.send
     pwd                 python          db.query
```

Agent 不应该关心：

- 这是 Rust 函数；
- Node CLI；
- Python CLI；
- 二进制；
- OneBot RPC；
- HTTP 服务；
- 远程 Worker。

这些差异全部由 Runtime 隐藏。

---

## 2.5 Workspace 是 Agent 唯一看到的文件世界

Agent 不应该直接看到宿主机：

```text
/etc
/root
/home
/var/lib/docker
/app/config
```

Agent 看到的是虚拟文件树：

```text
/
├── input/
├── workspace/
├── output/
├── memory/
├── tmp/
└── tools/
```

真实宿主路径可能是：

```text
/var/lib/myagent/workspaces/
└── user-42/
    └── session-a81f/
```

但这个路径不能泄露给模型。

---

# 3. 推荐总体架构

```text
                       ┌──────────────────────┐
                       │       WebUI          │
                       │   TypeScript         │
                       └──────────┬───────────┘
                                  │ HTTP / WS / SSE
                                  │
          QQ / OneBot             ▼
      ┌────────────────┐   ┌─────────────────────────┐
      │ TS Connector   │──▶│       Agent API         │
      └────────────────┘   │                         │
                            │      Agent Core         │
 Telegram / Discord         │   TS initially / Rust  │
      ┌────────────────┐   │       later optional    │
      │ Connectors     │──▶│                         │
      └────────────────┘   └────────────┬────────────┘
                                        │
                                        ▼
                          ┌─────────────────────────┐
                          │      MSP-Rust Core      │
                          │                         │
                          │ Parser / AST            │
                          │ Command Registry        │
                          │ WorkspaceFS             │
                          │ Policy                  │
                          │ Audit                   │
                          │ Execution Planner       │
                          └────────────┬────────────┘
                                       │
                               Execution Protocol
                                       │
                         ┌─────────────┴─────────────┐
                         ▼                           ▼
                ┌────────────────┐         ┌────────────────┐
                │ Rust Worker 01 │         │ Rust Worker 02 │
                └───────┬────────┘         └───────┬────────┘
                        │                          │
                    Sandbox                    Sandbox
                        │                          │
               ┌────────┼────────┐        ┌────────┼────────┐
               ▼        ▼        ▼        ▼        ▼        ▼
             Node     Python   Native    Node     Python   Native
              │
           npm CLI
```

---

# 4. 语言边界

## 4.1 推荐继续使用 TypeScript 的部分

以下部分继续使用 TypeScript 通常收益最高：

### WebUI

- React / Vue / Svelte / Next 等
- UI 状态
- Markdown
- Streaming
- WebSocket
- 用户设置
- Chat UI

没有必要为了语言统一而使用 Rust/WASM 重写普通 WebUI。

### Messaging Connector

例如：

```text
QQ
 ↓
OneBot
 ↓
TS Connector
 ↓
Internal Event Protocol
 ↓
Agent Core
```

TS 在协议适配和快速迭代方面非常适合。

### 初期 Agent Orchestration

例如：

- LLM Provider
- Prompt
- Context
- Tool schema
- Agent loop
- Model fallback
- Conversation logic

初期继续 TS，可以避免一次性重写大量业务代码。

---

## 4.2 推荐使用 Rust 的部分

优先 Rust 化：

1. MSP Core
2. Parser / Lexer / AST
3. WorkspaceFS
4. Virtual Path Resolver
5. Policy Engine
6. Command Registry
7. Audit
8. Process Supervisor
9. Worker Daemon
10. stdin/stdout/pipe/stream
11. Timeout / Cancellation
12. Resource Accounting
13. Sandbox Lifecycle
14. 后期高并发 Scheduler / Session Runtime

原则：

> **Rust 负责系统边界、资源和长期状态；TypeScript 负责产品与生态。**

---

# 5. 为什么选择 Rust，而不是 C++ / Go

## 5.1 Rust

优点：

- Safe Rust 默认内存安全
- 无 GC
- 强类型系统
- 非常适合 Parser / Runtime / Executor
- 很适合做跨平台 Library
- 很适合 FFI
- 适合 Linux / Windows / macOS / iOS / Android
- 编译器能够阻止大量 AI 容易产生的生命周期错误

缺点：

- 学习成本更高
- AI 可能产生过度复杂的泛型 / trait / lifetime 设计
- 编译反馈循环可能比 Go 慢
- 需要明确限制架构复杂度

推荐：

> MSP Core 首选 Rust。

---

## 5.2 Go

Go 是最合理的第二选择。

优点：

- 简单
- AI 写 Go 的稳定性通常较高
- GC 管理生命周期
- goroutine 易用
- Server / Worker 开发体验很好
- 编译部署简单

缺点：

- GC
- FFI / 嵌入其他平台不如 Rust
- 作为 Swift/Kotlin 可嵌入 Core 不如 Rust 自然
- 对系统资源和生命周期的精细控制弱于 Rust

适用：

> 如果 MSP 最终只作为 Linux 独立服务，且团队无法有效 review Rust，Go 完全合理。

---

## 5.3 C++

不建议作为新 MSP Core 的默认选择。

原因：

- 内存安全主要依赖开发者规范
- AI 生成代码增加 use-after-free / dangling pointer 等风险
- 安全审查成本高
- 当前需求并不存在必须使用 C++ 才能达到的性能目标

---

# 6. MSP 的长期定位

建议 MSP 项目采用：

```text
                 MSP Specification
                        │
          ┌─────────────┴─────────────┐
          ▼                           ▼
  Swift Reference              Rust Reference
  Implementation               Implementation
          │                           │
          └──────── Conformance ──────┘
```

共享：

- Specification
- Conformance Fixtures
- Golden Tests
- AST semantics
- Workspace semantics
- Command semantics
- Redirection semantics
- Exit status
- Policy semantics
- Audit semantics

这能够验证：

> MSP 是真正独立于语言的 Runtime Specification，而不是 Swift API 的别名。

---

# 7. MSP-Rust 推荐仓库结构

初期可以：

```text
msp-rs/
├── Cargo.toml
├── src/
│   ├── lib.rs
│   ├── parser/
│   ├── ast/
│   ├── workspace/
│   ├── command/
│   ├── policy/
│   ├── executor/
│   ├── audit/
│   └── protocol/
│
├── tests/
├── fuzz/
└── examples/
```

成熟后再拆 Workspace：

```text
msp-rs/
├── crates/
│   ├── msp-core/
│   ├── msp-parser/
│   ├── msp-workspace/
│   ├── msp-policy/
│   ├── msp-command/
│   ├── msp-executor/
│   ├── msp-audit/
│   ├── msp-protocol/
│   └── msp-conformance/
│
├── fuzz/
├── tests/
├── examples/
└── Cargo.toml
```

不要第一天就拆成十几个 crate。

优先：

> 简单、清晰、可测试。

---

# 8. MSP Runtime 执行管线

所有执行必须经过统一管线：

```text
Input
 ↓
Lexer
 ↓
Parser
 ↓
AST
 ↓
Validation
 ↓
Expansion
 ↓
Workspace Path Resolution
 ↓
Command Resolution
 ↓
Policy Evaluation
 ↓
Execution Plan
 ↓
Executor
 ↓
Audit
 ↓
ExecutionResult
```

禁止某个工具绕过：

- Policy
- WorkspaceFS
- Audit

直接访问 Host。

---

# 9. 不要一开始完整实现 Bash

完整 Bash / POSIX shell 语义非常复杂。

V0.x 只实现 Agent 实际需要的子集。

推荐支持：

```text
command
arguments
quotes
|
>
>>
<
&&
exit code
```

暂缓：

```text
eval
source
shell function
job control
arbitrary scripts
复杂 glob
复杂 expansion
command substitution
宿主环境变量任意展开
```

目标不是：

> Bash Compatibility 100%

而是：

> 对 Agent 足够实用且可控的 MSP Shell Subset。

---

# 10. 结构化 AST 优先

例如模型想执行：

```bash
find /workspace -name '*.md' | grep TODO
```

内部应该转为：

```json
{
  "pipeline": [
    {
      "command": "find",
      "args": ["/workspace", "-name", "*.md"]
    },
    {
      "command": "grep",
      "args": ["TODO"]
    }
  ]
}
```

Executor 直接：

```text
AST
 ↓
Policy
 ↓
spawn(argv)
```

禁止重新拼接：

```bash
bash -c "..."
```

---

# 11. 核心数据模型

以下只是方向，不要求严格照抄。

```rust
pub struct ExecutionRequest {
    pub command: String,
    pub args: Vec<String>,
    pub workspace_id: WorkspaceId,
    pub stdin: Option<InputSource>,
}

pub struct ExecutionResult {
    pub status: ExecutionStatus,
    pub exit_code: Option<i32>,
    pub stdout: CapturedOutput,
    pub stderr: CapturedOutput,
    pub artifacts: Vec<Artifact>,
}

pub struct CommandSpec {
    pub name: String,
    pub runner: RunnerSpec,
    pub permissions: PermissionSet,
    pub limits: ResourceLimits,
}

pub enum RunnerSpec {
    Native,
    ExternalProcess,
    RemoteWorker,
    ConnectorRpc,
}
```

保持三条边界：

```text
Command != Runner
Intent != Execution
Policy != Executor
```

---

# 12. Tool Registry

绝对不要采用：

```text
PATH 里面有什么
        ↓
Agent 都可以使用
```

推荐：

```text
Installed Tool
      ↓
Tool Registry
      ↓
Command Registry
      ↓
Agent-visible Commands
```

只有显式注册的工具才可以被 Agent 看见。

---

# 13. Tool Manifest

建议定义自己的 Tool Manifest。

示例：

```yaml
name: prettier
version: "3.6.2"

commands:
  - name: prettier
    runner:
      type: process
      executable: prettier

permissions:
  filesystem:
    read:
      - /workspace
    write:
      - /workspace

  network: false

  secrets: []

resources:
  timeout: 30s
  memory: 256MiB
  cpu: 1
  processes: 32
  stdout: 1MiB
  stderr: 1MiB

risk:
  level: low
```

需要网络和 Secret：

```yaml
name: github-cli

commands:
  - name: gh
    runner:
      type: process
      executable: gh

permissions:
  filesystem:
    read:
      - /workspace

  network:
    allow:
      - api.github.com

  secrets:
    allow:
      - GITHUB_TOKEN

resources:
  timeout: 60s
  memory: 512MiB

risk:
  level: medium
```

---

# 14. Agent Tool Package

未来可以形成：

```text
agent-tool/
├── tool.yaml
├── package.json
├── README.md
└── policy.yaml
```

管理员：

```bash
agent tool install @example/github-tool
```

内部：

```text
download
 ↓
verify
 ↓
isolated install/build
 ↓
read manifest
 ↓
policy validation
 ↓
register commands
```

Agent 本身不应该拥有：

```bash
npm install arbitrary-package
```

的默认权限。

---

# 15. npm CLI 接入理念

npm CLI 是系统扩展能力的重要来源。

目标：

```text
npm package / CLI
      ↓
Tool Package
      ↓
Manifest
      ↓
Registry
      ↓
MSP Command
      ↓
Sandbox
```

优势：

- 不必为每个工具写 Rust wrapper
- 不必重新编译 Agent Core
- 复用巨大 npm 生态
- 工具升级与 Core 解耦

但 npm 包应视作：

> **不可信第三方代码**

因此必须运行在 Execution Plane。

---

# 16. WorkspaceFS

WorkspaceFS 是系统最重要的安全边界之一。

推荐概念接口：

```rust
trait WorkspaceFs {
    fn read(...);
    fn write(...);
    fn list(...);
    fn metadata(...);
    fn remove(...);
}
```

但接口接受：

```text
VirtualPath
```

而不是任意 Host Path。

---

# 17. VirtualPath 与 HostPath 必须类型分离

建议：

```rust
pub struct VirtualPath(...);
pub struct HostPath(...);
```

例如：

```text
VirtualPath("/workspace/test.txt")
           ↓
      Path Resolver
           ↓
HostPath("/var/lib/agent/ws/123/test.txt")
```

所有以下行为在 resolver 中统一处理：

- `..`
- `.`
- repeated slash
- symlink
- mount escape
- invalid encoding
- absolute host path
- path canonicalization

业务代码不应该自行拼 Host Path。

---

# 18. Workspace 生命周期

推荐：

```text
Create Workspace
       ↓
Restore / Mount
       ↓
Run Jobs
       ↓
Collect Artifacts
       ↓
Persist / Snapshot
       ↓
Destroy Sandbox
```

Workspace 数据与 Worker 生命周期分离。

因此：

- Worker 可随时销毁
- Workspace 可跨 Worker
- Worker 可以横向扩容

---

# 19. Policy Engine

所有执行产生一个显式 Decision：

```text
ExecutionRequest
       ↓
Policy Engine
       ↓
┌──────────────────┐
│ Allow            │
│ Deny             │
│ Require Approval │
└──────────────────┘
```

检查至少包括：

- Agent ID
- User ID
- Workspace ID
- Command
- Arguments
- Filesystem Read
- Filesystem Write
- Network
- Secrets
- Timeout
- Memory
- CPU
- PID
- Tool Risk
- 是否需要人工确认

---

# 20. Capability 模型

中后期建议从简单 allowlist 进化为 Capability。

示例：

```text
fs.read:/workspace
fs.write:/workspace/output
net.connect:api.github.com
secret.read:GITHUB_TOKEN
process.spawn:prettier
```

执行时：

```text
Command
  ↓
Required Capabilities
  ↓
Policy
  ↓
Granted Capability Set
  ↓
Sandbox
```

Sandbox 默认没有任何额外能力。

---

# 21. Secret 模型

默认情况下，Worker 不应继承 Core 的环境变量。

尤其不能自动传入：

```text
OPENAI_API_KEY
DATABASE_URL
QQ_TOKEN
ADMIN_TOKEN
JWT_SECRET
```

如果 Tool 需要：

```text
GITHUB_TOKEN
```

流程：

```text
Tool requires secret
       ↓
Policy
       ↓
Grant?
       ↓
Temporary injection
       ↓
Sandbox process
       ↓
Process ends
       ↓
Secret disappears
```

---

# 22. Rust Worker

Worker 建议 Rust 实现。

职责：

1. 接收 ExecutionJob
2. 验证 Job
3. 创建 Sandbox
4. 挂载 Workspace
5. 设置资源限制
6. 设置网络策略
7. 注入允许的 Secret
8. 启动 Process
9. 管理 stdin/stdout/stderr
10. timeout
11. cancellation
12. kill process tree
13. artifact collection
14. cleanup
15. 返回 ExecutionResult

---

# 23. Execution Job 协议

示例：

```json
{
  "job_id": "job_123",
  "workspace_id": "ws_456",
  "command": "prettier",
  "args": ["--write", "/workspace/a.ts"],
  "stdin": null,
  "limits": {
    "timeout_ms": 30000,
    "memory_mb": 256,
    "cpu": 1,
    "pids": 32,
    "stdout_bytes": 1048576,
    "stderr_bytes": 1048576
  },
  "network_policy": "none"
}
```

结果：

```json
{
  "job_id": "job_123",
  "status": "completed",
  "exit_code": 0,
  "stdout": "...",
  "stderr": "",
  "artifacts": []
}
```

通信协议初期可以采用：

- Unix Domain Socket
- HTTP
- JSON

规模上来后再考虑：

- gRPC
- Message Queue
- NATS
- Redis Streams
- 专用 Job Queue

不要过早增加分布式复杂度。

---

# 24. Resource Budget：防 OOM 的真正核心

所有输入和执行必须有明确上限。

至少定义：

```text
max_request_bytes
max_command_bytes
max_arg_count
max_arg_bytes
max_ast_nodes
max_parser_depth
max_pipeline_length
max_expansions

max_stdin_bytes
max_stdout_bytes
max_stderr_bytes

max_file_bytes
max_workspace_bytes
max_file_count

max_execution_time
max_memory
max_cpu
max_pids
max_concurrent_jobs
max_network_connections
```

原则：

> **任何来自 Agent、用户、CLI、网络的数据结构都不能默认无限增长。**

---

# 25. 有界队列

核心系统尽量禁止：

```text
unbounded queue
```

推荐：

```text
bounded queue
    +
backpressure
    +
explicit rejection
```

系统达到容量：

```text
queue full
   ↓
reject / retry / degrade
```

而不是：

```text
queue full
   ↓
continue allocating memory
   ↓
OOM
```

---

# 26. stdout / stderr 处理

CLI 可以输出无限数据。

错误模式：

```rust
let output = collect_everything_forever();
```

推荐：

```text
Process stdout
      ↓
Streaming Reader
      ↓
Byte Budget
      ↓
┌───────────────┬──────────────────┐
│ Small Output  │ Large Output     │
│ memory        │ spill to file    │
└───────────────┴──────────────────┘
```

达到上限：

- truncate
- mark truncated
- optionally terminate process
- write artifact if policy allows

ExecutionResult 必须包含：

```text
stdout_truncated
stderr_truncated
```

---

# 27. Parser 防御

Parser 输入来自模型，因此同样是不可信输入。

必须限制：

- input bytes
- token count
- token length
- AST node count
- nesting depth
- quote length
- pipeline length
- expansion count
- recursion

异常输入必须：

```text
return error
```

而不是 panic。

---

# 28. Rust Core 编码规则

建议 MSP Core 顶层：

```rust
#![forbid(unsafe_code)]
```

除非未来存在明确且经过审计的底层模块需要 unsafe。

如果确实需要：

```text
msp-core           forbid unsafe
msp-parser         forbid unsafe
msp-policy         forbid unsafe
msp-workspace      forbid unsafe

msp-platform-lowlevel
    ↓
isolated unsafe
    ↓
manual review
```

不要允许 unsafe 到处扩散。

---

# 29. panic 策略

请求处理路径禁止大量使用：

```rust
unwrap()
expect()
panic!()
```

特别是：

- 用户输入
- Agent 输入
- 网络输入
- 文件数据
- IPC 数据
- CLI 返回

应返回显式 Error。

可以考虑 CI lint：

```text
clippy
+
deny unwrap in production modules
```

测试代码可以适当放宽。

---

# 30. “用 Go 的风格写 Rust”

Agent 编程场景下，应避免让 AI 设计过度复杂 Rust。

避免：

```text
巨型泛型层
过度 trait abstraction
复杂 lifetime gymnastics
宏生成核心业务逻辑
Arc<Mutex<Arc<...>>>
```

优先：

```rust
struct ExecutionRequest {}
struct ExecutionResult {}
struct Workspace {}
struct CommandRegistry {}
struct PolicyEngine {}
struct WorkerClient {}
```

函数保持：

```text
parse()
validate()
resolve()
authorize()
plan()
execute()
audit()
```

原则：

> **Rust 提供严格性，代码风格保持简单。**

---

# 31. 错误模型

推荐定义稳定的 Error taxonomy。

例如：

```text
ParseError
ValidationError
WorkspaceError
PolicyDenied
CommandNotFound
ExecutorUnavailable
Timeout
ResourceLimitExceeded
ProcessFailed
ProtocolError
InternalError
```

不要把所有错误变成：

```text
"something went wrong"
```

但也不要把宿主敏感信息原样返回给 Agent。

---

# 32. Audit

每次执行至少记录：

```text
job_id
session_id
user_id
agent_id
tool
command
arguments (redacted if needed)
workspace
policy decision
capabilities
start time
end time
duration
exit code
resource usage
stdout summary
stderr summary
artifacts
failure reason
```

Secret 必须脱敏。

Audit 的目的：

- debug
- 安全调查
- 用户可解释性
- 统计
- 限额
- 重放/复现

---

# 33. Docker 部署

MVP 不建议把所有东西塞进一个容器。

推荐：

```text
docker-compose
│
├── web / agent-api
│
├── connector-onebot
│
├── msp-core
│
└── worker
```

也可以初期把 Agent API + MSP Core 合成一个 Rust/TS 服务，但 Worker 建议独立。

---

# 34. 推荐容器边界

```text
┌────────────────────────────┐
│ Agent / MSP Core Container │
│                            │
│ no npm                     │
│ no arbitrary CLI execution │
│ secrets available          │
└─────────────┬──────────────┘
              │
              ▼
┌────────────────────────────┐
│ Worker Container           │
│                            │
│ node                       │
│ npm CLI                    │
│ python                     │
│ git                        │
│ ffmpeg                     │
│ tools                      │
│ NO core secrets            │
└────────────────────────────┘
```

---

# 35. Worker Docker 安全基线

至少考虑：

```text
non-root user
read-only root filesystem
tmpfs /tmp
drop Linux capabilities
seccomp
PID limit
memory limit
CPU limit
workspace-only mount
no host root mount
no Docker socket
network default deny
```

绝对不要给 Agent Worker：

```text
/var/run/docker.sock
```

否则 Worker 可以间接控制 Host Docker Daemon。

---

# 36. Sandbox 演进路线

推荐安全隔离逐级升级：

```text
Level 0
direct host process
    ↓
仅开发调试

Level 1
Docker isolation
    ↓

Level 2
Docker
+ non-root
+ seccomp
+ cgroups
+ network policy
    ↓

Level 3
gVisor
    ↓

Level 4
microVM
Kata / Firecracker-like isolation
```

个人 / 小规模服务：

> Level 2 通常已经很实用。

允许陌生用户运行任意第三方包：

> 考虑 Level 3 / Level 4。

---

# 37. 网络权限

Worker 默认：

```text
network: deny
```

需要网络时：

```text
Tool Manifest
      ↓
allowed hosts
      ↓
Policy
      ↓
Sandbox network rule
```

理想：

```yaml
network:
  allow:
    - api.github.com
```

而不是：

```text
internet: unrestricted
```

---

# 38. OneBot / Messaging 适配层

不要让 MSP Core 直接理解 QQ。

统一内部事件协议：

```json
{
  "platform": "qq",
  "account": "bot1",
  "conversation": "group:123456",
  "sender": "987654",
  "type": "message",
  "content": "帮我处理这个文件"
}
```

输出也统一：

```text
SendMessage
Reply
UploadFile
Reaction
```

平台 Connector：

```text
OneBot Adapter
Telegram Adapter
Discord Adapter
```

只是协议转换层。

---

# 39. 是否把 Messaging Action 做成 Command

可以。

例如：

```text
qq.send
qq.reply
message.history
attachment.download
```

但应区分：

```text
External Process Command
```

与：

```text
Trusted RPC Command
```

Messaging RPC 不需要进入 npm Sandbox。

---

# 40. Agent Core 是否迁 Rust

短期不强制。

当前：

```text
WebUI               TS
Agent orchestration TS
OneBot connector    TS
Executor            TS
```

推荐迁移顺序：

```text
1. MSP Core → Rust
2. Worker → Rust
3. Executor/Sandbox → Rust
4. Policy/Workspace → Rust
5. Agent Core → optional
```

只有以下情况出现时再迁 Agent Core：

- Session 数量高
- Task 状态机复杂
- 调度成为核心
- 长连接规模大
- 内存占用明显
- 单 Binary 部署成为目标

---

# 41. 横向扩容

执行层天然应该支持：

```text
              Agent Core
                  │
                Queue
          ┌───────┼───────┐
          ▼       ▼       ▼
       Worker1  Worker2  Worker3
```

ExecutionJob 不应依赖某个 Worker 的本地状态。

需要持久化的是：

```text
Workspace
Job metadata
Artifacts
Audit
```

Worker 应该尽量无状态。

---

# 42. 调度原则

Scheduler 初期只需要：

```text
available worker
      ↓
assign job
```

后期再增加：

```text
tool capability
architecture
memory requirement
GPU
network policy
workspace locality
priority
tenant
```

例如：

```text
Worker A: node, python
Worker B: ffmpeg, node
Worker C: GPU
```

Job 指定：

```text
requires: ["node", "playwright"]
```

Scheduler 再匹配。

---

# 43. Multi-Architecture Docker

最终建议发布：

```text
linux/amd64
linux/arm64
```

Docker Image 采用 multi-arch manifest。

Rust binary、Node runtime、第三方 native CLI 必须分别构建对应架构。

---

# 44. 构建镜像与运行镜像分离

Rust：

```text
rust builder
   ↓
cargo build --release
   ↓
runtime image
```

TS：

```text
node builder
   ↓
npm build
   ↓
runtime/static
```

最终运行镜像不要包含：

```text
rustc
cargo
gcc
源码
.git
dev dependencies
```

除非 Worker 本身需要编译用户代码。

---

# 45. Worker Tool Image

后期可将不同工具拆成不同 Worker 镜像：

```text
worker-base
worker-node
worker-python
worker-browser
worker-media
worker-dev
```

例如：

```text
worker-node
├── node
├── npm
├── prettier
└── eslint
```

这样不必打造一个几 GB 的万能 Worker。

---

# 46. Dynamic Tool Install

第一阶段：

> 工具在 Docker build 时由管理员预装。

第二阶段：

> 管理员通过 `agent tool install` 安装。

第三阶段才考虑：

> Agent 请求动态安装。

动态安装必须：

```text
download
 ↓
isolated builder
 ↓
dependency install
 ↓
build immutable tool image
 ↓
register digest
 ↓
run in sandbox
```

不要在 Core Container：

```bash
npm install
```

---

# 47. Supply Chain

未来 Tool Package 应记录：

```text
package name
version
registry
lockfile
digest
image digest
install time
publisher
risk
permissions
```

执行尽可能按 digest 固定：

```text
tool@sha256:...
```

避免工具在无人知晓时被升级。

---

# 48. 测试战略

安全 Runtime 不能只依赖 unit tests。

推荐：

```text
Unit Tests
   +
Integration Tests
   +
Conformance Tests
   +
Property Tests
   +
Fuzz Tests
   +
Chaos / Failure Tests
```

---

# 49. Unit Tests

重点：

- VirtualPath
- normalization
- Policy
- AST
- quote parsing
- pipeline
- limits
- error classification

---

# 50. Conformance Tests

Swift 与 Rust 实现必须尽量跑相同 Fixture。

示例：

```text
input command
     ↓
expected AST
expected stdout
expected stderr
expected exit
expected workspace mutations
```

这样能够检测两个实现语义漂移。

---

# 51. Fuzzing

最应该 fuzz 的部分：

```text
lexer
parser
virtual path
manifest parser
execution protocol decoder
policy decoder
```

目标：

```text
任何随机输入
   ↓
不能 panic
不能越界
不能无限执行
不能产生 host path escape
```

---

# 52. Property Testing

适合定义不变量：

```text
normalize(path)
永远不能超出 Workspace

parse → serialize → parse
应该保持等价 AST

Denied capability
永远不能被 Executor 执行
```

---

# 53. Chaos / Failure Tests

模拟：

```text
Worker sudden death
process hang
stdout flood
disk full
OOM kill
network timeout
queue full
workspace missing
partial artifact
connector disconnected
```

Agent Core 应保持可恢复。

---

# 54. Observability

核心指标：

```text
active_sessions
queued_jobs
running_jobs
worker_count
job_duration
job_failure_rate
timeout_count
policy_denied_count
OOM_kill_count
stdout_truncated_count
workspace_bytes
memory_usage
```

日志与 Audit 要区分：

```text
Operational Log
Security Audit
User-visible Execution Log
```

---

# 55. AI 编程规范

由于项目大量依赖 Agent 编程，需要把 AI 当作：

> 高产但不完全可信的开发者。

必须设计机器可检查的约束。

---

# 56. AI 生成 Rust 的仓库规则

建议写入 `AGENTS.md` / `CONTRIBUTING.md`：

```text
1. MSP Core 禁止 unsafe。
2. 请求处理路径禁止 unwrap/expect。
3. 禁止 bash -c / sh -c。
4. 所有 Process 使用 argv，不拼接 shell string。
5. 所有外部输入有大小限制。
6. 所有输出有大小限制。
7. 所有 Parser 有深度/节点限制。
8. 所有 Queue 必须 bounded。
9. 所有 Process 必须 timeout。
10. Workspace Path 必须通过 Resolver。
11. Command 必须经过 Policy。
12. Execution 必须产生 Audit。
13. Core 不向 Worker泄露默认环境变量。
14. 新增 Tool 必须有 Manifest。
15. 新增 Parser 行为必须加 Conformance Test。
16. 新增安全边界代码必须有 negative test。
```

---

# 57. CI 基线

每次 PR：

```text
cargo fmt --check
cargo check
cargo clippy
cargo test
conformance tests
security-focused tests
```

定期：

```text
fuzzing
dependency audit
container scan
```

如果未来使用 `cargo-deny` / `cargo-audit`，可加入依赖治理流程。

---

# 58. Dependency 原则

Core 依赖越少越好。

引入 dependency 前回答：

1. 是否真的需要？
2. 是否处于安全关键路径？
3. 项目是否维护活跃？
4. 是否带大量 transitive dependencies？
5. 是否包含 unsafe？
6. 是否可以用标准库简单实现？
7. 是否增加跨平台难度？

不要为了节省几十行代码引入大型依赖树。

---

# 59. 数据库职责

数据库保存：

```text
users
sessions
conversation metadata
job metadata
tool registry
policy config
workspace metadata
audit index
```

不要把运行中巨大 stdout 直接无限塞数据库。

大型输出：

```text
artifact storage
```

更合理。

---

# 60. Artifact 模型

Agent 执行产生：

```text
image
pdf
code
archive
large log
generated file
```

统一作为 Artifact。

```json
{
  "id": "artifact_123",
  "workspace_id": "ws_1",
  "path": "/output/report.pdf",
  "mime": "application/pdf",
  "size": 123456,
  "sha256": "..."
}
```

---

# 61. MVP 开发阶段

## Phase 0：冻结架构边界

目标：

- 写下 Rust / TS 模块边界
- 定义 Command
- 定义 Workspace
- 定义 ExecutionRequest / Result
- 定义 Policy 最小接口

验收：

- 文档完成
- 不开始复杂 Sandbox
- 不重写 WebUI

---

## Phase 1：MSP-Rust 最小 Core

实现：

```text
Parser
AST
Command Registry
WorkspaceFS
VirtualPath
Policy allow/deny
Audit
Local Executor adapter
```

支持：

```text
command
args
|
>
<
&&
```

验收：

- 不使用 bash -c
- path traversal tests 通过
- malformed parser input 不 panic
- 基础 conformance cases 通过
- `#![forbid(unsafe_code)]`

---

## Phase 2：Rust Worker

实现：

```text
Execution Job API
Worker daemon
process spawn
timeout
kill
stdin
stdout
stderr
output limits
workspace mount
```

验收：

- Core 与 Worker 分进程
- Worker 崩溃不带走 Core
- stdout flood 不 OOM Core
- timeout 可以 kill process tree
- malformed Job 不 panic

---

## Phase 3：Docker Sandbox

加入：

```text
non-root
cgroup resource limits
PID limit
read-only rootfs
workspace mount
network deny
environment filter
```

验收：

- Worker 看不到 Core secrets
- 不能读取 host `/etc`
- 不能挂载 Docker socket
- npm CLI 可以正常运行
- 超内存任务被隔离终止

---

## Phase 4：Tool Registry / Manifest

实现：

```text
tool.yaml
Command registration
permissions
limits
risk
version
digest
```

验收：

```text
prettier
git
ffmpeg
```

等工具可通过统一 Registry 执行。

---

## Phase 5：接回现有 TS Agent

结构：

```text
Existing TS Agent
       ↓
MSP API
       ↓
Rust Core
       ↓
Worker
```

现有 WebUI、OneBot 不重写。

验收：

- 用户可以 QQ 请求 Agent
- Agent 调用 MSP Command
- Worker 执行 CLI
- 结果返回聊天
- Audit 完整

---

## Phase 6：多 Worker

实现：

```text
Job Queue
Worker registration
health
scheduler
retry
```

验收：

- 一个 Worker 宕机不影响系统
- Job 能分发到多个 Worker
- Worker 可独立扩容

---

## Phase 7：加强隔离

按需求加入：

```text
gVisor
advanced network policy
ephemeral sandbox
per-session sandbox
```

此阶段才开始面向不完全可信的外部用户开放更自由的代码执行。

---

# 62. V1.0 非目标

为了控制复杂度，V1 不追求：

- 完整 Bash compatibility
- 任意 host command
- Agent 任意 npm install
- Kubernetes 必选
- microVM 必选
- 全部后端重写 Rust
- WebUI 重写 Rust
- OneBot 重写 Rust
- 所有平台一次实现
- 完整 distributed scheduler

---

# 63. 推荐 Monorepo 结构

整体项目可采用：

```text
agent-platform/
├── apps/
│   ├── web/                    # TypeScript WebUI
│   ├── connector-onebot/       # TypeScript
│   └── agent-orchestrator/     # TS initially
│
├── rust/
│   ├── msp-core/
│   ├── worker/
│   └── agent-core/             # optional future
│
├── packages/
│   ├── protocol/
│   └── sdk/
│
├── tools/
│   ├── prettier/
│   ├── github/
│   └── ffmpeg/
│
├── deploy/
│   ├── docker/
│   └── compose/
│
├── docs/
│   ├── architecture.md
│   ├── security.md
│   └── tool-spec.md
│
└── tests/
    └── conformance/
```

如果 MSP-Rust 希望成为独立上游项目，则：

```text
MSP/
└── rust implementation

Agent Project
└── dependency on MSP-Rust
```

比完全嵌进 Agent 仓库更合适。

---

# 64. Rust Core 与 TS 的通信协议

初期优先简单。

推荐：

```text
HTTP + JSON
```

或者同机：

```text
Unix Socket + JSON
```

原因：

- Debug 简单
- TS/Rust 都好用
- AI 更容易生成
- 抓包容易
- 不必一开始引入 protobuf

稳定后再考虑 gRPC。

---

# 65. API 最小集合

例如：

```text
POST /v1/executions
GET  /v1/executions/{id}
POST /v1/executions/{id}/cancel

GET  /v1/tools
GET  /v1/workspaces/{id}

POST /v1/policy/evaluate
```

但不要让公开 API 与内部模块边界强耦合。

---

# 66. Execution 状态机

推荐：

```text
Created
  ↓
Validated
  ↓
Authorized
  ↓
Queued
  ↓
Running
  ↓
┌──────────┬───────────┬───────────┐
▼          ▼           ▼           ▼
Succeeded  Failed      TimedOut    Cancelled
```

额外：

```text
Rejected
WorkerLost
ResourceExceeded
```

状态迁移应显式，避免到处 boolean：

```text
is_running
is_done
failed
cancelled
...
```

---

# 67. Idempotency

Job 创建接口建议支持：

```text
idempotency key
```

避免连接重试导致 Agent 同一个破坏性命令运行两次。

特别是：

```text
send message
git push
delete
upload
external API mutation
```

---

# 68. Cancellation

Cancellation 必须贯穿：

```text
User cancel
   ↓
Agent
   ↓
MSP
   ↓
Worker
   ↓
Process tree
```

不能只是 UI 显示“取消”，实际 CLI 继续运行。

---

# 69. Process Tree

终止一个 Process 时，需要考虑它启动的子进程。

```text
worker
  ↓
npm
  ↓
node
  ↓
child
```

Timeout 时必须能够清理整棵进程树。

这也是 Worker / Sandbox 比简单 `spawn()` 更重要的原因。

---

# 70. 文件写入事务与原子性

对重要文件可使用：

```text
write temporary
      ↓
fsync if needed
      ↓
atomic rename
```

避免 Agent 或 Worker 崩溃留下半写文件。

---

# 71. 用户确认模型

高风险命令：

```text
delete
external publish
send email
git push
money-related operation
credential use
```

Policy 可以返回：

```text
RequireApproval
```

而不是简单 Allow / Deny。

---

# 72. Risk Level

Tool Manifest 可以声明：

```text
low
medium
high
critical
```

但 Risk Level 只是 Policy 输入之一。

不能信任第三方工具自己声称：

```text
risk: low
```

最终风险等级由管理员 / Registry Policy 确定。

---

# 73. 安全信任边界图

```text
User Input
    │
    ▼
Connector
    │      不可信
────┼────────────────────────────
    ▼
Agent Core
    │      半可信模型输出
    ▼
MSP Parser / Validation
    │
    ▼
Policy
    │      Trusted boundary
────┼────────────────────────────
    ▼
Execution Job
    │
    ▼
Worker
    │
────┼──────── Sandbox boundary ──
    ▼
npm / python / user code
```

关键认识：

> **LLM 输出本身也是不可信输入。**

不能因为它来自“自己的 Agent”就绕过校验。

---

# 74. 威胁模型

至少考虑以下攻击面。

## Agent / 用户输入

- parser bomb
- giant string
- deeply nested structure
- path traversal
- command injection
- malicious args

## Tool

- malicious npm package
- install script
- secret exfiltration
- network exfiltration
- fork bomb
- disk fill
- stdout flood

## Worker

- sandbox escape
- privilege escalation
- mount abuse
- Docker socket access

## Protocol

- oversized message
- spoofed worker
- replay
- duplicate job
- malformed JSON

## Supply Chain

- compromised dependency
- changed npm package
- typo-squatting
- mutable latest version

---

# 75. 不变量（Security Invariants）

项目应明确以下不变量，并用测试保证。

### Invariant 1

> Agent 不能直接获得 Host Path。

### Invariant 2

> 未注册的 Command 不能执行。

### Invariant 3

> Policy Deny 的 Execution 永远不能到达 Executor。

### Invariant 4

> Worker 默认不能读取 Core Secrets。

### Invariant 5

> 所有进程都有资源上限。

### Invariant 6

> 所有 Job 都必须留下 Audit。

### Invariant 7

> Worker 崩溃不能导致 Agent Core 崩溃。

### Invariant 8

> npm CLI 永远不与 Agent Core 处于同一信任域。

---

# 76. 性能目标

当前项目不需要追求极端微基准。

真正关心：

```text
Core 长时间运行稳定
低 idle memory
有界内存
大量 Session 不线性失控
Worker crash isolation
高并发 Job dispatch
stdout streaming 不复制巨大 buffer
```

LLM Agent 的端到端延迟通常由：

```text
Model API
Network
Tool
CLI
Database
```

主导。

因此不要为了几十微秒复杂化 Core。

---

# 77. 性能优化优先级

依次：

1. 消除无界内存
2. Streaming
3. 减少巨大 Clone
4. 限制并发
5. Profiling
6. Worker reuse
7. Scheduler
8. Serialization 优化

不要一开始：

```text
unsafe optimization
custom allocator
zero-copy everywhere
```

---

# 78. MSP Rust Reference Implementation 的开发原则

如果作为 MSP 官方或半官方 Rust 实现：

1. Spec 优先于 Swift 实现细节。
2. Swift 行为与 Spec 冲突时应讨论 Spec，而不是机械复制 Bug。
3. 所有语义差异形成 issue / ADR。
4. Swift 和 Rust 共享 Conformance Test。
5. Rust 特有优化不能改变 observable behavior。
6. Platform-specific 能力通过 adapter，而不是污染 Core。

---

# 79. 平台能力不要全部塞进 Rust Core

例如：

```text
iOS Photos
Android SAF
Windows Credential Store
macOS Security Scoped Bookmark
```

应该：

```text
Platform Adapter
      ↓
MSP Core trait/interface
```

Rust Core 定义：

```text
WorkspaceBackend
CommandBackend
SecretProvider
PolicyProvider
```

平台负责实现。

---

# 80. Architecture Decision Records（ADR）

建议重要决策写 ADR。

例如：

```text
ADR-001 Use Rust for MSP Core
ADR-002 Control Plane / Execution Plane Separation
ADR-003 No bash -c
ADR-004 Virtual Workspace Paths
ADR-005 Bounded Resources Everywhere
ADR-006 TypeScript Connectors Remain
ADR-007 External Tools Run in Sandbox
```

未来有人问：

> 为什么不直接 spawn bash？

可以直接看 ADR，而不是重新争论一次。

---

# 81. 推荐第一批 ADR

## ADR-001：MSP Core 使用 Rust

理由：

- memory safety
- cross-platform
- FFI
- no GC
- runtime suitability

约束：

- forbid unsafe
- simple Rust
- bounded resources

---

## ADR-002：Execution Plane 独立

理由：

- 第三方 CLI 不可信
- Worker crash isolation
- 横向扩容

---

## ADR-003：禁止 Shell String Execution

禁止：

```text
sh -c
bash -c
cmd.exe /C
PowerShell -Command <model generated>
```

除非未来成为明确受限 Tool，并具有独立高风险 Policy。

---

# 82. 推荐开发顺序总结

```text
现在
 │
 ├─ 保留 TS WebUI
 ├─ 保留 TS OneBot
 ├─ 保留 TS Agent
 │
 ▼
开发 MSP-Rust
 │
 ▼
WorkspaceFS
 │
 ▼
Policy
 │
 ▼
Rust Worker
 │
 ▼
Docker Sandbox
 │
 ▼
npm CLI Tool Registry
 │
 ▼
接回 TS Agent
 │
 ▼
多个 Worker
 │
 ▼
gVisor / stronger isolation
 │
 ▼
决定是否把 Agent Core 迁 Rust
```

---

# 83. 推荐 V0.1 最小可运行 Demo

第一版不要做聊天系统全链路。

只做：

```text
CLI Client
   ↓
MSP-Rust
   ↓
Policy
   ↓
Worker
   ↓
Docker Sandbox
   ↓
prettier
```

例如：

```text
用户提交 Workspace
        ↓
执行 prettier
        ↓
修改 a.ts
        ↓
返回 diff / artifact
```

这个 Demo 就能验证：

- Parser
- Workspace
- Policy
- Worker
- npm CLI
- Docker
- Output
- Audit

核心架构全部贯通。

---

# 84. 第二个 Demo

```text
Agent
 ↓
MSP Command
 ↓
ffmpeg
 ↓
input/video.mp4
 ↓
output/audio.mp3
```

验证：

- 大文件
- streaming
- timeout
- artifact
- CPU limits

---

# 85. 第三个 Demo

```text
QQ
 ↓
OneBot TS
 ↓
Agent
 ↓
MSP
 ↓
prettier / grep / file
 ↓
QQ reply
```

验证产品全链路。

---

# 86. 开发验收 Checklist

## MSP Core

- [ ] `#![forbid(unsafe_code)]`
- [ ] parser malformed input 不 panic
- [ ] parser 有 size/depth limit
- [ ] Command Registry 显式注册
- [ ] 不使用 shell string execution
- [ ] Workspace 使用 VirtualPath
- [ ] path traversal tests
- [ ] Policy deny 无法执行
- [ ] Execution 产生 Audit

## Worker

- [ ] Worker 与 Core 分进程
- [ ] timeout
- [ ] process tree kill
- [ ] stdout limit
- [ ] stderr limit
- [ ] memory limit
- [ ] PID limit
- [ ] CPU limit
- [ ] environment allowlist
- [ ] network policy
- [ ] cleanup

## Docker

- [ ] non-root
- [ ] no Docker socket
- [ ] restricted mounts
- [ ] read-only rootfs where possible
- [ ] cgroup limits
- [ ] seccomp
- [ ] temporary workspace
- [ ] Core Secrets 不进入 Worker

## Tool

- [ ] Manifest
- [ ] version pin
- [ ] permissions
- [ ] limits
- [ ] risk
- [ ] digest
- [ ] registry entry

---

# 87. 给 AI 编程 Agent 的项目级 Prompt 原则

可以将以下内容放进仓库说明：

> 本项目是安全敏感的 Agent Runtime。任何来自用户、模型、网络、文件和 Worker 的输入均视为不可信。优先简单、安全、可测试的实现。不要使用 `unsafe`，不要使用 `bash -c` 或其他字符串 Shell 执行。所有队列、输入、输出、递归、并发和进程都必须有显式上限。任何 Workspace 路径必须经过 VirtualPath Resolver。任何 Command 必须经过 Registry 和 Policy。新增安全相关行为必须同时新增失败测试或 Conformance Test。不要为了抽象而增加复杂泛型、宏或 trait 层级。

---

# 88. 最终架构目标

成熟后的系统可以表现为：

```text
                       USERS
                         │
       ┌─────────────────┼─────────────────┐
       ▼                 ▼                 ▼
      QQ                Web             API
       │                 │                 │
       ▼                 ▼                 ▼
 Connectors           WebUI          API Gateway
       └─────────────────┬─────────────────┘
                         │
                         ▼
                ┌──────────────────┐
                │   Agent Runtime  │
                │                  │
                │ LLM              │
                │ Sessions         │
                │ Memory           │
                │ Scheduler        │
                └────────┬─────────┘
                         │
                         ▼
                ┌──────────────────┐
                │   MSP-Rust Core  │
                │                  │
                │ Parser           │
                │ WorkspaceFS      │
                │ Commands         │
                │ Policy           │
                │ Audit            │
                └────────┬─────────┘
                         │
                      Job Queue
                         │
            ┌────────────┼────────────┐
            ▼            ▼            ▼
         Worker        Worker       Worker
            │            │            │
         Sandbox      Sandbox      Sandbox
            │            │            │
        npm/python    ffmpeg      browser/etc.
```

最终最核心的系统理念可以浓缩成一句：

> **MSP 将 Agent 的“意图”变成受控、可组合、可审计的计算；Rust 保证控制边界本身尽可能可靠；Sandbox 负责承受不可信代码。**

---

# 89. 项目当前推荐决策

当前阶段建议立即采用：

| 模块 | 语言 / 技术 | 决策 |
|---|---|---|
| WebUI | TypeScript | 保留 |
| OneBot Connector | TypeScript | 保留 |
| Agent Orchestration | TypeScript | 暂时保留 |
| MSP Core | Rust | 新建 |
| WorkspaceFS | Rust | 新建 |
| Policy | Rust | 新建 |
| Audit | Rust | 新建 |
| Worker | Rust | 新建 |
| npm CLI | Node.js | Sandbox 内运行 |
| Python CLI | Python | Sandbox 内运行 |
| Runtime Deployment | Docker | 使用 |
| Worker Isolation | Docker+cgroup/seccomp | V0.x |
| Strong Sandbox | gVisor/microVM | 后续 |
| Full Bash Compatibility | 不做 | 非目标 |

---

# 90. 最后结论

项目不应该被设计成：

```text
LLM
 ↓
万能 Bash
 ↓
宿主系统
```

而应该是：

```text
LLM
 ↓
Structured Intent
 ↓
MSP Runtime
 ↓
Policy
 ↓
Workspace
 ↓
Command Registry
 ↓
Isolated Worker
 ↓
CLI / Code / API
```

语言不是最终安全来源。

真正的安全来源是：

```text
简单的 Rust Core
      +
明确的信任边界
      +
严格的 Policy
      +
Virtual Workspace
      +
有限资源
      +
隔离 Worker
      +
Conformance/Fuzz Tests
      +
Audit
```

这一架构能够同时满足：

- Agent 编程效率
- npm CLI 扩展能力
- Rust 核心稳定性
- Docker 部署
- 安全隔离
- 未来横向扩容
- MSP 跨语言规范化

并且允许当前 TypeScript 项目逐步迁移，而不是进行一次高风险的整体重写。
