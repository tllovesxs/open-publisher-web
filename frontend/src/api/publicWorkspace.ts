// Public examples and guest edits share the normal workbench contracts.
// Guest writes stay in this browser; private backend routes remain protected.
import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";

type Row = Record<string, any>;
type Kind = "articles" | "templates" | "media";
const cache = new Map<Kind, Promise<Row[]>>();
export const isExample = (id: string) => id.startsWith("example-");
const key = (kind: string) => `opw:local-workspace:${localStorage.getItem("opw_user_id") || "guest"}:${kind}`;
function read(kind: string): Row[] {
  try { return JSON.parse(localStorage.getItem(key(kind)) || "[]"); } catch { return []; }
}
function write(kind: string, rows: Row[]) { localStorage.setItem(key(kind), JSON.stringify(rows)); }
export function localMediaSource(id: string): string | null {
  if (id === "example-writing-workflow") return "/examples-writing.svg";
  return read("media").find(row => row.id === id)?.source || null;
}

export async function examples(kind: Kind): Promise<Row[]> {
  if (!cache.has(kind)) cache.set(kind, fetch(`/api/examples/${kind}`, { credentials: "omit" }).then(async res => {
    if (!res.ok) throw new Error("无法加载示例");
    const { items } = await res.json();
    return items.map((item: Row) => kind === "articles" ? {
      articleId: item.id, title: item.title, markdown: item.markdown,
      currentRevisionId: null, contentHash: null, updatedAt: null,
    } : kind === "templates" ? {
      ...item, name: item.title, category: "示例", isBuiltIn: true, mode: "scaffold",
      usageInstructions: item.description, variables: [], fixedBlocks: [],
      styleProfile: {}, structureProfile: {}, layoutProfile: {},
    } : {
      ...item, name: item.title, visualDescription: item.description, usageHint: "公共示例素材",
      generationPrompt: "", tags: ["示例"], mime: "image/svg+xml", origin: "upload", createdAt: "2026-10-30T00:00:00Z",
    });
  }).catch(error => { cache.delete(kind); throw error; }));
  return structuredClone(await cache.get(kind)!);
}

export async function localRows(kind: Kind): Promise<Row[]> {
  const saved = read(kind);
  const ids = new Set(saved.map(row => row.articleId || row.id));
  return [...saved, ...(await examples(kind)).filter(row => !ids.has(row.articleId || row.id))];
}

export const localAdapter: AxiosAdapter = async config => {
  const url = new URL(config.url || "", window.location.origin);
  const parts = url.pathname.replace(/^\/api/, "").split("/").filter(Boolean);
  const [kind, id, action, revisionId, restore] = parts;
  const method = config.method || "get";
  const body: Row = typeof config.data === "string" ? JSON.parse(config.data || "{}") : config.data || {};
  let data: any;
  if (["articles", "templates", "media"].includes(kind)) {
    const collection = kind as Kind;
    const rows = await localRows(collection);
    const row = rows.find(row => (row.articleId || row.id) === id);
    if (method === "get") {
      if (action === "revisions") {
        const revisions = read(`revisions:${id}`);
        data = revisionId ? revisions.find(r => r.revisionId === revisionId) : { revisions };
      } else if (id) data = row;
      else {
        let filtered = rows;
        if (kind === "media") {
          const search = (url.searchParams.get("search") || "").toLowerCase();
          filtered = filtered.filter(r => (!search || `${r.name} ${r.visualDescription} ${r.usageHint}`.toLowerCase().includes(search)) && (!url.searchParams.get("origin") || r.origin === url.searchParams.get("origin")));
          const sort = url.searchParams.get("sort") || "created_desc";
          filtered.sort((a, b) => sort.startsWith("name") ? String(a.name).localeCompare(String(b.name)) * (sort.endsWith("desc") ? -1 : 1) : String(a.createdAt).localeCompare(String(b.createdAt)) * (sort.endsWith("desc") ? -1 : 1));
        }
        data = { [kind === "media" ? "assets" : kind]: filtered };
      }
    } else if (method === "delete") {
      if (isExample(id || "")) throw new Error("公共示例不可删除");
      write(kind, read(kind).filter(r => (r.articleId || r.id) !== id));
      data = {};
    } else {
      if (kind === "articles") {
        const articleId = body.articleId || id || crypto.randomUUID();
        const previous = rows.find(r => r.articleId === articleId);
        const revision = restore ? read(`revisions:${id}`).find(r => r.revisionId === revisionId) : null;
        data = { ...previous, ...body, ...(revision ? { markdown: revision.markdown, title: revision.title } : {}), articleId,
          currentRevisionId: crypto.randomUUID(), contentHash: crypto.randomUUID(), updatedAt: new Date().toISOString() };
        const revisions = read(`revisions:${articleId}`);
        write(`revisions:${articleId}`, [{ ...data, revisionId: data.currentRevisionId, createdAt: data.updatedAt }, ...revisions]);
      } else {
        if (method === "patch" && isExample(id)) throw new Error("请复制示例后修改");
        data = { ...row, ...body, id: method === "patch" ? id : crypto.randomUUID(), isBuiltIn: false,
          createdAt: row?.createdAt || new Date().toISOString(), source: body.dataUrl || row?.source,
          mode: row?.mode || "scaffold", origin: row?.origin || "upload" };
      }
      write(kind, [data, ...read(kind).filter(r => (r.articleId || r.id) !== (data.articleId || data.id))]);
    }
  } else if (kind === "settings") data = { disabledNodeIds: [], webSearchMode: "off", profileId: null, nodeProfileIds: {} };
  else if (kind === "assistant") {
    data = method === "get" ? { sessions: [] } : { id: `guest-${crypto.randomUUID()}`, messages: [], ...body };
  }
  if (data === undefined) throw new Error("本机资源不存在");
  return { data, status: method === "post" ? 201 : 200, statusText: "OK", headers: {}, config };
};

export function useLocalAdapter(config: InternalAxiosRequestConfig): boolean {
  const path = (config.url || "").split("?")[0];
  const guest = !localStorage.getItem("opw_access_token");
  const exampleRead = config.method === "get" && /^\/(articles|templates|media)\/example-/.test(path);
  const body = typeof config.data === "string" ? JSON.parse(config.data || "{}") : config.data;
  if (exampleRead || (path === "/articles" && isExample(body?.articleId || ""))) return true;
  return guest && (/^\/(articles|templates|media)(\/|$)/.test(path) || /^\/assistant\/sessions(?:\/[^/]+)?$/.test(path) || path === "/settings/preferences");
}
