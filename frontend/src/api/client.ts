import axios from "axios";
import { examples, localAdapter, useLocalAdapter } from "./publicWorkspace";
import { requestLogin } from "../auth/loginPrompt";

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? "/api",
  // 生图 / AI 写作等后端调用可能需要 2 分钟以上；普通请求仍在 interceptor 层按需处理。
  timeout: 180000,
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("opw_access_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  const path = (config.url || "").split("?")[0];
  const paid = config.method !== "get" && (/^\/agent-runs\/(article-create|rewrite-candidate)$/.test(path) || /\/(visual-plan|visual-apply|analyze|generate|preview|chat)$/.test(path) || path === "/templates/extract");
  if (!token && paid) {
    requestLogin();
    throw new axios.CanceledError("登录后可使用 AI 功能");
  }
  if (!paid && useLocalAdapter(config)) config.adapter = localAdapter;
  return config;
});

api.interceptors.response.use(async response => {
  if (response.config.adapter === localAdapter || response.config.method !== "get") return response;
  const path = (response.config.url || "").split("?")[0];
  if (["/articles", "/templates", "/media"].includes(path)) {
    const kind = path.slice(1) as "articles" | "templates" | "media";
    const field = kind === "media" ? "assets" : kind;
    try {
      let items = await examples(kind);
      if (kind === "media") {
        const params = new URL(response.config.url || "", window.location.origin).searchParams;
        const search = (params.get("search") || "").toLowerCase();
        items = items.filter(item => (!search || `${item.name} ${item.visualDescription} ${item.usageHint}`.toLowerCase().includes(search)) && (!params.get("origin") || item.origin === params.get("origin")));
      }
      const rows = response.data[field] || [];
      response.data[field] = [...rows, ...items.filter(item => !rows.some((row: any) => (row.id || row.articleId) === (item.id || item.articleId)))];
    } catch { /* A public example outage must not hide personal resources. */ }
  }
  return response;
});
