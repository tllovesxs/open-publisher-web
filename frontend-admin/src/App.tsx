import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, LoaderCircle, LogOut, Plus, RefreshCw, Star, Trash2, XCircle } from "lucide-react";
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

interface ProfileOut {
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
  rerankTimeoutSeconds: number;
  embeddingKeyConfigured: boolean;
  source: "db" | "default";
}


const VIEWS = [
  { view: "text", title: "文本模型", desc: "当前生效的文本生成模型与密钥。" },
  { view: "profiles", title: "模型档案", desc: "维护多套文本模型配置并切换生效档案。" },
  { view: "image", title: "生图模型", desc: "文章配图使用的图像生成模型。" },
  { view: "embedding", title: "Embedding 模型", desc: "RAG 资料向量化与检索使用的嵌入模型。" },
  { view: "rerank", title: "Rerank 模型", desc: "检索结果重排序服务（bge-reranker 兼容）。" },
  { view: "security", title: "密钥安全", desc: "密钥的存储与使用约定。" },
] as const;


function AiConfigPage() {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [profiles, setProfiles] = useState<ProfileOut[]>([]);
  const [image, setImage] = useState<ImageStatus | null>(null);
  const [imageForm, setImageForm] = useState(emptyImageForm);
  const [showImageForm, setShowImageForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [llmKeyInput, setLlmKeyInput] = useState("");
  const [imageKeyInput, setImageKeyInput] = useState("");
  const [profileKeyInputs, setProfileKeyInputs] = useState<Record<string, string>>({});
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [showDiscoveredModels, setShowDiscoveredModels] = useState(false);
  const [rag, setRag] = useState<RagConfig | null>(null);
  const [ragForm, setRagForm] = useState({ embeddingBaseUrl: "", embeddingModel: "", rerankBaseUrl: "", rerankTimeoutSeconds: 3 });
  const [activeView, setActiveView] = useState("text");
  const [showEmbeddingForm, setShowEmbeddingForm] = useState(false);
  const [showRerankForm, setShowRerankForm] = useState(false);
  const [ragTest, setRagTest] = useState<{embedding: {ok: boolean; detail?: string; dimensions?: number; latencyMs?: number}; rerank: {ok: boolean; detail?: string; latencyMs?: number}} | null>(null);
  const { logout, user } = useAdminAuth();

  const load = useCallback(async () => {
    setError(null);
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
      setError(typeof detail === "string" ? detail : "无法读取 AI 配置。");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createProfile = async () => {
    if (!form.name.trim() || !form.baseUrl.trim() || !form.modelId.trim()) {
      setError("档案名称 / API Base URL / 模型 ID 必填。");
      return;
    }
    setBusy(true);
    setBusyAction("createProfile");
    setError(null);
    try {
      await api.post("/settings/profiles", { ...form, isDefault: profiles.length === 0 });
      setForm(emptyForm);
      setShowForm(false);
      await load();
      setMessage("AI 档案已保存。");
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "保存失败。");
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
      setMessage("已切换生效档案。");
    } catch {
      setError("激活失败。");
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
      setMessage("档案已删除。");
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
        setError("模型发现请求超时（上游超过 120 秒未响应）。");
        return;
      }
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "模型列表拉取失败。");
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
      const res = await api.post<{ latencyMs: number; model: string; reply: string }>("/settings/model/test", null, { timeout: 120000 });
      setMessage(`连通正常：${res.data.model} · ${res.data.latencyMs}ms · ${res.data.reply}`);
    } catch (err) {
      if ((err as { code?: string })?.code === "ECONNABORTED") {
        setError("连通测试请求超时（上游超过 120 秒未响应）。");
        return;
      }
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "连通测试失败。");
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
      setError("生图 API Base URL / 模型 ID 必填。");
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
      setError(typeof detail === "string" ? detail : "生图配置保存失败。");
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
      setMessage("已恢复默认模型配置。");
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
      setMessage(`生图连通正常：${res.data.model} · ${res.data.latencyMs}ms`);
    } catch (err) {
      if ((err as { code?: string })?.code === "ECONNABORTED") {
        setError("生图测试请求超时（上游超过 120 秒未响应）。");
        return;
      }
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "生图连通测试失败。");
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
      await api.put("/settings/llm/key", { apiKey: value });
      setLlmKeyInput("");
      await load();
      setMessage("LLM 密钥已加密入库。");
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "密钥保存失败。");
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
      await api.delete("/settings/llm/key");
      await load();
      setMessage("LLM 密钥已删除；未配置档案密钥时将不可用。");
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
      setMessage("生图密钥已加密入库。");
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "密钥保存失败。");
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
      setMessage("档案密钥已加密入库。");
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "密钥保存失败。");
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
      setMessage("档案密钥已删除，调用时沿用全局密钥。");
    } catch {
      setError("密钥删除失败。");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };
  const openEmbeddingForm = () => {
    if (rag) {
      setRagForm((current) => ({
        ...current,
        embeddingBaseUrl: rag.embeddingBaseUrl,
        embeddingModel: rag.embeddingModel,
      }));
    }
    setRagTest(null);
    setShowEmbeddingForm(true);
  };

  const openRerankForm = () => {
    if (rag) {
      setRagForm((current) => ({
        ...current,
        rerankBaseUrl: rag.rerankBaseUrl,
        rerankTimeoutSeconds: rag.rerankTimeoutSeconds,
      }));
    }
    setRagTest(null);
    setShowRerankForm(true);
  };

  const saveRag = async () => {
    if (!ragForm.embeddingModel.trim()) {
      setError("Embedding 模型 ID 必填。");
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
      setMessage("RAG 检索模型配置已保存。");
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "RAG 配置保存失败。");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const testRag = async () => {
    setBusy(true);
    setBusyAction("testRag");
    setMessage(null);
    setError(null);
    try {
      const res = await api.post<{embedding: {ok: boolean; detail?: string; dimensions?: number; latencyMs?: number}; rerank: {ok: boolean; detail?: string; latencyMs?: number}}>("/settings/rag/test", null, { timeout: 120000 });
      setRagTest(res.data);
      if (res.data.embedding.ok && res.data.rerank.ok) {
        setMessage(`Embedding 与 Rerank 均连通。`);
      }
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "RAG 连通测试失败。");
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
        <nav className="admin-nav" aria-label="模型列表">
          <span className="nav-title">模型列表</span>
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
      <section className="admin-card" id="sec-current" hidden={activeView !== "text"}>
        <div className="section-head">
          <h2>当前生效配置</h2>
          <div>
            <button className="quiet" onClick={() => void load()} type="button"><RefreshCw size={14} /> 刷新</button>
            <button className="quiet" disabled={busy} onClick={() => void discoverModels()} type="button">
              {busyAction === "discoverModels" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} 发现模型
            </button>
            <button className="primary" disabled={busy} onClick={() => void test()} type="button">
              {busyAction === "test" ? <LoaderCircle className="spin" size={14} /> : <CheckCircle2 size={14} />} 测试连通
            </button>
          </div>
        </div>
        {status ? (
          <>
          <div className="config-grid">
            <div><small>API Base URL</small><strong>{status.baseUrl}</strong></div>
            <div><small>模型</small><strong>{status.model}</strong></div>
            <div><small>密钥状态</small><strong>{status.keyConfigured ? "已配置（数据库加密）" : "未配置"}</strong></div>
            <div><small>生效档案</small><strong>{status.profileName ?? "全局数据库密钥"}</strong></div>
            <div><small>超时</small><strong>{status.timeoutSeconds}s</strong></div>
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
                          setMessage(`已选择 ${model}，确认 API Base URL 后保存档案。`);
                        }}
                        type="button"
                      >
                        填入档案
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="admin-form" style={{ marginTop: 12 }}>
            <input autoComplete="new-password" onChange={(e) => setLlmKeyInput(e.target.value)} placeholder="录入全局 LLM 密钥（加密入库，不回显）" type="password" value={llmKeyInput} />
            <button className="primary" disabled={busy} onClick={() => void saveLlmKey()} type="button">保存密钥</button>
            {status.keySource === "db" && (
              <button className="quiet" disabled={busy} onClick={() => void removeLlmKey()} type="button">删除密钥</button>
            )}
          </div>
          {status.keyHint && (
            <p className="muted">当前密钥 {status.keyHint}（已加密保存）</p>
          )}
          </>
        ) : (
          <p className="muted">加载中...</p>
        )}
      </section>

      <section className="admin-card" id="sec-profiles" hidden={activeView !== "profiles"}>
        <div className="section-head">
          <h2>模型档案</h2>
          <button className="primary" onClick={() => setShowForm(!showForm)} type="button">
            <Plus size={14} /> 新增配置
          </button>
        </div>

        {showForm && (
          <form
            className="admin-form"
            onSubmit={(event) => {
              event.preventDefault();
              void createProfile();
            }}>
            <input onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="档案名称" required value={form.name} />
            <input onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="API Base URL，例如 https://api.openai.com/v1" required value={form.baseUrl} />
            <input onChange={(e) => setForm({ ...form, modelId: e.target.value })} placeholder="模型 ID，例如 gpt-4o-mini" required value={form.modelId} />
            <input min={1} onChange={(e) => setForm({ ...form, timeoutSeconds: Number(e.target.value) || 120 })} placeholder="超时秒数" type="number" value={form.timeoutSeconds} />
            <button className="primary" disabled={busy} type="submit">保存配置</button>
          </form>
        )}

        <div className="profile-list">
          {profiles.map((profile) => (
            <div className={profile.isDefault ? "profile active" : "profile"} key={profile.id}>
              <div>
                <strong>{profile.isDefault && <Star color="#f59e0b" size={13} />} {profile.name}</strong>
                <small>{profile.baseUrl} · {profile.modelId} · {profile.keyConfigured ? `Key 已配置（数据库）${profile.keyHint}` : "Key 未配置"} · {profile.timeoutSeconds}s</small>
              </div>
              <div className="admin-form" style={{ marginTop: 8 }}>
                <input autoComplete="new-password" onChange={(e) => setProfileKeyInputs({ ...profileKeyInputs, [profile.id]: e.target.value })} placeholder="录入该档案密钥（加密入库，不回显）" type="password" value={profileKeyInputs[profile.id] ?? ""} />
                <button className="quiet" disabled={busy} onClick={() => void saveProfileKey(profile.id)} type="button">存密钥</button>
                {profile.keySource === "db" && (
                  <button className="quiet" disabled={busy} onClick={() => void removeProfileKey(profile.id)} type="button">删密钥</button>
                )}
              </div>
              <div className="actions">
                {!profile.isDefault && <button className="quiet" disabled={busy} onClick={() => void activate(profile.id)} type="button">激活</button>}
                <button aria-label={`删除 ${profile.name}`} className="danger" disabled={busy} onClick={() => void remove(profile.id)} type="button"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
          {profiles.length === 0 && <p className="muted">还没有模型档案。</p>}
        </div>
      </section>

      <section className="admin-card" id="sec-image" hidden={activeView !== "image"}>
        <div className="section-head">
          <h2>生图模型配置</h2>
          <div>
            <button className="quiet" onClick={() => void load()} type="button"><RefreshCw size={14} /> 刷新</button>
            <button className="primary" disabled={busy} onClick={() => void testImage()} type="button">
              {busyAction === "testImage" ? <LoaderCircle className="spin" size={14} /> : <CheckCircle2 size={14} />} 测试生图
            </button>
          </div>
        </div>
        {image ? (
          <>
            <div className="config-grid">
              <div><small>API Base URL</small><strong>{image.baseUrl}</strong></div>
              <div><small>模型</small><strong>{image.model}</strong></div>
                <div><small>密钥状态</small><strong>{image.keyConfigured ? "已配置（数据库加密）" : "未配置"}</strong></div>
              <div><small>配置来源</small><strong>{image.source === "db" ? "管理端配置" : "回退默认模型配置"}</strong></div>
              <div><small>超时</small><strong>{image.timeoutSeconds}s</strong></div>
            </div>
            <div className="admin-form" style={{ marginTop: 12 }}>
              <input autoComplete="new-password" onChange={(e) => setImageKeyInput(e.target.value)} placeholder="录入生图密钥（加密入库，不回显；留空表示沿用文本模型密钥）" type="password" value={imageKeyInput} />
              <button className="primary" disabled={busy} onClick={() => void saveImageKey()} type="button">保存密钥</button>
              {image.keySource === "db" && (
                <button className="quiet" disabled={busy} onClick={() => void removeImageKey()} type="button">删除密钥</button>
              )}
            </div>
            {image.keyHint && (
              <p className="muted">当前生图密钥 {image.keyHint}（已加密保存）</p>
            )}
            <div className="section-head" style={{ marginTop: 12 }}>
              <span className="muted">密钥只使用数据库加密存储；均不回显明文。</span>
              <div>
                <button className="quiet" onClick={openImageForm} type="button">编辑配置</button>
                {image.source === "db" && (
                  <button className="quiet" disabled={busy} onClick={() => void resetImage()} type="button">恢复默认模型配置</button>
                )}
              </div>
            </div>
            {showImageForm && (
              <form
                className="admin-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveImage();
                }}>
                <input onChange={(e) => setImageForm({ ...imageForm, baseUrl: e.target.value })} placeholder="生图 API Base URL，例如 https://api.openai.com/v1" required value={imageForm.baseUrl} />
                <input onChange={(e) => setImageForm({ ...imageForm, modelId: e.target.value })} placeholder="生图模型 ID，例如 gpt-image-1" required value={imageForm.modelId} />
                <input min={1} onChange={(e) => setImageForm({ ...imageForm, timeoutSeconds: Number(e.target.value) || 180 })} placeholder="超时秒数" type="number" value={imageForm.timeoutSeconds} />
                <button className="primary" disabled={busy} type="submit">保存生图配置</button>
              </form>
            )}
          </>
        ) : (
          <p className="muted">加载中...</p>
        )}
      </section>

      <section className="admin-card" id="sec-embedding" hidden={activeView !== "embedding"}>
        <div className="section-head">
          <h2>Embedding 模型</h2>
          <div>
            <button className="quiet" onClick={() => void load()} type="button"><RefreshCw size={14} /> 刷新</button>
            <button className="primary" disabled={busy} onClick={() => void testRag()} type="button">
              {busyAction === "testRag" ? <LoaderCircle className="spin" size={14} /> : <CheckCircle2 size={14} />} 测试连通
            </button>
          </div>
        </div>
        {rag ? (
          <>
            <div className="config-grid">
              <div><small>API Base URL</small><strong>{rag.embeddingBaseUrl || "沿用文本模型 API 地址"}</strong></div>
              <div><small>模型</small><strong>{rag.embeddingModel}</strong></div>
              <div><small>密钥状态</small><strong>{rag.embeddingKeyConfigured ? "已配置（复用文本模型密钥）" : "未配置"}</strong></div>
            </div>
            {ragTest && (
              <div className="config-grid" style={{ marginTop: 12 }}>
                <div><small>连通测试</small><strong>{ragTest.embedding.ok ? `正常（${ragTest.embedding.dimensions ?? "?"} 维 · ${ragTest.embedding.latencyMs ?? "?"}ms）` : `失败：${ragTest.embedding.detail ?? "未知"}`}</strong></div>
              </div>
            )}
            <div className="section-head" style={{ marginTop: 12 }}>
              <span className="muted">密钥复用文本模型密钥库，不回显明文。</span>
              <button className="quiet" onClick={openEmbeddingForm} type="button">编辑配置</button>
            </div>
            {showEmbeddingForm && (
              <form
                className="admin-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveRag();
                }}>
                <input onChange={(e) => setRagForm({ ...ragForm, embeddingBaseUrl: e.target.value })} placeholder="Embedding API Base URL（留空沿用文本模型地址）" value={ragForm.embeddingBaseUrl} />
                <input onChange={(e) => setRagForm({ ...ragForm, embeddingModel: e.target.value })} placeholder="Embedding 模型 ID，例如 text-embedding-3-small / embedding-3 / BAAI/bge-m3" required value={ragForm.embeddingModel} />
                <button className="primary" disabled={busy} type="submit">保存 Embedding 配置</button>
              </form>
            )}
          </>
        ) : (
          <p className="muted">加载中...</p>
        )}
      </section>

      <section className="admin-card" id="sec-rerank" hidden={activeView !== "rerank"}>
        <div className="section-head">
          <h2>Rerank 模型</h2>
          <div>
            <button className="quiet" onClick={() => void load()} type="button"><RefreshCw size={14} /> 刷新</button>
            <button className="primary" disabled={busy} onClick={() => void testRag()} type="button">
              {busyAction === "testRag" ? <LoaderCircle className="spin" size={14} /> : <CheckCircle2 size={14} />} 测试连通
            </button>
          </div>
        </div>
        {rag ? (
          <>
            <div className="config-grid">
              <div><small>服务地址</small><strong>{rag.rerankBaseUrl || "未配置（跳过重排）"}</strong></div>
              <div><small>超时</small><strong>{rag.rerankTimeoutSeconds}s</strong></div>
              <div><small>配置来源</small><strong>{rag.source === "db" ? "管理端配置" : "默认配置"}</strong></div>
            </div>
            {ragTest && (
              <div className="config-grid" style={{ marginTop: 12 }}>
                <div><small>连通测试</small><strong>{ragTest.rerank.ok ? `正常（${ragTest.rerank.latencyMs ?? "?"}ms）` : `不可用：${ragTest.rerank.detail ?? "未知"}`}</strong></div>
              </div>
            )}
            <div className="section-head" style={{ marginTop: 12 }}>
              <span className="muted">使用 bge-reranker 兼容服务（TEI 协议 /rerank）。</span>
              <button className="quiet" onClick={openRerankForm} type="button">编辑配置</button>
            </div>
            {showRerankForm && (
              <form
                className="admin-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveRag();
                }}>
                <input onChange={(e) => setRagForm({ ...ragForm, rerankBaseUrl: e.target.value })} placeholder="Rerank 服务地址，例如 http://localhost:8080（TEI bge-reranker）" value={ragForm.rerankBaseUrl} />
                <input min={1} onChange={(e) => setRagForm({ ...ragForm, rerankTimeoutSeconds: Number(e.target.value) || 3 })} placeholder="Rerank 超时秒数" type="number" value={ragForm.rerankTimeoutSeconds} />
                <button className="primary" disabled={busy} type="submit">保存 Rerank 配置</button>
              </form>
            )}
          </>
        ) : (
          <p className="muted">加载中...</p>
        )}
      </section>

      <section className="admin-card" id="sec-security" hidden={activeView !== "security"}>
        <h2>密钥安全</h2>
        <p className="muted">
          所有 API Key 均经加密存入数据库，不回显明文、不进日志；在各配置卡内通过"保存密钥"录入，删除后该配置回退到默认密钥。
        </p>
      </section>

      {message && <div className="success">{message}</div>}
      {error && <div className="error">{error}</div>}
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





