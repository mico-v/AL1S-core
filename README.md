# AL1S-Core

AL1S Core 插件已新增常用助手能力：

- 清理 LLM 回复中的 Markdown 样式。
- 支持开启“全局 Markdown 清理”来处理所有待发送文本。
- AI 回复按空行自动分段输出，支持按字数配置段间延迟。

本插件默认保留原有的 `/al1s` 与 `/al1s状态` 示例命令。

## 功能

- `astrbot` 插件生命周期注册。
- 命令 `/al1s`：回复配置里的问候语。
- 命令 `/al1s状态`：显示插件运行状态和版本。
- Hook `on_llm_response`：清理 LLM 响应中的 Markdown。
- Hook `on_decorating_result`：
  - 可选全局清理 Markdown。
  - 可选按空行分段发送 AI 回复。
- 分段规则（逻辑化）
  - 自动过滤 `---` 等无意义 markdown 分隔符。
  - 如果检测到标题，按“标题/文本/表格”文章结构切分：标题与同节正文优先合并，减少中间空行。
  - 列表项（`-`、`*`、`+`、`1.`）按块聚合。
  - 表格完整识别后转为“对齐文本表格”发送，避免平台 Markdown 表格错位。
  - 分段发送间隔按段落字数计算（可配置）。
  - 示例配置文件 `_conf_schema.json`。

## 安装

将本目录放入 `data/plugins` 并重启 AstrBot 后即可识别。

## 配置

- `enabled`：是否启用插件。
- `greeting`：`/al1s` 的返回文本。
- `enable_global_markdown_killer`：是否对所有输出清理 Markdown。
- `enable_llm_line_split`：是否开启 AI 空行分段发送。
- `split_chars_per_second`：按字数换算延迟（值越小，间隔越长）。
- `split_interval_min_seconds`：最小分段间隔。
- `split_interval_max_seconds`：最大分段间隔。
- `table_font_path`：该项已移除。表格不再转图片发送。


### 表格文本发送
- Markdown 表格会按列宽自动补齐，并保留 `|` 分隔符，直接作为普通文本发送。
- 对于 Unicode 边框风格表格（`┌┐└┘` 等），插件会去掉边框后直接以文本发送，避免把框线保留到平台里。


### 本地中文字体支持
本插件已在项目内置开源中文字体：
- `assets/fonts/NotoSansCJKsc-Regular.otf`
- `assets/fonts/NotoSansCJKsc-Bold.otf`
