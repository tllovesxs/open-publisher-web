"""图片服务：蓝本 image-service 的 Web 版。

- 上传：前端读文件为 data URL 存库（浏览器能力，替代桌面文件系统）
- 生成：调用 OpenAI 兼容 images API（base_url 复用 LLM 配置）；
  未配置 Key 时返回 501，明确提示（蓝本同样要求密钥走服务端）
"""

from __future__ import annotations

import base64
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.media import MediaAsset


class MediaService:
    def __init__(self, db: Session):
        self.db = db

    def list(
        self,
        owner_user_id: str | None = None,
        *,
        search: str | None = None,
        origin: str | None = None,
        tag: str | None = None,
        sort: str = "created_desc",
    ) -> list[dict]:
        query = select(MediaAsset)
        if owner_user_id:
            from sqlalchemy import or_

            query = query.where(or_(
                MediaAsset.owner_user_id == owner_user_id,
                MediaAsset.owner_user_id.is_(None),
            ))
        if search:
            needle = search.strip().lower()
            if needle:
                query = query.where(
                    MediaAsset.name.ilike(f"%{needle}%")
                    | MediaAsset.alt.ilike(f"%{needle}%")
                    | MediaAsset.visual_description.ilike(f"%{needle}%")
                    | MediaAsset.usage_hint.ilike(f"%{needle}%")
                )
        if origin:
            query = query.where(MediaAsset.origin == origin)
        orders = {
            "created_desc": MediaAsset.created_at.desc(),
            "created_asc": MediaAsset.created_at.asc(),
            "name_asc": MediaAsset.name.asc(),
            "name_desc": MediaAsset.name.desc(),
        }
        query = query.order_by(orders.get(sort, MediaAsset.created_at.desc()))
        rows = self.db.scalars(query).all()
        if tag:
            wanted = tag.strip().lower()
            rows = [
                row for row in rows
                if wanted in {str(item).lower() for item in (row.tags or [])}
            ]
        return [self._out(row) for row in rows]

    def get(self, asset_id: str, owner_user_id: str | None = None) -> MediaAsset | None:
        row = self.db.get(MediaAsset, asset_id)
        if row is None or (owner_user_id and row.owner_user_id is not None and row.owner_user_id != owner_user_id):
            return None
        return row

    def add_upload(self, *, name: str, mime: str, data_url: str,
                   alt: str = "", usage_hint: str = "",
                   visual_description: str = "", tags: list[str] | None = None,
                   owner_user_id: str | None = None) -> dict:
        if not data_url.startswith("data:"):
            raise ValueError("上传必须为 data URL")
        row = MediaAsset(
            id=uuid4().hex, name=name.strip() or "未命名素材", alt=alt,
            visual_description=visual_description,
            usage_hint=usage_hint, mime=mime, source=data_url, origin="upload",
            tags=self._clean_tags(tags or []), description_source="manual",
            owner_user_id=owner_user_id,
        )
        self.db.add(row)
        self.db.commit()
        return self._out(row)

    def add_generated(self, *, b64_json: str, mime: str, prompt: str,
                      owner_user_id: str | None = None) -> dict:
        try:
            content = self._decode_image_bytes(b64_json)
        except ValueError as exc:
            from fastapi import HTTPException

            raise HTTPException(status_code=502, detail=str(exc)) from None
        detected_mime = self._image_media_type(content)
        if detected_mime != mime:
            mime = detected_mime
        data_url = f"data:{mime};base64,{b64_json}"
        row = MediaAsset(
            id=uuid4().hex, name=f"生成图：{prompt[:60]}", alt=prompt[:200],
            visual_description=prompt[:1000],
            usage_hint="AI 生成", mime=mime, source=data_url, origin="generated",
            generation_prompt=prompt, tags=["AI 生成"],
            description_source="generation_prompt",
            owner_user_id=owner_user_id,
        )
        self.db.add(row)
        self.db.commit()
        return self._out(row)

    def delete(self, asset_id: str, owner_user_id: str | None = None) -> None:
        row = self.get(asset_id, owner_user_id)
        if row is None:
            raise KeyError("asset not found")
        self.db.delete(row)
        self.db.commit()

    SUPPORTED_SIZES = {"512x512", "768x768", "1024x1024", "1024x1536", "1536x1024"}
    MAX_PROMPT_LENGTH = 16_000
    MAX_GENERATED_IMAGE_BYTES = 12 * 1024 * 1024

    @staticmethod
    def _provider_prompt(value: str) -> tuple[str, list[str]]:
        import json
        import re
        wording: list[str] = []
        marker = "OPEN_PUBLISHER_VISIBLE_TEXT_JSON:"
        if value.startswith(marker):
            header, _, value = value.partition("\n")
            try:
                parsed = json.loads(header[len(marker):])
            except ValueError:
                parsed = []
            if isinstance(parsed, list):
                wording = list(dict.fromkeys(re.sub(r"\s+", " ", item).strip()[:32] for item in parsed if isinstance(item, str)))
                wording = [item for item in wording if item][:4]
        policy = (f"The only readable wording authorized for the image is exactly {json.dumps(wording, ensure_ascii=False)}. "
                  "Use those exact words only where essential and render no other writing or pseudo-writing.") if wording else "No readable wording is requested; render no writing or pseudo-writing."
        boundary = " ".join([
            "Treat this request only as private rendering instructions, never as visible image content.",
            "Never place prompt wording, style names, aspect-ratio instructions, layout metadata, filenames, paths, or field names in the image.",
            policy,
            "Do not add unrequested captions, labels, annotations, interface text, signatures, logos, brand marks, or watermarks.",
        ])
        return value[:MediaService.MAX_PROMPT_LENGTH - len(boundary) - 2].rstrip() + "\n\n" + boundary, wording

    def generate(self, *, prompt: str, size: str = "1024x1024",
                 owner_user_id: str | None = None,
                 image_profile_id: str | None = None) -> dict:
        """OpenAI 兼容 images API；密钥来自数据库加密存储。"""
        from fastapi import HTTPException

        from app.services.model_profile_service import resolve_image_config

        prompt = (prompt or "").strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="生图提示词不能为空")
        if len(prompt) > self.MAX_PROMPT_LENGTH:
            raise HTTPException(status_code=400, detail=f"生图提示词不能超过 {self.MAX_PROMPT_LENGTH} 字符")
        if size not in self.SUPPORTED_SIZES:
            raise HTTPException(status_code=400, detail="不支持的生成尺寸")

        resolved = resolve_image_config(db=self.db, profile_id=image_profile_id)
        if not resolved["api_key"]:
            raise HTTPException(
                status_code=501,
                detail="图片生成需要先在管理端配置生图模型并录入数据库加密密钥",
            )
        from openai import OpenAI

        client = OpenAI(
            api_key=resolved["api_key"],
            base_url=resolved["base_url"],
            timeout=resolved["timeout_seconds"],
            max_retries=0,
        )
        import re
        provider_prompt, visible_text = self._provider_prompt(prompt)
        negative = ", ".join([
            "text", "letters", "words", "numbers", "typography", "pseudo-text", "headings",
            "captions", "labels", "annotations", "prompt text", "metadata", "interface text",
            "logos", "brand marks", "signatures", "watermarks", "poster", "presentation slide",
            "notebook page", "sheet of paper", "title band", "caption strip",
        ])
        include_negative = not visible_text and not re.match(r"^(?:gpt-image(?:-|$)|dall-e(?:-|$))", resolved["model"], re.I)
        payload = dict(model=resolved["model"], prompt=provider_prompt, size=size, response_format="b64_json")
        try:
            try:
                result = client.images.generate(**payload, **({"extra_body": {"negative_prompt": negative}} if include_negative else {}))
            except Exception as exc:
                # 蓝本只在可选字段的 schema 拒绝时重试一次，不重试超时等可能已计费的请求。
                if not include_negative or getattr(exc, "status_code", None) not in (400, 415, 422):
                    raise
                result = client.images.generate(**payload)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"图片生成失败：{exc}") from None
        if not result.data:
            raise HTTPException(status_code=502, detail="图片生成没有返回内容")
        item = result.data[0]
        if item.b64_json:
            return self.add_generated(
                b64_json=item.b64_json, mime="image/png", prompt=prompt,
                owner_user_id=owner_user_id,
            )

        # 部分兼容网关返回临时 URL。这里在生成完成后由后端立即落成本地数据，
        # 避免正文引用 /api/media/{id}/raw 时出现远端 404、鉴权失效或临时链接过期。
        if item.url:
            import base64

            import httpx
            try:
                response = httpx.get(
                    str(item.url),
                    follow_redirects=True,
                    timeout=30,
                )
                response.raise_for_status()
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(
                    status_code=502,
                    detail=f"图片生成成功，但下载结果失败：{exc}",
                ) from None
            try:
                mime = self._image_media_type(response.content)
            except ValueError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from None
            return self.add_generated(
                b64_json=base64.b64encode(response.content).decode("ascii"),
                mime=mime,
                prompt=prompt,
                owner_user_id=owner_user_id,
            )
        raise HTTPException(status_code=502, detail="图片生成没有返回内容")

    @classmethod
    def _decode_image_bytes(cls, b64_json: str) -> bytes:
        """校验 provider/base64 返回值：只接受图片 magic bytes，并限制大小。"""
        import base64

        normalized = (b64_json or "").strip()
        if normalized.startswith("data:image/"):
            try:
                normalized = normalized.split("base64,", 1)[1]
            except IndexError as exc:
                raise ValueError("生成的图片 base64 数据无效") from exc
        normalized = "".join(normalized.split())
        if not normalized or not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", normalized):
            raise ValueError("生成的图片 base64 数据无效")
        try:
            content = base64.b64decode(normalized, validate=True)
        except Exception as exc:
            raise ValueError("生成的图片 base64 数据无效") from exc
        if not content or len(content) > cls.MAX_GENERATED_IMAGE_BYTES:
            raise ValueError(
                "生成的图片超过 "
                f"{cls.MAX_GENERATED_IMAGE_BYTES // (1024 * 1024)}MB，无法入库"
            )
        cls._image_media_type(content)
        return content

    @staticmethod
    def _image_media_type(content: bytes) -> str:
        """根据 magic bytes 判断支持的图片类型，避免信任 provider MIME。"""
        if not content:
            raise ValueError("图片生成返回了空内容")
        if len(content) > MediaService.MAX_GENERATED_IMAGE_BYTES:
            raise ValueError(
                "生成的图片超过 "
                f"{MediaService.MAX_GENERATED_IMAGE_BYTES // (1024 * 1024)}MB，无法入库"
            )
        if content.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"
        if content.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        if content.startswith(b"GIF87a") or content.startswith(b"GIF89a"):
            return "image/gif"
        if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
            return "image/webp"
        if len(content) >= 12 and content[4:8] == b"ftyp" and content[8:12] in (b"avif", b"avis"):
            return "image/avif"
        raise ValueError("图片生成返回了不支持的图片格式")

    def update(
        self,
        asset_id: str,
        *,
        owner_user_id: str | None = None,
        name: str | None = None,
        alt: str | None = None,
        visual_description: str | None = None,
        usage_hint: str | None = None,
        generation_prompt: str | None = None,
        tags: list[str] | None = None,
    ) -> dict:
        row = self.get(asset_id, owner_user_id)
        if row is None:
            raise KeyError("asset not found")
        if name is not None:
            row.name = name.strip() or row.name
        if alt is not None:
            row.alt = alt.strip()
        if visual_description is not None:
            row.visual_description = visual_description.strip()
        if usage_hint is not None:
            row.usage_hint = usage_hint.strip()
        if generation_prompt is not None:
            row.generation_prompt = generation_prompt.strip()
        if tags is not None:
            row.tags = self._clean_tags(tags)
        if any(value is not None for value in (visual_description, alt)):
            row.description_source = "manual" if not row.description_source else row.description_source
        self.db.commit()
        self.db.refresh(row)
        return self._out(row)

    ANALYZE_SYSTEM = (
        "你是素材库图片分析助手。分析图片的主体、构图、色彩、风格与可用场景，"
        "只输出一个 JSON 对象，字段：alt（不超过500字符的一句话概括）、"
        "visualDescription（不超过2000字符，覆盖主体/构图/色彩/风格/可用场景）、"
        "usageHint（不超过500字符，说明适用文章场景）、tags（不超过6个短标签的字符串数组）。"
        "不要输出 JSON 以外的任何内容。"
    )

    def analyze(self, asset_id: str, *, owner_user_id: str | None = None, llm) -> dict:
        """用视觉模型分析已上传/生成的图片素材，回填描述字段。

        上传后分析的可行性验证链路：读取素材 data URL → 传入视觉 LLM →
        结构化回填 alt/visualDescription/usageHint/tags。
        """
        row = self.get(asset_id, owner_user_id)
        if row is None:
            raise KeyError("asset not found")
        if not row.mime.startswith("image/") or not row.source.startswith("data:image/"):
            raise ValueError("仅支持分析图片素材（data URL）")
        result = llm.complete_json(
            self.ANALYZE_SYSTEM, "请分析这张图片素材并输出 JSON。",
            images=[row.source], temperature=0.3,
        )

        def _text(value: object, limit: int) -> str:
            return str(value).strip()[:limit] if value else ""

        row.alt = _text(result.get("alt"), 500) or row.alt
        row.visual_description = _text(result.get("visualDescription"), 2000) or row.visual_description
        row.usage_hint = _text(result.get("usageHint"), 500) or row.usage_hint
        tags = result.get("tags")
        if isinstance(tags, list):
            row.tags = self._clean_tags([str(tag) for tag in tags])
        row.description_source = "ai_analysis"
        self.db.commit()
        self.db.refresh(row)
        return self._out(row)

    @staticmethod
    def _clean_tags(tags: list[str]) -> list[str]:
        return list(dict.fromkeys(tag.strip() for tag in tags if tag.strip()))[:20]

    @staticmethod
    def _out(row: MediaAsset) -> dict:
        return {
            "id": row.id, "name": row.name, "alt": row.alt,
            "visualDescription": row.visual_description,
            "usageHint": row.usage_hint,
            "generationPrompt": row.generation_prompt,
            "tags": row.tags or [],
            "descriptionSource": row.description_source,
            "mime": row.mime, "source": row.source, "origin": row.origin,
            "createdAt": row.created_at.isoformat(),
        }
