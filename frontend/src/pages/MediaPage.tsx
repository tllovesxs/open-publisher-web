import { useCallback, useEffect, useRef, useState } from "react";
import { ToolbarSelect } from "../components/ui/ToolbarSelect";
import { Check, Copy, ImagePlus, LoaderCircle, Pencil, Rocket, Save, Sparkles, Trash2, Upload, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";

// 素材库：蓝本 MediaAsset 的 Web 版。管理描述、用途、标签、生图提示词，
// 让视觉规划和创作页能拿到可解释的结构化素材，而不是只剩文件名。

interface MediaAsset {
  id: string;
  name: string;
  alt: string;
  visualDescription: string;
  usageHint: string;
  generationPrompt: string;
  tags: string[];
  descriptionSource: string;
  mime: string;
  source: string;
  origin: string;
  createdAt: string;
}

interface MediaForm {
  name: string;
  alt: string;
  visualDescription: string;
  usageHint: string;
  generationPrompt: string;
  tagsText: string;
}

const emptyForm: MediaForm = {
  name: "", alt: "", visualDescription: "", usageHint: "",
  generationPrompt: "", tagsText: "",
};

function toForm(asset: MediaAsset): MediaForm {
  return {
    name: asset.name,
    alt: asset.alt,
    visualDescription: asset.visualDescription,
    usageHint: asset.usageHint,
    generationPrompt: asset.generationPrompt,
    tagsText: (asset.tags ?? []).join(", "),
  };
}

export default function MediaPage() {
  const navigate = useNavigate();
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [search, setSearch] = useState("");
  const [origin, setOrigin] = useState<"" | "upload" | "generated">("");
  const [sort, setSort] = useState("created_desc");
  const [selected, setSelected] = useState<MediaAsset | null>(null);
  const [form, setForm] = useState<MediaForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ sort });
      if (search.trim()) params.set("search", search.trim());
      if (origin) params.set("origin", origin);
      const res = await api.get<{ assets: MediaAsset[] }>(`/media?${params.toString()}`);
      setAssets(res.data.assets ?? []);
    } catch {
      setError("无法加载素材库。");
    } finally {
      setLoading(false);
    }
  }, [search, origin, sort]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        if (file.size > 8 * 1024 * 1024) {
          setError(`「${file.name}」超过 8MB，已跳过。`);
          continue;
        }
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        await api.post("/media", {
          name: file.name,
          mime: file.type,
          dataUrl,
          alt: file.name.replace(/\.[^.]+$/, ""),
          visualDescription: "请补充图片主体、构图与可用场景。",
          tags: ["上传"],
        });
      }
      await load();
    } catch {
      setError("上传失败。");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const generate = async () => {
    if (!prompt.trim()) {
      setError("请先填写图片描述。");
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      await api.post("/media/generate", { prompt: prompt.trim() });
      setPrompt("");
      await load();
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "图片生成失败，请检查模型设置或联系管理员。");
    } finally {
      setGenerating(false);
    }
  };

  const saveDetails = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.patch<MediaAsset>(`/media/${selected.id}`, {
        name: form.name,
        alt: form.alt,
        visualDescription: form.visualDescription,
        usageHint: form.usageHint,
        generationPrompt: form.generationPrompt,
        tags: form.tagsText.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      });
      setSelected(res.data);
      setForm(toForm(res.data));
      await load();
    } catch {
      setError("保存素材信息失败。");
    } finally {
      setSaving(false);
    }
  };

  const analyzeAsset = async () => {
    if (!selected || analyzing) return;
    setAnalyzing(true);
    setError(null);
    try {
      const res = await api.post<MediaAsset>(`/media/${selected.id}/analyze`, {});
      setSelected(res.data);
      setForm(toForm(res.data));
      await load();
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "图片分析暂时不可用，请选择支持图片理解的模型或联系管理员。");
    } finally {
      setAnalyzing(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.delete(`/media/${id}`);
      if (selected?.id === id) {
        setSelected(null);
        setForm(emptyForm);
      }
      await load();
    } catch {
      setError("删除失败。");
    }
  };

  const removeSelected = async () => {
    if (!selectedIds.length || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await Promise.all(selectedIds.map((id) => api.delete(`/media/${id}`)));
      setSelectedIds([]);
      if (selected && selectedIds.includes(selected.id)) {
        setSelected(null);
        setForm(emptyForm);
      }
      await load();
    } catch {
      setError("批量删除失败。");
    } finally {
      setDeleting(false);
    }
  };

  const copyMarkdown = async (asset: MediaAsset) => {
    const markdown = `![${asset.alt || asset.name}](/api/media/${asset.id}/raw)`;
    await navigator.clipboard.writeText(markdown);
    setCopiedId(asset.id);
    setTimeout(() => setCopiedId(null), 1200);
  };

  const mediaMarkdown = (asset: MediaAsset) => `![${asset.alt || asset.name}](/api/media/${asset.id}/raw)`;

  const copySelectedMarkdown = async () => {
    const picked = assets.filter((asset) => selectedIds.includes(asset.id));
    if (picked.length === 0) return;
    await navigator.clipboard.writeText(picked.map(mediaMarkdown).join("\n\n"));
    setCopiedId("batch");
    setTimeout(() => setCopiedId(null), 1200);
  };

  const bringIntoCreation = () => {
    if (!selectedIds.length) return;
    navigate("/", { state: { selectedMediaIds: [...selectedIds] } });
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  return (
    <section style={{ padding: "20px 24px", display: "grid", gap: 16, maxWidth: 1100 }}>
      <div>
        <p className="page-kicker">素材库</p>
        <h1>图片素材</h1>
      </div>

      {error && (
        <div className="workflow-task__failure" role="alert">
          <p>{error}</p>
        </div>
      )}

      <div className="panel" style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button className="button button--primary" disabled={uploading} onClick={() => fileRef.current?.click()} type="button">
            {uploading ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}
            {uploading ? "上传中……" : "上传图片"}
          </button>
          <input
            accept="image/*"
            aria-label="选择图片文件"
            hidden
            multiple
            onChange={(event) => void upload(event.target.files)}
            ref={fileRef}
            type="file"
          />
          <span className="muted" style={{ fontSize: 12 }}>单张 ≤ 8MB · 图片类型</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="AI 生成：描述想要的图片……"
            style={{ flex: 3, minWidth: 220 }}
            value={prompt}
          />
          <button className="button button--quiet" disabled={generating} onClick={() => void generate()} type="button">
            {generating ? <LoaderCircle className="spin" size={15} /> : <ImagePlus size={15} />}
            {generating ? "生成中……" : "AI 生成"}
          </button>
        </div>
      </div>

      <div className="panel" style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            aria-label="搜索素材"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索名称、描述、用途"
            style={{ flex: 2, minWidth: 180 }}
            value={search}
          />
          <ToolbarSelect
            label="素材来源"
            onChange={(value) => setOrigin(value)}
            options={[
              { id: "", label: "全部来源" },
              { id: "upload", label: "上传" },
              { id: "generated", label: "AI 生成" },
            ]}
            value={origin}
          />
          <ToolbarSelect
            label="排序"
            onChange={(value) => setSort(value)}
            options={[
              { id: "created_desc", label: "最新优先" },
              { id: "created_asc", label: "最早优先" },
              { id: "name_asc", label: "名称 A-Z" },
              { id: "name_desc", label: "名称 Z-A" },
            ]}
            value={sort}
          />
          <button
            className="button button--quiet"
            disabled={!selectedIds.length || deleting}
            onClick={() => void removeSelected()}
            type="button"
          >
            <Trash2 size={14} />
            {deleting ? "删除中" : `删除选中 ${selectedIds.length}`}
          </button>
          <button
            className="button button--quiet"
            disabled={!selectedIds.length}
            onClick={() => void copySelectedMarkdown()}
            type="button"
          >
            {copiedId === "batch" ? <Check size={14} /> : <Copy size={14} />}
            {copiedId === "batch" ? "已复制" : `复制选中 Markdown`}
          </button>
          <button
            className="button button--quiet"
            disabled={!selectedIds.length}
            onClick={bringIntoCreation}
            type="button"
          >
            <Rocket size={14} />
            带入创作页
          </button>
          <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
            共 {assets.length} 个素材{selectedIds.length ? ` · 已选 ${selectedIds.length}` : ""}
          </span>
        </div>
      </div>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: selected ? "1fr 320px" : "1fr", minWidth: 0 }}>
        {loading ? (
          <p className="muted">加载中……</p>
        ) : assets.length === 0 ? (
          <p className="muted">没有匹配的素材。上传图片或调整筛选。</p>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 14, alignContent: "start" }}>
            {assets.map((asset) => {
              const isSelected = selectedIds.includes(asset.id);
              const isGenerated = asset.origin === "generated";
              return (
                <figure
                  draggable
                  key={asset.id}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/x-media-markdown", mediaMarkdown(asset));
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  style={{
                    background: "var(--surface, #fff)",
                    border: `1px solid ${isSelected ? "var(--accent, #5b8def)" : "var(--border, #e5e5e5)"}`,
                    borderRadius: 12,
                    boxShadow: isSelected ? "0 0 0 2px color-mix(in srgb, var(--accent, #5b8def) 15%, transparent)" : "none",
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    gap: 0,
                    margin: 0,
                    overflow: "hidden",
                    padding: 0,
                    transition: "box-shadow 150ms ease, transform 150ms ease",
                  }}
                  title="拖入文章编辑器光标处插入"
                >
                  {/* Image area with fixed aspect ratio */}
                  <div style={{ aspectRatio: "4/3", position: "relative", overflow: "hidden" }}>
                    <img
                      alt={asset.alt || asset.name}
                      src={asset.source}
                      style={{ height: "100%", objectFit: "cover", width: "100%" }}
                    />
                    {/* Origin badge */}
                    <span style={{
                      alignItems: "center",
                      background: isGenerated
                        ? "color-mix(in srgb, var(--accent, #5b8def) 85%, transparent)"
                        : "color-mix(in srgb, #333 65%, transparent)",
                      backdropFilter: "blur(4px)",
                      borderRadius: 6,
                      color: "#fff",
                      display: "flex",
                      fontSize: 10,
                      fontWeight: 600,
                      gap: 3,
                      left: 8,
                      padding: "3px 8px",
                      position: "absolute",
                      top: 8,
                    }}>
                      {isGenerated ? <ImagePlus size={11} /> : <Upload size={11} />}
                      {isGenerated ? "AI 生成" : "上传"}
                    </span>
                    {/* Select checkbox */}
                    <button
                      aria-label={`选择 ${asset.name}`}
                      onClick={(e) => { e.stopPropagation(); toggleSelected(asset.id); }}
                      style={{
                        alignItems: "center",
                        background: isSelected ? "var(--accent, #5b8def)" : "rgba(0,0,0,0.35)",
                        backdropFilter: "blur(4px)",
                        border: "none",
                        borderRadius: "50%",
                        color: "#fff",
                        cursor: "pointer",
                        display: "grid",
                        height: 24,
                        placeItems: "center",
                        position: "absolute",
                        right: 8,
                        top: 8,
                        transition: "all 150ms ease",
                        width: 24,
                      }}
                      type="button"
                    >
                      {isSelected && <Check size={13} />}
                    </button>
                  </div>

                  {/* Content area */}
                  <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 6, padding: "10px 12px 12px" }}>
                    <strong style={{
                      fontSize: 13,
                      lineHeight: 1.4,
                      overflow: "hidden",
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 1,
                      textOverflow: "ellipsis",
                    }}>{asset.name}</strong>

                    <p style={{
                      color: "var(--muted, #888)",
                      display: "-webkit-box",
                      fontSize: 12,
                      lineHeight: 1.5,
                      margin: 0,
                      minHeight: 36,
                      overflow: "hidden",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 2,
                    }}>
                      {asset.visualDescription || asset.alt || "暂无描述"}
                    </p>

                    {(asset.tags ?? []).length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {asset.tags.slice(0, 3).map(tag => (
                          <span key={tag} style={{
                            background: "var(--accent-soft, #ebf4ff)",
                            borderRadius: 4,
                            color: "var(--accent, #5b8def)",
                            fontSize: 10,
                            fontWeight: 500,
                            padding: "2px 6px",
                          }}>{tag}</span>
                        ))}
                        {(asset.tags?.length ?? 0) > 3 && (
                          <span style={{ color: "var(--muted, #888)", fontSize: 10 }}>+{asset.tags.length - 3}</span>
                        )}
                      </div>
                    )}

                    {/* Action bar at bottom */}
                    <div style={{
                      alignItems: "center",
                      borderTop: "1px solid var(--border, #eee)",
                      display: "flex",
                      gap: 4,
                      justifyContent: "flex-end",
                      marginTop: "auto",
                      paddingTop: 8,
                    }}>
                      <button
                        aria-label={`编辑 ${asset.name}`}
                        onClick={(e) => { e.stopPropagation(); setSelected(asset); setForm(toForm(asset)); }}
                        style={{
                          alignItems: "center",
                          background: "var(--surface-muted, #f5f5f5)",
                          border: "none",
                          borderRadius: 6,
                          color: "var(--ink)",
                          cursor: "pointer",
                          display: "flex",
                          fontSize: 11,
                          gap: 4,
                          padding: "5px 10px",
                          transition: "background 150ms ease",
                        }}
                        type="button"
                      >
                        <Pencil size={12} /> 编辑
                      </button>
                      <button
                        aria-label={`复制 ${asset.name} Markdown`}
                        onClick={(e) => { e.stopPropagation(); void copyMarkdown(asset); }}
                        style={{
                          alignItems: "center",
                          background: "var(--surface-muted, #f5f5f5)",
                          border: "none",
                          borderRadius: 6,
                          color: "var(--ink)",
                          cursor: "pointer",
                          display: "grid",
                          height: 26,
                          placeItems: "center",
                          width: 26,
                        }}
                        type="button"
                      >
                        {copiedId === asset.id ? <Check size={13} color="var(--success, #48bb78)" /> : <Copy size={13} />}
                      </button>
                      <button
                        aria-label={`删除 ${asset.name}`}
                        onClick={(e) => { e.stopPropagation(); void remove(asset.id); }}
                        style={{
                          alignItems: "center",
                          background: "var(--surface-muted, #f5f5f5)",
                          border: "none",
                          borderRadius: 6,
                          color: "var(--muted, #888)",
                          cursor: "pointer",
                          display: "grid",
                          height: 26,
                          placeItems: "center",
                          width: 26,
                        }}
                        type="button"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </figure>
              );
            })}
          </div>
        )}

        {selected && (
          <aside aria-label="素材详情编辑" style={{
            background: "var(--surface, #fff)",
            border: "1px solid var(--border, #e5e5e5)",
            borderRadius: 12,
            display: "grid",
            gap: 0,
            height: "fit-content",
            overflow: "hidden",
            position: "sticky",
            top: 20,
          }}>
            {/* Header with image */}
            <div style={{ position: "relative" }}>
              <img alt="" src={selected.source} style={{ maxHeight: 200, objectFit: "cover", width: "100%" }} />
              <button
                aria-label="关闭素材详情"
                onClick={() => setSelected(null)}
                style={{
                  alignItems: "center",
                  background: "rgba(0,0,0,0.4)",
                  backdropFilter: "blur(4px)",
                  border: "none",
                  borderRadius: "50%",
                  color: "#fff",
                  cursor: "pointer",
                  display: "grid",
                  height: 28,
                  placeItems: "center",
                  position: "absolute",
                  right: 10,
                  top: 10,
                  width: 28,
                }}
                type="button"
              >
                <X size={15} />
              </button>
            </div>

            {/* Form */}
            <div style={{ display: "grid", gap: 14, padding: 16 }}>
              <h2 style={{ fontSize: 15, margin: 0 }}>
                {selected.origin === "generated" ? "AI 生成素材" : "上传素材"}
              </h2>
              <label style={{ color: "var(--ink)", display: "grid", fontSize: 12, fontWeight: 500, gap: 4 }}>
                名称
                <input onChange={(event) => setForm({ ...form, name: event.target.value })} style={{ borderRadius: 8, border: "1px solid var(--border, #ddd)", fontSize: 13, padding: "8px 10px" }} value={form.name} />
              </label>
              <label style={{ color: "var(--ink)", display: "grid", fontSize: 12, fontWeight: 500, gap: 4 }}>
                短描述 / alt
                <input onChange={(event) => setForm({ ...form, alt: event.target.value })} style={{ borderRadius: 8, border: "1px solid var(--border, #ddd)", fontSize: 13, padding: "8px 10px" }} value={form.alt} />
              </label>
              <label style={{ color: "var(--ink)", display: "grid", fontSize: 12, fontWeight: 500, gap: 4 }}>
                视觉描述
                <textarea
                  onChange={(event) => setForm({ ...form, visualDescription: event.target.value })}
                  placeholder="主体、构图、色彩、风格，用于素材匹配"
                  rows={4}
                  style={{ borderRadius: 8, border: "1px solid var(--border, #ddd)", fontSize: 13, lineHeight: 1.5, padding: "8px 10px", resize: "vertical" }}
                  value={form.visualDescription}
                />
              </label>
              <label style={{ color: "var(--ink)", display: "grid", fontSize: 12, fontWeight: 500, gap: 4 }}>
                使用场景
                <input
                  onChange={(event) => setForm({ ...form, usageHint: event.target.value })}
                  placeholder="例如：产品架构节 / 对比场景"
                  style={{ borderRadius: 8, border: "1px solid var(--border, #ddd)", fontSize: 13, padding: "8px 10px" }}
                  value={form.usageHint}
                />
              </label>
              <label style={{ color: "var(--ink)", display: "grid", fontSize: 12, fontWeight: 500, gap: 4 }}>
                生图提示词
                <textarea
                  onChange={(event) => setForm({ ...form, generationPrompt: event.target.value })}
                  rows={4}
                  style={{ borderRadius: 8, border: "1px solid var(--border, #ddd)", fontSize: 13, lineHeight: 1.5, padding: "8px 10px", resize: "vertical" }}
                  value={form.generationPrompt}
                />
              </label>
              <label style={{ color: "var(--ink)", display: "grid", fontSize: 12, fontWeight: 500, gap: 4 }}>
                标签（逗号分隔）
                <input onChange={(event) => setForm({ ...form, tagsText: event.target.value })} style={{ borderRadius: 8, border: "1px solid var(--border, #ddd)", fontSize: 13, padding: "8px 10px" }} value={form.tagsText} />
              </label>
              <div style={{ alignItems: "center", display: "flex", fontSize: 11, gap: 8 }}>
                <button
                  className="button"
                  disabled={analyzing}
                  onClick={() => void analyzeAsset()}
                  style={{ alignItems: "center", display: "flex", fontSize: 12, gap: 5, padding: "6px 12px" }}
                  type="button"
                >
                  {analyzing ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />}
                  {analyzing ? "分析中" : "AI 分析"}
                </button>
                <span style={{ color: "var(--muted, #888)" }}>来源：{selected.descriptionSource || "manual"}</span>
              </div>
              <button
                className="button button--primary"
                disabled={saving}
                onClick={() => void saveDetails()}
                style={{ alignItems: "center", display: "flex", fontSize: 14, gap: 6, justifyContent: "center", padding: "10px 16px" }}
                type="button"
              >
                {saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
                {saving ? "保存中" : "保存素材"}
              </button>
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}
