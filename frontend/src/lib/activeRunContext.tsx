import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { bridge, type ArticleCreateContract, type ArticleRunEvent } from "./bridge";
import { useAuth } from "../auth/AuthContext";

export type ActiveRunStatus = "running" | "succeeded" | "failed" | "stopped";

export interface ActiveRunVisualPlan {
  enabled: boolean;
  targetCount: number;
  imageModelId: string | null;
  assetIds: string[];
}

export interface ActiveRun {
  runId: string;
  articleId: string;
  title: string;
  visualPlan?: ActiveRunVisualPlan | null;
}

interface StartRunOptions {
  visualPlan?: ActiveRunVisualPlan | null;
}

interface ActiveRunContextValue {
  activeRun: ActiveRun | null;
  runStatus: ActiveRunStatus | null;
  runEvents: ArticleRunEvent[];
  completedNodeIds: Set<string>;
  startRun: (contract: ArticleCreateContract, title: string, options?: StartRunOptions) => Promise<ActiveRun>;
  stopRun: () => Promise<void>;
  clearRun: () => void;
}

interface StoredActiveRun extends ActiveRun {
  ownerUserId?: string | null;
}

const storageKey = "gaoliu.active-article-run";

const ActiveRunContext = createContext<ActiveRunContextValue | null>(null);

function readStoredRun(ownerUserId: string | null | undefined): ActiveRun | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredActiveRun;
    if (!parsed?.runId || !parsed?.articleId) return null;
    if (ownerUserId && parsed.ownerUserId && parsed.ownerUserId !== ownerUserId) return null;
    return { runId: parsed.runId, articleId: parsed.articleId, title: parsed.title || "文章", visualPlan: parsed.visualPlan ?? null };
  } catch {
    return null;
  }
}

export function ActiveRunProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(() => readStoredRun(user?.id));
  const [runStatus, setRunStatus] = useState<ActiveRunStatus | null>("running");
  const [runEvents, setRunEvents] = useState<ArticleRunEvent[]>([]);
  const [completedNodeIds, setCompletedNodeIds] = useState<Set<string>>(new Set());
  const sourceRef = useRef<{ close: () => void } | null>(null);
  const terminalRef = useRef<ActiveRunStatus | null>(null);

  const closeStream = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  // 全局监听是导航不丢进度的关键：文章页/创作页只是它的订阅者，页面切换不会关闭 SSE。
  useEffect(() => {
    closeStream();
    setRunEvents([]);
    setCompletedNodeIds(new Set());
    terminalRef.current = null;
    if (!activeRun || !user) {
      setRunStatus(null);
      return;
    }
    setRunStatus("running");
    sourceRef.current = bridge.openRunStream(activeRun.runId, {
      onEvent: (event) => {
        setRunEvents((current) => {
          const sequence = typeof event.sequence === "number" ? event.sequence : current.length + 1;
          if (current.length && current[current.length - 1]!.sequence! >= sequence) return current;
          return [...current, event];
        });
        const nodeId = (event.payload as { nodeId?: string } | undefined)?.nodeId;
        if (event.type === "node.completed" && nodeId) {
          setCompletedNodeIds((current) => new Set(current).add(nodeId));
        }
        if (event.type === "run.completed") terminalRef.current = "succeeded";
        if (event.type === "run.failed") terminalRef.current = "failed";
        if (event.type === "run.stopped") terminalRef.current = "stopped";
        if (terminalRef.current) setRunStatus(terminalRef.current);
      },
      onEnd: (reason) => {
        closeStream();
        setRunStatus((current) => {
          if (reason === "error") return "failed";
          if (current === "succeeded" || current === "failed" || current === "stopped") return current;
          return terminalRef.current ?? "failed";
        });
      },
    });
    return closeStream;
  }, [activeRun, closeStream, user]);

  useEffect(() => {
    if (!activeRun) {
      sessionStorage.removeItem(storageKey);
      return;
    }
    const stored: StoredActiveRun = { ...activeRun, ownerUserId: user?.id ?? null };
    sessionStorage.setItem(storageKey, JSON.stringify(stored));
  }, [activeRun, user?.id]);

  const startRun = useCallback(async (
    contract: ArticleCreateContract,
    title: string,
    options?: StartRunOptions,
  ) => {
    closeStream();
    setRunEvents([]);
    setCompletedNodeIds(new Set());
    setRunStatus("running");
    let run;
    try {
      run = await bridge.createArticleRun(contract);
    } catch (error) {
      setRunStatus(null);
      throw error;
    }
    const next: ActiveRun = {
      runId: run.id,
      articleId: contract.articleId,
      title: contract.title || title,
      visualPlan: options?.visualPlan ?? null,
    };
    setActiveRun(next);
    return next;
  }, [closeStream]);

  const stopRun = useCallback(async () => {
    if (!activeRun) return;
    await bridge.stopArticleRun(activeRun.runId);
  }, [activeRun]);

  const clearRun = useCallback(() => {
    closeStream();
    setActiveRun(null);
    setRunEvents([]);
    setRunStatus(null);
    setCompletedNodeIds(new Set());
  }, [closeStream]);

  return (
    <ActiveRunContext.Provider value={{
      activeRun,
      completedNodeIds,
      runEvents,
      runStatus,
      startRun,
      stopRun,
      clearRun,
    }}>
      {children}
    </ActiveRunContext.Provider>
  );
}

export function useActiveRun() {
  const context = useContext(ActiveRunContext);
  if (!context) throw new Error("useActiveRun must be used within ActiveRunProvider");
  return context;
}

