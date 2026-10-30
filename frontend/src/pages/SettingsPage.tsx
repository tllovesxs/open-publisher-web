import { useEffect, useState } from "react";
import { Check, FileCheck2, FilePenLine, Globe, Image, Layout, ListTree, Monitor, Moon, Save, Search, Settings2, ShieldCheck, Sparkles, Sun, User } from "lucide-react";
import { ToolbarSelect } from "../components/ui/ToolbarSelect";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useThemeSetting } from "../lib/theme";
import "./SettingsPage.css";
import { ARTICLE_WORKFLOW_NODES } from "../workflow/articleNodes";

interface Profile { id: string; name: string; isDefault?: boolean }
type ModelKind = "image" | "embedding" | "rerank";
interface ModelCatalog { models: Profile[]; defaultId: string | null }
const EXTRA_MODELS = [
  { kind: "image", field: "imageModelId", label: "生图模型", description: "生成文章配图和素材图片", icon: Image },
  { kind: "embedding", field: "embeddingModelId", label: "资料检索模型（向量）", description: "将资料与问题转为向量，查找相关内容", icon: Search },
  { kind: "rerank", field: "rerankModelId", label: "检索排序模型", description: "对检索到的资料进一步排序", icon: ListTree },
] as const;
interface Preferences { imageModelId: string | null; embeddingModelId: string | null; rerankModelId: string | null; disabledNodeIds: string[]; webSearchMode: "auto" | "off"; profileId: string | null; nodeProfileIds: Record<string, string> }
interface Integrations { trustedHosts: string[]; publishBridgeUrl: string; tavily?: {keyConfigured:boolean}; github?: {keyConfigured:boolean} }

const TABS = [
  { id: "model", label: "模型", icon: Settings2 },
  { id: "appearance", label: "外观", icon: Sun },
  { id: "account", label: "账号", icon: User },
  { id: "writing", label: "写作", icon: Layout },
] as const;

const STAGE_ICONS: Record<string, typeof Search> = {
  research: Search, outline: ListTree, draft: FilePenLine,
  "natural-style": Sparkles, review: FileCheck2,
  "reference-safety": Search, risk: ShieldCheck, visual: Image,
};

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const admin = user?.role === "admin";
  const { setting, setSetting } = useThemeSetting();
  const [tab, setTab] = useState<string>("model");
  const [catalogs, setCatalogs] = useState<Record<ModelKind, ModelCatalog>>({image:{models:[],defaultId:null},embedding:{models:[],defaultId:null},rerank:{models:[],defaultId:null}});
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [prefs, setPrefs] = useState<Preferences>({imageModelId:null, embeddingModelId:null, rerankModelId:null, disabledNodeIds:[], webSearchMode:"auto", profileId:null, nodeProfileIds:{}});
  const [integrations, setIntegrations] = useState<Integrations>({trustedHosts:[], publishBridgeUrl:""});
  const [keys, setKeys] = useState({tavily:"", github:""});
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>, success = "已保存") => {
    setBusy(true); setNotice("");
    try { await fn(); setNotice(success); }
    catch { setNotice("操作失败，请检查输入与登录权限后重试。"); }
    finally { setBusy(false); }
  };

  useEffect(() => { void act(async () => {
    const [p, w, c] = await Promise.all([api.get<{profiles:Profile[]}>("/settings/profiles"), api.get<Preferences>("/settings/preferences"), api.get<Record<ModelKind, ModelCatalog>>("/settings/available-models")]);
    setCatalogs(c.data);
    setProfiles(p.data.profiles);
    const ids = new Set(p.data.profiles.map(profile => profile.id));
    setPrefs({ ...w.data, disabledNodeIds: w.data.disabledNodeIds.filter(id => id !== "draft"), ...Object.fromEntries(EXTRA_MODELS.map(({kind,field}) => [field, c.data[kind].models.some(model => model.id === w.data[field]) ? w.data[field] : null])), profileId: ids.has(w.data.profileId ?? "") ? w.data.profileId : null,
      nodeProfileIds: Object.fromEntries(Object.entries(w.data.nodeProfileIds ?? {}).filter(([, id]) => ids.has(id))),
    });
    if (admin) setIntegrations((await api.get<Integrations>("/settings/integrations")).data);
  }, ""); }, [admin]);

  const defaultProfile = profiles.find(p => p.id === prefs.profileId) ?? profiles.find(p => p.isDefault) ?? profiles[0];
  const modelSelect = (label: string, profileId: string | null, onChange: (value: string) => void, inherit = false, models = profiles, defaultId?: string | null) => (
    <ToolbarSelect
      className="toolbar-select--fill toolbar-select--lg"
      disabled={busy || models.length <= 1}
      label={label}
      onChange={onChange}
      options={models.length <= 1
        ? (models.length ? models.map(model => ({ id: model.id, label: model.name })) : [{ id: "", label: "暂无可用模型" }])
        : [{ id: "", label: inherit ? `跟随默认（${defaultProfile?.name ?? "平台默认"}）` : `平台默认（${(models.find(model => model.id === defaultId) ?? models.find(model => model.isDefault) ?? models[0]).name}）` }, ...models.map(model => ({ id: model.id, label: model.name }))]}
      value={models.length === 1 ? models[0].id : profileId ?? ""}
    />
  );

  return (
    <div className="settings-page">
      <header className="client-settings-page-heading">
        <h1>设置</h1>
        <p>管理模型偏好、界面外观和创作设置</p>
      </header>
      <div className="client-settings-layout">
        <nav className="client-settings-nav" aria-label="设置分类">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button aria-pressed={tab === id} className={tab === id ? "is-active" : ""} key={id} onClick={() => { setTab(id); setNotice(""); }} type="button">
              <Icon size={17} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="client-settings-content">
      {notice && (
        <div role="status" style={{
          alignItems: "center", background: "var(--success-soft, #f0fff4)", border: "1px solid var(--success, #48bb78)",
          borderRadius: 8, color: "var(--success, #22543d)", display: "flex", fontSize: 13, gap: 8,
          marginBottom: 16, padding: "10px 14px",
        }}>
          <Save size={14} /> {notice}
        </div>
      )}

      {tab === "model" && (
        <section className="client-settings-card">
          <header className="client-settings-section-heading">
            <span className="client-settings-icon"><Settings2 size={19} /></span>
            <div><h2>模型选择</h2><p>为不同创作环节设置默认模型，保存后用于新任务。</p></div>
          </header>
          <div className="client-settings-default-model">
            <div><strong>默认写作模型</strong><p>未单独设置的环节将使用此模型</p></div>
            {modelSelect("默认写作模型", prefs.profileId, value => setPrefs(p => ({ ...p, profileId: value || null })))}
          </div>
          <div className="client-settings-divider" />
          <div className="client-settings-section-label">各环节默认模型</div>
          <div className="client-settings-model-grid">
            {ARTICLE_WORKFLOW_NODES.map((node, index) => (
              <div className="client-settings-model-row" key={node.id}>
                <div className="client-settings-node-label"><span>{String(index + 1).padStart(2, "0")}</span><strong>{node.label}</strong></div>
                {modelSelect(`${node.label}默认模型`, prefs.nodeProfileIds[node.id] ?? "", value => setPrefs(p => {
                  const next = { ...p.nodeProfileIds };
                  if (value) next[node.id] = value; else delete next[node.id];
                  return { ...p, nodeProfileIds: next };
                }), true)}
              </div>
            ))}
          </div>
          <div className="client-settings-divider" />
          <div className="client-settings-section-label">其他模型</div>
          <div className="client-settings-extra-models">
            {EXTRA_MODELS.map(({ kind, field, label, description, icon: Icon }) => {
              const catalog = catalogs[kind];
              return <div className="client-settings-model-row" key={kind}>
                <div className="client-settings-node-label"><Icon size={16} aria-hidden="true" /><strong>{label}</strong></div>
                {modelSelect(label, prefs[field], value => setPrefs(current => ({ ...current, [field]: value || null })), false, catalog.models, catalog.defaultId)}
                <p>{description}{kind === "embedding" ? "。更换向量模型后，已有资料需重新建立索引。" : "。"}</p>
              </div>;
            })}
          </div>
          <div className="client-settings-footer">
            <p>{profiles.length === 0 ? "暂无可用写作模型，仍可保存其他模型选择。" : profiles.length === 1 ? "各写作环节统一使用已配置的写作模型，其他模型可独立选择。" : "模型由管理员统一配置，此处仅保存你的使用偏好。"}</p>
            <button className="button button--primary" disabled={busy} onClick={() => void act(() => api.put("/settings/preferences", prefs), "模型选择已保存")} type="button"><Save size={15} />保存模型选择</button>
          </div>
        </section>
      )}

      {tab === "appearance" && (
        <section className="client-settings-card">
          <header className="client-settings-section-heading">
            <span className="client-settings-icon"><Sun size={19} /></span>
            <div><h2>明暗外观</h2><p>选择你喜欢的界面风格，切换后立即生效。</p></div>
          </header>
          <div className="client-settings-theme-options" role="group" aria-label="主题模式">
            {([
              { id: "light", label: "浅色", detail: "明亮清晰的创作空间", icon: Sun },
              { id: "dark", label: "深色", detail: "柔和舒适的夜间体验", icon: Moon },
              { id: "system", label: "跟随系统", detail: "随设备外观自动切换", icon: Monitor },
            ] as const).map(({ id, label, detail, icon: Icon }) => (
              <button aria-pressed={setting === id} className={`client-settings-theme-option${setting === id ? " is-active" : ""}`} key={id} onClick={() => setSetting(id)} type="button">
                <span className={`client-settings-theme-preview client-settings-theme-preview--${id}`} aria-hidden="true"><span /><span><i /><i /><i /></span></span>
                <span className="client-settings-theme-name"><Icon size={16} />{label}{setting === id && <Check size={15} />}</span>
                <small>{detail}</small>
              </button>
            ))}
          </div>
          <p className="client-settings-hint">外观设置自动保存在当前浏览器中。</p>
        </section>
      )}

      {/* Account tab */}
      {tab === "account" && (
        <div className="client-settings-account">
          <section className="client-settings-account-card">
            <div className="client-settings-avatar">
              {(user?.displayName || user?.username || "?").charAt(0).toUpperCase()}
            </div>
            <div className="client-settings-account-info">
              <span className="client-settings-eyebrow">当前账号</span>
              <h2>{user?.displayName || user?.username}</h2>
              <span className="client-settings-role">{admin ? "管理员" : "成员"}</span>
            </div>
            <button className="button button--quiet" onClick={() => void logout()} type="button">退出登录</button>
          </section>

          {admin && (
            <section style={{
              background: "var(--surface, #fff)", border: "1px solid var(--border, #e5e5e5)",
              borderRadius: 12, display: "grid", gap: 14, padding: 20,
            }}>
              <div>
                <strong style={{ fontSize: 14 }}>外部服务</strong>
                <p style={{ color: "var(--muted, #888)", fontSize: 12, marginTop: 2 }}>
                  管理联网搜索和代码仓库的访问权限
                </p>
              </div>
              {(["tavily", "github"] as const).map(kind => (
                <div key={kind} style={{ display: "grid", gap: 6 }}>
                  <label style={{ color: "var(--ink)", fontSize: 13, fontWeight: 500 }}>
                    {kind === "tavily" ? "联网搜索密钥（Tavily）" : "代码仓库访问凭证（GitHub）"}
                    <span style={{
                      background: integrations[kind]?.keyConfigured ? "var(--success-soft, #f0fff4)" : "var(--surface-muted, #f5f5f5)",
                      borderRadius: 4, color: integrations[kind]?.keyConfigured ? "var(--success, #22543d)" : "var(--muted, #888)",
                      fontSize: 10, marginLeft: 6, padding: "2px 6px",
                    }}>
                      {integrations[kind]?.keyConfigured ? "已配置" : "未配置"}
                    </span>
                  </label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      autoComplete="new-password"
                      onChange={e => setKeys({...keys, [kind]: e.target.value})}
                      style={{ borderRadius: 8, border: "1px solid var(--border, #ddd)", flex: 1, fontSize: 13, padding: "8px 10px" }}
                      type="password"
                      value={keys[kind]}
                    />
                    <button
                      className="button button--quiet"
                      disabled={busy || !keys[kind].trim()}
                      onClick={() => void act(async () => {
                        await api.put(`/settings/integrations/${kind}/key`, {apiKey: keys[kind]});
                        setKeys(k => ({...k, [kind]: ""}));
                        setIntegrations(i => ({...i, [kind]: {keyConfigured: true}}));
                      })}
                      style={{ fontSize: 12, padding: "8px 14px", whiteSpace: "nowrap" }}
                    >
                      加密保存
                    </button>
                  </div>
                </div>
              ))}
              <label style={{ color: "var(--ink)", display: "grid", fontSize: 13, fontWeight: 500, gap: 6 }}>
                允许访问的网站域名（每行一个）
                <textarea
                  onChange={e => setIntegrations({...integrations, trustedHosts: e.target.value.split("\n")})}
                  rows={3}
                  style={{ borderRadius: 8, border: "1px solid var(--border, #ddd)", fontSize: 13, padding: "8px 10px", resize: "vertical" }}
                  value={integrations.trustedHosts.join("\n")}
                />
              </label>
              <label style={{ color: "var(--ink)", display: "grid", fontSize: 13, fontWeight: 500, gap: 6 }}>
                发布连接服务地址
                <input
                  onChange={e => setIntegrations({...integrations, publishBridgeUrl: e.target.value})}
                  placeholder="https://bridge.example.com"
                  style={{ borderRadius: 8, border: "1px solid var(--border, #ddd)", fontSize: 13, padding: "8px 10px" }}
                  value={integrations.publishBridgeUrl}
                />
              </label>
              <button
                className="button button--primary"
                disabled={busy}
                onClick={() => void act(() => api.put("/settings/integrations", {trustedHosts: integrations.trustedHosts, publishBridgeUrl: integrations.publishBridgeUrl}))}
                style={{ alignItems: "center", display: "flex", gap: 6, fontSize: 13, justifyContent: "center", padding: "9px 16px" }}
              >
                <Save size={14} /> 保存服务设置
              </button>
            </section>
          )}
          {!admin && <div className="client-settings-account-note"><ShieldCheck size={18} aria-hidden="true" /><div><strong>外部服务</strong><p>联网搜索等外部服务由管理员统一配置。</p></div></div>}
        </div>
      )}

      {tab === "writing" && (
        <section className="client-settings-card">
          <header className="client-settings-section-heading">
            <span className="client-settings-icon"><FilePenLine size={19} aria-hidden="true" /></span>
            <div><h2>默认创作流程</h2><p>正文撰写为必需环节，其余 7 项按需开启；全部关闭也能生成正文。</p></div>
          </header>
          <div className="client-settings-writing-grid">
            {ARTICLE_WORKFLOW_NODES.map((node, index) => {
              const Icon = STAGE_ICONS[node.id] ?? FilePenLine;
              const enabled = node.required || !prefs.disabledNodeIds.includes(node.id);
              return (
                <label className={`client-settings-stage${enabled ? " is-enabled" : ""}`} key={node.id}>
                  <span className="client-settings-stage-icon" aria-hidden="true"><Icon size={21} strokeWidth={1.7} /></span>
                  <span className="client-settings-stage-copy"><strong>{node.label}{node.required && <span className="client-settings-required">必需</span>}</strong><small>{node.description}</small></span>
                  <span className="client-settings-stage-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                  <input aria-label={node.label} checked={enabled} disabled={busy || node.required} onChange={e => setPrefs(p => ({ ...p, disabledNodeIds: e.target.checked ? p.disabledNodeIds.filter(id => id !== node.id) : [...p.disabledNodeIds, node.id] }))} type="checkbox" />
                </label>
              );
            })}
          </div>
          <div className="client-settings-search-row">
            <div className="client-settings-search-label"><Globe size={18} aria-hidden="true" /><div><strong>联网检索</strong><p>{prefs.disabledNodeIds.includes("research") ? "资料整理已关闭，本次流程不执行联网检索" : "资料整理时自动补充相关资料"}</p></div></div>
            <ToolbarSelect disabled={busy || prefs.disabledNodeIds.includes("research")} label="联网检索" onChange={value => setPrefs(p => ({ ...p, webSearchMode: value }))} options={[{ id: "auto", label: "自动" }, { id: "off", label: "关闭" }]} value={prefs.webSearchMode} />
          </div>
          <div className="client-settings-footer">
            <button className="button button--primary" disabled={busy} onClick={() => void act(() => api.put("/settings/preferences", prefs), "写作偏好已保存")} type="button"><Save size={15} />保存写作偏好</button>
          </div>
        </section>
      )}
        </div>
      </div>
    </div>
  );
}
