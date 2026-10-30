# Open Publisher Web

面向产品推广与内容运营的 **AI 推文创作及发布工作台**（比赛项目，团队自研）。推文包括平台推广图文，界面以“文章”管理稿件和版本，不限定为 Twitter/X 短文本。

比赛材料见 [评审材料索引](docs/submission/README.md)：技术方案、评分证据、评委指南、演示脚本、截图、验证记录及 [技术文档 PDF](output/pdf/技术文档.pdf)。

把团队蓝本 open-publisher 的完整稿流整体迁移到 Web：文章创作（流式生成）、版本管理、AI 编辑助手、素材库与智能配图、模板库、发布 Outbox 与多用户数据归属，全部作为一等能力实现。

## 功能总览

- **文章创作**：填写创作要求后走创作 run（SSE 实时回显），可随时打断、失败保留上下文重试
- **文章工作台**：Markdown 编辑 / 分栏 / 预览三种视图，平台预览适配
- **AI 编辑助手**：选中改写、一键优化、快照撤销，所有 AI 写回可打断
- **配图中心**：
  - 配图栏自动识别正文图片与创作生成的 mermaid 图表（实时缩略图）
  - 上传素材 → 输入行号精确插入到正文对应行（不依赖光标）
  - 已插入配图 / AI 生成图表支持「编辑」菜单：删除 / 移动位置
  - AI 配图方案：自动匹配素材库图片，未命中位置调用生图模型生成并按锚点插入
- **版本管理**：每次保存生成新修订，可查看历史与一键恢复
- **素材库**：上传 / AI 生成图片，站内 `asset://` 引用
- **模板库 / 发布**：发布计划审批绑定、Outbox 幂等入队、dry-run 与远端核验
- **多用户**：注册登录（JWT），文章 / 项目 / 素材按用户隔离
- **管理后台**：独立 admin 前端，管理模型配置与公告

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Python · FastAPI · SQLAlchemy 2.x · Pydantic v2 |
| 数据库 | MySQL 8（Alembic 迁移） |
| 缓存 / 队列 | Redis 7 |
| AI 工作流 | WriterService + RunJournal（SSE / Function Calling / 结构化检查）；另有 LangGraph 推文候选链路 |
| 前端 | React 18 · TypeScript · Vite |
| 管理后台 | React + Vite（独立容器） |
| 部署 | Docker Compose |

## 项目结构

```
open-publisher-web/
├── backend/         # FastAPI 后端（API / ORM / Alembic 迁移 / 服务层）
├── frontend/        # React + Vite 用户端（创作 / 工作台 / 发布）
├── frontend-admin/  # 管理后台前端
└── docker-compose.yml
```

## 快速开始（Docker Compose）

```bash
cp .env.example .env   # 配置数据库密码、管理员账号和 SECRET_ENCRYPTION_KEY
docker compose up -d --build
```

启动后：

- 用户端前端：http://localhost:5173
- 管理后台：http://localhost:5174
- 后端 API：http://localhost:8000/api
- API 文档：http://localhost:8000/docs
- 健康检查：http://localhost:8000/api/health

首次启动自动执行数据库迁移（`alembic upgrade head`），并按 `AUTH_ADMIN_USERNAME` / `AUTH_ADMIN_PASSWORD` 初始化管理员账号。

模型与集成 API Key 在管理后台录入，密文保存于数据库；无需填写 API Key 环境变量。

正文生成总时限由 `WRITER_GENERATION_TIMEOUT_SECONDS` 控制，默认 900 秒（可在 `.env` 配置）。
管理端模型的读取超时用于检测接口流停滞，与正文总时限分别计算；流式思考阶段显示进度，正文增量按批写入。

> 对外部署设 `APP_ENV=production`：JWT 至少 32 字符，管理员密码至少 12 字符，拒绝已知占位前缀，Fernet 主密钥必须有效，否则拒绝启动。开发默认占位符不可用于公网；数据库和 Redis 端口须限制访问。详见 [部署清单](docs/submission/部署与提交清单.md)。

### Mock LLM 模式（无真实 API Key）

没有配置真实模型 Key 时，可用内置 Mock 服务器跑通完整链路（演示 / E2E）：

```bash
docker compose -f docker-compose.yml -f docker-compose.mock.yml up -d --build
```

Mock 服务器监听 http://localhost:8001，按节点返回脚本化响应，
支持固定响应、SSE 和 `write_article` 工具调用。在隔离演示环境的管理端新增模型档案，地址 `http://mock-llm:8001/v1`、模型 `mock`，录入无价值 Key `mock-local-only` 并启用 tools；不要更改日常环境的真实默认档案。Mock 使用固定响应，适合演示接口与交互流程。详见 [评委指南](docs/submission/评委操作指南.md)。

## 本地开发（不用 Docker）

### 后端

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
cp ../.env.example .env    # 填写数据库与管理员配置
alembic upgrade head
uvicorn app.main:app --reload
```

### 前端

```bash
cd frontend
npm install
npm run dev
```

开发模式下 Vite 会把 `/api` 代理到 http://localhost:8000（可用 `VITE_PROXY_TARGET` 覆盖）。

## 秘密管理（企业级约定）

- **LLM / 生图 / 集成 API Key：只密文入库**（2026-10-27 起）。管理端录入密钥，后端用 Fernet 信封加密后存入 `app_secrets` 表，主密钥通过 `SECRET_ENCRYPTION_KEY` 环境变量注入；不再读取 `LLM_API_KEY` / `IMAGE_API_KEY` 等环境变量。解析优先级：档案级 DB 密文 > 全局 LLM DB 密文。变更写入 `app_secret_audit` 审计表。
- **主密钥**：`SECRET_ENCRYPTION_KEY`（Fernet key）只放 `.env` / 宿主环境变量，必须显式配置；未配置时后端拒绝加密/解密，不提供开发回退。存量环境可先用 `backend/scripts/migrate_env_keys_to_db.py` 一次性迁移，再移除明文 Key 环境变量。
- 存量迁移：`backend/scripts/migrate_env_keys_to_db.py`（先干跑，确认后加 `--execute`）。
- 其余秘密（数据库密码、JWT 密钥、管理员密码）仍通过 `.env` / 环境变量注入，参考 `.env.example` 占位模板；`.env` 已被 `.gitignore` 排除。
- 密钥明文永不进入仓库、不回显浏览器、不写日志；管理端只见掩码尾号（keyHint）。

## 质量验证

### 公共示例资源

文章、模板、素材库在登录前后使用相同的列表与工作台，均可看到一篇示例文章、一篇实用指南模板、一张原创 SVG 素材。登录后示例与个人内容一起显示。
未登录时普通编辑、模板另存与图片上传保存于当前浏览器，不会写入私人后端资源；本机数据不会自动迁入账号。公共示例文件保持只读，登录后文章修改保存为个人副本。
仅点击设置或执行生成、改写、提取、图片分析等 AI 操作时要求登录；登录弹窗可取消或按 Escape 关闭，取消保留原页面与当前输入。登录成功不会自动执行或收费，需再次点击操作按钮。
旧 `/examples/articles`、`/examples/templates`、`/examples/media` 地址分别跳转对应工作台。
示例接口为 `GET /api/examples/{articles|templates|media}`，仅读取版本化静态文件，不查询私人资料、不调用模型、不支持写入。
匿名浏览验收脚本为 `frontend/scripts/smoke-public-examples.cjs`，使用真实本地接口验证桌面与手机视图、图片加载和私人接口隔离。
`frontend/scripts/smoke-workspace-login.cjs` 验证本机保存、取消保留草稿、登录后仍显示示例和零付费请求。

测试结果与首屏测量见 [验证记录](docs/submission/验证记录.md)。

### 回归命令

后端在 `backend/` 执行 `python -m pytest tests -q -p no:cacheprovider`。用户端在
`frontend/` 执行 `npm run typecheck` 或 `npm run build`（构建已包含类型检查）；
管理端在 `frontend-admin/` 执行 `npm run build`。GitHub Actions 会运行后端测试与双前端构建。

浏览器冒烟脚本为 `frontend/scripts/smoke-ui.cjs`：先启动 Vite，再设置
`PLAYWRIGHT_MODULE` 为已安装的 Playwright 模块路径，按需设置 `SMOKE_BROWSER_PATH`
和 `SMOKE_BASE_URL`（默认 `http://127.0.0.1:5183`），执行 `node scripts/smoke-ui.cjs`。
该检查使用隔离浏览器和模拟 API，验证页面加载、编辑器、大图读取及资料限制。

RAG 接口的 `global` 表示当前用户的个人资料库，项目索引同时检查项目归属。JSON 索引使用进程内写入互斥与原子文件替换，部署采用单写入进程。同步前预检绑定当前修订与正文哈希，高风险阻断，中风险与待确认状态要求人工确认，登录确认写入审计。

## 建设成果

- [x] 阶段 1：项目骨架（FastAPI + MySQL + Redis + React + Docker Compose + projects CRUD）
- [x] 阶段 2：多节点创作工作流 + artifact 存储 + SSE 实时进度
- [x] 阶段 3：前端工作台（创作 / 工作流可视化 / 编辑器 / 版本历史 / AI 优化）
- [x] 阶段 4：文章库、配图中心、模板库、发布队列、管理后台、多用户隔离
- [x] 阶段 5：技术方案、PDF、评分证据、评委指南、演示脚本、截图和验证记录



### Web 版文章同步发布

在文章页点击“同步发布”，通过当前浏览器安装的文章同步助手（WechatSync 2.0.9 网页接口）读取已登录平台、选择目标并同步到草稿箱。安装插件后需允许访问本站并刷新页面；无需配置桌面版 CLI / MCP Token。平台最终发布由用户在草稿箱中确认。

独立模拟发布队列已从 Web 界面移除，旧 `/publish-queue` 地址跳转文章页。历史后端发布记录与接口保留，不参与插件直连同步。插件提供同步记录，也可在纯净预览右键“同步助手 - 提取并编辑文章”独立操作。私人素材在浏览器读取后转为图片数据传给插件，不传递网站登录令牌；读取失败会阻止提交。
