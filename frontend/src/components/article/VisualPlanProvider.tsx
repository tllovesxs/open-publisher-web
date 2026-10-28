import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ToolbarSelect } from "../ui/ToolbarSelect";
import { Eye, LoaderCircle, Pencil, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";

interface VisualPlanPlacement {
  id: string;
  anchorHeading: string | null;
  anchorExcerpt: string | null;
  alt: string;
  source: "existing_asset" | "generate";
  assetId: string | null;
  candidates: Array<{ assetId: string; score: number; description: string }>;
  selectionReason: string;
  generationPrompt: string;
}

export interface VisualPlanSummary {
  targetCount: number;
  placements: VisualPlanPlacement[];
  sourceRevisionId: string | null;
  sourceContentHash: string | null;
  imageModelId?: string | null;
}

interface VisualApplyResult {
  article: {
    articleId: string;
    title: string;
    currentRevisionId: string | null;
    contentHash: string | null;
    markdown: string;
    updatedAt: string | null;
  };
  insertedCount: number;
  skipped: Array<{ id: string; reason: string }>;
}

export interface VisualPlanSnapshot {
  revisionId: string | null;
  contentHash: string | null;
  markdown: string;
}

interface VisualPlanJob {
  articleId: string;
  plan: VisualPlanSummary;
  snapshot: VisualPlanSnapshot | null;
}

interface CompletedVisualApply {
  articleId: string;
  article: VisualApplyResult["article"];
  snapshot: VisualPlanSnapshot;
  insertedCount: number;
  skipped: VisualApplyResult["skipped"];
}

interface StartVisualPlanOptions {
  targetCount?: number;
  assetIds?: string[];
  snapshot?: VisualPlanSnapshot | null;
}

interface VisualPlanContextValue {
  busy: boolean;
  error: string | null;
  job: VisualPlanJob | null;
  completed: CompletedVisualApply | null;
  excludedIds: string[];
  startPlan: (articleId: string, options?: StartVisualPlanOptions) => Promise<void>;
  setPlanForArticle: (
    articleId: string,
    plan: VisualPlanSummary,
    snapshot: VisualPlanSnapshot | null,
  ) => void;
  togglePlacement: (placementId: string) => void;
  closePlan: () => void;
  minimizePlan: () => void;
  confirmApply: () => Promise<void>;
  consumeCompleted: () => void;
}

const STYLE_PRESETS = [
  { id: "default", label: "默认（手绘扁平）", suffix: "" },
  { id: "minimal", label: "极简线条", suffix: "极简线条风格、大量留白、单色或双色，画面干净克制。" },
  { id: "watercolor", label: "水彩插画", suffix: "水彩插画风格、柔和色彩、自然过渡，画面温暖。" },
  { id: "3d", label: "3D 渲染", suffix: "3D 等距渲染风格、柔和光影、圆角几何，现代感。" },
  { id: "photo", label: "摄影写实", suffix: "真实摄影风格、自然光、浅景深，画面逼真。" },
  { id: "flat", label: "扁平几何", suffix: "扁平几何风格、色块构成、极简配色，现代设计感。" },
] as const;

interface ImageModelOption { id: string; name: string; model: string }

const VisualPlanContext = createContext<VisualPlanContextValue | null>(null);

function useVisualPlanContext(): VisualPlanContextValue {
  const value = useContext(VisualPlanContext);
  if (!value) throw new Error("useVisualPlan must be used within VisualPlanProvider");
  return value;
}

/** 智能配图任务的全局状态：
 * 确认弹窗和生图进度放在 App 级 Provider，切到其它页面也不会丢失进行中的任务。 */
export function VisualPlanProvider({ children }: { children: ReactNode }) {
  const [job, setJob] = useState<VisualPlanJob | null>(null);
  const [completed, setCompleted] = useState<CompletedVisualApply | null>(null);
  const [excludedIds, setExcludedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promptEdits, setPromptEdits] = useState<Record<string, string>>({});
  const [styleSelections, setStyleSelections] = useState<Record<string, string>>({});
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [editingPrompts, setEditingPrompts] = useState<Record<string, boolean>>({});
  const [imageModels, setImageModels] = useState<ImageModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [targetCount, setTargetCount] = useState(2);
  const [dismissed, setDismissed] = useState(false);
  const [materialMatchThreshold, setMaterialMatchThreshold] = useState(30);
  const navigate = useNavigate();

  // 加载可选生图模型列表
  useEffect(() => {
    api.get<{ models: ImageModelOption[] }>("/settings/image-models")
      .then((res) => {
        const models = res.data.models ?? [];
        setImageModels(models);
        if (models.length > 0) setSelectedModel(models[0].id);
      })
      .catch(() => setImageModels([]));
  }, []);

  const startPlan = async (articleId: string, options: StartVisualPlanOptions = {}) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setExcludedIds([]);
    setDismissed(false);
    try {
      const res = await api.post<VisualPlanSummary>(
        `/articles/${articleId}/visual-plan`,
        {
          targetCount: options.targetCount ?? targetCount,
          assetIds: options.assetIds ?? [],
          materialMatchThreshold,
        },
      );
      if (res.data.placements.length === 0) {
        setError("视觉规划认为本文不需要配图。");
        setJob(null);
        return;
      }
      setJob({
        articleId,
        plan: res.data,
        snapshot: options.snapshot ?? null,
      });
    } catch {
      setError("配图规划失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const setPlanForArticle = (
    articleId: string,
    plan: VisualPlanSummary,
    snapshot: VisualPlanSnapshot | null,
  ) => {
    setJob({ articleId, plan, snapshot });
    setExcludedIds([]);
    setError(null);
  };

  const getEffectivePrompt = (placementId: string, originalPrompt: string) => {
    const edited = promptEdits[placementId];
    const style = STYLE_PRESETS.find((s) => s.id === (styleSelections[placementId] ?? "default"));
    let prompt = edited ?? originalPrompt;
    if (style && style.suffix && !prompt.includes(style.suffix)) {
      prompt = prompt.replace(/风格：.*?(?=。|$)/, `风格：${style.suffix}`);
      if (prompt.includes(style.suffix)) return prompt;
      prompt = `${prompt} 风格：${style.suffix}`;
    }
    return prompt;
  };

  const updatePrompt = (placementId: string, value: string) => {
    setPromptEdits((current) => ({ ...current, [placementId]: value }));
  };

  const togglePromptEdit = (placementId: string) => {
    setEditingPrompts((current) => ({ ...current, [placementId]: !current[placementId] }));
  };

  const updateStyle = (placementId: string, styleId: string) => {
    setStyleSelections((current) => ({ ...current, [placementId]: styleId }));
  };

  const generatePreview = async (placementId: string, originalPrompt: string) => {
    if (previewing) return;
    setPreviewing(placementId);
    const prompt = getEffectivePrompt(placementId, originalPrompt);
    try {
      const res = await api.post<{ source: string }>("/media/preview", {
        prompt: prompt.slice(0, 2000),
        size: "1024x1024",
        imageModelId: selectedModel || undefined,
      });
      setPreviews((current) => ({ ...current, [placementId]: res.data.source }));
    } catch {
      setError("预览生成失败，请检查生图模型配置。");
    } finally {
      setPreviewing(null);
    }
  };

  const togglePlacement = (placementId: string) => {
    setExcludedIds((current) =>
      current.includes(placementId)
        ? current.filter((id) => id !== placementId)
        : [...current, placementId],
    );
  };

  const replan = async (count: number) => {
    if (!job || busy) return;
    setTargetCount(count);
    setBusy(true);
    setError(null);
    setExcludedIds([]);
    try {
      const res = await api.post<VisualPlanSummary>(
        `/articles/${job.articleId}/visual-plan`,
        { targetCount: count, assetIds: [], materialMatchThreshold },
      );
      if (res.data.placements.length === 0) {
        setError("视觉规划认为本文不需要配图。");
        return;
      }
      setJob({ ...job, plan: res.data });
    } catch {
      setError("重新规划失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const closePlan = () => {
    if (busy) return;
    setJob(null);
    setExcludedIds([]);
    setError(null);
    setDismissed(false);
  };

  // 后台模式：收起弹窗但保留任务，状态由右下角浮条承接。
  const minimizePlan = () => setDismissed(true);

  const resumeVisualPlan = () => {
    if (!busy && !job && completed) {
      navigate("/articles");
      return;
    }
    setDismissed(false);
  };

  const confirmApply = async () => {
    const current = job;
    if (!current || busy) return;
    const placements = current.plan.placements.filter(
      (placement) => !excludedIds.includes(placement.id),
    ).map((placement) => ({
      ...placement,
      generationPrompt: getEffectivePrompt(placement.id, placement.generationPrompt),
    }));
    if (!placements.length) {
      setError("请至少保留一张配图，或关闭方案。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let snapshot = current.snapshot;
      if (!snapshot) {
        const articleRes = await api.get<VisualApplyResult["article"]>(
          `/articles/${current.articleId}`,
        );
        snapshot = {
          revisionId: articleRes.data.currentRevisionId,
          contentHash: articleRes.data.contentHash,
          markdown: articleRes.data.markdown,
        };
      }
      const res = await api.post<VisualApplyResult>(
        `/articles/${current.articleId}/visual-apply`,
        {
          baseRevisionId: snapshot.revisionId,
          baseContentHash: snapshot.contentHash,
          placements,
          imageModelId: selectedModel || null,
        },
      );
      if (!res.data.insertedCount) {
        const reason = res.data.skipped[0]?.reason;
        setError(reason ? `配图应用失败：${reason}` : "配图应用失败，请稍后重试。");
        return;
      }
      setCompleted({
        articleId: current.articleId,
        article: res.data.article,
        snapshot,
        insertedCount: res.data.insertedCount,
        skipped: res.data.skipped,
      });
      setJob(null);
      setExcludedIds([]);
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(detail || "配图应用失败：文章可能已被修改，请刷新后重试。");
    } finally {
      setBusy(false);
    }
  };

  const consumeCompleted = () => setCompleted(null);

  return (
    <VisualPlanContext.Provider
      value={{
        busy,
        error,
        job,
        completed,
        excludedIds,
        startPlan,
        setPlanForArticle,
        togglePlacement,
        closePlan,
        minimizePlan,
        confirmApply,
        consumeCompleted,
      }}
    >
      {children}
      {(job || busy || error) && !dismissed && (
        <div className="studio-modal" role="presentation">
          <div className="studio-modal__scrim" />
          <section
            aria-label="确认配图方案"
            aria-modal="true"
            className="creation-picker__dialog visual-plan-dialog"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            style={{ maxWidth: 600, width: "min(600px, 100%)" }}
          >
            <header style={{ alignItems: "center", display: "flex", justifyContent: "space-between", paddingBottom: 14, borderBottom: "1px solid var(--border, #eee)" }}>
              <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
                <div style={{
                  alignItems: "center", background: "linear-gradient(135deg, var(--accent, #5b8def), color-mix(in srgb, var(--accent, #5b8def) 60%, #9b59b6))",
                  borderRadius: 10, color: "#fff", display: "grid", height: 38, placeItems: "center", width: 38,
                }}>
                  <Sparkles size={18} />
                </div>
                <div>
                  <span style={{ color: "var(--accent, #5b8def)", fontSize: 11, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase" }}>智能配图</span>
                  <h2 style={{ fontSize: 17, margin: 0 }}>{job ? `确认配图方案（${job.plan.placements.length} 张）` : busy ? "正在规划配图" : "智能配图"}</h2>
                </div>
              </div>
              <button
                aria-label="配图任务转后台"
                className="icon-button"
                onClick={minimizePlan}
                title="最小化到后台，稍后从右下角状态条恢复"
                type="button"
              >
                ✕
              </button>
            </header>
            <div className="visual-plan-dialog__body">
            {busy && (
              <div style={{
                alignItems: "center", display: "flex", gap: 10, marginTop: 4, padding: "12px 14px",
                border: "1px solid color-mix(in srgb, var(--accent, #5b8def) 18%, transparent)",
                borderRadius: 10, background: "color-mix(in srgb, var(--accent, #5b8def) 6%, transparent)",
              }}>
                <LoaderCircle className="spin" size={18} style={{ color: "var(--accent, #5b8def)", flexShrink: 0 }} />
                <div>
                  <div style={{ color: "var(--ink)", fontSize: 13, fontWeight: 600 }}>
                    {job ? "正在生成配图" : "正在规划配图"}
                  </div>
                  <div style={{ color: "var(--muted, #999)", fontSize: 12, marginTop: 2 }}>
                    {job ? "生成图片并插入正文，切换页面后进度不会丢失。" : "分析正文内容，匹配合适的插图位置，切换页面后进度不会丢失。"}
                  </div>
                </div>
              </div>
            )}
            {error && (
              <div className="workflow-task__failure" role="alert" style={{ marginTop: 10 }}>
                <p>{error}</p>
              </div>
            )}
            <p style={{ color: "var(--muted, #888)", fontSize: 12, lineHeight: 1.5, marginTop: 10 }}>
              素材库图片按匹配度自动选用；未达到阈值的位置将调用生图模型生成新图。
            </p>
            {imageModels.length > 0 && (
              <div style={{
                alignItems: "center", display: "flex", gap: 8, marginTop: 10, padding: "8px 10px",
                background: "var(--surface-muted, #f5f5f5)", borderRadius: 8,
              }}>
                <small style={{ color: "var(--muted, #888)", flexShrink: 0, fontSize: 11 }}>生图模型</small>
                <ToolbarSelect
                  className="toolbar-select--fill"
                  label="生图模型"
                  onChange={(value) => setSelectedModel(value)}
                  options={imageModels.map((m) => ({ id: m.id, label: m.name }))}
                  value={selectedModel}
                />
                <button
                  className="button button--quiet"
                  onClick={() => window.open("http://localhost:5174", "_blank")}
                  style={{ fontSize: 11, flexShrink: 0, padding: "3px 8px" }}
                  title="在管理端添加生图模型"
                  type="button"
                >
                  + 添加
                </button>
              </div>
            )}
            {imageModels.length === 0 && (
              <div style={{
                alignItems: "center", display: "flex", gap: 8, marginTop: 10, padding: "8px 10px",
                background: "var(--warning-soft, #fff3cd)", borderRadius: 8, border: "1px solid var(--warning, #ffc107)",
              }}>
                <small style={{ color: "var(--warning, #856404)", fontSize: 11 }}>
                  未配置生图模型，请到管理端添加。
                </small>
              </div>
            )}
            <div style={{
              alignItems: "center", display: "flex", gap: 8, marginTop: 10, padding: "8px 10px",
              background: "var(--surface-muted, #f5f5f5)", borderRadius: 8,
            }}>
              <small className="visual-count__label">配图数量</small>
              <div aria-label="配图数量" className="visual-count__segment" role="group">
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <button
                    aria-pressed={n === targetCount}
                    className={`visual-count__btn${n === targetCount ? " is-active" : ""}`}
                    disabled={busy}
                    key={n}
                    onClick={() => void replan(n)}
                    type="button"
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <label className="creation-threshold" style={{ marginTop: 12 }}>
              <span>
                素材匹配阈值 <strong>{materialMatchThreshold}%</strong>
              </span>
              <input
                aria-label="素材匹配阈值"
                disabled={busy}
                max={100}
                min={0}
                onChange={(event) => setMaterialMatchThreshold(Number(event.target.value))}
                step={5}
                type="range"
                value={materialMatchThreshold}
              />
              <small>达到此匹配度时优先使用素材库图片；未达到阈值的位置将调用生图模型生成新图。</small>
            </label>
            <ol style={{ display: "grid", gap: 10, marginTop: 12 }}>
              {job?.plan.placements.map((placement) => {
                const isExcluded = excludedIds.includes(placement.id);
                const isEditing = editingPrompts[placement.id];
                const effectivePrompt = getEffectivePrompt(placement.id, placement.generationPrompt);
                const previewSrc = previews[placement.id];
                const isPreviewing = previewing === placement.id;
                return (
                  <li
                    key={placement.id}
                    style={{
                      border: `1px solid ${isExcluded ? "var(--border, #ddd)" : "color-mix(in srgb, var(--accent, #5b8def) 30%, transparent)"}`,
                      borderRadius: 12, padding: "12px 14px",
                      opacity: isExcluded ? 0.5 : 1,
                      background: isExcluded ? "var(--surface-muted, #fafafa)" : "color-mix(in srgb, var(--accent, #5b8def) 3%, transparent)",
                      transition: "all 200ms ease",
                    }}
                  >
                    <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
                      <strong style={{ flex: 1, minWidth: 0 }}>{placement.anchorHeading ?? "文章正文"}</strong>
                      <span className="field-tag">
                        {placement.source === "existing_asset" ? "使用素材库" : "AI 生成"}
                      </span>
                    </div>
                    <small style={{ display: "block", marginTop: 4 }}>
                      {placement.selectionReason}｜alt：{placement.alt}
                    </small>

                    {/* 风格选择 + 提示词编辑 + 预览按钮 */}
                    {placement.source === "generate" && !isExcluded && (
                      <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                        <div style={{ alignItems: "center", display: "flex", gap: 6 }}>
                          <small className="muted" style={{ flexShrink: 0 }}>风格</small>
                          <ToolbarSelect
                            className="toolbar-select--fill"
                            label="风格"
                            onChange={(value) => updateStyle(placement.id, value)}
                            options={STYLE_PRESETS.map((s) => ({ id: s.id, label: s.label }))}
                            value={styleSelections[placement.id] ?? "default"}
                          />
                          <button
                            aria-label={isEditing ? "收起提示词" : "编辑提示词"}
                            className="button button--quiet"
                            disabled={busy}
                            onClick={() => togglePromptEdit(placement.id)}
                            style={{ padding: "4px 8px" }}
                            title={isEditing ? "收起提示词" : "编辑提示词"}
                            type="button"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            className="button button--quiet"
                            disabled={busy || isPreviewing}
                            onClick={() => void generatePreview(placement.id, placement.generationPrompt)}
                            style={{ alignItems: "center", display: "flex", gap: 4, padding: "4px 8px" }}
                            type="button"
                          >
                            {isPreviewing ? <LoaderCircle className="spin" size={13} /> : <Eye size={13} />}
                            {isPreviewing ? "生成中…" : "预览"}
                          </button>
                        </div>

                        {isEditing && (
                          <textarea
                            onChange={(e) => updatePrompt(placement.id, e.target.value)}
                            placeholder="输入生图提示词…"
                            rows={3}
                            style={{ fontSize: 12, lineHeight: 1.5, padding: "6px 8px", resize: "vertical", width: "100%" }}
                            value={promptEdits[placement.id] ?? placement.generationPrompt}
                          />
                        )}

                        {!isEditing && (
                          <small className="muted" style={{ cursor: "pointer", display: "-webkit-box", overflow: "hidden", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, fontSize: 11 }} onClick={() => togglePromptEdit(placement.id)}>
                            {effectivePrompt}
                          </small>
                        )}

                        {previewSrc && (
                          <img
                            alt={`预览：${placement.alt}`}
                            src={previewSrc}
                            style={{ borderRadius: 8, maxHeight: 200, objectFit: "cover", width: "100%" }}
                          />
                        )}
                      </div>
                    )}

                    <div style={{ alignItems: "center", display: "flex", gap: 8, marginTop: 8 }}>
                      <button
                        className="button button--quiet"
                        disabled={busy}
                        onClick={() => togglePlacement(placement.id)}
                        type="button"
                      >
                        {isExcluded ? "保留这张" : "不插入这张"}
                      </button>
                      {isExcluded && <small className="muted">确认应用时会跳过此位置。</small>}
                    </div>
                  </li>
                );
              })}
            </ol>
            </div>
            <footer style={{ borderTop: "1px solid var(--border, #eee)", display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14, paddingTop: 14 }}>
              <button className="button button--quiet" disabled={busy} onClick={job ? closePlan : undefined} style={{ padding: "8px 18px" }} type="button">
                取消
              </button>
              <button
                className="button button--primary"
                disabled={busy || !job}
                onClick={() => void confirmApply()}
                style={{ alignItems: "center", background: "linear-gradient(135deg, var(--accent, #5b8def), color-mix(in srgb, var(--accent, #5b8def) 70%, #9b59b6))", border: "none", display: "flex", gap: 6, padding: "8px 18px" }}
                type="button"
              >
                {busy ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
                {busy ? (job ? "生成中…" : "规划中…") : "确认并插入配图"}
              </button>
            </footer>
          </section>
        </div>
      )}
      {dismissed && (busy || job || completed || error) && (
        <button className="visual-plan-chip" onClick={resumeVisualPlan} type="button">
          {busy && <LoaderCircle className="spin" size={14} />}
          <span>
            {busy
              ? job
                ? "智能配图 · 正在生成配图…"
                : "智能配图 · 正在规划配图…"
              : job
                ? "配图方案已就绪 · 点击继续"
                : completed
                  ? `配图完成：已插入 ${completed.insertedCount} 张 · 点击查看`
                  : "配图任务失败 · 点击查看"}
          </span>
        </button>
      )}
    </VisualPlanContext.Provider>
  );
}

export function useVisualPlan() {
  return useVisualPlanContext();
}