from app.services.writer_stream import markdown_prefix


def test_markdown_prefix_reads_only_complete_top_level_string():
    assert markdown_prefix(
        '{"title":"标题","markdown":"# 标题\\n\\n正文。","reason":"'
    ) == "# 标题\n\n正文。"


def test_markdown_prefix_unescapes_quotes_and_backslashes():
    assert markdown_prefix(
        '{"markdown":"路径\\\\文件和\\"引用\\"'
    ) == '路径\\文件和"引用"'


def test_markdown_prefix_omits_incomplete_escape():
    assert markdown_prefix('{"markdown":"内容\\u4e2d\\uD83D') == "内容中"


def test_markdown_prefix_does_not_expose_other_tool_fields():
    assert markdown_prefix('{"title":"标题","reason":"说明","markdown":"正文') == "正文"
    assert markdown_prefix('{"title":"标题","reason":"说明"}') == ""
