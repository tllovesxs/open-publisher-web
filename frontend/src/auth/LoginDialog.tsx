import { useEffect, useRef, useState } from "react";
import LoginPage from "../pages/LoginPage";

export default function LoginPrompt() {
  const [prompt, setPrompt] = useState<{ onSuccess?: () => void } | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const show = (event: Event) => {
      previousFocus.current = document.activeElement as HTMLElement;
      setPrompt(current => current || (event as CustomEvent).detail || {});
    };
    window.addEventListener("opw:request-login", show);
    return () => window.removeEventListener("opw:request-login", show);
  }, []);
  useEffect(() => {
    if (!prompt) return;
    const shell = document.querySelector(".app-shell");
    shell?.setAttribute("inert", "");
    return () => { shell?.removeAttribute("inert"); previousFocus.current?.focus(); };
  }, [prompt]);
  if (!prompt) return null;
  return <div className="studio-modal" style={{ zIndex: 3000 }}>
    <div className="studio-modal__scrim" />
    <section role="dialog" aria-modal="true" aria-label="登录" style={{ position: "relative", width: "min(440px, 100%)", maxHeight: "calc(100dvh - 40px)", overflowY: "auto" }} onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input, button, a[href]')).filter(el => !(el as HTMLButtonElement).disabled);
      const target = event.shiftKey ? controls[0] : controls[controls.length - 1];
      if (document.activeElement === target) { event.preventDefault(); (event.shiftKey ? controls[controls.length - 1] : controls[0])?.focus(); }
    }}>
      <LoginPage onCancel={() => setPrompt(null)} onComplete={() => { const next = prompt.onSuccess; setPrompt(null); next?.(); }} />
    </section>
  </div>;
}
