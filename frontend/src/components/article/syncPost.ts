import { marked } from "marked";
import DOMPurify from "dompurify";
import { api } from "../../api/client";

/** Transfer private images as bytes, never as a URL containing our login token. */
export async function prepareSyncPost(title: string, markdown: string, signal: AbortSignal) {
  const resolved = markdown.replace(/\]\(asset:\/\/([A-Za-z0-9][A-Za-z0-9:_-]{0,255})\)/g,
    (_, id: string) => `](/api/media/${encodeURIComponent(id)}/raw)`);
  const box = document.createElement("div");
  box.innerHTML = DOMPurify.sanitize(marked.parse(resolved, { async: false }) as string);
  const replacements = new Map<string, string>();
  let totalBytes = 0;
  for (const image of box.querySelectorAll("img")) {
    const src = image.getAttribute("src");
    if (!src) continue;
    if (replacements.has(src)) { image.src = replacements.get(src)!; continue; }
    const url = new URL(src, location.origin);
    url.searchParams.delete("access_token");
    let output = url.href;
    if (url.origin === location.origin && url.pathname.startsWith("/api/media/")) {
      const response = await api.get<Blob>(url.pathname.slice(4) + url.search, { responseType: "blob", signal, timeout: 30000 })
        .catch(() => { throw new Error("无法读取正文图片，请检查素材权限与网络后重试。"); });
      const blob = response.data;
      if (!/^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(blob.type)) throw new Error("正文素材不是可同步的图片，请检查后重试。");
      totalBytes += blob.size;
      if (blob.size > 10 * 1024 * 1024 || totalBytes > 40 * 1024 * 1024) throw new Error("正文图片过大，请压缩图片后再同步。");
      output = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("读取正文图片失败，请重试。"));
        reader.readAsDataURL(blob);
      });
    } else if (!/^(https?:|data:image\/)/i.test(output)) {
      throw new Error("正文图片地址无法同步，请使用素材库或网络图片。");
    }
    replacements.set(src, output);
    image.src = output;
  }
  box.querySelectorAll("a[href]").forEach(link => {
    const url = new URL(link.getAttribute("href")!, location.origin);
    url.searchParams.delete("access_token");
    link.setAttribute("href", url.href);
  });
  let safeMarkdown = resolved;
  for (const [src, output] of replacements) safeMarkdown = safeMarkdown.split(src).join(output);
  safeMarkdown = safeMarkdown.replace(/([?&])access_token=[^\s)&#]+&?/g, (_match, prefix: string) => prefix === "?" ? "?" : "");
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return { title, content: box.innerHTML, markdown: safeMarkdown, thumb: box.querySelector("img")?.src ?? null };
}
