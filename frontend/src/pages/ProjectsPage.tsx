import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { ToolbarSelect } from "../components/ui/ToolbarSelect";
import { useNavigate } from "react-router-dom";
import {
  Check,
  FileText,
  GripVertical,
  LoaderCircle,
  Plus,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { api } from "../api/client";
import type { Project } from "../types/project";

// 照搬蓝本 ArticlesPage：article-browser 列表 + resizer + article-editor 编辑区（团队自有代码）。

const BOUNDS = { min: 208, max: 320, default: 248 } as const;

interface ProjectDraft {
  name: string;
  description: string;
  website_url: string;
  github_url: string;
  target_audience: string;
  tone: string;
  goals: string;
  selling_points: string;
  platforms: string;
}

function draftFrom(project: Project | null): ProjectDraft {
  return {
    name: project?.name ?? "",
    description: project?.description ?? "",
    website_url: project?.website_url ?? "",
    github_url: project?.github_url ?? "",
    target_audience: project?.target_audience ?? "",
    tone: project?.tone ?? "professional",
    goals: project?.goals ?? "",
    selling_points: (project?.selling_points ?? []).join("、"),
    platforms: (project?.platforms ?? []).join("、"),
  };
}

function splitList(text: string): string[] {
  return text
    .split(/[、,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export default function ProjectsPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [browserWidth, setBrowserWidth] = useState<number>(BOUNDS.default);
  const [draft, setDraft] = useState<ProjectDraft>(draftFrom(null));

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<Project[]>("/projects");
      setProjects(res.data);
      setSelectedId((current) => current ?? res.data[0]?.id ?? null);
    } catch {
      setError("无法加载项目列表，请确认后端服务已启动。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const selected = projects.find((p) => p.id === selectedId) ?? null;

  useEffect(() => {
    setDraft(draftFrom(selected));
  }, [selected]);

  const dirty = useMemo(() => {
    if (!selected) return false;
    return JSON.stringify(draft) !== JSON.stringify(draftFrom(selected));
  }, [draft, selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q),
    );
  }, [projects, query]);

  const resizeRef = { current: { startX: 0, startWidth: 0 } };

  const handleResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeRef.current = { startX: event.clientX, startWidth: browserWidth };
    const onMove = (move: PointerEvent) => {
      const next = resizeRef.current.startWidth + (move.clientX - resizeRef.current.startX);
      setBrowserWidth(Math.min(BOUNDS.max, Math.max(BOUNDS.min, Math.round(next))));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const patch = (fields: Partial<Project>) =>
    api.patch<Project>(`/projects/${selectedId}`, fields);

  const buildPayload = () => ({
    name: draft.name.trim() || selected?.name || "",
    description: draft.description,
    website_url: draft.website_url.trim() || null,
    github_url: draft.github_url.trim() || null,
    target_audience: draft.target_audience,
    tone: draft.tone,
    goals: draft.goals,
    selling_points: splitList(draft.selling_points),
    platforms: splitList(draft.platforms),
  });

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await patch(buildPayload());
      await loadProjects();
    } catch {
      setError("保存项目失败，请稍后重试。");
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async () => {
    if (!draft.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.post<Project>("/projects", {
        name: draft.name.trim(),
        description: draft.description,
        target_audience: draft.target_audience,
        tone: draft.tone,
        goals: draft.goals,
        selling_points: splitList(draft.selling_points),
        platforms: splitList(draft.platforms),
      });
      setCreating(false);
      setSelectedId(res.data.id);
      await loadProjects();
    } catch {
      setError("创建项目失败，请稍后重试。");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("确定删除该项目吗？")) return;
    try {
      await api.delete(`/projects/${id}`);
      setSelectedId((current) => (current === id ? null : current));
      await loadProjects();
    } catch {
      setError("删除项目失败。");
    }
  };

  const handleStartRun = async (id: string) => {
    if (!draft.name.trim()) {
      setError("请先填写产品名称（必填）再开始生成。");
      return;
    }
    if (!draft.description.trim()) {
      setError("请先填写产品简介（必填），AI 需要它来理解产品。");
      return;
    }
    setStartingId(id);
    setError(null);
    try {
      if (dirty && selected?.id === id) {
        await patch(buildPayload());
        await loadProjects();
      }
      const res = await api.post<{ id: string }>(`/projects/${id}/runs`);
      navigate(`/runs/${res.data.id}`);
    } catch {
      setError("启动工作流失败，请确认后端服务已启动。");
      setStartingId(null);
    }
  };

  if (loading) {
    return (
      <div className="page-loading" role="status">
        <span className="spinner" />
        正在读取项目
      </div>
    );
  }

  if (projects.length === 0 && !creating) {
    return (
      <section className="page empty-page">
        <FileText aria-hidden="true" size={28} />
        <h1>还没有项目</h1>
        <button className="button button--primary" onClick={() => setCreating(true)} type="button">
          <Plus size={16} />
          新建产品项目
        </button>
      </section>
    );
  }

  const layoutStyle = {
    "--article-browser-width": `${browserWidth}px`,
  } as CSSProperties;

  return (
    <section className="articles-layout" style={layoutStyle}>
      <aside className="article-browser" aria-label="项目列表">
        <div className="article-browser__head">
          <div>
            <span className="page-kicker">产品库</span>
            <strong>项目</strong>
          </div>
          <button
            aria-label="新建项目"
            className="icon-button"
            onClick={() => {
              setCreating(true);
              setSelectedId(null);
            }}
            title="新建项目"
            type="button"
          >
            <Plus size={16} />
          </button>
        </div>
        <label className="article-search">
          <Search aria-hidden="true" size={14} />
          <span className="visually-hidden">搜索项目</span>
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索项目"
            value={query}
          />
        </label>
        <div className="article-list">
          {filtered.map((project) => (
            <button
              aria-current={selectedId === project.id && !creating ? "true" : undefined}
              className={`article-list-item${selectedId === project.id && !creating ? " is-active" : ""}`}
              key={project.id}
              onClick={() => {
                setSelectedId(project.id);
                setCreating(false);
              }}
              type="button"
            >
              <span className="article-status article-status--draft">就绪</span>
              <strong>{project.name}</strong>
              <span className="article-list-item__meta">
                <span>{new Date(project.created_at).toLocaleDateString()}</span>
              </span>
            </button>
          ))}
          {filtered.length === 0 && <p className="article-list__empty">没有匹配的项目</p>}
        </div>
      </aside>

      <div
        aria-hidden="true"
        className="article-browser__resizer"
        onPointerDown={handleResizeStart}
        role="separator"
        tabIndex={-1}
      >
        <GripVertical size={14} />
      </div>

      <div className="article-editor">
        <header className="article-editor__head">
          <div className="article-editor__title">
            {creating ? (
              <>
                <span className="page-kicker">新建项目</span>
                <strong>产品信息</strong>
              </>
            ) : selected ? (
              <>
                <span className="article-status article-status--draft">就绪</span>
                <strong>{selected.name}</strong>
              </>
            ) : (
              <strong>选择一个项目</strong>
            )}
          </div>
          <div className="article-editor__actions">
            {creating ? (
              <>
                <button className="button button--quiet" onClick={() => setCreating(false)} type="button">
                  取消
                </button>
                <button
                  className="button button--primary"
                  disabled={saving || !draft.name.trim()}
                  onClick={() => void handleCreate()}
                  type="button"
                >
                  {saving ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
                  {saving ? "创建中" : "创建项目"}
                </button>
              </>
            ) : selected ? (
              <>
                <button
                  className="button button--quiet"
                  onClick={() => navigate(`/projects/${selected.id}/revisions`)}
                  type="button"
                >
                  版本历史
                </button>
                <button
                  aria-label="保存项目"
                  className="button button--primary"
                  disabled={saving || !dirty}
                  onClick={() => void handleSave()}
                  title="保存修改"
                  type="button"
                >
                  {saving ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : dirty ? (
                    <Save size={16} />
                  ) : (
                    <Check size={16} />
                  )}
                  {saving ? "保存中" : dirty ? "保存" : "已保存"}
                </button>
                <button
                  className="button button--primary"
                  disabled={startingId !== null}
                  onClick={() => void handleStartRun(selected.id)}
                  type="button"
                >
                  {startingId === selected.id ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <Plus size={16} />
                  )}
                  {startingId === selected.id ? "启动中" : "开始生成"}
                </button>
                <button
                  aria-label="删除项目"
                  className="icon-button"
                  onClick={() => void handleDelete(selected.id)}
                  title="删除项目"
                  type="button"
                >
                  <Trash2 size={15} />
                </button>
              </>
            ) : null}
          </div>
        </header>

        <div className="article-editor__body" style={{ overflowY: "auto", padding: "20px 24px" }}>
          {error && (
            <div className="workflow-task__failure" role="alert" style={{ marginBottom: 14 }}>
              <p>{error}</p>
            </div>
          )}
          <div style={{ display: "grid", gap: 20, maxWidth: 720 }}>
            <div>
              <span className="page-kicker">产品信息</span>
              <div style={{ display: "grid", gap: 14, marginTop: 10 }}>
                <div className="field">
                  <div className="field__head">
                    <label htmlFor="p-name">产品名称</label>
                    <span className="field-tag field-tag--required">必填</span>
                  </div>
                  <input
                    id="p-name"
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="例如：Open Publisher Web"
                    value={draft.name}
                  />
                </div>
                <div className="field">
                  <div className="field__head">
                    <label htmlFor="p-desc">产品简介</label>
                    <span className="field-tag field-tag--required">必填</span>
                  </div>
                  <small>一句话介绍，会直接进入 AI 的产品理解</small>
                  <textarea
                    id="p-desc"
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    placeholder="这个产品解决什么问题？"
                    rows={3}
                    value={draft.description}
                  />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <div className="field">
                    <div className="field__head">
                      <label htmlFor="p-site">官网</label>
                      <span className="field-tag">选填</span>
                    </div>
                    <input
                      id="p-site"
                      onChange={(e) => setDraft({ ...draft, website_url: e.target.value })}
                      placeholder="留空则不引用官网"
                      value={draft.website_url}
                    />
                  </div>
                  <div className="field">
                    <div className="field__head">
                      <label htmlFor="p-github">GitHub</label>
                      <span className="field-tag">选填</span>
                    </div>
                    <input
                      id="p-github"
                      onChange={(e) => setDraft({ ...draft, github_url: e.target.value })}
                      placeholder="留空则不引用仓库"
                      value={draft.github_url}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div>
              <span className="page-kicker">受众与语气</span>
              <div style={{ display: "grid", gap: 14, marginTop: 10 }}>
                <div className="field">
                  <div className="field__head">
                    <label htmlFor="p-audience">目标受众</label>
                    <span className="field-tag">选填</span>
                  </div>
                  <small>留空则由 AI 根据产品定位推断</small>
                  <input
                    id="p-audience"
                    onChange={(e) => setDraft({ ...draft, target_audience: e.target.value })}
                    placeholder="例如：独立开发者、小团队"
                    value={draft.target_audience}
                  />
                </div>
                <div className="field">
                  <label>语气</label>
                  <ToolbarSelect
                    label="语气"
                    onChange={(value) => setDraft({ ...draft, tone: value })}
                    options={[
                      { id: "professional", label: "专业" },
                      { id: "casual", label: "轻松" },
                      { id: "founder", label: "创始人口吻" },
                      { id: "technical", label: "技术向" },
                    ]}
                    value={draft.tone}
                  />
                </div>
                <div className="field">
                  <div className="field__head">
                    <label htmlFor="p-goals">推广目标</label>
                    <span className="field-tag">选填</span>
                  </div>
                  <small>这条推文希望达成什么</small>
                  <input
                    id="p-goals"
                    onChange={(e) => setDraft({ ...draft, goals: e.target.value })}
                    placeholder="例如：引导试用 / 涨粉 / 招募内测"
                    value={draft.goals}
                  />
                </div>
              </div>
            </div>

            <div>
              <span className="page-kicker">卖点与平台</span>
              <div style={{ display: "grid", gap: 14, marginTop: 10 }}>
                <div className="field">
                  <div className="field__head">
                    <label htmlFor="p-points">核心卖点</label>
                    <span className="field-tag">选填</span>
                  </div>
                  <small>用顿号分隔，如：免注册、支持 20+ 语言、一键生成</small>
                  <textarea
                    id="p-points"
                    onChange={(e) => setDraft({ ...draft, selling_points: e.target.value })}
                    rows={2}
                    value={draft.selling_points}
                  />
                </div>
                <div className="field">
                  <div className="field__head">
                    <label htmlFor="p-platforms">目标平台</label>
                    <span className="field-tag">选填</span>
                  </div>
                  <small>用顿号分隔，如：twitter、xiaohongshu；留空默认 twitter</small>
                  <input
                    id="p-platforms"
                    onChange={(e) => setDraft({ ...draft, platforms: e.target.value })}
                    value={draft.platforms}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
