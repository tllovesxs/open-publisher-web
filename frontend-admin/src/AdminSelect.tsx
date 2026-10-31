import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

/** Client PillSelect field appearance, with portal positioning and keyboard navigation. */
export function AdminSelect({ label, value, options, onChange, disabled = false }: {
  label: string; value: string; options: Array<{ id: string; label: string }>;
  onChange: (value: string) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (restoreFocus = false) => { setOpen(false); if (restoreFocus) trigger.current?.focus(); };
  const show = (index = Math.max(0, options.findIndex(o => o.id === value))) => {
    if (!disabled) { setActive(index); setOpen(true); }
  };
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect || !menu.current) return;
      const margin = 12, gap = 6;
      const below = Math.max(0, innerHeight - rect.bottom - margin - gap);
      const above = Math.max(0, rect.top - margin - gap);
      const desired = Math.min(menu.current.scrollHeight, 320);
      const up = below < desired && above > below;
      const maxHeight = Math.min(320, up ? above : below);
      const width = Math.min(rect.width, innerWidth - margin * 2);
      setStyle({ position: "fixed", width, maxHeight, left: Math.max(margin, Math.min(rect.left, innerWidth - width - margin)), top: up ? Math.max(margin, rect.top - gap - Math.min(desired, maxHeight)) : rect.bottom + gap });
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    const observer = new ResizeObserver(position);
    if (trigger.current) observer.observe(trigger.current);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); observer.disconnect(); };
  }, [open, options]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelectorAll<HTMLElement>("[role=option]")[active]?.focus({ preventScroll: true });
    menu.current?.querySelectorAll<HTMLElement>("[role=option]")[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) close(); };
    // Capture Escape before the containing drawer/modal handles it.
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(true); } };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape, true); };
  }, [open]);
  return <div className="admin-select">
    <button ref={trigger} type="button" className="admin-select__trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
      onClick={() => open ? close() : show()}
      onKeyDown={event => { if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); show(event.key === "End" ? options.length - 1 : event.key === "Home" ? 0 : undefined); } }}>
      <span>{options.find(o => o.id === value)?.label ?? value}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && createPortal(<div id={id} ref={menu} role="listbox" aria-label={label} className="admin-select__menu" style={style}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) close(); }}
      onKeyDown={event => {
        const key = event.key;
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) { event.preventDefault(); setActive(key === "Home" ? 0 : key === "End" ? options.length - 1 : (active + (key === "ArrowDown" ? 1 : -1) + options.length) % options.length); }
        else if (key === "Tab") { event.preventDefault(); close(true); const controls = [...document.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]')].filter(el => el.offsetParent !== null && !menu.current?.contains(el)); controls[controls.indexOf(trigger.current!) + (event.shiftKey ? -1 : 1)]?.focus(); }
        else if (key.length === 1 && key !== " " && !event.ctrlKey && !event.metaKey) { const match = options.findIndex((option, index) => index > active && option.label.toLocaleLowerCase().startsWith(key.toLocaleLowerCase())); const first = options.findIndex(option => option.label.toLocaleLowerCase().startsWith(key.toLocaleLowerCase())); if (match >= 0 || first >= 0) setActive(match >= 0 ? match : first); }
      }}>
      {options.map((option, index) => <button type="button" role="option" aria-selected={option.id === value} tabIndex={index === active ? 0 : -1} className="admin-select__option" key={option.id} onFocus={() => setActive(index)} onClick={() => { onChange(option.id); close(true); }}><span>{option.label}</span>{option.id === value && <Check size={14} aria-hidden="true" />}</button>)}
    </div>, document.body)}
  </div>;
}
