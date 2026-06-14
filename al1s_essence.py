import asyncio
import base64
import mimetypes
from datetime import datetime
from html import unescape as html_unescape
from pathlib import Path
from typing import Any, Optional, Tuple, List, Dict
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlparse
from urllib.request import Request, urlopen
import re
import time

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent

from al1s_cache import EssenceCacheManager
from al1s_config import AL1SPluginConfig


class EssenceService:
    """OneBot essence service and related content processing utilities."""

    def __init__(self, config: AL1SPluginConfig, cache_manager: EssenceCacheManager):
        self.config = config
        self.cache = cache_manager

    @staticmethod
    def _resolve_onebot_adapter(event_or_bot):
        if event_or_bot is None:
            return None
        if callable(getattr(event_or_bot, "call_action", None)):
            return event_or_bot
        return getattr(event_or_bot, "bot", None)

    def has_onebot_api(self, event_or_bot) -> bool:
        bot = self._resolve_onebot_adapter(event_or_bot)
        if bot and callable(getattr(bot, "call_action", None)):
            return True
        api = getattr(bot, "api", None) if bot else None
        return bool(api and callable(getattr(api, "call_action", None)))

    async def call_onebot_api(self, event_or_bot, action: str, **params):
        bot = self._resolve_onebot_adapter(event_or_bot)
        if not bot:
            raise RuntimeError("当前 OneBot 适配器没有暴露 call_action。")

        if callable(getattr(bot, "call_action", None)):
            response = await bot.call_action(action, **params)
        else:
            api = getattr(bot, "api", None)
            if not api or not callable(getattr(api, "call_action", None)):
                raise RuntimeError("当前 OneBot 适配器没有暴露 call_action。")
            response = await api.call_action(action, **params)

        self._raise_for_onebot_error(action, response)
        return response

    @staticmethod
    def extract_onebot_data(response: Any) -> Any:
        if isinstance(response, dict) and "data" in response:
            return response["data"]
        return response

    @staticmethod
    def _raise_for_onebot_error(action: str, response):
        if not isinstance(response, dict):
            return

        status = str(response.get("status", "")).lower()
        retcode = response.get("retcode")
        failed = status == "failed"
        if retcode is not None:
            try:
                failed = failed or int(retcode) != 0
            except (TypeError, ValueError):
                failed = True

        if not failed:
            return

        message = (
            response.get("msg")
            or response.get("message")
            or response.get("wording")
            or response.get("retcode")
            or "未知错误"
        )
        raise RuntimeError(f"{action} 调用失败：{message}")

    @staticmethod
    def _coalesce_essence_list(data: Any) -> Optional[List[Dict[str, Any]]]:
        if not isinstance(data, dict):
            return None
        for key in ("essence_msg_list", "data", "list", "essences"):
            raw_items = data.get(key)
            if isinstance(raw_items, list):
                return raw_items
        return None

    def parse_essence_command_flags(self, message_text: str) -> Tuple[int, bool]:
        message_text = message_text or ""
        should_refresh = False
        if any(
            kw in message_text
            for kw in ("刷新", "更新", "force", "强制", "renew", "重刷", "增量")
        ):
            should_refresh = True

        limit = self.parse_essence_limit(message_text)
        return limit, should_refresh

    def parse_essence_limit(self, message_text: str) -> int:
        default_limit = self.config.essence_default_limit()
        max_limit = self.config.essence_max_limit()
        match = re.search(r"(\d+)", message_text or "")
        if not match:
            return default_limit

        requested = int(match.group(1))
        if requested <= 0:
            return default_limit
        if requested > max_limit:
            return max_limit
        return requested

    @staticmethod
    def _extract_essence_message_id(item: Dict[str, Any]) -> str:
        return str(
            item.get("message_id")
            or item.get("msg_id")
            or item.get("msgId")
            or item.get("msgID")
            or ""
        ).strip()

    async def _merge_essence_items(
        self,
        group_id: str,
        incoming_items: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        existing_entry = self.cache.get_essence_cache(group_id)
        existing_items: List[Dict[str, Any]] = []
        if isinstance(existing_entry, dict):
            raw_existing = existing_entry.get("items")
            if isinstance(raw_existing, list):
                existing_items = [x for x in raw_existing if isinstance(x, dict)]

        if not existing_items:
            return incoming_items

        existing_map: Dict[str, Dict[str, Any]] = {}
        for item in existing_items:
            key = self._extract_essence_message_id(item)
            if key:
                existing_map[key] = item

        merged: List[Dict[str, Any]] = []
        seen: set[str] = set()

        for item in incoming_items:
            key = self._extract_essence_message_id(item)
            if not key:
                merged.append(item)
                continue
            if key in seen:
                continue
            seen.add(key)
            if key in existing_map:
                merged_item = dict(existing_map[key])
                merged_item.update(item)
                merged.append(merged_item)
            else:
                merged.append(item)

        for existing in existing_items:
            key = self._extract_essence_message_id(existing)
            if key and key in seen:
                continue
            merged.append(existing)
            if key:
                seen.add(key)

        return merged

    async def fetch_and_cache_essence_items(self, event: AstrMessageEvent, group_id: str) -> List[Dict[str, Any]]:
        response = await self.call_onebot_api(event, "get_essence_msg_list", group_id=int(group_id))
        data = self.extract_onebot_data(response)
        items = self._coalesce_essence_list(data)
        if items is None:
            items = []
            if isinstance(data, list):
                items = data
        if not isinstance(items, list):
            return []

        if items and not isinstance(items[0], dict):
            normalized: List[Dict[str, Any]] = []
            for item in items:
                if isinstance(item, dict):
                    normalized.append(item)
            items = normalized

        merged_items = await self._merge_essence_items(group_id, items)
        await self.cache.set_cached_essence_items(
            group_id,
            merged_items,
            max_cached_groups=self.config.max_cached_groups(),
        )
        return merged_items

    async def get_essence_items(
        self,
        event: AstrMessageEvent,
        group_id: str,
        force_refresh: bool = False,
    ) -> Optional[List[Dict[str, Any]]]:
        if not force_refresh:
            cached = self.cache.get_cached_essence_items(
                group_id,
                sync_interval_seconds=self.config.essence_sync_interval(),
            )
            if cached is not None:
                return cached

        try:
            return await self.fetch_and_cache_essence_items(event, group_id)
        except Exception:
            cached = self.cache.get_cached_essence_items(
                group_id,
                sync_interval_seconds=self.config.essence_sync_interval(),
            )
            if cached is not None:
                logger.warning("[AL1S Core] 获取精华列表接口异常，回退使用缓存分支。")
                return cached
            return None

    async def get_message_data(
        self,
        event: AstrMessageEvent,
        group_id: str,
        message_id: str,
        force_refresh: bool = False,
    ) -> Optional[Dict[str, Any]]:
        if not message_id:
            return None

        if not force_refresh:
            cached = self.cache.get_cached_message_data(
                group_id,
                message_id,
                ttl_seconds=self.config.message_cache_ttl(),
            )
            if isinstance(cached, dict):
                return cached

        try:
            msg_response = await self.call_onebot_api(
                event,
                "get_msg",
                message_id=int(message_id),
            )
            msg_data = self.extract_onebot_data(msg_response)
            if isinstance(msg_data, dict):
                await self.cache.set_cached_message_data(
                    group_id,
                    message_id,
                    msg_data,
                    ttl_seconds=self.config.message_cache_ttl(),
                    max_cached_groups=self.config.max_cached_groups(),
                )
                return msg_data
        except Exception:
            cached = self.cache.get_cached_message_data(
                group_id,
                message_id,
                ttl_seconds=self.config.message_cache_ttl(),
            )
            if isinstance(cached, dict):
                logger.warning("[AL1S Core] 获取消息详情失败，回退使用缓存分支。")
                return cached
        return None

    @staticmethod
    def chunk_plain_lines(lines: List[str], chunk_size: int = 15) -> List[str]:
        if not lines:
            return []
        chunks: List[str] = []
        for i in range(0, len(lines), chunk_size):
            chunks.append("\n".join(lines[i : i + chunk_size]))
        return chunks

    @staticmethod
    def to_timestamp_text(value: Any) -> str:
        try:
            ts = int(value)
            return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
        except (TypeError, ValueError, OSError, OverflowError):
            return "未知时间"

    def format_essence_line(self, index: int, item: Dict[str, Any]) -> str:
        message_id = str(
            item.get("message_id") or item.get("msg_id") or item.get("msgId") or "未知"
        )
        sender_id = str(item.get("sender_id") or item.get("user_id") or "未知")
        sender_nick = str(item.get("sender_nick") or item.get("sender_name") or "未知")
        sender_time = self.to_timestamp_text(
            item.get("sender_time") or item.get("time") or item.get("send_time")
        )
        operator_id = str(item.get("operator_id") or "未知")
        operator_nick = str(
            item.get("operator_nick") or item.get("operator_name") or "未知"
        )
        operator_time = self.to_timestamp_text(item.get("operator_time") or item.get("set_time"))

        return (
            f"{index}. message_id={message_id} | 发送者={sender_nick}({sender_id}) "
            f"| 发送时间={sender_time} | 设置者={operator_nick}({operator_id}) "
            f"| 设置时间={operator_time}"
        )

    @staticmethod
    def create_export_workspace(data_dir: Path, group_id: str) -> Path:
        base = data_dir / "essence_exports"
        base.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        workspace = base / f"group_{group_id}_{stamp}"
        workspace.mkdir(parents=True, exist_ok=True)
        (workspace / "images").mkdir(parents=True, exist_ok=True)
        return workspace

    @staticmethod
    def create_export_markdown_header(group_id: str, item_count: int) -> List[str]:
        return [
            "# 群精华消息导出",
            "",
            f"- 群号: {group_id}",
            f"- 导出时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            f"- 总计: {item_count} 条",
            "",
        ]

    @staticmethod
    def build_markdown_lines_for_essence(
        index: int,
        essence: Dict[str, Any],
        message_text: str,
        image_files: List[str],
        detail_error: Optional[str] = None,
    ) -> List[str]:
        message_id = str(
            essence.get("message_id") or essence.get("msg_id") or essence.get("msgId") or "未知"
        )
        sender_id = str(essence.get("sender_id") or essence.get("user_id") or "未知")
        sender_nick = str(
            essence.get("sender_nick") or essence.get("sender_name") or "未知"
        )
        sender_time = EssenceService.to_timestamp_text(
            essence.get("sender_time")
            or essence.get("time")
            or essence.get("send_time")
            or essence.get("message_time")
        )
        operator_id = str(
            essence.get("operator_id")
            or essence.get("operator_user_id")
            or essence.get("user_id")
            or "未知"
        )
        operator_nick = str(
            essence.get("operator_nick") or essence.get("operator_name") or "未知"
        )
        operator_time = EssenceService.to_timestamp_text(
            essence.get("operator_time") or essence.get("set_time")
        )

        lines = [
            f"## 精华消息 {index}",
            f"- message_id: `{message_id}`",
            f"- 发送者: {sender_nick}({sender_id})",
            f"- 发送时间: {sender_time}",
            f"- 设置者: {operator_nick}({operator_id})",
            f"- 设置时间: {operator_time}",
            "",
            "### 原文内容",
        ]
        if message_text:
            quoted_text = message_text.replace("\n", "\n> ")
            lines.append(f"> {quoted_text}")
        else:
            lines.append("> （无文本）")
        if detail_error:
            lines.append(f"- 备注: {detail_error}")
        if image_files:
            lines.append("")
            lines.append("### 图片引用")
            for file in image_files:
                lines.append(f"![{file}](images/{file})")
            lines.append("")
        else:
            lines.append("")
            lines.append("（无图片）")
            lines.append("")
        return lines

    @staticmethod
    def _is_http_url(text: str) -> bool:
        return bool(text) and str(text).lower().startswith(("http://", "https://"))

    @staticmethod
    def _safe_filename(name: str, fallback: str) -> str:
        safe = re.sub(r"[^\w\-.]+", "_", str(name).strip())
        safe = re.sub(r"_+", "_", safe).strip("._-")
        return safe or fallback

    @staticmethod
    def _extract_cq_params(text: str) -> Dict[str, str]:
        params: Dict[str, str] = {}
        if not text:
            return params
        for pair in str(text).split(","):
            if "=" not in pair:
                continue
            key, value = pair.split("=", 1)
            params[key.strip()] = EssenceService._unescape_cq(value.strip())
        return params

    @staticmethod
    def _unescape_cq(value: str) -> str:
        result = str(value)
        result = result.replace(r"\\", "\\")
        result = result.replace(r"\/", "/")
        result = result.replace(r"\[", "[")
        result = result.replace(r"\]", "]")
        result = result.replace(r"\,", ",")
        result = result.replace(r"\&", "&")
        return result

    def parse_message_images(self, message: Any) -> Tuple[str, List[str]]:
        text_parts: List[str] = []
        image_sources: List[str] = []

        if isinstance(message, str):
            cq_pattern = r"\[CQ:([a-zA-Z0-9_]+),([^\]]*)\]"
            for match in re.finditer(cq_pattern, message):
                comp_type = str(match.group(1)).lower()
                params = self._extract_cq_params(match.group(2))
                if comp_type == "image":
                    url = params.get("url")
                    file = params.get("file")
                    if url and url not in image_sources:
                        image_sources.append(url)
                    if file and file not in image_sources:
                        image_sources.append(file)
            text = re.sub(cq_pattern, "", message)
            if text.strip():
                text_parts.append(text.strip())
            return "\n".join(text_parts).strip(), image_sources

        if isinstance(message, list):
            for item in message:
                if not isinstance(item, dict):
                    continue

                comp_type = str(item.get("type") or item.get("type_id") or "").lower()
                data = item.get("data") if isinstance(item.get("data"), dict) else {}

                if comp_type in ("text", "plain"):
                    text = str(data.get("text") or "").strip()
                    if text:
                        text_parts.append(text)
                    continue

                if comp_type == "at":
                    mention = str(data.get("qq") or data.get("user_id") or data.get("id") or "").strip()
                    if mention:
                        text_parts.append(f"[@{mention}]")
                    continue

                if comp_type == "image":
                    url = str((data.get("url") or "")).strip()
                    file = str(data.get("file") or "").strip()
                    if url and url not in image_sources:
                        image_sources.append(url)
                    if file and file not in image_sources:
                        image_sources.append(file)
                    continue

                if comp_type and not comp_type.startswith("_"):
                    desc = str(item.get("type") or "").strip()
                    if desc:
                        text_parts.append(f"【{desc}】")
            return "\n".join(text_parts).strip(), image_sources

        return "", []

    @staticmethod
    def _guess_image_extension(src: str, blob: Optional[bytes] = None) -> str:
        path = Path(unquote(urlparse(src).path or ""))
        suffix = path.suffix.lower()
        if suffix:
            return suffix

        if blob:
            ext = mimetypes.guess_extension("image/png")
            if ext:
                return ext
        return ".png"

    @staticmethod
    def _decode_base64_blob(value: Any) -> Optional[bytes]:
        if not isinstance(value, str):
            return None
        raw = value.strip()
        if not raw:
            return None
        if raw.startswith("base64://"):
            raw = raw[len("base64://") :]
        raw = "".join(raw.split())
        if not raw:
            return None
        try:
            return base64.b64decode(raw, validate=True)
        except Exception:
            try:
                return base64.b64decode(raw)
            except Exception:
                return None

    @staticmethod
    def _download_binary(url: str, timeout: int = 20) -> bytes:
        req = Request(url, headers={"User-Agent": "AL1S-Core/1.0"})
        with urlopen(req, timeout=timeout) as response:
            return response.read()

    async def resolve_image_blob(
        self,
        event: AstrMessageEvent,
        source: str,
        image_index: int,
        message_index: int,
        images_dir: Path,
    ) -> Tuple[Optional[str], Optional[str]]:
        source = str(source or "").strip()
        if not source:
            return None, None

        normalized_source = html_unescape(source.strip())
        cached_blob_path = self.cache.get_cached_image_path(
            normalized_source,
            ttl_seconds=self.config.image_cache_ttl(),
        )
        if cached_blob_path and cached_blob_path.exists():
            ext = cached_blob_path.suffix.lower() or ".png"
            filename = self._safe_filename(
                f"{message_index}_{image_index}{ext}",
                f"image_{message_index}_{image_index}.bin",
            )
            image_path = images_dir / filename
            image_path.write_bytes(cached_blob_path.read_bytes())
            return filename, str(image_path.resolve())

        if source.startswith("base64://"):
            blob = self._decode_base64_blob(source)
            if blob:
                filename = self._safe_filename(
                    f"{message_index}_{image_index}.png",
                    f"image_{message_index}_{image_index}.bin",
                )
                image_path = images_dir / filename
                image_path.write_bytes(blob)
                try:
                    await self.cache.set_cached_image(
                        normalized_source,
                        ".png",
                        blob,
                        ttl_seconds=self.config.image_cache_ttl(),
                    )
                except Exception:
                    pass
                return filename, str(image_path.resolve())

        if self._is_http_url(source):
            try:
                blob = await asyncio.to_thread(self._download_binary, source)
                ext = self._guess_image_extension(source, blob)
                filename = self._safe_filename(
                    f"{message_index}_{image_index}{ext}",
                    f"image_{message_index}_{image_index}.bin",
                )
                image_path = images_dir / filename
                image_path.write_bytes(blob)
                try:
                    await self.cache.set_cached_image(
                        normalized_source,
                        ext,
                        blob,
                        ttl_seconds=self.config.image_cache_ttl(),
                    )
                except Exception:
                    pass
                return filename, str(image_path.resolve())
            except (HTTPError, URLError, TimeoutError, OSError, ValueError):
                logger.warning(
                    f"[AL1S Core] 下载图片失败（直接URL）：message_id={message_index}, source={source}"
                )

        try:
            response = await self.call_onebot_api(event, "get_image", file=source)
            image_data = self.extract_onebot_data(response)
            resolved_url: Optional[str] = None
            resolved_urls: List[str] = []
            raw_base64_candidates: List[Any] = []

            if isinstance(image_data, dict):
                raw_base64_candidates.extend(
                    [
                        image_data.get("base64"),
                        image_data.get("file"),
                    ]
                )
                for key in ("url", "download", "path"):
                    candidate = image_data.get(key)
                    if isinstance(candidate, str):
                        resolved_urls.append(candidate.strip())

                nested = image_data.get("data")
                if isinstance(nested, dict):
                    raw_base64_candidates.extend(
                        [
                            nested.get("base64"),
                            nested.get("file"),
                        ]
                    )
                    if not resolved_url:
                        candidate = nested.get("url")
                        if isinstance(candidate, str):
                            resolved_urls.append(candidate.strip())

            if isinstance(image_data, str):
                raw_base64_candidates.append(image_data)

            for raw_b64 in raw_base64_candidates:
                blob = self._decode_base64_blob(raw_b64)
                if blob:
                    filename = self._safe_filename(
                        f"{message_index}_{image_index}.png",
                        f"image_{message_index}_{image_index}.bin",
                    )
                    image_path = images_dir / filename
                    image_path.write_bytes(blob)
                    try:
                        await self.cache.set_cached_image(
                            normalized_source,
                            ".png",
                            blob,
                            ttl_seconds=self.config.image_cache_ttl(),
                        )
                    except Exception:
                        pass
                    return filename, str(image_path.resolve())

            if resolved_urls:
                resolved_urls = [html_unescape(url.strip()) for url in resolved_urls if url]
                resolved_urls = [url for url in resolved_urls if self._is_http_url(url)]

            if resolved_urls:
                resolved_url = resolved_urls[0]

            for candidate in resolved_urls:
                try:
                    blob = await asyncio.to_thread(self._download_binary, candidate)
                except Exception:
                    continue
                ext = self._guess_image_extension(candidate, blob)
                filename = self._safe_filename(
                    f"{message_index}_{image_index}{ext}",
                    f"image_{message_index}_{image_index}.bin",
                )
                image_path = images_dir / filename
                image_path.write_bytes(blob)
                try:
                    await self.cache.set_cached_image(
                        normalized_source,
                        ext,
                        blob,
                        ttl_seconds=self.config.image_cache_ttl(),
                    )
                except Exception:
                    pass
                return filename, str(image_path.resolve())

            if not resolved_url:
                if normalized_source.startswith("base64://"):
                    blob = self._decode_base64_blob(normalized_source)
                    if blob:
                        filename = self._safe_filename(
                            f"{message_index}_{image_index}.png",
                            f"image_{message_index}_{image_index}.bin",
                        )
                        image_path = images_dir / filename
                        image_path.write_bytes(blob)
                        try:
                            await self.cache.set_cached_image(
                                normalized_source,
                                ".png",
                                blob,
                                ttl_seconds=self.config.image_cache_ttl(),
                            )
                        except Exception:
                            pass
                        return filename, str(image_path.resolve())

                if self._is_http_url(normalized_source):
                    blob = await asyncio.to_thread(
                        self._download_binary,
                        normalized_source,
                    )
                    ext = self._guess_image_extension(normalized_source, blob)
                    filename = self._safe_filename(
                        f"{message_index}_{image_index}{ext}",
                        f"image_{message_index}_{image_index}.bin",
                    )
                    image_path = images_dir / filename
                    image_path.write_bytes(blob)
                    try:
                        await self.cache.set_cached_image(
                            normalized_source,
                            ext,
                            blob,
                            ttl_seconds=self.config.image_cache_ttl(),
                        )
                    except Exception:
                        pass
                    return filename, str(image_path.resolve())
                return None, None
        except Exception as exc:
            logger.warning(
                f"[AL1S Core] 通过 get_image 获取图片失败：message_id={message_index}, source={source}, err={exc}"
            )

        return None, None
