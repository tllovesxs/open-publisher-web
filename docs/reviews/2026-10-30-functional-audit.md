# 2026-10-30 全面功能审查

## 结论

本轮已检查当前 Web 主功能、管理端构建、接口鉴权和现有自动化回归。发现并补齐匿名公共示例入口，修复两项失配的后端测试及通用浏览器冒烟脚本。最终后端 **316 项通过**，双前端构建通过，8 个浏览器脚本通过。

这些结果表明已覆盖的本地逻辑与模拟外部服务场景通过，不能据此认定所有外部模型、检索服务和发布平台均已真实验收。没有执行外部平台发布、消息发送或远程推送。

## 功能覆盖与证据

| 功能 | 本轮证据 | 结果及边界 |
|---|---|---|
| 注册、登录、JWT、旧密码迁移、管理员权限、限流 | test_auth、test_rate_limit；smoke-account | 通过；后端认证测试使用隔离数据库，浏览器账号测试模拟接口 |
| 账号资料、取消编辑、保存失败、退出、切换账号 | smoke-account、smoke-account-menu | 普通用户与管理员、1280/900/390px 场景通过 |
| 创作输入、页面导航、文件限制 | smoke-ui、test_graph、test_nodes、test_runner | 通过；含大图转换、超大图拒绝、资料长度上限 |
| 文章生成与流式呈现 | test_writer_pipeline、test_writer_stream、smoke-writer-stream | 通过；覆盖思考阶段、增量正文、失败保留、用户编辑保护及移动端；完整工作流使用模拟模型 |
| 真实文本模型 | 当前数据库配置 GLM-5.3-Flash，单次生成示例文章 | 成功；仅验证一次文本生成，不代表所有已配置模型与工具循环的真实验收 |
| Markdown 编辑、预览、行号映射、版本与恢复、并发冲突 | smoke-ui、test_blueprint_migration、test_revisions_api、test_ownership_isolation | 通过；文章预览沿用 DOMPurify 与严格 Mermaid 渲染 |
| AI 助手与改写 | test_assistant、test_templates_rewrite | 通过；模型替身验证，未额外付费调用 |
| 模板库、新建/编辑/保存/复制/使用、文章提取与文件导入 | test_templates_rewrite、smoke-templates | 通过；含旧链接、滚动定位与窄屏；提取模型使用模拟接口 |
| 素材上传、描述、归属与图片读取 | test_media_settings、test_ownership_isolation、smoke-ui | 通过；公共示例 SVG 在真实浏览器中加载成功 |
| 配图规划、确认/取消、跨导航后台任务、批次与失败重试 | test_visual_pipeline、test_image_blueprint、smoke-visual-plan | 8 个浏览器配图场景通过；真实付费生图未调用 |
| 文本/生图/向量/排序模型配置、独立密钥、个人偏好 | test_model_profiles、test_model_config_catalog、test_customer_models、smoke-settings | 通过；涵盖零/一/多个模型、隐私展示、主题和移动端；没有更改用户原有模型配置 |
| RAG 分块、嵌入、混合检索、排序协议、引用与租户索引 | test_rag_service、test_retrieval_models、test_tenant_isolation | 通过；外部服务由替身验证，未启动 TEI 或额外消耗嵌入额度 |
| 加密秘密存储与审计 | test_secret_store、test_model_config_catalog | 通过；本轮调用密钥在后端解析，没有回显、写入文章或工作日志 |
| 项目、文章、素材、运行的用户归属与旧数据认领 | test_tenant_isolation、test_ownership_isolation、test_admin_ownership | 通过；保留既有 owner=NULL 历史共享语义，未迁移或修改真实用户归属 |
| 发布 Outbox、审批、幂等、微信适配器 | test_publish_api、test_wechat_publisher、test_blueprint_migration | 测试通过；使用模拟外部调用，未发送真实草稿或正式发布 |
| 浏览器同步助手 | 静态检查 SyncPublishDialog 及既有 smoke-sync-publish 脚本 | 当前未找到已安装扩展的 inject-api.js，未运行该脚本；真实平台账号、Cookie、草稿同步尚未验收 |
| 公告/发布教程 | 实际浏览器打开 /announcements | 页面成功渲染、无 JS 异常；不将远端 GitHub 公告索引可用性视为已保证 |
| 管理后台 | npm run build；真实浏览器打开 5174 登录页；后端管理员权限回归 | 通过；未修改真实配置，未逐一操作管理端表单 |
| 匿名公共资源 | test_public_examples、smoke-public-examples | 一篇文章、一篇模板、一张素材可匿名访问；桌面/390px、Markdown 源文、图片加载、无私人接口请求均通过 |
| 运行环境 | Docker Compose 重建 backend/frontend；HTTP 实测 | API、双前端正常，数据库和 Redis 健康；私人文章/模板/素材及匿名生成请求均返回 401 |

## 已解决的问题

1. **匿名示例入口缺失**：原导航将匿名用户送往登录页，私人资源接口全部要求认证。新增独立 `/api/examples/*` 只读静态资源接口及示例页，匿名导航可直接浏览；没有放开私人资源路由，也没有将私人文章改为共享文章。登录用户仍进入原个人工作区，公共示例保留独立 URL。
2. **模型偏好回归断言失配**：偏好接口已增加 imageModelId / embeddingModelId / rerankModelId，旧测试未包括空默认值。更新完整契约断言，保留无效模型拒绝和用户隔离验证。
3. **TEI 排序测试未隔离当前数据库配置**：排序实现已通过配置目录解析权威配置，旧测试只模拟早期偏好入口。补齐 SessionLocal 与 resolve_rag_config 的模拟，继续验证 TEI 列表响应和实际传递的 7 秒超时。
4. **通用 UI 冒烟脚本落后于页面实现**：模板、设置页选择器已变，设置模拟响应缺少模型目录。更新选择器和模拟数据后，所有页面、编辑器与原验证断言通过。

## 额度与示例来源

- 真实模型仅 **1 个请求**，关闭 SDK 自动重试，90 秒请求超时，输出预算上限 3000 tokens；未修改数据库中的模型参数。
- 模型：GLM-5.3-Flash；响应 finish_reason=stop；接口报告输入 82、输出 509，合计 **591 tokens**。未查询供应商计费账单，不能据此给出货币金额。
- 文章《把零散想法变成一篇清晰的文章》为本轮生成；输出约 838 字符，虽超过提示要求的 400–600 字，结构与内容可作为示例。没有引用网络新闻、数据或第三方图片。
- 模板根据文章的整理、结构、修改思路人工整理；素材为项目原创 SVG。没有额外调用模板模型、生图、联网搜索、向量或排序服务。
- 文章生成通过后端已配置模型客户端执行；完整创作多节点链路、AI 提取和生图链路使用自动化替身验收，未为每个功能重复生成付费内容。

## 后续事项与现有限制

| 优先级 | 项目 | 依据与建议 |
|---|---|---|
| P2 | 真实插件与外部服务验收 | 需在安装同步助手并登录目标平台的浏览器里检查草稿同步；真实生图、嵌入、排序、所有模型兼容性仍待单独限额验收。当前不宣称这些外部依赖已经真实通过。 |
| P2 | URL 查询令牌的既有兼容方式 | core/auth.py 接受 access_token 查询参数，MarkdownPreview.tsx 为私人图片附加令牌。同步适配器会剥离令牌，但源请求 URL 可能进入代理访问日志；后续可优先收敛到同源 HttpOnly Cookie 或短期专用图片凭据，并检查代理日志脱敏。此处属于登录令牌，不是模型 API Key。 |
| P2 | 匿名模型元信息范围 | /api/settings/profiles 按现有明确设计允许匿名只读，返回服务地址、ownerId、掩码 keyHint 等元信息，不含 API Key 明文。若对外演示需要隐藏部署细节，可另行拆分公开模型选项与管理配置。 |
| P2 | 多进程 RAG 文件并发 | README 已声明目前 JSON 索引只有进程内互斥；多 worker 部署需跨进程锁或事务存储，本轮单实例回归不证明多进程写入安全。 |
| P3 | 前端分包体积 | Vite 仍提示 Mermaid/ELK 等部分包超过 500kB；构建成功，但未进行冷启动下载性能基准。 |
| P3 | 上游弃用告警 | 4 条既有告警涉及 FastAPI on_event、LangGraph 与旧 HTTP 状态常量；不影响本轮断言，应在依赖升级时处理。 |

## 可重复验证

```powershell
docker exec opw-backend python -m pytest tests -q -p no:cacheprovider
# 最终：316 passed, 4 warnings in 83.24s

# 分别在 frontend 与 frontend-admin 中
npm run build

# 在 frontend 设置已安装的 PLAYWRIGHT_MODULE / SMOKE_BROWSER_PATH / SMOKE_BASE_URL 后
node scripts/smoke-ui.cjs
node scripts/smoke-settings.cjs
node scripts/smoke-templates.cjs
node scripts/smoke-writer-stream.cjs
node scripts/smoke-visual-plan.cjs
node scripts/smoke-account.cjs
node scripts/smoke-account-menu.cjs
node scripts/smoke-public-examples.cjs
```

未运行 smoke-sync-publish.cjs；它需要 SYNC_INJECT_API 指向实际安装扩展的 inject-api.js。上面 8 个脚本中仅公共示例脚本使用真实本地资源接口，其余以模拟接口隔离模型成本和真实用户数据。
