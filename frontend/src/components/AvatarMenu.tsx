import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronUp, CircleUserRound, LogIn, LogOut, UserPlus } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import "./AvatarMenu.css";

// 侧栏账号入口：复用登录、注册与退出，菜单向上展开。
export function AvatarMenu({ runtimeReady, onNavigate }: { runtimeReady: boolean; onNavigate: () => void }) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const initial = (user?.displayName || user?.username || "").trim().charAt(0).toUpperCase();

  return (
    <div className="avatar-menu avatar-menu--sidebar" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={user ? "账号菜单" : "登录或注册"}
        className="avatar-menu__trigger"
        onClick={() => setOpen((v) => !v)}
        title={user ? user.displayName || user.username : "登录 / 注册"}
        type="button"
      >
        {user ? (
          <span aria-hidden="true" className="avatar-menu__avatar">{initial || "·"}</span>
        ) : (
          <CircleUserRound aria-hidden="true" size={22} strokeWidth={1.8} />
        )}
        <span className="avatar-menu__identity"><strong>{user ? user.displayName || user.username : "登录稿流"}</strong><small>{user ? user.role === "admin" ? "管理员" : "个人账号" : "同步你的创作内容"}</small></span>
        <ChevronUp aria-hidden="true" size={14} className="avatar-menu__chevron" />
      </button>

      {open && (
        <div className="avatar-menu__panel" role="menu" aria-label="账号菜单">
          <div className="avatar-menu__runtime"><span className={runtimeReady ? "is-ready" : ""} />{runtimeReady ? "创作引擎已就绪" : "正在连接创作引擎"}</div>
          {user ? (
            <>
              <div className="avatar-menu__header">
                <strong>{user.displayName || user.username}</strong>
                <small>@{user.username}{user.role === "admin" ? " · 管理员" : ""}</small>
              </div>
              <button
                className="avatar-menu__item"
                onClick={async () => {
                  setOpen(false);
                  await logout();
                  onNavigate();
                  navigate("/", { replace: true });
                }}
                role="menuitem"
                type="button"
              >
                <LogOut aria-hidden="true" size={15} />
                退出登录
              </button>
            </>
          ) : (
            <>
              <div className="avatar-menu__header">
                <strong>登录稿流</strong>
                <small>登录后同步文章、模板与素材</small>
              </div>
              <button
                className="avatar-menu__item"
                onClick={() => { setOpen(false); onNavigate(); navigate("/login"); }}
                role="menuitem"
                type="button"
              >
                <LogIn aria-hidden="true" size={15} />
                登录
              </button>
              <button
                className="avatar-menu__item"
                onClick={() => { setOpen(false); onNavigate(); navigate("/login?mode=register"); }}
                role="menuitem"
                type="button"
              >
                <UserPlus aria-hidden="true" size={15} />
                注册新账号
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
