"""Validate the text-to-image contract before sending a provider request."""
from urllib.parse import urlsplit

from fastapi import HTTPException


def validate_image_generation_config(base_url: str, model: str) -> None:
    url = urlsplit(base_url)
    if url.hostname in {"cloud.siliconflow.cn", "cloud.siliconflow.com"}:
        raise HTTPException(status_code=400, detail="生图服务地址填写的是硅基流动控制台，请改为 API 地址 https://api.siliconflow.cn/v1（国际站为 https://api.siliconflow.com/v1）")
    if url.hostname in {"api.siliconflow.cn", "api.siliconflow.com"} and url.path.rstrip("/") != "/v1":
        raise HTTPException(status_code=400, detail="硅基流动服务地址应以 /v1 结尾，不要填写控制台或完整的 images/generations 路径")
    if model.lower().split("/")[-1].startswith("qwen-image-edit"):
        raise HTTPException(status_code=400, detail="当前模型是图片编辑模型，需要原图；文章配图仅支持文生图，请改用服务商支持的生成模型，例如 Qwen/Qwen-Image")
