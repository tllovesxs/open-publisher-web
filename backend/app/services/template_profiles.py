"""蓝本 reference-template.v2 的画像规范与离线结构兜底。"""
import re

STYLE = ("tone", "audience", "perspective", "sentenceStyle", "pacing", "density")
STRUCTURE = ("openingPattern", "sectionPattern", "conclusionPattern", "headingDepth", "paragraphPattern")
LAYOUT_TEXT = ("imagePlacement", "emphasisRules")
LAYOUT_BOOL = ("useLists", "useTables", "useBlockquotes", "useCodeBlocks")


def variables_in(markdown):
    return sorted(set(re.findall(r"\{\{([a-z][a-z0-9_]*)\}\}", markdown)))


def local_reference(source):
    lines = source.splitlines()
    headings = [re.match(r"^(#{1,6})\s+(.+)$", line) for line in lines]
    depths = [len(m[1]) for m in headings if m]
    sections = sum(d > 1 for d in depths)
    image_count = len(re.findall(r"!\[[^\]\n]*\]\([^)\n]+\)", source))
    outline = ["# {{title}}", "", "{{lead}}", ""]
    section = image = 0
    for line, heading in zip(lines, headings):
        if heading and len(heading[1]) > 1:
            section += 1
            outline += [f"{heading[1]} {{{{section_{section}_heading}}}}", "", f"{{{{section_{section}_content}}}}", ""]
        elif re.search(r"!\[[^\]]*\]\([^)]+\)", line):
            image += 1
            outline += [f"![{{{{image_{image}_alt}}}}]({{{{image_{image}_url}}}})", ""]
        elif re.match(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)", line):
            outline += ["- {{list_item_" + str(section or 1) + "}}", ""]
        elif re.match(r"^\s*>", line):
            outline += ["> {{quote}}", ""]
    if not section:
        outline += ["## {{section_1_heading}}", "", "{{section_1_content}}", ""]
    outline += ["## {{closing_heading}}", "", "{{closing}}"]
    markdown = "\n".join(outline)
    return {
        "name": "本地参考模板", "description": "模型分析未完成，已保留完整原文并生成可编辑写作蓝图。",
        "category": "参考写作", "markdown": markdown,
        "styleProfile": {
            "tone": "以参考原文为准，复用判断力度、措辞克制程度与解释方式。",
            "audience": "保持原文的术语密度和背景交代方式。",
            "perspective": "第一人称经验叙述" if re.search(r"我|我们|笔者", source) else "解释型作者视角",
            "sentenceStyle": "保持长短句交替和段落停顿；每段完成一个论证动作。",
            "pacing": f"按原文的 {max(sections, 1)} 个信息段分步推进，不合并转折、例证与收束。",
            "density": "高" if len(lines) >= 60 else "中等偏高",
        },
        "structureProfile": {
            "openingPattern": "复用原文开篇的切入动作与信息交代顺序，再进入新主题。",
            "sectionPattern": f"原文含 {sections} 个小节，按原有标题层级逐段推进。" if sections else "保持连续段落先引入再展开的节奏。",
            "conclusionPattern": "沿用原文结尾的收束方式、行动建议力度和留白程度。",
            "headingDepth": f"保留 H1-H{max(depths + [2])} 的层级关系。",
            "paragraphPattern": "按原文段落粒度推进，不把多个论证动作压缩为一段。",
        },
        "layoutProfile": {
            "useLists": bool(re.search(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)", source, re.M)),
            "useTables": "|" in source, "useBlockquotes": bool(re.search(r"^\s*>", source, re.M)),
            "useCodeBlocks": bool(re.search(r"^\s*```", source, re.M)),
            "imagePlacement": f"保留 {image_count} 个图片槽位，每张图解释前后的信息段。" if image_count else "原文没有图片槽位，按正文信息密度决定是否补图。",
            "emphasisRules": "保留原文对列表、引用、代码和强调的使用频率，不为装饰新增格式。",
        }, "fixedBlocks": [], "variables": variables_in(markdown),
        "usageInstructions": "参考原文只作写法样本；模仿组织、节奏、论证动作与图片职责，不复用原文事实、链接、数字、产品名或连续原句。",
    }


def normalize_profiles(data, source=""):
    """保留旧字段，补充蓝本字段；不把自由文本误转为布尔值。"""
    defaults = local_reference(source) if source else {"styleProfile": {}, "structureProfile": {}, "layoutProfile": {}}
    aliases = {
        "styleProfile": {"audience": "readerRelationship"},
        "structureProfile": {"sectionPattern": "sectionOrder", "headingDepth": "headingLevelRule"},
        "layoutProfile": {"emphasisRules": "emphasisStyle"},
    }
    result = dict(data)
    for group, keys in (("styleProfile", STYLE), ("structureProfile", STRUCTURE), ("layoutProfile", LAYOUT_TEXT + LAYOUT_BOOL)):
        snake_group = re.sub(r"([A-Z])", lambda m: "_" + m[1].lower(), group)
        raw = data.get(group, data.get(snake_group))
        raw = dict(raw) if isinstance(raw, dict) else {}
        for key in keys:
            snake = re.sub(r"([A-Z])", lambda m: "_" + m[1].lower(), key)
            value = raw.get(key, raw.get(snake))
            if value is None or value == "":
                value = raw.get(aliases[group].get(key, ""))
                if value is None and key == "headingDepth":
                    legacy_layout = data.get("layoutProfile")
                    value = legacy_layout.get("headingLevelRule") if isinstance(legacy_layout, dict) else None
            if key in LAYOUT_BOOL:
                raw[key] = value if isinstance(value, bool) else defaults[group].get(key, key == "useLists")
            else:
                if isinstance(value, list):
                    value = "、".join(str(item) for item in value)
                raw[key] = value if isinstance(value, str) and value.strip() else defaults[group].get(key, "")
        result[group] = raw
    return result
