import { AlertTriangle, Check, CircleMinus, LoaderCircle, XCircle } from "lucide-react";
import { ARTICLE_WORKFLOW_NODES } from "../workflow/articleNodes";

// 文章创作过程时间线：复刻蓝本 WorkflowWorkspace 的 workflow-timeline 类体系。
// 节点完成状态来自后端 node.completed 事件；配图节点由前端配图阶段驱动。

type NodeState = "pending" | "running" | "completed" | "failed" | "skipped" | "warning";

const DETAIL_LABELS: Record<string, string> = {
  score: "评分（对应检查版本）", level: "风险等级", issues: "问题数", issueDetails: "具体意见",
  sections: "大纲章节", skipped: "已跳过", reason: "原因", mode: "模式", chars: "字数",
  changed: "已修改", ok: "核验通过", verdict: "审阅结论", rag: "资料检索",
  indexedChunks: "索引片段", hits: "命中片段", rerankUsed: "已重排", status: "状态",
  checkedRevisionId: "检查版本", recheckRequired: "修改后需重新检查",
  durationMs: "耗时（毫秒）",
};
const DETAIL_VALUES: Record<string, string> = {
  disabled: "用户已禁用", "manual-or-frontend-driven": "由配图工具继续处理",
  "no-draft": "没有可用正文", "no-references": "未提供参考资料",
  "output-invalid": "输出未通过校验", retrieved: "已检索", fallback: "已使用参考原文",
  low: "低风险", medium: "中风险", high: "高风险，建议修改", unknown: "未完成检查",
  pass: "通过", revise: "建议修改", structured: "结构化大纲", free: "自由结构",
};

export function formatNodeDetail(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.map(formatNodeDetail).join("；") || "无";
  if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${DETAIL_LABELS[key] ?? key}：${formatNodeDetail(item)}`).join("；");
  return DETAIL_VALUES[String(value)] ?? String(value);
}

interface ArticleRunTimelineProps {
  completedNodeIds: Iterable<string>;
  events?: Array<{ type?: string; eventType?: string; payload?: Record<string, unknown> }>;
  stopped?: boolean;
  runFailed?: boolean;
  /** "hidden"：本次创作不涉及配图，不渲染该节点。 */
  visualState?: "hidden" | "pending" | "running" | "done" | "failed";
}

function ArticleRunTimeline({ completedNodeIds, runFailed = false, visualState = "hidden", events = [], stopped = false }: ArticleRunTimelineProps) {
  const completed = new Set(completedNodeIds);
  const details = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    const payload = event.payload;
    if ((event.type ?? event.eventType) === "node.completed" && typeof payload?.nodeId === "string") details.set(payload.nodeId, payload);
  }
  const nodes = ARTICLE_WORKFLOW_NODES;
  let currentAssigned = false;
  const states: NodeState[] = nodes.map((node) => {
    if (node.id === "visual" && visualState !== "hidden") {
      if (visualState === "done") return "completed";
      if (visualState === "failed") return "failed";
      if (visualState === "running") return "running";
      if (!completed.has(node.id)) return "pending";
    }
    if (completed.has(node.id)) {
      const detail = details.get(node.id);
      if (detail?.skipped) return "skipped";
      if (detail?.level === "high" || detail?.level === "unknown" || detail?.recheckRequired) return "warning";
      return "completed";
    }
    if (runFailed) return "failed";
    if (stopped) return "pending";
    if (!currentAssigned) {
      currentAssigned = true;
      return "running";
    }
    return "pending";
  });

  return (
    <ol aria-label="创作流程进度" className="workflow-timeline">
      {nodes.map((node, i) => {
        const state = states[i];
        const detail = details.get(node.id);
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
              ) : state === "failed" ? (
                <XCircle size={14} />
              ) : state === "skipped" ? (
                <CircleMinus size={14} aria-label="已跳过" />
              ) : state === "warning" ? (
                <AlertTriangle size={14} aria-label="需要查看检查结果" />
              ) : (
                <span style={{ fontSize: 11 }}>{i + 1}</span>
              )}
            </span>
            <div>
              <strong>{node.label}</strong>
              <small>{node.description}</small>
              {detail && <details><summary>{detail.skipped ? "已跳过 · 查看原因" : detail.recheckRequired ? "已修改 · 检查结果对应修改前版本" : detail.level === "high" ? "发现高风险 · 查看建议" : "查看结果"}</summary>
                <dl className="workflow-node-details">{Object.entries(detail).filter(([key]) => key !== "nodeId").map(([key, value]) => <div key={key}><dt>{DETAIL_LABELS[key] ?? key}</dt><dd>{formatNodeDetail(value)}</dd></div>)}</dl>
              </details>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export default ArticleRunTimeline;
