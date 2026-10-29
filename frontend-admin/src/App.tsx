import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, LoaderCircle, LogOut, Plus, RefreshCw, Settings2, Star, Trash2, XCircle } from "lucide-react";
import { api } from "./api";
import { ModelConfigurationManager, type ConfigurationManagerHandle } from "./ModelConfigurationManager";
import { ConfigurationKeyEditor } from "./ConfigurationKeyEditor";
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
  apiKey: "",
  name: "",
  provider: "custom",
  baseUrl: "",
  modelId: "",
  timeoutSeconds: 120,
  capabilities: defaultCapabilities,
};

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
  if (/检索接口|检索服务|嵌入接口|嵌入向量|排序接口|模型类型不匹配|未配置此检索|所选接口协议|控制台|图片编辑模型|硅基流动服务地址|服务商拒绝生图参数|生图接口或模型不存在|生图调用失败/.test(detail)) return detail;
  if (/401|403|api.?key|unauthorized|访问验证失败/i.test(detail)) return "访问验证失败，请检查密钥及模型使用权限。";
  if (/404|does not support|not found/i.test(detail)) return "当前服务不支持所选模型，请检查服务地址和模型名称。";
  if (/timeout|timed out|超时/i.test(detail)) return "服务响应超时，请稍后重试。";
  return "暂时无法连接，请检查配置或联系服务提供方。";
}

function AiConfigPage() {
  const [configurationRevision, setConfigurationRevision] = useState(0);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [profiles, setProfiles] = useState<ProfileOut[]>([]);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const selectedText = profiles.find(p => p.id === selectedTextId) ?? profiles[0];
  const imageManager = useRef<ConfigurationManagerHandle>(null);
  const embeddingManager = useRef<ConfigurationManagerHandle>(null);
  const rerankManager = useRef<ConfigurationManagerHandle>(null);
  const [form, setForm] = useState(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ view: string; name: string } | null>(null);
  const [activeView, setActiveView] = useState("text");
  const busyAction = pendingAction?.view === activeView ? pendingAction.name : null;
  function setBusyAction(name: string | null) { setPendingAction(name ? { view: activeView, name } : null); }
  const successTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => () => Object.values(successTimers.current).forEach(clearTimeout), []);
  const [notices, setNotices] = useState<Record<string, { message?: string | null; error?: string | null }>>({});
  const message = notices[activeView]?.message;
  const error = notices[activeView]?.error;
  function setMessage(value: string | null) {
    const view = activeView;
    clearTimeout(successTimers.current[view]);
    setNotices(current => ({ ...current, [view]: { message: value } }));
    if (value) successTimers.current[view] = setTimeout(() => setNotices(current => ({ ...current, [view]: { ...current[view], message: null } })), 5000);
  }
  function setError(value: string | null) { setNotices(current => ({ ...current, [activeView]: value ? { error: value } : { ...current[activeView], error: null } })); }
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [showDiscoveredModels, setShowDiscoveredModels] = useState(false);

  const { logout, user } = useAdminAuth();

  const load = useCallback(async () => {
    try {
      const [statusRes, profilesRes] = await Promise.all([
        api.get<ModelStatus>("/settings/model"),
        api.get<{ profiles: ProfileOut[] }>("/settings/profiles"),
      ]);
      setStatus(statusRes.data);
      setProfiles(profilesRes.data.profiles);
      setSelectedTextId(current => profilesRes.data.profiles.some(p => p.id === current) ? current : profilesRes.data.profiles[0]?.id ?? null);
      setConfigurationRevision(value => value + 1);
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? connectionError(detail) : "无法读取 AI 配置。");
    }
  }, [activeView]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!showForm) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) { setShowForm(false); setEditingProfileId(null); setForm(emptyForm); setNotices(current => ({ ...current, text: {} })); }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [showForm, busy]);
  useEffect(() => {
    if (activeView !== "text" && !busy) { setShowForm(false); setEditingProfileId(null); setForm(emptyForm); }
  }, [activeView, busy]);

  const createProfile = async () => {
    if (!form.name.trim() || !form.baseUrl.trim() || !form.modelId.trim()) {
      setError("方案名称 / 服务地址 / 模型名称 必填。");
      return;
    }
    setBusy(true);
    setBusyAction("createProfile");
    setError(null);
    try {
      const { apiKey, ...fields } = form;
      const payload = { ...fields, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) };
      if (editingProfileId) await api.patch(`/settings/profiles/${editingProfileId}`, payload);
      else await api.post("/settings/profiles", { ...payload, isDefault: profiles.length === 0 });
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
      const res = await api.get<{ models: string[] }>("/settings/models", { params: { profileId: selectedText?.id }, timeout: 120000 });
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
      const res = await api.post<{ latencyMs: number; model: string }>("/settings/model/test", null, { params: { profileId: selectedText?.id }, timeout: 120000 });
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

  const testImage = async () => {
    const profileId = imageManager.current?.selectedId();
    if (!profileId) { setError("请先新增或选择生图配置。"); return; }
    setBusy(true);
    setBusyAction("testImage");
    setMessage(null);
    setError(null);
    try {
      const res = await api.post<{ latencyMs: number; model: string }>("/settings/image/test", null, { params: { profileId }, timeout: 120000 });
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

  const openProfileForm = () => {
    setNotices(current => ({ ...current, text: {} }));
    setEditingProfileId(selectedText?.id ?? null);
    setForm(selectedText ? { apiKey: "", name: selectedText.name, provider: selectedText.provider, baseUrl: selectedText.baseUrl, modelId: selectedText.modelId, timeoutSeconds: selectedText.timeoutSeconds, capabilities: { ...defaultCapabilities, ...selectedText.capabilities } } : emptyForm);
    setShowForm(!showForm);
  };
  const testRag = async (target: "embedding" | "rerank") => {
    const profileId = (target === "embedding" ? embeddingManager : rerankManager).current?.selectedId();
    if (!profileId) { setError("请先新增或选择检索模型配置。"); return; }
    setBusy(true);
    setBusyAction("testRag");
    setMessage(null);
    setError(null);
    try {
      const res = await api.post<Record<string, { ok: boolean; detail?: string; latencyMs?: number }>>("/settings/rag/test?target=" + target, null, { params: { profileId }, timeout: 120000 });
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
          <span className="brand-mark" aria-hidden="true">
            <img alt="" src="/gaoliu-mark.svg" />
          </span>
          <div>
            <strong>稿流</strong>
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
            <div><small>服务地址</small><strong>{selectedText?.baseUrl ?? status.baseUrl}</strong></div>
            <div><small>模型</small><strong>{selectedText?.modelId ?? status.model}</strong></div>
            <div><small>密钥状态</small><strong>{(selectedText ? selectedText.keyConfigured : status.keyConfigured) ? "已配置" : "未配置"}</strong></div>
            <div><small>当前方案</small><strong>{selectedText?.name ?? status.profileName ?? "默认配置"}</strong></div>
            <div><small>等待时限</small><strong>{selectedText?.timeoutSeconds ?? status.timeoutSeconds}s</strong></div>
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
                          setEditingProfileId(null);
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
          {selectedText && <ConfigurationKeyEditor key={selectedText.id} endpoint={`/settings/profiles/${selectedText.id}/key`} configured={selectedText.keyConfigured} hint={selectedText.keyHint} onChanged={load} />}
          {showForm && (
            <form
              aria-label={`${editingProfileId ? "编辑" : "新增"}文本模型配置`}
              className="admin-form config-form"
              onSubmit={(event) => {
                event.preventDefault();
                void createProfile();
              }}>
              <label><span>方案名称</span><input onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="方案名称" required value={form.name} /></label>
              <label><span>服务地址</span><input onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="服务地址，例如 https://api.openai.com/v1" required value={form.baseUrl} /></label>
              <label><span>模型名称</span><input onChange={(e) => setForm({ ...form, modelId: e.target.value })} placeholder="模型名称，例如 gpt-4o-mini" required value={form.modelId} /></label>
              <label><span>等待时限（秒）</span><input min={1} onChange={(e) => setForm({ ...form, timeoutSeconds: Number(e.target.value) || 120 })} placeholder="等待时限（秒）" type="number" value={form.timeoutSeconds} /></label>
              <label><span>访问密钥（可选）</span><input autoComplete="new-password" disabled={busy} minLength={4} maxLength={4096} onChange={e => setForm({ ...form, apiKey: e.target.value })} placeholder={editingProfileId ? "留空保留此配置已有密钥" : "仅用于此配置"} type="password" value={form.apiKey} /></label>
              <label><span>最大输出 tokens</span><input min={256} max={200000} type="number" value={form.capabilities.maxTokens} onChange={e => setForm({ ...form, capabilities: { ...form.capabilities, maxTokens: Number(e.target.value) } })} /></label>
              <label><span>上下文 tokens</span><input min={1024} max={4000000} type="number" value={form.capabilities.contextWindow} onChange={e => setForm({ ...form, capabilities: { ...form.capabilities, contextWindow: Number(e.target.value) } })} /></label>
              <label className="check-field"><input type="checkbox" checked={form.capabilities.reasoning} onChange={e => setForm({ ...form, capabilities: { ...form.capabilities, reasoning: e.target.checked } })} /><span>启用模型思考</span></label>
              <label><span>思考等级</span><select value={form.capabilities.thinkingLevel} onChange={e => setForm({ ...form, capabilities: { ...form.capabilities, thinkingLevel: e.target.value } })}><option value="auto">自动</option><option value="off">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
              <label className="check-field"><input type="checkbox" checked={form.capabilities.vision} onChange={e => setForm({ ...form, capabilities: { ...form.capabilities, vision: e.target.checked } })} /><span>支持图片理解</span></label>
              <div className="config-form-actions"><button className="quiet" disabled={busy} onClick={() => { setShowForm(false); setEditingProfileId(null); setForm(emptyForm); setNotices(current => ({ ...current, text: {} })); }} type="button">取消</button><button className="primary" disabled={busy} type="submit">保存配置</button></div>
            </form>
          )}
          <div className="profile-list profile-list--embedded">
            <div className="section-head section-head--compact">
              <h2>文本模型配置</h2>
              <button className="quiet" onClick={() => { setEditingProfileId(null); setForm(emptyForm); setShowForm(true); }} type="button"><Plus size={14} /> 新增配置</button>
            </div>
            {profiles.map((profile) => (
              <div className={profile.id === selectedText?.id ? "profile selected" : "profile"} key={profile.id}>
                <button className="profile-summary profile-select" type="button" aria-pressed={profile.id === selectedText?.id} disabled={busy} onClick={() => { setSelectedTextId(profile.id); setShowForm(false); setEditingProfileId(null); setForm(emptyForm); setShowDiscoveredModels(false); setDiscoveredModels([]); setNotices(current => ({ ...current, text: {} })); }}>
                  <strong>{profile.isDefault && <Star color="#f59e0b" size={13} />} {profile.name}{profile.isDefault && <span className="profile-badge">使用中</span>}</strong>
                  <small>最大输出 {profile.capabilities?.maxTokens ?? 16384} tokens · {profile.baseUrl} · {profile.modelId} · {profile.keyConfigured ? `密钥已配置 ${profile.keyHint}` : "未配置密钥"} · {profile.timeoutSeconds}s</small>
                </button>
                <div className="actions">
                  <button className="quiet" disabled={busy} onClick={() => { setSelectedTextId(profile.id); setEditingProfileId(profile.id); setForm({ apiKey: "", name: profile.name, provider: profile.provider, baseUrl: profile.baseUrl, modelId: profile.modelId, timeoutSeconds: profile.timeoutSeconds, capabilities: { ...defaultCapabilities, ...profile.capabilities } }); setShowForm(true); }} type="button">编辑配置</button>
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
            <button className="quiet" onClick={() => imageManager.current?.toggleCurrent()} type="button"><Settings2 size={14} /> 模型配置</button>
            <button className="quiet" onClick={() => void load()} type="button"><RefreshCw size={14} /> 刷新</button>
            <button className="primary" disabled={busy} onClick={() => void testImage()} type="button">
              {busyAction === "testImage" ? <LoaderCircle className="spin" size={14} /> : <CheckCircle2 size={14} />} 测试连接
            </button>
          </>}>
        <ModelConfigurationManager externalBusy={busy} revision={configurationRevision} kind="image" onSelectionChange={() => setNotices(current => ({ ...current, image: {} }))} onChanged={load} ref={imageManager} visible={activeView === "image"} />
      </ModelPanel>

      <ModelPanel id="sec-embedding" hidden={activeView !== "embedding"} title="资料检索模型配置" actions={<>
            <button className="quiet" onClick={() => embeddingManager.current?.toggleCurrent()} type="button"><Settings2 size={14} /> 模型配置</button>
            <button className="quiet" onClick={() => void load()} type="button"><RefreshCw size={14} /> 刷新</button>
            <button className="primary" disabled={busy} onClick={() => void testRag("embedding")} type="button">
              {busyAction === "testRag" ? <LoaderCircle className="spin" size={14} /> : <CheckCircle2 size={14} />} 测试连接
            </button>
          </>}>
        <ModelConfigurationManager externalBusy={busy} revision={configurationRevision} kind="embedding" onSelectionChange={() => setNotices(current => ({ ...current, embedding: {} }))} onChanged={load} ref={embeddingManager} visible={activeView === "embedding"} />
      </ModelPanel>

      <ModelPanel id="sec-rerank" hidden={activeView !== "rerank"} title="检索排序模型配置" actions={<>
            <button className="quiet" onClick={() => rerankManager.current?.toggleCurrent()} type="button"><Settings2 size={14} /> 模型配置</button>
            <button className="quiet" onClick={() => void load()} type="button"><RefreshCw size={14} /> 刷新</button>
            <button className="primary" disabled={busy} onClick={() => void testRag("rerank")} type="button">
              {busyAction === "testRag" ? <LoaderCircle className="spin" size={14} /> : <CheckCircle2 size={14} />} 测试连接
            </button>
          </>}>
        <ModelConfigurationManager externalBusy={busy} revision={configurationRevision} kind="rerank" onSelectionChange={() => setNotices(current => ({ ...current, rerank: {} }))} onChanged={load} ref={rerankManager} visible={activeView === "rerank"} />
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





