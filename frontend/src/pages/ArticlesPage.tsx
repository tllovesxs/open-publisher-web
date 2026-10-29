import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Eye, FileText, FileUp, GripVertical, History, ImagePlus, LoaderCircle, Pencil, Plus, Save, Search, Sparkles, Undo2, Upload, XCircle } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useActiveRun } from "../lib/activeRunContext";
import { usePersistentState } from "../lib/usePersistentState";
import { api } from "../api/client";
import { ToolbarSelect } from "../components/ui/ToolbarSelect";
import { bridge } from "../lib/bridge";
import {
  AssistantDrawer,
  AiModifyPane,
  RevisionHistoryDrawer,
} from "../components/article/ArticleTools";
import { SyncPublishDialog } from "../components/article/SyncPublishDialog";
import { PublishNoticeDialog, publishNoticeMutedToday } from "../components/article/PublishNoticeDialog";
import { MarkdownWorkbench, type ImageInsertion, type MarkdownSelection, type PreviewPlatform } from "../components/article/MarkdownWorkbench";
import { ArticleImagePane, type ArticleFigure } from "../components/article/ArticleImagePane";
import { useVisualPlan, type VisualPlanSummary } from "../components/article/VisualPlanProvider";
import ArticleRunTimeline from "../components/ArticleRunTimeline";
import { articleNodeLabel } from "../workflow/articleNodes";
import { insertMarkdownAtLine, moveMarkdownSpanToLine, removeMarkdownSpan } from "../components/article/articleMarkdown";

// 文章库：蓝本 ArticlesPage 的 Web 版核心闭环（团队自有代码）。
// 本轮实现：列表 + 创作 run（SSE）+ 查看/编辑保存新版本；
// MarkdownWorkbench / SyncPublishDialog / Assistant 完整迁移见路线图。

interface ArticleState {
  articleId: string;
  title: string;
  currentRevisionId: string | null;
  contentHash: string | null;
  markdown: string;
  updatedAt: string | null;
}

interface RunEventItem {
  sequence?: number;
  type: string;
  payload?: Record<string, unknown>;
}

// 智能配图的任务状态与类型由全局 VisualPlanProvider 统一持有。

// 创作事件（RunJournal）的可读文案与状态图标
const JOURNAL_LABELS: Record<string, string> = {
  "run.started": "任务开始",
  "run.completed": "任务完成",
  "run.failed": "任务失败",
  "run.stopped": "任务已停止",
  "agent.message_delta": "正在撰写正文……",
  "article.checkpointed": "正文初稿已生成（不可变版本）",
  "revision.committed": "文章已保存新版本",

  "rewrite.candidate_ready": "改写候选已生成",
};

function journalEventState(type: string): "running" | "complete" | "failed" {
  if (type === "run.failed") return "failed";
  if (type === "run.completed" || type === "revision.committed") return "complete";
  return "running";
}

function journalEventMessage(type: string, payload?: Record<string, unknown>): string {
  const message = payload?.message ?? payload?.stage ?? payload?.reason;
  if (type === "node.started" || type === "node.completed") {
    const verb = type === "node.started" ? "开始" : "完成";
    return `${verb}：${articleNodeLabel(payload?.nodeId as string | undefined)}`;
  }
  return JOURNAL_LABELS[type] ?? (typeof message === "string" ? message : type);
}

const LENGTH_OPTIONS = [
  { id: "short", label: "短篇（1500-2000 字）" },
  { id: "medium", label: "中篇（3000-4000 字）" },
  { id: "long", label: "长篇（5500-7000 字）" },
  { id: "custom", label: "自定义篇幅" },
];

export default function ArticlesPage() {
  const navigate = useNavigate();
  const [articles, setArticles] = useState<ArticleState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ArticleState | null>(null);
  const [creating, setCreating] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [tone, setTone] = useState("");
  const [lengthPreset, setLengthPreset] = useState("medium");
  const [customLength, setCustomLength] = useState("");
  const [humanize, setHumanize] = useState(false);
  const {
    activeRun,
    completedNodeIds,
    runEvents,
    runStatus,
    startRun: startActiveRun,
    stopRun,
  } = useActiveRun();
  // 只让本次发起创作时跟随的文章页展示运行进度；切换其他文章时不劫持编辑器。
  const [followedRunArticleId, setFollowedRunArticleId] = useState<string | null>(null);
  // AI 修改栏默认收起，点工具栏「AI 修改」按需展开（展开时自动滚入视野）。
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  // 可拖拽面板宽度（本地持久化）：文章列表 / AI 修改栏 / 配图栏。
  const [browserWidth, setBrowserWidth] = usePersistentState("opw.article-browser-width", 248);
  const [aiPaneWidth, setAiPaneWidth] = usePersistentState("opw.ai-pane-width", 318);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [viewMode, setViewMode] = useState<"edit" | "split" | "preview">("split"); // 文章页默认「编辑与预览」
  const [previewPlatform, setPreviewPlatform] = useState<PreviewPlatform>("general");
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncNoticeOpen, setSyncNoticeOpen] = useState(false);
  // AI 侧边栏双 Tab：AI 修改 / 配图中心（配图并入侧边栏，不再独立成栏）。
  const [aiPaneTab, setAiPaneTab] = useState<"assistant" | "figures">("assistant");
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [rewriteSelection, setRewriteSelection] = useState<MarkdownSelection | null>(null);
  const [lastAiSnapshot, setLastAiSnapshot] = useState<{
    label: string;
    markdown: string;
    currentRevisionId: string | null;
    contentHash: string | null;
  } | null>(null);
  const [referenceNote, setReferenceNote] = useState<string | null>(null);
  const [visualResultNote, setVisualResultNote] = useState<string | null>(null);
  const [referenceNames, setReferenceNames] = useState<string[]>([]);
  const [referenceDrag, setReferenceDrag] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    busy: visualBusy,
    completed: completedVisualApply,
    startPlan: startVisualPlanJob,
    setPlanForArticle: setVisualPlanForArticle,
    consumeCompleted: consumeCompletedVisualApply,
  } = useVisualPlan();
  const userEditedRef = useRef(false);
  const finalDraftRef = useRef<string | null>(null);
  // F-007 受控打字机：SSE 增量进队列，requestAnimationFrame 逐字渲染，
  // 手动编辑（userEditedRef）立即清空队列，AI 不会覆盖用户输入。
  const typewriterRef = useRef<{ queue: string; frame: number | null }>({ queue: "", frame: null });
  const cancelTypewriter = () => {
    const state = typewriterRef.current;
    if (state.frame !== null) window.cancelAnimationFrame(state.frame);
    state.queue = "";
    state.frame = null;
  };
  const flushTypewriter = () => {
    const state = typewriterRef.current;
    if (state.queue && !userEditedRef.current) {
      const rest = state.queue;
      state.queue = "";
      setDraft((current) => current + rest);
    } else {
      state.queue = "";
    }
    cancelTypewriter();
  };
  // 卸载时只取消打字机帧；全局 run 监听会跨路由保留 SSE 进度。
  useEffect(() => () => {
    cancelTypewriter();
  }, []);
  const enqueueTypewriter = (delta: string) => {
    if (!delta) return;
    const state = typewriterRef.current;
    state.queue += delta;
    if (state.frame !== null) return;
    const drain = () => {
      const s = typewriterRef.current;
      if (userEditedRef.current) {
        cancelTypewriter();
        return;
      }
      const count = Math.max(1, Math.min(12, Math.ceil(s.queue.length / 120)));
      const characters = Array.from(s.queue);
      const chunk = characters.slice(0, count).join("");
      s.queue = characters.slice(count).join("");
      if (chunk) setDraft((current) => current + chunk);
      if (s.queue.length > 0) {
        s.frame = window.requestAnimationFrame(drain);
      } else {
        s.frame = null;
        if (finalDraftRef.current !== null && !userEditedRef.current) {
          setDraft(finalDraftRef.current);
          finalDraftRef.current = null;
        }
      }
    };
    state.frame = window.requestAnimationFrame(drain);
  };

  // 全局 run 事件到来时，只处理本页未见过的新增量；页面重挂载时跳过历史增量，
  // 再由文章状态恢复已写入的正文，避免重复拼接。
  const activeRunForSelected = activeRun
    && followedRunArticleId === activeRun.articleId
    && selected?.articleId === activeRun.articleId
    ? activeRun
    : null;
  const events: RunEventItem[] = activeRunForSelected ? runEvents : [];
  const completedNodes = activeRunForSelected ? completedNodeIds : new Set<string>();
  const running = Boolean(activeRunForSelected && runStatus === "running");

  const followedRunIdRef = useRef<string | null>(null);
  const lastRunEventSequenceRef = useRef(0);
  useEffect(() => {
    cancelTypewriter();
    finalDraftRef.current = null;
    const hasRunContent = activeRun?.articleId === selected?.articleId
      && runEvents.some((event) => event.type === "article.content_reset");
    setDraft(hasRunContent ? "" : selected?.markdown ?? "");
    userEditedRef.current = false;
    followedRunIdRef.current = null;
  }, [selected?.articleId]);
  useEffect(() => {
    const currentRunId = activeRunForSelected?.runId ?? null;
    if (!currentRunId) {
      followedRunIdRef.current = null;
      lastRunEventSequenceRef.current = 0;
      return;
    }
    if (followedRunIdRef.current !== currentRunId) {
      followedRunIdRef.current = currentRunId;
      lastRunEventSequenceRef.current = 0;
    }
    for (const event of events) {
      if ((event.sequence ?? 0) <= lastRunEventSequenceRef.current) continue;
      lastRunEventSequenceRef.current = event.sequence ?? lastRunEventSequenceRef.current;
      if (event.type === "article.content_reset" && !userEditedRef.current) {
        cancelTypewriter();
        setDraft("");
      }
      if (
        event.type === "agent.message_delta"
        && (event.payload as { stage?: string; delta?: string } | undefined)?.stage === "content"
      ) {
        const delta = (event.payload as { delta?: string }).delta ?? "";
        if (delta && !userEditedRef.current) enqueueTypewriter(delta);
      }
      if (event.type === "run.failed") {
        flushTypewriter();
        setError(`创作失败：${String((event.payload as { message?: string } | undefined)?.message ?? "未知错误")}`);
      }
      if (event.type === "run.stopped") {
        flushTypewriter();
      }
    }
  }, [activeRunForSelected, events]);

  // 模板参数：从模板库跳转过来时，把模板骨架注入创作要求
  useEffect(() => {
    const templateId = searchParams.get("template");
    if (!templateId) return;
    api
      .get<{ templates: Array<{ id: string; name: string; markdown: string; usageInstructions: string }> }>("/templates")
      .then((res) => {
        const t = res.data.templates.find((item) => item.id === templateId);
        if (t) {
          setPrompt((current) =>
            current
              ? current
              : `请按「${t.name}」模板的结构创作：\n\n${t.markdown}\n\n${t.usageInstructions}`,
          );
          setCreating(true);
          setSelected(null);
        }
      })
      .catch(() => undefined);
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  const loadArticles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ articles: ArticleState[] }>("/articles");
      setArticles(res.data.articles);
    } catch {
      setError("无法加载文章列表，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadArticles();
  }, [loadArticles]);

  // 直接进入文章页时，也恢复上一个路由发起的运行，避免必须依赖 ?open 深链。
  useEffect(() => {
    if (!activeRun || followedRunArticleId || selected) return;
    setFollowedRunArticleId(activeRun.articleId);
  }, [activeRun, followedRunArticleId, selected]);

  // ?new=1：顶栏「新文章」入口直接打开新建创作面板
  useEffect(() => {
    if (searchParams.get("new") === "1") {
      setSelected(null);
      setCreating(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // ?open=<articleId>：深链直接选中文章（同步发布/助手等入口的回跳能力）
  useEffect(() => {
    const openId = searchParams.get("open");
    if (!openId) return;
    if (activeRun?.articleId === openId) setFollowedRunArticleId(openId);
    api
      .get<ArticleState>(`/articles/${openId}`)
      .then((res) => {
        setSelected(res.data);
        setCreating(false);
      })
      .catch(() => undefined);
    setSearchParams({}, { replace: true });
  }, [activeRun, searchParams, setSearchParams]);

  // 导航离开后重新回到文章页时，从全局 run 监听恢复文章和当前进度。
  useEffect(() => {
    if (!activeRun || activeRun.articleId !== followedRunArticleId) return;
    let cancelled = false;
    const articleId = activeRun.articleId;
    void bridge.getArticle(articleId)
      .then((article) => {
        if (cancelled) return;
        setSelected(article);
        setCreating(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSelected((current) => current ?? {
          articleId,
          title: activeRun.title,
          currentRevisionId: null,
          contentHash: null,
          markdown: "",
          updatedAt: null,
        });
        setCreating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRun, followedRunArticleId]);

  // 全局监听收到完成事件后，这里负责把最终文章刷新进编辑器。
  // 创作页选择的配图参数随全局 run 传过来，避免离开创作页后丢失自动配图步骤。
  useEffect(() => {
    if (runStatus !== "succeeded" || !activeRun || activeRun.articleId !== followedRunArticleId) return;
    const visualPlan = activeRun.visualPlan;
    const visualKey = `gaoliu.visual-applied:${activeRun.runId}`;
    void (async () => {
      let pendingVisualPlan: VisualPlanSummary | null = null;
      let refreshedArticle: ArticleState | null = null;
      if (visualPlan?.enabled && !sessionStorage.getItem(visualKey)) {
        sessionStorage.setItem(visualKey, "1");
        try {
          const plan = await api.post<VisualPlanSummary>(
            `/articles/${activeRun.articleId}/visual-plan`,
            { targetCount: visualPlan.targetCount, assetIds: visualPlan.assetIds },
          );
          if (plan.data.placements.length > 0) {
            pendingVisualPlan = { ...plan.data, imageModelId: visualPlan.imageModelId };
          }
        } catch {
          setError("自动配图规划失败；正文已正常保存。");
        }
      }
      try {
        const [article] = await Promise.all([
          bridge.getArticle(activeRun.articleId),
          loadArticles(),
        ]);
        refreshedArticle = article;
        setSelected(article);
        if (!userEditedRef.current) {
          if (typewriterRef.current.queue) finalDraftRef.current = article.markdown;
          else setDraft(article.markdown);
        }
      } catch {
        void loadArticles();
      }
      // 文章已加载进编辑器后，弹出确认框让用户审核方案再真正生图。
      if (pendingVisualPlan && refreshedArticle) {
        setVisualPlanForArticle(
          activeRun.articleId,
          pendingVisualPlan,
          {
            revisionId: refreshedArticle.currentRevisionId,
            contentHash: refreshedArticle.contentHash,
            markdown: refreshedArticle.markdown,
          },
        );
      }
    })();
  }, [activeRun, followedRunArticleId, loadArticles, runStatus]);

  // 全局配图任务完成后，回到文章页时仍能刷新正文并保留撤销快照。
  useEffect(() => {
    if (!completedVisualApply) return;
    let cancelled = false;
    void (async () => {
      try {
        if (selected?.articleId !== completedVisualApply.articleId) {
          const fresh = await api.get<ArticleState>(`/articles/${completedVisualApply.articleId}`);
          if (cancelled) return;
          setSelected(fresh.data);
        }
        if (cancelled) return;
        setSelected(completedVisualApply.article);
        if (!userEditedRef.current) setDraft(completedVisualApply.article.markdown);
        setVisualResultNote(
          completedVisualApply.skipped.length
            ? `已插入 ${completedVisualApply.insertedCount} 张配图；${completedVisualApply.skipped.length} 张未插入：${completedVisualApply.skipped.map((item) => item.reason).join("；")}`
            : `已插入 ${completedVisualApply.insertedCount} 张配图。`,
        );
        setLastAiSnapshot({
          label: "智能配图",
          markdown: completedVisualApply.snapshot.markdown,
          currentRevisionId: completedVisualApply.snapshot.revisionId,
          contentHash: completedVisualApply.snapshot.contentHash,
        });
        consumeCompletedVisualApply();
        void loadArticles();
      } catch {
        if (!cancelled) setError("配图完成，但刷新文章失败；请重新进入文章页。");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [completedVisualApply, consumeCompletedVisualApply, loadArticles, selected?.articleId]);

  const runPlaceholder: ArticleState | null = activeRun && !articles.some((article) => article.articleId === activeRun.articleId)
    ? { articleId: activeRun.articleId, title: activeRun.title, currentRevisionId: null, contentHash: null, markdown: "", updatedAt: null }
    : null;
  const filtered = (runPlaceholder ? [runPlaceholder, ...articles] : articles).filter(
    (a) =>
      !query.trim() ||
      a.title.toLowerCase().includes(query.trim().toLowerCase()),
  );


  // 蓝本 onImageFileDrop 的 Web 等价：读为 data URL 上传素材库，返回站内引用
  const uploadImageFile = async (file: File): Promise<ImageInsertion> => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("读取图片文件失败。"));
      reader.readAsDataURL(file);
    });
    const res = await api.post<{ id: string; name: string }>("/media", {
      name: file.name,
      mime: file.type || "image/png",
      dataUrl,
      alt: file.name.replace(/\.[^.]+$/, ""),
    });
    return { alt: file.name.replace(/\.[^.]+$/, ""), src: `/api/media/${res.data.id}/raw` };
  };

  // 蓝本 CreatePage 资料文件夹导入的 Web 等价：选文本资料（.md/.txt），并入创作要求
  const importReferenceFiles = async (fileList: FileList | null) => {
    if (!fileList || !fileList.length) return;
    // 必须先快照：onChange 启动导入后会清空 input.value，活 FileList 会被浏览器置空
    const files = Array.from(fileList);
    const texts = await Promise.all(
      files.map(async (file) => {
        const text = await file.text();
        return `## 参考资料：${file.name}\n\n${text.trim()}`;
      }),
    );
    const names = files.map((file) => file.name);
    setPrompt((current) =>
      `${current ? `${current}\n\n` : ""}${texts.join("\n\n")}`.slice(0, 60000),
    );
    setReferenceNames(names);
    setReferenceNote(`已并入 ${files.length} 个资料文件（事实只来自这些资料）。`);
  };

  const startRun = async () => {
    if (!prompt.trim()) {
      setError("请先填写创作要求。");
      return;
    }
    setError(null);
    setCreating(false);
    const articleId = `article-${Date.now()}`;
    try {
      await startActiveRun({
        articleId,
        prompt: prompt.trim(),
        tone: tone || null,
        lengthPreset,
        customLength: lengthPreset === "custom" ? customLength : null,
        humanize,
      }, prompt.trim().slice(0, 80));
      setFollowedRunArticleId(articleId);
      // 蓝本交互：发起后立即迁移到文章工作区，由全局 run 监听继续驱动编辑器。
      try {
        const article = await bridge.getArticle(articleId);
        setSelected(article);
      } catch {
        setSelected({
          articleId,
          title: prompt.slice(0, 80),
          currentRevisionId: null,
          contentHash: null,
          markdown: "",
          updatedAt: null,
        });
      }
      setCreating(false);
    } catch {
      setError("启动创作运行失败，请稍后重试。");
    }
  };

  // 智能配图：规划与应用都交给全局 Provider，防止页面切换丢失生图进度。
  const startVisualPlan = async () => {
    if (!selected || visualBusy) return;
    setError(null);
    setVisualResultNote(null);
    await startVisualPlanJob(selected.articleId, {
      targetCount: 2,
      assetIds: [],
      snapshot: {
        revisionId: selected.currentRevisionId,
        contentHash: selected.contentHash,
        markdown: selected.markdown,
      },
    });
  };

  const saveVersion = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await api.post("/articles", {
        articleId: selected.articleId,
        baseRevisionId: selected.currentRevisionId,
        baseContentHash: selected.contentHash,
        title: selected.title,
        markdown: draft,
        reason: "web 编辑",
      });
      await loadArticles();
      const fresh = await api.get<ArticleState>(`/articles/${selected.articleId}`);
      setSelected(fresh.data);
    } catch {
      setError("保存失败：文章可能已被其他操作修改，请刷新后重试。");
    } finally {
      setSaving(false);
    }
  };

  const runFailed = events.some((event) => event.type === "run.failed");


  const undoLastAiChange = async () => {
    if (!selected || !lastAiSnapshot) return;
    if (
      lastAiSnapshot.currentRevisionId === selected.currentRevisionId
      && lastAiSnapshot.contentHash === selected.contentHash
    ) {
      // 本地 AI 改写还未提交新版本，直接回滚编辑器草稿即可。
      setDraft(lastAiSnapshot.markdown);
      setLastAiSnapshot(null);
      return;
    }
    try {
      await api.post("/articles", {
        articleId: selected.articleId,
        baseRevisionId: selected.currentRevisionId,
        baseContentHash: selected.contentHash,
        title: selected.title,
        markdown: lastAiSnapshot.markdown,
        reason: `undo ${lastAiSnapshot.label}`,
      });
      await loadArticles();
      const fresh = await api.get<ArticleState>(`/articles/${selected.articleId}`);
      setSelected(fresh.data);
      setLastAiSnapshot(null);
    } catch {
      setError("撤销失败：文章可能已被修改，请刷新后重试。");
    }
  };

  const dirty = selected !== null && draft !== selected.markdown;

  // 统一的正文写入入口：工作台编辑、配图栏与素材库插入都走这里，确保打断运行逻辑一致。
  const handleMarkdownChange = (markdown: string) => {
    userEditedRef.current = true;
    finalDraftRef.current = null;
    cancelTypewriter();
    if (running) void stopRun();
    setDraft(markdown);
  };
  // 通用竖向分隔条拖拽：按住后水平拖动调整面板宽度，宽度持久化到 localStorage。
  const beginWidthDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    startWidth: number,
    onResize: (start: number, deltaX: number) => void,
  ) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    document.body.classList.add("is-pane-dragging");
    const onMove = (moveEvent: PointerEvent) => {
      onResize(startWidth, moveEvent.clientX - startX);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      document.body.classList.remove("is-pane-dragging");
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp, { once: true });
    handle.addEventListener("pointercancel", onUp, { once: true });
  };
  const clampWidth = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const aiPaneRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  // 展开 AI 修改栏时确保它滚入视野（窄窗口下面板可能被折叠或滚动出视野）。
  useEffect(() => {
    if (aiPanelOpen) aiPaneRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [aiPanelOpen]);

  const layoutStyle = { "--article-browser-width": `${browserWidth}px` } as CSSProperties;

  return (
    <section className="articles-layout" style={layoutStyle}>
      <aside aria-label="文章列表" className="article-browser">
        <div className="article-browser__head">
          <div>
            <span className="page-kicker">文章库</span>
            <strong>文章</strong>
          </div>
          <button
            aria-label="新建文章"
            className="icon-button"
            onClick={() => {
              setCreating(true);
              setError(null);
              setSelected(null);
            }}
            title="新建文章"
            type="button"
          >
            <Plus size={16} />
          </button>
        </div>
        <label className="article-search">
          <Search aria-hidden="true" size={14} />
          <span className="visually-hidden">搜索文章</span>
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索文章"
            value={query}
          />
        </label>
        <div className="article-list">
          {filtered.map((article) => (
            <button
              aria-current={selected?.articleId === article.articleId ? "true" : undefined}
              className={`article-list-item${selected?.articleId === article.articleId ? " is-active" : ""}`}
              key={article.articleId}
              onClick={() => {
                setSelected(article);
                setCreating(false);
              }}
              type="button"
            >
              <span className="article-status article-status--draft">{article.articleId === activeRun?.articleId ? runStatus === "running" ? <><LoaderCircle className="spin" size={11} /> 生成中</> : runStatus === "failed" ? "生成失败" : runStatus === "stopped" ? "已停止" : "文章" : "文章"}</span>
              <strong>{article.title}</strong>
              <span className="article-list-item__meta">
                <span>
                  {article.updatedAt
                    ? new Date(article.updatedAt).toLocaleDateString()
                    : ""}
                </span>
              </span>
            </button>
          ))}
          {filtered.length === 0 && !loading && (
            <p className="article-list__empty">还没有文章，点右上角 + 新建</p>
          )}
        </div>
      </aside>

      <div
        aria-hidden="true"
        className="article-browser__resizer"
        onPointerDown={(event) =>
          beginWidthDrag(event, browserWidth, (start, dx) =>
            setBrowserWidth(clampWidth(start + dx, 200, 480)))}
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
                <span className="page-kicker">新建文章</span>
                <strong>创作要求</strong>
              </>
            ) : selected ? (
              <>
                <span className="article-status article-status--draft">文章</span>
                <strong>{selected.title}</strong>
              </>
            ) : (
              <strong>选择一篇文章</strong>
            )}
          </div>
          <div className="article-editor__actions">
            {selected && !creating && (
              <>
                <button
                  className="button button--quiet"
                  onClick={() => setAssistantOpen((v) => !v)}
                  type="button"
                >
                  <Sparkles size={15} />
                  助手
                </button>
                <button
                  className="button button--quiet"
                  aria-expanded={aiPanelOpen && aiPaneTab === "assistant"}
                  onClick={() => {
                    if (aiPanelOpen && aiPaneTab === "assistant") {
                      setAiPanelOpen(false);
                    } else {
                      setAiPanelOpen(true);
                      setAiPaneTab("assistant");
                    }
                  }}
                  type="button"
                >
                  <Pencil size={15} />
                  AI 修改
                </button>
                <button
                  className="button button--quiet"
                  disabled={!selected.currentRevisionId}
                  onClick={() => {
                    if (publishNoticeMutedToday()) {
                      setSyncOpen(true);
                    } else {
                      setSyncNoticeOpen(true);
                    }
                  }}
                  title="通过文章同步发布扩展，把全屏纯净稿同步为多平台草稿"
                  type="button"
                >
                  <Upload size={15} />
                  同步发布
                </button>
                <button
                  className="button button--quiet"
                  onClick={() =>
                    setViewMode((m) => (m === "edit" ? "split" : m === "split" ? "preview" : "edit"))
                  }
                  type="button"
                >
                  {viewMode === "edit" ? <Eye size={15} /> : <Pencil size={15} />}
                  {viewMode === "edit" ? "分栏" : viewMode === "split" ? "预览" : "编辑"}
                </button>
                <button
                  className="button button--quiet"
                  aria-expanded={aiPanelOpen && aiPaneTab === "figures"}
                  onClick={() => {
                    if (aiPanelOpen && aiPaneTab === "figures") {
                      setAiPanelOpen(false);
                    } else {
                      setAiPanelOpen(true);
                      setAiPaneTab("figures");
                    }
                  }}
                  type="button"
                >
                  <ImagePlus size={15} />
                  配图
                </button>
                <button
                  className="button button--quiet"
                  disabled={visualBusy}
                  onClick={() => void startVisualPlan()}
                  type="button"
                >
                  <Sparkles size={15} />
                  {visualBusy ? "配图中" : "智能配图"}
                </button>
                <button
                  className="button button--quiet"
                  disabled={!lastAiSnapshot}
                  onClick={() => void undoLastAiChange()}
                  type="button"
                >
                  <Undo2 size={15} />
                  撤销 AI 修改
                </button>
                <button
                  className="button button--quiet"
                  onClick={() => setHistoryOpen(true)}
                  type="button"
                >
                  <History size={15} />
                  历史
                </button>
                <button
                  aria-label="保存新版本"
                  className="button button--primary"
                  disabled={saving || !dirty}
                  onClick={() => void saveVersion()}
                  type="button"
                >
                  {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
                  {saving ? "保存中" : dirty ? "保存新版本" : selected.currentRevisionId ? "已保存" : "尚未保存"}
                </button>
              </>
            )}
          </div>
        </header>

        <div className="article-editor__body" style={{ overflowY: "auto", padding: "20px 24px" }}>
          {error && (
            <div className="workflow-task__failure" role="alert" style={{ marginBottom: 14 }}>
              <p>{error}</p>
            </div>
          )}
          {creating && (
            <div style={{ display: "grid", gap: 14, maxWidth: 720 }}>
              <div className="field">
                <div className="field__head">
                  <label htmlFor="a-prompt">创作要求</label>
                  <span className="field-tag field-tag--required">必填</span>
                </div>
                <small>写什么、给谁看、重点是什么。事实只来自这里，AI 不会编造。</small>
                <textarea
                  id="a-prompt"
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="例如：为我们的开源项目写一篇产品推广文章，目标读者是独立开发者……"
                  rows={6}
                  value={prompt}
                />
              </div>
              <div className="field">
                <div className="field__head">
                  <label htmlFor="a-materials">资料文件（可选）</label>
                </div>
                <small>
                  选择 .md / .txt 参考资料，
                  内容会并入创作要求，AI 只引用这些资料中的事实。
                </small>
                <div
                  className={`materials-dropzone${referenceDrag ? " materials-dropzone--drag" : ""}`}
                  onDragLeave={() => setReferenceDrag(false)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setReferenceDrag(true);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setReferenceDrag(false);
                    void importReferenceFiles(e.dataTransfer.files);
                  }}
                >
                  <FileUp aria-hidden size={20} strokeWidth={1.8} />
                  <div className="materials-dropzone__text">
                    <strong>点击选择或拖入 .md / .txt 资料</strong>
                    <span>支持多选，内容会并入上方创作要求</span>
                  </div>
                  <input
                    accept=".md,.markdown,.txt,text/markdown,text/plain"
                    id="a-materials"
                    multiple
                    onChange={(e) => {
                      void importReferenceFiles(e.target.files);
                      e.target.value = "";
                    }}
                    tabIndex={-1}
                    type="file"
                  />
                </div>
                {referenceNames.length > 0 && (
                  <ul className="materials-dropzone__files">
                    {referenceNames.map((name) => (
                      <li key={name}>
                        <FileText aria-hidden size={12} />
                        {name}
                      </li>
                    ))}
                  </ul>
                )}
                {referenceNote && <small className="muted">{referenceNote}</small>}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <div className="field">
                  <label>文风</label>
                  <ToolbarSelect
                    label="文风"
                    onChange={(value) => setTone(value)}
                    options={[
                      { id: "", label: "默认（自然中文）" },
                      { id: "产品推广", label: "产品推广" },
                      { id: "技术解析", label: "技术解析" },
                      { id: "真人感", label: "真人感增强" },
                    ]}
                    value={tone}
                  />
                </div>
                <div className="field">
                  <label>篇幅</label>
                  <ToolbarSelect
                    label="篇幅"
                    onChange={(value) => setLengthPreset(value)}
                    options={LENGTH_OPTIONS.map((option) => ({ id: option.id, label: option.label }))}
                    value={lengthPreset}
                  />
                </div>
              </div>
              {lengthPreset === "custom" && (
                <div className="field">
                  <label htmlFor="a-custom-length">自定义篇幅</label>
                  <input
                    id="a-custom-length"
                    onChange={(e) => setCustomLength(e.target.value)}
                    placeholder="例如：约 2000 字"
                    value={customLength}
                  />
                </div>
              )}
              <label className="creation-toolbar__choice">
                <input
                  checked={humanize}
                  onChange={(e) => setHumanize(e.target.checked)}
                  type="checkbox"
                />
                <span>启用真人感增强（humanizer-zh）</span>
              </label>
              <div>
                <button
                  className="button button--primary"
                  onClick={() => void startRun()}
                  type="button"
                >
                  <Plus size={16} />
                  开始创作
                </button>
              </div>
            </div>
          )}

          {!creating && activeRunForSelected && (
            <div className="article-run-strip">
              <ArticleRunTimeline completedNodeIds={completedNodes} events={events} stopped={!running} runFailed={runFailed} visualState="hidden" />
              {events.length > 0 && (
                <ol aria-label="创作事件" className="workflow-task__events">
                  {events.slice(-8).map((event) => {
                    const state = journalEventState(event.type);
                    const Icon = state === "failed" ? XCircle : state === "complete" ? Check : LoaderCircle;
                    return (
                      <li className={`is-${state}`} key={event.sequence}>
                        <Icon aria-hidden="true" className={state === "running" ? "spin" : undefined} size={13} />
                        <span>{journalEventMessage(event.type, event.payload)}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
              {running && (
                <div className="article-run-strip__status">
                  <p className="muted">
                    <LoaderCircle className="spin" size={14} /> 正在撰写正文，输出会实时进入编辑器……
                  </p>
                  <button className="button button--quiet" onClick={() => void stopRun()} type="button">
                    停止
                  </button>
                </div>
              )}
            </div>
          )}

          {!creating && selected && (
            <div className="article-editor__main" style={{ display: "grid", gap: 10, minWidth: 0 }}>
              <div className="field__head" style={{ padding: "0 2px" }}>
                <label htmlFor="a-markdown">正文（Markdown）</label>
                <span className="field-tag">
                  {selected.currentRevisionId ? `修订 ${selected.currentRevisionId.slice(0, 8)}` : "待生成完整版本"}
                </span>
              </div>
              {visualResultNote && (
                <p className="muted" style={{ fontSize: 12, margin: 0 }} role="status">
                  {visualResultNote}
                </p>
              )}
              <div className="article-editor__workspace" ref={workspaceRef}>
                <div className="article-editor__workbench">
                  <MarkdownWorkbench
                    dirty={dirty}
                    saved={Boolean(selected.currentRevisionId)}
                    streaming={running}
                    editorMode={viewMode}
                    markdown={draft}
                    onEditorModeChange={setViewMode}
                    onImageFileDrop={uploadImageFile}
                    onMarkdownChange={handleMarkdownChange}
                    onRequestSelectionRewrite={(sel) => {
                      setRewriteSelection(sel);
                      setAiPanelOpen(true);
                    }}
                    previewPlatform={previewPlatform}
                    onPreviewPlatformChange={setPreviewPlatform}
                    onFigureDrop={(figure, line) =>
                      handleMarkdownChange(moveMarkdownSpanToLine(draft, figure.span, line))
                    }
                    onInsertAtLine={(snippet, line) =>
                      handleMarkdownChange(insertMarkdownAtLine(draft, snippet, line))
                    }
                  />
                </div>
                {aiPanelOpen && (
                  <>
                    <div
                      aria-label="调节 AI 修改栏宽度"
                      aria-orientation="vertical"
                      className="pane-resizer"
                      onPointerDown={(event) =>
                        beginWidthDrag(event, aiPaneWidth, (start, dx) => {
                          const ws = workspaceRef.current?.getBoundingClientRect().width ?? 1200;
                          const max = Math.max(240, Math.min(560, ws - (viewMode === "split" ? 450 : 330)));
                          setAiPaneWidth(clampWidth(start - dx, 260, max));
                        })}
                      role="separator"
                    />
                    <div className="article-editor__pane article-editor__pane--ai" ref={aiPaneRef} style={{ width: aiPaneWidth, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                      <div aria-label="侧边栏" className="article-side-tabs" role="tablist">
                        <button
                          aria-selected={aiPaneTab === "assistant"}
                          className={`article-side-tabs__tab${aiPaneTab === "assistant" ? " is-active" : ""}`}
                          onClick={() => setAiPaneTab("assistant")}
                          role="tab"
                          type="button"
                        >
                          AI 修改
                        </button>
                        <button
                          aria-selected={aiPaneTab === "figures"}
                          className={`article-side-tabs__tab${aiPaneTab === "figures" ? " is-active" : ""}`}
                          onClick={() => setAiPaneTab("figures")}
                          role="tab"
                          type="button"
                        >
                          配图
                        </button>
                      </div>
                      {aiPaneTab === "assistant" ? (
                      <AiModifyPane
                    articleId={selected.articleId}
                    key={selected.articleId}
                    markdown={draft}
                    onClose={() => setAiPanelOpen(false)}
                    onApply={(next) => {
                      setLastAiSnapshot({
                        label: "AI 修改",
                        markdown: draft,
                        currentRevisionId: selected.currentRevisionId,
                        contentHash: selected.contentHash,
                      });
                      if (rewriteSelection) {
                        setDraft(
                          draft.slice(0, rewriteSelection.start) +
                          next +
                          draft.slice(rewriteSelection.end),
                        );
                        setRewriteSelection(null);
                      } else {
                        setDraft(next);
                      }
                    }}
                    selection={rewriteSelection}
                      />
                      ) : (
                      <ArticleImagePane
                        canInsert={viewMode !== "preview"}
                        markdown={draft}
                        onImageFileDrop={uploadImageFile}
                        onDeleteFigure={(figure: ArticleFigure) => handleMarkdownChange(removeMarkdownSpan(draft, figure.span))}
                        onInsertAtLine={(snippet: string, lineNumber: number) =>
                          handleMarkdownChange(insertMarkdownAtLine(draft, snippet, lineNumber))
                        }
                        onMoveFigure={(figure: ArticleFigure, lineNumber: number) =>
                          handleMarkdownChange(moveMarkdownSpanToLine(draft, figure.span, lineNumber))
                        }
                        style={{ flex: 1, minHeight: 0 }}
                      />
                      )}
                    </div>
                  </>
                )}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                {lastAiSnapshot && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    可撤销：{lastAiSnapshot.label}
                  </span>
                )}
                <button
                  className="text-button"
                  onClick={() => navigate("/")}
                  type="button"
                >
                  ← 返回工作台
                </button>
              </div>
            </div>
          )}

          {!creating && !selected && !loading && (
            <div className="empty-page">
              <FileText aria-hidden="true" size={28} />
              <p className="muted">从左侧选择文章，或点右上角 + 新建创作</p>
            </div>
          )}
          {selected && !creating && assistantOpen && (
            <AssistantDrawer
              articleId={selected.articleId}
              markdown={draft}
              onClose={() => setAssistantOpen(false)}
              selection={rewriteSelection}
              onApplySelection={(replacement) => {
                if (rewriteSelection) {
                  setDraft(
                    draft.slice(0, rewriteSelection.start) +
                    replacement +
                    draft.slice(rewriteSelection.end),
                  );
                  setRewriteSelection(null);
                } else {
                  setDraft(draft + "\n\n" + replacement);
                }
              }}
            />
          )}
        </div>
      </div>
      {selected && syncOpen && (
        <SyncPublishDialog
          markdown={draft}
          onClose={() => setSyncOpen(false)}
          title={selected.title}
        />
      )}
      {selected && syncNoticeOpen && (
        <PublishNoticeDialog
          onContinue={() => {
            setSyncNoticeOpen(false);
            setSyncOpen(true);
          }}
          onClose={() => setSyncNoticeOpen(false)}
          onOpenTutorial={() => {
            setSyncNoticeOpen(false);
            navigate("/announcements");
          }}
        />
      )}
      {selected && historyOpen && (
        <RevisionHistoryDrawer
          articleId={selected.articleId}
          onClose={() => setHistoryOpen(false)}
          onRestored={() => {
            void loadArticles();
            void api
              .get<ArticleState>(`/articles/${selected.articleId}`)
              .then((res) => setSelected(res.data))
              .catch(() => undefined);
          }}
        />
      )}
    </section>
  );
}

