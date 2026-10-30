import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { useActiveRun } from "../../lib/activeRunContext";

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
  assetIds?: string[];
  requiredAssetIds?: string[];
  materialMatchThreshold?: number;
  mode?: "none" | "auto" | "fixed";
  needsConfirmation?: boolean;
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
  materialMatchThreshold?: number;
  mode?: "none" | "auto" | "fixed";
  imageModelId?: string | null;
  requiredAssetIds?: string[];
  runKey?: string;
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
  observeEditor: (articleId: string, dirty: boolean) => void;
}

interface ImageModelOption { id: string; name: string; model: string }
type Decision = Pick<VisualPlanPlacement, "source" | "assetId">;
const BATCH_SIZE = 4;
const STALE_MESSAGE = "当前策略已过期：文章在规划后发生修改，请保存正文后重新生成策略。";
const VisualPlanContext = createContext<VisualPlanContextValue | null>(null);

function defaultDecisions(plan: VisualPlanSummary, threshold: number): Record<string, Decision> {
  if (plan.needsConfirmation === false) return Object.fromEntries(plan.placements.map(item => [item.id, { source: item.source, assetId: item.assetId }]));
  const used = new Set<string>();
  return Object.fromEntries(plan.placements.map((placement, index) => {
    const requiredId = plan.requiredAssetIds?.[index];
    const candidate = requiredId
      ? placement.candidates.find(item => item.assetId === requiredId)
      : placement.candidates.find(item => item.score / 10 >= threshold && !used.has(item.assetId));
    if (candidate) used.add(candidate.assetId);
    return [placement.id, { source: candidate ? "existing_asset" : "generate", assetId: candidate?.assetId ?? null }];
  }));
}
function errorMessage(error: unknown, fallback: string): string {
  const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object" && "message" in detail) return String(detail.message);
  return error instanceof Error ? error.message : fallback;
}

/** 与蓝本一致：规划不生图，确认后最多四张并行，全部准备好才提交正文。 */
export function VisualPlanProvider({ children }: { children: ReactNode }) {
  const [job, setJob] = useState<VisualPlanJob | null>(null);
  const [completed, setCompleted] = useState<CompletedVisualApply | null>(null);
  const [excludedIds, setExcludedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState("");
  const [stale, setStale] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [imageModels, setImageModels] = useState<ImageModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [targetCount, setTargetCount] = useState(2);
  const [dismissed, setDismissed] = useState(false);
  const [materialMatchThreshold, setMaterialMatchThreshold] = useState(40);
  const lock = useRef(false);
  const dirtyArticles = useRef(new Set<string>());
  // 失败重试保留成功的图片；更换正文、提示词、模型后不复用。
  const generated = useRef(new Map<string, string>());
  const automaticApproval = useRef<VisualPlanSummary | null>(null);
  const navigate = useNavigate();
  const { activeRun, runStatus } = useActiveRun();
  const plannedRun = useRef<string | null>(null);
  const observeEditor = useCallback((articleId: string, dirty: boolean) => {
    if (dirty) dirtyArticles.current.add(articleId);
    else dirtyArticles.current.delete(articleId);
    if (dirty) setStale(current => current || job?.articleId === articleId);
  }, [job?.articleId]);

  useEffect(() => {
    api.get<{ models: ImageModelOption[] }>("/settings/image-models")
      .then(res => setImageModels(res.data.models ?? []))
      .catch(() => setImageModels([]));
  }, []);

  const installPlan = (articleId: string, plan: VisualPlanSummary, snapshot: VisualPlanSnapshot | null) => {
    const threshold = plan.materialMatchThreshold ?? 40;
    const snapshotMatches = snapshot?.revisionId === plan.sourceRevisionId && snapshot?.contentHash === plan.sourceContentHash;
    setJob({ articleId, plan, snapshot: snapshotMatches ? snapshot : null });
    setDecisions(defaultDecisions(plan, threshold));
    setSelectedModel(plan.imageModelId ?? "");
    setMaterialMatchThreshold(threshold);
    setTargetCount(plan.targetCount);
    setExcludedIds([]);
    setError(null);
    setStale(dirtyArticles.current.has(articleId) || Boolean(snapshot && !snapshotMatches));
    setDismissed(false);
  };
  const setPlanForArticle = installPlan;

  const startPlan = async (articleId: string, options: StartVisualPlanOptions = {}) => {
    if (lock.current) return;
    if (dirtyArticles.current.has(articleId)) { setError("请先保存正文，再生成配图策略。"); return; }
    lock.current = true;
    setBusy(true);
    setPhase("正在规划配图，不会调用生图接口");
    setError(null);
    setDismissed(false);
    try {
      const res = await api.post<VisualPlanSummary>(`/articles/${articleId}/visual-plan`, {
        targetCount: options.targetCount ?? targetCount,
        assetIds: options.assetIds ?? [],
        materialMatchThreshold: options.materialMatchThreshold ?? materialMatchThreshold,
        mode: options.mode ?? "fixed",
        requiredAssetIds: options.requiredAssetIds ?? [],
      });
      if (options.runKey) sessionStorage.setItem(options.runKey, "1");
      if (!res.data.placements.length) { setJob(null); setError("视觉规划认为本文不需要配图。"); return; }
      installPlan(articleId, { ...res.data, imageModelId: options.imageModelId ?? null }, options.snapshot ?? null);
    } catch (err) { setError(errorMessage(err, "配图规划失败，请稍后重试。")); }
    finally { lock.current = false; setBusy(false); }
  };

  // 与蓝本 App 级编排相同：正文运行完成并落库后规划，切换页面不改变触发时机。
  useEffect(() => {
    if (!activeRun?.visualPlan?.enabled || runStatus !== "succeeded" || job || busy || lock.current) return;
    const runKey = `gaoliu.visual-applied:${activeRun.runId}`;
    if (plannedRun.current === activeRun.runId || sessionStorage.getItem(runKey)) return;
    plannedRun.current = activeRun.runId;
    const options = activeRun.visualPlan;
    void startPlan(activeRun.articleId, {
      targetCount: options.targetCount, assetIds: options.assetIds,
      imageModelId: options.imageModelId, mode: options.mode ?? "fixed",
      materialMatchThreshold: options.materialMatchThreshold ?? 40, runKey,
    });
  }, [activeRun, runStatus, job, busy]);

  const ensureCurrent = async (current: VisualPlanJob) => {
    const res = await api.get<VisualApplyResult["article"]>(`/articles/${current.articleId}`);
    if (dirtyArticles.current.has(current.articleId)
      || res.data.currentRevisionId !== current.plan.sourceRevisionId
      || res.data.contentHash !== current.plan.sourceContentHash) {
      setStale(true);
      throw new Error(STALE_MESSAGE);
    }
    return { revisionId: res.data.currentRevisionId, contentHash: res.data.contentHash, markdown: res.data.markdown };
  };

  useEffect(() => {
    if (!job || busy) return;
    let active = true;
    const check = () => {
      api.get<VisualApplyResult["article"]>(`/articles/${job.articleId}`).then(res => {
        if (active && (res.data.currentRevisionId !== job.plan.sourceRevisionId || res.data.contentHash !== job.plan.sourceContentHash)) setStale(true);
      }).catch(() => { /* 确认时再次严格校验；短暂断网不改变方案。 */ });
    };
    check();
    window.addEventListener("focus", check);
    const timer = window.setInterval(check, 5000);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", check); };
  }, [job, busy]);

  const togglePlacement = (id: string) => setExcludedIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  const replan = async (count?: number) => {
    if (!job || lock.current) return;
    await startPlan(job.articleId, {
      targetCount: count ?? (job.plan.mode === "auto" ? 0 : targetCount), assetIds: job.plan.assetIds ?? [],
      materialMatchThreshold, mode: count === undefined ? job.plan.mode ?? "fixed" : "fixed",
      imageModelId: selectedModel || null, requiredAssetIds: job.plan.requiredAssetIds ?? [],
    });
  };
  const closePlan = () => {
    if (lock.current) return;
    setJob(null); setExcludedIds([]); setError(null); setDismissed(false); generated.current.clear();
  };
  const minimizePlan = () => setDismissed(true);
  const resumeVisualPlan = () => { if (!job && completed) navigate("/articles"); setDismissed(false); };

  const confirmApply = async () => {
    const current = job;
    if (!current || lock.current || stale) return;
    const placements = current.plan.placements.filter(item => !excludedIds.includes(item.id)).map(item => ({ ...item, ...decisions[item.id] }));
    if (!placements.length) { setError("请至少保留一张配图，或选择暂不配图。"); return; }
    lock.current = true;
    setBusy(true); setError(null); setPhase("正在校验正文与配图位置");
    try {
      const snapshot = await ensureCurrent(current);
      const binding = { baseRevisionId: current.plan.sourceRevisionId, baseContentHash: current.plan.sourceContentHash };
      // 先验证所有锚点及素材权限，避免失效方案触发生图。
      await api.post(`/articles/${current.articleId}/visual-validate`, { ...binding, placements });
      let finished = 0;
      const resolved: VisualPlanPlacement[] = [];
      for (let offset = 0; offset < placements.length; offset += BATCH_SIZE) {
        await ensureCurrent(current);
        const batch = placements.slice(offset, offset + BATCH_SIZE);
        // 等待本批所有请求结束后再允许重试，避免失败时仍在后台重复生图。
        const results = await Promise.allSettled(batch.map(async placement => {
          let assetId = placement.assetId;
          if (placement.source === "generate") {
            const key = JSON.stringify([current.articleId, ...Object.values(binding), placement.id, placement.generationPrompt, selectedModel]);
            assetId = generated.current.get(key) ?? null;
            if (!assetId) {
              const res = await api.post<{ id: string }>("/media/generate", {
                prompt: placement.generationPrompt, size: "1536x1024", imageModelId: selectedModel || null,
              });
              if (!res.data.id) throw new Error("生图接口未返回可保存的图片。");
              assetId = res.data.id;
              generated.current.set(key, assetId);
            }
          }
          finished += 1;
          setPhase(`已准备 ${finished}/${placements.length} 张配图 · 每批最多 ${BATCH_SIZE} 张并行`);
          return { ...placement, source: "existing_asset" as const, assetId };
        }));
        const failed = results.find(result => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        for (const result of results) if (result.status === "fulfilled") resolved.push(result.value);
        await ensureCurrent(current);
      }
      setPhase("配图已全部准备好，正在保存正文新版本");
      const res = await api.post<VisualApplyResult>(`/articles/${current.articleId}/visual-apply`, { ...binding, placements: resolved });
      if (res.data.insertedCount !== placements.length) throw new Error(res.data.skipped[0]?.reason || "配图未全部插入，请重新生成策略。");
      setCompleted({ articleId: current.articleId, article: res.data.article, snapshot, insertedCount: res.data.insertedCount, skipped: res.data.skipped });
      setJob(null); setExcludedIds([]); generated.current.clear();
    } catch (err) {
      if ((err as { response?: { status?: number } }).response?.status === 409) { setStale(true); setError(STALE_MESSAGE); }
      else setError(errorMessage(err, "配图生成失败；正文未修改，成功生成的图片保留用于重试。"));
    } finally { lock.current = false; setBusy(false); }
  };

  useEffect(() => {
    if (job?.plan.needsConfirmation === false && !busy && !stale && automaticApproval.current !== job.plan) {
      automaticApproval.current = job.plan;
      void confirmApply();
    }
  }, [job, busy, stale]);

  const activePlacements = job?.plan.placements.filter(item => !excludedIds.includes(item.id)) ?? [];
  const generatedCount = activePlacements.filter(item => decisions[item.id]?.source === "generate").length;
  return (
    <VisualPlanContext.Provider value={{ busy, error, job, completed, excludedIds, startPlan, setPlanForArticle, togglePlacement, closePlan, minimizePlan, confirmApply, consumeCompleted: () => setCompleted(null), observeEditor }}>
      {children}
      {(job || busy || error) && !dismissed && (
        <div className="studio-modal" role="presentation">
          <div className="studio-modal__scrim" />
          <section aria-label="确认配图方案" aria-modal="true" className="creation-picker__dialog visual-plan-dialog" role="dialog" style={{ maxWidth: 600, width: "min(600px, 100%)" }}>
            <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div><span className="page-kicker">正文配图方案</span><h2>确认后再开始生成</h2></div>
              <button aria-label="配图任务转后台" className="icon-button" onClick={minimizePlan} type="button">✕</button>
            </header>
            <div className="visual-plan-dialog__body">
              {busy && <p role="status"><LoaderCircle className="spin" size={16} /> {phase}</p>}
              {error && <div className="workflow-task__failure" role="alert"><p>{error}</p></div>}
              {stale && <div className="workflow-task__failure" role="status"><strong>当前策略已过期</strong><p>请保存当前正文后重新生成策略，旧方案不能直接插入。</p></div>}
              <p className="muted">系统按 {materialMatchThreshold}% 匹配阈值给出默认方案，每张图都可以改用已选素材或 AI 生图。确认前不会生成图片。</p>
              <div className="visual-plan-settings">
                <label>生图模型 <select aria-label="生图模型" disabled={busy} onChange={event => setSelectedModel(event.target.value)} value={selectedModel}>
                  <option value="">跟随设置中的生图模型</option>
                  {imageModels.map(model => <option key={model.id} value={model.id}>{model.name} · {model.model}</option>)}
                </select></label>
                <label>配图数量 <select aria-label="配图数量" disabled={busy} value={targetCount} onChange={event => void replan(Number(event.target.value))}>
                  {[1, 2, 3, 4, 5, 6].map(count => <option key={count} value={count}>{count}</option>)}
                </select></label>
                <label className="creation-threshold">素材匹配阈值 <strong>{materialMatchThreshold}%</strong>
                  <input aria-label="素材匹配阈值" type="range" min={0} max={100} step={5} disabled={busy} value={materialMatchThreshold} onChange={event => {
                    const value = Number(event.target.value); setMaterialMatchThreshold(value);
                    if (job) setDecisions(defaultDecisions(job.plan, value));
                  }} />
                </label>
                <small>sketch-notes · 马卡龙配色 · 并发 4 · 预计生图 {generatedCount} 张 · 复用素材 {activePlacements.length - generatedCount} 张</small>
              </div>
              <ol className="visual-plan-placements">
                {job?.plan.placements.map((placement, index) => {
                  const decision = decisions[placement.id];
                  const excluded = excludedIds.includes(placement.id);
                  const candidate = placement.candidates.find(item => item.assetId === decision?.assetId);
                  return <li key={placement.id} style={{ opacity: excluded ? 0.5 : 1 }}>
                    <strong>配图 {index + 1} · {placement.anchorHeading ?? "文章正文"}</strong>
                    <p>{placement.selectionReason}</p><blockquote>{placement.anchorExcerpt}</blockquote>
                    <div role="radiogroup" aria-label={`配图 ${index + 1} 来源`}>
                      <label><input type="radio" name={`visual-source-${placement.id}`} checked={decision?.source === "existing_asset"} disabled={busy || !placement.candidates.length} onChange={() => setDecisions(current => ({ ...current, [placement.id]: { source: "existing_asset", assetId: placement.candidates[0]?.assetId ?? null } }))} />使用素材</label>
                      <label><input type="radio" name={`visual-source-${placement.id}`} checked={decision?.source !== "existing_asset"} disabled={busy} onChange={() => setDecisions(current => ({ ...current, [placement.id]: { source: "generate", assetId: null } }))} />AI 生图</label>
                    </div>
                    {decision?.source === "existing_asset" && <div>
                      <select aria-label={`配图 ${index + 1} 素材`} disabled={busy} value={decision.assetId ?? ""} onChange={event => setDecisions(current => ({ ...current, [placement.id]: { source: "existing_asset", assetId: event.target.value } }))}>
                        {placement.candidates.map(item => <option key={item.assetId} value={item.assetId}>{item.description || item.assetId} · {Math.round(item.score / 10)}%</option>)}
                      </select>
                      <img alt={placement.alt} src={`/api/media/${encodeURIComponent(decision.assetId ?? "")}/raw`} />
                      {candidate && <small>{Math.round(candidate.score / 10)}% 匹配 · {candidate.description}</small>}
                    </div>}
                    {decision?.source === "generate" && <small className="muted">确认后生成这张正文配图，尺寸 1536 × 1024。</small>}
                    <button className="button button--quiet" type="button" disabled={busy} onClick={() => togglePlacement(placement.id)}>{excluded ? "保留这张" : "不插入这张"}</button>
                  </li>;
                })}
              </ol>
            </div>
            <footer className="visual-plan-footer">
              <button className="button button--quiet" disabled={busy} onClick={closePlan} type="button">暂不配图</button>
              <button className="button button--quiet" disabled={busy || !job} onClick={() => void replan()} type="button">重新生成策略</button>
              <button className="button button--primary" disabled={busy || !job || stale} onClick={() => void confirmApply()} type="button">{busy ? "处理中…" : "确认并继续"}</button>
            </footer>
          </section>
        </div>
      )}
      {dismissed && (busy || job || completed || error) && <button className="visual-plan-chip" onClick={resumeVisualPlan} type="button">
        {busy && <LoaderCircle className="spin" size={14} />}<span>{busy ? phase : job ? "配图方案已就绪 · 点击继续" : completed ? `配图完成：已插入 ${completed.insertedCount} 张 · 点击查看` : "配图任务失败 · 点击查看"}</span>
      </button>}
    </VisualPlanContext.Provider>
  );
}

export function useVisualPlan() {
  const value = useContext(VisualPlanContext);
  if (!value) throw new Error("useVisualPlan must be used within VisualPlanProvider");
  return value;
}
