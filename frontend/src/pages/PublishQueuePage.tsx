import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, Clock3, LoaderCircle, RefreshCw, Send, XCircle } from "lucide-react";
import { api } from "../api/client";

// 发布队列：蓝本 publish outbox 状态机的 Web 管理页。
// 链路：draft（文章页 PublishDialog 创建）→ approve → enqueue → process（dry_run）
// → unknown 时 reconcile / resolve-unknown。真实平台投递第二阶段接入。

interface PublishJobView {
  id: string;
  planId: string;
  variantId: string;
  platform: string;
  accountRef: string;
  operation: string;
  state: string;
  remoteId: string | null;
  lastError: string | null;
  reconcileRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PublishPlanView {
  planId: string;
  revisionId: string;
  status: string;
  approvalStatus: string;
  approvalBindingHash: string | null;
  createdAt: string;
  updatedAt: string;
  variants: Array<{ id: string; platform: string; accountRef: string; title: string; contentHash: string }>;
  jobs: PublishJobView[];
}

const PLAN_STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  approved: "已审批",
  queued: "已入队",
  running: "执行中",
  completed: "已完成",
  needs_attention: "需要关注",
};

const JOB_STATE_LABEL: Record<string, string> = {
  pending: "待处理",
  in_progress: "处理中",
  succeeded: "成功",
  failed_retryable: "可重试失败",
  failed_terminal: "终止失败",
  unknown: "待核验",
  reconciling: "核验中",
  cancelled: "已取消",
};

function jobTone(state: string): "success" | "danger" | "warn" | "muted" {
  if (state === "succeeded") return "success";
  if (state === "failed_terminal") return "danger";
  if (state === "failed_retryable" || state === "unknown" || state === "reconciling") return "warn";
  return "muted";
}

const TONE_COLOR: Record<string, string> = {
  success: "var(--success)",
  danger: "var(--danger)",
  warn: "#d97706",
  muted: "var(--muted)",
};

function errorMessage(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { detail?: { message?: string } | string } } })
    ?.response?.data?.detail;
  if (typeof detail === "object" && detail?.message) return detail.message;
  if (typeof detail === "string") return detail;
  return fallback;
}

export default function PublishQueuePage() {
  const [plans, setPlans] = useState<PublishPlanView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ plans: PublishPlanView[] }>("/publish/plans");
      setPlans(res.data.plans ?? []);
    } catch {
      setError("无法读取发布计划，请确认已登录。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusyId(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(errorMessage(err, "操作失败，请稍后再试。"));
    } finally {
      setBusyId(null);
    }
  };

  const approve = (plan: PublishPlanView) =>
    act(`approve-${plan.planId}`, () =>
      api.post(`/publish/plans/${plan.planId}/approve`, { actorId: "user:web" }));

  const enqueue = (plan: PublishPlanView) =>
    act(`enqueue-${plan.planId}`, () =>
      api.post(`/publish/plans/${plan.planId}/enqueue`));

  const processJob = (jobId: string) =>
    act(`process-${jobId}`, () => api.post(`/publish/jobs/${jobId}/process`));

  const reconcile = (job: PublishJobView) =>
    act(`reconcile-${job.id}`, () =>
      api.post(`/publish/jobs/${job.id}/reconcile`));

  const resolveUnknown = (job: PublishJobView, resolution: "draft_exists" | "draft_missing") =>
    act(`resolve-${job.id}-${resolution}`, () =>
      api.post(`/publish/jobs/${job.id}/resolve-unknown`, { resolution }));

  return (
    <div className="publish-queue-page" style={{ padding: "20px 24px", display: "grid", gap: 16, maxWidth: 860 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <p className="page-kicker">发布</p>
          <h1 style={{ margin: 0 }}>发布队列</h1>
        </div>
        <button
          className="button button--quiet"
          disabled={loading}
          onClick={() => void load()}
          type="button"
        >
          {loading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
          刷新
        </button>
      </header>

      <p className="muted" style={{ fontSize: 13, margin: 0 }}>
        在文章页创建发布计划，然后在这里确认和处理。此队列目前仅模拟执行，不会向平台实际发布；实际同步请使用文章同步助手。
      </p>

      {error && (
        <div className="workflow-task__failure" role="alert">
          <p>{error}</p>
        </div>
      )}

      {loading && plans.length === 0 && (
        <div className="panel" style={{ alignItems: "center", display: "flex", gap: 8, padding: 16 }}>
          <LoaderCircle className="spin" size={16} />
          <span className="muted">加载中……</span>
        </div>
      )}

      {!loading && plans.length === 0 && !error && (
        <div className="panel" style={{ display: "grid", gap: 6, padding: 20, textAlign: "center" }}>
          <Send aria-hidden="true" size={22} style={{ margin: "0 auto", color: "var(--muted)" }} />
          <strong>还没有发布计划</strong>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            到「文章」页打开一篇文章，点击「发布」创建多平台发布计划。
          </p>
        </div>
      )}

      {plans.map((plan) => {
        const pendingJobs = plan.jobs.filter((job) => job.state === "pending");
        const attentionJobs = plan.jobs.filter((job) => job.reconcileRequired || job.state === "unknown");
        const canApprove = plan.status === "draft" && plan.approvalStatus !== "approved";
        const canEnqueue = plan.status === "approved";
        const title = plan.variants[0]?.title ?? plan.revisionId;
        return (
          <section className="panel" key={plan.planId} style={{ display: "grid", gap: 12, padding: 16 }}>
            <header style={{ alignItems: "flex-start", display: "flex", gap: 10, justifyContent: "space-between" }}>
              <div style={{ minWidth: 0 }}>
                <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {title}
                </strong>
                <small className="muted">
                  计划 {plan.planId.slice(0, 18)}… · 版本 {plan.revisionId.slice(0, 12)}… · 更新于 {new Date(plan.updatedAt).toLocaleString()}
                </small>
              </div>
              <span
                style={{
                  borderRadius: 999,
                  flex: "0 0 auto",
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "3px 10px",
                  background:
                    plan.status === "completed" ? "var(--success-soft, rgba(34,197,94,.14))"
                      : plan.status === "needs_attention" ? "rgba(217,119,6,.14)"
                        : "var(--surface-muted)",
                  color:
                    plan.status === "completed" ? "var(--success)"
                      : plan.status === "needs_attention" ? "#b45309"
                        : "var(--muted)",
                }}
              >
                {PLAN_STATUS_LABEL[plan.status] ?? plan.status}
              </span>
            </header>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {plan.variants.map((variant) => (
                <span
                  key={variant.id}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 999,
                    fontSize: 12,
                    padding: "3px 10px",
                  }}
                >
                  {variant.platform} · {variant.accountRef || "未填账号"}
                </span>
              ))}
            </div>

            <div style={{ display: "grid", gap: 6 }}>
              {plan.jobs.map((job) => (
                <div
                  key={job.id}
                  style={{
                    alignItems: "center",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    display: "flex",
                    flexWrap: "wrap",
                    fontSize: 13,
                    gap: 8,
                    justifyContent: "space-between",
                    padding: "8px 12px",
                  }}
                >
                  <div style={{ alignItems: "center", display: "flex", gap: 8, minWidth: 0 }}>
                    {jobTone(job.state) === "success" && <CheckCircle2 aria-hidden="true" color={TONE_COLOR.success} size={15} />}
                    {jobTone(job.state) === "danger" && <XCircle aria-hidden="true" color={TONE_COLOR.danger} size={15} />}
                    {(jobTone(job.state) === "warn") && <CircleAlert aria-hidden="true" color={TONE_COLOR.warn} size={15} />}
                    {jobTone(job.state) === "muted" && <Clock3 aria-hidden="true" color={TONE_COLOR.muted} size={15} />}
                    <strong>{job.platform}</strong>
                    <span className="muted">{job.accountRef}</span>
                    <span style={{ color: TONE_COLOR[jobTone(job.state)], fontWeight: 600 }}>
                      {JOB_STATE_LABEL[job.state] ?? job.state}
                    </span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {job.state === "pending" && (
                      <button
                        className="button button--quiet"
                        disabled={busyId !== null}
                        onClick={() => void processJob(job.id)}
                        type="button"
                      >
                        {busyId === `process-${job.id}` ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}
                        处理
                      </button>
                    )}
                    {(job.state === "unknown" || job.reconcileRequired) && (
                      <>
                        <button
                          className="button button--quiet"
                          disabled={busyId !== null}
                          onClick={() => void reconcile(job)}
                          type="button"
                        >
                          核验
                        </button>
                        <button
                          className="button button--quiet"
                          disabled={busyId !== null}
                          onClick={() => void resolveUnknown(job, "draft_exists")}
                          type="button"
                        >
                          远端已有草稿
                        </button>
                        <button
                          className="button button--quiet"
                          disabled={busyId !== null}
                          onClick={() => void resolveUnknown(job, "draft_missing")}
                          type="button"
                        >
                          远端缺失
                        </button>
                      </>
                    )}
                  </div>
                  {job.lastError && (
                    <small style={{ color: "var(--danger)", width: "100%" }}>错误：{job.lastError}</small>
                  )}
                </div>
              ))}
            </div>

            {(canApprove || canEnqueue || pendingJobs.length > 0 || attentionJobs.length > 0) && (
              <footer style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
                {canApprove && (
                  <button
                    className="button button--primary"
                    disabled={busyId !== null}
                    onClick={() => void approve(plan)}
                    type="button"
                  >
                    {busyId === `approve-${plan.planId}` ? <LoaderCircle className="spin" size={15} /> : <CheckCircle2 size={15} />}
                    审批绑定内容
                  </button>
                )}
                {canEnqueue && (
                  <button
                    className="button button--primary"
                    disabled={busyId !== null}
                    onClick={() => void enqueue(plan)}
                    type="button"
                  >
                    {busyId === `enqueue-${plan.planId}` ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}
                    加入处理队列
                  </button>
                )}
              </footer>
            )}
          </section>
        );
      })}
    </div>
  );
}

