import { useEffect, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { localMediaSource } from "../../api/publicWorkspace";

/**
 * Web 版 MarkdownPreview（蓝本 MarkdownPreview 的等价实现，团队自有）：
 * marked + DOMPurify 消毒 + mermaid 动态渲染（securityLevel: strict）。
 * 图片只允许 http(s)/data 与站内 /api/media 相对路径。
 */

const SANITIZE_CONFIG = {
  ADD_ATTR: ["target"],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 素材库引用解析：蓝本 mediaReferences 的 Web 版。
 * 正文只存紧凑的 asset://id，渲染时再映射到站内原始内容接口，
 * 保证素材可复用、可替换且文章正文不携带图片数据。 */
export function resolveAssetReferences(markdown: string): string {
  return markdown.replace(
    /\]\(asset:\/\/([A-Za-z0-9][A-Za-z0-9:_-]{0,255})\)/g,
    (_match, assetId: string) =>
      `](${localMediaSource(assetId) || withMediaAccessToken(`/api/media/${encodeURIComponent(assetId)}/raw`)})`,
  );
}

/** 站内素材图附带当前登录 token：
 * <img> 无法携带 Authorization 头；Cookie 缺失（旧登录态/跨端口）时兜底。 */
export function withMediaAccessToken(src: string): string {
  if (!src.startsWith("/api/media/")) return src;
  try {
    const url = new URL(src, window.location.origin);
    if (url.searchParams.has("access_token")) return src;
  } catch {
    return src;
  }
  const token = window.localStorage.getItem("opw_access_token");
  if (!token) return src;
  return `${src}${src.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
}
export function renderMarkdownHtml(markdown: string): string {
  const raw = marked.parse(resolveAssetReferences(markdown), { async: false }) as string;
  return DOMPurify.sanitize(raw, SANITIZE_CONFIG);
}

/** 按顶层块渲染并标注源 Markdown 行号（data-md-line / data-md-end）。
 * 行号基于 resolveAssetReferences 之后的文本计算；替换不引入换行，行号与原文一致。
 * 预览拖放（配图移动 / 素材插入）依赖这些标注把落点映射回源行。 */
export function renderMarkdownBlockHtml(markdown: string): string {
  const resolved = resolveAssetReferences(markdown);
  const tokens = marked.lexer(resolved);
  const parts: string[] = [];
  let nextLine = 1;
  for (const token of tokens) {
    const startLine = nextLine;
    const newlines = token.raw.split("\n").length - 1;
    nextLine += newlines;
    if (token.type === "space") continue;
    const endLine = startLine + newlines;
    const tokenHtml = DOMPurify.sanitize(marked.parse(token.raw, { async: false }) as string, SANITIZE_CONFIG);
    parts.push(`<div class="markdown-preview__block" data-md-line="${startLine}" data-md-end="${endLine}">${tokenHtml}</div>`);
  }
  return parts.join("");
}

let mermaidQueue: Promise<void> = Promise.resolve();

export async function renderMermaidSvg(id: string, source: string): Promise<string> {
  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: document.documentElement.dataset.theme === "dark" ? "dark" : "neutral",
    flowchart: { htmlLabels: false },
  });
  const { svg } = await mermaid.render(id, source);
  return svg;
}

function isSafeImageSrc(src: string): boolean {
  if (src.startsWith("/")) return true; // 站内相对路径（/api/media/...）
  if (src.startsWith("data:image/")) return true;
  try {
    const url = new URL(src);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function MarkdownPreview({ markdown, maxHeight }: { markdown: string; maxHeight?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = renderMarkdownBlockHtml(markdown);

    // 拦截不安全的图片地址（DOMPurify 已过滤协议，这里再兜底一次）
    container.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") ?? "";
      if (!isSafeImageSrc(src)) {
        img.remove();
        return;
      }
      const tokened = withMediaAccessToken(src);
      if (tokened !== src) {
        img.setAttribute("src", tokened);
      }
      img.loading = "lazy";
      // 加载失败（如历史生成图的临时链接过期）时展示占位，而不是裂图图标。
      img.addEventListener("error", () => {
        const placeholder = document.createElement("div");
        placeholder.className = "markdown-image-broken";
        placeholder.textContent = `图片加载失败：${img.getAttribute("alt") || "未命名配图"}（可在配图中心重新生成）`;
        img.replaceWith(placeholder);
      }, { once: true });
    });

    // 外链新窗口打开
    container.querySelectorAll("a[href^=\"http\"]").forEach((a) => {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noreferrer");
    });

    // mermaid 渲染：把 language-mermaid 代码块替换为 SVG
    const blocks = Array.from(
      container.querySelectorAll("pre > code.language-mermaid"),
    );
    blocks.forEach((code, index) => {
      const source = code.textContent ?? "";
      const pre = code.parentElement;
      if (!pre || !source.trim()) return;
      const holder = document.createElement("div");
      holder.className = "markdown-mermaid";
      holder.setAttribute("role", "img");
      holder.setAttribute("aria-label", "文章图表");
      holder.textContent = "正在绘制图表……";
      pre.replaceWith(holder);

      mermaidQueue = mermaidQueue.then(
        () => {
          if (!holder.isConnected) return;
          return renderMermaidSvg(`opw-mermaid-${Date.now()}-${index}`, source)
            .then((svg) => {
              if (!holder.isConnected) return;
              holder.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
            })
            .catch(() => {
              holder.className = "markdown-mermaid markdown-mermaid--error";
              holder.innerHTML =
                `<strong>图表无法渲染</strong>` +
                `<details><summary>查看 Mermaid 源码</summary><pre><code>${escapeHtml(source)}</code></pre></details>`;
            });
        },
        () => undefined,
      );
    });
  }, [markdown]);

  return (
    <article
      aria-label="Markdown 预览"
      className="markdown-preview"
      dangerouslySetInnerHTML={{ __html: "" }}
      ref={containerRef}
      style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}
    />
  );
}
