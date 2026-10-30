import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowRight, ArrowUpRight, Pause, Play } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import MetallicPaint from "../components/MetallicPaint/MetallicPaint";
import exampleArticle from "../../../backend/app/data/example-article.v1.md?raw";
import "./landing/landing.css";

const STAGES = ["研究", "写作", "审阅", "配图"];
const TITLES = ["让资料先有一条主线", "把大纲展开成正文", "让修改有具体的理由", "让图和文字一起说明问题"];
const ARTICLE = "把零散想法变成一篇清晰的文章";
const ORIGINAL = "写作的第一步不是动笔，而是“倾倒”。把脑海中所有相关的想法都写下来，不必讲究顺序，也不必追求措辞，哪怕只是一个词、半句话，都可以先记录在纸上或文档里。";
const REVISED = "先把脑海中与主题相关的想法记下来。一个词、半句话都可以，暂时不用排序，也不用打磨措辞。";

function openFullExample() {
  const example = document.getElementById("gl-full-example") as HTMLDetailsElement | null;
  if (example) example.open = true;
}

function FullExample() {
  return <details className="gl-full-example" id="gl-full-example"><summary>完整示例原文</summary><div>{exampleArticle.trim().split(/\r?\n\s*\r?\n/).map((block, index) => {
    if (block.startsWith("# ")) return <h3 key={index}>{block.slice(2)}</h3>;
    if (block.startsWith("## ")) return <h4 key={index}>{block.slice(3)}</h4>;
    if (/^\d+\./.test(block)) return <ol key={index}>{block.split(/\r?\n/).map(line => <li key={line}>{line.replace(/^\d+\.\s*/, "").replace(/\*\*/g, "")}</li>)}</ol>;
    return <p key={index}>{block}</p>;
  })}</div></details>;
}

function StructureImage({ compact = false }: { compact?: boolean }) {
  return <picture><source media={compact ? "(max-width: 1100px)" : "(max-width: 640px)"} srcSet="/landing-writing-structure-mobile.svg" /><img src="/landing-writing-structure.svg" width="960" height="360" alt="搭建文章结构：确定核心观点，安排内容顺序，补充过渡衔接。" /></picture>;
}

function Brand({ still }: { still: boolean }) {
  return <a className="gl-brand" href="#gl-content" aria-label="稿流首页">
    <img src="/gaoliu-mark.svg" width="36" height="36" alt="" />
    <MetallicPaint text="稿流" dpr={2} className="gl-wordmark" fontFamily="Microsoft YaHei, PingFang SC, sans-serif" fontWeight={800} color="#eee7ff" density={2.1} softness={0.18} dispersion={0.12} distortion={0.05} edgeBend={0.7} speed={0.45} scale={1.1} mouseTilt={0.25} intro={false} paused={still} />
  </a>;
}

function StageOutput({ stage }: { stage: number }) {
  if (stage === 0) return <>
    <h3>从资料里提取文章结构</h3>
    <div className="gl-source"><span className="gl-meta">资料摘录 · 项目公共示例文章</span><p>“留下真正有用的素材，舍弃那些看似精彩却偏离主线的内容。”</p><a href="#gl-full-example" onClick={openFullExample}>来源：《{ARTICLE}》 <ArrowDown size={14} /></a></div>
    <p className="gl-summary"><strong>整理摘要</strong>先筛选与主题相关的素材，再用核心观点串联段落。</p>
    <h4>由此展开的大纲</h4>
    <ol className="gl-outline"><li>先收集，再筛选</li><li>搭建结构：观点、顺序、过渡</li><li>反复修改，让文字更清晰</li></ol>
  </>;
  if (stage === 1) return <>
    <h3>先收集，再筛选</h3><p>{ORIGINAL}这个阶段的关键是放开手脚，不做评判。</p>
    <p>收集完毕后，进入筛选环节。问自己三个问题：这个想法与主题有关吗？它能支撑我的核心观点吗？删掉它会影响文章的完整性吗？</p>
    <blockquote>筛选的过程，就是为文章“瘦身”的过程。</blockquote><span className="gl-meta">节选自项目公共示例正文</span>
  </>;
  if (stage === 2) return <>
    <h3>把抽象动作改成可执行的一步</h3><p className="gl-summary"><strong>问题与理由</strong>“倾倒”依赖比喻理解，原句也偏长。先说清动作，再拆开表达，读者更容易照着做。</p>
    <div className="gl-edit gl-edit--before"><span className="gl-meta">修改前 · 原文节选</span><p>写作的第一步不是动笔，而是“倾倒”。把脑海中所有相关的想法都写下来，不必讲究顺序，也不必追求措辞。</p></div>
    <div className="gl-edit"><span className="gl-meta">修改后 · 编辑示例</span><p>{REVISED}</p></div>
  </>;
  return <>
    <h3>搭建结构的三步法</h3><p>用一句话确定核心观点，再安排内容顺序，最后补充过渡衔接。</p>
    <figure className="gl-figure"><StructureImage /><figcaption>图：把素材串成文章的三个步骤。图文编排示例。</figcaption></figure>
    <span className="gl-meta">根据示例文章制作的说明图</span>
  </>;
}

export default function LandingPage() {
  const { user } = useAuth();
  const [stage, setStage] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [motionPaused, setMotionPaused] = useState(false);
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [inView, setInView] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const preview = useRef<HTMLElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const [style, setStyle] = useState(0);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => { setReduced(query.matches); if (query.matches) setPlaying(false); };
    const visibility = () => setVisible(!document.hidden);
    query.addEventListener("change", update);
    document.addEventListener("visibilitychange", visibility);
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: .25 });
    if (preview.current) observer.observe(preview.current);
    return () => { query.removeEventListener("change", update); document.removeEventListener("visibilitychange", visibility); observer.disconnect(); };
  }, []);
  useEffect(() => {
    if (!playing || reduced || !inView || !visible) return;
    const timer = window.setInterval(() => setStage(value => (value + 1) % STAGES.length), 9000);
    return () => window.clearInterval(timer);
  }, [playing, reduced, inView, visible]);
  const select = (index: number) => { setPlaying(false); setStage(index); };
  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % STAGES.length;
    else if (event.key === "ArrowLeft") next = (index + STAGES.length - 1) % STAGES.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = STAGES.length - 1;
    else return;
    event.preventDefault(); select(next); tabs.current[next]?.focus({ preventScroll: true });
  };
  const still = reduced || motionPaused || !visible;
  return <main className={`gl-home${still ? " gl-home--still" : ""}`}>
    <a className="gl-skip" href="#gl-content">跳到主要内容</a>
    <header className="gl-nav"><div className="gl-frame gl-nav__inner">
      <Brand still={still} /><nav aria-label="产品导航"><a href="#experience">创作示例</a><a href="#capabilities">产品能力</a><a href="#faq">常见问题</a></nav>
      <Link className="gl-nav-login" to={user ? "/articles" : "/login"}>{user ? "我的稿件" : "登录"}<ArrowUpRight size={16} /></Link>
    </div></header>
    <div className="gl-frame" id="gl-content" tabIndex={-1}>
      <div className="gl-opening">
        <section className="gl-hero" aria-labelledby="gl-title">
          <h1 id="gl-title">让想法成稿，<br />让好内容流动。</h1>
          <p className="gl-lead">稿流是一个 AI 内容创作工作台，将资料研究、长文写作、审阅、配图与发布管理，放进同一个工作空间。</p>
          <div className="gl-hero__actions"><Link className="gl-button" to="/">开始创作<ArrowUpRight size={19} /></Link><a className="gl-text-link" href="#experience">查看创作示例<ArrowDown size={16} /></a></div>
          <p className="gl-hero-note">带着主题和资料开始，成稿后继续编辑与确认。</p>
        </section>
        <section className="gl-experience" id="experience" ref={preview} aria-labelledby="gl-example-title">
          <div className="gl-demo-heading"><h2 id="gl-example-title">看一篇文章逐步成稿</h2><span className="gl-meta">创作示例</span></div>
          <p className="gl-example-name">{ARTICLE}</p>
          <div className="gl-demo-toolbar"><div className="gl-tabs" role="tablist" aria-label="创作示例阶段">{STAGES.map((title, index) => <button type="button" role="tab" id={`gl-tab-${index}`} aria-controls={`gl-panel-${index}`} aria-selected={index === stage} tabIndex={index === stage ? 0 : -1} ref={el => { tabs.current[index] = el; }} onKeyDown={event => handleTabKey(event, index)} onClick={() => select(index)} key={title}>{title}</button>)}</div>
            <button className="gl-play" type="button" disabled={reduced} onClick={() => setPlaying(value => !value)} aria-label={reduced ? "已跟随系统减少动态效果" : playing ? "暂停示例" : "播放示例"} aria-pressed={playing}>{playing ? <Pause size={15} /> : <Play size={15} />}<span>{reduced ? "静态" : playing ? "暂停" : "播放"}</span></button>
          </div>
          <div className="gl-demo-panels" data-ui="article-output">{STAGES.map((_, index) => <div role="tabpanel" hidden={stage !== index} id={`gl-panel-${index}`} aria-labelledby={`gl-tab-${index}`} tabIndex={0} className="gl-output" key={index}><StageOutput stage={index} /></div>)}</div>
          <div className="gl-demo-foot"><span>{TITLES[stage]}</span><a href="#gl-full-example" onClick={openFullExample}>读完整示例<ArrowDown size={14} /></a></div>
          <p className="gl-demo-disclosure">正文取自项目公共示例；研究、审阅与配图为演示编排。</p>
          <FullExample />
        </section>
      </div>
      <section className="gl-capabilities" id="capabilities" aria-labelledby="gl-capabilities-title">
        <div className="gl-section-heading"><h2 id="gl-capabilities-title">不只得到文字，<br />也看得见内容的来路。</h2><p>资料、表达、图文，围绕同一篇文章继续打磨。<br />以下为能力演示，实际结果取决于输入与模型配置。</p></div>
        <article className="gl-evidence gl-evidence--source">
          <div className="gl-evidence-copy"><h3>让资料进入文章，<br />而不是停在附件里。</h3><p>导入参考文件，结合知识库检索，让有用的资料成为大纲和正文的依据。</p><Link className="gl-text-link" to="/">带着资料开始<ArrowUpRight size={16} /></Link></div>
          <div className="gl-source-proof" data-ui="source-outline"><div><span className="gl-meta">参考摘录 · 公共示例原文</span><p>“用一句话概括你最想表达的意思。这句话就是文章的中心，后续所有内容都要为它服务。”</p><span className="gl-meta">来源：示例文章「搭建结构的三步法」</span></div><ArrowRight className="gl-proof-arrow" size={22} aria-hidden="true" /><div><span className="gl-meta">进入大纲 · 整理示例</span><h4>先确定核心观点</h4><p>先用一句话定下文章主线，再按逻辑安排素材。</p><span className="gl-meta">接续章节：安排顺序 → 补充过渡</span></div></div>
        </article>
        <article className="gl-evidence gl-evidence--style">
          <div className="gl-evidence-copy"><h3>观点不变，<br />换一种合适的表达。</h3><p>用创作模板和表达要求调整语气。看看同一个意思，如何写给不同的读者。</p><Link className="gl-text-link" to="/templates">探索创作模板<ArrowUpRight size={16} /></Link></div>
          <div className="gl-style-proof" data-ui="style-comparison"><div className="gl-style-original"><span className="gl-meta">同一段原文</span><p>“写作的第一步不是动笔，而是‘倾倒’。把脑海中所有相关的想法都写下来……”</p></div><fieldset><legend>切换表达要求，比较改写示例</legend><div className="gl-style-options">{["简明直接", "温和引导"].map((label, index) => <label key={label}><input type="radio" name="writing-style" checked={style === index} onChange={() => setStyle(index)} />{label}</label>)}</div></fieldset><div className="gl-style-result" aria-live="polite"><span className="gl-meta">{style === 0 ? "少用比喻，先说明动作" : "降低动笔压力，像对话一样展开"}</span><p>{style === 0 ? REVISED : "不知道从哪里写起时，不妨先记下想到的内容。一个词、半句话也没关系，等想法都摆在眼前，再慢慢整理。"}</p></div></div>
        </article>
        <article className="gl-evidence gl-evidence--image">
          <div className="gl-evidence-copy"><h3>文字与画面，<br />在同一篇稿件里完成。</h3><p>从素材匹配到生成配图，在文章工作区调整图片位置，让正文、图片和图注相互补充。</p><Link className="gl-text-link" to="/media">打开素材库<ArrowUpRight size={16} /></Link></div>
          <div className="gl-image-proof" data-ui="article-image-layout"><div><span className="gl-meta">图文编排示例</span><h4>搭建结构的三步法</h4><p>确定观点是起点，安排顺序让内容有逻辑，过渡衔接则让读者跟得上思路。</p></div><figure className="gl-figure"><StructureImage compact /><figcaption>图：从一个核心观点，走向连贯的文章。</figcaption></figure></div>
        </article>
      </section>
      <section className="gl-workflow" id="workflow" aria-labelledby="gl-workflow-title"><h2 id="gl-workflow-title">开始，只需要带来一个主题。</h2><ol>{[["输入主题与资料", "在工作台写下读者、目标和表达要求，按需导入参考文件。"], ["发起创作，继续打磨", "登录后开始生成，在文章工作区查看结果、编辑正文、确认配图与审阅建议。"], ["确认成稿，再同步草稿", "需要同步时，连接浏览器扩展及平台账号，检查内容后再提交草稿。"]].map(([title, text]) => <li key={title}><h3>{title}</h3><p>{text}</p></li>)}</ol><Link className="gl-text-link" to="/">进入工作台<ArrowUpRight size={16} /></Link></section>
      <section className="gl-faq" id="faq" aria-labelledby="gl-faq-title"><h2 id="gl-faq-title">开始前，你可能想知道。</h2><div>{[
        ["需要先登录吗？", "可以先浏览首页与公共示例。发起 AI 创作需要登录，并使用已配置的模型服务。"],
        ["如何开始，能带什么资料？", "进入工作台，输入文章主题、读者与表达要求。参考文件支持 Markdown（.md、.markdown）和 TXT，也可以添加图片、选择素材，或在资料面板补充参考内容。"],
        ["成稿可以怎样带走？", "文章工作区提供 Markdown 正文编辑与图文预览。需要带走文字时，可以选择并复制正文。"],
        ["同步发布有什么限制？", "当前同步通道依赖文章同步助手浏览器扩展，以及扩展中已登录的平台账号。只提交平台草稿，需由你到平台确认发布；可用平台以扩展实际返回的账号为准。手机上能否使用取决于浏览器扩展支持。"],
      ].map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}</div></section>
      <section className="gl-close" aria-labelledby="gl-close-title"><div><h2 id="gl-close-title">下一篇，就从你的想法开始。</h2><p>把资料带进来，把判断留给自己。</p></div><Link className="gl-button" to="/">开始创作<ArrowUpRight size={19} /></Link></section>
      <footer className="gl-footer"><Brand still={still} /><span>让想法成稿，让好内容流动。</span><button type="button" className="gl-text-link" disabled={reduced} onClick={() => setMotionPaused(value => !value)}>{reduced ? "已减少动态效果" : motionPaused ? "恢复品牌动效" : "暂停品牌动效"}</button></footer>
    </div>
  </main>;
}
