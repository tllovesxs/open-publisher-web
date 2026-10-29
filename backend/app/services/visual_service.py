"""视觉规划服务：蓝本 visual-planning-service 的模型驱动版。

蓝本分两层：文本模型产出结构化 placement；模型不可用时降级为本地
确定性规划器。Web 版沿用同一契约，默认优先调用文本模型，失败或未
配置密钥时自动降级为确定性规划器：
- 每个位置对素材做 0-1000 相似度打分，取前 5 个候选；
- 最高分 >= materialMatchThreshold * 10 时 source=existing_asset，
  否则 source=generate 并生成可复现的生图提示词；
- apply 阶段绑定 baseRevisionId + baseContentHash（乐观并发），
  生成的图立即进入素材库，正文以 asset:// 引用插入并落新版本。
"""

from __future__ import annotations

import json
import re
import unicodedata
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.media import MediaAsset
from app.services.article_store import ArticleConflictError, ArticleStore
from app.services.media_service import MediaService

MAX_PLACEMENTS = 6
MAX_CANDIDATES = 5

_VISUAL_TYPES = {"infographic", "scene", "flowchart", "comparison", "framework", "timeline"}

_VISUAL_FORM = {
    "scene": "一个象征性主体构成克制的编辑场景",
    "flowchart": "最多三个象征性对象用方向箭头连接",
    "comparison": "左右均衡构图，用物体与颜色对比两种状态",
    "timeline": "从左到右的时间推进，用物件间距表现顺序",
}

_TYPE_HINTS = (
    (("对比", "相比", "差异", "vs", "versus"), "comparison"),
    (("流程", "步骤", "架构", "pipeline"), "flowchart"),
    (("时间线", "历史", "演进", "阶段"), "timeline"),
)


def _normalize(value: str) -> str:
    return unicodedata.normalize("NFKC", value).lower()


def _tokens(value: str) -> set[str]:
    """与蓝本一致：连续 CJK 的二/三元组、单汉字、至少两个字符的拉丁词。"""
    normalized = value.lower()
    tokens = set(re.findall(r"[a-z0-9]{2,}", normalized))
    for sequence in re.findall(r"[\u4e00-\u9fff]+", normalized):
        if len(sequence) == 1:
            tokens.add(sequence)
        for width in (2, 3):
            tokens.update(sequence[i:i + width] for i in range(len(sequence) - width + 1))
    return tokens


def _similarity(left: str, right: str) -> int:
    a, b = _tokens(left), _tokens(right)
    if not a or not b:
        return 0
    overlap = len(a & b)
    score = min(1, overlap / len(a) * 0.82 + 2 * overlap / (len(a) + len(b)) * 0.18)
    return int(score * 1000 + 0.5)


def _visual_type(text: str) -> str:
    lowered = _normalize(text)
    for hints, visual_type in _TYPE_HINTS:
        if any(hint in lowered for hint in hints):
            return visual_type
    return "scene"


def _excerpt(text: str, limit: int = 60) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip()
    return cleaned[:limit]


class MarkdownBlock:
    __slots__ = ("heading", "text", "excerpt", "start_line", "end_line")

    def __init__(self, *, heading: str | None, text: str,
                 start_line: int, end_line: int):
        self.heading = heading
        self.text = text
        self.excerpt = _excerpt(text, 220) or _excerpt(heading or "", 220)
        self.start_line = start_line
        self.end_line = end_line


def split_markdown_blocks(markdown: str) -> list[MarkdownBlock]:
    """复用蓝本段落规则：排除代码围栏、图片、表格、引用和列表。"""
    blocks: list[MarkdownBlock] = []
    heading: str | None = None
    body: list[str] = []
    start = 0
    in_fence = False

    def flush(end: int) -> None:
        text = re.sub(r"\s+", " ", "\n".join(body)).strip()[:2000]
        body.clear()
        if text and not re.match(r"^(?:!\[|\||>\s|[-*+]\s)", text):
            blocks.append(MarkdownBlock(heading=heading, text=text, start_line=start, end_line=end))

    for index, line in enumerate(markdown.splitlines()):
        if line.lstrip().startswith("```"):
            flush(index - 1)
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        match = re.match(r"^#{1,6}\s+(.+?)\s*$", line)
        if match:
            flush(index - 1)
            heading = match[1][:180]
        elif not line.strip() or re.match(r"^(?:\s*[-*+]\s+|\s*\d+[.)]\s+|\s*>\s*)", line):
            flush(index - 1)
        else:
            if not body:
                start = index
            body.append(line)
    flush(len(markdown.splitlines()) - 1)
    return blocks


def _choose_blocks(blocks: list[MarkdownBlock], count: int) -> list[MarkdownBlock]:
    if not blocks:
        return []
    count = max(0, min(count, MAX_PLACEMENTS))
    return [blocks[min(i * len(blocks) // count, len(blocks) - 1)] for i in range(count)]


def auto_image_count(markdown: str) -> int:
    length = len(re.sub(r"\s", "", markdown).encode("utf-16-le")) // 2
    return 1 if length <= 900 else 2 if length <= 2000 else 3 if length <= 3800 else 4


def _candidates_for(block: MarkdownBlock, assets: list[MediaAsset], *, visual_content: str | None = None, purpose: str = "") -> list[dict]:
    query = f"{visual_content or block.text}\n{purpose}"
    scored = sorted(
        (
            {
                "assetId": asset.id,
                # 只用语义字段匹配；name 是管理用标签，会稀释相似度
                "score": _similarity(query, (
                    f"{asset.alt}\n{asset.visual_description}"
                )),
                "description": _excerpt(f"{asset.alt} {asset.visual_description}", 900),
            }
            for asset in assets
        ),
        key=lambda item: (-item["score"], item["assetId"]),
    )
    return scored[:MAX_CANDIDATES]


def _generation_prompt(block: MarkdownBlock, *, visual_content: str | None = None,
                       visual_type: str = "scene", visible_text: list[str] | None = None) -> str:
    forms = {
        "infographic": "A sparse arrangement of symbolic objects, simple shapes, and connecting lines",
        "scene": "One symbolic focal subject in a restrained editorial scene",
        "flowchart": "A sequence of up to three symbolic objects connected by directional arrows",
        "comparison": "A balanced split composition contrasting two visual states through objects and color",
        "framework": "A small group of visual nodes connected through shape, position, and line",
        "timeline": "A left-to-right progression shown through objects, spacing, and directional movement",
    }
    wording = visible_text or []
    policy = (f"The only readable wording permitted is exactly {json.dumps(wording, ensure_ascii=False)}. "
              "Use it only where essential for understanding, reproduce it verbatim, and render no other writing or pseudo-writing.") if wording else "No readable wording is needed. Render no writing or pseudo-writing."
    brief = _excerpt(visual_content or block.text or "文章核心观点", 260)
    return " ".join([
        f"OPEN_PUBLISHER_VISIBLE_TEXT_JSON:{json.dumps(wording, ensure_ascii=False)}\n"
        f"{forms.get(visual_type, forms['infographic'])} representing this idea: {brief}.",
        "Use one focal subject, clear relationships, and generous negative space on a simple full-bleed background.",
        "Render with soft hand-drawn ink lines, simple flat shapes, and a subtle tactile texture; use muted coral, soft mint, warm gray, and off-white.",
        "Communicate only with objects, icons, shapes, arrows, scale, position, and color.",
        "Leave no header area, title band, caption strip, poster frame, presentation slide, sheet of paper, notebook page, card, diagram key, or interface panel.",
        policy,
        "Never render prompt fragments, style names, aspect-ratio instructions, layout metadata, filenames, signatures, logos, brand marks, or watermarks.",
        "Apart from explicitly permitted wording, do not reproduce any phrase from the article or this request. Avoid dense dashboards, portraits, and fabricated metrics.",
    ])[:12000]


def _alt_for(block: MarkdownBlock, ordinal: int) -> str:
    base = _excerpt(block.heading or "文章配图", 60)
    return re.sub(r"[\[\]\r\n]", " ", base).strip() or f"文章配图 {ordinal}"


def _clean_text(value: object, limit: int = 900) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _match_block(
    placement: dict, blocks: list[MarkdownBlock],
) -> MarkdownBlock | None:
    """按模型给出的标题/摘录反查正文块；精确命中优先，其次包含度。"""
    heading = _clean_text(placement.get("anchorHeading") or placement.get("afterHeading"))
    excerpt = _clean_text(placement.get("anchorExcerpt") or placement.get("position"))
    position = f"{heading} / {excerpt}"
    named = [block for block in blocks if block.heading and block.heading in position]
    candidates = named or blocks
    for block in candidates:
        if excerpt and excerpt in block.text:
            return block
    visual_content = _clean_text(placement.get("visualContent"), 1500)
    scored = sorted(candidates, key=lambda block: -_similarity(
        f"{position}\n{visual_content}", f"{block.heading or ''}\n{block.text}",
    ))
    return scored[0] if scored and (excerpt or heading or visual_content) else None


def _visual_model_prompt(
    blocks: list[MarkdownBlock], assets: list[MediaAsset], target_count: int,
    material_match_threshold: int,
) -> tuple[str, str]:
    asset_briefs = [
        {
            "id": asset.id, "alt": asset.alt,
            "description": _clean_text(asset.visual_description or asset.alt, 240),
            "usage": _clean_text(asset.usage_hint, 120),
            "tags": asset.tags or [],
        }
        for asset in assets
    ]
    section_briefs = [
        {
            "heading": block.heading,
            "excerpt": block.excerpt,
            "content": _clean_text(block.text, 900),
        }
        for block in blocks
    ]
    system = (
        "You are the planning phase of the article illustrator. "
        "Return a strict JSON object with a placements array. Do not create images. "
        "Each placement teaches one concrete relationship, comparison, process, "
        "framework or timeline. Prefer sparse explanatory visuals over decorative posters. "
        "Never ask for paragraphs, tables, UI screenshots or many labels inside the image. "
        "Use an existing asset only when its metadata serves the visual need, and at most once. "
        "Otherwise use generate. Return exactly the requested number of placements."
    )
    user = json.dumps({
        "targetCount": target_count,
        "materialMatchThreshold": material_match_threshold * 10,
        "sections": section_briefs,
        "assets": asset_briefs,
        "placementSchema": {
            "anchorHeading": "Section heading or null",
            "anchorExcerpt": "A short verbatim excerpt used to locate the insertion point",
            "purpose": "Why this visual helps readers",
            "visualType": "infographic | scene | flowchart | comparison | framework | timeline",
            "visualContent": "One concrete visual idea, not article copy",
            "visibleText": "Optional at most four labels, each <=80 characters and verbatim in article",
            "source": "existing_asset | generate",
            "assetId": "Asset id for existing_asset, otherwise null",
            "selectionReason": "Short reason",
            "alt": "Concise image alt text",

        },
    }, ensure_ascii=False)
    return system, user


def _model_plan(
    blocks: list[MarkdownBlock],
    assets: list[MediaAsset],
    *,
    target_count: int,
    material_match_threshold: int,
    required_asset_ids: list[str],
) -> tuple[list[dict], str | None] | None:
    """模型驱动规划；不可用/输出不合法时返回 None 以触发规则兜底。"""
    from app.agents.llm_client import LLMClient

    llm = LLMClient()
    if not llm.api_key_configured:
        return None
    system, user = _visual_model_prompt(
        blocks, assets, target_count, material_match_threshold,
    )
    try:
        data = llm.complete_json(system, user, temperature=0.25)
    except Exception:  # noqa: BLE001 - 规划失败必须无感回退
        return None
    candidates = data.get("placements")
    if not isinstance(candidates, list) or len(candidates) != target_count:
        return None

    placements: list[dict] = []
    used_assets: set[str] = set()
    used_blocks: set[int] = set()
    for ordinal, raw in enumerate(candidates, start=1):
        if not isinstance(raw, dict):
            return None
        block = _match_block(raw, [b for b in blocks if b.start_line not in used_blocks] or blocks)
        if block is None:
            return None
        used_blocks.add(block.start_line)
        visual_type = _clean_text(raw.get("visualType"), 40)
        if visual_type not in _VISUAL_TYPES:
            visual_type = _visual_type(block.text)
        asset_id = _clean_text(raw.get("assetId"), 100) or None
        visual_content = _clean_text(raw.get("visualContent"), 1500) or _excerpt(block.text, 260)
        purpose = _clean_text(raw.get("purpose"), 900) or "补充小节说明"
        candidates_for_block = _candidates_for(block, assets, visual_content=visual_content, purpose=purpose)
        required_id = required_asset_ids[ordinal - 1] if ordinal <= len(required_asset_ids) else None
        requested_id = asset_id if raw.get("source") == "existing_asset" else None
        special_id = required_id or requested_id
        special_asset = next((a for a in assets if a.id == special_id), None)
        if special_asset and not any(c["assetId"] == special_id for c in candidates_for_block):
            special = _candidates_for(block, [special_asset], visual_content=visual_content, purpose=purpose)[0]
            candidates_for_block = candidates_for_block[:MAX_CANDIDATES - 1] + [special]
        future_required = set(required_asset_ids[ordinal:])
        valid_asset = next((c for c in candidates_for_block if c["assetId"] == special_id and c["assetId"] not in used_assets), None)
        if valid_asset is None:
            valid_asset = next((c for c in candidates_for_block if c["score"] >= material_match_threshold * 10 and c["assetId"] not in used_assets and c["assetId"] not in future_required), None)
        source, asset_id = ("existing_asset", valid_asset["assetId"]) if valid_asset else ("generate", None)
        if asset_id:
            used_assets.add(asset_id)
        wording = raw.get("visibleText")
        article_text = "\n".join(b.text for b in blocks)
        visible_text = [value for value in wording if isinstance(value, str) and 0 < len(value) <= 80 and value in article_text][:4] if isinstance(wording, list) else []
        alt = re.sub(r"[\[\]\r\n]", " ", _clean_text(raw.get("alt"), 160)).strip()
        placements.append({
            "id": f"illustration-{ordinal}",
            "anchorHeading": block.heading,
            "anchorExcerpt": block.excerpt,
            "purpose": purpose,
            "visualContent": visual_content,
            "visualType": visual_type,
            "source": source,
            "assetId": asset_id,
            "candidates": candidates_for_block,
            "selectionReason": _clean_text(raw.get("selectionReason"), 500) or (
                f"素材与该小节匹配度 {valid_asset['score'] // 10}%。"
                if valid_asset else "没有达到阈值的可用素材，需生成新图。"
            ),
            "alt": alt or _alt_for(block, ordinal),
            "generationPrompt": _generation_prompt(block, visual_content=visual_content, visual_type=visual_type, visible_text=visible_text),
        })
    return placements, llm.model


def _fallback_plan(
    chosen: list[MarkdownBlock], assets: list[MediaAsset], *,
    material_match_threshold: int,
    required_asset_ids: list[str],
) -> list[dict]:
    placements: list[dict] = []
    used_assets: set[str] = set()
    for ordinal, block in enumerate(chosen, start=1):
        visual_content = f"只表现“{_excerpt(block.excerpt, 90)}”这一个核心概念的简洁infographic配图"
        purpose = "帮助读者在阅读对应段落后快速理解核心关系。"
        candidates = _candidates_for(block, assets, visual_content=visual_content, purpose=purpose)
        required_id = required_asset_ids[ordinal - 1] if ordinal <= len(required_asset_ids) else None
        required_asset = next((a for a in assets if a.id == required_id), None)
        if required_asset and not any(c["assetId"] == required_id for c in candidates):
            candidates = candidates[:MAX_CANDIDATES - 1] + _candidates_for(block, [required_asset], visual_content=visual_content, purpose=purpose)
        default = next((c for c in candidates if c["assetId"] == required_id), None) or next(
            (
                c for c in candidates
                if c["score"] >= material_match_threshold * 10
                and c["assetId"] not in used_assets
                and c["assetId"] not in required_asset_ids[ordinal:]
            ),
            None,
        )
        if default is not None:
            used_assets.add(default["assetId"])
        placements.append({
            "id": f"illustration-{ordinal}",
            "anchorHeading": block.heading,
            "anchorExcerpt": block.excerpt,
            "purpose": purpose,
            "visualContent": visual_content,
            "visualType": "infographic",
            "source": "existing_asset" if default else "generate",
            "assetId": default["assetId"] if default else None,
            "candidates": candidates,
            "selectionReason": (
                f"素材与该小节匹配度 {default['score'] // 10}%。"
                if default
                else "没有达到阈值的可用素材，需生成新图。"
            ),
            "alt": _alt_for(block, ordinal),
            "generationPrompt": _generation_prompt(block, visual_content=visual_content, visual_type="infographic"),
        })
    return placements


class VisualService:

    def __init__(self, db: Session):
        self.db = db
        self.store = ArticleStore(db)
        self.media = MediaService(db)

    def plan(
        self,
        *,
        markdown: str,
        target_count: int,
        asset_ids: list[str] | None = None,
        material_match_threshold: int = 40,
        owner_user_id: str | None = None,
        mode: str = "fixed",
        required_asset_ids: list[str] | None = None,
    ) -> dict:
        blocks = split_markdown_blocks(markdown)
        required_asset_ids = list(dict.fromkeys(required_asset_ids or []))
        if mode == "none" and required_asset_ids:
            mode = "fixed"
        target_count = max(len(required_asset_ids), 0 if mode == "none" else auto_image_count(markdown) if mode == "auto" else target_count)
        chosen = _choose_blocks(blocks, target_count)
        assets: list[MediaAsset] = []
        if asset_ids:
            rows = self.db.scalars(
                select(MediaAsset).where(MediaAsset.id.in_(asset_ids))
            ).all()
            by_id = {row.id: row for row in rows}
            assets = [by_id[asset_id] for asset_id in dict.fromkeys(asset_ids) if asset_id in by_id and (owner_user_id is None or by_id[asset_id].owner_user_id in (None, owner_user_id))]
        if any(asset_id not in {a.id for a in assets} for asset_id in required_asset_ids):
            raise ValueError("指定插入的素材不在本次可用的已选素材中")
        # 明确插入的素材即使低分也保留，不能被候选数量上限淘汰。
        metadata = {
            "assetIds": [asset.id for asset in assets], "requiredAssetIds": required_asset_ids,
            "materialMatchThreshold": material_match_threshold, "mode": mode,
            "needsConfirmation": not required_asset_ids,
            "settings": {"style": "sketch-notes", "palette": "macaron", "generation_batch_size": "4"},
        }

        if chosen:
            model_result = _model_plan(
                blocks, assets,
                target_count=len(chosen),
                material_match_threshold=material_match_threshold,
                required_asset_ids=required_asset_ids,
            )
            if model_result:
                placements, provider_model = model_result
                return {
                    **metadata,
                    "sourceContentHash": None,  # apply 时以前端提交的哈希做并发校验
                    "targetCount": len(placements),
                    "placements": placements,
                    "planner": "model",
                    "plannerModel": provider_model,
                }
        placements = _fallback_plan(
            chosen, assets, material_match_threshold=material_match_threshold, required_asset_ids=required_asset_ids,
        )
        return {
            **metadata,
            "sourceContentHash": None,  # apply 时以前端提交的哈希做并发校验
            "targetCount": len(placements),
            "placements": placements,
            "planner": "deterministic",
            "plannerModel": None,
        }

    def apply(
        self,
        *,
        article_id: str,
        base_revision_id: str,
        base_content_hash: str,
        placements: list[dict],
        owner_user_id: str | None = None,
        image_model_id: str | None = None,
    ) -> dict:
        article = self.validate(
            article_id=article_id, base_revision_id=base_revision_id,
            base_content_hash=base_content_hash, placements=placements,
            owner_user_id=owner_user_id,
        )
        lines = article["markdown"].rstrip().split("\n")
        insertions: list[tuple[int, str]] = []
        for placement in placements:
            asset_id = placement.get("assetId")
            if placement.get("source") == "generate":
                # Legacy callers retain support; the Web client materializes four-wide
                # batches before apply. Any failure leaves the article unchanged.
                asset = self.media.generate(
                    prompt=placement["generationPrompt"], size="1536x1024",
                    image_profile_id=image_model_id, owner_user_id=owner_user_id,
                )
                asset_id = asset["id"]
            anchor_line = self._anchor_line(lines, placement)
            alt = re.sub(r"[\[\]\r\n]", " ", str(placement.get("alt") or "文章配图")).strip()
            insertions.append((anchor_line, f"![{alt}](asset://{asset_id})"))
        skipped: list[dict] = []

        for line_no, markup in sorted(insertions, key=lambda item: item[0], reverse=True):
            lines.insert(line_no + 1, "")
            lines.insert(line_no + 2, markup)
        next_markdown = "\n".join(lines).rstrip() + "\n"

        if not insertions:
            return {
                "article": article,
                "insertedCount": 0,
                "skipped": skipped,
            }

        committed = self.store.commit(
            article_id=article_id,
            base_revision_id=base_revision_id,
            base_content_hash=base_content_hash,
            title=article["title"],
            markdown=next_markdown,
            reason=f"visual-insert {uuid4().hex[:8]}",
            owner_user_id=owner_user_id,
        )
        return {
            "article": committed,
            "insertedCount": len(insertions),
            "skipped": skipped,
        }

    def validate(self, *, article_id: str, base_revision_id: str,
                 base_content_hash: str, placements: list[dict],
                 owner_user_id: str | None = None) -> dict:
        self.db.expire_all()
        article = self.store.read(article_id, owner_user_id)
        if article is None:
            raise KeyError("article not found")
        if article["currentRevisionId"] != base_revision_id or article["contentHash"] != base_content_hash:
            raise ArticleConflictError("Article changed after this operation started")
        lines = article["markdown"].rstrip().split("\n")
        for placement in placements:
            if self._anchor_line(lines, placement) is None:
                raise ValueError("未找到插入锚点，请重新生成策略")
            if placement.get("source") == "generate":
                prompt = (placement.get("generationPrompt") or "").strip()
                if not prompt or len(prompt) > self.media.MAX_PROMPT_LENGTH:
                    raise ValueError("生图提示词为空或过长，请重新生成策略")
            elif not placement.get("assetId") or self.media.get(placement["assetId"], owner_user_id) is None:
                raise ValueError("所选素材不存在或无权使用，请重新生成策略")
        return article

    @staticmethod
    def _anchor_line(lines: list[str], placement: dict) -> int | None:
        """按规划时的同一段落规则定位，支持跨行摘录和同标题多段正文。"""
        excerpt = _clean_text(placement.get("anchorExcerpt"), 300)
        heading = _clean_text(placement.get("anchorHeading"), 300)
        blocks = split_markdown_blocks("\n".join(lines))
        if excerpt:
            matches = [block for block in blocks if excerpt in block.text]
            exact_section = [block for block in matches if block.heading == heading]
            target = (exact_section or matches)
            return target[0].end_line if target else None
        if heading:
            return next((block.end_line for block in blocks if block.heading == heading), None)
        return None
