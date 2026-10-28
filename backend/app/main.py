from fastapi import FastAPI
from fastapi import Depends
from fastapi.middleware.cors import CORSMiddleware

from app.api import admin, agent_runs, articles, assistant, auth, health, media, projects, publishing, rag, revisions, runs, templates
from app.api import settings as settings_api
from app.core.auth import require_admin, require_user
from app.core.config import get_settings

settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    version="0.2.0",
    description="Open Publisher Web - AI tweet creation workbench",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(admin.router, prefix="/api", dependencies=[Depends(require_admin)])
app.include_router(projects.router, prefix="/api", dependencies=[Depends(require_user)])
app.include_router(runs.router, prefix="/api", dependencies=[Depends(require_user)])
app.include_router(revisions.router, prefix="/api", dependencies=[Depends(require_user)])
app.include_router(articles.router, prefix="/api", dependencies=[Depends(require_user)])
app.include_router(agent_runs.router, prefix="/api", dependencies=[Depends(require_user)])
app.include_router(templates.router, prefix="/api", dependencies=[Depends(require_user)])
app.include_router(assistant.router, prefix="/api", dependencies=[Depends(require_user)])
app.include_router(media.router, prefix="/api", dependencies=[Depends(require_user)])
app.include_router(settings_api.router, prefix="/api")
app.include_router(publishing.router, prefix="/api", dependencies=[Depends(require_user)])
app.include_router(rag.router, prefix="/api", dependencies=[Depends(require_user)])


@app.on_event("startup")
def recover_interrupted_runtime():
    """蓝本 openRuntimeDatabase 的启动恢复：重启后未完成的运行/发布标记为
    interrupted / unknown，等待用户核验，绝不盲目重试。"""
    from app.core.secret_box import get_fernet

    get_fernet()
    from app.db.session import SessionLocal
    from app.services.publish_outbox import recover_interrupted

    try:
        with SessionLocal() as db:
            recover_interrupted(db)
            from app.services.template_service import seed_builtin_templates

            seed_builtin_templates(db)

            from app.core.users import password_helper
            from app.models.user import AppUser

            seed_admin = db.query(AppUser).filter(AppUser.username == settings.auth_admin_username).first()
            if seed_admin is None:
                if settings.auth_admin_password == "change_me_admin_password":
                    import logging

                    logging.getLogger(__name__).warning(
                        "AUTH_ADMIN_PASSWORD 仍为占位符，已用占位密码创建管理员 %s；"
                        "请通过环境变量配置真实密码后重建。",
                        settings.auth_admin_username,
                    )
                db.add(
                    AppUser(
                        id=f"u-{__import__('uuid').uuid4().hex[:32]}",
                        username=settings.auth_admin_username,
                        display_name=settings.auth_admin_display_name,
                        hashed_password=password_helper.hash(settings.auth_admin_password),
                        role="admin",
                        is_active=True,
                    )
                )
                db.commit()
    except Exception:  # noqa: BLE001 - 启动恢复失败不应阻塞服务（如本地无 DB 的测试环境）
        import logging

        logging.getLogger(__name__).warning(
            "startup recovery skipped: database unavailable", exc_info=True
        )


@app.get("/")
def root():
    return {"name": settings.app_name, "docs": "/docs"}


