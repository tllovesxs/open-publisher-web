import { useState } from "react";
import { BookOpen, ExternalLink, Send } from "lucide-react";

interface PublishNoticeDialogProps {
  onContinue: () => void;
  onClose: () => void;
  onOpenTutorial: () => void;
}

const NOTICE_STORAGE_KEY = "opw.publish-notice-muted-date";

function readMutedDate(): string | null {
  try {
    return window.localStorage.getItem(NOTICE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** 发布前置提醒：同步助手安装/登录教程（对应公告页图文教程的弹窗版）。 */
export function PublishNoticeDialog({ onContinue, onClose, onOpenTutorial }: PublishNoticeDialogProps) {
  const [mutedToday, setMutedToday] = useState(() => readMutedDate() === new Date().toISOString().slice(0, 10));

  const toggleMute = () => {
    const next = !mutedToday;
    setMutedToday(next);
    try {
      if (next) {
        window.localStorage.setItem(NOTICE_STORAGE_KEY, new Date().toISOString().slice(0, 10));
      } else {
        window.localStorage.removeItem(NOTICE_STORAGE_KEY);
      }
    } catch {
      // localStorage 不可用时静默忽略，弹窗行为不受影响
    }
  };

  return (
    <div className="studio-modal" role="presentation">
      <div className="studio-modal__scrim" />
      <section
        aria-label="发布前提醒"
        aria-modal="true"
        className="creation-picker__dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        style={{ maxWidth: 520, width: "min(520px, 100%)" }}
      >
        <header style={{ alignItems: "center", display: "flex", justifyContent: "space-between", paddingBottom: 12, borderBottom: "1px solid var(--border, #eee)" }}>
          <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
            <div style={{
              alignItems: "center", background: "linear-gradient(135deg, #07c160, #06ad56)",
              borderRadius: 10, color: "#fff", display: "grid", height: 36, placeItems: "center", width: 36,
            }}>
              <Send size={17} />
            </div>
            <h2 style={{ fontSize: 17, margin: 0 }}>发布前，先完成同步助手配置</h2>
          </div>
          <button aria-label="关闭提醒" className="icon-button" onClick={onClose} type="button">✕</button>
        </header>

        <ol style={{ color: "var(--ink)", fontSize: 13, lineHeight: 1.9, margin: "14px 0 0", paddingInlineStart: 20 }}>
          <li>
            <strong>加载扩展</strong>：在当前 Chrome / Edge 浏览器安装并启用「文章同步助手」，允许插件访问稿流网站，安装后刷新页面。
          </li>
          <li>
            <strong>登录平台</strong>：点击浏览器工具栏的「文章同步助手」→ 右上角「设置」→ 登录知乎 / 掘金 / 哔哩哔哩 / CSDN / 微信公众号等目标平台。
          </li>
          <li>
            <strong>同步草稿</strong>：回到稿流文章页点「同步发布」→ 刷新平台 → 勾选目标 → 点击「同步到草稿」，完成后打开草稿检查并正式发布。
          </li>
        </ol>

        <p style={{ color: "var(--muted, #888)", fontSize: 12, margin: "12px 0 0" }}>
          Web 版通过插件直接同步，无需填写 Token 或开启 CLI / MCP。插件也可通过右键菜单「同步助手 - 提取并编辑文章」处理纯净预览。
        </p>

        <footer style={{ alignItems: "center", display: "flex", gap: 10, justifyContent: "space-between", marginTop: 16 }}>
          <label style={{ alignItems: "center", color: "var(--muted, #888)", cursor: "pointer", display: "flex", fontSize: 12, gap: 6 }}>
            <input checked={mutedToday} onChange={toggleMute} type="checkbox" />
            今天不再提醒
          </label>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="button button--quiet" onClick={() => { onOpenTutorial(); }} style={{ alignItems: "center", display: "flex", gap: 5 }} type="button">
              <BookOpen size={14} /> 查看完整教程 <ExternalLink size={12} />
            </button>
            <button className="button button--primary" onClick={onContinue} type="button">
              继续发布
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

export function publishNoticeMutedToday(): boolean {
  return readMutedDate() === new Date().toISOString().slice(0, 10);
}


