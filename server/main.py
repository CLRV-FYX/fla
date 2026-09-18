"""FLA - FastAPI 主入口"""
import os
import secrets
import threading

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import converter, db, security
from .deps import user_public
from .routers import admin, announcements, auth, chat, files, social, users

app = FastAPI(title="FLA", docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                   allow_headers=["*"], expose_headers=["Content-Disposition", "Content-Range"])


@app.get("/api/health")
def health():
    return {"ok": True, "service": "fla"}


app.include_router(auth.router)
app.include_router(users.router)
app.include_router(users.avatars)
app.include_router(files.router)
app.include_router(admin.router)
app.include_router(announcements.router)   # v1.26: 公告
app.include_router(social.router)          # v1.26: 论坛
app.include_router(chat.router)            # v1.27: 聊天(微信级)


def _ensure_admin():
    if db.q1("SELECT id FROM users WHERE role='admin'"):
        return
    pw = os.environ.get("ADMIN_PASSWORD") or secrets.token_urlsafe(10)
    db.ex("INSERT INTO users(username,password_hash,nickname,role,created_at) VALUES(?,?,?,?,?)",
          ("admin", security.hash_password(pw), "管理员", "admin", db.now()))
    info = db.DATA / "initial_admin_password.txt"
    try:
        info.write_text(f"FLA 初始管理员账号\n用户名: admin\n密码: {pw}\n请登录后立即修改密码!\n",
                        encoding="utf-8")
    except Exception:
        pass
    print("=" * 56)
    print("!! 已创建初始管理员  用户名: admin  密码:", pw)
    print("!! 密码也已写入 data/initial_admin_password.txt, 请尽快修改")
    print("=" * 56)


@app.on_event("startup")
def startup():
    db.init_db()
    _ensure_admin()
    converter.start_worker()
    threading.Thread(target=converter.ensure_fonts, daemon=True).start()


# 前端静态资源 (SPA, hash 路由)
class NoCacheStatic(StaticFiles):
    """v1.26: html/js/css 须向服务器 revalidate(304), 避免发版后浏览器用旧缓存"""
    def file_response(self, *a, **kw):
        r = super().file_response(*a, **kw)
        r.headers["Cache-Control"] = "no-cache"
        return r

app.mount("/", NoCacheStatic(directory=str(db.WEB), html=True), name="web")
