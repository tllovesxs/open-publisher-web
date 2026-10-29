"""OpenAI 兼容聊天客户端封装。

所有节点只依赖 complete_json 接口，方便测试时用 FakeLLM 替换。
API Key 只来自后端数据库 app_secrets 解密结果，不落仓库。
"""

import json
import re
from collections.abc import Iterator

from openai import OpenAI

from app.core.config import get_settings
from app.services.model_profile_service import resolve_llm_config


class LLMError(Exception):
    """LLM 调用或 JSON 解析失败。"""


def parse_json_dict(text: str) -> dict:
    """尽力把模型输出解析为 dict；容忍 markdown 代码块包裹。"""
    cleaned = text.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", cleaned, re.DOTALL)
    if fence:
        cleaned = fence.group(1).strip()
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise LLMError(f"LLM 输出不是合法 JSON：{cleaned[:200]}") from exc
    if not isinstance(data, dict):
        raise LLMError(f"LLM 输出应为 JSON 对象，实际为 {type(data).__name__}")
    return data


class LLMClient:
    """OpenAI 兼容 chat completions 客户端。"""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        timeout_seconds: int | None = None,
        config: dict | None = None,
    ) -> None:
        settings = get_settings()
        resolved = config or resolve_llm_config()
        self.capabilities = resolved.get("capabilities") or {}
        self.profile_id = resolved.get("profileId")
        self.profile_name = resolved.get("profileName")
        self._api_key = api_key if api_key is not None else resolved["api_key"]
        self._base_url = base_url if base_url is not None else resolved["base_url"]
        self.model = model if model is not None else resolved["model"]
        self.timeout_seconds = (
            timeout_seconds if timeout_seconds is not None else resolved["timeout_seconds"]
        )
        self.call_count = 0
        self._client = OpenAI(
            api_key=self._api_key or "sk-not-configured",
            base_url=self._base_url,
            timeout=self.timeout_seconds,
        )

    def _options(self, temperature):
        if self.capabilities.get("reasoning"):
            return {"max_completion_tokens": self.capabilities.get("maxTokens", 8192), "reasoning_effort":"medium"}
        return {"temperature":temperature, "max_tokens": self.capabilities.get("maxTokens", 8192)}

    @property
    def api_key_configured(self) -> bool:
        """激活档案或全局数据库密钥是否提供了 API Key。"""
        return bool(self._api_key)

    def complete(
        self,
        system: str,
        user: str,
        *,
        json_mode: bool = False,
        temperature: float = 0.7,
    ) -> str:
        """返回完整文本；正文场景内部使用流式，JSON 场景保持非流式。"""
        return "".join(self.stream_complete(
            system, user, json_mode=json_mode, temperature=temperature,
        ))

    def stream_complete(
        self,
        system: str,
        user: str,
        *,
        json_mode: bool = False,
        temperature: float = 0.7,
    ) -> Iterator[str]:
        """逐段返回模型输出；JSON 输出仍一次性返回，便于统一解析。"""
        try:
            if json_mode:
                response = self._client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    **self._options(temperature),
                    response_format={"type": "json_object"},
                )
                self.call_count += 1
                content = response.choices[0].message.content or ""
                if content:
                    yield content
                return

            # 只要服务端持续返回增量，长文生成就不会触发单次 HTTP 读超时。
            stream = self._client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                **self._options(temperature),
                stream=True,
            )
            for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                content = getattr(delta, "content", None)
                if content:
                    yield content
            self.call_count += 1
        except Exception as exc:  # noqa: BLE001 - 统一转为 LLMError
            raise LLMError(f"LLM 调用失败：{exc}") from exc

    def stream_chat(
        self,
        system: str,
        messages: list[dict],
        *,
        tools: list[dict] | None = None,
        temperature: float = 0.7,
        tool_choice: dict | str | None = None,
    ) -> Iterator[dict]:
        """Agent 工具循环专用：流式对话，支持 function calling。

        逐段产出：
        - {"type": "text", "delta": str}   内容增量（实时转发给事件流）
        - {"type": "message", "content": str, "toolCalls": [...]}  最终消息

        toolCalls 元素：{"id", "name", "arguments"}（arguments 为原始 JSON 字符串）。
        """
        request_messages = [{"role": "system", "content": system}, *messages]
        kwargs: dict = {
            "model": self.model,
            "messages": request_messages,
            **self._options(temperature),
            "stream": True,
        }
        if tools:
            kwargs["tools"] = tools
            if tool_choice is not None:
                kwargs["tool_choice"] = tool_choice
        try:
            stream = self._client.chat.completions.create(**kwargs)
            content_parts: list[str] = []
            tool_calls: dict[int, dict] = {}
            finish_reason = None
            for chunk in stream:
                if not chunk.choices:
                    continue
                finish_reason = chunk.choices[0].finish_reason or finish_reason
                delta = chunk.choices[0].delta
                content = getattr(delta, "content", None)
                if content:
                    content_parts.append(content)
                    yield {"type": "text", "delta": content}
                for fragment in getattr(delta, "tool_calls", None) or []:
                    slot = tool_calls.setdefault(
                        fragment.index,
                        {"id": "", "name": "", "arguments": ""},
                    )
                    if fragment.id:
                        slot["id"] = fragment.id
                    if fragment.function and fragment.function.name:
                        slot["name"] = fragment.function.name
                    if fragment.function and fragment.function.arguments:
                        slot["arguments"] += fragment.function.arguments
                    yield {"type": "tool_delta", "index": fragment.index, **slot}
            self.call_count += 1
            ordered = [tool_calls[i] for i in sorted(tool_calls)]
            yield {
                "type": "message",
                "content": "".join(content_parts),
                "toolCalls": ordered,
                "finishReason": finish_reason,
            }
        except Exception as exc:  # noqa: BLE001 - 统一转为 LLMError
            raise LLMError(f"LLM 调用失败：{exc}") from exc

    def complete_json(
        self, system: str, user: str, *, temperature: float = 0.7,
        images: list[str] | None = None,
    ) -> dict:
        """JSON 模式；支持 data URL 图片输入（需模型档案开启 vision）。"""
        if images:
            if not self.capabilities.get("vision"):
                raise LLMError("当前模型档案未开启图片理解能力。")
            content: str | list[dict] = [
                {"type": "text", "text": user},
                *[{"type": "image_url", "image_url": {"url": image}} for image in images],
            ]
            try:
                response = self._client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": content},
                    ],
                    **self._options(temperature),
                    response_format={"type": "json_object"},
                )
                self.call_count += 1
                return parse_json_dict(response.choices[0].message.content or "")
            except LLMError:
                raise
            except Exception as exc:
                raise LLMError(f"LLM 调用失败：{exc}") from exc
        text = self.complete(system, user, json_mode=True, temperature=temperature)
        return parse_json_dict(text)
