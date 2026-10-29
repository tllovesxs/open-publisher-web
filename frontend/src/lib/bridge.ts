// Web Bridge：蓝本 desktopBridge 的浏览器等价层。
// 目标是把后端契约收敛成 typed API，页面不再直接拼 SSE 和业务对象。
import { api } from "../api/client";

export interface AgentRun {
  id: string;
  articleId: string | null;
  status: string;
  ownerUserId?: string | null;
  error?: { code?: string; message?: string } | null;
}

export interface ArticleRunEvent {
  key?: string;
  sequence?: number;
  type: string;
  message?: string;
  payload?: Record<string, unknown>;
}

export interface ArticleState {
  articleId: string;
  title: string;
  currentRevisionId: string | null;
  contentHash: string | null;
  markdown: string;
  updatedAt: string | null;
  ownerId?: string | null;
}

export interface CreationTemplate {
  id?: string | null;
  name?: string | null;
  markdown?: string | null;
  usageInstructions?: string | null;
}

export interface ArticleCreateContract {
  articleId: string;
  prompt: string;
  tone?: string | null;
  lengthPreset?: string;
  customLength?: string | null;
  humanize?: boolean;
  title?: string | null;
  references?: string | null;
  template?: CreationTemplate | null;
  imageAssets?: string[];
  inputImages?: string[];
  imagePlan?: { targetCount: number; imageModelId?: string | null } | null;
  webSearchMode?: "auto" | "off" | null;
  taskMode?: string | null;
  disabledNodeIds?: string[];
  materialMatchThreshold?: number;
}

export interface StreamHandlers {
  onEvent?: (event: ArticleRunEvent) => void;
  onEnd?: (status: "end" | "timeout" | "error") => void;
}

function eventSourceUrl(runId: string, after: number) {
  const base = import.meta.env.VITE_API_BASE_URL ?? "/api";
  return `${base.replace(/\/$/, "")}/agent-runs/${encodeURIComponent(runId)}/events?cursor=${after}`;
}

export const bridge = {
  async createArticleRun(contract: ArticleCreateContract) {
    const res = await api.post<AgentRun>("/agent-runs/article-create", contract);
    return res.data;
  },

  async getArticle(articleId: string) {
    const res = await api.get<ArticleState>(`/articles/${encodeURIComponent(articleId)}`);
    return res.data;
  },

  async listArticles() {
    const res = await api.get<{ articles: ArticleState[] }>("/articles");
    return res.data.articles ?? [];
  },

  async stopArticleRun(runId: string) {
    const res = await api.post<AgentRun>(`/agent-runs/${encodeURIComponent(runId)}/stop`);
    return res.data;
  },

  openRunStream(runId: string, handlers: StreamHandlers = {}) {
    let source: EventSource;
    let closed = false;
    let sequence = 0;
    let reconnectTimer: number | undefined;
    const connect = () => {
      if (closed) return;
      source = new EventSource(eventSourceUrl(runId, sequence), { withCredentials: true });
      source.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as ArticleRunEvent;
          if (event.type === "stream.timeout") {
            source.close();
            reconnectTimer = window.setTimeout(connect, 500);
            return;
          }
          if (event.type === "stream.end") {
            source.close();
            handlers.onEnd?.("end");
            return;
          }
          if (typeof event.sequence === "number") {
            if (event.sequence <= sequence) return;
            sequence = event.sequence;
          }
          handlers.onEvent?.(event);
        } catch {
          // 心跳与不可解析数据交给连接层处理。
        }
      };
      source.onerror = () => {
        // EventSource reconnects automatically; the server resumes from Last-Event-ID.
      };
    };
    connect();
    return { close() { closed = true; window.clearTimeout(reconnectTimer); source?.close(); } };
  },
};
