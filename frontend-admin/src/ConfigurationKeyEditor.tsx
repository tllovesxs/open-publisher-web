import { useState } from "react";
import { api } from "./api";

export function ConfigurationKeyEditor({ endpoint, configured, hint, onChanged }: { endpoint: string; configured?: boolean; hint?: string; onChanged: () => Promise<void> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const update = async (remove = false) => {
    if (!remove && value.trim().length < 4) { setError("密钥长度至少 4 位。"); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      if (remove) await api.delete(endpoint); else await api.put(endpoint, { apiKey: value.trim() });
      setValue(""); await onChanged(); setMessage(remove ? "此配置的密钥已移除。" : "此配置的密钥已保存。");
    } catch { setError("密钥操作失败，请重试。"); }
    finally { setBusy(false); }
  };
  return <div className="configuration-key-editor">
    <div className="key-editor"><input aria-label="当前配置访问密钥" autoComplete="new-password" disabled={busy} onChange={event => setValue(event.target.value)} placeholder="填写当前所选配置的访问密钥" type="password" value={value} /><button className="primary" disabled={busy} onClick={() => void update()} type="button">保存密钥</button>{configured && <button className="quiet" disabled={busy} onClick={() => void update(true)} type="button">移除密钥</button>}</div>
    <p className="muted">{configured ? `此配置密钥已配置${hint ? ` ${hint}` : ""}` : "此配置尚未填写密钥"}</p>
    {error && <div className="error" role="alert">{error}</div>}{message && <div className="success" role="status">{message}</div>}
  </div>;
}
