import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, LoaderCircle, LogOut, Plus, RefreshCw, Settings2, Star, Trash2, XCircle } from "lucide-react";
import { api } from "./api";
import AdminLoginPage from "./AdminLoginPage";
import { AdminAuthProvider, useAdminAuth } from "./AuthContext";

interface ModelStatus {
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
  keySource: "db" | "none";
  keyHint: string;
  timeoutSeconds: number;
  profileId: string | null;
  profileName: string | null;
}

interface Capabilities { maxTokens: number; contextWindow: number; reasoning: boolean; vision: boolean; thinkingLevel: string; }
const defaultCapabilities: Capabilities = { maxTokens: 16384, contextWindow: 128000, reasoning: false, vision: false, thinkingLevel: "auto" };

interface ProfileOut {
  capabilities?: Capabilities;
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  modelId: string;
  keyConfigured: boolean;
  keySource: "db" | "none";
  keyHint: string;
  timeoutSeconds: number;
  isDefault: boolean;
}

const emptyForm = {
  name: "",
  provider: "custom",
  baseUrl: "",
  modelId: "",
  timeoutSeconds: 120,
  capabilities: defaultCapabilities,
};

interface ImageStatus {
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
  keySource: "db" | "none";
  keyHint: string;
  timeoutSeconds: number;
  source: "db" | "fallback";
}

const emptyImageForm = {
  baseUrl: "",
  modelId: "",
  timeoutSeconds: 180,
};

interface RagConfig {
  embeddingBaseUrl: string;
  embeddingModel: string;
  rerankBaseUrl: string;
  rerankModel: string;
  rerankTimeoutSeconds: number;
  embeddingKeyConfigured: boolean;
  source: "db" | "default";
}


const VIEWS = [
  { view: "text", title: "文本模型", desc: "用于文章撰写、修改和内容检查。" },
  { view: "image", title: "生图模型", desc: "文章配图使用的图像生成模型。" },
  { view: "embedding", title: "资料检索模型", desc: "理解参考资料，帮助写作时找到相关内容。" },
  { view: "rerank", title: "检索排序模型", desc: "优先选出与主题相关的资料，可按需启用。" },
] as const;


function ModelPanel({ id, hidden, title, actions, children }: { id: string; hidden: boolean; title: string; actions: ReactNode; children: ReactNode }) {
  return <section className="admin-card model-panel" id={id} hidden={hidden}>
    <div className="section-head"><h2>{title}</h2><div className="panel-actions">{actions}</div></div>
    {children}
  </section>;
}

function connectionError(detail: unknown): string {
  if (typeof detail !== "string") return "连接失败，请检查服务地址、模型名称和访问密钥。";
  if (/401|403|api.?key|unauthorized/i.test(detail)) return "访问验证失败，请检查密钥及模型使用权限。";
  if (/404|does not support|not found/i.test(detail)) return "当前服务不支持所选模型，请检查服务地址和模型名称。";
  if (/timeout|timed out|超时/i.test(detail)) return "服务响应超时，请稍后重试。";
  return "暂时无法连接，请检查配置或联系服务提供方。";
}

function AiConfigPage() {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [profiles, setProfiles] = useState<ProfileOut[]>([]);
  const [image, setImage] = useState<ImageStatus | null>(null);
  const [imageForm, setImageForm] = useState(emptyImageForm);
  const [showImageForm, setShowImageForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ view: string; name: string } | null>(null);
  const [activeView, setActiveView] = useState("text");
  const busyAction = pendingAction?.view === activeView ? pendingAction.name : null;
  function setBusyAction(name: string | null) { setPendingAction(name ? { view: activeView, name } : null); }
  const [notices, setNotices] = useState<Record<string, { message?: string | null; error?: string | null }>>({});
  const message = notices[activeView]?.message;
  const error = notices[activeView]?.error;
  function setMessage(value: string | null) { setNotices(current => ({ ...current, [activeView]: { message: value } })); }
  function setError(value: string | null) { setNotices(current => ({ ...current, [activeView]: value ? { error: value } : { ...current[activeView], error: null } })); }
  const [llmKeyInput, setLlmKeyInput] = useState("");
  const [imageKeyInput, setImageKeyInput] = useState("");
  const [profileKeyInputs, setProfileKeyInputs] = useState<Record<string, string>>({});
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [showDiscoveredModels, setShowDiscoveredModels] = useState(false);
  const [rag, setRag] = useState<RagConfig | null>(null);
  const [ragForm, setRagForm] = useState({ embeddingBaseUrl: "", embeddingModel: "", rerankBaseUrl: "", rerankModel: "", rerankTimeoutSeconds: 3 });
  const [showEmbeddingForm, setShowEmbeddingForm] = useState(false);
  const [showRerankForm, setShowRerankForm] = useState(false);
  const { logout, user } = useAdminAuth();

  const load = useCallback(async () => {
    try {
      const [statusRes, profilesRes, imageRes, ragRes] = await Promise.all([
        api.get<ModelStatus>("/settings/model"),
        api.get<{ profiles: ProfileOut[] }>("/settings/profiles"),
        api.get<ImageStatus>("/settings/image"),
        api.get<RagConfig>("/settings/rag"),
      ]);
      setStatus(statusRes.data);
      setProfiles(profilesRes.data.profiles);
      setImage(imageRes.data);
      setRag(ragRes.data);
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? connectionError(detail) : "无法读取 AI 配置。");
    }
  }, [activeView]);

  useEffect(() => {
    void load();
  }, [load]);

  const createProfile = async () => {
    if (!form.name.trim() || !form.baseUrl.trim() || !form.modelId.trim()) {
      setError("方案名称 / 服务地址 / 模型名称 必填。");
      return;
    }
    setBusy(true);
    setBusyAction("createProfile");
    setError(null);
    try {
      if (editingProfileId) await api.patch(`/settings/profiles/${editingProfileId}`, form);
      else await api.post("/settings/profiles", { ...form, isDefault: profiles.length === 0 });
      setEditingProfileId(null);
      setForm(emptyForm);
      setShowForm(false);
      await load();
      setMessage("文本模型配置已保存。");
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? connectionError(detail) : "保存失败。");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const activate = async (id: string) => {
    setBusy(true);
    setBusyAction("activate");
    setError(null);
    try {
      await api.post(`/settings/profiles/${id}/activate`);
      await load();
      setMessage("已切换当前方案。");
    } catch {
      setError("设为默认失败。");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setBusyAction("remove");
    setError(null);
    try {
      await api.delete(`/settings/profiles/${id}`);
      await load();
      setMessage("方案已删除。");
    } catch {
      setError("删除失败。");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const discoverModels = async () => {
    setBusy(true);
    setBusyAction("discoverModels");
    setError(null);
    setMessage(null);
    try {
      const res = await api.get<{ models: string[] }>("/settings/models", { timeout: 120000 });
      setDiscoveredModels(res.data.models);
      setShowDiscoveredModels(true);
      setMessage(`已发现 ${res.data.models.length} 个模型。`);
    } catch (err) {
      if ((err as { code?: string })?.code === "ECONNABORTED") {
        setError("模型发现请求超时（服务超过 120 秒未响应）。");
        return;
      }
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? connectionError(detail) : "模型设置拉取失败。");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const test = async () => {
    setBusy(true);
    setBusyAction("test");
    setMessage(null);
    setError(null);
    try {
      const res = await api.post<{ latencyMs: number; model: string }>("/settings/model/test", null, { timeout: 120000 });
      setMessage(`连接成功：${res.data.model} · ${res.data.latencyMs} 毫秒`);
    } catch (err) {
      if ((err as { code?: string })?.code === "ECONNABORTED") {
        setError("连通测试请求超时（服务超过 120 秒未响应）。");
        return;
      }
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? connectionError(detail) : "连通测试失败。");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const openImageForm = () => {
    if (image && image.source === "db") {
      setImageForm({
        baseUrl: image.baseUrl,
        modelId: image.model,
        timeoutSeconds: image.timeoutSeconds,
      });
    } else {
      setImageForm(emptyImageForm);
    }
    setShowImageForm(true);
  };

  const saveImage = async () => {
    if (!imageForm.baseUrl.trim() || !imageForm.modelId.trim()) {
      setError("生图服务地址 / 模型名称 必填。");
      return;
    }
    setBusy(true);
    setBusyAction("saveImage");
    setError(null);
    try {
      await api.put<ImageStatus>("/settings/image", imageForm);
      setShowImageForm(false);
      await load();
      setMessage("生图配置已保存。");
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? connectionError(detail) : "生图配置保存失败。");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const resetImage = async () => {
    setBusy(true);
    setBusyAction("resetImage");
    setError(null);
    try {
      await api.delete<ImageStatus>("/settings/image");
      setShowImageForm(false);
      await load();
      setMessage("已使用默认配置。");
    } catch {
      setError("重置失败。");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const testImage = async () => {
    setBusy(true);
    setBusyAction("testImage");
    setMessage(null);
    setError(null);
    try {
      const res = await api.post<{ latencyMs: number; model: string }>("/settings/image/test", null, { timeout: 120000 });
      setMessage(`连接成功：${res.data.model} · ${res.data.latencyMs} 毫秒`);
    } catch (err) {
      if ((err as { code?: string })?.code === "ECONNABORTED") {
        setError("生图测试请求超时（服务超过 120 秒未响应）。");
        return;
      }
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? connectionError(detail) : "生图连通测试失败。");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const saveLlmKey = async () => {
    const value = llmKeyInput.trim();
    if (value.length < 4) {
      setError("密钥长度至少 4 位。");
      return;
    }
    setBusy(true);
    setBusyAction("saveLlmKey");
    setError(null);
    try {
      await api.put(status?.profileId ? `/settings/profiles/${status.profileId}/key` : "/settings/llm/key", { apiKey: value });
      setLlmKeyInput("");
      await load();
      setMessage("当前模型访问密钥已保存。");
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? connectionError(detail) : "密钥保存失败。");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const removeLlmKey = async () => {
    setBusy(true);
    setBusyAction("removeLlmKey");
    setError(null);
    try {
      await api.delete(status?.profileId ? `/settings/profiles/${status.profileId}/key` : "/settings/llm/key");
      await load();
      setMessage("独立密钥已移除；如有默认密钥，将自动使用。");
    } catch {
      setError("密钥删除失败。");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const saveImageKey = async () => {
    const value = imageKeyInput.trim();
    if (value.length < 4) {
      setError("密钥长度至少 4 位。");
      return;
    }
    setBusy(true);
    setBusyAction("saveImageKey");
    setError(null);
    try {
      await api.put("/settings/image/key", { apiKey: value });
      setImageKeyInput("");
      await load();
      setMessage("生图访问密钥已保存。");
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? connectionError(detail) : "密钥保存失败。");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const removeImageKey = async () => {
    setBusy(true);
    setBusyAction("removeImageKey");
    setError(null);
    try {
      await api.delete("/settings/image/key");
      await load();
      setMessage("生图密钥已删除，后续调用沿用文本模型密钥。");
    } catch {
      setError("密钥删除失败。");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const saveProfileKey = async (id: string) => {
    const value = (profileKeyInputs[id] ?? "").trim();
    if (value.length < 4) {
      setError("密钥长度至少 4 位。");
      return;
    }
    setBusy(true);
    setBusyAction("saveProfileKey");
    setError(null);
    try {
      await api.put(`/settings/profiles/${id}/key`, { apiKey: value });
      setProfileKeyInputs({ ...profileKeyInputs, [id]: "" });
      await load();
      setMessage("方案访问密钥已保存。");
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? connectionError(detail) : "密钥保存失败。");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const removeProfileKey = async (id: string) => {
    setBusy(true);
    setBusyAction("removeProfileKey");
    setError(null);
    try {
      await api.delete(`/settings/profiles/${id}/key`);
      await load();
      setMessage("方案密钥已删除，调用时沿用全局密钥。");
    } catch {
      setError("密钥删除失败。");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };
  const openProfileForm = () => {
    setEditingProfileId(null);
    setForm(emptyForm);
    setShowForm(!showForm);
  };
  const openRagForm = (kind: "embedding" | "rerank") => {
    if (rag) setRagForm({ embeddingBaseUrl: rag.embeddingBaseUrl, embeddingModel: rag.embeddingModel, rerankBaseUrl: rag.rerankBaseUrl, rerankModel: rag.rerankModel, rerankTimeoutSeconds: rag.rerankTimeoutSeconds });
    if (kind === "embedding") setShowEmbeddingForm(true); else setShowRerankForm(true);
  };
  const openEmbeddingForm = () => openRagForm("embedding");
  const openRerankForm = () => openRagForm("rerank");

  const saveRag = async () => {
    if (!ragForm.embeddingModel.trim()) {
      setError("资料检索模型名称 必填。");
      return;
    }
    setBusy(true);
    setBusyAction("saveRag");
    setError(null);
    try {
      await api.put<RagConfig>("/settings/rag", ragForm);
      setShowEmbeddingForm(false);
      setShowRerankForm(false);
      await load();
      setMessage("资料检索配置已保存。");
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? connectionError(detail) : "检索配置保存失败。");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const testRag = async (target: "embedding" | "rerank") => {
    setBusy(true);
    setBusyAction("testRag");
    setMessage(null);
    setError(null);
    try {
      const res = await api.post<Record<string, { ok: boolean; detail?: string; latencyMs?: number }>>("/settings/rag/test?target=" + target, null, { timeout: 120000 });
      const result = res.data[target];
      if (result.ok) setMessage("连接成功 · " + (result.latencyMs ?? 0) + " 毫秒");
      else setError(connectionError(result.detail));
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? connectionError(detail) : "检索连接测试失败。");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <span className="brand-mark">OP</span>
          <div>
            <strong>Open Publisher</strong>
            <small>管理控制台</small>
          </div>
        </div>
        <nav className="admin-nav" aria-label="模型设置">
          <span className="nav-title">模型设置</span>
          {VIEWS.map((item) => (
            <button
              className={activeView === item.view ? "nav-link active" : "nav-link"}
              key={item.view}
              onClick={() => setActiveView(item.view)}
              type="button"
            >
              {item.title}
            </button>
          ))}
        </nav>
        <div className="admin-user">
          <span>{user?.displayName ?? user?.username}</span>
          <button className="quiet" onClick={() => void logout()} type="button">
            <LogOut size={14} /> 退出登录
          </button>
        </div>
      </aside>
      <main className="admin-main">
        <div className="admin-main-head">
          <h1>{VIEWS.find((v) => v.view === activeView)?.title ?? "管理控制台"}</h1>
          <p className="muted">{VIEWS.find((v) => v.view === activeView)?.desc}</p>
        </div>
      <ModelPanel id="sec-current" hidden={activeView !== "text"} title="文本模型配置" actions={<>
            <button className="quiet" onClick={openProfileForm} type="button"><Settings2 size={14} /> 模型配置</button>
            <button className="quiet" onClick={() => void load()} type="button"><RefreshCw size={14} /> 刷新</button>
            <button className="quiet" disabled={busy} onClick={() => void discoverModels()} type="button">
              {busyAction === "discoverModels" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} 获取模型列表
            </button>
            <button className="primary" disabled={busy} onClick={() => void test()} type="button">
              {busyAction === "test" ? <LoaderCircle className="spin" size={14} /> : <CheckCircle2 size={14} />} 测试连接
            </button>
          </>}>
        {status ? (
          <>
          <div className="config-grid">
            <div><small>服务地址</small><strong>{status.baseUrl}</strong></div>
            <div><small>模型</small><strong>{status.model}</strong></div>
            <div><small>密钥状态</small><strong>{status.keyConfigured ? "已配置" : "未配置"}</strong></div>
            <div><small>当前方案</small><strong>{status.profileName ?? "默认配置"}</strong></div>
            <div><small>等待时限</small><strong>{status.timeoutSeconds}s</strong></div>
          </div>
          {showDiscoveredModels && (
            <div className="admin-form" style={{ marginTop: 12 }}>
              {discoveredModels.length === 0 ? (
                <p className="muted">未发现可用模型，请检查 API 地址与密钥。</p>
              ) : (
                <div className="profile-list">
                  {discoveredModels.map((model) => (
                    <div className="profile-row" key={model}>
                      <span className="mono">{model}</span>
                      <button
                        className="quiet"
                        onClick={() => {
                          setForm((current) => ({ ...current, modelId: model }));
                          setShowForm(true);
                          setNotices(current => ({ ...current, text: { message: `已选择 ${model}，补充服务地址后保存配置。` } }));
                        }}
                        type="button"
                      >
                        创建方案
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="key-editor">
            <input autoComplete="new-password" onChange={(e) => setLlmKeyInput(e.target.value)} placeholder="输入当前模型的访问密钥" type="password" value={llmKeyInput} />
            <button className="primary" disabled={busy} onClick={() => void saveLlmKey()} type="button">保存密钥</button>
            {status.keySource === "db" && (
              <button className="quiet" disabled={busy} onClick={() => void removeLlmKey()} type="button">移除密钥</button>
            )}
          </div>
          {status.keyHint && (
            <p className="muted">当前密钥 {status.keyHint}</p>
          )}
          {showForm && (
            <form
              className="admin-form config-form"
              onSubmit={(event) => {
                event.preventDefault();
                void createProfile();
              }}>
              <label><span>方案名称</span><input onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="方案名称" required value={form.name} /></label>
              <label><span>服务地址</span><input onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="服务地址，例如 https://api.openai.com/v1" required value={form.baseUrl} /></label>
              <label><span>模型名称</span><input onChange={(e) => setForm({ ...form, modelId: e.target.value })} placeholder="模型名称，例如 gpt-4o-mini" required value={form.modelId} /></label>
              <label><span>等待时限（秒）</span><input min={1} onChange={(e) => setForm({ ...form, timeoutSeconds: Number(e.target.value) || 120 })} placeholder="等待时限（秒）" type="number" value={form.timeoutSeconds} /></label>
              <label><span>最大输出 tokens</span><input min={256} max={200000} type="number" value={form.capabilities.maxTokens} onChange={e => setForm({ ...form, capabilities: { ...form.capabilities, maxTokens: Number(e.target.value) } })} /></label>
              <label><span>上下文 tokens</span><input min={1024} max={4000000} type="number" value={form.capabilities.contextWindow} onChange={e => setForm({ ...form, capabilities: { ...form.capabilities, contextWindow: Number(e.target.value) } })} /></label>
              <label className="check-field"><input type="checkbox" checked={form.capabilities.reasoning} onChange={e => setForm({ ...form, capabilities: { ...form.capabilities, reasoning: e.target.checked } })} /><span>启用模型思考</span></label>
              <label><span>思考等级</span><select value={form.capabilities.thinkingLevel} onChange={e => setForm({ ...form, capabilities: { ...form.capabilities, thinkingLevel: e.target.value } })}><option value="auto">自动</option><option value="off">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
              <label className="check-field"><input type="checkbox" checked={form.capabilities.vision} onChange={e => setForm({ ...form, capabilities: { ...form.capabilities, vision: e.target.checked } })} /><span>支持图片理解</span></label>
              <button className="primary" disabled={busy} type="submit">保存配置</button>
            </form>
          )}
          <div className="profile-list profile-list--embedded">
            <div className="section-head section-head--compact">
              <h2>文本模型配置</h2>
              <button className="quiet" onClick={openProfileForm} type="button"><Plus size={14} /> 新增配置</button>
            </div>
            {profiles.map((profile) => (
              <div className={profile.isDefault ? "profile active" : "profile"} key={profile.id}>
                <div className="profile-summary">
                  <strong>{profile.isDefault && <Star color="#f59e0b" size={13} />} {profile.name}{profile.isDefault && <span className="profile-badge">使用中</span>}</strong>
                  <small>最大输出 {profile.capabilities?.maxTokens ?? 16384} tokens · {profile.baseUrl} · {profile.modelId} · {profile.keyConfigured ? `密钥已配置 ${profile.keyHint}` : "使用默认密钥"} · {profile.timeoutSeconds}s</small>
                </div>
                <div className="key-editor">
                  <input autoComplete="new-password" onChange={(e) => setProfileKeyInputs({ ...profileKeyInputs, [profile.id]: e.target.value })} placeholder="输入此配置的访问密钥" type="password" value={profileKeyInputs[profile.id] ?? ""} />
                  <button className="quiet" disabled={busy} onClick={() => void saveProfileKey(profile.id)} type="button">保存密钥</button>
                  {profile.keySource === "db" && (
                    <button className="quiet" disabled={busy} onClick={() => void removeProfileKey(profile.id)} type="button">移除密钥</button>
                  )}
                </div>
                <div className="actions">
                  <button className="quiet" disabled={busy} onClick={() => { setEditingProfileId(profile.id); setForm({ name: profile.name, provider: profile.provider, baseUrl: profile.baseUrl, modelId: profile.modelId, timeoutSeconds: profile.timeoutSeconds, capabilities: { ...defaultCapabilities, ...profile.capabilities } }); setShowForm(true); }} type="button">编辑配置</button>
                  {!profile.isDefault && <button className="quiet" disabled={busy} onClick={() => void activate(profile.id)} type="button">设为默认</button>}
                  <button aria-label={`删除 ${profile.name}`} className="danger" disabled={busy} onClick={() => void remove(profile.id)} type="button"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
            {profiles.length === 0 && <p className="muted">还没有文本模型配置。</p>}
          </div>
          </>
        ) : (
          <p className="muted">加载中...</p>
        )}
      </ModelPanel>

      <ModelPanel id="sec-image" hidden={activeView !== "image"} title="生图模型配置" actions={<>
            <button className="quiet" onClick={openImageForm} type="button"><Settings2 size={14} /> 模型配置</button>
            <button className="quiet" onClick={() => void load()} type="button"><RefreshCw size={14} /> 刷新</button>
            <button className="primary" disabled={busy} onClick={() => void testImage()} type="button">
              {busyAction === "testImage" ? <LoaderCircle className="spin" size={14} /> : <CheckCircle2 size={14} />} 测试连接
            </button>
          </>}>
        {image ? (
          <>
            <div className="config-grid">
              <div><small>服务地址</small><strong>{image.baseUrl}</strong></div>
              <div><small>模型</small><strong>{image.model}</strong></div>
                <div><small>密钥状态</small><strong>{image.keyConfigured ? "已配置" : "未配置"}</strong></div>
              <div><small>配置方式</small><strong>{image.source === "db" ? "独立配置" : "使用默认配置"}</strong></div>
              <div><small>等待时限</small><strong>{image.timeoutSeconds}s</strong></div>
            </div>
            <div className="key-editor">
              <input autoComplete="new-password" onChange={(e) => setImageKeyInput(e.target.value)} placeholder="输入生图访问密钥" type="password" value={imageKeyInput} />
              <button className="primary" disabled={busy} onClick={() => void saveImageKey()} type="button">保存密钥</button>
              {image.keySource === "db" && (
                <button className="quiet" disabled={busy} onClick={() => void removeImageKey()} type="button">移除密钥</button>
              )}
            </div>
            {image.keyHint && (
              <p className="muted">当前生图密钥 {image.keyHint}</p>
            )}
            <div className="section-head" style={{ marginTop: 12 }}>
              <span className="muted">未设置独立密钥时，使用文本模型的访问密钥。</span>
              <div>

                {image.source === "db" && (
                  <button className="quiet" disabled={busy} onClick={() => void resetImage()} type="button">使用默认配置</button>
                )}
              </div>
            </div>
            {showImageForm && (
              <form
                className="admin-form config-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveImage();
                }}>
                <label><span>服务地址</span><input onChange={(e) => setImageForm({ ...imageForm, baseUrl: e.target.value })} placeholder="生图服务地址，例如 https://api.openai.com/v1" required value={imageForm.baseUrl} /></label>
                <label><span>模型名称</span><input onChange={(e) => setImageForm({ ...imageForm, modelId: e.target.value })} placeholder="生图模型名称，例如 gpt-image-1" required value={imageForm.modelId} /></label>
                <label><span>等待时限（秒）</span><input min={1} onChange={(e) => setImageForm({ ...imageForm, timeoutSeconds: Number(e.target.value) || 180 })} placeholder="等待时限（秒）" type="number" value={imageForm.timeoutSeconds} /></label>
                <button className="primary" disabled={busy} type="submit">保存生图配置</button>
              </form>
            )}
          </>
        ) : (
          <p className="muted">加载中...</p>
        )}
      </ModelPanel>

      <ModelPanel id="sec-embedding" hidden={activeView !== "embedding"} title="资料检索模型配置" actions={<>
            <button className="quiet" onClick={openEmbeddingForm} type="button"><Settings2 size={14} /> 模型配置</button>
            <button className="quiet" onClick={() => void load()} type="button"><RefreshCw size={14} /> 刷新</button>
            <button className="primary" disabled={busy} onClick={() => void testRag("embedding")} type="button">
              {busyAction === "testRag" ? <LoaderCircle className="spin" size={14} /> : <CheckCircle2 size={14} />} 测试连接
            </button>
          </>}>
        {rag ? (
          <>
            <div className="config-grid">
              <div><small>服务地址</small><strong>{rag.embeddingBaseUrl || "使用文本模型服务地址"}</strong></div>
              <div><small>模型</small><strong>{rag.embeddingModel}</strong></div>
              <div><small>密钥状态</small><strong>{rag.embeddingKeyConfigured ? "使用文本模型密钥" : "未配置"}</strong></div>
            </div>

            <div className="section-head" style={{ marginTop: 12 }}>
              <span className="muted">使用文本模型的访问密钥，请确认它支持资料检索。</span>

            </div>
            {showEmbeddingForm && (
              <form
                className="admin-form config-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveRag();
                }}>
                <label><span>服务地址</span><input onChange={(e) => setRagForm({ ...ragForm, embeddingBaseUrl: e.target.value })} placeholder="检索服务地址（留空沿用文本模型地址）" value={ragForm.embeddingBaseUrl} /></label>
                <label><span>模型名称</span><input onChange={(e) => setRagForm({ ...ragForm, embeddingModel: e.target.value })} placeholder="资料检索模型名称，例如 text-embedding-3-small / embedding-3 / BAAI/bge-m3" required value={ragForm.embeddingModel} /></label>
                <button className="primary" disabled={busy} type="submit">保存配置</button>
              </form>
            )}
          </>
        ) : (
          <p className="muted">加载中...</p>
        )}
      </ModelPanel>

      <ModelPanel id="sec-rerank" hidden={activeView !== "rerank"} title="检索排序模型配置" actions={<>
            <button className="quiet" onClick={openRerankForm} type="button"><Settings2 size={14} /> 模型配置</button>
            <button className="quiet" onClick={() => void load()} type="button"><RefreshCw size={14} /> 刷新</button>
            <button className="primary" disabled={busy} onClick={() => void testRag("rerank")} type="button">
              {busyAction === "testRag" ? <LoaderCircle className="spin" size={14} /> : <CheckCircle2 size={14} />} 测试连接
            </button>
          </>}>
        {rag ? (
          <>
            <div className="config-grid">
              <div><small>服务地址</small><strong>{rag.rerankBaseUrl || "未启用"}</strong></div>
              <div><small>模型</small><strong>{rag.rerankModel || "未指定"}</strong></div>
              <div><small>等待时限</small><strong>{rag.rerankTimeoutSeconds}s</strong></div>
              <div><small>配置方式</small><strong>{rag.source === "db" ? "独立配置" : "默认配置"}</strong></div>
            </div>

            <div className="section-head" style={{ marginTop: 12 }}>
              <span className="muted">配置后可提升资料匹配效果；留空时使用原有检索顺序。</span>

            </div>
            {showRerankForm && (
              <form
                className="admin-form config-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveRag();
                }}>
                <label><span>服务地址</span><input onChange={(e) => setRagForm({ ...ragForm, rerankBaseUrl: e.target.value })} placeholder="排序服务地址，例如 http://localhost:8080" value={ragForm.rerankBaseUrl} /></label>
                <label><span>模型名称</span><input onChange={(e) => setRagForm({ ...ragForm, rerankModel: e.target.value })} placeholder="排序模型名称，例如 bge-reranker-v2-m3" value={ragForm.rerankModel} /></label>
                <label><span>等待时限（秒）</span><input min={1} onChange={(e) => setRagForm({ ...ragForm, rerankTimeoutSeconds: Number(e.target.value) || 3 })} placeholder="排序等待时限（秒）" type="number" value={ragForm.rerankTimeoutSeconds} /></label>
                <button className="primary" disabled={busy} type="submit">保存配置</button>
              </form>
            )}
          </>
        ) : (
          <p className="muted">加载中...</p>
        )}
      </ModelPanel>

{message && <div className="success" role="status">{message}</div>}
      {error && <div className="error" role="alert">{error}</div>}
    </main>
    </div>
  );
}

function AdminGate() {
  const { user, loading } = useAdminAuth();
  if (loading) {
    return (
      <main className="admin-login">
        <div className="admin-card">正在恢复登录状态...</div>
      </main>
    );
  }
  if (!user) return <AdminLoginPage />;
  if (user.role !== "admin") {
    return (
      <main className="admin-login">
        <div className="admin-card"><XCircle size={18} /> 当前账号没有管理员权限。</div>
      </main>
    );
  }
  return <AiConfigPage />;
}



export default function AdminApp() {
  return (
    <AdminAuthProvider>
      <AdminGate />
    </AdminAuthProvider>
  );
}





