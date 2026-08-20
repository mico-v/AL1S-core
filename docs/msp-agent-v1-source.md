---
name: msp-agent-v1-source
description: MSP AgentBridge v1 协议来源和本地模拟器边界
metadata:
  type: project
---

本项目的 MSP 接入协议快照来源于 `/home/x/github.com/Nian2026/MSP` 工作树，重点文件为：

- `Spec/AgentBridge/LinuxRuntimeContract.md`
- `Spec/AgentBridge/ExecCommandProfile.md`
- `Spec/AgentBridge/ErrorCodes.md`
- `Spec/AgentBridge/ToolContracts.md`
- `Spec/Schemas/AgentBridge/v1/exec_command.input.schema.json`
- `Spec/Schemas/AgentBridge/v1/write_stdin.input.schema.json`

该工作树可能包含未提交内容；AL1S-core 不在运行时读取或 import 该目录，而是在 `src/msp/protocol/` 保存行为快照。当前 `local-bash` 只用于开发模拟，不能视为 full MSP runtime 或生产沙箱。
