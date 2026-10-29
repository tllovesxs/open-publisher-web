import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, LoaderCircle, Monitor, Send, XCircle } from "lucide-react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { resolveAssetReferences } from "./MarkdownPreview";

interface SyncAccount {
  type: string;
  title: string;
  displayName?: string;
  icon?: string;
  avatar?: string;
  uid?: string;
  home?: string;
  supportTypes?: string[];
}

interface SyncTaskStatus {
  type: string;
  status: string;
  msg?: string;
  error?: string;
  editResp?: { draftLink?: string | null } | null;
}

declare global {
  interface Window {
    $syncer?: {
      getAccounts: (cb: (accounts: SyncAccount[]) => void) => void;
      addTask: (
        task: {
          post: { title: string; content: string; markdown: string; thumb?: string | null };
          accounts: SyncAccount[];
        },
        onStatus: (task: SyncTaskStatus) => void,
        cb?: (result?: unknown) => void,
      ) => void;
    };
  }
}

interface SyncPublishDialogProps {
  title: string;
  markdown: string;
  onClose: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  uploading: "同步中",
  done: "已完成",
  failed: "失败",
};

/** 文章同步助手发布通道（依赖 wechatsync-2.0.9 浏览器扩展）：
 * 1. 全屏纯净文章视图：页面只渲染标题与正文，扩展抓取/截图不会带出工作台 UI；
 * 2. 通过扩展注入的 window.$syncer 读取已登录平台并提交草稿同步任务（只存草稿，不代发布）。 */
export function SyncPublishDialog({ title, markdown, onClose }: SyncPublishDialogProps) {
  const [extStatus, setExtStatus] = useState<"checking" | "missing" | "ready">("checking");
  const [accounts, setAccounts] = useState<SyncAccount[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [tasks, setTasks] = useState<Record<string, SyncTaskStatus>>({});
  const [syncing, setSyncing] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const shellRef = useRef<HTMLDivElement>(null);

  // 纯净正文：先解析 asset:// 素材引用（与编辑器预览同链路），再净化 HTML，并把站内相对图片地址补全成绝对地址
  const articleHtml = useMemo(() => {
    const html = DOMPurify.sanitize(marked.parse(resolveAssetReferences(markdown), { async: false }) as string);
    const box = document.createElement("div");
    box.innerHTML = html;
    box.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src");
      if (src && src.startsWith("/")) img.setAttribute("src", new URL(src, window.location.origin).href);
    });
    return box.innerHTML;
  }, [markdown]);

  const thumb = useMemo(() => {
    const box = document.createElement("div");
    box.innerHTML = articleHtml;
    return box.querySelector("img")?.getAttribute("src") ?? null;
  }, [articleHtml]);

  // 进入全屏：文章独占屏幕，浏览器 UI 也退出视野
  useEffect(() => {
    document.documentElement.requestFullscreen?.().catch(() => undefined);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChromeVisible(true);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => undefined);
    };
  }, []);

  // 检测扩展注入的 $syncer 桥（wechatsync 在 document_start 注入所有 http/https 页面）
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (typeof window.$syncer?.getAccounts !== "function") {
        setExtStatus("missing");
        return;
      }
      window.$syncer.getAccounts((list) => {
        const ready = (list ?? []).filter((item) => item && item.type);
        setAccounts(ready);
        setSelected(ready.map((item) => item.type));
        setExtStatus(ready.length ? "ready" : "missing");
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, []);

  const startSync = () => {
    const bridge = window.$syncer;
    if (!bridge || syncing) return;
    const picked = accounts.filter((item) => selected.includes(item.type));
    if (!picked.length) return;
    setSyncing(true);
    setTasks(Object.fromEntries(picked.map((item) => [item.type, { type: item.type, status: "uploading" }])));
    bridge.addTask(
      { post: { title, content: articleHtml, markdown, thumb }, accounts: picked },
      (task) => {
        if (!task?.type) return;
        setTasks((current) => ({ ...current, [task.type]: { ...current[task.type], ...task } }));
      },
    );
  };

  const toggleAccount = (type: string) => {
    setSelected((current) =>
      current.includes(type) ? current.filter((item) => item !== type) : [...current, type],
    );
  };

  return (
    <div
      className="sync-publish"
      style={{ background: "var(--surface, #fff)", inset: 0, overflowY: "auto", position: "fixed", zIndex: 1300 }}
    >
      <article
        id="sync-article"
        ref={shellRef}
        style={{
          boxSizing: "content-box",
          color: "var(--ink, #222)",
          fontFamily: "-apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif",
          lineHeight: 1.9,
          margin: "0 auto",
          maxWidth: 760,
          padding: chromeVisible ? "96px 28px 80px" : "48px 28px 80px",
          transition: "padding 200ms ease",
        }}
      >
        <h1 style={{ fontSize: 28, lineHeight: 1.4, marginBottom: 20 }}>{title}</h1>
        <div className="markdown-preview" dangerouslySetInnerHTML={{ __html: articleHtml }} />
      </article>

      {chromeVisible && (
        <header
          style={{
            alignItems: "center",
            background: "var(--surface, #fff)",
            borderBottom: "1px solid var(--border, #e5e5e5)",
            boxShadow: "0 2px 12px rgba(0,0,0,.06)",
            boxSizing: "border-box",
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            inset: "0 0 auto 0",
            padding: "10px 16px",
            position: "fixed",
            zIndex: 2,
          }}
        >
          <strong style={{ fontSize: 13 }}>
            <Monitor size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
            同步助手 · 全屏纯净稿
          </strong>

          {extStatus === "checking" && (
            <small style={{ alignItems: "center", color: "var(--muted, #999)", display: "flex", gap: 6 }}>
              <LoaderCircle className="spin" size={13} /> 检测文章同步助手扩展…
            </small>
          )}

          {extStatus === "missing" && (
            <small style={{ color: "var(--warning, #b45309)", maxWidth: 460 }}>
              未检测到扩展或未登录平台账号。请在当前浏览器安装并启用「文章同步助手」扩展，登录目标平台后刷新本页。
            </small>
          )}

          {extStatus === "ready" && (
            <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 6 }}>
              {accounts.map((account) => {
                const active = selected.includes(account.type);
                const task = tasks[account.type];
                return (
                  <button
                    aria-pressed={active}
                    key={account.type}
                    onClick={() => toggleAccount(account.type)}
                    style={{
                      alignItems: "center",
                      background: active ? "color-mix(in srgb, var(--accent, #5b8def) 12%, #fff)" : "var(--surface-muted, #f5f5f5)",
                      border: `1px solid ${active ? "var(--accent, #5b8def)" : "var(--border, #ddd)"}`,
                      borderRadius: 999,
                      cursor: syncing ? "default" : "pointer",
                      display: "flex",
                      fontSize: 12,
                      gap: 5,
                      opacity: task && !syncing ? 0.75 : 1,
                      padding: "4px 10px",
                    }}
                    title={syncing ? undefined : "点击选择/取消该平台"}
                    type="button"
                  >
                    {account.avatar || account.icon ? (
                      <img alt="" src={account.avatar || account.icon} style={{ borderRadius: 8, height: 16, width: 16 }} />
                    ) : null}
                    <span>{account.displayName || account.title || account.type}</span>
                    {task && (
                      task.status === "done" ? (
                        <CheckCircle2 size={13} color="#0a7d33" />
                      ) : task.status === "failed" ? (
                        <XCircle size={13} color="#c0392b" />
                      ) : (
                        <LoaderCircle className="spin" size={13} />
                      )
                    )}
                  </button>
                );
              })}
              <button
                className="button button--primary"
                disabled={syncing || !selected.length}
                onClick={startSync}
                style={{ alignItems: "center", display: "flex", gap: 6, marginLeft: 6 }}
                type="button"
              >
                {syncing ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}
                {syncing ? "同步中…" : `同步草稿到 ${selected.length} 个平台`}
              </button>
            </div>
          )}

          <span style={{ flex: 1 }} />

          <button
            className="button button--quiet"
            onClick={() => setChromeVisible(false)}
            title="隐藏控件，只保留文章正文（按 Esc 或点右下角浮标恢复）"
            type="button"
          >
            纯净预览
          </button>
          <button className="button button--quiet" onClick={onClose} type="button">
            退出全屏
          </button>
        </header>
      )}

      {/* 每平台进度 / 草稿链接 */}
      {chromeVisible && Object.keys(tasks).length > 0 && (
        <footer
          style={{
            background: "var(--surface, #fff)",
            borderTop: "1px solid var(--border, #e5e5e5)",
            bottom: 0,
            boxSizing: "border-box",
            display: "flex",
            flexWrap: "wrap",
            fontSize: 12,
            gap: 14,
            inset: "auto 0 0 0",
            padding: "8px 16px",
            position: "fixed",
            zIndex: 2,
          }}
        >
          {Object.values(tasks).map((task) => {
            const account = accounts.find((item) => item.type === task.type);
            const link = task.editResp?.draftLink;
            return (
              <span key={task.type} style={{ alignItems: "center", display: "inline-flex", gap: 5 }}>
                <strong>{account?.displayName || account?.title || task.type}</strong>
                {task.status === "done" ? (
                  link ? (
                    <a href={link} rel="noreferrer" style={{ alignItems: "center", display: "inline-flex", gap: 3 }} target="_blank">
                      查看草稿 <ExternalLink size={11} />
                    </a>
                  ) : (
                    <span style={{ color: "#0a7d33" }}>已完成</span>
                  )
                ) : task.status === "failed" ? (
                  <span style={{ color: "#c0392b" }}>{task.error || STATUS_LABEL.failed}</span>
                ) : (
                  <span style={{ color: "var(--muted, #888)" }}>{task.msg || STATUS_LABEL.uploading}</span>
                )}
              </span>
            );
          })}
        </footer>
      )}

      {!chromeVisible && (
        <button
          aria-label="显示同步控件"
          onClick={() => setChromeVisible(true)}
          style={{
            background: "rgba(30,30,30,.25)",
            border: "none",
            borderRadius: 999,
            bottom: 16,
            color: "#fff",
            cursor: "pointer",
            fontSize: 12,
            opacity: 0.4,
            padding: "6px 12px",
            position: "fixed",
            right: 16,
            zIndex: 3,
          }}
          type="button"
        >
          显示同步控件
        </button>
      )}
    </div>
  );
}
