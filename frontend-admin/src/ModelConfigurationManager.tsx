import { forwardRef, useEffect, useImperativeHandle, useState, type FormEvent } from "react";
import { Plus, Star, Trash2, X } from "lucide-react";
import { api } from "./api";

export type ModelKind = "image" | "embedding" | "rerank";
export interface ConfigurationManagerHandle { toggleCurrent: () => void }
interface Configuration { id: string; name: string; baseUrl: string; modelId: string; timeoutSeconds: number }
interface Catalog { profiles: Configuration[]; activeId: string | null }
const labels: Record<ModelKind, string> = { image: "生图模型", embedding: "资料检索模型", rerank: "检索排序模型" };
const empty = (kind: ModelKind) => ({ name: "", baseUrl: "", modelId: "", timeoutSeconds: kind === "image" ? 180 : kind === "rerank" ? 3 : 30 });
function errorMessage(error: unknown): string {
  const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  return typeof detail === "string" ? detail : "操作失败，请检查输入后重试。";
}

export const ModelConfigurationManager = forwardRef<ConfigurationManagerHandle, { kind: ModelKind; revision: number; visible: boolean; onChanged: () => Promise<void> }>(function ModelConfigurationManager({ kind, revision, visible, onChanged }, ref) {
  const [catalog, setCatalog] = useState<Catalog>({ profiles: [], activeId: null });
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(empty(kind));
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const label = labels[kind];
  const endpoint = `/settings/model-configs/${kind}`;
  const reload = async () => {
    const result = await api.get<Catalog>(endpoint);
    setCatalog(result.data);
  };
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    void api.get<Catalog>(endpoint).then(result => { if (!cancelled) { setCatalog(result.data); setError(""); } })
      .catch(error => { if (!cancelled) setError(errorMessage(error)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [endpoint, visible, revision]);
  const cancel = () => { if (busy) return; setOpen(false); setEditing(null); setDraft(empty(kind)); setError(""); setMessage(""); };
  const edit = (profile?: Configuration) => {
    if (busy || loading) return;
    setEditing(profile?.id ?? null);
    setDraft(profile ? { name: profile.name, baseUrl: profile.baseUrl, modelId: profile.modelId, timeoutSeconds: profile.timeoutSeconds } : empty(kind));
    setError(""); setMessage(""); setOpen(true);
  };
  useImperativeHandle(ref, () => ({ toggleCurrent: () => {
    if (open) cancel();
    else edit(catalog.profiles.find(p => p.id === catalog.activeId));
  } }));
  useEffect(() => { if (!visible && !busy) { setOpen(false); setEditing(null); setDraft(empty(kind)); setError(""); setMessage(""); } }, [visible, busy, kind]);
  useEffect(() => {
    if (!open || !visible) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) { event.preventDefault(); cancel(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, visible, busy]);
  const mutate = async (action: () => Promise<unknown>, success: string, close = false) => {
    setBusy(true); setError(""); setMessage("");
    try {
      await action();
      if (close) { setOpen(false); setEditing(null); setDraft(empty(kind)); }
      await reload(); await onChanged(); setMessage(success);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    const payload = { ...draft, name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), modelId: draft.modelId.trim() };
    if (!payload.name || !payload.modelId || (kind !== "embedding" && !payload.baseUrl)) { setError("请填写方案名称、模型名称和服务地址。"); return; }
    void mutate(() => editing ? api.patch(`${endpoint}/${editing}`, payload) : api.post(endpoint, payload), editing ? "配置已保存。" : "新配置已添加。", true);
  };
  return <div className="profile-list profile-list--embedded model-config-manager">
    <div className="section-head section-head--compact"><h2>{label}配置列表</h2><button className="quiet" disabled={busy || loading} onClick={() => edit()} type="button"><Plus size={14} />新增配置</button></div>
    {loading && <p className="muted">正在读取配置...</p>}
    {!loading && catalog.profiles.length === 0 && <p className="muted">尚无已保存配置，点击“新增配置”开始。</p>}
    {catalog.profiles.map(profile => <div className={`profile${profile.id === catalog.activeId ? " active" : ""}`} key={profile.id}>
      <div className="profile-summary"><strong>{profile.id === catalog.activeId && <Star size={13} />} {profile.name}{profile.id === catalog.activeId && <span className="profile-badge">使用中</span>}</strong><small>{profile.baseUrl || "沿用文本模型服务地址"} · {profile.modelId}{kind !== "embedding" && ` · ${profile.timeoutSeconds}s`}</small></div>
      <div className="actions"><button className="quiet" disabled={busy || loading} onClick={() => edit(profile)} type="button">编辑配置</button><button className="quiet" disabled={busy || loading || profile.id === catalog.activeId} onClick={() => void mutate(() => api.post(`${endpoint}/${profile.id}/activate`), "默认配置已切换。")} type="button">设为默认</button><button aria-label={`删除配置 ${profile.name}`} className="quiet" disabled={busy || loading || profile.id === catalog.activeId} onClick={() => void mutate(() => api.delete(`${endpoint}/${profile.id}`), "配置已删除。")} type="button"><Trash2 size={14} /></button></div>
    </div>)}
    {open && <form aria-label={`${editing ? "编辑" : "新增"}${label}配置`} className="admin-form config-form" onSubmit={save}>
      <div className="config-form-heading"><h3>{editing ? "编辑" : "新增"}{label}配置</h3><button aria-label="关闭配置表单" className="quiet" disabled={busy} onClick={cancel} type="button"><X size={15} /></button></div>
      <label><span>方案名称</span><input autoFocus disabled={busy} maxLength={120} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="为配置取一个易于识别的名称" required value={draft.name} /></label>
      <label><span>服务地址</span><input disabled={busy} maxLength={500} onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} placeholder={kind === "embedding" ? "留空沿用文本模型服务地址" : "https://api.example.com/v1"} required={kind !== "embedding"} value={draft.baseUrl} /></label>
      <label><span>模型名称</span><input disabled={busy} maxLength={200} onChange={e => setDraft({ ...draft, modelId: e.target.value })} placeholder="服务提供方的模型名称" required value={draft.modelId} /></label>
      {kind !== "embedding" && <label><span>等待时限（秒）</span><input disabled={busy} min={1} max={kind === "rerank" ? 120 : 1800} onChange={e => setDraft({ ...draft, timeoutSeconds: Number(e.target.value) })} required type="number" value={draft.timeoutSeconds} /></label>}
      <p className="muted config-form-hint">{kind === "image" ? "访问密钥沿用生图密钥设置；未设置时沿用文本模型密钥。" : kind === "embedding" ? "访问密钥沿用文本模型密钥。" : "请填写兼容 /rerank 接口的排序服务地址。"}新增配置不会覆盖已有配置。</p>
      <div className="config-form-actions"><button className="quiet" disabled={busy} onClick={cancel} type="button">取消</button><button className="primary" disabled={busy} type="submit">{busy ? "保存中..." : "保存配置"}</button></div>
    </form>}
    {error && <div className="error" role="alert">{error}</div>}{message && <div className="success" role="status">{message}</div>}
  </div>;
});
