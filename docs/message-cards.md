# 图文卡片（msg_type=8）

一条卡片＝标题 + 一句说明 + 配图 + 可点的链接。PR / issue 交付、构建结果、方案对比这类
「一条摘要 + 一个链接」的东西，比一长串文字好读。

2026-11-21 落地，代码 `src/agent/cards.ts` + 工具 `send_card`。

## 平台口径（2026-11-21 核对官方文档）

- 20261028 起开放，**群聊与单聊都能发**；频道场景不支持。
- 请求体挂 `card` 字段，`msg_type=8` 时必填，与 `markdown` / `media` 互斥。
- `card.type` 目前只有 `tuwen`（图文卡片）一种取值。
- 硬限制：`title` 1–50 字符、`description` 1–200 字符、`url` 与 `pic_url`
  必须是 https 且 ≤1024 字符。
- SDK `@tencent-connect/qqbot-nodejs` 的 `MsgType` 枚举只到 7，但 `send()` 支持
  `extra` 透传，所以 `Bot.pushCard()` 用 `extra: { card }` 发，不改依赖。
- **配图由平台自己转存**（实测 2026-11-21）：国内不可达的图直接 400
  `图片转存失败，请重试` —— `https://avatars.githubusercontent.com/...` 挂了，
  `https://q1.qlogo.cn/g?b=qq&nk=<qq>&s=640` 一次过。所以 `send_card` 的配图
  优先选腾讯 CDN / 国内图床，拿不到就别发卡片，改用 markdown 正文。

本地文档镜像已同步：`docs/qq-api/autogen/api/v2_{groups,users}_*_messages.post.md`
补了 `card` 字段与 `MessageCard` 表，`docs/qq-api/server-inter/message/type/overview.md`
补了 8 号类型。

## 代码怎么走

- `buildCard(input)`：文字压成一行、按上限裁剪（超了补 `…`），
  链接不是 https 或超长就整张不发 —— 发一张点不动的卡片比不发更糟。
  返回 `{ card }` 或 `{ error }`。
- `Bot.pushCard(target, card)`：主动推送（丢掉 `msgId`）。卡片要挂在会话里看得见，
  不受被动回复窗口约束。
- 工具 `send_card`（`title` / `description` / `url` / `pic_url`）：只在开发档以上注入
  （`caps.repoRead` 且注入了 `sendCard`），guest 看不到也就不会去试。
- `ChatAgent` 里发送成功后把 `（发了图文卡片：标题 链接）` 补进群聊缓冲，
  这样它自己下一轮、以及 `search_messages` 都能看到「发过这张卡」。
- `pnpm qq:card [--to <openid>] [--dry-run] [--title/--desc/--url/--pic]`：手动验证通道，
  走的是线上同一个 `Bot.pushCard()`；默认发给 `AGENT_OWNER_OPENIDS` 的第一个人。

## 人格口径（`personas` / `persona.ts`）

- 卡片不是长文：标题 ≤50 字、说明 ≤200 字，细节留在链接里。
- 配图拿不到 https 图就别硬凑，换成 markdown 正文，别发裂图。
- 一轮最多一张；发完补一句结论，不要把卡片内容再抄一遍。

## 自检

`pnpm agent:check` 第 `[27]` 节 17 条：卡片结构、标题/说明裁剪、换行压平、
`pic_url` 字段名、http 与超长链接被拦、缺字段整张不发、工具可见性、
非法链接不落到发送层、人格口径。

## 还没做

- 卡片 + 按钮同发：文档没给 `card` 与 `keyboard` 的组合示例，没验证过，别先写。
- 2026-11-17 新开放的「群消息 `msg_id` + 单聊回复」与「被动回复 60 分钟 / 50 条」还没用上。
