import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useAdminAuth } from "./AuthContext";
import SideRays from "./components/SideRays/SideRays";

export default function AdminLoginPage() {
  const { login } = useAdminAuth();
  const [form, setForm] = useState({ username: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await login(form.username, form.password);
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "登录失败。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="admin-login auth-page">
      <section className="auth-visual" aria-label="稿流 AI 内容创作">
        <div className="auth-visual__image" aria-hidden="true" />
        <SideRays
          className="auth-visual__rays"
          rayColor1="#d8a85f"
          rayColor2="#8c72b8"
          origin="top-left"
          speed={1.1}
          intensity={1.45}
          spread={2.4}
          density={6}
          sharpness={0.25}
          glow={1.1}
          dust={0.14}
          opacity={0.78}
          followMouse
          mouseInfluence={0.48}
        />
        <div className="auth-visual__glow" />
        <div className="auth-visual__grid" />
        <div className="auth-visual__content">
          <span className="auth-visual__eyebrow">GAOLIU · AI WRITING</span>
          <h2>让灵感流动<br /><em>让文字成稿</em></h2>
          <p>从一个想法开始，快速生成清晰、有温度的内容。</p>
          <div className="auth-visual__line" aria-hidden="true" />
        </div>
      </section>
      <section className="auth-form-panel">
      <form
        className="admin-card auth-card auth-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}>
        <div className="admin-brand">
          <ShieldCheck size={20} />
          <strong>稿流管理控制台</strong>
        </div>
        <h1>管理员登录</h1>
        <p className="admin-login-description">使用管理员账号管理内容、用户与平台配置。</p>
        <label>
          <span>管理员账号</span>
          <input
            autoComplete="username"
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            required
            value={form.username}
          />
        </label>
        <label>
          <span>密码</span>
          <input
            autoComplete="current-password"
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
            type="password"
            value={form.password}
          />
        </label>
        <button className="primary" disabled={busy} type="submit">{busy ? "登录中..." : "登录管理端"}</button>
        {error && <div className="error" role="alert">{error}</div>}
      </form>
      </section>
    </main>
  );
}
