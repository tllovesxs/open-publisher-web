import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { BarChart3, ImageIcon, LoaderCircle, MoreHorizontal, Plus, ScissorsLineDashed } from "lucide-react";
import { renderMermaidSvg, resolveAssetReferences } from "./MarkdownPreview";
import { InsertPositionDialog } from "./InsertPositionDialog";
import { markdownLineOfOffset, type MarkdownSpan } from "./articleMarkdown";
import type { ImageInsertion } from "./MarkdownWorkbench";

const IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const MERMAID_PATTERN = /```mermaid[^\S\n]*\n([\s\S]*?)```/g;

export type ArticleFigure =
  | { kind: "image"; alt: string; src: string; span: MarkdownSpan }
  | { kind: "mermaid"; source: string; span: MarkdownSpan };

export function extractArticleFigures(markdown: string): ArticleFigure[] {
  const figures: ArticleFigure[] = [];
  for (const match of markdown.matchAll(MERMAID_PATTERN)) {
    const source = match[1]?.trim();
    if (!source || match.index === undefined) continue;
    figures.push({
      kind: "mermaid",
      source,
      span: { start: match.index, end: match.index + match[0].length },
    });
  }
  for (const match of markdown.matchAll(IMAGE_PATTERN)) {
    const src = match[2];
    if (!src || match.index === undefined) continue;
    figures.push({
      kind: "image",
      alt: match[1] || "",
      src,
      span: { start: match.index, end: match.index + match[0].length },
    });
  }
  return figures;
}

function isEmbeddableImageSrc(src: string): boolean {
  return /^(data:image\/|blob:|https?:\/\/|\/api\/)/i.test(src);
}

function figureCaption(figure: ArticleFigure, index: number): string {
  if (figure.kind === "mermaid") return `图表 ${index + 1}`;
  return figure.alt || `配图 ${index + 1}`;
}

function MermaidThumb({ source, index }: { source: string; index: number }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    renderMermaidSvg(`opw-figure-pane-${Date.now()}-${index}`, source)
      .then((next) => {
        if (!cancelled) setSvg(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [source, index]);
  if (failed) {
    return <div className="article-figures__mermaid is-error">图表渲染失败</div>;
  }
  if (svg === null) {
    return <div className="article-figures__mermaid is-loading">绘制中…</div>;
  }
  return (
    <div
      aria-label="文章图表缩略图"
      className="article-figures__mermaid"
      dangerouslySetInnerHTML={{ __html: svg }}
      role="img"
    />
  );
}

interface ArticleImagePaneProps {
  markdown: string;
  /** 插入新素材：在正文指定行插入 Markdown 片段。 */
  onInsertAtLine: (snippet: string, lineNumber: number) => void;
  /** 删除正文中的配图 / 图表。 */
  onDeleteFigure: (figure: ArticleFigure) => void;
  /** 把正文中的配图 / 图表移动到指定行。 */
  onMoveFigure: (figure: ArticleFigure, lineNumber: number) => void;
  onImageFileDrop?: (file: File) => Promise<ImageInsertion>;
  canInsert?: boolean;
  style?: CSSProperties;
}

type LineDialog =
  | { mode: "insert"; snippet: string; alt: string }
  | { mode: "move"; figure: ArticleFigure }
  | null;

/** 文章右侧配图栏：展示正文图片与创作生成的 mermaid 图表；
 * 上传的图片点「插入」后输入行号写入指定行；已有配图可编辑（删除 / 移动位置）。 */
export function ArticleImagePane({
  markdown,
  onInsertAtLine,
  onDeleteFigure,
  onMoveFigure,
  onImageFileDrop,
  canInsert = true,
  style,
}: ArticleImagePaneProps) {
  // asset:// 是正文里的紧凑素材引用；侧栏与预览一样先解析成站内原始图地址。
  const resolvedMarkdown = useMemo(() => resolveAssetReferences(markdown), [markdown]);
  const figures = useMemo(
    () => extractArticleFigures(resolvedMarkdown).filter(
      (figure) => figure.kind === "mermaid" || isEmbeddableImageSrc(figure.src),
    ),
    [resolvedMarkdown],
  );
  const [uploads, setUploads] = useState<ImageInsertion[]>([]);
  const [isDropping, setIsDropping] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lineDialog, setLineDialog] = useState<LineDialog>(null);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null);
  const [failedFigureKeys, setFailedFigureKeys] = useState<Set<string>>(new Set());
  const [failedUploadKeys, setFailedUploadKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    setFailedFigureKeys(new Set());
  }, [resolvedMarkdown]);

  const markFailedFigure = (figure: ArticleFigure) => {
    if (figure.kind !== "image") return;
    const key = `${figure.span.start}:${figure.src}`;
    setFailedFigureKeys((current) => new Set(current).add(key));
  };

  const markFailedUpload = (asset: ImageInsertion) => {
    setFailedUploadKeys((current) => new Set(current).add(asset.src));
  };

  const importFiles = async (files: File[]) => {
    if (!onImageFileDrop) {
      setError("图片上传服务尚未连接。");
      return;
    }
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) {
      setError("只能导入图片文件。");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const inserted = await Promise.all(images.map((file) => onImageFileDrop(file)));
      setUploads((current) => [...current, ...inserted]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "图片上传失败，请重试。");
    } finally {
      setUploading(false);
    }
  };

  const confirmInsert = (lineNumber: number) => {
    if (!lineDialog || lineDialog.mode !== "insert") return;
    const { snippet } = lineDialog;
    onInsertAtLine(snippet, lineNumber);
    setUploads((current) => current.filter((item) => `![${item.alt}](${item.src})` !== snippet));
    setLineDialog(null);
  };

  const confirmMove = (lineNumber: number) => {
    if (!lineDialog || lineDialog.mode !== "move") return;
    onMoveFigure(lineDialog.figure, lineNumber);
    setLineDialog(null);
  };

  // 计数只反映真实可见内容；加载失败/失效引用不再占位，也不再算进角标。
  const visibleFigures = figures.filter((figure) =>
    figure.kind === "mermaid"
    || !failedFigureKeys.has(`${figure.span.start}:${figure.src}`));
  const visibleUploads = uploads.filter((asset) => !failedUploadKeys.has(asset.src));
  const hasVisibleContent = visibleFigures.length > 0 || visibleUploads.length > 0;

  return (
    <aside
      aria-label="文章配图"
      className={`article-figures${isDropping ? " is-dropping" : ""}`}
      style={style}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setIsDropping(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setIsDropping(false);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        setIsDropping(false);
        void importFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <header className="article-figures__head">
        <div className="article-figures__title">
          <ImageIcon size={15} />
          <span>配图</span>
          <span className="field-tag">{visibleFigures.length + visibleUploads.length}</span>
        </div>
        {onImageFileDrop && (
          <label className="button button--quiet article-figures__upload">
            {uploading ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}
            {uploading ? "上传中" : "上传"}
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
      </header>

      <div className="article-figures__scroll">
        {!hasVisibleContent ? (
          <p className="article-figures__empty">
            正文暂无可见配图；可上传素材后插入，或使用「智能配图」生成。失效图片不会保留空位。
          </p>
        ) : (
          <>
            {visibleFigures.length > 0 && (
              <>
                <p className="article-figures__section-label">正文配图与图表</p>
                <div className="article-figures__grid">
                  {visibleFigures.map((figure, index) => (
                    <figure
                      className={`article-figures__item${menuFor === index ? " is-menu-open" : ""}`}
                                            draggable
                      onDragStart={(event) => {
                        // 拖拽移动配图：载荷带原文位置，编辑器按落点行调用 onMoveFigure。
                        event.dataTransfer.setData(
                          "application/x-opw-figure",
                          JSON.stringify({ kind: figure.kind, span: figure.span }),
                        );
                        event.dataTransfer.effectAllowed = "move";
                      }}key={`figure-${figure.span.start}`}
                      onMouseLeave={() => setMenuFor((current) => (current === index ? null : current))}
                    >
                      {figure.kind === "image" ? (
                        <button
                          aria-label={`预览 ${figure.alt || `配图 ${index + 1}`}`}
                          className="article-figures__thumb"
                          onClick={() => setPreview({ src: figure.src, alt: figure.alt || `配图 ${index + 1}` })}
                          title="点击预览"
                          type="button"
                        >
                          <img
                            alt={figure.alt || `配图 ${index + 1}`}
                            onError={() => markFailedFigure(figure)}
                            src={figure.src}
                          />
                        </button>
                      ) : (
                        <MermaidThumb index={index} source={figure.source} />
                      )}
                      <figcaption
                        title={figure.kind === "image" ? figure.alt || figure.src : "创作生成的图表"}
                      >
                        {figureCaption(figure, index)}
                      </figcaption>
                      {canInsert && (
                        <button
                          aria-expanded={menuFor === index}
                          aria-haspopup="menu"
                          aria-label={`编辑 ${figureCaption(figure, index)}`}
                          className="article-figures__insert"
                          onClick={() => setMenuFor((current) => (current === index ? null : index))}
                          title="编辑：删除或移动位置"
                          type="button"
                        >
                          <MoreHorizontal size={12} /> 编辑
                        </button>
                      )}
                      {canInsert && menuFor === index && (
                        <div aria-label={`编辑 ${figureCaption(figure, index)}`} className="article-figures__menu" role="menu">
                          <button
                            onClick={() => {
                              setMenuFor(null);
                              onDeleteFigure(figure);
                            }}
                            role="menuitem"
                            type="button"
                          >
                            删除
                          </button>
                          <button
                            onClick={() => {
                              setMenuFor(null);
                              setLineDialog({ mode: "move", figure });
                            }}
                            role="menuitem"
                            type="button"
                          >
                            移动位置
                          </button>
                        </div>
                      )}
                    </figure>
                  ))}
                </div>
              </>
            )}

            {onImageFileDrop && (visibleUploads.length > 0 || visibleFigures.length === 0) && (
              <>
                <p className="article-figures__section-label">
                  <ScissorsLineDashed size={12} /> 新上传素材
                </p>
                {visibleUploads.length === 0 ? (
                  <p className="article-figures__empty">
                    拖入或上传的图片会先列在这里，点「插入」输入行号后写入正文对应行。
                  </p>
                ) : (
                  <div className="article-figures__grid">
                    {visibleUploads.map((asset, index) => (
                      <figure className="article-figures__item" key={`${asset.src}-${index}`}>
                        <img
                          alt={asset.alt}
                          onError={() => markFailedUpload(asset)}
                          src={asset.src}
                        />
                        <figcaption title={asset.alt}>{asset.alt}</figcaption>
                        {canInsert && (
                          <button
                            aria-label={`插入 ${asset.alt}`}
                            className="article-figures__insert"
                            onClick={() =>
                              setLineDialog({
                                mode: "insert",
                                snippet: `![${asset.alt}](${asset.src})`,
                                alt: asset.alt,
                              })
                            }
                            title="插入到正文指定行"
                            type="button"
                          >
                            插入
                          </button>
                        )}
                      </figure>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
      {error && (
        <p className="article-figures__error" role="alert">{error}</p>
      )}
      {figures.some((figure) => figure.kind === "mermaid") && (
        <p className="article-figures__hint">
          <BarChart3 size={12} /> 含创作生成的图表，会随正文实时更新
        </p>
      )}
      {preview && (
        <div
          aria-label="图片预览"
          aria-modal="true"
          className="article-figures__preview"
          onClick={() => setPreview(null)}
          role="dialog"
        >
          <figure onClick={(event) => event.stopPropagation()}>
            <img alt={preview.alt} src={preview.src} />
            <figcaption title={preview.alt}>{preview.alt}</figcaption>
          </figure>
        </div>
      )}
      {lineDialog?.mode === "insert" && (
        <InsertPositionDialog
          confirmLabel="插入"
          defaultLine={1}
          onClose={() => setLineDialog(null)}
          onConfirm={confirmInsert}
          preview={lineDialog.snippet}
          title={`插入「${lineDialog.alt}」`}
        />
      )}
      {lineDialog?.mode === "move" && (
        <InsertPositionDialog
          confirmLabel="移动"
          defaultLine={markdownLineOfOffset(markdown, lineDialog.figure.span.start)}
          onClose={() => setLineDialog(null)}
          onConfirm={confirmMove}
          preview={
            lineDialog.figure.kind === "mermaid"
              ? "```mermaid …```（创作生成的图表）"
              : lineDialog.figure.src
          }
          title="移动配图位置"
        />
      )}
    </aside>
  );
}
