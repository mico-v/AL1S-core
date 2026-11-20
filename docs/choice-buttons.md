# 选项卡片（按钮）

> 2026-11-21 落地。目的：Kei 要主人拍板时，别再让人手打「B」—— 发一排按钮，点一下就算回答。

## 平台侧事实（2026-11-21 核对官方文档）

官方文档站（`bot.q.qq.com/wiki/develop/api-v2/`）是 SPA，仓库 `tencent-connect/bot-docs` 停在 2025-04-21，
内容已经落后：线上比它多了 `autogen`（群 / 单聊全套接口）、`agent-qqbot`、`menu-panel`、`panels`。
最新变更记录见 `docs/qq-api/changelog.md`，要点：

- **2026/04/23**：单聊、群聊的自定义 Markdown 与**消息按钮已对全部机器人开放**，不用申请模板；频道仍需内邀。
- **2026-11-17**：群消息被动回复有效期 5 分钟 → 60 分钟，条数 5 → 50（机器人管理员是群主/管理员时）。
- **2026-10-28**：群聊/单聊支持图文卡片 `msg_type=8`（`card`）。
- **2026-10-26**：群聊 `@全体成员`（`<qqbot-at-everyone />`，需管理员、每天 1 次）。
- **2026-08-12**：自定义菜单（仅 C2C）与指令面板（C2C / 群 / 频道 / 频道私信）接口。

按钮本身：挂在 `keyboard` 字段，`action.type=1` 是回调按钮，点击推 `INTERACTION_CREATE`（intents `1<<26`），
机器人必须 `PUT /interactions/{id}` 回应，否则客户端一直转圈；回应窗口只有 3 秒。
`group_id` 让同一组按钮点一个、其余自动变灰，正好表达「选完了」。

## 我们怎么做

- `src/agent/choices.ts`：造键盘、渲染正文、待选卡片落盘（`data/choices/<会话>.json`，24 小时过期，一次性取走）。
- `ask_choice` 工具：只有主人档才注入（`access.tier === 'owner'` 且注入了回调），guest / dev 看不到也调不到。
- 发卡片走 `Bot.pushMarkdown`（主动推送 + `keyboard`），不带 `msg_id`：卡片要挂一整天，被动回复窗口撑不住。
- 点击 → `ChatAgent.handleChoice()`：校验点击人是主人 → 取回待选项 → 合成一条「（点了按钮）B：…」的用户消息，
  照常走 `handle()`。上下文、权限档、目标续跑、缓冲落盘全部复用，不另开一条路径。
- 按钮权限用 `permission.type=0` + `specify_user_ids=[主人 openid]`：群里别人点了只会弹「没有权限」。

## 验证

- 离线：`pnpm agent:check` 第 [25] 节（data 编解码、键盘结构、过期/一次性、工具门控、人格口径）。
- 在线：让 Kei 在单聊或工程群发一张卡片，点一下看是否回一条「已选 X」并继续干活。

## 还没做

- 指令面板（`/v2/panels`）：群聊里固定展示的指令/链接面板，适合放「/goal」「/status」这类常驻入口。
- 图文卡片 `msg_type=8`：一条卡片带标题 + 描述 + 链接 + 图，比 markdown 更适合推 PR/issue 摘要。
- 按钮点击后改消息（`PATCH`）：群聊暂未开放，靠 `group_id` 变灰替代。
