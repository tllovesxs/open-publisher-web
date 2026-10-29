"""Read only the top-level markdown string from incomplete tool JSON."""

import json
import time
from collections.abc import Callable


class MarkdownDeltaBuffer:
    """合并累计工具 JSON 快照，限制解析与落库频率，并在退出时保留尾段。"""

    def __init__(self, emit: Callable[[str, int], None], *, clock=None):
        self.emit = emit
        self.clock = clock or time.monotonic
        self.markdown = ""
        self.arguments = ""
        self.last_check = self.clock()
        self.checked_chars = 0

    def update(self, arguments: str, *, force: bool = False):
        self.arguments = arguments
        now = self.clock()
        if not force and now - self.last_check < 0.2 and len(arguments) - self.checked_chars < 180:
            return
        self.last_check = now
        self.checked_chars = len(arguments)
        content = markdown_prefix(arguments)
        if content.startswith(self.markdown) and len(content) > len(self.markdown):
            delta = content[len(self.markdown):]
            self.markdown = content
            self.emit(delta, len(content))

    def flush(self):
        self.update(self.arguments, force=True)


def markdown_prefix(arguments: str) -> str:
    decoder = json.JSONDecoder()
    pos = 0
    try:
        pos = len(arguments) - len(arguments.lstrip())
        if arguments[pos:pos + 1] != "{":
            return ""
        pos += 1
        while pos < len(arguments):
            while pos < len(arguments) and arguments[pos] in " \r\n\t,":
                pos += 1
            key, consumed = decoder.raw_decode(arguments[pos:])
            pos += consumed
            while pos < len(arguments) and arguments[pos].isspace():
                pos += 1
            if arguments[pos:pos + 1] != ":":
                return ""
            pos += 1
            while pos < len(arguments) and arguments[pos].isspace():
                pos += 1
            if key != "markdown":
                _, consumed = decoder.raw_decode(arguments[pos:])
                pos += consumed
                continue
            if arguments[pos:pos + 1] != '"':
                return ""
            start = pos + 1
            pos = start
            safe = start
            while pos < len(arguments):
                char = arguments[pos]
                if char == '"':
                    return json.loads(arguments[start - 1:pos + 1])
                if char == "\\":
                    if pos + 1 >= len(arguments):
                        break
                    size = 6 if arguments[pos + 1] == "u" else 2
                    if pos + size > len(arguments):
                        break
                    pos += size
                else:
                    pos += 1
                safe = pos
            value = json.loads('"' + arguments[start:safe] + '"')
            # Hold an unfinished surrogate pair until the next fragment.
            return value.rstrip(''.join(chr(i) for i in range(0xD800, 0xDC00)))
    except (ValueError, IndexError):
        return ""
    return ""
