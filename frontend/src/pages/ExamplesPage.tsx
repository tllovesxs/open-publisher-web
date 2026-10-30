import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { MarkdownPreview } from "../components/article/MarkdownPreview";
import "./ExamplesPage.css";

type Kind = "articles" | "templates" | "media";
interface Example { id: string; title: string; description: string; markdown?: string; source?: string; alt?: string }
const labels = { articles: "示例文章", templates: "示例模板", media: "示例素材" };

export default function ExamplesPage({ kind }: { kind: Kind }) {
  const [items, setItems] = useState<Example[]>([]);
  const [status, setStatus] = useState("正在加载示例……");
  useEffect(() => {
    let active = true;
    setItems([]);
    setStatus("正在加载示例……");
    api.get<{ items: Example[] }>(`/examples/${kind}`).then(({ data }) => {
      if (active) { setItems(data.items); setStatus(data.items.length ? "" : "暂无示例。"); }
    }).catch(() => { if (active) setStatus("示例加载失败，请刷新重试。"); });
    return () => { active = false; };
  }, [kind]);
  return <section className="examples-page" aria-label={labels[kind]}>
    <header><h1>{labels[kind]}</h1><p>无需登录即可浏览和复制。登录后可创作并保存自己的内容。</p><Link to="/login">登录工作台</Link></header>
    {status && <p role="status">{status}</p>}
    {items.map(item => <article className="examples-card" key={item.id}>
      <h2>{item.title}</h2><p>{item.description}</p>
      {item.source && <img src={item.source} alt={item.alt || item.title} />}
      {item.markdown && <><MarkdownPreview markdown={item.markdown} /><details><summary>查看 Markdown 源文</summary><textarea aria-label={`${item.title} Markdown`} readOnly value={item.markdown} rows={10} /></details></>}
    </article>)}
  </section>;
}
