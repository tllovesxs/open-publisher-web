import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Check, Copy, LoaderCircle, Pencil, X } from "lucide-react";
import { api } from "../api/client";
import type { TweetRevision } from "../types/run";

// 版本页照搬蓝本 RevisionHistoryDrawer 的时间线结构（revision-timeline，团队自有代码）。
export default function RevisionsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [revisions, setRevisions] = useState<TweetRevision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    id: string;
    content: string;
    platform: string;
    tone: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadRevisions = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<TweetRevision[]>(`/projects/${projectId}/revisions`);
      setRevisions(res.data);
    } catch {
      setError("无法加载版本历史，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadRevisions();
  }, [loadRevisions]);

  const startEdit = (rev: TweetRevision) => {
    setEditing({
      id: rev.id,
      content: rev.content,
      platform: rev.platform ?? "",
      tone: rev.tone ?? "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleSave = async () => {
    if (!projectId || !editing) return;
    setSaving(true);
    try {
      await api.post(`/projects/${projectId}/revisions`, {
        content: editing.content,
        platform: editing.platform || null,
        tone: editing.tone || null,
      });
      setEditing(null);
      await loadRevisions();
    } catch {
      setError("保存新版本失败，请稍后重试。");
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async (rev: TweetRevision) => {
    try {
      await navigator.clipboard.writeText(rev.content);
      setCopiedId(rev.id);
      window.setTimeout(() => setCopiedId(null), 1500);
    } catch {
      setError("复制失败，请手动选择文本复制。");
    }
  };

  if (loading) {
    return (
      <div className="page-loading" role="status">
        <span className="spinner" />
        正在读取版本记录
      </div>
    );
  }

  return (
    <section className="page">
      <header className="page-heading">
        <div>
          <span className="page-kicker">版本记录</span>
          <h1>版本历史</h1>
        </div>
        <div className="page-heading__actions">
          <button
            className="button button--quiet"
            onClick={() =>
              setEditing({ id: "", content: "", platform: "", tone: "" })
            }
            type="button"
          >
            <Pencil size={14} />
            手动新建
          </button>
        </div>
      </header>

      {error && (
        <div className="workflow-task__failure" role="alert">
          <p>{error}</p>
        </div>
      )}

      {editing && (
        <div className="creation-composer" style={{ marginBottom: 24, padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <strong>
              {editing.id
                ? `编辑版本 v${revisions.find((r) => r.id === editing.id)?.version}（保存为新版本）`
                : "手动创建第一个版本"}
            </strong>
            <button aria-label="取消编辑" className="icon-button" onClick={() => setEditing(null)} type="button">
              <X size={16} />
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
            <div className="field">
              <label htmlFor="edit-platform">平台</label>
              <input
                id="edit-platform"
                onChange={(e) => setEditing({ ...editing, platform: e.target.value })}
                placeholder="如 twitter / wechat"
                value={editing.platform}
              />
            </div>
            <div className="field">
              <label htmlFor="edit-tone">语气</label>
              <input
                id="edit-tone"
                onChange={(e) => setEditing({ ...editing, tone: e.target.value })}
                placeholder="如 professional / casual"
                value={editing.tone}
              />
            </div>
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="edit-content">推文内容 *</label>
            <textarea
              id="edit-content"
              onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              rows={6}
              value={editing.content}
            />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              className="button button--primary"
              disabled={saving || !editing.content.trim()}
              onClick={() => void handleSave()}
              type="button"
            >
              {saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
              {saving ? "保存中" : "保存为新版本"}
            </button>
          </div>
        </div>
      )}

      {revisions.length === 0 ? (
        <div className="revision-history-empty" role="status">
          还没有版本。先在工作台"开始生成"，或点右上角"手动新建"。
        </div>
      ) : (
        <ol className="revision-timeline">
          {revisions.map((rev) => (
              <li key={rev.id}>
                <span aria-hidden="true" className="revision-timeline__node" />
                <div className="revision-timeline__entry" style={{ cursor: "default" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  <span className="article-status">v{rev.version}</span>
                  <span
                    className="article-status"
                    style={
                      rev.source === "user_edited"
                        ? { background: "var(--accent-soft)", color: "var(--accent-ink)" }
                        : rev.source === "ai_optimized"
                          ? { background: "var(--warning-soft)", color: "var(--warning)" }
                          : undefined
                    }
                  >
                    {rev.source === "user_edited"
                      ? "用户编辑"
                      : rev.source === "ai_optimized"
                        ? "AI 优化"
                        : "AI 生成"}
                  </span>
                  {rev.platform && <span className="article-status">{rev.platform}</span>}
                  {rev.tone && <span className="article-status">{rev.tone}</span>}
                  {rev.score != null && (
                    <span className="article-status article-status--running">
                      评分 {Math.round(rev.score)}
                    </span>
                  )}
                  <span
                    className="article-status"
                    style={
                      rev.risk_level === "high"
                        ? { background: "var(--danger-soft)", color: "var(--danger)" }
                        : rev.risk_level === "medium"
                          ? { background: "var(--warning-soft)", color: "var(--warning)" }
                          : { background: "var(--success-soft)", color: "var(--success)" }
                    }
                  >
                    风险 {rev.risk_level}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button
                    className="button button--quiet"
                    onClick={() => void handleCopy(rev)}
                    type="button"
                  >
                    {copiedId === rev.id ? <Check size={14} /> : <Copy size={14} />}
                    {copiedId === rev.id ? "已复制" : "复制"}
                  </button>
                  <button className="button button--quiet" onClick={() => startEdit(rev)} type="button">
                    <Pencil size={14} />
                    编辑
                  </button>
                </div>
                <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.7, margin: "8px 0 0", color: "var(--ink)" }}>
                  {rev.content}
                </p>
                <span className="page-kicker">{new Date(rev.created_at).toLocaleString()}</span>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div style={{ marginTop: 28 }}>
        <Link className="text-button" to="/">
          ← 返回项目列表
        </Link>
      </div>
    </section>
  );
}
