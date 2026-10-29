import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, LoaderCircle, Monitor, RefreshCw, Send, XCircle } from "lucide-react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { prepareSyncPost } from "./syncPost";

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
        onStatus: (task: SyncTaskStatus | { accounts: SyncTaskStatus[] }) => void,
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
 * 1. 纯净文章预览，与桌面蓝本相同地由用户选择平台并提交草稿；
 * 2. 通过扩展注入的 window.$syncer 读取已登录平台并提交草稿同步任务（只存草稿，不代发布）。 */
export function SyncPublishDialog({ title, markdown, onClose }: SyncPublishDialogProps) {
  const [extStatus, setExtStatus] = useState<"checking" | "missing" | "empty" | "error" | "ready">("checking");
  const [accounts, setAccounts] = useState<SyncAccount[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [tasks, setTasks] = useState<Record<string, SyncTaskStatus>>({});
  const [syncing, setSyncing] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const shellRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const alive = useRef(true);
  const detecting = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const timeout = useRef<number>();
  useEffect(() => { alive.current = true; return () => { alive.current = false; detecting.current++; controller.current?.abort(); window.clearTimeout(timeout.current); }; }, []);

  // 纯净正文：先解析 asset:// 素材引用（与编辑器预览同链路），再净化 HTML，并把站内相对图片地址补全成绝对地址
  const articleHtml = useMemo(() => {
    const html = DOMPurify.sanitize(marked.parse(markdown.replace(/\]\(asset:\/\/([A-Za-z0-9][A-Za-z0-9:_-]{0,255})\)/g, (_, id: string) => `](/api/media/${encodeURIComponent(id)}/raw)`), { async: false }) as string);
    const box = document.createElement("div");
    box.innerHTML = html;
    box.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src");
      if (src) {
        const url = new URL(src, window.location.origin);
        url.searchParams.delete("access_token");
        img.setAttribute("src", url.href);
      }
    });
    return box.innerHTML;
  }, [markdown]);

  const refreshAccounts = useCallback(async () => {
    const request = ++detecting.current;
    setExtStatus("checking"); setError("");
    const deadline = Date.now() + 5000;
    while (!window.$syncer?.getAccounts && Date.now() < deadline && alive.current) await new Promise(resolve => window.setTimeout(resolve, 100));
    if (!alive.current || request !== detecting.current) return;
    const bridge = window.$syncer;
    if (!bridge?.getAccounts || !bridge.addTask) { setExtStatus("missing"); return; }
    const timer = window.setTimeout(() => { if (alive.current && request === detecting.current) { detecting.current++; setExtStatus("error"); setError("插件未返回平台信息，请检查网站访问权限后重试。"); } }, 20000);
    try {
      bridge.getAccounts(list => {
        window.clearTimeout(timer);
        if (!alive.current || request !== detecting.current) return;
        const ready = Array.isArray(list) ? list.filter(item => item && typeof item.type === "string") : [];
        setAccounts(ready); setSelected([]); setExtStatus(ready.length ? "ready" : "empty");
      });
    } catch { window.clearTimeout(timer); setExtStatus("error"); setError("读取插件失败，请刷新页面后重试。"); }
  }, []);
  useEffect(() => { void refreshAccounts(); }, [refreshAccounts]);

  const startSync = async () => {
    const bridge = window.$syncer;
    if (!bridge || syncing || submitted) return;
    const picked = accounts.filter(item => selected.includes(item.type));
    if (!picked.length) return;
    setSyncing(true); setError("");
    controller.current = new AbortController();
    try {
      const post = await prepareSyncPost(title, markdown, controller.current.signal);
      if (!alive.current) return;
      setSubmitted(true);
      setTasks(Object.fromEntries(picked.map(item => [item.type, { type: item.type, status: "uploading" }])));
      timeout.current = window.setTimeout(() => {
        if (!alive.current) return;
        setSyncing(false); setError("同步结果尚未确认，请先查看插件同步记录与平台草稿箱，避免重复提交。");
      }, 11 * 60 * 1000);
      bridge.addTask({ post, accounts: picked }, update => {
        if (!alive.current) return;
        if (!update || typeof update !== "object") return;
        const batch = "accounts" in update && Array.isArray(update.accounts) ? update.accounts : [update as SyncTaskStatus];
        setTasks(current => {
          const next = { ...current };
          for (const task of batch) if (task && picked.some(item => item.type === task.type)) next[task.type] = { ...next[task.type], ...task };
          return next;
        });
      });
    } catch (failure) {
      if (!alive.current) return;
      setSyncing(false); window.clearTimeout(timeout.current);
      setError(failure instanceof Error ? failure.message : "无法提交同步，请检查插件后重试。");
    }
  };
  useEffect(() => {
    const values = Object.values(tasks);
    if (values.length && values.every(task => task.status === "done" || task.status === "failed")) {
      setSyncing(false); window.clearTimeout(timeout.current);
    }
  }, [tasks]);

  const toggleAccount = (type: string) => {
    setSelected((current) =>
      current.includes(type) ? current.filter((item) => item !== type) : [...current, type],
    );
  };

  return (
    <div
      aria-label="文章同步发布"
      role="dialog"
      aria-modal="true"
      className="sync-publish"
      style={{ background: "var(--surface, #fff)", inset: 0, overflowY: "auto", position: "fixed", zIndex: 1300 }}
    >
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
            top: 0,
            padding: "10px 16px",
            position: "sticky",
            zIndex: 2,
          }}
        >
          <strong style={{ fontSize: 13 }}>
            <Monitor size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
            文章同步助手 · 同步到平台草稿
          </strong>

          {extStatus === "checking" && (
            <small style={{ alignItems: "center", color: "var(--muted, #999)", display: "flex", gap: 6 }}>
              <LoaderCircle className="spin" size={13} /> 检测文章同步助手扩展…
            </small>
          )}

          {extStatus === "missing" && (
            <small style={{ color: "var(--warning, #b45309)", maxWidth: 460 }}>
              未检测到插件。请在当前浏览器安装并启用「文章同步助手」，允许访问此网站后刷新页面。
            </small>
          )}

          {extStatus === "empty" && <small>插件已连接，请先登录目标平台，再刷新平台。</small>}
          {error && <small role="alert" style={{ color: "var(--danger, #b0434e)" }}>{error}</small>}
          <button className="button button--quiet" disabled={syncing || submitted || extStatus === "checking"} onClick={() => void refreshAccounts()} type="button"><RefreshCw size={14} /> 刷新平台</button>
          <a href="https://www.wechatsync.com/" target="_blank" rel="noreferrer">安装插件</a>
          {extStatus === "ready" && (
            <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 6 }}>
              {accounts.map((account) => {
                const active = selected.includes(account.type);
                const task = tasks[account.type];
                return (
                  <button
                    disabled={syncing || submitted}
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
                disabled={syncing || submitted || !selected.length}
                onClick={startSync}
                style={{ alignItems: "center", display: "flex", gap: 6, marginLeft: 6 }}
                type="button"
              >
                {syncing ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}
                {syncing ? "同步中…" : submitted ? "已提交同步" : `同步到草稿（${selected.length} 个平台）`}
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
            返回文章
          </button>
        </header>
      )}

      <article
        id="sync-article"
        ref={shellRef}
        style={{
          boxSizing: "border-box",
          color: "var(--ink, #222)",
          fontFamily: "-apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif",
          lineHeight: 1.9,
          margin: "0 auto",
          maxWidth: 760,
          padding: "32px 24px 80px",
          transition: "padding 200ms ease",
        }}
      >
        <h1 style={{ fontSize: 28, lineHeight: 1.4, marginBottom: 20 }}>{title}</h1>
        <div className="markdown-preview" dangerouslySetInnerHTML={{ __html: articleHtml }} />
      </article>

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
            const rawLink = task.editResp?.draftLink;
            const link = rawLink && /^https?:\/\//i.test(rawLink) ? rawLink : null;
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
