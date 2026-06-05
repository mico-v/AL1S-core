# AL1S-Core

AL1S Core 插件模板，提供 AstrBot 插件开发起步结构。

## 功能

- `astrbot` 插件生命周期注册。
- 命令 `/al1s`：回复配置里的问候语。
- 命令 `/al1s状态`：显示插件运行状态和版本。
- 示例配置文件 `_conf_schema.json`。

## 安装

将本目录放入 `data/plugins` 并重启 AstrBot 后即可识别。

## 配置

- `enabled`：是否启用插件。
- `greeting`：`/al1s` 的返回文本。
