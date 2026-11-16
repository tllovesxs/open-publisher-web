import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useAdminAuth } from "./AuthContext";
import { StatusNotice } from "./StatusNotice";

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
    <main className="admin-login">
      <form
        className="admin-card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}>
        <div className="admin-brand">
          <ShieldCheck size={20} />
          <strong>稿流管理控制台</strong>
        </div>
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
        {error && <StatusNotice message={error} tone="danger" />}
      </form>
    </main>
  );
}
