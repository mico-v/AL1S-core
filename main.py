from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register


@register(
    "astrbot_plugin_al1s_core",
    "AL1S",
    "AL1S Core 插件模板，提供基础配置与命令示例。",
    "v0.1.0",
)
class AL1SCorePlugin(Star):
    def __init__(self, context: Context, config: dict):
        super().__init__(context)
        self.config = config

    async def initialize(self):
        logger.info("AL1S Core 插件已初始化。")

    def _is_enabled(self) -> bool:
        return bool(self.config.get("enabled", True))

    @filter.command("al1s")
    async def handle_al1s(self, event: AstrMessageEvent):
        """基础功能演示：输出配置中的欢迎语。"""
        if not self._is_enabled():
            yield event.plain_result("AL1S Core 当前已禁用。")
            return

        greeting = self.config.get("greeting", "AL1S Core 已连接。")
        yield event.plain_result(greeting)

    @filter.command("al1s状态")
    async def handle_status(self, event: AstrMessageEvent):
        """输出插件版本与状态。"""
        version = "v0.1.0"
        enabled = "开启" if self._is_enabled() else "关闭"
        yield event.plain_result(f"AL1S Core 运行中，状态：{enabled}，版本：{version}")
