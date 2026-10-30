import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Check, Copy, FilePlus2, FileUp, LayoutTemplate, LoaderCircle, Plus, Save, Search, Sparkles, Trash2, Wand2 } from "lucide-react";
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
  const [sourceFileName, setSourceFileName] = useState<string | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [extracting, setExtracting] = useState(false);
  const [search, setSearch] = useState("");
  const [activeSection, setActiveSection] = useState("template-outline");
  const [createOpen, setCreateOpen] = useState(false);
  const [extractOpen, setExtractOpen] = useState(false);
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const isDirty = Boolean(selected && form && JSON.stringify(form) !== JSON.stringify(toForm(selected)));
  const visibleTemplates = useMemo(() => templates.filter(template => `${template.name} ${template.description} ${template.category}`.toLowerCase().includes(search.trim().toLowerCase())), [templates, search]);
  useEffect(() => { if (!extracting) return; setExtractSeconds(0); const id = window.setInterval(() => setExtractSeconds(n => n + 1), 1000); return () => clearInterval(id); }, [extracting]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || !form) return;
    const sections = Array.from(content.querySelectorAll<HTMLElement>(".template-section"));
    const syncSection = () => {
      if (!sections.length) return;
      const top = content.getBoundingClientRect().top + 48;
      let current = sections[0].id;
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= top) current = section.id;
      }
      if (content.scrollTop > 0 && content.scrollTop + content.clientHeight >= content.scrollHeight - 2) current = sections[sections.length - 1].id;
      setActiveSection(current);
    };
    content.scrollTo({ top: 0, behavior: "instant" });
    content.addEventListener("scroll", syncSection, { passive: true });
    const observer = new ResizeObserver(syncSection);
    observer.observe(content);
    sections.forEach(section => observer.observe(section));
    syncSection();
    return () => { content.removeEventListener("scroll", syncSection); observer.disconnect(); };
  }, [selected?.id, Boolean(form)]);

  const importMarkdown = async (file?: File) => {
    if (!file || extracting || readingFile) return;
    setError(null);
    setReadingFile(true);
    try {
      if (!/\.(md|markdown|txt)$/i.test(file.name)) throw new Error("请选择 .md、.markdown 或 .txt 文件。");
      if (file.size > 8_000_000) throw new Error("参考文件过大，请使用不超过 200 万字符的文档。");
      const content = (await file.text()).replace(/^\uFEFF/, "");
      if (!content.trim()) throw new Error("文件内容为空，请选择有正文的 Markdown 文档。");
      if (content.includes("\0") || content.length > 2_000_000) throw new Error("文件包含无效字符或超过 200 万字符。");
      setExtractSource(content);
      setSourceFileName(file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法读取这个文件，请改为粘贴 Markdown 正文。");
    } finally { setReadingFile(false); }
  };

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
      setCreateOpen(false);
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
      setSourceFileName(null);
      setRightsConfirmed(false);
      await load();
      setSelected(res.data);
      setExtractOpen(false);
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
    <section className="template-workbench">
      <aside aria-label="模板列表" className={`template-library${mobileListOpen ? " is-open" : ""}`}>
        <div className="template-library__head">
          <div><span className="page-kicker">内容工作台</span><h1>模板库</h1><p>{templates.length} 个模板</p></div>
          <button className="icon-button template-mobile-close" aria-label="关闭模板列表" onClick={() => setMobileListOpen(false)} type="button">×</button>
        </div>
        <label className="template-search"><Search size={15} /><input aria-label="搜索模板" placeholder="搜索模板" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <div className="template-library__list">
          {visibleTemplates.map((template) => (
            <button
              aria-current={selected?.id === template.id ? "true" : undefined}
              className={`article-list-item${selected?.id === template.id ? " is-active" : ""}`}
              key={template.id}
              onClick={() => { setSelected(template); setMobileListOpen(false); }}
              type="button"
            >
              <span className="template-library__item-icon">{template.mode === "reference" ? <BookOpen size={16} /> : <LayoutTemplate size={16} />}</span>
              <span className="template-library__item-copy"><strong>{template.name}</strong><small>{template.category}</small></span>
              <span className={`template-type${template.isBuiltIn ? " is-official" : ""}`}>{template.isBuiltIn ? "官方" : template.mode === "reference" ? "提取" : "自定义"}</span>
            </button>
          ))}
          {!visibleTemplates.length && <p className="template-empty">没有匹配的模板</p>}
        </div>
        <div className="template-library__footer"><button className="button button--quiet" onClick={() => setCreateOpen(true)} type="button"><Plus size={15} />新建模板</button><button className="button button--quiet" onClick={() => setExtractOpen(true)} type="button"><Wand2 size={15} />从文章提取</button></div>
        {user?.role === "admin" && <button className="template-refresh" onClick={() => { void api.post("/templates/refresh-official").then(load).catch(() => setError("官方模板刷新失败")); }} type="button">刷新官方模板</button>}
      </aside>
      <div className="template-main">
        <header className="template-toolbar">
          <button className="icon-button template-mobile-menu" aria-label="打开模板列表" onClick={() => setMobileListOpen(true)} type="button"><LayoutTemplate size={17} /></button>
          <div className="template-toolbar__title"><span className="page-kicker">{selected?.category ?? "模板库"}</span><h2>{selected?.name ?? "选择一个模板"}</h2></div>
          <div className="template-toolbar__actions">
            {selected && (
              <>
                <button
                  aria-label="保存模板修改" className="button button--quiet"
                  disabled={selected.isBuiltIn || saving}
                  onClick={() => void save()}
                  type="button"
                >
                  {saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
                  {saving ? "保存中" : "保存修改"}
                </button>
                <button
                  className="button button--quiet"
                  onClick={() => void duplicate()}
                  type="button"
                >
                  <Copy size={15} />复制另存
                </button>
                <button
                  className="button button--primary"
                  onClick={() => {
                    if (form && JSON.stringify(form) !== JSON.stringify(toForm(selected))) { setError("请先保存修改，或复制另存后用于创作。"); return; }
                    navigate(`/?template=${encodeURIComponent(selected.id)}`);
                  }}
                  type="button"
                >
                  <Sparkles size={15} />用于创作
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
        <div className="template-content" ref={contentRef}>
        {error && (
          <div className="workflow-task__failure" role="alert"><p>{error}</p></div>
        )}
        {selected && form && (
          <>
            <div className="template-overview">
              <span className="template-overview__icon"><LayoutTemplate size={20} /></span>
              <div className="template-overview__fields">
                <label className="field"><span>模板名称</span><input disabled={selected.isBuiltIn} onChange={event => update({ name: event.target.value })} value={form.name} /></label>
                <label className="field"><span>分类</span><input disabled={selected.isBuiltIn} onChange={event => update({ category: event.target.value })} value={form.category} /></label>
                <label className="field template-field--wide"><span>用途说明</span><input disabled={selected.isBuiltIn} onChange={event => update({ description: event.target.value })} value={form.description} /></label>
              </div>
            </div>
            {selected.mode === "reference" && selected.referenceMarkdown && <details className="template-reference"><summary><BookOpen size={15} />参考原文 <span>只用于写法分析</span></summary><pre>{selected.referenceMarkdown}</pre></details>}
            <section className="template-section" id="template-outline"><div className="template-section__heading"><div><span>01</span><div><h3>模板骨架</h3><p>安排文章结构，并用变量标记需要替换的内容。</p></div></div><span className="template-section__meta">{form.markdown.length.toLocaleString()} 字符</span></div><label className="field"><textarea className="template-outline-input" aria-label="模板骨架" disabled={selected.isBuiltIn} onChange={event => update({ markdown: event.target.value })} rows={12} value={form.markdown} /></label></section>
            <section className="template-section" id="template-style"><div className="template-section__heading"><div><span>02</span><div><h3>文风规范</h3><p>明确文章面向谁，以及表达节奏和语气。</p></div></div></div><div className="template-field-grid template-field-grid--three">{profileFields.style.map(([key,label]) => <label className="field" key={key}><span>{label}</span><textarea aria-label={label} rows={2} disabled={selected.isBuiltIn} value={String((JSON.parse(form.styleProfile) as Record<string, unknown>)[key] ?? "")} onChange={event => { const data=JSON.parse(form.styleProfile); update({styleProfile:JSON.stringify({...data,[key]:event.target.value})}); }} /></label>)}</div></section>
            <section className="template-section" id="template-structure"><div className="template-section__heading"><div><span>03</span><div><h3>结构规范</h3><p>定义开篇、章节推进、段落和结尾方式。</p></div></div></div><div className="template-field-grid template-field-grid--two">{profileFields.structure.map(([key,label]) => <label className="field" key={key}><span>{label}</span><textarea aria-label={label} rows={2} disabled={selected.isBuiltIn} value={String((JSON.parse(form.structureProfile) as Record<string, unknown>)[key] ?? "")} onChange={event => { const data=JSON.parse(form.structureProfile); update({structureProfile:JSON.stringify({...data,[key]:event.target.value})}); }} /></label>)}</div></section>
            <section className="template-section" id="template-layout"><div className="template-section__heading"><div><span>04</span><div><h3>排版规范</h3><p>控制列表、表格、代码块、图片和重点的呈现。</p></div></div></div><div className="template-field-grid template-field-grid--two">{profileFields.layout.map(([key,label]) => <label className="field" key={key}><span>{label}</span><textarea aria-label={label} rows={2} disabled={selected.isBuiltIn} value={String((JSON.parse(form.layoutProfile) as Record<string, unknown>)[key] ?? "")} onChange={event => { const data=JSON.parse(form.layoutProfile); update({layoutProfile:JSON.stringify({...data,[key]:event.target.value})}); }} /></label>)}</div><div className="template-toggles"><span>内容元素</span>{([["useLists","列表"],["useTables","表格"],["useBlockquotes","引用"],["useCodeBlocks","代码块"]] as const).map(([key,label]) => <label key={key}><input type="checkbox" disabled={selected.isBuiltIn} checked={(JSON.parse(form.layoutProfile) as Record<string, unknown>)[key] === true} onChange={event => { const data=JSON.parse(form.layoutProfile); update({layoutProfile:JSON.stringify({...data,[key]:event.target.checked})}); }} /><span>{label}</span></label>)}</div></section>
            <section className="template-section" id="template-blocks"><div className="template-section__heading"><div><span>05</span><div><h3>固定内容</h3><p>设置需要保留的说明或固定文案。</p></div></div></div><FixedContentFields disabled={selected.isBuiltIn} onChange={value => update({fixedBlocks:value})} value={form.fixedBlocks} /></section>
            <section className="template-section" id="template-usage"><div className="template-section__heading"><div><span>06</span><div><h3>使用说明</h3><p>补充 Agent 应遵守的特定要求。</p></div></div></div><label className="field"><textarea aria-label="使用说明" disabled={selected.isBuiltIn} rows={4} value={form.usageInstructions} onChange={event => update({usageInstructions:event.target.value})} /></label><label className="field template-variables"><span>变量</span><input aria-label="变量" disabled={selected.isBuiltIn} value={form.variables} onChange={event => update({variables:event.target.value})} /></label></section>
          </>
        )}
        </div>
        {selected && form && <nav aria-label="模板章节" className="template-outline-nav">{[["template-outline","骨架"],["template-style","文风"],["template-structure","结构"],["template-layout","排版"],["template-blocks","固定内容"],["template-usage","使用说明"]].map(([id,label],i)=><a className={activeSection===id?"is-active":""} aria-current={activeSection===id?"location":undefined} href={`#${id}`} key={id} onClick={event=>{event.preventDefault(); const content=contentRef.current; const target=content?.querySelector<HTMLElement>(`#${id}`); if(content&&target) content.scrollTo({top:target.getBoundingClientRect().top-content.getBoundingClientRect().top+content.scrollTop-20,behavior:"smooth"});}}><span>0{i+1}</span>{label}</a>)}</nav>}
        <footer className="template-savebar"><div>{isDirty ? <><span className="template-dirty-dot" />有未保存的修改</> : <><Check size={14} />已保存</>}</div><div><button className="button button--quiet" onClick={() => setCreateOpen(true)} type="button"><FilePlus2 size={15} />新建</button><button className="button button--primary" disabled={!isDirty || selected?.isBuiltIn || saving} onClick={() => void save()} type="button"><Save size={15} />{saving ? "保存中" : "保存修改"}</button></div></footer>
      </div>
      {(createOpen || extractOpen) && <div className="template-modal-backdrop" onClick={() => {setCreateOpen(false);setExtractOpen(false);}}><section aria-label={createOpen?"新建模板":"从参考文章提取"} aria-modal="true" className="template-modal" onClick={event=>event.stopPropagation()} role="dialog"><header><div><span className="page-kicker">模板库</span><h2>{createOpen?"新建模板":"从参考文章提取"}</h2></div><button className="icon-button" aria-label="关闭" onClick={()=>{setCreateOpen(false);setExtractOpen(false);}} type="button">×</button></header>{error && <div role="alert" className="workflow-task__failure"><p>{error}</p></div>}{createOpen?<div className="template-modal__body"><label className="field"><span>模板名称</span><input autoFocus onChange={event=>setName(event.target.value)} placeholder="例如：产品发布说明" value={name}/></label><label className="field"><span>用途说明</span><input onChange={event=>setDescription(event.target.value)} placeholder="简要说明模板适用场景" value={description}/></label><label className="field"><span>模板骨架</span><textarea rows={9} onChange={event=>setMarkdown(event.target.value)} placeholder="# {{title}}\n\n## {{section}}\n{{content}}" value={markdown}/></label></div>:<div className="template-modal__body"><p className="muted">分析结构和表达方式，将具体事实替换为变量；参考原文只用于写法分析。导入后点击“提取模板”开始自动分析。</p><div className="template-import-actions"><input accept=".md,.markdown,.txt,text/markdown,text/plain" aria-label="导入 Markdown 文件" className="visually-hidden" disabled={extracting || readingFile} ref={fileInputRef} type="file" onChange={event=>{const file=event.currentTarget.files?.[0]; event.currentTarget.value=""; void importMarkdown(file);}} /><button className="button button--quiet" disabled={extracting || readingFile} onClick={()=>fileInputRef.current?.click()} type="button"><FileUp size={15}/>{readingFile?"读取中":"导入 .md"}</button>{sourceFileName && <span title={sourceFileName}>{sourceFileName}</span>}</div><label className="field"><span>参考文章</span><textarea disabled={extracting || readingFile} rows={12} onChange={event=>{setExtractSource(event.target.value);setSourceFileName(null);setError(null);}} placeholder="粘贴 Markdown 或纯文本" value={extractSource}/></label><p className="template-import-count">{Array.from(extractSource).length.toLocaleString()} 字符</p><label className="template-rights"><input type="checkbox" checked={rightsConfirmed} onChange={event=>setRightsConfirmed(event.target.checked)}/>我拥有参考文章版权或已取得使用许可</label>{extracting&&<p role="status">提取中，已等待 {extractSeconds} 秒；最长等待 180 秒。</p>}</div>}<footer><button className="button button--quiet" onClick={()=>{setCreateOpen(false);setExtractOpen(false);}} type="button">取消</button><button className="button button--primary" disabled={createOpen?(!name.trim()||!markdown.trim()):extracting||readingFile||!rightsConfirmed||!extractSource.trim()} onClick={()=>void (createOpen?create():extract())} type="button">{extracting?<LoaderCircle className="spin" size={15}/>:createOpen?<Plus size={15}/>:<Wand2 size={15}/ >}{extracting?"处理中":createOpen?"创建模板":"提取模板"}</button></footer></section></div>}
    </section>
  );
}
