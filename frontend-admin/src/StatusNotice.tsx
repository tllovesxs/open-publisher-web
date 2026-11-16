import { AlertCircle, CheckCircle2, X } from "lucide-react";
import type { ReactNode } from "react";

type StatusTone = "success" | "danger";

interface StatusNoticeProps {
  message: ReactNode;
  onDismiss?: () => void;
  tone?: StatusTone;
}

export function StatusNotice({ message, onDismiss, tone = "success" }: StatusNoticeProps) {
  const Icon = tone === "success" ? CheckCircle2 : AlertCircle;
  const label = tone === "success" ? "关闭成功通知" : "关闭错误通知";

  return (
    <div
      className={`admin-note admin-note--${tone}`}
      role={tone === "success" ? "status" : "alert"}
    >
      <Icon aria-hidden="true" size={16} />
      <div className="admin-note__message">{message}</div>
      {onDismiss && (
        <button aria-label={label} className="admin-note__close" onClick={onDismiss} type="button">
          <X aria-hidden="true" size={14} />
        </button>
      )}
    </div>
  );
}
