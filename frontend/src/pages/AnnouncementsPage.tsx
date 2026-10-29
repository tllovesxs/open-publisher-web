import {
  BookOpenText,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  Megaphone,
  Pin,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ANNOUNCEMENT_REPOSITORY_URL,
  githubRepositoryMarkdownUrl,
  isRepositoryMarkdownPath,
  rawRepositoryMarkdownUrl,
} from "../lib/announcementPaths";
import { MarkdownPreview } from "../components/article/MarkdownPreview";

// 蓝本 AnnouncementsPage 的 Web 迁移（团队自有代码）：
// 远程 GitHub 公告索引 + 内置教程兜底；相对图片链接改写为 raw 地址。

type NoticeKind = "announcement" | "tutorial";
type SourceState = "embedded" | "loading" | "remote" | "fallback";
type BodyState = "idle" | "loading" | "ready" | "error";

interface NoticeItem {
  id: string;
  type: NoticeKind;
  pinned: boolean;
  title: string;
  summary: string;
  date: string;
  badge: string;
  tags: string[];
  path: string;
  body?: string;
}

interface NoticeManifest {
  version: number;
  updatedAt: string;
  repository: string;
  items: NoticeItem[];
}

const RAW_BASE_URL = rawRepositoryMarkdownUrl("docs/integrations/wechatsync-publishing-guide.md")!.replace(
  "docs/integrations/wechatsync-publishing-guide.md",
  "",
);
const MANIFEST_URL = `${RAW_BASE_URL}docs/announcements.json`;

const embeddedManifest: NoticeManifest = {
  version: 1,
  updatedAt: "2026-08-07",
  repository: ANNOUNCEMENT_REPOSITORY_URL,
  items: [
    {
      id: "wechatsync-publishing-guide",
      type: "tutorial",
      pinned: false,
      title: "如何添加文章同步发布功能",
      summary: "安装文章同步助手，允许网站访问并同步到已登录平台的草稿箱。",
      date: "2026-08-07",
      badge: "发布教程",
      tags: ["发布", "WechatSync", "草稿"],
      path: "docs/integrations/wechatsync-publishing-guide.md",
      body: `# Web 版文章同步发布教程

## 1. 安装并启用插件

打开[文章同步助手官网](https://www.wechatsync.com/)，在当前 Chrome / Edge 浏览器安装「文章同步助手」。在浏览器扩展管理中允许插件访问稿流网站，安装或调整权限后刷新稿流页面。

## 2. 登录目标平台

在同一个浏览器中登录微信公众号、知乎、CSDN 等需要同步的平台。平台支持范围与登录状态以插件读取的结果为准。

## 3. 在文章页同步

1. 打开文章，检查标题、正文和图片，点击「同步发布」。
2. 点击「继续发布」，进入文章纯净预览。
3. 点击「刷新平台」，勾选目标平台后点击「同步到草稿」。
4. 查看各平台同步进度，完成后点击「查看草稿」检查内容并在平台内正式发布。

Web 版通过插件注入的网页接口直接同步，无需填写 Token 或开启 CLI / MCP 连接。桌面蓝本的本地桥配置不适用于此网页入口。

## 4. 插件独立操作

也可以在「纯净预览」中右键，选择「同步助手 - 提取并编辑文章」，通过插件自己的编辑和同步窗口操作。插件负责平台账号和同步记录。

## 常见问题

- 未检测到插件：检查是否安装在当前浏览器、是否已启用、是否允许访问当前网站，再刷新页面。
- 插件已连接但没有平台：先在该浏览器登录目标平台，再点击「刷新平台」。
- 图片准备失败：检查素材权限及图片大小，修复后重试。
- 同步失败：按界面提示检查对应平台登录和草稿箱；结果尚未确认时先核验插件记录，避免重复提交。

独立模拟发布队列已移除，文章页是同步入口。
`,
    },
  ],
};

function safeText(value: unknown, limit: number, fallback = ""): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim().slice(0, limit) || fallback
    : fallback;
}

function normalizeManifest(value: unknown): NoticeManifest | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<NoticeManifest>;
  if (!Array.isArray(candidate.items)) return null;
  const items = candidate.items
    .map((raw, index): NoticeItem | null => {
      if (!raw || typeof raw !== "object") return null;
      const item = raw as Partial<NoticeItem>;
      const path = typeof item.path === "string" && isRepositoryMarkdownPath(item.path) ? item.path : "";
      if (!path) return null;
      return {
        id: safeText(item.id, 80, `notice-${index + 1}`),
        type: item.type === "tutorial" ? "tutorial" : "announcement",
        pinned: item.pinned === true,
        title: safeText(item.title, 180, "未命名公告"),
        summary: safeText(item.summary, 500),
        date: safeText(item.date, 32, safeText(candidate.updatedAt, 32)),
        badge: safeText(item.badge, 48),
        tags: Array.isArray(item.tags)
          ? item.tags.map((tag) => safeText(tag, 48)).filter(Boolean).slice(0, 8)
          : [],
        path,
      };
    })
    .filter((item): item is NoticeItem => Boolean(item))
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
    .sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return right.date.localeCompare(left.date) || left.title.localeCompare(right.title, "zh-Hans-CN");
    });
  if (items.length === 0) return null;
  return {
    version: typeof candidate.version === "number" ? candidate.version : 1,
    updatedAt: safeText(candidate.updatedAt, 32, embeddedManifest.updatedAt),
    repository: safeText(candidate.repository, 320, ANNOUNCEMENT_REPOSITORY_URL),
    items,
  };
}

function cacheEmbeddedBodies() {
  return Object.fromEntries(
    embeddedManifest.items
      .filter((item) => item.body)
      .map((item) => [item.id, item.body as string]),
  );
}

function kindLabel(item: NoticeItem) {
  if (item.pinned) return "置顶公告";
  return item.type === "tutorial" ? "教程" : item.badge || "公告";
}

function sourceLabel(source: SourceState) {
  if (source === "loading") return "正在同步教程";
  if (source === "remote") return "已从 GitHub 同步";
  if (source === "fallback") return "使用内置教程";
  return "内置教程";
}

/** 蓝本 MarkdownPreview 的 imageBaseUrl 语义：把相对图片链接改写为 raw 仓库地址。 */
function resolveBodyImages(body: string, path: string): string {
  const base = rawRepositoryMarkdownUrl(path);
  if (!base) return body;
  const dir = base.replace(/[^/]*$/, "");
  return body.replace(/(\]\()(\.\/)([^)\s]+)/g, (_match, lead: string, _dot: string, rest: string) => `${lead}${dir}${rest}`);
}

export default function AnnouncementsPage() {
  const [manifest, setManifest] = useState<NoticeManifest>(embeddedManifest);
  const [sourceState, setSourceState] = useState<SourceState>("embedded");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(embeddedManifest.items[0]!.id);
  const [body, setBody] = useState(embeddedManifest.items[0]!.body ?? "");
  const [bodyState, setBodyState] = useState<BodyState>("ready");
  const [bodyError, setBodyError] = useState<string | null>(null);
  const manifestRequestId = useRef(0);
  const bodyRequestId = useRef(0);
  const bodyCache = useRef<Record<string, string>>(cacheEmbeddedBodies());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const items = manifest.items;
  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? items[0] ?? null,
    [items, selectedId],
  );

  const refreshManifest = useCallback(async () => {
    const requestId = ++manifestRequestId.current;
    setSourceState("loading");
    setSourceError(null);
    try {
      const response = await fetch(MANIFEST_URL, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`仓库返回 HTTP ${response.status}`);
      const normalized = normalizeManifest(await response.json());
      if (!mounted.current || manifestRequestId.current !== requestId) return;
      if (!normalized) {
        bodyCache.current = cacheEmbeddedBodies();
        setManifest(embeddedManifest);
        setSourceState("embedded");
        setSelectedId(embeddedManifest.items[0]!.id);
        return;
      }
      bodyCache.current = cacheEmbeddedBodies();
      setManifest(normalized);
      setSourceState("remote");
      setSelectedId((current) =>
        normalized.items.some((item) => item.id === current) ? current : normalized.items[0]!.id,
      );
    } catch (error) {
      if (!mounted.current || manifestRequestId.current !== requestId) return;
      bodyCache.current = cacheEmbeddedBodies();
      setManifest(embeddedManifest);
      setSourceState("fallback");
      setSourceError(error instanceof Error ? error.message.slice(0, 160) : "无法连接到公告仓库");
      setSelectedId((current) =>
        embeddedManifest.items.some((item) => item.id === current) ? current : embeddedManifest.items[0]!.id,
      );
    }
  }, []);

  useEffect(() => {
    void refreshManifest();
  }, [refreshManifest]);

  useEffect(() => {
    if (!selected) return;
    const embedded = selected.body ?? bodyCache.current[selected.id];
    if (embedded) {
      setBody(embedded);
      setBodyState("ready");
      setBodyError(null);
      return;
    }
    const url = rawRepositoryMarkdownUrl(selected.path);
    if (!url) {
      setBody("");
      setBodyState("error");
      setBodyError("公告路径不受支持。");
      return;
    }
    const requestId = ++bodyRequestId.current;
    setBodyState("loading");
    setBodyError(null);
    fetch(url, { headers: { Accept: "text/plain" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`仓库返回 HTTP ${response.status}`);
        return response.text();
      })
      .then((text) => {
        if (!mounted.current || bodyRequestId.current !== requestId) return;
        bodyCache.current[selected.id] = text;
        setBody(text);
        setBodyState("ready");
      })
      .catch((error: unknown) => {
        if (!mounted.current || bodyRequestId.current !== requestId) return;
        setBody("");
        setBodyState("error");
        setBodyError(error instanceof Error ? error.message.slice(0, 160) : "无法读取公告正文");
      });
  }, [selected]);

  return (
    <section className="page page--announcements">
      <header className="page-heading page-heading--announcements">
        <div>
          <span className="page-kicker">发布连接</span>
          <h1>发布教程</h1>
          <p>按照教程连接浏览器中的文章同步助手，读取已登录的发布平台。</p>
        </div>
        <div className="announcement-page-actions">
          <span aria-live="polite" className={`announcement-source is-${sourceState}`}>
            {sourceState === "loading"
              ? <LoaderCircle aria-hidden="true" className="spin" size={14} />
              : <Megaphone aria-hidden="true" size={14} />}
            {sourceLabel(sourceState)}
          </span>
          <button
            className="button button--quiet"
            disabled={sourceState === "loading"}
            onClick={() => void refreshManifest()}
            type="button"
          >
            <RefreshCw aria-hidden="true" className={sourceState === "loading" ? "spin" : undefined} size={16} />
            刷新教程
          </button>
        </div>
      </header>

      <div className="announcement-layout">
        <aside aria-label="公告列表" className="announcement-list">
          <NoticeSection items={items} label="教程" onSelect={setSelectedId} selectedId={selected?.id ?? ""} />
        </aside>

        <article aria-busy={bodyState === "loading"} className="announcement-document">
          {selected ? (
            <>
              <header className="announcement-document__header">
                <div>
                  <span className={`announcement-badge${selected.pinned ? " is-pinned" : ""}`}>
                    {selected.pinned && <Pin aria-hidden="true" size={12} />}
                    {kindLabel(selected)}
                  </span>
                  <h2>{selected.title}</h2>
                  <p>{selected.date}{selected.summary ? ` · ${selected.summary}` : ""}</p>
                  {selected.tags.length > 0 && (
                    <div aria-label="公告标签" className="announcement-tags">
                      {selected.tags.map((tag) => <span key={tag}>{tag}</span>)}
                    </div>
                  )}
                </div>
                <a
                  className="text-button"
                  href={githubRepositoryMarkdownUrl(selected.path)}
                  rel="noreferrer"
                  target="_blank"
                >
                  在 GitHub 查看 <ExternalLink aria-hidden="true" size={14} />
                </a>
              </header>

              <div className="announcement-document__body">
                {bodyState === "loading" && (
                  <div className="announcement-document__loading" role="status">
                    <LoaderCircle aria-hidden="true" className="spin" size={20} />
                    正在读取公告正文
                  </div>
                )}
                {bodyState === "ready" && (
                  <MarkdownPreview markdown={resolveBodyImages(body, selected.path)} />
                )}
                {bodyState === "error" && (
                  <div className="announcement-document__error" role="alert">
                    <CircleAlert aria-hidden="true" size={20} />
                    <div><strong>公告正文暂时无法读取</strong><span>{bodyError ?? "请稍后刷新，或在 GitHub 查看原文。"}</span></div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="announcement-document__empty">
              <BookOpenText aria-hidden="true" size={24} />
              <strong>暂无公告</strong>
              <span>刷新后会从项目仓库重新读取公告索引。</span>
            </div>
          )}
        </article>
      </div>
      {sourceError && <p className="announcement-sync-note" role="status">本次同步未完成：{sourceError}</p>}
    </section>
  );
}

function NoticeSection({
  items,
  label,
  selectedId,
  onSelect,
}: {
  items: NoticeItem[];
  label: string;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="announcement-list__section">
      <h2>{label}</h2>
      {items.length === 0 ? <p className="announcement-list__empty">暂无{label}</p> : items.map((item) => {
        const active = item.id === selectedId;
        return (
          <button
            aria-pressed={active}
            className={`announcement-list__item${active ? " is-active" : ""}${item.pinned ? " is-pinned" : ""}`}
            key={item.id}
            onClick={() => onSelect(item.id)}
            type="button"
          >
            <span className="announcement-list__meta"><strong>{kindLabel(item)}</strong><time>{item.date}</time></span>
            <span className="announcement-list__title">{item.title}</span>
            {item.summary && <span className="announcement-list__summary">{item.summary}</span>}
          </button>
        );
      })}
    </section>
  );
}
