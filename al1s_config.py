from typing import Any


class AL1SPluginConfig:
    """Typed accessors for plugin configuration."""

    def __init__(self, values: dict[str, Any] = None):
        self._values = values if isinstance(values, dict) else {}

    def as_dict(self) -> dict[str, Any]:
        return self._values

    def is_enabled(self) -> bool:
        return bool(self._values.get("enabled", True))

    def should_clean_global_markdown(self) -> bool:
        return bool(self._values.get("enable_global_markdown_killer", False))

    def should_split_llm(self) -> bool:
        return bool(self._values.get("enable_llm_line_split", False))

    def _get_int(self, key: str, default: int) -> int:
        value = self._values.get(key, default)
        try:
            value_int = int(value)
        except (TypeError, ValueError):
            return default
        return value_int if value_int >= 0 else default

    def _get_float(self, key: str, default: float) -> float:
        value = self._values.get(key, default)
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    def essence_cache_ttl(self) -> int:
        legacy = self._get_int("onebot_essence_cache_ttl_seconds", 0)
        if legacy > 0:
            return legacy
        return self._get_int("onebot_essence_list_sync_interval_seconds", 300)

    def essence_sync_interval(self) -> int:
        return self.essence_cache_ttl()

    def message_cache_ttl(self) -> int:
        return self._get_int("onebot_essence_message_cache_ttl_seconds", 0)

    def image_cache_ttl(self) -> int:
        return self._get_int("onebot_essence_image_cache_ttl_seconds", 0)

    def max_cached_groups(self) -> int:
        return self._get_int("onebot_essence_cache_max_groups", 20)

    def essence_default_limit(self) -> int:
        return self._get_int("onebot_essence_list_default_limit", 20)

    def essence_max_limit(self) -> int:
        return self._get_int("onebot_essence_list_max_limit", 200)

    def split_chars_per_second(self) -> int:
        return self._get_int("split_chars_per_second", 80)

    def split_interval_min_seconds(self) -> float:
        return self._get_float("split_interval_min_seconds", 0.5)

    def split_interval_max_seconds(self) -> float:
        return self._get_float("split_interval_max_seconds", 3.0)

    def greeting(self) -> str:
        return str(self._values.get("greeting", "AL1S Core 已连接。"))
