import {
  Bold,
  Heading2,
  ImagePlus,
  Italic,
  List,
  MoreHorizontal,
  Quote,
  WandSparkles,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { usePersistentState } from "../../lib/usePersistentState";
import { ToolbarSelect } from "../ui/ToolbarSelect";
import { MarkdownPreview } from "./MarkdownPreview";
import type { MarkdownSpan } from "./articleMarkdown";
import { extractArticleFigures } from "./ArticleImagePane";
import { resolveAssetReferences } from "./MarkdownPreview";

/**
 * Web 版 MarkdownWorkbench（蓝本 MarkdownWorkbench 的完整迁移，团队自有）：
 * - 格式工具栏（标题/粗体/斜体/列表/引用/插图/分隔线）
 * - 行号槽 + 分栏比例滚动同步（双向）
 * - 图片拖拽 / 粘贴导入（onImageFileDrop 上传后插入光标处）
 * - 选中文本浮出「AI 修改选中内容」
 * - 底部状态栏（脏状态 / 行数 / 字数 / 导入进度）
 */

export type EditorMode = "edit" | "split" | "preview";
export type PreviewPlatform = "general" | "twitter" | "xiaohongshu" | "wechat";

export interface MarkdownSelection {
  start: number;
  end: number;
  text: string;
}

export interface ImageInsertion {
  alt: string;
  src: string;
}

interface SelectionActionPosition {
  left: number;
  top: number;
}

interface MarkdownWorkbenchProps {
  markdown: string;
  onMarkdownChange: (markdown: string) => void;
  dirty: boolean;
  saved?: boolean;
  editorMode: EditorMode;
  onEditorModeChange: (mode: EditorMode) => void;
  onImageFileDrop?: (file: File) => Promise<ImageInsertion>;
  streaming?: boolean;
  streamingLabel?: string;
  previewPlatform?: PreviewPlatform;
  onPreviewPlatformChange?: (platform: PreviewPlatform) => void;
  onRequestSelectionRewrite?: (selection: MarkdownSelection) => void;
  onFigureDrop?: (figure: { kind: "image" | "mermaid"; span: MarkdownSpan }, line: number) => void;
  onInsertAtLine?: (snippet: string, line: number) => void;
}

const editorModes: Array<{ id: EditorMode; label: string }> = [
  { id: "edit", label: "仅编辑" },
  { id: "split", label: "编辑与预览" },
  { id: "preview", label: "仅预览" },
];

const previewPlatforms: Array<{ id: PreviewPlatform; label: string }> = [
  { id: "general", label: "通用 Markdown" },
  { id: "twitter", label: "Twitter / X" },
  { id: "xiaohongshu", label: "小红书" },
  { id: "wechat", label: "公众号" },
];

type ScrollablePane = HTMLTextAreaElement | HTMLDivElement;

// 落点光标定位：把一份同样式的镜像层盖在 textarea 上，用
// caretPositionFromPoint / caretRangeFromPoint 命中字符偏移。
// 技术思路来自开源 textarea-caret-position（MIT）一类的镜像测量实现。
function caretOffsetFromPoint(textarea: HTMLTextAreaElement, clientX: number, clientY: number): number | null {
  try {
    const rect = textarea.getBoundingClientRect();
    const mirror = document.createElement("div");
    const source = window.getComputedStyle(textarea);
    for (const prop of [
      "boxSizing", "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing",
      "lineHeight", "padding", "border", "whiteSpace", "wordWrap", "overflowWrap", "tabSize",
    ] as const) {
      mirror.style[prop] = source[prop];
    }
    mirror.style.position = "fixed";
    mirror.style.left = `${rect.left}px`;
    mirror.style.top = `${rect.top}px`;
    mirror.style.width = `${rect.width}px`;
    mirror.style.height = `${rect.height}px`;
    mirror.style.margin = "0";
    mirror.style.overflow = "hidden";
    mirror.style.opacity = "0";
    mirror.style.zIndex = "2147483000";
    mirror.textContent = textarea.value;
    document.body.appendChild(mirror);
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;
    let offset: number | null = null;
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    if (doc.caretPositionFromPoint) {
      const pos = doc.caretPositionFromPoint(clientX, clientY);
      if (pos?.offsetNode) offset = pos.offset;
    } else if (doc.caretRangeFromPoint) {
      const range = doc.caretRangeFromPoint(clientX, clientY);
      if (range && mirror.contains(range.startContainer)) offset = range.startOffset;
    }
    mirror.remove();
    if (offset === null || offset < 0 || offset > textarea.value.length) return null;
    return offset;
  } catch {
    return null;
  }
}
function syncScrollPosition(source: ScrollablePane, target: ScrollablePane): number | null {
  const sourceMaximum = Math.max(0, source.scrollHeight - source.clientHeight);
  const targetMaximum = Math.max(0, target.scrollHeight - target.clientHeight);
  const progress = sourceMaximum > 0 ? Math.min(1, Math.max(0, source.scrollTop / sourceMaximum)) : 0;
  const nextScrollTop = progress * targetMaximum;
  if (Math.abs(target.scrollTop - nextScrollTop) > 0.5) {
    target.scrollTop = nextScrollTop;
    return nextScrollTop;
  }
  return null;
}

function positionSelectionAction(editor: HTMLTextAreaElement): SelectionActionPosition {
  const selectionEnd = editor.selectionEnd;
  const doc = editor.ownerDocument;
  const mirror = doc.createElement("div");
  const marker = doc.createElement("span");
  const computed = window.getComputedStyle(editor);
  const rect = editor.getBoundingClientRect();
  const copiedStyles = [
    "boxSizing", "fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth",
    "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "tabSize", "textTransform",
    "wordSpacing",
  ] as const;
  Object.assign(mirror.style, {
    position: "fixed", visibility: "hidden", overflow: "hidden", whiteSpace: "pre-wrap",
    overflowWrap: "break-word", wordBreak: "break-word",
    top: `${rect.top - editor.scrollTop}px`, left: `${rect.left - editor.scrollLeft}px`,
    width: `${editor.clientWidth}px`,
  });
  copiedStyles.forEach((property) => {
    (mirror.style as unknown as Record<string, string>)[property] = computed[property];
  });
  mirror.textContent = editor.value.slice(0, selectionEnd);
  marker.textContent = editor.value.slice(selectionEnd, selectionEnd + 1) || "\u200b";
  mirror.append(marker);
  doc.body.append(mirror);
  const markerRect = marker.getBoundingClientRect();
  mirror.remove();
  return {
    left: Math.max(8, Math.min(markerRect.right + 10, window.innerWidth - 205)),
    top: Math.max(8, Math.min(markerRect.bottom + 10, window.innerHeight - 42)),
  };
}

export function MarkdownWorkbench({
  markdown,
  onMarkdownChange,
  dirty,
  saved = true,
  editorMode,
  onEditorModeChange,
  onImageFileDrop,
  streaming = false,
  streamingLabel = "正在撰写正文",
  previewPlatform = "general",
  onPreviewPlatformChange,
  onRequestSelectionRewrite,
  onFigureDrop,
  onInsertAtLine,
}: MarkdownWorkbenchProps) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const latestMarkdownRef = useRef(markdown);
  latestMarkdownRef.current = markdown;
  const [streamPreview, setStreamPreview] = useState(markdown);
  useEffect(() => {
    if (!streaming) return;
    setStreamPreview(latestMarkdownRef.current);
    const timer = window.setInterval(() => setStreamPreview(latestMarkdownRef.current), 100);
    return () => window.clearInterval(timer);
  }, [streaming]);
  const previewRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef({ start: 0, end: 0 });
  // 用户是否在编辑器里主动放置过光标。程序化赋值会让未聚焦的 textarea
  // 隐式把 caret 停在文末，不能拿它的 selectionStart 当默认插入位置。
  const userCaretRef = useRef(false);
  const scrollSourceRef = useRef<"editor" | "preview">("editor");
  const synchronizedScrollTopsRef = useRef<Record<"editor" | "preview", number | null>>({
    editor: null,
    preview: null,
  });
  const [isDroppingImage, setIsDroppingImage] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [previewDropActive, setPreviewDropActive] = useState(false);
  const [imageDropError, setImageDropError] = useState<string | null>(null);
  const [selectedText, setSelectedText] = useState<MarkdownSelection | null>(null);
  const [selectionActionPosition, setSelectionActionPosition] = useState<SelectionActionPosition | null>(null);

  const surfaceRef = useRef<HTMLDivElement>(null);
  // 分栏比例（0.2–0.8，编辑区占比），拖拽分隔条调节并持久化。
  const [splitRatio, setSplitRatio] = usePersistentState("opw.editor-split-ratio", 0.5);

  const beginSplitDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const surface = surfaceRef.current;
    if (!surface) return;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("is-pane-dragging");
    const onMove = (ev: PointerEvent) => {
      const rect = surface.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = (ev.clientX - rect.left) / rect.width;
      // 按像素保底：编辑区至少 180px、预览区至少 140px，避免拖到极限挤成单字竖排。
      const minRatio = Math.min(0.5, 180 / rect.width);
      const maxRatio = Math.max(0.5, 1 - 140 / rect.width);
      setSplitRatio(Math.min(0.8, Math.max(0.2, Math.min(maxRatio, Math.max(minRatio, ratio)))));
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      document.body.classList.remove("is-pane-dragging");
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp, { once: true });
    handle.addEventListener("pointercancel", onUp, { once: true });
  };
  const lines = markdown.split("\n").length;
  const characters = markdown.replace(/\s/g, "").length;

  const applyMarkup = (prefix: string, suffix = prefix, placeholder = "文本") => {
    const editor = editorRef.current;
    if (!editor) return;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    selectionRef.current = { start, end };
    const selected = markdown.slice(start, end) || placeholder;
    onMarkdownChange(`${markdown.slice(0, start)}${prefix}${selected}${suffix}${markdown.slice(end)}`);
    window.requestAnimationFrame(() => {
      editor.focus();
      editor.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
    });
  };

  const insertBlock = (prefix: string, placeholder: string) => applyMarkup(prefix, "", placeholder);

  const insertAtSelection = (value: string) => {
    const editor = editorRef.current;
    // 只信任用户主动放置过的光标；用户没碰过编辑器时回到最近捕获的位置（初始为正文开头），避免静默落到文末。
    const start = editor && userCaretRef.current ? editor.selectionStart : selectionRef.current.start;
    const end = editor && userCaretRef.current ? editor.selectionEnd : selectionRef.current.end;
    const before = markdown.slice(0, start);
    const after = markdown.slice(end);
    const prefix = before && !before.endsWith("\n") ? "\n\n" : "";
    const suffix = after && !after.startsWith("\n") ? "\n\n" : "";
    onMarkdownChange(`${before}${prefix}${value}${suffix}${after}`);
    selectionRef.current = { start: start + prefix.length + value.length, end: start + prefix.length + value.length };
    window.requestAnimationFrame(() => {
      if (!editor) return;
      editor.focus();
      const position = start + prefix.length + value.length;
      editor.setSelectionRange(position, position);
    });
  };

  const importFiles = async (files: File[]) => {
    if (!onImageFileDrop) {
      setImageDropError("暂时无法导入图片，请稍后重试。");
      return;
    }
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) {
      setImageDropError("只能拖入图片文件。");
      return;
    }
    setIsDroppingImage(true);
    setImageDropError(null);
    try {
      const inserted = await Promise.all(images.map((file) => onImageFileDrop(file)));
      insertAtSelection(inserted.map(({ alt, src }) => `![${alt}](${src})`).join("\n\n"));
    } catch (error) {
      setImageDropError(error instanceof Error ? error.message : "图片导入失败，请重试。");
    } finally {
      setIsDroppingImage(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    setIsDropTarget(false);
    // 配图栏拖入：载荷带原文 span，编辑器按落点行调用 onFigureDrop 移动图片位置。
    const figurePayload = event.dataTransfer.getData("application/x-opw-figure");
    if (figurePayload && onFigureDrop) {
      try {
        const parsed = JSON.parse(figurePayload) as { kind: "image" | "mermaid"; span: MarkdownSpan };
        const editor = editorRef.current;
        const offset =
          (editor ? caretOffsetFromPoint(editor, event.clientX, event.clientY) : null)
          ?? editor?.selectionStart
          ?? markdown.length;
        const line = markdown.slice(0, offset).split("\n").length;
        onFigureDrop(parsed, line);
      } catch {
        // 载荷异常时忽略，不影响正文
      }
      return;
    }
    // 素材库与新上传配图：按实际落点插入，文件拖入走导入。
    const mediaMarkdown = event.dataTransfer.getData("text/x-media-markdown");
    if (mediaMarkdown) {
      const editor = editorRef.current;
      const offset = editor ? caretOffsetFromPoint(editor, event.clientX, event.clientY) : null;
      if (editor && offset !== null) editor.setSelectionRange(offset, offset);
      userCaretRef.current = true;
      insertAtSelection(mediaMarkdown);
      return;
    }
    void importFiles(Array.from(event.dataTransfer.files));
  };

  // 预览区拖放：用真实 DOM 的 caret 命中 + data-md-line 标注把落点映射回源 Markdown 行。
  const previewLineFromPoint = (event: React.DragEvent<HTMLElement>): number | null => {
    const pane = previewRef.current;
    if (!pane) return null;
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    let node: Node | null = null;
    if (doc.caretPositionFromPoint) {
      node = doc.caretPositionFromPoint(event.clientX, event.clientY)?.offsetNode ?? null;
    } else if (doc.caretRangeFromPoint) {
      node = doc.caretRangeFromPoint(event.clientX, event.clientY)?.startContainer ?? null;
    }
    const element = node instanceof Element ? node : node?.parentElement ?? null;
    const block = (element && pane.contains(element) ? element.closest<HTMLElement>("[data-md-line]") : null)
      ?? (event.target as HTMLElement).closest<HTMLElement>("[data-md-line]");
    if (!block || !pane.contains(block)) return markdown.split("\n").length + 1;
    const startLine = Number(block.dataset.mdLine);
    const endLine = Number(block.dataset.mdEnd);
    if (!Number.isFinite(startLine)) return null;
    const rect = block.getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2 ? endLine + 1 : startLine;
  };

  const handlePreviewDragStart = (event: React.DragEvent<HTMLElement>) => {
    // 预览里的图片可直接拖动换位置：按 src 匹配回源 Markdown 中的 figure span。
    const target = event.target as HTMLElement;
    if (!(target instanceof HTMLImageElement)) return;
    const src = target.getAttribute("src") ?? "";
    const figures = extractArticleFigures(markdown)
      .map((item) => item.kind === "image"
        ? { ...item, src: resolveAssetReferences(`](${item.src})`).slice(2, -1) }
        : item);
    const figure = figures.find((item) => item.kind === "image" && (item.src === src || src.endsWith(item.src) || item.src.endsWith(src)));
    if (!figure) return;
    event.dataTransfer.setData(
      "application/x-opw-figure",
      JSON.stringify({ kind: figure.kind, span: figure.span }),
    );
    event.dataTransfer.effectAllowed = "move";
  };

  const handlePreviewDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setPreviewDropActive(false);
    const figurePayload = event.dataTransfer.getData("application/x-opw-figure");
    if (figurePayload && onFigureDrop) {
      try {
        const parsed = JSON.parse(figurePayload) as { kind: "image" | "mermaid"; span: MarkdownSpan };
        const fallbackLine = Number((event.target as HTMLElement).closest?.("[data-md-line]")?.getAttribute("data-md-line"));
        const line = previewLineFromPoint(event) ?? (Number.isFinite(fallbackLine) && fallbackLine > 0 ? fallbackLine : null);
        if (line !== null) onFigureDrop(parsed, line);
      } catch {
        // 载荷异常时忽略
      }
      return;
    }
    const mediaMarkdown = event.dataTransfer.getData("text/x-media-markdown");
    if (mediaMarkdown && onInsertAtLine) {
      const line = previewLineFromPoint(event);
      if (line !== null) onInsertAtLine(mediaMarkdown, line);
    }
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    event.preventDefault();
    void importFiles(images);
  };

  const captureSelection = (editor: HTMLTextAreaElement) => {
    userCaretRef.current = true;
    const selection = {
      start: editor.selectionStart,
      end: editor.selectionEnd,
      text: markdown.slice(editor.selectionStart, editor.selectionEnd),
    };
    selectionRef.current = selection;
    const next = selection.text.trim() ? selection : null;
    setSelectedText(next);
    setSelectionActionPosition(next ? positionSelectionAction(editor) : null);
  };

  const updateSelectionActionPosition = (editor: HTMLTextAreaElement) => {
    if (!selectedText?.text.trim()) return;
    setSelectionActionPosition(positionSelectionAction(editor));
  };

  const syncPaneScroll = (source: ScrollablePane, target: ScrollablePane, targetKey: "editor" | "preview") => {
    const synchronizedTop = syncScrollPosition(source, target);
    if (synchronizedTop !== null) {
      synchronizedScrollTopsRef.current[targetKey] = synchronizedTop;
    }
  };

  const consumesSynchronizedScroll = (pane: "editor" | "preview", element: ScrollablePane) => {
    const expectedTop = synchronizedScrollTopsRef.current[pane];
    if (expectedTop === null) return false;
    synchronizedScrollTopsRef.current[pane] = null;
    return Math.abs(element.scrollTop - expectedTop) <= 0.5;
  };

  const syncPreviewToEditorScroll = (editor: HTMLTextAreaElement) => {
    const preview = previewRef.current;
    if (editorMode === "split" && preview) {
      if (consumesSynchronizedScroll("editor", editor)) return;
      scrollSourceRef.current = "editor";
      syncPaneScroll(editor, preview, "preview");
    }
  };

  const syncEditorToPreviewScroll = (preview: HTMLDivElement) => {
    const editor = editorRef.current;
    if (editorMode === "split" && editor) {
      if (consumesSynchronizedScroll("preview", preview)) return;
      scrollSourceRef.current = "preview";
      syncPaneScroll(preview, editor, "editor");
    }
  };

  useEffect(() => {
    if (editorMode !== "split") return;
    let frame: number | null = null;
    const syncFromActivePane = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const editor = editorRef.current;
        const preview = previewRef.current;
        if (!editor || !preview) return;
        if (scrollSourceRef.current === "preview") {
          syncPaneScroll(preview, editor, "editor");
          return;
        }
        syncPaneScroll(editor, preview, "preview");
      });
    };
    syncFromActivePane();
    window.addEventListener("resize", syncFromActivePane);
    const preview = previewRef.current;
    const editor = editorRef.current;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncFromActivePane);
    if (observer && editor && preview) {
      observer.observe(editor);
      observer.observe(preview);
    }
    return () => {
      window.removeEventListener("resize", syncFromActivePane);
      observer?.disconnect();
      synchronizedScrollTopsRef.current.editor = null;
      synchronizedScrollTopsRef.current.preview = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [editorMode, markdown]);

  return (
    <section aria-label="Markdown 编辑器" className="markdown-workbench">
      <div className="editor-toolbar">
        <div aria-label="格式工具" className="editor-toolbar__tools">
          <button aria-label="插入标题" onClick={() => insertBlock("## ", "小节标题")} title="标题" type="button">
            <Heading2 size={16} />
          </button>
          <button aria-label="切换粗体" onClick={() => applyMarkup("**")} title="粗体" type="button">
            <Bold size={16} />
          </button>
          <button aria-label="切换斜体" onClick={() => applyMarkup("*")} title="斜体" type="button">
            <Italic size={16} />
          </button>
          <button aria-label="插入列表" onClick={() => insertBlock("- ", "列表项")} title="列表" type="button">
            <List size={16} />
          </button>
          <button aria-label="插入引用" onClick={() => insertBlock("> ", "引用内容")} title="引用" type="button">
            <Quote size={16} />
          </button>
          <button aria-label="插入分隔线" onClick={() => insertBlock("\n---\n", "")} title="分隔线" type="button">
            <MoreHorizontal size={17} />
          </button>
          <button aria-label="插入图片" onClick={() => insertBlock("", "")} title="图片请拖入、粘贴或用顶部「插图」按钮" type="button" style={{ display: "none" }} />
          {onImageFileDrop && (
            <label aria-label="插入图片" className="editor-toolbar__upload" title="插入图片">
              <ImagePlus size={16} />
              <input
                accept="image/*"
                multiple
                onChange={(event) => {
                  void importFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
                style={{ display: "none" }}
                type="file"
              />
            </label>
          )}
        </div>
        <div className="editor-toolbar__right">
          <div aria-label="编辑器布局" className="mode-switch">
            <ToolbarSelect
              align="right"
              label="编辑器布局"
              onChange={(value) => onEditorModeChange(value)}
              options={editorModes}
              value={editorMode}
            />
          </div>
        </div>
      </div>

      <div
        className={`editor-surface editor-surface--${editorMode}`}
        ref={surfaceRef}
        style={{ "--split-left": `${splitRatio}fr`, "--split-right": `${(1 - splitRatio).toFixed(4)}fr` } as CSSProperties}
      >
        {editorMode !== "preview" && (
          <div className="source-editor">
            <div aria-hidden="true" className="source-editor__gutter">
              {Array.from({ length: lines }, (_, index) => (
                <span key={index}>{index + 1}</span>
              ))}
            </div>
            <textarea
              aria-busy={isDroppingImage || undefined}
              aria-label="Markdown 正文"
              className={isDropTarget ? "is-drop-target" : undefined}
              onChange={(event) => onMarkdownChange(event.target.value)}
              onDragEnter={(event) => {
                if (["Files", "application/x-opw-figure", "text/x-media-markdown"].some((type) => event.dataTransfer.types.includes(type))) {
                  event.preventDefault();
                  setIsDropTarget(true);
                }
              }}
              onDragLeave={(event) => {
                if (event.currentTarget === event.target) setIsDropTarget(false);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
              onFocus={() => {
                userCaretRef.current = true;
              }}
              onBlur={(event) => {
                selectionRef.current = {
                  start: event.currentTarget.selectionStart,
                  end: event.currentTarget.selectionEnd,
                };
              }}
              onPaste={handlePaste}
              onScroll={(event) => {
                syncPreviewToEditorScroll(event.currentTarget);
                updateSelectionActionPosition(event.currentTarget);
              }}
              onSelect={(event) => captureSelection(event.currentTarget)}
              ref={editorRef}
              spellCheck={false}
              value={markdown}
            />
            {selectedText && selectionActionPosition && onRequestSelectionRewrite && (
              <button
                className="selection-rewrite-button"
                onClick={() => {
                  onRequestSelectionRewrite(selectedText);
                  setSelectedText(null);
                  setSelectionActionPosition(null);
                }}
                onPointerDown={(event) => event.preventDefault()}
                style={selectionActionPosition}
                type="button"
              >
                <WandSparkles size={14} /> AI 修改选中内容
              </button>
            )}
          </div>
        )}
        {editorMode === "split" && (
          <div
            aria-label="调节编辑与预览宽度"
            aria-orientation="vertical"
            className="pane-resizer"
            onPointerDown={beginSplitDrag}
            role="separator"
          />
        )}
        {editorMode !== "edit" && (
          <div
            className={`preview-pane${previewDropActive ? " is-drop-target" : ""}`}
            onDragEnter={(event) => {
              if (
                event.dataTransfer.types.includes("application/x-opw-figure")
                || event.dataTransfer.types.includes("text/x-media-markdown")
              ) {
                event.preventDefault();
                setPreviewDropActive(true);
              }
            }}
            onDragLeave={(event) => {
              if (event.currentTarget === event.target) setPreviewDropActive(false);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={handlePreviewDrop}
            onDragStart={handlePreviewDragStart}
            onScroll={(event) => syncEditorToPreviewScroll(event.currentTarget)}
            ref={previewRef}
          >
            <div className="preview-pane__meta">
              <span>实时预览</span>
              <ToolbarSelect
                label="平台预览"
                onChange={(value) => onPreviewPlatformChange?.(value)}
                options={previewPlatforms}
                value={previewPlatform}
              />
            </div>
            <div style={{ margin: "0 auto", maxWidth: previewPlatform === "twitter" ? 560 : previewPlatform === "wechat" ? 680 : "none" }}>
              <MarkdownPreview markdown={streaming ? streamPreview : markdown} />
            </div>
          </div>
        )}
      </div>

      <footer className="editor-status">
        <span>
          <i className={`status-dot${dirty ? " is-dirty" : " is-saved"}`} />
          {dirty ? "有未保存修改" : saved ? "已保存" : "尚未保存版本"}
        </span>
        <span>{previewPlatform === "general" ? "Markdown" : `平台预览 · ${previewPlatform}`}</span>
        <span>{lines} 行</span>
        <span>{characters} 字</span>
        {isDroppingImage && <span className="editor-status__progress" role="status">正在导入图片</span>}
        {streaming && <span className="editor-status__progress" role="status">{streamingLabel}</span>}
        {imageDropError && <span className="editor-status__error" role="alert">{imageDropError}</span>}
      </footer>
    </section>
  );
}
