import { useEffect, useState } from "react";
import { Bell, Database, KeyRound, Layout, Save, Settings2, User } from "lucide-react";
import { ToolbarSelect } from "../components/ui/ToolbarSelect";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useThemeSetting } from "../lib/theme";
import { ARTICLE_WORKFLOW_NODES } from "../workflow/articleNodes";

interface Capabilities { contextWindow: number; maxTokens: number; vision: boolean; reasoning: boolean }
interface Profile { id: string; name: string; modelId: string; capabilities: Capabilities; keyConfigured: boolean }
interface Preferences { disabledNodeIds: string[]; webSearchMode: "auto" | "off"; profileId: string | null }
interface Integrations { trustedHosts: string[]; publishBridgeUrl: string; tavily?: {keyConfigured:boolean}; github?: {keyConfigured:boolean} }

const TABS = [
  { id: "model", label: "模型", icon: Settings2 },
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
  const [prefs, setPrefs] = useState<Preferences>({disabledNodeIds:[], webSearchMode:"auto", profileId:null});
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
    setProfiles(p.data.profiles); setPrefs(w.data);
    if (admin) setIntegrations((await api.get<Integrations>("/settings/integrations")).data);
  }, ""); }, [admin]);

  const exportData = async () => {
    const result = await api.get("/settings/data/export", {timeout:120000});
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.data, null, 2)], {type:"application/json"}));
    const a = document.createElement("a"); a.href=url; a.download="稿流个人数据.json"; a.click(); URL.revokeObjectURL(url);
  };

  const selectedProfile = profiles.find(p => p.id === prefs.profileId);

  return (
    <div className="settings-page" style={{ padding: 32, maxWidth: 720, display: "grid", gap: 0, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>设置</h1>
      <p style={{ color: "var(--muted, #888)", fontSize: 13, marginBottom: 20 }}>
        管理写作模型、工作流和账号安全
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

      {/* Model tab */}
      {tab === "model" && (
        <div style={{ display: "grid", gap: 20 }}>
          <section style={{
            background: "var(--surface, #fff)", border: "1px solid var(--border, #e5e5e5)",
            borderRadius: 12, display: "grid", gap: 14, padding: 20,
          }}>
            <div>
              <strong style={{ fontSize: 14 }}>默认写作模型</strong>
              <p style={{ color: "var(--muted, #888)", fontSize: 12, marginTop: 2 }}>
                选择你的写作引擎；密钥由管理员统一配置
              </p>
            </div>
            <ToolbarSelect
              className="toolbar-select--fill toolbar-select--lg"
              label="默认写作模型"
              onChange={(value) => setPrefs({ ...prefs, profileId: value || null })}
              options={[
                { id: "", label: "平台默认" },
                ...profiles.map((p) => ({ id: p.id, label: `${p.name} · ${p.modelId}` })),
              ]}
              value={prefs.profileId ?? ""}
            />
            {selectedProfile && (
              <div style={{
                alignItems: "center", background: "var(--surface-muted, #f5f5f5)",
                borderRadius: 8, display: "flex", flexWrap: "wrap", gap: 14, padding: "10px 12px",
              }}>
                <span style={{ alignItems: "center", color: "var(--ink)", display: "flex", fontSize: 12, fontWeight: 600, gap: 4 }}>
                  <KeyRound size={13} /> {selectedProfile.keyConfigured ? "密钥已配置" : "密钥未配置"}
                </span>
                <span style={{ color: "var(--muted, #888)", fontSize: 11 }}>上下文 {selectedProfile.capabilities.contextWindow.toLocaleString()}</span>
                <span style={{ color: "var(--muted, #888)", fontSize: 11 }}>最大输出 {selectedProfile.capabilities.maxTokens.toLocaleString()}</span>
                {selectedProfile.capabilities.vision && <span style={{ background: "var(--accent-soft, #ebf4ff)", borderRadius: 4, color: "var(--accent, #5b8def)", fontSize: 10, padding: "2px 6px" }}>图片理解</span>}
                {selectedProfile.capabilities.reasoning && <span style={{ background: "var(--accent-soft, #ebf4ff)", borderRadius: 4, color: "var(--accent, #5b8def)", fontSize: 10, padding: "2px 6px" }}>推理模型</span>}
              </div>
            )}
            <button
              className="button button--primary"
              disabled={busy}
              onClick={() => void act(() => api.put("/settings/preferences", prefs))}
              style={{ alignItems: "center", display: "flex", fontSize: 14, gap: 6, justifyContent: "center", padding: "10px 16px" }}
            >
              <Save size={15} /> 保存模型选择
            </button>
          </section>

          {admin && profiles.length > 0 && (
            <section style={{ display: "grid", gap: 12 }}>
              <strong style={{ fontSize: 13, color: "var(--muted, #888)" }}>模型能力配置（管理员）</strong>
              {profiles.map(p => (
                <div
                  key={p.id}
                  style={{
                    background: "var(--surface, #fff)", border: "1px solid var(--border, #e5e5e5)",
                    borderRadius: 10, display: "grid", gap: 10, padding: 14,
                  }}
                >
                  <strong style={{ fontSize: 13 }}>{p.name} · {p.modelId}</strong>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                    {(["contextWindow", "maxTokens"] as const).map(key => (
                      <label key={key} style={{ color: "var(--muted, #888)", fontSize: 11 }}>
                        {key === "contextWindow" ? "上下文窗口" : "最大输出 tokens"}
                        <input
                          disabled={!admin}
                          onChange={e => setProfiles(ps => ps.map(item => item.id === p.id ? {...item, capabilities: {...item.capabilities, [key]: Number(e.target.value)}} : item))}
                          style={{ borderRadius: 6, border: "1px solid var(--border, #ddd)", fontSize: 13, padding: "6px 8px", width: 120 }}
                          type="number"
                          value={p.capabilities[key]}
                        />
                      </label>
                    ))}
                    {(["vision", "reasoning"] as const).map(key => (
                      <label key={key} style={{ alignItems: "center", color: "var(--ink)", display: "flex", fontSize: 12, gap: 4 }}>
                        <input
                          checked={p.capabilities[key]}
                          disabled={!admin}
                          onChange={e => setProfiles(ps => ps.map(item => item.id === p.id ? {...item, capabilities: {...item.capabilities, [key]: e.target.checked}} : item))}
                          type="checkbox"
                        />
                        {key === "vision" ? "图片理解" : "推理模型"}
                      </label>
                    ))}
                  </div>
                  <button
                    className="button button--quiet"
                    disabled={busy}
                    onClick={() => void act(() => api.patch(`/settings/profiles/${p.id}`, {capabilities: p.capabilities}))}
                    style={{ fontSize: 12, justifySelf: "start", padding: "6px 12px" }}
                  >
                    保存模型能力
                  </button>
                </div>
              ))}
            </section>
          )}
          {!admin && <p style={{ color: "var(--muted, #888)", fontSize: 12 }}>模型接入与密钥由管理员统一管理；此处选择仅影响你的写作。</p>}
        </div>
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
                <strong style={{ fontSize: 14 }}>服务接入</strong>
                <p style={{ color: "var(--muted, #888)", fontSize: 12, marginTop: 2 }}>
                  联网检索与代码仓库 API 密钥
                </p>
              </div>
              {(["tavily", "github"] as const).map(kind => (
                <div key={kind} style={{ display: "grid", gap: 6 }}>
                  <label style={{ color: "var(--ink)", fontSize: 13, fontWeight: 500 }}>
                    {kind === "tavily" ? "Tavily Key" : "GitHub Token"}
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
                可信 Host（每行一个）
                <textarea
                  onChange={e => setIntegrations({...integrations, trustedHosts: e.target.value.split("\n")})}
                  rows={3}
                  style={{ borderRadius: 8, border: "1px solid var(--border, #ddd)", fontSize: 13, padding: "8px 10px", resize: "vertical" }}
                  value={integrations.trustedHosts.join("\n")}
                />
              </label>
              <label style={{ color: "var(--ink)", display: "grid", fontSize: 13, fontWeight: 500, gap: 6 }}>
                发布桥地址
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
                <Save size={14} /> 保存接入设置
              </button>
            </section>
          )}
          {!admin && <p style={{ color: "var(--muted, #888)", fontSize: 12 }}>服务接入由管理员配置。</p>}
        </div>
      )}

      {/* Writing tab */}
      {tab === "writing" && (
        <section style={{
          background: "var(--surface, #fff)", border: "1px solid var(--border, #e5e5e5)",
          borderRadius: 12, display: "grid", gap: 14, padding: 20,
        }}>
          <div>
            <strong style={{ fontSize: 14 }}>默认工作流</strong>
            <p style={{ color: "var(--muted, #888)", fontSize: 12, marginTop: 2 }}>
              取消勾选以跳过创作流程中的对应节点
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
          <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
            <label style={{ color: "var(--ink)", fontSize: 13, fontWeight: 500 }}>外观</label>
            <ToolbarSelect
              label="外观"
              onChange={(value) => setSetting(value)}
              options={[
                { id: "system", label: "跟随系统" },
                { id: "light", label: "浅色" },
                { id: "dark", label: "深色" },
              ]}
              value={setting}
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
              API 密钥在服务端加密保存，导出不包含密钥。个人文章、素材、模板和助手会话按账号隔离；历史共享内容按共享规则可读。
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
                const next = {disabledNodeIds: [], webSearchMode: "auto" as const, profileId: null};
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
