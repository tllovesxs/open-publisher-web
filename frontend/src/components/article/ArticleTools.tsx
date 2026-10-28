import { Bot, ImagePlus, LoaderCircle, PencilLine, Send, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { usePersistentState } from "../../lib/usePersistentState";
import { api } from "../../api/client";
import { marked } from "marked";
import DOMPurify from "dompurify";

export function renderMarkdown(markdown: string): string {
  return DOMPurify.sanitize(marked.parse(markdown, { async: false }) as string);
}



/* ---------------- 文章工作区独立 AI 修改栏（图片编辑不占位，候选确认后才写回） ---------------- */

interface AiSelection {
  start: number;
  end: number;
  text: string;
}

interface AiModelProfile {
  id: string;
  is_default?: boolean;
  name: string;
  modelId: string;
  keyConfigured: boolean;
}

interface AiModifyRecord {
  id: string;
  instruction: string;
  scope: string;
  summary: string;
  candidate: string;
  status: "ready" | "applied";
  createdAt: string;
}

interface AiModifyPaneProps {
  articleId: string;
  markdown: string;
  selection?: AiSelection | null;
  onApply: (nextMarkdown: string) => void;
  onClose: () => void;
}

export function AiModifyPane({
  articleId,
  markdown,
  selection = null,
  onApply,
  onClose,
}: AiModifyPaneProps) {
  const [instruction, setInstruction] = useState("");
  const [profileId, setProfileId] = useState("");
  const [profiles, setProfiles] = useState<AiModelProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<AiModifyRecord[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;
    api.get<{ profiles: AiModelProfile[] }>("/settings/profiles")
      .then((res) => {
        if (!mounted) return;
        const list = res.data.profiles ?? [];
        setProfiles(list);
        setProfileId(list.find((item) => item.is_default)?.id ?? list[0]?.id ?? "");
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [records, busy]);

  const submit = async () => {
    const requirement = instruction.trim();
    if (!requirement) {
      setError("请先说明要怎么改。");
      return;
    }
    setBusy(true);
    setError(null);
    const scope = selection?.text.trim() ? "选中内容" : "整篇文章";
    try {
      const run = await api.post<{ id: string }>("/agent-runs/rewrite-candidate", {
        articleId,
        markdown,
        instruction: requirement,
        selectedTexts: selection?.text.trim() ? [selection.text] : [],
        profileId: profileId || null,
      });
      for (let i = 0; i < 360; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const status = await api.get<{ status: string }>(`/agent-runs/${run.data.id}`);
        if (status.data.status === "completed") {
          const journal = await api.get<{ events: Array<{ type: string; payload: Record<string, unknown> }> }>(
            `/agent-runs/${run.data.id}/events?after=0`,
          );
          const ready = journal.data.events.find((event) => event.type === "rewrite.candidate_ready");
          const replacement = String((ready?.payload?.replacements as string[] | undefined)?.[0] ?? "");
          if (!ready || !replacement) {
            setError("运行完成但没有候选结果。");
            return;
          }
          setRecords((current) => [
            ...current,
            {
              id: run.data.id,
              instruction: requirement,
              scope,
              summary: String(ready.payload.summary ?? ""),
              candidate: replacement,
              status: "ready",
              createdAt: new Date().toLocaleTimeString(),
            },
          ]);
          setInstruction("");
          return;
        }
        if (status.data.status === "failed" || status.data.status === "stopped") {
          setError("AI 修改失败或已停止。");
          return;
        }
      }
      setError("AI 修改超时，请稍后重试。");
    } catch {
      setError("发起 AI 修改失败（需要后端配置 LLM Key）。");
    } finally {
      setBusy(false);
    }
  };

  const applyRecord = (record: AiModifyRecord) => {
    onApply(record.candidate);
    setRecords((current) => current.map((item) => (
      item.id === record.id ? { ...item, status: "applied" } : item
    )));
  };

  return (
    <aside aria-label="AI 修改" className="article-ai-modify">
      <header className="article-ai-modify__head">
        <div className="article-ai-modify__title">
          <Bot aria-hidden="true" size={15} />
          <strong>AI 修改</strong>
        </div>
        <button aria-label="关闭 AI 修改栏" className="icon-button" onClick={onClose} type="button">
          <X size={14} />
        </button>
      </header>

      <div className="article-ai-modify__scroll" ref={scrollRef}>
        <div className={`article-ai-modify__scope${selection?.text.trim() ? " is-selection" : ""}`}>
          <PencilLine aria-hidden="true" size={13} />
          <span>{selection?.text.trim() ? `已选中 ${selection.text.length} 字` : "当前范围：整篇文章"}</span>
        </div>

        {records.length === 0 && !busy && (
          <div className="article-ai-modify__empty">
            <Bot aria-hidden="true" size={22} />
            <p>还没有修改记录</p>
            <small>候选只写入编辑器，确认保存后才会形成新版本。</small>
          </div>
        )}

        {records.map((record) => (
          <article className="article-ai-modify__record" key={record.id}>
            <header>
              <span>{record.scope}</span>
              <time>{record.createdAt}</time>
            </header>
            <strong>{record.instruction}</strong>
            {record.summary && <p>{record.summary}</p>}
            <details>
              <summary>查看候选</summary>
              <pre>{record.candidate}</pre>
            </details>
            <footer>
              <span className={record.status === "applied" ? "is-applied" : undefined}>
                {record.status === "applied" ? "已写入编辑器" : "待确认"}
              </span>
              {record.status === "ready" && (
                <button className="text-button" onClick={() => applyRecord(record)} type="button">
                  应用到编辑器
                </button>
              )}
            </footer>
          </article>
        ))}

        {busy && (
          <div className="article-ai-modify__activity">
            <LoaderCircle aria-hidden="true" className="spin" size={14} />
            <span>正在生成修改候选……</span>
          </div>
        )}
        {error && <p className="article-ai-modify__error" role="alert">{error}</p>}
      </div>

      <footer className="article-ai-modify__composer">
        <div className="article-ai-modify__selects">
          <select
            aria-label="修改范围"
            disabled={Boolean(selection?.text.trim())}
            onChange={() => undefined}
            value={selection?.text.trim() ? "selection" : "whole"}
          >
            <option value="whole">整篇文章</option>
            <option value="selection">选中内容</option>
          </select>
          <select aria-label="写作模型" onChange={(event) => setProfileId(event.target.value)} value={profileId}>
            {profiles.length > 0 ? profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} · {profile.modelId}{profile.keyConfigured ? "" : "（缺少密钥）"}
              </option>
            )) : <option value="">未配置模型</option>}
          </select>
        </div>
        <textarea
          aria-label="AI 修改要求"
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="说说你想怎么改"
          rows={3}
          value={instruction}
        />
        <div className="article-ai-modify__actions">
          <span>Ctrl + Enter 发送</span>
          <button
            aria-label="发送 AI 修改要求"
            className="icon-button article-ai-modify__send"
            disabled={busy}
            onClick={() => void submit()}
            type="button"
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
          </button>
        </div>
      </footer>
    </aside>
  );
}

/* ---------------- AI 改写对话框（蓝本 RewriteService：只出候选，用户确认后应用） ---------------- */

interface RewriteDialogProps {
  articleId: string;
  markdown: string;
  onClose: () => void;
  onApply: (nextMarkdown: string, summary: string) => void;
  /** 蓝本 RewriteService：只针对选中文本出候选（不传则整篇）。 */
  initialSelection?: { start: number; end: number; text: string } | null;
}

export function RewriteDialog({ articleId, markdown, onClose, onApply, initialSelection = null }: RewriteDialogProps) {
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [candidate, setCandidate] = useState<{ replacements: string[]; summary: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    if (!instruction.trim()) {
      setError("请填写修改要求。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const run = await api.post<{ id: string }>("/agent-runs/rewrite-candidate", {
        articleId,
        markdown,
        instruction: instruction.trim(),
        selectedTexts: initialSelection?.text.trim() ? [initialSelection.text] : [],
      });
      // 轮询直到完成（改写通常只有一轮模型调用）
      for (let i = 0; i < 600; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        const status = await api.get<{ status: string }>(`/agent-runs/${run.data.id}`);
        if (status.data.status === "completed") {
          const events = await api.get<{ events: Array<{ type: string; payload: Record<string, unknown> }> }>(
            `/agent-runs/${run.data.id}/events?after=0`,
          );
          const ready = events.data.events.find((e) => e.type === "rewrite.candidate_ready");
          if (ready) {
            setCandidate({
              replacements: ready.payload.replacements as string[],
              summary: ready.payload.summary as string,
            });
          } else {
            setError("运行完成但没有候选结果。");
          }
          setBusy(false);
          return;
        }
        if (status.data.status === "failed" || status.data.status === "stopped") {
          setError("改写运行失败或已停止。");
          setBusy(false);
          return;
        }
      }
      setError("改写超时。");
      setBusy(false);
    } catch {
      setError("发起改写失败（需要后端配置 LLM Key）。");
      setBusy(false);
    }
  };

  const replaceWhole = (replacement: string) => onApply(replacement, candidate?.summary ?? "");

  return (
    <div className="studio-modal__scrim" onClick={onClose} role="presentation">
      <section
        aria-label="AI 改写"
        aria-modal="true"
        className="creation-picker__dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        style={{ maxWidth: 560 }}
      >
        <header>
          <div>
            <span className="page-kicker">AI 改写</span>
            <h2>只出候选，确认后才应用</h2>
          </div>
          <button aria-label="关闭" className="icon-button" onClick={onClose} type="button">
            ×
          </button>
        </header>
        {candidate ? (
          <div style={{ display: "grid", gap: 12 }}>
            <p className="muted">{candidate.summary}</p>
            <div className="field">
              <label>改写结果（整篇替换候选）</label>
              <textarea readOnly rows={12} value={candidate.replacements[0] ?? ""} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="button button--primary"
                onClick={() => replaceWhole(candidate.replacements[0] ?? "")}
                type="button"
              >
                应用到编辑器
              </button>
              <button className="button button--quiet" onClick={() => setCandidate(null)} type="button">
                重新改写
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            <div className="field">
              <label htmlFor="rw-instruction">修改要求</label>
              <textarea
                id="rw-instruction"
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="例如：把开头改得更具体，去掉营销套话，保持事实不变"
                rows={4}
                value={instruction}
              />
            </div>
            {error && <p className="workflow-task__failure">{error}</p>}
            <div>
              <button className="button button--primary" disabled={busy} onClick={() => void start()} type="button">
                {busy ? "生成候选中……" : "生成改写候选"}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/* ---------------- 编辑助手抽屉：会话持久化 + 模型档案切换 ---------------- */

interface AssistantModelProfile {
  id: string;
  name: string;
  modelId: string;
  keyConfigured: boolean;
}

interface AssistantSessionMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  profileId?: string | null;
  createdAt?: string;
}

interface AssistantSessionView {
  id: string;
  articleId: string | null;
  title: string;
  activeProfileId: string | null;
  messages: AssistantSessionMessage[];
}

export function AssistantDrawer({
  articleId,
  markdown,
  selection = null,
  onApplySelection,
  onClose,
}: {
  articleId: string;
  markdown: string;
  selection?: { start: number; end: number; text: string } | null;
  onApplySelection?: (replacement: string) => void;
  onClose?: () => void;
}) {
  const [session, setSession] = useState<AssistantSessionView | null>(null);
  const [messages, setMessages] = useState<AssistantSessionMessage[]>([]);
  const [profiles, setProfiles] = useState<AssistantModelProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string>("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const attachmentsRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [pendingSuggestion, setPendingSuggestion] = useState<string | null>(null);
  // 悬浮小窗位置：跨会话记忆，拖拽时实时写入 state。
  const [position, setPosition] = usePersistentState("opw.article-assistant-position", {
    left: Math.max(12, window.innerWidth - 372),
    top: 88,
  });
  const dragStartRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  useEffect(() => {
    const clamp = () => setPosition((current) => ({
      left: Math.min(Math.max(12, current.left), Math.max(12, window.innerWidth - 120)),
      top: Math.min(Math.max(12, current.top), Math.max(12, window.innerHeight - 80)),
    }));
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [setPosition]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, busy]);

  const beginWindowDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    dragStartRef.current = { x: event.clientX, y: event.clientY, left: position.left, top: position.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveWindow = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = dragStartRef.current;
    if (!start) return;
    const nextLeft = start.left + event.clientX - start.x;
    const nextTop = start.top + event.clientY - start.y;
    setPosition({
      left: Math.min(Math.max(12, nextLeft), Math.max(12, window.innerWidth - 120)),
      top: Math.min(Math.max(12, nextTop), Math.max(12, window.innerHeight - 80)),
    });
  };
  const endWindowDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragStartRef.current) event.currentTarget.releasePointerCapture(event.pointerId);
    dragStartRef.current = null;
  };

  useEffect(() => {
    let mounted = true;
    const bootstrap = async () => {
      try {
        const [profilesRes, sessionsRes] = await Promise.all([
          api.get<{ profiles: AssistantModelProfile[] }>("/settings/profiles"),
          api.get<{ sessions: AssistantSessionView[] }>(
            `/assistant/sessions?articleId=${encodeURIComponent(articleId)}`,
          ),
        ]);
        if (!mounted) return;
        setProfiles(profilesRes.data.profiles ?? []);
        const existing = sessionsRes.data.sessions?.[0] ?? null;
        if (existing) {
          setSession(existing);
          setMessages(existing.messages ?? []);
          setActiveProfileId(existing.activeProfileId ?? "");
        } else {
          const created = await api.post<AssistantSessionView>("/assistant/sessions", {
            articleId,
            title: "文章编辑助手",
          });
          if (!mounted) return;
          setSession(created.data);
          setMessages([]);
        }
      } catch {
        if (mounted) setError("助手会话加载失败；仍可发送，但本次不会持久化。");
      }
    };
    void bootstrap();
    return () => {
      mounted = false;
    };
  }, [articleId]);

  const send = async (options?: { mode?: "chat" | "rewrite"; message?: string }) => {
    const text = (options?.message ?? input).trim();
    const mode = options?.mode ?? "chat";
    if (!text || busy) return;
    const optimistic: AssistantSessionMessage = {
      id: `local-${Date.now()}`, role: "user", text,
    };
    setMessages((current) => [...current, optimistic]);
    setInput("");
    setAttachments([]);
    setBusy(true);
    setError(null);
    try {
      if (session) {
        const res = await api.post<AssistantSessionView & { reply: string }>(
          `/assistant/sessions/${session.id}/chat`,
          { message: text, articleContext: markdown, profileId: activeProfileId || null, mode, attachments },
        );
        setSession({
          ...res.data,
          messages: res.data.messages ?? [],
        });
        setMessages(res.data.messages ?? []);
        setActiveProfileId(res.data.activeProfileId ?? activeProfileId);
        if (mode === "rewrite") setPendingSuggestion(res.data.reply);
      } else {
        const res = await api.post<{ reply: string }>("/assistant/chat", {
          messages: [{ role: "user", text }],
          articleContext: markdown,
          profileId: activeProfileId || null,
          mode,
          attachments,
        });
        setMessages((current) => [
          ...current,
          { id: `assistant-${Date.now()}`, role: "assistant", text: res.data.reply },
        ]);
        if (mode === "rewrite") setPendingSuggestion(res.data.reply);
      }
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "助手调用失败（需要后端配置模型 Key）。");
    } finally {
      setBusy(false);
    }
  };

  const addAttachments = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const added: string[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > 4 * 1024 * 1024) { setError("「" + file.name + "」超过 4MB，已跳过。"); continue; }
      if (attachments.length + added.length >= 4) break;
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      added.push(dataUrl);
    }
    setAttachments((current) => [...current, ...added].slice(0, 4));
    if (attachmentsRef.current) attachmentsRef.current.value = "";
  };

  const clearSession = async () => {
    if (!session || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/assistant/sessions/${session.id}`);
      const created = await api.post<AssistantSessionView>("/assistant/sessions", {
        articleId,
        title: "文章编辑助手",
      });
      setSession(created.data);
      setMessages([]);
    } catch {
      setError("清空会话失败。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside
      aria-label="编辑助手"
      className="article-assistant-window"
      style={{ left: position.left, top: position.top }}
    >
      {/* 头部：图标 + 标题 + 模型选择 + 关闭 */}
      <header className="article-assistant-window__head">
        <button
          aria-label="拖动编辑助手"
          className="article-assistant-window__drag"
          onPointerDown={beginWindowDrag}
          onPointerMove={moveWindow}
          onPointerUp={endWindowDrag}
          type="button"
        >
          <span className="article-assistant-window__bot-icon">
            <Bot aria-hidden="true" size={14} />
          </span>
          <span className="article-assistant-window__title">
            <strong>AI 编辑助手</strong>
            <small>选中正文片段可精准改写 · 全文对话可整体调整</small>
          </span>
        </button>
        <select
          aria-label="助手模型"
          className="article-assistant-window__model-select"
          disabled={profiles.length === 0}
          onChange={(event) => setActiveProfileId(event.target.value)}
          value={activeProfileId || ""}
        >
          <option value="">默认</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}{profile.keyConfigured ? "" : "（无密钥）"}
            </option>
          ))}
        </select>
        {onClose && (
          <button aria-label="关闭编辑助手" className="icon-button" onClick={onClose} type="button">
            <X size={14} />
          </button>
        )}
      </header>

      {/* 作用域指示：整篇文章 vs 已选片段 */}
      <div className="article-assistant-window__scope-bar">
        {selection?.text.trim() ? (
          <span className="article-assistant-window__scope-badge article-assistant-window__scope-badge--selection">
            已选中 {selection.text.length} 字 · 可精准改写
          </span>
        ) : (
          <span className="article-assistant-window__scope-badge">
            全文模式 · AI 会阅读整篇文章
          </span>
        )}
        {session && (
          <button
            aria-label="清空会话"
            className="article-assistant-window__clear-btn"
            disabled={busy}
            onClick={() => void clearSession()}
            type="button"
          >
            清空会话
          </button>
        )}
      </div>

      {/* 消息列表 */}
      <div className="article-assistant-window__messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="article-assistant-window__empty">
            <p className="article-assistant-window__empty-hint">
              试试这些快捷指令，或直接输入你的要求：
            </p>
            <div className="article-assistant-window__chips">
              {[
                "帮我检查开头是否有营销套话",
                "润色全文，让语气更自然",
                "检查段落之间的过渡是否顺畅",
                "帮我精简全文，删去冗余",
              ].map((chip) => (
                <button
                  className="article-assistant-window__chip"
                  disabled={busy}
                  key={chip}
                  onClick={() => { setInput(chip); }}
                  type="button"
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message) => (
          <div
            className={`article-assistant-window__msg article-assistant-window__msg--${message.role}`}
            key={message.id}
          >
            <span className="article-assistant-window__msg-icon">
              {message.role === "user" ? "你" : <Bot aria-hidden="true" size={12} />}
            </span>
            <div
              className="article-assistant-window__msg-body"
              dangerouslySetInnerHTML={
                message.role === "assistant"
                  ? { __html: renderMarkdown(message.text) }
                  : undefined
              }
            >
              {message.role === "user" ? message.text : null}
            </div>
          </div>
        ))}
        {busy && (
          <div className="article-assistant-window__msg article-assistant-window__msg--assistant">
            <span className="article-assistant-window__msg-icon"><Bot aria-hidden="true" size={12} /></span>
            <div className="article-assistant-window__msg-body article-assistant-window__msg-body--thinking">
              <LoaderCircle className="spin" size={13} /> 思考中……
            </div>
          </div>
        )}
        {error && <p className="article-assistant-window__error">{error}</p>}
      </div>

      {/* 改写建议卡片 */}
      {pendingSuggestion && (
        <div className="article-assistant-window__suggestion">
          <div className="article-assistant-window__suggestion-head">
            <PencilLine aria-hidden="true" size={13} />
            <strong>改写建议</strong>
            {selection?.text.trim() && (
              <small>替换选中的 {selection.text.length} 字</small>
            )}
          </div>
          <div
            className="article-assistant-window__suggestion-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(pendingSuggestion) }}
          />
          <div className="article-assistant-window__suggestion-actions">
            <button
              className="button button--primary article-assistant-window__apply-btn"
              onClick={() => { onApplySelection?.(pendingSuggestion); setPendingSuggestion(null); }}
              type="button"
            >
              应用到文章
            </button>
            <button
              className="button button--quiet article-assistant-window__ignore-btn"
              onClick={() => setPendingSuggestion(null)}
              type="button"
            >
              忽略
            </button>
          </div>
        </div>
      )}

      {/* 输入区 */}
      <div className="article-assistant-window__composer">
        {attachments.length > 0 && (
          <div className="article-assistant-window__attachments">
            {attachments.map((dataUrl, index) => (
              <div className="article-assistant-window__attachment" key={index}>
                <img alt={`附件 ${index + 1}`} src={dataUrl} />
                <button
                  aria-label={`移除附件 ${index + 1}`}
                  className="article-assistant-window__attachment-remove"
                  onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="article-assistant-window__input-row">
          <textarea
            className="article-assistant-window__textarea"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder={selection?.text.trim() ? "说明如何修改选中的片段……" : "向 AI 描述你想要的修改……"}
            rows={2}
            value={input}
          />
          <div className="article-assistant-window__tools">
            <button
              aria-label="附加图片"
              className="article-assistant-window__tool-btn"
              disabled={attachments.length >= 4}
              onClick={() => attachmentsRef.current?.click()}
              title="附加图片（最多 4 张，需模型支持图片理解）"
              type="button"
            >
              <ImagePlus aria-hidden="true" size={15} />
            </button>
            <input
              accept="image/*"
              hidden
              multiple
              onChange={(event) => void addAttachments(event.target.files)}
              ref={attachmentsRef}
              type="file"
            />
            {selection?.text.trim() && (
              <button
                aria-label="改写选中片段"
                className="article-assistant-window__tool-btn"
                disabled={busy || !input.trim()}
                onClick={() => void send({ mode: "rewrite", message: input.trim() || "润色这段文字，保持原有语气" })}
                title="改写选中片段"
                type="button"
              >
                <PencilLine aria-hidden="true" size={15} />
              </button>
            )}
            <button
              aria-label={busy ? "思考中……" : "发送"}
              className="article-assistant-window__send-btn"
              disabled={busy || !input.trim()}
              onClick={() => void send()}
              type="button"
            >
              {busy ? <LoaderCircle className="spin" size={15} /> : <Send aria-hidden="true" size={15} />}
            </button>
          </div>
        </div>
        <small className="article-assistant-window__hint">
          Enter 发送 · Shift+Enter 换行 · 上下文：当前编辑器正文
        </small>
      </div>
    </aside>
  );
}


/* ---------------- 版本历史抽屉：列表 + 恢复旧版本为新修订 ---------------- */

interface RevisionListItem {
  revisionId: string;
  revisionNumber: number;
  title: string;
  contentHash: string;
  createdAt: string;
  reason: string;
  isCurrent: boolean;
}

export function RevisionHistoryDrawer({
  articleId,
  onClose,
  onRestored,
}: {
  articleId: string;
  onClose: () => void;
  onRestored?: () => void;
}) {
  const [revisions, setRevisions] = useState<RevisionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    api
      .get<{ revisions: RevisionListItem[] }>(`/articles/${encodeURIComponent(articleId)}/revisions`)
      .then((res) => {
        if (mounted) setRevisions(res.data.revisions ?? []);
      })
      .catch(() => {
        if (mounted) setError("无法加载版本历史。");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [articleId]);

  const restore = async (revisionId: string) => {
    setRestoring(revisionId);
    setError(null);
    try {
      await api.post(`/articles/${encodeURIComponent(articleId)}/revisions/${revisionId}/restore`);
      onRestored?.();
      onClose();
    } catch {
      setError("恢复失败：文章可能已被修改，请刷新后重试。");
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div className="studio-modal__scrim" onClick={onClose} role="presentation">
      <section
        aria-label="版本历史"
        aria-modal="true"
        className="creation-picker__dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        style={{ maxWidth: 620 }}
      >
        <header>
          <div>
            <span className="page-kicker">历史</span>
            <h2>版本记录</h2>
          </div>
          <button aria-label="关闭" className="icon-button" onClick={onClose} type="button">×</button>
        </header>
        <div style={{ display: "grid", gap: 8, maxHeight: 480, overflowY: "auto" }}>
          {loading && <p className="muted">加载中……</p>}
          {!loading && revisions.length === 0 && <p className="muted">还没有版本记录。</p>}
          {revisions.map((revision) => (
            <div className="panel" key={revision.revisionId} style={{ margin: 0, padding: 10 }}>
              <div style={{ alignItems: "center", display: "flex", gap: 8, justifyContent: "space-between" }}>
                <strong>#{revision.revisionNumber} {revision.title}</strong>
                {revision.isCurrent ? (
                  <span className="article-status article-status--published">当前</span>
                ) : (
                  <button
                    className="button button--quiet"
                    disabled={restoring === revision.revisionId}
                    onClick={() => void restore(revision.revisionId)}
                    type="button"
                  >
                    {restoring === revision.revisionId ? "恢复中……" : "恢复"}
                  </button>
                )}
              </div>
              <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
                {new Date(revision.createdAt).toLocaleString()} · {revision.reason || "无说明"}
              </p>
            </div>
          ))}
          {error && <p className="workflow-task__failure">{error}</p>}
        </div>
      </section>
    </div>
  );
}



