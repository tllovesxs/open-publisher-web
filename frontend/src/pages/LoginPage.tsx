import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { LogIn, UserPlus } from "lucide-react";
import { useAuth } from "../auth/AuthContext";

export default function LoginPage() {
  const navigate = useNavigate();
  const { user, login, register } = useAuth();
  const [searchParams] = useSearchParams();
  const switching = searchParams.get("switch") === "1";
  const cancel = () => navigate(user ? "/settings" : "/", { replace: true, state: { settingsTab: "account" } });
  const [mode, setMode] = useState<"login" | "register">(
    searchParams.get("mode") === "register" ? "register" : "login",
  );
  const [form, setForm] = useState({ username: "", password: "", displayName: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!switching || busy) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [switching, busy, user, navigate]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await login(form.username, form.password);
      else await register(form.username, form.password, form.displayName || form.username);
      navigate("/", { replace: true });
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "登录失败，请检查账号信息。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <strong>稿流</strong>
          <span>AI 内容工作台</span>
        </div>
        <h1>{mode === "login" ? switching ? "切换账号" : "登录" : "创建账号"}</h1>
        <p className="muted">{switching && user ? `当前账号：${user.displayName || user.username}。登录新账号后完成切换。` : "使用用户名和密码继续创作、管理文章与素材。"}</p>

        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}>
          <label>
            <span>用户名</span>
            <input
              autoComplete="username"
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="username"
              required
              value={form.username}
            />
          </label>
          <label>
            <span>密码</span>
            <input
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              minLength={mode === "register" ? 8 : undefined}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="至少 8 位"
              required
              type="password"
              value={form.password}
            />
          </label>
          {mode === "register" && (
            <label>
              <span>显示名称</span>
              <input
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                placeholder="可选"
                value={form.displayName}
              />
            </label>
          )}
          <button className="button button--primary" disabled={busy} type="submit">
            {mode === "login" ? <LogIn size={16} /> : <UserPlus size={16} />}
            {busy ? "处理中..." : mode === "login" ? "登录" : "注册"}
          </button>
        </form>

        {switching && <button className="button button--quiet" style={{ width: "100%", marginTop: 12 }} disabled={busy} onClick={cancel} type="button">取消切换</button>}

        {error && <div className="auth-error" role="alert">{error}</div>}

        <button
          className="auth-switch"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(null);
          }}
          type="button">
          {mode === "login" ? "还没有账号？注册" : "已有账号？登录"}
        </button>
        <button
          className="auth-switch"
          onClick={() => navigate("/landing")}
          type="button"
        >
          了解稿流 →
        </button>
      </div>
    </main>
  );
}
