import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Copy, LoaderCircle, Save, Trash2, Wand2 } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import { useNavigate } from "react-router-dom";

// 模板库：蓝本 MarkdownTemplate 的结构画像 Web 版。
// 不只保存骨架，也保存文风、结构、排版和固定块，供后续创作 Agent 消费。

type TemplateProfile = Record<string, string | string[] | boolean>;

interface MarkdownTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  markdown: string;
  styleProfile: TemplateProfile | null;
  structureProfile: TemplateProfile | null;
  layoutProfile: TemplateProfile | null;
  fixedBlocks: Array<{ id?: string; label?: string; name?: string; enabled?: boolean; content?: string; position?: string }> | null;
  variables: string[] | null;
  usageInstructions: string;
  isBuiltIn: boolean;
  mode: string;
  referenceMarkdown?: string | null;
  sourceFingerprint?: string | null;
}

interface TemplateForm {
  name: string;
  description: string;
  category: string;
  markdown: string;
  usageInstructions: string;
  styleProfile: string;
  structureProfile: string;
  layoutProfile: string;
  fixedBlocks: string;
  variables: string;
}

const profileFields: Record<string, Array<[string, string]>> = {
  style: [["tone", "整体语气"], ["audience", "目标读者"], ["perspective", "叙述视角"], ["sentenceStyle", "句式习惯"], ["pacing", "节奏"], ["density", "信息密度"]],
  structure: [["openingPattern", "开头方式"], ["sectionPattern", "章节组织"], ["conclusionPattern", "结尾方式"], ["headingDepth", "标题层级"], ["paragraphPattern", "段落习惯"]],
  layout: [["imagePlacement", "图片位置"], ["emphasisRules", "强调规则"]],
};

function ProfileFields({ kind, value, disabled, onChange }: { kind: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const data = JSON.parse(value || "{}") ?? {};
  return <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 10, minWidth: 0 }}>
    {profileFields[kind].map(([key, label]) => <label className="field" key={key}><span>{label}</span>
      <textarea aria-label={label} rows={2} value={String(data[key] ?? "")} onChange={event => onChange(JSON.stringify({ ...data, [key]: event.target.value }))} />
    </label>)}
    {kind === "layout" && ([["useLists", "列表"], ["useTables", "表格"], ["useBlockquotes", "引用"], ["useCodeBlocks", "代码块"]] as const).map(([key, label]) =>
      <label key={key}><input type="checkbox" checked={data[key] === true} onChange={event => onChange(JSON.stringify({ ...data, [key]: event.target.checked }))} />{label}</label>)}
  </fieldset>;
}

function FixedContentFields({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  const blocks: Array<Record<string, string | boolean>> = JSON.parse(value || "[]") ?? [];
  const updateBlock = (index: number, key: string, value: string | boolean) => onChange(JSON.stringify(blocks.map((block, i) => i === index ? { ...block, [key]: value } : block)));
  return <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 10, minWidth: 0 }}>
    {blocks.map((block, index) => <div key={index} style={{ display: "grid", gap: 8 }}>
      <label><input type="checkbox" checked={block.enabled !== false} onChange={event => updateBlock(index, "enabled", event.target.checked)} />启用固定内容</label>
      <label className="field"><span>内容名称</span><input value={String(block.label ?? block.name ?? "")} onChange={event => updateBlock(index, "label", event.target.value)} /></label>
      <label className="field"><span>固定内容</span><textarea aria-label="固定内容" rows={3} value={String(block.content ?? "")} onChange={event => updateBlock(index, "content", event.target.value)} /></label>
      <label className="field"><span>插入位置</span><select value={String(block.position ?? "after_article")} onChange={event => updateBlock(index, "position", event.target.value)}>
        {[["before_title", "标题前"], ["after_intro", "引言后"], ["before_closing", "结尾前"], ["after_article", "文章后"], ...(!["before_title", "after_intro", "before_closing", "after_article"].includes(String(block.position ?? "after_article")) ? [[String(block.position), `原位置：${block.position}`]] : [])].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <button className="button button--quiet" type="button" onClick={() => onChange(JSON.stringify(blocks.filter((_, i) => i !== index)))}>移除此段内容</button>
    </div>)}
    <button className="button button--quiet" type="button" onClick={() => onChange(JSON.stringify([...blocks, { id: crypto.randomUUID(), label: "", enabled: true, content: "", position: "after_article" }]))}>添加固定内容</button>
  </fieldset>;
}

function formPayload(form: TemplateForm) {
  return { ...form,
    styleProfile: parseJson<Record<string, unknown>>(form.styleProfile, "文风画像"),
    structureProfile: parseJson<Record<string, unknown>>(form.structureProfile, "结构画像"),
    layoutProfile: parseJson<Record<string, unknown>>(form.layoutProfile, "排版画像"),
    fixedBlocks: parseJson<Array<Record<string, unknown>>>(form.fixedBlocks, "固定块"),
    variables: form.variables.split(/[,，]/).map(item => item.trim()).filter(Boolean),
  };
}

function jsonText(value: unknown) {
  return value == null ? "{}" : JSON.stringify(value, null, 2);
}

function toForm(template: MarkdownTemplate): TemplateForm {
  return {
    name: template.name,
    description: template.description,
    category: template.category,
    markdown: template.markdown,
    usageInstructions: template.usageInstructions,
    styleProfile: jsonText(template.styleProfile),
    structureProfile: jsonText(template.structureProfile),
    layoutProfile: jsonText(template.layoutProfile),
    fixedBlocks: jsonText(template.fixedBlocks ?? []),
    variables: (template.variables ?? []).join(", "),
  };
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value || "null") as T;
  } catch {
    throw new Error(`${label}格式有误，请重新填写。`);
  }
}

export default function TemplatesPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [extractSeconds, setExtractSeconds] = useState(0);
  const [templates, setTemplates] = useState<MarkdownTemplate[]>([]);
  const [selected, setSelected] = useState<MarkdownTemplate | null>(null);
  const [form, setForm] = useState<TemplateForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [extractSource, setExtractSource] = useState("");
  const [extracting, setExtracting] = useState(false);
  useEffect(() => { if (!extracting) return; setExtractSeconds(0); const id = window.setInterval(() => setExtractSeconds(n => n + 1), 1000); return () => clearInterval(id); }, [extracting]);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ templates: MarkdownTemplate[] }>("/templates");
      setTemplates(res.data.templates);
      setSelected((current) =>
        current && res.data.templates.some((template) => template.id === current.id)
          ? res.data.templates.find((template) => template.id === current.id) ?? null
          : res.data.templates[0] ?? null,
      );
    } catch {
      setError("无法加载模板列表。");
    }
  }, []);

  useEffect(() => {
    if (selected) setForm(toForm(selected));
    setError(null);
  }, [selected]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!name.trim() || !markdown.trim()) {
      setError("模板名称与正文不能为空。");
      return;
    }
    setError(null);
    try {
      const res = await api.post<MarkdownTemplate>("/templates", {
        name, description, category: "自定义", markdown,
      });
      setName("");
      setDescription("");
      setMarkdown("");
      await load();
      setSelected(res.data);
    } catch {
      setError("创建模板失败。");
    }
  };

  const remove = async (id: string) => {
    try {
      await api.delete(`/templates/${id}`);
      await load();
    } catch {
      setError("删除失败（内置模板不可删除）。");
    }
  };

  const extract = async () => {
    if (!rightsConfirmed) { setError("请先确认参考文章使用权。"); return; }
    if (!extractSource.trim()) {
      setError("请先粘贴参考文章。");
      return;
    }
    setExtracting(true);
    setError(null);
    try {
      const res = await api.post<MarkdownTemplate>("/templates/extract", {
        markdown: extractSource, rightsConfirmed,
      }, { timeout: 180000 });
      setExtractSource("");
      await load();
      setSelected(res.data);
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(
        typeof detail === "string" && detail
          ? detail
          : "模板提取失败，请稍后重试或检查模型配置。",
      );
    } finally {
      setExtracting(false);
    }
  };

  const duplicate = async () => {
    if (!selected) return;
    setError(null);
    try {
      const res = await api.post<MarkdownTemplate>("/templates", {
        ...selected,
        ...(form ? formPayload(form) : {}),
        name: `${form?.name ?? selected.name} 副本`,
        category: "自定义",
      });
      await load();
      setSelected(res.data);
    } catch {
      setError("复制模板失败。");
    }
  };

  const save = async () => {
    if (!selected || !form) return;
    if (selected.isBuiltIn) {
      setError("内置模板不可修改，可复制后另存为自定义模板。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const styleProfile = parseJson<Record<string, unknown>>(form.styleProfile, "文风画像");
      const structureProfile = parseJson<Record<string, unknown>>(form.structureProfile, "结构画像");
      const layoutProfile = parseJson<Record<string, unknown>>(form.layoutProfile, "排版画像");
      const fixedBlocks = parseJson<Array<Record<string, unknown>>>(form.fixedBlocks, "固定块");
      const res = await api.patch<MarkdownTemplate>(`/templates/${selected.id}`, {
        name: form.name,
        description: form.description,
        category: form.category,
        markdown: form.markdown,
        usageInstructions: form.usageInstructions,
        styleProfile,
        structureProfile,
        layoutProfile,
        fixedBlocks,
        variables: form.variables.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      });
      await load();
      setSelected(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存模板失败。");
    } finally {
      setSaving(false);
    }
  };

  const update = (patch: Partial<TemplateForm>) => {
    setForm((current) => (current ? { ...current, ...patch } : current));
  };

  return (
    <section className="articles-layout" style={{ "--article-browser-width": "248px" } as CSSProperties}>
      <aside aria-label="模板列表" className="article-browser">
        <div className="article-browser__head">
          <div>
            <span className="page-kicker">模板库</span>
            <strong>模板</strong>
            {user?.role === "admin" && <button className="text-button" onClick={() => { void api.post("/templates/refresh-official").then(load).catch(() => setError("官方模板刷新失败")); }}>刷新官方模板</button>}
          </div>
        </div>
        <div className="article-list">
          {templates.map((template) => (
            <button
              aria-current={selected?.id === template.id ? "true" : undefined}
              className={`article-list-item${selected?.id === template.id ? " is-active" : ""}`}
              key={template.id}
              onClick={() => setSelected(template)}
              type="button"
            >
              <span className="article-status article-status--draft">
                {template.isBuiltIn ? "内置" : template.mode === "reference" ? "提取" : "自定义"}
              </span>
              <strong>{template.name}</strong>
              <span className="article-list-item__meta"><span>{template.category}</span></span>
            </button>
          ))}
        </div>
      </aside>
      <div aria-hidden="true" className="article-browser__resizer" role="separator" tabIndex={-1} />
      <div className="article-editor">
        <header className="article-editor__head">
          <div className="article-editor__title">
            {selected ? (
              <>
                <span className="page-kicker">{selected.category}</span>
                <strong>{selected.name}</strong>
              </>
            ) : <strong>选择模板</strong>}
          </div>
          <div className="article-editor__actions">
            {selected && (
              <>
                <button
                  className="button button--quiet"
                  disabled={selected.isBuiltIn || saving}
                  onClick={() => void save()}
                  type="button"
                >
                  {saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
                  {saving ? "保存中" : "保存画像"}
                </button>
                <button
                  className="button button--quiet"
                  onClick={() => void duplicate()}
                  type="button"
                >
                  <Copy size={15} />
                  复制另存
                </button>
                <button
                  className="button button--primary"
                  onClick={() => {
                    if (form && JSON.stringify(form) !== JSON.stringify(toForm(selected))) { setError("请先保存修改，或复制另存后用于创作。"); return; }
                    navigate(`/?template=${encodeURIComponent(selected.id)}`);
                  }}
                  type="button"
                >
                  用于创作
                </button>
                {!selected.isBuiltIn && (
                  <button
                    aria-label={`删除 ${selected.name}`}
                    className="icon-button"
                    onClick={() => void remove(selected.id)}
                    type="button"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </>
            )}
          </div>
        </header>


        <div className="article-editor__scroll">
        {error && (
          <div className="workflow-task__failure" role="alert"><p>{error}</p></div>
        )}
        {selected && form && (
          <div style={{ display: "grid", gap: 10, maxWidth: 940 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label className="field"><span>名称</span>
                <input disabled={selected.isBuiltIn} onChange={(event) => update({ name: event.target.value })} value={form.name} />
              </label>
              <label className="field"><span>分类</span>
                <input disabled={selected.isBuiltIn} onChange={(event) => update({ category: event.target.value })} value={form.category} />
              </label>
            </div>
            <label className="field"><span>描述</span>
              <input disabled={selected.isBuiltIn} onChange={(event) => update({ description: event.target.value })} value={form.description} />
            </label>
            {selected.mode === "reference" && selected.referenceMarkdown && <details><summary>参考原文（仅用于写法分析）</summary><pre style={{ whiteSpace: "pre-wrap", maxHeight: 320, overflow: "auto" }}>{selected.referenceMarkdown}</pre></details>}
            <label className="field"><span>模板骨架</span>
              <textarea
                disabled={selected.isBuiltIn}
                onChange={(event) => update({ markdown: event.target.value })}
                rows={10}
                value={form.markdown}
              />
            </label>
            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
              <div className="field"><span>文风设置</span>
                <ProfileFields kind="style" disabled={selected.isBuiltIn} onChange={(value) => update({ styleProfile: value })} value={form.styleProfile} />
              </div>
              <div className="field"><span>结构设置</span>
                <ProfileFields kind="structure" disabled={selected.isBuiltIn} onChange={(value) => update({ structureProfile: value })} value={form.structureProfile} />
              </div>
              <div className="field"><span>排版设置</span>
                <ProfileFields kind="layout" disabled={selected.isBuiltIn} onChange={(value) => update({ layoutProfile: value })} value={form.layoutProfile} />
              </div>
              <div className="field"><span>固定内容</span>
                <FixedContentFields disabled={selected.isBuiltIn} onChange={(value) => update({ fixedBlocks: value })} value={form.fixedBlocks} />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label className="field"><span>变量</span>
                <input disabled={selected.isBuiltIn} onChange={(event) => update({ variables: event.target.value })} value={form.variables} />
              </label>
              <label className="field"><span>使用说明</span>
                <input disabled={selected.isBuiltIn} onChange={(event) => update({ usageInstructions: event.target.value })} value={form.usageInstructions} />
              </label>
            </div>
          </div>
        )}

        <div style={{ display: "grid", gap: 12, maxWidth: 940, marginTop: 20 }}>
          <div className="panel" style={{ display: "grid", gap: 10 }}>
            <h2 style={{ margin: 0 }}>新建模板</h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <input onChange={(event) => setName(event.target.value)} placeholder="模板名称" value={name} />
              <input onChange={(event) => setDescription(event.target.value)} placeholder="一句话描述" value={description} />
            </div>
            <textarea
              onChange={(event) => setMarkdown(event.target.value)}
              placeholder="Markdown 模板骨架"
              rows={6}
              value={markdown}
            />
            <button className="button button--primary" onClick={() => void create()} type="button">创建模板</button>
          </div>

          <div className="panel" style={{ display: "grid", gap: 10 }}>
            <h2 style={{ margin: 0 }}>从参考文章提取</h2>
            <p className="muted" style={{ fontSize: 12 }}>
              只提取结构与表达方式；事实内容会被替换为变量。提取会同时生成文风、结构、排版画像。
            </p>
            <textarea
              onChange={(event) => setExtractSource(event.target.value)}
              placeholder="粘贴参考文章……"
              rows={7}
              value={extractSource}
            />
              <label><input type="checkbox" checked={rightsConfirmed} onChange={e => setRightsConfirmed(e.target.checked)} /> 我拥有参考文章版权或已取得使用许可</label>
              {extracting && <p role="status">提取中，已等待 {extractSeconds} 秒；最长等待 180 秒，超时后可重试。</p>}

            <button className="button button--quiet" disabled={extracting} onClick={() => void extract()} type="button">
              {extracting ? <LoaderCircle className="spin" size={15} /> : <Wand2 size={15} />}
              {extracting ? "提取中……" : "提取模板"}
            </button>
          </div>
        </div>
        </div>
      </div>
    </section>
  );
}
