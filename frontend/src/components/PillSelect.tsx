import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

// 工具栏药丸下拉：原生 select 的选项列表由操作系统渲染（直角、无法定制），
// 与药丸形按钮观感冲突，故统一替换为自绘圆角菜单。
interface PillSelectOption<T extends string> {
  id: T;
  label: string;
}

interface PillSelectProps<T extends string> {
  ariaLabel?: string;
  label: string;
  onChange: (value: T) => void;
  options: Array<PillSelectOption<T>>;
  title?: string;
  value: T;
  /** "field"：表单字段样式（全宽带边框，弹窗内使用）；默认药丸样式。 */
  variant?: "pill" | "field";
}

export function PillSelect<T extends string>({
  ariaLabel,
  label,
  onChange,
  options,
  title,
  value,
  variant = "pill",
}: PillSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({ visibility: "hidden" });

  // 表单菜单脱离弹窗的 overflow 裁剪，仍随触发器滚动及视口尺寸变化定位。
  useLayoutEffect(() => {
    if (!open || variant !== "field") return;
    const updatePosition = () => {
      const trigger = rootRef.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const margin = 12;
      const gap = 6;
      const below = Math.max(0, window.innerHeight - trigger.bottom - margin - gap);
      const above = Math.max(0, trigger.top - margin - gap);
      const desiredHeight = Math.min(menu.scrollHeight, 320);
      const upwards = below < desiredHeight && above > below;
      const maxHeight = Math.min(320, upwards ? above : below);
      const width = Math.min(trigger.width, window.innerWidth - margin * 2);
      setMenuStyle({
        position: "fixed",
        top: upwards ? Math.max(margin, trigger.top - gap - Math.min(desiredHeight, maxHeight)) : trigger.bottom + gap,
        left: Math.max(margin, Math.min(trigger.left, window.innerWidth - width - margin)),
        width,
        maxHeight,
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    const observer = new ResizeObserver(updatePosition);
    if (rootRef.current) observer.observe(rootRef.current);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      observer.disconnect();
    };
  }, [open, variant, options]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false);
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

  const current = options.find((option) => option.id === value)?.label ?? value;
  const menu = open && (
    <div
      aria-label={ariaLabel ?? label}
      className={`creation-pill-select__menu${variant === "field" ? " creation-pill-select__menu--floating" : ""}`}
      id={menuId}
      ref={menuRef}
      role="listbox"
      style={variant === "field" ? menuStyle : undefined}
    >
      {options.map((option) => (
        <button
          aria-selected={option.id === value}
          className={`creation-pill-select__item${option.id === value ? " is-selected" : ""}`}
          key={option.id}
          onClick={() => {
            onChange(option.id);
            setOpen(false);
          }}
          role="option"
          type="button"
        >
          <span>{option.label}</span>
          {option.id === value && <Check aria-hidden="true" size={14} />}
        </button>
      ))}
    </div>
  );

  return (
    <div
      className={`creation-pill-select${variant === "field" ? " creation-pill-select--field" : " creation-toolbar__choice"}${open ? " is-open" : ""}`}
      ref={rootRef}
      title={title}
    >
      <button
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-haspopup="listbox"
        aria-label={ariaLabel ?? label}
        className="creation-pill-select__trigger"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        {variant === "pill" && <span>{label}</span>}
        <strong>{current}</strong>
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      {variant === "field" ? createPortal(menu, document.body) : menu}
    </div>
  );
}
