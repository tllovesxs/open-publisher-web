import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Check, Copy, FileText, LoaderCircle, Square, XCircle } from "lucide-react";
import { api } from "../api/client";
import QualityReport, { type QualityReportData } from "../components/QualityReport";
import RiskReport, { type SafetyReport } from "../components/RiskReport";
import { WORKFLOW_NODES } from "../workflow/nodes";
import type { RunDetail, RunEvent, RunEventType, TweetRevision } from "../types/run";

// 页面结构照搬蓝本 WorkflowWorkspace / workflow-timeline 类体系（团队自有代码）。

type NodeState = "pending" | "running" | "completed";

function formatTime(iso?: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString();
}

const EVENT_LABELS: Partial<Record<RunEventType, string>> = {
  "run.started": "任务开始",
  "run.completed": "任务完成",
  "run.cancelled": "任务已取消",
  "run.failed": "任务失败",
};

interface FeedItem {
  key: string;
  message: string;
  time: string;
  eventType: RunEventType;
}

// 蓝本 WorkflowWorkspace 的 eventState / eventIcon（Web 事件类型映射）。
function eventState(eventType: RunEventType): "running" | "complete" | "failed" {
  if (eventType === "run.failed") return "failed";
  if (eventType === "run.completed" || eventType === "node.completed") return "complete";
  return "running";
}

function eventIcon(eventType: RunEventType) {
  const state = eventState(eventType);
  if (state === "failed") return XCircle;
  if (state === "complete") return Check;
  return LoaderCircle;
}

function deriveNodeStates(completed: Set<string>): NodeState[] {
  let currentAssigned = false;
  return WORKFLOW_NODES.map((node) => {
    if (completed.has(node.id)) return "completed";
    if (!currentAssigned) {
      currentAssigned = true;
      return "running";
    }
    return "pending";
  });
}

export default function RunPage() {
  const { runId } = useParams<{ runId: string }>();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [completedNodes, setCompletedNodes] = useState<Set<string>>(new Set());
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [revisions, setRevisions] = useState<TweetRevision[]>([]);
  const [stopping, setStopping] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const loadRun = useCallback(async () => {
    if (!runId) return;
    try {
      const res = await api.get<RunDetail>(`/runs/${runId}`);
      setRun(res.data);
      setRevisions(res.data.revisions ?? []);
      if (res.data.status === "completed") {
        setCompletedNodes(new Set(WORKFLOW_NODES.map((n) => n.id)));
      }
    } catch {
      setError("加载运行详情失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void loadRun();
  }, [loadRun]);

  useEffect(() => {
    if (!runId) return;
    const source = new EventSource(
      `${import.meta.env.VITE_API_BASE_URL ?? "/api"}/runs/${runId}/events`,
      { withCredentials: true },
    );
    esRef.current = source;

    source.onmessage = (evt) => {
      let event: RunEvent | null = null;
      try {
        event = JSON.parse(evt.data) as RunEvent;
      } catch {
        return;
      }
      if (!event) return;

      if (event.eventType === "node.completed" && event.nodeId) {
        setCompletedNodes((prev) => new Set(prev).add(event.nodeId as string));
        void loadRun();
      }

      if (event.eventType === "stream.end" || event.eventType === "stream.timeout") {
        source.close();
        void loadRun();
        return;
      }

      const message =
        event.message ??
        EVENT_LABELS[event.eventType] ??
        (event.eventType === "node.completed" ? "创作步骤已完成" : "任务进度已更新");
      const feedKey = event.id ?? `${event.eventType}-${event.createdAt ?? Date.now()}`;
      setFeed((prev) =>
        [{ key: feedKey, message, time: formatTime(event.createdAt), eventType: event.eventType }, ...prev].slice(0, 50),
      );
    };

    source.onerror = () => {
      source.close();
      void loadRun();
    };

    return () => {
      source.close();
      esRef.current = null;
    };
  }, [runId, loadRun]);

  const handleStop = async () => {
    if (!runId) return;
    setStopping(true);
    try {
      await api.post(`/runs/${runId}/stop`);
    } finally {
      setStopping(false);
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
        正在加载运行详情
      </div>
    );
  }
  if (!run) {
    return (
      <section className="page empty-page">
        <FileText aria-hidden="true" size={28} />
        <h1>{error ?? "运行不存在"}</h1>
        <Link className="button button--quiet" to="/">
          返回项目列表
        </Link>
      </section>
    );
  }

  const nodeStates = deriveNodeStates(completedNodes);
  const running = run.status === "running" || run.status === "pending";
  const statusLabel: Record<string, string> = {
    pending: "排队中",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  const statusClass =
    run.status === "completed"
      ? "article-status article-status--ready"
      : run.status === "failed"
        ? "article-status article-status--review"
        : "article-status article-status--running";

  return (
    <section className="page">
      <header className="page-heading">
        <div>
          <span className="page-kicker">创作任务</span>
          <h1>推文生成任务</h1>
        </div>
        <div className="page-heading__actions">
          <span className={statusClass}>{statusLabel[run.status] ?? run.status}</span>
          {running && (
            <button
              className="button button--quiet button--stop-workflow"
              disabled={stopping}
              onClick={() => void handleStop()}
              type="button"
            >
              {stopping ? <LoaderCircle className="spin" size={13} /> : <Square size={12} />}
              停止生成
            </button>
          )}
        </div>
      </header>

      {run.status === "failed" && run.error_message && (
        <div className="workflow-task__failure" role="alert">
          <p>{run.error_message}</p>
        </div>
      )}

      <ol aria-label="流程进度" className="workflow-timeline">
        {WORKFLOW_NODES.map((node, i) => {
          const state = nodeStates[i];
          return (
            <li
              className={`workflow-timeline__item${state === "running" ? " is-running" : ""}${state === "completed" ? " is-complete" : ""}`}
              key={node.id}
            >
              <span aria-hidden="true" className="workflow-timeline__icon">
                {state === "completed" ? (
                  <Check size={14} />
                ) : state === "running" ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <span style={{ fontSize: 11 }}>{i + 1}</span>
                )}
              </span>
              <div>
                <strong>{node.label}</strong>
                <small>{node.description}</small>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="workflow-task__details" style={{ marginTop: 18 }}>
        <span className="page-kicker">任务动态</span>
        {feed.length === 0 ? (
          <p className="workflow-workspace__empty" style={{ marginTop: 8 }}>
            {running
              ? "等待任务更新……"
              : "任务动态已归档，以下为最终结果。"}
          </p>
        ) : (
          <ol aria-label="本次任务记录" className="workflow-task__events" style={{ marginTop: 8 }}>
            {feed.map((item) => {
              const Icon = eventIcon(item.eventType);
              return (
                <li className={`is-${eventState(item.eventType)}`} key={item.key}>
                  <Icon
                    aria-hidden="true"
                    className={eventState(item.eventType) === "running" ? "spin" : undefined}
                    size={13}
                  />
                  <span>{item.message}</span>
                  {item.time && <time>{item.time}</time>}
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {(() => {
        const safetyArtifact = run.artifacts?.find((a) => a.artifact_type === "safety_report");
        if (!safetyArtifact) return null;
        return (
          <div style={{ marginTop: 24 }}>
            <RiskReport report={safetyArtifact.content_json as SafetyReport} />
          </div>
        );
      })()}

      {(() => {
        const qualityArtifact = run.artifacts?.find((a) => a.artifact_type === "quality_report");
        if (!qualityArtifact) return null;
        return (
          <div style={{ marginTop: 24 }}>
            <QualityReport report={qualityArtifact.content_json as QualityReportData} />
          </div>
        );
      })()}

      {revisions.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <span className="page-kicker">生成结果 · {revisions.length} 条</span>
          <div style={{ marginTop: 8 }}>
            {revisions.map((rev) => (
              <article className="workflow-source-card" key={rev.id} style={{ padding: "14px 0" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  <span className="article-status">{rev.platform ?? "通用"}</span>
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
                </div>
                <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.7, margin: "8px 0 0" }}>
                  {rev.content}
                </p>
                <span className="page-kicker">
                  v{rev.version} · {new Date(rev.created_at).toLocaleString()}
                </span>
              </article>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 28 }}>
        <Link className="text-button" to="/">
          ← 返回项目列表
        </Link>
      </div>
    </section>
  );
}


