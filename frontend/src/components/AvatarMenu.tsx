import { createPortal } from "react-dom";
import { useLayoutEffect } from "react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronUp, CircleUserRound, LogIn, LogOut, Moon, Sun, UserPlus } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import "./AvatarMenu.css";

// 侧栏账号入口：复用登录、注册与退出，菜单向上展开。
export function AvatarMenu({ runtimeReady, onNavigate, theme, onToggleTheme }: { runtimeReady: boolean; onNavigate: () => void; theme: "light" | "dark"; onToggleTheme: () => void }) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node) && !panelRef.current?.contains(event.target as Node)) setOpen(false);
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

  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 12, bottom: 80 });
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const bounds = rootRef.current?.getBoundingClientRect();
      if (bounds) setPosition({ left: Math.max(12, Math.min(bounds.left, window.innerWidth - 272)), bottom: window.innerHeight - bounds.top + 10 });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
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

      {open && createPortal(
        <div ref={panelRef} className="avatar-menu__panel account-popover" style={position} role="menu" aria-label="账号菜单">
          <button className="avatar-menu__item account-popover__theme" role="menuitem" type="button" onClick={onToggleTheme}>
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}{theme === "light" ? "切换深色主题" : "切换浅色主题"}
          </button>
          {user ? (
            <>
              <div className="avatar-menu__header">
                <span className="account-popover__avatar" aria-hidden="true">{initial || "·"}</span>
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
                <span className="account-popover__avatar" aria-hidden="true">{initial || "·"}</span>
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
          <div className="avatar-menu__runtime"><span className={runtimeReady ? "is-ready" : ""} />{runtimeReady ? "创作引擎已就绪" : "正在连接创作引擎"}</div>
        </div>, document.body
      )}
    </div>
  );
}
