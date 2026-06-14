
import asyncio
import hashlib
import json
import time
from pathlib import Path

from typing import Any, Optional

from astrbot.api import logger


class EssenceCacheManager:
    """Cache manager for essence metadata, message detail and image binary metadata."""

    def __init__(self, cache_dir: Path):
        self._cache_dir = cache_dir
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        self._cache_file = self._cache_dir / "cache.json"
        self._image_cache_dir = self._cache_dir / "images"
        self._image_cache_dir.mkdir(parents=True, exist_ok=True)

        self._cache_lock = asyncio.Lock()
        self._cache_data = {
            "essence": {},
            "messages": {},
            "images": {},
        }
        self._cache_stats = {
            "essence_hit": 0,
            "essence_miss": 0,
            "message_hit": 0,
            "message_miss": 0,
            "image_hit": 0,
            "image_miss": 0,
        }

        self._load_cache_state()

    @property
    def image_dir(self) -> Path:
        return self._image_cache_dir

    @staticmethod
    def _now_ts() -> int:
        return int(time.time())

    @staticmethod
    def _is_expired(expires_at: int, ttl: int) -> bool:
        if ttl <= 0:
            return False
        return EssenceCacheManager._now_ts() >= expires_at

    def _cache_key_message(self, group_id: str, message_id: str) -> str:
        return f"{str(group_id)}:{str(message_id)}"

    def _cache_key_source(self, source: str) -> str:
        return hashlib.sha256(str(source).strip().encode("utf-8")).hexdigest()

    def _load_cache_state(self) -> None:
        if not self._cache_file.exists():
            return

        try:
            raw = self._cache_file.read_text(encoding="utf-8")
            data = json.loads(raw)
            if isinstance(data, dict):
                self._cache_data["essence"] = data.get("essence", {})
                self._cache_data["messages"] = data.get("messages", {})
                self._cache_data["images"] = data.get("images", {})
        except Exception as exc:
            logger.warning(f"[AL1S Core] 加载缓存失败：{exc}")
            self._cache_data = {"essence": {}, "messages": {}, "images": {}}

        self._cleanup_expired_cache_locked(
            message_ttl=0,
            image_ttl=0,
            max_cached_groups=0,
        )

    def _dump_cache_state(self) -> None:
        tmp_path = self._cache_file.with_suffix(".tmp")
        payload = self._cache_data
        try:
            tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp_path.replace(self._cache_file)
        except Exception as exc:
            logger.warning(f"[AL1S Core] 缓存持久化失败：{exc}")

    def _cleanup_expired_cache_locked(
        self,
        *,
        message_ttl: int,
        image_ttl: int,
        max_cached_groups: int,
    ) -> None:
        essence = self._cache_data.get("essence")
        messages = self._cache_data.get("messages")
        images = self._cache_data.get("images")

        if isinstance(essence, dict):
            for group_id in list(essence.keys()):
                entry = essence.get(group_id)
                if not isinstance(entry, dict) or not isinstance(entry.get("items"), list):
                    essence.pop(group_id, None)

        if isinstance(messages, dict):
            for msg_key in list(messages.keys()):
                entry = messages.get(msg_key)
                if not isinstance(entry, dict):
                    messages.pop(msg_key, None)
                    continue
                if self._is_expired(int(entry.get("expires_at", 0) or 0), message_ttl):
                    messages.pop(msg_key, None)

        if isinstance(images, dict):
            for source_key in list(images.keys()):
                entry = images.get(source_key)
                if not isinstance(entry, dict):
                    images.pop(source_key, None)
                    continue

                if self._is_expired(int(entry.get("expires_at", 0) or 0), image_ttl):
                    file_path = entry.get("path")
                    if isinstance(file_path, str):
                        cached_file = Path(file_path)
                        try:
                            if cached_file.exists():
                                cached_file.unlink()
                        except Exception:
                            pass
                    images.pop(source_key, None)

        if isinstance(essence, dict) and max_cached_groups > 0 and len(essence) > max_cached_groups:
            ordered = sorted(
                essence.items(),
                key=lambda item: int((item[1] or {}).get("updated_at", 0) or 0),
                reverse=True,
            )
            keep = dict(ordered[:max_cached_groups])
            self._cache_data["essence"] = keep

        if isinstance(messages, dict):
            self._cache_data["messages"] = {
                key: entry for key, entry in messages.items() if isinstance(entry, dict)
            }

        if isinstance(images, dict):
            self._cache_data["images"] = {
                key: entry for key, entry in images.items() if isinstance(entry, dict)
            }

    def get_stats(self) -> dict[str, int]:
        return dict(self._cache_stats)

    def get_cached_essence_items(
        self,
        group_id: str,
        sync_interval_seconds: int,
    ) -> Optional[list[dict[str, Any]]]:
        entry = self._cache_data.get("essence", {}).get(str(group_id))
        if not isinstance(entry, dict):
            self._cache_stats["essence_miss"] += 1
            return None

        cached = entry.get("items")
        if not isinstance(cached, list):
            self._cache_stats["essence_miss"] += 1
            return None

        last_sync = int(entry.get("synced_at", 0) or 0)
        if sync_interval_seconds > 0 and (self._now_ts() - last_sync) >= sync_interval_seconds:
            self._cache_stats["essence_miss"] += 1
            return None

        self._cache_stats["essence_hit"] += 1
        return cached

    async def set_cached_essence_items(
        self,
        group_id: str,
        items: list[dict[str, Any]],
        *,
        max_cached_groups: int,
    ) -> None:
        async with self._cache_lock:
            now = self._now_ts()
            essence_cache = self._cache_data.setdefault("essence", {})
            essence_cache[str(group_id)] = {
                "items": items,
                "updated_at": now,
                "synced_at": now,
            }
            self._cleanup_expired_cache_locked(
                message_ttl=0,
                image_ttl=0,
                max_cached_groups=max_cached_groups,
            )
            self._dump_cache_state()

    def get_cached_message_data(
        self,
        group_id: str,
        message_id: str,
        ttl_seconds: int,
        *,
        force_refresh: bool = False,
    ) -> Optional[dict[str, Any]]:
        key = self._cache_key_message(group_id, message_id)
        entry = self._cache_data.get("messages", {}).get(key)
        if not isinstance(entry, dict):
            self._cache_stats["message_miss"] += 1
            return None

        data = entry.get("message")
        if not isinstance(data, dict):
            self._cache_stats["message_miss"] += 1
            return None

        if force_refresh or self._is_expired(int(entry.get("expires_at", 0) or 0), ttl_seconds):
            self._cache_stats["message_miss"] += 1
            return None

        self._cache_stats["message_hit"] += 1
        return data

    async def set_cached_message_data(
        self,
        group_id: str,
        message_id: str,
        message_data: dict[str, Any],
        *,
        ttl_seconds: int,
        max_cached_groups: int,
    ) -> None:
        async with self._cache_lock:
            now = self._now_ts()
            key = self._cache_key_message(group_id, message_id)
            message_cache = self._cache_data.setdefault("messages", {})
            message_cache[key] = {
                "message": message_data,
                "updated_at": now,
                "expires_at": now + ttl_seconds,
            }
            self._cleanup_expired_cache_locked(
                message_ttl=ttl_seconds,
                image_ttl=0,
                max_cached_groups=max_cached_groups,
            )
            self._dump_cache_state()

    def get_cached_image_path(self, source: str, ttl_seconds: int) -> Optional[Path]:
        key = self._cache_key_source(source)
        entry = self._cache_data.get("images", {}).get(key)
        if not isinstance(entry, dict):
            self._cache_stats["image_miss"] += 1
            return None

        path = entry.get("path")
        if not isinstance(path, str):
            self._cache_stats["image_miss"] += 1
            return None

        if self._is_expired(int(entry.get("expires_at", 0) or 0), ttl_seconds):
            self._cache_data.setdefault("images", {}).pop(key, None)
            self._cache_stats["image_miss"] += 1
            cached_file = Path(path)
            if cached_file.exists():
                try:
                    cached_file.unlink()
                except Exception:
                    pass
            return None

        cached_file = Path(path)
        if cached_file.exists():
            self._cache_stats["image_hit"] += 1
            return cached_file

        self._cache_stats["image_miss"] += 1
        self._cache_data.setdefault("images", {}).pop(key, None)
        return None

    async def set_cached_image(
        self,
        source: str,
        ext: str,
        blob: bytes,
        *,
        ttl_seconds: int,
    ) -> Path:
        key = self._cache_key_source(source)
        suffix = ext if ext.startswith(".") else f".{ext}" if ext else ".bin"
        file_path = self._image_cache_dir / f"{key}{suffix}"

        async with self._cache_lock:
            if not file_path.exists():
                file_path.write_bytes(blob)
            now = self._now_ts()
            self._cache_data.setdefault("images", {})[key] = {
                "path": str(file_path),
                "updated_at": now,
                "expires_at": now + ttl_seconds,
                "ext": suffix,
                "size": file_path.stat().st_size if file_path.exists() else 0,
            }
            self._cleanup_expired_cache_locked(
                message_ttl=0,
                image_ttl=ttl_seconds,
                max_cached_groups=0,
            )
            self._dump_cache_state()
        return file_path

    async def clear_group_cache(self, group_id: str) -> int:
        removed = 0
        async with self._cache_lock:
            group_key = str(group_id)
            if isinstance(self._cache_data.get("essence"), dict):
                if self._cache_data["essence"].pop(group_key, None) is not None:
                    removed += 1

            messages = self._cache_data.get("messages")
            if isinstance(messages, dict):
                for msg_key in list(messages.keys()):
                    if msg_key.startswith(f"{group_key}:"):
                        messages.pop(msg_key, None)
                        removed += 1

            self._dump_cache_state()
            return removed

    async def clear_all_cache(self) -> int:
        async with self._cache_lock:
            removed = (
                len(self._cache_data.get("essence", {}))
                + len(self._cache_data.get("messages", {}))
                + len(self._cache_data.get("images", {}))
            )
            self._cache_data = {"essence": {}, "messages": {}, "images": {}}
            self._dump_cache_state()
            for image_file in self._image_cache_dir.rglob("*"):
                if image_file.is_file():
                    try:
                        image_file.unlink()
                    except Exception:
                        pass
            return removed

    def get_essence_cache(self, group_id: str) -> Optional[dict[str, Any]]:
        entry = self._cache_data.get("essence", {}).get(str(group_id))
        return entry if isinstance(entry, dict) else None

    def get_group_count(self) -> int:
        return len(self._cache_data.get("essence", {}))

    def get_group_message_cache_count(self, group_id: str) -> int:
        group_key = str(group_id)
        count = 0
        for msg_key in self._cache_data.get("messages", {}):
            if msg_key.startswith(f"{group_key}:"):
                count += 1
        return count

    def get_image_cache_count(self) -> int:
        return len(self._cache_data.get("images", {}))
