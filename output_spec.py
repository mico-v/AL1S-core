from typing import Any
import re
import unicodedata

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent


class OutputSpec:
    def __init__(self, config: dict[str, Any] | None = None):
        self.config = config or {}

    def clean_text(self, text: str) -> str:
        """Remove common Markdown syntax while keeping readable text."""
        # 移除代码块 (保留内容)
        text = re.sub(r"```(?:[a-zA-Z0-9+\-]*\s+)?([\s\S]*?)```", r"\1", text)

        # 移除行内代码 `code` -> code
        text = re.sub(r"`([^`]+)`", r"\1", text)

        # 移除图片 ![alt](url) -> alt (避免残留 !)
        text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", text)

        # 移除普通链接 [text](url) -> text
        text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)

        # 移除粗体
        text = re.sub(r"\*\*(.*?)\*\*", r"\1", text)
        text = re.sub(r"__(.*?)__", r"\1", text)

        # 移除斜体（保守处理，减少误伤）
        text = re.sub(r"(?<!\*)\*(?!\s)(.*?)(?<!\s)\*(?!\*)", r"\1", text)
        text = re.sub(r"(?<!\w)_(?!\s)(.*?)(?<!\s)_(?!\w)", r"\1", text)

        # 移除删除线
        text = re.sub(r"~~(.*?)~~", r"\1", text)

        # 移除标题
        text = re.sub(r"^(#{1,6})\s+(.*)", r"\2", text, flags=re.MULTILINE)

        # 移除引用（处理嵌套）
        text = re.sub(r"^(?:>\s*)+(.*)", r"\1", text, flags=re.MULTILINE)

        # 移除列表标记（行首 -、*、+）
        text = re.sub(r"^\s*[-*+]\s+(.*)", r"\1", text, flags=re.MULTILINE)

        # 移除有序列表标记（行首 1. 2.）
        text = re.sub(r"^\s*\d+[.)]\s+(.*)", r"\1", text, flags=re.MULTILINE)

        # 移除任务列表标记（- [x]）
        text = re.sub(r"^\s*[-*+]\s+\[[xX ]\]\s+(.*)", r"\1", text, flags=re.MULTILINE)

        return text

    def _is_block_divider(self, line: str) -> bool:
        """识别只包含分隔符的行（可作为段落边界）。"""
        if not line:
            return False
        stripped = line.strip()
        return bool(
            re.fullmatch(r"[-*`_=]{3,}", stripped)
            or re.fullmatch(r"\|(?:\s*[-:]{3,}\s*\|?)+\s*", stripped)
        )

    def _is_markdown_heading_line(self, line: str) -> bool:
        if not line:
            return False

        cleaned = line.strip()
        if not cleaned:
            return False

        if re.match(r"^\s*#{1,6}\s+\S+", cleaned):
            return True

        patterns = [
            r"^\s*[✦•·*]+\s*[第]?(?:"
            r"[0-9]+|[一二三四五六七八九十百千万零〇两壹贰叁肆伍陆柒捌玖拾佰仟]+|[IVXLCDM]+)\s*[、。·•]\s*\S+$",
            r"^\s*[第]?(?:"
            r"[0-9]+|[一二三四五六七八九十百千万零〇两壹贰叁肆伍陆柒捌玖拾佰仟]+|[IVXLCDM]+)\s*[、。·•]\s*\S+$",
            r"^\s*[✦•·*]+\s*[一二三四五六七八九十百千万零〇两壹贰叁肆伍陆柒捌玖拾佰仟]+\s*[章节回卷篇卷]\s*[：:、。·•]?\s*\S+$",
            r"^\s*[一二三四五六七八九十百千万零〇两壹贰叁肆伍陆柒捌玖拾佰仟]+\s*[章节回卷篇卷]\s*[：:、。·•]?\s*\S+$",
            r"^\s*[✦•*]?\s*[\u4e00-\u9fff]{1,10}\s*[·•]\s*\S+$",
            r"^[💖💗💘💙💚💛💜🤍🖤🤎❤️🧡💝💌✦]\s*[\u4e00-\u9fffA-Za-z0-9].*?[\u4e00-\u9fffA-Za-z0-9💖💗💘💙💚💛💜🤍🖤🤎❤️🧡💝💌]$",
            r"^\s*[✦•*]+\s*\S{2,40}\s*[：:]\s*$",
        ]

        return any(re.match(pattern, cleaned) for pattern in patterns)

    def _is_list_line(self, line: str) -> bool:
        return bool(
            re.match(
                r"^\s*(?:\d{1,3}[.)、]\s+|[-+*]\s+|[-+*]\s+\[[xX ]\]\s+|[-+*]\s*\|\s*|[•·]\s+)",
                line,
            )
        )

    def _normalize_list_line(self, line: str) -> str:
        if not line:
            return ""

        normalized = line
        normalized = re.sub(r"^\s*[-+*]\s+\[[xX ]\]\s+", "", normalized)
        normalized = re.sub(r"^\s*\d{1,3}[.)、]\s+", "", normalized)
        normalized = re.sub(r"^\s*[-+*]\s*\|\s*", "", normalized)
        normalized = re.sub(r"^\s*[-+*]\s+", "", normalized)
        normalized = re.sub(r"^\s*[•·]\s+", "", normalized)
        return normalized.strip()

    def _is_box_table_line(self, line: str) -> bool:
        if not line:
            return False

        box_line_chars = set(
            "┌┐└┘├┤┬┴┼─━│╭╮╯╰╏╎╵╷╔╗╚╝╠╣╦╩╬║═┏┓┗┛"
        )
        if not any(ch in box_line_chars for ch in line):
            return False

        for ch in line:
            if ch in {"\r", "\n"}:
                return False
            if ch.isspace():
                continue
            if ch in box_line_chars:
                continue
            if ch.isprintable():
                continue
            return False

        return True

    def _extract_box_table_lines(self, lines, start_index: int):
        index = start_index
        if index >= len(lines):
            return None, start_index

        table_lines = []
        while index < len(lines):
            raw = lines[index]
            line = raw.rstrip("\r\n")
            if not line:
                break
            if self._is_block_divider(line):
                break
            if not self._is_box_table_line(line):
                break
            table_lines.append(line)
            index += 1

        if len(table_lines) < 2:
            return None, start_index

        return table_lines, index

    def _is_box_border_only_line(self, line: str) -> bool:
        stripped = line.strip()
        if not stripped:
            return False

        border_only_chars = set(
            "┌┐└┘├┤┬┴┼─━╭╮╯╰╏╎╵╷╔╗╚╝╠╣╦╩╬║═┏┓┗┛"
        )
        for ch in stripped:
            if ch in border_only_chars or ch.isspace():
                continue
            return False
        return True

    def _normalize_box_table(self, table_text: str) -> str:
        raw_rows = [line.rstrip() for line in table_text.split("\n") if line.rstrip()]
        if not raw_rows:
            return table_text.strip()

        normalized_rows = []
        for line in raw_rows:
            if self._is_box_border_only_line(line):
                continue

            has_vertical = any(ch in "│║╎╏" for ch in line)
            pieces = []
            for ch in line:
                if ch in "│║╎╏":
                    pieces.append("|")
                    continue
                if ch in {
                    "┌",
                    "┐",
                    "└",
                    "┘",
                    "├",
                    "┤",
                    "┬",
                    "┴",
                    "┼",
                    "─",
                    "━",
                    "╭",
                    "╮",
                    "╯",
                    "╰",
                    "╵",
                    "╷",
                    "╠",
                    "╣",
                    "╦",
                    "╩",
                    "╬",
                    "╔",
                    "╗",
                    "╚",
                    "╝",
                    "═",
                    "║",
                    "┏",
                    "┓",
                    "┗",
                    "┛",
                }:
                    continue
                pieces.append(ch)

            text = "".join(pieces).strip()
            if not text:
                continue
            if has_vertical:
                text = text.strip("|").strip()
                text = re.sub(r"\s*\|\s*", " | ", text).strip()
            normalized_rows.append(text)

        return "\n".join(normalized_rows)

    def _normalize_box_table_from_text(self, text: str) -> str:
        lines = [line.rstrip("\r") for line in text.split("\n")]
        if not lines:
            return text.strip()

        output_lines = []
        index = 0
        while index < len(lines):
            raw_line = lines[index]
            if not raw_line.strip() or not self._is_box_table_line(raw_line):
                output_lines.append(raw_line.rstrip())
                index += 1
                continue

            block = []
            while index < len(lines) and self._is_box_table_line(lines[index]):
                block.append(lines[index].rstrip())
                index += 1

            if len(block) >= 2:
                normalized = self._normalize_box_table("\n".join(block))
                if normalized:
                    output_lines.append(normalized)
            else:
                output_lines.extend(block)

        return "\n".join(output_lines)

    def _is_table_row(self, raw_line: str) -> bool:
        line = raw_line.strip()
        if not line:
            return False
        if line.count("|") < 2:
            return False
        return bool(re.fullmatch(r"^\s*\|(?:[^|\r\n]*\|)+\s*$", line))

    def _is_table_divider_row(self, raw_line: str) -> bool:
        line = raw_line.strip()
        if not line:
            return False
        return bool(re.fullmatch(r"^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$", line))

    def _extract_table_lines(self, lines, start_index: int):
        index = start_index
        if index >= len(lines):
            return None, start_index

        table_lines = []
        data_row_count = 0
        while index < len(lines):
            raw = lines[index]
            line = raw.strip()

            if self._is_table_divider_row(line):
                if data_row_count > 0:
                    index += 1
                    continue
                break

            if not line or self._is_block_divider(line):
                break

            if not self._is_table_row(line):
                break

            table_lines.append(raw.rstrip("\r"))
            data_row_count += 1
            index += 1

        if data_row_count < 2:
            return None, start_index

        return table_lines, index

    def _parse_table_rows(self, text: str):
        lines = [line.strip() for line in text.split("\n") if line.strip()]
        if len(lines) < 2:
            return []

        table_rows = []
        for idx, line in enumerate(lines):
            if self._is_table_divider_row(line):
                continue
            if not self._is_table_row(line):
                return []

            cells = [cell.strip() for cell in line.strip("|").split("|")]
            if cells:
                table_rows.append(cells)

        if len(table_rows) < 2:
            return []

        return table_rows

    def _display_width(self, text: str) -> int:
        width = 0
        for char in text:
            if char == "\t":
                width += 4
                continue
            ea = unicodedata.east_asian_width(char)
            if ea in {"F", "W"}:
                width += 2
            elif ea == "A":
                width += 2
            else:
                width += 1
        return width

    def _format_table_row(self, cells, width_list):
        pieces = []
        for idx, cell in enumerate(cells):
            text = (cell or "").strip()
            pad = max(0, width_list[idx] - self._display_width(text))
            pieces.append(f" {text}{' ' * pad} ")
        return "|" + "|".join(pieces) + "|"

    def _format_markdown_table(self, table_text: str) -> str:
        rows = self._parse_table_rows(table_text)
        if not rows:
            return table_text.strip()

        max_cols = max(len(r) for r in rows)
        normalized_rows = [r + [""] * (max_cols - len(r)) for r in rows]
        col_widths = [0] * max_cols

        for row in normalized_rows:
            for idx, cell in enumerate(row):
                width = self._display_width((cell or "").strip())
                if width > col_widths[idx]:
                    col_widths[idx] = width

        output_rows = []
        for idx, row in enumerate(normalized_rows):
            output_rows.append(self._format_table_row(row, col_widths))
            if idx == 0 and len(normalized_rows) > 1:
                output_rows.append(
                    "|"
                    + "|".join(
                        f" {'-' * max(3, col_widths[c])} "
                        for c in range(max_cols)
                    )
                    + "|"
                )

        return "\n".join(output_rows)

    def build_segments(self, text):
        raw_lines = (text or "").replace("\r\n", "\n").split("\n")
        has_heading = any(
            self._is_markdown_heading_line(line) for line in raw_lines if line.strip()
        )
        parsed_blocks = []
        i = 0

        def add_text_block(lines) -> None:
            block = "\n".join([ln.strip() for ln in lines if ln.strip()])
            if block:
                parsed_blocks.append(("text", block))

        while i < len(raw_lines):
            raw_line = raw_lines[i]
            line = raw_line.rstrip("\r")

            if not line.strip() or self._is_block_divider(line):
                i += 1
                continue

            box_lines, box_next_index = self._extract_box_table_lines(raw_lines, i)
            if box_lines:
                parsed_blocks.append(("box_table", "\n".join(box_lines)))
                i = box_next_index
                continue

            table_lines, next_index = self._extract_table_lines(raw_lines, i)
            if table_lines:
                parsed_blocks.append(("table", "\n".join(table_lines).strip()))
                i = next_index
                continue

            if self._is_markdown_heading_line(line):
                parsed_blocks.append(("heading", line.strip()))
                i += 1
                continue

            if self._is_list_line(line):
                list_lines = []
                while i < len(raw_lines):
                    current = raw_lines[i].rstrip("\r")
                    if self._is_list_line(current):
                        normalized = self._normalize_list_line(current)
                        if normalized:
                            list_lines.append(normalized)
                        i += 1
                    else:
                        break
                if list_lines:
                    parsed_blocks.append(("text", "\n".join(list_lines)))
                continue

            paragraph_lines = []
            while i < len(raw_lines):
                current = raw_lines[i].rstrip("\r")
                if not current.strip() or self._is_block_divider(current):
                    if has_heading:
                        i += 1
                        continue
                    break

                table_lines, next_index = self._extract_table_lines(raw_lines, i)
                if table_lines:
                    break

                if self._is_markdown_heading_line(current):
                    if has_heading:
                        break
                if self._is_list_line(current):
                    break

                box_lines, box_next_index = self._extract_box_table_lines(raw_lines, i)
                if box_lines:
                    break

                paragraph_lines.append(current)
                i += 1

            if paragraph_lines:
                add_text_block(paragraph_lines)
            else:
                i += 1

        merged = []
        index = 0
        while index < len(parsed_blocks):
            block_type, block_text = parsed_blocks[index]

            if has_heading and block_type == "heading":
                heading = block_text.strip()
                section_chunks = [heading]
                index += 1
                while index < len(parsed_blocks):
                    next_type, next_text = parsed_blocks[index]
                    if next_type == "heading":
                        break
                    if next_type in ("table", "box_table"):
                        if section_chunks:
                            merged.append({"type": "text", "text": "\n".join(section_chunks)})
                            section_chunks = []
                        merged.append({"type": next_type, "text": next_text})
                    elif next_type == "text" and next_text.strip():
                        section_chunks.append(next_text.strip())
                    index += 1
                if section_chunks:
                    merged.append({"type": "text", "text": "\n".join(section_chunks)})
                continue

            if not has_heading and block_type == "text" and index + 1 < len(parsed_blocks):
                next_type, next_text = parsed_blocks[index + 1]
                if next_type == "box_table":
                    merged.append({"type": "text", "text": f"{block_text}\n{next_text}"})
                    index += 2
                    continue

            if block_type == "heading" and index + 1 < len(parsed_blocks):
                next_type, next_text = parsed_blocks[index + 1]
                if next_type not in ("heading", "table", "box_table"):
                    merged.append({"type": "text", "text": f"{block_text}\n{next_text}"})
                    index += 2
                    continue

            if block_type in ("table", "box_table"):
                merged.append({"type": block_type, "text": block_text})
            else:
                merged.append({"type": "text", "text": block_text})

            index += 1

        return [segment for segment in merged if segment.get("text", "").strip()]

    def send_segment(self, event: AstrMessageEvent, segment: dict):
        kind = segment.get("type")
        if kind == "table":
            return event.plain_result(self._format_markdown_table(segment.get("text", "")))
        if kind == "box_table":
            return event.plain_result(self._normalize_box_table(segment.get("text", "")))
        text = segment.get("text", "").strip()
        if text and any(
            ch
            in "┌┐└┘├┤┬┴┼─━│╭╮╯╰╏╎╵╷╔╗╚╝╠╣╦╩╬║═┏┓┗┛"
            for ch in text
        ):
            normalized = self._normalize_box_table_from_text(text)
            if normalized:
                return event.plain_result(normalized)

        return event.plain_result(text)

    def extract_text(self, result) -> str:
        chain = getattr(result, "chain", None)
        if not chain:
            return ""

        text_parts = []
        for comp in chain:
            text = getattr(comp, "text", None)
            if isinstance(text, str):
                text_parts.append(text)
        return "".join(text_parts)

    def clean_result_chain(self, result) -> bool:
        changed = False
        chain = getattr(result, "chain", None)
        if not chain:
            return False

        for comp in chain:
            text = getattr(comp, "text", None)
            if not isinstance(text, str):
                continue
            cleaned = self.clean_text(text)
            if cleaned != text:
                comp.text = cleaned
                changed = True
                original_preview = text[:50].replace("\n", "\\n")
                cleaned_preview = cleaned[:50].replace("\n", "\\n")
                logger.warning(
                    f"[AL1S Core] 检测到Markdown并移除: {original_preview}... -> {cleaned_preview}..."
                )

        return changed

    def is_llm_result(self, result) -> bool:
        is_llm_result = getattr(result, "is_llm_result", None)
        if callable(is_llm_result):
            try:
                return bool(is_llm_result())
            except Exception:
                logger.exception("[AL1S Core] 检查 LLM 响应类型失败，已回退到 false。")

        return False

    def calc_delay(self, text: str) -> float:
        if not text:
            return 0.0

        chars_per_sec = self.config.get("split_chars_per_second", 80)
        min_delay = self.config.get("split_interval_min_seconds", 0.5)
        max_delay = self.config.get("split_interval_max_seconds", 3.0)

        try:
            chars_per_sec = int(chars_per_sec)
        except (TypeError, ValueError):
            chars_per_sec = 80

        if chars_per_sec <= 0:
            chars_per_sec = 1

        try:
            min_delay = float(min_delay)
            max_delay = float(max_delay)
        except (TypeError, ValueError):
            min_delay = 0.5
            max_delay = 3.0

        if max_delay < min_delay:
            max_delay = min_delay

        delay = len(text) / float(chars_per_sec)
        if delay < min_delay:
            delay = min_delay
        if delay > max_delay:
            delay = max_delay
        return delay
