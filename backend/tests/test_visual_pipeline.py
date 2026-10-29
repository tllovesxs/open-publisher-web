"""视觉配图链路测试：规划（素材匹配/生图提示词）+ 应用（插图落新版本）。"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models.media import MediaAsset
from app.services.article_store import ArticleConflictError, ArticleStore
from app.services.visual_service import VisualService

MARKDOWN = """# 测试文章标题

开篇导语，介绍整体背景。

## 产品架构

系统由三个服务组成，流程从采集到渲染。

## 数据对比

与上一版本相比，导出速度差异明显。

## 结语

持续迭代。
"""


@pytest.fixture()
def factory():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    yield sessionmaker(bind=engine, autoflush=False, autocommit=False)
    engine.dispose()


@pytest.fixture()
def client(factory):
    def override():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def prevent_visual_planner_network(monkeypatch):
    """单测不允许依赖真实模型；需要模型规划用例会再次覆写此类。"""
    from app.agents import llm_client

    class NoKeyLLM:
        api_key_configured = False

    monkeypatch.setattr(llm_client, "LLMClient", NoKeyLLM)


@pytest.fixture()
def article(factory):
    with factory() as db:
        return ArticleStore(db).commit(
            article_id="article-visual",
            base_revision_id=None,
            base_content_hash=None,
            title="测试文章",
            markdown=MARKDOWN,
            reason="seed",
        )


def _add_asset(factory, *, asset_id: str, alt: str) -> None:
    with factory() as db:
        db.add(MediaAsset(
            id=asset_id, name=f"素材-{asset_id}", alt=alt, usage_hint="",
            mime="image/png", source="data:image/png;base64,iVBORw0KGgo=",
            origin="upload",
        ))
        db.commit()


def test_plan_matches_asset_and_generates_prompts(factory, article):
    _add_asset(factory, asset_id="a-arch", alt="系统由三个服务组成，流程从采集到渲染。")
    with factory() as db:
        service = VisualService(db)
        plan = service.plan(
            markdown="## 产品架构\n\n系统由三个服务组成，流程从采集到渲染。\n\n## 数据对比\n\n导出速度差异明显。", target_count=2, asset_ids=["a-arch"], material_match_threshold=30,
        )

    assert plan["targetCount"] == 2
    assert [p["id"] for p in plan["placements"]] == ["illustration-1", "illustration-2"]
    architecture = plan["placements"][0]
    assert architecture["source"] == "existing_asset"
    assert architecture["assetId"] == "a-arch"
    assert architecture["candidates"][0]["assetId"] == "a-arch"
    assert architecture["candidates"][0]["score"] == 355
    for placement in plan["placements"]:
        assert placement["anchorHeading"]
        assert placement["generationPrompt"]
        assert "No readable wording" in placement["generationPrompt"]


def test_plan_without_assets_all_generate(factory, article):
    with factory() as db:
        plan = VisualService(db).plan(markdown=MARKDOWN, target_count=3)
    assert plan["targetCount"] == 3
    assert all(p["source"] == "generate" for p in plan["placements"])


def test_plan_uses_model_and_falls_back(factory, article, monkeypatch):
    from app.agents import llm_client

    class FakeLLM:
        model = "planner-model"
        api_key_configured = True

        @staticmethod
        def complete_json(*args, **kwargs):
            return {
                "placements": [
                    {
                        "anchorHeading": "数据对比",
                        "anchorExcerpt": "导出速度差异",
                        "purpose": "说明性能差异",
                        "visualType": "comparison",
                        "source": "generate",
                        "assetId": None,
                        "selectionReason": "对比图最直观。",
                        "alt": "导出速度对比",
                        "generationPrompt": "简洁左右对比示意图，无文字。",
                    },
                ],
            }

    monkeypatch.setattr(llm_client, "LLMClient", FakeLLM)
    with factory() as db:
        plan = VisualService(db).plan(markdown=MARKDOWN, target_count=1)
    assert plan["planner"] == "model"
    assert plan["plannerModel"] == "planner-model"
    assert plan["placements"][0]["anchorHeading"] == "数据对比"
    assert plan["placements"][0]["visualType"] == "comparison"

    class BadLLM:
        model = "bad-model"
        api_key_configured = True

        @staticmethod
        def complete_json(*args, **kwargs):
            raise RuntimeError("upstream unavailable")

    monkeypatch.setattr(llm_client, "LLMClient", BadLLM)
    with factory() as db:
        plan = VisualService(db).plan(markdown=MARKDOWN, target_count=1)
    assert plan["planner"] == "deterministic"
    assert len(plan["placements"]) == 1


def test_apply_inserts_assets_and_commits_revision(factory, article):
    _add_asset(factory, asset_id="a-1", alt="数据对比图")
    with factory() as db:
        plan = VisualService(db).plan(
            markdown=MARKDOWN, target_count=2, asset_ids=["a-1"],
        )
        # 第一张强制走生图路径，覆盖两条插入分支
        placements = plan["placements"]
        placements[0] = {
            **placements[0], "source": "generate",
            "generationPrompt": "一幅极简示意图",
        }
        placements[1] = {**placements[1], "source": "existing_asset", "assetId": "a-1"}
        generated: dict = {}

        def fake_generate(*, prompt: str, size: str = "1024x1024", image_profile_id: str | None = None, owner_user_id: str | None = None):
            generated["prompt"] = prompt
            return {
                "id": "gen-1", "name": "生成图", "alt": prompt[:200],
                "usageHint": "AI 生成", "mime": "image/png",
                "source": "data:image/png;base64,iVBORw0KGgo=",
                "origin": "generated", "createdAt": "2026-10-19T00:00:00",
            }

        service = VisualService(db)
        service.media.generate = fake_generate  # type: ignore[method-assign]
        result = service.apply(
            article_id="article-visual",
            base_revision_id=article["currentRevisionId"],
            base_content_hash=article["contentHash"],
            placements=placements,
        )

    assert result["insertedCount"] == 2
    assert result["skipped"] == []
    assert generated["prompt"] == "一幅极简示意图"
    markdown = result["article"]["markdown"]
    assert "asset://a-1" in markdown
    assert "asset://gen-1" in markdown
    assert result["article"]["currentRevisionId"] != article["currentRevisionId"]
    assert "## 数据对比" in markdown


def test_apply_rejects_stale_revision(factory, article):
    with factory() as db:
        service = VisualService(db)
        with pytest.raises(ArticleConflictError):
            service.apply(
                article_id="article-visual",
                base_revision_id="stale-revision",
                base_content_hash=article["contentHash"],
                placements=[{
                    "id": "illustration-1", "source": "generate",
                    "generationPrompt": "p", "alt": "配图",
                }],
            )


def test_visual_plan_api_returns_hash_binding(client, article):
    res = client.post("/api/articles/article-visual/visual-plan", json={
        "targetCount": 2, "assetIds": [], "materialMatchThreshold": 40,
    })
    assert res.status_code == 200
    body = res.json()
    assert body["sourceRevisionId"] == article["currentRevisionId"]
    assert body["sourceContentHash"] == article["contentHash"]
    assert len(body["placements"]) == 2


def test_visual_apply_api_creates_new_revision(client, factory, article, monkeypatch):
    def fake_generate(self, *, prompt: str, size: str = "1024x1024", image_profile_id: str | None = None, owner_user_id: str | None = None):
        return {
            "id": "gen-api", "name": "生成图", "alt": prompt[:200],
            "usageHint": "AI 生成", "mime": "image/png",
            "source": "data:image/png;base64,iVBORw0KGgo=",
            "origin": "generated", "createdAt": "2026-10-19T00:00:00",
        }

    from app.services import media_service

    monkeypatch.setattr(media_service.MediaService, "generate", fake_generate)
    plan = client.post("/api/articles/article-visual/visual-plan", json={
        "targetCount": 1, "assetIds": [],
    }).json()
    res = client.post("/api/articles/article-visual/visual-apply", json={
        "baseRevisionId": article["currentRevisionId"],
        "baseContentHash": article["contentHash"],
        "placements": plan["placements"],
    })
    assert res.status_code == 200
    body = res.json()
    assert body["insertedCount"] == 1
    assert "asset://gen-api" in body["article"]["markdown"]

    state = client.get("/api/articles/article-visual").json()
    assert state["currentRevisionId"] == body["article"]["currentRevisionId"]



@pytest.mark.parametrize("length, expected", [(900, 1), (901, 2), (2000, 2), (2001, 3), (3800, 3), (3801, 4)])
def test_auto_count_matches_blueprint(length, expected):
    from app.services.visual_service import auto_image_count
    assert auto_image_count("字" * length) == expected


def test_blueprint_similarity_and_paragraph_filter():
    from app.services.visual_service import _similarity, _tokens, split_markdown_blocks
    assert _tokens("中 ab c 中文测试") == {"中", "ab", "中文", "文测", "测试", "中文测", "文测试"}
    assert _similarity("alpha beta gamma", "alpha beta") == 691
    blocks = split_markdown_blocks("# 标题\n\n正文一。\n\n```md\n伪正文\n```\n\n![图](asset://x)\n\n| 表格 |\n\n- 列表\n\n> 引用\n\n正文二。")
    assert [b.text for b in blocks] == ["正文一。", "正文二。"]


def test_plan_only_selected_accessible_assets(factory, article):
    _add_asset(factory, asset_id="shared", alt="背景")
    _add_asset(factory, asset_id="private", alt="背景")
    with factory() as db:
        db.get(MediaAsset, "private").owner_user_id = "other-user"
        db.commit()
        plan = VisualService(db).plan(markdown=MARKDOWN, target_count=2, asset_ids=["private", "shared"], owner_user_id="u-test")
        assert plan["assetIds"] == ["shared"]
        assert all(c["assetId"] == "shared" for p in plan["placements"] for c in p["candidates"])
        empty = VisualService(db).plan(markdown=MARKDOWN, target_count=2, owner_user_id="u-test")
        assert all(not p["candidates"] for p in empty["placements"])


def test_required_asset_survives_top_five_and_skips_redundant_confirmation(factory):
    for i in range(6):
        _add_asset(factory, asset_id=f"asset-{i}", alt="完全不同" if i == 5 else "alpha beta")
    with factory() as db:
        plan = VisualService(db).plan(markdown="# 标题\n\nalpha beta", target_count=0, mode="none", asset_ids=[f"asset-{i}" for i in range(6)], required_asset_ids=["asset-5"])
    assert plan["targetCount"] == 1
    assert plan["needsConfirmation"] is False
    assert plan["placements"][0]["assetId"] == "asset-5"
    assert any(c["assetId"] == "asset-5" for c in plan["placements"][0]["candidates"])


def test_preflight_checks_all_anchors_before_any_image(factory, article):
    with factory() as db:
        service = VisualService(db)
        service.media.generate = lambda **kwargs: pytest.fail("Invalid plan must not call image model")
        placements = service.plan(markdown=MARKDOWN, target_count=2)["placements"]
        placements[1] = {**placements[1], "anchorHeading": "missing", "anchorExcerpt": "missing"}
        with pytest.raises(ValueError, match="锚点"):
            service.apply(article_id=article["articleId"], base_revision_id=article["currentRevisionId"], base_content_hash=article["contentHash"], placements=placements)
        assert ArticleStore(db).read(article["articleId"])["currentRevisionId"] == article["currentRevisionId"]


def test_apply_failure_does_not_insert_partial_article(factory, article):
    with factory() as db:
        service = VisualService(db)
        placements = service.plan(markdown=MARKDOWN, target_count=2)["placements"]
        calls = []
        def fake_generate(**kwargs):
            calls.append(kwargs)
            if len(calls) == 2:
                raise RuntimeError("mock provider failed")
            return {"id": "generated-first"}
        service.media.generate = fake_generate
        with pytest.raises(RuntimeError):
            service.apply(article_id=article["articleId"], base_revision_id=article["currentRevisionId"], base_content_hash=article["contentHash"], placements=placements, owner_user_id="u-test")
        assert all(c["size"] == "1536x1024" and c["owner_user_id"] == "u-test" for c in calls)
        assert ArticleStore(db).read(article["articleId"])["markdown"] == article["markdown"]


def test_validation_endpoint_is_read_only_and_rejects_stale(client, article, monkeypatch):
    from app.services.media_service import MediaService
    monkeypatch.setattr(MediaService, "generate", lambda *args, **kwargs: pytest.fail("validation must not generate"))
    plan = client.post("/api/articles/article-visual/visual-plan", json={"mode": "auto", "targetCount": 0}).json()
    body = {"baseRevisionId": article["currentRevisionId"], "baseContentHash": article["contentHash"], "placements": plan["placements"]}
    assert client.post("/api/articles/article-visual/visual-validate", json=body).json() == {"valid": True}
    body["baseRevisionId"] = "stale"
    assert client.post("/api/articles/article-visual/visual-validate", json=body).status_code == 409
    assert client.get("/api/articles/article-visual").json()["markdown"] == article["markdown"]


def test_apply_rejects_inaccessible_or_deleted_material(client, factory, article):
    _add_asset(factory, asset_id="other-image", alt="测试")
    with factory() as db:
        db.get(MediaAsset, "other-image").owner_user_id = "other-user"
        db.commit()
    placement = client.post("/api/articles/article-visual/visual-plan", json={"targetCount": 1}).json()["placements"][0]
    for asset_id in ["other-image", "deleted-image"]:
        body = {"baseRevisionId": article["currentRevisionId"], "baseContentHash": article["contentHash"], "placements": [{**placement, "source": "existing_asset", "assetId": asset_id}]}
        assert client.post("/api/articles/article-visual/visual-apply", json=body).status_code == 400



def test_creation_prompt_keeps_images_in_post_save_workflow():
    from app.services.writer_service import WriterService
    sections = "\n".join(WriterService._creation_sections({"imagePlan": {"mode": "auto", "targetCount": 0}, "imageAssets": ["selected-material"]}))
    assert "按篇幅自动确定数量" in sections
    assert "目标图片数量：0" not in sections
    assert "不输出图片占位符" in sections
    assert "正文阶段不插图" in sections


def test_generate_api_accepts_blueprint_prompt_length(client, monkeypatch):
    from app.services.media_service import MediaService
    seen = []
    monkeypatch.setattr(MediaService, "generate", lambda self, **kwargs: seen.append(kwargs) or {"id": "mock"})
    res = client.post("/api/media/generate", json={"prompt": "p" * 4000, "size": "1536x1024", "imageModelId": "chosen-profile"})
    assert res.status_code == 201
    assert len(seen[0]["prompt"]) == 4000
    assert seen[0]["owner_user_id"] == "u-test"
    assert seen[0]["image_profile_id"] == "chosen-profile"



def test_anchor_tracks_exact_paragraph_with_wrapped_lines():
    from app.services.visual_service import _match_block, split_markdown_blocks
    markdown = "## 同一小节\n\n第一段不应插图。\n\n第二段开头，\n换行但属于同一段。\n\n第三段。"
    placement = {"anchorHeading": "同一小节", "anchorExcerpt": "第二段开头， 换行但属于同一段。"}
    blocks = split_markdown_blocks(markdown)
    assert _match_block(placement, blocks).text.startswith("第二段开头")
    assert VisualService._anchor_line(markdown.splitlines(), placement) == 5
    assert VisualService._anchor_line(markdown.splitlines(), {**placement, "anchorExcerpt": "已不存在的段落"}) is None


def test_auto_count_uses_blueprint_utf16_length():
    from app.services.visual_service import auto_image_count
    assert auto_image_count("😀" * 451) == 2
