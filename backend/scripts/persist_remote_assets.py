"""一次性修复：把仍存远程临时 URL 的生成图落成 data URL。

用法：
    python scripts/persist_remote_assets.py            # 干跑，只报告
    python scripts/persist_remote_assets.py --execute  # 实际下载并写库

背景：早期版本生成图只保存了模型网关的临时签名 URL，过期后 /raw 404、
正文图片裂图。生成路径现在会立即落库，此脚本兜底修复存量数据。
"""
from __future__ import annotations

import argparse
import base64
import sys

import httpx
from app.db.session import SessionLocal
from app.models.media import MediaAsset

MAX_BYTES = 20 * 1024 * 1024


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true", help="实际写入；缺省只干跑")
    args = parser.parse_args()

    db = SessionLocal()
    rows = (
        db.query(MediaAsset)
        .filter(MediaAsset.origin == "generated")
        .filter(MediaAsset.source.like("http%"))
        .all()
    )
    if not rows:
        print("没有需要修复的远程素材。")
        return 0

    failures = 0
    with httpx.Client(follow_redirects=True, timeout=30) as client:
        for row in rows:
            label = f"{row.id} ({row.name[:40]})"
            try:
                response = client.get(row.source)
                response.raise_for_status()
                content_type = response.headers.get("content-type", row.mime).split(";", 1)[0].strip()
                if not content_type.startswith("image/") or not response.content or len(response.content) > MAX_BYTES:
                    raise ValueError(f"invalid image payload ({len(response.content)} bytes, {content_type})")
                data_url = f"data:{content_type};base64," + base64.b64encode(response.content).decode("ascii")
                if args.execute:
                    row.source = data_url
                    row.mime = content_type
                    db.commit()
                    print(f"[fixed] {label}")
                else:
                    print(f"[dry-run 可修复] {label}")
            except Exception as exc:  # noqa: BLE001 - 上游链接可能已过期，无法挽救
                failures += 1
                print(f"[失败] {label}: {exc}", file=sys.stderr)
    db.close()
    if failures:
        print(f"{failures} 个素材的远端链接已失效，图片本体无法取回，需要在配图中心重新生成。")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
