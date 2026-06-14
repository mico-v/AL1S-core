import asyncio
import sys
import zipfile
from datetime import datetime
from pathlib import Path
import time

from astrbot.api import logger
from astrbot.core import file_token_service
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.message_components import File
from astrbot.api.provider import LLMResponse
from astrbot.api.star import Context, Star, StarTools, register

from al1s_config import AL1SPluginConfig
from al1s_cache import EssenceCacheManager
from al1s_essence import EssenceService
from output_spec import OutputSpec

PLUGIN_DIR = Path(__file__).resolve().parent
if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))

PLUGIN_VERSION = "v0.3.4"


@register(
    "astrbot_plugin_al1s_core",
    "AL1S",
    "AL1S Core 插件，提供 Markdown 清理与 AI 空行分段输出功能。",
    PLUGIN_VERSION,
)
class AL1SCorePlugin(Star):
    VERSION = PLUGIN_VERSION

    def __init__(self, context: Context, config: dict):
        super().__init__(context)
        self.config = AL1SPluginConfig(config)
        self.output_spec = OutputSpec(self.config.as_dict())
        self.data_dir = StarTools.get_data_dir("astrbot_plugin_al1s_core")
        self._cache = EssenceCacheManager(self.data_dir / "essence_cache")
        self._essence = EssenceService(self.config, self._cache)

    async def initialize(self):
        logger.info("AL1S Core 插件已初始化。")

    async def _build_file_component(self, file_path: Path) -> File:
        """构造文件消息段。"""
        astrbot_config = getattr(self.context, "_config", {})
        if not isinstance(astrbot_config, dict):
            astrbot_config = {}
        callback_api_base = str(astrbot_config.get("callback_api_base", "")).strip()
        callback_api_base = callback_api_base.rstrip("/")

        if callback_api_base:
            try:
                token = await file_token_service.register_file(str(file_path))
                return File(name=file_path.name, url=f"{callback_api_base}/api/file/{token}")
            except Exception as exc:
                logger.warning(
                    f"[AL1S Core] 文件服务注册失败，回退为本地路径发送（文件: {file_path}）：{exc}"
                )

        return File(name=file_path.name, file=str(file_path))

    def _chunk_plain_lines(self, lines: list[str], chunk_size: int = 15) -> list[str]:
        return self._essence.chunk_plain_lines(lines, chunk_size=chunk_size)

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("精华消息", alias={"精华", "group_essence", "essence"})
    @filter.event_message_type(filter.EventMessageType.GROUP_MESSAGE)
    async def handle_group_essence_messages(self, event: AstrMessageEvent):
        """获取当前群的群精华消息索引列表。"""
        if not self.config.is_enabled():
            yield event.plain_result("AL1S Core 当前已禁用。")
            return

        if not self._essence.has_onebot_api(event):
            yield event.plain_result("当前平台未暴露 OneBot call_action，无法读取精华消息。")
            return

        group_id = event.get_group_id()
        if not group_id:
            yield event.plain_result("该指令仅支持群聊。")
            return

        limit, force_refresh = self._essence.parse_essence_command_flags(
            event.message_str or ""
        )
        try:
            data = await self._essence.get_essence_items(
                event,
                group_id,
                force_refresh=force_refresh,
            )
        except Exception as exc:
            logger.exception("[AL1S Core] 获取精华消息失败。")
            yield event.plain_result(f"获取精华消息失败：{exc}")
            return

        if not isinstance(data, list):
            yield event.plain_result("未获取到可解析的精华消息数据。")
            return

        if not data:
            yield event.plain_result("当前群还没有精华消息。")
            return

        selected = data[:limit]
        lines = [
            f"群 {group_id} 精华消息（已显示 {len(selected)} / {len(data)}，上限 {limit}）",
        ]
        for index, item in enumerate(selected, 1):
            if not isinstance(item, dict):
                lines.append(f"{index}. 无法解析的记录")
                continue
            lines.append(self._essence.format_essence_line(index, item))

        for chunk in self._chunk_plain_lines(lines, chunk_size=12):
            yield event.plain_result(chunk)

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("精华消息导出", alias={"导出精华", "export_essence"})
    @filter.event_message_type(filter.EventMessageType.GROUP_MESSAGE)
    async def handle_export_group_essence_messages(self, event: AstrMessageEvent):
        """导出当前群所有精华消息及图片为 ZIP（MD + 图片）并发送。"""
        if not self.config.is_enabled():
            yield event.plain_result("AL1S Core 当前已禁用。")
            return

        if not self._essence.has_onebot_api(event):
            yield event.plain_result("当前平台未暴露 OneBot call_action，无法导出精华消息。")
            return

        group_id = event.get_group_id()
        if not group_id:
            yield event.plain_result("该指令仅支持群聊。")
            return

        try:
            _, force_refresh = self._essence.parse_essence_command_flags(event.message_str or "")
            items = await self._essence.get_essence_items(
                event,
                group_id,
                force_refresh=force_refresh,
            )
        except Exception as exc:
            logger.exception("[AL1S Core] 获取精华消息失败（导出）。")
            yield event.plain_result(f"获取精华消息失败：{exc}")
            return

        if not isinstance(items, list):
            yield event.plain_result("未获取到可解析的精华消息数据。")
            return

        if not items:
            yield event.plain_result("当前群还没有精华消息，导出取消。")
            return

        export_dir = self._essence.create_export_workspace(self.data_dir, str(group_id))
        images_dir = export_dir / "images"
        markdown_path = export_dir / "essence_messages.md"
        zip_path = export_dir / f"essence_{group_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip"

        image_count = 0
        markdown_lines = self._essence.create_export_markdown_header(group_id, len(items))

        for index, essence in enumerate(items, 1):
            if not isinstance(essence, dict):
                markdown_lines.append(f"## 精华消息 {index}")
                markdown_lines.append("> 无法解析的记录")
                markdown_lines.append("")
                continue

            message_id = str(
                essence.get("message_id") or essence.get("msg_id") or essence.get("msgId") or ""
            )
            message_text = ""
            image_sources = []
            image_files = []
            detail_error = None

            try:
                if message_id:
                    msg_data = await self._essence.get_message_data(
                        event,
                        group_id,
                        message_id,
                        force_refresh=force_refresh,
                    )
                    if isinstance(msg_data, dict):
                        msg_source = msg_data.get("message") or msg_data.get("raw_message") or ""
                        message_text, image_sources = self._essence.parse_message_images(msg_source)
                        if not message_text:
                            message_text = str(
                                msg_data.get("message_str")
                                or msg_data.get("raw_message")
                                or ""
                            ).strip()
            except Exception as exc:
                detail_error = f"获取消息详情失败: {exc}"

            if not message_text:
                fallback_source = essence.get("message") or essence.get("raw_message") or ""
                text_fallback, fallback_images = self._essence.parse_message_images(fallback_source)
                if text_fallback:
                    message_text = text_fallback
                if not image_sources:
                    image_sources = fallback_images

            if not image_sources:
                fallback_source = essence.get("message") or essence.get("raw_message") or ""
                _, extra_sources = self._essence.parse_message_images(fallback_source)
                image_sources.extend(extra_sources)

            for image_index, source in enumerate(image_sources, 1):
                filename, image_path = await self._essence.resolve_image_blob(
                    event,
                    source,
                    image_index,
                    index,
                    images_dir,
                )
                if filename and image_path:
                    image_files.append(filename)
                    image_count += 1

            markdown_lines.extend(
                self._essence.build_markdown_lines_for_essence(
                    index,
                    essence,
                    message_text,
                    image_files,
                    detail_error,
                )
            )

        markdown_path.write_text("\n".join(markdown_lines).strip() + "\n", encoding="utf-8")

        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in export_dir.rglob("*"):
                if path.is_file():
                    zf.write(path, path.relative_to(export_dir))

        if not zip_path.exists() or zip_path.stat().st_size == 0:
            yield event.plain_result("导出失败：未生成压缩包。")
            return

        file_comp = await self._build_file_component(zip_path)
        yield event.chain_result([file_comp])
        yield event.plain_result(
            f"精华导出完成：共 {len(items)} 条消息，成功提取图片 {image_count} 张，压缩包 {zip_path.name}"
        )

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("精华缓存", alias={"缓存精华", "essence_cache"})
    @filter.event_message_type(filter.EventMessageType.GROUP_MESSAGE)
    async def handle_essence_cache_status(self, event: AstrMessageEvent):
        """查看当前群精华缓存状态。"""
        if not self.config.is_enabled():
            yield event.plain_result("AL1S Core 当前已禁用。")
            return

        group_id = event.get_group_id()
        group_key = str(group_id or "global")
        essence_cache = self._cache.get_essence_cache(group_key)

        if isinstance(essence_cache, dict):
            updated_at = self._essence.to_timestamp_text(int(essence_cache.get("updated_at", 0)))
            synced_at = int(essence_cache.get("synced_at", 0) or 0)
            total = self._cache.get_group_count()
            msg_count = len(essence_cache.get("items", []) or [])
            next_sync = synced_at + self.config.essence_sync_interval()
        else:
            updated_at = "未缓存"
            next_sync = 0
            total = self._cache.get_group_count()
            msg_count = 0

        message_cache_count = self._cache.get_group_message_cache_count(group_key)

        image_cache_count = self._cache.get_image_cache_count()
        stats = self._cache.get_stats()

        lines = [
            "精华缓存状态：",
            f"- 当前群: {group_key}",
            (
                f"- 精华列表缓存: {msg_count} 条（更新时间: {updated_at}，下次增量同步: "
                f"{max(0, next_sync - int(time.time())) if next_sync else 0}s）"
            ),
            f"- 当前群消息详情缓存: {message_cache_count} 条",
            f"- 图片缓存文件: {image_cache_count} 个",
            f"- 命中/未命中: 图片 {stats['image_hit']}/{stats['image_miss']}，消息 {stats['message_hit']}/{stats['message_miss']}，列表 {stats['essence_hit']}/{stats['essence_miss']}",
            f"- 缓存策略: 列表采用增量同步间隔 {self.config.essence_sync_interval()}s，消息 {self.config.message_cache_ttl()}s，图片 {self.config.image_cache_ttl()}s",
            f"- 当前已缓存群数: {total}",
        ]
        for chunk in self._chunk_plain_lines(lines, chunk_size=10):
            yield event.plain_result(chunk)

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("精华缓存清理", alias={"清理精华缓存", "clear_essence_cache"})
    @filter.event_message_type(filter.EventMessageType.GROUP_MESSAGE)
    async def handle_essence_cache_clear(self, event: AstrMessageEvent):
        """清理精华缓存。可携带“全部”清空全局缓存。"""
        if not self.config.is_enabled():
            yield event.plain_result("AL1S Core 当前已禁用。")
            return

        cmd_text = str(event.message_str or "")
        if any(kw in cmd_text for kw in ("全部", "所有", "all", "ALL", "clear_all")):
            removed = await self._cache.clear_all_cache()
            yield event.plain_result(f"精华缓存已清空，移除 {removed} 条缓存记录（含图片索引）。")
            return

        group_id = event.get_group_id()
        if not group_id:
            yield event.plain_result("该指令仅支持群聊，如需清空全部缓存请发送“全部”。")
            return

        removed = await self._cache.clear_group_cache(group_id)
        yield event.plain_result(f"群 {group_id} 精华缓存清理完成，移除 {removed} 条记录（消息+列表）。")

    @filter.on_llm_response()
    async def on_llm_resp(self, event: AstrMessageEvent, resp: LLMResponse, *args):
        """监听 LLM 回复并清理 Markdown 样式。"""
        if not self.config.is_enabled() or not resp or not resp.completion_text:
            return

        original_text = resp.completion_text
        cleaned_text = self.output_spec.clean_text(original_text)
        if original_text == cleaned_text:
            return

        resp.completion_text = cleaned_text
        original_preview = original_text[:50].replace("\n", "\\n")
        cleaned_preview = cleaned_text[:50].replace("\n", "\\n")
        logger.warning(
            f"[AL1S Core] [LLM] 检测到Markdown并移除: {original_preview}... -> {cleaned_preview}..."
        )

    @filter.on_decorating_result()
    async def on_decorating_result(self, event: AstrMessageEvent):
        """处理最终输出：支持全局 Markdown 清理 + AI 空行分段发送。"""
        if not self.config.is_enabled():
            return

        result = event.get_result()
        if not result:
            return

        if self.config.should_clean_global_markdown():
            self.output_spec.clean_result_chain(result)

        if not self.output_spec.is_llm_result(result):
            return

        if not self.config.should_split_llm():
            return

        text = self.output_spec.extract_text(result)
        if not text:
            return

        segments = self.output_spec.build_segments(text)
        if not segments:
            return

        if len(segments) <= 1 and segments[0].get("type") == "text":
            return

        event.clear_result()
        event.stop_event()

        for index, segment in enumerate(segments):
            if index > 0:
                prev = segments[index - 1]
                delay = self.output_spec.calc_delay(
                    (prev.get("text") or "") if isinstance(prev, dict) else ""
                )
                await asyncio.sleep(delay)
            send_result = self.output_spec.send_segment(event, segment)
            await event.send(send_result)

            logger.info(
                f"[AL1S Core] 已发送第 {index + 1}/{len(segments)} 条AI回复段落，长度 {len(segment.get('text', ''))}，延迟规则: 每 {self.config.split_chars_per_second()} 字约 1 秒。"
            )

    @filter.command("al1s")
    async def handle_al1s(self, event: AstrMessageEvent):
        """基础功能演示：输出配置中的欢迎语。"""
        if not self.config.is_enabled():
            yield event.plain_result("AL1S Core 当前已禁用。")
            return

        yield event.plain_result(self.config.greeting())

    @filter.command("al1s状态")
    async def handle_status(self, event: AstrMessageEvent):
        """输出插件版本与状态。"""
        enabled = "开启" if self.config.is_enabled() else "关闭"
        yield event.plain_result(f"AL1S Core 运行中，状态：{enabled}，版本：{PLUGIN_VERSION}")
