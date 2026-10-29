import { useEffect, useState } from "react";
import { Bell, Check, Database, Layout, Monitor, Moon, Save, Settings2, Sun, User } from "lucide-react";
import { ToolbarSelect } from "../components/ui/ToolbarSelect";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useThemeSetting } from "../lib/theme";
import "./SettingsPage.css";
import { ARTICLE_WORKFLOW_NODES } from "../workflow/articleNodes";

interface Profile { id: string; name: string; isDefault?: boolean }
interface Preferences { disabledNodeIds: string[]; webSearchMode: "auto" | "off"; profileId: string | null; nodeProfileIds: Record<string, string> }
interface Integrations { trustedHosts: string[]; publishBridgeUrl: string; tavily?: {keyConfigured:boolean}; github?: {keyConfigured:boolean} }

const TABS = [
  { id: "model", label: "模型", icon: Settings2 },
  { id: "appearance", label: "外观", icon: Sun },
  { id: "account", label: "账号", icon: User },
  { id: "writing", label: "写作", icon: Layout },
  { id: "data", label: "数据", icon: Database },
] as const;

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const admin = user?.role === "admin";
  const { setting, setSetting } = useThemeSetting();
  const [tab, setTab] = useState<string>("model");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [prefs, setPrefs] = useState<Preferences>({disabledNodeIds:[], webSearchMode:"auto", profileId:null, nodeProfileIds:{}});
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
    const [p, w] = await Promise.all([api.get<{profiles:Profile[]}>("/settings/profiles"), api.get<Preferences>("/settings/preferences")]);
    setProfiles(p.data.profiles);
    const ids = new Set(p.data.profiles.map(profile => profile.id));
    setPrefs({ ...w.data, profileId: ids.has(w.data.profileId ?? "") ? w.data.profileId : null,
      nodeProfileIds: Object.fromEntries(Object.entries(w.data.nodeProfileIds ?? {}).filter(([, id]) => ids.has(id))),
    });
    if (admin) setIntegrations((await api.get<Integrations>("/settings/integrations")).data);
  }, ""); }, [admin]);

  const exportData = async () => {
    const result = await api.get("/settings/data/export", {timeout:120000});
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.data, null, 2)], {type:"application/json"}));
    const a = document.createElement("a"); a.href=url; a.download="稿流个人数据.json"; a.click(); URL.revokeObjectURL(url);
  };

  const modelOptions = profiles.map(p => ({ id: p.id, label: p.name }));
  const defaultProfile = profiles.find(p => p.id === prefs.profileId) ?? profiles.find(p => p.isDefault) ?? profiles[0];
  const modelSelect = (label: string, profileId: string | null, onChange: (value: string) => void, inherit = false) => (
    <ToolbarSelect
      className="toolbar-select--fill toolbar-select--lg"
      disabled={busy || profiles.length <= 1}
      label={label}
      onChange={onChange}
      options={profiles.length <= 1
        ? (modelOptions.length ? modelOptions : [{ id: "", label: "暂无可用模型" }])
        : [...(inherit ? [{ id: "", label: `跟随默认（${defaultProfile?.name ?? "平台默认"}）` }] : [{ id: "", label: `平台默认（${profiles.find(p => p.isDefault)?.name ?? profiles[0].name}）` }]), ...modelOptions]}
      value={profiles.length === 1 ? profiles[0].id : profileId ?? ""}
    />
  );

  return (
    <div className="settings-page" style={{ padding: 32, maxWidth: 720, display: "grid", gap: 0, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>设置</h1>
      <p style={{ color: "var(--muted, #888)", fontSize: 13, marginBottom: 20 }}>
        管理模型偏好、界面外观和创作设置
      </p>

      {/* Tab navigation */}
      <nav style={{
        display: "flex", gap: 4, marginBottom: 24, padding: 3,
        background: "var(--surface-muted, #f5f5f5)", borderRadius: 10, width: "fit-content",
      }}>
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            aria-pressed={tab === id}
            key={id}
            onClick={() => setTab(id)}
            style={{
              alignItems: "center", background: tab === id ? "var(--surface, #fff)" : "transparent",
              border: tab === id ? "1px solid var(--border, #e5e5e5)" : "1px solid transparent",
              borderRadius: 8, color: tab === id ? "var(--ink)" : "var(--muted, #888)",
              cursor: "pointer", display: "flex", fontSize: 13, fontWeight: 500,
              gap: 6, padding: "7px 14px",
              boxShadow: tab === id ? "0 1px 2px rgba(0,0,0,0.05)" : "none",
              transition: "all 150ms ease",
            }}
            type="button"
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </nav>

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
          <div className="client-settings-footer">
            <p>{profiles.length === 0 ? "暂无可用模型，请联系管理员配置。" : profiles.length === 1 ? "管理员仅配置了一个模型，各环节统一使用该模型。" : "模型由管理员统一配置，此处仅保存你的使用偏好。"}</p>
            <button className="button button--primary" disabled={busy || profiles.length === 0} onClick={() => void act(() => api.put("/settings/preferences", prefs), "模型选择已保存")} type="button"><Save size={15} />保存模型选择</button>
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
        <div style={{ display: "grid", gap: 20 }}>
          <section style={{
            alignItems: "center", background: "var(--surface, #fff)", border: "1px solid var(--border, #e5e5e5)",
            borderRadius: 12, display: "flex", gap: 14, padding: 20,
          }}>
            <div style={{
              alignItems: "center", background: "linear-gradient(135deg, var(--accent, #5b8def), color-mix(in srgb, var(--accent, #5b8def) 60%, #9b59b6))",
              borderRadius: "50%", color: "#fff", display: "grid", fontSize: 18, fontWeight: 700, height: 48, placeItems: "center", width: 48,
            }}>
              {(user?.displayName || user?.username || "?").charAt(0).toUpperCase()}
            </div>
            <div style={{ flex: 1 }}>
              <strong style={{ fontSize: 15 }}>{user?.displayName || user?.username}</strong>
              <p style={{ color: "var(--muted, #888)", fontSize: 12, marginTop: 2 }}>
                {admin ? "管理员" : "成员"}
              </p>
            </div>
            <button className="button button--quiet" onClick={() => void logout()}>退出登录</button>
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
          {!admin && <p style={{ color: "var(--muted, #888)", fontSize: 12 }}>外部服务由管理员配置。</p>}
        </div>
      )}

      {/* Writing tab */}
      {tab === "writing" && (
        <section style={{
          background: "var(--surface, #fff)", border: "1px solid var(--border, #e5e5e5)",
          borderRadius: 12, display: "grid", gap: 14, padding: 20,
        }}>
          <div>
            <strong style={{ fontSize: 14 }}>默认创作流程</strong>
            <p style={{ color: "var(--muted, #888)", fontSize: 12, marginTop: 2 }}>
              取消勾选可跳过对应创作步骤
            </p>
          </div>
          {ARTICLE_WORKFLOW_NODES.map(node => (
            <label key={node.id} style={{ alignItems: "flex-start", cursor: "pointer", display: "flex", gap: 8 }}>
              <input
                checked={!prefs.disabledNodeIds.includes(node.id)}
                onChange={e => setPrefs({...prefs, disabledNodeIds: e.target.checked ? prefs.disabledNodeIds.filter(id => id !== node.id) : [...prefs.disabledNodeIds, node.id]})}
                style={{ marginTop: 2 }}
                type="checkbox"
              />
              <div>
                <span style={{ color: "var(--ink)", fontSize: 13, fontWeight: 500 }}>{node.label}</span>
                <small style={{ color: "var(--muted, #888)", display: "block", fontSize: 11, marginTop: 1 }}>{node.description}</small>
              </div>
            </label>
          ))}
          <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
            <label style={{ alignItems: "center", color: "var(--ink)", display: "flex", fontSize: 13, fontWeight: 500, gap: 4 }}>
              <Bell size={13} /> 联网检索
            </label>
            <ToolbarSelect
              label="联网检索"
              onChange={(value) => setPrefs({ ...prefs, webSearchMode: value })}
              options={[
                { id: "auto", label: "自动" },
                { id: "off", label: "关闭" },
              ]}
              value={prefs.webSearchMode}
            />
          </div>
          <button
            className="button button--primary"
            disabled={busy}
            onClick={() => void act(() => api.put("/settings/preferences", prefs))}
            style={{ alignItems: "center", display: "flex", fontSize: 13, gap: 6, justifyContent: "center", padding: "9px 16px" }}
          >
            <Save size={14} /> 保存写作偏好
          </button>
        </section>
      )}

      {/* Data tab */}
      {tab === "data" && (
        <section style={{
          background: "var(--surface, #fff)", border: "1px solid var(--border, #e5e5e5)",
          borderRadius: 12, display: "grid", gap: 14, padding: 20,
        }}>
          <div>
            <strong style={{ fontSize: 14 }}>安全与个人数据</strong>
            <p style={{ color: "var(--muted, #888)", fontSize: 12, lineHeight: 1.5, marginTop: 4 }}>
              导出内容不含访问密钥。你的文章、素材、模板和助手会话仅供本人使用；共享内容按原有权限访问。
            </p>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <button className="button button--primary" disabled={busy} onClick={() => void act(exportData, "数据已导出")} style={{ fontSize: 13, padding: "9px 16px" }}>
              导出个人数据
            </button>
            <button
              className="button button--quiet"
              disabled={busy}
              onClick={() => void act(async () => {
                const next = {disabledNodeIds: [], webSearchMode: "auto" as const, profileId: null, nodeProfileIds: {}};
                await api.put("/settings/preferences", next);
                setPrefs(next);
              })}
              style={{ fontSize: 13, padding: "9px 16px" }}
            >
              重置个人写作偏好
            </button>
          </div>
          <div style={{ display: "grid", gap: 6, paddingTop: 6, borderTop: "1px solid var(--border, #eee)" }}>
            <a href="/articles" style={{ color: "var(--accent, #5b8def)", fontSize: 13, textDecoration: "none" }}>管理文章与历史版本 →</a>
            <a href="/media" style={{ color: "var(--accent, #5b8def)", fontSize: 13, textDecoration: "none" }}>管理素材 →</a>
            <a href="/templates" style={{ color: "var(--accent, #5b8def)", fontSize: 13, textDecoration: "none" }}>管理模板 →</a>
          </div>
        </section>
      )}
    </div>
  );
}
