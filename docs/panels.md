# 指令面板（`/v2/panels`）

群聊 / 单聊里长期挂着的一排入口。点一下把文字填进输入框（`type=command`），
或直接开浏览器（`type=link`）。

和消息按钮（`choices.ts`）分工不同：按钮是一次性的、用来拍板；面板是常驻的、
用来随手查。面板元素点了之后用户还得自己按发送，所以只放「不走模型、立刻回」的指令。

## 声明在哪

内容与约束都在 `src/agent/panels.ts`：

- `buildPanel(scope)` 声明单聊 / 群聊各放什么
- `validatePanel(spec)` 校验平台限制，**并且要求每个 `command` 元素真被指令解析器认**
- `ensurePanel(api, spec, { targetType, openids })` 对账：新建 / 更新 / 重建 / 跳过

线上对账用脚本：

```
pnpm qq:panel                # 单聊按 AGENT_OWNER_OPENIDS、群聊按 AGENT_GROUPS
pnpm qq:panel --scope group  # 只弄群聊
pnpm qq:panel --all          # 改成该场景所有人可见（target_type=all）
pnpm qq:panel --list         # 只看线上现有面板
pnpm qq:panel --dry-run      # 只校验内容，不碰接口
```

幂等，重复跑只有第一次动接口。改动 `panels.ts` 后跑一次即可，不用重启进程。

## 平台约束（2026-11-21 实测/核对）

- scope 四选一 `c2c` / `group` / `channel` / `dm`；只有 `c2c` 与 `group` 支持
  `target_type=specific`（按用户 / 按群生效），channel 与 dm 只能 `all`
- 一个机器人最多 20 个面板，一个面板最多 20 个元素
- `name` ≤14 字符（约 7 个汉字）、`desc` ≤30 字符（约 15 个汉字）
- 更新接口（`PUT /v2/panels/{id}`）**只改内容不改作用范围**，想改范围必须删掉重建
- **`name` 里的前导 `/` 会被平台规范掉**：写 `/status` 存回来是 `status`。
  所以面板里写不带斜杠的名字，`sameItems()` 也比较前抹平，否则每次对账都误判成「变了」
- 对账靠 `panel.remark` 认领（`kei-commands`），别人的面板一律不碰

## 踩过的坑

- 面板里的指令必须真被 `matchCommand` / `matchGoalCommand` 认，否则点一下发出去
  会被当成「别人的命令」静默丢掉。`validatePanel` 把这条写成断言，自检里也守着。
- `/goal` 系列只在群聊生效（单聊分支直接跳过），所以单聊面板不放 `goal`；
  `validatePanel` 按 scope 判这条。
