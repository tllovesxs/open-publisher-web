export interface ArticleWorkflowNodeMeta {
  id: string;
  label: string;
  description: string;
  required?: boolean;
}

/**
 * 文章创作工作流节点：与蓝本 WorkflowWorkspace 的 nodeLabel 一一对应
 * （research/outline/draft/natural-style/review/reference-safety/risk/visual）。
 * 前后节点由后端 writer_service 的 node.started/node.completed 事件驱动；
 * visual 节点的完成由前端配图阶段（visual-plan/visual-apply）确认。
 */
export const ARTICLE_WORKFLOW_NODES: ArticleWorkflowNodeMeta[] = [
  { id: "research", label: "资料整理", description: "可选：整理参考资料；关闭后不联网检索" },
  { id: "outline", label: "大纲规划", description: "可选：先规划结构；关闭后直接撰写正文" },
  { id: "draft", label: "正文撰写", required: true, description: "必需：生成文章正文，其他环节围绕正文执行" },
  { id: "natural-style", label: "自然表达", description: "可选：润色文风；关闭后保留原始表达" },
  { id: "review", label: "内容审阅", description: "可选：评分并修订；关闭后不自动审阅" },
  { id: "reference-safety", label: "资料核验", description: "可选：有参考资料时核验，无资料自动跳过" },
  { id: "risk", label: "风险检查", description: "可选：检查风险；关闭后不生成风险报告" },
  { id: "visual", label: "配图规划", description: "可选：生成后进入配图流程；关闭后仅生成文字" },
];

export function articleNodeLabel(nodeId: string | undefined | null): string {
  if (!nodeId) return "本次创作";
  return (
    ARTICLE_WORKFLOW_NODES.find((node) => node.id === nodeId)?.label ?? nodeId
  );
}
