"""One bounded model request for the public audit article; no credentials logged."""
import json
from pathlib import Path

from app.agents.llm_client import LLMClient
from app.services.model_profile_service import resolve_llm_config


def main():
    config = resolve_llm_config()
    if not config["api_key"]:
        print("No configured model; no request made")
        return
    config["capabilities"] = {**config.get("capabilities", {}), "maxTokens": 3000, "thinkingLevel": "low"}
    client = LLMClient(config=config)
    client._client = client._client.with_options(max_retries=0, timeout=90)
    try:
        result = client._client.chat.completions.create(
            model=client.model,
            messages=[
                {"role": "system", "content": "你是中文编辑。直接输出 Markdown 成品，不要解释，不要调用工具。"},
                {"role": "user", "content": "写一篇400至600字的示例文章，标题为《把零散想法变成一篇清晰的文章》，使用二级标题、一个三步列表，提供具体写作建议。不涉及新闻、统计数据或未经核实的事实。不引用图片，不含HTML。"},
            ],
            **client._options(0.5),
        )
        markdown = (result.choices[0].message.content or "").strip()
        usage = result.usage
        print(json.dumps({"requests": 1, "model": client.model, "finishReason": result.choices[0].finish_reason,
                          "inputTokens": usage.prompt_tokens if usage else None,
                          "outputTokens": usage.completion_tokens if usage else None,
                          "articleChars": len(markdown)}, ensure_ascii=False))
        if markdown and result.choices[0].finish_reason == "stop":
            Path("/tmp/opw-audit-article.md").write_text(markdown, encoding="utf-8")
    except Exception as exc:
        # Exception bodies can contain provider details. Only report the class.
        print(json.dumps({"requests": 1, "errorType": type(exc).__name__}))


if __name__ == "__main__":
    main()
