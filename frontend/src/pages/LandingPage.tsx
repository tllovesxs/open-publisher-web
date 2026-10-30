import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { Link } from "react-router-dom";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  ImageIcon,
  Layers3,
  MoveUpRight,
  Pause,
  PenLine,
  Play,
  Search,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import FlowBackdrop from "./landing/FlowBackdrop";
import "./landing/landing.css";

const STEPS = [
  {
    title: "研究",
    label: "让灵感有据可循",
    icon: Search,
    detail: "梳理主题与参考资料，找到值得展开的方向。",
    tags: ["主题理解", "受众分析", "资料检索"],
  },
  {
    title: "写作",
    label: "把思路写成好内容",
    icon: PenLine,
    detail: "从结构到段落，让零散的想法连成一篇文章。",
    tags: ["大纲规划", "正文创作", "风格适配"],
  },
  {
    title: "审阅",
    label: "让每次修改都有价值",
    icon: ShieldCheck,
    detail: "检查表达与内容风险，在版本之间持续打磨。",
    tags: ["内容评估", "风险检查", "版本追溯"],
  },
  {
    title: "配图",
    label: "给文字一个视觉表达",
    icon: ImageIcon,
    detail: "从素材匹配到生成配图，让图文在同一处完成。",
    tags: ["素材匹配", "智能配图", "图文编排"],
  },
];

const CAPABILITIES = [
  {
    icon: BookOpen,
    title: "好内容，从好资料开始。",
    text: "导入参考文件，结合知识库检索，让资料融入你的创作。",
    path: "/",
    link: "带着资料开始",
    kind: "sources",
  },
  {
    icon: Layers3,
    title: "你的表达，有自己的风格。",
    text: "选择创作模板，调整表达方式，把内容写成你想要的样子。",
    path: "/templates",
    link: "探索创作模板",
    kind: "templates",
  },
  {
    icon: ImageIcon,
    title: "文字与画面，一起成稿。",
    text: "管理图片素材，匹配文章配图，让视觉表达接上写作思路。",
    path: "/media",
    link: "打开素材库",
    kind: "images",
  },
];

function spotlight(event: PointerEvent<HTMLElement>) {
  const bounds = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty(
    "--pointer-x",
    `${event.clientX - bounds.left}px`,
  );
  event.currentTarget.style.setProperty(
    "--pointer-y",
    `${event.clientY - bounds.top}px`,
  );
}

export default function LandingPage() {
  const { user } = useAuth();
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const root = useRef<HTMLElement>(null);
  const current = STEPS[step];
  const motionEnabled = !paused && !reducedMotion;

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const scrollTo = (id: string) =>
    document
      .getElementById(id)
      ?.scrollIntoView({
        behavior: motionEnabled ? "smooth" : "instant",
        block: "start",
      });

  return (
    <main
      className={`gl-home${motionEnabled ? "" : " gl-home--still"}`}
      ref={root}
    >
      <a className="gl-skip" href="#gl-content">
        跳到主要内容
      </a>
      <header className="gl-nav">
        <div className="gl-nav__inner">
          <a className="gl-brand" href="#gl-content" aria-label="稿流首页">
            <img src="/gaoliu-mark.svg" alt="" />
            <strong>
              稿流<span>GAOLIU</span>
            </strong>
          </a>
          <nav className="gl-nav__links" aria-label="产品导航">
            <a
              href="#experience"
              onClick={(event) => {
                event.preventDefault();
                scrollTo("experience");
              }}
            >
              创作体验
            </a>
            <a
              href="#capabilities"
              onClick={(event) => {
                event.preventDefault();
                scrollTo("capabilities");
              }}
            >
              产品能力
            </a>
            <a
              href="#workflow"
              onClick={(event) => {
                event.preventDefault();
                scrollTo("workflow");
              }}
            >
              工作流程
            </a>
          </nav>
          <div className="gl-nav__actions">
            <Link className="gl-login" to={user ? "/articles" : "/login"}>
              {user ? "我的稿件" : "登录"}
            </Link>
            <Link className="gl-button gl-button--small" to="/">
              进入工作台
              <ArrowUpRight size={16} />
            </Link>
          </div>
        </div>
      </header>

      <div className="gl-container" id="gl-content" tabIndex={-1}>
        <section className="gl-hero" aria-labelledby="gl-title">
          <div className="gl-hero__main">
            <div className="gl-eyebrow">
              <span className="gl-status-dot" />
              想法与作品之间，有稿流。
            </div>
            <h1 id="gl-title">
              让想法<span className="gl-serif">成稿，</span>
              <br />
              让好内容<span className="gl-gradient-text">流动。</span>
            </h1>
            <div className="gl-hero__actions">
              <Link className="gl-button" to="/">
                开始创作
                <ArrowUpRight size={19} />
              </Link>
              <button
                className="gl-text-button"
                type="button"
                onClick={() => scrollTo("experience")}
              >
                看看创作过程
                <ArrowDown size={16} />
              </button>
            </div>
          </div>
          <div className="gl-hero__aside">
            <span className="gl-orbit-mark" aria-hidden="true">
              ✳
            </span>
            <p>
              从一闪而过的灵感，
              <br />
              到值得分享的好文章。
            </p>
            <p className="gl-muted">
              研究、写作、审阅、配图与发布，
              <br className="gl-desktop-break" />
              在一个连贯的创作空间里完成。
            </p>
            <div className="gl-hero__note">
              <Workflow size={15} />
              <span>AI 协作，让创作顺势而行</span>
            </div>
          </div>
        </section>

        <section
          className="gl-experience"
          id="experience"
          aria-label="交互式创作流程预览"
        >
          <FlowBackdrop active={motionEnabled} />
          <div className="gl-stage-top">
            <span>
              <span className="gl-status-dot" />
              THE CREATIVE FLOW
            </span>
            <button
              type="button"
              className="gl-motion"
              disabled={reducedMotion}
              onClick={() => setPaused((value) => !value)}
              aria-label={
                reducedMotion
                  ? "已跟随系统减少动态效果"
                  : paused
                    ? "开启动效"
                    : "暂停动效"
              }
              aria-pressed={paused || reducedMotion}
            >
              {motionEnabled ? <Pause size={13} /> : <Play size={13} />}
              <span>
                {reducedMotion ? "静态模式" : paused ? "开启动效" : "暂停动效"}
              </span>
            </button>
          </div>
          <div className="gl-stage-layout">
            <div className="gl-preview">
              <div className="gl-preview__bar">
                <div className="gl-window-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
                <span>一篇好文章的诞生</span>
                <span className="gl-preview__badge">流程预览</span>
              </div>
              <div className="gl-preview__body">
                <div className="gl-preview__heading">
                  <span className="gl-file-icon">
                    <FileText size={19} />
                  </span>
                  <div>
                    <small>创作示例 / 内容工作方式</small>
                    <h2>把灵感，写成下一篇好内容。</h2>
                  </div>
                </div>
                <div
                  className="gl-preview__content"
                  key={step}
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {step === 0 && (
                    <>
                      <div className="gl-section-label">01 / 研究与规划</div>
                      <p className="gl-document-intro">
                        好的表达，始于对主题的理解。先把资料和想法放在一起，再找到文章的主线。
                      </p>
                      <div className="gl-research-grid">
                        <div>
                          <Search size={17} />
                          <strong>明确主题</strong>
                          <span>AI 如何融入日常内容创作</span>
                        </div>
                        <div>
                          <BookOpen size={17} />
                          <strong>整理资料</strong>
                          <span>参考文件 · 知识库 · 素材</span>
                        </div>
                      </div>
                      <div className="gl-outline">
                        <span>文章结构</span>
                        <p>
                          <i>01</i>从一个值得表达的想法出发
                        </p>
                        <p>
                          <i>02</i>让资料与观点形成连接
                        </p>
                        <p>
                          <i>03</i>在协作中找到自己的表达
                        </p>
                      </div>
                    </>
                  )}
                  {step === 1 && (
                    <>
                      <div className="gl-section-label">02 / 正文创作</div>
                      <p className="gl-document-intro">
                        创作的起点，往往只是一个还没想清楚的念头。
                      </p>
                      <p className="gl-document-paragraph">
                        它可能藏在一段阅读笔记里，也可能来自一次随手记录。当资料有了结构，当观点找到线索，零散的想法就开始成为文章。
                      </p>
                      <blockquote>
                        让工具接住繁琐的过程，
                        <br />
                        把注意力留给真正想说的话。
                      </blockquote>
                      <p className="gl-document-paragraph">
                        从大纲到正文，再到语气与节奏，每一步都可以继续调整，直到内容呈现出你想要的样子。
                      </p>
                      <div className="gl-inline-note">
                        <PenLine size={14} />
                        示例正文 · 内容可在工作台继续编辑
                      </div>
                    </>
                  )}
                  {step === 2 && (
                    <>
                      <div className="gl-section-label">03 / 审阅与打磨</div>
                      <p className="gl-document-intro">
                        回看文章的结构、表达和风险，让每一轮修改都有清晰的方向。
                      </p>
                      <div className="gl-review-items">
                        {["结构与表达", "内容与风险", "版本与修改"].map(
                          (label, index) => (
                            <div key={label}>
                              <span>
                                <Check size={14} />
                              </span>
                              <div>
                                <strong>{label}</strong>
                                <p>
                                  {
                                    [
                                      "检查段落衔接，打磨阅读节奏",
                                      "结合审阅报告，逐项确认内容",
                                      "保留修改记录，随时对比与回退",
                                    ][index]
                                  }
                                </p>
                              </div>
                              <ArrowUpRight size={14} />
                            </div>
                          ),
                        )}
                      </div>
                      <div className="gl-inline-note">
                        <ShieldCheck size={14} />
                        审阅能力示意 · 实际报告在创作后生成
                      </div>
                    </>
                  )}
                  {step === 3 && (
                    <>
                      <div className="gl-section-label">04 / 视觉表达</div>
                      <div className="gl-cover">
                        <div className="gl-cover__lines" />
                        <span>THE ART OF FINDING YOUR FLOW</span>
                        <strong>
                          灵感有形。
                          <br />
                          好内容，自有回响。
                        </strong>
                        <small>稿流 / GAOLIU</small>
                      </div>
                      <div className="gl-image-caption">
                        <span>
                          <ImageIcon size={14} />
                          图文编排示例
                        </span>
                        <span>素材匹配 / 创作配图</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div className="gl-preview__footer">
                <span>
                  <span className="gl-status-dot" />
                  {current.title} · {current.tags[0]}
                </span>
                <span>
                  由你的想法驱动
                  <Sparkles size={13} />
                </span>
              </div>
            </div>
            <div className="gl-controls">
              <span className="gl-controls__eyebrow">
                从灵感开始，随思路推进
              </span>
              <h2>
                好内容，
                <br />
                一步步发生。
              </h2>
              <div
                className="gl-step-buttons"
                role="group"
                aria-label="选择预览阶段"
              >
                {STEPS.map(({ title, icon: Icon }, index) => (
                  <button
                    type="button"
                    key={title}
                    onClick={() => setStep(index)}
                    aria-pressed={step === index}
                    className={step === index ? "is-active" : ""}
                  >
                    <Icon size={17} />
                    <span>{title}</span>
                    <span className="gl-step-number" aria-hidden="true">
                      0{index + 1}
                    </span>
                  </button>
                ))}
              </div>
              <div className="gl-step-description">
                <strong>{current.label}</strong>
                <p>{current.detail}</p>
              </div>
              <Link to="/" className="gl-stage-link">
                打开创作工作台
                <ArrowRight size={16} />
              </Link>
            </div>
          </div>
          <div className="gl-stage-bottom">
            <span>从零散灵感，到完整表达。</span>
            <span>
              YOUR IDEAS. IN FLOW.
              <MoveUpRight size={14} />
            </span>
          </div>
        </section>

        <div className="gl-feature-strip" aria-label="创作能力">
          <span>为完整的创作过程而设计</span>
          <div>
            {["资料理解", "长文写作", "多维审阅", "智能配图", "发布管理"].map(
              (label) => (
                <span key={label}>
                  <Check size={13} />
                  {label}
                </span>
              ),
            )}
          </div>
        </div>

        <section
          className="gl-capabilities"
          id="capabilities"
          aria-labelledby="gl-capabilities-title"
        >
          <div className="gl-section-heading">
            <div>
              <p className="gl-eyebrow">MORE ROOM FOR YOUR IDEAS</p>
              <h2 id="gl-capabilities-title">把精力，留给表达本身。</h2>
            </div>
            <p>
              把创作中来回切换的环节，
              <br />
              放进同一个顺手的工作空间。
            </p>
          </div>
          <div className="gl-card-grid">
            {CAPABILITIES.map(
              ({ icon: Icon, title, text, path, link, kind }) => (
                <article
                  className="gl-capability"
                  key={kind}
                  onPointerMove={spotlight}
                >
                  <div
                    className={`gl-mini-art gl-mini-art--${kind}`}
                    aria-hidden="true"
                  >
                    {kind === "sources" && (
                      <>
                        <div className="gl-source-paper gl-source-paper--back">
                          <FileText size={18} />
                          <i />
                          <i />
                          <i />
                        </div>
                        <div className="gl-source-paper">
                          <span>参考资料</span>
                          <i />
                          <i />
                          <i />
                          <b>
                            <Search size={12} />
                            找到思路线索
                          </b>
                        </div>
                        <span className="gl-art-orb">
                          <Sparkles size={20} />
                        </span>
                      </>
                    )}
                    {kind === "templates" && (
                      <>
                        <div className="gl-type-row">
                          <span>Aa</span>
                          <small>你的语气，你的风格。</small>
                        </div>
                        <div className="gl-template-tags">
                          <span>深度解读</span>
                          <span>品牌故事</span>
                          <span>产品介绍</span>
                        </div>
                        <div className="gl-type-line">
                          <i />
                          <i />
                          <i />
                        </div>
                      </>
                    )}
                    {kind === "images" && (
                      <>
                        <div className="gl-art-frame gl-art-frame--back" />
                        <div className="gl-art-frame">
                          <span />
                          <ImageIcon size={21} />
                        </div>
                        <span className="gl-art-label">
                          <Sparkles size={12} />
                          让灵感有画面
                        </span>
                      </>
                    )}
                  </div>
                  <div className="gl-capability__copy">
                    <Icon size={20} />
                    <h3>{title}</h3>
                    <p>{text}</p>
                    <Link to={path}>
                      {link}
                      <ArrowUpRight size={16} />
                    </Link>
                  </div>
                </article>
              ),
            )}
          </div>
        </section>

        <section
          className="gl-workflow"
          id="workflow"
          aria-labelledby="gl-workflow-title"
        >
          <div className="gl-workflow__intro">
            <p className="gl-eyebrow">ONE CONNECTED WORKSPACE</p>
            <h2 id="gl-workflow-title">
              从第一句想法，
              <br />
              到最后一次确认。
            </h2>
            <p>
              你掌握方向，稿流协助推进。
              <br />
              每个环节，都留有你的判断与选择。
            </p>
            <Link className="gl-text-button" to="/articles">
              看看稿件空间
              <ArrowUpRight size={16} />
            </Link>
          </div>
          <ol className="gl-workflow__steps">
            {[
              [
                "把想法带进来",
                "输入主题、参考资料与表达要求，确定这一次想说什么。",
              ],
              [
                "和 AI 一起成稿",
                "从研究规划到正文配图，在工作台里跟进创作过程。",
              ],
              [
                "打磨，直到满意",
                "结合审阅报告继续优化，查看历史版本，保留每一次选择。",
              ],
              [
                "让好内容被看见",
                "确认最终稿件，管理发布计划，通过同步助手连接目标平台。",
              ],
            ].map(([title, text], index) => (
              <li
                key={title}
                style={
                  {
                    "--step-color": [
                      "#b4a1ff",
                      "#8facff",
                      "#f3bca1",
                      "#b2dfd1",
                    ][index],
                  } as CSSProperties
                }
              >
                <span className="gl-workflow__number">0{index + 1}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
                <ChevronRight size={17} />
              </li>
            ))}
          </ol>
        </section>

        <section className="gl-final-cta">
          <div className="gl-cta-orbit" aria-hidden="true" />
          <span className="gl-eyebrow">MAKE SOMETHING WORTH SHARING</span>
          <h2>
            下一篇好内容，
            <br />
            从你的想法开始。
          </h2>
          <Link className="gl-button" to="/">
            进入稿流，开始创作
            <ArrowUpRight size={18} />
          </Link>
          <p>让灵感有所落点，让表达持续发生。</p>
        </section>
        <footer className="gl-footer">
          <a className="gl-brand" href="#gl-content">
            <img src="/gaoliu-mark.svg" alt="" />
            <strong>
              稿流<span>GAOLIU</span>
            </strong>
          </a>
          <span>让想法成稿，让好内容流动。</span>
          <Link to="/">
            创作工作台
            <ArrowUpRight size={14} />
          </Link>
        </footer>
      </div>
    </main>
  );
}
