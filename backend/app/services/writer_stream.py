"""Read only the top-level markdown string from incomplete tool JSON."""

import json


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
