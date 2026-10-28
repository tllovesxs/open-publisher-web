import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * 全局统一的自定义下拉：替代原生 <select>（原生弹窗直角且样式不可控）。
 * - 圆角触发器 + 圆角菜单、阴影、悬停/选中态
 * - 点击外部 / Esc 关闭，listbox/option 无障碍标注
 * - align="right" 菜单右对齐；direction="up" 菜单向上弹出（底部工具条）
 * - className 可叠加（如 toolbar-select--fill 占满容器宽度）
 */
export function ToolbarSelect<T extends string>({
  align = "left",
  className = "",
  direction = "down",
  disabled = false,
  label,
  onChange,
  options,
  value,
}: {
  align?: "left" | "right";
  className?: string;
  direction?: "down" | "up";
  disabled?: boolean;
  label: string;
  onChange: (value: T) => void;
  options: Array<{ id: T; label: string }>;
  value: T;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const current = options.find((item) => item.id === value) ?? options[0];
  const rootClass = [
    "toolbar-select",
    align === "right" ? "toolbar-select--right" : "",
    direction === "up" ? "toolbar-select--up" : "",
    className,
  ].filter(Boolean).join(" ");

  return (
    <div className={rootClass} ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={label}
        className="toolbar-select__trigger"
        disabled={disabled}
        onClick={() => setOpen((state) => !state)}
        type="button"
      >
        <span>{current?.label}</span>
        <ChevronDown aria-hidden="true" className={`toolbar-select__chevron${open ? " is-open" : ""}`} size={13} />
      </button>
      {open && (
        <div aria-label={label} className="toolbar-select__menu" role="listbox">
          {options.map((item) => (
            <button
              aria-selected={item.id === value}
              className={`toolbar-select__option${item.id === value ? " is-active" : ""}`}
              key={item.id}
              onClick={() => {
                onChange(item.id);
                setOpen(false);
              }}
              role="option"
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
