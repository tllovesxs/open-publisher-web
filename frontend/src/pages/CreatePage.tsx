import {
  Check,
  ChevronDown,
  FilePlus2,
  ImagePlus,
  LoaderCircle,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useActiveRun } from "../lib/activeRunContext";
import { useAuth } from "../auth/AuthContext";
import { PillSelect } from "../components/PillSelect";
import { appendReferences, readPromptImage, readReferenceFiles } from "../lib/fileImport";


// 蓝本 CreatePage 的 Web 迁移（团队自有代码，1:1 结构与类名）。
// 后端映射：POST /agent-runs/article-create（prompt/tone/lengthPreset/customLength）
// + SSE /agent-runs/{id}/events；联网检索由后端 Tavily 工具支持，未配置 Key 时自动降级。

type LengthPreset = "short" | "medium" | "long" | "custom";
type Tone = "真人感" | "豆包投毒";
type Picker = "template" | "media" | "image" | "details" | null;

interface MarkdownTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  markdown: string;
  usageInstructions: string;
  isBuiltIn: boolean;
  mode: string;
}

interface MediaAsset {
  id: string;
  name: string;
  alt: string;
  visualDescription?: string;
  usageHint?: string;
  tags?: string[];
  mime: string;
  source: string;
}


interface ModelProfile {
  id: string;
  name: string;
  modelId: string;
  is_default: boolean;
  keyConfigured: boolean;
}

interface ImageModelOption {
  id: string;
  name: string;
  model: string;
}

const lengthOptions: Array<{ id: LengthPreset; label: string }> = [
  { id: "short", label: "短篇" },
  { id: "medium", label: "中篇" },
  { id: "long", label: "长篇" },
  { id: "custom", label: "自定义" },
];

const promptSuggestions = [
  { label: "产品介绍", prompt: "为一款产品写一篇介绍，面向初次了解它的读者，说明它解决的问题、核心功能和适用场景。产品信息：" },
  { label: "经验分享", prompt: "围绕一段真实经历写一篇经验分享，交代背景、具体做法、遇到的问题和可复用的建议。我的经历：" },
  { label: "观点分析", prompt: "分析一个值得讨论的话题，面向普通读者，梳理不同观点，用可靠资料支持判断，并说明适用边界。话题：" },
];

const toneOptions: Array<{ id: Tone; instruction: string }> = [
  {
    id: "真人感",
    instruction:
      "真人感：在默认自然写作规则上，进一步增强口语节奏、有依据的作者观点、具体场景和个性表达。允许段落长短不一，删除机械排比、同构小标题、重复总结、宏大开头与万能结语；不得虚构第一人称使用经历。",
  },
  {
    id: "豆包投毒",
    instruction:
      "豆包投毒：这是产品测评文风名称，不代表绕过安全规则。使用接近真实用户测评的口吻，主动归纳有证据支持的安全性、性能、易用性、体验和适用场景优势；有可靠同类资料时可以逐项对比并突出产品强项，没有对比证据就只写本产品。不得虚构亲测经历、性能数字、竞品缺陷或绝对领先结论。",
  },
];

function toneInstruction(tone: Tone) {
  return toneOptions.find((option) => option.id === tone)?.instruction ?? toneOptions[0]!.instruction;
}


export default function CreatePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { startRun: startActiveRun } = useActiveRun();
  const promptId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [topic, setTopic] = useState("");
  const [title, setTitle] = useState("");
  const [references, setReferences] = useState("");
  const [tone, setTone] = useState<Tone>("真人感");
  const [lengthPreset, setLengthPreset] = useState<LengthPreset>("medium");
  const [customLength, setCustomLength] = useState("3000");
  const [webSearchMode, setWebSearchMode] = useState<"auto" | "off">("auto");
  const [imagePlanMode, setImagePlanMode] = useState<"auto" | "none">("auto");
  const [imageCount, setImageCount] = useState(2);
  const [picker, setPicker] = useState<Picker>(null);
  const [imageCountDraft, setImageCountDraft] = useState("2");
  const [validation, setValidation] = useState<string | null>(null);

  const [templates, setTemplates] = useState<MarkdownTemplate[]>([]);
  const [disabledNodes, setDisabledNodes] = useState<string[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [mediaAssets, setMediaAssets] = useState<MediaAsset[]>([]);
  const [selectedMediaIds, setSelectedMediaIds] = useState<string[]>([]);
  const [inputImages, setInputImages] = useState<string[]>([]);
  const [promptImageImporting, setPromptImageImporting] = useState(false);
  const promptImageInputRef = useRef<HTMLInputElement | null>(null);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [imageModels, setImageModels] = useState<ImageModelOption[]>([]);
  // 生图模型选择为非必选：留空沿用当前用户的生图偏好，未设置时使用平台默认
  const [selectedImageModelId, setSelectedImageModelId] = useState("");

  const [importNote, setImportNote] = useState<string | null>(null);
  // 发起后按蓝本工作流直接进入文章工作区；SSE 和进度由全局 ActiveRunProvider 保存。
  const [starting, setStarting] = useState(false);
  // 配图数量编辑草稿：弹窗打开时同步，避免 0 占位导致需要先删 0 再输入
  useEffect(() => {
    if (picker === "image") setImageCountDraft(String(imageCount));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker]);

  useEffect(() => {
    if (!picker) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicker(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [picker]);


  useEffect(() => {
    // 模型目录是公共展示信息（免登录可读）：无论是否登录都加载，避免未登录显示"未配置模型"。
    api.get<{ profiles: ModelProfile[] }>("/settings/profiles")
      .then((res) => {
        const list = res.data.profiles ?? [];
        setProfiles(list);
        setActiveProfileId(list.find((p) => p.is_default)?.id ?? list[0]?.id ?? null);
      })
      .catch(() => setProfiles([]));
    api.get<{ models: ImageModelOption[] }>("/settings/image-models")
      .then((res) => setImageModels(res.data.models ?? []))
      .catch(() => setImageModels([]));
    if (!user) return;
    api.get<{ templates: MarkdownTemplate[] }>("/templates")
      .then((res) => setTemplates(res.data.templates ?? []))
      .catch(() => setTemplates([]));
    api.get<{ assets: MediaAsset[] }>("/media")
      .then((res) => setMediaAssets(res.data.assets ?? []))
      .catch(() => setMediaAssets([]));
  }, [user]);

  useEffect(() => { void api.get<{disabledNodeIds:string[];webSearchMode:"auto"|"off"}>("/settings/preferences").then(r => { setDisabledNodes(r.data.disabledNodeIds); setWebSearchMode(r.data.webSearchMode); }).catch(() => undefined); }, []);
  // 素材库「带入创作」：读取路由 state 预选素材，用后即清。
  useEffect(() => {
    const ids = (location.state as { selectedMediaIds?: string[] } | null)?.selectedMediaIds;
    if (Array.isArray(ids) && ids.length > 0) {
      setSelectedMediaIds(ids.slice(0, 20));
      navigate("/", { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;
  const selectedMedia = mediaAssets.filter((asset) => selectedMediaIds.includes(asset.id));
  const selectedImageModel = imageModels.find((m) => m.id === selectedImageModelId) ?? null;
  const imageLabel = imagePlanMode === "none"
    ? "不配图"
    : `自动 · ${imageCount} 张${selectedImageModel ? ` · ${selectedImageModel.model}` : ""}`;
  const selectedProfile = profiles.find((p) => p.id === activeProfileId) ?? null;
  const templateLabel = selectedTemplate?.mode === "reference"
    ? `高保真参考 · ${selectedTemplate.name}`
    : selectedTemplate?.name ?? "自由结构";

  const importReferenceFiles = async (fileList: FileList | null) => {
    if (!fileList || !fileList.length) return;
    // 必须先快照：onChange 启动导入后会清空 input.value，活 FileList 会被浏览器置空
    const files = Array.from(fileList);
    try {
      const text = await readReferenceFiles(files, "来源文件");
      setReferences((current) => appendReferences(current, text));
      setImportNote(`已导入资料，最多保留 40 个文件、共 30 万字。`);
    } catch (error) {
      setValidation(error instanceof Error ? error.message : "资料读取失败，请重试。");
    }
  };

  const addPromptImages = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const selectedFiles = Array.from(files).slice(0, 10 - inputImages.length);
    setPromptImageImporting(true);
    try {
      const dataUrls: string[] = [];
      for (const file of selectedFiles) {
        dataUrls.push(await readPromptImage(file));
      }
      if (dataUrls.length) {
        setInputImages((current) => [...current, ...dataUrls].slice(0, 10));
        setImportNote(`已添加 ${dataUrls.length} 张图片，写作模型将参考图片内容。`);
      }
    } catch (error) {
      setValidation(error instanceof Error ? error.message : "图片读取失败，请重试。");
    } finally {
      setPromptImageImporting(false);
    }
  };

  const activateProfile = async (profileId: string) => {
    if (profileId === activeProfileId) return;
    try {
      await api.post(`/settings/profiles/${profileId}/activate`);
      setActiveProfileId(profileId);
      setProfiles((current) => current.map((p) => ({ ...p, is_default: p.id === profileId })));
    } catch {
      setValidation("切换模型失败，请稍后再试。");
    }
  };

  const startCreation = async () => {
    if (starting) return;
    if (!user) {
      navigate("/login");
      return;
    }
    if (!topic.trim()) {
      setValidation("请先写下主题或创作要求。");
      return;
    }
    setValidation(null);
    setStarting(true);

    const sections: string[] = [topic.trim()];
    if (title.trim()) sections.push(`文章标题：${title.trim()}`);
    if (selectedTemplate) {
      sections.push(`使用模板「${selectedTemplate.name}」的结构：\n\n${selectedTemplate.markdown}\n\n${selectedTemplate.usageInstructions}`);
    }
    if (selectedMedia.length > 0) {
      sections.push(
        `可用素材（仅在匹配时引用，不要杜撰图片内容）：\n${selectedMedia
          .map((asset) => `- ${asset.name}（/api/media/${asset.id}/raw）：${asset.alt || "未填写描述"}`)
          .join("\n")}`,
      );
    }
    // References travel in their dedicated field; the backend selects retrieved
    // evidence or the original-text fallback without duplicating the full input.

    const articleId = `article-${Date.now()}`;
    try {
      await startActiveRun({
        articleId,
        prompt: sections.join("\n\n").slice(0, 100000),
        tone: toneInstruction(tone),
        lengthPreset,
        customLength: lengthPreset === "custom" ? customLength : null,
        humanize: false,
        title: title.trim() || null,
        references: references.trim() || null,
        template: selectedTemplate,
        imageAssets: selectedMediaIds,
        inputImages,
        imagePlan: {
          targetCount: imagePlanMode === "auto" ? imageCount : 0,
          imageModelId: selectedImageModelId || null,
        },
        webSearchMode,
        taskMode: "article_create",
        disabledNodeIds: disabledNodes,
        materialMatchThreshold: 40,
      }, title.trim() || topic.trim().slice(0, 80), {
        visualPlan: {
          enabled: (imagePlanMode === "auto" || selectedMediaIds.length > 0)
            && !disabledNodes.includes("visual"),
          targetCount: imagePlanMode === "auto" ? imageCount : 0,
          imageModelId: selectedImageModelId || null,
          assetIds: selectedMediaIds,
        },
      });
      navigate(`/articles?open=${encodeURIComponent(articleId)}`);
    } catch (error) {
      setValidation(error instanceof Error ? error.message : "创作请求失败，请稍后重试。");
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="page page--create">
      <header className="page-heading page-heading--create">
        <div>
          <span className="page-kicker">创作工作台</span>
          <h1>开始创作</h1>
        </div>
      </header>

      <div className="creation-studio">
        <div aria-label="创作选项" className="creation-toolbar">
          <button className="creation-toolbar__choice creation-toolbar__button" onClick={() => setPicker("template")} type="button">
            <span>模板</span><strong>{templateLabel}</strong><ChevronDown aria-hidden="true" size={14} />
          </button>
          <PillSelect
            ariaLabel="文风"
            label="文风"
            onChange={(value) => setTone(value)}
            options={toneOptions.map((option) => ({ id: option.id, label: option.id }))}
            value={tone}
          />
          <PillSelect
            ariaLabel="篇幅"
            label="篇幅"
            onChange={(value) => setLengthPreset(value)}
            options={lengthOptions}
            value={lengthPreset}
          />
          {lengthPreset === "custom" && (
            <label className="creation-toolbar__choice creation-toolbar__length">
              <span>字数</span>
              <input aria-label="目标字数" min={1} onChange={(event) => setCustomLength(event.target.value)} type="number" value={customLength} />
            </label>
          )}
          <PillSelect
            ariaLabel="联网检索"
            label="联网"
            onChange={(value) => setWebSearchMode(value)}
            options={[
              { id: "auto", label: "自动" },
              { id: "off", label: "关闭" },
            ]}
            title="查找最新网络资料；服务不可用时，将使用已提供的资料继续创作"
            value={webSearchMode}
          />
          <button className="creation-toolbar__choice creation-toolbar__button" onClick={() => setPicker("image")} type="button">
            <span>配图</span><strong>{imageLabel}</strong><ChevronDown aria-hidden="true" size={14} />
          </button>
        </div>

        <div className="creation-composer">
          {inputImages.length > 0 && (
            <div aria-label="已添加图片" className="creation-prompt-images">
              {inputImages.map((dataUrl, index) => (
                <span className="creation-prompt-images__chip" key={index}>
                  <img alt={`图片 ${index + 1}`} src={dataUrl} />
                  <button
                    aria-label={`移除图片 ${index + 1}`}
                    onClick={() => setInputImages((current) => current.filter((_, i) => i !== index))}
                    type="button"
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <label className="visually-hidden" htmlFor={promptId}>文章主题</label>
          <textarea
            aria-invalid={validation ? "true" : undefined}
            autoFocus
            id={promptId}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="写下主题、读者、目标或希望文章回答的问题"
            rows={8}
            value={topic}
          />
          <div className="creation-composer__footer">
            <div className="creation-composer__tools">
              <button className="text-button" onClick={() => setPicker("details")} type="button"><SlidersHorizontal size={15} />资料</button>
              <button className="text-button" onClick={() => fileInputRef.current?.click()} type="button"><FilePlus2 size={15} />导入文件</button>
              <button className="text-button" onClick={() => setPicker("media")} type="button"><ImagePlus size={15} />{selectedMedia.length ? `素材 ${selectedMedia.length}` : "选择素材"}</button>
              <button className="text-button" disabled={promptImageImporting} onClick={() => promptImageInputRef.current?.click()} type="button"><ImagePlus size={15} />{promptImageImporting ? "导入图片" : "添加图片"}</button>
              <input
                accept=".md,.markdown,.txt,text/plain,text/markdown"
                aria-label="选择参考文件"
                className="visually-hidden"
                multiple
                onChange={(event) => { void importReferenceFiles(event.target.files); event.currentTarget.value = ""; }}
                ref={fileInputRef}
                type="file"
              />
              <input
                accept="image/*"
                aria-label="添加图片"
                className="visually-hidden"
                multiple
                onChange={(event) => { void addPromptImages(event.target.files); event.currentTarget.value = ""; }}
                ref={promptImageInputRef}
                type="file"
              />
            </div>
            <div className="creation-composer__actions">
            <span className="creation-composer__summary">{templateLabel}</span>
            <PillSelect
              ariaLabel="写作模型"
              label="模型"
              onChange={(value) => { void activateProfile(value); }}
              options={profiles.length > 0 ? profiles.map((profile) => ({ id: profile.id, label: `${profile.name} · ${profile.modelId}${profile.keyConfigured ? "" : "（缺少密钥）"}` })) : [{ id: "", label: "未配置模型" }]}
              value={selectedProfile?.id ?? ""}
            />
            <button
              className="button button--primary"
              disabled={starting}
              onClick={() => void startCreation()}
              type="button"
            >
              {starting ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
              {starting ? "正在进入文章工作区…" : user ? "开始创作" : "登录后开始创作"}
            </button>
            </div>
          </div>
          {validation && <p className="creation-validation" role="alert">{validation}</p>}
          {importNote && <p className="creation-import-note" role="status">{importNote}</p>}
        </div>
        {!topic.trim() && (
          <div aria-label="创作建议" className="creation-suggestions">
            <span>还没想好怎么写？试试</span>
            <div>
              {promptSuggestions.map((suggestion) => (
                <button className="creation-suggestions__item" key={suggestion.label} onClick={() => {
                  setTopic(suggestion.prompt);
                  setValidation(null);
                  document.getElementById(promptId)?.focus();
                }} type="button">{suggestion.label}</button>
              ))}
            </div>
          </div>
        )}

      </div>

      {picker !== null && (
        <div className="studio-modal creation-picker-modal">
          <div className="studio-modal__scrim" onClick={() => setPicker(null)} role="presentation" />
        {picker === "template" && (
          <section aria-label="选择写作模板" aria-modal="true" className="creation-picker__dialog" role="dialog">
            <header>
              <div><span className="page-kicker">写作模板</span><h2>选择文章结构</h2></div>
              <button aria-label="关闭" className="icon-button" onClick={() => setPicker(null)} type="button"><X size={18} /></button>
            </header>
            <div className="creation-picker__grid">
              <button aria-pressed={!selectedTemplate} className={!selectedTemplate ? "is-selected" : ""} onClick={() => { setSelectedTemplateId(null); setPicker(null); }} type="button"><strong>自由结构</strong><span>根据主题自动组织文章，不套用模板。</span>{!selectedTemplate && <Check size={16} />}</button>
              {templates.map((template) => (
                <button
                  aria-pressed={selectedTemplate?.id === template.id}
                  className={selectedTemplate?.id === template.id ? "is-selected" : ""}
                  key={template.id}
                  onClick={() => { setSelectedTemplateId(template.id); setPicker(null); }}
                  type="button"
                >
                  <strong>{template.name}</strong>
                  <span>{template.description || template.usageInstructions || "使用已保存的结构、排版与文风。"}</span>
                  <small>{template.mode === "reference" ? "高保真参考" : template.category}</small>
                  {selectedTemplate?.id === template.id && <Check size={16} />}
                </button>
              ))}
            </div>
            <footer><button className="button button--primary" onClick={() => setPicker(null)} type="button">完成选择</button></footer>
          </section>
        )}

        {picker === "media" && (
          <section aria-label="选择图片素材" aria-modal="true" className="creation-picker__dialog" role="dialog">
            <header>
              <div><span className="page-kicker">图片参考</span><h2>选择素材库图片</h2></div>
              <button aria-label="关闭" className="icon-button" onClick={() => setPicker(null)} type="button"><X size={18} /></button>
            </header>
            <div className="creation-picker__media">
              {mediaAssets.length === 0
                ? <p>素材库还没有图片。</p>
                : mediaAssets.map((asset) => {
                  const isSelected = selectedMediaIds.includes(asset.id);
                  return (
                    <button
                      aria-pressed={isSelected}
                      className={isSelected ? "is-selected" : ""}
                      key={asset.id}
                      onClick={() => setSelectedMediaIds((current) =>
                        current.includes(asset.id)
                          ? current.filter((id) => id !== asset.id)
                          : [...current, asset.id])}
                      type="button"
                    >
                      <img alt="" src={`/api/media/${asset.id}/raw`} />
                      <span><strong>{asset.name}</strong><small>{asset.alt || "未填写图片描述"}</small></span>
                      {isSelected && <Check size={16} />}
                    </button>
                  );
                })}
            </div>
            <footer><button className="button button--primary" onClick={() => setPicker(null)} type="button">完成选择</button></footer>
          </section>
        )}

        {picker === "image" && (
          <section aria-label="配图设置" aria-modal="true" className="creation-picker__dialog creation-picker__dialog--settings" role="dialog">
            <header>
              <div><span className="page-kicker">配图设置</span><h2>决定图片如何补足正文</h2></div>
              <button aria-label="关闭" className="icon-button" onClick={() => setPicker(null)} type="button"><X size={18} /></button>
            </header>
            <div className="creation-settings-form">
              <div className="field">
                <span>配图方式</span>
                <PillSelect
                  ariaLabel="配图方式"
                  label="配图方式"
                  onChange={setImagePlanMode}
                  options={[
                    { id: "auto" as const, label: "自动" },
                    { id: "none" as const, label: "不配图" },
                  ]}
                  value={imagePlanMode}
                  variant="field"
                />
              </div>
              {imagePlanMode === "auto" && (
                <div className="field">
                  <span>生图模型（可选）</span>
                  <PillSelect
                    ariaLabel="生图模型"
                    label="生图模型"
                    onChange={setSelectedImageModelId}
                    options={[
                      { id: "", label: "跟随设置中的生图模型" },
                      ...imageModels.map((model) => ({
                        id: model.id,
                        label: `${model.name} · ${model.model}`,
                      })),
                    ]}
                    value={selectedImageModelId}
                    variant="field"
                  />
                  {imageModels.length === 0 && (
                    <small>暂无已配置生图模型；未在管理端配置生图时无法自动生成图片。</small>
                  )}
                </div>
              )}
              {imagePlanMode === "auto" && (
                <label className="field">
                  <span>目标图片数量</span>
                  <input
                    aria-label="目标图片数量"
                    max={6}
                    min={0}
                    onBlur={() => setImageCountDraft(String(imageCount))}
                    onChange={(event) => {
                      const raw = event.target.value;
                      setImageCountDraft(raw);
                      const parsed = Number.parseInt(raw, 10);
                      if (!Number.isNaN(parsed)) {
                        setImageCount(Math.min(6, Math.max(0, parsed)));
                      }
                    }}
                    placeholder={`0-6（当前 ${imageCount}）`}
                    type="number"
                    value={imageCountDraft}
                  />
                </label>
              )}
              <small>按你的选择规划文章配图。不选择生图模型时，使用默认模型。</small>
            </div>
          </section>
        )}

        {picker === "details" && (
          <section aria-label="创作资料" aria-modal="true" className="creation-picker__dialog creation-picker__dialog--settings" role="dialog">
            <header>
              <div><span className="page-kicker">创作资料</span><h2>标题与参考内容</h2></div>
              <button aria-label="关闭" className="icon-button" onClick={() => setPicker(null)} type="button"><X size={18} /></button>
            </header>
            <div className="creation-settings-form">
              <label className="field">
                <span>文章标题（可选）</span>
                <input onChange={(event) => setTitle(event.target.value)} placeholder="留空则根据主题自动拟定" value={title} />
              </label>
              <label className="field">
                <span>参考资料</span>
                <textarea
                  aria-label="参考资料"
                  onChange={(event) => setReferences(event.target.value)}
                  placeholder="粘贴链接、数据、访谈摘录、项目说明或已有笔记"
                  rows={8}
                  value={references}
                />
              </label>
              <small>导入的资料文件也会合并到这里，作为独立资料附在本次创作中。</small>
            </div>
          </section>
        )}
        </div>
      )}
    </section>
  );
}
