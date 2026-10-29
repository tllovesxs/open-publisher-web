import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Menu, Plus } from "lucide-react";
import { api } from "./api/client";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ActiveRunProvider } from "./lib/activeRunContext";
import { PageBoundary, PageLoading } from "./components/PageBoundary";
import { AvatarMenu } from "./components/AvatarMenu";
import { useThemeSetting } from "./lib/theme";
import { VisualPlanProvider } from "./components/article/VisualPlanProvider";
import { AppNavigation, type NavKey } from "./components/AppNavigation";
import "./blueprint.css";

const LoginPage = lazy(() => import("./pages/LoginPage"));
const LandingPage = lazy(() => import("./pages/LandingPage"));
const ArticlesPage = lazy(() => import("./pages/ArticlesPage"));
const CreatePage = lazy(() => import("./pages/CreatePage"));
const AnnouncementsPage = lazy(() => import("./pages/AnnouncementsPage"));
const TemplatesPage = lazy(() => import("./pages/TemplatesPage"));
const MediaPage = lazy(() => import("./pages/MediaPage"));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage"));
const PublishQueuePage = lazy(() => import("./pages/PublishQueuePage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const RevisionsPage = lazy(() => import("./pages/RevisionsPage"));
const RunPage = lazy(() => import("./pages/RunPage"));

// 外壳布局迁移自蓝本 App.tsx 的 app-shell / app-workspace 结构（团队自有代码）。
// 2026-10-16：导航/品牌/首页按蓝本 1:1 迁移；旧工作台保留在 /projects（未入导航）。

function isCreatePathname(): boolean {
  return ["/", "/runs/", "/projects/", "/announcements"].some((prefix) =>
    prefix === "/" ? window.location.pathname === "/" : window.location.pathname.startsWith(prefix),
  );
}

function Shell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [nav, setNav] = useState<NavKey>(isCreatePathname() ? "create" : "settings");
  const { resolved: theme, setSetting: setThemeSetting } = useThemeSetting();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [backendReady, setBackendReady] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    if (location.pathname.startsWith("/articles")) setNav("articles");
    else if (location.pathname.startsWith("/announcements")) setNav("announcements");
    else if (location.pathname.startsWith("/templates")) setNav("templates");
    else if (location.pathname.startsWith("/media")) setNav("media");
    else if (location.pathname.startsWith("/publish-queue")) setNav("publish");
    else if (location.pathname.startsWith("/settings")) setNav("settings");
    else if (isCreatePathname()) setNav("create");
  }, [location.pathname]);

  useEffect(() => {
    api
      .get("/health")
      .then(() => setBackendReady(true))
      .catch(() => setBackendReady(false));
  }, []);

  const handleNavigate = useCallback(
    (next: NavKey) => {
      if (!user && next !== "create") {
        navigate("/login");
        return;
      }
      setNav(next);
      setMobileNavOpen(false);
      if (next === "create") navigate("/");
      if (next === "articles") navigate("/articles");
      if (next === "announcements") navigate("/announcements");
      if (next === "templates") navigate("/templates");
      if (next === "media") navigate("/media");
      if (next === "publish") navigate("/publish-queue");
      if (next === "settings") navigate("/settings");
    },
    [user, navigate],
  );

  const title =
    nav === "create"
      ? "创作"
      : nav === "articles"
        ? "文章"
        : nav === "announcements"
          ? "公告"
          : nav === "templates"
            ? "模板"
            : nav === "media"
              ? "素材库"
              : nav === "publish"
                ? "发布"
                : "设置";

  return (
    <div className="app-shell">
      <AppNavigation
        active={nav}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
        onNavigate={handleNavigate}
        onToggleTheme={() => setThemeSetting(theme === "light" ? "dark" : "light")}
        runtimeLabel="AI 写作 · 智能配图 · 多平台草稿"
        runtimeReady={backendReady}
        theme={theme}
      />

      <div className="app-workspace">
        <header className="workspace-topbar">
          <button
            aria-label="打开导航"
            className="icon-button workspace-topbar__menu"
            onClick={() => setMobileNavOpen(true)}
            type="button"
          >
            <Menu size={19} />
          </button>
          <strong>{title}</strong>
          <span className="workspace-topbar__spacer" />
          {nav !== "create" && (
            <button
              className="button button--quiet workspace-new"
              onClick={() => navigate("/articles?new=1")}
              type="button"
            >
              <Plus size={15} />
              新文章
            </button>
          )}
          <AvatarMenu />
        </header>

        <main
          className="page-viewport"
          id="main-content">
          <PageBoundary><Suspense fallback={<PageLoading />}><Routes>
            <Route path="/" element={<CreatePage />} />
            <Route path="/announcements" element={<AnnouncementsPage />} />
            <Route path="/runs/:runId" element={<RunPage />} />
            <Route path="/articles" element={<ArticlesPage />} />
            <Route path="/templates" element={<TemplatesPage />} />
            <Route path="/media" element={<MediaPage />} />
            <Route path="/publish-queue" element={<PublishQueuePage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:projectId/revisions" element={<RevisionsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes></Suspense></PageBoundary>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ActiveRunProvider>
          <VisualPlanProvider>
            <PageBoundary resetOnNavigation={false}><Suspense fallback={<PageLoading />}><Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/landing" element={<LandingPage />} />
              <Route path="/*" element={<Shell />} />
            </Routes></Suspense></PageBoundary>
          </VisualPlanProvider>
        </ActiveRunProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
